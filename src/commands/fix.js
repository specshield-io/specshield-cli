'use strict';

const { Command } = require('commander');
const chalk = require('chalk');
const path = require('path');
const fsExtra = require('fs-extra');
const { loadSpec } = require('../core/loadSpec');
const { parseSpec } = require('../core/parseSpec');
const { fixSpec } = require('../core/fix/fixSpec');
const { applyOpsToText } = require('../core/fix/ops');
const { buildShim } = require('../core/fix/shim/transforms');
const { generateSpring } = require('../core/fix/shim/spring');
const { plural } = require('../core/usage/format');
const logger = require('../utils/logger');
const exitAfterFlush = require('../utils/exitAfterFlush');

const fix = new Command('fix')
  .description('Turn breaking changes into non-breaking ones: expand-and-contract edits to the new spec, each verified by the diff engine')
  .argument('<base>', 'The spec your clients use today')
  .argument('<target>', 'The new spec with breaking changes')
  .option('--out <file>', 'Where to write the fixed spec (default: <target>.fixed.<ext>)')
  .option('--write', 'Edit <target> in place instead of writing a new file')
  .option('--dry-run', 'Only report; write nothing')
  .option('--sunset <date>', 'Add x-sunset: <date> to everything restored as deprecated (YYYY-MM-DD)')
  .option('--spring <dir>', 'Also generate a Spring Boot version layer (Java) into this directory')
  .option('--package <name>', 'Java package for --spring', 'com.example.api.compat')
  .option('--version-header <name>', 'Request header that carries the client\'s API version (--spring)', 'X-API-Version')
  .option('--json', 'Output machine-readable JSON')
  .action(async (basePath, targetPath, opts) => {
    try {
      if (opts.sunset && !/^\d{4}-\d{2}-\d{2}$/.test(opts.sunset)) throw new Error('--sunset must be a date like 2027-03-31');
      if (opts.write && opts.out) throw new Error('Use either --write or --out, not both');
      const targetText = await loadSpec(targetPath);
      const baseDoc = parseSpec(await loadSpec(basePath), basePath);
      const targetDoc = parseSpec(targetText, targetPath);

      const result = fixSpec(baseDoc, targetDoc, { sunset: opts.sunset || null });
      const verified = result.suggestions.filter((s) => s.status === 'verified');

      let outFile = null;
      if (!opts.dryRun && result.ops.length > 0) {
        outFile = opts.write ? targetPath : (opts.out || defaultOut(targetPath));
        const json = path.extname(targetPath).toLowerCase() === '.json' || /^\s*\{/.test(targetText);
        await fsExtra.outputFile(outFile, applyOpsToText(targetText, result.ops, { json }));
      }

      let shim = null;
      if (opts.spring) {
        shim = buildShim(result, baseDoc, targetDoc);
        if (!opts.dryRun && shim.transforms.length > 0) {
          shim.files = await generateSpring(shim, {
            dir: opts.spring, pkg: opts.package, header: opts.versionHeader,
            version: String((targetDoc.info && targetDoc.info.version) || 'next'),
            basePath: serverBasePath(targetDoc),
          });
        }
      }

      if (opts.json) {
        process.stdout.write(JSON.stringify({
          before: result.before,
          after: result.after,
          output: outFile,
          suggestions: result.suggestions.map(({ ops, ...s }) => ({ ...s, edits: ops.length })),
          remaining: result.remaining,
          ...(shim ? { spring: { transforms: shim.transforms, skipped: shim.skipped, files: shim.files || [] } } : {}),
        }, null, 2) + '\n');
      } else {
        process.stdout.write(render(result, { baseDoc, targetDoc, outFile, verified, shim, dryRun: opts.dryRun, targetPath }) + '\n');
      }
      exitAfterFlush(result.after > 0 ? 1 : 0);
    } catch (err) {
      logger.error(`Error: ${err.message}`);
      process.exit(2);
    }
  });

function defaultOut(target) {
  const ext = path.extname(target);
  return path.join(path.dirname(target), `${path.basename(target, ext)}.fixed${ext || '.yaml'}`);
}

function serverBasePath(doc) {
  if (typeof doc.basePath === 'string') return doc.basePath.replace(/\/$/, '');
  const url = doc.servers && doc.servers[0] && doc.servers[0].url;
  if (!url) return '';
  const p = url.replace(/^[a-z]+:\/\/[^/]+/i, '').replace(/\{[^}]+\}/g, '').replace(/\/$/, '');
  return p.startsWith('/') ? p : '';
}

