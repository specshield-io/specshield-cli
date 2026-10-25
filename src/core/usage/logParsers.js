'use strict';

/**
 * Access-log line parsers for `specshield usage import`.
 *
 * Every parser turns one line into a request record, or null when the line
 * isn't a request it understands (blank, comment, health-check noise in an
 * unknown shape):
 *
 *   { method, path, query, status, time, userAgent, extras, json }
 *
 *   method     upper-case HTTP method
 *   path       URL path only — no scheme/host, no query string
 *   query      raw query string without the leading '?' ('' when absent)
 *   status     numeric status code, or null
 *   time       epoch ms, or null when the line carries no parseable timestamp
 *   userAgent  raw User-Agent, or null
 *   extras     quoted fields after the User-Agent (combined format only) —
 *              where nginx `log_format` additions such as $http_x_api_key land
 *   json       the parsed object (json format only), for --client field:<path>
 *
 * Supported formats:
 *   combined  nginx / Apache "combined" and "common" log formats
 *   alb       AWS Application Load Balancer access logs
 *   json      one JSON object per line — nginx JSON log_format, Kong file-log,
 *             API Gateway JSON access logs, Envoy/Traefik JSON, ECS-style logs
 */

const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'TRACE', 'CONNECT']);

// ─── combined / common ──────────────────────────────────────────────────────

// host ident authuser [time] "request" status bytes ["referer" "user-agent"] [extras...]
const COMBINED_RE = /^(\S+) \S+ \S+ \[([^\]]+)\] "((?:[^"\\]|\\.)*)" (\d{3}|-) \S+(?: "((?:[^"\\]|\\.)*)" "((?:[^"\\]|\\.)*)")?(.*)$/;

function parseCombined(line) {
  const m = COMBINED_RE.exec(line);
  if (!m) return null;
  const req = splitRequestLine(unescape(m[3]));
  if (!req) return null;
  return {
    ...req,
    status: m[4] === '-' ? null : Number(m[4]),
    time: parseClfTime(m[2]),
    userAgent: m[6] !== undefined ? nullIfDash(unescape(m[6])) : null,
    extras: m[7] ? tokenize(m[7]).map(nullIfDash) : [],
    json: null,
  };
}

const MONTHS = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };

/** "10/Oct/2026:13:55:36 +0530" → epoch ms. */
function parseClfTime(s) {
  const m = /^(\d{2})\/(\w{3})\/(\d{4}):(\d{2}):(\d{2}):(\d{2})(?: ([+-])(\d{2})(\d{2}))?$/.exec(s || '');
  if (!m || MONTHS[m[2]] === undefined) return null;
  const utc = Date.UTC(+m[3], MONTHS[m[2]], +m[1], +m[4], +m[5], +m[6]);
  const offsetMin = m[7] ? (m[7] === '-' ? -1 : 1) * (+m[8] * 60 + +m[9]) : 0;
  return utc - offsetMin * 60000;
}

// ─── AWS ALB ────────────────────────────────────────────────────────────────

// type time elb client:port target:port req_t target_t resp_t elb_status
// target_status recv sent "request" "user_agent" ...
const ALB_TYPES = new Set(['http', 'https', 'h2', 'grpcs', 'ws', 'wss']);

function parseAlb(line) {
  const f = tokenize(line);
  if (f.length < 14 || !ALB_TYPES.has(f[0])) return null;
  const req = splitRequestLine(f[12]);
  if (!req) return null;
  const time = Date.parse(f[1]);
  return {
    ...req,
    status: /^\d{3}$/.test(f[8]) ? Number(f[8]) : null,
    time: Number.isNaN(time) ? null : time,
    userAgent: nullIfDash(f[13]),
    extras: [],
    json: null,
  };
}

// ─── JSON lines ─────────────────────────────────────────────────────────────

const JSON_KEYS = {
  method: ['method', 'request_method', 'httpMethod', 'http_method', 'verb',
    'request.method', 'req.method', 'http.method', 'http.request.method'],
  path: ['path', 'uri', 'request_uri', 'url', 'request.uri', 'request.url', 'req.url',
    'req.path', 'http.url', 'http.target', 'url.original', 'url.path'],
  query: ['query', 'query_string', 'args', 'url.query'],
  status: ['status', 'status_code', 'statusCode', 'response.status', 'res.statusCode',
    'http.status_code', 'http.response.status_code'],
  time: ['time', 'timestamp', '@timestamp', 'time_iso8601', 'time_local', 'requestTime',
    'requestTimeEpoch', 'started_at', 'ts', 'start_time'],
  userAgent: ['user_agent', 'http_user_agent', 'userAgent', 'user_agent.original',
    'request.headers.user-agent', 'req.headers.user-agent', 'headers.user-agent',
    'http.user_agent', 'request.headers.User-Agent'],
};

