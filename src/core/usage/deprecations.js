'use strict';

const { indexUsage, downgradeBlocker, isObjectSchema, compileClientPatterns, BODYLESS_METHODS } = require('./impact');
const { resolveSchema } = require('../normalizeSpec');
const { weekOf } = require('./usageStore');

/**
 * Safe-removal workflow: deprecate → watch traffic drain → remove.
 *
 * collectDeprecations() lists what the spec marks `deprecated: true` (or gives
 * an `x-sunset` date): operations, parameters, and request/response fields.
 * deprecationReport() joins that list to a usage file and says, per item, who
 * still calls it and whether it is safe to remove:
 *
 *   in-use          called in the last week of the usage window
 *   quiet           draining: no calls for a week or more, but not for
 *                   `quietDays` yet — keep watching
 *   safe-to-remove  no calls for at least `quietDays`
 *   unverifiable    a body field or header: logs can't show who sends or reads
 *                   it, and the endpoint is still called
 *   no-data         the usage file can't support a verdict (stale, filtered…)
 *
 * A deprecated property of a shared schema (one `$ref`'d component used by
 * many operations) is one item — `kind: 'schema-field'` — judged by the
 * traffic of every operation that uses it. Listing it once per operation and
 * status code turned one deprecation (Kubernetes' ObjectMeta.selfLink) into
 * 1,700 rows on real data.
 *
 * Field paths match the compare engine's (`parameters.sort`,
 * `requestBody.owner.name`, `responses.200.items[items].tag`) so a removal in
 * compare can be tied back to its deprecation.
 */

const DAY = 86400e3;
const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'];
const MAX_DEPTH = 12;
const STATUS_ORDER = ['in-use', 'unverifiable', 'quiet', 'no-data', 'safe-to-remove'];
// A call this recent means "still in use", not "draining".
const ACTIVE_DAYS = 7;

function collectDeprecations(spec) {
  const items = [];
  const seen = new Set();
  const push = (item) => {
    if (seen.has(item.key)) return;
    seen.add(item.key);
    items.push(item);
  };
  const components = spec.components || {};
  const ctx = {
    schemas: components.schemas || spec.definitions || {},
    parameters: components.parameters || spec.parameters || {},
    responses: components.responses || spec.responses || {},
    requestBodies: components.requestBodies || {},
  };

  for (const [path, pathItem] of Object.entries(spec.paths || {})) {
    if (!pathItem || typeof pathItem !== 'object') continue;
    for (const m of HTTP_METHODS) {
      const op = pathItem[m];
      if (!op || typeof op !== 'object') continue;
      const method = m.toUpperCase();
      const base = { method, path };

      if (isDeprecated(op)) {
        // Everything under a deprecated operation goes with it — listing its
        // fields too would only repeat the same callers.
        push({ ...base, key: `${method} ${path}`, kind: 'operation', field: null, sunset: sunsetOf(op), summary: op.summary || null });
        continue;
      }

      let body = null;
      for (const p of mergeParameters(pathItem.parameters, op.parameters, ctx)) {
        if (p.in === 'body') { body = p.schema || null; continue; }      // Swagger 2.0
        if (!isDeprecated(p)) continue;
        push({
          ...base, key: `${method} ${path} parameters.${p.name}`, kind: 'parameter',
          field: `parameters.${p.name}`, in: p.in, name: p.name, sunset: sunsetOf(p),
          objectSchema: p.in === 'query' && isObjectSchema(paramSchema(p, ctx)),
        });
      }

      const requestBody = deref(op.requestBody, ctx.requestBodies, '#/components/requestBodies/');
      if (requestBody && requestBody.content) body = mediaSchema(requestBody.content);
      if (body) walkSchema(body, 'requestBody', { ...base, kind: 'request-field' }, ctx, push, [], null);

      for (const [code, raw] of Object.entries(op.responses || {})) {
        const resp = deref(raw, ctx.responses, '#/components/responses/', '#/responses/');
        if (!resp) continue;
        const schema = resp.schema || (resp.content ? mediaSchema(resp.content) : null);
        if (schema) walkSchema(schema, `responses.${code}`, { ...base, kind: 'response-field' }, ctx, push, [], null);
      }
    }
  }
  return items;
}

