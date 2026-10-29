'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const yaml = require('js-yaml');
const { spawn } = require('child_process');

const { compare } = require('../src/core/replay/shape');
const { loadTraffic } = require('../src/core/replay/traffic');
const { runReplay, classify, summarize } = require('../src/core/replay/runReplay');

const bin = path.join(__dirname, '..', 'bin', 'specshield.js');

const OLD_SPEC = yaml.load(`
openapi: 3.0.3
info: {title: Pay, version: "1"}
paths:
  /payments:
    get:
      responses:
        "200": {description: ok, content: {application/json: {schema: {type: array, items: {$ref: '#/components/schemas/P'}}}}}
    post:
      requestBody: {content: {application/json: {schema: {type: object}}}}
      responses: {"201": {description: ok}}
  /payments/{id}:
    get:
      parameters: [{name: id, in: path, required: true, schema: {type: string}}]
      responses:
        "200": {description: ok, content: {application/json: {schema: {$ref: '#/components/schemas/P'}}}}
components:
  schemas:
    P: {type: object, required: [id, amount], properties: {id: {type: string}, amount: {type: number}, receiptUrl: {type: string}}}
`);

// ─── shapes ─────────────────────────────────────────────────────────────────

describe('response shapes', () => {
  test('a missing field and a changed type are found; data differences are not', () => {
    expect(compare({ items: [{ id: 1, legacy: 'a', tag: null }], n: 3 }, { items: [{ id: '1', tag: 'x' }], n: 9 }))
      .toEqual({ missing: ['.items[].legacy'], changed: [{ path: '.items[].id', from: 'number', to: 'string' }] });
    expect(compare({ items: [{ id: 1 }] }, { items: [] })).toEqual({ missing: [], changed: [] });           // empty list: no data
    expect(compare({ a: { b: 1 } }, { a: null })).toEqual({ missing: [], changed: [] });                  // null parent: no data
    expect(compare({ byId: { 1: { a: 1 }, 2: { a: 2 } } }, { byId: { 7: { a: 3 }, 9: { a: 4 } } })).toEqual({ missing: [], changed: [] });
    expect(compare({ u: { name: 'a', addr: { city: 'x' } } }, { u: { name: 'a' } }).missing).toEqual(['.u.addr']);  // top-most only
  });
});

// ─── traffic ────────────────────────────────────────────────────────────────

function har(entries) {
  return JSON.stringify({ log: { version: '1.2', entries: entries.map(([method, url, status, resBody, reqBody]) => ({
    request: {
      method, url,
      headers: [
        { name: 'Authorization', value: 'Bearer captured-secret' }, { name: 'Cookie', value: 'sid=1' }, { name: 'X-Api-Key', value: 'k' },
        { name: 'Accept', value: 'application/json' }, { name: 'X-Api-Version', value: '1' }, { name: 'Host', value: 'prod' },
        ...(reqBody ? [{ name: 'Content-Type', value: 'application/json' }] : []),
      ],
      ...(reqBody ? { postData: { mimeType: 'application/json', text: JSON.stringify(reqBody) } } : {}),
    },
    response: { status, content: { mimeType: 'application/json', text: resBody === undefined ? '' : JSON.stringify(resBody) } },
  })) } });
}

