'use strict';

/**
 * `specshield init` — interactive (or scriptable) wizard that detects the
 * project context, asks the user a few questions, and writes
 * `.specshield.yml` plus an optional starter GitHub Actions workflow.
 *
 * Modes:
 *   specshield init                    interactive (default)
 *   specshield init --no-interactive ...   scriptable; fails fast on missing fields
 *   specshield init --print            detect everything, print proposed YAML to stdout, write nothing
 */

const { Command } = require('commander');
const path        = require('path');
const chalk       = require('chalk');
const prompts     = require('prompts');
const axios       = require('axios');
const logger      = require('../utils/logger');
const { getStoredApiKey, setStoredApiKey } = require('../config/localConfig');
const { detectAll }                    = require('../core/projectDetect');
const { render, writeProjectConfig, writeWorkflow } = require('../core/configWriter');

const DEFAULT_SERVER = 'https://specshield.io';

// ─── Helpers ───────────────────────────────────────────────────────────────

function abortIfCancelled(answers, keys) {
  // `prompts` returns undefined values when the user hits Ctrl-C.
  for (const k of keys) {
    if (answers[k] === undefined) {
      logger.error('Aborted.');
      process.exit(2);
    }
  }
}

async function validateApiKey(server, key) {
  try {
    const res = await axios.post(`${server.replace(/\/$/, '')}/auth/validate-api-key`,
      null, { headers: { 'X-Api-Key': key }, timeout: 8000 });
    return res.data && res.data.valid ? res.data : null;
  } catch {
    return null;
  }
}

async function fetchOrgs(server, key) {
  try {
    const res = await axios.get(`${server.replace(/\/$/, '')}/me/orgs`,
      { headers: { 'X-Api-Key': key }, timeout: 8000 });
    return Array.isArray(res.data) ? res.data : (res.data?.orgs || []);
  } catch {
    return [];
  }
}

function fmtSection(title) {
  process.stdout.write('\n' + chalk.bold(title) + '\n');
  process.stdout.write(chalk.gray('  ─────────────────────────────────────────────────────') + '\n');
}

function ok(msg)   { process.stdout.write(`  ${chalk.green('✔')}  ${msg}\n`); }
function info(msg) { process.stdout.write(`  ${chalk.cyan('•')}  ${msg}\n`); }
function warn(msg) { process.stdout.write(`  ${chalk.yellow('!')}  ${msg}\n`); }

// ─── Build the config object ───────────────────────────────────────────────

function buildConfig(answers, detected) {
  const cfg = {
    schemaVersion: 1,
    failOnBreaking: true,
    severity: 'error',
  };

  const wantsBdct = answers.kind && answers.kind !== 'skip';
  if (wantsBdct) {
    cfg.bdct = {
      org:         answers.org,
      environment: answers.environment || 'staging',
    };
    if (answers.server && answers.server !== DEFAULT_SERVER) {
      cfg.bdct.server = answers.server;
    }

    if (answers.kind === 'provider' || answers.kind === 'both') {
      cfg.bdct.provider = {
        name:   answers.providerName,
        spec:   answers.specPath,
      };
      if (detected.branch) cfg.bdct.provider.branch = detected.branch;
    }

    if (answers.kind === 'consumer' || answers.kind === 'both') {
      cfg.bdct.consumer = {
        name:     answers.consumerName,
        provider: answers.consumerProvider,
        contract: answers.contractPath,
        format:   answers.contractFormat || 'OPENAPI',
      };
    }
  }

  if (answers.specPath) {
    cfg.github = {
      specPath:       answers.specPath,
      failOnBreaking: true,
      commentOnPr:    true,
    };
  }

  return cfg;
}

// ─── Interactive flow ──────────────────────────────────────────────────────

