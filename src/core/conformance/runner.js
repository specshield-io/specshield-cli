'use strict';

/**
 * Execute a set of conformance probes against the running provider.
 * Pure function-ish: takes probes + an `http(method, url, opts)` adapter
 * (so tests can inject without spinning a real HTTP client) and returns
 * a structured result list.
 *
 *   ProbeResult = {
 *     routePath:  '/users/{userId}',
 *     method:     'GET',
 *     resolvedPath: '/users/u-7',          // or null if skipped
 *     status:     'PASS' | 'FAIL' | 'SKIPPED' | 'ERROR',
 *     httpStatus: 200,                      // if reached
 *     reason:     human-readable summary,
 *     mismatches: [{path, message, expected, got}, …],  // only on FAIL
 *     skipReason: 'unresolved path params: paymentId',  // only on SKIPPED
 *     error:      'ECONNREFUSED …',                     // only on ERROR
 *   }
 *
 *   RunSummary = { total, pass, fail, skipped, error }
 */

const { resolveProbePath, collectSpecExamples } = require('./pathResolver');
const { pickResponseSchema } = require('./probeBuilder');
const { validateBody }       = require('./responseValidator');

/**
 * @param spec        dereferenced OAS (used to gather param examples)
 * @param probes      output of buildProbes(spec)
 * @param opts.baseUrl       e.g. 'https://staging.payments.acme.com'
 * @param opts.pathParams    { paymentId: 'pay-123', ... } CLI overrides
 * @param opts.headers       request headers to send (e.g. auth)
 * @param opts.http          async (method, url, {headers, timeoutMs}) → {status, body}
 * @param opts.timeoutMs     default 8000
 */
async function runProbes(spec, probes, opts) {
  const examples = collectSpecExamples(spec);
  const results = [];
  const http = opts.http;
  const baseUrl = String(opts.baseUrl || '').replace(/\/$/, '');

  for (const probe of probes) {
    const { resolved, missing } = resolveProbePath(
      probe.routePath, probe.method, examples, opts.pathParams,
    );

    if (missing.length > 0) {
      results.push({
        routePath: probe.routePath, method: probe.method,
        resolvedPath: null, status: 'SKIPPED',
        reason: `unresolved path params (no --path-params or spec example)`,
        skipReason: missing.join(', '),
      });
      continue;
    }

    const url = baseUrl + resolved;
    let httpStatus, body, err;
    try {
      const r = await http(probe.method, url, {
        headers: opts.headers || {},
        timeoutMs: opts.timeoutMs || 8000,
      });
      httpStatus = r.status;
      body = r.body;
    } catch (e) {
      err = e.message || String(e);
    }

    if (err) {
      results.push({
        routePath: probe.routePath, method: probe.method,
        resolvedPath: resolved, status: 'ERROR',
        reason: 'HTTP call failed', error: err,
      });
      continue;
    }

    const schema = pickResponseSchema(probe, httpStatus);
    if (schema === undefined) {
      results.push({
        routePath: probe.routePath, method: probe.method,
        resolvedPath: resolved, status: 'FAIL', httpStatus,
        reason: `actual status ${httpStatus} is not documented in the spec`,
        mismatches: [],
      });
      continue;
    }
    if (schema === null) {
      // Status documented but no JSON schema — accept any response body.
      results.push({
        routePath: probe.routePath, method: probe.method,
        resolvedPath: resolved, status: 'PASS', httpStatus,
        reason: 'status documented (no JSON schema to validate against)',
        mismatches: [],
      });
      continue;
    }

    const { ok, errors } = validateBody(body, schema);
    if (ok) {
      results.push({
        routePath: probe.routePath, method: probe.method,
        resolvedPath: resolved, status: 'PASS', httpStatus,
        reason: 'response matches spec schema',
        mismatches: [],
      });
    } else {
      results.push({
        routePath: probe.routePath, method: probe.method,
        resolvedPath: resolved, status: 'FAIL', httpStatus,
        reason: `response body does not match spec (${errors.length} mismatch${errors.length === 1 ? '' : 'es'})`,
        mismatches: errors,
      });
    }
  }

  return { results, summary: summarise(results) };
}

function summarise(results) {
  const s = { total: results.length, pass: 0, fail: 0, skipped: 0, error: 0 };
  for (const r of results) {
    if (r.status === 'PASS') s.pass++;
    else if (r.status === 'FAIL') s.fail++;
    else if (r.status === 'SKIPPED') s.skipped++;
    else if (r.status === 'ERROR') s.error++;
  }
  return s;
}

module.exports = { runProbes, summarise };
