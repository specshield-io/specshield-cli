'use strict';

/**
 * Tests for `specshield share`. Runs the real CLI binary as a subprocess
 * against a local fake server (same pattern as whoami.test.js), exercising
 * the /api/share-links path that replaced the old "UI-only" stub.
 */

const path = require('path');
const cp   = require('child_process');
const fs   = require('fs');
const os   = require('os');

const CLI = path.join(__dirname, '..', 'bin', 'specshield.js');
const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'share-home-'));

// Child processes must render WITHOUT colour: every assertion below matches plain
// substrings of stdout. NO_COLOR alone is not enough — chalk gives FORCE_COLOR
// precedence over NO_COLOR, and `...process.env` carries the parent's value into the
// child, so a developer or CI with FORCE_COLOR set would get ANSI escapes in stdout
// and these tests would fail with "expected" and "received" looking identical.
function runCLI(args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = cp.spawn('node', [CLI, ...args], {
      env: { ...process.env, ...env, NO_COLOR: '1', FORCE_COLOR: '0', HOME: env.HOME || isolatedHome },
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', reject);
    child.on('close', (status) => resolve({ stdout, stderr, status }));
  });
}

describe('specshield share', () => {
  let server, baseUrl, lastShareBody;
  const http = require('http');

  beforeAll(() => new Promise((resolve) => {
    server = http.createServer((req, res) => {
      res.setHeader('Content-Type', 'application/json');
      if (req.method === 'POST' && req.url === '/api/share-links') {
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
          lastShareBody = JSON.parse(body || '{}');
          // 404 simulates "not found or not owned" for a sentinel id.
          if (lastShareBody.reportId === 999) {
            res.statusCode = 404;
            res.end(JSON.stringify({ message: 'Comparison report 999 not found or you don\'t own it' }));
            return;
          }
          res.statusCode = 201;
          res.end(JSON.stringify({
            id: 7,
            token: 'tok_test',
            url: 'https://specshield.io/r/tok_test',
            expiresAt: lastShareBody.expiresInDays ? '2026-07-12T00:00:00Z' : null,
            createdAt: '2026-06-12T00:00:00Z',
          }));
        });
      } else {
        res.statusCode = 404;
        res.end('{}');
      }
    });
    server.listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  }));

  afterAll(() => new Promise((resolve) => server.close(resolve)));

  it('nudges signup and exits 2 when no API key is available', async () => {
    const r = await runCLI(['share', '482', '--api-url', baseUrl], { SPECSHIELD_API_KEY: '' });
    expect(r.status).toBe(2);
    expect(r.stdout + r.stderr).toMatch(/Cloud feature|specshield login/i);
  });

  it('creates a share link for an existing report id and prints the URL', async () => {
    const r = await runCLI(['share', '482', '--api-url', baseUrl, '--api-key', 'ss_valid']);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/Share link ready/);
    expect(r.stdout).toMatch(/https:\/\/specshield\.io\/r\/tok_test/);
    expect(lastShareBody.reportId).toBe(482); // sent as a number, not a string
  });

  it('passes --expires through as expiresInDays', async () => {
    const r = await runCLI(['share', '482', '--api-url', baseUrl, '--api-key', 'ss_valid', '--expires', '30']);
    expect(r.status).toBe(0);
    expect(lastShareBody.expiresInDays).toBe(30);
    expect(r.stdout).toMatch(/Expires:/);
  });

  it('rejects a non-numeric report id with a clear message', async () => {
    const r = await runCLI(['share', 'not-a-number', '--api-url', baseUrl, '--api-key', 'ss_valid']);
    expect(r.status).toBe(2);
    expect(r.stdout + r.stderr).toMatch(/Invalid report ID/i);
  });

  it('surfaces a 404 (not found / not owned) as a failure, not a crash', async () => {
    const r = await runCLI(['share', '999', '--api-url', baseUrl, '--api-key', 'ss_valid']);
    expect(r.status).toBe(2);
    expect(r.stdout + r.stderr).toMatch(/Share failed|Could not generate/i);
  });
});
