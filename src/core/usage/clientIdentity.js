'use strict';

const crypto = require('crypto');
const { lookup } = require('./logParsers');

/**
 * Who made a request. The `--client` option picks the signal:
 *
 *   ua                 User-Agent, reduced to "product/major.minor" (default)
 *   field:<dot.path>   a field of a JSON log line, e.g. field:consumer.username (Kong)
 *   extra:<n>          the n-th quoted field after the User-Agent in a combined
 *                      log, e.g. an nginx log_format that appends "$http_x_client_id"
 *
 * Prefix any source with `hash:` (e.g. hash:field:request.headers.x-api-key)
 * to store a one-way hash instead of the value. Use it for API keys: the key
 * never lands in usage.json, but the same key always maps to the same client.
 */
function parseClientSpec(spec) {
  const raw = String(spec || 'ua').trim();
  const hash = raw.startsWith('hash:');
  const source = hash ? raw.slice(5) : raw;

  if (source === 'ua') return { spec: raw, hash, kind: 'ua' };
  let m = /^field:(.+)$/.exec(source);
  if (m) return { spec: raw, hash, kind: 'field', field: m[1] };
  m = /^extra:(\d+)$/.exec(source);
  if (m && Number(m[1]) >= 1) return { spec: raw, hash, kind: 'extra', index: Number(m[1]) - 1 };

  throw new Error(`Invalid --client "${raw}". Use ua, field:<path>, extra:<n> — optionally prefixed with hash:`);
}

function clientIdOf(record, clientSpec) {
  let value;
  if (clientSpec.kind === 'ua') {
    value = normalizeUserAgent(record.userAgent);
    if (value === null) return 'unknown';
  } else if (clientSpec.kind === 'field') {
    const v = record.json ? lookup(record.json, clientSpec.field) : undefined;
    value = v === undefined || v === null || v === '' ? null : String(Array.isArray(v) ? v[0] : v);
  } else {
    value = record.extras[clientSpec.index] ?? null;
  }
  if (value === null) return 'unknown';
  if (clientSpec.hash) return `hash:${crypto.createHash('sha256').update(value).digest('hex').slice(0, 12)}`;
  return value.length > 120 ? value.slice(0, 120) : value;
}

/**
 * "MyShop-iOS/5.2.1 CFNetwork/1410 Darwin/22.6" → "MyShop-iOS/5.2"
 * "okhttp/4.12.0"                               → "okhttp/4.12"
 * "Mozilla/5.0 (Windows NT 10.0; …) Chrome/…"   → "browser"
 *
 * Keeping major.minor groups patch releases of one app version together —
 * the useful question is "is anyone still on 5.2?", not "on 5.2.1 vs 5.2.3?".
 */
function normalizeUserAgent(ua) {
  if (!ua) return null;
  const s = ua.trim();
  if (!s) return null;
  if (/^Mozilla\//.test(s)) return 'browser';
  const first = s.split(/\s+/)[0];
  const m = /^([^/]+)\/(\d+)(?:\.(\d+))?/.exec(first);
  if (m) return `${m[1]}/${m[2]}${m[3] !== undefined ? `.${m[3]}` : ''}`;
  return first.length > 60 ? first.slice(0, 60) : first;
}

module.exports = { parseClientSpec, clientIdOf, normalizeUserAgent };
