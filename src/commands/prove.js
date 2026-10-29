'use strict';

const { Command } = require('commander');
const chalk = require('chalk');
const { loadSpec } = require('../core/loadSpec');
const { parseSpec } = require('../core/parseSpec');
const { prove } = require('../core/prove');
const { confirmAll } = require('../core/prove/execute');
const R = require('../core/prove/render');
const H = require('../core/prove/http');
const { plural } = require('../core/usage/format');
const logger = require('../utils/logger');
const exitAfterFlush = require('../utils/exitAfterFlush');

const prove_ = new Command('prove')
  .description('Proof, not opinion: for every breaking change, the exact request that worked before and fails now — checked against both specs, and optionally against a running build')
  .argument('<base>', 'The spec your clients use today')
  .argument('<target>', 'The new spec')
  .option('--against <url>', 'Send each witness to a running build of the new API and report what it does')
  .option('--header <header...>', 'Header for --against requests, e.g. "Authorization: Bearer $TOKEN" (repeatable)')
  .option('--include-mutating', 'With --against, also send POST/PUT/PATCH/DELETE witnesses (they may change data)')
  .option('--allow-remote', 'Allow --against to target a host that is not local or private')
  .option('--timeout <ms>', 'Per-request timeout for --against', '10000')
  .option('--base-url <url>', 'Base URL to print in the curl commands (default: $BASE_URL, or --against)')
  .option('--warnings', 'Also prove constraint warnings (tightened min/max/length/pattern), which never fail the build')
  .option('--json', 'Output machine-readable JSON')
  .action(async (basePath, targetPath, opts) => {
    try {
      const baseDoc = parseSpec(await loadSpec(basePath), basePath);
      const targetDoc = parseSpec(await loadSpec(targetPath), targetPath);
      const r = prove(baseDoc, targetDoc);
      const shown = opts.warnings ? [...r.breaking, ...r.warnings] : r.breaking;

      let against = null;
      if (opts.against) {
        against = H.targetUrl(opts.against, { allowRemote: opts.allowRemote });
        const items = shown.filter((c) => c.proof).map((c) => ({ diff: c.proof.diff, witness: c.proof }));
        await confirmAll(items, {
          baseDoc, targetDoc, against,
          headers: H.parseHeaders(opts.header),
          includeMutating: opts.includeMutating,
          timeoutMs: Number(opts.timeout) || 10000,
        });
        const sent = items.filter((i) => i.witness.run.outcome !== 'skipped');
        if (sent.length && sent.every((i) => i.witness.run.outcome === 'error')) {
          throw new Error(`Can't reach ${against}: ${sent[0].witness.run.detail}`);
        }
      }

      if (opts.json) {
        process.stdout.write(JSON.stringify(toJson(r, { baseDoc, targetDoc, against, warnings: opts.warnings }), null, 2) + '\n');
      } else {
        process.stdout.write(render(r, { baseDoc, targetDoc, against, base: opts.baseUrl || against, warnings: opts.warnings }) + '\n');
      }
      exitAfterFlush(r.breaking.length > 0 ? 1 : 0);
    } catch (err) {
      logger.error(`Error: ${err.message}`);
      process.exit(2);
    }
  });

function title(doc) {
  const t = (doc.info && doc.info.title) || 'API';
  return { title: t, version: doc.info && doc.info.version ? String(doc.info.version) : null };
}

function toJson(r, { baseDoc, targetDoc, against, warnings }) {
  const item = (c) => {
    const { proof, ...change } = c;
    return { ...change, proof: proof ? strip(proof) : null };
  };
  return {
    base: title(baseDoc),
    target: title(targetDoc),
    against,
    summary: { ...r.summary, ...(against ? { onTheBuild: runCounts(r.breaking) } : {}) },
    breakingChanges: r.breaking.map(item),
    warnings: warnings ? r.warnings.map(item) : r.warnings.map(({ proof, ...c }) => c),
    nonBreaking: r.nonBreaking,
  };
}

function strip(p) {
  const { diff, ...rest } = p;
  return { ...rest, at: diff };
}

function runCounts(changes) {
  const out = {};
  for (const c of changes) if (c.proof && c.proof.run) out[c.proof.run.outcome] = (out[c.proof.run.outcome] || 0) + 1;
  return out;
}

function render(r, { baseDoc, targetDoc, against, base, warnings }) {
  const b = title(baseDoc);
  const t = title(targetDoc);
  const lines = [''];
  lines.push(chalk.bold(`  SpecShield™ Prove — ${t.title}${b.version ? ` ${b.version}` : ''} →${t.version ? ` ${t.version}` : ''}`));
  lines.push(chalk.gray('  ─────────────────────────────────────────'));
  if (r.breaking.length === 0) {
    lines.push(chalk.green('  ✔ No breaking changes — nothing to prove.'));
  } else {
    const s = r.summary;
    const parts = [`${chalk.green(`${s.proven} proven`)} with a failing request`];
    if (s.example) parts.push(chalk.yellow(`${s.example} shown by example`));
    if (s.compatible) parts.push(chalk.cyan(`${s.compatible} compatible on their own`));
    if (s.unproven) parts.push(chalk.gray(`${s.unproven} without proof`));
    lines.push(`  ${plural(s.total, 'breaking change')} · ${parts.join(' · ')}`);
    lines.push(chalk.gray('  Every proof is checked against both specs: the old one accepts it, the new one rejects it.'));
    if (against) {
      const counts = runCounts(r.breaking);
      lines.push(`  On ${against}: ` + Object.entries(counts).map(([k, n]) => `${n} ${k}`).join(' · '));
    }
    for (const c of r.breaking) block(lines, c, base);
  }
  const provable = r.warnings.filter((c) => c.proof && c.proof.status === 'proven');
  if (warnings && r.warnings.length) {
    lines.push('');
    lines.push(chalk.yellow.bold(`  Warnings (${r.warnings.length}) — reported, never fail the build`));
    for (const c of r.warnings) block(lines, c, base);
  } else if (provable.length) {
    lines.push('');
    lines.push(chalk.gray(`  ${plural(provable.length, 'constraint warning')} also ${provable.length === 1 ? 'has' : 'have'} a failing request — see them with --warnings.`));
  }
  if (!base && r.breaking.some((c) => c.proof && c.proof.request)) {
    lines.push('');
    lines.push(chalk.gray('  Set BASE_URL to run the curl commands, e.g. export BASE_URL=http://localhost:8080'));
  }
  lines.push('');
  return lines.join('\n');
}

/** A merged change's description lists every endpoint (with repeats); name a few, count them all. */
function headline(c) {
  const eps = [...new Set(c.affectedEndpoints || [])];
  if (eps.length < 2) return c.description;
  const head = c.description.replace(/ \(affects \d+ endpoints?:.*\)$/, '');
  return `${head} — ${eps.length} endpoints: ${eps.slice(0, 3).join(', ')}${eps.length > 3 ? ` and ${eps.length - 3} more` : ''}`;
}

function block(lines, c, base) {
  lines.push('');
  lines.push(`  ${R.badge(c.proof)}  ${headline(c)}`);
  // A merged change already names its endpoints in the description.
  if (c.method && !(c.affectedEndpoints && c.affectedEndpoints.length > 1)) lines.push(chalk.gray(`      ${c.method.toUpperCase()} ${c.path}`));
  lines.push(...R.lines(c.proof, { base }));
}

module.exports = prove_;
