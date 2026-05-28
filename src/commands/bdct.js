'use strict';

const { Command } = require('commander');
const chalk = require('chalk');
const ora = require('ora');
const path = require('path');
const fsExtra = require('fs-extra');
const logger = require('../utils/logger');
const { getStoredApiKey } = require('../config/localConfig');
const { applyBdctDefaults } = require('../core/projectConfig');
const {
  publishProviderSpec,
  publishConsumerContract,
  verify,
  listVerifications,
  canIDeploy,
  getMatrix,
  listProviderSpecs,
  listConsumerContracts,
} = require('../api/bdctClient');

// ─── Helpers ────────────────────────────────────────────────────────────────

async function resolveApiToken(opts) {
  return opts.apiToken || process.env.SPECSHIELD_API_KEY || (await getStoredApiKey()) || null;
}

function requireToken(token) {
  if (!token) {
    logger.error('No API token found. Pass --api-token, set SPECSHIELD_API_KEY, or run: specshield login --api-key <KEY>');
    process.exit(2);
  }
}

/**
 * Fill missing CLI options from `.specshield.yml` if one is present, then
 * verify every required field for `command` is set. Exits 2 with a friendly
 * message if anything is missing.
 */
function withProjectDefaults(opts, command) {
  try {
    applyBdctDefaults(opts, command);
  } catch (err) {
    if (err.code === 'MISSING_REQUIRED_OPTIONS' || err.code === 'UNRESOLVED_PLACEHOLDER') {
      logger.error(err.message);
      process.exit(2);
    }
    throw err;
  }
  return opts;
}

function fmtDate(iso) {
  if (!iso) return chalk.gray('—');
  try {
    return new Date(iso).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false })
      .replace(',', '');
  } catch { return iso; }
}

function compatBadge(status) {
  if (!status) return chalk.gray('UNKNOWN');
  const s = String(status).toUpperCase();
  if (s === 'COMPATIBLE')   return chalk.green(s);
  if (s === 'INCOMPATIBLE') return chalk.red(s);
  return chalk.gray(s);
}

function hr() {
  return chalk.gray('  ─────────────────────────────────────────────────────');
}

const { stripVersionPrefix } = require('../util/versionStrip');

/**
 * Flatten a verification result's mismatches.
 * Current backend returns `resultJson` (JSON string of [{endpoint,status,mismatches:[...]}]).
 * Tolerate older shapes that put a flat array on `issues` or `mismatches`.
 */
function flattenMismatches(result) {
  if (!result) return [];
  if (Array.isArray(result.issues)) return result.issues;
  if (Array.isArray(result.mismatches)) return result.mismatches;
  if (typeof result.resultJson === 'string' && result.resultJson.length > 0) {
    try {
      const parsed = JSON.parse(result.resultJson);
      if (Array.isArray(parsed)) {
        return parsed.flatMap(ep => Array.isArray(ep.mismatches) ? ep.mismatches : []);
      }
    } catch { /* fall through */ }
  }
  return [];
}

/** Strip ANSI escape codes for length measurement */
function stripAnsi(str) {
  return str.replace(/\[[0-9;]*m/g, '');
}

/** Simple padded column table */
function printTable(headers, rows) {
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map(r => stripAnsi(String(r[i] ?? '')).length))
  );
  const headerLine = headers.map((h, i) => chalk.bold(h.padEnd(widths[i]))).join('  ');
  process.stdout.write('\n  ' + headerLine + '\n');
  process.stdout.write('  ' + widths.map(w => '─'.repeat(w)).join('  ') + '\n');
  for (const row of rows) {
    const line = row.map((cell, i) => {
      const raw = String(cell ?? '');
      const pad = widths[i] - stripAnsi(raw).length;
      return raw + ' '.repeat(Math.max(0, pad));
    }).join('  ');
    process.stdout.write('  ' + line + '\n');
  }
  process.stdout.write('\n');
}

// ─── publish-provider ────────────────────────────────────────────────────────

