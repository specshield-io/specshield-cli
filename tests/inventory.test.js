'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { createInventory } = require('../src/core/security/inventory');

const bin = path.join(__dirname, '..', 'bin', 'specshield.js');
const ok = { 200: { description: 'ok' } };
const SPEC = {
  openapi: '3.0.3',
  info: { title: 'Shop', version: '2' },
  servers: [{ url: 'https://api.shop.io/api' }],
  paths: {
    '/v2/orders': { get: { responses: ok }, post: { responses: ok } },
    '/v2/orders/{orderId}': { get: { responses: ok } },
    '/v2/legacy': { get: { 'x-sunset': '2026-01-01', deprecated: true, responses: ok } },
  },
};
const NOW = Date.parse('2026-11-12T00:00:00Z');
const T = Date.parse('2026-11-01T00:00:00Z');

function run(records, { spec = SPEC, ...opts } = {}) {
  const inv = createInventory(spec, { now: NOW, ...opts });
  for (const r of records) inv.add({ host: 'api.shop.io', time: T, userAgent: 'app/1', query: '', ...r });
  return { findings: inv.findings(), stats: inv.stats };
}
const req = (method, p, status = 200, extra = {}) => ({ method, path: p, status, ...extra });
const rules = (records, opts) => run(records, opts).findings.map((f) => `${f.rule}:${f.severity}`);

describe('documented traffic is quiet', () => {
  test('no findings', () => {
    const r = run([req('GET', '/api/v2/orders'), req('GET', '/api/v2/orders/42'), req('POST', '/api/v2/orders/', 201)]);
    expect(r.findings).toEqual([]);
    expect(r.stats.documentedSeen).toBe(3);
  });

  test('assets, the root, HEAD and OPTIONS are not endpoints', () => {
    expect(rules([req('GET', '/api/app.js'), req('GET', '/'), req('OPTIONS', '/api/x'), req('HEAD', '/api/v2/orders')])).toEqual([]);
  });
});

describe('shadow endpoints', () => {
  test('served → medium; a write or an internal path → high', () => {
    expect(rules([req('GET', '/api/v2/reports')])).toEqual(['shadow-endpoint:medium']);
    expect(rules([req('DELETE', '/api/v2/reports/9')])).toEqual(['shadow-endpoint:high']);
    expect(rules([req('GET', '/api/internal/flags')])).toEqual(['shadow-endpoint:high']);
  });

  test('IDs are templated, so one route is one finding', () => {
    const f = run([req('GET', '/api/v2/users/1'), req('GET', '/api/v2/users/2', 200, { userAgent: 'b' })]).findings;
    expect(f).toHaveLength(1);
    expect(f[0].affectedEndpoints).toEqual(['GET /v2/users/{userId}']);
    expect(f[0].detail).toMatch(/2 calls from 2 clients \(200×2\), last 2026-11-01/);
  });

  test('redirects prove nothing; 304 does', () => {
    expect(rules([req('GET', '/api/v2/reports', 301), req('GET', '/.env', 301)])).toEqual([]);
    expect(rules([req('GET', '/api/v2/reports', 304)])).toEqual(['shadow-endpoint:medium']);
  });

  test('404/405 only means it isn\'t there; 401/403 means it exists', () => {
    const gone = run([req('GET', '/api/wp-login.php', 404), req('GET', '/api/x', 405)]);
    expect(gone.findings).toEqual([]);
    expect(gone.stats.endpoints).toBe(0);
    const f = run([req('GET', '/api/v2/secret', 403)]).findings;
    expect(f.map((x) => `${x.rule}:${x.severity}`)).toEqual(['shadow-endpoint:low']);
    expect(f[0].detail).toMatch(/exists/);
  });

  test('logs without a status are reported with that caveat', () => {
    const f = run([req('GET', '/api/v2/reports', null)]).findings;
    expect(f[0]).toMatchObject({ severity: 'low', detail: expect.stringMatching(/no status/) });
  });

  test('paths outside the API\'s base path belong to something else', () => {
    const r = run([req('GET', '/blog/post-1')]);
    expect(r.findings).toEqual([]);
    expect(r.stats.outside).toBe(1);
  });

  test('--host keeps other hosts out', () => {
    expect(rules([req('GET', '/api/v2/reports', 200, { host: 'other.io' })], { hosts: new Set(['api.shop.io']) })).toEqual([]);
  });

  test('HTML responses in a capture are the app, not the API', () => {
    expect(rules([req('GET', '/api/v2/reports', 200, { mime: 'text/html' })])).toEqual([]);
  });
});

