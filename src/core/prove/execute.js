'use strict';

/**
 * `prove --against <url>`: send each witness to a running build of the new
 * API and see whether the build behaves the way the new spec says it will.
 *
 * Every request witness travels with a control — the same request, valid under
 * the new spec. A rejected witness next to an accepted control is a confirmed
 * break; both rejected means the build is refusing something else (missing
 * credentials, missing test data), so the result is inconclusive rather than
 * a false confirmation.
 *
 *   confirmed       the build does what the witness predicts
 *   not-reproduced  it doesn't: it accepts the request, or still sends what
 *                   old clients expect — the spec and the code disagree
 *   inconclusive    the outcome can't be attributed to the change
 *   skipped         not sent (a write without --include-mutating, or no witness)
 *   error           no response
 */

const L = require('../fix/locate');
const C = require('./contract');
const H = require('./http');
const { relatesTo } = require('./relate');
const S = require('./schema');

async function confirmAll(items, opts) {
  const { baseDoc, against, headers = {}, includeMutating = false, timeoutMs = 10000, concurrency = 4, http = H.send } = opts;
  const run = async ({ diff, witness: w }) => {
    if (!w.request || (w.status !== 'proven' && w.status !== 'example')) return { outcome: 'skipped', detail: 'nothing to send' };
    if (!includeMutating && !H.SAFE_METHODS.has(w.request.method)) {
      return { outcome: 'skipped', detail: `${w.request.method} changes data; pass --include-mutating to send it` };
    }
    const call = (req) => http({
      method: req.method,
      url: against + req.path,
      headers: { ...headers, ...req.headers },
      body: req.bodyText || (req.body === null ? undefined : JSON.stringify(req.body)),
      timeoutMs,
    });
    try {
      const res = await call(w.request);
      const out = { status: res.status, ...judge(diff, w, res, baseDoc) };
      if (w.expect === 'rejected' && w.control && res.status >= 400 && res.status !== 401 && res.status !== 403) {
        const ctrl = await call(w.control);
        out.controlStatus = ctrl.status;
        Object.assign(out, withControl(res, ctrl));
      }
      return out;
    } catch (err) {
      return { outcome: 'error', detail: H.describeNetworkError(err) };
    }
  };
  const results = await H.pool(items, concurrency, run);
  items.forEach((it, i) => { it.witness.run = results[i]; });
  return items;
}

function judge(diff, w, res, baseDoc) {
  const s = res.status;
  if (s === 401 || s === 403) return { outcome: 'inconclusive', detail: `HTTP ${s} — the build wants credentials; pass them with --header` };

  if (w.expect === 'not-found' || w.expect === 'method-not-allowed') {
    if (s === 404 || s === 405 || s === 501) return { outcome: 'confirmed', detail: `HTTP ${s}: the operation is gone` };
    if (s < 400) return { outcome: 'not-reproduced', detail: `HTTP ${s}: the build still serves it, though the new spec removed it` };
    return { outcome: 'inconclusive', detail: `HTTP ${s}` };
  }

  if (w.expect === 'rejected') {
    if (s < 400) return { outcome: 'not-reproduced', detail: `HTTP ${s}: the build accepted it. The new spec says it should be rejected — the spec and the code disagree` };
    return { outcome: 'confirmed', detail: `HTTP ${s}: rejected${s >= 500 ? ' (a server error, not a 4xx)' : ''}`, weak: true };
  }

  if (w.expect === 'ignored') {
    if (s >= 400) return { outcome: 'confirmed', detail: `HTTP ${s}: the build rejects requests that still send it` };
    return { outcome: 'inconclusive', detail: `HTTP ${s}: accepted — whether the value is still used can't be seen from outside` };
  }

  if (w.expect === 'response') {
    const code = w.response.status;
    if (!sameStatus(code, s)) return { outcome: 'inconclusive', detail: `HTTP ${s} instead of ${code} — check the test data` };
    if (res.json === undefined) return { outcome: 'inconclusive', detail: `HTTP ${s} with no JSON body` };
    const parsed = L.parseField(diff.field);
    const oldC = C.contractOf(baseDoc, diff.method, diff.path);
    const check = C.checkResponse(oldC, code, res.json);
    const related = parsed ? (check.errors || []).filter((e) => relatesTo([e], parsed.steps)) : [];
    if (related.length) {
      return { outcome: 'confirmed', detail: `the build's response breaks old clients: ${related.map((e) => S.describeError(e, 'response')).join('; ')}` };
    }
    if (parsed && emptyAlong(res.json, parsed.steps)) return { outcome: 'inconclusive', detail: 'the response had no data at that field (an empty list?) — seed some test data' };
    if (w.status === 'example' && parsed && present(res.json, parsed.steps)) {
      return { outcome: 'not-reproduced', detail: `the build still sends ${diff.field.replace(/^responses\.[^.]+\./, '')}` };
    }
    return { outcome: w.status === 'example' ? 'confirmed' : 'not-reproduced', detail: w.status === 'example' ? 'the field is gone from the response' : 'the response still matches what old clients expect here' };
  }
  return { outcome: 'inconclusive', detail: `HTTP ${s}` };
}

function withControl(res, ctrl) {
  if (ctrl.status < 400) {
    return { outcome: 'confirmed', weak: false, detail: `HTTP ${res.status}: rejected, while the same request valid under the new spec got HTTP ${ctrl.status}` };
  }
  return { outcome: 'inconclusive', weak: false, detail: `HTTP ${res.status}, but the control request was rejected too (HTTP ${ctrl.status}) — check credentials and test data` };
}

function sameStatus(documented, actual) {
  const d = String(documented);
  const a = String(actual);
  if (d === a) return true;
  if (/^[1-5]xx$/i.test(d)) return d[0] === a[0];
  return d === 'default';
}

/** Walks an actual response along diff steps; true when an array on the way is empty. */
function emptyAlong(body, steps) {
  let cur = body;
  for (const s of steps) {
    if (cur === null || cur === undefined) return false;
    if (s.items) { if (!Array.isArray(cur)) return false; if (cur.length === 0) return true; cur = cur[0]; } else if (s.prop !== undefined) cur = cur[s.prop];
    else if (s.map) { const k = Object.keys(cur)[0]; if (k === undefined) return true; cur = cur[k]; }
  }
  return false;
}

function present(body, steps) {
  let cur = body;
  for (const s of steps) {
    if (cur === null || cur === undefined) return false;
    if (s.items) { if (!Array.isArray(cur) || !cur.length) return false; cur = cur[0]; } else if (s.prop !== undefined) { if (!(s.prop in Object(cur))) return false; cur = cur[s.prop]; }
    else if (s.map) { const k = Object.keys(cur)[0]; if (k === undefined) return false; cur = cur[k]; }
  }
  return cur !== undefined;
}

module.exports = { confirmAll, judge };