const publishProviderCommand = new Command('publish-provider')
  .description('Publish a provider OpenAPI spec to the BDCT registry')
  .option('--spec <path>',     'Path to provider spec file (YAML or JSON)')
  .option('--provider <name>', 'Provider service name')
  .option('--version <ver>',   'Provider version tag')
  .option('--org <key>',       'Organization key')
  .option('--env <environment>', 'Environment label (e.g. staging, production)')
  .option('--branch <branch>', 'Git branch name')
  .option('--json',            'Output raw JSON')
  .option('--server <url>',    'SpecShield server URL')
  .option('--api-token <token>', 'API token (overrides env / stored config)')
  .action(async (opts) => {
    withProjectDefaults(opts, 'publish-provider');
    const token = await resolveApiToken(opts);
    requireToken(token);

    const filePath = path.resolve(opts.spec);
    if (!(await fsExtra.pathExists(filePath))) {
      logger.error(`Spec file not found: ${filePath}`);
      process.exit(2);
    }

    let specContent;
    try {
      specContent = await fsExtra.readFile(filePath, 'utf8');
    } catch (err) {
      logger.error(`Failed to read spec file: ${err.message}`);
      process.exit(2);
    }

    const spinner = opts.json ? null : ora('Publishing provider spec...').start();

    try {
      const result = await publishProviderSpec(opts.server, token, {
        orgKey:       opts.org,
        providerName: opts.provider,
        version:      opts.version,
        specContent,
        environment:  opts.env    || null,
        branch:       opts.branch || null,
      });
      if (spinner) spinner.stop();

      if (opts.json) {
        process.stdout.write(JSON.stringify(result, null, 2) + '\n');
        return;
      }

      process.stdout.write('\n');
      process.stdout.write(chalk.green.bold('  ✔  Provider Spec Published') + '\n');
      process.stdout.write(hr() + '\n');
      if (result.id)       process.stdout.write(`  ID          : ${chalk.cyan(result.id)}\n`);
      process.stdout.write(`  Provider    : ${chalk.white(opts.provider)}\n`);
      process.stdout.write(`  Version     : ${chalk.cyan(opts.version)}\n`);
      if (opts.env)        process.stdout.write(`  Environment : ${opts.env}\n`);
      const publishedAt = result.createdAt || result.publishedAt;
      if (publishedAt) process.stdout.write(`  Published At: ${fmtDate(publishedAt)}\n`);
      if (typeof result.verificationsTriggered === 'number') {
        process.stdout.write(`  Verifications triggered: ${chalk.cyan(result.verificationsTriggered)}\n`);
      }
      process.stdout.write('\n');
    } catch (err) {
      if (spinner) spinner.fail('Publish failed');
      logger.error(err.message);
      process.exit(1);
    }
  });

// ─── publish-consumer ────────────────────────────────────────────────────────

const publishConsumerCommand = new Command('publish-consumer')
  .description('Publish a consumer contract to the BDCT registry')
  .option('--contract <path>', 'Path to consumer contract file (OpenAPI YAML/JSON or Pact JSON)')
  .option('--consumer <name>', 'Consumer service name')
  .option('--provider <name>', 'Provider service name')
  .option('--version <ver>',   'Consumer version tag')
  .option('--org <key>',       'Organization key')
  .option('--format <fmt>',    'Contract format: OPENAPI | PACT', 'OPENAPI')
  .option('--json',            'Output raw JSON')
  .option('--server <url>',    'SpecShield server URL')
  .option('--api-token <token>', 'API token (overrides env / stored config)')
  .action(async (opts) => {
    withProjectDefaults(opts, 'publish-consumer');
    const token = await resolveApiToken(opts);
    requireToken(token);

    const filePath = path.resolve(opts.contract);
    if (!(await fsExtra.pathExists(filePath))) {
      logger.error(`Contract file not found: ${filePath}`);
      process.exit(2);
    }

    let contractContent;
    try {
      contractContent = await fsExtra.readFile(filePath, 'utf8');
    } catch (err) {
      logger.error(`Failed to read contract file: ${err.message}`);
      process.exit(2);
    }

    const spinner = opts.json ? null : ora('Publishing consumer contract...').start();

    try {
      const result = await publishConsumerContract(opts.server, token, {
        orgKey:          opts.org,
        consumerName:    opts.consumer,
        providerName:    opts.provider,
        version:         opts.version,
        contractContent,
        contractFormat:  opts.format || 'OPENAPI',
      });
      if (spinner) spinner.stop();

      if (opts.json) {
        process.stdout.write(JSON.stringify(result, null, 2) + '\n');
        return;
      }

      process.stdout.write('\n');
      process.stdout.write(chalk.green.bold('  ✔  Consumer Contract Published') + '\n');
      process.stdout.write(hr() + '\n');
      if (result.id)       process.stdout.write(`  ID          : ${chalk.cyan(result.id)}\n`);
      process.stdout.write(`  Consumer    : ${chalk.white(opts.consumer)}\n`);
      process.stdout.write(`  Provider    : ${chalk.white(opts.provider)}\n`);
      process.stdout.write(`  Version     : ${chalk.cyan(opts.version)}\n`);
      process.stdout.write(`  Format      : ${opts.format || 'OPENAPI'}\n`);
      const consumerPublishedAt = result.createdAt || result.publishedAt;
      if (consumerPublishedAt) process.stdout.write(`  Published At: ${fmtDate(consumerPublishedAt)}\n`);
      if (typeof result.verificationsTriggered === 'number') {
        process.stdout.write(`  Verifications triggered: ${chalk.cyan(result.verificationsTriggered)}\n`);
      }
      process.stdout.write('\n');
      process.stdout.write(chalk.gray(`  ➜  Run: specshield bdct verify --consumer ${opts.consumer} --provider ${opts.provider}\n`));
      process.stdout.write('\n');
    } catch (err) {
      if (spinner) spinner.fail('Publish failed');
      logger.error(err.message);
      process.exit(1);
    }
  });

