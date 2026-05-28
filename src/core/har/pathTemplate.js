'use strict';

/**
 * Path-template inference for HAR → OpenAPI capture (Fix 2 of the BDCT
 * fidelity roadmap).
 *
 * Goal: turn concrete request paths recorded in real traffic into OpenAPI
 * path templates, e.g.
 *   /users/123/orders/550e8400-e29b-41d4-a716-446655440000
 *     → /users/{userId}/orders/{orderId}
 *
 * Heuristic (intentionally conservative — false positives cost more than
 * false negatives because over-templating destroys meaningful endpoint
 * shape):
 *
 *   A segment is "dynamic" iff it matches one of:
 *     - all digits                       e.g. "123", "42"
 *     - UUID                             e.g. "550e8400-…"
 *     - hex-only ≥ 8 chars               e.g. "9a3f7c1b"  (mongo-style ids)
 *     - has a digit AND a hyphen/underscore   e.g. "PAY-2026-001"
 *
 *   Pure-alpha segments ("orders", "summary", "profile") stay literal.
 *
 * Param naming: if the preceding segment is alpha (a resource name), the
 * synthesised param is "<singular>Id" (rough singularise: strip trailing
 * `s`), so /users/123 → /users/{userId}. Otherwise it's plain "id".
 *
 * Custom dynamic patterns can be supplied via `opts.dynamicPatterns` —
 * an array of RegExp matched against each segment.
 */

const UUID_RE   = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX_RE    = /^[0-9a-f]{8,}$/i;
const DIGITS_RE = /^\d+$/;

function isDynamicSegment(seg, opts = {}) {
  if (!seg) return false;
  if (DIGITS_RE.test(seg)) return true;
  if (UUID_RE.test(seg))   return true;
  if (HEX_RE.test(seg))    return true;
  if (/[-_]/.test(seg) && /\d/.test(seg)) return true;
  if (Array.isArray(opts.dynamicPatterns)) {
    for (const re of opts.dynamicPatterns) if (re.test(seg)) return true;
  }
  return false;
}

function paramNameFromContext(prevSegment) {
  if (!prevSegment || !/^[a-z][a-z0-9_-]*$/i.test(prevSegment)) return 'id';
  // Rough singularisation: users → user, orders → order, but "address" → "addres"
  // is wrong. Only apply when the result still has >1 char AND the original
  // ends in a plural-looking 's' (not 'ss' which is usually mass-noun).
  const m = /^(.+?)s$/.exec(prevSegment);
  const base = (m && !/ss$/.test(prevSegment)) ? m[1] : prevSegment;
  if (!base || base.length < 2) return 'id';
  return `${base}Id`;
}

/**
 * Convert a concrete path (no query string) into a templated path.
 * Returns { templated, paramNames }.
 */
function templatePath(concretePath, opts = {}) {
  if (typeof concretePath !== 'string' || concretePath.length === 0) {
    return { templated: '/', paramNames: [] };
  }
  // Strip query if caller accidentally passed it.
  const q = concretePath.indexOf('?');
  const clean = q >= 0 ? concretePath.slice(0, q) : concretePath;

  const segments = clean.split('/');
  const paramNames = [];
  // De-duplicate within one path so /users/1/users/2 → /users/{userId}/users/{userId2}
  const used = new Map();

  for (let i = 0; i < segments.length; i++) {
    const s = segments[i];
    if (!s) continue;
    if (isDynamicSegment(s, opts)) {
      let name = paramNameFromContext(segments[i - 1]);
      const seen = used.get(name) || 0;
      if (seen > 0) name = `${name}${seen + 1}`;
      used.set(name.replace(/\d+$/, '') || name, seen + 1);
      segments[i] = `{${name}}`;
      paramNames.push(name);
    }
  }
  const joined = segments.join('/');
  return { templated: joined || '/', paramNames };
}

module.exports = { templatePath, isDynamicSegment, paramNameFromContext };
