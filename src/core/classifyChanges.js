'use strict';

/**
 * Classify raw diffs into breaking changes, additions, modifications, warnings.
 */

const BREAKING_TYPES = new Set([
  'ENDPOINT_REMOVED',
  'METHOD_REMOVED',
  'PARAMETER_REMOVED',
  'PARAMETER_TYPE_CHANGED',
  'PARAMETER_BECAME_REQUIRED',
  'REQUEST_FIELD_REMOVED',
  'REQUEST_FIELD_TYPE_CHANGED',
  'REQUEST_REQUIRED_FIELD_ADDED',
  'RESPONSE_FIELD_REMOVED',
  'RESPONSE_FIELD_TYPE_CHANGED',
  'RESPONSE_REMOVED',
  'FIELD_BECAME_REQUIRED',
  'ENUM_VALUE_REMOVED',
  'REQUEST_TYPE_CHANGED',
  'RESPONSE_TYPE_CHANGED',
  'SCHEMA_REMOVED',
]);

const ADDITION_TYPES = new Set([
  'ENDPOINT_ADDED',
  'METHOD_ADDED',
  'PARAMETER_ADDED',
  'REQUEST_FIELD_ADDED',
  'RESPONSE_FIELD_ADDED',
  'RESPONSE_ADDED',
  'SCHEMA_ADDED',
]);

const MODIFICATION_TYPES = new Set([
  'FIELD_BECAME_OPTIONAL',
  'PARAMETER_BECAME_OPTIONAL',
]);

const WARNING_TYPES = new Set([
  // future use
]);

// Numeric order: higher = more severe
const SEVERITY_ORDER = { error: 2, warning: 1, info: 0 };

function classifyChanges(diffs) {
  const result = {
    breakingChanges: [],
    additions: [],
    modifications: [],
    warnings: [],
  };

  for (const diff of diffs) {
    const change = {
      type: diff.type,
      path: diff.path || null,
      method: diff.method || null,
      field: diff.field || null,
      oldValue: diff.oldValue || null,
      newValue: diff.newValue || null,
      description: diff.description,
    };

    if (BREAKING_TYPES.has(diff.type)) {
      change.severity = 'error';
      result.breakingChanges.push(change);
    } else if (ADDITION_TYPES.has(diff.type)) {
      change.severity = 'info';
      result.additions.push(change);
    } else if (MODIFICATION_TYPES.has(diff.type)) {
      change.severity = 'warning';
      result.modifications.push(change);
    } else if (WARNING_TYPES.has(diff.type)) {
      change.severity = 'warning';
      result.warnings.push(change);
    } else {
      // Unknown type — treat as modification
      change.severity = 'warning';
      result.modifications.push(change);
    }
  }

  // Dedupe $ref-driven changes. When a schema property is added/removed/typed,
  // the change appears once per endpoint that references the schema — which
  // produces "6 breaking changes" reports when really one schema field was
  // removed and it rippled through 4 endpoints. Group entries with the same
  // (type, leafFieldName) and collapse them into one entry that names every
  // affected endpoint. See `mergeDuplicateFieldChanges` for the rules.
  result.breakingChanges = mergeDuplicateFieldChanges(result.breakingChanges);
  result.additions       = mergeDuplicateFieldChanges(result.additions);
  result.modifications   = mergeDuplicateFieldChanges(result.modifications);
  result.warnings        = mergeDuplicateFieldChanges(result.warnings);

  return result;
}

// Types whose multi-counting is almost always caused by a $ref'd component
// schema being inlined into many endpoint responses/requests. Safe to dedupe.
const FIELD_DEDUPE_TYPES = new Set([
  'RESPONSE_FIELD_REMOVED',
  'RESPONSE_FIELD_ADDED',
  'RESPONSE_FIELD_TYPE_CHANGED',
  'REQUEST_FIELD_REMOVED',
  'REQUEST_FIELD_ADDED',
  'REQUEST_FIELD_TYPE_CHANGED',
  'REQUEST_REQUIRED_FIELD_ADDED',
  'FIELD_BECAME_REQUIRED',
  'FIELD_BECAME_OPTIONAL',
  'ENUM_VALUE_REMOVED',
]);