// ─── verify ──────────────────────────────────────────────────────────────────

const verifyCommand = new Command('verify')
  .description('Verify consumer-provider contract compatibility')
  .option('--consumer <name>',         'Consumer service name')
  .option('--provider <name>',         'Provider service name')
  .option('--consumer-version <ver>',  'Consumer version to verify')
  .option('--provider-version <ver>',  'Provider version to verify against')
  .option('--org <key>',               'Organization key')
  .option('--env <environment>',       'Environment label')
  .option('--json',                    'Output raw JSON')
  .option('--server <url>',            'SpecShield server URL')
  .option('--api-token <token>',       'API token')
  .action(async (opts) => {
    withProjectDefaults(opts, 'verify');
    const token = await resolveApiToken(opts);
    requireToken(token);

    // Tolerate a leading `v` on either version (see can-i-deploy for the
    // full rationale — readers paste back display values like `v1.0.0`).
    opts.consumerVersion = stripVersionPrefix(opts.consumerVersion);
    opts.providerVersion = stripVersionPrefix(opts.providerVersion);

    const spinner = opts.json ? null : ora(`Verifying ${opts.consumer} → ${opts.provider}...`).start();

    try {
      const result = await verify(opts.server, token, {
        orgKey:          opts.org,
        consumerName:    opts.consumer,
        consumerVersion: opts.consumerVersion,
        providerName:    opts.provider,
        providerVersion: opts.providerVersion,
        environment:     opts.env || null,
      });
      if (spinner) spinner.stop();

      const status  = String(result.status || result.result || '').toUpperCase();
      const success = status === 'COMPATIBLE';

      if (opts.json) {
        process.stdout.write(JSON.stringify(result, null, 2) + '\n');
        process.exit(success ? 0 : 1);
      }

      process.stdout.write('\n');
      if (success) {
        process.stdout.write(chalk.green.bold('  ✔  COMPATIBLE') + '\n');
      } else {
        process.stdout.write(chalk.red.bold('  ✖  INCOMPATIBLE') + '\n');
      }
      process.stdout.write(hr() + '\n');
      if (result.id) process.stdout.write(`  Verification ID : ${chalk.cyan(result.id)}\n`);
      process.stdout.write(`  Consumer        : ${opts.consumer}${opts.consumerVersion ? '@' + opts.consumerVersion : ''}\n`);
      process.stdout.write(`  Provider        : ${opts.provider}${opts.providerVersion ? '@' + opts.providerVersion : ''}\n`);
      if (opts.env) process.stdout.write(`  Environment     : ${opts.env}\n`);
      process.stdout.write(`  Result          : ${compatBadge(status)}\n`);
      if (result.verifiedAt || result.completedAt) {
        process.stdout.write(`  Verified At     : ${fmtDate(result.verifiedAt || result.completedAt)}\n`);
      }

      // Backend returns resultJson as a JSON string of [{endpoint, status, mismatches:[...]}].
      // Older shapes also accepted: top-level issues / mismatches arrays.
      const issues = flattenMismatches(result);
      if (issues.length > 0) {
        process.stdout.write('\n');
        process.stdout.write(chalk.red.bold('  Issues') + '\n');
        process.stdout.write(hr() + '\n');
        for (const issue of issues) {
          const sev = (issue.severity || 'ERROR').toUpperCase();
          const marker = sev === 'WARNING' ? chalk.yellow('⚠') : chalk.red('●');
          const type = issue.type || issue.mismatchType || 'MISMATCH';
          const loc  = issue.field || issue.path || issue.endpoint || '$';
          process.stdout.write(`  ${marker} ${chalk.bold(type)} at ${chalk.gray(loc)}\n`);
          if (issue.consumerExpects && issue.providerProvides) {
            process.stdout.write(`    ${chalk.gray(`consumer: ${issue.consumerExpects}, provider: ${issue.providerProvides}`)}\n`);
          } else if (issue.consumerExpects) {
            process.stdout.write(`    ${chalk.gray(`expected: ${issue.consumerExpects}`)}\n`);
          } else if (issue.message) {
            process.stdout.write(`    ${chalk.gray(issue.message)}\n`);
          }
        }
        process.stdout.write('\n');
      }

      process.stdout.write('\n');
      process.exit(success ? 0 : 1);
    } catch (err) {
      if (spinner) spinner.fail('Verification failed');
      logger.error(err.message);
      process.exit(2);
    }
  });

