'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const yaml = require('js-yaml');

const { collectDeprecations, deprecationReport, annotateDeprecations } = require('../src/core/usage/deprecations');
const { UsageAggregator, weekOf } = require('../src/core/usage/usageStore');
const { parseClientSpec } = require('../src/core/usage/clientIdentity');
const { createRouteMatcher } = require('../src/core/usage/routeMatcher');
const { splitTarget } = require('../src/core/usage/logParsers');
const { applyUsageImpact } = require('../src/core/usage/impact');
const { normalizeSpec } = require('../src/core/normalizeSpec');
const { formatHuman } = require('../src/core/outputFormatter');

const DAY = 86400e3;
const NOW = Date.parse('2026-10-25T12:00:00Z');
const iso = (t) => new Date(t).toISOString();

const SPEC = {
  openapi: '3.0.3',
  info: { title: 'Pets', version: '2' },
  paths: {
    '/v1/pets': {
      get: { deprecated: true, 'x-sunset': new Date('2026-09-30'), responses: { 200: { description: 'ok' } } },
    },
    '/pets': {
      parameters: [{ $ref: '#/components/parameters/Legacy' }],
      get: {
        parameters: [
          { name: 'sort', in: 'query', deprecated: true, 'x-sunset': '2027-01-31', schema: { type: 'string' } },
          { name: 'filter', in: 'query', deprecated: true, schema: { $ref: '#/components/schemas/Filter' } },
          { name: 'limit', in: 'query', schema: { type: 'integer' } },
        ],
        requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { odd: { type: 'string', deprecated: true } } } } } },
        responses: {
          200: { description: 'ok', content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/Pet' } } } } },
        },
      },
      post: {
        requestBody: { $ref: '#/components/requestBodies/NewPet' },
        responses: { 201: { description: 'created' } },
      },
    },
    '/pets/{id}/photo': {
      get: { deprecated: true, parameters: [{ name: 'size', in: 'query', deprecated: true, schema: { type: 'string' } }], responses: { 200: { description: 'ok' } } },
    },
    '/pets/{id}/quiet': { get: { deprecated: true, responses: { 200: { description: 'ok' } } } },
    '/pets/{id}/never': { get: { deprecated: true, responses: { 200: { description: 'ok' } } } },
    '/stores': { get: { responses: { 200: { description: 'ok' } } } },
  },
  components: {
    parameters: { Legacy: { name: 'X-Legacy', in: 'header', deprecated: true, schema: { type: 'string' } } },
    requestBodies: { NewPet: { content: { 'application/json': { schema: { $ref: '#/components/schemas/Pet' } } } } },
    schemas: {
      Filter: { type: 'object', properties: { color: { type: 'string' } } },
      Pet: {
        allOf: [
          { $ref: '#/components/schemas/Named' },
          { type: 'object', properties: { tag: { type: 'string', deprecated: true }, owner: { $ref: '#/components/schemas/Owner' } } },
        ],
      },
      Named: { type: 'object', properties: { name: { type: 'string' } } },
      Owner: { type: 'object', properties: { phone: { $ref: '#/components/schemas/Phone' }, friend: { $ref: '#/components/schemas/Owner' } } },
      Phone: { type: 'string', deprecated: true },
    },
  },
};

describe('collectDeprecations', () => {
  const items = collectDeprecations(SPEC);
  const keys = items.map((i) => i.key);

  test('finds operations, parameters (incl. path-level $ref) and body/response fields', () => {
    expect(keys.sort()).toEqual([
      'GET /pets parameters.X-Legacy',
      'GET /pets parameters.filter',
      'GET /pets parameters.sort',
      'GET /pets requestBody.odd',
      'GET /pets responses.200[items].owner.phone',
      'GET /pets responses.200[items].tag',
      'GET /pets/{id}/never',
      'GET /pets/{id}/photo',
      'GET /pets/{id}/quiet',
      'GET /v1/pets',
      'POST /pets parameters.X-Legacy',
      'POST /pets requestBody.owner.phone',
      'POST /pets requestBody.tag',
    ]);
  });

  test('x-sunset as a YAML date or a string; children of a deprecated operation are not repeated', () => {
    expect(items.find((i) => i.key === 'GET /v1/pets').sunset).toBe('2026-09-30');
    expect(items.find((i) => i.key === 'GET /pets parameters.sort').sunset).toBe('2027-01-31');
    expect(keys).not.toContain('GET /pets/{id}/photo parameters.size');
  });

  test('Swagger 2.0 body parameter and definitions', () => {
    const swagger = {
      swagger: '2.0',
      paths: { '/a': { post: { parameters: [{ name: 'b', in: 'body', schema: { $ref: '#/definitions/A' } }], responses: { 200: { description: 'ok', schema: { $ref: '#/definitions/A' } } } } } },
      definitions: { A: { type: 'object', properties: { old: { type: 'string', deprecated: true } } } },
    };
    expect(collectDeprecations(swagger).map((i) => i.key)).toEqual(['POST /a requestBody.old', 'POST /a responses.200.old']);
  });
});

