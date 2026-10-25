'use strict';

const L = require('./locate');
const { clone } = require('./ops');

/**
 * One suggestion per breaking change: the expand-and-contract edit that keeps
 * existing clients working, as ops on the TARGET spec. Nothing here is
 * trusted — fixSpec re-runs the diff engine on every suggestion and drops the
 * ones that don't remove their break or that add another.
 *
 * A suggestion: {
 *   strategy,          short id, e.g. 'restore-deprecated-field'
 *   title,             one line for the report
 *   detail,            what the server has to do for the spec to be true
 *   ops,               edits to the target spec (see ops.js)
 *   changes,           the breaking diffs it addresses
 *   transforms,        version transforms for the Spring layer (see shim/)
 * }
 * Changes with no safe spec-level edit come back as { strategy: null, reason }.
 */

function suggest(change, ctx) {
  const fn = STRATEGIES[change.type];
  if (!fn) return none(change, 'no automatic fix for this kind of change');
  try {
    return fn(change, ctx) || none(change, 'could not locate it in the spec');
  } catch (err) {
    return none(change, `could not build a fix: ${err.message}`);
  }
}

function none(change, reason) {
  return { strategy: null, title: null, reason, ops: [], changes: [change], transforms: [] };
}

const STRATEGIES = {
  ENDPOINT_REMOVED: restoreOperation,
  METHOD_REMOVED: restoreOperation,
  RESPONSE_FIELD_REMOVED: restoreField,
  REQUEST_FIELD_REMOVED: restoreField,
  PARAMETER_REMOVED: restoreParameter,
  PARAMETER_BECAME_REQUIRED: parameterOptional,
  PARAMETER_TYPE_CHANGED: revertParameterType,
  REQUEST_REQUIRED_FIELD_ADDED: fieldOptional,
  FIELD_BECAME_REQUIRED: fieldOptional,
  REQUEST_FIELD_TYPE_CHANGED: revertFieldType,
  RESPONSE_FIELD_TYPE_CHANGED: revertFieldType,
  RESPONSE_REMOVED: restoreResponse,
  ENUM_VALUE_REMOVED: restoreEnumValue,
  RESPONSE_TYPE_CHANGED: bodyShapeChanged,
  REQUEST_TYPE_CHANGED: bodyShapeChanged,
  SCHEMA_REMOVED: restoreSchema,
  SCHEMA_VARIANT_REMOVED: restoreVariant,
  SCHEMA_DISCRIMINATOR_CHANGED: revertDiscriminator,
};

// ─── operations, responses, components ──────────────────────────────────────

function restoreOperation(c, { base, target, deprecate }) {
  const m = c.method.toLowerCase();
  const baseItem = L.get(base, ['paths', c.path]);
  const baseOp = baseItem && baseItem[m];
  if (!baseOp) return null;
  const ops = [];
  if (!L.get(target, ['paths', c.path]) && Array.isArray(baseItem.parameters)) {
    ops.push({ op: 'set', path: ['paths', c.path, 'parameters'], value: baseItem.parameters });
  }
  ops.push({ op: 'set', path: ['paths', c.path, m], value: deprecate(clone(baseOp)) });
  ops.push(...missingRefs(base, target, [baseOp, baseItem.parameters]));
  return {
    strategy: 'restore-deprecated-operation',
    title: `Keep ${c.method.toUpperCase()} ${c.path}, marked deprecated`,
    detail: 'Keep serving it until its callers have moved (`specshield deprecations` shows who still calls it), then remove it.',
    ops, changes: [c], transforms: [],
  };
}

function restoreResponse(c, { base, target }) {
  const code = /^responses\.(.+)$/.exec(c.field)[1];
  const op = L.operationPtr(target, c.method, c.path);
  const value = L.get(base, ['paths', c.path, c.method.toLowerCase(), 'responses', code]);
  if (!op || value === undefined) return null;
  return {
    strategy: 'restore-response',
    title: `Keep documenting the ${code} response of ${c.method.toUpperCase()} ${c.path}`,
    detail: `Clients may handle ${code}; keep it in the spec while the server can still return it.`,
    ops: [{ op: 'set', path: [...op, 'responses', code], value }, ...missingRefs(base, target, [value])],
    changes: [c], transforms: [],
  };
}