// ─── can-i-deploy ─────────────────────────────────────────────────────────────

const canIDeployCommand = new Command('can-i-deploy')
  .description('Check if a service version is safe to deploy')
  .option('--service <name>',    'Service name (consumer or provider)')
  .option('--version <ver>',     'Service version to check')
  .option('--org <key>',         'Organization key')
  .option('--env <environment>', 'Target environment (e.g. qa, staging, production)')
  .option('--json',              'Output raw JSON')
  .option('--server <url>',      'SpecShield server URL')
  .option('--api-token <token>', 'API token')
  .action(async (opts) => {
    withProjectDefaults(opts, 'can-i-deploy');
    const token = await resolveApiToken(opts);
    requireToken(token);

    // Both the UI and the CLI render versions as `v<version>` for readability.
    // When a user reads that and pastes it back into `--version`, the query
    // silently matches nothing (the stored value never has a leading `v`).
    // Strip a `v` that's followed by a digit, then use the cleaned version
    // for the network call AND the human display so we never print `vv…`.
    opts.version = stripVersionPrefix(opts.version);

    const spinner = opts.json ? null : ora(`Checking deployment safety for ${opts.service}@${opts.version}...`).start();

    try {
      const result = await canIDeploy(opts.server, token, {
        org:     opts.org,
        service: opts.service,
        version: opts.version,
        env:     opts.env || null,
      });
      if (spinner) spinner.stop();

      const deployable = result.deployable ?? result.allowed ?? false;
      const envLabel   = opts.env ? ` in ${opts.env}` : '';

      if (opts.json) {
        process.stdout.write(JSON.stringify(result, null, 2) + '\n');
        process.exit(deployable ? 0 : 1);
      }

      // Idempotent `v` prefix on display — don't double it when the stored
      // version legitimately starts with `v` (e.g. `vendor-tag-99`). Mirrors
      // the UI pill at `BdctCanIDeploy.jsx:392`.
      const vDisplay = /^v/i.test(opts.version) ? opts.version : `v${opts.version}`;
      process.stdout.write('\n');
      if (deployable) {
        process.stdout.write(chalk.green.bold('  ✔  PASS') + chalk.white(`: ${opts.service} ${vDisplay} is deployable${envLabel}\n`));
      } else {
        process.stdout.write(chalk.red.bold('  ✖  FAIL') + chalk.white(`: ${opts.service} ${vDisplay} is NOT deployable${envLabel}\n`));
      }
      process.stdout.write(hr() + '\n');

      const consumers = result.consumers || result.verifications || [];
      if (consumers.length > 0) {
        process.stdout.write('\n');
        process.stdout.write(chalk.bold('  Consumer Verifications') + '\n');
        printTable(
          ['Consumer', 'Version', 'Status', 'Verified At'],
          consumers.map(c => [
            c.consumer || c.consumerName || '—',
            c.consumerVersion || c.version || '—',
            compatBadge(c.status || c.result),
            fmtDate(c.verifiedAt || c.completedAt),
          ])
        );
      }

      if (!deployable) {
        process.stdout.write(chalk.gray(`  ➜  Run: specshield bdct verify --consumer <NAME> --provider ${opts.service}\n`));
        process.stdout.write(chalk.gray(`  ➜  to identify and resolve incompatibilities\n`));
        process.stdout.write('\n');
        process.exit(1);
      } else {
        process.stdout.write('\n');
        process.exit(0);
      }
    } catch (err) {
      if (spinner) spinner.fail('Check failed');
      logger.error(err.message);
      process.exit(2);
    }
  });

// ─── list ─────────────────────────────────────────────────────────────────────

