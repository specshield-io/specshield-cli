'use strict';

/**
 * `specshield audit`: what a spec alone reveals about an API's security, by
 * OWASP API Security Top 10 category. Only declared behaviour is judged — the
 * running service may be stricter or looser.
 */

const D = require('./diff');
const { finding } = require('./rules');
const { isLocalHost } = require('../prove/http');

// Writes that are public by design.
const OPEN_BY_DESIGN = /(^|\/)(login|logout|signin|sign-in|signup|sign-up|register|token|oauth2?|auth|authenticate|password|forgot|reset|webhooks?|callbacks?|health|ready|ping|verify)(\/|$)/i;
const ADMIN = /(^|\/)(admin|internal|debug|actuator)(\/|$)/i;
const NON_PROD = /(^|[.-])(dev|develop|staging|stage|test|qa|sandbox|uat|internal)([.-]|$)/i;
const PAGE_SIZE = /^(limit|per_page|page_size|size|top|max_results)$/;
const PAGING = /^(limit|per_page|page_size|size|top|max_results|page|offset|cursor|next|page_token|after|before|starting_after|skip)$/;
const ELEVATING = /^(is_)?(admin|superuser|staff|root)$/;
const PRIVILEGED = /^(role|roles|permissions|privileges|owner_id|tenant_id)$/;
const URL_FIELD = /(^|_)(url|uri|webhook|callback|redirect)$/;

function auditSpec(doc) {
  const out = [...documentRules(doc)];
  const declared = D.declaresAuth(doc);
  for (const o of D.operations(doc).values()) out.push(...operationRules(doc, o, declared));
  return out;
}