describe('methods, versions, sunsets', () => {
  test('an undocumented method on a documented path', () => {
    expect(rules([req('DELETE', '/api/v2/orders/42', 204)])).toEqual(['undocumented-method:high']);
    expect(rules([req('PUT', '/api/v2/orders/42', 405)])).toEqual([]);
  });

  test('an older version still answering', () => {
    const f = run([req('GET', '/api/v1/orders/42')]).findings;
    expect(f.map((x) => x.rule)).toEqual(['zombie-version']);
    expect(f[0].detail).toMatch(/now GET \/v2\/orders\/\{orderId\} \(v2\)/);
  });

  test('a version under the base path', () => {
    const spec = { ...SPEC, servers: [{ url: '/api/v2' }], paths: { '/orders': { get: { responses: ok } } } };
    expect(rules([req('GET', '/api/v1/orders')], { spec })).toEqual(['zombie-version:medium']);
  });

  test('still served after its sunset date; quiet after it is fine', () => {
    expect(rules([req('GET', '/api/v2/legacy')])).toEqual(['sunset-passed:medium']);
    expect(rules([req('GET', '/api/v2/legacy', 410)])).toEqual([]);
    expect(rules([req('GET', '/api/v2/legacy', 200, { time: Date.parse('2025-12-01') })])).toEqual([]);
  });
});

