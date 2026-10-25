'use strict';

const { Command } = require('commander');
const chalk = require('chalk');
const fsExtra = require('fs-extra');
const { loadSpec } = require('../core/loadSpec');
const { parseSpec } = require('../core/parseSpec');
const { loadConfig } = require('../core/configLoader');
const { loadProjectConfig } = require('../core/projectConfig');
const { loadUsage } = require('../core/usage/usageStore');
const { deprecationReport } = require('../core/usage/deprecations');
const { fmt, plural, day, spanDays, ago } = require('../core/usage/format');
const { getStoredApiKey } = require('../config/localConfig');
const { uploadDeprecationReport } = require('../api/bdctClient');
const logger = require('../utils/logger');
const exitAfterFlush = require('../utils/exitAfterFlush');

const FAIL_ON = ['none', 'past-sunset', 'in-use'];
const MAX_CLIENTS_SHOWN = 5;

const deprecations = new Command('deprecations')
  .description('Deprecate → watch traffic drain → remove: who still calls each deprecated endpoint, parameter and field')
  .argument('<spec>', 'OpenAPI spec with `deprecated: true` (and optional `x-sunset: YYYY-MM-DD`) markings')
  .option('--usage <file>', 'usage.json from "specshield usage import" (default: usage.file in .specshield.yml)')
  .option('--quiet-days <n>', 'Days without a call before an item is safe to remove (default: 30)')
  .option('--usage-ignore-client <pattern>', 'Leave a client out, e.g. health checks (repeatable; * globs)', collect, [])
  .option('--usage-max-age <days>', 'Newest log line may be at most this old (default: 30)')
  .option('--usage-min-coverage <pct>', 'Percent of spec operations that must appear in the logs (default: 25)')
  .option('--fail-on <when>', `Exit 1 when: ${FAIL_ON.join(' | ')}`, 'none')
  .option('--json', 'Output machine-readable JSON')
  .option('--output <file>', 'Also save the JSON report to this file')
  .option('--csv <file>', 'Write the remaining callers (item, client, calls, last call, contact) as CSV for outreach')
  .option('--upload', 'Send the report to your SpecShield dashboard (Team plan) to track the drain week by week')
  .option('--org <key>', 'Org key for --upload (default: bdct.org in .specshield.yml)')
  .option('--api <name>', 'API name for --upload (default: the spec title)')
  .option('--server <url>', 'SpecShield server URL')
  .option('--api-token <token>', 'API token (overrides env / stored config)')
  .option('--config <path>', 'Path to .specshield.yml config file')
  .action(async (specPath, opts) => {
    try {
      if (!FAIL_ON.includes(opts.failOn)) throw new Error(`--fail-on must be one of ${FAIL_ON.join(', ')}`);
      const config = await loadConfig(opts.config);
      const u = config.usage || {};
      const usageFile = opts.usage || u.file || null;

      const spec = parseSpec(await loadSpec(specPath), specPath);
      const usage = usageFile ? await loadUsage(usageFile) : null;
      const report = deprecationReport({
        spec,
        usage,
        file: usageFile,
        quietDays: num(opts.quietDays ?? u.quietDays ?? 30, '--quiet-days'),
        ignoreClients: [...opts.usageIgnoreClient, ...(u.ignoreClients || [])],
        maxAgeDays: num(opts.usageMaxAge ?? u.maxAgeDays ?? 30, '--usage-max-age'),
        minCoverage: num(opts.usageMinCoverage ?? u.minCoverage ?? 25, '--usage-min-coverage', 100),
        contacts: u.contacts || {},
      });

      if (opts.upload) report.upload = await upload(report, spec, opts);

      const json = JSON.stringify(report, null, 2);
      if (opts.json) process.stdout.write(json + '\n');
      else process.stdout.write(renderReport(report) + '\n');
      if (opts.output) await fsExtra.outputFile(opts.output, json + '\n');
      if (opts.csv) {
        await fsExtra.outputFile(opts.csv, toCsv(report));
        if (!opts.json) logger.info(`Callers written to ${opts.csv}`);
      }

      const s = report.summary;
      const failed = (opts.failOn === 'past-sunset' && s.pastSunset > 0) ||
        (opts.failOn === 'in-use' && s.inUse + s.unverifiable > 0);
      exitAfterFlush(failed ? 1 : 0);
    } catch (err) {
      if (err.status === 402) {
        logger.error('Uploading deprecation reports requires a paid plan (Team or above). See https://specshield.io/pricing');
      } else {
        logger.error(`Error: ${err.message}`);
      }
      process.exit(2);
    }
  });

