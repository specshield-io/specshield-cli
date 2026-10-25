'use strict';

const { normalizeSpec } = require('../normalizeSpec');
const { diffSpecs } = require('../diffEngine');
const { BREAKING_TYPES } = require('../classifyChanges');
const { suggest, detectRenames, detectEnumRenames, reshapedBodies, sig } = require('./strategies');
const { applyOps, clone } = require('./ops');

/**
 * Break → fix. For every breaking change between `baseDoc` and `targetDoc`
 * (raw parsed specs), proposes the expand-and-contract edit to the target
 * that keeps existing clients working — and keeps it only if the diff engine
 * agrees: applied on top of the fixes accepted so far, the suggestion must
 * remove the breaking change(s) it addresses and must not introduce any other
 * breaking change. Suggestions are applied in that order, so the returned
 * `fixedDoc` is exactly what was verified.
 */
function fixSpec(baseDoc, targetDoc, { sunset = null, depth = 0 } = {}) {
  const baseNorm = normalizeSpec(baseDoc);
  const raw = diffSpecs(baseNorm, normalizeSpec(targetDoc));
  const breaking = raw.filter((d) => BREAKING_TYPES.has(d.type));
  const original = new Set(breaking.map(sig));
  const deprecate = deprecator(targetDoc, sunset);

  // Fixes depend on each other: restoring a removed field that references an
  // enum which lost a value brings that enum break into view, and only a
  // second round can fix it. So run rounds; within a round a fix is accepted
  // when it removes its own break(s), even if it exposes another. At the end the
  // result must contain no break the original target didn't have — otherwise
  // fall back to strict mode, where no fix may introduce anything.
  const relaxed = run({ baseDoc, targetDoc, baseNorm, deprecate, depth, strict: false });
  const ok = [...relaxed.currentBreaking].every((x) => original.has(x));
  const result = ok ? relaxed : run({ baseDoc, targetDoc, baseNorm, deprecate, depth, strict: true });

  return {
    suggestions: result.suggestions,
    fixedDoc: result.current,
    ops: result.ops,
    before: breaking.length,
    after: result.currentBreaking.size,
    remaining: breaking.filter((c) => result.currentBreaking.has(sig(c))),
  };
}

function run({ baseDoc, targetDoc, baseNorm, deprecate, depth, strict }) {
  let current = clone(targetDoc);
  let currentBreaking = breakingSigs(baseNorm, current);
  const ops = [];
  const all = [];
  const seen = new Set();

  for (let round = 0; round < 5; round++) {
    const raw = diffSpecs(baseNorm, normalizeSpec(current));
    const ctx = {
      base: baseDoc,
      target: current,
      renames: detectRenames(raw, baseNorm, normalizeSpec(current)),
      enumRenames: detectEnumRenames(raw, baseNorm, normalizeSpec(current)),
      reshaped: reshapedBodies(raw),
      deprecate,
      // Transforms for changes nested inside a reshaped body (see bodyShapeChanged).
      nested: depth < 2
        ? (b, t) => fixSpec(b, t, { depth: depth + 1 }).suggestions.flatMap((x) => x.transforms)
        : null,
    };
    const fresh = raw.filter((d) => BREAKING_TYPES.has(d.type) && !seen.has(sig(d)));
    if (fresh.length === 0 && round > 0) break;
    const suggestions = mergeIdentical(raw.filter((d) => BREAKING_TYPES.has(d.type) && (round === 0 || !seen.has(sig(d)) || retry(all, d)))
      .map((c) => suggest(c, ctx)));
    for (const d of raw) if (BREAKING_TYPES.has(d.type)) seen.add(sig(d));

    let progress = false;
    for (const s of suggestions) {
      if (!s.strategy) { s.status = 'manual'; continue; }
      if (s.changes.every((c) => !currentBreaking.has(sig(c)))) { s.status = 'covered'; continue; }
      let candidate;
      let after;
      try {
        candidate = applyOps(clone(current), s.ops);
        after = breakingSigs(baseNorm, candidate);
      } catch (err) {
        reject(s, `the edited spec no longer parses: ${err.message}`);
        continue;
      }
      const unfixed = s.changes.filter((c) => after.has(sig(c)));
      const introduced = [...after].filter((x) => !currentBreaking.has(x));
      if (unfixed.length > 0) { reject(s, 'the diff engine still reports the breaking change'); continue; }
      // Relaxed rounds let a fix expose a break that a later round fixes (a
      // restored field brings its enum's removed value back into view); the
      // final subset check in fixSpec keeps that honest.
      if (introduced.length > 0 && strict) {
        reject(s, `it would add a breaking change: ${describe(introduced[0])}`);
        continue;
      }
      s.status = 'verified';
      current = candidate;
      currentBreaking = after;
      ops.push(...s.ops);
      progress = true;
    }
    mergeInto(all, suggestions);
    if (!progress) break;
  }
  return { suggestions: all, current, currentBreaking, ops };
}

/** A change rejected in an earlier round gets another chance once other fixes landed. */
function retry(all, d) {
  return all.some((s) => s.status === 'rejected' && s.changes.some((c) => sig(c) === sig(d)));
}

/** Later rounds' verdicts replace earlier ones for the same changes. */
function mergeInto(all, next) {
  for (const s of next) {
    const keys = new Set(s.changes.map(sig));
    for (let i = all.length - 1; i >= 0; i--) {
      if (all[i].changes.some((c) => keys.has(sig(c))) && all[i].status !== 'verified') all.splice(i, 1);
    }
    if (s.status === 'covered' && all.some((x) => x.status === 'verified' && x.changes.some((c) => keys.has(sig(c))))) continue;
    all.push(s);
  }
}

function reject(s, reason) {
  s.status = 'rejected';
  s.reason = reason;
}

function breakingSigs(baseNorm, doc) {
  return new Set(diffSpecs(baseNorm, normalizeSpec(doc)).filter((d) => BREAKING_TYPES.has(d.type)).map(sig));
}

function describe(signature) {
  const [type, method, path, field] = signature.split('|');
  return `${type}${method ? ` ${method.toUpperCase()} ${path}` : ''}${field ? ` ${field}` : ''}`;
}

/**
 * A change to a shared component shows up once per operation that uses it;
 * the fix is the same edit each time. One suggestion, many changes.
 */
function mergeIdentical(list) {
  const byOps = new Map();
  const out = [];
  for (const s of list) {
    if (!s.strategy || s.ops.length === 0) { out.push(s); continue; }
    const key = JSON.stringify(s.ops);
    const prev = byOps.get(key);
    if (prev) {
      prev.changes.push(...s.changes);
      prev.transforms.push(...s.transforms);
      continue;
    }
    byOps.set(key, s);
    out.push(s);
  }
  return out;
}

/**
 * Marks a restored node deprecated the way the spec's version allows:
 * `deprecated: true` (OpenAPI 3; beside a $ref it is honoured by 3.1 and
 * ignored by 3.0 tools), `x-deprecated` on Swagger 2.0 schemas, and
 * `x-sunset` when a sunset date was given.
 */
function deprecator(targetDoc, sunset) {
  const swagger2 = typeof targetDoc.swagger === 'string';
  return (node, note = null) => {
    if (!node || typeof node !== 'object') return node;
    const isSchemaish = !node.responses && !node.in;
    if (swagger2 && isSchemaish) node['x-deprecated'] = true;
    else node.deprecated = true;
    if (sunset) node['x-sunset'] = sunset;
    if (note && !node.$ref) node.description = node.description ? `${node.description} Deprecated: ${note}` : `Deprecated: ${note}`;
    return node;
  };
}

module.exports = { fixSpec };