describe('usage weeks', () => {
  const rec = (url, time, ua = 'app/1.0') => {
    const { path: p, query } = splitTarget(url);
    return { method: 'GET', path: p, query, status: 200, time, userAgent: ua, extras: [], json: null };
  };

  test('calls are bucketed by the Monday starting their week; params keep a last-sent time', () => {
    expect(weekOf(Date.parse('2026-10-25T23:00:00Z'))).toBe('2026-10-19');      // Sunday
    expect(weekOf(Date.parse('2026-10-26T00:00:00Z'))).toBe('2026-10-26');      // Monday
    const agg = new UsageAggregator({ clientSpec: parseClientSpec('ua'), matcher: createRouteMatcher(SPEC) });
    agg.add(rec('/pets?sort=a', Date.parse('2026-10-14T10:00:00Z')));
    agg.add(rec('/pets', Date.parse('2026-10-21T10:00:00Z')));
    agg.add(rec('/pets?sort=b', Date.parse('2026-10-15T10:00:00Z')));
    const c = agg.toJSON({ generator: 't', client: 'ua', sources: [] }).endpoints[0].clients[0];
    expect(c.weeks).toEqual({ '2026-10-12': 2, '2026-10-19': 1 });
    expect(c.paramsLastSeen).toEqual({ sort: '2026-10-15T10:00:00.000Z' });

    const merged = new UsageAggregator({ clientSpec: parseClientSpec('ua') });
    merged.absorb({ endpoints: [{ method: 'GET', path: '/pets', clients: [c] }], window: {}, stats: {} });
    merged.absorb({ endpoints: [{ method: 'GET', path: '/pets', clients: [c] }], window: {}, stats: {} });
    expect(merged.toJSON({ sources: [] }).endpoints[0].clients[0].weeks).toEqual({ '2026-10-12': 4, '2026-10-19': 2 });
  });
});

// ─── report ─────────────────────────────────────────────────────────────────

const TO = NOW - DAY;
const client = (id, calls, lastSeenDaysBeforeTo, extra = {}) =>
  ({ id, calls, lastSeen: iso(TO - lastSeenDaysBeforeTo * DAY), ...extra });
const USAGE = {
  format: 'specshield-usage',
  version: 1,
  client: 'ua',
  basePath: null,
  window: { from: iso(TO - 59 * DAY), to: iso(TO) },
  endpoints: [
    { method: 'GET', path: '/v1/pets', clients: [
      client('ios/5.2', 800, 3, { weeks: { [weekOf(TO - 50 * DAY)]: 700, [weekOf(TO - 3 * DAY)]: 100 } }),
      client('partner/1.0', 20, 40),
    ] },
    { method: 'GET', path: '/pets', clients: [
      client('android/4.0', 50, 1, { params: { sort: 50, limit: 50 }, paramsLastSeen: { sort: iso(TO - 35 * DAY), limit: iso(TO - DAY) } }),
      client('web/3.1', 300, 1),
    ] },
    { method: 'GET', path: '/pets/{id}/photo', clients: [client('web/3.1', 15, 45)] },
    { method: 'GET', path: '/pets/{id}/quiet', clients: [client('web/3.1', 4, 12)] },
    { method: 'GET', path: '/stores', clients: [client('web/3.1', 9, 0)] },
  ],
};
const report = (opts = {}) => deprecationReport({ spec: SPEC, usage: USAGE, now: NOW, ...opts });
const item = (r, key) => r.items.find((i) => i.key === key);

