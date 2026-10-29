'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, spawnSync, execFileSync } = require('child_process');

const W = require('../src/core/gate/waivers');
const { ciContext } = require('../src/core/gate/baseline');
const { runGate } = require('../src/core/gate/runGate');

const bin = path.join(__dirname, '..', 'bin', 'specshield.js');
const NOW = Date.parse('2026-10-27T12:00:00Z');

// The suite itself may run in GitHub Actions: never let the runner's own
// event leak into a gate under test, and never let a developer's global git
// config (signing, hooks, default branch) change what git does here.
function cleanEnv(extra = {}) {
  const env = { ...process.env };
  for (const k of Object.keys(env)) {
    if (/^(GITHUB_|GITLAB_|BITBUCKET_|CI_)/.test(k) || /^(https?|all)_proxy$/i.test(k)) delete env[k];
  }
  delete env.CI;
  return {
    ...env, FORCE_COLOR: '0', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', ...extra,
  };
}

const git = (cwd, ...args) => execFileSync('git', args, { cwd, env: cleanEnv(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

const SPEC = `openapi: 3.0.3
info: {title: Pets, version: 1.0.0}
paths:
  /pets:
    get:
      responses:
        '200':
          description: ok
          content:
            application/json:
              schema:
                type: array
                items: {$ref: '#/components/schemas/Pet'}
  /pets/{id}:
    get:
      parameters: [{name: id, in: path, required: true, schema: {type: string}}]
      responses:
        '200':
          description: ok
          content:
            application/json:
              schema: {$ref: '#/components/schemas/Pet'}
components:
  schemas:
    Pet:
      type: object
      properties:
        id: {type: string}
        name: {type: string}
        legacy_id: {type: integer}
`;
const dropLegacy = (s) => s.replace('        legacy_id: {type: integer}\n', '');
const addOwners = (s) => s.replace('components:', "  /owners:\n    get:\n      responses:\n        '200': {description: ok}\ncomponents:");
const dropPetById = (s) => s.slice(0, s.indexOf('  /pets/{id}:')) + s.slice(s.indexOf('components:'));

/**
 * origin (bare) + work clone. main: v1, then /owners added after `feature`
 * forked; feature: legacy_id removed. A gate against main's tip would also
 * report /owners as removed — the merge-base baseline must not.
 */
function scenario() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-gate-'));
  const origin = path.join(root, 'origin.git');
  const work = path.join(root, 'work');
  git(root, 'init', '-q', '--bare', origin);
  git(root, 'clone', '-q', origin, work);
  git(work, 'checkout', '-q', '-b', 'main');
  fs.writeFileSync(path.join(work, 'openapi.yaml'), SPEC);
  git(work, 'add', '.'); git(work, 'commit', '-qm', 'v1'); git(work, 'push', '-q', 'origin', 'main');
  git(work, 'checkout', '-q', '-b', 'feature');
  fs.writeFileSync(path.join(work, 'openapi.yaml'), dropLegacy(SPEC));
  git(work, 'commit', '-qam', 'drop legacy_id');
  git(work, 'checkout', '-q', 'main');
  fs.writeFileSync(path.join(work, 'openapi.yaml'), addOwners(SPEC));
  git(work, 'commit', '-qam', 'add owners'); git(work, 'push', '-q', 'origin', 'main', 'feature');
  git(work, 'checkout', '-q', 'feature');
  git(work, 'remote', 'set-head', 'origin', 'main');
  return { root, origin, work };
}

const write = (dir, rel, text) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); };

const WAIVER = (extra = '') => `waivers:
  - change: response-field-removed
    field: legacy_id
    owner: "@alice"
    reason: Clients stopped reading legacy_id in v4.2
    created: "2026-10-20"
    expires: "2026-11-30"
${extra}`;

// ─── waivers ────────────────────────────────────────────────────────────────

