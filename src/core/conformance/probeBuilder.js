'use strict';

/**
 * Build a flat list of conformance probes from a dereferenced OAS document.
 *
 *   Probe = {
 *     routePath:    '/users/{userId}',
 *     method:       'GET',
 *     operationId:  string | undefined,
 *     expectedResponses: { '200': schema, '404': schema, default?: schema },
 *     responseHeadersForStatus: { '200': { 'X-RateLimit-Remaining': { schema } } },
 *   }
 *
 * Safety: by default we only probe **safe** methods (GET, HEAD, OPTIONS).
 * Mutating verbs are opt-in via `includeMutating: true` so we never
 * accidentally side-effect a customer's staging data.
 */

const SAFE_METHODS    = new Set(['get', 'head', 'options']);
const ALL_METHODS     = ['get','put','post','delete','options','head','patch','trace'];
const JSON_MIME       = /\bjson\b/i;

/**
 * @param spec               dereferenced OAS document
 * @param opts.includeMutating   default false
 * @returns Probe[]
 */
function buildProbes(spec, opts = {}) {
  const includeMutating = opts.includeMutating === true;
  const allowed = includeMutating ? new Set(ALL_METHODS) : SAFE_METHODS;
  const out = [];

  const paths = (spec && spec.paths) || {};
  for (const [routePath, item] of Object.entries(paths)) {
    if (!item || typeof item !== 'object') continue;
    for (const method of ALL_METHODS) {
      const op = item[method];
      if (!op || typeof op !== 'object') continue;
      if (!allowed.has(method)) continue;

      out.push({
        routePath,
        method: method.toUpperCase(),
        operationId: op.operationId,
        expectedResponses: extractResponses(op.responses || {}),
      });
    }
  }
  return out;
}

/**
 * { '200': { content: { 'application/json': { schema } } }, '4XX': … }
 * →
 * { '200': schema | null, '4XX': schema | null, default?: schema | null }
 *
 * Pulls the JSON-content schema only (other content types deferred).
 */
function extractResponses(responses) {
  const out = {};
  for (const [code, body] of Object.entries(responses)) {
    if (!body) continue;
    const content = body.content || {};
    let schema = null;
    for (const [mime, c] of Object.entries(content)) {
      if (JSON_MIME.test(mime) && c && c.schema) { schema = c.schema; break; }
    }
    out[code] = schema;       // null = "documented status, no JSON schema"
  }
  return out;
}

/**
 * Match an actual response status (e.g. 200) against the spec's response keys
 * (which can be exact `"200"`, wildcard `"2XX"`, or `"default"`).
 * Returns the matching schema (possibly null) or undefined if nothing matches.
 */
function pickResponseSchema(probe, actualStatus) {
  const r = probe.expectedResponses;
  const code = String(actualStatus);
  if (Object.prototype.hasOwnProperty.call(r, code)) return r[code];
  const wildcard = code[0] + 'XX';
  if (Object.prototype.hasOwnProperty.call(r, wildcard)) return r[wildcard];
  if (Object.prototype.hasOwnProperty.call(r, wildcard.toLowerCase())) return r[wildcard.toLowerCase()];
  if (Object.prototype.hasOwnProperty.call(r, 'default')) return r['default'];
  return undefined;
}

module.exports = {
  buildProbes, extractResponses, pickResponseSchema,
  SAFE_METHODS, ALL_METHODS,
};
