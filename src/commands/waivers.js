'use strict';

const { Command } = require('commander');
const chalk = require('chalk');
const path = require('path');
const { loadConfig } = require('../core/configLoader');
const W = require('../core/gate/waivers');
const { plural } = require('../core/usage/format');
const logger = require('../utils/logger');
const exitAfterFlush = require('../utils/exitAfterFlush');

const DAY = 86400000;

async function settings(opts) {
  const config = await loadConfig(opts.config);
  const g = config.gate || {};
  const maxDays = opts.maxDays !== undefined ? Number(opts.maxDays) : (g.maxWaiverDays || W.DEFAULT_MAX_DAYS);
  if (!(maxDays >= 1)) throw new Error('--max-days must be a number ≥ 1');
  return { file: opts.file || g.waivers || W.DEFAULT_FILE, maxDays };
}

const add = new Command('add')
  .description('Accept a breaking change: add a waiver with an owner, a reason and an expiry')
  .argument('<change>', 'Change type, e.g. response-field-removed (as printed by "specshield gate"); "*" with --operation for every change there')
  .option('--operation <op>', 'Limit to an operation: "GET /pets/{id}"; * and ** glob path segments; "/pets/**" = any method')
  .option('--field <name>', 'Limit to a field (name or dotted path suffix)')
  .requiredOption('--owner <who>', 'Who answers for this waiver, e.g. @alice or team-payments')
  .requiredOption('--reason <text>', 'Why this break is acceptable — what a reviewer needs to know')
  .option('--days <n>', 'Expire after n days (default 30)')
  .option('--expires <date>', 'Expire after this day (YYYY-MM-DD) instead of --days')
  .option('--ticket <id>', 'A ticket or issue that tracks the follow-up')
  .option('--file <path>', `Waiver file (default: ${W.DEFAULT_FILE})`)
  .option('--max-days <n>', `Longest allowed waiver (default: gate.maxWaiverDays or ${W.DEFAULT_MAX_DAYS})`)
  .option('--config <path>', 'Path to .specshield.yml')
  .action(async (change, opts) => {
    try {
      const { file, maxDays } = await settings(opts);
      if (opts.days && opts.expires) throw new Error('Use either --days or --expires, not both');
      const created = W.today();
      let expires = opts.expires;
      if (!expires) {
        const days = opts.days !== undefined ? Number(opts.days) : 30;
        if (!(Number.isInteger(days) && days >= 1)) throw new Error('--days must be a whole number ≥ 1');
        expires = new Date(Date.parse(created) + days * DAY).toISOString().slice(0, 10);
      }
      const waiver = { change, operation: opts.operation, field: opts.field, owner: opts.owner, reason: opts.reason, created, expires, ticket: opts.ticket };
      const checked = W.validate(waiver, 0, { maxDays });
      if (checked.errors.length) throw new Error(`Waiver not added: ${checked.errors.join('; ')}`);
      await W.addWaiver(path.resolve(file), { ...waiver, change: checked.change, operation: checked.operation ? normalizeOp(checked.operation) : undefined });
      process.stdout.write(chalk.green(`✔ Waiver added to ${file}`) + chalk.gray(` — ${[checked.change, checked.operation, checked.field].filter(Boolean).join(' ')}, ${checked.owner}, until ${expires}`) + '\n');
      process.stdout.write(chalk.gray('  Commit it with the change it accepts, so the waiver is reviewed with the PR.') + '\n');
    } catch (err) {
      logger.error(`Error: ${err.message}`);
      process.exit(2);
    }
  });

function normalizeOp(op) {
  const p = W.parseOperation(op);
  return p.method === '*' ? p.path : `${p.method} ${p.path}`;
}

const list = new Command('list')
  .description('List waivers with their owner and expiry; --check fails on expired or invalid ones')
  .option('--file <path>', `Waiver file (default: ${W.DEFAULT_FILE})`)
  .option('--max-days <n>', `Longest allowed waiver (default: gate.maxWaiverDays or ${W.DEFAULT_MAX_DAYS})`)
  .option('--check', 'Exit 1 when a waiver is expired or invalid (for a scheduled CI job)')
  .option('--config <path>', 'Path to .specshield.yml')
  .option('--json', 'Output machine-readable JSON')
  .action(async (opts) => {
    try {
      const { file, maxDays } = await settings(opts);
      const { exists, waivers } = await W.loadWaivers(path.resolve(file), { maxDays, file });
      const rows = waivers.map((w) => ({ ...w, status: W.status(w), daysLeft: W.daysLeft(w) }));
      const bad = rows.filter((w) => w.status === 'expired' || w.status === 'invalid');
      if (opts.json) {
        process.stdout.write(JSON.stringify({ file, exists, waivers: rows }, null, 2) + '\n');
      } else {
        process.stdout.write(renderList(file, exists, rows) + '\n');
      }
      exitAfterFlush(opts.check && bad.length ? 1 : 0);
    } catch (err) {
      logger.error(`Error: ${err.message}`);
      process.exit(2);
    }
  });

function renderList(file, exists, rows) {
  const lines = [''];
  lines.push(chalk.bold(`  Waivers — ${file}`));
  lines.push(chalk.gray('  ─────────────────────────────────────────'));
  if (!exists || rows.length === 0) {
    lines.push(chalk.gray(`  ${exists ? 'The file has no waivers.' : 'No waiver file yet.'} Add one with: specshield waivers add <change> --owner <you> --reason "<why>"`));
    lines.push('');
    return lines.join('\n');
  }
  const counts = rows.reduce((m, w) => ({ ...m, [w.status]: (m[w.status] || 0) + 1 }), {});
  lines.push(`  ${plural(rows.length, 'waiver')}` + ['active', 'expiring', 'expired', 'invalid']
    .filter((s) => counts[s]).map((s) => ` · ${color(s)(`${counts[s]} ${s}`)}`).join(''));
  for (const w of rows) {
    lines.push('');
    const what = [w.change || '?', w.operation, w.field].filter(Boolean).join(' ');
    const when = w.status === 'invalid' ? 'invalid'
      : w.status === 'expired' ? `expired ${w.expires}`
      : `${w.daysLeft === 0 ? 'expires today' : `${plural(w.daysLeft, 'day')} left`} (${w.expires})`;
    lines.push(`  ${color(w.status)('●')} ${what}  ${color(w.status)(when)}`);
    if (w.owner || w.reason) lines.push(chalk.gray(`      ${w.owner || 'no owner'}${w.ticket ? ` · ${w.ticket}` : ''}: ${w.reason || 'no reason'}`));
    if (w.errors.length) lines.push(chalk.red(`      ${w.errors.join('; ')}`));
  }
  lines.push('');
  return lines.join('\n');
}

function color(status) {
  return { active: chalk.green, expiring: chalk.yellow, expired: chalk.red, invalid: chalk.red }[status] || chalk.gray;
}

const waivers = new Command('waivers')
  .description('Accepted breaking changes for "specshield gate": each with an owner, a reason and an expiry')
  .addCommand(list, { isDefault: true })
  .addCommand(add);

module.exports = waivers;