async function interactiveFlow(detected, opts) {
  fmtSection('SpecShield CLI · setup wizard');

  if (detected.git.remote) ok(`Detected git repo: ${chalk.white(detected.git.remote)}`);
  if (detected.spec)       ok(`Found OpenAPI spec: ${chalk.white(detected.spec)}`);
  if (detected.serviceName) {
    ok(`Detected service name from ${detected.service.source}: ${chalk.white(detected.serviceName)}`);
  }
  if (detected.existing) warn('A .specshield.yml already exists in this directory.');

  const answers = {};

  if (detected.existing) {
    const r = await prompts({
      type: 'confirm', name: 'overwrite',
      message: 'Overwrite the existing .specshield.yml?',
      initial: false,
    });
    abortIfCancelled(r, ['overwrite']);
    if (!r.overwrite) {
      info('No changes written. Exiting.');
      return null;
    }
  }

  const k = await prompts({
    type: 'select', name: 'kind',
    message: 'What does this project own?',
    choices: [
      { title: 'Provider service (publishes a spec consumers depend on)', value: 'provider' },
      { title: 'Consumer integration (calls a provider\'s API)',           value: 'consumer' },
      { title: 'Both',                                                     value: 'both' },
      { title: 'Skip BDCT — local compare only',                          value: 'skip' },
    ],
    initial: detected.spec ? 0 : 3,
  });
  abortIfCancelled(k, ['kind']);
  answers.kind = k.kind;

  const wantsProvider = k.kind === 'provider' || k.kind === 'both';
  const wantsConsumer = k.kind === 'consumer' || k.kind === 'both';

  if (wantsProvider) {
    const provQs = [
      { type: 'text', name: 'providerName', message: 'Provider name', initial: detected.serviceName },
      { type: 'text', name: 'specPath',     message: 'Path to provider OpenAPI spec',
        initial: detected.spec || 'api/openapi.yaml',
        validate: (v) => v ? true : 'Required',
      },
    ];
    const r = await prompts(provQs);
    abortIfCancelled(r, ['providerName', 'specPath']);
    Object.assign(answers, r);
  }

  if (wantsConsumer) {
    const consQs = [
      { type: 'text', name: 'consumerName',     message: 'Consumer name',
        initial: detected.serviceName },
      { type: 'text', name: 'consumerProvider', message: 'Provider this consumer talks to',
        validate: (v) => v ? true : 'Required',
      },
      { type: 'text', name: 'contractPath',     message: 'Path to consumer contract',
        initial: 'contracts/contract.yaml',
        validate: (v) => v ? true : 'Required',
      },
      { type: 'select', name: 'contractFormat', message: 'Contract format',
        choices: [
          { title: 'OpenAPI', value: 'OPENAPI' },
          { title: 'Pact JSON', value: 'PACT' },
        ],
        initial: 0,
      },
    ];
    const r = await prompts(consQs);
    abortIfCancelled(r, ['consumerName', 'consumerProvider', 'contractPath', 'contractFormat']);
    Object.assign(answers, r);
  }

  if (k.kind !== 'skip') {
    // Server first (so we can validate the API key against it)
    answers.server = opts.server || DEFAULT_SERVER;

    // Authenticate / pick org
    let token = await getStoredApiKey();
    let validated = token ? await validateApiKey(answers.server, token) : null;

    if (validated) {
      const r = await prompts({
        type: 'confirm', name: 'reuse',
        message: `Use existing API key for ${chalk.white(validated.name || validated.customerId)} (${validated.plan})?`,
        initial: true,
      });
      abortIfCancelled(r, ['reuse']);
      if (!r.reuse) { token = null; validated = null; }
    }

    if (!token) {
      info(`Generate an API key at ${chalk.white(answers.server + '/account/keys')}`);
      const r = await prompts({
        type: 'password', name: 'key',
        message: 'Paste your SpecShield API key',
        validate: (v) => (v && v.startsWith('ss_')) ? true : 'API keys start with ss_',
      });
      abortIfCancelled(r, ['key']);
      validated = await validateApiKey(answers.server, r.key);
      if (!validated) {
        logger.error('That API key did not validate against ' + answers.server);
        process.exit(2);
      }
      await setStoredApiKey(r.key);
      ok(`Stored API key in ~/.specshield/config.json`);
      token = r.key;
    }

    // Org key — try to autocomplete from /me/orgs
    const orgs = await fetchOrgs(answers.server, token);
    if (orgs.length > 0) {
      const r = await prompts({
        type: 'select', name: 'org',
        message: 'Pick an organisation',
        choices: orgs.map(o => ({
          title: `${o.name || o.orgKey} ${chalk.gray('(' + o.orgKey + ')')}`,
          value: o.orgKey,
        })).concat([{ title: chalk.gray('Other (enter manually)'), value: '__manual__' }]),
        initial: 0,
      });
      abortIfCancelled(r, ['org']);
      if (r.org === '__manual__') {
        const m = await prompts({ type: 'text', name: 'org', message: 'Org key',
          validate: (v) => v ? true : 'Required' });
        abortIfCancelled(m, ['org']);
        answers.org = m.org;
      } else {
        answers.org = r.org;
      }
    } else {
      const r = await prompts({
        type: 'text', name: 'org', message: 'Org key',
        validate: (v) => v ? true : 'Required',
      });
      abortIfCancelled(r, ['org']);
      answers.org = r.org;
    }

    // Default environment
    const e = await prompts({
      type: 'text', name: 'environment',
      message: 'Default environment',
      initial: detected.environment || 'staging',
    });
    abortIfCancelled(e, ['environment']);
    answers.environment = e.environment;
  }

  // Optional: write the starter workflow
  if (k.kind !== 'skip') {
    const w = await prompts({
      type: 'confirm', name: 'workflow',
      message: 'Also write a starter GitHub Actions workflow at .github/workflows/specshield-bdct.yml?',
      initial: true,
    });
    abortIfCancelled(w, ['workflow']);
    answers.writeWorkflow = w.workflow;
  }

  return answers;
}

