'use strict';

/**
 * Witnesses: for a breaking change, a concrete request that the old contract
 * accepts and the new one rejects — or, for a response-side change, a response
 * the new contract allows that a client written against the old one rejects.
 *
 * The method, per change:
 *
 *   1. Locate the change in both documents (operation, parameter or schema
 *      node, via the diff engine's field path).
 *   2. Generate candidate values for that location — values the accepting
 *      side allows: its enums, boundaries, pattern matches, each oneOf branch,
 *      typed probes, and leaving the field out.
 *   3. Build a whole request (or response) around each candidate, repair every
 *      other part of it until both specs accept it (isolation: other changes
 *      in the same release must not be what fails it), and validate it with
 *      ajv against BOTH full contracts. A candidate is a witness only when the
 *      accepting side accepts it and the other side rejects it.
 *   4. Attribute the rejection to the change with a control: the finished
 *      witness with only the changed location swapped for a value the
 *      rejecting side allows. When the control passes, the change is provably
 *      the cause. Without a passing control, the rejection must be reported at
 *      the changed location itself.
 *
 * Results:
 *   proven      a witness validated as above
 *   example     the change is real but the specs can't show a rejection (a
 *               removed optional response field, an undeclared parameter the
 *               server will ignore): a concrete before/after instead
 *   compatible  no witness, and a structural reason none exists: the sound
 *               subschema check (./subschema), a reordered oneOf branch, a
 *               numeric format that only widened, a response that only narrowed
 *   unproven    no witness found; the reason says why
 */

const { normalizeSpec } = require('../normalizeSpec');
const { diffSpecs } = require('../diffEngine');
const { BREAKING_TYPES } = require('../classifyChanges');
const L = require('../fix/locate');
const S = require('./schema');
const C = require('./contract');
const { generate, fromPattern, ofLength, OMIT, FORMATS } = require('./instance');
const { relatesTo } = require('./relate');
const { coSatisfy } = require('./repair');
const SS = require('./subschema');

const WARNING_TYPES = new Set(['CONSTRAINT_TIGHTENED', 'CONSTRAINT_PATTERN_CHANGED']);
const PROVABLE = new Set([...BREAKING_TYPES, ...WARNING_TYPES]);

const CONFIGS = [
  { full: false, examples: true, variant: 0 },
  { full: false, examples: false, variant: 0 },
  { full: true, examples: true, variant: 0 },
  { full: false, examples: true, variant: 1 },
  { full: false, examples: true, variant: 2 },
  { full: true, examples: false, variant: 1 },
];

// Response-side changes that can only narrow what a server sends.
const NARROWING = new Set(['FIELD_BECAME_REQUIRED', 'ENUM_VALUE_REMOVED', 'SCHEMA_VARIANT_REMOVED', 'CONSTRAINT_TIGHTENED']);
// Request-side changes where leaving the value out is the natural witness.
const ABSENCE = new Set(['FIELD_BECAME_REQUIRED', 'REQUEST_REQUIRED_FIELD_ADDED', 'PARAMETER_BECAME_REQUIRED']);

/**
 * Witnesses for every breaking change (and constraint warning) between two
 * raw spec documents. Returns [{ diff, witness }] in diff-engine order.
 */
function proveAll(baseDoc, targetDoc, { types = PROVABLE } = {}) {
  const raw = diffSpecs(normalizeSpec(baseDoc), normalizeSpec(targetDoc));
  const ctx = context(baseDoc, targetDoc);
  return raw.filter((d) => types.has(d.type)).map((d) => ({ diff: d, witness: proveChange(ctx, d) }));
}

function context(baseDoc, targetDoc) {
  const cache = new Map();
  return {
    base: baseDoc,
    target: targetDoc,
    contract(side, method, path) {
      const key = `${side} ${method} ${path}`;
      if (!cache.has(key)) cache.set(key, C.contractOf(side === 'base' ? baseDoc : targetDoc, method, path));
      return cache.get(key);
    },
  };
}

