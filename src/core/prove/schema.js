'use strict';

/**
 * Schema plumbing for witnesses: following $refs inside a raw (un-normalized)
 * spec document, flattening allOf, walking the diff engine's field steps, and
 * validating instances with ajv against the document's own schemas.
 *
 * Validation runs against the spec as written — $refs stay $refs, resolved by
 * ajv against the document's components — so a witness is checked against the
 * real contract, not a simplified copy of it.
 */

const Ajv = require('ajv').default;
const addFormats = require('ajv-formats');
const L = require('../fix/locate');

// inlineRefs: false compiles each referenced component once, as its own
// function, instead of inlining it into every schema that mentions it — on a
// spec like Stripe's (thousands of mutually-referencing schemas) the difference
// between seconds and hours.
const OPTIONS = { strict: false, allErrors: true, validateFormats: true, logger: false, inlineRefs: false };
const bodyAjv = addFormats(new Ajv({ ...OPTIONS, coerceTypes: false }));
// Parameters arrive as strings ("?limit=10"); servers parse them into the
// declared type, so a parameter validates the way a server would read it.
const paramAjv = addFormats(new Ajv({ ...OPTIONS, coerceTypes: 'array' }));

const ANNOTATIONS = new Set(['example', 'examples', 'xml', 'discriminator', 'readOnly', 'writeOnly', 'deprecated', 'externalDocs', 'nullable', '$schema', '$id', 'x-nullable']);

function deref(doc, node, depth = 0) {
  let cur = node;
  for (let i = 0; cur && typeof cur === 'object' && typeof cur.$ref === 'string' && i < 20; i++) {
    const ptr = L.refToPtr(cur.$ref);
    if (!ptr) return null;                                   // external ref
    cur = L.get(doc, ptr);
  }
  return cur && typeof cur === 'object' ? cur : null;
}

/**
 * The schema with $refs followed and allOf merged into one node — the shape a
 * generator or a reader cares about. Constraints of every part are kept (the
 * last part wins on a conflict, which ajv's own check then catches).
 */
function effective(doc, node, depth = 0) {
  const s = deref(doc, node);
  if (!s || depth > 12) return s;
  if (!Array.isArray(s.allOf)) return s;
  const out = { ...s, properties: { ...(s.properties || {}) }, required: [...(s.required || [])] };
  delete out.allOf;
  for (const part of s.allOf) {
    const p = effective(doc, part, depth + 1);
    if (!p) continue;
    for (const [k, v] of Object.entries(p)) {
      if (k === 'properties') Object.assign(out.properties, v);
      else if (k === 'required') out.required.push(...v);
      else if (!(k in out) || k === 'type') out[k] = v;
    }
  }
  if (Object.keys(out.properties).length === 0) delete out.properties;
  if (out.required.length === 0) delete out.required;
  return out;
}

/** The type a schema declares, ignoring "null" (OpenAPI 3.1 nullable). */
function typeOf(s) {
  if (!s) return null;
  if (Array.isArray(s.type)) return s.type.find((t) => t !== 'null') || null;
  if (s.type) return s.type;
  if (s.properties || s.additionalProperties) return 'object';
  if (s.items) return 'array';
  return null;
}

function nullable(s) {
  return Boolean(s && (s.nullable === true || s['x-nullable'] === true || (Array.isArray(s.type) && s.type.includes('null'))));
}

/**
 * Walks diff-engine steps ({prop}, {items}, {map}, {variant, index}) from a
 * schema node. Returns the (un-dereferenced) node at the end, or null.
 */
function nodeAt(doc, node, steps) {
  let cur = node;
  for (const step of steps) {
    const s = effective(doc, cur);
    if (!s) return null;
    if (step.prop !== undefined) cur = s.properties && s.properties[step.prop];
    else if (step.items) cur = s.items;
    else if (step.map) cur = s.additionalProperties && typeof s.additionalProperties === 'object' ? s.additionalProperties : null;
    else cur = Array.isArray(s[step.variant]) ? s[step.variant][step.index] : null;
    if (!cur) return null;
  }
  return cur;
}

