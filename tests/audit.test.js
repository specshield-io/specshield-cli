'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { auditSpec, consolidate } = require('../src/core/security/audit');
const { auditHar } = require('../src/core/security/auditHar');
const { OWASP, RULES } = require('../src/core/security/rules');

const bin = path.join(__dirname, '..', 'bin', 'specshield.js');
const SCHEMES = { b: { type: 'http', scheme: 'bearer' } };
const ok = { 200: { description: 'ok' } };
const json = (schema) => ({ 200: { description: 'ok', content: { 'application/json': { schema } } } });
const auth = [{ b: [] }];
const doc = (paths, extra = {}) => ({ openapi: '3.0.3', info: { title: 'T', version: '1' }, security: auth, paths, components: { securitySchemes: SCHEMES }, ...extra });
const rules = (d) => auditSpec(d).map((f) => f.rule);
const hit = (d, rule) => auditSpec(d).filter((f) => f.rule === rule);
const body = (properties) => ({ content: { 'application/json': { schema: { type: 'object', properties } } } });
const str = { type: 'string' };

describe('rules table', () => {
  test('every rule maps to an OWASP category and has a fix', () => {
    for (const [id, [owasp, title, fix]] of Object.entries(RULES)) {
      expect(OWASP[owasp]).toBeDefined();
      expect(title && fix && id).toBeTruthy();
    }
  });
});

describe('spec: a well-secured API is quiet', () => {
  test('no findings', () => {
    const d = doc({ '/pets': { get: { parameters: [{ name: 'limit', in: 'query', schema: { type: 'integer', maximum: 100 } }], responses: json({ type: 'array', items: { type: 'object', properties: { name: str } } }) } } }, { servers: [{ url: 'https://api.example.com' }] });
    expect(auditSpec(d)).toEqual([]);
  });
});

describe('spec: authentication', () => {
  test('no auth anywhere is one finding, and nothing is called public', () => {
    const d = { openapi: '3.0.3', paths: { '/a/{id}': { post: { responses: json({ type: 'object', properties: { email: str } }) } } } };
    expect(rules(d)).toEqual(['no-auth-declared']);
  });

  test('public writes block, except flows open by design', () => {
    expect(hit(doc({ '/orders': { post: { security: [], responses: ok } } }), 'public-write')).toHaveLength(1);
    expect(hit(doc({ '/auth/login': { post: { security: [], responses: ok } } }), 'public-write')).toEqual([]);
    expect(hit(doc({ '/orders': { get: { security: [], responses: ok } } }), 'public-write')).toEqual([]);
  });

  test('scheme weaknesses', () => {
    const d = (s) => doc({ '/a': { get: { responses: ok } } }, { components: { securitySchemes: { ...SCHEMES, s } } });
    expect(hit(d({ type: 'apiKey', in: 'query', name: 'k' }), 'api-key-in-query')).toHaveLength(1);
    expect(hit(d({ type: 'apiKey', in: 'header', name: 'k' }), 'api-key-in-query')).toEqual([]);
    expect(hit(d({ type: 'http', scheme: 'basic' }), 'basic-auth')).toHaveLength(1);
    expect(hit(d({ type: 'oauth2', flows: { implicit: { authorizationUrl: 'https://a.io/x', scopes: {} } } }), 'oauth-legacy-flow')).toHaveLength(1);
    expect(hit(d({ type: 'oauth2', flows: { clientCredentials: { tokenUrl: 'http://a.io/t', scopes: {} } } }), 'oauth-insecure-url')).toHaveLength(1);
    expect(hit(d({ type: 'oauth2', flows: { clientCredentials: { tokenUrl: 'http://localhost/t', scopes: {} } } }), 'oauth-insecure-url')).toEqual([]);
  });

  test('undefined scheme', () => {
    expect(hit(doc({ '/a': { get: { security: [{ nope: [] }], responses: ok } } }), 'undefined-security-scheme')[0].field).toBe('nope');
  });

  test('secrets in the query, but not flags about them', () => {
    const q = (name, schema) => doc({ '/a': { get: { parameters: [{ name, in: 'query', schema }], responses: ok } } });
    expect(hit(q('api_key', str), 'secret-in-query')).toHaveLength(1);
    expect(hit(q('hide_secret', { type: 'boolean' }), 'secret-in-query')).toEqual([]);
    expect(hit(q('page_token', str), 'secret-in-query')).toEqual([]);
  });
});

