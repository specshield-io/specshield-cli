'use strict';

/**
 * Finds things inside a RAW (un-normalized) spec document by the coordinates
 * the diff engine reports — (method, path, field) — and returns JSON-pointer
 * style paths (arrays of keys) into that document. Fixes are edits at those
 * paths, so they land where the author would make them: inside the shared
 * component a `$ref` points to, not in a copy.
 *
 * Field paths are the diff engine's: `requestBody.owner.name`,
 * `responses.200.items[items].tag`, `responses.200.data.oneOf[1].x`,
 * `requestBody.meta.<*>.label` (map values), `parameters.sort`.
 */

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'];
const REF_PREFIXES = [
  ['#/components/schemas/', ['components', 'schemas']],
  ['#/definitions/', ['definitions']],
  ['#/components/parameters/', ['components', 'parameters']],
  ['#/parameters/', ['parameters']],
  ['#/components/responses/', ['components', 'responses']],
  ['#/responses/', ['responses']],
  ['#/components/requestBodies/', ['components', 'requestBodies']],
];

function get(doc, ptr) {
  let cur = doc;
  for (const k of ptr) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = cur[k];
  }
  return cur;
}

/** "#/components/schemas/Pet" → ['components', 'schemas', 'Pet'] (also any local JSON pointer). */
function refToPtr(ref) {
  if (typeof ref !== 'string' || !ref.startsWith('#/')) return null;
  return ref.slice(2).split('/').map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~'));
}

