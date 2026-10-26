'use strict';

const fsExtra = require('fs-extra');
const jsYaml = require('js-yaml');
const YAML = require('yaml');

/**
 * Waivers: accepted breaking changes, each with an owner, a reason and an
 * expiry. They live in the repository (default .specshield/waivers.yml), so
 * adding one is a reviewed diff in the PR that needs it, and the same file is
 * read by `specshield gate` and the SpecShield GitHub App.
 *
 *   waivers:
 *     - change: response-field-removed     # change type (required); "*" = any type on `operation`
 *       operation: GET /pets/{id}          # optional: METHOD /path, "*" method, * / ** path globs
 *       field: legacy_id                   # optional: field name or path suffix
 *       owner: "@alice"                    # required
 *       reason: Clients stopped reading it in v4.2   (required)
 *       expires: 2026-12-31                # required; the waiver stops applying after this day (UTC)
 *       created: 2026-10-27                # written by `specshield waivers add`
 *       ticket: PAY-123                    # optional
 *
 * Without `operation` and `field` a waiver covers every change of that type —
 * a policy decision, which the expiry forces someone to revisit.
 *
 * Matching rules (mirrored by the backend's GateWaivers.java):
 *   change    the change's type, kebab-case (RESPONSE_FIELD_REMOVED → response-field-removed)
 *   operation must cover EVERY endpoint the change affects
 *   field     equals the change's field, its last segment, or a dot-suffix of it
 */

const DEFAULT_FILE = '.specshield/waivers.yml';
const DEFAULT_MAX_DAYS = 90;
const EXPIRING_DAYS = 7;
const DAY = 86400000;

function changeId(type) {
  return String(type || '').trim().toLowerCase().replace(/_/g, '-');
}

function today(now = Date.now()) {
  return new Date(now).toISOString().slice(0, 10);
}

function toDate(v) {
  if (v instanceof Date && !Number.isNaN(v.getTime())) return v.toISOString().slice(0, 10);
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v.trim()) && !Number.isNaN(Date.parse(v.trim()))) return v.trim();
  return null;
}

function daysBetween(a, b) {
  return Math.round((Date.parse(b) - Date.parse(a)) / DAY);
}

/** Reads and validates the waiver file. A missing file is no waivers; bad YAML throws. */
async function loadWaivers(file, opts = {}) {
  if (!(await fsExtra.pathExists(file))) return { file, exists: false, waivers: [] };
  return { file, exists: true, ...parseWaivers(await fsExtra.readFile(file, 'utf8'), { ...opts, file }) };
}

function parseWaivers(text, { file = DEFAULT_FILE, maxDays = DEFAULT_MAX_DAYS, now = Date.now() } = {}) {
  let doc;
  try {
    doc = jsYaml.load(text);
  } catch (err) {
    throw new Error(`${file} is not valid YAML: ${err.message.split('\n')[0]}`);
  }
  if (doc === null || doc === undefined) return { waivers: [] };
  const list = Array.isArray(doc) ? doc : doc.waivers;
  if (list === undefined || list === null) return { waivers: [] };
  if (!Array.isArray(list)) throw new Error(`${file}: "waivers" must be a list`);
  return { waivers: list.map((w, i) => validate(w, i, { maxDays, now })) };
}

