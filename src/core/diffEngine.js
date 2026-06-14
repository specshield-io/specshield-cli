'use strict';

/**
 * Compare two normalized specs and return a flat list of raw diffs.
 * Each diff: { type, path, method, field, oldValue, newValue, description }
 */
function diffSpecs(base, target) {
  const diffs = [];

  diffEndpoints(base.endpoints || {}, target.endpoints || {}, diffs);
  diffSchemas(base.schemas || {}, target.schemas || {}, diffs);

  return diffs;
}

// ─── Endpoints ──────────────────────────────────────────────────────────────

function diffEndpoints(baseEndpoints, targetEndpoints, diffs) {
  // Removed paths
  for (const path of Object.keys(baseEndpoints)) {
    if (!targetEndpoints[path]) {
      for (const method of Object.keys(baseEndpoints[path])) {
        diffs.push({
          type: 'ENDPOINT_REMOVED',
          path,
          method,
          description: `${method.toUpperCase()} ${path} was removed`,
        });
      }
    } else {
      diffMethods(path, baseEndpoints[path], targetEndpoints[path], diffs);
    }
  }

  // Added paths
  for (const path of Object.keys(targetEndpoints)) {
    if (!baseEndpoints[path]) {
      for (const method of Object.keys(targetEndpoints[path])) {
        diffs.push({
          type: 'ENDPOINT_ADDED',
          path,
          method,
          description: `${method.toUpperCase()} ${path} was added`,
        });
      }
    }
  }
}

function diffMethods(path, baseMethods, targetMethods, diffs) {
  for (const method of Object.keys(baseMethods)) {
    if (!targetMethods[method]) {
      diffs.push({
        type: 'METHOD_REMOVED',
        path,
        method,
        description: `${method.toUpperCase()} ${path} method was removed`,
      });
    } else {
      diffOperation(path, method, baseMethods[method], targetMethods[method], diffs);
    }
  }

  for (const method of Object.keys(targetMethods)) {
    if (!baseMethods[method]) {
      diffs.push({
        type: 'METHOD_ADDED',
        path,
        method,
        description: `${method.toUpperCase()} ${path} method was added`,
      });
    }
  }
}

function diffOperation(path, method, baseOp, targetOp, diffs) {
  diffParameters(path, method, baseOp.parameters || [], targetOp.parameters || [], diffs);
  diffSchemaNode(path, method, 'requestBody', baseOp.requestBody, targetOp.requestBody, diffs, true);
  diffResponses(path, method, baseOp.responses || {}, targetOp.responses || {}, diffs);
}

// ─── Parameters ─────────────────────────────────────────────────────────────

function diffParameters(path, method, baseParams, targetParams, diffs) {
  const baseMap = toParamMap(baseParams);
  const targetMap = toParamMap(targetParams);

  for (const key of Object.keys(baseMap)) {
    if (!targetMap[key]) {
      const p = baseMap[key];
      diffs.push({
        type: 'PARAMETER_REMOVED',
        path,
        method,
        field: `parameters.${p.name}`,
        description: `Parameter "${p.name}" (${p.in}) was removed from ${method.toUpperCase()} ${path}`,
      });
    } else {
      const bp = baseMap[key];
      const tp = targetMap[key];
      const baseType = schemaTypeStr(bp.schema);
      const targetType = schemaTypeStr(tp.schema);

      if (baseType !== targetType) {
        diffs.push({
          type: 'PARAMETER_TYPE_CHANGED',
          path,
          method,
          field: `parameters.${bp.name}`,
          oldValue: baseType,
          newValue: targetType,
          description: `Parameter "${bp.name}" type changed from "${baseType}" to "${targetType}" in ${method.toUpperCase()} ${path}`,
        });
      }

      if (bp.required !== tp.required) {
        diffs.push({
          type: tp.required ? 'PARAMETER_BECAME_REQUIRED' : 'PARAMETER_BECAME_OPTIONAL',
          path,
          method,
          field: `parameters.${bp.name}`,
          oldValue: String(bp.required),
          newValue: String(tp.required),
          description: `Parameter "${bp.name}" became ${tp.required ? 'required' : 'optional'} in ${method.toUpperCase()} ${path}`,
        });
      }

      // Constraint changes on the parameter's schema (min/max, length,
      // pattern, enum). Tightening = breaking; loosening = modification.
      diffConstraints(
        path, method, `parameters.${bp.name}`, bp.schema, tp.schema, diffs);
    }
  }

  for (const key of Object.keys(targetMap)) {
    if (!baseMap[key]) {
      const p = targetMap[key];
      diffs.push({
        type: 'PARAMETER_ADDED',
        path,
        method,
        field: `parameters.${p.name}`,
        description: `Parameter "${p.name}" (${p.in}) was added to ${method.toUpperCase()} ${path}`,
      });
    }
  }
}

