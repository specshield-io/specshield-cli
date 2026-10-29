'use strict';

/**
 * Real traffic for `specshield replay`: requests read from HAR files (full
 * requests with their recorded responses) or access logs (method, path, query
 * and status), sampled so every operation is represented — not just the hot
 * ones — and the same seed always picks the same requests.
 *
 *   Record = {
 *     method, path, query,            // query: raw string without "?"
 *     headers: { name: value },       // credentials and hop-by-hop headers removed
 *     body: string | null,            // raw request body (HAR only)
 *     recorded: { status, json?, source: 'har' | 'log' },
 *     operation: 'GET /orders/{id}',  // grouping key
 *     matched: boolean,               // operation found in --spec
 *   }
 */

const fs = require('fs');
const { importLogFile } = require('../usage/importLogs');
const { createRouteMatcher } = require('../usage/routeMatcher');
const { templatePath } = require('../har/pathTemplate');

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);

// Never replayed from a capture: credentials (pass your own with --header),
// and headers that describe the original connection rather than the request.
const DROP = /^(:|host$|content-length$|connection$|keep-alive$|transfer-encoding$|te$|upgrade$|accept-encoding$|x-forwarded-|x-real-ip$|forwarded$|via$|x-amz|cf-|x-cloud-trace|traceparent$|tracestate$|x-request-id$|x-b3-|sec-|origin$|referer$|if-none-match$|if-modified-since$)/i;
const SECRET = /auth|token|key|secret|cookie|session|signature|csrf|xsrf|password/i;

function isHar(file) {
  if (/\.har$/i.test(file)) return true;
  if (/\.(log|gz|txt|jsonl)$/i.test(file) || file === '-') return false;
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(512);
    const n = fs.readSync(fd, buf, 0, 512, 0);
    fs.closeSync(fd);
    return /^\s*\{\s*"log"\s*:/.test(buf.slice(0, n).toString('utf8'));
  } catch { return false; }
}

/**
 * Reads every file, keeps up to `perOperation` requests per operation
 * (reservoir sampling, seeded), then at most `limit` overall — taken round-robin
 * across operations so rare ones survive the cut.
 */
async function loadTraffic(files, opts = {}) {
  const {
    format = 'auto', spec = null, basePath, perOperation = 5, limit = 200, seed = 1,
    includeMutating = false, hosts = null,
  } = opts;
  const matcher = spec ? createRouteMatcher(spec, { basePath }) : null;
  const rand = mulberry32(seed);
  const groups = new Map();
  const stats = { files: [], read: 0, considered: 0, mutatingSkipped: 0, bodilessWrites: 0, unmatched: 0, otherHosts: 0 };

  const take = (rec) => {
    stats.read++;
    if (hosts && rec.host && !hosts.has(rec.host)) { stats.otherHosts++; return; }
    if (!SAFE.has(rec.method)) {
      // An access log has no request bodies: a write rebuilt from it would be a different request.
      if (rec.recorded.source === 'log') { stats.bodilessWrites++; return; }
      if (!includeMutating) { stats.mutatingSkipped++; return; }
    }
    const m = matcher ? matcher.match(rec.method, rec.path) : null;
    if (matcher && (!m || !m.operation)) stats.unmatched++;
    rec.matched = Boolean(m && m.operation);
    rec.operation = rec.matched ? `${rec.method} ${m.template}` : `${rec.method} ${templatePath(rec.path).templated}`;
    stats.considered++;
    let g = groups.get(rec.operation);
    if (!g) { g = { seen: 0, kept: [] }; groups.set(rec.operation, g); }
    g.seen++;
    if (g.kept.length < perOperation) g.kept.push(rec);
    else {
      const j = Math.floor(rand() * g.seen);
      if (j < perOperation) g.kept[j] = rec;
    }
  };

  for (const file of files) {
    if (isHar(file)) {
      const n = readHar(file, take);
      stats.files.push({ file, kind: 'har', requests: n });
    } else {
      const res = await importLogFile(file, { format, aggregator: { add: (r) => take(fromLog(r)) } });
      stats.files.push({ file, kind: `log (${res.format || 'empty'})`, requests: res.parsed });
    }
  }

  const keys = [...groups.keys()].sort();
  const records = [];
  for (let round = 0; records.length < limit; round++) {
    let added = false;
    for (const k of keys) {
      const rec = groups.get(k).kept[round];
      if (!rec) continue;
      records.push(rec);
      added = true;
      if (records.length >= limit) break;
    }
    if (!added) break;
  }
  stats.operations = keys.length;
  stats.sampled = records.length;
  return { records, stats, seen: new Map([...groups].map(([k, g]) => [k, g.seen])) };
}

function readHar(file, take) {
  let doc;
  try { doc = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { throw new Error(`${file} is not valid HAR JSON (${e.message})`); }
  if (!doc || !doc.log || !Array.isArray(doc.log.entries)) throw new Error(`${file} is not a HAR file (no log.entries)`);
  let n = 0;
  for (const e of doc.log.entries) {
    if (!e || !e.request || !e.request.url) continue;
    let url;
    try { url = new URL(e.request.url); } catch { continue; }
    const headers = {};
    for (const h of e.request.headers || []) {
      if (!h || typeof h.name !== 'string' || DROP.test(h.name) || SECRET.test(h.name)) continue;
      headers[h.name] = h.value;
    }
    const resText = e.response && e.response.content && typeof e.response.content.text === 'string' && e.response.content.encoding !== 'base64'
      ? e.response.content.text : null;
    n++;
    take({
      method: String(e.request.method || 'GET').toUpperCase(),
      path: url.pathname.replace(/\/{2,}/g, '/'),
      query: url.search.replace(/^\?/, ''),
      host: url.hostname.toLowerCase(),
      headers,
      body: e.request.postData && typeof e.request.postData.text === 'string' ? e.request.postData.text : null,
      recorded: { status: e.response && e.response.status > 0 ? e.response.status : null, json: parseJson(resText), source: 'har' },
    });
  }
  return n;
}

function fromLog(r) {
  return {
    method: r.method,
    path: r.path,
    query: r.query || '',
    host: r.host || null,
    headers: {},
    body: null,
    recorded: { status: r.status, json: undefined, source: 'log' },
  };
}

function parseJson(text) {
  if (!text || !/^\s*[[{]/.test(text)) return undefined;
  try { return JSON.parse(text); } catch { return undefined; }
}

/** Small, fast, seedable PRNG — the same seed samples the same requests. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

module.exports = { loadTraffic, isHar, mulberry32, DROP, SECRET };
