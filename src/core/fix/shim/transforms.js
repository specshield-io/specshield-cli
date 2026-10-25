'use strict';

const L = require('../locate');
const { validateBody } = require('../../conformance/responseValidator');

/**
 * Version transforms: Stripe-style "old clients get the old shape". The new
 * code speaks the target spec; a thin layer rewrites JSON at the edge —
 * responses back into the base shape for clients on the old version, and old
 * requests forward into the target shape — so nothing in the controllers
 * changes.
 *
 * A transform:
 *   { method, path, code?, side: 'response'|'request', kind, at: [steps], …kind fields }
 *     rename   { from, to }          move a property inside the object at `at`
 *     convert  { field, from, to }   change a scalar's JSON type at `at`
 *     enum     { field, from, to }   map one enum value to another at `at`
 *     default  { field, value }      add a property when the client left it out
 *     unwrap   { property }          replace the root object by one of its properties
 *   steps: { prop } · { items } (every element) · { map } (every value)
 *
 * applyTransforms() here and the generated Java runtime implement the same
 * rules; the CLI checks every transform on sample payloads before generating.
 */

const CONVERTIBLE = ['string', 'integer', 'number', 'boolean'];

/** Collects, dedupes and verifies the transforms behind a fixSpec result. */
function buildShim(result, baseDoc, targetDoc) {
  const seen = new Set();
  const all = [];
  const skipped = [];
  for (const s of result.suggestions) {
    for (const t of s.transforms) {
      const n = normalize(t);
      if (!n) { skipped.push(`${t.method} ${t.path}: a ${t.kind} inside oneOf/anyOf or of a non-scalar type is not supported`); continue; }
      const key = JSON.stringify(n);
      if (!seen.has(key)) { seen.add(key); all.push(n); }
    }
  }

  // Verify per (operation, side, status): sample the shape one side speaks,
  // transform it, validate against the other side's schema.
  const groups = new Map();
  for (const t of all) {
    const k = `${t.method} ${t.path} ${t.side} ${t.code || ''}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(t);
  }
  const transforms = [];
  for (const list of groups.values()) {
    const v = verify(list, baseDoc, targetDoc);
    if (v.ok) transforms.push(...list);
    else skipped.push(`${list[0].method} ${list[0].path} ${list[0].side}${list[0].code ? ` ${list[0].code}` : ''}: ${v.reason}`);
  }
  return { transforms: order(transforms), skipped };
}

function normalize(t) {
  // rename/default act on the object holding the field; convert/enum on the
  // field's value, addressed by its parent plus `field` (null = the array
  // element itself); unwrap on the root.
  const parent = t.kind === 'rename' || t.kind === 'default' ? t.parent
    : t.kind === 'unwrap' ? [] : t.steps.slice(0, -1);
  if (parent.some((s) => s.variant)) return null;
  const at = parent.map((s) => (s.prop !== undefined ? { prop: s.prop } : s.items ? { items: true } : { map: true }));
  const n = { method: t.method, path: t.path, code: t.code || null, side: t.side, kind: t.kind, at };
  if (t.kind === 'rename') Object.assign(n, { from: t.from, to: t.to });
  else if (t.kind === 'default') Object.assign(n, { field: t.field, value: t.value });
  else if (t.kind === 'unwrap') Object.assign(n, { property: t.property });
  else {
    const last = t.steps[t.steps.length - 1];
    if (!last || last.variant || last.map) return null;
    if (last.items) { n.at.push({ items: true }); n.field = null; } else n.field = last.prop;
    Object.assign(n, { from: t.from, to: t.to });
    if (t.kind === 'convert') {
      n.from = String(n.from).split(':')[0];
      n.to = String(n.to).split(':')[0];
      if (!CONVERTIBLE.includes(n.from) || !CONVERTIBLE.includes(n.to)) return null;
    }
  }
  return n;
}

/**
 * The order both runtimes apply. Value rewrites name fields as the OLD spec
 * does, so a response (new → old) renames first and rewrites after, and a
 * request (old → new) rewrites first and renames after. Defaults name new
 * fields and come last on requests.
 */
function order(list) {
  const rank = {
    response: { unwrap: 0, rename: 1, default: 2, convert: 3, enum: 4 },
    request: { unwrap: 0, convert: 1, enum: 2, rename: 3, default: 4 },
  };
  return [...list].sort((a, b) => rank[a.side][a.kind] - rank[b.side][b.kind]);
}

// ─── runtime (mirrored in the generated Java) ───────────────────────────────

function applyTransforms(body, transforms) {
  let root = body;
  for (const t of order(transforms)) {
    if (t.kind === 'unwrap') {
      if (root && typeof root === 'object' && !Array.isArray(root) && t.property in root) root = root[t.property];
      continue;
    }
    forEachAt(root, t.at, (obj, parentSetter) => applyOne(obj, t, parentSetter));
  }
  return root;
}

function forEachAt(node, steps, fn, setter = null) {
  if (steps.length === 0) { fn(node, setter); return; }
  const [s, ...rest] = steps;
  if (node === null || typeof node !== 'object') return;
  if (s.prop !== undefined) {
    if (!Array.isArray(node) && s.prop in node) forEachAt(node[s.prop], rest, fn, (v) => { node[s.prop] = v; });
  } else if (s.items) {
    if (Array.isArray(node)) node.forEach((el, i) => forEachAt(el, rest, fn, (v) => { node[i] = v; }));
  } else if (!Array.isArray(node)) {
    for (const k of Object.keys(node)) forEachAt(node[k], rest, fn, (v) => { node[k] = v; });
  }
}

function applyOne(node, t, setValue) {
  if (t.kind === 'rename') {
    if (isObject(node) && t.from in node && !(t.to in node)) {
      node[t.to] = node[t.from];
      delete node[t.from];
    }
    return;
  }
  if (t.kind === 'default') {
    if (isObject(node) && !(t.field in node)) node[t.field] = t.value;
    return;
  }
  // convert / enum act on a value: a property of `node`, or `node` itself (array items)
  if (t.field === null) { if (setValue) setValue(rewrite(node, t)); return; }
  if (isObject(node) && t.field in node) node[t.field] = rewrite(node[t.field], t);
}

function rewrite(v, t) {
  if (t.kind === 'enum') return v === t.from ? t.to : v;
  return convert(v, t.to);
}

/** Converts a JSON scalar; leaves it untouched when it has no faithful form in the target type. */
function convert(v, to) {
  if (v === null || v === undefined) return v;
  if (to === 'string') return typeof v === 'string' ? v : String(v);
  if (to === 'boolean') {
    if (typeof v === 'boolean') return v;
    if (v === 'true' || v === 1) return true;
    if (v === 'false' || v === 0) return false;
    return v;
  }
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\s*-?\d+(\.\d+)?([eE][+-]?\d+)?\s*$/.test(v) ? Number(v) : NaN;
  if (Number.isNaN(n)) return v;
  if (to === 'integer') return Number.isInteger(n) ? n : v;
  return n;
}

function isObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// ─── verification ───────────────────────────────────────────────────────────

function verify(list, baseDoc, targetDoc) {
  const t0 = list[0];
  const from = t0.side === 'response' ? targetDoc : baseDoc;
  const to = t0.side === 'response' ? baseDoc : targetDoc;
  const fromPtr = schemaPtr(from, t0);
  const toPtr = schemaPtr(to, t0);
  if (!fromPtr || !toPtr) return { ok: false, reason: 'no JSON body schema on both sides' };
  const fromSchema = L.inline(from, L.get(from, fromPtr));
  const toSchema = L.inline(to, L.get(to, toPtr));
  const prefer = new Set(list.filter((t) => t.kind === 'enum').map((t) => t.from));
  // The fields the transforms act on — present in any real payload they'd matter for.
  const keep = new Set(list.map((t) => t.property || (t.kind === 'rename' ? t.from : t.field)).filter(Boolean));
  // Two samples: every optional property present, and only the required ones.
  for (const full of [true, false]) {
    const sample = sampleOf(fromSchema, { full, prefer, keep });
    const out = applyTransforms(JSON.parse(JSON.stringify(sample)), list);
    const v = validateBody(out, toSchema);
    if (!v.ok) {
      const e = v.errors[0];
      return { ok: false, reason: `a transformed ${t0.side} still doesn't match the old schema (${e.path} ${e.message})` +
        (e.keyword === 'required' ? ' — the new code no longer produces a field old clients require' : '') };
    }
  }
  return { ok: true };
}

