'use strict';

const fsExtra = require('fs-extra');
const { templatePath } = require('../har/pathTemplate');
const { queryParamNames } = require('./logParsers');
const { clientIdOf } = require('./clientIdentity');

/**
 * Aggregates request records into the usage summary written to usage.json.
 *
 * Only aggregates are kept: per (method, path template, client) a call count,
 * first/last seen, and how often each query-parameter NAME was sent. Concrete
 * paths (which carry IDs), query values, IPs and bodies are never stored — the
 * file is safe to commit or upload.
 */

const FORMAT = 'specshield-usage';
const VERSION = 1;
const MAX_ENDPOINTS = 5000;
const MAX_UNMATCHED = 500;
const MAX_PARAMS = 50;

class UsageAggregator {
  /**
   * @param {object} opts
   * @param {object} opts.clientSpec  from parseClientSpec
   * @param {object} [opts.matcher]   from createRouteMatcher (import --spec)
   * @param {number} [opts.sinceMs]   drop records older than this epoch ms
   */
  constructor({ clientSpec, matcher = null, sinceMs = null, hosts = [] }) {
    this.clientSpec = clientSpec;
    this.matcher = matcher;
    this.sinceMs = sinceMs;
    this.hostTest = compileHostFilter(hosts);
    this.hostsSeen = new Map();
    this.endpoints = new Map();
    this.unmatchedCount = 0;
    this.stats = { requests: 0, matched: 0, unmatched: 0, notFound: 0, tooOld: 0, otherHost: 0, overflow: 0 };
    this.from = null;
    this.to = null;
  }

  add(record) {
    // One load balancer often fronts several APIs by host name. Requests for
    // another host must not count as usage of this API.
    if (record.host) {
      if (this.hostTest && !this.hostTest(record.host)) { this.stats.otherHost++; return; }
      if (this.hostsSeen.size < 50 || this.hostsSeen.has(record.host)) {
        this.hostsSeen.set(record.host, (this.hostsSeen.get(record.host) || 0) + 1);
      }
    }
    if (this.sinceMs !== null && record.time !== null && record.time < this.sinceMs) {
      this.stats.tooOld++;
      return;
    }

    let path;
    let matched = null;
    if (this.matcher) {
      const m = this.matcher.match(record.method, record.path);
      if (m && m.operation) {
        path = m.template;
        matched = true;
      } else {
        // 404/405 on a path the spec doesn't know is almost always a scanner
        // probing /wp-login.php and friends — not an undocumented endpoint.
        if (record.status === 404 || record.status === 405) { this.stats.notFound++; return; }
        path = templatePath(record.path).templated;
        matched = false;
      }
    } else {
      path = templatePath(record.path).templated;
    }

    const key = `${record.method} ${path}`;
    let ep = this.endpoints.get(key);
    if (!ep) {
      if (this.endpoints.size >= MAX_ENDPOINTS || (matched === false && this.unmatchedCount >= MAX_UNMATCHED)) {
        this.stats.overflow++;
        return;
      }
      ep = { method: record.method, path, matched, clients: new Map() };
      this.endpoints.set(key, ep);
      if (matched === false) this.unmatchedCount++;
    }

    const clientId = clientIdOf(record, this.clientSpec);
    let c = ep.clients.get(clientId);
    if (!c) {
      c = { calls: 0, firstSeen: null, lastSeen: null, params: new Map(), paramsTruncated: false };
      ep.clients.set(clientId, c);
    }
    c.calls++;
    if (record.time !== null) {
      if (c.firstSeen === null || record.time < c.firstSeen) c.firstSeen = record.time;
      if (c.lastSeen === null || record.time > c.lastSeen) c.lastSeen = record.time;
      if (this.from === null || record.time < this.from) this.from = record.time;
      if (this.to === null || record.time > this.to) this.to = record.time;
    }
    for (const name of queryParamNames(record.query)) {
      if (c.params.has(name)) c.params.set(name, c.params.get(name) + 1);
      else if (c.params.size < MAX_PARAMS) c.params.set(name, 1);
      else c.paramsTruncated = true;
    }

    this.stats.requests++;
    if (matched === true) this.stats.matched++;
    else if (matched === false) this.stats.unmatched++;
  }

  /** Fold a previously written usage.json into this aggregate (import --append). */
  absorb(usage) {
    for (const e of usage.endpoints) {
      const key = `${e.method} ${e.path}`;
      let ep = this.endpoints.get(key);
      if (!ep) {
        ep = { method: e.method, path: e.path, matched: e.matched ?? null, clients: new Map() };
        this.endpoints.set(key, ep);
        if (ep.matched === false) this.unmatchedCount++;
      }
      for (const ec of e.clients) {
        let c = ep.clients.get(ec.id);
        if (!c) {
          c = { calls: 0, firstSeen: null, lastSeen: null, params: new Map(), paramsTruncated: false };
          ep.clients.set(ec.id, c);
        }
        c.calls += ec.calls;
        c.firstSeen = minTime(c.firstSeen, toMs(ec.firstSeen));
        c.lastSeen = maxTime(c.lastSeen, toMs(ec.lastSeen));
        for (const [name, n] of Object.entries(ec.params || {})) {
          if (c.params.has(name)) c.params.set(name, c.params.get(name) + n);
          else if (c.params.size < MAX_PARAMS) c.params.set(name, n);
          else c.paramsTruncated = true;
        }
        if (ec.paramsTruncated) c.paramsTruncated = true;
      }
    }
    this.from = minTime(this.from, toMs(usage.window && usage.window.from));
    this.to = maxTime(this.to, toMs(usage.window && usage.window.to));
    for (const k of Object.keys(this.stats)) this.stats[k] += (usage.stats && usage.stats[k]) || 0;
  }

