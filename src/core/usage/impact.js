'use strict';

const { createRouteMatcher } = require('./routeMatcher');
const { toMs } = require('./usageStore');

/**
 * Joins a compare result to real traffic: every breaking change (and warning)
 * gets an `impact` saying which clients actually exercise it.
 *
 *   impact.verdict  'used'    — at least one call in the usage window
 *                   'unused'  — zero calls; nobody will notice the change
 *                   'unknown' — can't tie the change to an endpoint, or the
 *                               endpoint isn't in the base spec
 *   impact.basis    'endpoint'        — clients calling the operation. Logs
 *                                       don't show bodies, so for a body/response
 *                                       field change this means "may be affected"
 *                   'query-parameter' — clients that send (or, for a param that
 *                                       became required, omit) the parameter
 *
 * Breaking changes judged 'unused' move to `unusedBreakingChanges` and stop
 * failing the build — but only when the evidence is good enough (see
 * downgradeBlocker). Otherwise they are annotated and stay breaking.
 */

const DAY = 86400e3;

function applyUsageImpact(result, opts) {
  const {
    usage, baseSpec, baseNorm, file = 'usage.json',
    ignoreClients = [], minDays = 7, maxAgeDays = 30, minCoverage = 25,
    downgrade = true, now = Date.now(),
  } = opts;

  const ignore = compileClientPatterns(ignoreClients);
  const matcher = createRouteMatcher(baseSpec, { basePath: usage.basePath });

  // "GET /orders/{id}" → Map(clientId → { calls, lastSeen, params, paramsTruncated })
  const opIndex = new Map();
  let totalCalls = 0;
  let matchedCalls = 0;
  let ignoredCalls = 0;
  const clientIds = new Set();

  for (const e of usage.endpoints) {
    const m = matcher.match(e.method, e.path);
    for (const c of e.clients) {
      if (ignore(c.id)) { ignoredCalls += c.calls; continue; }
      totalCalls += c.calls;
      if (!m || !m.operation) continue;
      matchedCalls += c.calls;
      clientIds.add(c.id);
      const key = `${m.method} ${m.template}`;
      if (!opIndex.has(key)) opIndex.set(key, new Map());
      const byClient = opIndex.get(key);
      const agg = byClient.get(c.id) || { calls: 0, lastSeen: null, params: {}, paramsTruncated: false };
      agg.calls += c.calls;
      const seen = toMs(c.lastSeen);
      if (seen !== null && (agg.lastSeen === null || seen > agg.lastSeen)) agg.lastSeen = seen;
      for (const [name, n] of Object.entries(c.params || {})) agg.params[name] = (agg.params[name] || 0) + n;
      if (c.paramsTruncated) agg.paramsTruncated = true;
      byClient.set(c.id, agg);
    }
  }

  const from = toMs(usage.window && usage.window.from);
  const to = toMs(usage.window && usage.window.to);
  const meta = {
    file,
    window: { from: usage.window ? usage.window.from : null, to: usage.window ? usage.window.to : null },
    days: from !== null && to !== null ? round1((to - from) / DAY) : null,
    staleDays: to !== null ? round1(Math.max(0, now - to) / DAY) : null,
    totalCalls,
    matchedCalls,
    ignoredCalls,
    clients: clientIds.size,
    matchRate: totalCalls > 0 ? round3(matchedCalls / totalCalls) : 0,
    basePaths: matcher.basePaths,
    // Share of the spec's operations that appear in the logs. A low share
    // usually means the logs are filtered (one route exported), sampled, or
    // from one node of several — and then "0 calls" proves nothing.
    operationsSeen: opIndex.size,
    operationsTotal: matcher.operations.length,
    trusted: matchedCalls > 0,
  };

  const blocker = downgradeBlocker(meta, { downgrade, minDays, maxAgeDays, minCoverage });
  meta.downgrade = { enabled: blocker === null, reason: blocker };

  const ctx = { opIndex, baseSpec, baseNorm, trusted: meta.trusted };
  const annotate = (c) => (meta.trusted ? { ...c, impact: computeImpact(c, ctx) } : c);

  let breakingChanges = result.breakingChanges.map(annotate);
  const warnings = result.warnings.map(annotate);
  let unusedBreakingChanges = [];

  if (meta.downgrade.enabled) {
    unusedBreakingChanges = breakingChanges.filter((c) => c.impact && c.impact.verdict === 'unused');
    breakingChanges = breakingChanges.filter((c) => !(c.impact && c.impact.verdict === 'unused'));
  }

  return {
    result: { ...result, breakingChanges, warnings, unusedBreakingChanges },
    meta,
  };
}

/** Why "zero calls" isn't strong enough evidence to stop failing the build — or null. */
function downgradeBlocker(meta, { downgrade, minDays, maxAgeDays, minCoverage }) {
  if (!downgrade) return 'disabled by --no-usage-downgrade';
  if (!meta.trusted) return 'no call in the usage file matches an operation in the base spec';
  if (meta.days === null) return 'the logs had no timestamps, so the time window is unknown';
  if (meta.days < minDays) {
    return `the usage covers ${meta.days} day(s); at least ${minDays} are needed so weekly/monthly clients show up (--usage-min-days)`;
  }
  if (meta.staleDays > maxAgeDays) {
    return `the newest log line is ${Math.floor(meta.staleDays)} days old — re-import recent logs (--usage-max-age)`;
  }
  const coverage = meta.operationsTotal > 0 ? (meta.operationsSeen / meta.operationsTotal) * 100 : 0;
  if (coverage < minCoverage) {
    return `only ${meta.operationsSeen} of ${meta.operationsTotal} operations in the spec appear in the logs — ` +
      'they look filtered, sampled or from one server of several (--usage-min-coverage)';
  }
  return null;
}

