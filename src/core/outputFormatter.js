'use strict';

const chalk = require('chalk');
const { fmt, plural, pct, day, spanDays, ago } = require('./usage/format');

function formatHuman(result) {
  const lines = [];
  const { breakingChanges, additions, modifications, warnings } = result;
  const unused = result.unusedBreakingChanges || [];

  const total = breakingChanges.length + additions.length + modifications.length + warnings.length + unused.length;

  if (total === 0) {
    lines.push(chalk.green('✔  No changes detected between the two specs.'));
    return lines.join('\n');
  }

  // Summary header
  lines.push('');
  lines.push(chalk.bold('  SpecShield™ Comparison Report'));
  lines.push(chalk.gray('  ─────────────────────────────────────────'));
  lines.push(
    `  ${chalk.red.bold(`${breakingChanges.length} breaking`)}  ` +
    `${chalk.green(`${additions.length} additions`)}  ` +
    `${chalk.yellow(`${modifications.length} modifications`)}  ` +
    `${chalk.gray(`${warnings.length} warnings`)}` +
    (result.usage ? `  ${chalk.green(`${unused.length} breaking but unused`)}` : '')
  );
  if (result.usage) lines.push(...formatUsageHeader(result.usage));
  lines.push('');

  if (breakingChanges.length > 0) {
    lines.push(chalk.red.bold('  ✖  BREAKING CHANGES'));
    lines.push(chalk.gray('  ─────────────────────────────────────────'));
    for (const c of breakingChanges) {
      lines.push(`  ${chalk.red('●')} ${c.description}`);
      if (c.oldValue && c.newValue) {
        lines.push(`    ${chalk.gray('from:')} ${chalk.red(c.oldValue)}  ${chalk.gray('→')}  ${chalk.green(c.newValue)}`);
      }
      if (c.impact) lines.push(...formatImpact(c, { detailed: true }));
      if (c.deprecation) lines.push(formatDeprecation(c));
    }
    lines.push(chalk.gray('  Get a non-breaking version of this change: specshield fix <base> <target>'));
    lines.push('');
  }

  if (unused.length > 0) {
    const w = result.usage && result.usage.window;
    lines.push(chalk.green.bold('  ✔  BREAKING BUT UNUSED — safe to ship'));
    const drained = unused.some((c) => c.deprecation && c.deprecation.drained);
    lines.push(chalk.gray(`  0 calls ${w && w.from ? `between ${day(w.from)} and ${day(w.to)}` : 'in the usage window'}` +
      (drained ? ` — or deprecated and quiet for ${result.usage.quietDays}+ days` : '') + '; these do not fail the build'));
    lines.push(chalk.gray('  ─────────────────────────────────────────'));
    for (const c of unused) {
      lines.push(`  ${chalk.green('○')} ${c.description}`);
      if (c.impact && c.impact.basis === 'query-parameter') {
        lines.push(chalk.gray(`    no client ${c.impact.parameterUse === 'omitted' ? 'omits' : 'sends'} "${c.impact.parameter}"`));
      }
      if (c.deprecation) lines.push(formatDeprecation(c));
    }
    lines.push('');
  }

  if (additions.length > 0) {
    lines.push(chalk.green.bold('  ✚  ADDITIONS'));
    lines.push(chalk.gray('  ─────────────────────────────────────────'));
    for (const c of additions) {
      lines.push(`  ${chalk.green('+')} ${c.description}`);
    }
    lines.push('');
  }

  if (modifications.length > 0) {
    lines.push(chalk.yellow.bold('  ✎  MODIFICATIONS'));
    lines.push(chalk.gray('  ─────────────────────────────────────────'));
    for (const c of modifications) {
      lines.push(`  ${chalk.yellow('~')} ${c.description}`);
      if (c.oldValue && c.newValue) {
        lines.push(`    ${chalk.gray('from:')} ${chalk.yellow(c.oldValue)}  ${chalk.gray('→')}  ${chalk.yellow(c.newValue)}`);
      }
    }
    lines.push('');
  }

  if (warnings.length > 0) {
    lines.push(chalk.gray.bold('  ⚠  WARNINGS'));
    lines.push(chalk.gray('  ─────────────────────────────────────────'));
    for (const c of warnings) {
      lines.push(`  ${chalk.gray('!')} ${c.description}`);
      if (c.impact) lines.push(...formatImpact(c, { detailed: false }));
    }
    // Whether a constraint change actually breaks depends on which side of the
    // contract it sits on, which this engine does not track. Say so rather than
    // let the reader assume these were judged and found safe.
    lines.push(chalk.gray('    These depend on request/response direction — the hosted gate rules on them.'));
    lines.push('');
  }

  // "0 breaking" from a deliberately smaller local engine is not the same claim
  // as "0 breaking" from the full one. Don't let the two look identical.
  if (breakingChanges.length === 0) {
    lines.push(chalk.gray('  No breaking changes found by the local engine.'));
    lines.push(chalk.gray('  Nullability, constraint and enum-addition checks run on the hosted gate.'));
    lines.push('');
  }

  return lines.join('\n');
}