function proveChange(ctx, d) {
  try {
    if (d.type === 'ENDPOINT_REMOVED' || d.type === 'METHOD_REMOVED') return removedOperation(ctx, d);
    if (d.type === 'SCHEMA_REMOVED') return removedSchema(ctx, d);
    if (d.type === 'RESPONSE_REMOVED') {
      return result(d, 'unproven', { side: 'response', reason: 'A removed status code has no payload to show. It breaks clients that branch on that status; replay real traffic to see whether any receive it.' });
    }
    if (!d.method || !d.path || !d.field) return result(d, 'unproven', { reason: 'The change has no operation to send a request to.' });
    if (d.field.startsWith('parameters.')) return parameterChange(ctx, d);
    const parsed = L.parseField(d.field);
    if (!parsed) return result(d, 'unproven', { reason: `Can't locate "${d.field}" in the spec.` });
    return parsed.side === 'request' ? requestBodyChange(ctx, d, parsed) : responseChange(ctx, d, parsed);
  } catch (err) {
    return result(d, 'unproven', { reason: `Witness search failed: ${err.message}` });
  }
}

// ─── operations and components ──────────────────────────────────────────────

function removedOperation(ctx, d) {
  const oldC = ctx.contract('base', d.method, d.path);
  const newC = ctx.contract('target', d.method, d.path);
  for (const cfg of CONFIGS) {
    const req = C.buildRequest(oldC, cfg);
    if (C.checkRequest(oldC, req).length) continue;
    return result(d, 'proven', {
      side: 'request',
      focus: 'operation',
      request: render(oldC, req),
      why: C.checkRequest(newC, req).map((p) => p.message),
      expect: d.type === 'METHOD_REMOVED' ? 'method-not-allowed' : 'not-found',
      tried: 1,
    });
  }
  return result(d, 'unproven', { side: 'request', reason: 'Could not build a request the old spec accepts for this operation.' });
}

function removedSchema(ctx, d) {
  const name = d.field.replace(/^components\.schemas\./, '');
  const refs = new Set([`#/components/schemas/${name}`, `#/definitions/${name}`]);
  const used = Object.values(ctx.base.paths || {}).some((item) => [...L.collectRefs(ctx.base, item).keys()].some((r) => refs.has(r)));
  return used
    ? result(d, 'unproven', { reason: `Operations used "${name}"; the proof is on the endpoint changes its removal caused.` })
    : result(d, 'compatible', { reason: `No operation referenced "${name}", so no request or response can tell it is gone.` });
}

// ─── parameters ─────────────────────────────────────────────────────────────

function parameterChange(ctx, d) {
  const name = d.field.slice('parameters.'.length);
  const oldC = ctx.contract('base', d.method, d.path);
  const newC = ctx.contract('target', d.method, d.path);
  const inDesc = /\((query|header|path|cookie)\)/.exec(d.description || '');
  const oldP = oldC.params.find((p) => p.name === name && (!inDesc || p.in === inDesc[1]))
    || oldC.params.find((p) => p.name === name);
  if (!oldP) return result(d, 'unproven', { reason: `Parameter "${name}" isn't in the old spec's operation.` });
  const newP = newC.params.find((p) => p.key === oldP.key) || null;

  const found = search({
    candidates: probes(ctx.base, oldP.schema, ctx.target, newP && newP.schema, { omitFirst: ABSENCE.has(d.type), side: 'request', optional: !oldP.required }),
    control: (cfg) => (newP ? (newP.schema ? generate(ctx.target, newP.schema, { side: 'request', ...cfg }) : 'abc') : OMIT),
    make: (value, cfg) => isolate(oldC, newC, C.buildRequest(oldC, { ...cfg, target: { param: oldP.key, value } }), oldP.key, cfg),
    swap: (req, v) => {
      const params = { ...req.params };
      if (v === OMIT) delete params[oldP.key]; else params[oldP.key] = v;
      return { ...req, params };
    },
    accept: (req) => C.checkRequest(oldC, req),
    reject: (req) => C.checkRequest(newC, req),
    relates: (problems) => problems.some((p) => p.part === oldP.key),
  });
  if (found.witness) return requestWitness(d, oldC, newC, found, oldP.key);

  if (d.type === 'PARAMETER_REMOVED' && oldP.in !== 'path') {
    const req = firstValid(oldC, (cfg) => C.buildRequest(oldC, { ...cfg, full: true }), (r) => r.params[oldP.key] !== undefined);
    if (req) {
      return result(d, 'example', {
        side: 'request', focus: oldP.key, request: render(oldC, req), expect: 'ignored', tried: found.tried,
        reason: `The new spec no longer declares ${oldP.in} parameter "${name}". A server built from it ignores the value clients still send — or rejects the request, if it refuses unknown parameters.`,
      });
    }
  }
  const why = structural({ side: 'request', param: name, a: { doc: ctx.base, node: oldP.schema }, b: { doc: ctx.target, node: newP && newP.schema } });
  if (why) return result(d, why.status, { side: 'request', tried: found.tried, reason: why.reason });
  return result(d, 'unproven', { side: 'request', tried: found.tried, reason: noWitness(found.tried, 'request') });
}

