'use strict';

const { Command } = require('commander');
const chalk = require('chalk');
const fs = require('fs');
const { loadConfig } = require('../core/configLoader');
const { loadProjectConfig } = require('../core/projectConfig');
const { runGate } = require('../core/gate/runGate');
const { usageOptions } = require('../core/usage/applyUsage');
const W = require('../core/gate/waivers');
const G = require('../core/gate/git');
const { plural } = require('../core/usage/format');
const { uploadGateRun } = require('../api/bdctClient');
const { getStoredApiKey } = require('../config/localConfig');
const logger = require('../utils/logger');
const exitAfterFlush = require('../utils/exitAfterFlush');

const gate = new Command('gate')
  .description('CI gate: breaking changes in this branch vs the commit it started from, with owned, expiring waivers and a shadow mode')
  .argument('[spec]', 'The OpenAPI spec in this repository (default: gate.spec or github.specPath in .specshield.yml)')
  .option('--base <ref>', 'Branch or commit to compare against (default: detected from CI, else origin\'s default branch); the merge base with HEAD is used')
  .option('--mode <mode>', 'blocking (fail the build) or shadow (report what would have been blocked, never fail)')
  .option('--shadow', 'Same as --mode shadow')
  .option('--waivers <file>', `Waiver file (default: ${W.DEFAULT_FILE})`)
  .option('--max-waiver-days <n>', `Longest a waiver may run before it must be renewed (default: ${W.DEFAULT_MAX_DAYS})`)
  .option('--no-fetch', 'Never run git fetch, even when the baseline commit is missing from a shallow clone')
  .option('--usage <file>', 'usage.json from "specshield usage import" — breaking changes no client uses stop blocking')
  .option('--no-summary', 'Skip the GitHub Actions job summary and annotations')
  .option('--upload', 'Record this run on your SpecShield dashboard, for the shadow-mode graduation report (Team plan)')
  .option('--org <key>', 'Org key for --upload (default: gate.org or bdct.org in .specshield.yml)')
  .option('--repo <name>', 'Repository name for --upload (default: from CI, else the origin remote)')
  .option('--api-token <token>', 'API key for --upload (default: SPECSHIELD_API_KEY or "specshield login")')
  .option('--server <url>', 'SpecShield server for --upload')
  .option('--config <path>', 'Path to .specshield.yml')
  .option('--json', 'Output machine-readable JSON')
  .action(async (specArg, opts) => {
    try {
      const config = await loadConfig(opts.config);
      const g = config.gate || {};
      const spec = specArg || g.spec || (config.github && config.github.specPath);
      if (!spec) throw new Error('Which spec? Pass it as an argument (specshield gate openapi.yaml) or set gate.spec in .specshield.yml');
      const mode = opts.shadow ? 'shadow' : (opts.mode || g.mode || 'blocking');
      const maxWaiverDays = opts.maxWaiverDays !== undefined ? Number(opts.maxWaiverDays) : (g.maxWaiverDays || W.DEFAULT_MAX_DAYS);
      if (!(maxWaiverDays >= 1)) throw new Error('--max-waiver-days must be a number ≥ 1');

      const usage = usageOptions(config, { usage: opts.usage });
      const r = await runGate({
        spec, mode, base: opts.base, fetch: opts.fetch,
        waiversFile: opts.waivers || g.waivers || W.DEFAULT_FILE,
        maxWaiverDays,
        ignore: config.ignore || [],
        usage: usage.usage ? usage : null,
      });

      if (opts.upload || g.upload) r.upload = await upload(r, { ...opts, org: opts.org || g.org });

      if (opts.json) process.stdout.write(JSON.stringify(r, null, 2) + '\n');
      else process.stdout.write(render(r) + '\n');

      if (opts.summary !== false && process.env.GITHUB_ACTIONS === 'true') {
        annotate(r);
        if (process.env.GITHUB_STEP_SUMMARY) {
          try { fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown(r) + '\n'); } catch { /* summary is best-effort */ }
        }
      }
      exitAfterFlush(r.verdict === 'block' ? 1 : 0);
    } catch (err) {
      logger.error(`Error: ${err.message}`);
      process.exit(2);
    }
  });

// ─── upload ─────────────────────────────────────────────────────────────────

