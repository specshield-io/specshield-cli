'use strict';

/**
 * `specshield whoami` — print the active customer's identity and the list of
 * organizations they can use as `--org` values. Reuses /auth/validate-api-key
 * (for the customer summary) and /me/orgs (for the org list) — the same two
 * endpoints the init wizard hits.
 *
 * Why it exists: the dashboard now surfaces orgKey, but terminal-native users
 * and CI engineers shouldn't have to open a browser to discover what their
 * org_key is. This command makes it a one-line lookup.
 *
 * Resolves the API token the same way every other command does:
 *   --api-token flag  >  $SPECSHIELD_API_KEY  >  stored ~/.specshield/config.json
 */

const { Command } = require('commander');
const chalk = require('chalk');
const axios = require('axios');
const logger = require('../utils/logger');
const { getStoredApiKey } = require('../config/localConfig');

const DEFAULT_SERVER = 'https://specshield.io';

const whoami = new Command('whoami');

whoami
  .description('Show the signed-in customer and the orgKeys you can use as --org')
  .option('--api-token <key>', 'Override stored / env API token for this call')
  .option('--server <url>',    'Override the SpecShield server URL', DEFAULT_SERVER)
  .option('--json',            'Output machine-readable JSON instead of a table')
  .action(async (opts) => {
    const token = opts.apiToken
      || process.env.SPECSHIELD_API_KEY
      || (await getStoredApiKey());
    if (!token) {
      logger.error('Not logged in. Run: specshield login --api-key <KEY>');
      process.exit(2);
    }

    const server = (opts.server || DEFAULT_SERVER).replace(/\/$/, '');
    const headers = { 'X-Api-Key': token, 'X-SpecShield-Client': 'cli' };

    let me, orgs;
    try {
      const meRes = await axios.post(`${server}/auth/validate-api-key`, {}, { headers, timeout: 8000 });
      if (!meRes.data || !meRes.data.valid) {
        logger.error('API key did not validate against ' + server);
        process.exit(2);
      }
      me = meRes.data;
    } catch (err) {
      logger.error(err.response
        ? `Failed to validate token: ${err.response.status} ${JSON.stringify(err.response.data)}`
        : `Could not reach ${server}: ${err.message}`);
      process.exit(2);
    }

    try {
      const orgsRes = await axios.get(`${server}/me/orgs`, { headers, timeout: 8000 });
      orgs = Array.isArray(orgsRes.data) ? orgsRes.data : (orgsRes.data?.orgs || []);
    } catch (err) {
      // Org fetch is best-effort; the customer info already printed below
      // is the more important part.
      orgs = [];
    }

    if (opts.json) {
      process.stdout.write(JSON.stringify({
        customer: { name: me.name, email: me.email, plan: me.plan, customerId: me.customerId },
        server,
        orgs: orgs.map(o => ({ orgKey: o.orgKey, name: o.name, role: o.myRole || o.role || null })),
      }, null, 2) + '\n');
      return;
    }

    // Human-readable output. Two sections — identity, then orgs table.
    process.stdout.write('\n');
    process.stdout.write(`  ${chalk.bold('Logged in as:')} ${me.name || '(no name)'} `);
    if (me.email) process.stdout.write(chalk.gray(`(${me.email})`));
    process.stdout.write(`   ${chalk.gray('· plan:')} ${chalk.cyan(me.plan || 'FREE')}\n`);
    process.stdout.write(`  ${chalk.gray('Server:')}       ${server}\n`);
    process.stdout.write('\n');

    if (orgs.length === 0) {
      process.stdout.write(chalk.yellow('  You are not a member of any organization yet.\n'));
      process.stdout.write(chalk.gray(`  Create one at ${server}/account/team to get an org_key.\n\n`));
      return;
    }

    process.stdout.write(`  ${chalk.bold('Organizations you can use as --org:')}\n`);
    process.stdout.write(chalk.gray('  ─────────────────────────────────────────────────────\n'));
    const widestKey = Math.max(...orgs.map(o => (o.orgKey || '').length), 8);
    for (const o of orgs) {
      const key  = (o.orgKey || '').padEnd(widestKey);
      const role = o.myRole || o.role || '';
      process.stdout.write(
        `    ${chalk.cyan(key)}   ${o.name || ''}` +
        (role ? `   ${chalk.gray('(' + role + ')')}` : '') + '\n');
    }
    process.stdout.write('\n');
    process.stdout.write(chalk.gray(`  Tip: paste an org_key into --org on CLI commands or bdct.org in .specshield.yml\n\n`));
  });

module.exports = whoami;
