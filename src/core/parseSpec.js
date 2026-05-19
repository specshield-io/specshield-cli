'use strict';

const yaml = require('js-yaml');
const path = require('path');

/**
 * Parse raw spec content (YAML or JSON) into a JavaScript object.
 * Detects format from file extension or content. Validates that the parsed
 * object looks like an OpenAPI 3.x or Swagger 2.x spec — otherwise a file
 * containing arbitrary YAML/JSON would silently succeed with "No changes
 * detected" instead of erroring out.
 */
function parseSpec(content, filePath) {
  const ext = filePath ? path.extname(filePath).toLowerCase() : '';

  let parsed;
  try {
    if (ext === '.json') {
      parsed = parseJson(content);
    } else if (ext === '.yaml' || ext === '.yml') {
      parsed = parseYaml(content);
    } else {
      // Auto-detect: try JSON first, then YAML
      parsed = autoDetect(content);
    }
  } catch (err) {
    throw new Error(`Failed to parse spec "${filePath}": ${err.message}`);
  }

  assertLooksLikeOpenApi(parsed, filePath);
  return parsed;
}

/**
 * Confirms the parsed object has a top-level `openapi: "3.x"` or `swagger: "..."`
 * key — the minimum surface that defines an OpenAPI/Swagger document. Without
 * this check, a stray YAML/JSON file would silently compare as identical to
 * anything that doesn't share its incidental keys.
 */
function assertLooksLikeOpenApi(parsed, filePath) {
  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`"${filePath}" is not a valid OpenAPI/Swagger spec (parsed value was not an object)`);
  }
  const isOpenApi3 = typeof parsed.openapi === 'string' && parsed.openapi.startsWith('3.');
  const isSwagger2 = typeof parsed.swagger === 'string';
  if (!isOpenApi3 && !isSwagger2) {
    throw new Error(
      `"${filePath}" is not a valid OpenAPI/Swagger spec ` +
      '(missing top-level "openapi: 3.x" or "swagger: ..." key)');
  }
}

function parseJson(content) {
  try {
    return JSON.parse(content);
  } catch (err) {
    throw new Error(`Invalid JSON: ${err.message}`);
  }
}

function parseYaml(content) {
  const result = yaml.load(content);
  if (result === null || typeof result !== 'object') {
    throw new Error('YAML did not produce a valid object');
  }
  return result;
}

function autoDetect(content) {
  const trimmed = content.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    return parseJson(content);
  }
  return parseYaml(content);
}

module.exports = { parseSpec, parseJson, parseYaml };