/**
 * The schema node that governs the value at a JSON pointer of an instance
 * ("/items/0/tag"), or null. Array indexes go to `items`, unknown keys to
 * additionalProperties, and a oneOf/anyOf branch that declares the key wins.
 */
function nodeAtPointer(doc, root, pointer) {
  let cur = root;
  for (const raw of pointer.split('/').slice(1)) {
    const seg = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    const s = effective(doc, cur);
    if (!s) return null;
    if (s.properties && s.properties[seg]) { cur = s.properties[seg]; continue; }
    if (/^\d+$/.test(seg) && s.items) { cur = s.items; continue; }
    if (s.additionalProperties && typeof s.additionalProperties === 'object') { cur = s.additionalProperties; continue; }
    const branch = (s.oneOf || s.anyOf || []).map((v) => effective(doc, v)).find((v) => v && v.properties && v.properties[seg]);
    if (!branch) return null;
    cur = branch.properties[seg];
  }
  return cur;
}

/** Steps → the JSON pointer of the value they name in an instance ("/items/0/tag"). */
function instancePath(steps) {
  let p = '';
  for (const s of steps) {
    if (s.prop !== undefined) p += '/' + String(s.prop).replace(/~/g, '~0').replace(/\//g, '~1');
    else if (s.items) p += '/0';
    else if (s.map) p += '/key';
  }
  return p;
}

// ─── OpenAPI → JSON Schema ──────────────────────────────────────────────────

/**
 * Rewrites OpenAPI-isms so ajv validates what the spec means:
 *   nullable / x-nullable          → type also allows null
 *   exclusiveMinimum: true (3.0)   → JSON Schema's numeric form
 *   readOnly properties            → not required in a request
 *   writeOnly properties           → not required in a response
 *   annotations, $schema, $id      → dropped
 */
function convert(doc, node, side, depth = 0, base = '') {
  if (node === null || typeof node !== 'object' || depth > 200) return node;
  if (Array.isArray(node)) return node.map((n) => convert(doc, n, side, depth + 1, base));

  const out = {};
  for (const [k, v] of Object.entries(node)) {
    if (ANNOTATIONS.has(k) || k.startsWith('x-')) continue;
    if (k === 'properties' && v && typeof v === 'object') {
      out.properties = {};
      for (const [name, p] of Object.entries(v)) out.properties[name] = convert(doc, p, side, depth + 1, base);
      continue;
    }
    if (k === 'type' && v === 'file') continue;              // Swagger 2.0 upload
    if (k === '$ref' && typeof v === 'string' && base && v.startsWith('#/')) { out.$ref = base + v; continue; }
    out[k] = convert(doc, v, side, depth + 1, base);
  }

  if (nullable(node) && out.type && !Array.isArray(out.type)) out.type = [out.type, 'null'];
  if (nullable(node) && Array.isArray(out.enum) && !out.enum.includes(null)) out.enum = [...out.enum, null];
  for (const [ex, bound] of [['exclusiveMinimum', 'minimum'], ['exclusiveMaximum', 'maximum']]) {
    if (out[ex] === true && typeof out[bound] === 'number') { out[ex] = out[bound]; delete out[bound]; } else if (typeof out[ex] === 'boolean') delete out[ex];
  }
  if (Array.isArray(node.required) && node.properties) {
    const skip = side === 'request' ? 'readOnly' : 'writeOnly';
    out.required = node.required.filter((name) => {
      const p = deref(doc, node.properties[name]);
      return !(p && p[skip] === true);
    });
  }
  return out;
}

// Each document's reusable schemas are registered once per ajv instance and
// side, under an id of their own; a validator's $refs point there.
let docSeq = 0;
const docIds = new WeakMap();
const registered = new WeakMap();

function docBase(ajv, doc, side) {
  let id = docIds.get(doc);
  if (!id) { id = `specshield://doc/${++docSeq}`; docIds.set(doc, id); }
  const uri = `${id}/${side}`;
  let set = registered.get(ajv);
  if (!set) { set = new Set(); registered.set(ajv, set); }
  if (!set.has(uri)) {
    ajv.addSchema({
      $id: uri,
      components: { schemas: convert(doc, (doc.components && doc.components.schemas) || {}, side) },
      definitions: convert(doc, doc.definitions || {}, side),
    });
    set.add(uri);
  }
  return uri;
}

const compiled = { body: new WeakMap(), param: new WeakMap() };

/**
 * A validator for `schema` (a node of `doc`). `kind` 'param' parses string
 * values the way a server reads a query/path/header parameter.
 * Returns (value) → { ok, errors: [{ path, keyword, message, params }] }.
 */
function validator(doc, schema, { side = 'request', kind = 'body' } = {}) {
  if (!schema || typeof schema !== 'object') return () => ({ ok: true, errors: [] });
  const cache = compiled[kind];
  let bySide = cache.get(schema);
  if (!bySide) { bySide = {}; cache.set(schema, bySide); }
  if (!bySide[side]) {
    let fn;
    try {
      const ajv = kind === 'param' ? paramAjv : bodyAjv;
      fn = ajv.compile(convert(doc, schema, side, 0, docBase(ajv, doc, side)));
    } catch (err) {
      const message = `the spec's schema can't be compiled: ${err.message}`;
      fn = null;
      bySide[side] = () => ({ ok: false, invalidSchema: true, errors: [{ path: '', keyword: 'schema', message, params: {} }] });
    }
    if (fn) {
      bySide[side] = (value) => {
        const copy = value === undefined ? undefined : JSON.parse(JSON.stringify(value));
        if (fn(copy)) return { ok: true, errors: [] };
        return { ok: false, errors: dedupe((fn.errors || []).map((e) => ({ path: e.instancePath || '', keyword: e.keyword, message: e.message, params: e.params || {}, schemaPath: e.schemaPath || '' }))) };
      };
    }
  }
  return bySide[side];
}

/**
 * ajv reports every failed branch of a oneOf/anyOf next to the union's own
 * error. Keep the union's error and drop its branches' at the same place; keep
 * each remaining distinct message once.
 */
function dedupe(errors) {
  // ajv's schemaPath restarts inside a $ref'd branch, so match by instance
  // location: anything at or below a failed union is that union's detail.
  const unions = errors.filter((e) => e.keyword === 'oneOf' || e.keyword === 'anyOf');
  const inBranch = (e) => unions.some((u) => e.path === u.path || e.path.startsWith(`${u.path}/`));
  const seen = new Set();
  const out = [];
  for (const e of errors) {
    if (e.keyword === 'allOf' || e.keyword === 'if') continue;
    if (e.keyword !== 'oneOf' && e.keyword !== 'anyOf' && inBranch(e)) continue;
    const key = `${e.path}|${e.keyword}|${e.message}`;
    if (!seen.has(key)) { seen.add(key); out.push(e); }
  }
  return out;
}

/** "/items/0/tag must be integer" — an ajv error the way a person reads it. */
function describeError(e, root = 'body') {
  const where = e.path ? `${root}${e.path.replace(/\/(\d+)(?=\/|$)/g, '[$1]').replace(/\//g, '.')}` : root;
  if (e.keyword === 'required') return `${where} is missing required field "${e.params.missingProperty}"`;
  if (e.keyword === 'enum') return `${where} must be one of ${JSON.stringify(e.params.allowedValues)}`;
  if (e.keyword === 'additionalProperties') return `${where} has a field the spec doesn't allow: "${e.params.additionalProperty}"`;
  if (e.keyword === 'type') return `${where} must be ${e.params.type}`;
  if (e.keyword === 'oneOf' || e.keyword === 'anyOf') {
    return e.params && Array.isArray(e.params.passingSchemas) ? `${where} matches more than one allowed form` : `${where} matches none of the allowed forms`;
  }
  if (e.keyword === 'schema') return e.message;
  return `${where} ${e.message}`;
}

module.exports = { deref, effective, typeOf, nullable, nodeAt, nodeAtPointer, instancePath, convert, validator, describeError };
