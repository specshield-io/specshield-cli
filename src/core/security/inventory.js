'use strict';

/**
 * Improper inventory (OWASP API9) from real traffic: what the API serves that
 * the spec doesn't say.
 *
 *   shadow-endpoint         a path the spec doesn't have, answering requests
 *   undocumented-method     a documented path, answering a method the spec doesn't list
 *   zombie-version          /v1/... still answering, where the spec documents /v2/...
 *   sunset-passed           an operation past its x-sunset date, still answering
 *   exposed-sensitive-path  /.env, /.git/config, /actuator/env... answering 200
 *
 * The response status decides how sure a finding is: a 2xx (or 304) means the
 * endpoint served the request; 401/403/400 mean it exists; 404/405 and
 * redirects say nothing.
 * A host that answers 200 to scanner probes is most likely a catch-all (a
 * single-page app's index.html), so its findings are downgraded, not trusted.
 */

const { createRouteMatcher } = require('../usage/routeMatcher');
const { templatePath } = require('../har/pathTemplate');
const { finding } = require('./rules');

const MAX_ENTRIES = 2000;
const MAX_CLIENTS = 100;
const SKIP_METHODS = new Set(['HEAD', 'OPTIONS']);
const WRITE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const STATIC = /\.(m?js|css|map|png|jpe?g|gif|svg|ico|webp|avif|woff2?|ttf|eot|html?|txt|webmanifest)$/i;
const PRIVILEGED_PATH = /(^|\/)(admin|internal|debug|actuator|management|private|_[a-z]+)(\/|$)/i;
const VERSION = /^v\d+(\.\d+)?$/i;
// Every API has these, and few specs list them: worth knowing about, not alarming.
const CONVENTIONAL = /^\/(health|healthz|livez|readyz|ping|status|version|openapi|swagger|api-docs|v\d+\/api-docs|\.well-known)(\/|$|\.json$|\.yaml$)/i;
// A position with this many distinct values is a parameter, whatever the values look like.
const DISTINCT = 4;

// Paths no production server should answer with content.
const PROBES = [
  ['environment file', /^\/(.*\/)?\.env(\.[\w-]+)?$/i],
  ['git repository', /^\/(.*\/)?\.git\/(config|HEAD|index)$/i],
  ['cloud credentials', /^\/(.*\/)?\.aws\/credentials$/i],
  ['Spring Boot actuator', /^\/(.*\/)?actuator\/(env|heapdump|threaddump|configprops|beans|mappings|loggers|jolokia|shutdown)$/i],
  ['heap dump', /^\/(.*\/)?heapdump$/i],
  ['Go debug endpoint', /^\/debug\/(pprof|vars)(\/.*)?$/i],
  ['server status page', /^\/server-(status|info)$/i],
  ['PHP info page', /^\/(.*\/)?phpinfo\.php$/i],
  ['database backup', /^\/(.*\/)?[\w-]*(backup|dump|db)[\w-]*\.(sql|sql\.gz|bak)$/i],
];
// This many probe paths answered with the same page means the host answers everything with it.
const CATCH_ALL = 3;
const MAX_SIZES = 50;