/** Never fails the gate: a dashboard outage must not block merges. */
async function upload(r, opts) {
  try {
    const project = loadProjectConfig();
    const bdct = project.bdct || {};
    const orgKey = opts.org || (bdct.org && bdct.org !== '<replace-me>' ? bdct.org : null);
    if (!orgKey) throw new Error('needs an org key: pass --org <key> or set gate.org in .specshield.yml');
    const repo = opts.repo || r.ci.repo || repoFromRemote();
    if (!repo) throw new Error('could not tell the repository name: pass --repo owner/name');
    const token = opts.apiToken || process.env.SPECSHIELD_API_KEY || (await getStoredApiKey());
    if (!token) throw new Error('no API key: set SPECSHIELD_API_KEY or pass --api-token');
    const res = await uploadGateRun(opts.server || bdct.server, token, payload(r, orgKey, repo));
    return { ok: true, id: res && res.id, url: res && res.url, readiness: (res && res.readiness) || null };
  } catch (err) {
    const reason = err.status === 402 ? 'the graduation report needs a paid plan (Team or above)' : err.message.replace(/^API error/, 'server said');
    logger.warn(`Gate result not uploaded: ${reason}`);
    return { ok: false, error: reason };
  }
}

function payload(r, orgKey, repo) {
  const item = (c) => ({ key: c.key, change: c.change, operations: c.operations, field: c.field || null, description: c.description || null });
  return {
    orgKey,
    repo,
    pr: r.ci.pr,
    prTitle: r.ci.title,
    provider: r.ci.provider,
    event: r.ci.event,
    headSha: r.head.sha,
    baseSha: r.baseline.sha,
    spec: r.spec,
    mode: r.mode,
    verdict: r.verdict,
    specTouched: r.specTouched,
    specStatus: r.specStatus,
    blocking: r.blocking.map((c) => ({ ...item(c), expiredWaiver: c.expiredWaiver ? { owner: c.expiredWaiver.owner, expires: c.expiredWaiver.expires } : null })),
    waived: r.waived.map((c) => ({ ...item(c), owner: c.waiver.owner, reason: c.waiver.reason, expires: c.waiver.expires })),
    unused: r.unused.length,
    waivers: {
      total: r.waivers.total,
      active: (r.waivers.counts.active || 0),
      expiring: r.waivers.expiring.length,
      expired: r.waivers.expired.length,
      invalid: r.waivers.invalid.length,
    },
  };
}

function repoFromRemote() {
  const url = G.git(['remote', 'get-url', 'origin'], { allowFail: true });
  const m = url && /[:/]([^/:]+\/[^/]+?)(\.git)?$/.exec(url);
  return m ? m[1] : null;
}

// ─── human output ───────────────────────────────────────────────────────────

function waiveCommand(c, file) {
  const s = W.suggestFor(c);
  const q = (v) => `"${v.replace(/"/g, '\\"')}"`;
  return ['specshield waivers add', s.change,
    s.operation ? `--operation ${q(s.operation)}` : null,
    s.field ? `--field ${q(s.field)}` : null,
    '--owner <you> --reason "<why this is safe>" --days 30',
    file !== W.DEFAULT_FILE ? `--file ${q(file)}` : null].filter(Boolean).join(' ');
}

function label(c) {
  const ops = c.operations && c.operations.length ? c.operations : [];
  const what = c.description || c.change;
  // Merged changes already name their endpoints in the description.
  if (ops.length === 0 || ops.every((o) => what.includes(o))) return { where: '', what };
  const where = ops.length <= 2 ? ops.join(', ') : `${ops.slice(0, 2).join(', ')} and ${ops.length - 2} more`;
  return { where, what };
}

