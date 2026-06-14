'use strict';

/**
 * CLI-engine mirror of the backend complex-spec corpus
 * (APIContractDrift/src/test/resources/complex-spec-corpus). Runs each spec
 * through the REAL CLI pipeline (parseSpec → normalizeSpec) and reports whether
 * the "marker" fields inside each construct survive normalization — then a diff
 * smoke confirms a breaking change buried in a union is actually detected.
 *
 * Goal: know whether the CLI's JS engine has the same blind spots the backend
 * Java engine had, BEFORE claiming "handles complex specs" anywhere.
 */

const fs = require('fs');
const path = require('path');
const { parseSpec } = require('../src/core/parseSpec');
const { normalizeSpec } = require('../src/core/normalizeSpec');
const { diffSpecs } = require('../src/core/diffEngine');
const { classifyChanges } = require('../src/core/classifyChanges');

const CORPUS = path.join(__dirname, 'fixtures', 'complex-spec-corpus');

const CASES = [
  { file: '01-allof.yaml',                construct: 'allOf (control)',        markers: ['id', 'email'] },
  { file: '02-oneof.yaml',                construct: 'oneOf',                  markers: ['bark', 'meow'] },
  { file: '03-anyof.yaml',                construct: 'anyOf',                  markers: ['alpha', 'beta'] },
  { file: '04-discriminator.yaml',        construct: 'oneOf+discriminator',    markers: ['petType', 'wingspan', 'depth'] },
  { file: '05-additionalproperties.yaml', construct: 'additionalProperties',   markers: ['value', 'unit'] },
  { file: '06-openapi31-nullunion.yaml',  construct: 'OpenAPI 3.1 null-union', markers: ['id', 'nickname'] },
  { file: '07-circular-ref.yaml',         construct: 'circular $ref',          markers: ['label', 'children'] },
];

function firstResponseSchema(norm) {
  const eps = norm.endpoints || {};
  for (const methods of Object.values(eps)) {
    for (const op of Object.values(methods)) {
      const r = op.responses || {};
      if (r['200']) return r['200'];
      const first = Object.values(r)[0];
      if (first) return first;
    }
  }
  return null;
}

function collectProps(node, out, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 25) return;
  if (node.properties) {
    for (const [k, v] of Object.entries(node.properties)) { out.add(k); collectProps(v, out, depth + 1); }
  }
  if (node.items) collectProps(node.items, out, depth + 1);
  if (node.additionalProperties) collectProps(node.additionalProperties, out, depth + 1);
  if (Array.isArray(node.oneOf)) node.oneOf.forEach((v) => collectProps(v, out, depth + 1));
  if (Array.isArray(node.anyOf)) node.anyOf.forEach((v) => collectProps(v, out, depth + 1));
}