// ─── request bodies ─────────────────────────────────────────────────────────

function requestBodyChange(ctx, d, parsed) {
  const oldC = ctx.contract('base', d.method, d.path);
  const newC = ctx.contract('target', d.method, d.path);
  if (!oldC.body || !oldC.body.schema) return result(d, 'unproven', { side: 'request', reason: 'The old spec has no request body schema here.' });
  if (!oldC.body.structured) return result(d, 'unproven', { side: 'request', reason: `The request body is ${oldC.body.mediaType}; witnesses are built for JSON and form bodies.` });
  const steps = parsed.steps;
  const aNode = S.nodeAt(ctx.base, oldC.body.schema, steps);
  const bNode = newC.body && newC.body.schema ? S.nodeAt(ctx.target, newC.body.schema, steps) : null;
  const leafOptional = !isRequiredAt(ctx.base, oldC.body.schema, steps);

  const found = search({
    candidates: aNode ? probes(ctx.base, aNode, ctx.target, bNode, { omitFirst: ABSENCE.has(d.type), side: 'request', optional: leafOptional }) : [OMIT],
    control: (cfg) => (bNode ? generate(ctx.target, bNode, { side: 'request', ...cfg }) : OMIT),
    make: (value, cfg) => {
      const req = C.buildRequest(oldC, { ...cfg, target: { body: steps, value } });
      if (newC.body && newC.body.schema) {
        req.body = coSatisfy(req.body, { a: { doc: ctx.base, schema: oldC.body.schema }, b: { doc: ctx.target, schema: newC.body.schema }, protect: steps, side: 'request', cfg });
      }
      return isolate(oldC, newC, req, 'body', cfg);
    },
    swap: (req, v) => {
      const body = setAt(req.body, S.instancePath(steps), v);
      return body === undefined && v !== OMIT ? null : { ...req, body };
    },
    accept: (req) => C.checkRequest(oldC, req),
    reject: (req) => C.checkRequest(newC, req),
    relates: (problems) => problems.some((p) => p.part === 'body' && relatesTo(p.errors, steps)),
  });
  if (found.witness) return requestWitness(d, oldC, newC, found, 'body', steps);

  const moved = movedVariant(steps, { doc: ctx.base, root: oldC.body.schema }, { doc: ctx.target, root: newC.body && newC.body.schema }, 'request');
  if (moved) return result(d, moved.status, { side: 'request', tried: found.tried, reason: moved.reason });

  if (d.type === 'REQUEST_FIELD_REMOVED' && aNode) {
    const req = firstValid(oldC, (cfg) => C.buildRequest(oldC, { ...cfg, target: { body: steps, value: generate(ctx.base, aNode, { side: 'request', ...cfg }) } }));
    if (req) {
      return result(d, 'example', {
        side: 'request', focus: 'body', request: render(oldC, req), expect: 'ignored', tried: found.tried,
        reason: `The new spec no longer declares ${display(d.field)}. A server built from it drops the value clients still send — or rejects the request, if it refuses unknown fields.`,
      });
    }
  }
  const why = structural({
    side: 'request', steps,
    a: { doc: ctx.base, node: aNode, root: oldC.body.schema },
    b: { doc: ctx.target, node: bNode, root: newC.body && newC.body.schema },
  });
  if (why) return result(d, why.status, { side: 'request', tried: found.tried, reason: why.reason });
  return result(d, 'unproven', { side: 'request', tried: found.tried, reason: noWitness(found.tried, 'request') });
}

function requestWitness(d, oldC, newC, found, focus, steps = null) {
  const hint = focus === 'body' && newC.body && newC.body.schema
    ? (e) => unionHint(newC.doc, newC.body.schema, found.witness.body, e, 'request')
    : () => null;
  // The control a running build should accept: the found one, or else the same
  // request rebuilt for the new spec with the changed part made valid.
  let control = found.control;
  if (!control) {
    const like = { params: { ...found.witness.params }, body: focus === 'body' ? undefined : found.witness.body };
    delete like.params[focus];
    const c = isolate(newC, oldC, C.buildRequest(newC, { like }), null, CONFIGS[0]);
    if (C.checkRequest(newC, c).length === 0) control = c;
  }
  return result(d, 'proven', {
    side: 'request',
    focus,
    request: render(oldC, found.witness),
    ...explain(found.problems, focus, steps, hint, Boolean(found.control)),
    control: control ? render(newC, control) : null,
    expect: 'rejected',
    tried: found.tried,
  });
}

