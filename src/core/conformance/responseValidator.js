'use strict';

/**
 * Validate an actual HTTP response body against the OAS response schema —
 * the core of Fix 3 (spec-vs-production conformance).
 *
 * OpenAPI 3.0 schemas are a *modified subset* of JSON Schema. ajv validates
 * standard JSON Schema, so we normalise OAS-isms first:
 *
 *   - `nullable: true`     → union with null (`type: [x, 'null']`)
 *   - `example`, `examples`, `xml`, `discriminator`, `readOnly`, `writeOnly`,
 *     `deprecated`, `externalDocs`              → stripped (annotations only)
 *
 * Anything else (allOf/oneOf/anyOf/not, formats, enums, required, additional-
 * Properties) passes through to ajv unchanged.
 *
 * Format keywords (date-time, uuid, email, …) are handled by ajv-formats.
 */

const Ajv = require('ajv').default;
const addFormats = require('ajv-formats');

// One ajv per-validator-call would be slow; cache compiled validators by
// schema reference. Lifetime is the process — for the CLI that's fine.
const ajv = new Ajv({
  strict: false,           // OAS allows non-standard keywords; don't fail compile
  allErrors: true,         // collect every mismatch, not just the first
  validateFormats: true,
  coerceTypes: false,      // a body field that's "1" when spec says integer = mismatch
});
addFormats(ajv);

const compiledCache = new WeakMap();

function compile(schema) {
  if (compiledCache.has(schema)) return compiledCache.get(schema);
  const normalised = oasToJsonSchema(schema);
  const fn = ajv.compile(normalised);
  compiledCache.set(schema, fn);
  return fn;
}

/** Recursively rewrite OAS-3.0 quirks into plain JSON Schema. */
function oasToJsonSchema(node) {
  if (node === null || typeof node !== 'object') return node;
  if (Array.isArray(node)) return node.map(oasToJsonSchema);

  // Drop OAS-only annotations that confuse ajv (or are no-ops for validation).
  const STRIP = new Set([
    'example', 'examples', 'xml', 'discriminator',
    'readOnly', 'writeOnly', 'deprecated', 'externalDocs',
  ]);

  const out = {};
  for (const [k, v] of Object.entries(node)) {
    if (STRIP.has(k)) continue;
    if (k === 'nullable') continue;            // handled below
    out[k] = oasToJsonSchema(v);
  }

  // `nullable: true` → widen type to also permit null. JSON Schema 2020-12 +
  // ajv accept `type: [...]` arrays.
  if (node.nullable === true && out.type) {
    if (Array.isArray(out.type)) {
      if (!out.type.includes('null')) out.type = [...out.type, 'null'];
    } else {
      out.type = [out.type, 'null'];
    }
  }

  return out;
}

/**
 * Validate one body against one schema.
 * Returns { ok: true } on pass; otherwise { ok: false, errors: [...] } where
 * each error is { path, message, expected?, got? } — caller-friendly format.
 */
function validateBody(body, schema) {
  if (!schema) return { ok: true, errors: [] };
  let validate;
  try { validate = compile(schema); }
  catch (e) {
    return { ok: false, errors: [{
      path: '', message: `spec schema is invalid: ${e.message}`,
    }]};
  }
  const ok = validate(body);
  if (ok) return { ok: true, errors: [] };
  return {
    ok: false,
    errors: (validate.errors || []).map(e => ({
      path: e.instancePath || '(root)',
      keyword: e.keyword,                       // 'enum' | 'required' | 'type' | 'format' | …
      message: e.message || 'validation failed',
      expected: e.params,                       // ajv's params, e.g. { allowedValues, missingProperty, format, type }
      got: peek(body, e.instancePath),
    })),
  };
}

/** Best-effort: extract the value at a JSON-Pointer-style path for the error. */
function peek(body, jsonPointer) {
  if (!jsonPointer || jsonPointer === '') return body;
  const parts = jsonPointer.split('/').slice(1).map(p => p.replace(/~1/g, '/').replace(/~0/g, '~'));
  let cur = body;
  for (const p of parts) {
    if (cur === null || cur === undefined) return undefined;
    cur = cur[p];
  }
  return cur;
}

module.exports = { validateBody, oasToJsonSchema };
