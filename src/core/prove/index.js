'use strict';

/**
 * `specshield prove` as a library: classify the changes between two specs the
 * way `compare` and `gate` do, and attach a witness to each breaking change
 * (and to each constraint warning, which the engine reports without ruling on).
 *
 * The diff engine merges a field change that a shared schema spreads across
 * several endpoints into one finding; its proof is the strongest witness among
 * those endpoints, with a count of how many were proven.
 */

const { normalizeSpec } = require('../normalizeSpec');
const { diffSpecs } = require('../diffEngine');
const { classifyChanges } = require('../classifyChanges');
const { context, proveChange, PROVABLE } = require('./witness');

const RANK = { proven: 3, example: 2, compatible: 1, unproven: 0 };

function prove(baseDoc, targetDoc) {
  const raw = diffSpecs(normalizeSpec(baseDoc), normalizeSpec(targetDoc));
  const classified = classifyChanges(raw);
  const proofs = witnesses(baseDoc, targetDoc, raw);

  const breaking = classified.breakingChanges.map((c) => attach(c, proofs));
  const warnings = classified.warnings.map((c) => attach(c, proofs));
  return {
    breaking,
    warnings,
    nonBreaking: classified.additions.length + classified.modifications.length,
    summary: summarize(breaking),
    proofs,
  };
}

/** Per-endpoint witnesses for every provable raw diff. */
function witnesses(baseDoc, targetDoc, raw = diffSpecs(normalizeSpec(baseDoc), normalizeSpec(targetDoc))) {
  const ctx = context(baseDoc, targetDoc);
  return raw.filter((d) => PROVABLE.has(d.type)).map((d) => ({ diff: d, witness: proveChange(ctx, d) }));
}

/** The proof for one classified change, drawn from the per-endpoint witnesses. */
function proofFor(change, proofs) {
  const eps = endpointsOf(change);
  const merged = Array.isArray(change.affectedEndpoints) && change.affectedEndpoints.length > 1;
  const mine = proofs.filter(({ diff: d }) => {
    if (d.type !== change.type) return false;
    if (eps.length === 0) return !d.method && (d.field || null) === (change.field || null);
    if (!d.method || !eps.includes(`${d.method.toUpperCase()} ${d.path}`)) return false;
    return merged ? leaf(d.field) === leaf(change.field) : (d.field || null) === (change.field || null);
  });
  if (mine.length === 0) return null;
  const best = mine.reduce((a, b) => (RANK[b.witness.status] > RANK[a.witness.status] ? b : a));
  return {
    ...best.witness,
    diff: { type: best.diff.type, method: best.diff.method || null, path: best.diff.path || null, field: best.diff.field || null },
    endpoints: mine.length,
    provenOn: mine.filter((p) => p.witness.status === 'proven').length,
  };
}

function attach(change, proofs) {
  return { ...change, proof: proofFor(change, proofs) };
}

function summarize(changes) {
  const out = { total: changes.length, proven: 0, example: 0, compatible: 0, unproven: 0 };
  for (const c of changes) out[c.proof ? c.proof.status : 'unproven']++;
  return out;
}

function endpointsOf(c) {
  if (Array.isArray(c.affectedEndpoints) && c.affectedEndpoints.length) return c.affectedEndpoints;
  return c.method && c.path ? [`${c.method.toUpperCase()} ${c.path}`] : [];
}

/** Mirrors classifyChanges' leafFieldName: "responses.200.data[items].legacy_id" → "legacy_id". */
function leaf(field) {
  if (!field) return null;
  const parts = field.split('.');
  return parts[parts.length - 1].replace(/\[.*$/, '');
}

module.exports = { prove, witnesses, proofFor, summarize };
