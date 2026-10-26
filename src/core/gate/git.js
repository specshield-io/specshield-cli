'use strict';

const { execFileSync } = require('child_process');

/** Runs git and returns trimmed stdout; throws with git's stderr. */
function git(args, { cwd, allowFail = false, raw = false } = {}) {
  try {
    const out = execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024 });
    return raw ? out : out.replace(/\n$/, '');
  } catch (err) {
    if (allowFail) return null;
    const msg = (err.stderr && String(err.stderr).trim()) || err.message;
    throw new Error(`git ${args.join(' ')} failed: ${msg}`);
  }
}

function toplevel(cwd) {
  return git(['rev-parse', '--show-toplevel'], { cwd, allowFail: true });
}

function commitOf(ref, cwd) {
  return git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { cwd, allowFail: true }) || null;
}

function mergeBase(a, b, cwd) {
  return git(['merge-base', a, b], { cwd, allowFail: true }) || null;
}

function isShallow(cwd) {
  return git(['rev-parse', '--is-shallow-repository'], { cwd, allowFail: true }) === 'true';
}

/** The file's content at a commit, or null when it doesn't exist there. */
function showFile(sha, relPath, cwd) {
  return git(['show', `${sha}:${relPath}`], { cwd, allowFail: true, raw: true });
}

/** origin/HEAD's branch, e.g. "origin/main", or null. */
function remoteDefaultBranch(cwd) {
  const ref = git(['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'], { cwd, allowFail: true });
  return ref ? ref.replace(/^refs\/remotes\//, '') : null;
}

module.exports = { git, toplevel, commitOf, mergeBase, isShallow, showFile, remoteDefaultBranch };