async function upload(report, spec, opts) {
  const project = loadProjectConfig();
  const bdct = project.bdct || {};
  const orgKey = opts.org || (bdct.org !== '<replace-me>' ? bdct.org : null);
  const apiName = opts.api || (spec.info && spec.info.title);
  if (!orgKey) throw new Error('--upload needs an org key: pass --org <key> (shown by "specshield whoami" or on the dashboard)');
  if (!apiName) throw new Error('--upload needs an API name: pass --api <name> (the spec has no info.title)');
  const token = opts.apiToken || process.env.SPECSHIELD_API_KEY || (await getStoredApiKey());
  if (!token) throw new Error('No API token found. Pass --api-token, set SPECSHIELD_API_KEY, or run: specshield login --api-key <KEY>');
  const res = await uploadDeprecationReport(opts.server || bdct.server, token, { orgKey, apiName, report });
  return { orgKey, apiName, id: res && res.id, url: res && res.url, changes: (res && res.changes) || [] };
}

// ─── Human output ───────────────────────────────────────────────────────────

const SECTIONS = [
  ['in-use', (n) => chalk.red.bold(`  ✖  STILL CALLED (${n}) — not safe to remove`)],
  ['unverifiable', (n) => chalk.yellow.bold(`  ?  CAN'T VERIFY FROM LOGS (${n}) — the endpoint is still called`)],
  ['quiet', (n) => chalk.cyan.bold(`  ○  QUIET (${n}) — no calls, keep watching`)],
  ['no-data', (n) => chalk.gray.bold(`  ·  NO VERDICT (${n})`)],
  ['safe-to-remove', (n) => chalk.green.bold(`  ✔  SAFE TO REMOVE (${n})`)],
];

function renderReport(r) {
  const lines = [''];
  const s = r.summary;
  lines.push(chalk.bold(`  SpecShield™ Deprecations${r.api.title ? ` — ${r.api.title}` : ''}`));
  lines.push(chalk.gray('  ─────────────────────────────────────────'));
  if (s.total === 0) {
    lines.push('  Nothing in this spec is marked deprecated.');
    lines.push(chalk.gray('  Mark an operation, parameter or schema property with `deprecated: true`'));
    lines.push(chalk.gray('  (and optionally `x-sunset: YYYY-MM-DD`) to start tracking who still uses it.'));
    lines.push('');
    return lines.join('\n');
  }
  if (r.usage) {
    const w = r.usage.window;
    lines.push(chalk.gray(`  ${r.usage.file} · ${day(w.from)} → ${day(w.to)} (${spanDays(w)} days) · ` +
      `safe after ${r.quietDays} quiet days`));
    if (r.usage.evidence !== 'ok') lines.push(chalk.yellow(`  No verdicts: ${r.usage.evidence}.`));
  }
  lines.push(`  ${plural(s.total, 'deprecated item')} · ` + [
    s.inUse && chalk.red(`${s.inUse} still called`),
    s.unverifiable && chalk.yellow(`${s.unverifiable} can't verify`),
    s.quiet && chalk.cyan(`${s.quiet} quiet`),
    s.safeToRemove && chalk.green(`${s.safeToRemove} safe to remove`),
    s.pastSunset && chalk.red.bold(`${s.pastSunset} past sunset`),
  ].filter(Boolean).join(' · '));

  for (const [status, header] of SECTIONS) {
    const items = r.items.filter((i) => i.status === status);
    if (items.length === 0) continue;
    lines.push('');
    lines.push(header(items.length));
    lines.push(chalk.gray('  ─────────────────────────────────────────'));
    if (status === 'no-data' && r.usage === null) {
      lines.push(chalk.gray('  Pass --usage usage.json to see who still calls these.'));
      for (const i of items) lines.push(`  ${label(i)}${sunsetNote(i)}`);
      continue;
    }
    for (const i of items) lines.push(...renderItem(i));
  }
  if (r.upload) {
    lines.push('');
    lines.push(chalk.green(`  ✔ Uploaded to ${r.upload.orgKey} / ${r.upload.apiName}`) + (r.upload.url ? chalk.gray(`  ${r.upload.url}`) : ''));
    if (r.upload.changes.length) lines.push(chalk.bold('  Since the last upload:'));
    for (const c of r.upload.changes) {
      lines.push(`    ${c.key}  ` + (c.to === 'safe-to-remove' ? chalk.green('→ safe to remove')
        : c.to === 'past-sunset' ? chalk.red(`→ past its sunset, ${plural(c.clients, 'client')} still calling`)
          : chalk.yellow(`→ called again by ${plural(c.clients, 'client')}`)));
    }
  }
  lines.push('');
  return lines.join('\n');
}