// ─── responses ──────────────────────────────────────────────────────────────

function responseChange(ctx, d, parsed) {
  const oldC = ctx.contract('base', d.method, d.path);
  const newC = ctx.contract('target', d.method, d.path);
  const code = parsed.code;
  const oldR = oldC.responses[code];
  const newR = newC.responses[code];
  if (!oldR || !newR || !oldR.schema || !newR.schema) return result(d, 'unproven', { side: 'response', reason: `No JSON schema for status ${code} on both sides.` });
  const steps = parsed.steps;
  const aNode = S.nodeAt(ctx.target, newR.schema, steps);            // what the server may send now
  const bNode = S.nodeAt(ctx.base, oldR.schema, steps);              // what old clients expect
  const accept = S.validator(ctx.target, newR.schema, { side: 'response' });
  const reject = S.validator(ctx.base, oldR.schema, { side: 'response' });
  const asProblems = (r) => (r.ok ? [] : [{ part: 'response', label: 'response', message: r.errors.map((e) => S.describeError(e, 'response')).join('; '), errors: r.errors }]);

  const found = search({
    candidates: aNode ? probes(ctx.target, aNode, ctx.base, bNode, { omitFirst: false, side: 'response', optional: !isRequiredAt(ctx.target, newR.schema, steps) }) : [OMIT],
    control: (cfg) => (bNode ? generate(ctx.base, bNode, { side: 'response', ...cfg }) : OMIT),
    make: (value, cfg) => ({
      body: coSatisfy(generate(ctx.target, newR.schema, { side: 'response', ...cfg, target: { steps, value } }), {
        a: { doc: ctx.target, schema: newR.schema }, b: { doc: ctx.base, schema: oldR.schema }, protect: steps, side: 'response', cfg,
      }),
    }),
    swap: (r, v) => {
      const body = setAt(r.body, S.instancePath(steps), v);
      return body === undefined && v !== OMIT ? null : { body };
    },
    accept: (r) => asProblems(accept(r.body)),
    reject: (r) => asProblems(reject(r.body)),
    relates: (problems) => problems.some((p) => relatesTo(p.errors, steps)),
  });
  const request = requestFor(newC, oldC);

  if (found.witness) {
    return result(d, 'proven', {
      side: 'response', focus: 'response', request,
      response: { status: code, body: found.witness.body },
      ...explain(found.problems, 'response', steps, (e) => unionHint(ctx.base, oldR.schema, found.witness.body, e, 'response'), Boolean(found.control)),
      expect: 'response',
      tried: found.tried,
    });
  }

  // A branch that only moved inside a oneOf/anyOf isn't a removal: check that before showing an example.
  const moved = movedVariant(steps, { doc: ctx.base, root: oldR.schema }, { doc: ctx.target, root: newR.schema }, 'response');
  if (moved) return result(d, moved.status, { side: 'response', tried: found.tried, reason: moved.reason });

  if (d.type === 'RESPONSE_FIELD_REMOVED' && bNode) {
    const after = firstOk((cfg) => generate(ctx.target, newR.schema, { side: 'response', ...cfg, full: true }), (b) => accept(b).ok);
    const before = firstOk((cfg) => generate(ctx.base, oldR.schema, { side: 'response', ...cfg, full: true }), (b) => reject(b).ok);
    if (after !== undefined) {
      return result(d, 'example', {
        side: 'response', focus: 'response', request,
        response: { status: code, body: after },
        before: before !== undefined ? { status: code, body: before } : null,
        expect: 'response', tried: found.tried,
        reason: `The old spec documented ${display(d.field)} without requiring it; the new spec drops it. A client that reads it now gets nothing.`,
      });
    }
  }
  // Old clients must accept what the server sends now: B (old) is the accepting side here.
  const why = structural({
    side: 'response', steps,
    a: { doc: ctx.base, node: bNode, root: oldR.schema },
    b: { doc: ctx.target, node: aNode, root: newR.schema },
  });
  if (why) return result(d, why.status, { side: 'response', tried: found.tried, reason: why.reason });
  if (NARROWING.has(d.type)) {
    return result(d, 'compatible', {
      side: 'response', tried: found.tried,
      reason: 'This only narrows what the server may send: every response the new spec allows here, the old spec allowed too. It can\'t break a client of the old spec on its own.',
    });
  }
  return result(d, 'unproven', { side: 'response', tried: found.tried, reason: noWitness(found.tried, 'response') });
}

