'use strict';

const { classifyChanges } = require('../src/core/classifyChanges');

describe('classifyChanges', () => {

  // ─── Basic bucketing ─────────────────────────────────────────────────────

  test('buckets a removed endpoint as breaking', () => {
    const result = classifyChanges([
      { type: 'ENDPOINT_REMOVED', path: '/users/{id}', method: 'delete',
        description: 'DELETE /users/{id} was removed' },
    ]);
    expect(result.breakingChanges).toHaveLength(1);
    expect(result.additions).toHaveLength(0);
    expect(result.breakingChanges[0].severity).toBe('error');
  });

  test('buckets an added endpoint as an addition', () => {
    const result = classifyChanges([
      { type: 'ENDPOINT_ADDED', path: '/users/{id}/audit-log', method: 'get',
        description: 'GET /users/{id}/audit-log was added' },
    ]);
    expect(result.additions).toHaveLength(1);
    expect(result.breakingChanges).toHaveLength(0);
    expect(result.additions[0].severity).toBe('info');
  });

  test('buckets a field that became optional as a modification', () => {
    const result = classifyChanges([
      { type: 'FIELD_BECAME_OPTIONAL', path: '/x', method: 'post',
        field: 'requestBody.foo',
        description: 'Field "foo" became optional in POST /x' },
    ]);
    expect(result.modifications).toHaveLength(1);
    expect(result.modifications[0].severity).toBe('warning');
  });

  test('treats unknown types as modifications (defensive)', () => {
    const result = classifyChanges([
      { type: 'UNKNOWN_TYPE_FROM_FUTURE', description: '?' },
    ]);
    expect(result.modifications).toHaveLength(1);
    expect(result.modifications[0].severity).toBe('warning');
  });

  // ─── F1 regression — dedupe of $ref-driven multi-counted changes ─────────
  // A schema component change (e.g. removing User.legacy_id) shows up once
  // per endpoint that references the component. The dedupe pass collapses
  // those entries into one with an `affectedEndpoints` array.

  test('collapses RESPONSE_FIELD_REMOVED that hit 4 endpoints into one entry', () => {
    const diffs = [
      { type: 'RESPONSE_FIELD_REMOVED', path: '/users',      method: 'get',   field: 'responses.200.data[items].legacy_id', description: 'x' },
      { type: 'RESPONSE_FIELD_REMOVED', path: '/users',      method: 'post',  field: 'responses.201.legacy_id',              description: 'x' },
      { type: 'RESPONSE_FIELD_REMOVED', path: '/users/{id}', method: 'get',   field: 'responses.200.legacy_id',              description: 'x' },
      { type: 'RESPONSE_FIELD_REMOVED', path: '/users/{id}', method: 'patch', field: 'responses.200.legacy_id',              description: 'x' },
    ];
    const result = classifyChanges(diffs);
    expect(result.breakingChanges).toHaveLength(1);
    const merged = result.breakingChanges[0];
    expect(merged.affectedEndpoints).toEqual([
      'GET /users',
      'POST /users',
      'GET /users/{id}',
      'PATCH /users/{id}',
    ]);
    // Collapsed entries shed their path/method since they apply to many.
    expect(merged.path).toBeNull();
    expect(merged.method).toBeNull();
    // Description is rewritten with the leaf field name + endpoint count.
    expect(merged.description).toContain('"legacy_id"');
    expect(merged.description).toContain('4 endpoints');
  });

  test('collapses RESPONSE_FIELD_ADDED similarly (additions also dedupe)', () => {
    const diffs = [
      { type: 'RESPONSE_FIELD_ADDED', path: '/users',      method: 'get',   field: 'responses.200.data[items].last_login_at', description: 'x' },
      { type: 'RESPONSE_FIELD_ADDED', path: '/users/{id}', method: 'get',   field: 'responses.200.last_login_at',              description: 'x' },
    ];
    const result = classifyChanges(diffs);
    expect(result.additions).toHaveLength(1);
    expect(result.additions[0].affectedEndpoints).toEqual([
      'GET /users',
      'GET /users/{id}',
    ]);
  });

  test('does NOT collapse changes with the same type but different leaf field', () => {
    const diffs = [
      { type: 'RESPONSE_FIELD_REMOVED', path: '/users', method: 'get', field: 'responses.200.legacy_id', description: 'x' },
      { type: 'RESPONSE_FIELD_REMOVED', path: '/users', method: 'get', field: 'responses.200.email',     description: 'x' },
    ];
    const result = classifyChanges(diffs);
    // Two distinct leaf names — must remain two entries.
    expect(result.breakingChanges).toHaveLength(2);
  });

  test('single-occurrence field changes are NOT collapsed (canonical entry preserved)', () => {
    const diffs = [
      { type: 'RESPONSE_FIELD_REMOVED', path: '/users', method: 'get', field: 'responses.200.solo', description: 'specific to one endpoint' },
    ];
    const result = classifyChanges(diffs);
    expect(result.breakingChanges).toHaveLength(1);
    // Description and path/method are preserved as-is for single occurrences.
    expect(result.breakingChanges[0].description).toBe('specific to one endpoint');
    expect(result.breakingChanges[0].path).toBe('/users');
    expect(result.breakingChanges[0].method).toBe('get');
    expect(result.breakingChanges[0].affectedEndpoints).toBeUndefined();
  });

  test('non-field types are passed through untouched (ENDPOINT_REMOVED, METHOD_REMOVED, SCHEMA_*)', () => {
    const diffs = [
      { type: 'ENDPOINT_REMOVED', path: '/a', method: 'get',  description: 'GET /a removed' },
      { type: 'METHOD_REMOVED',   path: '/b', method: 'post', description: 'POST /b removed' },
      { type: 'SCHEMA_REMOVED',                                field: 'components.schemas.X', description: 'Schema X removed' },
    ];
    const result = classifyChanges(diffs);
    expect(result.breakingChanges).toHaveLength(3);
    // None should have affectedEndpoints; they're already at the right granularity.
    result.breakingChanges.forEach(c => expect(c.affectedEndpoints).toBeUndefined());
  });

  test('mixed input: deduped field changes + passthrough endpoint changes all appear', () => {
    // Realistic post-engine output: 4 multi-counted field removals + 1 method
    // removal + 1 required-field change. Should collapse the 4 into 1, leave
    // the other two alone — total 3 breaking changes.
    const diffs = [
      { type: 'RESPONSE_FIELD_REMOVED', path: '/users',      method: 'get',   field: 'responses.200.legacy_id', description: '' },
      { type: 'RESPONSE_FIELD_REMOVED', path: '/users',      method: 'post',  field: 'responses.201.legacy_id', description: '' },
      { type: 'RESPONSE_FIELD_REMOVED', path: '/users/{id}', method: 'get',   field: 'responses.200.legacy_id', description: '' },
      { type: 'RESPONSE_FIELD_REMOVED', path: '/users/{id}', method: 'patch', field: 'responses.200.legacy_id', description: '' },
      { type: 'METHOD_REMOVED',         path: '/users/{id}', method: 'delete', description: 'DELETE removed' },
      { type: 'FIELD_BECAME_REQUIRED',  path: '/users',      method: 'post',  field: 'requestBody.email',       description: 'email required' },
    ];
    const result = classifyChanges(diffs);
    expect(result.breakingChanges).toHaveLength(3);
  });
});
