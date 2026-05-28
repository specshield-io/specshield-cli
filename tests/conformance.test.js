'use strict';

/**
 * Tests for the active spec-vs-production conformance engine
 * (`specshield bdct verify-provider` / Fix 3 of the BDCT fidelity roadmap).
 *
 * - Unit: validator (nullable + format + required + enum + type), path
 *   resolver (overrides win, spec-example fallback, missing), probeBuilder
 *   (safe-only by default, mutating opt-in), pickResponseSchema (exact /
 *   wildcard / default).
 * - Integration: spin up a tiny native http server, point the orchestrator
 *   at it with a fixture OAS, verify the structured report (pass / fail
 *   on enum violation / fail on missing required / skipped on unresolved
 *   param / fail on undocumented status / error on network failure).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const { validateBody, oasToJsonSchema } = require('../src/core/conformance/responseValidator');
const { substitute, collectSpecExamples, resolveProbePath, parsePathParamsArg }
  = require('../src/core/conformance/pathResolver');
const { buildProbes, pickResponseSchema, extractResponses }
  = require('../src/core/conformance/probeBuilder');
const { verifyProvider } = require('../src/core/conformance');

// ─── responseValidator ────────────────────────────────────────────────────────

describe('responseValidator.oasToJsonSchema', () => {
  test('drops OAS-only annotations', () => {
    const out = oasToJsonSchema({
      type: 'string', example: 'hi', xml: { name: 'x' },
      readOnly: true, deprecated: true,
    });
    expect(out).toEqual({ type: 'string' });
  });
  test('nullable: true widens the type', () => {
    expect(oasToJsonSchema({ type: 'string', nullable: true }).type).toEqual(['string', 'null']);
    // Nested
    const nested = oasToJsonSchema({
      type: 'object',
      properties: { x: { type: 'integer', nullable: true } },
    });
    expect(nested.properties.x.type).toEqual(['integer', 'null']);
  });
});

describe('responseValidator.validateBody', () => {
  const personSchema = {
    type: 'object',
    required: ['id', 'name'],
    properties: {
      id:    { type: 'string', format: 'uuid' },
      name:  { type: 'string' },
      age:   { type: 'integer' },
      email: { type: 'string', format: 'email', nullable: true },
      role:  { type: 'string', enum: ['admin', 'user'] },
    },
  };

  test('valid body → ok', () => {
    const r = validateBody({
      id: '550e8400-e29b-41d4-a716-446655440000', name: 'Alice',
      age: 30, email: 'a@b.com', role: 'admin',
    }, personSchema);
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
  });
  test('missing required field → fail with path', () => {
    const r = validateBody({ id: '550e8400-e29b-41d4-a716-446655440000' }, personSchema);
    expect(r.ok).toBe(false);
    expect(r.errors.some(e => /required.*name|must have required property 'name'/i.test(e.message))).toBe(true);
  });
  test('enum violation → fail', () => {
    const r = validateBody({
      id: '550e8400-e29b-41d4-a716-446655440000', name: 'a', role: 'partially_admin',
    }, personSchema);
    expect(r.ok).toBe(false);
    expect(r.errors.some(e => e.keyword === 'enum')).toBe(true);
  });
  test('type mismatch → fail', () => {
    const r = validateBody({
      id: '550e8400-e29b-41d4-a716-446655440000', name: 'a', age: 'thirty',
    }, personSchema);
    expect(r.ok).toBe(false);
    expect(r.errors.some(e => /age/.test(e.path) && /integer/i.test(e.message))).toBe(true);
  });
  test('nullable: true allows null', () => {
    const r = validateBody({
      id: '550e8400-e29b-41d4-a716-446655440000', name: 'a', email: null,
    }, personSchema);
    expect(r.ok).toBe(true);
  });
  test('format violation (bad uuid) → fail', () => {
    const r = validateBody({ id: 'not-a-uuid', name: 'a' }, personSchema);
    expect(r.ok).toBe(false);
    expect(r.errors.some(e => /uuid/i.test(e.message))).toBe(true);
  });
});

// ─── pathResolver ─────────────────────────────────────────────────────────────

describe('pathResolver.substitute', () => {
  test('substitutes resolved params and URL-encodes values', () => {
    expect(substitute('/users/{userId}/orders/{orderId}', { userId: 'u 1', orderId: 'o-7' }))
      .toEqual({ resolved: '/users/u%201/orders/o-7', missing: [] });
  });
  test('reports missing params', () => {
    expect(substitute('/users/{userId}/orders/{orderId}', { userId: 'u-1' }))
      .toEqual({ resolved: '/users/u-1/orders/{orderId}', missing: ['orderId'] });
  });
});

describe('pathResolver.collectSpecExamples + resolveProbePath', () => {
  const spec = {
    paths: {
      '/users/{userId}': {
        parameters: [{ name: 'userId', in: 'path', schema: { type: 'string' }, example: 'u-spec' }],
        get: { responses: { '200': {} } },
      },
      '/payments/{paymentId}': {
        get: {
          parameters: [{ name: 'paymentId', in: 'path', schema: { type: 'string' }, example: 'pay-123' }],
          responses: { '200': {} },
        },
      },
    },
  };
  test('uses spec example when no override', () => {
    const ex = collectSpecExamples(spec);
    expect(resolveProbePath('/users/{userId}', 'GET', ex, {}).resolved).toBe('/users/u-spec');
    expect(resolveProbePath('/payments/{paymentId}', 'GET', ex, {}).resolved).toBe('/payments/pay-123');
  });
  test('CLI override wins over spec example', () => {
    const ex = collectSpecExamples(spec);
    expect(resolveProbePath('/users/{userId}', 'GET', ex, { userId: 'u-cli' }).resolved).toBe('/users/u-cli');
  });
  test('parsePathParamsArg parses comma-separated kv pairs', () => {
    expect(parsePathParamsArg('userId=u-1,paymentId=pay-7'))
      .toEqual({ userId: 'u-1', paymentId: 'pay-7' });
    expect(parsePathParamsArg('')).toEqual({});
  });
});

// ─── probeBuilder ─────────────────────────────────────────────────────────────

describe('probeBuilder.buildProbes (safety default)', () => {
  const spec = {
    paths: {
      '/orders': {
        get:  { responses: { '200': { content: { 'application/json': { schema: { type: 'array' } } } } } },
        post: { responses: { '201': { content: { 'application/json': { schema: { type: 'object' } } } } } },
      },
      '/health': {
        get: { responses: { '200': { content: { 'application/json': { schema: { type: 'object' } } } } } },
      },
    },
  };
  test('by default probes only safe methods (GET/HEAD/OPTIONS)', () => {
    const probes = buildProbes(spec);
    expect(probes.map(p => `${p.method} ${p.routePath}`).sort()).toEqual([
      'GET /health', 'GET /orders',
    ]);
  });
  test('--include-mutating opts POST/PUT/PATCH/DELETE in', () => {
    const probes = buildProbes(spec, { includeMutating: true });
    expect(probes.map(p => `${p.method} ${p.routePath}`).sort())
      .toContain('POST /orders');
  });
  test('extractResponses pulls JSON schema per status code', () => {
    const responses = extractResponses({
      '200': { content: { 'application/json': { schema: { type: 'object' } } } },
      '404': { content: { 'application/json': { schema: { type: 'object' } } } },
      '500': { description: 'oops' },        // no schema
    });
    expect(responses['200'].type).toBe('object');
    expect(responses['404'].type).toBe('object');
    expect(responses['500']).toBeNull();      // documented status, no schema
  });
});

describe('probeBuilder.pickResponseSchema (status matching)', () => {
  const probe = { expectedResponses: {
    '200':     { type: 'object' },
    '4XX':     { type: 'object' },
    'default': { type: 'object' },
  }};
  test('exact match wins', () => {
    expect(pickResponseSchema(probe, 200)).toEqual({ type: 'object' });
  });
  test('wildcard match (4XX) for 404', () => {
    expect(pickResponseSchema(probe, 404)).toEqual({ type: 'object' });
  });
  test('falls back to default', () => {
    expect(pickResponseSchema(probe, 500)).toEqual({ type: 'object' });
  });
  test('undefined when no match (no default)', () => {
    expect(pickResponseSchema({ expectedResponses: { '200': null } }, 500))
      .toBeUndefined();
  });
});

// ─── End-to-end against a real http.Server ───────────────────────────────────

const PROVIDER_SPEC_YAML = `
openapi: 3.0.0
info: { title: Mock Payments, version: 1.0.0 }
paths:
  /health:
    get:
      responses:
        '200':
          content:
            application/json:
              schema:
                type: object
                required: [status]
                properties:
                  status: { type: string, enum: [ok, degraded] }
  /payments/{paymentId}:
    get:
      parameters:
        - name: paymentId
          in: path
          required: true
          schema: { type: string }
          example: pay-123
      responses:
        '200':
          content:
            application/json:
              schema:
                type: object
                required: [id, amount]
                properties:
                  id:       { type: string }
                  amount:   { type: number }
                  currency: { type: string, nullable: true }
  /orders:
    get:
      responses:
        '200':
          content:
            application/json:
              schema:
                type: array
                items:
                  type: object
                  required: [id]
                  properties:
                    id: { type: string }
  /unconfigured/{thingId}:
    get:
      parameters:
        - name: thingId
          in: path
          required: true
          schema: { type: string }   # no example → unresolved unless CLI override
      responses:
        '200':
          content:
            application/json:
              schema: { type: object }
`;

function writeSpec() {
  const file = path.join(os.tmpdir(), `spec-${Date.now()}.yaml`);
  fs.writeFileSync(file, PROVIDER_SPEC_YAML);
  return file;
}

/**
 * Spin a tiny http server with configurable per-path responses.
 * Each handler returns { status, body } (body is JSON-serialised).
 */
