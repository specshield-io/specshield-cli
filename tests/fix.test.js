'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { parseSpec } = require('../src/core/parseSpec');
const { normalizeSpec } = require('../src/core/normalizeSpec');
const { diffSpecs } = require('../src/core/diffEngine');
const { BREAKING_TYPES } = require('../src/core/classifyChanges');
const L = require('../src/core/fix/locate');
const { applyOps, applyOpsToText } = require('../src/core/fix/ops');
const { fixSpec } = require('../src/core/fix/fixSpec');
const { buildShim, applyTransforms, convert } = require('../src/core/fix/shim/transforms');
const { generateSpring } = require('../src/core/fix/shim/spring');

const SPECS = path.join(__dirname, '..', 'test-harness', 'spring-compat', 'specs');
const baseText = fs.readFileSync(path.join(SPECS, 'base.yaml'), 'utf8');
const targetText = fs.readFileSync(path.join(SPECS, 'target.yaml'), 'utf8');
const base = () => parseSpec(baseText, 'base.yaml');
const target = () => parseSpec(targetText, 'target.yaml');
const plain = (x) => JSON.parse(JSON.stringify(x));
const breakingOf = (a, b) => diffSpecs(normalizeSpec(a), normalizeSpec(b)).filter((d) => BREAKING_TYPES.has(d.type));

describe('locate', () => {
  test('parses diff field paths', () => {
    expect(L.parseField('responses.200.items[items].tag')).toEqual(
      { side: 'response', code: '200', steps: [{ prop: 'items' }, { items: true }, { prop: 'tag' }] });
    expect(L.parseField('requestBody.meta.<*>.label').steps).toEqual([{ prop: 'meta' }, { map: true }, { prop: 'label' }]);
    expect(L.parseField('responses.default.data.oneOf[1].x').steps).toEqual(
      [{ prop: 'data' }, { variant: 'oneOf', index: 1 }, { prop: 'x' }]);
    expect(L.parseField('components.schemas.X')).toBeNull();
  });

  test('finds a field through $ref and allOf, pointing into the shared component', () => {
    const doc = {
      openapi: '3.0.3',
      paths: { '/p': { get: { responses: { 200: { content: { 'application/json': { schema: { $ref: '#/components/schemas/Pet' } } } } } } } },
      components: { schemas: {
        Pet: { allOf: [{ $ref: '#/components/schemas/Named' }, { properties: { tag: { type: 'string' } } }] },
        Named: { properties: { name: { type: 'string' } } },
      } },
    };
    expect(L.fieldPtr(doc, 'get', '/p', 'responses.200.name')).toEqual(['components', 'schemas', 'Named', 'properties', 'name']);
    expect(L.fieldPtr(doc, 'get', '/p', 'responses.200.tag')).toEqual(['components', 'schemas', 'Pet', 'allOf', 1, 'properties', 'tag']);
    // A removed property goes back into the composed schema's own part.
    expect(L.parentObjectPtr(doc, 'get', '/p', 'responses.200.gone')).toEqual(['components', 'schemas', 'Pet', 'allOf', 1]);
  });

  test('Swagger 2.0 body parameters and response schemas', () => {
    const doc = {
      swagger: '2.0',
      paths: { '/a': { post: { parameters: [{ name: 'b', in: 'body', schema: { $ref: '#/definitions/A' } }],
        responses: { 200: { schema: { $ref: '#/definitions/A' } } } } } },
      definitions: { A: { properties: { x: { type: 'string' } } } },
    };
    expect(L.fieldPtr(doc, 'post', '/a', 'requestBody.x')).toEqual(['definitions', 'A', 'properties', 'x']);
    expect(L.fieldPtr(doc, 'post', '/a', 'responses.200.x')).toEqual(['definitions', 'A', 'properties', 'x']);
  });
});

