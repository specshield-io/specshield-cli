'use strict';

/**
 * `--remote-url` is documented as a BASE url. It used to be handed to axios
 * verbatim, so `--remote-url https://host` POSTed to the site root, got a web
 * page or a 405 back, and the CLI failed with "Cannot read properties of
 * undefined (reading 'filter')" — a stack trace where an explanation belonged.
 *
 * Two guards here: the URL is resolved to the /compare endpoint, and a response
 * that is not a comparison result produces a readable error instead of a
 * TypeError from somewhere deep in the pipeline.
 */

const path = require('path');
const cp   = require('child_process');
const fs   = require('fs');
const os   = require('os');
const http = require('http');

const { resolveRemoteUrl } = require('../src/core/remoteUrl');
const CLI = path.join(__dirname, '..', 'bin', 'specshield.js');
const HOSTED = 'https://specshield.io';

describe('resolveRemoteUrl', () => {
  test('appends /compare to a base url', () => {
    expect(resolveRemoteUrl('https://api.specshield.io', HOSTED))
      .toBe('https://api.specshield.io/compare');
  });

  test('tolerates a trailing slash', () => {
    expect(resolveRemoteUrl('https://api.specshield.io/', HOSTED))
      .toBe('https://api.specshield.io/compare');
  });

  test('leaves a full endpoint alone, so existing workarounds keep working', () => {
    expect(resolveRemoteUrl('https://api.specshield.io/compare', HOSTED))
      .toBe('https://api.specshield.io/compare');
  });

  test('falls back to the hosted default', () => {
    expect(resolveRemoteUrl(undefined, HOSTED)).toBe(HOSTED + '/compare');
  });
});

describe('remote compare against a server that is not the compare API', () => {
  let server, baseUrl, dir, a, b;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-remote-'));
    a = path.join(dir, 'a.json');
    b = path.join(dir, 'b.json');
    const spec = (paths) => JSON.stringify({ openapi: '3.0.0', info: { title: 't', version: '1' }, paths });
    fs.writeFileSync(a, spec({ '/gone': { get: { responses: { 200: { description: 'ok' } } } } }));
    fs.writeFileSync(b, spec({}));

    // Answers every path with a web page — what a misrouted base URL really returns.
    server = http.createServer((req, res) => {
      req.resume();                       // drain the POST body or the request stalls
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<!doctype html><html><body>SpecShield</body></html>');
      });
    });
    baseUrl = await new Promise((r) =>
      server.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${server.address().port}`)));
  });

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    return new Promise((r) => server.close(r));
  });

  // spawnSync would block this process's event loop, so the server above could
  // never accept the connection and the CLI would just time out.
  function runCLI(args) {
    return new Promise((resolve, reject) => {
      const child = cp.spawn('node', [CLI, ...args],
        { env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' } });
      let stdout = '', stderr = '';
      child.stdout.on('data', (d) => { stdout += d.toString(); });
      child.stderr.on('data', (d) => { stderr += d.toString(); });
      child.on('error', reject);
      child.on('close', (status) => resolve({ stdout, stderr, status }));
    });
  }

  test('explains the problem instead of throwing a TypeError', async () => {
    const { stderr, status } = await runCLI(
      ['compare', a, b, '--remote', '--remote-url', baseUrl, '--api-key', 'ss_test']);

    expect(stderr).not.toMatch(/Cannot read properties of undefined/);
    expect(stderr).toMatch(/returned a web page, not the compare API/);
    expect(status).toBe(2);
  }, 20000);
});