/**
 * `origin` names where a property is declared, independent of the operation:
 * "Pet.owner.phone" for a property reached through the Pet component. Null
 * for inline schemas, which belong to their one operation.
 */
function walkSchema(raw, prefix, base, ctx, push, refStack, origin) {
  if (!raw || typeof raw !== 'object' || refStack.length > MAX_DEPTH) return;
  let schema = raw;
  let stack = refStack;
  if (raw.$ref) {
    if (refStack.includes(raw.$ref)) return;                            // recursive schema
    schema = deref(raw, ctx.schemas, '#/components/schemas/', '#/definitions/');
    if (!schema) return;
    stack = [...refStack, raw.$ref];
    origin = schemaName(raw.$ref);
  }
  const sub = (suffix) => (origin ? `${origin}${suffix}` : null);
  for (const part of schema.allOf || []) walkSchema(part, prefix, base, ctx, push, stack, origin);
  for (const key of ['oneOf', 'anyOf']) {
    (schema[key] || []).forEach((v, i) => walkSchema(v, `${prefix}[${i}]`, base, ctx, push, stack, sub(`[${i}]`)));
  }
  for (const [name, prop] of Object.entries(schema.properties || {})) {
    const field = `${prefix}.${name}`;
    const resolved = prop && prop.$ref ? deref(prop, ctx.schemas, '#/components/schemas/', '#/definitions/') : prop;
    // `deprecated` beside a $ref is how 3.1 marks a referenced property; on the
    // target schema it marks every use of it.
    if (isDeprecated(prop) || isDeprecated(resolved)) {
      push({
        ...base, key: `${base.method} ${base.path} ${field}`, field, sunset: sunsetOf(prop) || sunsetOf(resolved),
        origin: isDeprecated(prop) ? sub(`.${name}`) : schemaName(prop.$ref),
      });
      continue;
    }
    walkSchema(prop, field, base, ctx, push, stack, sub(`.${name}`));
  }
  if (schema.items) walkSchema(schema.items, `${prefix}[items]`, base, ctx, push, stack, sub('[items]'));
}

/**
 * Folds the per-operation occurrences of a shared-schema property into one
 * 'schema-field' item. A property used by a single operation stays as it is.
 */
function groupDeprecations(occurrences) {
  const groups = new Map();
  const out = [];
  for (const o of occurrences) {
    if (!o.origin) { out.push(o); continue; }
    let g = groups.get(o.origin);
    if (!g) {
      g = { key: `schema ${o.origin}`, kind: 'schema-field', method: null, path: null, field: o.origin,
        sunset: o.sunset, occurrences: [], first: o };
      groups.set(o.origin, g);
      out.push(g);
    }
    g.occurrences.push({ method: o.method, path: o.path, field: o.field, side: o.kind === 'request-field' ? 'request' : 'response' });
  }
  return out.map((i) => {
    if (i.kind !== 'schema-field') return i;
    const { first, ...g } = i;
    return new Set(g.occurrences.map((o) => `${o.method} ${o.path}`)).size === 1 && g.occurrences.length === 1 ? first : g;
  });
}

/**
 * Joins the deprecations of `spec` to a usage file. Without usage, every item
 * is 'no-data' — the report then only lists what is deprecated.
 */