// ─── Non-interactive flow ──────────────────────────────────────────────────

function nonInteractiveFlow(detected, opts) {
  const need = (name) => {
    if (!opts[name] && !detected[name]) {
      logger.error(`Missing --${name.replace(/[A-Z]/g, m => '-' + m.toLowerCase())} (required in --no-interactive mode).`);
      process.exit(2);
    }
  };

  if (!opts.kind) {
    logger.error('Missing --kind (provider | consumer | both | skip) in --no-interactive mode.');
    process.exit(2);
  }

  const answers = {
    kind:        opts.kind,
    server:      opts.server      || DEFAULT_SERVER,
    org:         opts.org,
    environment: opts.env || detected.environment || 'staging',
  };

  if (opts.kind === 'provider' || opts.kind === 'both') {
    answers.providerName = opts.provider || detected.serviceName;
    answers.specPath     = opts.spec     || detected.spec;
    if (!answers.providerName) need('provider');
    if (!answers.specPath)     need('spec');
  }
  if (opts.kind === 'consumer' || opts.kind === 'both') {
    answers.consumerName     = opts.consumer || detected.serviceName;
    answers.consumerProvider = opts.consumerProvider;
    answers.contractPath     = opts.contract;
    answers.contractFormat   = opts.format || 'OPENAPI';
    if (!answers.consumerName)     need('consumer');
    if (!answers.consumerProvider) need('consumerProvider');
    if (!answers.contractPath)     need('contract');
  }
  if (opts.kind !== 'skip' && !answers.org) need('org');

  answers.writeWorkflow = !!opts.writeWorkflow;
  return answers;
}

// ─── Preview flow ──────────────────────────────────────────────────────────

/**
 * Used by `specshield init --print`. Behaves like `nonInteractiveFlow` but
 * substitutes a "<replace-me>" placeholder for any required field the user
 * didn't supply, instead of erroring out. The header comment printed
 * alongside the YAML tells the user where to fill these in.
 *
 * Kind defaults to "provider" if a spec was detected (the most common
 * case), else "skip" (local-compare-only).
 */
function previewFlow(detected, opts) {
  const PLACEHOLDER = '<replace-me>';
  const kind = opts.kind || (detected.spec ? 'provider' : 'skip');

  const answers = {
    kind,
    server:      opts.server      || DEFAULT_SERVER,
    org:         opts.org         || (kind === 'skip' ? null : PLACEHOLDER),
    environment: opts.env         || detected.environment || 'staging',
  };

  if (kind === 'provider' || kind === 'both') {
    answers.providerName = opts.provider || detected.serviceName || PLACEHOLDER;
    answers.specPath     = opts.spec     || detected.spec        || PLACEHOLDER;
  }
  if (kind === 'consumer' || kind === 'both') {
    answers.consumerName     = opts.consumer         || detected.serviceName || PLACEHOLDER;
    answers.consumerProvider = opts.consumerProvider || PLACEHOLDER;
    answers.contractPath     = opts.contract         || PLACEHOLDER;
    answers.contractFormat   = opts.format           || 'OPENAPI';
  }

  answers.writeWorkflow = !!opts.writeWorkflow;
  return answers;
}

