'use strict';

/**
 * Replays sampled real requests against a build of the new API and compares
 * each response with a reference:
 *
 *   --baseline <url>   the same request sent to the old build, side by side —
 *                      the strong comparison: same data, only the code differs
 *   recorded           the response captured in the HAR (or the status in an
 *                      access log) — weaker: data may differ between then and now
 *
 * Verdicts, per request:
 *   broken        worked before (2xx/3xx), fails now (4xx/5xx)
 *   changed       both succeed, but the new response lost fields or changed types
 *   ok            same outcome, same shape
 *   improved      failed before, works now
 *   inconclusive  can't be attributed to the code: credentials, throttling, or a
 *                 404 that missing test data explains as well as a removed route
 *   error         no response from the build
 */

const H = require('../prove/http');
const C = require('../prove/contract');
const S = require('../prove/schema');
const { compare } = require('./shape');
const { createRouteMatcher } = require('../usage/routeMatcher');

async function runReplay(records, opts) {
  const {
    against, baseline = null, headers = {}, timeoutMs = 10000, concurrency = 4,
    http = H.send, spec = null, oldSpec = null, basePath,
  } = opts;
  const matcher = spec ? createRouteMatcher(spec, { basePath }) : null;
  const oldMatcher = oldSpec ? createRouteMatcher(oldSpec, { basePath }) : null;

  const one = async (rec) => {
    const target = rec.path + (rec.query ? `?${rec.query}` : '');
    const req = (base) => ({
      method: rec.method,
      url: base + target,
      headers: { ...rec.headers, ...headers },
      body: rec.body === null ? undefined : rec.body,
      timeoutMs,
    });
    let cand;
    try { cand = await http(req(against)); } catch (err) { return { rec, verdict: 'error', detail: H.describeNetworkError(err) }; }

    let ref;
    if (baseline) {
      try {
        const r = await http(req(baseline));
        ref = { status: r.status, json: r.json, source: 'baseline' };
      } catch (err) {
        return { rec, cand: brief(cand), verdict: 'error', detail: `baseline: ${H.describeNetworkError(err)}` };
      }
    } else {
      ref = { status: rec.recorded.status, json: rec.recorded.json, source: rec.recorded.source };
    }
    const out = { rec, ref: brief(ref), cand: brief(cand), ...classify(ref, cand, { baseline: Boolean(baseline), removed: removedFromSpec(rec, matcher) }) };
    // The old spec as the oracle: what old clients were promised, checked
    // against what the build sends now. Works even when the reference has no
    // body (access logs).
    if (oldSpec && (out.verdict === 'ok' || out.verdict === 'changed') && cand.status < 400 && cand.json !== undefined) {
      const broken = conformance(oldSpec, oldMatcher, rec, cand);
      if (broken) {
        out.verdict = 'changed';
        out.detail = [out.detail && out.diff ? out.detail : null, `breaks the old contract: ${broken.join('; ')}`].filter(Boolean).join('; ');
        out.oldContract = broken;
      }
    }
    if (spec && cand.status < 400 && cand.json !== undefined) out.specDrift = conformance(spec, matcher, rec, cand);
    if (out.verdict === 'broken' && cand.text) out.excerpt = cand.text.slice(0, 160);
    return out;
  };

  return H.pool(records, concurrency, one);
}