describe('waivers: validation', () => {
  const v = (w, opts = {}) => W.validate(w, 0, { now: NOW, ...opts });
  const ok = { change: 'endpoint-removed', owner: '@a', reason: 'Nobody calls it since July', expires: '2026-11-30' };

  test('a complete waiver is valid; SCREAMING_SNAKE types are accepted', () => {
    expect(v(ok).errors).toEqual([]);
    expect(v({ ...ok, change: 'ENDPOINT_REMOVED' }).change).toBe('endpoint-removed');
  });

  test('owner, reason and expires are required', () => {
    const errs = v({ change: 'endpoint-removed' }).errors.join(' | ');
    expect(errs).toMatch(/owner is required/);
    expect(errs).toMatch(/reason is required/);
    expect(errs).toMatch(/expires is required/);
    expect(v({ ...ok, reason: 'because' }).errors.join()).toMatch(/too short/);
  });

  test('expiry is capped: from created, else from today', () => {
    expect(v({ ...ok, expires: '2027-06-01' }).errors.join()).toMatch(/more than 90 days after today/);
    expect(v({ ...ok, created: '2026-01-01', expires: '2026-05-01' }).errors.join()).toMatch(/more than 90 days after created/);
    expect(v({ ...ok, expires: '2027-06-01' }, { maxDays: 365 }).errors).toEqual([]);
    expect(v({ ...ok, expires: 'soon' }).errors.join()).toMatch(/must be a date/);
  });

  test('YAML dates (unquoted) are read as dates', () => {
    const { waivers } = W.parseWaivers('waivers:\n  - {change: endpoint-removed, owner: a, reason: "long enough reason", expires: 2026-11-30}\n', { now: NOW });
    expect(waivers[0].expires).toBe('2026-11-30');
    expect(waivers[0].errors).toEqual([]);
  });

  test('a wildcard type needs an operation', () => {
    expect(v({ ...ok, change: '*' }).errors.join()).toMatch(/needs an operation/);
    expect(v({ ...ok, change: '*', operation: 'DELETE /pets/{id}' }).errors).toEqual([]);
  });

  test('status: active, expiring within 7 days, expired the day after expires', () => {
    expect(W.status(v(ok), NOW)).toBe('active');
    expect(W.status(v({ ...ok, expires: '2026-11-02' }), NOW)).toBe('expiring');
    expect(W.status(v({ ...ok, expires: '2026-10-27' }), NOW)).toBe('expiring');
    expect(W.status(v({ ...ok, created: '2026-09-01', expires: '2026-10-26' }), NOW)).toBe('expired');
    expect(W.status(v({}), NOW)).toBe('invalid');
  });

  test('bad YAML throws; an empty file or no list is no waivers', () => {
    expect(() => W.parseWaivers('waivers: [', { now: NOW })).toThrow(/not valid YAML/);
    expect(W.parseWaivers('', { now: NOW }).waivers).toEqual([]);
    expect(() => W.parseWaivers('waivers: {a: 1}', { now: NOW })).toThrow(/must be a list/);
  });
});