/** A request that reaches the operation: valid for the new spec, and for the old one when possible. */
function requestFor(newC, oldC) {
  const req = firstValid(newC, (cfg) => isolate(newC, oldC, C.buildRequest(newC, cfg), null, cfg)) || C.buildRequest(newC, CONFIGS[0]);
  return render(newC, req);
}

// ─── when there is no witness ───────────────────────────────────────────────

const NUMERIC_FORMATS = new Set([undefined, null, 'int32', 'int64', 'float', 'double']);

/**
 * After the search finds nothing, a structural reason the change can't break
 * anyone — so "no witness" becomes "compatible" with a justification instead
 * of an absence of evidence. `a` is the old spec's side and `b` the new one's.
 * For a request, the new schema must accept everything the old one did; for a
 * response, old clients must accept everything the new schema lets the server
 * send. Every "compatible" here rests on the sound subschema check (or on a
 * wire-level argument for parameters). Returns { status, reason } or null.
 */
function structural({ side, steps = [], param = null, a, b }) {
  const from = side === 'request' ? a : b;                      // instances that must stay accepted
  const to = side === 'request' ? b : a;                        // the schema that must accept them
  const moved = movedVariant(steps, a, b, side);
  if (moved) return moved;
  if (!a.node || !b.node) return null;
  const o = S.effective(a.doc, a.node);
  const n = S.effective(b.doc, b.node);
  if (!o || !n) return null;
  const ot = S.typeOf(o);
  const nt = S.typeOf(n);
  const fmt = (x) => `${S.typeOf(x)}${x.format ? `:${x.format}` : ''}`;

  if (ot && ot === nt && (ot === 'integer' || ot === 'number') && o.format !== n.format && NUMERIC_FORMATS.has(o.format) && NUMERIC_FORMATS.has(n.format)) {
    return compatible(`Only the numeric format changed (${fmt(o)} → ${fmt(n)}). JSON numbers carry no width, so every value ${side === 'request' ? 'the old spec accepted is still accepted' : 'the server sends still reads the same to old clients'}.`);
  }
  if (param && side === 'request' && nt === 'array') {
    const it = n.items ? S.typeOf(S.effective(b.doc, n.items)) : null;
    if (!it || it === ot || it === 'string' || (ot === 'integer' && it === 'number')) {
      return compatible(`On the wire a single value is a one-item list, so "${param}=1" reads the same under both specs.`);
    }
  }
  if (SS.widens(from, to)) {
    if (ot === 'integer' && nt === 'number') return compatible('integer → number widens the type: every integer is still a valid number.');
    if (ot === 'number' && nt === 'integer' && side === 'response') return compatible('number → integer narrows what the server sends: every integer is a number old clients accept.');
    return compatible(side === 'request'
      ? 'The new schema accepts everything the old one did here (checked schema against schema), so no request that worked can fail on this change.'
      : 'Everything the new schema lets the server send here, the old schema accepted too (checked schema against schema), so old clients can\'t break on this change.');
  }
  return null;
}

/**
 * The diff engine compares oneOf/anyOf branches by position, so inserting or
 * reordering branches reports changes in branches that only moved. When the
 * old branch named by `steps` lives on in the new union — taken in full by one
 * of its branches (for a oneOf, one no other branch can also match), and for a
 * response still documenting the field the change is about — say so.
 */
function movedVariant(steps, old, neu, side) {
  let k = -1;
  for (let i = steps.length - 1; i >= 0; i--) if (steps[i].variant) { k = i; break; }
  if (k < 0 || !old.root || !neu.root) return null;
  const branch = S.nodeAt(old.doc, old.root, steps.slice(0, k + 1));
  const holder = S.effective(neu.doc, S.nodeAt(neu.doc, neu.root, steps.slice(0, k)));
  const kind = steps[k].variant;
  const union = holder && holder[kind];
  if (!branch || !Array.isArray(union)) return null;
  const rest = steps.slice(k + 1);
  const from = { doc: old.doc, node: branch };
  const j = union.findIndex((v) => SS.widens(from, { doc: neu.doc, node: v }) && (side === 'request' || rest.length === 0 || S.nodeAt(neu.doc, v, rest)));
  if (j < 0) return null;
  if (kind === 'oneOf' && !SS.exclusiveIn(neu.doc, union[j], union.filter((_, x) => x !== j))) return null;
  const at = `${kind}[${steps[k].index}]`;
  const there = `${kind}[${j}]`;
  const unchanged = SS.equivalent(from, { doc: neu.doc, node: union[j] });
  if (j === steps[k].index) {
    return compatible(`${at} still accepts everything it did (checked schema against schema); the reported difference doesn't reach clients.`);
  }
  return compatible(`The branches were reordered: the old ${at} is the new ${there}${unchanged ? ', unchanged' : ', and accepts at least as much'}${side === 'response' && rest.length ? `, still documenting ${rest.map((x) => x.prop).filter(Boolean).join('.')}` : ''}. The engine compares branches by position, so the move shows up as changes; ${side === 'request' ? 'no request that matched before is rejected' : 'nothing old clients read is gone'}.`);
}