/** Normalizes one waiver and lists what's wrong with it; a waiver with errors never applies. */
function validate(raw, index, { maxDays = DEFAULT_MAX_DAYS, now = Date.now() } = {}) {
  const errors = [];
  const w = raw && typeof raw === 'object' ? raw : {};
  const str = (v) => (v === undefined || v === null ? '' : String(v).trim());
  const out = {
    index,
    change: changeId(w.change || w.type),
    operation: str(w.operation) || null,
    field: str(w.field) || null,
    owner: str(w.owner),
    reason: str(w.reason),
    expires: toDate(w.expires),
    created: toDate(w.created),
    ticket: str(w.ticket) || null,
    errors,
  };
  if (!raw || typeof raw !== 'object') errors.push('must be a mapping with change, owner, reason and expires');
  if (!out.change) errors.push('change is required (e.g. response-field-removed)');
  else if (out.change !== '*' && !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(out.change)) errors.push(`change "${out.change}" is not a change type`);
  if (out.change === '*' && !out.operation) errors.push('change: "*" needs an operation — it would waive every breaking change');
  if (out.operation && !parseOperation(out.operation)) errors.push(`operation "${out.operation}" must look like "GET /pets/{id}" or "/pets/**"`);
  if (!out.owner) errors.push('owner is required — who answers for this waiver');
  if (!out.reason) errors.push('reason is required — why this break is acceptable');
  else if (out.reason.length < 10) errors.push('reason is too short to tell a reviewer why');
  if (!w.expires) errors.push(`expires is required (YYYY-MM-DD, at most ${maxDays} days out)`);
  else if (!out.expires) errors.push(`expires "${w.expires instanceof Date ? w.expires : w.expires}" must be a date like 2026-12-31`);
  else {
    const from = out.created || today(now);
    if (daysBetween(from, out.expires) > maxDays) {
      errors.push(`expires ${out.expires} is more than ${maxDays} days after ${out.created ? `created ${out.created}` : 'today'} — waivers must be revisited`);
    }
    if (out.created && out.created > out.expires) errors.push('created is after expires');
  }
  return out;
}

function status(w, now = Date.now()) {
  if (w.errors.length) return 'invalid';
  const t = today(now);
  if (t > w.expires) return 'expired';
  return daysBetween(t, w.expires) <= EXPIRING_DAYS ? 'expiring' : 'active';
}

function daysLeft(w, now = Date.now()) {
  return w.expires ? daysBetween(today(now), w.expires) : null;
}

// ─── matching ───────────────────────────────────────────────────────────────

function parseOperation(op) {
  const m = /^\s*(?:([A-Za-z]+|\*)\s+)?(\/\S*)\s*$/.exec(op || '');
  if (!m) return null;
  return { method: m[1] ? m[1].toUpperCase() : '*', path: m[2] };
}

function pathMatches(pattern, path) {
  const norm = (p) => p.replace(/\{[^}]+\}/g, '{}').replace(/\/+$/, '') || '/';
  const pat = norm(pattern).split('/');
  const segs = norm(path).split('/');
  const go = (i, j) => {
    if (i === pat.length) return j === segs.length;
    if (pat[i] === '**') {
      for (let k = j; k <= segs.length; k++) if (go(i + 1, k)) return true;
      return false;
    }
    if (j === segs.length) return false;
    return (pat[i] === '*' || pat[i] === segs[j]) && go(i + 1, j + 1);
  };
  return go(0, 0);
}

function opMatches(op, endpoint) {
  const [method, ...rest] = endpoint.split(' ');
  const path = rest.join(' ');
  return (op.method === '*' || op.method === method.toUpperCase()) && pathMatches(op.path, path);
}

/** Every "METHOD /path" a change affects. */
function endpointsOf(change) {
  if (Array.isArray(change.affectedEndpoints) && change.affectedEndpoints.length) return change.affectedEndpoints;
  if (change.method && change.path) return [`${change.method.toUpperCase()} ${change.path}`];
  return [];
}

function fieldMatches(want, field) {
  if (!field) return false;
  const clean = (f) => String(f).replace(/\[[^\]]*\]/g, '').replace(/^(query|path|header|cookie):/, '');
  const f = clean(field);
  const w = clean(want);
  if (f === w) return true;
  const segs = f.split('.').map((s) => s.replace(/^(query|path|header|cookie):/, ''));
  if (segs[segs.length - 1] === w) return true;
  return f.endsWith(`.${w}`);
}

function matches(w, change) {
  if (w.errors.length) return false;
  if (w.change !== '*' && w.change !== changeId(change.type)) return false;
  if (w.operation) {
    const op = parseOperation(w.operation);
    const eps = endpointsOf(change);
    if (eps.length === 0 || !eps.every((e) => opMatches(op, e))) return false;
  }
  if (w.field && !fieldMatches(w.field, change.field)) return false;
  return true;
}