describe('deprecationReport', () => {
  test('statuses: in use, drained parameter, unverifiable header/body, quiet, safe to remove', () => {
    const r = report();
    expect(item(r, 'GET /v1/pets')).toMatchObject({ status: 'in-use', calls: 820, basis: 'operation', pastSunset: true });
    expect(item(r, 'GET /v1/pets').clients.map((c) => c.id)).toEqual(['ios/5.2', 'partner/1.0']);
    // Sent by android, but not for 35 days although android still calls /pets.
    expect(item(r, 'GET /pets parameters.sort')).toMatchObject({ status: 'safe-to-remove', basis: 'query-parameter', quietForDays: 35 });
    expect(item(r, 'GET /pets parameters.X-Legacy')).toMatchObject({ status: 'unverifiable', basis: 'endpoint', calls: 350 });
    // An object-typed query param never appears under its own name.
    expect(item(r, 'GET /pets parameters.filter')).toMatchObject({ status: 'unverifiable', basis: 'endpoint' });
    expect(item(r, 'schema Pet.tag')).toMatchObject({ status: 'unverifiable', kind: 'schema-field', operations: 2 });
    expect(item(r, 'GET /pets/{id}/photo')).toMatchObject({ status: 'safe-to-remove', quietForDays: 45 });
    expect(item(r, 'GET /pets/{id}/quiet')).toMatchObject({ status: 'quiet', quietForDays: 12 });
    expect(item(r, 'GET /pets/{id}/never')).toMatchObject({ status: 'safe-to-remove', calls: 0, reason: expect.stringMatching(/never called in 59 days/) });
    expect(r.summary).toMatchObject({ total: 11, inUse: 1, pastSunset: 1, quiet: 1 });
    expect(r.items[0].key).toBe('GET /v1/pets');                                    // worst first
  });

  test('a GET request-body field has no senders; POST body fields are judged by POST callers', () => {
    const r = report();
    expect(item(r, 'GET /pets requestBody.odd')).toMatchObject({ calls: 0, status: 'safe-to-remove' });
    // Phone is used in GET /pets responses and POST /pets bodies: only GET is called.
    expect(item(r, 'schema Phone')).toMatchObject({ operations: 2, calls: 350 });
  });

  test('a shared-schema property is one item listing every place it is used', () => {
    const phone = item(report(), 'schema Phone');
    expect(phone.occurrences).toEqual([
      { method: 'GET', path: '/pets', field: 'responses.200[items].owner.phone', side: 'response' },
      { method: 'POST', path: '/pets', field: 'requestBody.owner.phone', side: 'request' },
    ]);
    expect(phone).not.toHaveProperty('origin');
    // An inline property belongs to its one operation and keeps its own key.
    expect(item(report(), 'GET /pets requestBody.odd').kind).toBe('request-field');
  });

  test('weekly series is zero-filled across the window, with partial edge weeks', () => {
    const weeks = item(report(), 'GET /v1/pets').weeks;
    expect(weeks.length).toBeGreaterThanOrEqual(9);
    expect(weeks.reduce((n, w) => n + w.calls, 0)).toBe(800);                     // partner/1.0 has no weekly data
    expect(weeks.filter((w) => w.calls === 0).length).toBeGreaterThan(5);
    expect(weeks[0].partial).toBe(true);
    expect(item(report(), 'GET /pets parameters.sort').weeks).toEqual([]);       // weeks are per endpoint
  });

  test('--quiet-days and --usage-ignore-client change the verdict', () => {
    expect(item(report({ quietDays: 10 }), 'GET /pets/{id}/quiet').status).toBe('safe-to-remove');
    const r = report({ ignoreClients: ['ios/*'] });
    expect(item(r, 'GET /v1/pets')).toMatchObject({ status: 'safe-to-remove', calls: 20 });
  });

  test('no usage, stale usage or filtered logs give no verdict', () => {
    expect(deprecationReport({ spec: SPEC, now: NOW }).items.every((i) => i.status === 'no-data')).toBe(true);
    const stale = report({ now: NOW + 90 * DAY });
    expect(stale.items.every((i) => i.status === 'no-data')).toBe(true);
    expect(stale.usage.evidence).toMatch(/days old/);
    expect(report({ minCoverage: 90 }).usage.evidence).toMatch(/operations in the spec appear/);
  });

  test('contacts: exact id or glob, first match wins; plain text is not a substring match', () => {
    const r = report({ contacts: { 'ios/*': 'ios-team@shop.example', 'partner': 'nobody', 'partner/1.0': '#partner-x' } });
    expect(item(r, 'GET /v1/pets').clients.map((c) => c.contact)).toEqual(['ios-team@shop.example', '#partner-x']);
  });
});