function render(r) {
  const lines = [''];
  lines.push(chalk.bold(`  SpecShield™ Gate — ${r.spec}`));
  lines.push(chalk.gray('  ─────────────────────────────────────────'));
  lines.push(`  ${chalk.gray('Baseline')}  ${r.baseline.sha.slice(0, 12)} ${chalk.gray(`— where this branch started from ${r.baseline.from}`)}`);
  if (r.baseline.fetched.length) lines.push(chalk.gray(`            fetched ${r.baseline.fetched.join(', ')} to find it`));
  lines.push(`  ${chalk.gray('Mode')}      ${r.mode === 'shadow' ? `${chalk.yellow('shadow')} ${chalk.gray('— reports what it would block; never fails the build')}` : 'blocking'}`);
  lines.push('');

  if (r.specStatus === 'unchanged') {
    lines.push(chalk.green('  ✔ This change doesn\'t touch the spec — nothing to check.'));
  } else if (r.specStatus === 'added') {
    lines.push(chalk.green('  ✔ The spec is new in this change — nothing to compare it with.'));
  } else if (r.blocking.length === 0) {
    const notes = [];
    if (r.waived.length) notes.push(`${plural(r.waived.length, 'waived change')}`);
    if (r.unused.length) notes.push(`${r.unused.length} unused by any client`);
    lines.push(chalk.green(`  ✔ No breaking changes block this change`) + (notes.length ? chalk.gray(` (${notes.join(', ')})`) : '') +
      (r.nonBreaking ? chalk.gray(` · ${plural(r.nonBreaking, 'non-breaking change')}`) : ''));
  } else {
    const head = r.verdict === 'would-block'
      ? chalk.yellow.bold(`  ▲ Shadow mode: would have blocked this change — ${plural(r.blocking.length, 'breaking change')}`)
      : chalk.red.bold(`  ✖ ${plural(r.blocking.length, 'breaking change')} block${r.blocking.length === 1 ? 's' : ''} this change`);
    lines.push(head);
    for (const c of r.blocking) {
      const { where, what } = label(c);
      lines.push('');
      lines.push(`  ${chalk.red('●')} ${what}`);
      if (where) lines.push(chalk.gray(`      ${where}`));
      if (c.expiredWaiver) {
        lines.push(chalk.yellow(`      waiver expired ${c.expiredWaiver.expires} (owner ${c.expiredWaiver.owner}) — renew it or fix the change`));
      }
      lines.push(chalk.gray(`      intended? ${waiveCommand(c, r.waivers.file)}`));
    }
  }

  if (r.waived.length) {
    lines.push('');
    lines.push(chalk.bold(`  Waived (${r.waived.length})`));
    for (const c of r.waived) {
      const { where, what } = label(c);
      lines.push(`  ${chalk.green('✔')} ${what}${where ? chalk.gray(` · ${where}`) : ''}`);
      const w = c.waiver;
      lines.push(chalk.gray(`      ${w.owner}, until ${w.expires}${w.ticket ? ` (${w.ticket})` : ''}: ${w.reason}`) +
        (w.status === 'expiring' ? chalk.yellow('  expires soon') : ''));
    }
  }
  if (r.unused.length) {
    lines.push('');
    lines.push(chalk.gray(`  ${plural(r.unused.length, 'breaking change')} not blocking: no client called ${r.unused.length === 1 ? 'it' : 'them'} in the usage data.`));
  }
  if (r.ignored.length) {
    lines.push('');
    lines.push(chalk.yellow(`  ${plural(r.ignored.length, 'breaking change')} skipped by the "ignore:" list in .specshield.yml, which has no owner or expiry.`));
    lines.push(chalk.gray(`  Move ${r.ignored.length === 1 ? 'it' : 'them'} to ${r.waivers.file}: ${waiveCommand(r.ignored[0], r.waivers.file)}`));
  }

  const wl = waiverLines(r);
  if (wl.length) { lines.push(''); lines.push(...wl.map((l) => `  ${l}`)); }

  if (r.upload) {
    lines.push('');
    lines.push(r.upload.ok ? chalk.green('  ✔ Recorded on your dashboard') + (r.upload.url ? chalk.gray(`  ${r.upload.url}`) : '') : chalk.yellow(`  Not recorded on the dashboard: ${r.upload.error}`));
    if (r.upload.readiness && r.upload.readiness.headline) lines.push(chalk.gray(`    Readiness: ${r.upload.readiness.headline}`));
  }
  lines.push('');
  return lines.join('\n');
}

function waiverLines(r) {
  const w = r.waivers;
  const out = [];
  for (const x of w.invalid) out.push(chalk.red(`✖ ${w.file} waiver #${x.index + 1} (${x.change || '?'}) doesn't apply: ${x.errors.join('; ')}`));
  for (const x of w.unmatchedAdded) out.push(chalk.yellow(`▲ The waiver you added for ${describeWaiver(x)} matches no breaking change here — check change, operation and field.`));
  if (w.expired.length) out.push(chalk.yellow(`▲ ${plural(w.expired.length, 'expired waiver')} in ${w.file} — delete ${w.expired.length === 1 ? 'it' : 'them'} or renew with a new expiry: ${w.expired.map(describeWaiver).join('; ')}`));
  if (w.expiring.length) out.push(chalk.gray(`${plural(w.expiring.length, 'waiver')} expire${w.expiring.length === 1 ? 's' : ''} within ${W.EXPIRING_DAYS} days: ${w.expiring.map((x) => `${describeWaiver(x)} (${x.owner}, ${x.expires})`).join('; ')}`));
  return out;
}