function createInventory(spec, { basePath, hosts = null, now = Date.now() } = {}) {
  const matcher = spec ? createRouteMatcher(spec, { basePath }) : null;
  const versions = spec ? knownVersions(spec, matcher) : [];
  const entries = new Map();
  const probes = new Map();
  const probeHits = new Map();          // site → probe path → probe answered 2xx
  const home = new Map();               // site → size buckets of its home page
  const documented = new Map();
  const stats = { requests: 0, considered: 0, outside: 0, static: 0, otherHosts: 0, overflow: 0 };

  function add(rec) {
    if (!rec || !rec.method || typeof rec.path !== 'string') return;
    stats.requests++;
    const method = String(rec.method).toUpperCase();
    const host = rec.host ? String(rec.host).toLowerCase() : null;
    if (hosts && host && !hosts.has(host)) { stats.otherHosts++; return; }
    // Per-site logs record no host; the file they came from stands in, so one
    // site's catch-all page doesn't cast doubt on another's findings.
    const site = host || (rec.site ? String(rec.site) : null);
    if (SKIP_METHODS.has(method)) return;
    let path = rec.path.replace(/\/{2,}/g, '/');
    if (path.length > 1) path = path.replace(/\/$/, '');
    // A capture tells us what came back; an HTML page is the app, not the API.
    const html = rec.mime ? /html/i.test(rec.mime) : false;

    // Single-page apps and CMS rewrites answer unknown paths with the home page.
    if (path === '/' && method === 'GET' && ok(rec.status) && typeof rec.bytes === 'number') {
      if (!home.has(site)) home.set(site, new Set());
      const sizes = home.get(site);
      const b = bucket(rec.bytes);
      if (sizes.size < MAX_SIZES) [b - 1, b, b + 1].forEach((x) => sizes.add(x));
    }

    const probe = PROBES.find(([, re]) => re.test(path));
    if (probe) {
      // "/.env/" is a directory request: whatever answered it, it wasn't the file.
      const asDirectory = (rec.trailingSlash || (rec.path.length > 1 && rec.path.endsWith('/'))) && !/^\/debug\//.test(path);
      if (ok(rec.status) && !html && !asDirectory) {
        const key = `${site || ''} ${path}`;
        if (!probes.has(key)) probes.set(key, { label: probe[0], path, host: site, calls: 0, last: null, sizes: [] });
        const p = probes.get(key);
        p.calls++;
        p.last = latest(p.last, rec.time);
        if (typeof rec.bytes === 'number' && p.sizes.length < MAX_SIZES) p.sizes.push(rec.bytes);
        if (!probeHits.has(site)) probeHits.set(site, new Map());
        probeHits.get(site).set(path, p);
      }
      return;
    }
    if (!matcher) return;
    if (path === '/' || STATIC.test(path)) { stats.static++; return; }
    if (html) return;
    stats.considered++;

    const m = matcher.match(method, path) || greedy(method, path);
    if (m && m.operation) { record(documented, `${method} ${m.template}`, { method, template: m.template }, rec, site); return; }
    if (m) { remember('undocumented-method', method, m.template, rec, site); return; }
    const older = versions.length ? otherVersion(method, path) : null;
    if (older) { remember('zombie-version', method, templatePath(path).templated, rec, site, older); return; }
    // Named like the spec names its paths, so a waiver for it reads the same.
    const base = matcher.basePaths.find((b) => path === b || path.startsWith(`${b}/`));
    if (matcher.basePaths.length && !base) { stats.outside++; return; }
    remember('shadow-endpoint', method, templatePath(base ? path.slice(base.length) || '/' : path).templated, rec, site);
  }

  /**
   * Kubernetes and others document "/proxy/{path}" where {path} spans several
   * segments. OpenAPI doesn't say a parameter can't hold a slash, so try the
   * path with its tail folded into the last segment.
   */
  function greedy(method, path) {
    const segs = path.split('/');
    for (let n = segs.length - 1; n > 1; n--) {
      const m = matcher.match(method, [...segs.slice(0, n), segs.slice(n).join('%2F')].join('/'));
      if (m && /\/\{[^}/]+\}$/.test(m.template)) return m;
    }
    return null;
  }

  /** /v1/orders when the spec serves /v2/orders: the same operation under a version the spec dropped. */
  function otherVersion(method, path) {
    const segs = path.split('/');
    for (let i = 0; i < segs.length; i++) {
      if (!VERSION.test(segs[i]) || versions.includes(segs[i].toLowerCase())) continue;
      for (const v of versions) {
        const swapped = [...segs.slice(0, i), v, ...segs.slice(i + 1)].join('/');
        const m = matcher.match(method, swapped);
        if (m && m.operation) return `${method} ${m.template} (${v})`;
      }
    }
    return null;
  }

  function remember(kind, method, template, rec, host, current = null) {
    const key = `${kind}|${method} ${template}`;
    if (!entries.has(key) && entries.size >= MAX_ENTRIES) { stats.overflow++; return; }
    record(entries, key, { kind, method, template, current, fixed: kind === 'shadow-endpoint' && CONVENTIONAL.test(template) }, rec, host);
  }

  /**
   * Whether a probe's 2xx was the site's catch-all page rather than the file.
   * With sizes: other probe paths got a response of the same size, so it isn't
   * this file's content. Comparing per probe copes with a site that has several
   * such pages, or whose page changed. Only probes count: an ordinary API
   * response of a similar size says nothing. Without sizes: the site answered
   * 2xx to several probes.
   */
  function catchAllAnswer(p) {
    const size = median(p.sizes);
    const siblings = [...probeHits.get(p.host).values()].filter((q) => q !== p);
    if (size === null) {
      const n = siblings.length + 1;
      return n >= CATCH_ALL ? `this host answers 200 to ${n} probe paths, so it is probably a catch-all page` : null;
    }
    const b = bucket(size);
    if ((home.get(p.host) || new Set()).has(b)) return `${size} bytes, the size of this host's home page; probably a rewrite to it`;
    const same = siblings.filter((q) => { const m = median(q.sizes); return m !== null && Math.abs(bucket(m) - b) <= 1; });
    if (same.length + 1 < CATCH_ALL) return null;
    return `${size} bytes, the same as ${same.length} other probe paths got (e.g. ${same[0].path}); probably a catch-all page`;
  }

  function findings() {
    const verdicts = new Map([...probes.values()].map((p) => [p, catchAllAnswer(p)]));
    const catchAll = new Set([...verdicts].filter(([, v]) => v).map(([p]) => p.host));
    const out = [];
    for (const e of collapse([...entries.values()])) {
      const f = judge(e, catchAll);
      if (f) out.push(f);
    }
    for (const op of sunsetPassed(spec, documented, now)) out.push(op);
    for (const [p, why] of verdicts) {
      const size = median(p.sizes);
      const detail = why ? `${p.label}; ${why}` : `${p.label}, answered 2xx ${times(p.calls)}${size !== null ? ` with ${size} bytes no other path got` : ''}`;
      out.push(finding('exposed-sensitive-path', why ? 'low' : 'high', { endpoint: `GET ${p.path}`, field: p.host, detail, source: 'traffic' }));
    }
    return out;
  }

  return {
    add,
    findings,
    get stats() {
      const real = [...entries.values()].filter((e) => count(e, (st) => st !== 404 && st !== 405) > 0).length;
      return { ...stats, documentedSeen: documented.size, documentedTotal: matcher ? matcher.operations.length : 0, endpoints: real };
    },
  };
}

