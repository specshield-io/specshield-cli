'use strict';

/**
 * HTTP for `prove --against` and `replay`: one request at a time, raw text in
 * and out, HTTP errors returned as data (only connection failures throw), and
 * a guard against pointing either command at a server by accident.
 */

const axios = require('axios');
const net = require('net');

/**
 * A server is "local" when it can only be a developer's or a CI job's own:
 * loopback, private ranges, link-local, single-label hosts (docker-compose
 * service names such as "api"), and the .local/.internal/.test/.localhost
 * suffixes. Anything else needs --allow-remote.
 */
function isLocalHost(hostname) {
  const h = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) return false;
  if (h === 'localhost' || /\.(localhost|local|internal|test)$/.test(h)) return true;
  if (net.isIPv4(h)) {
    const [a, b] = h.split('.').map(Number);
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || a === 0;
  }
  if (net.isIPv6(h)) return h === '::1' || /^f[cd]/.test(h) || /^fe80:/.test(h);
  return !h.includes('.');
}

/** Validates a base URL and returns it without a trailing slash. */
function targetUrl(raw, { allowRemote = false, flag = '--against' } = {}) {
  let u;
  try { u = new URL(raw); } catch { throw new Error(`${flag} must be a URL like http://localhost:8080 (got "${raw}")`); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error(`${flag} must be an http(s) URL`);
  if (!allowRemote && !isLocalHost(u.hostname)) {
    throw new Error(`${flag} ${u.host} is not a local or private host. These requests are built to fail or to change data; pass --allow-remote if this server is a test environment you own.`);
  }
  return u.toString().replace(/\/+$/, '');
}

/** "Name: value" pairs from repeated --header options. */
function parseHeaders(list = []) {
  const out = {};
  for (const h of list) {
    const i = h.indexOf(':');
    if (i <= 0) throw new Error(`--header must look like "Name: value" (got "${h}")`);
    out[h.slice(0, i).trim()] = h.slice(i + 1).trim();
  }
  return out;
}

/**
 * Sends one request. Returns { status, headers, text, json, ms }; `json` is
 * the parsed body when it is JSON. Rejects only when no response came back.
 */
async function send({ method, url, headers = {}, body, timeoutMs = 10000 }) {
  const started = Date.now();
  const res = await axios.request({
    method,
    url,
    headers,
    data: body,
    timeout: timeoutMs,
    validateStatus: () => true,
    maxRedirects: 0,
    responseType: 'text',
    transformResponse: [(d) => d],
    transitional: { silentJSONParsing: true },
  });
  const text = typeof res.data === 'string' ? res.data : res.data === undefined || res.data === null ? '' : String(res.data);
  return { status: res.status, headers: res.headers || {}, text, json: parseJson(text, res.headers), ms: Date.now() - started };
}

function parseJson(text, headers) {
  if (!text) return undefined;
  const type = String((headers && (headers['content-type'] || headers['Content-Type'])) || '');
  if (!/json/i.test(type) && !/^\s*[[{]/.test(text)) return undefined;
  try { return JSON.parse(text); } catch { return undefined; }
}

/** Runs `fn` over `items` with at most `n` in flight; keeps the order. */
async function pool(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(n, items.length)) }, worker));
  return out;
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function describeNetworkError(err) {
  if (err.code === 'ECONNREFUSED') return 'connection refused';
  if (err.code === 'ECONNABORTED' || /timeout/i.test(err.message)) return 'timed out';
  if (err.code === 'ENOTFOUND') return 'host not found';
  return err.message;
}

module.exports = { isLocalHost, targetUrl, parseHeaders, send, pool, SAFE_METHODS, describeNetworkError };
