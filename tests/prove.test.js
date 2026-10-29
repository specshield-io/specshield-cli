'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const yaml = require('js-yaml');
const { spawn } = require('child_process');

const S = require('../src/core/prove/schema');
const I = require('../src/core/prove/instance');
const C = require('../src/core/prove/contract');
const SS = require('../src/core/prove/subschema');
const W = require('../src/core/prove/witness');
const { prove } = require('../src/core/prove');
const { confirmAll, judge } = require('../src/core/prove/execute');
const H = require('../src/core/prove/http');
const R = require('../src/core/prove/render');

const bin = path.join(__dirname, '..', 'bin', 'specshield.js');
const doc = (s) => yaml.load(s);

// ─── fixtures ───────────────────────────────────────────────────────────────

const OLD = doc(`
openapi: 3.0.3
info: {title: Orders, version: "1"}
paths:
  /orders:
    get:
      parameters:
        - {name: limit, in: query, schema: {type: integer, maximum: 100}}
        - {name: sort, in: query, schema: {type: string}}
      responses:
        "200":
          description: ok
          content: {application/json: {schema: {type: array, items: {$ref: '#/components/schemas/Order'}}}}
    post:
      requestBody:
        required: true
        content: {application/json: {schema: {$ref: '#/components/schemas/NewOrder'}}}
      responses:
        "201": {description: created, content: {application/json: {schema: {$ref: '#/components/schemas/Order'}}}}
  /orders/{id}:
    get:
      parameters: [{name: id, in: path, required: true, schema: {type: integer}}]
      responses:
        "200": {description: ok, content: {application/json: {schema: {$ref: '#/components/schemas/Order'}}}}
    delete:
      parameters: [{name: id, in: path, required: true, schema: {type: integer}}]
      responses: {"204": {description: gone}}
components:
  schemas:
    NewOrder:
      type: object
      required: [sku, quantity]
      properties:
        sku: {type: string, pattern: '^[A-Z]{3}-\\d{4}$'}
        quantity: {type: integer, minimum: 1}
        note: {type: string, maxLength: 200}
        gift: {type: boolean}
    Order:
      type: object
      required: [id, status, legacy_id]
      properties:
        id: {type: integer}
        status: {type: string, enum: [open, shipped, cancelled]}
        legacy_id: {type: string}
        coupon: {type: string}
        total: {type: number}
`);

const NEW = doc(`
openapi: 3.0.3
info: {title: Orders, version: "2"}
paths:
  /orders:
    get:
      parameters:
        - {name: limit, in: query, schema: {type: integer, maximum: 50}}
      responses:
        "200":
          description: ok
          content: {application/json: {schema: {type: array, items: {$ref: '#/components/schemas/Order'}}}}
    post:
      requestBody:
        required: true
        content: {application/json: {schema: {$ref: '#/components/schemas/NewOrder'}}}
      responses:
        "201": {description: created, content: {application/json: {schema: {$ref: '#/components/schemas/Order'}}}}
  /orders/{id}:
    get:
      parameters: [{name: id, in: path, required: true, schema: {type: integer}}]
      responses:
        "200": {description: ok, content: {application/json: {schema: {$ref: '#/components/schemas/Order'}}}}
components:
  schemas:
    NewOrder:
      type: object
      required: [sku, quantity, channel]
      additionalProperties: false
      properties:
        sku: {type: string, pattern: '^[A-Z]{3}-\\d{4}$'}
        quantity: {type: string}
        note: {type: string, maxLength: 100}
        channel: {type: string, enum: [web, app]}
    Order:
      type: object
      required: [id, status, total]
      properties:
        id: {type: string}
        status: {type: string, enum: [open, shipped]}
        total: {type: number}
`);

function proofs(a = OLD, b = NEW) {
  return W.proveAll(a, b);
}

function find(list, type, field, method) {
  return list.find(({ diff }) => diff.type === type && (field === undefined || diff.field === field) && (!method || diff.method === method));
}

// ─── instances ──────────────────────────────────────────────────────────────

