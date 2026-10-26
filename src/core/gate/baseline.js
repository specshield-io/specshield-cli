'use strict';

const fs = require('fs');
const G = require('./git');

/**
 * Which spec a change is judged against.
 *
 * Always the merge base of the change and its target branch — the commit the
 * branch started from — never the target branch's current tip and never what
 * is deployed. Against the tip, a branch that is behind sees every change
 * merged since it forked as "removed"; against production, a break that is
 * already merged re-fires on every unrelated PR until it ships. Both make the
 * check fail on PRs that didn't cause the failure, which is how a gate loses
 * the team's trust.
 *
 * The baseline candidate comes from the CI event when there is one:
 *   GitHub pull_request   the PR's base commit
 *   GitHub merge_group    the merge queue's base (the PRs ahead in the queue)
 *   GitHub push           the commit before the push
 *   GitLab MR             CI_MERGE_REQUEST_DIFF_BASE_SHA (already a merge base)
 *   Bitbucket PR          the destination branch
 *   anywhere else         origin's default branch
 * and --base overrides it.
 */

const ZERO_SHA = /^0+$/;

function readEvent(env) {
  if (!env.GITHUB_EVENT_PATH) return {};
  try { return JSON.parse(fs.readFileSync(env.GITHUB_EVENT_PATH, 'utf8')) || {}; } catch { return {}; }
}