function restoreSchema(c, { base, target, deprecate }) {
  const name = c.field.replace(/^components\.schemas\./, '');
  const where = base.components && base.components.schemas ? ['components', 'schemas', name] : ['definitions', name];
  const value = L.get(base, where);
  if (value === undefined) return null;
  return {
    strategy: 'restore-schema',
    title: `Keep the ${name} schema, marked deprecated`,
    detail: 'Code generated from the spec may still import it.',
    ops: [{ op: 'set', path: where, value: deprecate(clone(value)) }, ...missingRefs(base, target, [value])],
    changes: [c], transforms: [],
  };
}

// ─── fields ─────────────────────────────────────────────────────────────────

function restoreField(c, ctx) {
  const { base, target, deprecate } = ctx;
  const parsed = L.parseField(c.field);
  const last = parsed && parsed.steps[parsed.steps.length - 1];
  if (parsed && ctx.reshaped.has(`${c.method} ${c.path} ${parsed.side} ${parsed.code}`)) {
    return none(c, 'part of the body shape change of this operation (see below)');
  }
  if (!last || last.prop === undefined) return null;
  const basePtr = L.fieldPtr(base, c.method, c.path, c.field);
  const holder = L.parentObjectPtr(target, c.method, c.path, c.field);
  if (!basePtr || !holder) return null;

  const name = last.prop;
  const renamedTo = ctx.renames.get(sig(c)) || null;
  const request = parsed.side === 'request';
  const value = deprecate(clone(L.get(base, basePtr)), renamedTo ? `Use \`${renamedTo}\` instead.` : null);
  const ops = [{ op: 'set', path: [...holder, 'properties', name], value }, ...missingRefs(base, target, [L.get(base, basePtr)])];
  // A response field keeps its guarantee; a request field comes back optional
  // so clients already sending only the new shape stay valid.
  if (!request && baseRequired(base, c, name)) ops.push({ op: 'push', path: [...holder, 'required'], value: name });

  const transforms = [];
  if (renamedTo) {
    transforms.push({
      ...where(c), side: parsed.side, kind: 'rename',
      parent: parsed.steps.slice(0, -1), from: request ? name : renamedTo, to: request ? renamedTo : name,
    });
  }
  return {
    strategy: renamedTo ? 'keep-both-names' : 'restore-deprecated-field',
    title: renamedTo
      ? `\`${name}\` was renamed to \`${renamedTo}\`: ${request ? 'accept' : 'return'} both, \`${name}\` deprecated`
      : `Keep ${request ? 'accepting' : 'returning'} \`${name}\`, marked deprecated`,
    detail: request
      ? (renamedTo
        ? `The server must read \`${name}\` when \`${renamedTo}\` is absent.`
        : `The server must keep accepting \`${name}\` (it may ignore it).`)
      : (renamedTo
        ? `The server must return \`${name}\` with the same value as \`${renamedTo}\`.`
        : `The server must keep returning \`${name}\`.`),
    ops, changes: [c], transforms,
  };
}

function fieldOptional(c, { target }) {
  const parsed = L.parseField(c.field);
  const last = parsed && parsed.steps[parsed.steps.length - 1];
  if (!last || last.prop === undefined) return null;
  const parent = L.parentObjectPtr(target, c.method, c.path, c.field);
  if (!parent) return null;
  const holders = requiredHolders(target, parent, last.prop);
  if (holders.length === 0) return null;
  const propPtr = L.fieldPtr(target, c.method, c.path, c.field);
  const prop = propPtr && L.get(target, L.derefPtr(target, propPtr));
  const def = prop && prop.default !== undefined ? prop.default : undefined;
  const request = parsed.side === 'request';
  return {
    strategy: 'make-optional',
    title: `Make \`${last.prop}\` optional${def !== undefined ? ` (default ${JSON.stringify(def)})` : ''}`,
    detail: request
      ? (def !== undefined
        ? `Clients that don't send it get the default ${JSON.stringify(def)}.`
        : `Existing clients don't send \`${last.prop}\`: the server must pick a value when it is missing (add a \`default\` to document it).`)
      : 'Clients never relied on it being present. Making it required in a response does not break readers; this keeps the gate green.',
    ops: holders.map((h) => ({ op: 'pull', path: [...h, 'required'], value: last.prop })),
    changes: [c],
    transforms: request && def !== undefined
      ? [{ ...where(c), side: 'request', kind: 'default', parent: parsed.steps.slice(0, -1), field: last.prop, value: def }]
      : [],
  };
}

