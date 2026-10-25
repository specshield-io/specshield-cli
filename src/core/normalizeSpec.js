'use strict';

/**
 * Normalize an OpenAPI spec into a flat, consistent internal model.
 * Resolves simple $ref references from components.schemas.
 *
 * Swagger 2.0 is mapped onto the same model: `definitions` stand in for
 * components.schemas, the `in: body` parameter becomes the request body,
 * `responses.<code>.schema` is the response schema, and non-body parameters
 * carry their type inline instead of under `schema`. Path-level parameters
 * and `$ref` parameters/responses are resolved for both versions.
 */
function normalizeSpec(spec) {
  if (!spec || typeof spec !== 'object') {
    throw new Error('Invalid spec: must be an object');
  }

  const components = spec.components || {};
  const schemas = components.schemas || spec.definitions || {};
  const ctx = {
    schemas,
    parameters: components.parameters || spec.parameters || {},
    responses: components.responses || spec.responses || {},
  };

  const endpoints = {};

  const paths = spec.paths || {};
  for (const [pathKey, pathItem] of Object.entries(paths)) {
    if (!pathItem || typeof pathItem !== 'object') continue;

    const methods = {};
    const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'];

    for (const method of HTTP_METHODS) {
      if (!pathItem[method]) continue;
      const operation = pathItem[method];
      methods[method] = normalizeOperation(operation, pathItem.parameters, ctx);
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

function normalizeOperation(operation, pathParams, ctx) {
  const { schemas } = ctx;
  const params = mergeParameters(pathParams, operation.parameters, ctx);
  const body = params.find((p) => p.in === 'body');      // Swagger 2.0
  return {
    operationId: operation.operationId || null,
    summary: operation.summary || null,
    parameters: normalizeParameters(params.filter((p) => p.in !== 'body'), schemas),
    requestBody: body
      ? (body.schema ? resolveSchema(body.schema, schemas) : null)
      : normalizeRequestBody(operation.requestBody, schemas),
    responses: normalizeResponses(operation.responses || {}, ctx),
  };
}

/** Path-level parameters apply to every operation; an operation-level one with the same (in, name) overrides. */
function mergeParameters(pathParams, opParams, ctx) {
  const byKey = new Map();
  for (const raw of [...(Array.isArray(pathParams) ? pathParams : []), ...(Array.isArray(opParams) ? opParams : [])]) {
    const p = derefParameter(raw, ctx);
    if (!p || !p.name || !p.in) continue;
    byKey.set(`${p.in}:${p.name}`, p);
  }
  return [...byKey.values()];
}

function derefParameter(p, ctx) {
  if (!p || typeof p !== 'object' || !p.$ref) return p;
  const name = refName(p.$ref, ['#/components/parameters/', '#/parameters/']);
  return name ? ctx.parameters[name] || null : null;
}

function normalizeParameters(params, schemas) {
  return params.map((p) => ({
    name: p.name,
    in: p.in,
    required: Boolean(p.required),
    // Swagger 2.0 non-body parameters declare type/format/items/enum inline.
    schema: p.schema
      ? resolveSchema(p.schema, schemas)
      : p.type ? resolveSchema(inlineParamSchema(p), schemas) : null,
  }));
}

function inlineParamSchema(p) {
  const { name, in: _in, required, description, collectionFormat, allowEmptyValue, ...schema } = p;
  return schema;
}

function refName(ref, prefixes) {
  for (const prefix of prefixes) {
    if (typeof ref === 'string' && ref.startsWith(prefix)) return ref.slice(prefix.length);
  }
  return null;
}

function normalizeRequestBody(requestBody, schemas) {
  if (!requestBody) return null;
  const content = requestBody.content || {};
  const mediaType = content['application/json'] || Object.values(content)[0];
  if (!mediaType || !mediaType.schema) return null;
  return resolveSchema(mediaType.schema, schemas);
}

function normalizeResponses(responses, ctx) {
  const { schemas } = ctx;
  const result = {};
  for (const [statusCode, raw] of Object.entries(responses)) {
    const response = raw && raw.$ref
      ? ctx.responses[refName(raw.$ref, ['#/components/responses/', '#/responses/'])]
      : raw;
    if (!response) continue;
    if (response.schema) {                                  // Swagger 2.0
      result[statusCode] = resolveSchema(response.schema, schemas);
      continue;
    }
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
    const name = refName(schema.$ref, ['#/components/schemas/', '#/definitions/']);
    const resolved = name ? schemas[name] : undefined;
    if (!resolved) return { type: 'unknown', ref: schema.$ref };
    return resolveSchema(resolved, schemas, depth + 1);
  }

  // allOf = composition → merge into one combined object.
  if (schema.allOf) {
    return mergeSchemas(schema.allOf, schemas, depth);
  }
  // oneOf / anyOf are NOT merged — they're kept as separate variants below so
  // the diff engine can compare variants individually (added/removed variants
  // + per-variant field changes). This matches the backend's variant-aware
  // model; merging would lose variant identity and over-mark `required`.

  // OpenAPI 3.1 expresses nullability as a type array: `type: [x, "null"]`.
  // Normalize that to a single base type + nullable flag so it compares cleanly
  // against 3.0's `nullable: true` form and doesn't surface a bogus type change.
  let resolvedType = schema.type;
  let resolvedNullable = Boolean(schema.nullable);
  if (Array.isArray(resolvedType)) {
    if (resolvedType.includes('null')) resolvedNullable = true;
    resolvedType = resolvedType.find((t) => t !== 'null') || 'object';
  }

  const node = {
    type: resolvedType || 'object',
    format: schema.format || null,
    enum: schema.enum || null,
    nullable: resolvedNullable,
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

  // additionalProperties as a schema = a free-form map/dictionary value type
  // (e.g. Map<String, Metric>). Boolean true/false is not a value schema.
  if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
    node.additionalProperties = resolveSchema(schema.additionalProperties, schemas, depth + 1);
  }

  // oneOf / anyOf variants kept separate (variant-aware model).
  if (Array.isArray(schema.oneOf)) {
    node.oneOf = schema.oneOf.map((s) => resolveSchema(s, schemas, depth + 1));
  }
  if (Array.isArray(schema.anyOf)) {
    node.anyOf = schema.anyOf.map((s) => resolveSchema(s, schemas, depth + 1));
  }
  if (schema.discriminator && schema.discriminator.propertyName) {
    node.discriminator = schema.discriminator.propertyName;
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