function render(r, { baseDoc, targetDoc, outFile, verified, shim, dryRun, targetPath }) {
  const lines = [''];
  const v = (d) => (d.info && d.info.version ? ` ${d.info.version}` : '');
  lines.push(chalk.bold(`  SpecShield™ Fix — ${(targetDoc.info && targetDoc.info.title) || 'API'}${v(baseDoc)} →${v(targetDoc)}`));
  lines.push(chalk.gray('  ─────────────────────────────────────────'));
  if (r.before === 0) {
    lines.push(chalk.green('  ✔ No breaking changes — nothing to fix.'));
    lines.push('');
    return lines.join('\n');
  }
  const fixedCount = r.before - r.after;
  lines.push(`  ${plural(r.before, 'breaking change')} · ${chalk.green(`${fixedCount} fixed`)}` +
    (r.after ? ` · ${chalk.red(`${r.after} need${r.after === 1 ? 's' : ''} a decision`)}` : ''));
  lines.push(chalk.gray('  Each fix was re-checked with the diff engine: it removes its breaking change and adds none.'));

  if (verified.length) {
    lines.push('');
    lines.push(chalk.green.bold(`  ✔  FIXES (${verified.length})`));
    lines.push(chalk.gray('  ─────────────────────────────────────────'));
    for (const s of verified) {
      lines.push(`  ${chalk.green('✔')} ${s.title}`);
      lines.push(chalk.gray(`      ${where(s.changes)}`));
      lines.push(`      ${chalk.cyan('→')} ${s.detail}`);
    }
  }

  const open = r.suggestions.filter((s) => s.status === 'manual' || s.status === 'rejected');
  if (open.length) {
    lines.push('');
    lines.push(chalk.red.bold(`  ✖  NEEDS A DECISION (${open.length})`));
    lines.push(chalk.gray('  ─────────────────────────────────────────'));
    for (const s of open) {
      const c = s.changes[0];
      lines.push(`  ${chalk.red('●')} ${c.description || `${c.type} ${c.method ? c.method.toUpperCase() : ''} ${c.path || ''} ${c.field || ''}`}`);
      lines.push(chalk.gray(`      ${s.status === 'rejected' ? `fix not applied — ${s.reason}` : s.reason}`));
    }
  }

  if (shim) {
    lines.push('');
    lines.push(chalk.bold('  Spring Boot version layer'));
    lines.push(chalk.gray('  ─────────────────────────────────────────'));
    if (shim.transforms.length === 0) {
      lines.push(chalk.gray('  Nothing to generate: no change here can be undone by reshaping JSON.'));
    } else {
      lines.push(`  ${plural(shim.transforms.length, 'transform')} — old clients get the old JSON shape; each was checked against sample payloads.`);
      for (const t of shim.transforms) {
        const assumed = t.kind === 'rename' || t.kind === 'enum';
        lines.push(chalk.gray(`    ${describeTransform(t)}`) + (assumed ? chalk.yellow('  (inferred rename — check)') : ''));
      }
    }
    for (const s of shim.skipped) lines.push(chalk.yellow(`    not generated: ${s}`));
    if (shim.files) for (const f of shim.files) lines.push(chalk.green(`  ✔ ${f}`));
  }

  lines.push('');
  if (outFile) {
    lines.push(chalk.green(`  ✔ Wrote ${outFile}`) + chalk.gray(` (${plural(r.ops.length, 'edit')}, comments and layout kept)`));
    if (outFile !== targetPath) lines.push(chalk.gray(`    Review: diff -u ${targetPath} ${outFile}`));
  } else if (dryRun && r.ops.length) {
    lines.push(chalk.gray('  --dry-run: nothing written.'));
  }
  lines.push('');
  return lines.join('\n');
}

function where(changes) {
  const eps = [...new Set(changes.filter((c) => c.method).map((c) => `${c.method.toUpperCase()} ${c.path}`))];
  if (eps.length === 0) return changes[0].field || '';
  return eps.length <= 3 ? eps.join(', ') : `${eps.slice(0, 3).join(', ')} and ${eps.length - 3} more`;
}

function describeTransform(t) {
  const at = `${t.method} ${t.path} ${t.side}`;
  if (t.kind === 'rename') return `${at}: ${t.from} → ${t.to}`;
  if (t.kind === 'convert') return `${at}: ${t.field} ${t.from} → ${t.to}`;
  if (t.kind === 'enum') return `${at}: ${t.field} "${t.from}" → "${t.to}"`;
  if (t.kind === 'default') return `${at}: ${t.field} defaults to ${JSON.stringify(t.value)}`;
  if (t.kind === 'unwrap') return `${at}: unwrap the list from \`${t.property}\``;
  return `${at}: ${t.kind}`;
}

module.exports = fix;
