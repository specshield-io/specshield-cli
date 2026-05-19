'use strict';

/**
 * Tests for `specshield whoami`. Mocks axios so we don't reach a real server.
 * The command itself calls into commander's `.action`, so we exercise the
 * exported Command directly via `parseAsync` — same pattern other command
 * tests in this repo use.
 */

const path = require('path');
const cp   = require('child_process');
const fs   = require('fs');
const os   = require('os');

const CLI = path.join(__dirname, '..', 'bin', 'specshield.js');

// Each spawnSync would deadlock with the in-process mock server (single
// event loop, blocked while waiting for the subprocess). We use spawn +
// Promise so the parent stays responsive while the child makes its HTTP
// calls back to us.
function runCLI(args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = cp.spawn('node', [CLI, ...args], {
      // HOME is isolated to a fresh tmp dir so no stale ~/.specshield/config.json
      // bleeds into the test (otherwise the "no token" assertion would find
      // the developer's real stored key).
      env: { ...process.env, ...env, NO_COLOR: '1', HOME: env.HOME || isolatedHome },
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', reject);
    child.on('close', (status) => resolve({ stdout, stderr, status }));
  });
}

// Single shared isolated home for every test in this suite.
const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'whoami-home-'));

describe('specshield whoami', () => {

  // Test against a fake server that returns canned responses. We run the
  // real CLI binary as a subprocess and pipe args/env — most faithful to
  // how it executes for real users.

  let server, baseUrl;
  const http = require('http');

  beforeAll(() => new Promise((resolve) => {
    server = http.createServer((req, res) => {
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/auth/validate-api-key') {
        const key = req.headers['x-api-key'];
        if (key === 'ss_valid') {
          res.end(JSON.stringify({ valid: true, name: 'Aarav', email: 'aarav@example.com', plan: 'FREE', customerId: 'cust_aarav' }));
        } else {
          res.statusCode = 401;
          res.end(JSON.stringify({ error: 'invalid token' }));
        }
      } else if (req.url === '/me/orgs') {
        res.end(JSON.stringify([
          { id: 100, orgKey: 'acme-pay',  name: 'Acme Payments',  myRole: 'MEMBER' },
          { id: 200, orgKey: 'acme-data', name: 'Acme Data',      myRole: 'OWNER'  },
        ]));
      } else {
        res.statusCode = 404;
        res.end('{}');
      }
    });
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  }));

  afterAll(() => new Promise((resolve) => server.close(resolve)));

  it('exits 2 with a friendly error when no token is available', async () => {
    const r = await runCLI(['whoami', '--server', baseUrl], { SPECSHIELD_API_KEY: '' });
    expect(r.status).toBe(2);
    expect(r.stderr + r.stdout).toMatch(/Not logged in/);
  });

  it('rejects an invalid token with exit code 2', async () => {
    const r = await runCLI(['whoami', '--server', baseUrl, '--api-token', 'ss_invalid']);
    expect(r.status).toBe(2);
    expect(r.stderr + r.stdout).toMatch(/Failed to validate token/);
  });

  it('prints identity + every org with its orgKey for a valid token', async () => {
    const r = await runCLI(['whoami', '--server', baseUrl, '--api-token', 'ss_valid']);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/Logged in as:/);
    expect(r.stdout).toMatch(/Aarav/);
    expect(r.stdout).toMatch(/aarav@example\.com/);
    expect(r.stdout).toMatch(/FREE/);
    expect(r.stdout).toMatch(/acme-pay/);
    expect(r.stdout).toMatch(/acme-data/);
    expect(r.stdout).toMatch(/MEMBER/);
    expect(r.stdout).toMatch(/OWNER/);
  });

  it('--json emits a machine-readable shape with customer + orgs', async () => {
    const r = await runCLI(['whoami', '--server', baseUrl, '--api-token', 'ss_valid', '--json']);
    expect(r.status).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.customer).toMatchObject({ name: 'Aarav', email: 'aarav@example.com', plan: 'FREE' });
    expect(parsed.orgs).toEqual([
      { orgKey: 'acme-pay',  name: 'Acme Payments',  role: 'MEMBER' },
      { orgKey: 'acme-data', name: 'Acme Data',      role: 'OWNER'  },
    ]);
    expect(parsed.server).toBe(baseUrl);
  });

  it('--api-token flag overrides env var', async () => {
    const r = await runCLI(
      ['whoami', '--server', baseUrl, '--api-token', 'ss_valid'],
      { SPECSHIELD_API_KEY: 'ss_invalid' },
    );
    expect(r.status).toBe(0);
  });

  it('env var works when no --api-token is passed', async () => {
    const r = await runCLI(['whoami', '--server', baseUrl], { SPECSHIELD_API_KEY: 'ss_valid' });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/Aarav/);
  });

  it('prints a "no orgs" hint when the user is in zero orgs', async () => {
    // Spin up a second mini-server that returns [] for /me/orgs.
    const empty = http.createServer((req, res) => {
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/auth/validate-api-key') {
        res.end(JSON.stringify({ valid: true, name: 'Solo', email: 's@x.com', plan: 'FREE' }));
      } else if (req.url === '/me/orgs') {
        res.end('[]');
      } else { res.statusCode = 404; res.end('{}'); }
    });
    await new Promise(resolve => empty.listen(0, '127.0.0.1', resolve));
    try {
      const url = `http://127.0.0.1:${empty.address().port}`;
      const r = await runCLI(['whoami', '--server', url, '--api-token', 'ss_valid']);
      expect(r.status).toBe(0);
      expect(r.stdout).toMatch(/not a member of any organization/i);
    } finally {
      await new Promise(resolve => empty.close(resolve));
    }
  });
});
