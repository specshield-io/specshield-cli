'use strict';

const { Command } = require('commander');
const chalk = require('chalk');
const fsExtra = require('fs-extra');
const { loadSpec } = require('../core/loadSpec');
const { parseSpec } = require('../core/parseSpec');
const { createRouteMatcher } = require('../core/usage/routeMatcher');
const { parseClientSpec } = require('../core/usage/clientIdentity');
const { UsageAggregator, loadUsage, parseDuration } = require('../core/usage/usageStore');
const { importLogFile, fingerprintFile } = require('../core/usage/importLogs');
const { fmt, plural, pct, day, spanDays, ago } = require('../core/usage/format');
const logger = require('../utils/logger');
const exitAfterFlush = require('../utils/exitAfterFlush');
const { version } = require('../../package.json');

const usage = new Command('usage')
  .description('Learn who calls which endpoint from access logs, so compare can say who a change breaks');

// ─── usage import ───────────────────────────────────────────────────────────

usage
  .command('import')
  .description('Aggregate access logs into usage.json (raw logs never leave this machine)')
  .argument('<logs...>', 'Access log files (.gz ok), or - for stdin')
  .option('--out <file>', 'Where to write the usage summary', 'usage.json')
  .option('--spec <file>', 'OpenAPI spec to map request paths onto its path templates (recommended)')
  .option('--format <format>', 'Log format: auto | combined | alb | json', 'auto')
  .option('--client <source>', 'How to identify clients: ua | field:<path> | extra:<n>, optionally hash:-prefixed', 'ua')
  .option('--base-path <path>', 'Path prefix the API is served under, e.g. /api/v1 (default: from the spec servers)')
  .option('--since <duration>', 'Only count requests newer than this, e.g. 30d')
  .option('--append', 'Add to an existing --out file instead of replacing it')
  .action(async (logs, opts) => {
    try {
      const clientSpec = parseClientSpec(opts.client);
      const sinceMs = opts.since ? Date.now() - parseDuration(opts.since) : null;

      let spec = null;
      let matcher = null;
      if (opts.spec) {
        spec = parseSpec(await loadSpec(opts.spec), opts.spec);
        matcher = createRouteMatcher(spec, { basePath: opts.basePath });
      }

      let existing = null;
      if (opts.append && await fsExtra.pathExists(opts.out)) {
        existing = await loadUsage(opts.out);
        if (existing.client !== clientSpec.spec) {
          throw new Error(`${opts.out} identifies clients by "${existing.client}", not "${clientSpec.spec}". Use the same --client to append.`);
        }
      }

      const aggregator = new UsageAggregator({ clientSpec, matcher, sinceMs });
      const sources = existing ? [...(existing.sources || [])] : [];
      const seen = new Set(sources.map((s) => s.fingerprint).filter(Boolean));
      const imported = [];

      for (const file of logs) {
        if (file !== '-') {
          const fp = await fingerprintFile(file).catch(() => null);
          if (fp && seen.has(fp)) {
            logger.warn(`Skipping ${file} — already imported into ${opts.out}`);
            continue;
          }
        }
        const r = await importLogFile(file, { format: opts.format, aggregator });
        if (r.fingerprint) seen.add(r.fingerprint);
        imported.push(r);
        sources.push({ file: r.file, format: r.format, lines: r.lines, parsed: r.parsed, fingerprint: r.fingerprint });
        if (r.parsed === 0 && r.lines > 0) logger.warn(`${file}: no request lines recognised as ${r.format}`);
      }

      if (aggregator.stats.requests === 0 && !existing) {
        throw new Error('No requests were counted. Check the log format (--format), --since, and that the files are access logs.');
      }
      const runStats = { ...aggregator.stats };
      if (existing) aggregator.absorb(existing);

      const out = aggregator.toJSON({
        generator: `specshield-cli ${version}`,
        client: clientSpec.spec,
        spec: spec ? { title: (spec.info && spec.info.title) || null, version: (spec.info && spec.info.version) || null } : null,
        basePath: opts.basePath || (existing && existing.basePath) || null,
        sources,
      });
      await fsExtra.outputFile(opts.out, JSON.stringify(out, null, 2) + '\n');

      printImportSummary(out, imported, runStats, { outFile: opts.out, matcher, appended: !!existing });
      exitAfterFlush(0);
    } catch (err) {
      logger.error(`Error: ${err.message}`);
      process.exit(2);
    }
  });

