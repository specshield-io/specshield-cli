'use strict';

/**
 * Response shapes, for telling "the data is different" (expected: another
 * environment, another day) from "the contract is different" (a field is gone,
 * a number became a string).
 *
 * A shape is the set of paths in a JSON value and the types seen at each:
 *   { ".items[].id": {number}, ".items[].tag": {string, null}, ... }
 * Arrays fold their elements into "[]"; objects whose keys are data (ids,
 * dates) rather than field names fold into "{*}".
 */

const MAX_ELEMENTS = 50;

function shape(value) {
  const out = new Map();
  walk(value, '', out, 0);
  return out;
}

function walk(v, path, out, depth) {
  const t = typeOf(v);
  if (!out.has(path)) out.set(path, new Set());
  out.get(path).add(t);
  if (depth > 20) return;
  if (t === 'array') {
    for (const x of v.slice(0, MAX_ELEMENTS)) walk(x, `${path}[]`, out, depth + 1);
  } else if (t === 'object') {
    const keys = Object.keys(v);
    if (isDataKeyed(keys)) {
      for (const k of keys.slice(0, MAX_ELEMENTS)) walk(v[k], `${path}{*}`, out, depth + 1);
    } else {
      for (const k of keys) walk(v[k], `${path}.${k}`, out, depth + 1);
    }
  }
}

function isDataKeyed(keys) {
  if (keys.length > 50) return true;
  if (keys.length < 2) return false;
  return keys.every((k) => /^\d+$/.test(k) || /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(k) || /^\d{4}-\d{2}-\d{2}/.test(k));
}

function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

/**
 * What a client that read `ref` would miss in `cand`:
 *   missing  fields present in the reference, absent in the candidate
 *   changed  fields whose (non-null) type differs
 * A path is only judged where the candidate has data around it — an empty
 * list or a null parent says nothing about the contract.
 */
function compare(ref, cand) {
  const a = shape(ref);
  const b = shape(cand);
  const missing = [];
  const changed = [];
  for (const [path, types] of a) {
    if (path === '') continue;
    const parent = parentOf(path);
    const pTypes = b.get(parent);
    if (!pTypes) continue;                                    // reported at the parent, or no data there
    if (!pTypes.has(path.endsWith('[]') ? 'array' : 'object')) continue;
    const bt = b.get(path);
    if (!bt && (path.endsWith('[]') || path.endsWith('{*}'))) continue;  // an empty list or map: no data, not a missing field
    if (!bt) {
      if (!types.has('null') || types.size > 1) missing.push(path);
      continue;
    }
    const x = nonNull(types);
    const y = nonNull(bt);
    if (x.length && y.length && !x.some((t) => y.includes(t))) changed.push({ path, from: x.join('|'), to: y.join('|') });
  }
  // A missing parent covers its children: report the top-most only.
  const top = missing.filter((p) => !missing.some((q) => q !== p && (p.startsWith(q + '.') || p.startsWith(q + '[') || p.startsWith(q + '{'))));
  return { missing: top, changed };
}

function parentOf(path) {
  if (path.endsWith('[]')) return path.slice(0, -2);
  if (path.endsWith('{*}')) return path.slice(0, -3);
  const i = path.lastIndexOf('.');
  return i <= 0 ? '' : path.slice(0, i);
}

function nonNull(types) {
  return [...types].filter((t) => t !== 'null');
}

/** ".items[].id" → "items[].id" for display. */
function display(path) {
  return path.replace(/^\./, '') || '(root)';
}

module.exports = { shape, compare, display };