function compatible(reason) {
  return { status: 'compatible', reason };
}

// ─── search ─────────────────────────────────────────────────────────────────

/**
 * Tries each candidate under each generator config. A witness is accepted by
 * `accept` (no problems) and rejected by `reject`. It counts when its control
 * — the same finished artifact with only the changed location swapped for a
 * value `reject` allows — passes (so the location alone causes the rejection),
 * or, failing that, when the rejection is reported at the location itself.
 */
function search({ candidates, control, make, swap, accept, reject, relates }) {
  let tried = 0;
  for (const cfg of CONFIGS) {
    let swapIn;
    try { swapIn = control(cfg); } catch { swapIn = undefined; }
    for (const value of candidates) {
      tried++;
      let x;
      try { x = make(value, cfg); } catch { continue; }
      if (!x || accept(x).length) continue;
      const problems = reject(x);
      if (!problems.length) continue;
      let ctrl = null;
      if (swapIn !== undefined) {
        try {
          const c = swap(x, swapIn);
          if (c && reject(c).length === 0) ctrl = c;
        } catch { /* no control */ }
      }
      if (!ctrl && !relates(problems)) continue;
      return { witness: x, problems, control: ctrl, tried };
    }
  }
  return { witness: null, tried };
}

/** A copy of `value` with the JSON pointer `ptr` set to `v` (OMIT removes it). */
function setAt(value, ptr, v) {
  if (ptr === '') return v === OMIT ? undefined : clone(v);
  const root = clone(value);
  const parts = ptr.split('/').slice(1).map((k) => k.replace(/~1/g, '/').replace(/~0/g, '~'));
  let cur = root;
  for (const k of parts.slice(0, -1)) {
    if (cur === null || typeof cur !== 'object' || cur[k] === undefined) return undefined;
    cur = cur[k];
  }
  if (cur === null || typeof cur !== 'object') return undefined;
  const last = parts[parts.length - 1];
  if (v === OMIT) delete cur[last]; else cur[last] = clone(v);
  return root;
}

function clone(v) {
  return v === undefined || v === null || typeof v !== 'object' ? v : JSON.parse(JSON.stringify(v));
}

/**
 * The values worth trying at one location: what the accepting schema (a)
 * allows, aimed at what the rejecting schema (b) forbids.
 */
