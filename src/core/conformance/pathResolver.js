'use strict';

/**
 * Resolve OpenAPI path-template parameters into concrete URL paths.
 * Sources, in priority order:
 *   1. caller-supplied overrides (e.g. CLI `--path-params paymentId=pay-123`)
 *   2. the operation's `parameters[].example` for each path-param
 *   3. the path-item-level `parameters[].example`
 *   4. the parameter schema's `example`
 *
 * If a required path param can't be resolved, the probe is skipped (with a
 * `missing` list so the runner can report it).
 */

/**
 * @param template     '/users/{userId}/orders/{orderId}'
 * @param resolvedMap  { userId: 'u-1', orderId: 'o-7' }   (already-resolved)
 * @returns            { resolved: string, missing: string[] }
 */
function substitute(template, resolvedMap) {
  const missing = [];
  const resolved = template.replace(/\{([^}]+)\}/g, (_full, name) => {
    const v = resolvedMap && Object.prototype.hasOwnProperty.call(resolvedMap, name)
      ? resolvedMap[name]
      : undefined;
    if (v === undefined || v === null || v === '') { missing.push(name); return `{${name}}`; }
    return encodeURIComponent(String(v));
  });
  return { resolved, missing };
}

/**
 * Walk the spec to gather examples for path params. Returns a map per-route:
 *   { '/users/{userId}': { GET: { userId: 'u-1' }, … }, … }
 *
 * Operation-level params override path-item-level params (standard OAS rule).
 */
function collectSpecExamples(spec) {
  const out = {};
  const paths = (spec && spec.paths) || {};
  const METHODS = ['get','put','post','delete','options','head','patch','trace'];

  for (const [routePath, item] of Object.entries(paths)) {
    if (!item || typeof item !== 'object') continue;
    out[routePath] = {};

    const pathLevelParams = Array.isArray(item.parameters) ? item.parameters : [];
    for (const method of METHODS) {
      const op = item[method];
      if (!op || typeof op !== 'object') continue;
      const opParams = Array.isArray(op.parameters) ? op.parameters : [];

      const merged = {};
      for (const p of pathLevelParams) addExample(merged, p);
      for (const p of opParams)        addExample(merged, p);   // op overrides
      out[routePath][method.toUpperCase()] = merged;
    }
  }
  return out;
}

function addExample(target, param) {
  if (!param || param.in !== 'path' || !param.name) return;
  const ex = param.example
         ?? (param.examples && firstExampleValue(param.examples))
         ?? (param.schema && param.schema.example);
  if (ex !== undefined) target[param.name] = ex;
}

function firstExampleValue(examples) {
  for (const v of Object.values(examples || {})) {
    if (v && v.value !== undefined) return v.value;
  }
  return undefined;
}

/**
 * Resolve a single probe's path. CLI overrides win over spec examples.
 *
 * @param routePath        '/users/{userId}'
 * @param method           'GET'
 * @param specExamples     output of collectSpecExamples(spec)
 * @param cliOverrides     { userId: 'u-7', ... } (global)
 */
function resolveProbePath(routePath, method, specExamples, cliOverrides) {
  const fromSpec = (specExamples[routePath] && specExamples[routePath][method.toUpperCase()]) || {};
  const merged = { ...fromSpec, ...(cliOverrides || {}) };
  return substitute(routePath, merged);
}

/**
 * Parse a CLI string `paymentId=pay-123,userId=u-7` into a map.
 * Multiple `--path-params` flags can be joined by the caller before parsing.
 */
function parsePathParamsArg(arg) {
  if (!arg) return {};
  const map = {};
  for (const pair of String(arg).split(',')) {
    const [k, ...rest] = pair.split('=');
    if (!k) continue;
    map[k.trim()] = rest.join('=').trim();
  }
  return map;
}

module.exports = {
  substitute, collectSpecExamples, resolveProbePath, parsePathParamsArg,
};