describe('traffic', () => {
  let dir;
  beforeAll(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-traffic-')); });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  test('HAR: credentials and connection headers are never replayed; writes only when asked', async () => {
    const f = path.join(dir, 'a.har');
    fs.writeFileSync(f, har([['GET', 'https://prod/payments/1', 200, { id: '1', amount: 1 }], ['POST', 'https://prod/payments', 201, {}, { a: 1 }]]));
    const t = await loadTraffic([f], { spec: OLD_SPEC });
    expect(t.records).toHaveLength(1);
    expect(t.stats.mutatingSkipped).toBe(1);
    expect(t.records[0]).toMatchObject({ method: 'GET', path: '/payments/1', operation: 'GET /payments/{id}', matched: true });
    expect(t.records[0].headers).toEqual({ Accept: 'application/json', 'X-Api-Version': '1' });
    expect(t.records[0].recorded).toMatchObject({ status: 200, json: { id: '1', amount: 1 }, source: 'har' });
    const w = await loadTraffic([f], { includeMutating: true });
    expect(w.records.map((r) => r.method).sort()).toEqual(['GET', 'POST']);
  });

  test('sampling: every operation represented, capped, and the same seed picks the same requests', async () => {
    const f = path.join(dir, 'b.har');
    const entries = [];
    for (let i = 0; i < 200; i++) entries.push(['GET', `https://prod/payments/${i}`, 200, { id: String(i) }]);
    entries.push(['GET', 'https://prod/payments', 200, []]);
    fs.writeFileSync(f, har(entries));
    const a = await loadTraffic([f], { spec: OLD_SPEC, perOperation: 5, limit: 6, seed: 7 });
    expect(a.records).toHaveLength(6);
    expect(new Set(a.records.map((r) => r.operation))).toEqual(new Set(['GET /payments', 'GET /payments/{id}']));   // the rare one survives
    const b = await loadTraffic([f], { spec: OLD_SPEC, perOperation: 5, limit: 6, seed: 7 });
    expect(b.records.map((r) => r.path)).toEqual(a.records.map((r) => r.path));
    const c = await loadTraffic([f], { spec: OLD_SPEC, perOperation: 5, limit: 6, seed: 8 });
    expect(c.records.map((r) => r.path)).not.toEqual(a.records.map((r) => r.path));
  });

  test('access logs: reads with their status; writes are never rebuilt without a body', async () => {
    const f = path.join(dir, 'access.log');
    fs.writeFileSync(f, [
      '10.0.0.1 - - [29/Oct/2026:10:00:00 +0000] "GET /payments/7?expand=x HTTP/1.1" 200 12 "-" "app/1"',
      '10.0.0.1 - - [29/Oct/2026:10:00:01 +0000] "POST /payments HTTP/1.1" 201 12 "-" "app/1"',
    ].join('\n') + '\n');
    const t = await loadTraffic([f], { includeMutating: true });
    expect(t.records).toEqual([expect.objectContaining({ method: 'GET', path: '/payments/7', query: 'expand=x', recorded: expect.objectContaining({ status: 200, source: 'log' }) })]);
    expect(t.stats.bodilessWrites).toBe(1);
  });
});

// ─── verdicts ───────────────────────────────────────────────────────────────

describe('verdicts', () => {
  test.each([
    [{ status: 200 }, { status: 400 }, {}, 'broken'],
    [{ status: 200 }, { status: 500 }, {}, 'broken'],
    [{ status: 200 }, { status: 404 }, {}, 'inconclusive'],                          // missing data explains a 404 too
    [{ status: 200 }, { status: 404 }, { baseline: true }, 'broken'],                // same data on both builds
    [{ status: 200 }, { status: 404 }, { removed: true }, 'broken'],                 // gone from the new spec
    [{ status: 200 }, { status: 401 }, {}, 'inconclusive'],
    [{ status: 200 }, { status: 429 }, {}, 'inconclusive'],
    [{ status: 404 }, { status: 404 }, {}, 'ok'],
    [{ status: 500 }, { status: 200 }, {}, 'improved'],
    [{ status: 200, json: { a: 1, b: 2 } }, { status: 200, json: { a: 1 } }, {}, 'changed'],
    [{ status: 200, json: { a: 1 } }, { status: 200, json: { a: 5, c: 1 } }, {}, 'ok'],
  ])('%j → %j %j: %s', (ref, cand, opts, verdict) => {
    expect(classify(ref, cand, opts).verdict).toBe(verdict);
  });

  test('the old spec as the oracle catches a shape break even without a recorded body', async () => {
    const rec = { method: 'GET', path: '/payments/1', query: '', headers: {}, body: null, recorded: { status: 200, json: undefined, source: 'log' }, operation: 'GET /payments/{id}' };
    const http = async () => ({ status: 200, json: { id: '1', amount: '12.50' }, text: '' });
    const [r] = await runReplay([rec], { against: 'http://x', http, oldSpec: OLD_SPEC });
    expect(r.verdict).toBe('changed');
    expect(r.detail).toBe('breaks the old contract: response.amount must be number');
    const s = summarize([r]);
    expect(s.totals.changed).toBe(1);
    expect(s.operations[0].examples).toHaveLength(1);
  });
});

// ─── the command, against two real servers ──────────────────────────────────