function revertFieldType(c, { base, target, deprecate }) {
  const parsed = L.parseField(c.field);
  const basePtr = L.fieldPtr(base, c.method, c.path, c.field);
  const targetPtr = L.fieldPtr(target, c.method, c.path, c.field);
  if (!parsed || !basePtr || !targetPtr) return null;
  const last = parsed.steps[parsed.steps.length - 1];
  const request = parsed.side === 'request';
  const oldNode = L.get(base, basePtr);
  const ops = [{ op: 'set', path: targetPtr, value: oldNode }, ...missingRefs(base, target, [oldNode])];
  const label = last.prop !== undefined ? `\`${last.prop}\`` : `"${c.field}"`;

  // integer → integer:int64 is a format change, not a new kind of value:
  // keep the old format, no new field, nothing for a version layer to do.
  const kind = (t) => String(t || '').split(':')[0];
  if (kind(c.oldValue) === kind(c.newValue)) {
    return {
      strategy: 'keep-old-format',
      title: `Keep the format of ${label} as ${c.oldValue}`,
      detail: `Generated clients map ${c.oldValue} and ${c.newValue} to different types. If the values really outgrew ${c.oldValue}, publish the wider field under a new name.`,
      ops, changes: [c], transforms: [],
    };
  }

  let added = null;
  if (!request && last.prop !== undefined) {
    // Expand: the new type moves to a new field next to the old one.
    added = newFieldName(last.prop);
    const holder = targetPtr.slice(0, -2);
    if (!L.get(target, [...holder, 'properties', added])) {
      ops.push({ op: 'set', path: [...holder, 'properties', added], value: clone(L.get(target, targetPtr)) });
    }
    ops[0] = { op: 'set', path: targetPtr, value: deprecate(clone(oldNode), `Use \`${added}\` (${c.newValue}) instead.`) };
  }
  const convertible = scalar(c.oldValue) && scalar(c.newValue);
  return {
    strategy: request ? 'accept-old-type' : 'keep-old-type-add-new-field',
    title: request
      ? `Keep ${label} as ${c.oldValue}`
      : `Keep ${label} as ${c.oldValue}; return the ${c.newValue} value as \`${added || '<new field>'}\``,
    detail: request
      ? `Changing a request field's type rejects existing clients. Accept ${c.oldValue} and convert on the server, or add the ${c.newValue} value as a new field.`
      : `Old clients keep parsing ${label} as ${c.oldValue}; new clients read \`${added}\`.`,
    ops: added || request ? ops : ops.slice(0, 1),
    changes: [c],
    transforms: convertible
      ? [{ ...where(c), side: parsed.side, kind: 'convert', steps: parsed.steps,
        from: request ? c.oldValue : c.newValue, to: request ? c.newValue : c.oldValue }]
      : [],
  };
}

