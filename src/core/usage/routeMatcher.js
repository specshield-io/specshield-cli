'use strict';

/**
 * Maps a concrete request path from a log ("/v1/orders/123/receipt") onto the
 * OpenAPI path template that serves it ("/orders/{orderId}/receipt").
 *
 * Handles the two things that make naive string matching fail:
 *   - base paths: spec paths are relative to servers[].url (OpenAPI 3) or
 *     basePath (Swagger 2), while logs record the full path;
 *   - overlapping templates: /users/me and /users/{id} both match "/users/me",
 *     and the one with more literal segments wins, as in most routers.
 *
 * Paths that are already templated (usage.json written without --spec stores
 * "/orders/{orderId}") also match: a "{…}" segment matches any template
 * parameter, never a literal.
 */

const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];

function createRouteMatcher(spec, opts = {}) {
  const routes = [];
  for (const [template, item] of Object.entries((spec && spec.paths) || {})) {
    if (!item || typeof item !== 'object') continue;
    const methods = new Set(HTTP_METHODS.filter((m) => item[m]).map((m) => m.toUpperCase()));
    if (methods.size === 0) continue;
    const segs = splitPath(template);
    routes.push({
      template,
      methods,
      matchers: segs.map(segmentMatcher),
      literals: segs.filter((s) => !s.includes('{')).length,
    });
  }

  const bySegCount = new Map();
  for (const r of routes) {
    const n = r.matchers.length;
    if (!bySegCount.has(n)) bySegCount.set(n, []);
    bySegCount.get(n).push(r);
  }
  for (const list of bySegCount.values()) list.sort((a, b) => b.literals - a.literals);

  const basePaths = resolveBasePaths(spec, opts.basePath);

  /**
   * @returns {{ template, method, operation: boolean } | null}
   *   operation=false when the path exists but the spec doesn't define that method.
   */
  function match(method, path) {
    const upper = String(method).toUpperCase();
    for (const prefix of basePaths) {
      let rel;
      if (prefix === '') rel = path;
      else if (path === prefix) rel = '/';
      else if (path.startsWith(prefix + '/')) rel = path.slice(prefix.length);
      else continue;

      const segs = splitPath(rel);
      const candidates = bySegCount.get(segs.length) || [];
      let pathOnly = null;
      for (const r of candidates) {
        if (!r.matchers.every((test, i) => test(segs[i]))) continue;
        if (r.methods.has(upper)) return { template: r.template, method: upper, operation: true };
        if (!pathOnly) pathOnly = { template: r.template, method: upper, operation: false };
      }
      if (pathOnly) return pathOnly;
    }
    return null;
  }

  return {
    match,
    basePaths: basePaths.filter(Boolean),
    operations: routes.flatMap((r) => [...r.methods].map((m) => ({ method: m, template: r.template }))),
  };
}

/** Longest base path first, always ending with '' (no prefix). */
function resolveBasePaths(spec, explicit) {
  const found = new Set();
  const add = (p) => {
    if (typeof p !== 'string') return;
    let clean = p.trim().replace(/\/{2,}/g, '/');
    if (clean.endsWith('/')) clean = clean.slice(0, -1);
    if (clean && clean.startsWith('/')) found.add(clean);
  };

  if (explicit) add(explicit);
  if (spec && typeof spec.basePath === 'string') add(spec.basePath);
  for (const server of (spec && Array.isArray(spec.servers) ? spec.servers : [])) {
    if (!server || typeof server.url !== 'string') continue;
    let url = server.url;
    for (const [name, v] of Object.entries(server.variables || {})) {
      if (v && v.default !== undefined) url = url.split(`{${name}}`).join(String(v.default));
    }
    if (url.includes('{')) continue;          // unresolved variable — can't use it
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) {
      try { add(new URL(url).pathname); } catch { /* malformed server url */ }
    } else {
      add(url.startsWith('/') ? url : null);
    }
  }
  return [...found].sort((a, b) => b.length - a.length).concat('');
}

function splitPath(p) {
  return String(p).split('/').filter(Boolean);
}

/** One template segment → predicate. "{id}" any value; "v{n}" / "{id}.json" partial. */
function segmentMatcher(seg) {
  if (!seg.includes('{')) {
    return (s) => s === seg;
  }
  if (/^\{[^}]+\}$/.test(seg)) {
    return (s) => typeof s === 'string' && s.length > 0;
  }
  const re = new RegExp('^' + seg.split(/\{[^}]+\}/).map(escapeRe).join('[^/]+') + '$');
  // An already-templated segment ("{orderId}") counts as matching any parameter.
  return (s) => typeof s === 'string' && (re.test(s) || /^\{[^}]+\}$/.test(s));
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = { createRouteMatcher, resolveBasePaths };