function describeWaiver(w) {
  return [w.change, w.operation, w.field].filter(Boolean).join(' ');
}

// ─── GitHub Actions ─────────────────────────────────────────────────────────

function esc(s) {
  return String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}
function escProp(s) {
  return esc(s).replace(/:/g, '%3A').replace(/,/g, '%2C');
}

function annotate(r) {
  const level = r.verdict === 'would-block' ? 'warning' : 'error';
  const file = `file=${escProp(r.spec)}`;
  for (const c of r.blocking) {
    const { where, what } = label(c);
    const title = r.verdict === 'would-block' ? 'Breaking API change (shadow mode)' : 'Breaking API change';
    const extra = c.expiredWaiver ? ` — waiver expired ${c.expiredWaiver.expires}` : '';
    process.stdout.write(`::${level} ${file},title=${escProp(title)}::${esc(`${what}${where ? ` (${where})` : ''}${extra}`)}\n`);
  }
  for (const x of r.waivers.expired) {
    process.stdout.write(`::warning file=${escProp(r.waivers.file)},title=Expired waiver::${esc(`${describeWaiver(x)} expired ${x.expires} (owner ${x.owner})`)}\n`);
  }
  for (const x of r.waivers.invalid) {
    process.stdout.write(`::error file=${escProp(r.waivers.file)},title=Invalid waiver::${esc(`#${x.index + 1}: ${x.errors.join('; ')}`)}\n`);
  }
}

function markdown(r) {
  const md = [];
  const icon = r.verdict === 'pass' ? '✅' : r.verdict === 'would-block' ? '🟡' : '❌';
  md.push(`### ${icon} SpecShield gate — \`${r.spec}\``);
  md.push('');
  md.push(`Compared with \`${r.baseline.sha.slice(0, 12)}\`, where this branch started from ${r.baseline.from}. Mode: **${r.mode}**.`);
  md.push('');
  if (r.specStatus === 'unchanged') md.push('This change doesn\'t touch the spec.');
  else if (r.specStatus === 'added') md.push('The spec is new in this change.');
  else if (r.blocking.length === 0) md.push(`No breaking changes block this change${r.waived.length ? ` (${r.waived.length} waived)` : ''}.`);
  else {
    md.push(r.verdict === 'would-block'
      ? `**Shadow mode:** would have blocked this change — ${plural(r.blocking.length, 'breaking change')}.`
      : `**${plural(r.blocking.length, 'breaking change')}** block this change.`);
    md.push('');
    md.push('| Change | Where | |');
    md.push('|---|---|---|');
    for (const c of r.blocking) {
      const { where, what } = label(c);
      md.push(`| ${cell(what)} | ${cell(where || '—')} | ${c.expiredWaiver ? `waiver expired ${c.expiredWaiver.expires}` : ''} |`);
    }
    md.push('');
    md.push(`Intended? Add a waiver with an owner, a reason and an expiry: \`${waiveCommand(r.blocking[0], r.waivers.file)}\``);
  }
  if (r.waived.length) {
    md.push('');
    md.push('<details><summary>Waived</summary>');
    md.push('');
    for (const c of r.waived) md.push(`- ${cell(label(c).what)} — ${cell(c.waiver.owner)}, until ${c.waiver.expires}: ${cell(c.waiver.reason)}`);
    md.push('');
    md.push('</details>');
  }
  const w = r.waivers;
  if (w.expired.length || w.invalid.length || w.expiring.length) {
    md.push('');
    if (w.invalid.length) md.push(`- ${plural(w.invalid.length, 'invalid waiver')} in \`${w.file}\` (not applied)`);
    if (w.expired.length) md.push(`- ${plural(w.expired.length, 'expired waiver')} in \`${w.file}\` — delete or renew`);
    if (w.expiring.length) md.push(`- ${plural(w.expiring.length, 'waiver')} expiring within ${W.EXPIRING_DAYS} days`);
  }
  return md.join('\n');
}

function cell(s) {
  return String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

module.exports = gate;
module.exports._internal = { render, markdown, payload, waiveCommand };