function restoreEnumValue(c, { base, target, enumRenames }) {
  const ptr = enumPtr(target, c);
  if (!ptr) return null;
  const value = enumValue(base, c);
  if (value === undefined) return null;
  const renamedTo = enumRenames.get(`${c.method} ${c.path} ${c.field} ${c.oldValue}`);
  const parsed = c.field.startsWith('parameters.') ? null : L.parseField(c.field);
  const side = parsed ? parsed.side : 'request';
  return {
    strategy: 'restore-enum-value',
    title: `Keep "${value}" as an allowed value of ${c.field.replace(/^(requestBody|responses\.\w+)\./, '')}` +
      (renamedTo !== undefined ? ` (renamed to "${renamedTo}")` : ''),
    detail: side === 'request'
      ? `Existing clients still send "${value}"; the server must accept it${renamedTo !== undefined ? ` as "${renamedTo}"` : ''}.`
      : `Old clients may not know ${renamedTo !== undefined ? `"${renamedTo}"` : 'the new values'}; keep "${value}" listed while you migrate them.`,
    ops: [{ op: 'push', path: [...ptr, 'enum'], value }],
    changes: [c],
    transforms: renamedTo !== undefined && parsed
      ? [{ ...where(c), side, kind: 'enum', steps: parsed.steps,
        from: side === 'request' ? value : renamedTo, to: side === 'request' ? renamedTo : value }]
      : [],
  };
}

function bodyShapeChanged(c, ctx) {
  const { base, target } = ctx;
  const parsed = L.parseField(c.field);
  if (!parsed) return null;
  // Below the root this is a field whose type changed (the engine reports it
  // twice); it gets the same fix, which mergeIdentical folds together.
  if (parsed.steps.length > 0) return revertFieldType(c, ctx);
  // A list response wrapped into an envelope: { data: [...] } where it was [...].
  const bPtr = L.fieldPtr(base, c.method, c.path, c.field);
  const bNode = bPtr && L.get(base, L.derefPtr(base, bPtr));
  const tPtr = L.fieldPtr(target, c.method, c.path, c.field);
  const tNode = tPtr && L.get(target, L.derefPtr(target, tPtr));
  const wrapper = parsed.side === 'response' && bNode && bNode.type === 'array' && tNode
    ? envelopeProperty(target, tPtr) : null;
  if (!wrapper) return none(c, 'the body changed shape: this needs a new API version (see --spring for a version layer)');
  // Changes inside the list's items aren't reported once the root changed
  // type; diff the old list against the new `wrapper` property to find them.
  const tProp = L.derefPtr(target, [...L.derefPtr(target, tPtr), 'properties', wrapper]);
  const inner = ctx.nested
    ? ctx.nested(mini(base, bNode), mini(target, L.get(target, tProp)))
        // Applied after the unwrap, when the list is the root again: the
        // nested steps ([items].…) are already right.
        .map((t) => ({ ...t, ...where(c) }))
    : [];
  return {
    strategy: null,
    reason: `the list moved into \`${wrapper}\` — one schema can't describe both shapes, so this needs a version layer (--spring)`,
    ops: [],
    changes: [c],
    transforms: [{ ...where(c), side: 'response', kind: 'unwrap', property: wrapper }, ...inner],
  };
}

/** A one-operation spec around `schema`, sharing the document's components. */
function mini(doc, schema) {
  const out = { openapi: '3.0.3', info: { title: 'nested', version: '0' },
    paths: { '/_': { get: { responses: { 200: { description: '', content: { 'application/json': { schema } } } } } } } };
  if (doc.components) out.components = doc.components;
  if (doc.definitions) out.definitions = doc.definitions;
  return out;
}

// ─── parameters ─────────────────────────────────────────────────────────────

function restoreParameter(c, { base, target, deprecate }) {
  const name = c.field.replace(/^parameters\./, '');
  const bp = L.findParameter(base, c.method, c.path, name);
  const op = L.operationPtr(target, c.method, c.path);
  if (!bp || !op) return null;
  const value = deprecate(clone(bp.node));
  value.required = value.in === 'path' ? true : false;
  return {
    strategy: 'restore-deprecated-parameter',
    title: `Keep accepting the ${bp.node.in} parameter \`${name}\`, marked deprecated`,
    detail: `Existing clients still send \`${name}\`; the server must accept it (it may ignore it).`,
    ops: [{ op: 'push', path: [...op, 'parameters'], value }, ...missingRefs(base, target, [bp.node])],
    changes: [c], transforms: [],
  };
}