// ─── Usage impact ───────────────────────────────────────────────────────────

const MAX_CLIENTS_SHOWN = 5;

function formatUsageHeader(u) {
  const lines = [];
  if (!u.trusted) {
    lines.push(chalk.yellow(`  Usage: ${u.file} was not applied — none of its calls match an operation in the base spec.`));
    return lines;
  }
  const span = spanDays(u.window);
  lines.push(chalk.gray(
    `  Usage: ${u.file} · ${u.window.from ? `${day(u.window.from)} → ${day(u.window.to)}` : 'no timestamps'}` +
    (span !== null ? ` (${span} days)` : '') +
    ` · ${plural(u.matchedCalls, 'call')} · ${plural(u.clients, 'client')}` +
    (u.operationsTotal ? ` · ${u.operationsSeen}/${u.operationsTotal} operations seen` : '') +
    (u.ignoredCalls ? ` · ${fmt(u.ignoredCalls)} ignored` : '')));
  if (!u.downgrade.enabled && u.downgrade.reason !== 'disabled by --no-usage-downgrade') {
    lines.push(chalk.yellow(`  Unused breaking changes still fail the build: ${u.downgrade.reason}.`));
  }
  return lines;
}

function formatImpact(c, { detailed }) {
  const i = c.impact;
  const lines = [];
  if (i.verdict === 'unknown') {
    lines.push(chalk.gray(`    ↳ impact: unknown — ${i.reason}`));
    return lines;
  }
  if (i.verdict === 'unused') {
    lines.push(chalk.green(`    ↳ impact: 0 calls${scope(i)} — nobody would notice this change`));
    return lines;
  }

  const n = i.clients.length;
  lines.push(chalk.yellow(
    `    ↳ impact: ${plural(n, 'client')} · ${plural(i.calls, 'call')}${scope(i)}` +
    ` · last seen ${ago(i.lastSeen)}`));
  if (detailed) {
    const width = Math.min(32, Math.max(...i.clients.slice(0, MAX_CLIENTS_SHOWN).map((x) => x.id.length)));
    for (const cl of i.clients.slice(0, MAX_CLIENTS_SHOWN)) {
      lines.push(
        `        ${chalk.bold(cl.id.padEnd(width))}  ${pct(cl.share).padStart(4)} of calls  ` +
        chalk.gray(`${fmt(cl.calls)} · last seen ${ago(cl.lastSeen)}`));
    }
    if (n > MAX_CLIENTS_SHOWN) lines.push(chalk.gray(`        …and ${n - MAX_CLIENTS_SHOWN} more`));
    if (i.basis === 'endpoint' && isFieldLevel(c)) {
      lines.push(chalk.gray('        (clients calling this endpoint — access logs do not show which fields they use)'));
    }
  }
  return lines;
}

/** Removals only: was this deprecated in the base spec before it was removed? */
function formatDeprecation(c) {
  const d = c.deprecation;
  const used = c.impact && c.impact.verdict === 'used';
  if (d.deprecated) {
    const sunset = d.sunset ? ` (sunset ${d.sunset})` : '';
    if (d.drained) {
      return chalk.gray(`    ↳ deprecated${sunset} · drained: last call ${day(c.impact.lastSeen)}, ${d.quietForDays} days before the newest log line`);
    }
    return used
      ? chalk.yellow(`    ↳ deprecated${sunset}, but still called — tell the clients above before removing it`)
      : chalk.gray(`    ↳ deprecated${sunset} and unused — removal is the planned last step`);
  }
  return chalk.yellow('    ↳ removed without being deprecated first — callers got no warning' +
    (used ? '. Mark it `deprecated: true` and watch it drain: specshield deprecations' : ''));
}

function scope(i) {
  if (i.basis !== 'query-parameter') return '';
  return i.parameterUse === 'omitted'
    ? ` without "${i.parameter}"`
    : ` sending "${i.parameter}"`;
}

/** Changes below the operation level, where "calls the endpoint" over-approximates "is affected". */
function isFieldLevel(c) {
  return !['ENDPOINT_REMOVED', 'METHOD_REMOVED'].includes(c.type);
}

function formatJson(result) {
  const out = {
    summary: {
      breaking: result.breakingChanges.length,
      additions: result.additions.length,
      modifications: result.modifications.length,
      warnings: result.warnings.length,
    },
    breakingChanges: result.breakingChanges,
    additions: result.additions,
    modifications: result.modifications,
    warnings: result.warnings,
  };
  // Additive only, and only with --usage: CI consumers parsing the existing
  // shape see no difference unless they opt in.
  if (result.usage) {
    out.summary.unusedBreaking = (result.unusedBreakingChanges || []).length;
    out.unusedBreakingChanges = result.unusedBreakingChanges || [];
    out.usage = result.usage;
  }
  return out;
}

module.exports = { formatHuman, formatJson };