function probes(docA, aNode, docB, bNode, { omitFirst = false, side = 'request', optional = true } = {}) {
  const a = S.effective(docA, aNode) || {};
  const b = bNode ? S.effective(docB, bNode) : null;
  const out = [];
  const add = (v) => { if (v !== undefined) out.push(v); };

  if (omitFirst && optional) add(OMIT);
  if (Array.isArray(a.enum)) {
    for (const v of a.enum) if (!b || !Array.isArray(b.enum) || !b.enum.some((x) => same(x, v))) add(v);
  }
  for (const cfg of CONFIGS) add(generate(docA, aNode, { side, ...cfg }));
  const variants = a.oneOf || a.anyOf;
  if (Array.isArray(variants)) variants.forEach((_, i) => add(generate(docA, aNode, { side, variant: i })));

  const ta = S.typeOf(a);
  // Just past the rejecting side's bounds first: the smallest value that shows the change.
  const nums = b ? [add1(b.maximum, 1), sub(b.minimum, 1), add1(b.maximum, 0.5), sub(b.minimum, 0.5), b.exclusiveMinimum, b.exclusiveMaximum] : [];
  nums.push(a.minimum, a.maximum, a.exclusiveMinimum, a.exclusiveMaximum);
  if (ta === 'integer' || ta === 'number' || !ta) {
    for (const n of nums) if (typeof n === 'number' && Number.isFinite(n)) add(ta === 'integer' ? Math.round(n) : n);
    [0, 1, -1, 1.5, 1000000].forEach(add);
  }
  if (ta === 'string' || !ta) {
    const lengths = [b && add1(b.maxLength, 1), b && sub(b.minLength, 1), a.minLength, a.maxLength].filter((n) => typeof n === 'number' && n >= 0 && n <= 10000);
    for (const n of lengths) add(stringOf(a, n));
    if (b && b.pattern && a.pattern !== b.pattern) {
      for (const s of ['abc', 'ABC', '123', 'a-b', 'a b', 'a_b', '', 'x'.repeat(64)]) add(s);
    }
    ['abc', '1', 'true', '', ...Object.values(FORMATS).slice(0, 4)].forEach(add);
  }
  if (ta === 'array' || !ta) {
    const item = a.items ? generate(docA, a.items, { side }) : 'abc';
    add([]);
    for (const n of [b && add1(b.maxItems, 1), b && sub(b.minItems, 1), a.minItems, a.maxItems]) {
      if (typeof n === 'number' && n >= 0 && n <= 1000) add(Array.from({ length: n }, (_, i) => (typeof item === 'string' ? `${item}${i}` : typeof item === 'number' ? item + i : item)));
    }
  }
  if (ta === 'object' || !ta) {
    const base = generate(docA, aNode, { side, full: true });
    if (base && typeof base === 'object' && !Array.isArray(base)) add({ ...base, extra_field: 'abc' });
    add({});
  }
  [true, false, null, 'abc', 1, 1.5, [], {}].forEach(add);
  if (!omitFirst && optional) add(OMIT);
  return dedupe(out);
}

function stringOf(a, n) {
  if (a.pattern) {
    const s = fromPattern(a.pattern, { min: n, max: n });
    if (s !== null) return s;
  }
  return ofLength(FORMATS[a.format] || 'a', a.format, n, n);
}

/**
 * Makes `req` satisfy `other` (the contract on the far side) everywhere except
 * `focus`: adds the parameters it requires, and swaps in a body it accepts
 * when the original's problems there are unrelated to the change.
 */
function isolate(contract, other, req, focus, cfg) {
  const out = { ...req, params: { ...req.params } };
  for (const p of other.params) {
    if (p.key === focus || out.params[p.key] !== undefined || !p.required) continue;
    out.params[p.key] = p.schema ? generate(other.doc, p.schema, { side: 'request', ...cfg }) : 'abc';
  }
  // A parameter both declare but with different rules: prefer a value both accept.
  for (const p of other.params) {
    if (p.key === focus || out.params[p.key] === undefined || !p.schema) continue;
    const ok = S.validator(other.doc, p.schema, { side: 'request', kind: 'param' })(C.wire(out.params[p.key])).ok;
    if (ok) continue;
    const v = generate(other.doc, p.schema, { side: 'request', ...cfg });
    const mine = contract.params.find((x) => x.key === p.key);
    if (!mine || !mine.schema || S.validator(contract.doc, mine.schema, { side: 'request', kind: 'param' })(C.wire(v)).ok) out.params[p.key] = v;
  }
  if (focus !== 'body' && out.body !== undefined && contract.body && contract.body.schema && other.body && other.body.structured && other.body.schema) {
    out.body = coSatisfy(out.body, { a: { doc: contract.doc, schema: contract.body.schema }, b: { doc: other.doc, schema: other.body.schema }, side: 'request', cfg });
  }
  return out;
}

function firstValid(contract, build, also = () => true) {
  for (const cfg of CONFIGS) {
    let req;
    try { req = build(cfg); } catch { continue; }
    if (req && C.checkRequest(contract, req).length === 0 && also(req)) return req;
  }
  return null;
}

function firstOk(build, ok) {
  for (const cfg of CONFIGS) {
    let v;
    try { v = build(cfg); } catch { continue; }
    if (v !== undefined && ok(v)) return v;
  }
  return undefined;
}

/** Is the property at the end of `steps` required in its parent? */
function isRequiredAt(doc, root, steps) {
  if (!steps.length) return true;
  const last = steps[steps.length - 1];
  if (last.prop === undefined) return true;
  const parent = S.effective(doc, S.nodeAt(doc, root, steps.slice(0, -1)));
  return Boolean(parent && Array.isArray(parent.required) && parent.required.includes(last.prop));
}

// ─── results ────────────────────────────────────────────────────────────────

/**
 * "matches none of the allowed forms" says little; name the value no branch
 * takes — a discriminator the other spec doesn't know, or a scalar that fits
 * no branch (a null that used to be allowed).
 */