function deprecationReport({
  spec, usage = null, file = 'usage.json', quietDays = 30, ignoreClients = [],
  maxAgeDays = 30, minCoverage = 25, contacts = {}, now = Date.now(),
}) {
  const items = groupDeprecations(collectDeprecations(spec));
  const contactOf = compileContacts(contacts);
  let meta = null;
  let opIndex = new Map();
  let blocker = 'no usage file was given (--usage)';

  if (usage) {
    ({ opIndex, meta } = indexUsage(usage, spec, { file, ignoreClients, now }));
    blocker = downgradeBlocker(meta, { downgrade: true, minDays: 0, maxAgeDays, minCoverage });
  }
  const to = meta && meta.window.to ? Date.parse(meta.window.to) : null;
  const activeSince = to !== null ? to - Math.min(ACTIVE_DAYS, quietDays) * DAY : null;

  const out = items.map((item) => {
    const judged = judge(item, opIndex, { activeSince, to, meta, quietDays, blocker });
    const { objectSchema, origin, ...rest } = item;
    const r = { ...rest, ...judged };
    r.clients = r.clients.map((c) => ({ ...c, contact: contactOf(c.id) }));
    const sunsetMs = item.sunset ? Date.parse(item.sunset) : NaN;
    if (!Number.isNaN(sunsetMs)) {
      r.daysToSunset = Math.ceil((sunsetMs - now) / DAY);
      r.pastSunset = r.daysToSunset < 0 && (r.status === 'in-use' || r.status === 'unverifiable');
    }
    return r;
  }).sort((a, b) =>
    STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status) ||
    (b.pastSunset === true) - (a.pastSunset === true) ||
    b.calls - a.calls || a.key.localeCompare(b.key));

  const summary = { total: out.length, pastSunset: out.filter((i) => i.pastSunset).length };
  for (const s of STATUS_ORDER) summary[camel(s)] = out.filter((i) => i.status === s).length;

  return {
    api: { title: (spec.info && spec.info.title) || null, version: (spec.info && spec.info.version) || null },
    quietDays,
    usage: meta ? { ...meta, evidence: blocker === null ? 'ok' : blocker } : null,
    summary,
    items: out,
  };
}

/** The operations whose callers an item is judged by, each once. */
function operationsOf(item) {
  if (item.kind !== 'schema-field') {
    // A GET carries no request body: nobody can be sending the field.
    if (item.kind === 'request-field' && BODYLESS_METHODS.has(item.method)) return [];
    return [`${item.method} ${item.path}`];
  }
  const ops = new Set();
  for (const o of item.occurrences) {
    if (o.side === 'request' && BODYLESS_METHODS.has(o.method)) continue;
    ops.add(`${o.method} ${o.path}`);
  }
  return [...ops];
}

function judge(item, opIndex, { activeSince, to, meta, quietDays, blocker }) {
  const ops = operationsOf(item);
  const sources = ops.map((op) => opIndex.get(op)).filter(Boolean);
  // Logs record the query string, so a scalar query parameter is judged by who
  // sends it. Header/cookie/path params and body fields are judged by who
  // calls the endpoint, which can only ever clear them, never convict them.
  const byParam = item.kind === 'parameter' && item.in === 'query' && !item.objectSchema &&
    !sources.some((byClient) => [...byClient.values()].some((c) => c.paramsTruncated));
  const exact = item.kind === 'operation' || byParam;

  const byId = new Map();
  const weeks = {};
  for (const byClient of sources) {
    for (const [id, c] of byClient) {
      const calls = byParam ? c.params[item.name] || 0 : c.calls;
      if (calls <= 0) continue;
      const seen = byParam ? c.paramsLastSeen[item.name] ?? c.lastSeen : c.lastSeen;
      const agg = byId.get(id) || { id, calls: 0, lastSeen: null };
      agg.calls += calls;
      if (seen !== null && (agg.lastSeen === null || seen > agg.lastSeen)) agg.lastSeen = seen;
      byId.set(id, agg);
      // Weekly counts are per endpoint: they describe a parameter's senders
      // only as "callers of the endpoint", so parameters get none.
      if (!byParam) for (const [w, n] of Object.entries(c.weeks)) weeks[w] = (weeks[w] || 0) + n;
    }
  }
  const clients = [...byId.values()]
    .map((c) => ({ id: c.id, calls: c.calls, lastSeen: c.lastSeen === null ? null : new Date(c.lastSeen).toISOString() }))
    .sort((a, b) => b.calls - a.calls || a.id.localeCompare(b.id));
  const calls = clients.reduce((n, c) => n + c.calls, 0);
  const lastSeen = clients.reduce((t, c) => (c.lastSeen && (!t || c.lastSeen > t) ? c.lastSeen : t), null);
  const recent = clients.filter((c) => c.lastSeen && Date.parse(c.lastSeen) >= activeSince);
  const hasWeeks = Object.keys(weeks).length > 0;           // usage files before 3.4.15 have none

  const r = {
    ...(item.kind === 'schema-field' ? { operations: ops.length } : {}),
    basis: exact ? (byParam ? 'query-parameter' : 'operation') : 'endpoint',
    calls,
    lastSeen,
    clients,
    weeks: hasWeeks ? weekSeries(weeks, meta.window) : [],
  };

  if (blocker !== null) return { ...r, status: 'no-data', reason: blocker };
  if (recent.length > 0) {
    if (exact) {
      return { ...r, status: 'in-use', reason: `${plural(recent.length, 'client')} called it in the last ${Math.min(ACTIVE_DAYS, quietDays)} days` };
    }
    return {
      ...r, status: 'unverifiable',
      reason: `access logs don't show ${item.kind === 'parameter' ? `the ${item.in} parameter` : 'body fields'}, ` +
        `and ${plural(recent.length, 'client')} still ${recent.length === 1 ? 'calls' : 'call'} ` +
        (item.kind === 'schema-field' ? `operations that use it (${ops.length})` : 'the endpoint'),
    };
  }
  const quietFor = lastSeen ? (to - Date.parse(lastSeen)) / DAY : meta.days;
  if (quietFor >= quietDays) {
    return { ...r, status: 'safe-to-remove', quietForDays: Math.floor(quietFor), reason: lastSeen
      ? `last called ${Math.floor(quietFor)} days before the newest log line`
      : `never called in ${Math.floor(quietFor)} days of logs` };
  }
  return {
    ...r, status: 'quiet', quietForDays: Math.floor(quietFor),
    reason: `no calls for ${Math.floor(quietFor)} of the ${quietDays} days needed`,
  };
}

