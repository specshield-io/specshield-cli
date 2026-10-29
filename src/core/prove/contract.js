'use strict';

/**
 * One operation's contract, read from a raw spec (OpenAPI 3.x or Swagger 2.0):
 * its parameters, request body and responses. Plus the two things a witness
 * needs from it: build an HTTP request, and say whether a request satisfies it.
 *
 *   Request = {
 *     method: 'POST', path: '/orders/{id}',
 *     params: { 'path:id': 1, 'query:limit': 10, 'header:X-Trace': 'abc' },  // typed values
 *     body: <JSON> | undefined,
 *   }
 *
 * Parameter values are kept typed; they are checked the way a server reads
 * them off the wire (strings parsed into the declared type).
 */

const L = require('../fix/locate');
const S = require('./schema');
const { generate, OMIT } = require('./instance');

const JSON_TYPE = /^application\/(.+\+)?json$|^\*\/\*$/i;
const FORM_TYPE = /^application\/x-www-form-urlencoded$/i;

function contractOf(doc, method, path) {
  const m = method.toLowerCase();
  const op = L.operationPtr(doc, m, path);
  if (!op) return { doc, method: m.toUpperCase(), path, exists: false, params: [], body: null, responses: {} };

  const params = [];
  let body = null;
  for (const { node } of L.parameterPtrs(doc, m, path)) {
    if (node.in === 'body') {
      body = { schema: node.schema || null, required: Boolean(node.required), mediaType: 'application/json', json: true, form: false, structured: true };
      continue;
    }
    // Swagger 2.0 formData fields stay parameters (the diff engine reports them
    // as parameters); they travel as a form body.
    params.push({
      name: node.name,
      in: node.in,
      key: `${node.in}:${node.name}`,
      required: node.in === 'path' ? true : Boolean(node.required),
      schema: node.schema || (node.type ? inlineSchema(node) : node.content ? contentSchema(node.content) : null),
      style: node.style || null,
      explode: node.explode,
      collectionFormat: node.collectionFormat || null,
    });
  }

  const rb = S.deref(doc, L.get(doc, [...op, 'requestBody']));
  if (rb && rb.content) {
    const types = Object.keys(rb.content);
    const jsonType = types.find((t) => JSON_TYPE.test(t));
    const formType = types.find((t) => FORM_TYPE.test(t));
    const type = jsonType || formType || types[0];
    body = {
      schema: (rb.content[type] && rb.content[type].schema) || null,
      required: Boolean(rb.required),
      mediaType: type,
      json: Boolean(jsonType),
      form: !jsonType && Boolean(formType),
      structured: Boolean(jsonType || formType),
    };
  }

  const responses = {};
  for (const code of Object.keys(L.get(doc, [...op, 'responses']) || {})) {
    const ptr = L.responseSchemaPtr(doc, m, path, code);
    responses[code] = { schema: ptr ? L.get(doc, ptr) : null };
  }
  return { doc, method: m.toUpperCase(), path, exists: true, params, body, responses };
}

/** Swagger 2.0 non-body parameters declare their schema inline. */
function inlineSchema(p) {
  const { name, in: _in, required, description, collectionFormat, allowEmptyValue, ...schema } = p;
  return schema;
}

function contentSchema(content) {
  const first = Object.values(content)[0];
  return first && first.schema ? first.schema : null;
}

/** The response entry a status code falls under: exact, "2XX", then "default". */
function responseFor(contract, code) {
  const c = String(code);
  const r = contract.responses;
  for (const key of [c, `${c[0]}XX`, `${c[0]}xx`, 'default']) if (r[key]) return { key, ...r[key] };
  return null;
}

// ─── building requests ──────────────────────────────────────────────────────

/**
 * A request for `contract`. Required parameters always; optional ones too with
 * `full`. `target` puts one value in place: { param: 'query:limit', value } or
 * { body: steps, value } (value may be OMIT). `like` copies parameter values
 * from another request where this contract declares the same parameter, so a
 * witness and its control differ only where they must.
 */
function buildRequest(contract, { full = false, variant = 0, examples = true, target = null, like = null } = {}) {
  const { doc } = contract;
  const params = {};
  for (const p of contract.params) {
    if (target && target.param === p.key) {
      if (target.value !== OMIT) params[p.key] = target.value;
      continue;
    }
    if (like && like.params[p.key] !== undefined) { params[p.key] = like.params[p.key]; continue; }
    if (!p.required && !full) continue;
    params[p.key] = p.schema ? generate(doc, p.schema, { side: 'request', full, examples, variant }) : 'abc';
  }
  if (target && target.param && !contract.params.some((p) => p.key === target.param) && target.value !== OMIT) {
    params[target.param] = target.value;
  }

  let body;
  if (contract.body && contract.body.structured && contract.body.schema) {
    const bodyTarget = target && target.body ? { steps: target.body, value: target.value } : null;
    if (like && like.body !== undefined && !bodyTarget) body = like.body;
    else if (contract.body.required || full || bodyTarget || (like && like.body !== undefined)) {
      body = generate(doc, contract.body.schema, { side: 'request', full, examples, variant, target: bodyTarget });
    }
  }
  return { method: contract.method, path: contract.path, params, body, mediaType: contract.body ? contract.body.mediaType : null };
}

// ─── checking requests ──────────────────────────────────────────────────────

/**
 * Does `req` satisfy `contract`? Returns the reasons it doesn't, each tagged
 * with the part of the request it is about ({ part: 'query:limit' | 'body' |
 * 'operation' }). Undeclared parameters are not an error — servers ignore them.
 */