function toParamMap(params) {
  const map = {};
  for (const p of params) {
    map[`${p.in}:${p.name}`] = p;
  }
  return map;
}

// ─── Responses ──────────────────────────────────────────────────────────────

function diffResponses(path, method, baseResponses, targetResponses, diffs) {
  for (const statusCode of Object.keys(baseResponses)) {
    if (!(statusCode in targetResponses)) {
      diffs.push({
        type: 'RESPONSE_REMOVED',
        path,
        method,
        field: `responses.${statusCode}`,
        description: `Response status ${statusCode} was removed from ${method.toUpperCase()} ${path}`,
      });
    } else {
      diffSchemaNode(path, method, `responses.${statusCode}`, baseResponses[statusCode], targetResponses[statusCode], diffs, false);
    }
  }

  for (const statusCode of Object.keys(targetResponses)) {
    if (!(statusCode in baseResponses)) {
      diffs.push({
        type: 'RESPONSE_ADDED',
        path,
        method,
        field: `responses.${statusCode}`,
        description: `Response status ${statusCode} was added to ${method.toUpperCase()} ${path}`,
      });
    }
  }
}

// ─── Schema diffing ─────────────────────────────────────────────────────────

function diffSchemaNode(path, method, fieldPrefix, base, target, diffs, isRequest) {
  if (!base && !target) return;
  if (!base || !target) return;

  const baseProps = base.properties || {};
  const targetProps = target.properties || {};
  const baseRequired = base.required || [];
  const targetRequired = target.required || [];

  // Check type change at node level
  if (base.type && target.type && base.type !== target.type) {
    diffs.push({
      type: isRequest ? 'REQUEST_TYPE_CHANGED' : 'RESPONSE_TYPE_CHANGED',
      path,
      method,
      field: fieldPrefix,
      oldValue: base.type,
      newValue: target.type,
      description: `Type of "${fieldPrefix}" changed from "${base.type}" to "${target.type}" in ${method.toUpperCase()} ${path}`,
    });
  }

  // Check enum changes
  diffEnums(path, method, fieldPrefix, base.enum, target.enum, diffs);

  // Removed properties
  for (const field of Object.keys(baseProps)) {
    const fullField = `${fieldPrefix}.${field}`;
    if (!targetProps[field]) {
      diffs.push({
        type: isRequest ? 'REQUEST_FIELD_REMOVED' : 'RESPONSE_FIELD_REMOVED',
        path,
        method,
        field: fullField,
        description: `Field "${fullField}" was removed from ${method.toUpperCase()} ${path}`,
      });
    } else {
      const bField = baseProps[field];
      const tField = targetProps[field];

      // Type change
      const bType = schemaTypeStr(bField);
      const tType = schemaTypeStr(tField);
      if (bType !== tType) {
        diffs.push({
          type: isRequest ? 'REQUEST_FIELD_TYPE_CHANGED' : 'RESPONSE_FIELD_TYPE_CHANGED',
          path,
          method,
          field: fullField,
          oldValue: bType,
          newValue: tType,
          description: `Field "${fullField}" type changed from "${bType}" to "${tType}" in ${method.toUpperCase()} ${path}`,
        });
      }

      // Required changed
      const wasRequired = baseRequired.includes(field);
      const isRequired = targetRequired.includes(field);
      if (!wasRequired && isRequired) {
        diffs.push({
          type: 'FIELD_BECAME_REQUIRED',
          path,
          method,
          field: fullField,
          description: `Field "${fullField}" became required in ${method.toUpperCase()} ${path}`,
        });
      } else if (wasRequired && !isRequired) {
        diffs.push({
          type: 'FIELD_BECAME_OPTIONAL',
          path,
          method,
          field: fullField,
          description: `Field "${fullField}" became optional in ${method.toUpperCase()} ${path}`,
        });
      }

      // Enum changes on field
      diffEnums(path, method, fullField, bField.enum, tField.enum, diffs);

      // Constraint changes on the field's schema (min/max, length, pattern).
      diffConstraints(path, method, fullField, bField, tField, diffs);

      // Recurse into nested objects
      if (bField.properties || tField.properties) {
        diffSchemaNode(path, method, fullField, bField, tField, diffs, isRequest);
      }
    }
  }

  // Added properties
  for (const field of Object.keys(targetProps)) {
    if (!baseProps[field]) {
      const fullField = `${fieldPrefix}.${field}`;
      const isRequired = targetRequired.includes(field);
      diffs.push({
        type: isRequest
          ? isRequired ? 'REQUEST_REQUIRED_FIELD_ADDED' : 'REQUEST_FIELD_ADDED'
          : 'RESPONSE_FIELD_ADDED',
        path,
        method,
        field: fullField,
        description: `Field "${fullField}" was added to ${method.toUpperCase()} ${path}${isRequest && isRequired ? ' (required)' : ''}`,
      });
    }
  }

  // Diff array items
  if (base.items || target.items) {
    const itemsField = `${fieldPrefix}[items]`;
    if (base.items && target.items) {
      const baseItemType = schemaTypeStr(base.items);
      const targetItemType = schemaTypeStr(target.items);
      if (baseItemType !== targetItemType) {
        diffs.push({
          type: isRequest ? 'REQUEST_FIELD_TYPE_CHANGED' : 'RESPONSE_FIELD_TYPE_CHANGED',
          path,
          method,
          field: itemsField,
          oldValue: baseItemType,
          newValue: targetItemType,
          description: `Array item type of "${fieldPrefix}" changed from "${baseItemType}" to "${targetItemType}" in ${method.toUpperCase()} ${path}`,
        });
      }
      // Recurse into items if they contain object properties
      if (base.items.properties || target.items.properties) {
        diffSchemaNode(path, method, itemsField, base.items, target.items, diffs, isRequest);
      }
    } else if (base.items && !target.items) {
      diffs.push({
        type: isRequest ? 'REQUEST_FIELD_REMOVED' : 'RESPONSE_FIELD_REMOVED',
        path,
        method,
        field: itemsField,
        description: `Array items schema was removed from "${fieldPrefix}" in ${method.toUpperCase()} ${path}`,
      });
    }
  }

  // additionalProperties (free-form map): compare the value schema so a
  // breaking change inside map values is caught. ".<*>" denotes "any key".
  if (base.additionalProperties || target.additionalProperties) {
    const apField = `${fieldPrefix}.<*>`;
    if (base.additionalProperties && target.additionalProperties) {
      diffSchemaNode(path, method, apField, base.additionalProperties, target.additionalProperties, diffs, isRequest);
    } else if (base.additionalProperties && !target.additionalProperties) {
      diffs.push({
        type: isRequest ? 'REQUEST_FIELD_REMOVED' : 'RESPONSE_FIELD_REMOVED',
        path,
        method,
        field: apField,
        description: `Map value schema (additionalProperties) removed from "${fieldPrefix}" in ${method.toUpperCase()} ${path}`,
      });
    }
  }

  // Discriminator rename/removal — breaks consumers keyed on the old name.
  if (base.discriminator && base.discriminator !== target.discriminator) {
    diffs.push({
      type: 'SCHEMA_DISCRIMINATOR_CHANGED',
      path,
      method,
      field: `${fieldPrefix}.discriminator`,
      oldValue: base.discriminator,
      newValue: target.discriminator || null,
      description: `Discriminator at "${fieldPrefix}" changed from "${base.discriminator}" to "${target.discriminator || '(none)'}" in ${method.toUpperCase()} ${path}`,
    });
  }

  // oneOf / anyOf variant comparison (positional; field-level changes inside a
  // matched variant are caught by recursion). Mirrors the backend engine.
  diffVariants(path, method, `${fieldPrefix}.oneOf`, base.oneOf, target.oneOf, diffs, isRequest);
  diffVariants(path, method, `${fieldPrefix}.anyOf`, base.anyOf, target.anyOf, diffs, isRequest);
}