/**
 * Calls per week across the whole usage window, zero-filled so a week with no
 * calls shows as a drop instead of vanishing. The first and last week are
 * marked partial when the logs cover only part of them.
 */
function weekSeries(weeks, window) {
  if (!window || !window.from || !window.to) return [];
  const from = Date.parse(window.from);
  const to = Date.parse(window.to);
  const out = [];
  for (let t = Date.parse(weekOf(from)); t <= to; t += 7 * DAY) {
    const week = new Date(t).toISOString().slice(0, 10);
    const entry = { week, calls: weeks[week] || 0 };
    if (t < from || t + 7 * DAY - 1 > to) entry.partial = true;
    out.push(entry);
  }
  return out.slice(-26);
}

// ─── compare integration ────────────────────────────────────────────────────

const REMOVAL_TYPES = new Set([
  'ENDPOINT_REMOVED', 'METHOD_REMOVED', 'PARAMETER_REMOVED', 'REQUEST_FIELD_REMOVED', 'RESPONSE_FIELD_REMOVED',
]);

/**
 * Marks every removal in a compare result with whether the base spec had
 * deprecated it first: `deprecation: { deprecated, sunset?, drained? }`. A
 * removal that skipped deprecation gave its callers no warning.
 *
 * Deprecation is the gate's other half: a deprecated item whose callers all
 * stopped at least `quietDays` before the newest log line has drained, and
 * stops failing the build like an unused change — the same verdict
 * `specshield deprecations` gives it.
 */
function annotateDeprecations(result, baseSpec, { meta = null, quietDays = 30 } = {}) {
  const byKey = new Map(collectDeprecations(baseSpec).map((i) => [i.key, i]));
  const to = meta && meta.window && meta.window.to ? Date.parse(meta.window.to) : null;
  const annotate = (c) => {
    if (!REMOVAL_TYPES.has(c.type)) return c;
    const item = deprecationFor(c, byKey);
    if (!item) return { ...c, deprecation: { deprecated: false } };
    const deprecation = { deprecated: true, sunset: item.sunset || null };
    if (c.impact && c.impact.verdict === 'used' && c.impact.lastSeen && to !== null) {
      const quietFor = Math.floor((to - Date.parse(c.impact.lastSeen)) / DAY);
      if (quietFor >= quietDays) Object.assign(deprecation, { drained: true, quietForDays: quietFor });
    }
    return { ...c, deprecation };
  };
  let breakingChanges = result.breakingChanges.map(annotate);
  let unusedBreakingChanges = (result.unusedBreakingChanges || []).map(annotate);
  if (meta && meta.downgrade && meta.downgrade.enabled) {
    const drained = (c) => Boolean(c.deprecation && c.deprecation.drained);
    unusedBreakingChanges = [...unusedBreakingChanges, ...breakingChanges.filter(drained)];
    breakingChanges = breakingChanges.filter((c) => !drained(c));
  }
  return { ...result, breakingChanges, unusedBreakingChanges };
}

