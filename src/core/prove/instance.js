'use strict';

/**
 * Deterministic example instances of a schema, with an optional override at
 * one location — the building block of a witness: "a valid request, except
 * that this one field holds this value (or is left out)".
 *
 * The generator aims for instances ajv accepts but never has to be perfect:
 * every witness is validated afterwards, and one that doesn't validate under
 * the spec it claims to satisfy is discarded.
 */

const S = require('./schema');

const OMIT = Symbol('omit');

const FORMATS = {
  'date-time': '2026-01-15T10:00:00Z',
  date: '2026-01-15',
  time: '10:00:00Z',
  uuid: '3fa85f64-5717-4562-b3fc-2c963f66afa6',
  email: 'jane@example.com',
  'idn-email': 'jane@example.com',
  uri: 'https://example.com/a',
  'uri-reference': '/a',
  url: 'https://example.com/a',
  hostname: 'example.com',
  'idn-hostname': 'example.com',
  ipv4: '192.0.2.1',
  ipv6: '2001:db8::1',
  byte: 'YWJj',
  binary: 'abc',
  password: 'secret-1',
  duration: 'P1D',
  int32: '1',
  int64: '1',
};

/**
 * @param doc      the spec document `schema` lives in
 * @param schema   a schema node of `doc`
 * @param opts.side      'request' (skip readOnly) | 'response' (skip writeOnly)
 * @param opts.full      include every optional property (default: required only)
 * @param opts.examples  use the spec's own `example` values for scalars
 * @param opts.variant   which oneOf/anyOf branch to take (index, wraps around)
 * @param opts.target    { steps, value } — at `steps`, put `value` (OMIT leaves it out)
 * @returns the instance, or undefined when the root itself is omitted
 */
// Size limits: "full" instances include optional properties only this close to
// the root, and no instance grows past this many values. Recursive specs
// (an object whose fields expand into other objects) would otherwise explode.
const FULL_DEPTH = 3;
const MAX_NODES = 1500;

function generate(doc, schema, opts = {}) {
  const o = { side: 'request', full: false, examples: true, variant: 0, target: null, ...opts, budget: { left: MAX_NODES } };
  const v = gen(doc, schema, o, [], 0, null);
  return v === OMIT ? undefined : v;
}

function gen(doc, node, o, steps, depth, discriminated) {
  if (o.target && sameSteps(steps, o.target.steps)) return clone(o.target.value);
  if (depth > 14) return null;
  o.budget.left--;
  const s = S.effective(doc, node);
  if (!s) return 'value';

  if (s.const !== undefined) return clone(s.const);
  const variants = s.oneOf || s.anyOf;
  if (Array.isArray(variants) && variants.length) return genVariant(doc, s, variants, o, steps, depth);

  if (Array.isArray(s.enum) && s.enum.length) {
    const vals = s.enum.filter((v) => v !== null);
    return clone(vals.length ? vals[0] : s.enum[0]);
  }
  const type = S.typeOf(s);
  const leaf = type !== 'object' && type !== 'array';
  if (o.examples && leaf && s.example !== undefined && !onPath(steps, o.target)) return clone(s.example);
  if (o.examples && leaf && s.default !== undefined && !onPath(steps, o.target)) return clone(s.default);

  switch (type) {
    case 'object': return genObject(doc, s, o, steps, depth, discriminated);
    case 'array': return genArray(doc, s, o, steps, depth);
    case 'integer': return number(s, true);
    case 'number': return number(s, false);
    case 'boolean': return true;
    case 'null': return null;
    case 'string': return string(s);
    default: return s.properties ? genObject(doc, s, o, steps, depth, discriminated) : 'value';
  }
}

