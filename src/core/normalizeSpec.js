'use strict';

/**
 * Normalize an OpenAPI spec into a flat, consistent internal model.
 * Resolves simple $ref references from components.schemas.
 */
function normalizeSpec(spec) {
  if (!spec || typeof spec !== 'object') {
    throw new Error('Invalid spec: must be an object');
  }

  const components = spec.components || {};
  const schemas = components.schemas || {};

  const endpoints = {};

  const paths = spec.paths || {};
  for (const [pathKey, pathItem] of Object.entries(paths)) {
    if (!pathItem || typeof pathItem !== 'object') continue;

    const methods = {};
    const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'];

    for (const method of HTTP_METHODS) {
      if (!pathItem[method]) continue;
      const operation = pathItem[method];
      methods[method] = normalizeOperation(operation, schemas);
    }

    if (Object.keys(methods).length > 0) {
      endpoints[pathKey] = methods;
    }
  }

  return {
    info: spec.info || {},
    endpoints,
    schemas: normalizeSchemaMap(schemas, schemas),
  };
}

function normalizeOperation(operation, schemas) {
  return {
    operationId: operation.operationId || null,
    summary: operation.summary || null,
    parameters: normalizeParameters(operation.parameters || [], schemas),
    requestBody: normalizeRequestBody(operation.requestBody, schemas),
    responses: normalizeResponses(operation.responses || {}, schemas),
  };
}

function normalizeParameters(params, schemas) {
  return params.map((p) => ({
    name: p.name,
    in: p.in,
    required: Boolean(p.required),
    schema: p.schema ? resolveSchema(p.schema, schemas) : null,
  }));
}

function normalizeRequestBody(requestBody, schemas) {
  if (!requestBody) return null;
  const content = requestBody.content || {};
  const mediaType = content['application/json'] || Object.values(content)[0];
  if (!mediaType || !mediaType.schema) return null;
  return resolveSchema(mediaType.schema, schemas);
}

function normalizeResponses(responses, schemas) {
  const result = {};
  for (const [statusCode, response] of Object.entries(responses)) {
    if (!response) continue;
    const content = response.content || {};
    const mediaType = content['application/json'] || Object.values(content)[0];
    result[statusCode] = mediaType && mediaType.schema
      ? resolveSchema(mediaType.schema, schemas)
      : null;
  }
  return result;
}

function normalizeSchemaMap(schemaMap, allSchemas) {
  const result = {};
  for (const [name, schema] of Object.entries(schemaMap)) {
    result[name] = resolveSchema(schema, allSchemas);
  }
  return result;
}

/**
 * Resolve a schema node, following simple $ref to components.schemas.
 * Returns a normalized schema node with { type, properties, required, items, enum }.
 */
function resolveSchema(schema, schemas, depth = 0) {
  if (!schema || typeof schema !== 'object') return { type: 'unknown' };
  if (depth > 10) return { type: 'circular' };

  if (schema.$ref) {
    const refName = schema.$ref.replace('#/components/schemas/', '');
    const resolved = schemas[refName];
    if (!resolved) return { type: 'unknown', ref: schema.$ref };
    return resolveSchema(resolved, schemas, depth + 1);
  }

  // Handle allOf / oneOf / anyOf by merging
  if (schema.allOf) {
    return mergeSchemas(schema.allOf, schemas, depth);
  }
  if (schema.oneOf || schema.anyOf) {
    const list = schema.oneOf || schema.anyOf;
    return mergeSchemas(list, schemas, depth);
  }

  const node = {
    type: schema.type || 'object',
    format: schema.format || null,
    enum: schema.enum || null,
    nullable: Boolean(schema.nullable),
    required: Array.isArray(schema.required) ? schema.required : [],
    properties: {},
    items: null,
    // Constraint fields — preserved so the diff engine can detect changes
    // to ranges/patterns/lengths (e.g. `maximum: 100` → `maximum: 250`).
    // `undefined` (not present) and `null` are treated as "no constraint"
    // by the diff engine; the explicit values flow through unchanged.
    minimum:    schema.minimum    !== undefined ? schema.minimum    : null,
    maximum:    schema.maximum    !== undefined ? schema.maximum    : null,
    minLength:  schema.minLength  !== undefined ? schema.minLength  : null,
    maxLength:  schema.maxLength  !== undefined ? schema.maxLength  : null,
    minItems:   schema.minItems   !== undefined ? schema.minItems   : null,
    maxItems:   schema.maxItems   !== undefined ? schema.maxItems   : null,
    pattern:    schema.pattern    || null,
    multipleOf: schema.multipleOf !== undefined ? schema.multipleOf : null,
  };

  if (schema.properties) {
    for (const [key, val] of Object.entries(schema.properties)) {
      node.properties[key] = resolveSchema(val, schemas, depth + 1);
    }
  }

  if (schema.items) {
    node.items = resolveSchema(schema.items, schemas, depth + 1);
  }

  return node;
}

function mergeSchemas(schemaList, schemas, depth) {
  const merged = { type: 'object', required: [], properties: {}, items: null, enum: null, nullable: false };
  for (const s of schemaList) {
    const resolved = resolveSchema(s, schemas, depth + 1);
    if (resolved.properties) Object.assign(merged.properties, resolved.properties);
    if (resolved.required) merged.required.push(...resolved.required);
    if (resolved.type && resolved.type !== 'object') merged.type = resolved.type;
    if (resolved.enum) merged.enum = resolved.enum;
  }
  return merged;
}

module.exports = { normalizeSpec, resolveSchema };