const listCommand = new Command('list')
  .description('List BDCT verification history')
  .option('--org <key>', 'Organization key')
  .option('--consumer <name>', 'Filter by consumer service name')
  .option('--provider <name>', 'Filter by provider service name')
  .option('--env <environment>', 'Filter by environment')
  .option('--page <n>', 'Page number (0-based)', '0')
  .option('--size <n>', 'Page size', '20')
  .option('--json', 'Output raw JSON')
  .option('--server <url>', 'SpecShield server URL')
  .option('--api-token <token>', 'API token')
  .action(async (opts) => {
    withProjectDefaults(opts, 'list');
    const token = await resolveApiToken(opts);
    requireToken(token);

    const spinner = opts.json ? null : ora('Fetching verification history...').start();

    try {
      const page = await listVerifications(opts.server, token, {
        org:      opts.org,
        consumer: opts.consumer,
        provider: opts.provider,
        env:      opts.env,
        page:     parseInt(opts.page, 10) || 0,
        size:     parseInt(opts.size, 10)  || 20,
      });
      if (spinner) spinner.stop();

      if (opts.json) {
        process.stdout.write(JSON.stringify(page, null, 2) + '\n');
        return;
      }

      const items = page.content || (Array.isArray(page) ? page : []);
      const total = page.totalElements ?? items.length;

      process.stdout.write('\n');
      process.stdout.write(chalk.bold('  BDCT Verification History') + '\n');
      process.stdout.write(hr() + '\n');
      process.stdout.write(`  Showing ${items.length} of ${total} verifications\n`);

      if (items.length === 0) {
        process.stdout.write(chalk.gray('\n  No verifications found matching filters.\n\n'));
        return;
      }

      printTable(
        ['ID', 'Consumer', 'Provider', 'Cons Ver', 'Prov Ver', 'Status', 'Environment', 'Verified At'],
        items.map(v => [
          chalk.cyan(String(v.id ?? v.verificationId ?? '—')),
          v.consumer || v.consumerName || '—',
          v.provider || v.providerName || '—',
          v.consumerVersion || '—',
          v.providerVersion || '—',
          compatBadge(v.status || v.result),
          v.env || v.environment || '—',
          fmtDate(v.verifiedAt || v.completedAt),
        ])
      );

      if (page.totalPages > 1) {
        const cur = (page.number ?? 0) + 1;
        process.stdout.write(chalk.gray(`  Page ${cur} of ${page.totalPages}  ·  Use --page and --size to navigate\n\n`));
      }
    } catch (err) {
      if (spinner) spinner.fail('List failed');
      logger.error(err.message);
      process.exit(1);
    }
  });

// ─── matrix ──────────────────────────────────────────────────────────────────

const matrixCommand = new Command('matrix')
  .description('Show ASCII compatibility matrix of consumers vs providers')
  .option('--org <key>', 'Organization key')
  .option('--env <environment>', 'Environment label')
  .option('--json', 'Output raw JSON')
  .option('--server <url>', 'SpecShield server URL')
  .option('--api-token <token>', 'API token')
  .action(async (opts) => {
    withProjectDefaults(opts, 'matrix');
    const token = await resolveApiToken(opts);
    requireToken(token);

    const spinner = opts.json ? null : ora('Fetching compatibility matrix...').start();

    try {
      const matrix = await getMatrix(opts.server, token, {
        org: opts.org,
        env: opts.env,
      });
      if (spinner) spinner.stop();

      if (opts.json) {
        process.stdout.write(JSON.stringify(matrix, null, 2) + '\n');
        return;
      }

      // Backend matrix shape: { consumers: string[], providers: string[],
      //                        cells: { "<consumer>__<provider>": "<STATUS>" } }
      const consumers = matrix.consumers || [];
      const providers = matrix.providers || [];
      const cells     = matrix.cells     || {};

      process.stdout.write('\n');
      process.stdout.write(chalk.bold('  BDCT Compatibility Matrix') + '\n');
      if (opts.env) process.stdout.write(chalk.gray(`  Environment: ${opts.env}\n`));
      process.stdout.write(hr() + '\n');

      if (consumers.length === 0 || providers.length === 0) {
        process.stdout.write(chalk.gray('\n  No data available. Publish provider specs and consumer contracts first.\n\n'));
        return;
      }

      // Build table: first column = consumer label, remaining = providers
      const headers = ['Consumer \\ Provider', ...providers];
      const rows = consumers.map(consumer => {
        const providerCells = providers.map(provider => {
          const status = cells[`${consumer}__${provider}`] || 'UNKNOWN';
          return compatBadge(status);
        });
        return [chalk.white(consumer), ...providerCells];
      });

      printTable(headers, rows);

      process.stdout.write(chalk.green('  ■') + chalk.gray(' COMPATIBLE  ') +
                           chalk.red('■')   + chalk.gray(' INCOMPATIBLE  ') +
                           chalk.gray('■ UNKNOWN') + '\n\n');
    } catch (err) {
      if (spinner) spinner.fail('Fetch failed');
      logger.error(err.message);
      process.exit(1);
    }
  });