function genObject(doc, s, o, steps, depth, discriminated) {
  const out = {};
  const required = new Set(s.required || []);
  const skip = o.side === 'request' ? 'readOnly' : 'writeOnly';
  for (const [name, child] of Object.entries(s.properties || {})) {
    const at = [...steps, { prop: name }];
    const through = onPath(at, o.target);
    const c = S.deref(doc, child);
    if (!through && c && c[skip] === true) continue;
    const roomy = o.full && depth < FULL_DEPTH && o.budget.left > 0;
    if (!through && !roomy && !required.has(name)) continue;
    const v = gen(doc, child, o, at, depth + 1, null);
    if (v !== OMIT) out[name] = v;
  }
  const ap = s.additionalProperties;
  if (ap && typeof ap === 'object') {
    const at = [...steps, { map: true }];
    if (onPath(at, o.target) || (o.full && depth < FULL_DEPTH && Object.keys(out).length === 0)) {
      const v = gen(doc, ap, o, at, depth + 1, null);
      if (v !== OMIT) out.key = v;
    }
  }
  if (discriminated && !(s.properties && s.properties[discriminated.property] && S.effective(doc, s.properties[discriminated.property]).enum)) {
    out[discriminated.property] = discriminated.value;
  }
  // minProperties: pad with generic entries only when nothing else is declared.
  for (let i = Object.keys(out).length; i < (s.minProperties || 0) && s.additionalProperties !== false; i++) out[`key${i}`] = 'value';
  return out;
}

function genArray(doc, s, o, steps, depth) {
  const at = [...steps, { items: true }];
  const min = s.minItems || 0;
  const max = s.maxItems === undefined ? Infinity : s.maxItems;
  const n = Math.min(max, Math.max(min, o.budget.left > 0 ? 1 : 0));
  const out = [];
  for (let i = 0; i < n; i++) {
    const v = gen(doc, s.items || {}, i === 0 ? o : { ...o, target: null }, at, depth + 1, null);
    if (v === OMIT) continue;
    out.push(s.uniqueItems && i > 0 ? vary(v, i) : v);
  }
  return out;
}

function genVariant(doc, s, variants, o, steps, depth) {
  // An explicit variant on the target's path wins; otherwise o.variant picks one.
  const key = s.oneOf ? 'oneOf' : 'anyOf';
  let index = o.variant % variants.length;
  for (let i = 0; i < variants.length; i++) {
    if (onPath([...steps, { variant: key, index: i }], o.target)) { index = i; break; }
  }
  const variant = variants[index];
  const disc = s.discriminator && s.discriminator.propertyName
    ? { property: s.discriminator.propertyName, value: discriminatorValue(s.discriminator, variant) }
    : null;
  let v = gen(doc, variant, o, [...steps, { variant: key, index }], depth + 1, disc);
  if (v === OMIT) return OMIT;
  // Properties declared next to oneOf apply to every branch.
  if (s.properties && v && typeof v === 'object' && !Array.isArray(v)) {
    const base = genObject(doc, { ...s, oneOf: undefined, anyOf: undefined }, o, steps, depth, null);
    v = { ...base, ...v };
  }
  return v;
}

function discriminatorValue(disc, variant) {
  const ref = variant && variant.$ref;
  if (disc.mapping) {
    for (const [value, target] of Object.entries(disc.mapping)) {
      if (target === ref || (ref && ref.endsWith(`/${target}`))) return value;
    }
  }
  return ref ? ref.split('/').pop() : 'value';
}

// ─── scalars ────────────────────────────────────────────────────────────────

function number(s, integer) {
  let lo = typeof s.minimum === 'number' ? s.minimum : -Infinity;
  let hi = typeof s.maximum === 'number' ? s.maximum : Infinity;
  const step = integer ? 1 : 0.5;
  if (s.exclusiveMinimum === true) lo += step; else if (typeof s.exclusiveMinimum === 'number') lo = Math.max(lo, s.exclusiveMinimum + step);
  if (s.exclusiveMaximum === true) hi -= step; else if (typeof s.exclusiveMaximum === 'number') hi = Math.min(hi, s.exclusiveMaximum - step);
  let v = integer ? 1 : 1.5;
  if (v < lo) v = integer ? Math.ceil(lo) : lo;
  if (v > hi) v = integer ? Math.floor(hi) : hi;
  if (typeof s.multipleOf === 'number' && s.multipleOf > 0) {
    v = Math.ceil(v / s.multipleOf) * s.multipleOf;
    if (v > hi) v = Math.floor(hi / s.multipleOf) * s.multipleOf;
    v = Number(v.toFixed(10));
  }
  return v;
}

function string(s, base = null) {
  const min = s.minLength || 0;
  const max = s.maxLength === undefined ? Infinity : s.maxLength;
  if (s.pattern) {
    const m = fromPattern(s.pattern, { min, max });
    if (m !== null) return m;
  }
  return ofLength(base !== null ? base : (FORMATS[s.format] || 'abc'), s.format, min, max);
}

