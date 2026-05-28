'use strict';

/**
 * Unit + integration tests for the HAR-ingest capture pipeline
 * (`specshield bdct capture from-har`). Covers the four core modules
 * (path templating, schema inference, HAR parsing, OpenAPI emission)
 * plus an end-to-end run with a fixture HAR.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const yaml = require('js-yaml');

const { templatePath, isDynamicSegment } = require('../src/core/har/pathTemplate');
const { inferSchema, mergeSchemas }      = require('../src/core/har/schemaInfer');
const { readHarFile, normaliseEntries }  = require('../src/core/har/parseHar');
const { harToOpenapi }                   = require('../src/core/har/emitOpenapi');
const { captureFromHarFile }             = require('../src/core/har');

// ─── pathTemplate ─────────────────────────────────────────────────────────────

describe('pathTemplate.isDynamicSegment', () => {
  test('all-digits → dynamic', () => {
    expect(isDynamicSegment('123')).toBe(true);
    expect(isDynamicSegment('1')).toBe(true);
  });
  test('UUID → dynamic', () => {
    expect(isDynamicSegment('550e8400-e29b-41d4-a716-446655440000')).toBe(true);
  });
  test('hex-only ≥8 → dynamic (mongo-style)', () => {
    expect(isDynamicSegment('9a3f7c1b')).toBe(true);
    expect(isDynamicSegment('507f1f77bcf86cd799439011')).toBe(true);
  });
  test('digits + hyphen/underscore → dynamic', () => {
    expect(isDynamicSegment('PAY-2026-001')).toBe(true);
    expect(isDynamicSegment('order_42')).toBe(true);
  });
  test('pure-alpha → static (NOT dynamic)', () => {
    expect(isDynamicSegment('users')).toBe(false);
    expect(isDynamicSegment('summary')).toBe(false);
    expect(isDynamicSegment('profile')).toBe(false);
  });
  test('hex shorter than 8 chars → static', () => {
    expect(isDynamicSegment('abcdef')).toBe(false);   // 6 hex chars; could be a word
  });
});

describe('pathTemplate.templatePath', () => {
  test('templatises a single numeric segment, names from preceding noun', () => {
    expect(templatePath('/users/123')).toEqual({
      templated: '/users/{userId}', paramNames: ['userId'],
    });
  });
  test('keeps pure-alpha endpoints literal (no over-templating)', () => {
    expect(templatePath('/users/profile')).toEqual({
      templated: '/users/profile', paramNames: [],
    });
  });
  test('handles multiple params with context-aware names', () => {
    const r = templatePath('/users/123/orders/abc-2026');
    expect(r.templated).toBe('/users/{userId}/orders/{orderId}');
    expect(r.paramNames).toEqual(['userId', 'orderId']);
  });
  test('UUID and mongo-id both become {…Id}', () => {
    expect(templatePath('/payments/550e8400-e29b-41d4-a716-446655440000').templated)
      .toBe('/payments/{paymentId}');
    expect(templatePath('/sessions/507f1f77bcf86cd799439011').templated)
      .toBe('/sessions/{sessionId}');
  });
  test('strips a trailing query string defensively', () => {
    expect(templatePath('/users/123?limit=10').templated).toBe('/users/{userId}');
  });
  test('empty / "/" inputs are safe', () => {
    expect(templatePath('').templated).toBe('/');
    expect(templatePath('/').templated).toBe('/');
  });
  test('singularisation skips "ss" words (address ≠ addres)', () => {
    expect(templatePath('/address/123').templated).toBe('/address/{addressId}');
  });
  test('respects custom dynamicPatterns', () => {
    const r = templatePath('/regions/north-east-1', { dynamicPatterns: [/^[a-z-]+\d+$/] });
    expect(r.templated).toBe('/regions/{regionId}');
  });
});

// ─── schemaInfer ──────────────────────────────────────────────────────────────

describe('schemaInfer.inferSchema', () => {
  test('primitives', () => {
    expect(inferSchema('hi')).toEqual({ type: 'string' });
    expect(inferSchema(42)).toEqual({ type: 'integer' });
    expect(inferSchema(3.14)).toEqual({ type: 'number' });
    expect(inferSchema(true)).toEqual({ type: 'boolean' });
    expect(inferSchema(null)).toEqual({ type: 'null' });
  });
  test('detects uuid / date-time / email formats', () => {
    expect(inferSchema('550e8400-e29b-41d4-a716-446655440000'))
      .toEqual({ type: 'string', format: 'uuid' });
    expect(inferSchema('2026-05-28T12:34:56Z'))
      .toEqual({ type: 'string', format: 'date-time' });
    expect(inferSchema('a@b.com'))
      .toEqual({ type: 'string', format: 'email' });
  });
  test('object: required = present non-null keys', () => {
    const s = inferSchema({ id: 'x', amount: 1, note: null });
    expect(s.type).toBe('object');
    expect(s.properties.id.type).toBe('string');
    expect(s.properties.amount.type).toBe('integer');
    expect(s.properties.note).toEqual({ type: 'null' });
    expect(s.required).toEqual(['id', 'amount']);
  });
  test('array merges item shapes across elements', () => {
    const s = inferSchema([{ id: 1 }, { id: 2, name: 'x' }]);
    expect(s.type).toBe('array');
    expect(s.items.type).toBe('object');
    expect(s.items.properties.id.type).toBe('integer');
    expect(s.items.properties.name.type).toBe('string');
    // `id` present in both, `name` only in one → required = [id]
    expect(s.items.required).toEqual(['id']);
  });
});

describe('schemaInfer.mergeSchemas', () => {
  test('object: required = intersection across samples', () => {
    const a = inferSchema({ id: 'x', amount: 1, currency: 'USD' });
    const b = inferSchema({ id: 'y', amount: 2 });
    const m = mergeSchemas(a, b);
    expect(m.required.sort()).toEqual(['amount', 'id']);
    expect(m.properties.currency).toBeDefined();   // optional now
  });
  test('integer + number → number (numeric widening)', () => {
    expect(mergeSchemas({ type: 'integer' }, { type: 'number' })).toEqual({ type: 'number' });
    expect(mergeSchemas({ type: 'number' }, { type: 'integer' })).toEqual({ type: 'number' });
  });
  test('type conflict (string vs integer) → string (most permissive)', () => {
    expect(mergeSchemas({ type: 'string' }, { type: 'integer' })).toEqual({ type: 'string' });
  });
  test('format kept only when both samples agree', () => {
    const a = { type: 'string', format: 'uuid' };
    const b = { type: 'string', format: 'uuid' };
    expect(mergeSchemas(a, b)).toEqual({ type: 'string', format: 'uuid' });
    const c = { type: 'string', format: 'email' };
    expect(mergeSchemas(a, c)).toEqual({ type: 'string' });
  });
  test('null is absorbed into the other side', () => {
    expect(mergeSchemas({ type: 'null' }, { type: 'string' })).toEqual({ type: 'string' });
  });
});

// ─── parseHar.normaliseEntries ────────────────────────────────────────────────

const HAR_FIXTURE = {
  log: {
    version: '1.2',
    entries: [
      {
        request: {
          method: 'GET',
          url: 'https://api.acme.com/v1/payments/pay-123',
          headers: [],
        },
        response: {
          status: 200,
          headers: [],
          content: { mimeType: 'application/json', text: '{"id":"pay-123","amount":99.5}' },
        },
      },
      {
        request: {
          method: 'GET',
          url: 'https://api.acme.com/v1/payments/pay-456',
          headers: [],
        },
        response: {
          status: 200,
          headers: [],
          content: { mimeType: 'application/json', text: '{"id":"pay-456","amount":12.0,"currency":"USD"}' },
        },
      },
      {
        request: {
          method: 'POST',
          url: 'https://api.acme.com/v1/payments',
          headers: [{ name: 'Content-Type', value: 'application/json' }],
          postData: { mimeType: 'application/json', text: '{"amount":1.0,"currency":"USD"}' },
        },
        response: {
          status: 201,
          headers: [],
          content: { mimeType: 'application/json', text: '{"id":"pay-789","amount":1.0,"currency":"USD"}' },
        },
      },
      {
        // off-base-url entry — must be filtered out when --base-url is set
        request: { method: 'GET', url: 'https://cdn.example.com/asset.png', headers: [] },
        response: {
          status: 200,
          headers: [],
          content: { mimeType: 'image/png', size: 1234, text: '' },
        },
      },
      {
        // non-JSON body on a matching host — dropped by onlyJson default
        request: { method: 'GET', url: 'https://api.acme.com/v1/docs', headers: [] },
        response: {
          status: 200,
          headers: [],
          content: { mimeType: 'text/html', text: '<html>...</html>' },
        },
      },
    ],
  },
};

function writeFixture(obj) {
  const file = path.join(os.tmpdir(), `harfix-${Date.now()}-${Math.random().toString(36).slice(2)}.har`);
  fs.writeFileSync(file, JSON.stringify(obj));
  return file;
}

describe('parseHar.normaliseEntries', () => {
  test('filters by base-url (host + optional path prefix)', () => {
    const recs = normaliseEntries(HAR_FIXTURE, { baseUrl: 'https://api.acme.com/v1' });
    // CDN entry off-host → dropped; HTML entry on-host non-JSON → dropped; the 3 JSON entries remain.
    expect(recs.map(r => `${r.method} ${r.path}`)).toEqual([
      'GET /v1/payments/pay-123',
      'GET /v1/payments/pay-456',
      'POST /v1/payments',
    ]);
  });
  test('filters by method allow-list', () => {
    const recs = normaliseEntries(HAR_FIXTURE, {
      baseUrl: 'https://api.acme.com', methods: ['POST'],
    });
    expect(recs.map(r => r.method)).toEqual(['POST']);
  });
  test('parses request/response JSON bodies', () => {
    const recs = normaliseEntries(HAR_FIXTURE, { baseUrl: 'https://api.acme.com' });
    const post = recs.find(r => r.method === 'POST');
    expect(post.requestBody).toEqual({ amount: 1.0, currency: 'USD' });
    expect(post.responseBody.id).toBe('pay-789');
    expect(post.responseStatus).toBe(201);
  });
});

describe('parseHar.readHarFile', () => {
  test('throws a clear error on invalid JSON', () => {
    const bad = path.join(os.tmpdir(), `bad-${Date.now()}.har`);
    fs.writeFileSync(bad, '{not valid json');
    expect(() => readHarFile(bad)).toThrow(/Not valid HAR JSON/);
  });
  test('throws a clear error on non-HAR JSON', () => {
    const bad = writeFixture({ hello: 'world' });
    expect(() => readHarFile(bad)).toThrow(/Not a HAR file/);
  });
});

// ─── emitOpenapi.harToOpenapi (the heart of the pipeline) ─────────────────────

describe('harToOpenapi (group + emit)', () => {
  test('groups concrete paths under one templated path, merges response shapes', () => {
    const recs = normaliseEntries(HAR_FIXTURE, { baseUrl: 'https://api.acme.com' });
    const doc = harToOpenapi(recs);

    expect(doc.openapi).toBe('3.0.0');
    expect(doc.paths['/v1/payments/{paymentId}']).toBeDefined();
    expect(doc.paths['/v1/payments']).toBeDefined();

    // Two GET samples under /payments/{paymentId} — `id`+`amount` in both,
    // `currency` in only one → required = [id, amount]; currency optional.
    const getOp = doc.paths['/v1/payments/{paymentId}'].get;
    const schema = getOp.responses['200'].content['application/json'].schema;
    expect(schema.type).toBe('object');
    expect(schema.required.sort()).toEqual(['amount', 'id']);
    expect(schema.properties.currency).toBeDefined();

    // Path parameter declared
    expect(getOp.parameters).toEqual([
      { name: 'paymentId', in: 'path', required: true, schema: { type: 'string' } },
    ]);

    // POST has both requestBody + 201 response with body
    const postOp = doc.paths['/v1/payments'].post;
    expect(postOp.requestBody.content['application/json'].schema.type).toBe('object');
    expect(postOp.responses['201']).toBeDefined();
  });

  test('sets servers[] when baseUrl provided', () => {
    const recs = normaliseEntries(HAR_FIXTURE, { baseUrl: 'https://api.acme.com' });
    const doc = harToOpenapi(recs, { baseUrl: 'https://api.acme.com' });
    expect(doc.servers).toEqual([{ url: 'https://api.acme.com' }]);
  });

  test('emits a stub 200 response if no responses were captured for an op', () => {
    const recs = [{ method: 'GET', path: '/health', responseStatus: 0 }];
    const doc = harToOpenapi(recs);
    expect(doc.paths['/health'].get.responses['200'].description).toBe('OK');
  });
});

// ─── End-to-end orchestrator ─────────────────────────────────────────────────

describe('captureFromHarFile (end-to-end)', () => {
  test('produces parseable YAML with the expected shape + summary', () => {
    const harPath = writeFixture(HAR_FIXTURE);
    const { text, doc, summary } = captureFromHarFile(harPath, {
      baseUrl: 'https://api.acme.com',
      title: 'Checkout consumer of Payments',
      version: '0.1.0',
    });

    expect(summary).toEqual({
      harEntries: 5,
      recordsKept: 3,            // 2 GET + 1 POST (CDN + HTML dropped)
      endpoints: 2,              // /v1/payments + /v1/payments/{paymentId}
      operations: 2,             // one GET, one POST
    });

    expect(typeof text).toBe('string');
    expect(text.length).toBeGreaterThan(0);
    const parsed = yaml.load(text);
    expect(parsed).toEqual(doc);
    expect(parsed.info.title).toBe('Checkout consumer of Payments');
  });

  test('--format json produces parseable JSON', () => {
    const harPath = writeFixture(HAR_FIXTURE);
    const { text } = captureFromHarFile(harPath, {
      baseUrl: 'https://api.acme.com',
      format: 'json',
    });
    const parsed = JSON.parse(text);
    expect(parsed.openapi).toBe('3.0.0');
  });
});
