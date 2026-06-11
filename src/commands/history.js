'use strict';

/**
 * `specshield history` — list recent comparisons saved in the user's
 * SpecShield Cloud account.
 *
 * This command's primary value isn't itself — it's that it surfaces a
 * concrete Cloud-only feature in `specshield --help`, giving local-only
 * users a visible "what am I missing?" signal. When run without a stored
 * API key, it prints a brief sign-up nudge rather than failing silently.
 */

const { Command } = require('commander');
const chalk = require('chalk');
const ora = require('ora');
const axios = require('axios');
const logger = require('../utils/logger');
const { getStoredApiKey } = require('../config/localConfig');

const HOSTED_API_URL = 'https://specshield.io';

const history = new Command('history');

history
  .description('Show your recent comparisons (Cloud account required)')
  .option('--limit <n>', 'How many comparisons to show', '20')
  .option('--json', 'Machine-readable JSON output')
  .option('--api-key <key>', 'API key (overrides env / stored config)')
  .option('--api-url <url>', 'Override hosted API base URL', HOSTED_API_URL)
  .action(async (opts) => {
    const apiKey = opts.apiKey
      || process.env.SPECSHIELD_API_KEY
      || (await getStoredApiKey())
      || null;

    if (!apiKey) {
      printSignupNudge();
      process.exit(2);
    }

    const spinner = opts.json ? null : ora('Fetching your comparison history...').start();
    try {
      const size = parseInt(opts.limit, 10) || 20;
      const response = await axios.get(`${opts.apiUrl}/api/compare-history`, {
        // Backend paginates with page (0-indexed) + size; the /api endpoint
        // returns a PagedResponse envelope ({ content, page, size, ... }).
        params: { page: 0, size },
        headers: { 'X-Api-Key': apiKey, 'X-SpecShield-Client': 'cli' },
        timeout: 10000,
      });
      if (spinner) spinner.stop();

      const items = response.data?.content
                 || response.data?.items
                 || (Array.isArray(response.data) ? response.data : []);

      if (opts.json) {
        process.stdout.write(JSON.stringify(items, null, 2) + '\n');
        return;
      }

      if (items.length === 0) {
        console.log(chalk.gray('\n  No comparisons in your history yet. Run:'));
        console.log(chalk.cyan('    specshield compare a.yaml b.yaml --remote\n'));
        return;
      }

      console.log('\n  ' + chalk.bold('Your recent comparisons'));
      console.log(chalk.gray('  ─────────────────────────────────────────────────────'));
      for (const item of items) {
        const id      = item.id || item.reportId || '—';
        const created = item.createdAt || item.timestamp || '—';
        const breaks  = item.breakingCount ?? item.breakingChanges?.length ?? '—';
        // CompareHistorySummaryDto exposes base + target spec names — combine
        // for a "a.yaml → b.yaml" summary that matches what the user typed.
        const summary = item.baseSpecName && item.targetSpecName
          ? `${item.baseSpecName} → ${item.targetSpecName}`
          : (item.summary || item.baseSpecName || '');
        const breakBadge = breaks === 0 || breaks === '—'
          ? chalk.green(`${breaks} breaking`)
          : chalk.red(`${breaks} breaking`);
        console.log(`  ${chalk.cyan(String(id).padEnd(10))} ${breakBadge.padEnd(18)} ${chalk.gray(String(created))}  ${summary}`);
      }
      console.log();
    } catch (err) {
      if (spinner) spinner.fail('Could not fetch history');
      const msg = err.response
        ? `${err.response.status}: ${JSON.stringify(err.response.data)}`
        : err.message;
      logger.error(`Failed to fetch history: ${msg}`);
      process.exit(2);
    }
  });

function printSignupNudge() {
  console.log('');
  console.log(chalk.bold('  specshield history') + chalk.gray(' — Cloud feature'));
  console.log('');
  console.log('  Comparison history is part of your SpecShield Cloud account.');
  console.log('  Every ' + chalk.cyan('specshield compare --remote') + ' you run is saved with the diff,');
  console.log('  date, and a shareable report URL.');
  console.log('');
  console.log(chalk.bold('  Get started in 30 seconds:'));
  console.log('    ' + chalk.cyan('specshield login') + chalk.gray('   # API key from https://specshield.io'));
  console.log('    ' + chalk.gray('or visit https://specshield.io and sign in with GitHub / Google'));
  console.log('');
  console.log('  ' + chalk.gray('Cloud is free for personal use.'));
  console.log('');
}

module.exports = history;