function parameterOptional(c, { target }) {
  const name = c.field.replace(/^parameters\./, '');
  const tp = L.findParameter(target, c.method, c.path, name);
  if (!tp || tp.node.in === 'path') return null;
  const def = tp.node.schema ? tp.node.schema.default : tp.node.default;
  return {
    strategy: 'make-optional',
    title: `Make the ${tp.node.in} parameter \`${name}\` optional${def !== undefined ? ` (default ${JSON.stringify(def)})` : ''}`,
    detail: def !== undefined
      ? `Clients that don't send it get the default ${JSON.stringify(def)}.`
      : `Existing clients don't send \`${name}\`: the server must pick a value when it is missing.`,
    ops: [{ op: 'set', path: [...tp.ptr, 'required'], value: false }],
    changes: [c], transforms: [],
  };
}

function revertParameterType(c, { base, target }) {
  const name = c.field.replace(/^parameters\./, '');
  const bp = L.findParameter(base, c.method, c.path, name);
  const tp = L.findParameter(target, c.method, c.path, name);
  if (!bp || !tp) return null;
  const ops = [];
  if (bp.node.schema) ops.push({ op: 'set', path: [...tp.ptr, 'schema'], value: bp.node.schema });
  for (const k of ['type', 'format', 'items', 'enum']) {
    if (bp.node[k] !== undefined) ops.push({ op: 'set', path: [...tp.ptr, k], value: bp.node[k] });
    else if (tp.node[k] !== undefined) ops.push({ op: 'delete', path: [...tp.ptr, k] });
  }
  return {
    strategy: 'accept-old-type',
    title: `Keep the parameter \`${name}\` as ${c.oldValue}`,
    detail: `Existing clients send ${c.oldValue}. Parse it on the server, or add the ${c.newValue} value as a new parameter.`,
    ops: [...ops, ...missingRefs(base, target, [bp.node])],
    changes: [c], transforms: [],
  };
}

// ─── variants, discriminators ───────────────────────────────────────────────

function restoreVariant(c, { base, target }) {
  const m = /^(.*)\.(oneOf|anyOf)\[(\d+)\]$/.exec(c.field);
  if (!m) return null;
  const basePtr = L.fieldPtr(base, c.method, c.path, c.field);
  const holder = L.fieldPtr(target, c.method, c.path, m[1]);
  if (!basePtr || !holder) return null;
  const owner = L.derefPtr(target, holder);
  return {
    strategy: 'restore-variant',
    title: `Keep the removed ${m[2]} variant #${Number(m[3]) + 1}`,
    detail: 'Clients may still send or receive that shape.',
    ops: [{ op: 'insert', path: [...owner, m[2]], index: Number(m[3]), value: L.get(base, basePtr) },
      ...missingRefs(base, target, [L.get(base, basePtr)])],
    changes: [c], transforms: [],
  };
}

function revertDiscriminator(c, { base, target }) {
  const prefix = c.field.replace(/\.discriminator$/, '');
  const bPtr = L.fieldPtr(base, c.method, c.path, prefix);
  const tPtr = L.fieldPtr(target, c.method, c.path, prefix);
  if (!bPtr || !tPtr) return null;
  const bOwner = L.derefPtr(base, bPtr);
  const tOwner = L.derefPtr(target, tPtr);
  const value = L.get(base, [...bOwner, 'discriminator']);
  return {
    strategy: 'revert-discriminator',
    title: `Keep "${c.oldValue}" as the discriminator`,
    detail: 'Clients pick the variant by that property name.',
    ops: [{ op: 'set', path: [...tOwner, 'discriminator'], value }],
    changes: [c], transforms: [],
  };
}

// ─── renames ────────────────────────────────────────────────────────────────

/**
 * A field removed and another added under the same parent, with the same
 * type and a related name (a shared word), is a rename: `status` →
 * `paymentStatus`. Only an unambiguous pair counts. Being the only field of
 * that type is not enough: on GitHub's real API history that matched
 * `budget_type` → `expires_at`, and the Spring layer would have copied one
 * field's data into an unrelated one.
 */