describe('instances', () => {
  test('strings matching a pattern, at an exact length', () => {
    expect(I.fromPattern('^[A-Z]{3}-\\d{4}$')).toBe('AAA-1111');
    expect(I.fromPattern('^[0-9a-fA-F]+$', { min: 40, max: 40 })).toHaveLength(40);
    expect(I.fromPattern('^(GET|POST)$')).toBe('GET');
    expect(I.fromPattern('[0-9]+', { min: 5 })).toMatch(/^[0-9]+/);
    expect(I.fromPattern('^v\\d+(\\.\\d+){2}$')).toBe('v1.1.1');
    // Lookarounds and backreferences aren't guessed at.
    expect(I.fromPattern('^(?=a)b')).toBeNull();
    expect(I.fromPattern('^(a)\\1$')).toBeNull();
    for (const [p, o] of [['^[a-z0-9_-]{3,16}$', { min: 10 }], ['^[^@]+@[^@]+\\.[a-z]{2,}$', {}], ['^\\+?[1-9]\\d{1,14}$', {}]]) {
      expect(I.fromPattern(p, o)).toMatch(new RegExp(p));
    }
  });

  test('lengths keep the format valid', () => {
    expect(I.ofLength('https://example.com/a', 'uri', 513, 513)).toMatch(/^https:\/\/example\.com\/a/);
    expect(I.ofLength('https://example.com/a', 'uri', 513, 513)).toHaveLength(513);
    expect(I.ofLength('jane@example.com', 'email', 30, 30)).toMatch(/@example\.com$/);
  });

  test('a target value lands at its location; OMIT leaves it out', () => {
    const d = OLD;
    const schema = d.components.schemas.NewOrder;
    expect(I.generate(d, schema, { target: { steps: [{ prop: 'quantity' }], value: 7 } }).quantity).toBe(7);
    expect(I.generate(d, schema, { target: { steps: [{ prop: 'sku' }], value: I.OMIT } })).not.toHaveProperty('sku');
    // An optional property on the target's path is included even when not "full".
    expect(I.generate(d, schema, { target: { steps: [{ prop: 'gift' }], value: false } }).gift).toBe(false);
  });

  test('oneOf: the branch named on the target path, with its discriminator value', () => {
    const d = doc(`
components:
  schemas:
    Pet:
      oneOf: [{$ref: '#/components/schemas/Cat'}, {$ref: '#/components/schemas/Dog'}]
      discriminator: {propertyName: kind, mapping: {cat: '#/components/schemas/Cat', dog: '#/components/schemas/Dog'}}
    Cat: {type: object, required: [kind, lives], properties: {kind: {type: string}, lives: {type: integer}}}
    Dog: {type: object, required: [kind, bark], properties: {kind: {type: string}, bark: {type: boolean}}}
`);
    const v = I.generate(d, d.components.schemas.Pet, { target: { steps: [{ variant: 'oneOf', index: 1 }, { prop: 'bark' }], value: false } });
    expect(v).toEqual({ kind: 'dog', bark: false });
  });

  test('readOnly fields stay out of requests, writeOnly out of responses', () => {
    const d = doc(`
components:
  schemas:
    U: {type: object, required: [id, password], properties: {id: {type: integer, readOnly: true}, password: {type: string, writeOnly: true}}}
`);
    expect(I.generate(d, d.components.schemas.U, { side: 'request' })).toEqual({ password: 'abc' });
    expect(I.generate(d, d.components.schemas.U, { side: 'response' })).toEqual({ id: 1 });
  });

  test('recursive schemas stay small, even in "full" mode', () => {
    const d = doc(`
components:
  schemas:
    Node:
      type: object
      properties:
        a: {$ref: '#/components/schemas/Node'}
        b: {$ref: '#/components/schemas/Node'}
        c: {type: array, items: {$ref: '#/components/schemas/Node'}}
        name: {type: string}
`);
    const v = I.generate(d, d.components.schemas.Node, { full: true });
    expect(JSON.stringify(v).length).toBeLessThan(5000);
  });
});

// ─── validation ─────────────────────────────────────────────────────────────

