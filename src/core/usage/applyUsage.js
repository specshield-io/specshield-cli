'use strict';

const path = require('path');
const { normalizeSpec } = require('../normalizeSpec');
const { loadUsage } = require('./usageStore');
const { applyUsageImpact } = require('./impact');
const { annotateDeprecations } = require('./deprecations');
const logger = require('../../utils/logger');

/**
 * Joins a classified result to real traffic (compare --usage, gate --usage):
 * annotates each change with the clients it affects, moves unused breaking
 * changes to unusedBreakingChanges when the evidence is good enough, and
 * marks deprecated items that have drained.
 *
 * `baseSpec` is the parsed base spec; `baseLabel` names it in warnings.
 */
async function applyUsage(result, baseSpec, options, baseLabel = 'the base spec') {
  const usage = await loadUsage(options.usage);
  const num = (value, flag, max = Infinity) => {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0 || n > max) throw new Error(`${flag} must be a number from 0 to ${max}, got "${value}"`);
    return n;
  };
  const minDays = num(options.usageMinDays, '--usage-min-days');
  const maxAgeDays = num(options.usageMaxAge, '--usage-max-age');
  const minCoverage = num(options.usageMinCoverage, '--usage-min-coverage', 100);

  const { result: annotated, meta } = applyUsageImpact(result, {
    usage,
    baseSpec,
    baseNorm: normalizeSpec(baseSpec),
    file: path.basename(options.usage),
    ignoreClients: options.usageIgnoreClient,
    minDays,
    maxAgeDays,
    minCoverage,
    downgrade: options.usageDowngrade,
  });
  if (!meta.trusted && meta.totalCalls > 0) {
    logger.warn(`None of the calls in ${options.usage} match an operation in ${baseLabel}. ` +
      'Is it the right usage file? If the API is served under a prefix, re-import with --base-path.');
  }
  const quietDays = num(options.usageQuietDays, '--usage-quiet-days');
  return { ...annotateDeprecations(annotated, baseSpec, { meta, quietDays }), usage: { ...meta, quietDays } };
}

/** The usage options from .specshield.yml's `usage:` block, overridden by flags. */
function usageOptions(config, cliOpts) {
  const u = config.usage || {};
  const pick = (flag, key, def) => (cliOpts[flag] !== undefined ? cliOpts[flag] : u[key] !== undefined ? u[key] : def);
  return {
    usage: cliOpts.usage || u.file || null,
    usageIgnoreClient: [...(cliOpts.usageIgnoreClient || []), ...(u.ignoreClients || [])],
    usageMinDays: pick('usageMinDays', 'minDays', 7),
    usageMaxAge: pick('usageMaxAge', 'maxAgeDays', 30),
    usageMinCoverage: pick('usageMinCoverage', 'minCoverage', 25),
    usageQuietDays: pick('usageQuietDays', 'quietDays', 30),
    usageDowngrade: cliOpts.usageDowngrade === false ? false : u.downgrade !== false,
  };
}

module.exports = { applyUsage, usageOptions };
