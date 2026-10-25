'use strict';

const YAML = require('yaml');
const jsYaml = require('js-yaml');

/**
 * Edits a fix makes to the target spec, as data:
 *
 *   { op: 'set',    path, value }         set a key (parents created as needed)
 *   { op: 'delete', path }                remove a key
 *   { op: 'push',   path, value }         append to an array unless already there
 *   { op: 'pull',   path, value }         remove a value from an array (drops the array if it empties)
 *   { op: 'insert', path, index, value }  insert into an array at index
 *
 * The same ops apply to a plain object (to verify the fix with the diff
 * engine) and to a `yaml` Document (to write the fix into the author's file
 * with comments, ordering and quoting intact).
 */

function clone(v) {
  return v === undefined ? undefined : JSON.parse(JSON.stringify(v, (k, x) => (x instanceof Date ? x.toISOString().slice(0, 10) : x)));
}

// ─── plain objects ──────────────────────────────────────────────────────────

function applyOps(doc, ops) {
  for (const o of ops) applyOne(doc, o);
  return doc;
}

function applyOne(doc, o) {
  const parentPath = o.path.slice(0, -1);
  const key = o.path[o.path.length - 1];
  if (o.op === 'set') {
    const parent = ensure(doc, parentPath);
    parent[key] = clone(o.value);
    return;
  }
  const parent = getAt(doc, parentPath);
  if (!parent || typeof parent !== 'object') return;
  if (o.op === 'delete') { delete parent[key]; return; }
  if (o.op === 'push') {
    if (!Array.isArray(parent[key])) parent[key] = [];
    if (!parent[key].some((x) => same(x, o.value))) parent[key].push(clone(o.value));
    return;
  }
  if (o.op === 'pull') {
    if (!Array.isArray(parent[key])) return;
    parent[key] = parent[key].filter((x) => !same(x, o.value));
    if (parent[key].length === 0) delete parent[key];
    return;
  }
  if (o.op === 'insert') {
    if (!Array.isArray(parent[key])) parent[key] = [];
    parent[key].splice(o.index, 0, clone(o.value));
  }
}

function getAt(doc, path) {
  let cur = doc;
  for (const k of path) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = cur[k];
  }
  return cur;
}

function ensure(doc, path) {
  let cur = doc;
  for (const k of path) {
    if (cur[k] === null || typeof cur[k] !== 'object') cur[k] = {};
    cur = cur[k];
  }
  return cur;
}