describe('exposed files', () => {
  test('a 200 on /.env is high, a 404 nothing', () => {
    const f = run([req('GET', '/.env'), req('GET', '/.git/config', 404)]).findings;
    expect(f.map((x) => `${x.rule}:${x.severity}`)).toEqual(['exposed-sensitive-path:high']);
    expect(f[0]).toMatchObject({ field: 'api.shop.io', detail: expect.stringMatching(/environment file/) });
  });

  test('a host answering 200 to many probes is a catch-all, and is downgraded', () => {
    const r = rules([req('GET', '/.env'), req('GET', '/.git/config'), req('GET', '/phpinfo.php'), req('GET', '/api/v2/reports')]);
    expect(r.sort()).toEqual(['exposed-sensitive-path:low', 'exposed-sensitive-path:low', 'exposed-sensitive-path:low', 'shadow-endpoint:low']);
  });

  test('with response sizes, a file unlike the catch-all page stays high', () => {
    const page = (p) => req('GET', p, 200, { bytes: 1362 });
    const f = run([page('/.git/config'), page('/phpinfo.php'), page('/.aws/credentials'), req('GET', '/.env', 200, { bytes: 2411 })]).findings;
    expect(f.map((x) => `${x.affectedEndpoints[0]}:${x.severity}`).sort()).toEqual(['GET /.aws/credentials:low', 'GET /.env:high', 'GET /.git/config:low', 'GET /phpinfo.php:low']);
    expect(f.find((x) => x.severity === 'high').detail).toMatch(/2411 bytes no other path got/);
  });

  test('a site whose catch-all page changed size is still recognised', () => {
    const at = (p, bytes) => req('GET', p, 200, { bytes });
    const f = run([at('/.env', 1366), at('/.git/config', 1365), at('/phpinfo.php', 1366), at('/.env.prod', 4269), at('/.env.local', 4270), at('/.env.save', 4268)], { spec: null }).findings;
    expect(f.map((x) => x.severity)).toEqual(['low', 'low', 'low', 'low', 'low', 'low']);
    expect(f[3].detail).toMatch(/4269 bytes, the same as 2 other probe paths got \(e\.g\. \/\.env\.local\)/);
  });

  test('a leak the size of an ordinary API response is still a leak', () => {
    const at = (p, bytes) => req('GET', p, 200, { bytes });
    const f = run([at('/api/v2/orders', 120), at('/api/v2/orders/1', 121), at('/api/v2/orders/2', 119), at('/.env', 120)]).findings;
    expect(f.map((x) => `${x.rule}:${x.severity}`)).toEqual(['exposed-sensitive-path:high']);
  });

  test('with sizes, several real leaks are not mistaken for a catch-all', () => {
    const f = run([req('GET', '/.env', 200, { bytes: 900 }), req('GET', '/.git/config', 200, { bytes: 260 }), req('GET', '/phpinfo.php', 200, { bytes: 85000 })]).findings;
    expect(f.map((x) => x.severity)).toEqual(['high', 'high', 'high']);
  });

  test('catch-all detection is per site when the logs carry no host', () => {
    const at = (site, p, bytes) => req('GET', p, 200, { host: null, site, bytes });
    const f = run([at('a', '/.env', 673), at('a', '/.git/config', 673), at('a', '/phpinfo.php', 673), at('b', '/.env', 3100)]).findings;
    expect(f.filter((x) => x.severity === 'high').map((x) => x.field)).toEqual(['b']);
  });

  test('a probe answered with the home page is a rewrite, not the file', () => {
    const f = run([req('GET', '/', 200, { bytes: 11862 }), req('GET', '/.env', 200, { bytes: 11870 })], { spec: null }).findings;
    expect(f.map((x) => x.severity)).toEqual(['low']);
    expect(f[0].detail).toMatch(/size of this host's home page/);
  });

  test('a directory request for a file path is not the file', () => {
    expect(rules([req('GET', '/.aws/credentials/', 200, { bytes: 11879 })])).toEqual([]);
    expect(rules([req('GET', '/debug/pprof/', 200)])).toEqual(['exposed-sensitive-path:high']);
  });

  test('checked without a spec too', () => {
    expect(rules([req('GET', '/actuator/env'), req('GET', '/api/anything')], { spec: null })).toEqual(['exposed-sensitive-path:high']);
  });
});

describe('specshield audit --logs (CLI)', () => {
  let dir;
  const line = (method, p, status, ua = 'app/1') => `10.0.0.1 - - [01/Nov/2026:10:00:00 +0000] "${method} ${p} HTTP/1.1" ${status} 12 "-" "${ua}"`;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-inv-'));
    fs.writeFileSync(path.join(dir, 'o.json'), JSON.stringify({ ...SPEC, security: [{ b: [] }], components: { securitySchemes: { b: { type: 'http', scheme: 'bearer' } } } }));
    fs.writeFileSync(path.join(dir, 'access.log'), [
      line('GET', '/api/v2/orders', 200), line('GET', '/api/v1/orders/7', 200), line('DELETE', '/api/v2/orders/7', 204),
      line('GET', '/.env', 200, 'scanner'), line('GET', '/wp-admin', 404, 'scanner'),
    ].join('\n') + '\n');
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
  const audit = (...a) => spawnSync('node', [bin, 'audit', ...a, '--no-summary'], { cwd: dir, encoding: 'utf8', env: { ...process.env, FORCE_COLOR: '0' } });

  test('reports traffic findings next to the spec\'s', () => {
    const r = audit('o.json', '--logs', 'access.log', '--json');
    expect(r.status).toBe(1);
    const out = JSON.parse(r.stdout);
    expect(out.findings.map((f) => f.rule).sort()).toEqual(['exposed-sensitive-path', 'undocumented-method', 'zombie-version']);
    expect(out.traffic).toMatchObject({ requests: 5, documentedSeen: 1, documentedTotal: 4 });
    expect(out.owasp.find((o) => o.id === 'API9').medium).toBe(1);
  });

  test('human output', () => {
    const r = audit('o.json', '--logs', 'access.log');
    expect(r.stdout).toMatch(/Traffic: 5 requests; 1 of 4 documented operations called/);
    expect(r.stdout).toMatch(/Retired API version still served/);
  });

  test('logs alone check exposed files only', () => {
    const r = audit('--logs', 'access.log');
    expect(r.stdout).toMatch(/checked for exposed files only/);
    expect(r.stdout).toMatch(/Sensitive file or debug endpoint served/);
  });
});