// ─── Command ───────────────────────────────────────────────────────────────

const initCommand = new Command('init')
  .description('Detect the project, write .specshield.yml and an optional GitHub workflow')
  .option('--no-interactive',         'Run without prompts; all fields must be passed as flags')
  .option('--print',                  'Print the proposed config and exit; do not write any files')
  .option('--force',                  'Skip the overwrite confirmation if .specshield.yml exists')
  .option('--server <url>',           'SpecShield server URL', 'https://specshield.io')
  .option('--kind <kind>',            'provider | consumer | both | skip')
  .option('--org <key>',              'Organization key')
  .option('--provider <name>',        'Provider service name (when --kind=provider|both)')
  .option('--spec <path>',            'Path to provider OpenAPI spec')
  .option('--consumer <name>',        'Consumer service name (when --kind=consumer|both)')
  .option('--consumer-provider <name>', 'Provider this consumer talks to')
  .option('--contract <path>',        'Path to consumer contract')
  .option('--format <fmt>',           'Consumer contract format: OPENAPI | PACT', 'OPENAPI')
  .option('--env <environment>',      'Default environment')
  .option('--write-workflow',         'Also write .github/workflows/specshield-bdct.yml')
  .action(async (opts) => {
    const cwd = process.cwd();
    const detected = detectAll(cwd);

    let answers;
    if (opts.print) {
      // --print is documented as a dry-run that detects everything and writes
      // a proposed YAML without prompting. Route it through the non-interactive
      // flow (with relaxed validation — see previewFlow) so it truly never asks
      // questions, even if the user didn't pass --no-interactive or all the
      // required scripted-mode flags.
      answers = previewFlow(detected, opts);
    } else if (opts.interactive === false) {
      // In non-interactive mode, refuse to overwrite an existing config unless
      // --force is passed. Prevents a CI script from silently clobbering a
      // hand-edited .specshield.yml that has settings the wizard wouldn't
      // regenerate (custom branch, different provider name, etc.).
      if (detected.existing && !opts.force) {
        logger.error(
          '.specshield.yml already exists. Pass --force to overwrite, or remove the file first.');
        process.exit(2);
      }
      answers = nonInteractiveFlow(detected, opts);
    } else {
      answers = await interactiveFlow(detected, opts);
      if (answers === null) return;     // user said "don't overwrite"
    }

    const cfg  = buildConfig(answers, detected);
    const yaml = render(cfg);

    if (opts.print) {
      // Header comment makes it obvious this was a dry-run + flags any
      // placeholders the user will need to fill in before committing.
      process.stdout.write(
        '\n# ─────────────────────────────────────────────────────────────\n' +
        '#  specshield init --print — DRY RUN. No files were written.\n' +
        '#  Review the YAML below; replace any "<replace-me>" placeholders\n' +
        '#  before running `specshield init` (without --print) for real.\n' +
        '# ─────────────────────────────────────────────────────────────\n\n' +
        yaml);
      return;
    }

    fmtSection('Writing files');
    const target = writeProjectConfig(cfg, cwd);
    ok(`Wrote ${chalk.white(path.relative(cwd, target) || '.specshield.yml')}`);

    if (answers.writeWorkflow && answers.kind !== 'skip') {
      const workflowPath = writeWorkflow({
        kind: answers.kind,
        providerName:        answers.providerName,
        consumerName:        answers.consumerName,
        providerForConsumer: answers.consumerProvider,
      }, cwd);
      ok(`Wrote ${chalk.white(path.relative(cwd, workflowPath))}`);
    }

    fmtSection('Next steps');
    if (answers.kind !== 'skip') {
      info(`Try: ${chalk.white('specshield bdct list-providers')}`);
      info(`Or:  ${chalk.white('specshield bdct can-i-deploy --version $(git rev-parse HEAD)')}`);
    }
    info(`Docs: ${chalk.white('https://specshield.io/docs')}`);
    process.stdout.write('\n');
  });

module.exports = initCommand;