describe('validation against the spec as written', () => {
  test('OpenAPI 3.0 nullable, boolean exclusiveMinimum, readOnly-required', () => {
    const d = doc(`
components:
  schemas:
    T:
      type: object
      required: [id, n]
      properties:
        id: {type: integer, readOnly: true}
        n: {type: number, minimum: 0, exclusiveMinimum: true, nullable: true}
`);
    const v = S.validator(d, d.components.schemas.T, { side: 'request' });
    expect(v({ n: null }).ok).toBe(true);                     // nullable; id is readOnly so not required in a request
    expect(v({ n: 0 }).ok).toBe(false);                       // exclusive
    expect(v({ n: 0.1 }).ok).toBe(true);
    expect(S.validator(d, d.components.schemas.T, { side: 'response' })({ n: 1 }).ok).toBe(false);
  });

  test('a failed union reads as one line, with its branch noise dropped', () => {
    const d = doc(`
components:
  schemas:
    T: {type: object, properties: {type: {oneOf: [{type: string}, {$ref: '#/components/schemas/O'}]}}}
    O: {type: object, required: [a], properties: {a: {type: string}}}
`);
    const r = S.validator(d, d.components.schemas.T)({ type: null });
    expect(r.errors.map((e) => S.describeError(e))).toEqual(['body.type matches none of the allowed forms']);
  });

  test('parameters are read like a server reads them: text parsed into the declared type', () => {
    const v = S.validator({}, { type: 'integer', maximum: 50 }, { kind: 'param' });
    expect(v('10').ok).toBe(true);
    expect(v('abc').ok).toBe(false);
    expect(v('51').ok).toBe(false);
  });
});

// ─── subschema check ────────────────────────────────────────────────────────

describe('subschema check (sound: true only when every instance stays valid)', () => {
  const w = (a, b, opts, d = {}) => SS.widens({ doc: d, node: a }, { doc: d, node: b }, opts);

  test('widenings', () => {
    expect(w({ type: 'integer' }, { type: 'number' })).toBe(true);
    expect(w({ type: 'string', enum: ['a'] }, { type: 'string', enum: ['a', 'b'] })).toBe(true);
    expect(w({ type: 'string', maxLength: 5 }, { type: 'string', maxLength: 10 })).toBe(true);
    expect(w({ type: 'object', required: ['a', 'b'], properties: { a: {}, b: {} } }, { type: 'object', required: ['a'], properties: { a: {}, b: {} } })).toBe(true);
    expect(w({ type: 'integer' }, { type: 'integer', format: 'int64' })).toBe(true);
    expect(w({ type: 'string' }, { anyOf: [{ type: 'string' }, { type: 'object' }] })).toBe(true);
  });

  test('narrowings', () => {
    expect(w({ type: 'number' }, { type: 'integer' })).toBe(false);
    expect(w({ type: 'string', enum: ['a', 'b'] }, { type: 'string', enum: ['a'] })).toBe(false);
    expect(w({ type: 'string', maxLength: 10 }, { type: 'string', maxLength: 5 })).toBe(false);
    expect(w({ type: 'object', properties: { a: {} } }, { type: 'object', required: ['a'], properties: { a: {} } })).toBe(false);
    expect(w({ type: 'string' }, { type: 'string', pattern: '^a' })).toBe(false);
    expect(w({ type: 'integer' }, { type: 'integer', format: 'int32' })).toBe(false);
  });

  test('a new optional property: compatible in a closed world, not without it', () => {
    const a = { type: 'object', properties: { x: { type: 'string' } } };
    const b = { type: 'object', properties: { x: { type: 'string' }, y: { type: 'integer' } } };
    expect(w(a, b)).toBe(true);
    expect(w(a, b, { closedWorld: false })).toBe(false);
  });

  test('unions: a branch must take all of `from`; oneOf only when its branches cannot overlap', () => {
    expect(w({ type: 'integer' }, { oneOf: [{ type: 'string' }, { type: 'number' }] })).toBe(true);
    expect(w({ type: 'integer' }, { oneOf: [{ type: 'number' }, { type: 'number', minimum: 0 }] })).toBe(false);
    expect(w({ anyOf: [{ type: 'string' }, { type: 'integer' }] }, { anyOf: [{ type: 'integer' }, { type: 'string' }, { type: 'boolean' }] })).toBe(true);
    expect(w({ anyOf: [{ type: 'string' }, { type: 'object' }] }, { anyOf: [{ type: 'string' }] })).toBe(false);
    expect(w({ type: 'string', not: { const: 'x' } }, { type: 'string' })).toBe(false);          // unmodelled keyword on one side only
  });

  test('a oneOf branch pinned by a discriminator value is exclusive', () => {
    const b = (t) => ({ type: 'object', required: ['kind'], properties: { kind: { enum: [t] } } });
    expect(SS.exclusiveIn({}, b('a'), [b('b'), b('c')])).toBe(true);
    expect(SS.exclusiveIn({}, b('a'), [b('a')])).toBe(false);
    expect(SS.exclusiveIn({}, b('a'), [{ type: 'object' }])).toBe(false);
  });

  test('recursive schemas are compared coinductively, through $refs', () => {
    const d = doc(`
components:
  schemas:
    A: {type: object, properties: {next: {$ref: '#/components/schemas/A'}, v: {type: integer}}}
    B: {type: object, properties: {next: {$ref: '#/components/schemas/B'}, v: {type: number}}}
`);
    expect(SS.widens({ doc: d, node: { $ref: '#/components/schemas/A' } }, { doc: d, node: { $ref: '#/components/schemas/B' } })).toBe(true);
    expect(SS.widens({ doc: d, node: { $ref: '#/components/schemas/B' } }, { doc: d, node: { $ref: '#/components/schemas/A' } })).toBe(false);
  });
});

