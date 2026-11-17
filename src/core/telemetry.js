'use strict';

// Opt-in usage telemetry. Off unless the user says yes once, or sets
// SPECSHIELD_TELEMETRY=1 (CI). DO_NOT_TRACK=1 and SPECSHIELD_TELEMETRY=0 always win.
//
// One event per command run: the command name, the names of the flags given (never
// their values), the exit code, the duration, the CLI version, OS, Node major and
// which CI it ran in. No paths, spec contents, hosts, repo names or results.
//
// The event is sent by a detached child process started from the 'exit' handler,
// so it never delays the command, never changes its exit code and survives
// process.exit().

const crypto = require('crypto');
const path = require('path');
const { spawn } = require('child_process');

const DEFAULT_URL = 'https://specshield.io/api/telemetry/cli';
const DOCS = 'https://specshield.io/docs#telemetry';

const CI_VARS = [
  ['GITHUB_ACTIONS', 'github'], ['GITLAB_CI', 'gitlab'], ['BITBUCKET_BUILD_NUMBER', 'bitbucket'],
  ['CIRCLECI', 'circleci'], ['JENKINS_URL', 'jenkins'], ['BUILDKITE', 'buildkite'],
  ['TF_BUILD', 'azure'], ['TRAVIS', 'travis'], ['CODEBUILD_BUILD_ID', 'codebuild'], ['CI', 'other'],
];

function ciName(env = process.env) {
  const hit = CI_VARS.find(([v]) => env[v]);
  return hit ? hit[1] : null;
}

const truthy = (v) => /^(1|true|yes|on)$/i.test(String(v || '').trim());
const falsy = (v) => /^(0|false|no|off)$/i.test(String(v || '').trim());

/** 'on' | 'off' | 'unset', and why. Environment beats the saved choice. */
function state(config = {}, env = process.env) {
  if (truthy(env.DO_NOT_TRACK)) return { status: 'off', source: 'DO_NOT_TRACK' };
  if (falsy(env.SPECSHIELD_TELEMETRY)) return { status: 'off', source: 'SPECSHIELD_TELEMETRY' };
  if (truthy(env.SPECSHIELD_TELEMETRY)) return { status: 'on', source: 'SPECSHIELD_TELEMETRY' };
  if (config.telemetry === true) return { status: 'on', source: 'config' };
  if (config.telemetry === false) return { status: 'off', source: 'config' };
  return { status: 'unset', source: null };
}

/**
 * The id that lets runs from one install (or one CI repository) be counted together.
 * Locally: a random id saved on opt-in. In CI: a one-way hash of the CI's numeric
 * project id, so a repository's runs group together without its name being sent.
 */
function installId(config = {}, env = process.env) {
  if (config.telemetryId) return config.telemetryId;
  const project = env.GITHUB_REPOSITORY_ID || env.CI_PROJECT_ID || env.BITBUCKET_REPO_UUID;
  if (project) return 'ci-' + crypto.createHash('sha256').update('specshield-telemetry:' + project).digest('hex').slice(0, 32);
  return 'run-' + crypto.randomUUID();
}

/** "gate", "bdct can-i-deploy", "usage import" — the path below the root program. */
function commandName(cmd) {
  const names = [];
  for (let c = cmd; c && c.parent; c = c.parent) names.unshift(c.name());
  return names.join(' ');
}

/** Long names of the flags the user typed — never their values. */
function flagNames(cmd) {
  return cmd.options
    .filter((o) => cmd.getOptionValueSource(o.attributeName()) === 'cli')
    .map((o) => o.long || o.short)
    .filter(Boolean)
    .sort();
}

function buildEvent({ cmd, exitCode, durationMs, version, config, env = process.env }) {
  return {
    id: installId(config, env),
    version,
    command: commandName(cmd),
    flags: flagNames(cmd),
    exitCode: Number.isInteger(exitCode) ? exitCode : 0,
    durationMs: Math.max(0, Math.round(durationMs)),
    ci: ciName(env),
    os: process.platform,
    arch: process.arch,
    node: Number(process.versions.node.split('.')[0]),
  };
}

/** Ask once, only when a person is clearly at the keyboard. */
function shouldPrompt({ config = {}, env = process.env, argv = process.argv, stdin = process.stdin, stderr = process.stderr, command = '' }) {
  if (state(config, env).status !== 'unset') return false;
  if (ciName(env)) return false;
  if (!stdin.isTTY || !stderr.isTTY) return false;
  if (command === 'telemetry' || command.startsWith('telemetry ')) return false;
  if (argv.includes('--json')) return false;
  return true;
}

const PROMPT = [
  '',
  'Help improve SpecShield? Send anonymous usage data: the command and flag names you',
  'use, exit code, duration, CLI version and OS. Never file paths, specs, values or',
  `results. Change it any time with "specshield telemetry disable". ${DOCS}`,
  'Enable anonymous telemetry? [y/N] ',
].join('\n');

async function ask(stdin = process.stdin, stderr = process.stderr) {
  const readline = require('readline');
  const rl = readline.createInterface({ input: stdin, output: stderr });
  try {
    // Ctrl-D or a closed stdin ends the question with no answer: that's a no. Without the
    // 'close' listener the promise never settles, Node exits 0 and the command never runs.
    const answer = await new Promise((resolve) => {
      rl.on('close', () => resolve(''));
      rl.question(PROMPT, resolve);
    });
    return /^y(es)?$/i.test(String(answer).trim());
  } finally {
    rl.close();
  }
}

function withChoice(config, enabled) {
  const next = { ...config, telemetry: enabled };
  if (enabled && !next.telemetryId) next.telemetryId = crypto.randomUUID();
  if (!enabled) delete next.telemetryId;
  return next;
}

/** Fire and forget from a detached child; prints instead with SPECSHIELD_TELEMETRY_DEBUG=1. */
function send(event, env = process.env) {
  const body = JSON.stringify(event);
  if (truthy(env.SPECSHIELD_TELEMETRY_DEBUG)) {
    process.stderr.write(`[telemetry] ${body}\n`);
    return;
  }
  try {
    const child = spawn(process.execPath, [path.join(__dirname, 'telemetrySend.js'), env.SPECSHIELD_TELEMETRY_URL || DEFAULT_URL, body], {
      detached: true, stdio: 'ignore', windowsHide: true,
    });
    child.unref();
  } catch {
    // Telemetry must never affect the command.
  }
}

/**
 * Wire telemetry into the program: ask once before the first interactive command,
 * and send one event when the process exits.
 */
function install(program, { version, loadConfig, saveConfig }) {
  let started = null;
  let config = {};

  program.hook('preAction', async (_root, actionCommand) => {
    try {
      config = await loadConfig();
      if (shouldPrompt({ config, command: commandName(actionCommand) })) {
        config = withChoice(config, await ask());
        await saveConfig(config);
        process.stderr.write(config.telemetry ? 'Thanks — telemetry enabled.\n\n' : 'Telemetry stays off.\n\n');
      }
    } catch {
      // A broken config file or a closed stdin must not stop the command.
    }
    if (state(config).status !== 'on') return;
    started = { cmd: actionCommand, at: Date.now() };
  });

  process.on('exit', (code) => {
    if (!started) return;
    const exitCode = typeof code === 'number' ? code : (process.exitCode || 0);
    send(buildEvent({ cmd: started.cmd, exitCode, durationMs: Date.now() - started.at, version, config }));
  });
}

module.exports = {
  install, state, installId, commandName, flagNames, buildEvent, shouldPrompt, withChoice, send, ciName, ask,
  DEFAULT_URL, DOCS,
};