// ─── list-providers ──────────────────────────────────────────────────────────

const listProvidersCommand = new Command('list-providers')
  .description('List published provider specs')
  .option('--org <key>',       'Organization key')
  .option('--provider <name>', 'Filter by provider service name')
  .option('--json',            'Output raw JSON')
  .option('--server <url>',    'SpecShield server URL')
  .option('--api-token <token>', 'API token')
  .action(async (opts) => {
    withProjectDefaults(opts, 'list-providers');
    const token = await resolveApiToken(opts);
    requireToken(token);

    const spinner = opts.json ? null : ora('Fetching provider specs...').start();

    try {
      const page = await listProviderSpecs(opts.server, token, {
        org:      opts.org,
        provider: opts.provider,
      });
      if (spinner) spinner.stop();

      if (opts.json) {
        process.stdout.write(JSON.stringify(page, null, 2) + '\n');
        return;
      }

      const items = page.content || (Array.isArray(page) ? page : []);
      const total = page.totalElements ?? items.length;

      process.stdout.write('\n');
      process.stdout.write(chalk.bold('  Published Provider Specs') + '\n');
      process.stdout.write(hr() + '\n');
      process.stdout.write(`  Showing ${items.length} of ${total} specs\n`);

      if (items.length === 0) {
        process.stdout.write(chalk.gray('\n  No provider specs found matching filters.\n\n'));
        return;
      }

      printTable(
        ['ID', 'Provider', 'Version', 'Environment', 'Branch', 'Published At'],
        items.map(s => [
          chalk.cyan(String(s.id ?? '—')),
          s.providerName || s.provider || '—',
          chalk.cyan(s.version || '—'),
          s.environment || s.env || '—',
          chalk.gray(s.branch || '—'),
          fmtDate(s.createdAt || s.publishedAt),
        ])
      );

      if (page.totalPages > 1) {
        const cur = (page.number ?? 0) + 1;
        process.stdout.write(chalk.gray(`  Page ${cur} of ${page.totalPages}  ·  Use --page and --size to navigate\n\n`));
      }
    } catch (err) {
      if (spinner) spinner.fail('List failed');
      logger.error(err.message);
      process.exit(1);
    }
  });

// ─── list-consumers ──────────────────────────────────────────────────────────

const listConsumersCommand = new Command('list-consumers')
  .description('List published consumer contracts')
  .option('--org <key>',       'Organization key')
  .option('--consumer <name>', 'Filter by consumer service name')
  .option('--provider <name>', 'Filter by provider service name')
  .option('--json',            'Output raw JSON')
  .option('--server <url>',    'SpecShield server URL')
  .option('--api-token <token>', 'API token')
  .action(async (opts) => {
    withProjectDefaults(opts, 'list-consumers');
    const token = await resolveApiToken(opts);
    requireToken(token);

    const spinner = opts.json ? null : ora('Fetching consumer contracts...').start();

    try {
      const page = await listConsumerContracts(opts.server, token, {
        org:      opts.org,
        consumer: opts.consumer,
        provider: opts.provider,
      });
      if (spinner) spinner.stop();

      if (opts.json) {
        process.stdout.write(JSON.stringify(page, null, 2) + '\n');
        return;
      }

      const items = page.content || (Array.isArray(page) ? page : []);
      const total = page.totalElements ?? items.length;

      process.stdout.write('\n');
      process.stdout.write(chalk.bold('  Published Consumer Contracts') + '\n');
      process.stdout.write(hr() + '\n');
      process.stdout.write(`  Showing ${items.length} of ${total} contracts\n`);

      if (items.length === 0) {
        process.stdout.write(chalk.gray('\n  No consumer contracts found matching filters.\n\n'));
        return;
      }

      printTable(
        ['ID', 'Consumer', 'Provider', 'Version', 'Format', 'Published At'],
        items.map(c => [
          chalk.cyan(String(c.id ?? '—')),
          c.consumerName || c.consumer || '—',
          c.providerName || c.provider || '—',
          chalk.cyan(c.version || '—'),
          c.contractFormat || c.format || '—',
          fmtDate(c.createdAt || c.publishedAt),
        ])
      );

      if (page.totalPages > 1) {
        const cur = (page.number ?? 0) + 1;
        process.stdout.write(chalk.gray(`  Page ${cur} of ${page.totalPages}  ·  Use --page and --size to navigate\n\n`));
      }
    } catch (err) {
      if (spinner) spinner.fail('List failed');
      logger.error(err.message);
      process.exit(1);
    }
  });

