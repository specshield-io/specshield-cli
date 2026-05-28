'use strict';

/**
 * One-call orchestrator for `specshield bdct verify-provider` — the
 * "spec-vs-production conformance" check (Fix 3 of the BDCT fidelity
 * roadmap).
 *
 * Loads + dereferences an OpenAPI spec, derives a probe list (safe methods
 * only by default), fires the probes at the running provider, validates
 * each response body against the spec's schema for that status, and
 * returns a structured result + summary.
 *
 * Defaults are deliberately conservative — this tool is pointed at REAL
 * customer services (typically staging, sometimes prod), so:
 *
 *   - Only GET / HEAD / OPTIONS unless `includeMutating: true`.
 *   - Probes whose path params can't be resolved are SKIPPED, not guessed.
 *   - Network errors are reported as ERROR results — never thrown — so a
 *     single flaky endpoint doesn't kill the whole run.
 */

const axios = require('axios');
const SwaggerParser = require('@apidevtools/swagger-parser');
const { buildProbes } = require('./probeBuilder');
const { runProbes }   = require('./runner');

async function verifyProvider(opts) {
  const spec = await SwaggerParser.dereference(opts.spec);
  const probes = buildProbes(spec, { includeMutating: !!opts.includeMutating });
  const http = opts.http || defaultHttpAdapter;
  return runProbes(spec, probes, {
    baseUrl: opts.baseUrl,
    pathParams: opts.pathParams,
    headers: opts.headers,
    timeoutMs: opts.timeoutMs,
    http,
  });
}

/** Default HTTP adapter (axios). Returns { status, body } and rejects only
 *  on connection-level failures — HTTP error statuses come back as data. */
async function defaultHttpAdapter(method, url, { headers, timeoutMs }) {
  const res = await axios.request({
    method, url, headers, timeout: timeoutMs,
    validateStatus: () => true,    // never throw on 4xx/5xx; the validator decides
    responseType: 'json',
    transitional: { silentJSONParsing: true, forcedJSONParsing: true },
  });
  return { status: res.status, body: res.data };
}

module.exports = { verifyProvider, defaultHttpAdapter };