/**
 * Folds routes that differ only where a value varies: /things/noxus/x and
 * /things/fooab/x become /things/{thingId}/x once DISTINCT siblings share both
 * a parent and the shape of what follows them. Object names that don't look
 * like IDs would otherwise each be a finding, and fixed words (/readyz,
 * /metrics, /openapi) differ in what follows, so they stay apart. The first
 * segment is never folded.
 */
function collapse(list) {
  let routes = list.map((e) => ({ ...e, segs: e.template.split('/'), variants: e.variants || 1, examples: e.examples || [] }));
  const depth = Math.max(0, ...routes.map((r) => r.segs.length));
  const isParam = (v) => v.startsWith('{');
  for (let i = 2; i < depth; i++) {
    const familyOf = (r) => [r.kind, r.method, r.segs.slice(0, i).join('/')].join('|');
    const shapes = new Map();               // family → value → shapes of what follows
    for (const r of routes) {
      if (r.segs.length <= i || isParam(r.segs[i])) continue;
      const fam = familyOf(r);
      if (!shapes.has(fam)) shapes.set(fam, new Map());
      const byValue = shapes.get(fam);
      if (!byValue.has(r.segs[i])) byValue.set(r.segs[i], new Set());
      byValue.get(r.segs[i]).add(r.segs.slice(i + 1).map((x) => (isParam(x) ? '{}' : '*')).join('/'));
    }
    const fold = new Set();
    for (const [fam, byValue] of shapes) {
      const bySignature = new Map();
      for (const [value, set] of byValue) {
        const sig = [...set].sort().join('|');
        if (!bySignature.has(sig)) bySignature.set(sig, []);
        bySignature.get(sig).push(value);
      }
      for (const values of bySignature.values()) {
        if (values.length >= DISTINCT) values.forEach((v) => fold.add(`${fam}|${v}`));
      }
    }
    if (!fold.size) continue;
    const merged = new Map();
    for (const r of routes) {
      const folded = r.segs.length > i && fold.has(`${familyOf(r)}|${r.segs[i]}`);
      const segs = folded ? [...r.segs.slice(0, i), `{${paramName(r.segs[i - 1])}}`, ...r.segs.slice(i + 1)] : r.segs;
      const key = [r.kind, r.method, segs.join('/')].join('|');
      const into = merged.get(key);
      const examples = folded && !r.examples.length ? [r.template] : r.examples;
      if (!into) {
        merged.set(key, { ...r, segs, examples: [...examples], statuses: new Map(r.statuses), clients: new Set(r.clients), hosts: new Set(r.hosts) });
        continue;
      }
      into.calls += r.calls;
      into.variants += r.variants;
      for (const x of examples) if (into.examples.length < 3) into.examples.push(x);
      for (const [st, c] of r.statuses) into.statuses.set(st, (into.statuses.get(st) || 0) + c);
      for (const c of r.clients) if (into.clients.size < MAX_CLIENTS) into.clients.add(c);
      for (const h of r.hosts) into.hosts.add(h);
      into.last = latest(into.last, r.last);
      into.lastOk = latest(into.lastOk, r.lastOk) ?? into.lastOk ?? r.lastOk;
    }
    routes = [...merged.values()];
  }
  return routes.map((r) => ({ ...r, template: unique(r.segs).join('/') }));
}

