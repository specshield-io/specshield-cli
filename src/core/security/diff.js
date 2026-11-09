'use strict';

/**
 * Security regressions between two specs. Works on the raw documents, because
 * normalizeSpec has no notion of `security`.
 *
 *   breaking   AUTH_REMOVED, AUTH_SCOPE_REDUCED, AUTH_WEAKENED,
 *              ENDPOINT_ADDED_WITHOUT_AUTH, SENSITIVE_FIELD_EXPOSED
 *   warnings   AUTH_CHANGED, PUBLIC_ENDPOINT_ADDED, SENSITIVE_FIELD_EXPOSED (lower tiers)
 *
 * A requirement is a list of alternatives (OR), each a map of scheme → scopes
 * (AND). The new requirement is at least as strict when every new alternative
 * implies some old one: a credential that passes it would have passed before.
 */

const METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'];
const MAX_DEPTH = 12;

function securityDiff(baseDoc, headDoc) {
  const base = operations(baseDoc);
  const head = operations(headDoc);
  const found = [];
  for (const [key, h] of head) {
    const b = base.get(key);
    const headReq = requirement(headDoc, h.op);
    if (!b) found.push(...addedEndpoint(h, headReq, headDoc));
    else found.push(...authChange(b, h, requirement(baseDoc, b.op), headReq, baseDoc, headDoc));
    found.push(...exposedFields(b, h, baseDoc, headDoc, headReq));
  }
  const merged = merge(found);
  return {
    breaking: merged.filter((f) => f.severity === 'error'),
    warnings: merged.filter((f) => f.severity !== 'error'),
  };
}

function operations(doc) {
  const ops = new Map();
  for (const [path, item] of Object.entries((doc && doc.paths) || {})) {
    if (!item || typeof item !== 'object') continue;
    for (const method of METHODS) {
      if (!item[method] || typeof item[method] !== 'object') continue;
      // A renamed path parameter is the same operation.
      ops.set(`${method} ${path.replace(/\{[^}]+\}/g, '{}')}`, { path, method, op: item[method], item });
    }
  }
  return ops;
}

// ─── authentication ─────────────────────────────────────────────────────────

/** An operation's own `security` wins, even when empty; otherwise the document's. */
function requirement(doc, op) {
  const source = Array.isArray(op.security) ? 'operation' : Array.isArray(doc.security) ? 'global' : 'none';
  const raw = source === 'operation' ? op.security : source === 'global' ? doc.security : [];
  const alts = raw.filter((a) => a && typeof a === 'object').map((a) => {
    const out = {};
    for (const [scheme, scopes] of Object.entries(a)) out[scheme] = Array.isArray(scopes) ? scopes : [];
    return out;
  });
  return { source, alternatives: alts.length ? alts : [{}] };
}

const isAnonymous = (alt) => Object.keys(alt).length === 0;
const allowsAnonymous = (req) => req.alternatives.some(isAnonymous);
const subset = (a, b) => a.every((x) => b.includes(x));

function schemeOf(doc, name) {
  const all = (doc.components && doc.components.securitySchemes) || doc.securityDefinitions || {};
  let s = all[name];
  if (s && s.$ref) s = all[String(s.$ref).split('/').pop()];
  return s && typeof s === 'object' ? s : null;
}

/** Relative strength of one scheme; null when the spec doesn't define it. */
function strength(doc, name) {
  const s = schemeOf(doc, name);
  if (!s) return null;
  const type = String(s.type || '').toLowerCase();
  if (type === 'mutualtls') return 4;
  if (type === 'oauth2' || type === 'openidconnect') return 3;
  if (type === 'basic') return 1;                                   // Swagger 2.0
  if (type === 'apikey') return String(s.in).toLowerCase() === 'query' ? 1 : 2;   // in a URL it ends up in logs
  if (type === 'http') return String(s.scheme).toLowerCase() === 'basic' ? 1 : 3;
  return null;
}