function printImportSummary(out, imported, run, { outFile, matcher, appended }) {
  const lines = [];
  const parsed = imported.reduce((n, r) => n + r.parsed, 0);
  const skipped = imported.reduce((n, r) => n + r.skipped, 0);
  const formats = [...new Set(imported.map((r) => r.format).filter(Boolean))].join(', ') || '—';
  const clients = new Set(out.endpoints.flatMap((e) => e.clients.map((c) => c.id)));

  if (imported.length === 0) {
    process.stdout.write(chalk.gray(`  Nothing new to import — ${outFile} is unchanged.`) + '\n');
    return;
  }
  lines.push(chalk.green(`✔ ${appended ? 'Updated' : 'Wrote'} ${outFile}`));
  lines.push(`  ${plural(parsed, 'request')} from ${plural(imported.length, 'file')} (${formats})` +
    (out.window.from ? ` · ${day(out.window.from)} → ${day(out.window.to)} (${spanDays(out.window)} days)` : ''));
  lines.push(`  ${plural(out.endpoints.length, 'endpoint')} · ${plural(clients.size, 'client')}` +
    (matcher ? ` · ${fmt(run.matched)} matched the spec · ${fmt(run.unmatched)} not in the spec` : ''));
  if (run.notFound) lines.push(chalk.gray(`  ${plural(run.notFound, 'request')} to unknown paths answered 404/405 skipped (scanners)`));
  if (run.tooOld) lines.push(chalk.gray(`  ${plural(run.tooOld, 'request')} older than --since skipped`));
  if (run.overflow) lines.push(chalk.yellow(`  ${plural(run.overflow, 'request')} dropped: endpoint limit reached (use --spec to group paths)`));
  if (skipped) lines.push(chalk.gray(`  ${plural(skipped, 'line')} skipped (not a request)`));

  if (clients.size === 1 && clients.has('unknown')) {
    lines.push(chalk.yellow('  Every request has client "unknown" — the logs carry no User-Agent. Pick another signal with --client.'));
  }
  if (matcher && run.requests > 0 && run.matched / run.requests < 0.5) {
    lines.push(chalk.yellow(`  Only ${pct(run.matched / run.requests)} of requests matched the spec.` +
      (matcher.basePaths.length ? '' : ' If the API is served under a prefix, pass --base-path (e.g. --base-path /api).')));
  }
  if (!matcher) {
    lines.push(chalk.gray('  Tip: pass --spec openapi.yaml to group paths exactly as the spec defines them.'));
  }
  lines.push('');
  lines.push(`  Next: ${chalk.cyan(`specshield compare base.yaml target.yaml --usage ${outFile}`)}`);
  process.stdout.write(lines.join('\n') + '\n');
}

// ─── usage show ─────────────────────────────────────────────────────────────