function startMockServer(handlers) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://localhost');
      const h = handlers[`${req.method} ${url.pathname}`];
      if (!h) { res.statusCode = 404; res.end(); return; }
      const out = h(req, url);
      res.statusCode = out.status;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(out.body));
    });
    server.listen(0, '127.0.0.1', () => resolve({
      server, baseUrl: `http://127.0.0.1:${server.address().port}`,
    }));
  });
}

describe('verifyProvider — end-to-end against a real http server', () => {
  let specPath;
  beforeAll(() => { specPath = writeSpec(); });
  afterAll(() => { try { fs.unlinkSync(specPath); } catch {} });

  test('happy path: all conforming responses → all PASS, /unconfigured SKIPPED', async () => {
    const { server, baseUrl } = await startMockServer({
      'GET /health':           () => ({ status: 200, body: { status: 'ok' } }),
      'GET /payments/pay-123': () => ({ status: 200, body: { id: 'pay-123', amount: 99.5 } }),
      'GET /orders':           () => ({ status: 200, body: [{ id: 'o-1' }, { id: 'o-2' }] }),
    });
    try {
      const { results, summary } = await verifyProvider({ spec: specPath, baseUrl });
      const byRoute = Object.fromEntries(results.map(r => [`${r.method} ${r.routePath}`, r]));
      expect(byRoute['GET /health'].status).toBe('PASS');
      expect(byRoute['GET /payments/{paymentId}'].status).toBe('PASS');
      expect(byRoute['GET /orders'].status).toBe('PASS');
      expect(byRoute['GET /unconfigured/{thingId}'].status).toBe('SKIPPED');
      expect(summary.pass).toBe(3);
      expect(summary.skipped).toBe(1);
      expect(summary.fail + summary.error).toBe(0);
    } finally { server.close(); }
  });

  test('enum violation: server returns a status not in spec enum → FAIL', async () => {
    const { server, baseUrl } = await startMockServer({
      'GET /health':           () => ({ status: 200, body: { status: 'partially_refunded' } }),
      'GET /payments/pay-123': () => ({ status: 200, body: { id: 'pay-123', amount: 1 } }),
      'GET /orders':           () => ({ status: 200, body: [] }),
    });
    try {
      const { results } = await verifyProvider({ spec: specPath, baseUrl });
      const health = results.find(r => r.routePath === '/health');
      expect(health.status).toBe('FAIL');
      expect(health.mismatches.some(m => m.keyword === 'enum')).toBe(true);
    } finally { server.close(); }
  });

  test('missing required field → FAIL with path pointing at the missing field', async () => {
    const { server, baseUrl } = await startMockServer({
      'GET /health':           () => ({ status: 200, body: { status: 'ok' } }),
      'GET /payments/pay-123': () => ({ status: 200, body: { id: 'pay-123' /* amount missing */ } }),
      'GET /orders':           () => ({ status: 200, body: [] }),
    });
    try {
      const { results } = await verifyProvider({ spec: specPath, baseUrl });
      const pay = results.find(r => r.routePath === '/payments/{paymentId}');
      expect(pay.status).toBe('FAIL');
      expect(pay.mismatches.some(m => /amount|required/i.test(m.message))).toBe(true);
    } finally { server.close(); }
  });

  test('undocumented status code → FAIL', async () => {
    const { server, baseUrl } = await startMockServer({
      'GET /health':           () => ({ status: 503, body: { status: 'ok' } }),  // 503 not in spec
      'GET /payments/pay-123': () => ({ status: 200, body: { id: 'pay-123', amount: 1 } }),
      'GET /orders':           () => ({ status: 200, body: [] }),
    });
    try {
      const { results } = await verifyProvider({ spec: specPath, baseUrl });
      const health = results.find(r => r.routePath === '/health');
      expect(health.status).toBe('FAIL');
      expect(health.reason).toMatch(/not documented/i);
      expect(health.httpStatus).toBe(503);
    } finally { server.close(); }
  });

  test('--path-params override resolves SKIPPED routes', async () => {
    const { server, baseUrl } = await startMockServer({
      'GET /health':              () => ({ status: 200, body: { status: 'ok' } }),
      'GET /payments/pay-123':    () => ({ status: 200, body: { id: 'pay-123', amount: 1 } }),
      'GET /orders':              () => ({ status: 200, body: [] }),
      'GET /unconfigured/thing-9':() => ({ status: 200, body: {} }),
    });
    try {
      const { results } = await verifyProvider({
        spec: specPath, baseUrl, pathParams: { thingId: 'thing-9' },
      });
      const u = results.find(r => r.routePath === '/unconfigured/{thingId}');
      expect(u.status).toBe('PASS');
      expect(u.resolvedPath).toBe('/unconfigured/thing-9');
    } finally { server.close(); }
  });

  test('network failure → ERROR result (does not throw, run continues)', async () => {
    // Closed port — connection refused.
    const baseUrl = 'http://127.0.0.1:1';  // reserved, will refuse
    const { results, summary } = await verifyProvider({
      spec: specPath, baseUrl, timeoutMs: 500,
    });
    // GET /unconfigured/{thingId} is still SKIPPED (no example, no override).
    // Every other probe should be ERROR (refused / timeout).
    const errors = results.filter(r => r.status === 'ERROR');
    const skipped = results.filter(r => r.status === 'SKIPPED');
    expect(errors.length).toBeGreaterThanOrEqual(2);
    expect(skipped.length).toBeGreaterThanOrEqual(1);
    expect(summary.pass).toBe(0);
    // Every error result must carry the error message — never undefined.
    for (const e of errors) expect(typeof e.error).toBe('string');
  });

  test('mutating opt-in: --include-mutating exposes POST/PUT/PATCH/DELETE', async () => {
    // The fixture spec has no mutating ops, but the probe count should match
    // either way. Re-prove the flag wiring via probeBuilder + a tiny spec.
    const { buildProbes } = require('../src/core/conformance/probeBuilder');
    const tinySpec = { paths: {
      '/x': { post: { responses: { '201': {} } } },
    }};
    expect(buildProbes(tinySpec)).toEqual([]);
    expect(buildProbes(tinySpec, { includeMutating: true }).length).toBe(1);
  });
});
