'use strict';

const { Command } = require('commander');
const chalk = require('chalk');
const fs = require('fs');
const { loadSpec } = require('../core/loadSpec');
const { parseSpec } = require('../core/parseSpec');
const { loadTraffic } = require('../core/replay/traffic');
const { runReplay, summarize } = require('../core/replay/runReplay');
const H = require('../core/prove/http');
const { plural } = require('../core/usage/format');
const logger = require('../utils/logger');
const exitAfterFlush = require('../utils/exitAfterFlush');

const replay = new Command('replay')
  .description('Replay a sample of real captured requests (HAR or access logs) against a build of the new API, and report every request that worked before and fails now')
  .requiredOption('--against <url>', 'The new build, e.g. http://localhost:8080')
  .requiredOption('--from <file...>', 'Captured traffic: .har files and/or access logs (nginx/Apache, ALB, JSON lines; .gz ok)')
  .option('--baseline <url>', 'The old build: send each request there too and compare side by side (recommended)')
  .option('--spec <file>', 'The new spec: groups traffic by operation, spots removed routes, and checks responses against it')
  .option('--old-spec <file>', 'The old spec: every response must still satisfy it — catches shape breaks even from access logs, which record no bodies')
  .option('--base-path <path>', 'Path prefix in the captured URLs that the spec\'s paths leave out, e.g. /v1')
  .option('--host <host...>', 'Only replay requests captured for these hosts')
  .option('--sample <n>', 'At most this many requests in total', '200')
  .option('--per-operation <n>', 'At most this many requests per operation', '5')
  .option('--seed <n>', 'Sampling seed — the same seed replays the same requests', '1')
  .option('--include-mutating', 'Also replay POST/PUT/PATCH/DELETE (they change data on the build)')
  .option('--allow-remote', 'Allow --against/--baseline hosts that are not local or private')
  .option('--header <header...>', 'Header added to every request, e.g. "Authorization: Bearer $TOKEN" (captured credentials are never replayed)')
  .option('--concurrency <n>', 'Requests in flight', '4')
  .option('--timeout <ms>', 'Per-request timeout', '10000')
  .option('--format <format>', 'Access log format: auto, combined, alb, json', 'auto')
  .option('--show-values', 'Print query values in the report (hidden by default; they can be personal data)')
  .option('--no-summary', 'Skip the GitHub Actions job summary')
  .option('--json', 'Output machine-readable JSON')
  .action(async (opts) => {
    try {
      const against = H.targetUrl(opts.against, { allowRemote: opts.allowRemote });
      const baseline = opts.baseline ? H.targetUrl(opts.baseline, { allowRemote: opts.allowRemote, flag: '--baseline' }) : null;
      const spec = opts.spec ? parseSpec(await loadSpec(opts.spec), opts.spec) : null;
      const oldSpec = opts.oldSpec ? parseSpec(await loadSpec(opts.oldSpec), opts.oldSpec) : null;
      for (const f of opts.from) if (f !== '-' && !fs.existsSync(f)) throw new Error(`Traffic file not found: ${f}`);

      const traffic = await loadTraffic(opts.from, {
        format: opts.format,
        spec: spec || oldSpec,
        basePath: opts.basePath,
        perOperation: positive(opts.perOperation, '--per-operation'),
        limit: positive(opts.sample, '--sample'),
        seed: Number(opts.seed) || 1,
        includeMutating: opts.includeMutating,
        hosts: opts.host ? new Set(opts.host.map((h) => h.toLowerCase())) : null,
      });
      if (traffic.records.length === 0) throw new Error(emptyReason(traffic.stats, opts));

      const results = await runReplay(traffic.records, {
        against, baseline,
        headers: H.parseHeaders(opts.header),
        timeoutMs: Number(opts.timeout) || 10000,
        concurrency: positive(opts.concurrency, '--concurrency'),
        spec,
        oldSpec,
        basePath: opts.basePath,
      });
      if (results.every((r) => r.verdict === 'error')) throw new Error(`Can't reach the build: ${results[0].detail}`);

      const s = summarize(results);
      const bodies = Boolean(baseline) || traffic.records.some((r) => r.recorded.json !== undefined);
      const report = { against, baseline, reference: baseline ? 'baseline' : 'recorded', bodies, oldSpec: Boolean(oldSpec), traffic: traffic.stats, totals: s.totals, operations: s.operations };
      if (opts.json) process.stdout.write(JSON.stringify(toJson(report, opts), null, 2) + '\n');
      else process.stdout.write(render(report, opts) + '\n');

      if (opts.summary !== false && process.env.GITHUB_ACTIONS === 'true' && process.env.GITHUB_STEP_SUMMARY) {
        try { fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown(report, opts) + '\n'); } catch { /* best-effort */ }
      }
      exitAfterFlush(s.totals.broken + s.totals.changed > 0 ? 1 : 0);
    } catch (err) {
      logger.error(`Error: ${err.message}`);
      process.exit(2);
    }
  });

