'use strict';

const S = require('./schema');

/**
 * Is any ajv error about the location `steps` names? At it, under it, the
 * parent reporting it missing or unexpected, or a oneOf/anyOf above it.
 */
function relatesTo(errors, steps) {
  const at = S.instancePath(steps);
  const last = steps[steps.length - 1];
  const parent = S.instancePath(steps.slice(0, -1));
  return errors.some((e) => {
    if (e.path === at || e.path.startsWith(at + '/')) return true;
    if (last && last.prop !== undefined && e.path === parent) {
      if (e.keyword === 'required' && e.params.missingProperty === last.prop) return true;
      if (e.keyword === 'additionalProperties' && e.params.additionalProperty === last.prop) return true;
    }
    return (e.keyword === 'oneOf' || e.keyword === 'anyOf') && at.startsWith(e.path) && at !== e.path;
  });
}

module.exports = { relatesTo };
