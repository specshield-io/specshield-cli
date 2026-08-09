'use strict';

/**
 * Tests for `specshield history`. Runs the real CLI binary as a subprocess
 * against a local fake server (same pattern as whoami.test.js), exercising
 * the /api/compare-history path (PagedResponse) that replaced the old
 * "UI-only" stub.
 */

const path = require('path');
const cp   = require('child_process');
const fs   = require('fs');
const os   = require('os');

const CLI = path.join(__dirname, '..', 'bin', 'specshield.js');
const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'history-home-'));

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

function pagedServer(content) {
  const http = require('http');
  return http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url.startsWith('/api/compare-history')) {
      res.end(JSON.stringify({
        content,
        page: 0, size: 20,
        totalElements: content.length,
        totalPages: content.length ? 1 : 0,
        last: true,
      }));
    } else {
      res.statusCode = 404;
      res.end('{}');
    }
  });
}

describe('specshield history', () => {
  const rows = [
    { id: 42, baseSpecName: 'a.yaml', targetSpecName: 'b.yaml', breakingCount: 0, createdAt: '2026-06-01T00:00:00Z' },
    { id: 43, baseSpecName: 'v1.yaml', targetSpecName: 'v2.yaml', breakingCount: 3, createdAt: '2026-06-02T00:00:00Z' },
  ];

  let server, baseUrl;
  beforeAll(() => new Promise((resolve) => {
    server = pagedServer(rows);
    server.listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  }));
  afterAll(() => new Promise((resolve) => server.close(resolve)));

  it('nudges signup and exits 2 when no API key is available', async () => {
    const r = await runCLI(['history', '--api-url', baseUrl], { SPECSHIELD_API_KEY: '' });
    expect(r.status).toBe(2);
    expect(r.stdout + r.stderr).toMatch(/Cloud feature|specshield login/i);
  });

  it('lists comparisons from /api/compare-history', async () => {
    const r = await runCLI(['history', '--api-url', baseUrl, '--api-key', 'ss_valid']);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/Your recent comparisons/);
    expect(r.stdout).toMatch(/a\.yaml → b\.yaml/);
    expect(r.stdout).toMatch(/v1\.yaml → v2\.yaml/);
    expect(r.stdout).toMatch(/3 breaking/);
  });

  it('--json emits the raw items array', async () => {
    const r = await runCLI(['history', '--api-url', baseUrl, '--api-key', 'ss_valid', '--json']);
    expect(r.status).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0]).toMatchObject({ id: 42, baseSpecName: 'a.yaml' });
  });

  it('prints an empty-state hint when there is no history', async () => {
    const empty = pagedServer([]);
    await new Promise((resolve) => empty.listen(0, '127.0.0.1', resolve));
    try {
      const url = `http://127.0.0.1:${empty.address().port}`;
      const r = await runCLI(['history', '--api-url', url, '--api-key', 'ss_valid']);
      expect(r.status).toBe(0);
      expect(r.stdout).toMatch(/No comparisons in your history yet/);
    } finally {
      await new Promise((resolve) => empty.close(resolve));
    }
  });
});