// ─── compare integration ────────────────────────────────────────────────────

describe('compare --usage with deprecations', () => {
  const change = (type, extra) => ({ type, severity: 'error', description: `${type} ${extra.path || ''} ${extra.field || ''}`, ...extra });
  const RESULT = {
    breakingChanges: [
      change('ENDPOINT_REMOVED', { path: '/v1/pets', method: 'get' }),
      change('ENDPOINT_REMOVED', { path: '/pets/{id}/photo', method: 'get' }),
      change('ENDPOINT_REMOVED', { path: '/stores', method: 'get' }),
      change('PARAMETER_REMOVED', { path: '/pets', method: 'get', field: 'parameters.limit' }),
      change('RESPONSE_FIELD_REMOVED', { field: 'responses.200[items].tag', affectedEndpoints: ['GET /pets', 'GET /pets'] }),
      change('FIELD_BECAME_REQUIRED', { path: '/pets', method: 'post', field: 'requestBody.tag' }),
    ],
    additions: [], modifications: [], warnings: [],
  };
  const run = (opts = {}) => {
    const { result, meta } = applyUsageImpact(RESULT, {
      usage: USAGE, baseSpec: SPEC, baseNorm: normalizeSpec(SPEC), now: NOW, ...opts,
    });
    return { ...annotateDeprecations(result, SPEC, { meta, quietDays: opts.quietDays ?? 30 }), usage: { ...meta, quietDays: 30 } };
  };
  const find = (list, text) => list.find((c) => c.description.includes(text));

  test('a deprecated removal still called stays breaking; one quiet for quietDays passes', () => {
    const r = run();
    expect(find(r.breakingChanges, '/v1/pets').deprecation).toEqual({ deprecated: true, sunset: '2026-09-30' });
    expect(find(r.unusedBreakingChanges, '/pets/{id}/photo').deprecation).toEqual(
      { deprecated: true, sunset: null, drained: true, quietForDays: 45 });
  });

  test('removals that skipped deprecation are flagged; non-removals are left alone', () => {
    const r = run();
    expect(find(r.breakingChanges, '/stores').deprecation).toEqual({ deprecated: false });
    expect(find(r.breakingChanges, 'parameters.limit').deprecation).toEqual({ deprecated: false });
    expect(find(r.breakingChanges, 'responses.200[items].tag').deprecation).toEqual({ deprecated: true, sunset: null });
    expect(find(r.unusedBreakingChanges, 'requestBody.tag').deprecation).toBeUndefined();      // no POST callers
  });

  test('without the downgrade, drained items are annotated but keep failing', () => {
    const r = run({ downgrade: false });
    expect(find(r.breakingChanges, '/pets/{id}/photo').deprecation.drained).toBe(true);
    expect(r.unusedBreakingChanges).toEqual([]);
  });

  test('human output explains each case', () => {
    const out = formatHuman(run());
    expect(out).toMatch(/deprecated \(sunset 2026-09-30\), but still called/);
    expect(out).toMatch(/removed without being deprecated first/);
    expect(out).toMatch(/deprecated · drained: last call \d{4}-\d\d-\d\d, 45 days before the newest log line/);
    expect(out).toMatch(/or deprecated and quiet for 30\+ days/);
  });
});

// ─── CLI ────────────────────────────────────────────────────────────────────