function detectRenames(rawDiffs, baseNorm, targetNorm) {
  const groups = new Map();
  for (const d of rawDiffs) {
    if (!/^(REQUEST|RESPONSE)_FIELD_(REMOVED|ADDED)$|^REQUEST_REQUIRED_FIELD_ADDED$/.test(d.type)) continue;
    const parsed = L.parseField(d.field);
    const last = parsed && parsed.steps[parsed.steps.length - 1];
    if (!last || last.prop === undefined) continue;
    const parent = d.field.slice(0, d.field.length - last.prop.length - 1);
    const key = `${d.method} ${d.path} ${parent}`;
    if (!groups.has(key)) groups.set(key, { removed: [], added: [] });
    groups.get(key)[/REMOVED$/.test(d.type) ? 'removed' : 'added'].push({ d, name: last.prop });
  }
  const renames = new Map();
  for (const { removed, added } of groups.values()) {
    for (const r of removed) {
      const rType = typeKey(normNode(baseNorm, r.d.method, r.d.path, r.d.field));
      if (!rType) continue;
      const sameType = added.filter((a) => typeKey(normNode(targetNorm, a.d.method, a.d.path, a.d.field)) === rType);
      const rivals = removed.filter((x) => typeKey(normNode(baseNorm, x.d.method, x.d.path, x.d.field)) === rType);
      const related = sameType.filter((a) => relatedNames(r.name, a.name));
      const relatedRivals = rivals.filter((x) => sameType.some((a) => relatedNames(x.name, a.name)));
      if (related.length === 1 && relatedRivals.length === 1) renames.set(sig(r.d), related[0].name);
    }
  }
  return renames;
}

/**
 * An enum value removed and exactly one added in the same place is a renamed
 * value — if the enum also kept at least one value. Single-value enums are
 * constants/discriminators: on GitHub's API history, oneOf variants that
 * shifted position paired 9 unrelated constants ("github_resource" → "pull").
 */
function detectEnumRenames(rawDiffs, baseNorm, targetNorm) {
  const out = new Map();
  const seen = new Set();
  for (const d of rawDiffs) {
    if (d.type !== 'ENUM_VALUE_REMOVED' || seen.has(`${d.method} ${d.path} ${d.field}`)) continue;
    seen.add(`${d.method} ${d.path} ${d.field}`);
    const b = enumOf(baseNorm, d);
    const t = enumOf(targetNorm, d);
    if (!b || !t) continue;
    const removed = b.filter((v) => !t.includes(v));
    const added = t.filter((v) => !b.includes(v));
    const kept = b.filter((v) => t.includes(v));
    if (removed.length === 1 && added.length === 1 && kept.length > 0) out.set(`${d.method} ${d.path} ${d.field} ${String(removed[0])}`, added[0]);
  }
  return out;
}

// ─── helpers ────────────────────────────────────────────────────────────────

/**
 * "status" / "paymentStatus" share "status"; "created_at" / "createdAt" the
 * same words. Short and filler words don't count: on GitHub's API history
 * `do_not_enforce_on_create` and `review_on_push` matched on "on".
 */
const FILLER = new Set(['the', 'and', 'for', 'with', 'from', 'not', 'into', 'url', 'urls']);
function relatedNames(a, b) {
  const words = (n) => n.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[\s_-]+/)
    .filter((w) => w.length > 2 && !FILLER.has(w));
  const wb = new Set(words(b));
  return words(a).some((w) => wb.has(w));
}

function sig(c) {
  return `${c.type}|${c.method || ''}|${c.path || ''}|${c.field || ''}`;
}

function where(c) {
  const parsed = L.parseField(c.field);
  return { method: c.method.toUpperCase(), path: c.path, code: parsed ? parsed.code : null };
}

function scalar(t) {
  return ['string', 'integer', 'number', 'boolean'].includes(String(t || '').split(':')[0]);
}

/** `status` → `statusV2`, `created_at` → `created_at_v2`. */
function newFieldName(name) {
  return name.includes('_') ? `${name}_v2` : `${name}V2`;
}