const hostOf = (url) => { const m = /^[a-z]+:\/\/([^/:?#]+)/i.exec(url); return m ? m[1].toLowerCase() : null; };
const cleartext = (url) => /^http:\/\//i.test(url) && !isLocalHost(hostOf(url) || '');

function documentRules(doc) {
  const out = [];
  if (D.operations(doc).size && !D.declaresAuth(doc)) out.push(finding('no-auth-declared', 'medium'));
  const urls = (doc.servers || []).map((s) => s && s.url).filter((u) => typeof u === 'string');
  if (doc.host) for (const scheme of doc.schemes || ['https']) urls.push(`${scheme}://${doc.host}`);
  for (const url of urls) {
    if (cleartext(url)) out.push(finding('insecure-server', 'high', { field: url }));
    const host = hostOf(url);
    if (host && !isLocalHost(host) && NON_PROD.test(host.split('.').slice(0, -1).join('.'))) {
      out.push(finding('non-production-server', 'low', { field: url }));
    }
  }
  const schemes = (doc.components && doc.components.securitySchemes) || doc.securityDefinitions || {};
  for (const name of Object.keys(schemes)) {
    const s = D.schemeOf(doc, name);
    if (!s) continue;
    const type = String(s.type).toLowerCase();
    if (type === 'apikey' && String(s.in).toLowerCase() === 'query') out.push(finding('api-key-in-query', 'high', { field: name }));
    if (type === 'basic' || (type === 'http' && String(s.scheme).toLowerCase() === 'basic')) out.push(finding('basic-auth', 'medium', { field: name }));
    if (type === 'oauth2') out.push(...oauthRules(name, s));
    if (type === 'openidconnect' && cleartext(String(s.openIdConnectUrl))) out.push(finding('oauth-insecure-url', 'high', { field: name }));
  }
  return out;
}

function oauthRules(name, s) {
  const out = [];
  const flows = s.flows ? Object.entries(s.flows) : [[s.flow, s]];           // Swagger 2.0 has one flow
  for (const [flow, f] of flows) {
    if (flow === 'implicit' || flow === 'password') out.push(finding('oauth-legacy-flow', 'medium', { field: name, detail: `${flow} flow` }));
    if (!f) continue;
    if ([f.authorizationUrl, f.tokenUrl, f.refreshUrl].some((u) => typeof u === 'string' && cleartext(u))) {
      out.push(finding('oauth-insecure-url', 'high', { field: name, detail: `${flow} flow` }));
    }
  }
  return out;
}

function parameters(doc, o) {
  const merged = new Map();
  for (const raw of [...(o.item.parameters || []), ...(o.op.parameters || [])]) {
    const p = D.deref(doc, raw);
    if (p && p.name && p.in) merged.set(`${p.in}:${p.name}`, p);
  }
  return [...merged.values()];
}

function operationRules(doc, o, declared) {
  const out = [];
  const endpoint = `${o.method.toUpperCase()} ${o.path}`;
  const add = (rule, severity, extra) => out.push(finding(rule, severity, { endpoint, ...extra }));
  const req = D.requirement(doc, o.op);
  const params = parameters(doc, o);
  const isPublic = declared && D.allowsAnonymous(req);
  const write = ['post', 'put', 'patch', 'delete'].includes(o.method);
  const admin = ADMIN.test(o.path);

  for (const alt of req.alternatives) {
    for (const name of Object.keys(alt)) {
      if (!D.schemeOf(doc, name)) add('undefined-security-scheme', 'high', { field: name });
    }
  }
  if (isPublic && admin) add('public-admin-endpoint', 'high');
  else if (isPublic && write && !OPEN_BY_DESIGN.test(o.path)) add('public-write', 'high');
  if (admin && !isPublic && declared && req.alternatives.every((a) => Object.entries(a).every(([n, sc]) => String((D.schemeOf(doc, n) || {}).type).toLowerCase() === 'oauth2' && !sc.length))) {
    add('admin-without-scope', 'low');
  }

  const paramSchema = (p) => D.deref(doc, p.schema) || p;
  for (const p of params) {
    const s = paramSchema(p);
    const w = D.words(p.name);
    if (p.in === 'query') {
      const tier = D.sensitivity(p.name, s);
      if (tier === 'credential' || tier === 'regulated' || tier === 'token') add('secret-in-query', 'high', { field: p.name });
    }
    if (p.in === 'path' && /(^|_)id$/.test(w) && s.type === 'integer') {
      add('enumerable-id', 'low', { field: p.name });
      if (isPublic && o.method === 'get') add('public-object-read', 'medium', { field: p.name });
    }
    if (p.in === 'query' && PAGE_SIZE.test(w) && s.type === 'integer' && s.maximum === undefined) add('limit-without-maximum', 'low', { field: p.name });
    if ((p.in === 'query' || p.in === 'formData') && urlInput(p.name, s)) add('url-input', 'low', { field: p.name });
  }

  if (o.method === 'get' && returnsBareList(doc, o.op) && !params.some((p) => p.in === 'query' && PAGING.test(D.words(p.name)))) {
    add('list-without-pagination', 'low');
  }

  const seen = new Set();
  for (const f of D.sensitiveResponseFields(doc, o.op)) {
    const name = D.leaf(f.path);
    const high = f.tier === 'credential' || f.tier === 'regulated' || isPublic;
    if (!high || seen.has(name)) continue;
    seen.add(name);
    add('sensitive-response-field', 'high', { field: name, detail: f.path === name ? f.tier : `${f.tier}, at ${f.path}` });
  }

  const taken = new Set();
  for (const schema of requestSchemas(doc, o)) {
    for (const f of D.fields(doc, schema, classifyInput, 'readOnly')) {
      const name = D.leaf(f.path);
      if (taken.has(name)) continue;
      taken.add(name);
      if (f.tier === 'url') add('url-input', 'low', { field: name, detail: f.path === name ? null : `at ${f.path}` });
      // Nested "permissions" usually configure the thing being created, not the caller.
      else if (!admin && f.path === name) add('mass-assignment-risk', f.tier === 'elevating' ? 'medium' : 'low', { field: name });
    }
  }
  return out;
}

function urlInput(name, s) {
  return URL_FIELD.test(D.words(name)) && [].concat(s.type || 'string').includes('string') && !s.enum && !s.pattern;
}

function classifyInput(name, s) {
  if (urlInput(name, s)) return 'url';
  const w = D.words(name);
  return ELEVATING.test(w) ? 'elevating' : PRIVILEGED.test(w) ? 'privileged' : null;
}

function requestSchemas(doc, o) {
  if (!['post', 'put', 'patch'].includes(o.method)) return [];
  const body = parameters(doc, o).find((p) => p.in === 'body');
  if (body) return body.schema ? [body.schema] : [];
  const rb = D.deref(doc, o.op.requestBody);
  return rb ? Object.values(rb.content || {}).map((m) => m && m.schema).filter(Boolean) : [];
}

function returnsBareList(doc, op) {
  return Object.entries(op.responses || {}).some(([status, raw]) => {
    if (!/^2/.test(status)) return false;
    const res = D.deref(doc, raw);
    if (!res) return false;
    const schemas = res.schema ? [res.schema] : Object.values(res.content || {}).map((m) => m && m.schema);
    return schemas.some((s) => { const n = D.deref(doc, s); return n && n.type === 'array'; });
  });
}

/** One finding per exposed field: a shared schema shouldn't count once per endpoint. */
function consolidate(findings) {
  const out = [];
  const merged = new Map();
  for (const f of findings) {
    if (f.rule !== 'sensitive-response-field') { out.push(f); continue; }
    const k = `${f.severity}|${f.field}`;
    if (merged.has(k)) { merged.get(k).affectedEndpoints.push(...f.affectedEndpoints); continue; }
    const item = { ...f, affectedEndpoints: [...f.affectedEndpoints] };
    merged.set(k, item);
    out.push(item);
  }
  return out;
}

module.exports = { auditSpec, consolidate };
