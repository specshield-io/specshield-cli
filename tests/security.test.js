'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { securityDiff, sensitivity } = require('../src/core/security/diff');
const { runGate } = require('../src/core/gate/runGate');

const SCHEMES = {
  oauth: { type: 'oauth2', flows: {} },
  other: { type: 'oauth2', flows: {} },
  bearer: { type: 'http', scheme: 'bearer' },
  basic: { type: 'http', scheme: 'basic' },
  headerKey: { type: 'apiKey', in: 'header', name: 'X-Key' },
  queryKey: { type: 'apiKey', in: 'query', name: 'key' },
};
const res = (properties) => ({ 200: { description: 'ok', content: { 'application/json': { schema: { type: 'object', properties } } } } });
const op = (security, properties = { id: { type: 'string' } }) => ({ ...(security !== undefined ? { security } : {}), responses: res(properties) });
const spec = (paths, extra = {}) => ({ openapi: '3.0.3', info: { title: 'T', version: '1' }, paths, components: { securitySchemes: SCHEMES }, ...extra });
const one = (security, properties, extra) => spec({ '/pets/{id}': { get: op(security, properties) } }, extra);
const types = (r) => r.map((c) => c.type);

describe('authentication', () => {
  test('removing security from an operation is AUTH_REMOVED', () => {
    const r = securityDiff(one([{ oauth: ['read'] }]), one(undefined));
    expect(types(r.breaking)).toEqual(['AUTH_REMOVED']);
    expect(r.breaking[0].affectedEndpoints).toEqual(['GET /pets/{id}']);
    expect(r.breaking[0].description).toMatch(/oauth \[read\]/);
  });

  test('an explicit security: [] overrides a global requirement', () => {
    const r = securityDiff(one(undefined, undefined, { security: [{ bearer: [] }] }), one([], undefined, { security: [{ bearer: [] }] }));
    expect(types(r.breaking)).toEqual(['AUTH_REMOVED']);
  });

  test('adding an anonymous alternative removes the requirement', () => {
    expect(types(securityDiff(one([{ bearer: [] }]), one([{ bearer: [] }, {}])).breaking)).toEqual(['AUTH_REMOVED']);
  });

  test('removing a global requirement is one finding across endpoints', () => {
    const paths = { '/a': { get: op() }, '/b': { post: op() } };
    const r = securityDiff(spec(paths, { security: [{ bearer: [] }] }), spec(paths));
    expect(types(r.breaking)).toEqual(['AUTH_REMOVED']);
    expect(r.breaking[0].affectedEndpoints).toEqual(['GET /a', 'POST /b']);
  });

  test('an endpoint that was already anonymous is not a regression', () => {
    const r = securityDiff(one([{}, { bearer: [] }]), one(undefined));
    expect(r.breaking).toEqual([]);
    expect(r.warnings).toEqual([]);
  });

  test('moving a requirement from global to the operation changes nothing', () => {
    const r = securityDiff(one(undefined, undefined, { security: [{ bearer: [] }] }), one([{ bearer: [] }]));
    expect(r.breaking).toEqual([]);
    expect(r.warnings).toEqual([]);
  });

  test('dropping a scope is AUTH_SCOPE_REDUCED, adding one is fine', () => {
    const r = securityDiff(one([{ oauth: ['read', 'admin'] }]), one([{ oauth: ['read'] }]));
    expect(types(r.breaking)).toEqual(['AUTH_SCOPE_REDUCED']);
    expect(r.breaking[0]).toMatchObject({ field: 'oauth' });
    expect(r.breaking[0].description).toMatch(/scope admin on oauth/);
    expect(securityDiff(one([{ oauth: ['read'] }]), one([{ oauth: ['read', 'admin'] }])).breaking).toEqual([]);
  });

  test('a weaker scheme, or one factor fewer, is AUTH_WEAKENED', () => {
    expect(types(securityDiff(one([{ bearer: [] }]), one([{ basic: [] }])).breaking)).toEqual(['AUTH_WEAKENED']);
    expect(types(securityDiff(one([{ headerKey: [] }]), one([{ headerKey: [] }, { queryKey: [] }])).breaking)).toEqual(['AUTH_WEAKENED']);
    expect(types(securityDiff(one([{ bearer: [], headerKey: [] }]), one([{ bearer: [] }])).breaking)).toEqual(['AUTH_WEAKENED']);
  });

  test('a scheme redefined as weaker under the same name is AUTH_WEAKENED', () => {
    const weak = spec({ '/pets/{id}': { get: op([{ bearer: [] }]) } }, { components: { securitySchemes: { bearer: { type: 'apiKey', in: 'query', name: 'k' } } } });
    expect(types(securityDiff(one([{ bearer: [] }]), weak).breaking)).toEqual(['AUTH_WEAKENED']);
  });

  test('an equally strong replacement is a warning', () => {
    const r = securityDiff(one([{ oauth: ['read'] }]), one([{ other: ['read'] }]));
    expect(r.breaking).toEqual([]);
    expect(types(r.warnings)).toEqual(['AUTH_CHANGED']);
  });

  test('a renamed path parameter is still the same operation', () => {
    const head = spec({ '/pets/{petId}': { get: op(undefined) } });
    expect(types(securityDiff(one([{ bearer: [] }]), head).breaking)).toEqual(['AUTH_REMOVED']);
  });

  test('Swagger 2.0 security definitions', () => {
    const doc = (security) => ({ swagger: '2.0', securityDefinitions: { k: { type: 'apiKey', in: 'header', name: 'K' }, b: { type: 'basic' } }, paths: { '/a': { get: { security, responses: { 200: { description: 'ok' } } } } } });
    expect(types(securityDiff(doc([{ k: [] }]), doc([{ b: [] }])).breaking)).toEqual(['AUTH_WEAKENED']);
    expect(types(securityDiff(doc([{ k: [] }]), doc([])).breaking)).toEqual(['AUTH_REMOVED']);
  });

  test('new endpoints: forgotten auth blocks, explicit security: [] is flagged', () => {
    const base = spec({ '/a': { get: op([{ bearer: [] }]) } });
    const add = (o) => spec({ '/a': { get: op([{ bearer: [] }]) }, '/b': { post: o } });
    expect(types(securityDiff(base, add(op())).breaking)).toEqual(['ENDPOINT_ADDED_WITHOUT_AUTH']);
    const r = securityDiff(base, add(op([])));
    expect(r.breaking).toEqual([]);
    expect(types(r.warnings)).toEqual(['PUBLIC_ENDPOINT_ADDED']);
    expect(securityDiff(base, add(op([{ bearer: [] }]))).warnings).toEqual([]);
  });

  test('an API with no auth anywhere is not asked to add it', () => {
    const r = securityDiff(spec({ '/a': { get: op() } }), spec({ '/a': { get: op() }, '/b': { get: op() } }));
    expect(r.breaking).toEqual([]);
  });
});

