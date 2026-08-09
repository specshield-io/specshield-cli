'use strict';

/**
 * Tests for the `specshield bdct verify` issue list. Runs the real CLI binary as
 * a subprocess against a local fake server that emulates GET /api/bdct/verify,
 * the same integration-style pattern as govern.test.js / history.test.js.
 *
 * Regression guard: the issue line used to print only the field
 * (`issue.field || issue.path || issue.endpoint`). One field can be read from
 * several endpoints, so two genuinely distinct findings rendered as identical
 * lines — a `receiptUrl` removal reported once for `POST /payments` and once for
 * `GET /payments/{paymentId}` both printed as "RESPONSE_FIELD_MISSING at
 * $.receiptUrl". It read like the CLI was double-printing a bug rather than
 * reporting two real problems.
 */

const path = require('path');
const cp   = require('child_process');
const fs   = require('fs');
const os   = require('os');

const CLI = path.join(__dirname, '..', 'bin', 'specshield.js');
const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'bdct-home-'));

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

function verifyServer(payload) {
  const http = require('http');
  return http.createServer((req, res) => {
    if (req.url.startsWith('/api/bdct/verify')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload));
      return;
    }
    res.writeHead(404); res.end('{}');
  });
}

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
  });
}

// Mirrors the real backend shape: resultJson is a JSON *string* of
// [{ endpoint, status, mismatches: [...] }]. Each mismatch carries its own
// `endpoint` (see BdctMismatch in the backend engine).
const TWO_ENDPOINTS_ONE_FIELD = {
  id: 57,
  status: 'INCOMPATIBLE',
  resultJson: JSON.stringify([
    {
      endpoint: 'POST /payments',
      status: 'INCOMPATIBLE',
      mismatches: [{
        endpoint: 'POST /payments',
        type: 'RESPONSE_FIELD_MISSING',
        field: '$.receiptUrl',
        consumerExpects: 'string',
        severity: 'ERROR',
      }],
    },
    {
      endpoint: 'GET /payments/{paymentId}',
      status: 'INCOMPATIBLE',
      mismatches: [{
        endpoint: 'GET /payments/{paymentId}',
        type: 'RESPONSE_FIELD_MISSING',
        field: '$.receiptUrl',
        consumerExpects: 'string',
        severity: 'ERROR',
      }],
    },
  ]),
};

const ARGS = (server) => [
  'bdct', 'verify',
  '--org', 'org_test',
  '--consumer', 'checkout-bff',
  '--provider', 'payment-service',
  '--consumer-version', '1.2.0',
  '--provider-version', '3.0.0',
  '--server', server,
  '--api-token', 'test-key',
];

describe('bdct verify — issue list', () => {
  let server, url;

  afterEach(() => { if (server) server.close(); server = null; });

  test('same field on two endpoints renders as two distinguishable lines', async () => {
    server = verifyServer(TWO_ENDPOINTS_ONE_FIELD);
    url = await listen(server);

    const r = await runCLI(ARGS(url));

    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/INCOMPATIBLE/);

    const issueLines = r.stdout
      .split('\n')
      .filter(l => l.includes('RESPONSE_FIELD_MISSING'));

    expect(issueLines).toHaveLength(2);

    // Both endpoints must be named, or the two lines are indistinguishable.
    expect(r.stdout).toContain('POST /payments');
    expect(r.stdout).toContain('GET /payments/{paymentId}');

    // And the field is still shown alongside it.
    expect(r.stdout).toContain('$.receiptUrl');

    // The actual regression: the two lines must not be byte-identical.
    expect(issueLines[0].trim()).not.toBe(issueLines[1].trim());
  });

  test('falls back to the endpoint alone when a finding has no field', async () => {
    server = verifyServer({
      id: 58,
      status: 'INCOMPATIBLE',
      resultJson: JSON.stringify([{
        endpoint: 'GET /payments',
        status: 'INCOMPATIBLE',
        mismatches: [{
          endpoint: 'GET /payments',
          type: 'ENDPOINT_MISSING',
          field: null,
          severity: 'ERROR',
        }],
      }]),
    });
    url = await listen(server);

    const r = await runCLI(ARGS(url));

    expect(r.stdout).toMatch(/ENDPOINT_MISSING/);
    expect(r.stdout).toContain('GET /payments');
    // No stray placeholder when there is no field to show.
    expect(r.stdout).not.toMatch(/ENDPOINT_MISSING at \s*\$\s*$/m);
  });

  test('warnings are marked but do not change the exit code on their own', async () => {
    server = verifyServer({
      id: 59,
      status: 'COMPATIBLE',
      resultJson: JSON.stringify([{
        endpoint: 'POST /payments',
        status: 'COMPATIBLE',
        mismatches: [{
          endpoint: 'POST /payments',
          type: 'REQUEST_FIELD_MISSING',
          field: '$.couponCode',
          consumerExpects: 'string',
          severity: 'WARNING',
        }],
      }]),
    });
    url = await listen(server);

    const r = await runCLI(ARGS(url));

    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/COMPATIBLE/);
    expect(r.stdout).toContain('REQUEST_FIELD_MISSING');
    expect(r.stdout).toContain('POST /payments');
  });
});