function diffVariants(path, method, fieldPrefix, baseVariants, targetVariants, diffs, isRequest) {
  const b = Array.isArray(baseVariants) ? baseVariants : [];
  const t = Array.isArray(targetVariants) ? targetVariants : [];
  if (b.length === 0 && t.length === 0) return;

  const matched = Math.min(b.length, t.length);
  for (let i = 0; i < matched; i++) {
    diffSchemaNode(path, method, `${fieldPrefix}[${i}]`, b[i], t[i], diffs, isRequest);
  }
  for (let i = t.length; i < b.length; i++) {
    diffs.push({
      type: 'SCHEMA_VARIANT_REMOVED',
      path,
      method,
      field: `${fieldPrefix}[${i}]`,
      description: `A schema variant was removed from "${fieldPrefix}" in ${method.toUpperCase()} ${path}`,
    });
  }
  for (let i = b.length; i < t.length; i++) {
    diffs.push({
      type: 'SCHEMA_VARIANT_ADDED',
      path,
      method,
      field: `${fieldPrefix}[${i}]`,
      description: `A schema variant was added to "${fieldPrefix}" in ${method.toUpperCase()} ${path}`,
    });
  }
}

// ─── Constraints (min/max, length, pattern) ─────────────────────────────────

/**
 * Detects changes to numeric/string constraint fields on a schema node.
 * Classification is direction-aware:
 *
 *   maximum increased / minimum decreased / maxLength increased / etc.
 *     → CONSTRAINT_RELAXED (modification — existing clients still valid)
 *
 *   maximum decreased / minimum increased / maxLength decreased / etc.
 *     → CONSTRAINT_TIGHTENED (breaking — previously-valid values now rejected)
 *
 *   pattern added/changed/removed
 *     → CONSTRAINT_PATTERN_CHANGED (breaking; semantic comparison is too hard
 *        to do safely so we treat any change as potentially restrictive)
 *
 * `null` on either side means "not constrained" — adding a constraint is
 * tightening, removing one is relaxing.
 */