/** What CI (if any) this runs in, and the baseline candidates it offers, best first. */
function ciContext(env = process.env) {
  if (env.GITHUB_ACTIONS === 'true') {
    const event = env.GITHUB_EVENT_NAME || '';
    const payload = readEvent(env);
    const ctx = { provider: 'github', event, repo: env.GITHUB_REPOSITORY || null, pr: null, candidates: [] };
    if (event === 'merge_group' && payload.merge_group) {
      const mg = payload.merge_group;
      const m = /\/pr-(\d+)-/.exec(mg.head_ref || '');
      ctx.pr = m ? Number(m[1]) : null;
      if (mg.base_sha) ctx.candidates.push({ ref: mg.base_sha, label: 'the merge queue base' });
      if (mg.base_ref) ctx.candidates.push({ ref: `origin/${mg.base_ref.replace(/^refs\/heads\//, '')}`, label: 'the merge queue base branch', branch: mg.base_ref.replace(/^refs\/heads\//, '') });
    } else if ((event === 'pull_request' || event === 'pull_request_target') && payload.pull_request) {
      const pr = payload.pull_request;
      ctx.pr = pr.number || null;
      ctx.title = pr.title || null;
      if (pr.base && pr.base.sha) ctx.candidates.push({ ref: pr.base.sha, label: `the PR's base (${pr.base.ref})` });
    } else if (event === 'push' && payload.before && !ZERO_SHA.test(payload.before)) {
      ctx.candidates.push({ ref: payload.before, label: 'the commit before this push' });
    }
    if (env.GITHUB_BASE_REF) ctx.candidates.push({ ref: `origin/${env.GITHUB_BASE_REF}`, label: `origin/${env.GITHUB_BASE_REF}`, branch: env.GITHUB_BASE_REF });
    return ctx;
  }
  if (env.GITLAB_CI === 'true') {
    const ctx = { provider: 'gitlab', event: env.CI_PIPELINE_SOURCE || '', repo: env.CI_PROJECT_PATH || null, pr: env.CI_MERGE_REQUEST_IID ? Number(env.CI_MERGE_REQUEST_IID) : null, title: env.CI_MERGE_REQUEST_TITLE || null, candidates: [] };
    if (env.CI_MERGE_REQUEST_DIFF_BASE_SHA) ctx.candidates.push({ ref: env.CI_MERGE_REQUEST_DIFF_BASE_SHA, label: 'the merge request base' });
    if (env.CI_MERGE_REQUEST_TARGET_BRANCH_NAME) ctx.candidates.push({ ref: `origin/${env.CI_MERGE_REQUEST_TARGET_BRANCH_NAME}`, label: `origin/${env.CI_MERGE_REQUEST_TARGET_BRANCH_NAME}`, branch: env.CI_MERGE_REQUEST_TARGET_BRANCH_NAME });
    if (!ctx.pr && env.CI_COMMIT_BEFORE_SHA && !ZERO_SHA.test(env.CI_COMMIT_BEFORE_SHA)) ctx.candidates.push({ ref: env.CI_COMMIT_BEFORE_SHA, label: 'the commit before this push' });
    return ctx;
  }
  if (env.BITBUCKET_BUILD_NUMBER) {
    const ctx = { provider: 'bitbucket', event: env.BITBUCKET_PR_ID ? 'pull_request' : 'push', repo: env.BITBUCKET_REPO_FULL_NAME || null, pr: env.BITBUCKET_PR_ID ? Number(env.BITBUCKET_PR_ID) : null, candidates: [] };
    const b = env.BITBUCKET_PR_DESTINATION_BRANCH;
    if (b) ctx.candidates.push({ ref: `origin/${b}`, label: `origin/${b}`, branch: b });
    return ctx;
  }
  return { provider: env.CI ? 'ci' : 'local', event: null, repo: null, pr: null, candidates: [] };
}

/**
 * Resolves the baseline commit. `fetch` lets it fetch a missing base commit
 * and deepen a shallow clone (CI checkouts default to depth 1) until the
 * merge base is reachable.
 *
 * Returns { sha, headSha, label, candidate, fetched: [..], ctx }.
 */
function resolveBaseline({ cwd, base, env = process.env, fetch = true } = {}) {
  if (!G.toplevel(cwd)) throw new Error('specshield gate needs a git checkout (run it inside the repository)');
  const headSha = G.commitOf('HEAD', cwd);
  if (!headSha) throw new Error('The repository has no commits yet');
  const ctx = ciContext(env);
  const fetched = [];

  let candidates = ctx.candidates;
  if (base) candidates = [{ ref: base, label: base, branch: /^[0-9a-f]{7,40}$/i.test(base) ? null : base.replace(/^origin\//, '') }];
  if (candidates.length === 0) {
    const def = G.remoteDefaultBranch(cwd);
    const guesses = def ? [def] : ['origin/main', 'origin/master', 'main', 'master'];
    candidates = guesses.map((ref) => ({ ref, label: ref, branch: ref.replace(/^origin\//, '') }));
  }

  const tried = [];
  for (const c of candidates) {
    let sha = G.commitOf(c.ref, cwd);
    if (!sha && fetch) {
      sha = fetchRef(c, cwd, fetched);
    }
    if (!sha) { tried.push(`${c.ref} (not found)`); continue; }

    let mb = G.mergeBase(sha, headSha, cwd);
    if (!mb && fetch && G.isShallow(cwd)) mb = deepenUntil(() => G.mergeBase(sha, headSha, cwd), c, cwd, fetched);
    if (!mb) { tried.push(`${c.ref} (no common history with HEAD)`); continue; }
    return { sha: mb, headSha, label: c.label, candidate: c.ref, candidateSha: sha, fetched, ctx };
  }

  const shallow = G.isShallow(cwd);
  throw new Error(`Could not find the commit this change started from. Tried: ${tried.join(', ')}.` +
    (shallow ? ' The checkout is shallow — fetch full history (actions/checkout: fetch-depth: 0) or allow fetching (drop --no-fetch).' : '') +
    ' Pass --base <branch or sha> to choose the baseline.');
}

function fetchRef(c, cwd, fetched) {
  const isSha = /^[0-9a-f]{7,40}$/i.test(c.ref);
  const spec = isSha ? c.ref : c.branch ? `+refs/heads/${c.branch}:refs/remotes/origin/${c.branch}` : null;
  if (!spec) return null;
  if (G.git(['fetch', '--no-tags', '--quiet', 'origin', spec], { cwd, allowFail: true }) === null) return null;
  fetched.push(isSha ? c.ref.slice(0, 12) : `origin/${c.branch}`);
  return G.commitOf(c.ref, cwd);
}

/** Deepens a shallow clone step by step until `found()` succeeds, then unshallows as a last resort. */
function deepenUntil(found, c, cwd, fetched) {
  const target = /^[0-9a-f]{7,40}$/i.test(c.ref) ? c.ref : c.branch ? `+refs/heads/${c.branch}:refs/remotes/origin/${c.branch}` : null;
  for (const depth of [50, 250, 1000]) {
    const args = ['fetch', '--no-tags', '--quiet', `--deepen=${depth}`, 'origin'];
    if (target) args.push(target);
    if (G.git(args, { cwd, allowFail: true }) === null) break;
    fetched.push(`--deepen=${depth}`);
    const mb = found();
    if (mb) return mb;
  }
  if (G.isShallow(cwd) && G.git(['fetch', '--no-tags', '--quiet', '--unshallow', 'origin'], { cwd, allowFail: true }) !== null) {
    fetched.push('--unshallow');
    return found();
  }
  return null;
}

module.exports = { resolveBaseline, ciContext };
