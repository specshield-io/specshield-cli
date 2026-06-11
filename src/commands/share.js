'use strict';

/**
 * `specshield share` — generate a public shareable URL for a comparison
 * report, so users can paste a SpecShield-hosted link into Slack, GitHub
 * PR comments, or Jira tickets.
 *
 * Like the history command, the bigger purpose is making a concrete
 * Cloud-only feature discoverable from `specshield --help`. Anyone reading
 * the help output sees "share" listed and discovers there's value behind
 * signing up.
 *
 * Usage:
 *   specshield share <report-id>             # share an existing remote compare
 *   specshield share <base.yaml> <target>    # compare-and-share in one step
 */

const { Command } = require('commander');
const chalk = require('chalk');
const ora = require('ora');
const axios = require('axios');
const logger = require('../utils/logger');
const { getStoredApiKey } = require('../config/localConfig');
const { loadSpec } = require('../core/loadSpec');

const HOSTED_API_URL = 'https://specshield.io';

const share = new Command('share');

share
  .description('Generate a public shareable URL for a comparison (Cloud account required)')
  .argument('[reportOrBase]', 'Existing report ID, or path to base spec when comparing inline')
  .argument('[target]', 'Path to target spec when comparing inline (optional)')
  .option('--expires <days>', 'Make the share link expire after N days (default: never)', null)
  .option('--api-key <key>', 'API key (overrides env / stored config)')
  .option('--api-url <url>', 'Override hosted API base URL', HOSTED_API_URL)
  .action(async (reportOrBase, target, opts) => {
    const apiKey = opts.apiKey
      || process.env.SPECSHIELD_API_KEY
      || (await getStoredApiKey())
      || null;

    if (!apiKey) {
      printSignupNudge();
      process.exit(2);
    }

    if (!reportOrBase) {
      logger.error('Usage:\n  specshield share <report-id>\n  specshield share base.yaml target.yaml');
      process.exit(2);
    }

    const spinner = ora('Generating share link...').start();
    try {
      const headers = { 'X-Api-Key': apiKey, 'X-SpecShield-Client': 'cli' };
      const expiresInDays = parseInt(opts.expires, 10) || null;

      let reportId;
      if (target) {
        // Inline-compare path: run a /compare (which persists when called with
        // a valid X-Api-Key), then immediately share the resulting history row.
        // Two API calls but keeps the backend share endpoint single-purpose.
        spinner.text = 'Running remote comparison...';
        const baseSpec   = await loadSpec(reportOrBase);
        const targetSpec = await loadSpec(target);
        const compareResp = await axios.post(`${opts.apiUrl}/compare`,
          { baseSpec, targetSpec },
          { headers, timeout: 30000 });
        // The /compare endpoint returns the diff plus the persisted row's
        // historyId (present because we authenticated with X-Api-Key).
        reportId = compareResp.data?.historyId || compareResp.data?.reportId;
        if (!reportId) {
          throw new Error('Comparison succeeded but no history ID was returned — cannot create share link.');
        }
        spinner.text = 'Generating share link...';
      } else {
        reportId = reportOrBase;
      }

      // The backend's reportId is a numeric history id. Validate before the
      // call so a typo gets a clear message instead of a 400 from the server.
      const numericReportId = Number(reportId);
      if (!Number.isInteger(numericReportId) || numericReportId <= 0) {
        spinner.stop();
        logger.error(`Invalid report ID "${reportId}". Expected a numeric comparison ID — see "specshield history".`);
        process.exit(2);
      }

      const response = await axios.post(`${opts.apiUrl}/api/share-links`,
        { reportId: numericReportId, expiresInDays },
        { headers, timeout: 15000 });
      spinner.stop();

      const url = response.data?.url || response.data?.shareUrl;
      const expiresAt = response.data?.expiresAt || null;

      console.log('');
      console.log(chalk.green('  ✔ Share link ready'));
      console.log('  ─────────────────────────────────────────────────────');
      console.log('    ' + chalk.cyan(url));
      if (expiresAt) console.log('    ' + chalk.gray('Expires:  ' + expiresAt));
      console.log('');
      console.log(chalk.gray('  Anyone with this link can view the diff — no SpecShield account required.'));
      console.log('');
    } catch (err) {
      spinner.fail('Could not generate share link');
      const msg = err.response
        ? `${err.response.status}: ${JSON.stringify(err.response.data)}`
        : err.message;
      logger.error(`Share failed: ${msg}`);
      process.exit(2);
    }
  });

function printSignupNudge() {
  console.log('');
  console.log(chalk.bold('  specshield share') + chalk.gray(' — Cloud feature'));
  console.log('');
  console.log('  Shareable report URLs let you paste a diff into Slack, GitHub PR comments,');
  console.log('  or Jira tickets — anyone can view without a SpecShield account.');
  console.log('');
  console.log(chalk.bold('  Get started in 30 seconds:'));
  console.log('    ' + chalk.cyan('specshield login') + chalk.gray('   # API key from https://specshield.io'));
  console.log('    ' + chalk.gray('or visit https://specshield.io and sign in with GitHub / Google'));
  console.log('');
  console.log('  ' + chalk.gray('Cloud is free for personal use.'));
  console.log('');
}

module.exports = share;