/** An alternative is as strong as its strongest scheme. */
function altStrength(doc, alt) {
  const names = Object.keys(alt);
  if (!names.length) return 0;
  const all = names.map((n) => strength(doc, n));
  return all.includes(null) ? null : Math.max(...all);
}

function implies(h, b, headDoc, baseDoc) {
  if (!Object.keys(b).every((s) => s in h && subset(b[s], h[s]))) return false;
  const hs = altStrength(headDoc, h);
  const bs = altStrength(baseDoc, b);
  return hs === null || bs === null || hs >= bs;
}

function authChange(b, h, baseReq, headReq, baseDoc, headDoc) {
  const loose = headReq.alternatives.filter((alt) => !baseReq.alternatives.some((x) => implies(alt, x, headDoc, baseDoc)));
  if (!loose.length) return [];
  const ep = endpoint(h);
  const was = describeReq(baseReq);
  const global = baseReq.source === 'global' && headReq.source !== 'operation';
  const at = global ? 'The API-wide security requirement' : ep;
  const finding = (type, severity, field, description) => ({
    ...change(type, h, severity, field, description),
    ...(global ? { mergeAs: `${type}|${field || ''}|${description}` } : {}),
  });

  if (loose.some(isAnonymous)) {
    return [finding('AUTH_REMOVED', 'error', null, `Security: ${at} no longer requires authentication (was ${was}) — anyone can call ${global ? 'these endpoints' : 'it'}`)];
  }
  for (const alt of loose) {
    for (const x of baseReq.alternatives) {
      const names = Object.keys(x);
      if (names.length !== Object.keys(alt).length || !names.every((s) => s in alt)) continue;
      const scheme = names.find((s) => !subset(x[s], alt[s]));
      if (scheme && names.every((s) => subset(alt[s], x[s]))) {
        const dropped = x[scheme].filter((s) => !alt[scheme].includes(s));
        return [finding('AUTH_SCOPE_REDUCED', 'error', scheme, `Security: ${at} no longer requires ${dropped.length === 1 ? 'scope' : 'scopes'} ${dropped.join(', ')} on ${scheme}`)];
      }
    }
  }
  const floor = Math.min(...baseReq.alternatives.map((x) => altStrength(baseDoc, x) ?? Infinity));
  for (const alt of loose) {
    const s = altStrength(headDoc, alt);
    const fewer = baseReq.alternatives.some((x) => Object.keys(alt).length < Object.keys(x).length && Object.keys(alt).every((n) => n in x));
    if (fewer || (s !== null && s < floor)) {
      return [finding('AUTH_WEAKENED', 'error', Object.keys(alt).join('+'), `Security: ${at} now accepts weaker authentication: ${describeAlt(alt, headDoc)} (was ${was})`)];
    }
  }
  return [finding('AUTH_CHANGED', 'warning', Object.keys(loose[0]).join('+'), `Security: ${at} now accepts ${describeAlt(loose[0], headDoc)} (was ${was}) — check it grants no more than before`)];
}

/**
 * A new endpoint with no security at all, in an API that protects others, was
 * most likely forgotten; `security: []` was written on purpose, so it's only flagged.
 */
function addedEndpoint(h, req, doc) {
  if (!allowsAnonymous(req)) return [];
  if (req.source === 'operation') {
    return [change('PUBLIC_ENDPOINT_ADDED', h, 'warning', null, `Security: new endpoint ${endpoint(h)} is public (security: [])`)];
  }
  if (!declaresAuth(doc)) return [];
  return [change('ENDPOINT_ADDED_WITHOUT_AUTH', h, 'error', null, `Security: new endpoint ${endpoint(h)} has no authentication, unlike the rest of this API — add security, or "security: []" if it is meant to be public`)];
}

/** Specs that declare no auth anywhere say nothing about which endpoints are public. */
function declaresAuth(doc) {
  if ((doc.security || []).some((a) => a && Object.keys(a).length)) return true;
  return [...operations(doc).values()].some((o) => !allowsAnonymous(requirement(doc, o.op)));
}