function diffConstraints(path, method, fieldPrefix, base, target, diffs) {
  if (!base || !target) return;

  // Direction map: how to interpret a numeric change for each constraint.
  // 'upper' constraints (maximum, maxLength, maxItems): higher = looser.
  // 'lower' constraints (minimum, minLength, minItems): lower = looser.
  const UPPER = ['maximum', 'maxLength', 'maxItems'];
  const LOWER = ['minimum', 'minLength', 'minItems'];

  for (const key of UPPER) {
    pushNumericConstraint(path, method, fieldPrefix, key, base[key], target[key], 'upper', diffs);
  }
  for (const key of LOWER) {
    pushNumericConstraint(path, method, fieldPrefix, key, base[key], target[key], 'lower', diffs);
  }

  // pattern: any change is treated as a tightening (breaking). Adding or
  // removing a pattern also counts.
  if ((base.pattern || null) !== (target.pattern || null)) {
    diffs.push({
      type: 'CONSTRAINT_PATTERN_CHANGED',
      path, method, field: fieldPrefix,
      oldValue: base.pattern || null,
      newValue: target.pattern || null,
      description: target.pattern
        ? `Pattern constraint on "${fieldPrefix}" changed from ${base.pattern ? `/${base.pattern}/` : '(none)'} to /${target.pattern}/ in ${method.toUpperCase()} ${path}`
        : `Pattern constraint on "${fieldPrefix}" was removed from ${method.toUpperCase()} ${path}`,
    });
  }
}