function positive(v, flag) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw new Error(`${flag} must be a whole number ≥ 1`);
  return n;
}

function emptyReason(st, opts) {
  if (st.read === 0) return 'No requests found in the traffic files';
  if (st.bodilessWrites === st.read) return `All ${st.read} logged requests change data, and access logs don't record request bodies — record a HAR to replay writes`;
  if (st.mutatingSkipped + st.bodilessWrites === st.read) return `All ${st.read} captured requests change data (POST/PUT/PATCH/DELETE); pass --include-mutating to replay them`;
  if (st.otherHosts) return `No requests for ${opts.host.join(', ')} (${st.otherHosts} for other hosts)`;
  return 'Nothing to replay after filtering';
}

/** "/orders?status=open&limit=5" → "/orders?status=…&limit=…" unless --show-values. */
function target(rec, showValues) {
  if (!rec.query) return rec.path;
  if (showValues) return `${rec.path}?${rec.query}`;
  return `${rec.path}?${rec.query.split('&').map((p) => `${p.split('=')[0]}=…`).join('&')}`;
}

function toJson(r, opts) {
  const req = (x) => ({
    method: x.rec.method, target: target(x.rec, opts.showValues), operation: x.rec.operation,
    reference: x.ref, build: x.cand, verdict: x.verdict, detail: x.detail,
    ...(x.diff ? { missing: x.diff.missing.map(field), changed: x.diff.changed.map((c) => ({ ...c, path: field(c.path) })) } : {}),
    ...(x.specDrift ? { specDrift: x.specDrift } : {}),
    ...(x.oldContract ? { oldContract: x.oldContract } : {}),
    ...(x.excerpt && opts.showValues ? { response: x.excerpt } : {}),
  });
  return {
    against: r.against,
    baseline: r.baseline,
    reference: r.reference,
    comparedBodies: r.bodies,
    checkedAgainstOldSpec: r.oldSpec,
    traffic: r.traffic,
    totals: r.totals,
    operations: r.operations.map(({ examples, drift, ...o }) => ({ ...o, examples: examples.map(req), specDrift: drift.map(req) })),
  };
}

/** ".items[].id" → "items[].id" */
function field(p) {
  return p.replace(/^\./, '') || '(root)';
}

const MARK = {
  broken: chalk.red('✖'), changed: chalk.red('▲'), error: chalk.red('!'), inconclusive: chalk.yellow('?'), improved: chalk.cyan('↑'), ok: chalk.green('✔'),
};