describe('spec: objects, properties, functions', () => {
  test('integer IDs; public object reads', () => {
    const p = [{ name: 'orderId', in: 'path', required: true, schema: { type: 'integer' } }];
    expect(rules(doc({ '/o/{orderId}': { get: { parameters: p, responses: ok } } }))).toEqual(['enumerable-id']);
    expect(rules(doc({ '/o/{orderId}': { get: { security: [], parameters: p, responses: ok } } }))).toEqual(['enumerable-id', 'public-object-read']);
    expect(rules(doc({ '/o/{orderId}': { get: { parameters: [{ ...p[0], schema: { type: 'string', format: 'uuid' } }], responses: ok } } }))).toEqual([]);
  });

  test('path-level parameters count', () => {
    const d = doc({ '/o/{id}': { parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }], get: { responses: ok } } });
    expect(rules(d)).toEqual(['enumerable-id']);
  });

  test('credentials in responses; writeOnly is fine', () => {
    expect(hit(doc({ '/u': { get: { responses: json({ type: 'object', properties: { password: str } }) } } }), 'sensitive-response-field')).toHaveLength(1);
    expect(hit(doc({ '/u': { get: { responses: json({ type: 'object', properties: { password: { ...str, writeOnly: true } } }) } } }), 'sensitive-response-field')).toEqual([]);
  });

  test('personal data is only a finding on a public endpoint', () => {
    const r = json({ type: 'object', properties: { email: str } });
    expect(hit(doc({ '/u': { get: { responses: r } } }), 'sensitive-response-field')).toEqual([]);
    expect(hit(doc({ '/u': { get: { security: [], responses: r } } }), 'sensitive-response-field')).toHaveLength(1);
  });

  test('consolidate: one field across endpoints is one finding', () => {
    const r = json({ type: 'object', properties: { secret: str } });
    const merged = consolidate(auditSpec(doc({ '/a': { get: { responses: r } }, '/b': { get: { responses: r } } })));
    expect(merged).toHaveLength(1);
    expect(merged[0].affectedEndpoints).toEqual(['GET /a', 'GET /b']);
  });

  test('mass assignment: top-level only, not on admin routes, readOnly excused', () => {
    const d = (p, props) => doc({ [p]: { post: { requestBody: body(props), responses: ok } } });
    expect(hit(d('/users', { is_admin: { type: 'boolean' } }), 'mass-assignment-risk')[0].severity).toBe('medium');
    expect(hit(d('/users', { role: str }), 'mass-assignment-risk')[0].severity).toBe('low');
    expect(hit(d('/users', { opts: { type: 'object', properties: { permissions: str } } }), 'mass-assignment-risk')).toEqual([]);
    expect(hit(d('/admin/users', { role: str }), 'mass-assignment-risk')).toEqual([]);
    expect(hit(d('/users', { role: { ...str, readOnly: true } }), 'mass-assignment-risk')).toEqual([]);
  });

  test('admin endpoints', () => {
    expect(rules(doc({ '/admin/users': { get: { security: [], responses: ok } } }))).toEqual(['public-admin-endpoint']);
    expect(rules(doc({ '/administrators': { get: { security: [], responses: ok } } }))).toEqual([]);
  });

  test('client-supplied URLs, unless constrained', () => {
    const d = (s) => doc({ '/a': { post: { requestBody: body({ callback_url: s }), responses: ok } } });
    expect(hit(d(str), 'url-input')).toHaveLength(1);
    expect(hit(d({ ...str, pattern: '^https://x' }), 'url-input')).toEqual([]);
  });
});

describe('spec: resources and servers', () => {
  test('page size and bare lists', () => {
    const q = (schema) => doc({ '/a': { get: { parameters: [{ name: 'limit', in: 'query', schema }], responses: ok } } });
    expect(rules(q({ type: 'integer' }))).toEqual(['limit-without-maximum']);
    expect(rules(doc({ '/a': { get: { responses: json({ type: 'array', items: str }) } } }))).toEqual(['list-without-pagination']);
  });

  test('servers', () => {
    const d = (url) => doc({ '/a': { get: { responses: ok } } }, { servers: [{ url }] });
    expect(rules(d('http://api.example.com'))).toEqual(['insecure-server']);
    expect(rules(d('http://localhost:8080'))).toEqual([]);
    expect(rules(d('https://staging.example.com'))).toEqual(['non-production-server']);
    expect(rules(d('https://api.latest.example.com'))).toEqual([]);
    expect(rules(d('/v1'))).toEqual([]);
    expect(rules(d('https://{region}.example.com'))).toEqual([]);
  });

  test('Swagger 2.0', () => {
    const d = { swagger: '2.0', host: 'api.example.com', schemes: ['http'], securityDefinitions: { k: { type: 'apiKey', in: 'query', name: 'k' } }, security: [{ k: [] }], paths: { '/a': { get: { responses: { 200: { description: 'ok' } } } } } };
    expect(rules(d).sort()).toEqual(['api-key-in-query', 'insecure-server']);
  });
});