/** {id}/{id} → {id}/{id2}: a template can't repeat a parameter name. */
function unique(segs) {
  const seen = new Map();
  return segs.map((s) => {
    const m = /^\{(.+)\}$/.exec(s);
    if (!m) return s;
    const base = m[1].replace(/\d+$/, '');
    const n = (seen.get(base) || 0) + 1;
    seen.set(base, n);
    return n === 1 ? `{${base}}` : `{${base}${n}}`;
  });
}

function paramName(prev) {
  const m = /^([a-z][a-z0-9]*?)(e?s)?$/i.exec(prev || '');
  return m && m[1].length > 1 && !prev.startsWith('{') ? `${m[1]}Id` : 'id';
}

const median = (xs) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : null);
// Buckets about 3% wide: a catch-all page that echoes the path varies by a few bytes.
const bucket = (bytes) => Math.round(Math.log(bytes + 64) / Math.log(1.03));

function record(map, key, base, rec, host) {
  if (!map.has(key)) map.set(key, { ...base, calls: 0, statuses: new Map(), clients: new Set(), hosts: new Set(), last: null, lastOk: null });
  const e = map.get(key);
  e.calls++;
  const s = rec.status || null;
  e.statuses.set(s, (e.statuses.get(s) || 0) + 1);
  if (rec.userAgent && e.clients.size < MAX_CLIENTS) e.clients.add(rec.userAgent);
  if (host) e.hosts.add(host);
  e.last = latest(e.last, rec.time);
  if (ok(s)) e.lastOk = latest(e.lastOk, rec.time) ?? e.lastOk ?? true;
}

