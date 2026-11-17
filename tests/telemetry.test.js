'use strict';

const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const { Command } = require('commander');
const t = require('../src/core/telemetry');

const CLI = path.join(__dirname, '..', 'bin', 'specshield.js');
const tty = { isTTY: true };

function parsed(argv) {
  const program = new Command().exitOverride();
  let action = null;
  const bdct = program.command('bdct');
  bdct.command('can-i-deploy').option('--provider <name>').option('--env <env>', 'env', 'production')
    .action((_o, cmd) => { action = cmd; });
  program.command('gate').argument('[spec]').option('--shadow').option('--waivers <file>', 'w', '.specshield/waivers.yml')
    .action((_s, _o, cmd) => { action = cmd; });
  program.parse(argv, { from: 'user' });
  return action;
}

function run(args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => resolve({ code, stderr }));
  });
}

describe('telemetry state', () => {
  test('off until chosen', () => {
    expect(t.state({}, {}).status).toBe('unset');
    expect(t.state({ telemetry: true }, {}).status).toBe('on');
    expect(t.state({ telemetry: false }, {}).status).toBe('off');
  });

  test('environment beats the saved choice, and DO_NOT_TRACK beats everything', () => {
    expect(t.state({ telemetry: true }, { SPECSHIELD_TELEMETRY: '0' })).toEqual({ status: 'off', source: 'SPECSHIELD_TELEMETRY' });
    expect(t.state({ telemetry: false }, { SPECSHIELD_TELEMETRY: '1' })).toEqual({ status: 'on', source: 'SPECSHIELD_TELEMETRY' });
    expect(t.state({ telemetry: true }, { DO_NOT_TRACK: '1', SPECSHIELD_TELEMETRY: '1' }).status).toBe('off');
  });

  test('withChoice keeps an id only while enabled', () => {
    const on = t.withChoice({ apiKey: 'k' }, true);
    expect(on).toMatchObject({ apiKey: 'k', telemetry: true });
    expect(on.telemetryId).toMatch(/^[0-9a-f-]{36}$/);
    expect(t.withChoice(on, true).telemetryId).toBe(on.telemetryId);
    expect(t.withChoice(on, false)).toEqual({ apiKey: 'k', telemetry: false });
  });
});

describe('telemetry ids', () => {
  test('saved id first, then a hash of the CI project id, never the id itself', () => {
    expect(t.installId({ telemetryId: 'abc' }, { GITHUB_REPOSITORY_ID: '1' })).toBe('abc');
    const a = t.installId({}, { GITHUB_REPOSITORY_ID: '12345' });
    expect(a).toMatch(/^ci-[0-9a-f]{32}$/);
    expect(a).not.toContain('12345');
    expect(t.installId({}, { GITHUB_REPOSITORY_ID: '12345' })).toBe(a);
    expect(t.installId({}, {})).toMatch(/^run-/);
  });
});

describe('telemetry event', () => {
  test('names the subcommand path and only the flags typed, without values', () => {
    const cmd = parsed(['bdct', 'can-i-deploy', '--provider', 'payments-api']);
    expect(t.commandName(cmd)).toBe('bdct can-i-deploy');
    expect(t.flagNames(cmd)).toEqual(['--provider']);   // --env came from its default
    const e = t.buildEvent({ cmd, exitCode: 1, durationMs: 12.6, version: '9.9.9', config: { telemetryId: 'x' }, env: { GITLAB_CI: 'true' } });
    expect(e).toMatchObject({ id: 'x', version: '9.9.9', command: 'bdct can-i-deploy', flags: ['--provider'], exitCode: 1, durationMs: 13, ci: 'gitlab' });
    expect(JSON.stringify(e)).not.toContain('payments-api');
  });

  test('positional arguments never appear', () => {
    const cmd = parsed(['gate', 'secret/path/openapi.yaml', '--shadow', '--waivers', 'w.yml']);
    const e = t.buildEvent({ cmd, exitCode: 0, durationMs: 1, version: '1', config: {}, env: {} });
    expect(e.flags).toEqual(['--shadow', '--waivers']);
    expect(JSON.stringify(e)).not.toMatch(/secret|openapi\.yaml|w\.yml/);
  });
});