// ─── witnesses ──────────────────────────────────────────────────────────────

describe('witnesses', () => {
  const all = proofs();

  test('every proof is accepted by the old contract and rejected by the new one — checked again here', () => {
    const proven = all.filter((p) => p.witness.status === 'proven');
    expect(proven.length).toBeGreaterThanOrEqual(8);
    for (const { diff, witness } of proven) {
      expect(witness.why.length).toBeGreaterThan(0);
      if (witness.side !== 'request' || witness.focus === 'operation') continue;
      const req = { method: witness.request.method, path: diff.path, params: paramsOf(witness.request), body: witness.request.body === null ? undefined : witness.request.body };
      expect(C.checkRequest(C.contractOf(OLD, diff.method, diff.path), req)).toEqual([]);
      expect(C.checkRequest(C.contractOf(NEW, diff.method, diff.path), req).length).toBeGreaterThan(0);
    }
  });

  test('a new required field: the old request without it, with a control that differs only there', () => {
    const p = find(all, 'REQUEST_REQUIRED_FIELD_ADDED', 'requestBody.channel').witness;
    expect(p.status).toBe('proven');
    expect(p.request.body).not.toHaveProperty('channel');
    expect(p.why).toEqual(['body is missing required field "channel"']);
    expect(p.expect).toBe('rejected');
    // The control is accepted by the new spec.
    expect(C.checkRequest(C.contractOf(NEW, 'post', '/orders'), { params: {}, body: p.control.body })).toEqual([]);
  });

  test('isolation: the rest of the witness satisfies both specs wherever any value can', () => {
    const p = find(all, 'REQUEST_FIELD_TYPE_CHANGED', 'requestBody.quantity').witness;
    expect(p.status).toBe('proven');
    expect(p.request.body.quantity).toBe(1);
    expect(p.request.body.channel).toBeDefined();               // repaired so the new spec's other rule doesn't fire
    expect(p.why).toEqual(['body.quantity must be string']);
    expect(p.also).toEqual([]);
  });

  test('conflicts no value can satisfy are reported apart from the cause', () => {
    const p = find(all, 'CONSTRAINT_TIGHTENED', 'requestBody.note').witness;
    expect(p.status).toBe('proven');
    expect(p.request.body.note).toHaveLength(101);              // the smallest violation
    expect(p.why).toEqual(['body.note must NOT have more than 100 characters']);
    expect(p.also).toEqual(['body.quantity must be string']);   // integer vs string: nothing satisfies both
  });

  test('a tightened parameter bound: the value just past the new bound', () => {
    const p = find(all, 'CONSTRAINT_TIGHTENED', 'parameters.limit').witness;
    expect(p.request.path).toBe('/orders?limit=51');
    expect(p.why).toEqual(['query parameter "limit" must be <= 50']);
    expect(p.control.path).toMatch(/limit=\d/);
  });

  test('a removed operation: proven, expecting 404/405', () => {
    const p = find(all, 'METHOD_REMOVED', undefined, 'delete').witness;
    expect(p.status).toBe('proven');
    expect(p.request).toMatchObject({ method: 'DELETE', path: '/orders/1' });
    expect(p.expect).toBe('method-not-allowed');
  });

  test('a removed parameter can only be shown by example', () => {
    const p = find(all, 'PARAMETER_REMOVED', 'parameters.sort').witness;
    expect(p.status).toBe('example');
    expect(p.request.path).toMatch(/sort=/);
    expect(p.reason).toMatch(/no longer declares query parameter "sort"/);
  });

  test('response: a removed required field is proven; a removed optional one is an example', () => {
    const req = find(all, 'RESPONSE_FIELD_REMOVED', 'responses.200.legacy_id', 'get').witness;
    expect(req.status).toBe('proven');
    expect(req.response.body).not.toHaveProperty('legacy_id');
    expect(req.why).toEqual(['response is missing required field "legacy_id"']);

    const opt = find(all, 'RESPONSE_FIELD_REMOVED', 'responses.200.coupon', 'get').witness;
    expect(opt.status).toBe('example');
    expect(opt.before.body).toHaveProperty('coupon');
    expect(opt.response.body).not.toHaveProperty('coupon');
  });

  test('response: narrowing is compatible on its own', () => {
    const enumGone = find(all, 'ENUM_VALUE_REMOVED', 'responses.200.status', 'get');
    expect(enumGone.witness.status).toBe('compatible');
    const req = find(all, 'FIELD_BECAME_REQUIRED', 'responses.200.total', 'get');
    expect(req.witness.status).toBe('compatible');
  });

  test('only a numeric format changed: compatible, with the reason', () => {
    const a = doc(`openapi: 3.0.3
info: {title: t, version: "1"}
paths:
  /j/{id}:
    get: {parameters: [{name: id, in: path, required: true, schema: {type: integer}}], responses: {"200": {description: ok}}}`);
    const b = JSON.parse(JSON.stringify(a));
    b.paths['/j/{id}'].get.parameters[0].schema.format = 'int64';
    const p = proofs(a, b)[0].witness;
    expect(p.status).toBe('compatible');
    expect(p.reason).toMatch(/numeric format/);
  });

  test('oneOf branches that only moved: compatible, naming where they went', () => {
    const branch = (t, extra = '') => `{type: object, required: [type], properties: {type: {type: string, enum: [${t}]}${extra}}}`;
    const mk = (order) => doc(`openapi: 3.0.3
info: {title: t, version: "1"}
paths:
  /rules:
    post:
      requestBody:
        required: true
        content: {application/json: {schema: {type: object, properties: {rule: {oneOf: [${order.join(', ')}]}}}}}
      responses: {"201": {description: ok}}`);
    const a = mk([branch('a', ', x: {type: string}'), branch('b', ', y: {type: integer}')]);
    const b = mk([branch('c'), branch('a', ', x: {type: string}'), branch('b', ', y: {type: integer}')]);
    const list = proofs(a, b);
    expect(list.length).toBeGreaterThan(0);
    for (const { witness } of list) {
      expect(witness.status).toBe('compatible');
      expect(witness.reason).toMatch(/reordered: the old oneOf\[\d\] is the new oneOf\[\d\]/);
    }
  });

  test('form bodies: proven on the parsed values, sent bracket-encoded', () => {
    const mk = (required) => doc(`openapi: 3.0.3
info: {title: t, version: "1"}
paths:
  /charges:
    post:
      requestBody:
        content:
          application/x-www-form-urlencoded:
            schema: {type: object, required: [${required}], properties: {amount: {type: integer}, currency: {type: string}, metadata: {type: object, properties: {order: {type: string}}}}}
      responses: {"200": {description: ok}}`);
    const p = proofs(mk('amount'), mk('amount, currency'))[0].witness;
    expect(p.status).toBe('proven');
    expect(p.request.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    expect(p.request.bodyText).toMatch(/^amount=1/);
    expect(p.request.bodyText).not.toMatch(/currency=/);
    expect(C.formEncode({ a: 1, m: { k: 'v w' }, l: ['x', 'y'] })).toBe('a=1&m[k]=v%20w&l[0]=x&l[1]=y');
  });

  test('Swagger 2.0 formData parameters travel as a form body', () => {
    const mk = (max) => doc(`swagger: "2.0"
info: {title: t, version: "1"}
paths:
  /upload:
    post:
      consumes: [application/x-www-form-urlencoded]
      parameters: [{name: size, in: formData, type: integer, maximum: ${max}}]
      responses: {"200": {description: ok}}`);
    const p = proofs(mk(100), mk(10))[0].witness;
    expect(p.status).toBe('proven');
    expect(p.request.bodyText).toBe('size=11');
    expect(p.request.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
  });
});

function paramsOf(rendered) {
  const params = {};
  const [p, q] = rendered.path.split('?');
  const id = /^\/orders\/([^/]+)$/.exec(p);
  if (id) params['path:id'] = decodeURIComponent(id[1]);
  for (const pair of (q || '').split('&').filter(Boolean)) {
    const [k, v] = pair.split('=');
    params[`query:${decodeURIComponent(k)}`] = decodeURIComponent(v);
  }
  return params;
}

// ─── classified changes ─────────────────────────────────────────────────────

describe('prove: proofs on the changes compare and gate report', () => {
  test('a change merged across endpoints carries the strongest proof and a count', () => {
    const r = prove(OLD, NEW);
    const merged = r.breaking.find((c) => c.type === 'RESPONSE_FIELD_REMOVED' && /legacy_id/.test(c.description));
    expect(merged.affectedEndpoints.length).toBe(3);
    expect(merged.proof.status).toBe('proven');
    expect(merged.proof.provenOn).toBe(3);
    expect(r.summary.total).toBe(r.breaking.length);
    expect(r.summary.proven + r.summary.example + r.summary.compatible + r.summary.unproven).toBe(r.summary.total);
  });
});

// ─── running builds ─────────────────────────────────────────────────────────

describe('confirming witnesses on a build', () => {
  const witness = (over) => ({ status: 'proven', request: { method: 'POST', path: '/orders', headers: {}, body: { a: 1 } }, control: { method: 'POST', path: '/orders', headers: {}, body: { a: 2 } }, expect: 'rejected', ...over });
  const fake = (byBody) => async ({ body }) => ({ status: byBody[JSON.parse(body).a], json: undefined, text: '' });

  test('rejected while the control is accepted: confirmed', async () => {
    const items = [{ diff: { type: 'X' }, witness: witness() }];
    await confirmAll(items, { baseDoc: OLD, against: 'http://x', includeMutating: true, http: fake({ 1: 422, 2: 201 }) });
    expect(items[0].witness.run).toMatchObject({ outcome: 'confirmed', status: 422, controlStatus: 201 });
  });

  test('both rejected: inconclusive, not a false confirmation', async () => {
    const items = [{ diff: { type: 'X' }, witness: witness() }];
    await confirmAll(items, { baseDoc: OLD, against: 'http://x', includeMutating: true, http: fake({ 1: 400, 2: 400 }) });
    expect(items[0].witness.run.outcome).toBe('inconclusive');
  });

  test('accepted: not reproduced — the spec and the code disagree', async () => {
    const items = [{ diff: { type: 'X' }, witness: witness() }];
    await confirmAll(items, { baseDoc: OLD, against: 'http://x', includeMutating: true, http: fake({ 1: 201, 2: 201 }) });
    expect(items[0].witness.run.outcome).toBe('not-reproduced');
  });

  test('writes are not sent without --include-mutating; credentials wanted means inconclusive', async () => {
    const items = [{ diff: { type: 'X' }, witness: witness() }];
    await confirmAll(items, { baseDoc: OLD, against: 'http://x', http: fake({}) });
    expect(items[0].witness.run.outcome).toBe('skipped');
    expect(judge({}, witness(), { status: 401 }, OLD).outcome).toBe('inconclusive');
  });

  test('responses are checked against the old contract at the changed field', () => {
    const w = { status: 'proven', expect: 'response', response: { status: '200' } };
    const diff = { type: 'RESPONSE_FIELD_TYPE_CHANGED', method: 'get', path: '/orders/{id}', field: 'responses.200.id' };
    expect(judge(diff, w, { status: 200, json: { id: 'x', status: 'open', legacy_id: 'a' } }, OLD).outcome).toBe('confirmed');
    expect(judge(diff, w, { status: 200, json: { id: 7, status: 'open', legacy_id: 'a' } }, OLD).outcome).toBe('not-reproduced');
    expect(judge(diff, w, { status: 404, json: {} }, OLD).outcome).toBe('inconclusive');
  });
});

describe('targets', () => {
  test('only local and private hosts without --allow-remote', () => {
    for (const h of ['localhost', '127.0.0.1', '10.1.2.3', '172.20.0.5', '192.168.1.9', 'api', 'svc.internal', 'app.test', '::1']) expect(H.isLocalHost(h)).toBe(true);
    for (const h of ['api.example.com', '8.8.8.8', '172.32.0.1']) expect(H.isLocalHost(h)).toBe(false);
    expect(() => H.targetUrl('https://api.example.com')).toThrow(/--allow-remote/);
    expect(H.targetUrl('https://api.example.com/', { allowRemote: true })).toBe('https://api.example.com');
    expect(H.parseHeaders(['Authorization: Bearer a:b'])).toEqual({ Authorization: 'Bearer a:b' });
    expect(() => H.parseHeaders(['nope'])).toThrow(/Name: value/);
  });
});

describe('rendering', () => {
  const strip = (lines) => lines.join('\n').replace(/\u001b\[[0-9;]*m/g, '');

  test('terminal lines for a request proof, a response example and a compatible change', () => {
    const all = proofs();
    const req = find(all, 'REQUEST_REQUIRED_FIELD_ADDED', 'requestBody.channel');
    const text = strip(R.lines({ ...req.witness, diff: req.diff }));
    expect(text).toMatch(/worked before +POST \/orders \{"sku":"AAA-1111","quantity":1\}/);
    expect(text).toMatch(/fails now +body is missing required field "channel"/);
    expect(text).toMatch(/reproduce +curl -X POST "\$BASE_URL\/orders"/);

    const ex = find(all, 'RESPONSE_FIELD_REMOVED', 'responses.200.coupon', 'get');
    const exText = strip(R.lines({ ...ex.witness, diff: ex.diff }));
    expect(exText).toMatch(/old spec sent +coupon = "abc"/);
    expect(exText).toMatch(/new spec sends +a body without "coupon"/);

    const comp = find(all, 'ENUM_VALUE_REMOVED', 'responses.200.status', 'get');
    expect(strip(R.lines({ ...comp.witness, diff: comp.diff }))).toMatch(/the old schema accepted too \(checked schema against schema\)/);
    expect(strip(R.lines(null))).toMatch(/no proof/);
  });

  test('markdown for job summaries and PR comments', () => {
    const all = proofs();
    const req = find(all, 'REQUEST_REQUIRED_FIELD_ADDED', 'requestBody.channel');
    const md = R.markdown({ ...req.witness, diff: req.diff, run: { outcome: 'confirmed', detail: 'HTTP 400' } });
    expect(md).toMatch(/This request worked before and fails now:/);
    expect(md).toMatch(/```http\nPOST \/orders\nContent-Type: application\/json/);
    expect(md).toMatch(/Rejected by the new spec: body is missing required field "channel"/);
    expect(md).toMatch(/On the build: \*\*confirmed\*\* — HTTP 400/);
    const ex = find(all, 'RESPONSE_FIELD_REMOVED', 'responses.200.coupon', 'get');
    expect(R.markdown({ ...ex.witness, diff: ex.diff })).toMatch(/The old spec sent `coupon`:/);
  });

  test('curl quotes JSON safely and leaves $BASE_URL to the shell', () => {
    const c = R.curl({ method: 'POST', path: '/a?x=1', headers: { 'Content-Type': 'application/json' }, body: { s: "it's" } });
    expect(c).toBe(`curl -X POST "$BASE_URL/a?x=1" -H 'Content-Type: application/json' -d '{"s":"it'\\''s"}'`);
    expect(R.curl({ method: 'GET', path: '/a', headers: {}, body: null }, 'http://localhost:8080')).toBe("curl 'http://localhost:8080/a'");
  });
});

// ─── the command ────────────────────────────────────────────────────────────

function run(args, { cwd } = {}) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [bin, ...args], { cwd, env: { ...process.env, FORCE_COLOR: '0' } });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('close', (code) => resolve({ code, out, err }));
  });
}

