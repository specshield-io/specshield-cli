'use strict';

/**
 * Passive checks on captured traffic. Reads a HAR file and sends nothing.
 * A capture is full of real secrets, so a finding says where one was seen and
 * never what it was.
 */

const fs = require('fs');
const { finding } = require('./rules');
const { sensitivity } = require('./diff');
const { isLocalHost } = require('../prove/http');
const { templatePath } = require('../har/pathTemplate');

const MAX_BODY = 2 * 1024 * 1024;
const MAX_NODES = 20000;
const API_MIME = /json|xml|graphql|text\/plain/i;
const SESSION_COOKIE = /sess|sid|auth|token|jwt/i;
const MASKED = /^[*xX•.\-\s]*$|^\*+|\*{3,}|x{4,}|redacted|^null$|^undefined$/i;

const SECRET_VALUES = [
  ['AWS access key', /\bAKIA[0-9A-Z]{16}\b/],
  ['private key', /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/],
  ['GitHub token', /\b(?:gh[pousr]_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{40,})\b/],
  ['Stripe live key', /\b[sr]k_live_[A-Za-z0-9]{16,}\b/],
  ['Slack token', /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/],
  ['Google API key', /\bAIza[0-9A-Za-z_-]{35}\b/],
];
const STACK = /Traceback \(most recent call last\)|Exception in thread "|\n\s+at [\w.$<>]+\([\w.]+\.(?:java|kt|scala):\d+\)|\n\s+at .+ \(.+\.[jt]s:\d+:\d+\)|\.php on line \d+/;

function auditHar(files, { hosts = null } = {}) {
  const found = new Map();
  const stats = { entries: 0, api: 0, otherHosts: 0, hosts: new Set() };
  const add = (rule, severity, opts) => {
    const key = [rule, opts.endpoint || '', opts.field || ''].join('|');
    if (!found.has(key)) found.set(key, finding(rule, severity, { ...opts, source: 'har' }));
  };
  for (const file of files) {
    for (const e of entriesOf(file)) {
      stats.entries++;
      checkEntry(e, { add, hosts, stats });
    }
  }
  return { findings: [...found.values()], stats: { ...stats, hosts: stats.hosts.size } };
}

function entriesOf(file) {
  let doc;
  try { doc = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { throw new Error(`${file} is not valid HAR JSON (${e.message})`); }
  if (!doc || !doc.log || !Array.isArray(doc.log.entries)) throw new Error(`${file} is not a HAR file (no log.entries)`);
  return doc.log.entries.filter((e) => e && e.request && e.request.url && e.response);
}

function headerMap(list) {
  const map = new Map();
  for (const h of list || []) {
    if (!h || typeof h.name !== 'string') continue;
    const k = h.name.toLowerCase();
    map.set(k, [...(map.get(k) || []), String(h.value)]);
  }
  return map;
}

function bodyOf(res) {
  const c = res.content;
  if (!c || typeof c.text !== 'string') return null;
  const text = c.encoding === 'base64' ? Buffer.from(c.text.slice(0, MAX_BODY * 2), 'base64').toString('utf8') : c.text;
  return text.slice(0, MAX_BODY);
}

function checkEntry(e, { add, hosts, stats }) {
  let url;
  try { url = new URL(e.request.url); } catch { return; }
  if (!/^https?:$/.test(url.protocol)) return;
  const host = url.hostname.toLowerCase();
  if (hosts && !hosts.has(host)) { stats.otherHosts++; return; }
  const res = headerMap(e.response.headers);
  const mime = String((e.response.content && e.response.content.mimeType) || (res.get('content-type') || [''])[0]);
  // A browser capture is mostly pages and assets; these checks are about the API.
  if (!API_MIME.test(mime)) return;
  stats.api++;
  stats.hosts.add(host);

  const endpoint = `${String(e.request.method || 'GET').toUpperCase()} ${templatePath(url.pathname).templated}`;
  const local = isLocalHost(host);
  const https = url.protocol === 'https:';

  if (!https && !local) add('cleartext-traffic', 'high', { field: host });
  if (https && !local) {
    if (!res.has('strict-transport-security')) add('missing-hsts', 'medium', { field: host });
  }
  if (!res.has('x-content-type-options')) add('missing-nosniff', 'low', { field: host });

  for (const [name, value] of url.searchParams) {
    const tier = sensitivity(name, { type: 'string' });
    if (value && (tier === 'credential' || tier === 'regulated' || tier === 'token')) add('secret-in-url', 'high', { endpoint, field: name });
    const hit = SECRET_VALUES.find(([, re]) => re.test(value));
    if (hit) add('secret-in-url', 'high', { endpoint, field: name, detail: hit[0] });
  }

  checkCors(res, { add, host });
  checkCookies(res, { add, host, https, local });
  for (const h of ['server', 'x-powered-by', 'x-aspnet-version']) {
    if ((res.get(h) || []).some((v) => /\d+\.\d+/.test(v))) add('version-disclosure', 'low', { field: host, detail: h });
  }

  const body = bodyOf(e.response);
  if (!body) return;
  if (e.response.status >= 400 && STACK.test(body)) add('stack-trace', 'medium', { endpoint });
  for (const [label, re] of SECRET_VALUES) if (re.test(body)) add('secret-in-response', 'high', { endpoint, field: label });
  if (/^\s*[[{]/.test(body)) {
    try { scanJson(JSON.parse(body), { add, endpoint }); } catch { /* truncated or not JSON after all */ }
  }
}

function checkCors(res, { add, host }) {
  const origin = (res.get('access-control-allow-origin') || [])[0];
  if (!origin) return;
  const credentials = (res.get('access-control-allow-credentials') || [])[0] === 'true';
  if (origin === '*' && credentials) add('cors-wildcard-credentials', 'high', { field: host });
  else if (origin === '*') add('cors-any-origin', 'low', { field: host });
  else if (origin === 'null') add('cors-null-origin', 'medium', { field: host });
}

function checkCookies(res, { add, host, https, local }) {
  for (const raw of res.get('set-cookie') || []) {
    const [pair, ...attrs] = raw.split(';');
    const name = pair.split('=')[0].trim();
    if (!SESSION_COOKIE.test(name)) continue;
    const has = (a) => attrs.some((x) => x.trim().toLowerCase().startsWith(a));
    const missing = [
      https && !local && !has('secure') ? 'Secure' : null,
      !has('httponly') ? 'HttpOnly' : null,
      !has('samesite') ? 'SameSite' : null,
    ].filter(Boolean);
    if (missing.length) add('insecure-cookie', 'medium', { field: name, detail: `${host}: no ${missing.join(', ')}` });
  }
}

function scanJson(root, { add, endpoint }) {
  let nodes = 0;
  const visit = (v, key) => {
    if (++nodes > MAX_NODES || v === null || v === undefined) return;
    if (Array.isArray(v)) { for (const x of v) visit(x, key); return; }
    if (typeof v === 'object') { for (const [k, x] of Object.entries(v)) visit(x, k); return; }
    if (typeof v !== 'string' && typeof v !== 'number') return;
    const text = String(v);
    if (!key || !text || MASKED.test(text)) return;
    const tier = sensitivity(key, { type: 'string' });
    if (tier === 'credential') add('secret-in-response', 'high', { endpoint, field: key });
    else if (tier === 'regulated') add('regulated-data-in-response', 'high', { endpoint, field: key });
    else if (tier === 'personal') add('personal-data-in-response', 'low', { endpoint, field: key });
  };
  visit(root, null);
}

module.exports = { auditHar };
