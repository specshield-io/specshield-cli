'use strict';

/**
 * Isolation: make an instance satisfy two schemas at once everywhere except
 * one protected location.
 *
 * A spec change rarely comes alone — the same body may gain a required field,
 * change a type and drop another field in one release. A witness built for one
 * of those changes would trip over the others, and "it fails" would prove
 * nothing about the change it is meant to show. So before a witness is judged,
 * every other part of it is repaired until both the old and the new schema
 * accept it; only the protected location is left alone. A repair that the
 * accepting schema rejects is undone, so the witness stays valid on its side.
 */

const S = require('./schema');
const { generate } = require('./instance');
const { relatesTo } = require('./relate');

const VALUE_KEYWORDS = new Set([
  'type', 'enum', 'const', 'format', 'pattern', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum',
  'multipleOf', 'minLength', 'maxLength', 'minItems', 'maxItems', 'uniqueItems', 'oneOf', 'anyOf', 'minProperties',
]);

/**
 * @param value     the instance (from the accepting side, A)
 * @param a         { doc, schema } — must keep accepting the result
 * @param b         { doc, schema } — repaired towards
 * @param protect   diff-engine steps of the location to leave alone, or null
 * @param side      'request' | 'response'
 * @returns the repaired instance (unchanged when nothing could be repaired)
 */
function coSatisfy(value, { a, b, protect = null, side = 'request', cfg = {} }) {
  if (value === undefined || !b || !b.schema) return value;
  const at = protect ? S.instancePath(protect) : null;
  const isProtected = (e) => Boolean(protect) && relatesTo([e], protect);
  const validA = S.validator(a.doc, a.schema, { side });
  const validB = S.validator(b.doc, b.schema, { side });
  let x = clone(value);
  for (let pass = 0; pass < 6; pass++) {
    const rb = validB(x);
    if (rb.ok) return x;
    let changed = false;
    for (const e of rb.errors) {
      if (isProtected(e)) continue;
      const fix = proposal(e, b, side, cfg);
      if (!fix || (at !== null && overlaps(fix.pointer, at))) continue;
      const y = apply(x, fix);
      if (y === undefined || same(x, y)) continue;
      if (!validA(y).ok) continue;
      x = y;
      changed = true;
    }
    if (!changed) break;
  }
  return x;
}

function proposal(e, b, side, cfg) {
  if (e.keyword === 'required' && e.params.missingProperty !== undefined) {
    const pointer = `${e.path}/${esc(e.params.missingProperty)}`;
    const node = S.nodeAtPointer(b.doc, b.schema, pointer);
    return { op: 'set', pointer, value: node ? generate(b.doc, node, { side, ...cfg }) : 'abc' };
  }
  if (e.keyword === 'additionalProperties' && e.params.additionalProperty !== undefined) {
    return { op: 'delete', pointer: `${e.path}/${esc(e.params.additionalProperty)}` };
  }
  if (VALUE_KEYWORDS.has(e.keyword)) {
    const node = S.nodeAtPointer(b.doc, b.schema, e.path);
    if (!node) return null;
    return { op: 'set', pointer: e.path, value: generate(b.doc, node, { side, ...cfg }) };
  }
  return null;
}

/** A fix may not replace the protected value, anything containing it, or anything inside it. */
function overlaps(pointer, at) {
  return pointer === at || at.startsWith(pointer + '/') || pointer === '' || pointer.startsWith(at + '/');
}

function apply(x, { op, pointer, value }) {
  if (pointer === '') return op === 'set' ? clone(value) : undefined;
  const root = clone(x);
  const parts = pointer.split('/').slice(1).map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~'));
  let cur = root;
  for (const k of parts.slice(0, -1)) {
    if (cur === null || typeof cur !== 'object' || !(k in cur)) return undefined;
    cur = cur[k];
  }
  if (cur === null || typeof cur !== 'object') return undefined;
  const last = parts[parts.length - 1];
  if (op === 'delete') delete cur[last];
  else cur[last] = clone(value);
  return root;
}

function esc(s) {
  return String(s).replace(/~/g, '~0').replace(/\//g, '~1');
}

function clone(v) {
  return v === undefined || v === null || typeof v !== 'object' ? v : JSON.parse(JSON.stringify(v));
}

function same(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

module.exports = { coSatisfy };
