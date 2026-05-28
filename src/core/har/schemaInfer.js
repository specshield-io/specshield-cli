'use strict';

/**
 * JSON Schema inference from sample bodies — for HAR-ingest capture (Fix 2).
 *
 *   inferSchema(value)              → JSON Schema describing one sample
 *   mergeSchemas(a, b)              → schema that admits both inputs
 *
 * The merger is the interesting bit: across multiple recorded responses
 * for the same endpoint, fields seen in EVERY sample stay `required`;
 * fields seen in only SOME become optional; type conflicts widen
 * conservatively (integer + number → number; otherwise → string).
 *
 * Common string formats (uuid, date-time, email) are detected so the
 * emitted OpenAPI subset is richer than just "type: string".
 */

const UUID_RE      = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;
const EMAIL_RE     = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

function inferSchema(value) {
  if (value === null || value === undefined) return { type: 'null' };
  if (typeof value === 'boolean') return { type: 'boolean' };
  if (typeof value === 'string') {
    if (UUID_RE.test(value))      return { type: 'string', format: 'uuid' };
    if (DATE_TIME_RE.test(value)) return { type: 'string', format: 'date-time' };
    if (EMAIL_RE.test(value))     return { type: 'string', format: 'email' };
    return { type: 'string' };
  }
  if (typeof value === 'number') {
    return Number.isInteger(value) ? { type: 'integer' } : { type: 'number' };
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return { type: 'array', items: {} };
    let items = inferSchema(value[0]);
    for (let i = 1; i < value.length; i++) {
      items = mergeSchemas(items, inferSchema(value[i]));
    }
    return { type: 'array', items };
  }
  if (typeof value === 'object') {
    const properties = {};
    const required = [];
    for (const [k, v] of Object.entries(value)) {
      properties[k] = inferSchema(v);
      // null values still register the key, but the field is not "required"
      // (it was present-but-null; another sample might omit it entirely).
      if (v !== null && v !== undefined) required.push(k);
    }
    const out = { type: 'object', properties };
    if (required.length > 0) out.required = required;
    return out;
  }
  return {};
}

function mergeSchemas(a, b) {
  if (!a || Object.keys(a).length === 0) return b || {};
  if (!b || Object.keys(b).length === 0) return a;
  if (a.type === 'null') return b;
  if (b.type === 'null') return a;

  if (a.type === b.type) {
    if (a.type === 'object') {
      const out = { type: 'object', properties: {} };
      const allKeys = new Set([
        ...Object.keys(a.properties || {}),
        ...Object.keys(b.properties || {}),
      ]);
      for (const k of allKeys) {
        const aProp = a.properties && a.properties[k];
        const bProp = b.properties && b.properties[k];
        out.properties[k] = aProp && bProp ? mergeSchemas(aProp, bProp) : (aProp || bProp);
      }
      // Required = INTERSECTION (a field is only "always present" if both samples had it).
      const aReq = new Set(a.required || []);
      const bReq = new Set(b.required || []);
      const intersect = [...aReq].filter(k => bReq.has(k));
      if (intersect.length > 0) out.required = intersect;
      return out;
    }
    if (a.type === 'array') {
      return { type: 'array', items: mergeSchemas(a.items || {}, b.items || {}) };
    }
    // Same primitive type. Keep `format` only if both samples agreed.
    const out = { type: a.type };
    if (a.format && a.format === b.format) out.format = a.format;
    return out;
  }

  // Type mismatch — widen numerically; otherwise fall back to string.
  if ((a.type === 'integer' && b.type === 'number') ||
      (a.type === 'number'  && b.type === 'integer')) {
    return { type: 'number' };
  }
  return { type: 'string' };
}

module.exports = { inferSchema, mergeSchemas };