describe('capture', () => {
  const SECRET = 'hunter2-do-not-print';
  const AWS = 'AKIAIOSFODNN7EXAMPLE';
  const entry = ({ url = 'https://api.acme.io/users/123', method = 'GET', status = 200, headers = [], text = '{}', mime = 'application/json' } = {}) => ({
    request: { method, url, headers: [] },
    response: { status, headers: [{ name: 'Strict-Transport-Security', value: 'max-age=1' }, { name: 'X-Content-Type-Options', value: 'nosniff' }, ...headers], content: { mimeType: mime, text } },
  });
  let dir;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-audit-')); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
  const har = (entries) => { const f = path.join(dir, `${Math.random()}.har`); fs.writeFileSync(f, JSON.stringify({ log: { entries } })); return f; };
  const scan = (...e) => auditHar([har(e)]).findings;
  const names = (...e) => scan(...e).map((f) => f.rule);

  test('clean traffic is quiet', () => expect(names(entry())).toEqual([]));

  test('pages and assets are skipped', () => {
    expect(names(entry({ url: 'http://acme.io/app.js', mime: 'application/javascript', text: AWS }))).toEqual([]);
  });

  test('cleartext, and local hosts excused', () => {
    expect(names(entry({ url: 'http://api.acme.io/a' }))).toContain('cleartext-traffic');
    expect(names(entry({ url: 'http://localhost:8080/a' }))).not.toContain('cleartext-traffic');
  });

  test('missing headers are per host', () => {
    const e = { request: { method: 'GET', url: 'https://a.io/x', headers: [] }, response: { status: 200, headers: [], content: { mimeType: 'application/json', text: '{}' } } };
    const r = names(e, { ...e, request: { ...e.request, url: 'https://a.io/y' } });
    expect(r.sort()).toEqual(['missing-hsts', 'missing-nosniff']);
  });

  test('secrets are found and never quoted', () => {
    const f = scan(
      entry({ url: `https://api.acme.io/a?api_key=${SECRET}` }),
      entry({ url: 'https://api.acme.io/b', text: JSON.stringify({ password: SECRET, note: AWS }) }),
    );
    expect(f.map((x) => x.rule).sort()).toEqual(['secret-in-response', 'secret-in-response', 'secret-in-url']);
    const printed = JSON.stringify(f);
    expect(printed).not.toContain(SECRET);
    expect(printed).not.toContain(AWS);
  });

  test('masked values and empty secrets are not leaks', () => {
    expect(names(entry({ text: JSON.stringify({ password: '********', secret: '', ssn: 'XXX-XX-XXXX'.toLowerCase().replace(/-/g, '') }) }))).toEqual([]);
  });

  test('base64 bodies are decoded', () => {
    const e = entry({ text: Buffer.from(JSON.stringify({ secret: SECRET })).toString('base64') });
    e.response.content.encoding = 'base64';
    expect(names(e)).toEqual(['secret-in-response']);
  });

  test('personal and regulated data', () => {
    expect(scan(entry({ text: JSON.stringify({ users: [{ email: 'a@b.io', ssn: '123456789' }] }) })).map((f) => [f.rule, f.severity]).sort())
      .toEqual([['personal-data-in-response', 'low'], ['regulated-data-in-response', 'high']]);
  });

  test('CORS', () => {
    const c = (o, cr) => names(entry({ headers: [{ name: 'Access-Control-Allow-Origin', value: o }, ...(cr ? [{ name: 'Access-Control-Allow-Credentials', value: 'true' }] : [])] }));
    expect(c('*', true)).toEqual(['cors-wildcard-credentials']);
    expect(c('*', false)).toEqual(['cors-any-origin']);
    expect(c('null', false)).toEqual(['cors-null-origin']);
    expect(c('https://app.acme.io', true)).toEqual([]);
  });

  test('session cookies', () => {
    const c = (v) => scan(entry({ headers: [{ name: 'Set-Cookie', value: v }] }));
    expect(c('session=abc; Path=/')[0]).toMatchObject({ rule: 'insecure-cookie', field: 'session', detail: expect.stringContaining('Secure, HttpOnly, SameSite') });
    expect(c('session=abc; Secure; HttpOnly; SameSite=Lax')).toEqual([]);
    expect(c('theme=dark')).toEqual([]);
  });

  test('stack traces only on errors; version banners', () => {
    const t = '{"e":"x\\n  at com.acme.Foo.bar(Foo.java:12)"}';
    const text = JSON.parse(t).e;
    expect(names(entry({ status: 500, text, mime: 'text/plain' }))).toEqual(['stack-trace']);
    expect(names(entry({ status: 200, text, mime: 'text/plain' }))).toEqual([]);
    expect(names(entry({ headers: [{ name: 'Server', value: 'nginx/1.18.0' }] }))).toEqual(['version-disclosure']);
    expect(names(entry({ headers: [{ name: 'Server', value: 'nginx' }] }))).toEqual([]);
  });

  test('repeat requests collapse; IDs are templated', () => {
    const e = (id) => entry({ url: `https://api.acme.io/users/${id}`, text: JSON.stringify({ secret: SECRET }) });
    const f = scan(e(1), e(2));
    expect(f).toHaveLength(1);
    expect(f[0].affectedEndpoints).toEqual(['GET /users/{userId}']);
  });

  test('--host filter and bad input', () => {
    const f = har([entry({ url: 'http://other.io/a' })]);
    expect(auditHar([f], { hosts: new Set(['api.acme.io']) }).findings).toEqual([]);
    const bad = path.join(dir, 'b.har');
    fs.writeFileSync(bad, 'nope');
    expect(() => auditHar([bad])).toThrow(/not valid HAR/);
  });
});