function describeAlt(alt, doc) {
  return Object.entries(alt).map(([name, scopes]) => {
    const s = schemeOf(doc, name);
    const kind = !s ? '' : s.type === 'apiKey' ? ` (API key in ${s.in})` : s.type === 'http' ? ` (${s.scheme})` : s.type === 'basic' ? ' (basic)' : '';
    return `${name}${kind}${scopes.length ? ` [${scopes.join(', ')}]` : ''}`;
  }).join(' + ') || 'no authentication';
}

function describeReq(req) {
  return req.alternatives.map((a) => (isAnonymous(a) ? 'anonymous' : Object.entries(a).map(([n, s]) => `${n}${s.length ? ` [${s.join(', ')}]` : ''}`).join(' + '))).join(' or ');
}

// ─── sensitive fields in responses ──────────────────────────────────────────

const CREDENTIAL = /(^|_)(password|passwd|pwd|passphrase|secret|private_key|api_key|apikey)$/;
const REGULATED = /(^|_)(ssn|social_security_number|aadhaar|cvv|cvc|card_number|credit_card_number|passport_number|tax_id|bank_account_number)$/;
const TOKEN = /(^|_)(access_token|refresh_token|id_token|auth_token|session_token|bearer_token|jwt|session_id)$/;
const PERSONAL = /(^|_)(email|email_address|phone|phone_number|date_of_birth|dob|birthdate|birth_date|home_address)$/;
// The name has to end in the term: password_changed_at, secret_scanning_status and
// cvc_check are facts about a secret, not the secret.
const words = (name) => String(name)
  .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
  .replace(/[^A-Za-z0-9]+/g, '_')
  .toLowerCase();

/** credential | regulated | token | personal | null */
function sensitivity(name, schema) {
  const types = [].concat((schema && schema.type) || 'string');
  if (!types.includes('string')) return null;
  const w = words(name);
  if (schema && schema.format === 'password') return 'credential';
  if (CREDENTIAL.test(w)) return 'credential';
  if (REGULATED.test(w)) return 'regulated';
  if (TOKEN.test(w)) return 'token';
  if (PERSONAL.test(w) || (schema && schema.format === 'email')) return 'personal';
  return null;
}

const LABEL = { credential: 'a credential', regulated: 'regulated personal data', token: 'a token', personal: 'personal data' };

function exposedFields(b, h, baseDoc, headDoc, headReq) {
  const before = new Set(b ? sensitiveResponseFields(baseDoc, b.op).map((f) => leaf(f.path)) : []);
  const isPublic = allowsAnonymous(headReq) && (headReq.source === 'operation' || declaresAuth(headDoc));
  const seen = new Set();
  const out = [];
  for (const f of sensitiveResponseFields(headDoc, h.op)) {
    const name = leaf(f.path);
    if (before.has(name) || seen.has(name)) continue;
    seen.add(name);
    const high = f.tier === 'credential' || f.tier === 'regulated' || isPublic;
    const where = isPublic ? 'a public response' : 'a response';
    const via = f.path === name ? '' : ` (at ${f.path})`;
    out.push({
      ...change('SENSITIVE_FIELD_EXPOSED', h, high ? 'error' : 'warning', name, `Security: new field "${name}"${via} in ${where} looks like ${LABEL[f.tier]}`),
      mergeAs: `exposed|${name}|${f.tier}|${isPublic}`,
    });
  }
  return out;
}

const leaf = (p) => p.split('.').pop().replace(/\[\]$/, '');