// ─── capture (Fix 2 — turn recorded traffic into a consumer contract) ────────
// Reads a HAR file (any browser/Cypress/Playwright/k6 can export one) and
// emits an OpenAPI 3.0 consumer-contract subset describing only the
// endpoints/fields the consumer actually called/read. Pure local CLI work —
// no API token required.

const captureFromHarCommand = new Command('from-har')
  .description('Generate a consumer OpenAPI contract from a recorded HAR file')
  .requiredOption('--in <path>',          'Input HAR file (HTTP Archive 1.2)')
  .option('--out <path>',                 'Output file (default: write to stdout)')
  .option('--base-url <url>',             'Keep only entries matching this URL prefix (e.g. https://api.acme.com or https://api.acme.com/v1)')
  .option('--method <verbs>',             'Comma-separated methods to include (e.g. GET,POST). Default: all')
  .option('--title <title>',              'OpenAPI info.title', 'Captured consumer contract')
  .option('--version <ver>',              'OpenAPI info.version', '0.1.0')
  .option('--format <fmt>',               'Output format: yaml | json', 'yaml')
  .option('--include-non-json',           'Keep entries with non-JSON bodies (default: drop them)')
  .action(async (opts) => {
    const { captureFromHarFile } = require('../core/har');
    const inputPath = path.resolve(opts.in);
    if (!fsExtra.existsSync(inputPath)) {
      logger.error(`HAR file not found: ${inputPath}`);
      process.exit(2);
    }
    const methods = opts.method
      ? opts.method.split(',').map(s => s.trim()).filter(Boolean)
      : undefined;

    let result;
    try {
      result = captureFromHarFile(inputPath, {
        baseUrl: opts.baseUrl,
        methods,
        onlyJson: !opts.includeNonJson,
        title: opts.title,
        version: opts.version,
        format: opts.format,
      });
    } catch (err) {
      logger.error(err.message);
      process.exit(1);
    }

    if (opts.out) {
      const outPath = path.resolve(opts.out);
      fsExtra.outputFileSync(outPath, result.text);
      process.stderr.write(chalk.green('✔ ') +
        `Wrote ${chalk.cyan(opts.out)}  ` +
        chalk.gray(`(${result.summary.endpoints} endpoints, ${result.summary.operations} ops from ${result.summary.recordsKept}/${result.summary.harEntries} entries)`) + '\n');
    } else {
      process.stdout.write(result.text);
      process.stderr.write(chalk.gray(
        `# ${result.summary.endpoints} endpoints, ${result.summary.operations} ops from ${result.summary.recordsKept}/${result.summary.harEntries} HAR entries\n`
      ));
    }
  });

const captureCommand = new Command('capture')
  .description('Capture a consumer OpenAPI contract from observed traffic (currently: HAR ingest)');
captureCommand.addCommand(captureFromHarCommand);

// ─── verify-provider (Fix 3 — spec-vs-production conformance) ─────────────────
// Fires probes derived from the OpenAPI spec at the running provider and
// validates that every response body actually matches its documented schema.
// Pure local CLI work (calls the customer's service directly); no API token.
// Safe-by-default: only GET/HEAD/OPTIONS unless --include-mutating.