describe('telemetry prompt', () => {
  const base = { config: {}, env: {}, argv: ['node', 'specshield', 'gate'], stdin: tty, stderr: tty, command: 'gate' };

  test('asks once, at an interactive terminal', () => {
    expect(t.shouldPrompt(base)).toBe(true);
    expect(t.shouldPrompt({ ...base, config: { telemetry: false } })).toBe(false);
  });

  test('never in CI, without a terminal, for --json or for the telemetry command', () => {
    expect(t.shouldPrompt({ ...base, env: { CI: 'true' } })).toBe(false);
    expect(t.shouldPrompt({ ...base, stdin: {} })).toBe(false);
    expect(t.shouldPrompt({ ...base, stderr: {} })).toBe(false);
    expect(t.shouldPrompt({ ...base, argv: [...base.argv, '--json'] })).toBe(false);
    expect(t.shouldPrompt({ ...base, command: 'telemetry' })).toBe(false);
    expect(t.shouldPrompt({ ...base, env: { DO_NOT_TRACK: '1' } })).toBe(false);
  });
});

describe('telemetry answer', () => {
  const { PassThrough } = require('stream');
  const sink = () => new PassThrough();

  test('y or yes enables; anything else, Enter or a closed input is a no', async () => {
    for (const [typed, want] of [['y\n', true], ['YES\n', true], ['\n', false], ['nope\n', false]]) {
      const input = new PassThrough();
      const answer = t.ask(input, sink());
      input.write(typed);
      await expect(answer).resolves.toBe(want);
    }
    const closed = new PassThrough();
    const answer = t.ask(closed, sink());
    closed.end();
    await expect(answer).resolves.toBe(false);
  });
});

describe('telemetry from the CLI', () => {
  test('sends one event to the collector after the command exits, keeping its exit code', async () => {
    const received = [];
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (d) => { body += d; });
      req.on('end', () => { received.push({ url: req.url, body: JSON.parse(body) }); res.end(); });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${server.address().port}/api/telemetry/cli`;
    try {
      const { code } = await run(['compare', 'missing-a.yaml', 'missing-b.yaml', '--severity', 'error'],
        { SPECSHIELD_TELEMETRY: '1', SPECSHIELD_TELEMETRY_URL: url });
      expect(code).toBe(2);
      for (let i = 0; i < 50 && !received.length; i++) await new Promise((r) => setTimeout(r, 100));
      expect(received).toHaveLength(1);
      expect(received[0].url).toBe('/api/telemetry/cli');
      expect(received[0].body).toMatchObject({ command: 'compare', flags: ['--severity'], exitCode: 2 });
      expect(JSON.stringify(received[0].body)).not.toContain('missing-a');
    } finally {
      server.close();
    }
  });

  test('sends nothing when off, and nothing for --help', async () => {
    const off = await run(['compare', 'a.yaml', 'b.yaml'], { SPECSHIELD_TELEMETRY: '0', SPECSHIELD_TELEMETRY_DEBUG: '1' });
    expect(off.stderr).not.toContain('[telemetry]');
    const help = await run(['gate', '--help'], { SPECSHIELD_TELEMETRY: '1', SPECSHIELD_TELEMETRY_DEBUG: '1' });
    expect(help.stderr).not.toContain('[telemetry]');
  });

  test('an unreachable collector changes nothing', async () => {
    const { code, stderr } = await run(['compare', 'a.yaml', 'b.yaml'],
      { SPECSHIELD_TELEMETRY: '1', SPECSHIELD_TELEMETRY_URL: 'http://127.0.0.1:9/nowhere' });
    expect(code).toBe(2);
    expect(stderr).not.toMatch(/ECONNREFUSED|telemetry/i);
  });
});
