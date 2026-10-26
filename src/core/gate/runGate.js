'use strict';

const fs = require('fs');
const path = require('path');
const fsExtra = require('fs-extra');
const { parseSpec } = require('../parseSpec');
const { normalizeSpec } = require('../normalizeSpec');
const { diffSpecs } = require('../diffEngine');
const { classifyChanges } = require('../classifyChanges');
const { resolveBaseline } = require('./baseline');
const G = require('./git');
const W = require('./waivers');

/**
 * One gate run: the spec at the merge base vs the spec in the working tree,
 * minus changes no client uses (with usage data), minus waived changes.
 *
 *   verdict  pass         nothing blocks
 *            block        something blocks, mode blocking (exit 1)
 *            would-block  something blocks, mode shadow (exit 0)
 */
async function runGate(opts) {
  const {
    spec, cwd = process.cwd(), base, env = process.env, fetch = true,
    mode = 'blocking', waiversFile = W.DEFAULT_FILE, maxWaiverDays = W.DEFAULT_MAX_DAYS,
    ignore = [], usage = null, now = Date.now(),
  } = opts;
  if (!['blocking', 'shadow'].includes(mode)) throw new Error(`mode must be "blocking" or "shadow", got "${mode}"`);

  const baseline = resolveBaseline({ cwd, base, env, fetch });
  const top = G.toplevel(cwd);
  // git reports the toplevel with symlinks resolved (macOS /var → /private/var).
  const rel = (p) => path.relative(real(top), real(path.resolve(cwd, p))).split(path.sep).join('/');
  const specRel = rel(spec);
  if (specRel.startsWith('..')) throw new Error(`${spec} is outside the repository`);

  const specAbs = path.resolve(cwd, spec);
  const headText = (await fsExtra.pathExists(specAbs)) ? await fsExtra.readFile(specAbs, 'utf8') : null;
  const baseText = G.showFile(baseline.sha, specRel, cwd);
  if (headText === null && baseText === null) {
    throw new Error(`Spec not found: ${spec} (neither in the working tree nor at the baseline ${baseline.sha.slice(0, 12)})`);
  }

  // A Windows checkout (core.autocrlf) has CRLF in the tree and LF in history.
  const same = headText !== null && baseText !== null && headText.replace(/\r\n/g, '\n') === baseText.replace(/\r\n/g, '\n');
  const out = {
    version: 1,
    mode,
    spec: specRel,
    baseline: { sha: baseline.sha, from: baseline.label, candidate: baseline.candidate, fetched: baseline.fetched },
    head: { sha: baseline.headSha, dirty: isDirty(specRel, cwd) },
    ci: { provider: baseline.ctx.provider, event: baseline.ctx.event, repo: baseline.ctx.repo, pr: baseline.ctx.pr, title: baseline.ctx.title || null },
    specTouched: !same,
    specStatus: baseText === null ? 'added' : headText === null ? 'deleted' : same ? 'unchanged' : 'changed',
    breaking: [],
    blocking: [],
    waived: [],
    unused: [],
    ignored: [],
    nonBreaking: 0,
  };

  // Waivers: the working tree's file applies; the baseline's tells which were added here.
  const wAbs = path.resolve(cwd, waiversFile);
  const wOpts = { maxDays: maxWaiverDays, now, file: waiversFile };
  const headW = await W.loadWaivers(wAbs, wOpts);
  const baseWText = G.showFile(baseline.sha, rel(waiversFile), cwd);
  let baseW = [];
  try { baseW = baseWText ? W.parseWaivers(baseWText, wOpts).waivers : []; } catch { /* the baseline's file may predate today's rules */ }

  let breaking = [];
  if (out.specStatus === 'deleted') {
    breaking = [{ type: 'SPEC_REMOVED', path: null, method: null, field: null, severity: 'error', description: `The spec ${specRel} was deleted` }];
  } else if (out.specStatus === 'changed') {
    const baseDoc = parseSpec(baseText, specRel);
    const headDoc = parseSpec(headText, specRel);
    let result = classifyChanges(diffSpecs(normalizeSpec(baseDoc), normalizeSpec(headDoc)));
    out.nonBreaking = result.additions.length + result.modifications.length + result.warnings.length;
    if (ignore.length) {
      const hit = (c) => ignore.some((p) => (c.description || '').includes(p));
      out.ignored = result.breakingChanges.filter(hit);
      result = { ...result, breakingChanges: result.breakingChanges.filter((c) => !hit(c)) };
    }
    if (usage && usage.usage) {
      const { applyUsage } = require('../usage/applyUsage');
      result = await applyUsage(result, baseDoc, usage, `${specRel} at ${baseline.sha.slice(0, 12)}`);
      out.unused = result.unusedBreakingChanges || [];
      out.usage = result.usage;
    }
    breaking = result.breakingChanges;
  }

  out.breaking = breaking.map(withKey);
  const { blocking, waived, used } = W.applyWaivers(out.breaking, headW.waivers, now);
  out.blocking = blocking;
  out.waived = waived;

  const added = W.newSince(headW.waivers, baseW);
  out.waivers = {
    file: waiversFile,
    exists: headW.exists,
    total: headW.waivers.length,
    counts: countBy(headW.waivers.map((w) => W.status(w, now))),
    used: used.size,
    invalid: headW.waivers.filter((w) => w.errors.length).map(summary),
    expired: headW.waivers.filter((w) => W.status(w, now) === 'expired').map(summary),
    expiring: headW.waivers.filter((w) => W.status(w, now) === 'expiring').map((w) => ({ ...summary(w), daysLeft: W.daysLeft(w, now) })),
    added: added.map(summary),
    // A waiver added in this change that matches nothing is almost always a typo.
    unmatchedAdded: added.filter((w) => W.status(w, now) !== 'invalid' && W.status(w, now) !== 'expired' && !used.has(w.index)).map(summary),
  };

  out.verdict = blocking.length === 0 ? 'pass' : mode === 'shadow' ? 'would-block' : 'block';
  return out;
}

function withKey(c) {
  const eps = W.endpointsOf(c);
  return { ...c, change: W.changeId(c.type), operations: eps, key: [W.changeId(c.type), eps.join(','), c.field || ''].join('|') };
}

function summary(w) {
  return { index: w.index, change: w.change, operation: w.operation, field: w.field, owner: w.owner, reason: w.reason, expires: w.expires, ticket: w.ticket, errors: w.errors };
}

function countBy(list) {
  return list.reduce((m, k) => ({ ...m, [k]: (m[k] || 0) + 1 }), {});
}

/** realpath for a path that may not exist yet (a deleted spec). */
function real(p) {
  try { return fs.realpathSync(p); } catch { const d = path.dirname(p); return d === p ? p : path.join(real(d), path.basename(p)); }
}

function isDirty(rel, cwd) {
  const s = G.git(['status', '--porcelain', '--', rel], { cwd, allowFail: true });
  return Boolean(s);
}

module.exports = { runGate };