/**
 * Splits breaking changes into the ones still blocking and the ones an active
 * waiver accepts. A change matched only by an expired waiver keeps blocking
 * and carries `expiredWaiver`, so the output can say why it's back.
 */
function applyWaivers(breaking, waivers, now = Date.now()) {
  const blocking = [];
  const waived = [];
  const used = new Set();
  for (const c of breaking) {
    const hits = waivers.filter((w) => matches(w, c));
    const live = hits.find((w) => status(w, now) !== 'expired');
    if (live) {
      used.add(live.index);
      waived.push({ ...c, waiver: brief(live, now) });
    } else if (hits.length) {
      blocking.push({ ...c, expiredWaiver: brief(hits[0], now) });
    } else {
      blocking.push(c);
    }
  }
  return { blocking, waived, used };
}

function brief(w, now) {
  return { change: w.change, operation: w.operation, field: w.field, owner: w.owner, reason: w.reason, expires: w.expires, ticket: w.ticket, status: status(w, now) };
}

/** Waivers added or edited in this change (not identical to one in the baseline file). */
function newSince(head, base) {
  const key = (w) => JSON.stringify([w.change, w.operation, w.field, w.owner, w.reason, w.expires, w.ticket]);
  const before = new Set(base.map(key));
  return head.filter((w) => !before.has(key(w)));
}

/** The waiver a change would need — exactly that change, nothing broader. */
function suggestFor(change) {
  const eps = endpointsOf(change);
  return {
    change: changeId(change.type),
    operation: eps.length === 1 ? eps[0] : null,
    field: change.field ? String(change.field).split('.').pop().replace(/\[[^\]]*\]/g, '') || null : null,
  };
}

function needsQuotes(str) {
  if (/^[@`|>!&*%#?{[,'"-]/.test(str)) return true;
  try { return jsYaml.load(str) !== str; } catch { return true; }
}

// ─── writing ────────────────────────────────────────────────────────────────

const HEADER = [
  'Accepted breaking changes, read by `specshield gate` and the SpecShield GitHub App.',
  'Each waiver needs an owner, a reason and an expiry; an expired waiver stops applying.',
  'Add one with: specshield waivers add <change> --operation "GET /path" --owner @you --reason "..." --days 30',
].join('\n');

/** Appends a waiver to the file, keeping comments and layout. Returns the file text. */
async function addWaiver(file, waiver) {
  const exists = await fsExtra.pathExists(file);
  const text = exists ? await fsExtra.readFile(file, 'utf8') : '';
  const doc = text.trim() ? YAML.parseDocument(text) : new YAML.Document({ waivers: [] });
  if (!text.trim()) doc.commentBefore = HEADER.split('\n').map((l) => ` ${l}`).join('\n');
  if (doc.errors && doc.errors.length) throw new Error(`${file} is not valid YAML: ${doc.errors[0].message}`);
  let seq = doc.get('waivers');
  if (!YAML.isSeq(seq)) {
    if (YAML.isSeq(doc.contents)) seq = doc.contents;
    else { doc.set('waivers', doc.createNode([])); seq = doc.get('waivers'); }
  }
  const entry = {};
  for (const k of ['change', 'operation', 'field', 'owner', 'reason', 'created', 'expires', 'ticket']) {
    if (waiver[k] !== undefined && waiver[k] !== null && waiver[k] !== '') entry[k] = waiver[k];
  }
  const node = doc.createNode(entry);
  // Dates stay strings in the file, and "@alice" needs quoting in YAML.
  YAML.visit(node, { Scalar(_, s) { if (typeof s.value === 'string' && needsQuotes(s.value)) s.type = YAML.Scalar.QUOTE_DOUBLE; } });
  seq.items.push(node);
  const out = doc.toString({ lineWidth: 0 });
  await fsExtra.outputFile(file, out);
  return out;
}

module.exports = {
  DEFAULT_FILE, DEFAULT_MAX_DAYS, EXPIRING_DAYS,
  changeId, today, loadWaivers, parseWaivers, validate, status, daysLeft,
  parseOperation, pathMatches, fieldMatches, endpointsOf, matches, applyWaivers, newSince, suggestFor, addWaiver,
};