function deprecationFor(change, byKey) {
  const endpoints = change.path && change.method
    ? [`${change.method.toUpperCase()} ${change.path}`]
    : (change.affectedEndpoints || []).map((e) => e.replace(/^(\S+)/, (m) => m.toUpperCase()));
  if (endpoints.length === 0) return null;
  const leaf = change.field ? change.field.split('.').pop() : null;
  const found = endpoints.map((ep) => {
    // The whole operation was deprecated: everything in it went with it.
    if (byKey.has(ep)) return byKey.get(ep);
    if (!change.field) return null;
    if (byKey.has(`${ep} ${change.field}`)) return byKey.get(`${ep} ${change.field}`);
    // A merged $ref change carries the first endpoint's field path; elsewhere
    // the same property sits under another prefix. Match it by its leaf name.
    for (const [key, item] of byKey) {
      if (key.startsWith(`${ep} `) && item.field && item.field.split('.').pop() === leaf &&
          item.field.startsWith(change.field.startsWith('requestBody') ? 'requestBody' : 'responses')) return item;
    }
    return null;
  });
  // Only "deprecated" if it was deprecated everywhere it was removed from.
  return found.every(Boolean) ? found[0] : null;
}

// ─── spec helpers ───────────────────────────────────────────────────────────

function isDeprecated(node) {
  return Boolean(node && typeof node === 'object' && (node.deprecated === true || node['x-sunset']));
}

/** `x-sunset: 2026-12-31` — YAML parses an unquoted date to a Date. */
function sunsetOf(node) {
  const v = node && node['x-sunset'];
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? String(v) : d.toISOString().slice(0, 10);
}

function schemaName(ref) {
  return typeof ref === 'string' ? ref.slice(ref.lastIndexOf('/') + 1) : null;
}

function deref(node, table, ...prefixes) {
  if (!node || typeof node !== 'object' || !node.$ref) return node || null;
  for (const prefix of prefixes) {
    if (node.$ref.startsWith(prefix)) return table[node.$ref.slice(prefix.length)] || null;
  }
  return null;
}

function mergeParameters(pathParams, opParams, ctx) {
  const byKey = new Map();
  for (const raw of [...(Array.isArray(pathParams) ? pathParams : []), ...(Array.isArray(opParams) ? opParams : [])]) {
    const p = deref(raw, ctx.parameters, '#/components/parameters/', '#/parameters/');
    if (p && p.name && p.in) byKey.set(`${p.in}:${p.name}`, p);
  }
  return [...byKey.values()];
}

function paramSchema(p, ctx) {
  if (p.schema) return resolveSchema(p.schema, ctx.schemas);
  return p.type ? { type: p.type } : null;
}

function mediaSchema(content) {
  const media = content['application/json'] || Object.values(content)[0];
  return (media && media.schema) || null;
}

/**
 * usage.contacts: { "<client id, or * glob>": "<email, Slack channel, …>" } —
 * first match wins. Unlike --usage-ignore-client, a pattern without * must
 * match the whole id: "app" must not hand myapp's callers to app's owner.
 */
function compileContacts(contacts) {
  const entries = Object.entries(contacts || {}).map(([pattern, contact]) => [
    pattern.includes('*') ? compileClientPatterns([pattern]) : (id) => id.toLowerCase() === pattern.toLowerCase(),
    String(contact),
  ]);
  return (id) => {
    for (const [test, contact] of entries) if (test(id)) return contact;
    return null;
  };
}

function plural(n, word) { return `${n} ${word}${n === 1 ? '' : 's'}`; }
function camel(s) { return s.replace(/-(\w)/g, (_, c) => c.toUpperCase()); }

module.exports = { collectDeprecations, groupDeprecations, deprecationReport, annotateDeprecations, STATUS_ORDER };
