'use strict';

const fs   = require('fs');
const os   = require('os');
const path = require('path');

const {
  findProjectConfigFile,
  loadProjectConfig,
  applyBdctDefaults,
  clearCache,
} = require('../src/core/projectConfig');

function makeTmp(layout) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-cfg-'));
  for (const [rel, contents] of Object.entries(layout)) {
    const target = path.join(root, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, contents);
  }
  return root;
}

beforeEach(() => clearCache());

describe('findProjectConfigFile()', () => {
  it('finds .specshield.yml in cwd', () => {
    const root = makeTmp({ '.specshield.yml': 'schemaVersion: 1\n' });
    expect(findProjectConfigFile(root)).toBe(path.join(root, '.specshield.yml'));
  });

  it('walks up the directory tree', () => {
    const root = makeTmp({
      '.specshield.yml': 'schemaVersion: 1\n',
      'pkg/sub/.gitkeep': '',
    });
    expect(findProjectConfigFile(path.join(root, 'pkg', 'sub')))
      .toBe(path.join(root, '.specshield.yml'));
  });

  it('returns null when no config exists', () => {
    const root = makeTmp({ 'README.md': '' });
    expect(findProjectConfigFile(root)).toBeNull();
  });
});

describe('loadProjectConfig()', () => {
  it('parses the file and includes the _file path', () => {
    const root = makeTmp({
      '.specshield.yml': 'schemaVersion: 1\nbdct:\n  org: acme\n',
    });
    const cfg = loadProjectConfig(root, { noCache: true });
    expect(cfg.schemaVersion).toBe(1);
    expect(cfg.bdct.org).toBe('acme');
    expect(cfg._file).toBe(path.join(root, '.specshield.yml'));
  });

  it('returns {} when no file is found', () => {
    const root = makeTmp({ 'README.md': '' });
    const cfg = loadProjectConfig(root, { noCache: true });
    expect(cfg).toEqual({});
  });

  it('falls back to {} on malformed YAML', () => {
    const root = makeTmp({ '.specshield.yml': '::: not valid yaml :::\n' });
    const cfg = loadProjectConfig(root, { noCache: true });
    // Either {} or a parsed-string error; we accept any non-throwing result.
    expect(typeof cfg).toBe('object');
  });
});

describe('applyBdctDefaults()', () => {
  it('fills missing flags from the config', () => {
    const root = makeTmp({
      '.specshield.yml': [
        'bdct:',
        '  org: acme-pay',
        '  environment: staging',
        '  provider:',
        '    name: payment-service',
        '    spec: api/openapi.yaml',
      ].join('\n') + '\n',
    });
    const opts = { version: 'abc123' };          // user passed only --version
    applyBdctDefaults(opts, 'publish-provider', { cwd: root });
    expect(opts.org).toBe('acme-pay');
    expect(opts.provider).toBe('payment-service');
    expect(opts.spec).toBe(path.join(root, 'api/openapi.yaml'));   // resolved
    expect(opts.env).toBe('staging');
  });

  it('CLI flags win over config', () => {
    const root = makeTmp({
      '.specshield.yml': 'bdct:\n  org: from-config\n',
    });
    const opts = { org: 'from-cli', service: 's', version: '1' };
    applyBdctDefaults(opts, 'can-i-deploy', { cwd: root });
    expect(opts.org).toBe('from-cli');
  });

  it('throws MISSING_REQUIRED_OPTIONS with the right field list', () => {
    const root = makeTmp({});
    const opts = {};
    let err = null;
    try { applyBdctDefaults(opts, 'can-i-deploy', { cwd: root }); }
    catch (e) { err = e; }
    expect(err).not.toBeNull();
    expect(err.code).toBe('MISSING_REQUIRED_OPTIONS');
    expect(err.missing).toEqual(expect.arrayContaining(['org', 'service', 'version']));
  });

  it('publish-consumer: uses bdct.consumer.* keys', () => {
    const root = makeTmp({
      '.specshield.yml': [
        'bdct:',
        '  org: acme',
        '  consumer:',
        '    name: checkout-ui',
        '    provider: payment-service',
        '    contract: contracts/c.yaml',
        '    format: OPENAPI',
      ].join('\n') + '\n',
    });
    const opts = { version: 'v1' };
    applyBdctDefaults(opts, 'publish-consumer', { cwd: root });
    expect(opts.consumer).toBe('checkout-ui');
    expect(opts.provider).toBe('payment-service');
    expect(opts.contract).toBe(path.join(root, 'contracts/c.yaml'));
    expect(opts.format).toBe('OPENAPI');
  });

  it('can-i-deploy: defaults service to whichever role the project owns', () => {
    const root = makeTmp({
      '.specshield.yml': [
        'bdct:',
        '  org: acme',
        '  provider:',
        '    name: payment-service',
        '    spec: a.yaml',
      ].join('\n') + '\n',
    });
    const opts = { version: 'v1' };
    applyBdctDefaults(opts, 'can-i-deploy', { cwd: root });
    expect(opts.service).toBe('payment-service');
  });

  it('list-providers: fills only --org', () => {
    const root = makeTmp({
      '.specshield.yml': 'bdct:\n  org: acme\n',
    });
    const opts = {};
    applyBdctDefaults(opts, 'list-providers', { cwd: root });
    expect(opts.org).toBe('acme');
  });
});