function computeImpact(change, { opIndex, baseSpec, baseNorm }) {
  const endpoints = endpointsOf(change);
  if (endpoints.length === 0) {
    return { verdict: 'unknown', basis: null, reason: 'not tied to a specific endpoint' };
  }
  if (!endpoints.every(([m, p]) => operationExists(baseSpec, m, p))) {
    return { verdict: 'unknown', basis: null, reason: 'endpoint not found in the base spec' };
  }

  // Query-parameter changes can be judged per parameter: logs record the
  // query string. Header/path/cookie params and bodies can't — fall back to
  // "who calls this endpoint".
  let param = null;
  const pm = /^parameters\.(.+)$/.exec(change.field || '');
  if (pm && endpoints.length === 1) {
    const p = findParam(baseNorm, endpoints[0][0], endpoints[0][1], pm[1]);
    const byClient = opIndex.get(`${endpoints[0][0]} ${endpoints[0][1]}`);
    const truncated = byClient && [...byClient.values()].some((c) => c.paramsTruncated);
    // An object-typed query parameter (Spring's @ModelAttribute DTOs, form
    // explode, deepObject) never appears in the URL under its own name — its
    // properties do. Judging it by name would call a heavily used parameter
    // unused, so judge it by who calls the endpoint instead.
    if (p && p.in === 'query' && !isObjectSchema(p.schema) && !truncated) param = pm[1];
  }
  const omitters = change.type === 'PARAMETER_BECAME_REQUIRED';

  const clients = new Map();
  let endpointCalls = 0;
  for (const [method, path] of endpoints) {
    const byClient = opIndex.get(`${method} ${path}`);
    if (!byClient) continue;
    for (const [id, c] of byClient) {
      endpointCalls += c.calls;
      const sent = param ? (c.params[param] || 0) : 0;
      const hit = !param ? c.calls : omitters ? c.calls - sent : sent;
      if (hit <= 0) continue;
      const agg = clients.get(id) || { id, calls: 0, lastSeen: null };
      agg.calls += hit;
      if (c.lastSeen !== null && (agg.lastSeen === null || c.lastSeen > agg.lastSeen)) agg.lastSeen = c.lastSeen;
      clients.set(id, agg);
    }
  }

  const list = [...clients.values()]
    .sort((a, b) => b.calls - a.calls || a.id.localeCompare(b.id))
    .map((c) => ({
      id: c.id,
      calls: c.calls,
      share: endpointCalls > 0 ? round3(c.calls / endpointCalls) : 0,
      lastSeen: c.lastSeen === null ? null : new Date(c.lastSeen).toISOString(),
    }));
  const calls = list.reduce((n, c) => n + c.calls, 0);
  const lastSeen = list.reduce((t, c) => (c.lastSeen && (!t || c.lastSeen > t) ? c.lastSeen : t), null);

  const impact = {
    verdict: calls > 0 ? 'used' : 'unused',
    basis: param ? 'query-parameter' : 'endpoint',
    calls,
    endpointCalls,
    clients: list,
    lastSeen,
  };
  if (param) {
    impact.parameter = param;
    if (omitters) impact.parameterUse = 'omitted';
    else impact.parameterUse = 'sent';
  }
  return impact;
}

function endpointsOf(change) {
  if (change.path && change.method) return [[change.method.toUpperCase(), change.path]];
  const out = [];
  for (const e of change.affectedEndpoints || []) {
    const m = /^([A-Za-z]+) (\S+)$/.exec(e);
    if (m) out.push([m[1].toUpperCase(), m[2]]);
  }
  return out;
}

function operationExists(spec, method, path) {
  const item = spec && spec.paths && spec.paths[path];
  return Boolean(item && item[method.toLowerCase()]);
}

function findParam(baseNorm, method, path, name) {
  const op = baseNorm && baseNorm.endpoints && baseNorm.endpoints[path] && baseNorm.endpoints[path][method.toLowerCase()];
  return (op && (op.parameters || []).find((x) => x.name === name)) || null;
}

/** Unknown schemas count as objects: when in doubt, don't judge by the name. */
function isObjectSchema(schema) {
  if (!schema) return true;
  // Scalars and arrays serialize under the parameter's own name (?tag=a&tag=b).
  if (['string', 'integer', 'number', 'boolean', 'array'].includes(schema.type)) return false;
  return true;
}

/**
 * --usage-ignore-client patterns. With "*" the pattern is a glob over the whole
 * id ("kube-probe/*"); without, a case-insensitive substring ("probe").
 */
function compileClientPatterns(patterns) {
  const tests = patterns.filter(Boolean).map((p) => {
    if (p.includes('*')) {
      const re = new RegExp('^' + p.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$', 'i');
      return (id) => re.test(id);
    }
    const needle = p.toLowerCase();
    return (id) => id.toLowerCase().includes(needle);
  });
  return (id) => tests.some((t) => t(id));
}

function round1(n) { return Math.round(n * 10) / 10; }
function round3(n) { return Math.round(n * 1000) / 1000; }

module.exports = { applyUsageImpact, compileClientPatterns };
