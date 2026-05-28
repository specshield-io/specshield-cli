'use strict';

/**
 * Read + normalise a HAR (HTTP Archive 1.2) file into the minimal record
 * shape the OpenAPI emitter consumes.
 *
 *   readHarFile(path)                 → parsed HAR object (validates shape)
 *   normaliseEntries(har, opts)       → HarRecord[]
 *
 * HarRecord = {
 *   method:               'GET' | 'POST' | …,
 *   url:                  URL object,
 *   path:                 '/users/123',
 *   query:                { limit: '10', … },
 *   requestBody:          parsed JSON | undefined,
 *   responseStatus:       200,
 *   responseBody:         parsed JSON | undefined,
 *   requestContentType:   'application/json' | null,
 *   responseContentType:  'application/json' | null,
 * }
 */

const fs = require('fs');
const { URL } = require('url');

function isJsonMimeType(m) {
  if (!m) return false;
  return /\bjson\b/i.test(m);
}

function safeJsonParse(text) {
  if (typeof text !== 'string' || text.trim().length === 0) return undefined;
  try { return JSON.parse(text); } catch { return undefined; }
}

function readHarFile(filepath) {
  const raw = fs.readFileSync(filepath, 'utf8');
  let doc;
  try { doc = JSON.parse(raw); }
  catch (e) { throw new Error(`Not valid HAR JSON: ${filepath} (${e.message})`); }
  if (!doc || typeof doc !== 'object' || !doc.log || !Array.isArray(doc.log.entries)) {
    throw new Error(`Not a HAR file (missing log.entries): ${filepath}`);
  }
  return doc;
}

/**
 * @param har          parsed HAR object
 * @param opts.baseUrl filter: keep only entries whose URL host (and optional
 *                     prefix path, e.g. /v1) matches. Bare host accepted.
 * @param opts.methods filter: keep only these HTTP methods (case-insensitive)
 * @param opts.onlyJson default true — drop entries whose bodies are non-JSON
 */
function normaliseEntries(har, opts = {}) {
  const out = [];
  const entries = har.log.entries;
  const baseUrl = opts.baseUrl ? normaliseBase(opts.baseUrl) : null;
  const methods = Array.isArray(opts.methods) && opts.methods.length > 0
    ? new Set(opts.methods.map(m => m.toUpperCase()))
    : null;
  const onlyJson = opts.onlyJson !== false;

  for (const e of entries) {
    if (!e || !e.request) continue;
    let url;
    try { url = new URL(e.request.url); } catch { continue; }

    const method = String(e.request.method || 'GET').toUpperCase();
    if (methods && !methods.has(method)) continue;
    if (baseUrl && !urlMatchesBase(url, baseUrl)) continue;

    const reqMime = headerValue(e.request.headers, 'content-type');
    const resMime = e.response && e.response.content && e.response.content.mimeType;

    const requestBody  = safeJsonParse(e.request.postData && e.request.postData.text);
    const responseBody = safeJsonParse(e.response && e.response.content && e.response.content.text);

    // Drop entries whose declared body is non-JSON (or undecodable). We can't
    // infer a JSON Schema from binary/multipart/HTML, and silently emitting
    // a wrong schema would be worse than dropping the sample.
    if (onlyJson) {
      const hasReqText = e.request.postData && typeof e.request.postData.text === 'string'
                        && e.request.postData.text.length > 0;
      if (hasReqText && requestBody === undefined && !isJsonMimeType(reqMime)) continue;

      const hasResText = e.response && e.response.content
                        && typeof e.response.content.text === 'string'
                        && e.response.content.text.length > 0;
      if (hasResText && responseBody === undefined && !isJsonMimeType(resMime)) continue;
    }

    const query = {};
    url.searchParams.forEach((v, k) => { query[k] = v; });

    out.push({
      method,
      url,
      path: url.pathname,
      query,
      requestBody,
      responseStatus: e.response ? e.response.status : 0,
      responseBody,
      requestContentType: reqMime || null,
      responseContentType: resMime || null,
    });
  }
  return out;
}

function headerValue(headers, name) {
  if (!Array.isArray(headers)) return null;
  const wanted = name.toLowerCase();
  for (const h of headers) {
    if (h && typeof h.name === 'string' && h.name.toLowerCase() === wanted) return h.value;
  }
  return null;
}

function normaliseBase(base) {
  if (!base) return null;
  if (!/^https?:\/\//i.test(base)) base = `https://${base}`;
  try { return new URL(base); } catch { return null; }
}

function urlMatchesBase(url, baseUrl) {
  if (!baseUrl) return true;
  if (url.host !== baseUrl.host) return false;
  if (url.protocol !== baseUrl.protocol) return false;
  const basePath = baseUrl.pathname.replace(/\/$/, '');
  if (basePath && basePath !== '/' &&
      !url.pathname.startsWith(basePath + '/') &&
      url.pathname !== basePath) return false;
  return true;
}

module.exports = { readHarFile, normaliseEntries, isJsonMimeType };