describe('ops', () => {
  const yaml = [
    'openapi: 3.0.3',
    'paths:',
    '  /a:',
    '    get:',
    '      # why this is required',
    '      parameters: [{ name: q, in: query, required: true }]',
    '      responses:',
    '        200: { description: ok }   # numeric key, kept as is',
    '',
  ].join('\n');

  test('YAML: edits land in place; untouched lines and comments stay byte-for-byte', () => {
    const out = applyOpsToText(yaml, [
      { op: 'set', path: ['paths', '/a', 'get', 'responses', '404'], value: { description: 'missing' } },
      { op: 'set', path: ['paths', '/a', 'get', 'deprecated'], value: true },
    ]);
    const before = yaml.split('\n');
    const after = out.split('\n');
    for (const line of before.filter(Boolean)) expect(after).toContain(line);
    expect(out).toMatch(/['"]404['"]:\n\s+description: missing/);
    expect(parseSpec(out, 'x.yaml').paths['/a'].get.responses['404'].description).toBe('missing');
  });

  test('push / pull / insert on arrays, also through a numeric YAML key', () => {
    const doc = { required: ['a', 'b'], list: [1, 3] };
    applyOps(doc, [
      { op: 'pull', path: ['required'], value: 'a' },
      { op: 'push', path: ['required'], value: 'b' },
      { op: 'insert', path: ['list'], index: 1, value: 2 },
      { op: 'pull', path: ['required'], value: 'b' },
    ]);
    expect(doc).toEqual({ list: [1, 2, 3] });
    const out = applyOpsToText(yaml, [{ op: 'set', path: ['paths', '/a', 'get', 'responses', '200', 'description'], value: 'fine' }]);
    expect(out).toMatch(/200: \{ ?description: fine ?\}/);
  });

  test('JSON keeps its indentation', () => {
    const out = applyOpsToText('{\n    "a": 1\n}\n', [{ op: 'set', path: ['b'], value: 2 }], { json: true });
    expect(out).toBe('{\n    "a": 1,\n    "b": 2\n}\n');
  });
});

describe('fixSpec on a realistic payments change', () => {
  const r = fixSpec(base(), target(), { sunset: '2027-03-31' });
  const by = (strategy) => r.suggestions.filter((s) => s.strategy === strategy);

  test('fixes 14 of 16 breaking changes; the list moved into an envelope is left for the version layer', () => {
    expect(r.before).toBe(16);
    expect(r.after).toBe(2);
    expect(r.remaining.map((c) => c.type).sort()).toEqual(['RESPONSE_FIELD_REMOVED', 'RESPONSE_TYPE_CHANGED']);
    const manual = r.suggestions.find((s) => s.status === 'manual' && /moved into `data`/.test(s.reason));
    expect(manual.transforms.map((t) => t.kind)).toContain('unwrap');
  });

  test('the fixed spec has no breaking change against the old one, except the reshaped list', () => {
    const left = breakingOf(base(), r.fixedDoc);
    expect(left.every((d) => d.method === 'get' && d.path === '/payments')).toBe(true);
    expect(left).toHaveLength(2);
  });

  test('a rename keeps both names; the removed enum value comes back as a second-round fix', () => {
    expect(by('keep-both-names').map((s) => s.title)).toEqual([
      '`status` was renamed to `paymentStatus`: accept both, `status` deprecated',
      '`status` was renamed to `paymentStatus`: return both, `status` deprecated',
    ]);
    const payment = r.fixedDoc.components.schemas.Payment;
    expect(payment.properties.status).toMatchObject({ $ref: '#/components/schemas/Status', deprecated: true, 'x-sunset': '2027-03-31' });
    expect(payment.required).toEqual(['id', 'paymentStatus', 'status']);
    expect(r.fixedDoc.components.schemas.Status.enum).toEqual(['PENDING', 'ACTIVE', 'FAILED', 'ENABLED']);
    expect(by('restore-enum-value')[0].title).toMatch(/"ENABLED".*renamed to "ACTIVE"/);
  });

  test('new required input becomes optional again; removed things come back deprecated', () => {
    expect(r.fixedDoc.components.schemas.NewPayment.required).toEqual(['amount']);
    expect(r.fixedDoc.paths['/payments'].get.parameters.find((p) => p.name === 'limit').required).toBe(false);
    expect(r.fixedDoc.paths['/payments'].get.parameters.find((p) => p.name === 'legacy')).toMatchObject({ deprecated: true, required: false });
    expect(r.fixedDoc.paths['/payments/{id}/receipt'].get.deprecated).toBe(true);
    expect(r.fixedDoc.paths['/payments/{id}'].get.responses['404']).toEqual({ description: 'not found' });
  });

  test('a response type change keeps the old type and adds the new one as a new field', () => {
    const amount = r.fixedDoc.components.schemas.Payment.properties;
    expect(amount.amount).toMatchObject({ type: 'integer', deprecated: true });
    expect(amount.amountV2).toEqual({ type: 'string' });
  });

  test('the text written to the file is exactly the verified document', () => {
    const written = parseSpec(applyOpsToText(targetText, r.ops), 'out.yaml');
    expect(plain(written)).toEqual(plain(r.fixedDoc));
    expect(applyOpsToText(targetText, r.ops)).toContain('# limit is now mandatory to protect the DB');
  });
});

describe('fixSpec: guesses it must not make', () => {
  const spec = (props, enumValues) => ({
    openapi: '3.0.3',
    info: { title: 't', version: '1' },
    paths: { '/x': { get: { responses: { 200: { description: 'ok', content: { 'application/json': {
      schema: { type: 'object', properties: { ...props, kind: { type: 'string', enum: enumValues } } } } } } } } } },
  });

  test('a field is not "renamed" to an unrelated one of the same type (real GitHub case)', () => {
    const r = fixSpec(spec({ budget_type: { type: 'string' } }, ['a']), spec({ expires_at: { type: 'string' } }, ['a']));
    expect(r.suggestions.map((s) => s.strategy)).toEqual(['restore-deprecated-field']);
  });

  test('a shared filler word ("on") is not a relation; a shared real word is', () => {
    let r = fixSpec(spec({ do_not_enforce_on_create: { type: 'boolean' } }, ['a']), spec({ review_on_push: { type: 'boolean' } }, ['a']));
    expect(r.suggestions[0].strategy).toBe('restore-deprecated-field');
    r = fixSpec(spec({ created_at: { type: 'string' } }, ['a']), spec({ createdAt: { type: 'string' } }, ['a']));
    expect(r.suggestions[0].strategy).toBe('keep-both-names');
  });

  test('a single-value enum (a constant) changing is not an enum rename', () => {
    const r = fixSpec(spec({}, ['github_resource']), spec({}, ['pull']));
    expect(r.suggestions[0].title).not.toMatch(/renamed/);
    expect(r.suggestions[0].transforms).toEqual([]);
  });

  test('a format-only change (integer → int64) keeps the old format and adds no field', () => {
    const r = fixSpec(spec({ id: { type: 'integer' } }, ['a']), spec({ id: { type: 'integer', format: 'int64' } }, ['a']));
    const s = r.suggestions.find((x) => x.strategy === 'keep-old-format');
    expect(s.status).toBe('verified');
    expect(r.fixedDoc.paths['/x'].get.responses[200].content['application/json'].schema.properties).not.toHaveProperty('idV2');
  });
});

describe('version transforms', () => {
  const r = fixSpec(base(), target());
  const shim = buildShim(r, base(), target());

  test('every transform for the payments change is verified against the old schema', () => {
    expect(shim.skipped).toEqual([]);
    const kinds = shim.transforms.map((t) => `${t.method} ${t.path} ${t.side} ${t.kind}`);
    expect(kinds).toEqual(expect.arrayContaining([
      'GET /payments response unwrap', 'GET /payments response rename',
      'POST /payments request rename', 'POST /payments request enum', 'POST /payments request default',
      'GET /payments/{id} response convert', 'GET /payments/{id} response enum',
    ]));
    expect(shim.transforms).toHaveLength(13);
  });

  test('old clients get the old shape back; old requests are upgraded', () => {
    const forOp = (m, p, side) => shim.transforms.filter((t) => t.method === m && t.path === p && t.side === side);
    expect(applyTransforms({ data: [{ id: 'p1', paymentStatus: 'ACTIVE', amount: '1250' }], next: null }, forOp('GET', '/payments', 'response')))
      .toEqual([{ id: 'p1', status: 'ENABLED', amount: 1250 }]);
    expect(applyTransforms({ amount: 5, status: 'ENABLED' }, forOp('POST', '/payments', 'request')))
      .toEqual({ amount: 5, paymentStatus: 'ACTIVE', currency: 'EUR' });
  });

  test('a removed required field that is not a rename cannot be shimmed, and says why', () => {
    const b = { openapi: '3.0.3', info: { version: '1' }, paths: { '/x': { get: { responses: { 200: { description: '', content: { 'application/json': {
      schema: { type: 'object', required: ['a', 'n'], properties: { a: { type: 'string' }, n: { type: 'integer' } } } } } } } } } } };
    const t = JSON.parse(JSON.stringify(b));
    const s = t.paths['/x'].get.responses[200].content['application/json'].schema;
    delete s.properties.a;
    s.required = ['n'];
    s.properties.n = { type: 'string' };
    const sh = buildShim(fixSpec(b, t), b, t);
    expect(sh.transforms).toEqual([]);
    expect(sh.skipped[0]).toMatch(/required property 'a'.*no longer produces a field old clients require/);
  });

  test('conversions only happen when the value has a faithful form', () => {
    expect(convert('12', 'integer')).toBe(12);
    expect(convert('12.5', 'integer')).toBe('12.5');
    expect(convert('abc', 'number')).toBe('abc');
    expect(convert(1.5, 'string')).toBe('1.5');
    expect(convert('false', 'boolean')).toBe(false);
    expect(convert('yes', 'boolean')).toBe('yes');
  });
});

describe('Spring Boot generation', () => {
  test('writes the runtime and one class per version, with inferred renames flagged', async () => {
    const r = fixSpec(base(), target());
    const shim = buildShim(r, base(), target());
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-spring-'));
    const files = await generateSpring(shim, { dir, pkg: 'com.acme.compat', header: 'X-API-Version', version: '2.0.0', basePath: '/v1' });
    expect(files.map((f) => path.basename(f)).sort()).toEqual([
      'ApiVersion_2_0_0.java', 'CompatEngine.java', 'CompatRequestAdvice.java', 'CompatResponseAdvice.java',
      'CompatTransform.java', 'CompatVersion.java',
    ]);
    const v = fs.readFileSync(path.join(dir, 'com', 'acme', 'compat', 'ApiVersion_2_0_0.java'), 'utf8');
    expect(v).toMatch(/^\/\/ Generated by SpecShield/);
    expect(v).toContain('package com.acme.compat;');
    expect(v).toContain('CompatTransform.responseUnwrap("GET", "/payments", "200", CompatTransform.steps(), "data")');
    expect(v).toContain('/* inferred rename — check */ CompatTransform.requestRename("POST", "/payments", null, CompatTransform.steps(), "status", "paymentStatus")');
    expect(v).toContain('CompatTransform.requestDefault("POST", "/payments", null, CompatTransform.steps(), "currency", "\\"EUR\\"")');
    const advice = fs.readFileSync(path.join(dir, 'com', 'acme', 'compat', 'CompatResponseAdvice.java'), 'utf8');
    expect(advice).toContain('${specshield.compat.header:X-API-Version}');
    expect(advice).toContain('${specshield.compat.base-path:/v1}');
  });

  test('rejects a package name that is not Java', async () => {
    await expect(generateSpring({ transforms: [] }, { dir: os.tmpdir(), pkg: 'com.acme-api', version: '1' })).rejects.toThrow(/not a Java package/);
  });
});

describe('specshield fix (CLI)', () => {
  const bin = path.join(__dirname, '..', 'bin', 'specshield.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-fix-'));
  fs.writeFileSync(path.join(dir, 'base.yaml'), baseText);
  fs.writeFileSync(path.join(dir, 'target.yaml'), targetText);
  const cli = (args) => spawnSync(process.execPath, [bin, ...args], { cwd: dir, encoding: 'utf8', env: { ...process.env, CI: '1', FORCE_COLOR: '0' } });

  test('writes <target>.fixed.yaml, reports the fixes, exits 1 while something still needs a decision', () => {
    const r = cli(['fix', 'base.yaml', 'target.yaml']);
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/16 breaking changes · 14 fixed · 2 need a decision/);
    expect(r.stdout).toMatch(/Wrote target\.fixed\.yaml \(12 edits, comments and layout kept\)/);
    expect(fs.readFileSync(path.join(dir, 'target.fixed.yaml'), 'utf8')).toContain('# renamed from status');
  });

  test('--dry-run writes nothing; --json is machine-readable; --spring generates Java', () => {
    fs.rmSync(path.join(dir, 'target.fixed.yaml'), { force: true });
    expect(cli(['fix', 'base.yaml', 'target.yaml', '--dry-run']).stdout).toMatch(/--dry-run: nothing written/);
    expect(fs.existsSync(path.join(dir, 'target.fixed.yaml'))).toBe(false);
    const j = JSON.parse(cli(['fix', 'base.yaml', 'target.yaml', '--json', '--spring', 'java', '--package', 'com.x']).stdout);
    expect(j).toMatchObject({ before: 16, after: 2 });
    expect(j.spring.files).toHaveLength(6);
    expect(fs.existsSync(path.join(dir, 'java', 'com', 'x', 'CompatEngine.java'))).toBe(true);
  });

  test('a compatible change exits 0; bad options exit 2', () => {
    expect(cli(['fix', 'base.yaml', 'base.yaml']).status).toBe(0);
    expect(cli(['fix', 'base.yaml', 'target.yaml', '--sunset', 'soon']).status).toBe(2);
    expect(cli(['fix', 'base.yaml', 'target.yaml', '--write', '--out', 'x.yaml']).status).toBe(2);
  });
});