function parseJsonLine(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) return null;
  let obj;
  try { obj = JSON.parse(trimmed); } catch { return null; }
  if (!obj || typeof obj !== 'object') return null;

  let method = pick(obj, JSON_KEYS.method);
  let target = pick(obj, JSON_KEYS.path);

  // nginx JSON formats often log "$request" ("GET /x?y HTTP/1.1") instead of
  // separate method and uri fields.
  if ((!method || !target) && typeof obj.request === 'string') {
    const req = splitRequestLine(obj.request);
    if (req) { method = method || req.method; target = target || req.path + (req.query ? `?${req.query}` : ''); }
  }
  if (typeof method !== 'string' || typeof target !== 'string') return null;
  method = method.toUpperCase();
  if (!HTTP_METHODS.has(method)) return null;

  const { path, query } = splitTarget(target);
  if (!path) return null;
  const explicitQuery = pick(obj, JSON_KEYS.query);
  const status = Number(pick(obj, JSON_KEYS.status));

  return {
    method,
    path,
    query: query || (typeof explicitQuery === 'string' ? explicitQuery.replace(/^\?/, '') : ''),
    status: Number.isInteger(status) && status >= 100 && status <= 599 ? status : null,
    time: parseAnyTime(pick(obj, JSON_KEYS.time)),
    userAgent: nullIfDash(asString(pick(obj, JSON_KEYS.userAgent))),
    extras: [],
    json: obj,
  };
}

/** Value at a dotted path. Tries the literal key first ("user_agent.original" as one key). */
function lookup(obj, dotted) {
  if (obj == null) return undefined;
  if (Object.prototype.hasOwnProperty.call(obj, dotted)) return obj[dotted];
  let cur = obj;
  for (const part of dotted.split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[part];
  }
  return cur;
}

function pick(obj, keys) {
  for (const k of keys) {
    const v = lookup(obj, k);
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
}

function parseAnyTime(v) {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v === 'number' || /^\d+(\.\d+)?$/.test(String(v))) {
    const n = Number(v);
    return n > 1e12 ? Math.round(n) : Math.round(n * 1000);   // ms vs seconds
  }
  const s = String(v);
  const clf = parseClfTime(s);
  if (clf !== null) return clf;
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : t;
}

// ─── Format detection ───────────────────────────────────────────────────────

const PARSERS = { combined: parseCombined, alb: parseAlb, json: parseJsonLine };

/** Picks the format that parses the most of the sample lines. */
function detectFormat(sampleLines) {
  let best = null;
  let bestHits = 0;
  for (const [name, parse] of Object.entries(PARSERS)) {
    const hits = sampleLines.filter((l) => parse(l)).length;
    if (hits > bestHits) { best = name; bestHits = hits; }
  }
  return best;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/** "GET /a/b?x=1 HTTP/1.1" (or an absolute URL as ALB logs it) → { method, path, query }. */
function splitRequestLine(s) {
  if (typeof s !== 'string') return null;
  const parts = s.trim().split(/\s+/);
  if (parts.length < 2) return null;
  const method = parts[0].toUpperCase();
  if (!HTTP_METHODS.has(method)) return null;
  const { path, query } = splitTarget(parts[1]);
  if (!path) return null;
  return { method, path, query };
}

function splitTarget(target) {
  let t = target;
  // Absolute URL (ALB, some proxies) → keep only the path + query.
  const abs = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i.exec(t);
  if (abs) t = t.slice(abs[0].length) || '/';
  if (!t.startsWith('/')) return { path: null, query: '' };
  const hash = t.indexOf('#');
  if (hash >= 0) t = t.slice(0, hash);
  const q = t.indexOf('?');
  let path = q >= 0 ? t.slice(0, q) : t;
  const query = q >= 0 ? t.slice(q + 1) : '';
  path = path.replace(/\/{2,}/g, '/');
  if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
  return { path, query };
}

/** Query-string parameter NAMES only — values are never kept. */
function queryParamNames(query) {
  if (!query) return [];
  const names = new Set();
  for (const pair of query.split('&')) {
    if (!pair) continue;
    const raw = pair.split('=')[0];
    let name;
    try { name = decodeURIComponent(raw.replace(/\+/g, ' ')); } catch { name = raw; }
    name = name.replace(/\[\]$/, '');           // tags[]=a → tags
    if (name && name.length <= 100) names.add(name);
  }
  return [...names];
}

/** Space-separated tokens; "double quoted" tokens may contain spaces and \" escapes. */
function tokenize(s) {
  const out = [];
  const re = /"((?:[^"\\]|\\.)*)"|(\S+)/g;
  let m;
  while ((m = re.exec(s)) !== null) out.push(m[1] !== undefined ? unescape(m[1]) : m[2]);
  return out;
}

function unescape(s) {
  return s.replace(/\\(["\\])/g, '$1');
}

function nullIfDash(s) {
  return s === undefined || s === null || s === '' || s === '-' ? null : s;
}

function asString(v) {
  if (v === undefined || v === null) return null;
  return Array.isArray(v) ? String(v[0]) : String(v);
}

module.exports = {
  PARSERS,
  parseCombined,
  parseAlb,
  parseJsonLine,
  detectFormat,
  queryParamNames,
  lookup,
  splitTarget,
};