describe('waivers: matching', () => {
  const w = (extra) => W.validate({ change: 'response-field-removed', owner: '@a', reason: 'long enough reason', expires: '2026-11-30', ...extra }, 0, { now: NOW });
  const change = { type: 'RESPONSE_FIELD_REMOVED', method: 'get', path: '/pets/{id}', field: 'responses.200.legacy_id' };
  const merged = { ...change, affectedEndpoints: ['GET /pets', 'GET /pets/{id}'] };

  test('type, field leaf and dotted suffix', () => {
    expect(W.matches(w({}), change)).toBe(true);
    expect(W.matches(w({ field: 'legacy_id' }), change)).toBe(true);
    expect(W.matches(w({ field: '200.legacy_id' }), change)).toBe(true);
    expect(W.matches(w({ field: 'id' }), change)).toBe(false);
    expect(W.matches(w({ change: 'endpoint-removed' }), change)).toBe(false);
  });

  test('backend field paths match too (array marker, parameter location)', () => {
    expect(W.matches(w({ field: 'tags' }), { ...change, field: 'responses.200.tags[]' })).toBe(true);
    const p = W.validate({ change: 'parameter-removed', owner: '@a', reason: 'long enough reason', expires: '2026-11-30', field: 'limit' }, 0, { now: NOW });
    expect(W.matches(p, { type: 'PARAMETER_REMOVED', method: 'get', path: '/pets', field: 'parameters.query:limit' })).toBe(true);
  });

  test('operation must cover every endpoint the change affects', () => {
    expect(W.matches(w({ operation: 'GET /pets/{id}' }), change)).toBe(true);
    expect(W.matches(w({ operation: 'GET /pets/{petId}' }), change)).toBe(true);
    expect(W.matches(w({ operation: 'GET /pets/{id}' }), merged)).toBe(false);
    expect(W.matches(w({ operation: 'GET /pets/**' }), merged)).toBe(true);
    expect(W.matches(w({ operation: 'GET /pets**' }), merged)).toBe(false);
    expect(W.matches(w({ operation: '/**' }), merged)).toBe(true);
    expect(W.matches(w({ operation: 'POST /pets/{id}' }), change)).toBe(false);
    expect(W.matches(w({ operation: '/pets/*' }), change)).toBe(true);
  });

  test('glob semantics', () => {
    expect(W.pathMatches('/pets/**', '/pets')).toBe(true);
    expect(W.pathMatches('/pets/**', '/pets/1/photo')).toBe(true);
    expect(W.pathMatches('/pets/*', '/pets/1/photo')).toBe(false);
    expect(W.pathMatches('/pets/{id}', '/pets/{petId}')).toBe(true);
  });

  test('applyWaivers: active waives, expired keeps blocking and says why, invalid never applies', () => {
    const expired = w({ created: '2026-09-01', expires: '2026-10-01' });
    const invalid = W.validate({ change: 'response-field-removed' }, 1, { now: NOW });
    const r1 = W.applyWaivers([change], [expired, invalid], NOW);
    expect(r1.waived).toEqual([]);
    expect(r1.blocking[0].expiredWaiver).toMatchObject({ owner: '@a', expires: '2026-10-01', status: 'expired' });
    const r2 = W.applyWaivers([change], [expired, w({})], NOW);
    expect(r2.blocking).toEqual([]);
    expect(r2.waived[0].waiver).toMatchObject({ owner: '@a', status: 'active' });
  });

  test('newSince: added or edited waivers', () => {
    const a = w({});
    const b = w({ field: 'name' });
    expect(W.newSince([a, b], [a]).map((x) => x.field)).toEqual(['name']);
    expect(W.newSince([{ ...a, expires: '2026-12-01' }], [a])).toHaveLength(1);
  });

  test('suggestFor names exactly the change', () => {
    expect(W.suggestFor(change)).toEqual({ change: 'response-field-removed', operation: 'GET /pets/{id}', field: 'legacy_id' });
    expect(W.suggestFor(merged).operation).toBeNull();
  });
});