/** Copies the components a restored piece references that the target no longer has. */
function missingRefs(base, target, nodes) {
  const ops = [];
  const refs = new Map();
  for (const n of nodes) L.collectRefs(base, n, refs);
  for (const ptr of refs.values()) {
    if (L.get(target, ptr) === undefined && L.get(base, ptr) !== undefined) {
      ops.push({ op: 'set', path: ptr, value: L.get(base, ptr) });
    }
  }
  return ops;
}

function baseRequired(base, c, name) {
  const holder = L.parentObjectPtr(base, c.method, c.path, c.field);
  return Boolean(holder && requiredHolders(base, holder, name).length);
}

/** The schema objects (the holder and its allOf parts) whose `required` lists `name`. */
function requiredHolders(doc, ptr, name, depth = 0, out = []) {
  const s = L.derefPtr(doc, ptr);
  const node = s && L.get(doc, s);
  if (!node || depth > 12) return out;
  if (Array.isArray(node.required) && node.required.includes(name)) out.push(s);
  (node.allOf || []).forEach((_, i) => requiredHolders(doc, [...s, 'allOf', i], name, depth + 1, out));
  // The diff engine looks at the composed parent; required may sit one level up.
  return out;
}

function enumPtr(doc, c) {
  if (c.field.startsWith('parameters.')) {
    const p = L.findParameter(doc, c.method, c.path, c.field.slice('parameters.'.length));
    if (!p) return null;
    return p.node.schema ? L.derefPtr(doc, [...p.ptr, 'schema']) : p.ptr;
  }
  const ptr = L.fieldPtr(doc, c.method, c.path, c.field);
  return ptr && L.derefPtr(doc, ptr);
}

function enumValue(base, c) {
  const ptr = enumPtr(base, c);
  const node = ptr && L.get(base, ptr);
  return node && Array.isArray(node.enum) ? node.enum.find((v) => String(v) === c.oldValue) : undefined;
}

function envelopeProperty(doc, ptr) {
  const s = L.derefPtr(doc, ptr);
  const node = s && L.get(doc, s);
  const arrays = Object.keys((node && node.properties) || {}).filter((k) => {
    const p = L.get(doc, L.derefPtr(doc, [...s, 'properties', k]));
    return p && p.type === 'array';
  });
  return arrays.length === 1 ? arrays[0] : null;
}

function normNode(norm, method, path, field) {
  const op = norm.endpoints[path] && norm.endpoints[path][method.toLowerCase()];
  const parsed = L.parseField(field);
  if (!op || !parsed) return null;
  let cur = parsed.side === 'request' ? op.requestBody : op.responses[parsed.code];
  for (const s of parsed.steps) {
    if (!cur) return null;
    if (s.prop !== undefined) cur = cur.properties && cur.properties[s.prop];
    else if (s.items) cur = cur.items;
    else if (s.map) cur = cur.additionalProperties;
    else cur = cur[s.variant] && cur[s.variant][s.index];
  }
  return cur || null;
}

function enumOf(norm, d) {
  if (d.field.startsWith('parameters.')) {
    const op = norm.endpoints[d.path] && norm.endpoints[d.path][d.method.toLowerCase()];
    const p = op && op.parameters.find((x) => x.name === d.field.slice('parameters.'.length));
    return p && p.schema && p.schema.enum;
  }
  const n = normNode(norm, d.method, d.path, d.field);
  return n && n.enum;
}

/** Type identity for rename detection. Enum values are left out: a renamed field may gain or lose values too. */
function typeKey(n) {
  if (!n) return null;
  return [n.type, n.format || '', n.items ? typeKey(n.items) : ''].join('|');
}

/** Operations whose request or response body root changed type: "GET /x response 200". */
function reshapedBodies(rawDiffs) {
  const out = new Set();
  for (const d of rawDiffs) {
    if (d.type !== 'REQUEST_TYPE_CHANGED' && d.type !== 'RESPONSE_TYPE_CHANGED') continue;
    const parsed = L.parseField(d.field);
    if (parsed && parsed.steps.length === 0) out.add(`${d.method} ${d.path} ${parsed.side} ${parsed.code}`);
  }
  return out;
}

module.exports = { suggest, detectRenames, detectEnumRenames, reshapedBodies, sig, STRATEGIES };