/**
 * Returns the leaf field name from a dotted/bracketed field path so we can
 * dedupe by component-property name rather than full positional path.
 *
 *   responses.200.data[items].legacy_id  →  legacy_id
 *   responses.201.legacy_id              →  legacy_id
 *   requestBody.email                    →  email
 *
 * Both rows above share leaf "legacy_id", so they're recognised as the same
 * schema-level change.
 */
function leafFieldName(field) {
  if (!field) return null;
  const parts = field.split('.');
  const last = parts[parts.length - 1];
  // Strip trailing array marker like "data[items]" → "data"
  return last.replace(/\[.*$/, '');
}

/**
 * Collapses entries that have the same (type, leafFieldName) into one entry
 * with an `affectedEndpoints` array of every `${METHOD} ${path}` it appeared
 * under. The original first-seen entry is kept as the canonical record; its
 * description is rewritten to lead with the field name and end with the
 * affected-endpoint count.
 *
 * Non-field types (ENDPOINT_*, METHOD_*, SCHEMA_*, PARAMETER_*) pass through
 * untouched — they're already at the right granularity.
 */
function mergeDuplicateFieldChanges(entries) {
  const groups = new Map();
  const passthrough = [];

  for (const change of entries) {
    if (!FIELD_DEDUPE_TYPES.has(change.type) || !change.field) {
      passthrough.push(change);
      continue;
    }
    const leaf = leafFieldName(change.field);
    const key = `${change.type}::${leaf}`;
    if (!groups.has(key)) {
      groups.set(key, { canonical: { ...change }, endpoints: [] });
    }
    if (change.path && change.method) {
      groups.get(key).endpoints.push(`${change.method.toUpperCase()} ${change.path}`);
    }
  }

  const merged = [];
  for (const { canonical, endpoints } of groups.values()) {
    if (endpoints.length <= 1) {
      // Single occurrence — keep the original detailed description.
      merged.push(canonical);
      continue;
    }
    const leaf = leafFieldName(canonical.field);
    canonical.affectedEndpoints = endpoints;
    canonical.description = describeMergedChange(canonical.type, leaf, endpoints);
    // Strip path/method from the canonical entry since it now applies to many.
    canonical.path = null;
    canonical.method = null;
    merged.push(canonical);
  }

  return [...merged, ...passthrough];
}

function describeMergedChange(type, leaf, endpoints) {
  const n = endpoints.length;
  const VERBS = {
    RESPONSE_FIELD_REMOVED:        `Response field "${leaf}" was removed`,
    RESPONSE_FIELD_ADDED:          `Response field "${leaf}" was added`,
    RESPONSE_FIELD_TYPE_CHANGED:   `Response field "${leaf}" changed type`,
    REQUEST_FIELD_REMOVED:         `Request field "${leaf}" was removed`,
    REQUEST_FIELD_ADDED:           `Request field "${leaf}" was added`,
    REQUEST_FIELD_TYPE_CHANGED:    `Request field "${leaf}" changed type`,
    REQUEST_REQUIRED_FIELD_ADDED:  `Required request field "${leaf}" was added`,
    FIELD_BECAME_REQUIRED:         `Field "${leaf}" became required`,
    FIELD_BECAME_OPTIONAL:         `Field "${leaf}" became optional`,
    ENUM_VALUE_REMOVED:            `Enum value removed from "${leaf}"`,
  };
  const head = VERBS[type] || `Change in "${leaf}"`;
  return `${head} (affects ${n} endpoint${n === 1 ? '' : 's'}: ${endpoints.join(', ')})`;
}

/**
 * Filter a classified result to only include changes at or above minSeverity.
 * info < warning < error
 */
function filterBySeverity(result, minSeverity) {
  const minLevel = SEVERITY_ORDER[minSeverity] ?? 0;
  const passes = (c) => (SEVERITY_ORDER[c.severity] ?? 0) >= minLevel;
  return {
    breakingChanges: result.breakingChanges.filter(passes),
    additions: result.additions.filter(passes),
    modifications: result.modifications.filter(passes),
    warnings: result.warnings.filter(passes),
  };
}

module.exports = { classifyChanges, filterBySeverity };
