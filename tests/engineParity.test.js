'use strict';

/**
 * CLI ↔ hosted-engine parity guard.
 *
 * The CLI diff engine is deliberately SMALLER than the hosted one. That is a
 * product decision: the CLI is the free, offline, zero-config surface, and the
 * hosted gate is where the nuanced rules live.
 *
 * The rule that makes that safe:
 *
 *     The CLI may detect FEWER change types than the backend,
 *     but it must never classify a shared type DIFFERENTLY.
 *     Subset, not variant.
 *
 * Why it matters: if `specshield compare` red-lights a change the hosted PR
 * check passes (or vice versa), a developer learns that one of the two is
 * lying and stops trusting both. That is the exact failure this product is
 * sold to prevent, so manufacturing it in our own toolchain is not an option.
 *
 * This file encodes the backend's classification as data. When the backend
 * changes, this table must be updated in the same change — that is the point.
 * Source of truth: APIContractDrift ClassificationEngine.java (verified
 * 2026-08-24, backend suite at 658 tests).
 */

const { classifyChanges } = require('../src/core/classifyChanges');

/**
 * Backend verdict for every change type the CLI can emit.
 *
 * `true`  → backend calls it breaking
 * `false` → backend calls it non-breaking
 * `null`  → backend splits it by request/response direction, so the CLI (which
 *           has no direction) must NOT rule on it either — warning only.
 */
const BACKEND_VERDICT = {
  // Removals — breaking on both sides, no ambiguity.
  ENDPOINT_REMOVED: true,
  METHOD_REMOVED: true,
  PARAMETER_REMOVED: true,
  REQUEST_FIELD_REMOVED: true,
  RESPONSE_FIELD_REMOVED: true,
  RESPONSE_REMOVED: true,
  SCHEMA_REMOVED: true,
  SCHEMA_VARIANT_REMOVED: true,

  // Type changes break serialization regardless of side.
  PARAMETER_TYPE_CHANGED: true,
  REQUEST_FIELD_TYPE_CHANGED: true,
  RESPONSE_FIELD_TYPE_CHANGED: true,
  REQUEST_TYPE_CHANGED: true,
  RESPONSE_TYPE_CHANGED: true,

  SCHEMA_DISCRIMINATOR_CHANGED: true,
  ENUM_VALUE_REMOVED: true,

  // Requiredness — the CLI already encodes direction in the type name.
  FIELD_BECAME_REQUIRED: true,
  PARAMETER_BECAME_REQUIRED: true,
  REQUEST_REQUIRED_FIELD_ADDED: true,
  FIELD_BECAME_OPTIONAL: false,
  PARAMETER_BECAME_OPTIONAL: false,

  // Additions.
  ENDPOINT_ADDED: false,
  METHOD_ADDED: false,
  PARAMETER_ADDED: false,
  REQUEST_FIELD_ADDED: false,
  RESPONSE_FIELD_ADDED: false,
  RESPONSE_ADDED: false,
  SCHEMA_ADDED: false,
  SCHEMA_VARIANT_ADDED: false,

  // Direction-dependent: the backend splits these into REQUEST_* / RESPONSE_*
  // with opposite verdicts. The CLI has no direction, so it must abstain.
  CONSTRAINT_TIGHTENED: null,
  CONSTRAINT_PATTERN_CHANGED: null,
  CONSTRAINT_RELAXED: false,
};

/** Runs one synthetic diff of the given type through the classifier. */
function classifyOne(type) {
  const r = classifyChanges([{
    type,
    path: '/x',
    method: 'get',
    field: 'f',
    description: `${type} for parity test`,
  }]);
  return {
    breaking: r.breakingChanges.some(c => c.type === type),
    warning: r.warnings.some(c => c.type === type),
    seen: [...r.breakingChanges, ...r.additions, ...r.modifications, ...r.warnings]
      .some(c => c.type === type),
  };
}

describe('CLI engine is a strict subset of the hosted engine', () => {

  test('every change type the CLI emits has a recorded backend verdict', () => {
    const diffEngineSource = require('fs')
      .readFileSync(require.resolve('../src/core/diffEngine.js'), 'utf8');
    const emitted = new Set(
      [...diffEngineSource.matchAll(/type:\s*'([A-Z_]+)'/g)].map(m => m[1])
    );

    const unrecorded = [...emitted].filter(t => !(t in BACKEND_VERDICT)).sort();
    expect(unrecorded).toEqual([]);
  });

  test.each(
    Object.entries(BACKEND_VERDICT).filter(([, v]) => v === true)
  )('%s is breaking in both engines', (type) => {
    expect(classifyOne(type).breaking).toBe(true);
  });

  test.each(
    Object.entries(BACKEND_VERDICT).filter(([, v]) => v === false)
  )('%s is non-breaking in both engines', (type) => {
    expect(classifyOne(type).breaking).toBe(false);
  });

  test.each(
    Object.entries(BACKEND_VERDICT).filter(([, v]) => v === null)
  )('%s is direction-dependent, so the CLI abstains rather than guesses', (type) => {
    const { breaking, warning, seen } = classifyOne(type);
    expect(breaking).toBe(false);
    expect(warning).toBe(true);
    expect(seen).toBe(true); // reported, never silently dropped
  });

  test('no direction-dependent type can fail a build', () => {
    const { resolveExitCode } = require('../src/core/exitCode');
    const ambiguous = Object.entries(BACKEND_VERDICT)
      .filter(([, v]) => v === null)
      .map(([type]) => ({ type, path: '/x', method: 'get', field: 'f', description: type }));

    const classified = classifyChanges(ambiguous);
    const code = resolveExitCode(classified, { failOnBreaking: true, allowBreaking: false });

    expect(classified.breakingChanges).toHaveLength(0);
    expect(code).toBe(0);
  });
});
