'use strict';

/**
 * Load `.specshield.yml` from the working directory (or any ancestor) and
 * apply its defaults to a parsed CLI options object.
 *
 * Precedence at call time:
 *   CLI flag  >  env var  >  .specshield.yml  >  hard-coded default
 *
 * Each `bdct` subcommand calls `applyBdctDefaults(opts, command)` after
 * parsing args. Required-field validation happens here too — that way the
 * CLI flags can stop being `requiredOption(...)` and fall through gracefully
 * to the project config when the user is running from a configured repo.
 */

const fs   = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const logger = require('../utils/logger');

/**
 * Walk upward from `start` looking for `.specshield.yml` or `.specshield.yaml`.
 * Returns the absolute path of the first hit, or null.
 */
function findProjectConfigFile(start = process.cwd()) {
  let dir = path.resolve(start);
  // Bound walk to a sensible depth — never escape the user's home directory.
  for (let i = 0; i < 20; i++) {
    for (const name of ['.specshield.yml', '.specshield.yaml']) {
      const candidate = path.join(dir, name);
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        return candidate;
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

let cached = null;
let cachedFor = null;

/**
 * Returns the parsed config object (or an empty `{}` if no file is found).
 * Cached per-process for the same starting directory; tests can pass
 * `{ noCache: true }` or call `clearCache()` to refetch.
 */
function loadProjectConfig(start = process.cwd(), { noCache = false } = {}) {
  if (!noCache && cached !== null && cachedFor === start) return cached;

  const file = findProjectConfigFile(start);
  if (!file) {
    cached = {}; cachedFor = start;
    return cached;
  }

  let parsed = {};
  try {
    const raw = fs.readFileSync(file, 'utf8');
    parsed = yaml.load(raw) || {};
    if (typeof parsed !== 'object' || Array.isArray(parsed)) {
      logger.warn(`Ignoring ${file}: top-level must be a YAML mapping.`);
      parsed = {};
    }
  } catch (err) {
    logger.warn(`Failed to read ${file}: ${err.message}. Continuing without project config.`);
    parsed = {};
  }

  cached = { ...parsed, _file: file };
  cachedFor = start;
  return cached;
}

function clearCache() { cached = null; cachedFor = null; }

/**
 * Required-field declaration per BDCT subcommand. Same source-of-truth the
 * old `requiredOption(...)` checks used; centralised here so missing fields
 * produce a single, friendly error.
 */
const REQUIRED_FIELDS = {
  'publish-provider': ['org', 'provider', 'version', 'spec'],
  'publish-consumer': ['org', 'consumer', 'provider', 'version', 'contract'],
  'verify':           ['org', 'consumer', 'consumerVersion', 'provider', 'providerVersion'],
  'can-i-deploy':     ['org', 'service', 'version'],
  'matrix':           ['org'],
  'list':             ['org'],
  'list-providers':   ['org'],
  'list-consumers':   ['org'],
};

/**
 * Option names that CAN be defaulted from `.specshield.yml`.
 *
 * Deliberately NOT every required field: `version`, `consumerVersion` and
 * `providerVersion` are per-invocation values (a git SHA, a release tag) with no
 * sensible project-wide default, so `bdctDefaultFor` has no case for them.
 *
 * This set exists so the "missing required options" error can tell the truth about
 * where each field can be set. Pointing a user at `.specshield.yml` for a field the
 * config can never supply sends them to edit a file, re-run, hit the identical error,
 * and conclude the config file is broken.
 *
 * MUST stay in sync with the cases handled in {@link bdctDefaultFor} — the
 * "config-backed fields" test asserts both directions.
 */
const CONFIG_BACKED_FIELDS = new Set([
  'org', 'server', 'env',
  'provider', 'consumer', 'service',
  'spec', 'contract', 'format', 'branch',
]);

/**
 * Map a CLI option name to a path inside `.specshield.yml > bdct`.
 * Returns undefined when there is no defaulting rule for that option.
 */
function bdctDefaultFor(bdct, name, command) {
  if (!bdct) return undefined;
  switch (name) {
    case 'org':         return bdct.org;
    case 'server':      return bdct.server;
    case 'env':         return bdct.environment;

    case 'provider': {
      // For consumer-side operations the provider lives under `bdct.consumer.provider`.
      if (command === 'publish-consumer' || command === 'verify') {
        return bdct.consumer && bdct.consumer.provider;
      }
      // For everything else it's the project's own provider name.
      return bdct.provider && bdct.provider.name;
    }
    case 'consumer':    return bdct.consumer && bdct.consumer.name;
    case 'service': {
      // can-i-deploy service is whichever role the project owns.
      return (bdct.provider && bdct.provider.name)
          || (bdct.consumer && bdct.consumer.name);
    }
    case 'spec':        return bdct.provider && bdct.provider.spec;
    case 'contract':    return bdct.consumer && bdct.consumer.contract;
    case 'format':      return bdct.consumer && bdct.consumer.format;
    case 'branch':      return bdct.provider && bdct.provider.branch;
    default:            return undefined;
  }
}

/**
 * Mutates `opts` in place: for every CLI option that is currently undefined
 * (or empty string), look up a default in the loaded project config.
 *
 * Then verify every required field for the given `command` is present.
 * Throws an Error listing all missing fields if not.
 */
function applyBdctDefaults(opts, command, { cwd = process.cwd() } = {}) {
  const cfg = loadProjectConfig(cwd);
  const bdct = cfg.bdct;

  const FIELDS = [
    'org', 'server', 'env',
    'provider', 'consumer', 'service',
    'version', 'consumerVersion', 'providerVersion',
    'spec', 'contract', 'format', 'branch',
  ];

  // Paths in the config file are interpreted relative to the config file's
  // directory (not the CWD where the command was invoked). This lets a user
  // run `specshield bdct publish-provider` from any subdirectory.
  const configDir = cfg._file ? path.dirname(cfg._file) : cwd;
  const resolvePath = (v) =>
    !v || path.isAbsolute(v) ? v : path.resolve(configDir, v);

  for (const f of FIELDS) {
    if (opts[f] !== undefined && opts[f] !== '') continue;
    const def = bdctDefaultFor(bdct, f, command);
    if (def === undefined || def === null || def === '') continue;
    opts[f] = (f === 'spec' || f === 'contract') ? resolvePath(def) : def;
  }

  // Placeholder check — `<replace-me>` is the marker `specshield init` writes
  // for fields the user skipped during the wizard. Letting it flow through
  // would send the literal string to the backend, producing confusing 4xx
  // errors. Refuse with a message that points at the file and field.
  const placeholders = FIELDS
    .filter(f => opts[f] === '<replace-me>')
    .map(f => '--' + f.replace(/[A-Z]/g, m => '-' + m.toLowerCase()));
  if (placeholders.length > 0) {
    const where = cfg._file ? cfg._file : '(no config file found)';
    const err = new Error(
      `The following value${placeholders.length === 1 ? ' is' : 's are'} still set to ` +
      `the "<replace-me>" placeholder written by \`specshield init\`: ` +
      placeholders.join(', ') + '\n' +
      `Edit ${where} (or pass real values as CLI flags) before re-running.`);
    err.code = 'UNRESOLVED_PLACEHOLDER';
    err.placeholders = placeholders;
    throw err;
  }

  // Required-field check.
  const required = REQUIRED_FIELDS[command] || [];
  const missing  = required.filter(k => !opts[k]);
  if (missing.length > 0) {
    const flagFor = (k) => '--' + k.replace(/[A-Z]/g, m => '-' + m.toLowerCase());
    const list = (ks) => ks.map(flagFor).join(', ');

    // Split the advice: only fields the config can actually supply get pointed at
    // `.specshield.yml`. The rest are flag-only and must say so, or the user edits
    // the config, re-runs, and hits the same error with no idea why.
    const configurable = missing.filter(k => CONFIG_BACKED_FIELDS.has(k));
    const flagOnly     = missing.filter(k => !CONFIG_BACKED_FIELDS.has(k));

    const msg = [
      `Missing required ${missing.length === 1 ? 'option' : 'options'} for \`bdct ${command}\`: `
        + list(missing),
    ];

    if (flagOnly.length > 0) {
      msg.push(
        `  ${list(flagOnly)} must be passed as CLI ${flagOnly.length === 1 ? 'flag' : 'flags'} — ` +
        `${flagOnly.length === 1 ? 'it has' : 'they have'} no \`.specshield.yml\` equivalent ` +
        '(version values change per run).');
    }

    if (configurable.length > 0) {
      msg.push(cfg._file
        ? `  ${list(configurable)} can be passed as CLI flags or set under \`bdct\` in ${cfg._file}.`
        : `  ${list(configurable)} can be passed as CLI flags, or run \`specshield init\` to write a \`.specshield.yml\`.`);
    }

    if (command === 'verify' && flagOnly.length > 0) {
      msg.push('  e.g. specshield bdct verify --consumer <NAME> --provider <NAME> '
             + '--consumer-version <VER> --provider-version <VER>');
    }
    const err = new Error(msg.join('\n'));
    err.code = 'MISSING_REQUIRED_OPTIONS';
    err.missing = missing;
    throw err;
  }

  return opts;
}

module.exports = {
  findProjectConfigFile,
  loadProjectConfig,
  clearCache,
  applyBdctDefaults,
  REQUIRED_FIELDS,
  CONFIG_BACKED_FIELDS,
  bdctDefaultFor,
};
