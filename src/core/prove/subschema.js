'use strict';

/**
 * A sound, incomplete subschema check: `widens(from, to)` returns true only
 * when every instance `from` accepts is also accepted by `to`. When it can't
 * tell — composition it doesn't model, a keyword it doesn't know — it answers
 * false. So "true" is a proof of compatibility; "false" proves nothing.
 *
 * Deciding inclusion between JSON Schemas in general is hard (Habib et al.,
 * "Finding Data Compatibility Bugs with JSON Subschema Checking", ISSTA 2021);
 * this covers the shapes API changes are made of: properties added or made
 * optional, enums extended, bounds relaxed, types widened, a union gaining a
 * branch, branches reordered.
 *
 * Schemas are compared where they live — $refs followed on demand, each pair
 * of nodes visited once. Recursive schemas are handled coinductively: a pair
 * already being compared is assumed to widen, the standard sound rule for
 * recursive types (it proves inclusion for every instance, finite or not).
 *
 * One assumption, the one every API-compatibility check makes: a closed world.
 * An instance carries only the properties its schema declares — a client
 * doesn't send fields the old spec never mentioned. Without it, declaring any
 * new optional property would count as narrowing (an undeclared field could
 * have held anything). Pass { closedWorld: false } to drop the assumption.
 *
 * A side is { doc, node }: a schema node and the document its $refs resolve in.
 */

const S = require('./schema');

const ANNOTATION = /^(description|title|example|examples|externalDocs|deprecated|readOnly|writeOnly|xml|discriminator|default|\$schema|\$id|x-.*)$/;
// Numeric formats as ranges: float/double add nothing to a JSON number, int64
// covers every integer JSON carries exactly; int32 is the only real bound.
const NUMERIC_WIDTH = { int32: 1, int64: 2, float: 3, double: 3 };

let seq = 0;
const ids = new WeakMap();
const effCache = new WeakMap();

function id(o) {
  let n = ids.get(o);
  if (!n) { n = ++seq; ids.set(o, n); }
  return n;
}

/** $refs followed and allOf merged, with a stable identity per node. */
function eff(doc, node) {
  if (node === true || node === false) return node;
  if (!node || typeof node !== 'object') return null;
  let byDoc = effCache.get(node);
  if (!byDoc) { byDoc = new WeakMap(); effCache.set(node, byDoc); }
  if (!byDoc.has(doc)) byDoc.set(doc, S.effective(doc, node));
  return byDoc.get(doc);
}

function widens(from, to, opts = { closedWorld: true }) {
  return check(from.doc, from.node, to.doc, to.node, { closedWorld: opts.closedWorld !== false, memo: new Map() });
}

function check(fd, fn, td, tn, ctx) {
  const f = eff(fd, fn);
  const t = eff(td, tn);
  if (t === true || (isObj(t) && meaningful(t).length === 0)) return true;      // {} accepts everything
  if (f === false) return true;
  if (!isObj(f) || !isObj(t)) return false;
  const key = `${id(f)}|${id(t)}`;
  if (ctx.memo.has(key)) return ctx.memo.get(key);
  ctx.memo.set(key, true);                                                      // coinductive assumption
  const r = compare(fd, f, td, t, ctx);
  ctx.memo.set(key, r);
  return r;
}

function compare(fd, f, td, t, ctx) {
  const fu = union(f);
  const tu = union(t);

  // A union on the accepting side: enough that one branch takes all of `from`.
  if (tu && onlyKeys(t, tu.kind) && !fu) {
    if (tu.kind === 'oneOf' && !disjointTypes(td, tu.branches)) return false;
    return tu.branches.some((b) => check(fd, f, td, b, ctx));
  }
  // Unions on both sides: every branch of `from` must land in a branch of `to`.
  if (fu && tu && onlyKeys(f, fu.kind) && onlyKeys(t, tu.kind)) {
    if (tu.kind === 'oneOf' && !disjointTypes(td, tu.branches)) return false;
    return fu.branches.every((fb) => tu.branches.some((tb) => check(fd, fb, td, tb, ctx)));
  }

  const keys = new Set([...meaningful(f), ...meaningful(t)]);
  for (const k of keys) {
    const a = f[k];
    const b = t[k];
    switch (k) {
      case 'type':
        if (!typeWidens(a, b, f)) return false;
        break;
      case 'nullable':
        if (a === true && b !== true) return false;
        break;
      case 'format':
        if (!formatWidens(a, b, f)) return false;
        break;
      case 'pattern': case 'const': case 'multipleOf': case 'uniqueItems':
        if (b !== undefined && !same(a, b)) return false;
        break;
      case 'enum':
        if (b !== undefined && (!Array.isArray(a) || !a.every((v) => b.some((x) => same(x, v))))) return false;
        break;
      case 'minimum': case 'minLength': case 'minItems': case 'minProperties': case 'exclusiveMinimum':
        if (b !== undefined && !(typeof a === typeof b && a >= b)) return false;
        break;
      case 'maximum': case 'maxLength': case 'maxItems': case 'maxProperties': case 'exclusiveMaximum':
        if (b !== undefined && !(typeof a === typeof b && a <= b)) return false;
        break;
      case 'required':
        if (b !== undefined && !b.every((name) => (a || []).includes(name))) return false;
        break;
      case 'items':
        if (b !== undefined && !(a !== undefined && check(fd, a, td, b, ctx))) return false;
        break;
      case 'properties':
        if (!propertiesWiden(fd, f, td, t, ctx)) return false;
        break;
      case 'additionalProperties':
        if (!additionalWidens(fd, f, td, t, ctx)) return false;
        break;
      case 'oneOf': case 'anyOf':
        // A union next to other keywords: only when the two unions match branch for branch.
        if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || !a.every((x, i) => check(fd, x, td, b[i], ctx))) return false;
        break;
      default:
        // anything else (not, if/then, patternProperties, …): only when identical
        if (!same(a, b)) return false;
    }
  }
  return true;
}

