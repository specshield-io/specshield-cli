'use strict';

const { Command } = require('commander');
const chalk = require('chalk');
const ora = require('ora');
const fsExtra = require('fs-extra');
const logger = require('../utils/logger');
const { loadSpec } = require('../core/loadSpec');
const { getStoredApiKey } = require('../config/localConfig');
const { governanceGate } = require('../api/bdctClient');

// Token precedence mirrors the bdct subcommands.
async function resolveApiToken(opts) {
  return opts.apiToken || process.env.SPECSHIELD_API_KEY || (await getStoredApiKey()) || null;
}

const SEV_ORDER = { error: 0, warning: 1, info: 2 };

function sevLabel(sev) {
  const s = String(sev || '').toLowerCase();
  if (s === 'error')   return chalk.red('error  ');
  if (s === 'warning') return chalk.yellow('warning');
  return chalk.blue('info   ');
}

function gradeColor(grade) {
  const g = String(grade || '—').toUpperCase();
  if (g === 'A' || g === 'B') return chalk.green(g);
  if (g === 'C')              return chalk.yellow(g);
  return chalk.red(g);
}

const govern = new Command('govern')
  .description('Lint an OpenAPI spec against governance rules (OWASP + design) and gate the PR')
  .argument('<spec>', 'Path to the OpenAPI spec to govern (YAML or JSON)')
  .option('--ruleset <path>', 'Lint against a Spectral-format ruleset file (uses the ruleset engine)')
  .option('--min-score <n>', 'Minimum compliance score (0–100) required to pass (default 70)', (v) => parseInt(v, 10))
  .option('--fail-on-warning', 'Fail the gate when any warning-severity finding is present')
  .option('--no-fail-on-error', 'Do NOT fail the gate on error-severity findings')
  .option('--org <key>', 'Org key — applies your org’s active governance waivers to the verdict')
  .option('--advisory', 'Report findings but always exit 0 (never fail CI)')
  .option('--json', 'Output machine-readable JSON')
  .option('--output <file>', 'Also save the JSON result to this file')
  .option('--server <url>', 'SpecShield server URL')
  .option('--api-token <token>', 'API token (overrides env / stored config)')
  .action(async (specPath, opts) => {
    try {
      const token = await resolveApiToken(opts);
      if (!token) {
        logger.error('No API token found. Pass --api-token, set SPECSHIELD_API_KEY, or run: specshield login --api-key <KEY>');
        process.exit(2);
      }

      const spinner = opts.json ? null : ora('Loading spec...').start();
      const specText = await loadSpec(specPath);
      const ruleset = opts.ruleset ? await loadSpec(opts.ruleset) : null;

      // Only send policy fields the user overrode; the server applies documented
      // defaults (minScore 70, failOnError true, failOnWarning false) otherwise.
      const policy = {};
      if (opts.minScore !== undefined && !Number.isNaN(opts.minScore)) policy.minScore = opts.minScore;
      if (opts.failOnWarning) policy.failOnWarning = true;
      if (opts.failOnError === false) policy.failOnError = false; // set by --no-fail-on-error

      if (spinner) spinner.text = 'Running governance review...';
      const resp = await governanceGate(opts.server, token, {
        spec: specText,
        ruleset,
        policy: Object.keys(policy).length ? policy : null,
        orgKey: opts.org || null,
      });
      if (spinner) spinner.stop();

      if (opts.json) {
        const out = JSON.stringify(resp, null, 2);
        process.stdout.write(out + '\n');
        if (opts.output) await fsExtra.outputFile(opts.output, out);
      } else {
        renderHuman(resp);
        if (opts.output) await fsExtra.outputFile(opts.output, JSON.stringify(resp, null, 2));
      }

      if (opts.advisory) process.exit(0);
      process.exit(resp.passed ? 0 : 1);
    } catch (err) {
      if (err.status === 402) {
        logger.error('API governance requires a paid plan (Team or above). See https://specshield.io/pricing');
        process.exit(2);
      }
      if (err.status === 503) {
        logger.error('Governance is not enabled on this SpecShield server.');
        process.exit(2);
      }
      logger.error(`Error: ${err.message}`);
      process.exit(2);
    }
  });

function renderHuman(resp) {
  const review = resp.review || {};
  const findings = Array.isArray(review.findings) ? review.findings.slice() : [];
  const score = review.score || {};

  process.stdout.write('\n  ' + chalk.bold('SpecShield™ Governance Report') + '\n');
  process.stdout.write('  ' + chalk.gray('─────────────────────────────────────────') + '\n');

  if (findings.length === 0) {
    process.stdout.write('  ' + chalk.green('✔ No governance findings.') + '\n');
  } else {
    findings.sort((a, b) =>
      (SEV_ORDER[String(a.severity).toLowerCase()] ?? 3) - (SEV_ORDER[String(b.severity).toLowerCase()] ?? 3));
    for (const f of findings) {
      const loc = f.location ? chalk.gray('  ' + f.location) : '';
      process.stdout.write(`  ${sevLabel(f.severity)}  ${chalk.cyan(f.ruleId || '')}${loc}\n`);
      if (f.message) process.stdout.write(`           ${f.message}\n`);
      if (f.suggestedFix) process.stdout.write(`           ${chalk.gray('fix: ' + f.suggestedFix)}\n`);
    }
  }

  process.stdout.write('  ' + chalk.gray('─────────────────────────────────────────') + '\n');
  const scoreVal = (score.value === undefined || score.value === null) ? '—' : score.value;
  process.stdout.write(
    `  Score ${chalk.bold(scoreVal)}/100 · grade ${gradeColor(score.grade)}  ·  `
    + `${chalk.red((review.errorCount || 0) + ' error')} · `
    + `${chalk.yellow((review.warningCount || 0) + ' warning')} · `
    + `${chalk.blue((review.infoCount || 0) + ' info')}`
    + (resp.waivedCount ? `  ·  ${chalk.gray(resp.waivedCount + ' waived')}` : '')
    + '\n'
  );

  if (resp.passed) {
    process.stdout.write('\n  ' + chalk.green.bold('✔ PASS')
      + chalk.gray(` — meets the governance policy (min score ${resp.scoreThreshold}).`) + '\n\n');
  } else {
    process.stdout.write('\n  ' + chalk.red.bold('✖ FAIL') + chalk.gray(' — governance policy not met:') + '\n');
    for (const r of (resp.reasons || [])) process.stdout.write('    ' + chalk.red('•') + ' ' + r + '\n');
    if (resp.recommendedAction) process.stdout.write('\n  ' + chalk.gray(resp.recommendedAction) + '\n');
    process.stdout.write('\n');
  }
}

module.exports = govern;