/** Sensitive fields a 2xx response can carry, with their paths. */
function sensitiveResponseFields(doc, op) {
  const out = [];
  for (const [status, raw] of Object.entries(op.responses || {})) {
    if (!/^2/.test(status)) continue;
    const res = deref(doc, raw);
    if (!res) continue;
    const schemas = res.schema ? [res.schema] : Object.entries(res.content || {})
      .filter(([type]) => /json/i.test(type)).map(([, m]) => m && m.schema).filter(Boolean);
    for (const s of schemas) out.push(...fields(doc, s, sensitivity, 'writeOnly'));
  }
  return out;
}

const memos = new WeakMap();
function memoFor(doc, classify) {
  if (!memos.has(doc)) memos.set(doc, new Map());
  const byClassifier = memos.get(doc);
  if (!byClassifier.has(classify)) byClassifier.set(classify, new Map());
  return byClassifier.get(classify);
}

function deref(doc, node) {
  let n = node;
  for (let i = 0; n && n.$ref && i < 20; i++) {
    if (typeof n.$ref !== 'string' || !n.$ref.startsWith('#/')) return null;
    n = n.$ref.slice(2).split('/').reduce((o, k) => (o ? o[k.replace(/~1/g, '/').replace(/~0/g, '~')] : undefined), doc);
  }
  return n && typeof n === 'object' ? n : null;
}

/** [{path, tier}] for each property `classify(name, schema)` tags; `skip` names a flag that hides a property. */
function fields(doc, schema, classify, skip) {
  return walk({ doc, classify, skip, memo: memoFor(doc, classify), stack: new Set() }, schema, 0);
}

/** Named schemas are memoized; cycles are cut. */
function walk(ctx, node, depth) {
  if (!node || depth > MAX_DEPTH) return [];
  const { doc, memo, stack } = ctx;
  if (node.$ref) {
    if (memo.has(node.$ref)) return memo.get(node.$ref);
    if (stack.has(node.$ref)) return [];
    stack.add(node.$ref);
    const r = walk(ctx, deref(doc, node), depth + 1);
    stack.delete(node.$ref);
    memo.set(node.$ref, r);
    return r;
  }
  const out = [];
  for (const key of ['allOf', 'oneOf', 'anyOf']) {
    if (Array.isArray(node[key])) for (const s of node[key]) out.push(...walk(ctx, s, depth + 1));
  }
  if (node.items) out.push(...walk(ctx, node.items, depth + 1).map((f) => ({ ...f, path: `[].${f.path}` })));
  if (node.additionalProperties && typeof node.additionalProperties === 'object') {
    out.push(...walk(ctx, node.additionalProperties, depth + 1));
  }
  for (const [name, raw] of Object.entries(node.properties || {})) {
    const prop = deref(doc, raw);
    if (!prop || prop[ctx.skip]) continue;
    const tier = ctx.classify(name, prop);
    if (tier) out.push({ path: name, tier });
    out.push(...walk(ctx, raw, depth + 1).map((f) => ({ ...f, path: `${name}.${f.path}` })));
  }
  return out.map((f) => ({ ...f, path: f.path.replace(/^\[\]\./, '') }));
}

// ─── findings ───────────────────────────────────────────────────────────────

const endpoint = (h) => `${h.method.toUpperCase()} ${h.path}`;

function change(type, h, severity, field, description) {
  return { type, category: 'security', path: h.path, method: h.method, field, severity, description };
}

/** One finding for a cause shared by many endpoints: a global requirement or a shared schema. */
function merge(found) {
  const out = [];
  const groups = new Map();
  for (const f of found) {
    const { mergeAs, ...c } = f;
    const ep = `${c.method.toUpperCase()} ${c.path}`;
    const g = mergeAs && groups.get(mergeAs);
    if (g) { g.affectedEndpoints.push(ep); continue; }
    const item = { ...c, affectedEndpoints: [ep] };
    if (mergeAs) groups.set(mergeAs, item);
    out.push(item);
  }
  return out;
}

module.exports = {
  securityDiff, requirement, sensitivity, operations, allowsAnonymous, declaresAuth,
  schemeOf, deref, fields, sensitiveResponseFields, leaf, words,
};
