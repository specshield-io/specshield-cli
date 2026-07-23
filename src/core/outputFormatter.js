'use strict';

const chalk = require('chalk');

function formatHuman(result) {
  const lines = [];
  const { breakingChanges, additions, modifications, warnings } = result;

  const total = breakingChanges.length + additions.length + modifications.length + warnings.length;

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
    `${chalk.gray(`${warnings.length} warnings`)}`
  );
  lines.push('');

  if (breakingChanges.length > 0) {
    lines.push(chalk.red.bold('  ✖  BREAKING CHANGES'));
    lines.push(chalk.gray('  ─────────────────────────────────────────'));
    for (const c of breakingChanges) {
      lines.push(`  ${chalk.red('●')} ${c.description}`);
      if (c.oldValue && c.newValue) {
        lines.push(`    ${chalk.gray('from:')} ${chalk.red(c.oldValue)}  ${chalk.gray('→')}  ${chalk.green(c.newValue)}`);
      }
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
    }
    lines.push('');
  }

  return lines.join('\n');
}

function formatJson(result) {
  return {
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
}

module.exports = { formatHuman, formatJson };
