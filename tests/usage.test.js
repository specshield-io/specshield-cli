'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { execFileSync, spawnSync } = require('child_process');

const {
  parseCombined, parseAlb, parseJsonLine, detectFormat, queryParamNames, splitTarget,
} = require('../src/core/usage/logParsers');
const { parseClientSpec, clientIdOf, normalizeUserAgent } = require('../src/core/usage/clientIdentity');
const { createRouteMatcher } = require('../src/core/usage/routeMatcher');
const { UsageAggregator, validateUsage, parseDuration } = require('../src/core/usage/usageStore');
const { importLogFile } = require('../src/core/usage/importLogs');
const { applyUsageImpact, compileClientPatterns } = require('../src/core/usage/impact');
const { normalizeSpec } = require('../src/core/normalizeSpec');
const { formatHuman, formatJson } = require('../src/core/outputFormatter');

const DAY = 86400e3;
const NOW = Date.parse('2026-10-25T12:00:00Z');

const SPEC = {
  openapi: '3.0.3',
  info: { title: 'Shop', version: '1' },
  servers: [{ url: 'https://api.shop.example/{ver}', variables: { ver: { default: 'v1' } } }],
  paths: {
    '/orders': {
      get: {
        parameters: [
          { name: 'status', in: 'query', schema: { type: 'string' } },
          { name: 'expand', in: 'query', schema: { type: 'string' } },
          { name: 'X-Tenant', in: 'header', schema: { type: 'string' } },
        ],
        responses: { 200: { description: 'ok' } },
      },
    },
    '/orders/{orderId}': { get: { responses: { 200: { description: 'ok' } } } },
    '/orders/{orderId}/receipt': {
      get: { responses: { 200: { description: 'ok' } } },
      delete: { responses: { 204: { description: 'gone' } } },
    },
    '/files/{name}.json': { get: { responses: { 200: { description: 'ok' } } } },
    '/legacy-report': { get: { responses: { 200: { description: 'ok' } } } },
    '/users/me': { get: { responses: { 200: { description: 'ok' } } } },
    '/users/{id}': { get: { responses: { 200: { description: 'ok' } } } },
  },
};