describe('specshield deprecations (CLI)', () => {
  const bin = path.join(__dirname, '..', 'bin', 'specshield.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-deprecations-'));
  const now = Date.now();
  // Recent enough for the staleness guard: shift the fixture to end yesterday.
  const shift = (now - DAY) - TO;
  const usage = JSON.parse(JSON.stringify(USAGE, (k, v) =>
    (typeof v === 'string' && /^\d{4}-\d\d-\d\dT/.test(v) ? iso(Date.parse(v) + shift) : v)));
  usage.endpoints[0].clients[0].id = '=cmd|calc';                                 // CSV injection attempt
  fs.writeFileSync(path.join(dir, 'spec.yaml'), yaml.dump(SPEC));
  fs.writeFileSync(path.join(dir, 'usage.json'), JSON.stringify(usage));
  fs.writeFileSync(path.join(dir, '.specshield.yml'), yaml.dump({ usage: { file: 'usage.json', contacts: { 'partner/1.0': 'ops@partner.example' } } }));
  // FORCE_COLOR (set by IntelliJ and some terminals) would put ANSI codes in
  // the output the assertions match against.
  const plainEnv = () => ({ ...process.env, CI: '1', FORCE_COLOR: '0' });
  const cli = (args) => spawnSync(process.execPath, [bin, ...args], { cwd: dir, encoding: 'utf8', env: plainEnv() });
  // A developer's HTTP(S)_PROXY would send the request for the local test
  // server through the proxy, and the upload test would fail on their machine.
  const noProxyEnv = () => {
    const env = plainEnv();
    for (const k of Object.keys(env)) if (/^(https?|all)_proxy$/i.test(k)) delete env[k];
    return env;
  };

  test('text report groups by status and names contacts; usage file comes from .specshield.yml', () => {
    const r = cli(['deprecations', 'spec.yaml']);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/STILL CALLED \(1\)/);
    expect(r.stdout).toMatch(/sunset 2026-09-30 PASSED/);
    expect(r.stdout).toMatch(/→ ops@partner\.example/);
    expect(r.stdout).toMatch(/SAFE TO REMOVE/);
  });

  test('--fail-on past-sunset fails; --json and --csv write the callers safely', () => {
    const r = cli(['deprecations', 'spec.yaml', '--fail-on', 'past-sunset', '--json', '--csv', 'callers.csv']);
    expect(r.status).toBe(1);
    expect(JSON.parse(r.stdout).summary.pastSunset).toBe(1);
    const csv = fs.readFileSync(path.join(dir, 'callers.csv'), 'utf8');
    expect(csv.split('\n')[0]).toBe('item,kind,status,sunset,client,calls,last_call,contact');
    expect(csv).toMatch(/^GET \/v1\/pets,operation,in-use,2026-09-30,'=cmd\|calc,800,/m);
    expect(csv).toMatch(/partner\/1\.0,20,.*,ops@partner\.example$/m);
  });

  test('a spec with nothing deprecated says how to start; bad --fail-on is rejected', () => {
    fs.writeFileSync(path.join(dir, 'plain.yaml'), yaml.dump({ openapi: '3.0.3', info: { title: 'x', version: '1' }, paths: {} }));
    expect(cli(['deprecations', 'plain.yaml']).stdout).toMatch(/Nothing in this spec is marked deprecated/);
    expect(cli(['deprecations', 'spec.yaml', '--fail-on', 'sometimes']).status).toBe(2);
  });

  test('--upload posts { orgKey, apiName, report } with the API key, and prints the dashboard link', async () => {
    const http = require('http');
    let got = null;
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        got = { method: req.method, url: req.url, key: req.headers['x-api-key'], body: JSON.parse(body) };
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: 7, url: 'https://specshield.io/account/deprecations?api=Pets',
          changes: [{ key: 'GET /pets/{id}/photo', kind: 'operation', from: 'quiet', to: 'safe-to-remove', clients: 0 }] }));
      });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address();
    const { spawn } = require('child_process');
    const run = await new Promise((resolve) => {
      const p = spawn(process.execPath, [bin, 'deprecations', 'spec.yaml', '--upload', '--org', 'acme',
        '--server', `http://127.0.0.1:${port}`, '--api-token', 'ss_test'], { cwd: dir, env: noProxyEnv() });
      let stdout = '';
      p.stdout.on('data', (c) => { stdout += c; });
      p.on('close', (status) => resolve({ status, stdout }));
    });
    server.close();
    expect(run.status).toBe(0);
    expect(got).toMatchObject({ method: 'POST', url: '/api/deprecations/reports', key: 'ss_test' });
    expect(got.body).toMatchObject({ orgKey: 'acme', apiName: 'Pets' });
    expect(got.body.report.items.length).toBe(11);
    expect(run.stdout).toMatch(/Uploaded to acme \/ Pets/);
    expect(run.stdout).toMatch(/Since the last upload:\n\s+GET \/pets\/\{id\}\/photo\s+→ safe to remove/);
  });

  test('--upload without an org key explains what is missing', () => {
    const r = cli(['deprecations', 'spec.yaml', '--upload', '--api-token', 'x']);
    expect(r.status).toBe(2);
    expect(r.stderr + r.stdout).toMatch(/--upload needs an org key/);
  });
});
