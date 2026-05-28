'use strict';

/**
 * One-call orchestrator for `specshield bdct capture from-har`. Read a HAR
 * file → produce an OpenAPI 3.0 document (text + parsed) + a small summary
 * the CLI can print.
 *
 * This is Phase 1 of Fix 2 (the BDCT fidelity-roadmap "capture" feature):
 * HAR ingest specifically — language-agnostic, no TLS-proxy gymnastics.
 * Later phases can layer on live capture (Node `--require` interceptor,
 * full mitm proxy) without changing the downstream pipeline.
 */

const yaml = require('js-yaml');
const { readHarFile, normaliseEntries } = require('./parseHar');
const { harToOpenapi } = require('./emitOpenapi');

/**
 * @param filepath  path to a HAR file
 * @param opts      { baseUrl, methods, onlyJson, title, version, format,
 *                    dynamicPatterns }
 * @returns         { text, doc, summary }
 *
 *   text     — the OpenAPI document serialised (default: YAML)
 *   doc      — the same document as a JS object
 *   summary  — { harEntries, recordsKept, endpoints, operations }
 */
function captureFromHarFile(filepath, opts = {}) {
  const har = readHarFile(filepath);
  const records = normaliseEntries(har, {
    baseUrl: opts.baseUrl,
    methods: opts.methods,
    onlyJson: opts.onlyJson,
  });
  const doc = harToOpenapi(records, {
    title: opts.title,
    version: opts.version,
    baseUrl: opts.baseUrl,
    dynamicPatterns: opts.dynamicPatterns,
  });

  const fmt = String(opts.format || 'yaml').toLowerCase();
  const text = fmt === 'json'
    ? JSON.stringify(doc, null, 2) + '\n'
    : yaml.dump(doc, { noRefs: true, sortKeys: false, lineWidth: 120 });

  return {
    text,
    doc,
    summary: {
      harEntries: har.log.entries.length,
      recordsKept: records.length,
      endpoints: Object.keys(doc.paths || {}).length,
      operations: countOperations(doc),
    },
  };
}

function countOperations(doc) {
  let n = 0;
  const methods = ['get','post','put','patch','delete','head','options','trace'];
  for (const item of Object.values(doc.paths || {})) {
    for (const k of Object.keys(item)) if (methods.includes(k)) n++;
  }
  return n;
}

module.exports = { captureFromHarFile };
