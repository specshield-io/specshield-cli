'use strict';

const { normalizeSpec, resolveSchema } = require('../src/core/normalizeSpec');

describe('normalizeSpec - input validation', () => {
  test('throws on null input', () => {
    expect(() => normalizeSpec(null)).toThrow('Invalid spec');
  });

  test('throws on string input', () => {
    expect(() => normalizeSpec('openapi: 3.0.0')).toThrow('Invalid spec');
  });

  test('returns empty endpoints and schemas for empty spec', () => {
    const result = normalizeSpec({});
    expect(result.endpoints).toEqual({});
    expect(result.schemas).toEqual({});
  });
});

describe('normalizeSpec - endpoints', () => {
  test('normalizes HTTP methods on a path', () => {
    const spec = {
      paths: {
        '/users': {
          get: { responses: { '200': {} } },
          post: { responses: { '201': {} } },
        },
      },
    };
    const result = normalizeSpec(spec);
    expect(result.endpoints['/users']).toHaveProperty('get');
    expect(result.endpoints['/users']).toHaveProperty('post');
    expect(result.endpoints['/users']).not.toHaveProperty('put');
  });

  test('ignores non-HTTP-method keys on path item', () => {
    const spec = {
      paths: {
        '/users': {
          get: { responses: {} },
          summary: 'Users path',
          parameters: [],
        },
      },
    };
    const result = normalizeSpec(spec);
    expect(result.endpoints['/users']).toHaveProperty('get');
    expect(result.endpoints['/users']).not.toHaveProperty('summary');
    expect(result.endpoints['/users']).not.toHaveProperty('parameters');
  });

  test('normalizes path parameters', () => {
    const spec = {
      paths: {
        '/pets/{id}': {
          get: {
            parameters: [
              { name: 'id', in: 'path', required: true, schema: { type: 'integer' } },
              { name: 'fields', in: 'query', required: false, schema: { type: 'string' } },
            ],
            responses: {},
          },
        },
      },
    };
    const result = normalizeSpec(spec);
    const params = result.endpoints['/pets/{id}'].get.parameters;
    expect(params).toHaveLength(2);
    expect(params[0]).toMatchObject({ name: 'id', in: 'path', required: true });
    expect(params[1]).toMatchObject({ name: 'fields', in: 'query', required: false });
  });

  test('normalizes request body from application/json', () => {
    const spec = {
      paths: {
        '/pets': {
          post: {
            requestBody: {
              content: {
                'application/json': {
                  schema: { type: 'object', properties: { name: { type: 'string' } } },
                },
              },
            },
            responses: {},
          },
        },
      },
    };
    const result = normalizeSpec(spec);
    const reqBody = result.endpoints['/pets'].post.requestBody;
    expect(reqBody.type).toBe('object');
    expect(reqBody.properties).toHaveProperty('name');
  });

  test('returns null requestBody when not present', () => {
    const spec = {
      paths: { '/ping': { get: { responses: { '200': {} } } } },
    };
    const result = normalizeSpec(spec);
    expect(result.endpoints['/ping'].get.requestBody).toBeNull();
  });

  test('normalizes response schemas', () => {
    const spec = {
      paths: {
        '/users': {
          get: {
            responses: {
              '200': {
                content: {
                  'application/json': {
                    schema: { type: 'object', properties: { id: { type: 'integer' } } },
                  },
                },
              },
            },
          },
        },
      },
    };
    const result = normalizeSpec(spec);
    const resp200 = result.endpoints['/users'].get.responses['200'];
    expect(resp200.type).toBe('object');
    expect(resp200.properties).toHaveProperty('id');
  });
});

describe('normalizeSpec - component schemas', () => {
  test('normalizes component schemas', () => {
    const spec = {
      components: {
        schemas: {
          User: { type: 'object', properties: { id: { type: 'integer' } } },
        },
      },
      paths: {},
    };
    const result = normalizeSpec(spec);
    expect(result.schemas).toHaveProperty('User');
    expect(result.schemas.User.type).toBe('object');
  });
});

describe('resolveSchema - $ref resolution', () => {
  const schemas = {
    Pet: {
      type: 'object',
      properties: { name: { type: 'string' }, age: { type: 'integer' } },
      required: ['name'],
    },
  };

  test('resolves a valid $ref', () => {
    const result = resolveSchema({ $ref: '#/components/schemas/Pet' }, schemas);
    expect(result.type).toBe('object');
    expect(result.properties).toHaveProperty('name');
    expect(result.required).toContain('name');
  });

  test('returns unknown for unresolvable $ref', () => {
    const result = resolveSchema({ $ref: '#/components/schemas/Missing' }, schemas);
    expect(result.type).toBe('unknown');
  });

  test('handles allOf by merging properties', () => {
    const localSchemas = {
      A: { type: 'object', properties: { a: { type: 'string' } } },
      B: { type: 'object', properties: { b: { type: 'integer' } } },
    };
    const result = resolveSchema(
      { allOf: [{ $ref: '#/components/schemas/A' }, { $ref: '#/components/schemas/B' }] },
      localSchemas
    );
    expect(result.properties).toHaveProperty('a');
    expect(result.properties).toHaveProperty('b');
  });

  test('keeps oneOf variants separate (variant-aware, not merged)', () => {
    const localSchemas = {
      X: { type: 'object', properties: { x: { type: 'string' } } },
      Y: { type: 'object', properties: { y: { type: 'integer' } } },
    };
    const result = resolveSchema(
      { oneOf: [{ $ref: '#/components/schemas/X' }, { $ref: '#/components/schemas/Y' }] },
      localSchemas
    );
    // oneOf is no longer flattened into one object — each variant is preserved
    // so the diff engine can compare variants individually.
    expect(Array.isArray(result.oneOf)).toBe(true);
    expect(result.oneOf).toHaveLength(2);
    expect(result.oneOf[0].properties).toHaveProperty('x');
    expect(result.oneOf[1].properties).toHaveProperty('y');
  });

  test('handles circular references without throwing', () => {
    const circularSchemas = {
      Node: {
        type: 'object',
        properties: { child: { $ref: '#/components/schemas/Node' } },
      },
    };
    expect(() =>
      resolveSchema({ $ref: '#/components/schemas/Node' }, circularSchemas)
    ).not.toThrow();
  });

  test('normalizes array with items', () => {
    const result = resolveSchema({ type: 'array', items: { type: 'string' } }, {});
    expect(result.type).toBe('array');
    expect(result.items).toMatchObject({ type: 'string' });
  });

  test('returns unknown for null/undefined input', () => {
    expect(resolveSchema(null, {})).toMatchObject({ type: 'unknown' });
    expect(resolveSchema(undefined, {})).toMatchObject({ type: 'unknown' });
  });
});