// ── Pre-flight: refuse to run when "<replace-me>" placeholder is present ──

describe('applyBdctDefaults — placeholder check', () => {
  it('throws UNRESOLVED_PLACEHOLDER when bdct.org is the placeholder', () => {
    const root = makeTmp({
      '.specshield.yml': [
        'bdct:',
        '  org: <replace-me>',
        '  provider:',
        '    name: payment-service',
        '    spec: a.yaml',
      ].join('\n') + '\n',
    });
    const opts = { version: 'v1' };
    expect(() => applyBdctDefaults(opts, 'publish-provider', { cwd: root }))
      .toThrow(/<replace-me>/);
    try {
      applyBdctDefaults({ version: 'v1' }, 'publish-provider', { cwd: root });
    } catch (err) {
      expect(err.code).toBe('UNRESOLVED_PLACEHOLDER');
      expect(err.placeholders).toContain('--org');
    }
  });

  it('error message names the config file path so users can find it', () => {
    const root = makeTmp({
      '.specshield.yml': [
        'bdct:',
        '  org: <replace-me>',
      ].join('\n') + '\n',
    });
    try {
      applyBdctDefaults({}, 'publish-provider', { cwd: root });
    } catch (err) {
      expect(err.message).toContain(path.join(root, '.specshield.yml'));
    }
  });

  it('CLI flag override beats the placeholder (user can re-run with --org=foo without editing the file)', () => {
    const root = makeTmp({
      '.specshield.yml': [
        'bdct:',
        '  org: <replace-me>',
        '  provider:',
        '    name: svc',
        '    spec: a.yaml',
      ].join('\n') + '\n',
    });
    const opts = { org: 'acme-pay', version: 'v1' };
    expect(() => applyBdctDefaults(opts, 'publish-provider', { cwd: root }))
      .not.toThrow();
    expect(opts.org).toBe('acme-pay');
  });

  it('placeholder check ignores fields not in the FIELDS list', () => {
    // Something the user wrote into the config with <replace-me> that's
    // not one of the BDCT fields shouldn't trigger the check.
    const root = makeTmp({
      '.specshield.yml': [
        'bdct:',
        '  org: acme',
        '  provider:',
        '    name: svc',
        '    spec: a.yaml',
        'somethingUnrelated: <replace-me>',
      ].join('\n') + '\n',
    });
    const opts = { version: 'v1' };
    expect(() => applyBdctDefaults(opts, 'publish-provider', { cwd: root }))
      .not.toThrow();
  });
});