const verifyProviderCommand = new Command('verify-provider')
  .description('Check that a running provider service matches its OpenAPI spec')
  .requiredOption('--spec <path>',         'Path to the provider OpenAPI spec (YAML or JSON)')
  .requiredOption('--base-url <url>',      'Base URL of the running provider, e.g. https://staging.payments.acme.com')
  .option('--include-mutating',            'Also probe POST/PUT/PATCH/DELETE (off by default for safety)')
  .option('--path-params <kvList>',        'Resolve path params: name=val,other=val (overrides spec examples)', collectPathParams, {})
  .option('--header <header>',             'Extra request header to send, e.g. "Authorization: Bearer X" (repeatable)', collectHeaders, {})
  .option('--timeout-ms <ms>',             'Per-request timeout in ms', v => parseInt(v, 10), 8000)
  .option('--json',                        'Output raw JSON instead of the human report')
  .action(async (opts) => {
    const { verifyProvider } = require('../core/conformance');
    const specPath = path.resolve(opts.spec);
    if (!fsExtra.existsSync(specPath)) {
      logger.error(`Spec file not found: ${specPath}`);
      process.exit(2);
    }
    const spinner = opts.json ? null : ora('Probing provider…').start();
    let report;
    try {
      report = await verifyProvider({
        spec: specPath,
        baseUrl: opts.baseUrl,
        includeMutating: !!opts.includeMutating,
        pathParams: opts.pathParams,
        headers: opts.header,
        timeoutMs: opts.timeoutMs,
      });
    } catch (err) {
      if (spinner) spinner.fail('Conformance run failed');
      logger.error(err.message);
      process.exit(1);
    }
    if (spinner) spinner.stop();

    if (opts.json) {
      process.stdout.write(JSON.stringify(report, null, 2) + '\n');
      process.exit(report.summary.fail + report.summary.error > 0 ? 1 : 0);
    }

    // Human report.
    process.stdout.write('\n' + chalk.bold('  Provider conformance — spec vs ') + chalk.cyan(opts.baseUrl) + '\n');
    process.stdout.write('  ' + '─'.repeat(60) + '\n');
    for (const r of report.results) {
      const label = `${r.method.padEnd(6)} ${r.routePath}`;
      const tag =
        r.status === 'PASS'    ? chalk.green('  PASS  ') :
        r.status === 'FAIL'    ? chalk.red('  FAIL  ')   :
        r.status === 'ERROR'   ? chalk.red(' ERROR  ')   :
                                  chalk.yellow(' SKIP   ');
      process.stdout.write(`  ${tag} ${label}` +
        (r.httpStatus ? chalk.gray(`  (${r.httpStatus})`) : '') + '\n');
      if (r.status === 'FAIL' && r.mismatches && r.mismatches.length > 0) {
        for (const m of r.mismatches.slice(0, 5)) {
          process.stdout.write(chalk.gray(`           ${m.path || '(root)'}: ${m.message}\n`));
        }
        if (r.mismatches.length > 5) {
          process.stdout.write(chalk.gray(`           …and ${r.mismatches.length - 5} more\n`));
        }
      } else if (r.status === 'FAIL' && r.reason) {
        process.stdout.write(chalk.gray(`           ${r.reason}\n`));
      } else if (r.status === 'ERROR') {
        process.stdout.write(chalk.gray(`           ${r.error}\n`));
      } else if (r.status === 'SKIPPED') {
        process.stdout.write(chalk.gray(`           ${r.reason}: ${r.skipReason}\n`));
      }
    }
    const s = report.summary;
    process.stdout.write('  ' + '─'.repeat(60) + '\n');
    process.stdout.write(`  ${s.pass} pass · ${s.fail} fail · ${s.error} error · ${s.skipped} skip   (${s.total} probes)\n\n`);
    process.exit(s.fail + s.error > 0 ? 1 : 0);
  });

// Repeatable --header parser: collects into a map.
function collectHeaders(val, acc) {
  const idx = val.indexOf(':');
  if (idx < 0) return acc;
  const k = val.slice(0, idx).trim();
  const v = val.slice(idx + 1).trim();
  if (k) acc[k] = v;
  return acc;
}

// --path-params name=val,name=val parser: merges into the accumulator so the
// flag can be passed multiple times.
function collectPathParams(val, acc) {
  for (const pair of String(val).split(',')) {
    const [k, ...rest] = pair.split('=');
    if (k && k.trim()) acc[k.trim()] = rest.join('=').trim();
  }
  return acc;
}

// ─── Parent bdct command ──────────────────────────────────────────────────────

const bdct = new Command('bdct')
  .description('Bi-Directional Contract Testing (BDCT) — publish specs, verify compatibility, check deployability');

bdct.addCommand(publishProviderCommand);
bdct.addCommand(publishConsumerCommand);
bdct.addCommand(verifyCommand);
bdct.addCommand(canIDeployCommand);
bdct.addCommand(listCommand);
bdct.addCommand(matrixCommand);
bdct.addCommand(listProvidersCommand);
bdct.addCommand(listConsumersCommand);
bdct.addCommand(captureCommand);
bdct.addCommand(verifyProviderCommand);

module.exports = bdct;