function same(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

// ─── yaml Documents ─────────────────────────────────────────────────────────

/**
 * Applies ops to the source text of a YAML or JSON spec and returns the new
 * text. YAML keeps its comments and layout; JSON keeps its indentation.
 */
function applyOpsToText(text, ops, { json = false } = {}) {
  if (json) {
    const doc = JSON.parse(text);
    applyOps(doc, ops);
    const indent = (/\n([ \t]+)"/.exec(text) || [, '  '])[1];
    return JSON.stringify(doc, null, indent) + (text.endsWith('\n') ? '\n' : '');
  }
  const doc = YAML.parseDocument(text, { keepSourceTokens: false });
  for (const o of ops) applyYaml(doc, o);
  const singles = (text.match(/'/g) || []).length;
  const doubles = (text.match(/"/g) || []).length;
  const out = doc.toString({ lineWidth: 0, flowCollectionPadding: false, singleQuote: singles > doubles });
  return keepOriginalLines(text, out);
}

/**
 * The yaml printer re-renders lines it didn't change: comment spacing,
 * padding inside [ ] and { }, quote style. Put the author's line back
 * wherever the new line is the same content, so the diff shows only the fix.
 * Lines are matched in order, as far ahead as the next 200 original lines.
 */
function keepOriginalLines(original, rendered) {
  const src = original.split('\n');
  const out = rendered.split('\n');
  // Indentation is structure in YAML: it must match exactly.
  const norm = (l) => {
    const [, indent, rest] = /^(\s*)(.*)$/.exec(l);
    return indent + rest.replace(/\s+#/, ' #').replace(/\s+/g, ' ').replace(/([[{]) /g, '$1').replace(/ ([\]}])/g, '$1').replace(/"/g, "'").trimEnd();
  };
  const keys = src.map(norm);
  let i = 0;
  const result = out.map((line) => {
    const n = norm(line);
    for (let k = i; k < Math.min(src.length, i + 200); k++) {
      if (keys[k] === n) { i = k + 1; return src[k]; }
    }
    return line;
  });
  return result.join('\n');
}

function applyYaml(doc, o) {
  const parentPath = o.path.slice(0, -1);
  const key = o.path[o.path.length - 1];
  if (o.op === 'set') {
    const parent = ensureNode(doc, parentPath);
    const pair = findPair(parent, key);
    const node = createNode(doc, o.value);
    if (pair) pair.value = node;
    else parent.add(doc.createPair(keyScalar(key), node));
    return;
  }
  const parent = nodeAt(doc, parentPath);
  if (!parent) return;
  if (o.op === 'delete') {
    if (YAML.isMap(parent)) {
      const pair = findPair(parent, key);
      if (pair) parent.items.splice(parent.items.indexOf(pair), 1);
    }
    return;
  }
  let seq = childOf(parent, key);
  if (o.op === 'pull') {
    if (!YAML.isSeq(seq)) return;
    seq.items = seq.items.filter((n) => !same(n.toJSON ? n.toJSON() : n, o.value));
    if (seq.items.length === 0) applyYaml(doc, { op: 'delete', path: o.path });
    return;
  }
  if (!YAML.isSeq(seq)) {
    applyYaml(doc, { op: 'set', path: o.path, value: [] });
    seq = childOf(nodeAt(doc, parentPath), key);
  }
  if (o.op === 'push') {
    if (!seq.items.some((n) => same(n.toJSON ? n.toJSON() : n, o.value))) seq.items.push(createNode(doc, o.value));
  } else if (o.op === 'insert') {
    seq.items.splice(o.index, 0, createNode(doc, o.value));
  }
}

/**
 * A string that YAML would read back as something else — a date like
 * 2027-03-31, a number, true/null — is quoted, so the file says exactly what
 * was verified.
 */
function createNode(doc, value) {
  const node = doc.createNode(clone(value));
  YAML.visit(node, {
    Scalar(_, s) {
      // Judged by js-yaml, which reads the spec (YAML 1.1: dates are timestamps).
      if (typeof s.value === 'string' && readsAsOther(s.value)) s.type = YAML.Scalar.QUOTE_SINGLE;
    },
  });
  return node;
}

function readsAsOther(str) {
  try {
    return jsYaml.load(str) !== str;
  } catch {
    return true;
  }
}

/** Keys in a spec are strings, but YAML may hold `200:` as a number — match by string form. */
function findPair(map, key) {
  if (!YAML.isMap(map)) return null;
  return map.items.find((p) => String(YAML.isScalar(p.key) ? p.key.value : p.key) === String(key)) || null;
}

function childOf(node, key) {
  if (YAML.isMap(node)) { const p = findPair(node, key); return p ? p.value : undefined; }
  if (YAML.isSeq(node)) return node.items[Number(key)];
  return undefined;
}

function nodeAt(doc, path) {
  let cur = doc.contents;
  for (const k of path) {
    cur = childOf(cur, k);
    if (cur === undefined || cur === null) return undefined;
  }
  return cur;
}

function ensureNode(doc, path) {
  let cur = doc.contents;
  for (const k of path) {
    let next = childOf(cur, k);
    if (!YAML.isMap(next) && !YAML.isSeq(next)) {
      next = doc.createNode({});
      const pair = findPair(cur, k);
      if (pair) pair.value = next;
      else cur.add(doc.createPair(keyScalar(k), next));
    }
    cur = next;
  }
  return cur;
}

function keyScalar(key) {
  // HTTP status codes stay quoted so they remain strings: '200'.
  const s = new YAML.Scalar(String(key));
  if (/^\d+$/.test(String(key))) s.type = YAML.Scalar.QUOTE_SINGLE;
  return s;
}

module.exports = { applyOps, applyOpsToText, clone };