const clf = (t) => {
  const M = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const d = new Date(t);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getUTCDate())}/${M[d.getUTCMonth()]}/${d.getUTCFullYear()}:${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} +0000`;
};
const nginxLine = (t, method, url, status, ua, extra = '') =>
  `203.0.113.9 - - [${clf(t)}] "${method} ${url} HTTP/1.1" ${status} 512 "-" "${ua}"${extra}`;

// ─── Parsers ────────────────────────────────────────────────────────────────

describe('log parsers', () => {
  test('combined: method, path, query, status, time, UA and trailing extras', () => {
    const r = parseCombined(nginxLine(Date.parse('2026-10-10T13:55:36Z'), 'GET', '/v1/orders?status=open&expand=items', 200, 'okhttp/4.12.0', ' "key-123" "-"'));
    expect(r).toMatchObject({ method: 'GET', path: '/v1/orders', query: 'status=open&expand=items', status: 200, userAgent: 'okhttp/4.12.0', extras: ['key-123', null] });
    expect(r.time).toBe(Date.parse('2026-10-10T13:55:36Z'));
  });

  test('combined: honours the timezone offset', () => {
    const r = parseCombined('1.2.3.4 - - [10/Oct/2026:19:25:36 +0530] "GET / HTTP/1.1" 200 1');
    expect(new Date(r.time).toISOString()).toBe('2026-10-10T13:55:36.000Z');
  });

  test('common log format (no referer/UA) still parses', () => {
    const r = parseCombined('1.2.3.4 - frank [10/Oct/2026:13:55:36 +0000] "DELETE /a/b/ HTTP/1.0" 204 -');
    expect(r).toMatchObject({ method: 'DELETE', path: '/a/b', userAgent: null, status: 204 });
  });

  test('combined: rejects malformed request lines', () => {
    expect(parseCombined('1.2.3.4 - - [10/Oct/2026:13:55:36 +0000] "\\x16\\x03" 400 0 "-" "-"')).toBeNull();
    expect(parseCombined('not a log line')).toBeNull();
  });

  test('ALB: absolute request URL is reduced to path + query', () => {
    const line = 'https 2026-10-20T10:00:00.123456Z app/shop/abc 198.51.100.7:4433 10.0.0.1:80 0.001 0.002 0.000 201 201 300 900 "POST https://api.shop.example:443/v1/orders?dry=1 HTTP/1.1" "acme/1.0" ECDHE TLSv1.2 arn "Root=1" "api" "cert" 0 2026-10-20T10:00:00Z "forward" "-" "-" "10.0.0.1:80" "201" "-" "-"';
    expect(parseAlb(line)).toMatchObject({ method: 'POST', path: '/v1/orders', query: 'dry=1', status: 201, userAgent: 'acme/1.0' });
  });

  test('JSON: nginx $request string, Kong nested fields, API Gateway keys', () => {
    expect(parseJsonLine(JSON.stringify({ time_local: '10/Oct/2026:13:55:36 +0000', request: 'GET /x?y=1 HTTP/1.1', status: '200', http_user_agent: 'a/1' })))
      .toMatchObject({ method: 'GET', path: '/x', query: 'y=1', status: 200, userAgent: 'a/1' });
    expect(parseJsonLine(JSON.stringify({ started_at: 1760000000000, request: { method: 'get', uri: '/k/1', headers: { 'user-agent': 'k/2' } }, response: { status: 404 } })))
      .toMatchObject({ method: 'GET', path: '/k/1', status: 404, userAgent: 'k/2', time: 1760000000000 });
    expect(parseJsonLine(JSON.stringify({ httpMethod: 'PUT', path: '/prod/items/9', status: 200, requestTimeEpoch: 1760000000 })))
      .toMatchObject({ method: 'PUT', path: '/prod/items/9', time: 1760000000000 });
    expect(parseJsonLine('{"message":"started"}')).toBeNull();
    expect(parseJsonLine('{broken')).toBeNull();
  });

  test('detectFormat picks the parser that understands the sample', () => {
    expect(detectFormat([nginxLine(NOW, 'GET', '/', 200, 'a/1')])).toBe('combined');
    expect(detectFormat(['{"method":"GET","path":"/"}'])).toBe('json');
    expect(detectFormat(['hello world'])).toBeNull();
  });

  test('query: keeps parameter names only, never values', () => {
    expect(queryParamNames('status=open&tags[]=a&tags[]=b&token=SECRET&&flag')).toEqual(['status', 'tags', 'token', 'flag']);
  });

  test('splitTarget normalises slashes and drops fragments', () => {
    expect(splitTarget('//a//b/?q=1#frag')).toEqual({ path: '/a/b', query: 'q=1', host: null });
    expect(splitTarget('https://API.x.io:8443/a?b')).toEqual({ path: '/a', query: 'b', host: 'api.x.io' });
    expect(splitTarget('*')).toEqual({ path: null, query: '', host: null });
  });
});

// ─── Client identity ────────────────────────────────────────────────────────

describe('client identity', () => {
  test('UA is reduced to product/major.minor; browsers collapse', () => {
    expect(normalizeUserAgent('MyShop-iOS/5.2.1 CFNetwork/1410 Darwin/22.6')).toBe('MyShop-iOS/5.2');
    expect(normalizeUserAgent('okhttp/4')).toBe('okhttp/4');
    expect(normalizeUserAgent('Mozilla/5.0 (Windows NT 10.0) Chrome/122')).toBe('browser');
    expect(normalizeUserAgent('')).toBeNull();
  });

  test('field:, extra: and hash: sources', () => {
    const rec = { userAgent: null, extras: ['key-123'], json: { consumer: { username: 'acme' }, h: { k: 'secret' } } };
    expect(clientIdOf(rec, parseClientSpec('field:consumer.username'))).toBe('acme');
    expect(clientIdOf(rec, parseClientSpec('extra:1'))).toBe('key-123');
    const hashed = clientIdOf(rec, parseClientSpec('hash:field:h.k'));
    expect(hashed).toMatch(/^hash:[0-9a-f]{12}$/);
    expect(hashed).not.toContain('secret');
    expect(clientIdOf(rec, parseClientSpec('ua'))).toBe('unknown');
  });

  test('rejects an unknown --client source', () => {
    expect(() => parseClientSpec('ip')).toThrow(/Invalid --client/);
    expect(() => parseClientSpec('extra:0')).toThrow(/Invalid --client/);
  });
});

// ─── Route matching ─────────────────────────────────────────────────────────

describe('route matcher', () => {
  const m = createRouteMatcher(SPEC);

  test('strips the server base path (with variables resolved)', () => {
    expect(m.basePaths).toEqual(['/v1']);
    expect(m.match('GET', '/v1/orders/42/receipt')).toEqual({ template: '/orders/{orderId}/receipt', method: 'GET', operation: true });
    expect(m.match('GET', '/orders/42')).toMatchObject({ template: '/orders/{orderId}' });
  });

  test('literal segments beat parameters (/users/me vs /users/{id})', () => {
    expect(m.match('GET', '/v1/users/me').template).toBe('/users/me');
    expect(m.match('GET', '/v1/users/7').template).toBe('/users/{id}');
  });

  test('path exists but method does not → operation=false', () => {
    expect(m.match('POST', '/v1/users/7')).toMatchObject({ template: '/users/{id}', operation: false });
    expect(m.match('GET', '/v1/nope')).toBeNull();
  });

  test('partial-parameter segments and already-templated paths', () => {
    expect(m.match('GET', '/v1/files/report.json').template).toBe('/files/{name}.json');
    expect(m.match('GET', '/v1/orders/{orderId}/receipt').template).toBe('/orders/{orderId}/receipt');
    expect(m.match('GET', '/v1/users/{userId}').template).toBe('/users/{id}');
  });

  test('Swagger 2 basePath and an explicit --base-path', () => {
    const sw = createRouteMatcher({ swagger: '2.0', basePath: '/api/', paths: { '/a': { get: {} } } });
    expect(sw.match('GET', '/api/a')).toMatchObject({ template: '/a', operation: true });
    const ex = createRouteMatcher({ paths: { '/a': { get: {} } } }, { basePath: '/gw/v2' });
    expect(ex.match('GET', '/gw/v2/a')).toMatchObject({ template: '/a' });
  });
});

// ─── Aggregation ────────────────────────────────────────────────────────────

function rec(method, url, { ua = 'app/1.0', status = 200, time = NOW - DAY } = {}) {
  const { path: p, query } = splitTarget(url);
  return { method, path: p, query, status, time, userAgent: ua, extras: [], json: null };
}

describe('usage aggregation', () => {
  test('maps to spec templates, keeps no concrete IDs or query values', () => {
    const agg = new UsageAggregator({ clientSpec: parseClientSpec('ua'), matcher: createRouteMatcher(SPEC) });
    agg.add(rec('GET', '/v1/orders/1001?token=SECRET'));
    agg.add(rec('GET', '/v1/orders/1002', { ua: 'other/2.0.1' }));
    agg.add(rec('GET', '/v1/internal/9'));                       // undocumented
    agg.add(rec('POST', '/wp-login.php', { status: 404 }));       // scanner
    const out = agg.toJSON({ generator: 't', client: 'ua', sources: [] });
    const json = JSON.stringify(out);
    expect(json).not.toMatch(/1001|1002|SECRET/);
    expect(out.endpoints[0]).toMatchObject({ method: 'GET', path: '/orders/{orderId}', matched: true, calls: 2 });
    expect(out.endpoints[0].clients[0].params).toEqual({ token: 1 });
    expect(out.endpoints.find((e) => !e.matched).path).toBe('/v1/internal/{internalId}');
    expect(out.stats).toMatchObject({ requests: 3, matched: 2, unmatched: 1, notFound: 1 });
    expect(() => validateUsage(out)).not.toThrow();
  });

  test('--since drops older records; absorb() merges counts and windows', () => {
    const spec = parseClientSpec('ua');
    const a = new UsageAggregator({ clientSpec: spec, sinceMs: NOW - 2 * DAY });
    a.add(rec('GET', '/x?q=1', { time: NOW - 5 * DAY }));
    a.add(rec('GET', '/x?q=1', { time: NOW - DAY }));
    expect(a.stats.tooOld).toBe(1);
    const first = a.toJSON({ generator: 't', client: 'ua', sources: [] });

    const b = new UsageAggregator({ clientSpec: spec });
    b.add(rec('GET', '/x?q=1', { time: NOW - 10 * DAY }));
    b.absorb(first);
    const merged = b.toJSON({ generator: 't', client: 'ua', sources: [] });
    expect(merged.endpoints[0].calls).toBe(2);
    expect(merged.endpoints[0].clients[0].params).toEqual({ q: 2 });
    expect(merged.window.from).toBe(new Date(NOW - 10 * DAY).toISOString());
  });

  test('validateUsage rejects foreign or future files', () => {
    expect(() => validateUsage({ foo: 1 })).toThrow(/not a SpecShield usage file/);
    expect(() => validateUsage({ format: 'specshield-usage', version: 99, endpoints: [] })).toThrow(/v99/);
  });

  test('parseDuration', () => {
    expect(parseDuration('30d')).toBe(30 * DAY);
    expect(parseDuration('2w')).toBe(14 * DAY);
    expect(() => parseDuration('soon')).toThrow(/Invalid duration/);
  });
});

describe('importLogFile', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-usage-'));

  test('auto-detects format and reads .gz', async () => {
    const lines = [nginxLine(NOW, 'GET', '/v1/users/me', 200, 'a/1'), 'junk', nginxLine(NOW, 'GET', '/v1/users/me', 200, 'a/1')].join('\n');
    const file = path.join(dir, 'access.log.gz');
    fs.writeFileSync(file, zlib.gzipSync(lines));
    const agg = new UsageAggregator({ clientSpec: parseClientSpec('ua'), matcher: createRouteMatcher(SPEC) });
    const r = await importLogFile(file, { aggregator: agg });
    expect(r).toMatchObject({ file: 'access.log.gz', format: 'combined', lines: 3, parsed: 2, skipped: 1 });
    expect(r.fingerprint).toMatch(/^\d+:[0-9a-f]{16}$/);
  });

  test('explains an unrecognised format', async () => {
    const file = path.join(dir, 'weird.log');
    fs.writeFileSync(file, 'alpha beta\ngamma delta\n');
    const agg = new UsageAggregator({ clientSpec: parseClientSpec('ua') });
    await expect(importLogFile(file, { aggregator: agg })).rejects.toThrow(/Could not recognise the log format/);
  });
});

// ─── Impact ─────────────────────────────────────────────────────────────────

function usageFile(endpoints, { from = NOW - 20 * DAY, to = NOW - DAY } = {}) {
  return {
    format: 'specshield-usage',
    version: 1,
    client: 'ua',
    basePath: null,
    window: { from: new Date(from).toISOString(), to: new Date(to).toISOString() },
    endpoints,
  };
}
const ep = (method, p, clients) => ({ method, path: p, clients });
const cl = (id, calls, params) => ({ id, calls, lastSeen: new Date(NOW - DAY).toISOString(), ...(params ? { params } : {}) });

const USAGE = usageFile([
  ep('GET', '/v1/orders', [cl('ios/5.2', 300, { status: 300 }), cl('okhttp/4.12', 100, { status: 100, expand: 100 }), cl('acme/1.0', 2)]),
  ep('DELETE', '/v1/orders/{orderId}/receipt', [cl('ios/5.2', 31), cl('acme/1.0', 1)]),
  ep('GET', '/v1/orders/{orderId}', [cl('kube-probe/1.29', 500)]),
]);

const change = (type, extra) => ({ type, severity: 'error', description: type, ...extra });
const RESULT = {
  breakingChanges: [
    change('METHOD_REMOVED', { path: '/orders/{orderId}/receipt', method: 'delete' }),
    change('ENDPOINT_REMOVED', { path: '/legacy-report', method: 'get' }),
    change('PARAMETER_REMOVED', { path: '/orders', method: 'get', field: 'parameters.expand' }),
    change('PARAMETER_BECAME_REQUIRED', { path: '/orders', method: 'get', field: 'parameters.status' }),
    change('PARAMETER_TYPE_CHANGED', { path: '/orders', method: 'get', field: 'parameters.X-Tenant' }),
    change('RESPONSE_FIELD_REMOVED', { field: 'responses.200.total', affectedEndpoints: ['GET /orders/{orderId}', 'GET /orders'] }),
    change('SCHEMA_REMOVED', { field: 'components.schemas.Old' }),
  ],
  additions: [],
  modifications: [],
  warnings: [],
};

function run(opts = {}) {
  return applyUsageImpact(RESULT, {
    usage: USAGE, baseSpec: SPEC, baseNorm: normalizeSpec(SPEC), now: NOW, ...opts,
  });
}
const byType = (list, type) => list.find((c) => c.type === type);

describe('usage impact', () => {
  test('endpoint-level impact names the calling clients with shares', () => {
    const { result } = run();
    const i = byType(result.breakingChanges, 'METHOD_REMOVED').impact;
    expect(i).toMatchObject({ verdict: 'used', basis: 'endpoint', calls: 32, endpointCalls: 32 });
    expect(i.clients.map((c) => [c.id, c.share])).toEqual([['ios/5.2', 0.969], ['acme/1.0', 0.031]]);
  });

  test('query parameter removed → only clients that send it', () => {
    const i = byType(run().result.breakingChanges, 'PARAMETER_REMOVED').impact;
    expect(i).toMatchObject({ basis: 'query-parameter', parameter: 'expand', parameterUse: 'sent', calls: 100 });
    expect(i.clients.map((c) => c.id)).toEqual(['okhttp/4.12']);
  });

  test('query parameter became required → only clients that omit it', () => {
    const i = byType(run().result.breakingChanges, 'PARAMETER_BECAME_REQUIRED').impact;
    expect(i).toMatchObject({ parameterUse: 'omitted', calls: 2 });
    expect(i.clients.map((c) => c.id)).toEqual(['acme/1.0']);
  });

  test('header parameter falls back to endpoint-level impact', () => {
    const i = byType(run().result.breakingChanges, 'PARAMETER_TYPE_CHANGED').impact;
    expect(i).toMatchObject({ basis: 'endpoint', calls: 402 });
  });

  test('merged $ref changes aggregate across their affected endpoints', () => {
    const i = byType(run().result.breakingChanges, 'RESPONSE_FIELD_REMOVED').impact;
    expect(i.calls).toBe(902);
  });

  test('unused breaking changes move out of breakingChanges; unknown ones stay', () => {
    const { result, meta } = run();
    expect(meta).toMatchObject({ trusted: true, days: 19, downgrade: { enabled: true, reason: null } });
    expect(result.unusedBreakingChanges.map((c) => c.type)).toEqual(['ENDPOINT_REMOVED']);
    expect(byType(result.breakingChanges, 'SCHEMA_REMOVED').impact).toMatchObject({ verdict: 'unknown' });
    expect(result.breakingChanges).toHaveLength(6);
  });

  test('--usage-ignore-client removes a client from the impact', () => {
    const { result, meta } = run({ ignoreClients: ['kube-probe/*'] });
    expect(byType(result.breakingChanges, 'RESPONSE_FIELD_REMOVED').impact.calls).toBe(402);
    expect(meta.ignoredCalls).toBe(500);
  });

  test('a short window, stale data or --no-usage-downgrade keep unused changes breaking', () => {
    const short = run({ usage: { ...USAGE, window: usageFile([], { from: NOW - 3 * DAY }).window } });
    expect(short.meta.downgrade.reason).toMatch(/covers 2 day/);
    expect(short.result.unusedBreakingChanges).toHaveLength(0);
    expect(byType(short.result.breakingChanges, 'ENDPOINT_REMOVED').impact.verdict).toBe('unused');

    const stale = run({ usage: { ...USAGE, window: usageFile([], { from: NOW - 90 * DAY, to: NOW - 45 * DAY }).window } });
    expect(stale.meta.downgrade.reason).toMatch(/45 days old/);

    expect(run({ minDays: 30 }).result.unusedBreakingChanges).toHaveLength(0);
    expect(run({ downgrade: false }).meta.downgrade.reason).toMatch(/--no-usage-downgrade/);
  });

  test('usage that matches nothing in the spec is not applied at all', () => {
    const { result, meta } = run({ usage: usageFile([ep('GET', '/elsewhere', [cl('x/1', 9)])]) });
    expect(meta.trusted).toBe(false);
    expect(result.unusedBreakingChanges).toHaveLength(0);
    expect(result.breakingChanges.every((c) => !c.impact)).toBe(true);
  });

  test('client patterns: glob is whole-id, plain text is a substring', () => {
    const t = compileClientPatterns(['kube-probe/*', 'HEALTH']);
    expect(t('kube-probe/1.29')).toBe(true);
    expect(t('my-kube-probe/1')).toBe(false);
    expect(t('elb-healthchecker/2.0')).toBe(true);
  });
});

describe('report output with usage', () => {
  test('human report shows impact and a safe-to-ship section', () => {
    const { result, meta } = run();
    const text = formatHuman({ ...result, usage: { ...meta, file: 'usage.json' } }).replace(/\x1b\[[0-9;]*m/g, '');
    expect(text).toMatch(/1 breaking but unused/);
    expect(text).toMatch(/impact: 2 clients · 32 calls/);
    expect(text).toMatch(/ios\/5\.2\s+97% of calls/);
    expect(text).toMatch(/BREAKING BUT UNUSED — safe to ship/);
    expect(text).toMatch(/impact: 1 client · 2 calls without "status"/);
  });

  test('JSON gains usage fields only when usage was applied', () => {
    const { result, meta } = run();
    const withUsage = formatJson({ ...result, usage: meta });
    expect(withUsage.summary.unusedBreaking).toBe(1);
    expect(withUsage.usage.trusted).toBe(true);
    const plain = formatJson(RESULT);
    expect(Object.keys(plain)).toEqual(['summary', 'breakingChanges', 'additions', 'modifications', 'warnings']);
  });
});

// ─── Regressions found by testing on real logs ──────────────────────────────
// SEART-GHS (real REST API, nginx, Dec 2023–Feb 2024) + its live OpenAPI spec;
// Elastic sample logs (same events as combined and JSON); AWS ALB doc examples.

describe('real-log regressions', () => {
  test('object-typed query param (Spring DTO) is judged by endpoint, not by its never-sent name', () => {
    const spec = {
      openapi: '3.0.1',
      paths: { '/r/search': { get: { parameters: [
        { name: 'searchParameterDto', in: 'query', required: true, schema: { $ref: '#/components/schemas/Dto' } },
        { name: 'sort', in: 'query', schema: { type: 'array', items: { type: 'string' } } },
      ], responses: { 200: { description: 'ok' } } } } },
      components: { schemas: { Dto: { type: 'object', properties: { language: { type: 'string' } } } } },
    };
    const usage = usageFile([ep('GET', '/r/search', [cl('browser', 50, { language: 50, page: 50 })])]);
    const res = {
      breakingChanges: [
        change('PARAMETER_REMOVED', { path: '/r/search', method: 'get', field: 'parameters.searchParameterDto' }),
        change('PARAMETER_REMOVED', { path: '/r/search', method: 'get', field: 'parameters.sort' }),
      ],
      additions: [], modifications: [], warnings: [],
    };
    const { result } = applyUsageImpact(res, { usage, baseSpec: spec, baseNorm: normalizeSpec(spec), now: NOW, minCoverage: 0 });
    expect(result.breakingChanges.map((c) => [c.field, c.impact.basis, c.impact.calls])).toEqual([
      ['parameters.searchParameterDto', 'endpoint', 50],
    ]);
    expect(result.unusedBreakingChanges.map((c) => c.field)).toEqual(['parameters.sort']);
  });

  test('logs covering few spec operations (filtered/sampled) block the downgrade', () => {
    const narrow = usageFile([ep('GET', '/v1/orders', [cl('a/1', 10)])]);
    const { meta, result } = run({ usage: narrow });
    expect(meta).toMatchObject({ operationsSeen: 1, operationsTotal: 8 });
    expect(meta.downgrade.reason).toMatch(/only 1 of 8 operations/);
    expect(result.unusedBreakingChanges).toHaveLength(0);
    expect(run({ usage: narrow, minCoverage: 0 }).result.unusedBreakingChanges.length).toBeGreaterThan(0);
  });

  test('--usage-max-age allows deliberately analysing archived logs', () => {
    const old = { ...USAGE, window: usageFile([], { from: NOW - 900 * DAY, to: NOW - 880 * DAY }).window };
    expect(run({ usage: old }).meta.downgrade.reason).toMatch(/880 days old/);
    expect(run({ usage: old, maxAgeDays: 1000 }).meta.downgrade.enabled).toBe(true);
  });

  test('JSON field names from Elastic, Caddy, Traefik, Google Cloud LB', () => {
    expect(parseJsonLine('{"time":"17/May/2015:08:05:32 +0000","request":"GET /downloads/product_1 HTTP/1.1","response":304,"agent":"Debian APT-HTTP/1.3 (0.8.16)"}'))
      .toMatchObject({ method: 'GET', path: '/downloads/product_1', status: 304, userAgent: 'Debian APT-HTTP/1.3 (0.8.16)' });
    expect(parseJsonLine('{"ts":1760000000.5,"request":{"method":"GET","host":"api.x.io","uri":"/a?b=1","headers":{"User-Agent":["caddy-client/2.1"]}},"status":201}'))
      .toMatchObject({ method: 'GET', path: '/a', query: 'b=1', host: 'api.x.io', status: 201, userAgent: 'caddy-client/2.1' });
    expect(parseJsonLine('{"RequestMethod":"DELETE","RequestPath":"/t/1","RequestHost":"API.X.io:443","DownstreamStatus":204,"StartUTC":"2026-10-01T00:00:00Z","request_User-Agent":"tr/1"}'))
      .toMatchObject({ method: 'DELETE', path: '/t/1', host: 'api.x.io', status: 204, userAgent: 'tr/1' });
    expect(parseJsonLine('{"httpRequest":{"requestMethod":"POST","requestUrl":"https://g.example.com/v1/x?y=2","status":200,"userAgent":"gcp/3"},"timestamp":"2026-10-01T00:00:00Z"}'))
      .toMatchObject({ method: 'POST', path: '/v1/x', query: 'y=2', host: 'g.example.com', status: 200, userAgent: 'gcp/3' });
  });

  test('multi-word User-Agent products are kept', () => {
    expect(normalizeUserAgent('Debian APT-HTTP/1.3 (0.8.16~exp12ubuntu10.21)')).toBe('Debian APT-HTTP/1.3');
    expect(normalizeUserAgent('Chef Client/10.18.2 (ruby-1.9.3-p327; ohai-6.16.0)')).toBe('Chef Client/10.18');
    expect(normalizeUserAgent('Feedfetcher-Google; (+http://www.google.com/feedfetcher.html)')).toBe('Feedfetcher-Google');
    expect(normalizeUserAgent('Some Bot')).toBe('Some Bot');
  });

  test('all AWS ALB documentation examples parse, with host', () => {
    const tg = 'arn:aws:elasticloadbalancing:us-east-2:123456789012:targetgroup/my-targets/73e2d6bc24d8a067';
    const lines = [
      `http 2018-07-02T22:23:00.186641Z app/my-loadbalancer/50dc6c495c0c9188 192.168.131.39:2817 10.0.0.1:80 0.000 0.001 0.000 200 200 34 366 "GET http://www.example.com:80/ HTTP/1.1" "curl/7.46.0" - - ${tg} "Root=1-58337262-36d228ad5d99923122bbe354" "-" "-" 0 2018-07-02T22:22:48.364000Z "forward" "-" "-" "10.0.0.1:80" "200" "-" "-" TID_1234abcd5678ef90 "-" "-" "-"`,
      `h2 2018-07-02T22:23:00.186641Z app/my-loadbalancer/50dc6c495c0c9188 10.0.1.252:48160 10.0.0.66:9000 0.000 0.002 0.000 200 200 5 257 "GET https://10.0.2.105:773/ HTTP/2.0" "curl/7.46.0" ECDHE-RSA-AES128-GCM-SHA256 TLSv1.2 ${tg} "Root=1-58337327-72bd00b0343d75b906739c42" "-" "-" 1 2018-07-02T22:22:48.364000Z "redirect" "https://example.com:80/" "-" "10.0.0.66:9000" "200" "-" "-" TID_1234abcd5678ef90 "-" "-" "-"`,
      `wss 2018-07-02T22:23:00.186641Z app/my-loadbalancer/50dc6c495c0c9188 10.0.0.140:44244 10.0.0.171:8010 0.000 0.001 0.000 101 101 218 786 "GET https://10.0.0.30:443/ HTTP/1.1" "-" ECDHE-RSA-AES128-GCM-SHA256 TLSv1.2 ${tg} "Root=1-58337364-23a8c76965a2ef7629b185e3" "-" "-" 1 2018-07-02T22:22:48.364000Z "forward" "-" "-" "10.0.0.171:8010" "101" "-" "-" TID_1234abcd5678ef90 "-" "-" "-"`,
      `http 2018-11-30T22:23:00.186641Z app/my-loadbalancer/50dc6c495c0c9188 192.168.131.39:2817 - 0.000 0.001 0.000 502 - 34 366 "GET http://www.example.com:80/ HTTP/1.1" "curl/7.46.0" - - ${tg} "Root=1-58337364-23a8c76965a2ef7629b185e3" "-" "-" 0 2018-11-30T22:22:48.364000Z "forward" "-" "LambdaInvalidResponse" "-" "-" "-" "-" TID_1234abcd5678ef90 "-" "-" "-"`,
    ];
    expect(detectFormat(lines)).toBe('alb');
    expect(lines.map((l) => { const r = parseAlb(l); return [r.host, r.status, r.userAgent]; })).toEqual([
      ['www.example.com', 200, 'curl/7.46.0'],
      ['10.0.2.105', 200, 'curl/7.46.0'],
      ['10.0.0.30', 101, null],
      ['www.example.com', 502, 'curl/7.46.0'],
    ]);
    // Malformed requests are logged by ALB as "- http://host:80- -" → skipped.
    expect(parseAlb(lines[0].replace('"GET http://www.example.com:80/ HTTP/1.1"', '"- http://www.example.com:80- -"'))).toBeNull();
  });

  test('--host keeps only the API being analysed', () => {
    const agg = new UsageAggregator({ clientSpec: parseClientSpec('ua'), hosts: ['api.example.com', '*.internal.example.com'] });
    agg.add({ ...rec('GET', '/a'), host: 'api.example.com' });
    agg.add({ ...rec('GET', '/a'), host: 'admin.example.com' });
    agg.add({ ...rec('GET', '/a'), host: 'svc.internal.example.com' });
    agg.add({ ...rec('GET', '/a'), host: null });               // log without host → kept
    expect(agg.stats).toMatchObject({ requests: 3, otherHost: 1 });
  });
});

// ─── CLI end-to-end ─────────────────────────────────────────────────────────

describe('specshield usage + compare --usage (CLI)', () => {
  const bin = path.join(__dirname, '..', 'bin', 'specshield.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-usage-cli-'));
  const yaml = require('js-yaml');

  const base = { ...SPEC, paths: { '/orders/{orderId}': SPEC.paths['/orders/{orderId}'], '/legacy-report': SPEC.paths['/legacy-report'] } };
  const target = { ...SPEC, paths: { '/orders/{orderId}': SPEC.paths['/orders/{orderId}'] } };
  fs.writeFileSync(path.join(dir, 'base.yaml'), yaml.dump(base));
  fs.writeFileSync(path.join(dir, 'target.yaml'), yaml.dump(target));
  const now = Date.now();
  const log = Array.from({ length: 30 }, (_, i) => nginxLine(now - i * DAY, 'GET', `/v1/orders/${i}`, 200, 'ios/5.2.1'));
  fs.writeFileSync(path.join(dir, 'access.log'), log.join('\n') + '\n');

  const cli = (args) => spawnSync(process.execPath, [bin, ...args], { cwd: dir, encoding: 'utf8', env: { ...process.env, CI: '1' } });

  test('an unused removal does not fail --fail-on-breaking; without --usage it does', () => {
    const imp = cli(['usage', 'import', 'access.log', '--spec', 'base.yaml']);
    expect(imp.status).toBe(0);
    expect(imp.stdout).toMatch(/Wrote usage\.json/);

    expect(cli(['compare', 'base.yaml', 'target.yaml', '--fail-on-breaking']).status).toBe(1);

    const withUsage = cli(['compare', 'base.yaml', 'target.yaml', '--fail-on-breaking', '--usage', 'usage.json', '--json']);
    expect(withUsage.status).toBe(0);
    const out = JSON.parse(withUsage.stdout);
    expect(out.summary).toMatchObject({ breaking: 0, unusedBreaking: 1 });

    const shown = execFileSync(process.execPath, [bin, 'usage', 'show', 'usage.json', '--spec', 'base.yaml', '--json'], { cwd: dir, encoding: 'utf8' });
    expect(JSON.parse(shown).unusedOperations).toEqual([{ method: 'GET', path: '/legacy-report' }]);
  });

  test('re-importing the same file with --append is skipped', () => {
    const again = cli(['usage', 'import', 'access.log', '--append']);
    expect(again.status).toBe(0);
    expect(again.stderr).toMatch(/already imported/);
  });
});
