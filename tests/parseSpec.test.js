'use strict';

const { parseSpec, parseJson, parseYaml } = require('../src/core/parseSpec');

describe('parseSpec', () => {
  test('parses valid JSON spec', () => {
    const content = JSON.stringify({ openapi: '3.0.0', info: { title: 'Test', version: '1.0' }, paths: {} });
    const result = parseSpec(content, 'spec.json');
    expect(result.openapi).toBe('3.0.0');
  });

  test('parses valid YAML spec', () => {
    const content = `openapi: "3.0.0"\ninfo:\n  title: Test\n  version: "1.0"\npaths: {}`;
    const result = parseSpec(content, 'spec.yaml');
    expect(result.openapi).toBe('3.0.0');
  });

  test('auto-detects JSON without extension', () => {
    const content = JSON.stringify({ openapi: '3.0.0', paths: {} });
    const result = parseSpec(content, 'specfile');
    expect(result.openapi).toBe('3.0.0');
  });

  test('auto-detects YAML without extension', () => {
    const content = `openapi: "3.0.0"\npaths: {}`;
    const result = parseSpec(content, 'specfile');
    expect(result.openapi).toBe('3.0.0');
  });

  test('throws on invalid JSON', () => {
    expect(() => parseSpec('{invalid json}', 'spec.json')).toThrow();
  });

  test('throws on invalid YAML', () => {
    expect(() => parseSpec('key: [invalid', 'spec.yaml')).toThrow();
  });

  // ─── F2 regression — non-OpenAPI input is rejected ──────────────────────
  // Previously, files like `hello: world` were silently accepted and would
  // compare as "no changes" against anything — a confusing footgun. The
  // assertLooksLikeOpenApi check rejects them up front.

  test('rejects valid YAML that is not an OpenAPI/Swagger spec', () => {
    expect(() => parseSpec('hello: world', 'bad.yaml'))
      .toThrow(/not a valid OpenAPI\/Swagger spec/);
  });

  test('rejects valid JSON that is not an OpenAPI/Swagger spec', () => {
    expect(() => parseSpec(JSON.stringify({ random: 'data' }), 'bad.json'))
      .toThrow(/not a valid OpenAPI\/Swagger spec/);
  });

  test('rejects YAML with openapi key but wrong version (2.x)', () => {
    expect(() => parseSpec('openapi: "2.0"\npaths: {}', 'spec.yaml'))
      .toThrow(/not a valid OpenAPI\/Swagger spec/);
  });

  test('accepts Swagger 2.0 (top-level `swagger:` key)', () => {
    const result = parseSpec('swagger: "2.0"\npaths: {}', 'spec.yaml');
    expect(result.swagger).toBe('2.0');
  });
});