describe('waivers: writing', () => {
  test('addWaiver keeps existing comments and quotes owners and dates', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-waive-'));
    const file = path.join(dir, 'w.yml');
    fs.writeFileSync(file, '# keep me\nwaivers:\n  - change: endpoint-removed # inline\n    owner: bob\n    reason: Nobody calls it since July\n    expires: 2026-11-30\n');
    await W.addWaiver(file, { change: 'response-field-removed', field: 'legacy_id', owner: '@alice', reason: 'Clients stopped reading it', created: '2026-10-27', expires: '2026-11-26' });
    const text = fs.readFileSync(file, 'utf8');
    expect(text).toMatch(/^# keep me/);
    expect(text).toMatch(/# inline/);
    expect(text).toMatch(/owner: "@alice"/);
    expect(text).toMatch(/expires: "2026-11-26"/);
    const { waivers } = W.parseWaivers(text, { now: NOW });
    expect(waivers.map((x) => x.errors)).toEqual([[], []]);
  });
});

// ─── CI context ─────────────────────────────────────────────────────────────

describe('ciContext', () => {
  const event = (obj) => {
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ss-ev-')), 'e.json');
    fs.writeFileSync(f, JSON.stringify(obj));
    return f;
  };

  test('GitHub pull_request: PR base commit first, then origin/<base ref>', () => {
    const c = ciContext({ GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'pull_request', GITHUB_BASE_REF: 'main', GITHUB_REPOSITORY: 'acme/pets',
      GITHUB_EVENT_PATH: event({ pull_request: { number: 7, title: 'T', base: { sha: 'abc1234', ref: 'main' } } }) });
    expect(c).toMatchObject({ provider: 'github', event: 'pull_request', repo: 'acme/pets', pr: 7, title: 'T' });
    expect(c.candidates.map((x) => x.ref)).toEqual(['abc1234', 'origin/main']);
  });

  test('GitHub merge_group: queue base, PR number from the queue branch', () => {
    const c = ciContext({ GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'merge_group',
      GITHUB_EVENT_PATH: event({ merge_group: { base_sha: 'def5678', base_ref: 'refs/heads/main', head_ref: 'refs/heads/gh-readonly-queue/main/pr-42-0123abc' } }) });
    expect(c.pr).toBe(42);
    expect(c.candidates.map((x) => x.ref)).toEqual(['def5678', 'origin/main']);
  });

  test('GitHub push: the commit before; a new branch (zero sha) falls back', () => {
    expect(ciContext({ GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'push', GITHUB_EVENT_PATH: event({ before: 'aaa1111' }) }).candidates[0].ref).toBe('aaa1111');
    expect(ciContext({ GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'push', GITHUB_EVENT_PATH: event({ before: '0000000000' }) }).candidates).toEqual([]);
  });

  test('GitLab merge request and Bitbucket PR', () => {
    const gl = ciContext({ GITLAB_CI: 'true', CI_MERGE_REQUEST_IID: '12', CI_PROJECT_PATH: 'g/p', CI_MERGE_REQUEST_DIFF_BASE_SHA: 'bbb2222', CI_MERGE_REQUEST_TARGET_BRANCH_NAME: 'develop' });
    expect(gl).toMatchObject({ provider: 'gitlab', pr: 12, repo: 'g/p' });
    expect(gl.candidates.map((x) => x.ref)).toEqual(['bbb2222', 'origin/develop']);
    const bb = ciContext({ BITBUCKET_BUILD_NUMBER: '1', BITBUCKET_PR_ID: '3', BITBUCKET_PR_DESTINATION_BRANCH: 'main', BITBUCKET_REPO_FULL_NAME: 'w/r' });
    expect(bb).toMatchObject({ provider: 'bitbucket', pr: 3, repo: 'w/r' });
    expect(bb.candidates[0].ref).toBe('origin/main');
  });

  test('outside CI: local, no candidates', () => {
    expect(ciContext({})).toMatchObject({ provider: 'local', candidates: [] });
  });
});

// ─── runGate against real git history ───────────────────────────────────────

describe('runGate', () => {
  let s;
  beforeEach(() => { s = scenario(); });
  const run = (opts = {}) => runGate({ spec: 'openapi.yaml', cwd: s.work, env: cleanEnv(), now: NOW, ...opts });

  test('compares with the merge base: changes merged to main since the fork are not this branch\'s', async () => {
    const r = await run();
    expect(r.baseline.sha).toBe(git(s.work, 'merge-base', 'origin/main', 'HEAD'));
    expect(r.blocking.map((c) => c.type)).toEqual(['RESPONSE_FIELD_REMOVED']);
    expect(r.blocking[0].operations).toEqual(['GET /pets', 'GET /pets/{id}']);
    expect(r.verdict).toBe('block');
  });

  test('shadow mode reports what it would block', async () => {
    expect((await run({ mode: 'shadow' })).verdict).toBe('would-block');
  });

  test('--prove attaches the proof to each finding, against the merge base', async () => {
    const r = await run({ prove: true });
    const p = r.blocking[0].proof;
    expect(p).toMatchObject({ side: 'response', expect: 'response', endpoints: 2 });
    expect(['proven', 'example']).toContain(p.status);
    expect(p.request.path).toBe('/pets');
    expect(r.proofs).toMatchObject({ total: 1 });
    expect((await run()).blocking[0].proof).toBeUndefined();
  });

  test('a waiver in the working tree accepts the change; one added here that matches nothing is flagged', async () => {
    write(s.work, '.specshield/waivers.yml', WAIVER(`  - change: endpoint-removed
    operation: DELETE /pets/{id}
    owner: "@bob"
    reason: A typo in the operation, nothing removed there
    expires: "2026-11-30"
`));
    const r = await run();
    expect(r.verdict).toBe('pass');
    expect(r.waived[0].waiver).toMatchObject({ owner: '@alice' });
    expect(r.waivers.added).toHaveLength(2);
    expect(r.waivers.unmatchedAdded.map((w) => w.change)).toEqual(['endpoint-removed']);
  });

  test('an expired waiver stops applying and is named in the result', async () => {
    write(s.work, '.specshield/waivers.yml', WAIVER().replace('"2026-10-20"', '"2026-09-01"').replace('"2026-11-30"', '"2026-10-01"'));
    const r = await run();
    expect(r.verdict).toBe('block');
    expect(r.blocking[0].expiredWaiver).toMatchObject({ owner: '@alice', expires: '2026-10-01' });
    expect(r.waivers.expired).toHaveLength(1);
  });

  test('spec untouched, added, deleted', async () => {
    git(s.work, 'checkout', '-q', '-b', 'docs', 'main');
    fs.writeFileSync(path.join(s.work, 'README.md'), 'docs');
    let r = await run();
    expect(r).toMatchObject({ specStatus: 'unchanged', specTouched: false, verdict: 'pass' });

    fs.renameSync(path.join(s.work, 'openapi.yaml'), path.join(s.work, 'api.yaml'));
    r = await run({ spec: 'api.yaml' });
    expect(r).toMatchObject({ specStatus: 'added', verdict: 'pass' });

    r = await run();
    expect(r.specStatus).toBe('deleted');
    expect(r.blocking[0]).toMatchObject({ type: 'SPEC_REMOVED', change: 'spec-removed' });
  });

  test('the legacy ignore list still applies, and is reported so it can move to waivers', async () => {
    const r = await run({ ignore: ['legacy_id'] });
    expect(r.verdict).toBe('pass');
    expect(r.ignored).toHaveLength(1);
  });

  test('--base overrides detection; an unknown base explains how to fix it', async () => {
    const r = await run({ base: 'HEAD~1' });
    expect(r.baseline.sha).toBe(git(s.work, 'rev-parse', 'HEAD~1'));
    await expect(run({ base: 'nope', fetch: false })).rejects.toThrow(/Could not find the commit.*--base/);
  });

  test('a depth-1 CI checkout fetches the base and deepens until the merge base is found', async () => {
    const ci = path.join(s.root, 'ci');
    git(s.root, 'clone', '-q', '--depth', '1', '--branch', 'feature', `file://${s.origin}`, ci);
    const base = git(s.origin, 'rev-parse', 'main');
    const ev = path.join(s.root, 'ev.json');
    fs.writeFileSync(ev, JSON.stringify({ pull_request: { number: 7, base: { sha: base, ref: 'main' } } }));
    const env = cleanEnv({ GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'pull_request', GITHUB_EVENT_PATH: ev, GITHUB_BASE_REF: 'main' });
    await expect(runGate({ spec: 'openapi.yaml', cwd: ci, env, fetch: false, now: NOW })).rejects.toThrow(/shallow/);
    const r = await runGate({ spec: 'openapi.yaml', cwd: ci, env, now: NOW });
    expect(r.baseline.fetched.length).toBeGreaterThan(0);
    expect(r.baseline.sha).toBe(git(s.work, 'merge-base', 'origin/main', 'feature'));
    expect(r.ci.pr).toBe(7);
    expect(r.blocking.map((c) => c.type)).toEqual(['RESPONSE_FIELD_REMOVED']);
  });

  test('merge queue: a PR is judged on its own change, not the PRs ahead of it', async () => {
    // PR 3 (removes GET /pets/{id}) is ahead of PR 7 (feature) in the queue.
    git(s.work, 'checkout', '-q', '-b', 'pr3', 'main');
    fs.writeFileSync(path.join(s.work, 'openapi.yaml'), dropPetById(addOwners(SPEC)));
    git(s.work, 'commit', '-qam', 'remove pets by id');
    git(s.work, 'checkout', '-q', '-b', 'gh-readonly-queue/main/pr-3-aaa', 'main');
    git(s.work, 'merge', '-q', '--no-edit', 'pr3');
    const q3 = git(s.work, 'rev-parse', 'HEAD');
    git(s.work, 'checkout', '-q', '-b', 'gh-readonly-queue/main/pr-7-bbb');
    git(s.work, 'merge', '-q', '--no-edit', 'feature');
    git(s.work, 'push', '-q', 'origin', 'gh-readonly-queue/main/pr-3-aaa', 'gh-readonly-queue/main/pr-7-bbb');
    const ci = path.join(s.root, 'ci');
    git(s.root, 'clone', '-q', '--depth', '1', '--branch', 'gh-readonly-queue/main/pr-7-bbb', `file://${s.origin}`, ci);
    const ev = path.join(s.root, 'mg.json');
    fs.writeFileSync(ev, JSON.stringify({ merge_group: { base_sha: q3, base_ref: 'refs/heads/main', head_ref: 'refs/heads/gh-readonly-queue/main/pr-7-bbb' } }));
    const r = await runGate({ spec: 'openapi.yaml', cwd: ci, now: NOW, env: cleanEnv({ GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'merge_group', GITHUB_EVENT_PATH: ev }) });
    expect(r.ci).toMatchObject({ event: 'merge_group', pr: 7 });
    expect(r.baseline.sha).toBe(q3);
    expect(r.blocking.map((c) => c.type)).toEqual(['RESPONSE_FIELD_REMOVED']);
  });
});

// ─── the commands ───────────────────────────────────────────────────────────

describe('specshield gate / waivers (CLI)', () => {
  let s;
  beforeEach(() => { s = scenario(); });
  const cli = (args, env = {}, cwd = s.work) => spawnSync(process.execPath, [bin, ...args], { cwd, encoding: 'utf8', env: cleanEnv(env) });

  test('exit codes: 1 when blocking, 0 in shadow mode, 2 on error', () => {
    const r = cli(['gate', 'openapi.yaml']);
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/1 breaking change blocks this change/);
    expect(r.stdout).toMatch(/specshield waivers add response-field-removed --field "legacy_id" --owner <you>/);
    expect(r.stdout).not.toMatch(/owners/);
    const sh = cli(['gate', 'openapi.yaml', '--shadow']);
    expect(sh.status).toBe(0);
    expect(sh.stdout).toMatch(/Shadow mode: would have blocked this change/);
    expect(cli(['gate', 'missing.yaml']).status).toBe(2);
    expect(cli(['gate']).stderr + cli(['gate']).stdout).toMatch(/Which spec\?/);
  });

  test('--prove prints the proof and adds it to the job summary', () => {
    const summary = path.join(s.root, 'summary.md');
    const r = cli(['gate', 'openapi.yaml', '--prove'], { GITHUB_ACTIONS: 'true', GITHUB_STEP_SUMMARY: summary });
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/new spec sends +\[0\] without "legacy_id"/);
    expect(r.stdout).toMatch(/reproduce +curl "\$BASE_URL\/pets"/);
    expect(fs.readFileSync(summary, 'utf8')).toMatch(/<details><summary>Proof for 1 change<\/summary>/);
  });

  test('gate settings come from .specshield.yml', () => {
    write(s.work, '.specshield.yml', 'gate:\n  spec: openapi.yaml\n  mode: shadow\n');
    const r = cli(['gate']);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/Mode\s+shadow/);
  });

  test('waivers add → gate passes; list --check fails on expired and invalid waivers', () => {
    const add = cli(['waivers', 'add', 'response-field-removed', '--field', 'legacy_id', '--owner', '@alice', '--reason', 'Clients stopped reading it in v4.2', '--days', '14']);
    expect(add.status).toBe(0);
    expect(fs.readFileSync(path.join(s.work, '.specshield/waivers.yml'), 'utf8')).toMatch(/owner: "@alice"/);
    const g = cli(['gate', 'openapi.yaml']);
    expect(g.status).toBe(0);
    expect(g.stdout).toMatch(/1 waived change/);
    expect(g.stdout).toMatch(/@alice, until/);

    expect(cli(['waivers', 'add', 'endpoint-removed', '--owner', '@a', '--reason', 'Long enough reason here', '--days', '120']).stderr).toMatch(/more than 90 days/);
    expect(cli(['waivers', 'add', 'endpoint-removed', '--reason', 'Long enough reason here']).status).not.toBe(0);

    expect(cli(['waivers', 'list', '--check']).status).toBe(0);
    fs.appendFileSync(path.join(s.work, '.specshield/waivers.yml'), '  - change: endpoint-removed\n    owner: x\n    reason: Old and forgotten waiver\n    created: "2026-01-01"\n    expires: "2026-02-01"\n');
    const l = cli(['waivers', 'list', '--check']);
    expect(l.status).toBe(1);
    expect(l.stdout).toMatch(/1 active · 1 expired/);
    expect(JSON.parse(cli(['waivers', 'list', '--json']).stdout).waivers.map((w) => w.status)).toEqual(['active', 'expired']);
  });

  test('in GitHub Actions: annotations and a job summary', () => {
    const summary = path.join(s.root, 'summary.md');
    fs.writeFileSync(summary, '');
    const env = { GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_STEP_SUMMARY: summary };
    const r = cli(['gate', 'openapi.yaml', '--shadow'], env);
    expect(r.stdout).toMatch(/^::warning file=openapi\.yaml,title=Breaking API change \(shadow mode\)::Response field "legacy_id" was removed/m);
    const md = fs.readFileSync(summary, 'utf8');
    expect(md).toMatch(/### 🟡 SpecShield gate — `openapi.yaml`/);
    expect(md).toMatch(/\| Response field "legacy_id" was removed/);
    const quiet = cli(['gate', 'openapi.yaml', '--no-summary'], env);
    expect(quiet.stdout).not.toMatch(/^::/m);
  });

  test('--json carries baseline, verdict and waiver health', () => {
    const r = JSON.parse(cli(['gate', 'openapi.yaml', '--json']).stdout);
    expect(r).toMatchObject({ version: 1, mode: 'blocking', verdict: 'block', specStatus: 'changed' });
    expect(r.blocking[0].key).toBe('response-field-removed|GET /pets,GET /pets/{id}|responses.200[items].legacy_id');
  });

  test('--upload sends the run; a failing upload never changes the verdict', async () => {
    let got = null;
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        got = { url: req.url, key: req.headers['x-api-key'], body: JSON.parse(body) };
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: 9, url: 'https://specshield.io/account/gate', readiness: { status: 'NOT_ENOUGH_DATA', headline: 'Shadow mode, day 2 of 14 — 3 PRs checked so far.' } }));
      });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address();
    const go = (args) => new Promise((resolve) => {
      const p = spawn(process.execPath, [bin, 'gate', 'openapi.yaml', '--shadow', '--upload', '--org', 'acme', '--api-token', 'ss_test', ...args], { cwd: s.work, env: cleanEnv() });
      let stdout = ''; let stderr = '';
      p.stdout.on('data', (c) => { stdout += c; });
      p.stderr.on('data', (c) => { stderr += c; });
      p.on('close', (status) => resolve({ status, stdout, stderr }));
    });
    const ok = await go(['--server', `http://127.0.0.1:${port}`]);
    server.close();
    expect(ok.status).toBe(0);
    expect(ok.stdout).toMatch(/Recorded on your dashboard/);
    expect(ok.stdout).toMatch(/Readiness: Shadow mode, day 2 of 14/);
    expect(got).toMatchObject({ url: '/api/gate/runs', key: 'ss_test' });
    expect(got.body).toMatchObject({ orgKey: 'acme', repo: expect.stringMatching(/origin$/), mode: 'shadow', verdict: 'would-block', specTouched: true, spec: 'openapi.yaml' });
    expect(got.body.blocking[0]).toMatchObject({ change: 'response-field-removed', operations: ['GET /pets', 'GET /pets/{id}'] });

    const down = await go(['--server', 'http://127.0.0.1:1', '--repo', 'acme/pets']);
    expect(down.status).toBe(0);
    expect(down.stdout + down.stderr).toMatch(/not uploaded/);
  });
});