function ptrToRef(ptr) {
  return '#/' + ptr.map((s) => String(s).replace(/~/g, '~0').replace(/\//g, '~1')).join('/');
}

/** Follows $ref chains from `ptr`; returns the pointer of the node that holds the content. */
function derefPtr(doc, ptr) {
  let cur = ptr;
  for (let i = 0; i < 20; i++) {
    const node = get(doc, cur);
    if (!node || typeof node !== 'object' || typeof node.$ref !== 'string') return cur;
    const next = refToPtr(node.$ref);
    if (!next) return cur;                                  // external ref: stop here
    cur = next;
  }
  return null;
}

function operationPtr(doc, method, path) {
  const ptr = ['paths', path, method.toLowerCase()];
  return get(doc, ptr) ? ptr : null;
}

/** Path-level + operation-level parameters, op-level winning — like normalizeSpec. */
function parameterPtrs(doc, method, path) {
  const out = new Map();
  for (const base of [['paths', path, 'parameters'], ['paths', path, method.toLowerCase(), 'parameters']]) {
    const list = get(doc, base);
    if (!Array.isArray(list)) continue;
    list.forEach((_, i) => {
      const p = derefPtr(doc, [...base, i]);
      const node = p && get(doc, p);
      if (node && node.name && node.in) out.set(`${node.in}:${node.name}`, { ptr: p, listPtr: [...base, i], node });
    });
  }
  return [...out.values()];
}

function findParameter(doc, method, path, name) {
  return parameterPtrs(doc, method, path).find((p) => p.node.name === name && p.node.in !== 'body') || null;
}

function mediaSchemaPtr(doc, contentPtr) {
  const content = get(doc, contentPtr);
  if (!content || typeof content !== 'object') return null;
  const type = content['application/json'] ? 'application/json' : Object.keys(content)[0];
  if (!type || !content[type] || !content[type].schema) return null;
  return [...contentPtr, type, 'schema'];
}

/** Pointer to the request body schema of an operation (OpenAPI 3 or Swagger 2.0 `in: body`). */
function requestSchemaPtr(doc, method, path) {
  const op = operationPtr(doc, method, path);
  if (!op) return null;
  const rb = get(doc, [...op, 'requestBody']);
  if (rb) {
    const rbPtr = derefPtr(doc, [...op, 'requestBody']);
    return rbPtr && mediaSchemaPtr(doc, [...rbPtr, 'content']);
  }
  const body = parameterPtrs(doc, method, path).find((p) => p.node.in === 'body');
  return body && body.node.schema ? [...body.ptr, 'schema'] : null;
}

function responseSchemaPtr(doc, method, path, code) {
  const op = operationPtr(doc, method, path);
  if (!op || !get(doc, [...op, 'responses', code])) return null;
  const rPtr = derefPtr(doc, [...op, 'responses', code]);
  const resp = rPtr && get(doc, rPtr);
  if (!resp) return null;
  if (resp.schema) return [...rPtr, 'schema'];                // Swagger 2.0
  return resp.content ? mediaSchemaPtr(doc, [...rPtr, 'content']) : null;
}

/**
 * Splits a diff field path into its root and schema steps:
 *   "responses.200.items[items].tag" → { side: 'response', code: '200', steps: ['items', '[items]', 'tag'] }
 */
function parseField(field) {
  let m = /^requestBody(.*)$/.exec(field || '');
  let side;
  let code = null;
  let rest;
  if (m) { side = 'request'; rest = m[1]; } else {
    m = /^responses\.([^.[]+)(.*)$/.exec(field || '');
    if (!m) return null;
    side = 'response'; code = m[1]; rest = m[2];
  }
  const steps = [];
  const re = /\.(oneOf|anyOf)\[(\d+)\]|\[items\]|\.<\*>|\.([^.[]+)/g;
  let pos = 0;
  let t;
  while ((t = re.exec(rest)) !== null) {
    if (t.index !== pos) return null;
    pos = re.lastIndex;
    if (t[1]) steps.push({ variant: t[1], index: Number(t[2]) });
    else if (t[0] === '[items]') steps.push({ items: true });
    else if (t[0] === '.<*>') steps.push({ map: true });
    else steps.push({ prop: t[3] });
  }
  if (pos !== rest.length) return null;
  return { side, code, steps };
}

function rootSchemaPtr(doc, method, path, parsed) {
  return parsed.side === 'request'
    ? requestSchemaPtr(doc, method, path)
    : responseSchemaPtr(doc, method, path, parsed.code);
}

/**
 * Finds the schema object that declares property `name`, starting at the
 * schema at `ptr` and looking through $ref and allOf. Returns the pointer of
 * that (dereferenced) schema object, or null.
 */
function propertyOwnerPtr(doc, ptr, name, depth = 0) {
  if (!ptr || depth > 12) return null;
  const s = derefPtr(doc, ptr);
  const node = s && get(doc, s);
  if (!node || typeof node !== 'object') return null;
  if (node.properties && Object.prototype.hasOwnProperty.call(node.properties, name)) return s;
  for (let i = 0; i < (node.allOf || []).length; i++) {
    const found = propertyOwnerPtr(doc, [...s, 'allOf', i], name, depth + 1);
    if (found) return found;
  }
  return null;
}

/**
 * Walks `steps` from the schema at `ptr`. Returns the pointer of the last
 * step's schema node (not dereferenced), or null when a step is missing.
 */
function walk(doc, ptr, steps) {
  let cur = ptr;
  for (const step of steps) {
    if (!cur) return null;
    if (step.prop !== undefined) {
      const owner = propertyOwnerPtr(doc, cur, step.prop);
      if (!owner) return null;
      cur = [...owner, 'properties', step.prop];
      continue;
    }
    const s = derefPtr(doc, cur);
    const node = s && get(doc, s);
    if (!node) return null;
    if (step.items) cur = node.items ? [...s, 'items'] : null;
    else if (step.map) cur = node.additionalProperties && typeof node.additionalProperties === 'object' ? [...s, 'additionalProperties'] : null;
    else cur = Array.isArray(node[step.variant]) && node[step.variant][step.index] ? [...s, step.variant, step.index] : null;
  }
  return cur;
}

/** Pointer of the schema node a diff field names, in `doc`. */
function fieldPtr(doc, method, path, field) {
  const parsed = parseField(field);
  if (!parsed) return null;
  const root = rootSchemaPtr(doc, method, path, parsed);
  return root && walk(doc, root, parsed.steps);
}

/**
 * For a property path (last step is a property), the pointer of the schema
 * object that should hold it in `doc` — where a removed property goes back.
 * Prefers the schema that declares the property's siblings.
 */
function parentObjectPtr(doc, method, path, field) {
  const parsed = parseField(field);
  if (!parsed || parsed.steps.length === 0) return null;
  const last = parsed.steps[parsed.steps.length - 1];
  if (last.prop === undefined) return null;
  const root = rootSchemaPtr(doc, method, path, parsed);
  const parent = root && walk(doc, root, parsed.steps.slice(0, -1));
  if (!parent) return null;
  return objectHolder(doc, parent);
}

function objectHolder(doc, ptr, depth = 0) {
  const s = derefPtr(doc, ptr);
  const node = s && get(doc, s);
  if (!node || typeof node !== 'object' || depth > 12) return null;
  if (node.properties || !node.allOf) return s;
  // allOf: the last part that declares properties is the "own" part of a
  // composed schema (allOf: [$ref Base, { properties: … }]).
  for (let i = node.allOf.length - 1; i >= 0; i--) {
    const part = get(doc, [...s, 'allOf', i]);
    if (part && !part.$ref && part.properties) return [...s, 'allOf', i];
  }
  return objectHolder(doc, [...s, 'allOf', node.allOf.length - 1], depth + 1);
}

/** Every local $ref target reachable from `node` in `doc`, transitively (pointers). */
function collectRefs(doc, node, out = new Map()) {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) { node.forEach((n) => collectRefs(doc, n, out)); return out; }
  if (typeof node.$ref === 'string') {
    const ptr = refToPtr(node.$ref);
    if (ptr && !out.has(node.$ref)) {
      out.set(node.$ref, ptr);
      collectRefs(doc, get(doc, ptr), out);
    }
  }
  for (const [k, v] of Object.entries(node)) if (k !== '$ref') collectRefs(doc, v, out);
  return out;
}

/** Inlines local $refs (cycles cut at `depth`) — for validating sample payloads with ajv. */
function inline(doc, node, depth = 0) {
  if (!node || typeof node !== 'object') return node;
  if (Array.isArray(node)) return node.map((n) => inline(doc, n, depth));
  if (typeof node.$ref === 'string') {
    const ptr = refToPtr(node.$ref);
    if (!ptr || depth > 8) return {};
    return inline(doc, get(doc, ptr), depth + 1);
  }
  const out = {};
  for (const [k, v] of Object.entries(node)) out[k] = inline(doc, v, depth);
  return out;
}

module.exports = {
  HTTP_METHODS, REF_PREFIXES,
  get, refToPtr, ptrToRef, derefPtr, operationPtr, parameterPtrs, findParameter,
  requestSchemaPtr, responseSchemaPtr, parseField, rootSchemaPtr, propertyOwnerPtr, walk,
  fieldPtr, parentObjectPtr, collectRefs, inline,
};