function schemaPtr(doc, t) {
  return t.side === 'request'
    ? L.requestSchemaPtr(doc, t.method, t.path)
    : L.responseSchemaPtr(doc, t.method, t.path, t.code);
}

/** A deterministic example of `schema` (inlined). */
function sampleOf(schema, { full, prefer, keep = new Set() }, depth = 0) {
  if (!schema || typeof schema !== 'object' || depth > 8) return null;
  if (schema.example !== undefined && !schema.enum) return schema.example;
  if (schema.allOf) return Object.assign({}, ...schema.allOf.map((s) => sampleOf(s, { full, prefer, keep }, depth + 1)));
  if (schema.oneOf || schema.anyOf) return sampleOf((schema.oneOf || schema.anyOf)[0], { full, prefer, keep }, depth + 1);
  if (Array.isArray(schema.enum) && schema.enum.length) return schema.enum.find((v) => prefer.has(v)) ?? schema.enum[0];
  const type = Array.isArray(schema.type) ? schema.type.find((x) => x !== 'null') : schema.type;
  if (type === 'array') return [sampleOf(schema.items, { full, prefer, keep }, depth + 1)];
  if (type === 'object' || schema.properties) {
    const out = {};
    const required = new Set(schema.required || []);
    for (const [k, p] of Object.entries(schema.properties || {})) {
      if (full || required.has(k) || keep.has(k)) out[k] = sampleOf(p, { full, prefer, keep }, depth + 1);
    }
    return out;
  }
  if (type === 'integer') return schema.minimum !== undefined ? Math.ceil(schema.minimum) : 1;
  if (type === 'number') return schema.minimum !== undefined ? schema.minimum : 1.5;
  if (type === 'boolean') return true;
  if (type === 'string') {
    const formats = { 'date-time': '2026-01-01T00:00:00Z', date: '2026-01-01', uuid: '00000000-0000-4000-8000-000000000000', email: 'a@b.co', uri: 'https://example.com' };
    if (formats[schema.format]) return formats[schema.format];
    // Numeric strings convert cleanly — the realistic case for a type change.
    return '1';
  }
  return null;
}

module.exports = { buildShim, applyTransforms, convert, sampleOf, order };