describe('CLI engine — complex-spec corpus mirror', () => {
  const result = {};

  test('capture diagnostic (prints handle-vs-gap report)', () => {
    let report = '\n=== CLI COMPLEX-SPEC CORPUS DIAGNOSTIC ===\n';
    for (const c of CASES) {
      const content = fs.readFileSync(path.join(CORPUS, c.file), 'utf8');
      let status = 'OK';
      const captured = new Set();
      try {
        const norm = normalizeSpec(parseSpec(content, c.file));
        collectProps(firstResponseSchema(norm), captured);
      } catch (e) {
        status = 'THREW: ' + e.message;
      }
      const found = c.markers.filter((m) => captured.has(m)).length;
      const verdict = status !== 'OK' ? '❌ PARSE FAILED'
        : found === c.markers.length ? '✅ FULL'
        : found === 0 ? '❌ GAP'
        : '⚠️ PARTIAL';
      result[c.construct] = found === c.markers.length && status === 'OK';
      report += `${c.construct.padEnd(24)} parse=${status === 'OK' ? 'OK ' : 'FAIL'} markers ${found}/${c.markers.length}  ${verdict}\n   captured: ${[...captured].join(', ') || '(none)'}\n`;
      if (status !== 'OK') report += `   detail: ${status}\n`;
    }
    report += '=== END DIAGNOSTIC ===\n';
    // eslint-disable-next-line no-console
    console.log(report);

    // Control must work (harness sanity).
    expect(result['allOf (control)']).toBe(true);
  });

  // The CLI MERGES oneOf/anyOf variants into one object, so it does capture the
  // variant fields (unlike the pre-fix backend). Assert that capture so a
  // regression is caught.
  test('oneOf / anyOf variant fields are captured (via merge)', () => {
    expect(result['oneOf']).toBe(true);
    expect(result['anyOf']).toBe(true);
    expect(result['oneOf+discriminator']).toBe(true);
  });

  // P1 (fixed): additionalProperties map value schema is now captured.
  test('additionalProperties (map value schema) is captured', () => {
    expect(result['additionalProperties']).toBe(true);
  });

  // Diff smoke: a field removed inside a oneOf variant must surface as breaking.
  test('breaking change inside a oneOf variant is detected', () => {
    const base = normalizeSpec(parseSpec(fs.readFileSync(path.join(CORPUS, '02-oneof.yaml'), 'utf8'), '02-oneof.yaml'));
    const targetYaml = [
      'openapi: 3.0.3',
      'info: {title: OneOf Demo, version: 2.0.0}',
      'paths:',
      '  /pet:',
      '    get:',
      '      responses:',
      "        '200':",
      '          description: ok',
      '          content:',
      '            application/json:',
      '              schema:',
      '                oneOf:',
      '                  - type: object',
      '                    properties: {}',          // Dog lost `bark`
      '                  - type: object',
      '                    required: [meow]',
      '                    properties: {meow: {type: string}}',
      '',
    ].join('\n');
    const target = normalizeSpec(parseSpec(targetYaml, 'target.yaml'));
    const classified = classifyChanges(diffSpecs(base, target));
    const hitBark = classified.breakingChanges.some(
      (c) => /bark/.test(c.field || '') && /REMOVED/.test(c.type || ''));
    expect(hitBark).toBe(true);
  });

  // The next three mirror the backend's ComplexSpecDiffTest so both engines
  // assert the same variant-aware contract.
  test('removing a oneOf variant is breaking', () => {
    const base = normalizeSpec(parseSpec(fs.readFileSync(path.join(CORPUS, '02-oneof.yaml'), 'utf8'), '02-oneof.yaml'));
    const targetYaml = [
      'openapi: 3.0.3',
      'info: {title: OneOf Demo, version: 2.0.0}',
      'paths:',
      '  /pet:',
      '    get:',
      '      responses:',
      "        '200':",
      '          description: ok',
      '          content:',
      '            application/json:',
      '              schema:',
      '                oneOf:',
      '                  - type: object',
      '                    required: [bark]',
      '                    properties: {bark: {type: string}}',
      '',
    ].join('\n');
    const target = normalizeSpec(parseSpec(targetYaml, 'target.yaml'));
    const classified = classifyChanges(diffSpecs(base, target));
    expect(classified.breakingChanges.some((c) => c.type === 'SCHEMA_VARIANT_REMOVED')).toBe(true);
  });

  test('adding a oneOf variant is non-breaking', () => {
    // Inline base + target (no components.schemas on either side) so the test
    // isolates variant behavior — otherwise removing inline-vs-$ref component
    // schemas adds unrelated SCHEMA_REMOVED noise.
    const twoVariants = [
      '                  - type: object',
      '                    required: [bark]',
      '                    properties: {bark: {type: string}}',
      '                  - type: object',
      '                    required: [meow]',
      '                    properties: {meow: {type: string}}',
    ];
    const thirdVariant = [
      '                  - type: object',
      '                    required: [tweet]',
      '                    properties: {tweet: {type: string}}',
    ];
    const mk = (variants) => [
      'openapi: 3.0.3',
      'info: {title: OneOf Demo, version: 1.0.0}',
      'paths:',
      '  /pet:',
      '    get:',
      '      responses:',
      "        '200':",
      '          description: ok',
      '          content:',
      '            application/json:',
      '              schema:',
      '                oneOf:',
      ...variants,
      '',
    ].join('\n');
    const base = normalizeSpec(parseSpec(mk(twoVariants), 'base.yaml'));
    const target = normalizeSpec(parseSpec(mk([...twoVariants, ...thirdVariant]), 'target.yaml'));
    const classified = classifyChanges(diffSpecs(base, target));
    expect(classified.additions.some((c) => c.type === 'SCHEMA_VARIANT_ADDED')).toBe(true);
    expect(classified.breakingChanges).toHaveLength(0);
  });

  test('discriminator change is breaking', () => {
    const base = normalizeSpec(parseSpec(fs.readFileSync(path.join(CORPUS, '04-discriminator.yaml'), 'utf8'), '04-discriminator.yaml'));
    const targetYaml = [
      'openapi: 3.0.3',
      'info: {title: Discriminator Demo, version: 2.0.0}',
      'paths:',
      '  /animal:',
      '    get:',
      '      responses:',
      "        '200':",
      '          description: ok',
      '          content:',
      '            application/json:',
      '              schema:',
      '                oneOf:',
      '                  - type: object',
      '                    required: [kind, wingspan]',
      '                    properties: {kind: {type: string}, wingspan: {type: integer}}',
      '                  - type: object',
      '                    required: [kind, depth]',
      '                    properties: {kind: {type: string}, depth: {type: integer}}',
      '                discriminator:',
      '                  propertyName: kind',
      '',
    ].join('\n');
    const target = normalizeSpec(parseSpec(targetYaml, 'target.yaml'));
    const classified = classifyChanges(diffSpecs(base, target));
    expect(classified.breakingChanges.some((c) => c.type === 'SCHEMA_DISCRIMINATOR_CHANGED')).toBe(true);
  });

  test('field removed inside an additionalProperties map value is breaking', () => {
    const base = normalizeSpec(parseSpec(fs.readFileSync(path.join(CORPUS, '05-additionalproperties.yaml'), 'utf8'), '05-additionalproperties.yaml'));
    const targetYaml = [
      'openapi: 3.0.3',
      'info: {title: AP Demo, version: 2.0.0}',
      'paths:',
      '  /metrics:',
      '    get:',
      '      responses:',
      "        '200':",
      '          description: ok',
      '          content:',
      '            application/json:',
      '              schema:',
      '                type: object',
      '                additionalProperties:',
      '                  type: object',
      '                  required: [unit]',
      '                  properties:',
      '                    unit: {type: string}',
      '',
    ].join('\n');
    const target = normalizeSpec(parseSpec(targetYaml, 'target.yaml'));
    const classified = classifyChanges(diffSpecs(base, target));
    const hitValue = classified.breakingChanges.some(
      (c) => /value/.test(c.field || '') && /REMOVED/.test(c.type || ''));
    expect(hitValue).toBe(true);
  });

  test('OpenAPI 3.1 null-union is normalized to nullable + base type', () => {
    const norm = normalizeSpec(parseSpec(fs.readFileSync(path.join(CORPUS, '06-openapi31-nullunion.yaml'), 'utf8'), '06.yaml'));
    const nickname = firstResponseSchema(norm).properties.nickname;
    expect(nickname.type).toBe('string'); // not the raw ['string','null'] array
    expect(nickname.nullable).toBe(true);
  });

  test('removing an enum value is breaking (parity with backend)', () => {
    const base = normalizeSpec(parseSpec(fs.readFileSync(path.join(CORPUS, '08-enum.yaml'), 'utf8'), '08-enum.yaml'));
    const targetYaml = [
      'openapi: 3.0.3',
      'info: {title: Enum Demo, version: 2.0.0}',
      'paths:',
      '  /accounts:',
      '    get:',
      '      responses:',
      "        '200':",
      '          description: ok',
      '          content:',
      '            application/json:',
      '              schema:',
      '                type: object',
      '                required: [status]',
      '                properties:',
      '                  status:',
      '                    type: string',
      '                    enum: [active, suspended]',
      '',
    ].join('\n');
    const target = normalizeSpec(parseSpec(targetYaml, 'target.yaml'));
    const classified = classifyChanges(diffSpecs(base, target));
    expect(classified.breakingChanges.some((c) => c.type === 'ENUM_VALUE_REMOVED')).toBe(true);
  });
});