/**
 * Lengthens or shortens a string to fit [min, max] without breaking its
 * format: padding goes where the format allows it (a URI's path, an email's
 * local part), not at the end of a domain.
 */
function ofLength(v, format, min, max) {
  if (v.length >= min && v.length <= max) return v;
  if (v.length > max) return v.slice(0, max);
  const pad = 'x'.repeat(min - v.length);
  if (format === 'email' || format === 'idn-email') return pad + v;
  if (format === 'uri' || format === 'url' || format === 'uri-reference') return v + pad;
  if (format === 'hostname' || format === 'idn-hostname') return `${pad.replace(/x{60}/g, 'x'.repeat(59) + '.')}${v}`;
  if (format && FORMATS[format]) return v;                    // fixed-length formats (date, uuid…): leave it to validation
  return v + pad;
}

// ─── strings from a regular expression ─────────────────────────────────────

/**
 * A short string matching `pattern`, within [min, max] length, or null.
 * Covers what API specs use: literals, escapes (\d \w \s), classes, groups,
 * alternation, quantifiers and anchors. Lookarounds and backreferences → null.
 */
function fromPattern(pattern, { min = 0, max = Infinity } = {}) {
  let ast;
  try { ast = parseRegex(pattern); } catch { return null; }
  let re;
  try { re = new RegExp(pattern, 'u'); } catch { try { re = new RegExp(pattern); } catch { return null; } }
  const shortest = emit(ast.node, { extra: 0 });
  if (shortest === null || shortest.length > max) return null;
  // Spend exactly the characters still needed on the pattern's repeats.
  let s = shortest.length >= min ? shortest : emit(ast.node, { extra: min - shortest.length });
  if (s === null) return null;
  if (s.length < min) {
    // An unanchored pattern matches inside a longer string.
    if (!ast.end) s += 'x'.repeat(min - s.length);
    else if (!ast.start) s = 'x'.repeat(min - s.length) + s;
  }
  return s.length >= min && s.length <= max && re.test(s) ? s : null;
}

