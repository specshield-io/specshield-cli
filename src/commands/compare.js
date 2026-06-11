'use strict';

const { Command } = require('commander');
const chalk = require('chalk');
const ora = require('ora');
const path = require('path');
const { loadSpec } = require('../core/loadSpec');
const { parseSpec } = require('../core/parseSpec');
const { normalizeSpec } = require('../core/normalizeSpec');
const { diffSpecs } = require('../core/diffEngine');
const { classifyChanges, filterBySeverity } = require('../core/classifyChanges');
const { formatHuman, formatJson } = require('../core/outputFormatter');
const { loadConfig } = require('../core/configLoader');
const { resolveExitCode } = require('../core/exitCode');
const { recordCompareAndMaybeRender } = require('../core/conversionPrompt');
const logger = require('../utils/logger');
const fsExtra = require('fs-extra');
const { getStoredApiKey } = require('../config/localConfig');

const HOSTED_API_URL = 'https://specshield.io';

const compare = new Command('compare');

compare
  .description('Compare two OpenAPI spec files and detect breaking changes')
  .argument('<base>', 'Path to the base (old) OpenAPI spec')
  .argument('<target>', 'Path to the target (new) OpenAPI spec')
  .option('--json', 'Output machine-readable JSON')
  .option('--output <file>', 'Save result to a file')
  .option('--fail-on-breaking', 'Exit with code 1 if breaking changes are found')
  .option('--allow-breaking', 'Override fail-on-breaking behavior')
  .option('--config <path>', 'Path to .specshield.yml config file')
  .option('--ignore <change>', 'Ignore a specific change string (repeatable)', collect, [])
  // Default severity is 'info' so additions and modifications are visible
  // by default. Customers expect a diff summary to list ALL changes, with
  // severity coloring/filtering as an opt-in narrowing. The previous default
  // of 'error' silently hid every non-breaking change, which read as "0
  // additions / 0 modifications" even when both existed.
  .option('--severity <level>', 'Minimum severity level: info | warning | error', 'info')
  .option('--remote', 'Use the SpecShield hosted compare API')
  .option('--api-key <key>', 'API key for hosted mode (overrides env and stored config)')
  .option('--remote-url <url>', 'Override the hosted API base URL')
  .option('--timeout <ms>', 'Request timeout for remote mode (ms)', '10000')
  .action(async (base, target, opts) => {
    try {
      // Load config
      const config = await loadConfig(opts.config);

      // Merge config with CLI options (CLI wins)
      const options = mergeOptions(config, opts);

      // Resolve API key for remote mode (precedence: --api-key > env > stored config > .specshield.yml)
      if (options.remote || options.remoteUrl || (config.remote && config.remote.enabled)) {
        options.resolvedApiKey = opts.apiKey
          || process.env.SPECSHIELD_API_KEY
          || await getStoredApiKey()
          || (config.remote && config.remote.apiKey)
          || null;

        if (!options.resolvedApiKey) {
          logger.error('No API key found. Run: specshield login --api-key <KEY>');
          process.exit(2);
        }
      }

      const spinner = options.json ? null : ora('Loading specs...').start();

      let result;

      if (options.remote || options.remoteUrl || (config.remote && config.remote.enabled)) {
        result = await runRemoteComparison(base, target, options, spinner);
      } else {
        result = await runLocalComparison(base, target, options, spinner);
      }

      if (spinner) spinner.stop();

      // Apply ignore list
      result = applyIgnoreList(result, options.ignore || []);

      // Apply severity filter
      result = filterBySeverity(result, options.severity);

      // Output
      if (options.json) {
        const jsonOutput = formatJson(result);
        process.stdout.write(JSON.stringify(jsonOutput, null, 2) + '\n');
        if (options.output) {
          await fsExtra.outputFile(options.output, JSON.stringify(jsonOutput, null, 2));
        }
      } else {
        const humanOutput = formatHuman(result);
        process.stdout.write(humanOutput + '\n');
        if (options.output) {
          const jsonOutput = formatJson(result);
          await fsExtra.outputFile(options.output, JSON.stringify(jsonOutput, null, 2));
          logger.info(`Results saved to ${options.output}`);
        }

        // Note for an anonymous --remote: the diff ran but wasn't saved
        // because no API key was sent. An authenticated --remote persists the
        // comparison and the backend returns a historyId, so this note hides.
        if ((options.remote || options.remoteUrl)
            && !result.historyId && !result.reportId && !result.id) {
          const chalk = require('chalk');
          process.stdout.write('\n' + chalk.gray(
            '  Note: --remote ran the diff but did NOT save it to your history\n' +
            '  (no API key). Run "specshield login" (or set SPECSHIELD_API_KEY) to\n' +
            '  save comparisons and unlock "specshield history" / "specshield share".\n'
          ));
        }
      }

      // Contextual signup nudge — runs only when the user isn't logged in,
      // output is human-readable, not in CI, and they've crossed a usage
      // threshold this week. The recordCompareAndMaybeRender function is
      // best-effort; any failure (disk read/write, etc.) is silently
      // swallowed so the conversion path never blocks compare.
      try {
        const loggedIn = !!(options.resolvedApiKey ||
                            process.env.SPECSHIELD_API_KEY ||
                            await getStoredApiKey());
        const prompt = await recordCompareAndMaybeRender({
          loggedIn,
          jsonOutput: !!options.json,
        });
        if (prompt) process.stdout.write('\n' + prompt + '\n');
      } catch { /* never block on the nudge */ }

      // Exit code
      const code = resolveExitCode(result, options);
      process.exit(code);

    } catch (err) {
      logger.error(`Error: ${err.message}`);
      process.exit(2);
    }
  });

