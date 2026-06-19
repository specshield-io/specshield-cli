# SpecShield CLI changelog

## 3.3.0 — 2026-06-20 — Complex-spec hardening + "contract compatibility testing"

A minor release focused on the local diff engine's accuracy on advanced OpenAPI
constructs, plus naming and packaging updates. The `bdct` command names are
unchanged — your existing CI keeps working.

### Added

- **Polymorphism & union support in `compare`.** `oneOf` / `anyOf` are no longer
  flattened into a single object; each variant is captured and compared
  independently. New change types surface in the diff:
  - `SCHEMA_VARIANT_ADDED` (non-breaking) / `SCHEMA_VARIANT_REMOVED` (breaking)
  - `SCHEMA_DISCRIMINATOR_CHANGED` (breaking — discriminator renamed/removed)
  - field-level changes *inside* a matched variant are now detected.
- **`additionalProperties` (free-form maps / dictionaries)** value schemas are
  now captured and diffed — a field removed/changed inside map values is caught.
- **OpenAPI 3.1 null-unions** (`type: [x, "null"]`) normalize to a base type +
  `nullable`, so 3.1 specs compare cleanly against 3.0's `nullable: true` and
  don't surface a bogus type-change.

### Changed

- **Naming:** SpecShield is now described as **contract compatibility testing**
  (a.k.a. bidirectional contract testing) across the README and package metadata.
  No command or flag changed.