function pushNumericConstraint(path, method, field, key, oldVal, newVal, direction, diffs) {
  // Treat null/undefined as "no constraint".
  const had = oldVal !== null && oldVal !== undefined;
  const has = newVal !== null && newVal !== undefined;

  if (!had && !has) return;
  if (had && has && oldVal === newVal) return;

  // Adding a constraint where none existed → tightening (breaking).
  if (!had && has) {
    diffs.push({
      type: 'CONSTRAINT_TIGHTENED',
      path, method, field,
      oldValue: null, newValue: String(newVal),
      description: `${key} constraint added on "${field}" (now ${newVal}) — tightens "${method.toUpperCase()} ${path}"`,
    });
    return;
  }
  // Removing a constraint → relaxation (modification).
  if (had && !has) {
    diffs.push({
      type: 'CONSTRAINT_RELAXED',
      path, method, field,
      oldValue: String(oldVal), newValue: null,
      description: `${key} constraint removed from "${field}" — relaxes "${method.toUpperCase()} ${path}"`,
    });
    return;
  }

  // Both present, different value. Direction tells us whether higher = looser
  // or higher = tighter for THIS constraint key.
  const wentUp = newVal > oldVal;
  const isRelaxation = (direction === 'upper' && wentUp) || (direction === 'lower' && !wentUp);
  diffs.push({
    type: isRelaxation ? 'CONSTRAINT_RELAXED' : 'CONSTRAINT_TIGHTENED',
    path, method, field,
    oldValue: String(oldVal), newValue: String(newVal),
    description: `${key} on "${field}" changed from ${oldVal} to ${newVal} (${isRelaxation ? 'relaxed' : 'tightened'}) in ${method.toUpperCase()} ${path}`,
  });
}

function diffEnums(path, method, fieldPrefix, baseEnum, targetEnum, diffs) {
  if (!baseEnum || !targetEnum) return;
  for (const val of baseEnum) {
    if (!targetEnum.includes(val)) {
      diffs.push({
        type: 'ENUM_VALUE_REMOVED',
        path,
        method,
        field: fieldPrefix,
        oldValue: String(val),
        description: `Enum value "${val}" was removed from "${fieldPrefix}" in ${method.toUpperCase()} ${path}`,
      });
    }
  }
}

// ─── Component schemas ───────────────────────────────────────────────────────

function diffSchemas(baseSchemas, targetSchemas, diffs) {
  for (const name of Object.keys(baseSchemas)) {
    if (!targetSchemas[name]) {
      diffs.push({
        type: 'SCHEMA_REMOVED',
        field: `components.schemas.${name}`,
        description: `Schema "${name}" was removed from components.schemas`,
      });
    }
  }

  for (const name of Object.keys(targetSchemas)) {
    if (!baseSchemas[name]) {
      diffs.push({
        type: 'SCHEMA_ADDED',
        field: `components.schemas.${name}`,
        description: `Schema "${name}" was added to components.schemas`,
      });
    }
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function schemaTypeStr(schema) {
  if (!schema) return 'unknown';
  if (schema.ref) return schema.ref;
  let t = schema.type || 'object';
  if (schema.format) t += `:${schema.format}`;
  return t;
}

module.exports = { diffSpecs };