async function runLocalComparison(base, target, options, spinner) {
  if (spinner) spinner.text = 'Loading base spec...';
  const baseRaw = await loadSpec(base);

  if (spinner) spinner.text = 'Loading target spec...';
  const targetRaw = await loadSpec(target);

  if (spinner) spinner.text = 'Parsing specs...';
  const baseParsed = parseSpec(baseRaw, base);
  const targetParsed = parseSpec(targetRaw, target);

  if (spinner) spinner.text = 'Normalizing specs...';
  const baseNorm = normalizeSpec(baseParsed);
  const targetNorm = normalizeSpec(targetParsed);

  if (spinner) spinner.text = 'Comparing specs...';
  const rawDiffs = diffSpecs(baseNorm, targetNorm);

  if (spinner) spinner.text = 'Classifying changes...';
  return classifyChanges(rawDiffs);
}

async function runRemoteComparison(base, target, options, spinner) {
  const axios = require('axios');
  const { version } = require('../../package.json');

  if (spinner) spinner.text = 'Loading specs for remote comparison...';
  const baseRaw = await loadSpec(base);
  const targetRaw = await loadSpec(target);

  const url = options.remoteUrl || HOSTED_API_URL + '/compare';
  const timeout = parseInt(options.timeout, 10) || 10000;

  if (spinner) spinner.text = `Sending to hosted API...`;

  const headers = {
    'Content-Type': 'application/json',
    'X-Api-Key': options.resolvedApiKey,
    'X-SpecShield-Client': 'cli',
    'X-SpecShield-Version': version,
  };

  try {
    const response = await axios.post(
      url,
      { baseSpec: baseRaw, targetSpec: targetRaw },
      { timeout, headers }
    );
    return response.data;
  } catch (err) {
    const msg = err.response
      ? `Remote API error ${err.response.status}: ${JSON.stringify(err.response.data)}`
      : `Remote connection failed: ${err.message}`;
    throw new Error(msg);
  }
}

function applyIgnoreList(result, ignoreList) {
  if (!ignoreList || ignoreList.length === 0) return result;

  const shouldIgnore = (change) => {
    const desc = change.description || change.message || '';
    return ignoreList.some((pattern) => desc.includes(pattern));
  };

  return {
    ...result,
    breakingChanges: result.breakingChanges.filter((c) => !shouldIgnore(c)),
    additions: result.additions.filter((c) => !shouldIgnore(c)),
    modifications: result.modifications.filter((c) => !shouldIgnore(c)),
    warnings: result.warnings.filter((c) => !shouldIgnore(c)),
  };
}

function mergeOptions(config, cliOpts) {
  return {
    json: cliOpts.json || false,
    output: cliOpts.output || null,
    failOnBreaking: cliOpts.allowBreaking
      ? false
      : cliOpts.failOnBreaking !== undefined
      ? cliOpts.failOnBreaking
      : config.failOnBreaking !== undefined
      ? config.failOnBreaking
      : false,
    allowBreaking: cliOpts.allowBreaking || config.allowBreakingChanges || false,
    ignore: [
      ...(cliOpts.ignore || []),
      ...(config.ignore || []),
    ],
    severity: cliOpts.severity || config.severity || 'error',
    remote: cliOpts.remote || (config.remote && config.remote.enabled) || false,
    remoteUrl: cliOpts.remoteUrl || null,
    timeout: cliOpts.timeout || (config.remote && config.remote.timeout) || 10000,
  };
}

function collect(value, previous) {
  return previous.concat([value]);
}

module.exports = compare;
