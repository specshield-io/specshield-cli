'use strict';

/**
 * Tests for `specshield govern`. Runs the real CLI binary as a subprocess
 * against a local fake server that emulates POST /api/governance/gate, the
 * same integration-style pattern as history.test.js / whoami.test.js.
 */

const path = require('path');
const cp   = require('child_process');
const fs   = require('fs');
const os   = require('os');

const CLI = path.join(__dirname, '..', 'bin', 'specshield.js');
const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'govern-home-'));

// A tiny valid spec file for the CLI to read and send as `spec`.
const specFile = path.join(isolatedHome, 'openapi.yaml');
fs.writeFileSync(specFile, 'openapi: "3.0.0"\ninfo: { title: t, version: "1.0.0" }\npaths: {}\n');

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

// Fake gate server. `respond(body)` lets each test control the last request it saw.
function gateServer(handler) {
  const http = require('http');
  return http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/api/governance/gate') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const parsed = body ? JSON.parse(body) : {};
        const { status, json } = handler(parsed, req);
        res.statusCode = status;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(json));
      });
    } else {
      res.statusCode = 404;
      res.end('{}');
    }
  });
}

function passVerdict(overrides = {}) {
  return {
    passed: true,
    reasons: [],
    scoreThreshold: 70,
    recommendedAction: '',
    waivedCount: 0,
    review: {
      findings: [{ ruleId: 'operation-operation-id', severity: 'info', message: 'missing operationId', suggestedFix: null, location: '$.paths' }],
      errorCount: 0, warningCount: 0, infoCount: 1,
      score: { value: 92, grade: 'A' },
      summary: 'ok',
    },
    ...overrides,
  };
}

function failVerdict() {
  return {
    passed: false,
    reasons: ['score 55 is below the minimum of 70', '2 error-severity findings'],
    scoreThreshold: 70,
    recommendedAction: 'Fix the error-severity findings, then re-run the gate.',
    waivedCount: 0,
    review: {
      findings: [
        { ruleId: 'security-scheme-missing', severity: 'error', message: 'operation has no security', suggestedFix: 'add security', location: '$.paths./x.get' },
        { ruleId: 'no-http-basic', severity: 'error', message: 'basic auth', suggestedFix: null, location: '$.components' },
      ],
      errorCount: 2, warningCount: 0, infoCount: 0,
      score: { value: 55, grade: 'D' },
      summary: 'fail',
    },
  };
}

let server, baseUrl, lastBody, handlerRef;
beforeAll(() => new Promise((resolve) => {
  server = gateServer((body, req) => { lastBody = body; return handlerRef(body, req); });
  server.listen(0, '127.0.0.1', () => {
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    resolve();
  });
}));
afterAll(() => new Promise((resolve) => server.close(resolve)));
beforeEach(() => { lastBody = null; handlerRef = () => ({ status: 200, json: passVerdict() }); });

describe('specshield govern', () => {
  it('exits 2 when no API token is available', async () => {
    const r = await runCLI(['govern', specFile, '--server', baseUrl], { SPECSHIELD_API_KEY: '' });
    expect(r.status).toBe(2);
    expect(r.stdout + r.stderr).toMatch(/No API token found|specshield login/i);
  });

  it('passes the gate → exit 0, shows PASS + score/grade', async () => {
    handlerRef = () => ({ status: 200, json: passVerdict() });
    const r = await runCLI(['govern', specFile, '--server', baseUrl, '--api-token', 'ss_x']);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/PASS/);
    expect(r.stdout).toMatch(/Score 92\/100 · grade A/);
    // spec content was sent in the request body
    expect(lastBody.spec).toMatch(/openapi/);
  });

  it('fails the gate → exit 1, shows FAIL + reasons', async () => {
    handlerRef = () => ({ status: 200, json: failVerdict() });
    const r = await runCLI(['govern', specFile, '--server', baseUrl, '--api-token', 'ss_x']);
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/FAIL/);
    expect(r.stdout).toMatch(/below the minimum of 70/);
    expect(r.stdout).toMatch(/security-scheme-missing/);
  });

  it('--advisory reports a failing gate but still exits 0', async () => {
    handlerRef = () => ({ status: 200, json: failVerdict() });
    const r = await runCLI(['govern', specFile, '--server', baseUrl, '--api-token', 'ss_x', '--advisory']);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/FAIL/);
  });

  it('builds the policy from flags (min-score, fail-on-warning, no-fail-on-error)', async () => {
    const r = await runCLI(['govern', specFile, '--server', baseUrl, '--api-token', 'ss_x',
      '--min-score', '85', '--fail-on-warning', '--no-fail-on-error']);
    expect(r.status).toBe(0);
    expect(lastBody.policy).toEqual({ minScore: 85, failOnWarning: true, failOnError: false });
  });

  it('omits policy entirely when no policy flags are passed (server defaults apply)', async () => {
    await runCLI(['govern', specFile, '--server', baseUrl, '--api-token', 'ss_x']);
    expect(lastBody.policy).toBeNull();
  });

  it('sends the ruleset content and orgKey when provided', async () => {
    const rulesetFile = path.join(isolatedHome, 'ruleset.yaml');
    fs.writeFileSync(rulesetFile, 'rules:\n  my-rule: true\n');
    await runCLI(['govern', specFile, '--server', baseUrl, '--api-token', 'ss_x',
      '--ruleset', rulesetFile, '--org', 'acme']);
    expect(lastBody.ruleset).toMatch(/my-rule/);
    expect(lastBody.orgKey).toBe('acme');
  });

  it('--json emits the raw gate response', async () => {
    handlerRef = () => ({ status: 200, json: passVerdict() });
    const r = await runCLI(['govern', specFile, '--server', baseUrl, '--api-token', 'ss_x', '--json']);
    expect(r.status).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed).toMatchObject({ passed: true, review: { score: { grade: 'A' } } });
  });

  it('gives a friendly message + exit 2 on 402 (paid plan required)', async () => {
    handlerRef = () => ({ status: 402, json: { message: 'Governance gate requires a paid plan (Team or above).' } });
    const r = await runCLI(['govern', specFile, '--server', baseUrl, '--api-token', 'ss_x']);
    expect(r.status).toBe(2);
    expect(r.stdout + r.stderr).toMatch(/paid plan/i);
  });
});