function unionHint(doc, root, instance, e, side) {
  if (e.keyword !== 'oneOf' && e.keyword !== 'anyOf') return null;
  const node = S.effective(doc, S.nodeAtPointer(doc, root, e.path));
  const branches = node && (node.oneOf || node.anyOf);
  if (!Array.isArray(branches)) return null;
  const v = valueAt(instance, e.path);
  if (v === null || typeof v !== 'object') return `${JSON.stringify(v)} fits none of them`;
  for (const [k, x] of Object.entries(v)) {
    if (x === null || typeof x === 'object') continue;
    const pinned = branches.map((b) => S.effective(doc, b)).filter((b) => b && b.properties && b.properties[k])
      .map((b) => S.effective(doc, b.properties[k])).filter((p) => p && (Array.isArray(p.enum) || p.const !== undefined));
    if (pinned.length && !pinned.some((p) => (p.enum || [p.const]).includes(x))) {
      return side === 'response' ? `"${k}": ${JSON.stringify(x)} is a kind the old spec didn't have` : `"${k}": ${JSON.stringify(x)} is no longer accepted`;
    }
  }
  return null;
}

function valueAt(v, ptr) {
  let cur = v;
  for (const k of ptr.split('/').slice(1)) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = cur[k.replace(/~1/g, '/').replace(/~0/g, '~')];
  }
  return cur;
}

/**
 * Splits the rejecting side's complaints into the ones this change causes
 * (`why`) and the ones other changes in the same release cause (`also`) —
 * conflicts no single value can satisfy on both sides, such as a field that
 * changed from integer to string next to the one being shown.
 */
function explain(problems, focus, steps, hint = () => null, isolated = false) {
  const why = [];
  const also = [];
  for (const p of problems) {
    if (p.part !== 'body' && p.part !== 'response') {
      (isolated || p.part === focus || focus === 'operation' ? why : also).push(p.message);
      continue;
    }
    if (!p.errors.length) { (isolated || p.part === focus ? why : also).push(p.message); continue; }
    for (const e of p.errors) {
      const h = hint(e);
      const msg = S.describeError(e, p.label) + (h ? ` — ${h}` : '');
      // With a passing control the change is the only difference, so every complaint is its doing.
      (isolated || (p.part === focus && (!steps || relatesTo([e], steps))) ? why : also).push(msg);
    }
  }
  return { why, also };
}

function result(d, status, extra = {}) {
  return {
    status,
    side: extra.side || null,
    focus: extra.focus || null,
    operation: d.method && d.path ? { method: d.method.toUpperCase(), path: d.path } : null,
    request: extra.request || null,
    response: extra.response || null,
    before: extra.before || null,
    why: extra.why || [],
    also: extra.also || [],
    control: extra.control || null,
    expect: extra.expect || null,
    reason: extra.reason || null,
    tried: extra.tried || 0,
  };
}

/**
 * The request as it goes on the wire: method, path with query, headers, and
 * the body — `body` structured, `bodyText` exactly as sent when it isn't JSON
 * (a form). Swagger 2.0 formData parameters become a form body too.
 */
function render(contract, req) {
  const { path, headers, form } = C.urlOf(contract, req);
  const b = contract.body;
  if (req.body !== undefined && b && b.form) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    return { method: req.method, path, headers, body: req.body, bodyText: C.formEncode(req.body) };
  }
  if (form) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    return { method: req.method, path, headers, body: null, bodyText: form };
  }
  if (req.body !== undefined) headers['Content-Type'] = b && b.json ? b.mediaType.replace('*/*', 'application/json') : 'application/json';
  return { method: req.method, path, headers, body: req.body === undefined ? null : req.body };
}

function noWitness(tried, side) {
  return side === 'request'
    ? `No request the old spec accepts is rejected by the new one (${tried} tried). This change may be compatible on the wire — or need values the generator can't produce.`
    : `No response the new spec allows is rejected by the old one (${tried} tried).`;
}

function display(field) {
  return `"${field.replace(/^requestBody\./, '').replace(/^responses\.[^.]+\./, '')}"`;
}

function dedupe(values) {
  const seen = new Set();
  return values.filter((v) => {
    const k = v === OMIT ? '\u0000omit' : JSON.stringify(v);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function same(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
function sub(n, d) { return typeof n === 'number' ? n - d : undefined; }
function add1(n, d) { return typeof n === 'number' ? n + d : undefined; }

module.exports = { proveAll, proveChange, context, probes, PROVABLE, WARNING_TYPES };