// 304 means the client's copy of an existing resource is current. Other 3xx
// prove nothing: an HTTP→HTTPS redirect answers every path, real or not.
const ok = (s) => (s >= 200 && s < 300) || s === 304;
const latest = (a, t) => (typeof t === 'number' && (typeof a !== 'number' || t > a) ? t : a);
const times = (n) => (n === 1 ? 'once' : `${n} times`);

function count(e, test) {
  let n = 0;
  for (const [s, c] of e.statuses) if (test(s)) n += c;
  return n;
}

function judge(e, catchAll) {
  const served = count(e, ok);
  const exists = count(e, (s) => s === 401 || s === 403 || s === 400 || s === 422 || s === 429 || (s >= 500 && s < 600));
  const unknown = count(e, (s) => s === null);
  if (!served && !exists && !unknown) return null;              // only 404/405: it isn't there
  const write = WRITE.has(e.method);
  const doubtful = [...e.hosts].some((h) => catchAll.has(h));
  const conventional = Boolean(e.fixed);
  let severity = 'low';
  if (served && !doubtful && !conventional) {
    if (e.kind === 'shadow-endpoint') severity = write || PRIVILEGED_PATH.test(e.template) ? 'high' : 'medium';
    else severity = write ? 'high' : 'medium';
  }
  const notes = [describe(e)];
  if (e.variants > 1) notes.push(`${e.variants} routes folded into this one, e.g. ${e.examples.join(', ')}`);
  if (e.current) notes.push(`now ${e.current}`);
  if (conventional) notes.push('a conventional health or discovery endpoint');
  if (!served && unknown === e.calls) notes.push('the logs have no status, so it may not exist');
  else if (!served) notes.push('never answered 2xx, but it exists');
  if (doubtful) notes.push('this host looks like a catch-all');
  return finding(e.kind, severity, { endpoint: `${e.method} ${e.template}`, detail: notes.join('; '), source: 'traffic' });
}

function describe(e) {
  const statuses = [...e.statuses].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([s, n]) => `${s ?? '?'}×${n}`).join(' ');
  const last = typeof e.last === 'number' ? `, last ${new Date(e.last).toISOString().slice(0, 10)}` : '';
  return `${e.calls} ${e.calls === 1 ? 'call' : 'calls'} from ${e.clients.size || '?'} ${e.clients.size === 1 ? 'client' : 'clients'} (${statuses})${last}`;
}

/** Operations whose x-sunset date has passed and that still answered 2xx after it. */
function sunsetPassed(spec, documented, now) {
  const out = [];
  if (!spec) return out;
  for (const [path, item] of Object.entries(spec.paths || {})) {
    if (!item || typeof item !== 'object') continue;
    for (const [method, op] of Object.entries(item)) {
      if (!op || typeof op !== 'object' || !op['x-sunset']) continue;
      const v = op['x-sunset'];
      const sunset = (v instanceof Date ? v : new Date(String(v))).getTime();
      if (Number.isNaN(sunset) || sunset > now) continue;
      const e = documented.get(`${method.toUpperCase()} ${path}`);
      if (!e || !e.lastOk || (typeof e.lastOk === 'number' && e.lastOk < sunset)) continue;
      out.push(finding('sunset-passed', 'medium', {
        endpoint: `${method.toUpperCase()} ${path}`,
        detail: `sunset ${new Date(sunset).toISOString().slice(0, 10)}; ${describe(e)}`,
        source: 'traffic',
      }));
    }
  }
  return out;
}

function knownVersions(spec, matcher) {
  const found = new Set();
  const scan = (p) => p.split('/').forEach((s) => { if (VERSION.test(s)) found.add(s.toLowerCase()); });
  for (const p of Object.keys(spec.paths || {})) scan(p);
  matcher.basePaths.forEach(scan);
  return [...found];
}

module.exports = { createInventory, PROBES };