function render(r, opts) {
  const t = r.totals;
  const lines = [''];
  lines.push(chalk.bold(`  SpecShield™ Replay — ${r.against}`));
  lines.push(chalk.gray('  ─────────────────────────────────────────'));
  const sources = r.traffic.files.map((f) => `${f.file} (${f.kind}, ${f.requests})`).join(', ');
  lines.push(`  ${chalk.gray('Traffic')}    ${plural(r.traffic.sampled, 'request')} sampled from ${plural(r.traffic.considered, 'captured request')} across ${plural(r.traffic.operations, 'operation')}`);
  lines.push(chalk.gray(`             ${sources}`));
  if (r.traffic.mutatingSkipped) lines.push(chalk.gray(`             ${plural(r.traffic.mutatingSkipped, 'write')} not replayed (--include-mutating to replay them)`));
  if (r.traffic.bodilessWrites) lines.push(chalk.gray(`             ${plural(r.traffic.bodilessWrites, 'write')} from access logs not replayed: logs don't record request bodies`));
  lines.push(`  ${chalk.gray('Compared')}   ${r.baseline ? `with the old build at ${r.baseline}, side by side` : 'with the recorded responses — use --baseline <old build> to rule out data differences'}`);
  if (r.oldSpec) lines.push(chalk.gray('             and every response checked against the old spec'));
  else if (!r.bodies) lines.push(chalk.yellow('             status codes only: access logs record no bodies — add --old-spec (or --baseline) to compare responses'));
  lines.push('');

  const bad = t.broken + t.changed;
  if (bad === 0) lines.push(chalk.green(`  ✔ No request that worked before fails now (${plural(results(t), 'request')}${!r.bodies && !r.oldSpec ? ', by status code' : ''})`));
  else lines.push(chalk.red.bold(`  ✖ ${plural(bad, 'request')} that worked before ${bad === 1 ? 'breaks' : 'break'} on the new build`));
  const counts = Object.entries(t).filter(([, n]) => n > 0).map(([k, n]) => `${MARK[k]} ${n} ${k}`);
  lines.push(`  ${counts.join('   ')}`);

  for (const o of r.operations) {
    if (o.broken + o.changed + o.error + o.inconclusive === 0 && !o.drift.length) continue;
    lines.push('');
    const head = [o.broken && chalk.red(`${o.broken} broken`), o.changed && chalk.red(`${o.changed} changed`), o.inconclusive && chalk.yellow(`${o.inconclusive} inconclusive`), o.error && chalk.red(`${o.error} error`)].filter(Boolean).join(', ');
    lines.push(`  ${chalk.bold(o.operation)}  ${chalk.gray(`${o.total} replayed`)}${head ? ` · ${head}` : ''}`);
    for (const x of o.examples) {
      lines.push(`    ${MARK[x.verdict]} ${x.rec.method} ${target(x.rec, opts.showValues)}`);
      lines.push(chalk.gray(`        ${x.detail}`));
      if (x.excerpt && opts.showValues) lines.push(chalk.gray(`        response: ${x.excerpt}`));
    }
    for (const x of o.drift) lines.push(chalk.yellow(`    ⚠ the build's response doesn't match the new spec: ${x.specDrift.join('; ')}`));
  }
  if (!opts.showValues && r.operations.some((o) => o.examples.some((x) => x.rec.query))) {
    lines.push('');
    lines.push(chalk.gray('  Query values are hidden (they can be personal data); --show-values prints them.'));
  }
  lines.push('');
  return lines.join('\n');
}

function results(t) {
  return Object.values(t).reduce((a, b) => a + b, 0);
}

function markdown(r, opts) {
  const t = r.totals;
  const bad = t.broken + t.changed;
  const out = ['### SpecShield replay', ''];
  out.push(bad ? `❌ **${plural(bad, 'request')} that worked before ${bad === 1 ? 'breaks' : 'break'} on the new build**` : `✅ No request that worked before fails now (${plural(results(t), 'request')} replayed)`);
  out.push('', `Compared with ${r.baseline ? 'the old build, side by side' : 'the recorded responses'} · ${Object.entries(t).filter(([, n]) => n).map(([k, n]) => `${n} ${k}`).join(' · ')}`);
  const rows = r.operations.filter((o) => o.examples.length);
  if (rows.length) {
    out.push('', '| Operation | Request | Result |', '|---|---|---|');
    for (const o of rows) {
      for (const x of o.examples) out.push(`| \`${o.operation}\` | \`${x.rec.method} ${target(x.rec, opts.showValues).replace(/\|/g, '\\|')}\` | ${x.verdict}: ${x.detail.replace(/\|/g, '\\|')} |`);
    }
  }
  return out.join('\n');
}

module.exports = replay;