describe('specshield prove', () => {
  let dir;
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prove-'));
    fs.writeFileSync(path.join(dir, 'old.yaml'), yaml.dump(OLD));
    fs.writeFileSync(path.join(dir, 'new.yaml'), yaml.dump(NEW));
  });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  test('prints a proof per breaking change and exits 1', async () => {
    const r = await run(['prove', 'old.yaml', 'new.yaml'], { cwd: dir });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/proven with a failing request/);
    expect(r.out).toMatch(/PROOF {2}Field "requestBody\.channel" was added/);
    expect(r.out).toMatch(/fails now +body is missing required field "channel"/);
    expect(r.out).toMatch(/reproduce +curl -X POST "\$BASE_URL\/orders"/);
  });

  test('--json carries the proof on each change', async () => {
    const r = await run(['prove', 'old.yaml', 'new.yaml', '--json'], { cwd: dir });
    const j = JSON.parse(r.out);
    expect(j.summary.proven).toBeGreaterThan(0);
    const c = j.breakingChanges.find((x) => x.type === 'REQUEST_REQUIRED_FIELD_ADDED');
    expect(c.proof).toMatchObject({ status: 'proven', side: 'request', expect: 'rejected', at: { field: 'requestBody.channel' } });
  });

  test('no breaking changes: nothing to prove, exit 0', async () => {
    const r = await run(['prove', 'old.yaml', 'old.yaml'], { cwd: dir });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/nothing to prove/);
  });

  test('--against a running build: confirmed with a control, writes only when asked', async () => {
    // A tiny "new build": requires channel and a string quantity; still has DELETE.
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (d) => { body += d; });
      req.on('end', () => {
        const json = (code, v) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(v)); };
        if (req.method === 'POST' && req.url === '/orders') {
          const b = JSON.parse(body || '{}');
          return b.channel && typeof b.quantity === 'string' ? json(201, { id: 'o1', status: 'open', total: 1 }) : json(400, { error: 'bad' });
        }
        if (req.method === 'GET' && req.url.startsWith('/orders/')) return json(200, { id: 'o1', status: 'open', total: 1 });
        if (req.method === 'GET' && req.url.startsWith('/orders')) return json(200, [{ id: 'o1', status: 'open', total: 1 }]);
        if (req.method === 'DELETE') { res.writeHead(204); return res.end(); }
        return json(404, {});
      });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${server.address().port}`;
    try {
      const safe = JSON.parse((await run(['prove', 'old.yaml', 'new.yaml', '--against', url, '--json'], { cwd: dir })).out);
      const get = safe.breakingChanges.find((c) => c.type === 'RESPONSE_FIELD_TYPE_CHANGED' || c.type === 'RESPONSE_TYPE_CHANGED');
      expect(get.proof.run.outcome).toBe('confirmed');                          // id is a string now
      const post = safe.breakingChanges.find((c) => c.type === 'REQUEST_REQUIRED_FIELD_ADDED');
      expect(post.proof.run.outcome).toBe('skipped');

      const all = JSON.parse((await run(['prove', 'old.yaml', 'new.yaml', '--against', url, '--include-mutating', '--json'], { cwd: dir })).out);
      const p = all.breakingChanges.find((c) => c.type === 'REQUEST_REQUIRED_FIELD_ADDED').proof.run;
      expect(p).toMatchObject({ outcome: 'confirmed', status: 400, controlStatus: 201 });
      const del = all.breakingChanges.find((c) => c.type === 'METHOD_REMOVED').proof.run;
      expect(del.outcome).toBe('not-reproduced');                               // the build still serves DELETE
    } finally {
      server.close();
    }
  });

  test('--against refuses a public host unless --allow-remote', async () => {
    const r = await run(['prove', 'old.yaml', 'new.yaml', '--against', 'https://api.example.com'], { cwd: dir });
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/--allow-remote/);
  });
});