function parseRegex(src) {
  let i = 0;
  const start = src[0] === '^';
  if (start) i = 1;
  const peek = () => src[i];
  const end = src.length > i && src[src.length - 1] === '$' && src[src.length - 2] !== '\\';
  const stop = end ? src.length - 1 : src.length;

  function alternation() {
    const branches = [sequence()];
    while (i < stop && peek() === '|') { i++; branches.push(sequence()); }
    return branches.length === 1 ? branches[0] : { alt: branches };
  }
  function sequence() {
    const items = [];
    while (i < stop && peek() !== '|' && peek() !== ')') {
      let atom = atomNode();
      atom = quantified(atom);
      items.push(atom);
    }
    return { seq: items };
  }
  function atomNode() {
    const c = src[i++];
    if (c === '(') {
      if (src[i] === '?') {
        if (src[i + 1] === ':') i += 2;
        else if (src[i + 1] === '<' && src[i + 2] !== '=' && src[i + 2] !== '!') { i = src.indexOf('>', i) + 1; } else throw new Error('lookaround');
      }
      const inner = alternation();
      if (src[i++] !== ')') throw new Error('unbalanced');
      return inner;
    }
    if (c === '[') return charClass();
    if (c === '\\') return escape();
    if (c === '.') return { chars: 'a' };
    if (c === '^' || c === '$') return { lit: '' };
    return { lit: c };
  }
  function escape() {
    const c = src[i++];
    if (c === 'd') return { chars: '1' };
    if (c === 'w') return { chars: 'a' };
    if (c === 's') return { chars: ' ' };
    if (c === 'D' || c === 'W' || c === 'S') return { chars: c === 'S' ? 'a' : '-' };
    if (c === 'b' || c === 'B') return { lit: '' };
    if (/[1-9]/.test(c)) throw new Error('backreference');
    if (c === 'u' && /^[0-9a-fA-F]{4}$/.test(src.slice(i, i + 4))) { const ch = String.fromCharCode(parseInt(src.slice(i, i + 4), 16)); i += 4; return { lit: ch }; }
    if (c === 'x' && /^[0-9a-fA-F]{2}$/.test(src.slice(i, i + 2))) { const ch = String.fromCharCode(parseInt(src.slice(i, i + 2), 16)); i += 2; return { lit: ch }; }
    if (c === 'n') return { lit: '\n' };
    if (c === 't') return { lit: '\t' };
    return { lit: c };
  }
  function charClass() {
    let negate = false;
    if (src[i] === '^') { negate = true; i++; }
    const members = [];
    let first = true;
    while (i < src.length && (src[i] !== ']' || first)) {
      first = false;
      let c = src[i++];
      if (c === '\\') {
        const e = src[i++];
        c = e === 'd' ? '1' : e === 'w' ? 'a' : e === 's' ? ' ' : e;
        members.push([c, c]);
        continue;
      }
      if (src[i] === '-' && src[i + 1] && src[i + 1] !== ']') {
        let hi = src[i + 1];
        i += 2;
        if (hi === '\\') hi = src[i++];
        members.push([c, hi]);
      } else members.push([c, c]);
    }
    i++;                                                       // ]
    if (!negate) {
      // Prefer a letter or digit when the class allows one — reads better.
      for (const pref of ['a', 'A', '1', 'x']) if (members.some(([lo, hi]) => pref >= lo && pref <= hi)) return { chars: pref };
      return { chars: members.length ? members[0][0] : 'a' };
    }
    for (const cand of ['a', '1', 'x', 'Z', '_', '-', ' ']) {
      if (!members.some(([lo, hi]) => cand >= lo && cand <= hi)) return { chars: cand };
    }
    return { chars: '~' };
  }
  function quantified(atom) {
    const c = src[i];
    let q = null;
    if (c === '*') q = [0, Infinity];
    else if (c === '+') q = [1, Infinity];
    else if (c === '?') q = [0, 1];
    else if (c === '{') {
      const m = /^\{(\d+)(,(\d*))?\}/.exec(src.slice(i));
      if (m) { q = [Number(m[1]), m[2] ? (m[3] ? Number(m[3]) : Infinity) : Number(m[1])]; i += m[0].length - 1; }
    }
    if (!q) return atom;
    i++;
    if (src[i] === '?' || src[i] === '+') i++;                 // lazy / possessive
    return { repeat: atom, min: q[0], max: q[1] };
  }

  const node = alternation();
  if (i !== stop) throw new Error('unparsed');
  return { node, start, end };
}

/** The shortest match, with `state.extra` more characters spent on repeats left to right. */
function emit(n, state) {
  if (n.lit !== undefined) return n.lit;
  if (n.chars !== undefined) return n.chars;
  if (n.seq) {
    let out = '';
    for (const x of n.seq) { const s = emit(x, state); if (s === null) return null; out += s; }
    return out;
  }
  if (n.alt) return emit(n.alt[0], state);
  if (n.repeat) {
    const unit = emit(n.repeat, { extra: 0 });
    if (unit === null) return null;
    let count = n.min;
    if (state.extra > 0 && unit.length > 0 && n.max > n.min) {
      const more = Math.min(n.max - n.min, Math.ceil(state.extra / unit.length));
      count += more;
      state.extra -= more * unit.length;
    }
    let out = '';
    for (let k = 0; k < count; k++) { const s = emit(n.repeat, state); if (s === null) return null; out += s; }
    return out;
  }
  return '';
}

// ─── helpers ────────────────────────────────────────────────────────────────

function sameSteps(a, b) {
  if (a.length !== b.length) return false;
  return a.every((s, i) => stepKey(s) === stepKey(b[i]));
}

function stepKey(s) {
  if (s.prop !== undefined) return `p:${s.prop}`;
  if (s.items) return 'i';
  if (s.map) return 'm';
  return `v:${s.variant}:${s.index}`;
}

/** True when `steps` is a prefix of (or equal to) the target's steps. */
function onPath(steps, target) {
  if (!target || steps.length > target.steps.length) return false;
  return steps.every((s, i) => stepKey(s) === stepKey(target.steps[i]));
}

function vary(v, i) {
  if (typeof v === 'string') return `${v}${i}`;
  if (typeof v === 'number') return v + i;
  return v;
}

function clone(v) {
  return v === undefined || v === OMIT || v === null || typeof v !== 'object' ? v : JSON.parse(JSON.stringify(v));
}

module.exports = { generate, fromPattern, string, ofLength, number, OMIT, sameSteps, stepKey, FORMATS };