function classify(ref, cand, { baseline, removed }) {
  const r = ref.status;
  const c = cand.status;
  if (r === null || r === undefined) {
    return c < 400 ? { verdict: 'ok', detail: `HTTP ${c} (no recorded status to compare with)` } : { verdict: 'inconclusive', detail: `HTTP ${c} (no recorded status to compare with)` };
  }
  const refOk = r < 400;
  const candOk = c < 400;
  if ((c === 401 || c === 403) && r !== c) return { verdict: 'inconclusive', detail: `HTTP ${c} — the build wants credentials; pass them with --header` };
  if (c === 429 || c === 503) return { verdict: 'inconclusive', detail: `HTTP ${c} — throttled or unavailable` };

  if (refOk && !candOk) {
    if (c === 404 && !baseline && !removed) {
      return { verdict: 'inconclusive', detail: `HTTP ${r} → 404 — the record may not exist here; compare against the old build with --baseline` };
    }
    return { verdict: 'broken', detail: `worked before (HTTP ${r}), fails now (HTTP ${c})${removed ? ' — the operation is gone from the new spec' : ''}` };
  }
  if (!refOk && candOk) return { verdict: 'improved', detail: `failed before (HTTP ${r}), works now (HTTP ${c})` };
  if (!refOk && !candOk) return { verdict: 'ok', detail: `fails as before (HTTP ${r} → ${c})` };

  if (ref.json !== undefined && cand.json !== undefined) {
    const d = compare(ref.json, cand.json);
    if (d.missing.length || d.changed.length) {
      return { verdict: 'changed', detail: describeDiff(d), diff: d };
    }
  } else if (ref.json !== undefined && cand.json === undefined) {
    return { verdict: 'changed', detail: 'the response is no longer JSON' };
  }
  return { verdict: 'ok', detail: `HTTP ${r} → ${c}` };
}

function describeDiff(d) {
  const parts = [];
  if (d.missing.length) parts.push(`missing ${d.missing.slice(0, 4).map(show).join(', ')}${d.missing.length > 4 ? ` and ${d.missing.length - 4} more` : ''}`);
  for (const x of d.changed.slice(0, 3)) parts.push(`${show(x.path)} ${x.from} → ${x.to}`);
  if (d.changed.length > 3) parts.push(`${d.changed.length - 3} more type changes`);
  return parts.join('; ');
}

function show(path) {
  return path.replace(/^\./, '') || '(root)';
}

function brief(r) {
  return r ? { status: r.status, source: r.source || 'build' } : null;
}

/** With --spec: is the request's operation gone from the new spec? */
function removedFromSpec(rec, matcher) {
  if (!matcher) return false;
  const m = matcher.match(rec.method, rec.path);
  return !m || !m.operation;
}

/** Does the build's response match `spec` for this request's operation? Null when it does (or can't tell). */
function conformance(spec, matcher, rec, cand) {
  const m = matcher.match(rec.method, rec.path);
  if (!m || !m.operation) return null;
  const contract = C.contractOf(spec, rec.method, m.template);
  const check = C.checkResponse(contract, cand.status, cand.json);
  if (check.ok) return null;
  // One line per problem, not per list element: response[3].amount → response[].amount.
  const msgs = [...new Set(check.errors.map((e) => S.describeError(e, 'response').replace(/\[\d+\]/g, '[]')))];
  return msgs.slice(0, 3);
}

/** Per-operation totals and the requests worth showing. */
function summarize(results) {
  const totals = { ok: 0, broken: 0, changed: 0, improved: 0, inconclusive: 0, error: 0 };
  const ops = new Map();
  for (const r of results) {
    totals[r.verdict]++;
    const k = r.rec.operation;
    if (!ops.has(k)) ops.set(k, { operation: k, total: 0, ok: 0, broken: 0, changed: 0, improved: 0, inconclusive: 0, error: 0, examples: [], drift: [] });
    const o = ops.get(k);
    o.total++;
    o[r.verdict]++;
    if (r.verdict !== 'ok' && o.examples.length < 3) o.examples.push(r);
    if (r.specDrift && o.drift.length < 1) o.drift.push(r);
  }
  return { totals, operations: [...ops.values()].sort(order) };
}

const SEVERITY = ['broken', 'changed', 'error', 'inconclusive', 'improved', 'ok'];

function order(a, b) {
  const rank = (o) => SEVERITY.findIndex((v) => o[v] > 0);
  return rank(a) - rank(b) || a.operation.localeCompare(b.operation);
}

module.exports = { runReplay, classify, summarize };