  toJSON({ generator, client, spec, basePath, sources }) {
    const endpoints = [...this.endpoints.values()].map((ep) => {
      const clients = [...ep.clients.entries()]
        .map(([id, c]) => {
          const out = { id, calls: c.calls, firstSeen: toIso(c.firstSeen), lastSeen: toIso(c.lastSeen) };
          if (c.params.size > 0) out.params = Object.fromEntries([...c.params.entries()].sort((a, b) => b[1] - a[1]));
          if (c.paramsTruncated) out.paramsTruncated = true;
          return out;
        })
        .sort((a, b) => b.calls - a.calls || a.id.localeCompare(b.id));
      const calls = clients.reduce((n, c) => n + c.calls, 0);
      const lastSeen = clients.reduce((t, c) => maxTime(t, toMs(c.lastSeen)), null);
      return { method: ep.method, path: ep.path, matched: ep.matched, calls, lastSeen: toIso(lastSeen), clients };
    }).sort((a, b) => b.calls - a.calls || `${a.path} ${a.method}`.localeCompare(`${b.path} ${b.method}`));

    return {
      format: FORMAT,
      version: VERSION,
      generatedAt: new Date().toISOString(),
      generator,
      client,
      spec: spec || null,
      basePath: basePath || null,
      window: { from: toIso(this.from), to: toIso(this.to) },
      stats: { ...this.stats },
      sources,
      endpoints,
    };
  }
}

/** --host values: exact host names, or globs like "*.example.com". Null = no filter. */
function compileHostFilter(hosts) {
  const list = (hosts || []).filter(Boolean).map((h) => String(h).toLowerCase());
  if (list.length === 0) return null;
  const tests = list.map((h) => {
    if (!h.includes('*')) return (x) => x === h;
    const re = new RegExp('^' + h.split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
    return (x) => re.test(x);
  });
  return (host) => tests.some((t) => t(host));
}

/** Reads and validates a usage.json. Throws with a readable message. */
async function loadUsage(file) {
  if (!(await fsExtra.pathExists(file))) throw new Error(`Usage file not found: ${file}`);
  let data;
  try {
    data = JSON.parse(await fsExtra.readFile(file, 'utf8'));
  } catch (err) {
    throw new Error(`Usage file "${file}" is not valid JSON: ${err.message}`);
  }
  return validateUsage(data, file);
}

function validateUsage(data, file = 'usage.json') {
  if (!data || data.format !== FORMAT || !Array.isArray(data.endpoints)) {
    throw new Error(`"${file}" is not a SpecShield usage file. Create one with: specshield usage import <access.log>`);
  }
  if (data.version !== VERSION) {
    throw new Error(`"${file}" is usage format v${data.version}; this CLI reads v${VERSION}. Re-run specshield usage import.`);
  }
  for (const e of data.endpoints) {
    if (typeof e.method !== 'string' || typeof e.path !== 'string' || !Array.isArray(e.clients)) {
      throw new Error(`"${file}" has a malformed endpoint entry`);
    }
    for (const c of e.clients) {
      if (typeof c.id !== 'string' || !Number.isFinite(c.calls) || c.calls < 0) {
        throw new Error(`"${file}" has a malformed client entry under ${e.method} ${e.path}`);
      }
    }
  }
  return data;
}

/** "30d" / "12h" / "2w" / "45m" → milliseconds. */
function parseDuration(s) {
  const m = /^(\d+)\s*(m|h|d|w)$/i.exec(String(s || '').trim());
  if (!m) throw new Error(`Invalid duration "${s}". Use e.g. 30d, 12h, 2w`);
  const unit = { m: 60e3, h: 3600e3, d: 86400e3, w: 7 * 86400e3 }[m[2].toLowerCase()];
  return Number(m[1]) * unit;
}

function toMs(v) {
  if (v === null || v === undefined) return null;
  const t = typeof v === 'number' ? v : Date.parse(v);
  return Number.isNaN(t) ? null : t;
}
function toIso(ms) { return ms === null || ms === undefined ? null : new Date(ms).toISOString(); }
function minTime(a, b) { return a === null ? b : b === null ? a : Math.min(a, b); }
function maxTime(a, b) { return a === null ? b : b === null ? a : Math.max(a, b); }

module.exports = { UsageAggregator, loadUsage, validateUsage, parseDuration, toMs, FORMAT, VERSION };
