'use strict';

/**
 * End-to-end smoke for the non-interactive `init` flow.
 * Runs the actual CLI binary against a tmp directory, then verifies the
 * generated `.specshield.yml` parses and contains the expected keys.
 */

const fs        = require('fs');
const os        = require('os');
const path      = require('path');
const cp        = require('child_process');
const yaml      = require('js-yaml');

const CLI = path.join(__dirname, '..', 'bin', 'specshield.js');

function run(args, cwd) {
  const r = cp.spawnSync('node', [CLI, ...args], { cwd, encoding: 'utf8' });
  return { stdout: r.stdout, stderr: r.stderr, status: r.status };
}

function tmpRepo(layout = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-init-'));
  for (const [rel, contents] of Object.entries(layout)) {
    const target = path.join(root, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, contents);
  }
  return root;
}

describe('specshield init --no-interactive', () => {
  it('writes a valid provider-only .specshield.yml', () => {
    const root = tmpRepo({
      'package.json':     JSON.stringify({ name: 'payment-service' }),
      'api/openapi.yaml': 'openapi: 3.0.0\ninfo: {title: x, version: 1}\npaths: {}\n',
    });

    const r = run([
      'init', '--no-interactive',
      '--kind',     'provider',
      '--org',      'acme-pay',
      '--provider', 'payment-service',
      '--spec',     'api/openapi.yaml',
      '--env',      'staging',
    ], root);

    expect(r.status).toBe(0);

    const written = fs.readFileSync(path.join(root, '.specshield.yml'), 'utf8');
    const parsed  = yaml.load(written);
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.bdct.org).toBe('acme-pay');
    expect(parsed.bdct.provider.name).toBe('payment-service');
    expect(parsed.bdct.provider.spec).toBe('api/openapi.yaml');
    expect(parsed.bdct.environment).toBe('staging');
  });

  it('exits 2 with a friendly error when --kind is missing', () => {
    const root = tmpRepo({});
    const r = run(['init', '--no-interactive'], root);
    expect(r.status).toBe(2);
    expect(r.stderr + r.stdout).toMatch(/Missing --kind/);
  });

  it('exits 2 when required fields for the chosen kind are absent', () => {
    const root = tmpRepo({});  // no package.json, no spec
    const r = run([
      'init', '--no-interactive',
      '--kind', 'provider',
      '--org',  'acme',
    ], root);
    expect(r.status).toBe(2);
  });

  it('--print outputs YAML and writes nothing', () => {
    const root = tmpRepo({
      'api/openapi.yaml': 'openapi: 3.0.0\npaths: {}\n',
      'package.json':     JSON.stringify({ name: 'svc' }),
    });
    const r = run([
      'init', '--no-interactive', '--print',
      '--kind', 'provider', '--org', 'acme',
      '--provider', 'svc', '--spec', 'api/openapi.yaml',
    ], root);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/schemaVersion: 1/);
    expect(fs.existsSync(path.join(root, '.specshield.yml'))).toBe(false);
  });

  // ─── F3 regression — `init --print` must never prompt ─────────────────
  // Previously, --print still ran the interactive prompt flow and only the
  // tail of the action handler honoured the flag. The fix routes --print
  // through a previewFlow that's strictly non-interactive — so even with
  // NO other flags and on a stdin-less invocation it exits cleanly with
  // a dry-run YAML on stdout.

  it('--print without --no-interactive does NOT prompt and exits 0', () => {
    const root = tmpRepo({
      'api/openapi.yaml': 'openapi: 3.0.0\npaths: {}\n',
      'package.json':     JSON.stringify({ name: 'svc' }),
    });
    // Note: no --no-interactive, no --kind, no --org — bare `init --print`.
    // If --print were still routed through the interactive flow, this would
    // either hang waiting for input or print the prompt and exit.
    const r = cp.spawnSync('node', [CLI, 'init', '--print'], {
      cwd: root, encoding: 'utf8', input: '',
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/DRY RUN/);
    expect(r.stdout).toMatch(/schemaVersion: 1/);
    expect(fs.existsSync(path.join(root, '.specshield.yml'))).toBe(false);
  });

  it('--print with no --org uses a "<replace-me>" placeholder rather than failing', () => {
    const root = tmpRepo({
      'api/openapi.yaml': 'openapi: 3.0.0\npaths: {}\n',
      'package.json':     JSON.stringify({ name: 'svc' }),
    });
    const r = cp.spawnSync('node', [CLI, 'init', '--print'], {
      cwd: root, encoding: 'utf8', input: '',
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/<replace-me>/);
  });

  it('--print defaults kind to "provider" when a spec is detected', () => {
    const root = tmpRepo({
      'api/openapi.yaml': 'openapi: 3.0.0\npaths: {}\n',
      'package.json':     JSON.stringify({ name: 'my-svc' }),
    });
    const r = cp.spawnSync('node', [CLI, 'init', '--print'], {
      cwd: root, encoding: 'utf8', input: '',
    });
    expect(r.status).toBe(0);
    // Provider block is present in the dry-run output.
    expect(r.stdout).toMatch(/provider:/);
    expect(r.stdout).toMatch(/name: my-svc/);
  });

  it('--print defaults kind to "skip" when NO spec is detected', () => {
    const root = tmpRepo({
      'package.json': JSON.stringify({ name: 'svc' }),
      // No openapi.yaml anywhere.
    });
    const r = cp.spawnSync('node', [CLI, 'init', '--print'], {
      cwd: root, encoding: 'utf8', input: '',
    });
    expect(r.status).toBe(0);
    // Kind defaults to 'skip' → no bdct block in the output.
    expect(r.stdout).not.toMatch(/^bdct:/m);
    expect(r.stdout).toMatch(/schemaVersion: 1/);
  });

  it('--write-workflow also writes .github/workflows/specshield-bdct.yml', () => {
    const root = tmpRepo({
      'api/openapi.yaml': 'openapi: 3.0.0\npaths: {}\n',
      'package.json':     JSON.stringify({ name: 'svc' }),
    });
    const r = run([
      'init', '--no-interactive', '--write-workflow',
      '--kind', 'provider', '--org', 'acme',
      '--provider', 'svc', '--spec', 'api/openapi.yaml',
    ], root);
    expect(r.status).toBe(0);
    const wf = path.join(root, '.github', 'workflows', 'specshield-bdct.yml');
    expect(fs.existsSync(wf)).toBe(true);
    const text = fs.readFileSync(wf, 'utf8');
    expect(text).toMatch(/specshield-io\/bdct-action@v1/);
    expect(text).toMatch(/publish-provider:/);
  });
});