describe('sensitive fields', () => {
  const auth = [{ bearer: [] }];

  test.each([
    ['password', {}, 'credential'], ['clientSecret', {}, 'credential'], ['api_key', {}, 'credential'],
    ['anything', { format: 'password' }, 'credential'], ['ssn', {}, 'regulated'], ['cardNumber', {}, 'regulated'],
    ['refresh_token', {}, 'token'], ['email', {}, 'personal'], ['contact', { format: 'email' }, 'personal'],
  ])('%s is sensitive', (name, s, tier) => expect(sensitivity(name, { type: 'string', ...s })).toBe(tier));

  test.each([
    ['password_changed_at', 'string'], ['secret_count', 'integer'], ['has_password', 'boolean'],
    ['api_key_id', 'string'], ['secret_scanning_status', 'string'], ['tax_id_registrar', 'string'], ['cvc_check', 'string'], ['next_page_token', 'string'], ['token_type', 'string'], ['secretary', 'string'], ['email_verified', 'boolean'],
  ])('%s is not', (name, type) => expect(sensitivity(name, { type })).toBeNull());

  test('a new credential blocks; a new email on an authenticated endpoint is a warning', () => {
    const r = securityDiff(one(auth), one(auth, { id: { type: 'string' }, password: { type: 'string' }, email: { type: 'string' } }));
    expect(r.breaking.map((c) => c.field)).toEqual(['password']);
    expect(r.warnings.map((c) => c.field)).toEqual(['email']);
  });

  test('personal data on a public endpoint blocks', () => {
    const r = securityDiff(one([]), one([], { email: { type: 'string' } }));
    expect(r.breaking.map((c) => c.field)).toEqual(['email']);
    expect(r.breaking[0].description).toMatch(/public response/);
  });

  test('a spec that declares no auth anywhere says nothing about what is public', () => {
    const r = securityDiff(one(undefined), one(undefined, { email: { type: 'string' } }));
    expect(r.breaking).toEqual([]);
    expect(r.warnings.map((c) => c.field)).toEqual(['email']);
  });

  test('one field reached by several paths is one finding', () => {
    const user = { type: 'object', properties: { email: { type: 'string' } } };
    const r = securityDiff(one(auth), one(auth, { owner: user, creator: user }));
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0].description).toMatch(/"email" \(at owner\.email\)/);
  });

  test('a field that already existed is not new, even if it moved', () => {
    const r = securityDiff(one(auth, { password: { type: 'string' } }), one(auth, { user: { type: 'object', properties: { password: { type: 'string' } } } }));
    expect(r.breaking).toEqual([]);
  });

  test('dropping writeOnly exposes the field', () => {
    const r = securityDiff(one(auth, { password: { type: 'string', writeOnly: true } }), one(auth, { password: { type: 'string' } }));
    expect(types(r.breaking)).toEqual(['SENSITIVE_FIELD_EXPOSED']);
  });

  test('a field added to a shared, recursive schema is one finding', () => {
    const doc = (props) => ({
      openapi: '3.0.3',
      paths: Object.fromEntries(['/a', '/b'].map((p) => [p, { get: { security: auth, responses: { 200: { description: 'ok', content: { 'application/json': { schema: { $ref: '#/components/schemas/U' } } } } } } }])),
      components: { securitySchemes: SCHEMES, schemas: { U: { type: 'object', properties: { parent: { $ref: '#/components/schemas/U' }, ...props } } } },
    });
    const r = securityDiff(doc({}), doc({ secret: { type: 'string' } }));
    expect(r.breaking).toHaveLength(1);
    expect(r.breaking[0].affectedEndpoints).toEqual(['GET /a', 'GET /b']);
  });

  test('error responses and request bodies are not exposure', () => {
    const base = one(auth);
    const head = spec({ '/pets/{id}': { get: { security: auth, requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { password: { type: 'string' } } } } } }, responses: { ...res({}), 400: res({ secret: { type: 'string' } })[200] } } } });
    expect(securityDiff(base, head).breaking).toEqual([]);
  });
});