function server(handler) {
  const seen = [];
  const s = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body });
      const send = (code, v) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(v === undefined ? '' : JSON.stringify(v)); };
      handler(req, body, send);
    });
  });
  return new Promise((resolve) => s.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${s.address().port}`, close: () => s.close(), seen })));
}

function run(args, cwd) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [bin, ...args], { cwd, env: { ...process.env, FORCE_COLOR: '0', GITHUB_ACTIONS: '' } });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('close', (code) => resolve({ code, out, err }));
  });
}

describe('specshield replay', () => {
  let dir;
  let oldBuild;
  let newBuild;
  const pay = (id, amount, extra = {}) => ({ id, amount, receiptUrl: `https://r/${id}`, ...extra });

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-cmd-'));
    oldBuild = await server((req, body, send) => {
      if (req.url === '/payments') return req.method === 'POST' ? send(201, pay('9', 1)) : send(200, [pay('1', 1), pay('2', 2)]);
      if (req.url.startsWith('/payments/')) return send(200, pay(req.url.split('/').pop(), 1));
      return send(404, {});
    });
    // The new build drops receiptUrl, returns amount as a string, and requires "channel" on POST.
    newBuild = await server((req, body, send) => {
      const strip = (p) => ({ id: p.id, amount: String(p.amount) });
      if (req.url === '/payments' && req.method === 'POST') return JSON.parse(body || '{}').channel ? send(201, strip(pay('9', 1))) : send(400, { error: 'channel is required' });
      if (req.url === '/payments') return send(200, [strip(pay('1', 1)), strip(pay('2', 2))]);
      if (req.url.startsWith('/payments/')) return send(200, strip(pay(req.url.split('/').pop(), 1)));
      return send(404, {});
    });
    fs.writeFileSync(path.join(dir, 'old.yaml'), yaml.dump(OLD_SPEC));
    fs.writeFileSync(path.join(dir, 'traffic.har'), har([
      ['GET', 'https://prod/payments', 200, [pay('1', 1)]],
      ['GET', 'https://prod/payments/1?expand=customer', 200, pay('1', 1)],
      ['POST', 'https://prod/payments', 201, pay('9', 1), { amount: 1 }],
    ]));
  });
  afterAll(() => { oldBuild.close(); newBuild.close(); fs.rmSync(dir, { recursive: true, force: true }); });

  test('side by side with the old build: broken writes, changed reads, exit 1; captured credentials never sent', async () => {
    const r = await run(['replay', '--from', 'traffic.har', '--against', newBuild.url, '--baseline', oldBuild.url, '--include-mutating', '--json', '--header', 'Authorization: Bearer test-token'], dir);
    expect(r.code).toBe(1);
    const j = JSON.parse(r.out);
    expect(j.totals).toMatchObject({ broken: 1, changed: 2 });
    const post = j.operations.find((o) => o.operation.startsWith('POST'));
    expect(post.examples[0]).toMatchObject({ verdict: 'broken', detail: 'worked before (HTTP 201), fails now (HTTP 400)' });
    const get = j.operations.find((o) => o.operation === 'GET /payments');
    expect(get.examples[0].missing).toEqual(['[].receiptUrl']);
    expect(get.examples[0].changed).toEqual([{ path: '[].amount', from: 'number', to: 'string' }]);
    // What reached the servers: our header, never the captured ones.
    for (const s of [oldBuild, newBuild]) {
      for (const req of s.seen) {
        expect(req.headers.authorization).toBe('Bearer test-token');
        expect(req.headers.cookie).toBeUndefined();
        expect(req.headers['x-api-key']).toBeUndefined();
      }
    }
    expect(newBuild.seen.find((x) => x.method === 'POST').body).toBe('{"amount":1}');
  });

  test('against the recorded responses, reads only; query values hidden unless asked', async () => {
    const r = await run(['replay', '--from', 'traffic.har', '--against', newBuild.url], dir);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/Compared {3}with the recorded responses/);
    expect(r.out).toMatch(/1 write not replayed/);
    expect(r.out).toMatch(/GET \/payments\/1\?expand=…/);
    expect(r.out).toMatch(/missing receiptUrl; amount number → string/);
    const shown = await run(['replay', '--from', 'traffic.har', '--against', newBuild.url, '--show-values'], dir);
    expect(shown.out).toMatch(/GET \/payments\/1\?expand=customer/);
  });

  test('nothing broke: exit 0', async () => {
    const r = await run(['replay', '--from', 'traffic.har', '--against', oldBuild.url, '--baseline', oldBuild.url], dir);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/No request that worked before fails now/);
  });

  test('refuses public hosts without --allow-remote, and reports an unreachable build', async () => {
    const remote = await run(['replay', '--from', 'traffic.har', '--against', 'https://api.example.com'], dir);
    expect(remote.code).toBe(2);
    expect(remote.err).toMatch(/--allow-remote/);
    const down = await run(['replay', '--from', 'traffic.har', '--against', 'http://127.0.0.1:1'], dir);
    expect(down.code).toBe(2);
    expect(down.err).toMatch(/Can't reach the build/);
  });
});