function renderItem(i) {
  const lines = [`  ${label(i)}${sunsetNote(i)}`];
  if (i.status === 'in-use' || i.status === 'unverifiable') {
    lines.push(chalk.gray(`      ${plural(i.clients.length, 'client')} · ${plural(i.calls, 'call')} · last call ${ago(i.lastSeen)}`) +
      (i.weeks.length > 1 ? chalk.gray('   weekly ') + sparkline(i.weeks) : ''));
    const shown = i.clients.slice(0, MAX_CLIENTS_SHOWN);
    const width = Math.min(32, Math.max(...shown.map((c) => c.id.length)));
    for (const c of shown) {
      lines.push(`      ${chalk.bold(c.id.padEnd(width))}  ${fmt(c.calls).padStart(8)}  ` +
        chalk.gray(`last ${ago(c.lastSeen)}`) + (c.contact ? chalk.cyan(`  → ${c.contact}`) : ''));
    }
    if (i.clients.length > shown.length) lines.push(chalk.gray(`      …and ${i.clients.length - shown.length} more (--csv for all)`));
  } else {
    lines.push(chalk.gray(`      ${i.reason}`) + (i.weeks.length > 1 && i.calls > 0 ? chalk.gray('   weekly ') + sparkline(i.weeks) : ''));
  }
  if (i.status === 'unverifiable') lines.push(chalk.gray(`      (${i.reason})`));
  return lines;
}

function label(i) {
  if (i.kind === 'schema-field') {
    const n = new Set(i.occurrences.map((o) => `${o.method} ${o.path}`)).size;
    return `${chalk.bold('schema')} ${chalk.magenta(i.field)}` + chalk.gray(`  used by ${plural(n, 'operation')}`);
  }
  const op = `${chalk.bold(i.method.padEnd(6))} ${i.path}`;
  if (i.kind === 'operation') return op;
  if (i.kind === 'parameter') return `${op}  ${chalk.magenta(`${i.in} parameter "${i.name}"`)}`;
  return `${op}  ${chalk.magenta(i.field)}`;
}

function sunsetNote(i) {
  if (!i.sunset) return '';
  if (i.daysToSunset === undefined) return chalk.gray(`  · sunset ${i.sunset}`);
  if (i.pastSunset) return chalk.red.bold(`  · sunset ${i.sunset} PASSED ${-i.daysToSunset} days ago`);
  if (i.daysToSunset < 0) return chalk.gray(`  · sunset ${i.sunset} (passed)`);
  return chalk.gray(`  · sunset ${i.sunset} (in ${plural(i.daysToSunset, 'day')})`);
}

const BARS = '▁▂▃▄▅▆▇█';
/** Weekly calls, oldest → newest; · is a week with none. Partial weeks (window edges) are dimmed. */
function sparkline(weeks) {
  const max = Math.max(...weeks.map((w) => w.calls), 1);
  return weeks.map((w) => {
    if (w.calls === 0) return chalk.gray('·');
    const ch = BARS[Math.min(7, Math.floor((w.calls / max) * 7.999))];
    return w.partial ? chalk.gray(ch) : chalk.yellow(ch);
  }).join('');
}

function toCsv(r) {
  const rows = [['item', 'kind', 'status', 'sunset', 'client', 'calls', 'last_call', 'contact']];
  for (const i of r.items) {
    for (const c of i.clients) {
      rows.push([i.key, i.kind, i.status, i.sunset || '', c.id, c.calls, c.lastSeen || '', c.contact || '']);
    }
  }
  return rows.map((row) => row.map(csvCell).join(',')).join('\n') + '\n';
}

function csvCell(v) {
  const s = String(v);
  // A leading = + - @ makes spreadsheets evaluate the cell; client ids come from logs.
  const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;
  return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

function num(value, flag, max = Infinity) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > max) throw new Error(`${flag} must be a number from 0 to ${max}, got "${value}"`);
  return n;
}

function collect(value, previous) {
  return previous.concat([value]);
}

module.exports = deprecations;