describe('gate --security', () => {
  const YAML = (sec) => `openapi: 3.0.3
info: {title: T, version: "1"}
paths:
  /pets:
    get:
${sec}      responses:
        '200': {description: ok}
components:
  securitySchemes:
    b: {type: http, scheme: bearer}
`;
  const SECURED = '      security:\n        - b: []\n';
  const env = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', PATH: process.env.PATH };
  const git = (cwd, ...a) => execFileSync('git', a, { cwd, env, stdio: 'pipe' });
  let dir;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-sec-'));
    git(dir, 'init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(dir, 'o.yaml'), YAML(SECURED));
    git(dir, 'add', '.'); git(dir, 'commit', '-qm', 'v1');
    git(dir, 'checkout', '-q', '-b', 'f');
    fs.writeFileSync(path.join(dir, 'o.yaml'), YAML(''));
    git(dir, 'commit', '-qam', 'open it');
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const run = (o = {}) => runGate({ spec: 'o.yaml', cwd: dir, base: 'main', env: {}, fetch: false, ...o });

  test('without the flag the gate stays as it was', async () => {
    const r = await run();
    expect(r.verdict).toBe('pass');
    expect(r.security).toBeUndefined();
  });

  test('blocks removed auth', async () => {
    const r = await run({ security: true });
    expect(r.verdict).toBe('block');
    expect(r.blocking[0]).toMatchObject({ change: 'auth-removed', category: 'security', operations: ['GET /pets'] });
  });

  test('shadow mode reports, a waiver accepts', async () => {
    expect((await run({ security: true, mode: 'shadow' })).verdict).toBe('would-block');
    fs.mkdirSync(path.join(dir, '.specshield'));
    fs.writeFileSync(path.join(dir, '.specshield/waivers.yml'), `waivers:\n  - change: auth-removed\n    operation: GET /pets\n    owner: "@a"\n    reason: Public catalogue, approved by security\n    expires: "2099-01-01"\n    created: "2098-12-01"\n`);
    const r = await run({ security: true, now: Date.parse('2098-12-02') });
    expect(r.verdict).toBe('pass');
    expect(r.waived).toHaveLength(1);
  });

  test('usage data cannot hide it', async () => {
    const r = await run({ security: true, usage: null });
    expect(r.unused).toEqual([]);
    expect(r.blocking).toHaveLength(1);
  });
});