function union(s) {
  if (Array.isArray(s.anyOf)) return { kind: 'anyOf', branches: s.anyOf };
  if (Array.isArray(s.oneOf)) return { kind: 'oneOf', branches: s.oneOf };
  return null;
}

function typeWidens(a, b, f) {
  if (b === undefined) return true;
  const fs = a === undefined ? (f.properties ? ['object'] : null) : [].concat(a);
  if (!fs) return false;
  const ts = [].concat(b);
  return fs.every((x) => ts.includes(x) || (x === 'integer' && ts.includes('number')));
}

function formatWidens(a, b, f) {
  if (b === undefined || a === b) return true;
  const types = [].concat(f.type || []);
  const numeric = types.length > 0 && types.every((x) => x === 'integer' || x === 'number' || x === 'null');
  if (!numeric || !(b in NUMERIC_WIDTH) || (a !== undefined && !(a in NUMERIC_WIDTH))) return false;
  return b !== 'int32' || a === 'int32';
}

/** Every property `from` allows must be allowed by `to`, at least as loosely. */
function propertiesWiden(fd, f, td, t, ctx) {
  const fp = f.properties || {};
  const tp = t.properties || {};
  for (const [name, a] of Object.entries(fp)) {
    if (tp[name] !== undefined) {
      if (!check(fd, a, td, tp[name], ctx)) return false;
    } else if (t.additionalProperties === false) {
      return false;
    } else if (isObj(t.additionalProperties) && !check(fd, a, td, t.additionalProperties, ctx)) {
      return false;
    }
  }
  // Properties only `to` declares: in a closed world `from`'s instances never
  // carry them; otherwise `from` must not have let arbitrary values through.
  if (ctx.closedWorld) return true;
  for (const [name, b] of Object.entries(tp)) {
    if (fp[name] !== undefined || f.additionalProperties === false) continue;
    if (isObj(f.additionalProperties) ? !check(fd, f.additionalProperties, td, b, ctx) : !acceptsAll(eff(td, b))) return false;
  }
  return true;
}

function additionalWidens(fd, f, td, t, ctx) {
  const a = f.additionalProperties;
  const b = t.additionalProperties;
  if (b === undefined || b === true || (isObj(b) && meaningful(b).length === 0)) return true;
  if (a === false) return true;
  if (b === false) return ctx.closedWorld;                      // closed world: nothing undeclared is sent
  return isObj(a) && check(fd, a, td, b, ctx);
}

function acceptsAll(s) {
  return s === true || (isObj(s) && meaningful(s).length === 0);
}

/** Branches a oneOf can't both match: distinct JSON types. */
function disjointTypes(doc, branches) {
  const seen = new Set();
  for (const b of branches) {
    const s = eff(doc, b);
    if (!isObj(s) || s.type === undefined || Array.isArray(s.type)) return false;
    const t = s.type === 'integer' ? 'number' : s.type;
    if (seen.has(t)) return false;
    seen.add(t);
  }
  return true;
}

/**
 * Can an instance of `branch` (which pins a required property to one value)
 * also match another branch of a oneOf? Not when every other branch requires
 * that property with values that leave it out — the usual discriminated union.
 */
function exclusiveIn(doc, branch, others) {
  const b = eff(doc, branch);
  if (!isObj(b)) return false;
  const req = new Set(b.required || []);
  for (const [prop, raw] of Object.entries(b.properties || {})) {
    const ps = eff(doc, raw);
    if (!req.has(prop) || !isObj(ps)) continue;
    const pinned = ps.const !== undefined ? ps.const : Array.isArray(ps.enum) && ps.enum.length === 1 ? ps.enum[0] : undefined;
    if (pinned === undefined) continue;
    const excluded = others.every((o) => {
      const os = eff(doc, o);
      const op = isObj(os) && os.properties && eff(doc, os.properties[prop]);
      if (!isObj(op) || !(os.required || []).includes(prop)) return false;
      const vals = op.const !== undefined ? [op.const] : op.enum;
      return Array.isArray(vals) && !vals.some((v) => same(v, pinned));
    });
    if (excluded) return true;
  }
  return false;
}

/** Same meaning both ways — "unchanged" for reporting. */
function equivalent(a, b) {
  return widens(a, b) && widens(b, a);
}

function meaningful(s) {
  return Object.keys(s).filter((k) => !ANNOTATION.test(k));
}

function onlyKeys(s, key) {
  return meaningful(s).every((k) => k === key);
}

function isObj(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function same(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

module.exports = { widens, equivalent, exclusiveIn };
