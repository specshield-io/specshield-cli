'use strict';

/**
 * Tolerate a leading `v` on user-supplied versions.
 *
 * The UI pill and several CLI displays render versions as `v<version>` for
 * readability; readers routinely paste those back into lookup flags
 * (`--version`, `--consumer-version`, `--provider-version`) where the leading
 * `v` then silently makes the query miss every record because the stored
 * value never has one.
 *
 * Strip a `v` (case-insensitive) ONLY when it sits in front of a digit, so
 * legitimate strings that start with `v` followed by a letter (`vendor-tag`,
 * `vNext`) pass through untouched.
 *
 * Applied at the entry of every LOOKUP action (`verify`, `can-i-deploy`).
 * NOT applied to publish actions — the publisher's version is whatever they
 * chose to store, including a literal `v` prefix if they want one.
 */
function stripVersionPrefix(v) {
  return typeof v === 'string' ? v.replace(/^v(?=\d)/i, '') : v;
}

module.exports = { stripVersionPrefix };
