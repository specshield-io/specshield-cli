'use strict';

/**
 * Resolve the hosted compare endpoint from a base URL.
 *
 * `--remote-url` is documented as "Override the hosted API base URL", but the
 * value used to be passed to axios verbatim — so `--remote-url https://host`
 * POSTed to the site root instead of /compare. The root answers with a web page
 * or a 405, and the CLI then died on `Cannot read properties of undefined
 * (reading 'filter')` while trying to read breakingChanges off HTML.
 *
 * A URL that already ends in /compare is returned unchanged, so anyone who
 * worked around the old behaviour by passing the full endpoint keeps working.
 */
function resolveRemoteUrl(remoteUrl, hostedDefault) {
  const base = String(remoteUrl || hostedDefault).trim().replace(/\/+$/, '');
  return /\/compare$/i.test(base) ? base : base + '/compare';
}

module.exports = { resolveRemoteUrl };