- `oneOf` / `anyOf` handling no longer over-marks fields as `required` (the old
  merge concatenated every variant's `required`), removing a class of
  false-positive breaking changes.
- The local `compare` engine and the hosted BDCT `verify` engine are now aligned
  on union / map / enum / 3.1 semantics — `compare` and `verify` give consistent
  verdicts on the same spec.

### Packaging / legal

- `LICENSE` copyright and `package.json` author now attribute the project to
  **SpecShield Software Private Limited**.
- The `specshield-bdct-action` default `cli-version` now tracks **`~3.3.0`**
  (the latest 3.3.x patch), so action users get 3.3 bug-fixes automatically.

> Note: this entry documents everything since the last documented release (3.2.7),
> including what shipped in the 3.2.8–3.2.9 patches. `enum` value-removal detection
> (`ENUM_VALUE_REMOVED`, breaking) is part of this aligned engine work.

## 3.2.7 — 2026-06-12 — `history` + `share` now work from the CLI

`specshield history` and `specshield share` were previously "UI-only" stubs —
the backend's comparison-history and share-link endpoints lived on JWT-only
routes that rejected the CLI's API key. The backend now exposes API-key-callable
endpoints (`/api/compare-history`, `/api/share-links`) and `/compare` returns the
saved comparison's id, so the full CLI/CI flow works end to end.

### Added

- **`specshield history`** lists your recent comparisons (id, breaking count,
  date, `base → target`). Honors `--limit` and `--json`. Reads the new
  `/api/compare-history` endpoint.
- **`specshield share <id>`** generates a public `/r/<token>` link for a saved
  comparison via the new `/api/share-links` endpoint. `--expires <days>` sets an
  expiry. `specshield share <base> <target>` still compares-and-shares in one step.
- **`compare --remote` now returns a `historyId`** when run with an API key —
  feed it straight into `specshield share` (the CI "compare → share link in PR
  comment" flow).

### Changed

- `compare --remote`'s footer is accurate again: with an API key the comparison
  is saved (no note); without one it notes the diff ran but wasn't saved.
- Removed the "currently UI-only" notices from `history` / `share` (and the
  matching README callouts) now that both work.

### Fixed

- `specshield share` validates the report id is a positive number and gives a
  clear message (pointing at `specshield history`) instead of a server 400.

## 3.2.4–3.2.6 — 2026-05-29 → 2026-06-03 — `whoami`, can-i-deploy fix, runnable examples

A series of small patches, consolidated here (they predate the 3.2.7 history/share work).

### Added

- **`specshield whoami`** — prints the authenticated user, plan, and the org keys
  you can pass to `--org`.
- **`examples/playwright-har/`** — a runnable Playwright → HAR → `bdct capture`
  starter you can clone and run in ~30 seconds against a public sandbox.

### Fixed

- **`can-i-deploy` / `verify` `v`-prefix round-trip.** Versions were displayed as
  `v1.0.0`; pasting that back into `--version` queried `v1.0.0` and matched zero
  records (the stored value is `1.0.0`), so the gate failed open. A leading `v`
  before a digit is now stripped on input, and the display is idempotent.

### Docs / CI

- README: grouped table of contents and a flagship rewrite of the
  `bdct capture from-har` section; added a weekly smoke workflow that runs the
  example against the published CLI.

## 3.2.3 — 2026-05-28 — BDCT fidelity: HAR capture + provider conformance

Two new `bdct` sub-commands that close the contract-fidelity gap PactFlow
historically owned — both **fully local, no API token, nothing uploaded**,
language-agnostic, and built mature with full test coverage (60 new tests).

### Added

- **`specshield bdct capture from-har`** — record real test traffic, get an
  accurate OpenAPI consumer contract. Reads a HAR file (any browser /
  Cypress / Playwright / k6 / Charles can export one), filters to the
  provider's host, and emits an OpenAPI 3.0 subset describing only the
  endpoints + fields the consumer actually called and read. No Pact DSL.

  - Context-aware path templating: `/users/123` → `/users/{userId}`
    (param named from the preceding noun, not a generic `{id}`).
  - Per-status schema merging across all samples: fields seen in EVERY
    sample stay `required`, fields seen in only SOME become optional;
    `integer + number` widens to `number`; type conflict falls back to
    the more permissive type.
  - Detects common formats (`uuid`, `date-time`, `email`).
  - Filters: `--base-url`, `--method`, `--include-non-json`.
  - Output: YAML (default) or JSON; feeds straight into
    `bdct publish-consumer --format OPENAPI`.

- **`specshield bdct verify-provider`** — active spec-vs-production
  conformance (Dredd-style, in CI). Fires probes derived from your
  OpenAPI spec at a running provider (typically staging) and validates
  every response body against the spec's schema for that status code.
  Catches the "spec says X but live API returns Y" drift that BDCT
  alone can't see.

  - **Safe by default**: probes only `GET`, `HEAD`, `OPTIONS` —
    `--include-mutating` is required to also probe `POST`/`PUT`/
    `PATCH`/`DELETE`. Never side-effects staging data accidentally.
  - Validates type, format (uuid/date-time/email/…), required fields,
    enums, `nullable: true`, and status-code coverage (exact / wildcard
    `4XX` / `default`).
  - Path-parameter resolution: `--path-params` CLI overrides win,
    else spec `parameters[].example`, else **SKIPPED** with a reason
    (never guesses).
  - Network errors → `ERROR` result, never thrown — a single flaky
    endpoint doesn't kill the whole run.
  - Human report + summary, or `--json` for CI parsing. Exit `1` on
    any FAIL/ERROR.

- **README rewrite** — surfaces both new commands as first-class
  sections; removed two outdated visuals; pricing/tier copy updated
  to **Free / Team / Enterprise**; vs-Alternatives extended with
  Specmatic and Microcks. Reference sections moved to the bottom for
  better promotion flow.

### Dependencies

- Added `ajv@^8` + `ajv-formats@^3` for JSON-schema validation of
  responses in `verify-provider`.
- Added `@apidevtools/swagger-parser@^10` for OpenAPI parsing +
  `$ref` resolution.

### Internal

- New module trees under `src/core/har/` (HAR ingest pipeline) and
  `src/core/conformance/` (active probing engine).
- 60 new tests: `tests/harCaptureCore.test.js` (33) +
  `tests/conformance.test.js` (27 — including 6 end-to-end against a
  real in-process `http.Server`). Full CLI suite: **249 passing**.

### Backwards compatibility

- Pure additions — no breaking changes to existing commands or flags.
- `bdct capture` and `bdct verify-provider` are new sub-commands;
  every existing `bdct` flow continues to work unchanged.

---

## 3.2.0 — 2026-05-17 — Conversion fixes

Three CLI changes designed to make the Cloud features (history, share URLs,
PR checks, BDCT) visible to the 2,000+ existing CLI users who run local
`specshield compare` but never discover what signing up unlocks.

### Added

- **Post-install welcome banner** — runs once after a fresh `npm install -g specshield`.
  Briefly explains the value progression (Local → Cloud Free → Pro) and points
  to the next command to try. Skipped automatically in CI, in non-TTY shells,
  on update installs, and when `SPECSHIELD_NO_BANNER=1` is set.

- **Contextual signup prompt after `specshield compare`** — after 3+ compares
  per week, a soft 3-line nudge appears below the regular output:
  ```
  ● Track these comparisons over time:
    specshield login   # 30-sec signup via GitHub / Google · no credit card
    Unlocks: compare history, shareable report URLs, PR badge
  ```
  Throttled to once per week so it never spams. Suppressed entirely for
  logged-in users, `--json` output, CI environments, and on opt-out. The
  prompt copy escalates at 10 and 25 compares per window.

- **`specshield history`** — new command to list recent comparisons saved
  in your Cloud account. Surfaces in `specshield --help` so local-only
  users discover the feature exists.

- **`specshield share <report-id | base.yaml target.yaml>`** — generate a
  public shareable URL for a comparison. Designed for pasting diffs into
  Slack, PR comments, or Jira. Cloud account required.

Both new commands print a friendly "Get started in 30 seconds" message
with a `specshield login` deep link when run without credentials.

### Why

Background: in May 2026 the CLI had 2,000+ active monthly users (npm download
estimate; real human count likely 200-500) but the SpecShield Cloud signup
rate from the CLI was effectively zero. Local compare was so capable that
users got 100% of their immediate value without ever needing an account.

These changes don't remove any free functionality — local compare is still
fully usable without signup — they just make the gap between local and
cloud visible at the moments when a user is most engaged (post-install,
post-compare, on `--help`).

### Tests

- Added `tests/core/conversionPrompt.test.js` covering all skip conditions,
  threshold logic, escalation, and 7-day window reset (10 tests).
- All 134 existing tests still pass.

### Opting out

If you don't want the banner or contextual prompts:

```sh
export SPECSHIELD_NO_BANNER=1     # disable banner + post-compare nudge
```

Or just sign up — logged-in users never see either.