usage
  .command('show')
  .description('Summarise a usage file; with --spec, list endpoints nobody calls and calls the spec does not document')
  .argument('[file]', 'Usage file', 'usage.json')
  .option('--spec <file>', 'OpenAPI spec to check against')
  .option('--top <n>', 'How many endpoints to list', '15')
  .option('--json', 'Output machine-readable JSON')
  .action(async (file, opts) => {
    try {
      const data = await loadUsage(file);
      const top = Math.max(1, parseInt(opts.top, 10) || 15);
      let unused = null;
      let undocumented = null;

      if (opts.spec) {
        const spec = parseSpec(await loadSpec(opts.spec), opts.spec);
        const matcher = createRouteMatcher(spec, { basePath: data.basePath });
        const called = new Set();
        undocumented = [];
        for (const e of data.endpoints) {
          const m = matcher.match(e.method, e.path);
          if (m && m.operation) called.add(`${m.method} ${m.template}`);
          else undocumented.push({ method: e.method, path: e.path, calls: e.calls, lastSeen: e.lastSeen, clients: e.clients.length });
        }
        unused = matcher.operations
          .filter((o) => !called.has(`${o.method} ${o.template}`))
          .map((o) => ({ method: o.method, path: o.template }));
      }

      if (opts.json) {
        process.stdout.write(JSON.stringify({
          window: data.window,
          totalCalls: data.endpoints.reduce((n, e) => n + e.calls, 0),
          endpoints: data.endpoints.slice(0, top),
          ...(unused ? { unusedOperations: unused, undocumentedEndpoints: undocumented } : {}),
        }, null, 2) + '\n');
        return exitAfterFlush(0);
      }

      process.stdout.write(renderShow(data, { top, unused, undocumented }) + '\n');
      exitAfterFlush(0);
    } catch (err) {
      logger.error(`Error: ${err.message}`);
      process.exit(2);
    }
  });

function renderShow(data, { top, unused, undocumented }) {
  const lines = [];
  const total = data.endpoints.reduce((n, e) => n + e.calls, 0);
  lines.push('');
  lines.push(chalk.bold('  SpecShield™ API Usage'));
  lines.push(chalk.gray('  ─────────────────────────────────────────'));
  lines.push(`  ${plural(total, 'call')} · ${plural(data.endpoints.length, 'endpoint')}` +
    (data.window.from ? ` · ${day(data.window.from)} → ${day(data.window.to)} (${spanDays(data.window)} days)` : '') +
    chalk.gray(`  clients by ${data.client}`));
  lines.push('');

  for (const e of data.endpoints.slice(0, top)) {
    lines.push(`  ${chalk.bold(e.method.padEnd(6))} ${e.path}  ${chalk.gray(plural(e.calls, 'call'))}`);
    const shown = e.clients.slice(0, 3);
    for (const c of shown) {
      lines.push(chalk.gray(`         ${c.id.padEnd(28)} ${pct(c.calls / e.calls).padStart(4)}  last seen ${ago(c.lastSeen)}`));
    }
    if (e.clients.length > shown.length) lines.push(chalk.gray(`         …and ${e.clients.length - shown.length} more client(s)`));
  }
  if (data.endpoints.length > top) lines.push(chalk.gray(`  …${data.endpoints.length - top} more endpoint(s) — raise --top`));

  if (unused) {
    lines.push('');
    lines.push(chalk.green.bold(`  ✔  NEVER CALLED IN THIS WINDOW (${unused.length}) — candidates for deprecation`));
    lines.push(chalk.gray('  ─────────────────────────────────────────'));
    if (unused.length === 0) lines.push(chalk.gray('  Every operation in the spec was called.'));
    for (const o of unused) lines.push(`  ${chalk.green('○')} ${o.method} ${o.path}`);
  }
  if (undocumented) {
    lines.push('');
    lines.push(chalk.yellow.bold(`  ⚠  CALLED BUT NOT IN THE SPEC (${undocumented.length})`));
    lines.push(chalk.gray('  ─────────────────────────────────────────'));
    if (undocumented.length === 0) lines.push(chalk.gray('  All traffic matches a documented operation.'));
    for (const u of undocumented.slice(0, top)) {
      lines.push(`  ${chalk.yellow('!')} ${u.method} ${u.path}  ${chalk.gray(`${plural(u.calls, 'call')} · ${plural(u.clients, 'client')}`)}`);
    }
    if (undocumented.length > top) lines.push(chalk.gray(`  …${undocumented.length - top} more`));
  }
  lines.push('');
  return lines.join('\n');
}

module.exports = usage;