describe('specshield audit (CLI)', () => {
  let dir;
  const SPEC = `openapi: 3.0.3
info: {title: T, version: "1"}
security:
  - b: []
paths:
  /orders:
    post:
      security: []
      responses:
        '200': {description: ok}
    get:
      responses:
        '200': {description: ok}
components:
  securitySchemes:
    b: {type: http, scheme: bearer}
`;
  const run = (...a) => spawnSync('node', [bin, 'audit', ...a, '--no-summary'], { cwd: dir, encoding: 'utf8', env: { ...process.env, FORCE_COLOR: '0' } });
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-audit-')); fs.writeFileSync(path.join(dir, 'o.yaml'), SPEC); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  test('exits 1 on high, honours --fail-on', () => {
    const r = run('o.yaml');
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/Anyone can change data/);
    expect(r.stdout).toMatch(/needs runtime testing/);
    expect(run('o.yaml', '--fail-on', 'none').status).toBe(0);
  });

  test('a waiver with an owner and expiry accepts a finding', () => {
    fs.mkdirSync(path.join(dir, '.specshield'));
    const exp = new Date(Date.now() + 10 * 864e5).toISOString().slice(0, 10);
    fs.writeFileSync(path.join(dir, '.specshield/waivers.yml'), `waivers:\n  - change: public-write\n    operation: POST /orders\n    owner: "@a"\n    reason: Guest checkout is intended\n    expires: "${exp}"\n`);
    const r = run('o.yaml', '--json');
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ verdict: 'pass', findings: [], waived: [{ rule: 'public-write' }] });
  });

  test('SARIF points at the path', () => {
    run('o.yaml', '--sarif', 's.sarif');
    const s = JSON.parse(fs.readFileSync(path.join(dir, 's.sarif'), 'utf8'));
    expect(s.version).toBe('2.1.0');
    expect(s.runs[0].results[0]).toMatchObject({ ruleId: 'public-write', level: 'error', locations: [{ physicalLocation: { artifactLocation: { uri: 'o.yaml' }, region: { startLine: 6 } } }] });
  });

  test('needs something to audit; rejects a bad severity', () => {
    expect(run().status).toBe(2);
    expect(run('o.yaml', '--fail-on', 'nope').status).toBe(2);
  });
});