function checkRequest(contract, req) {
  const problems = [];
  if (!contract.exists) {
    return [{ part: 'operation', message: `${contract.method} ${contract.path} is not in this spec`, errors: [] }];
  }
  for (const p of contract.params) {
    const v = req.params[p.key];
    if (v === undefined) {
      if (p.required) problems.push({ part: p.key, message: `${p.in} parameter "${p.name}" is required`, errors: [] });
      continue;
    }
    if (!p.schema) continue;
    const r = S.validator(contract.doc, p.schema, { side: 'request', kind: 'param' })(wire(v));
    if (!r.ok) problems.push({ part: p.key, message: r.errors.map((e) => S.describeError(e, `${p.in} parameter "${p.name}"`)).join('; '), errors: r.errors });
  }
  const b = contract.body;
  if (b && b.structured && b.schema) {
    if (req.body === undefined) {
      if (b.required) problems.push({ part: 'body', message: 'a request body is required', errors: [] });
    } else {
      // Form fields arrive as text and are parsed into the declared types, like parameters.
      const r = S.validator(contract.doc, b.schema, { side: 'request', kind: b.form ? 'param' : 'body' })(req.body);
      if (!r.ok) problems.push({ part: 'body', label: 'body', message: r.errors.map((e) => S.describeError(e)).join('; '), errors: r.errors });
    }
  }
  return problems;
}

/** A parameter value as a server receives it: strings (or a list of them). */
function wire(v) {
  if (Array.isArray(v)) return v.map((x) => (typeof x === 'object' && x !== null ? JSON.stringify(x) : String(x)));
  if (v !== null && typeof v === 'object') return v;              // deepObject: leave as an object
  return String(v);
}

/** Check a response body against the contract's schema for `code`. */
function checkResponse(contract, code, body) {
  const r = responseFor(contract, code);
  if (!r) return { ok: false, documented: false, errors: [{ path: '', keyword: 'status', message: `status ${code} is not documented`, params: {} }] };
  if (!r.schema) return { ok: true, documented: true, errors: [] };
  return { documented: true, ...S.validator(contract.doc, r.schema, { side: 'response' })(body) };
}

// ─── rendering ──────────────────────────────────────────────────────────────

/** "/orders/{id}?limit=10" with values filled in, plus the headers. */
function urlOf(contract, req) {
  let path = req.path;
  const query = [];
  const headers = {};
  const form = [];
  for (const [key, v] of Object.entries(req.params)) {
    const [loc, ...rest] = key.split(':');
    const name = rest.join(':');
    const p = contract.params.find((x) => x.key === key) || { name, in: loc };
    if (loc === 'path') path = path.split(`{${name}}`).join(encodeURIComponent(serialize(v, p, ',')));
    else if (loc === 'query') {
      const explode = p.explode !== undefined ? p.explode : (p.collectionFormat ? p.collectionFormat === 'multi' : true);
      if (Array.isArray(v) && explode) for (const x of v) query.push(`${encodeURIComponent(name)}=${encodeURIComponent(scalar(x))}`);
      else query.push(`${encodeURIComponent(name)}=${encodeURIComponent(serialize(v, p, delimiter(p)))}`);
    } else if (loc === 'formData') {
      const explode = p.collectionFormat === 'multi';
      if (Array.isArray(v) && explode) for (const x of v) form.push(`${encodeURIComponent(name)}=${encodeURIComponent(scalar(x))}`);
      else form.push(`${encodeURIComponent(name)}=${encodeURIComponent(serialize(v, p, delimiter(p)))}`);
    } else if (loc === 'header') headers[name] = serialize(v, p, ',');
    else if (loc === 'cookie') headers.Cookie = [headers.Cookie, `${name}=${serialize(v, p, ',')}`].filter(Boolean).join('; ');
  }
  return { path: path + (query.length ? `?${query.join('&')}` : ''), headers, form: form.length ? form.join('&') : null };
}

/**
 * A form body for a structured value, in the bracket notation most servers
 * parse (Rails, PHP, Stripe): a[b]=1&list[0]=x.
 */
function formEncode(value, prefix = '') {
  const out = [];
  const add = (k, v) => out.push(`${encodeURIComponent(k).replace(/%5B/g, '[').replace(/%5D/g, ']')}=${encodeURIComponent(v)}`);
  const walk = (v, key) => {
    if (v === undefined) return;
    if (v === null) { add(key, ''); return; }
    if (Array.isArray(v)) { v.forEach((x, i) => walk(x, `${key}[${i}]`)); return; }
    if (typeof v === 'object') { for (const [k, x] of Object.entries(v)) walk(x, key ? `${key}[${k}]` : k); return; }
    add(key, String(v));
  };
  walk(value, prefix);
  return out.join('&');
}

function delimiter(p) {
  if (p.collectionFormat === 'ssv' || p.style === 'spaceDelimited') return ' ';
  if (p.collectionFormat === 'pipes' || p.style === 'pipeDelimited') return '|';
  if (p.collectionFormat === 'tsv') return '\t';
  return ',';
}

function serialize(v, p, sep) {
  if (Array.isArray(v)) return v.map(scalar).join(sep);
  return scalar(v);
}

function scalar(v) {
  return v !== null && typeof v === 'object' ? JSON.stringify(v) : String(v);
}

module.exports = { contractOf, responseFor, buildRequest, checkRequest, checkResponse, urlOf, wire, formEncode, JSON_TYPE };
