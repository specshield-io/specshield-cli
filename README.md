# SpecShield CLI

[![npm](https://img.shields.io/npm/v/specshield)](https://www.npmjs.com/package/specshield)
[![downloads](https://img.shields.io/npm/dw/specshield)](https://www.npmjs.com/package/specshield)
[![license](https://img.shields.io/badge/license-MIT-blue)](#license)
[![node](https://img.shields.io/badge/node-%3E%3D20-green)](https://nodejs.org)

---

> **OpenAPI Diff · Breaking-Change Detection · Bi-Directional Contract Testing · `can-i-deploy` Gate · Pact-File Ingest · Live-Traffic Capture · Spec-vs-Production Conformance · GitHub PR Checks**

---

## Never ship a breaking change to your API consumers.

**SpecShield** is the one CLI that does four things to keep your API safe:

1. **Diff** two OpenAPI specs and fail CI on breaking changes.
2. **Bi-directional contract testing** with `can-i-deploy` — block a deploy that would break a consumer.
3. **`bdct capture from-har`** — turn recorded traffic into an accurate consumer contract (no Pact DSL).
4. **`bdct verify-provider`** — prove the running provider actually matches its OpenAPI spec.

```
OpenAPI diff  +  BDCT  +  HAR → consumer contract  +  spec-vs-production conformance  —  in one CLI.
```

No broker. No Pact DSL. Language-agnostic. Works in 30 seconds. Local mode never uploads your specs.

---

## The Problem

**APIs break silently. Your users feel it first.**

- A backend rename of `status` → `paymentStatus` — the mobile app crashes for 10,000 users.
- An endpoint gets removed — the frontend breaks with no error in your logs.
- A required field changes — partner integrations fail at 2am.
- You find out from an angry customer, not from CI.

Manual review doesn't catch it. Integration tests run too late.
**You need a contract between your services — and something that enforces it on every PR and every deploy.**

---

## The Solution

Think of SpecShield as **unit tests for your API contracts.**

- Consumers declare (or record) what they expect from the provider.
- The provider proves it satisfies those expectations before deploying.
- The pipeline blocks the deploy if anything breaks.

```
Consumer publishes contract  →  Provider verifies it  →  CI passes or blocks
```

No runtime surprise. No production incident. No 3am page.

---

## See It in Action

**Catch a breaking spec change in CI:**

```bash
$ specshield compare base.yaml target.yaml --fail-on-breaking

✖ BREAKING CHANGES DETECTED

  1. DELETE /users endpoint removed
  2. POST /payments — "amount" changed from optional to required
  3. GET /orders/{id} — "status" type changed: string → object

  Breaking changes : 3
  Modifications    : 1
  Additions        : 2

CI Result: FAILED  ·  Exit code: 1
```

**Catch the running provider drifting from its own spec:**

```bash
$ specshield bdct verify-provider --spec api/openapi.yaml --base-url https://staging.payments.acme.com

  Provider conformance — spec vs https://staging.payments.acme.com
  ────────────────────────────────────────────────────────────
    PASS   GET    /health  (200)
    FAIL   GET    /payments/{paymentId}  (200)
             /amount: must be number
    PASS   GET    /orders  (200)
  ────────────────────────────────────────────────────────────
  2 pass · 1 fail · 0 error · 0 skip   (3 probes)
```

**Turn recorded test traffic into an accurate consumer contract — no Pact DSL:**

```bash
$ specshield bdct capture from-har --in checkout-tests.har --base-url https://api.acme.com --out consumer.yaml

✔ Wrote consumer.yaml  (2 endpoints, 3 ops from 17/24 entries)
```

**That output just saved you a production incident.**

---

## Quick Start

No account, no login, no config file for `compare`. Just run it.

```bash
npm install -g specshield
specshield compare base.yaml target.yaml --fail-on-breaking
```

Works with any OpenAPI 3.x YAML or JSON.

**For BDCT**, run the wizard once and never re-type the same flags again:

```bash
specshield init
```

It auto-detects your spec, service name (from `package.json` / `pyproject.toml` / `pom.xml` / `go.mod`), git branch, and environment; writes **`.specshield.yml`**; and (optionally) seeds a GitHub Actions workflow. Every subsequent `specshield bdct …` invocation reads this file, so your CI commands collapse to:

```bash
specshield bdct publish-provider --version $GITHUB_SHA
specshield bdct can-i-deploy     --version $GITHUB_SHA
```

> **Quiet install for CI / Docker:** the post-install welcome banner auto-skips in CI (`CI`, `GITHUB_ACTIONS`, `BUILDKITE`, `CIRCLECI`, `GITLAB_CI`, `JENKINS_URL`, `TRAVIS`, `TF_BUILD`). To silence it on a workstation too: `export SPECSHIELD_NO_BANNER=1`.

---

## A Real-World Story

> The `payment-service` team merged a change that renamed `status` to
> `paymentStatus`. The `checkout-ui` team wasn't notified.
>
> Without SpecShield, this would have reached staging, broken checkout for
> every user, and triggered an incident at 2am.
>
> With SpecShield, the provider's CI published the new spec via
> `specshield bdct publish-provider`. The compatibility engine ran against
> `checkout-ui`'s published contract and the mismatch was caught immediately:
>
> ```
> ● MISSING_FIELD at $.status
>   expected: "CREATED"  →  actual: null
> ```
>
> `can-i-deploy` returned exit code `1`. The broken build never deployed.
> **Zero users affected.**

---

## Use Cases

- **Pull-request validation** — catch breaking changes before merge with `specshield compare`.
- **CI/CD gating** — exit code `1` stops the pipeline automatically.
- **Microservices contract safety** — consumers publish what they expect, providers verify they deliver it, no cross-team surprises.
- **API governance** — track API drift over time across your platform; know what changed, when, by whom.
- **Provider conformance** *(new)* — make sure your *running* service actually matches its published OpenAPI spec, not just on paper.
- **Pact-free consumer contracts** *(new)* — record real traffic with `capture from-har` and get an OpenAPI consumer contract without writing a single line of Pact DSL.

---

## Local vs Cloud

| Feature | Local (Free) | Team | Enterprise |
|---|---|---|---|
| Compare two spec files | ✅ | ✅ | ✅ |
| Breaking change detection | ✅ | ✅ | ✅ |
| JSON / human output | ✅ | ✅ | ✅ |
| Fail CI on breaking change | ✅ | ✅ | ✅ |
| **`bdct capture from-har`** | ✅ | ✅ | ✅ |
| **`bdct verify-provider`** | ✅ | ✅ | ✅ |
| `specshield history` — compare timeline | ❌ | ✅ | ✅ |
| `specshield share` — public report URLs | ❌ | ✅ | ✅ |
| Hosted dashboard | ❌ | ✅ | ✅ |
| GitHub App PR checks | ❌ | ✅ | ✅ |
| BDCT consumer registry + can-i-deploy gate | ❌ | ✅ | ✅ |
| BDCT compatibility matrix | ❌ | ✅ | ✅ |
| Team workspace + audit log + RBAC | ❌ | ✅ | ✅ |
| Slack notifications | ❌ | ✅ | ✅ |
| SAML SSO, SCIM, on-prem | ❌ | ❌ | ✅ |

> **The local-only commands are first-class.** `compare`, `bdct capture from-har`, and `bdct verify-provider` all run entirely in your CI — your spec text never leaves your infrastructure.

---

# Commands

## Local Compare

No account needed.

```bash
# Basic compare
specshield compare base.yaml target.yaml

# Fail CI on breaking changes
specshield compare base.yaml target.yaml --fail-on-breaking

# JSON output
specshield compare base.yaml target.yaml --json

# Save to file
specshield compare base.yaml target.yaml --output result.json

# Ignore a specific change
specshield compare base.yaml target.yaml --ignore "DELETE /admin removed" --fail-on-breaking
```

## Remote Compare

Sends your specs to SpecShield and stores results in your dashboard. Requires a free account.

```bash
specshield compare base.yaml target.yaml --remote
specshield compare base.yaml target.yaml --remote --fail-on-breaking
specshield compare base.yaml target.yaml --remote --json --output result.json
```

## Comparison History

Every `specshield compare --remote` is saved to your account. List recent comparisons from any machine — useful for tracking API drift over time across CI pipelines + local runs.

```bash
specshield history                # last 20 comparisons
specshield history --limit 50
specshield history --json
```

```
  Your recent comparisons
  ─────────────────────────────────────────────────────
  482        3 breaking         2026-05-17 14:30   payment-v1.yaml → payment-v2.yaml
  481        0 breaking         2026-05-17 11:02   user-api.yaml → user-api-updated.yaml
  480        7 breaking         2026-05-16 18:55   billing-v3.yaml → billing-v4.yaml
```

## Share a Comparison

Generate a public, tokenized URL for any comparison report. Great for Slack threads, PR comments, Jira tickets.

```bash
# Share an existing report by ID (from `specshield history`)
specshield share 482

# Compare two specs and share the result in one step
specshield share base.yaml target.yaml

# Time-limited link — expires in 30 days
specshield share 482 --expires 30
```

```
  ✔ Share link ready
    https://specshield.io/r/_Ru8OVubxY3r9zHOsylESaULphCqBYH5jTPYldSMU88
    Expires:  2026-06-16T12:34:56Z
```

Links use a 256-bit random token (unguessable by enumeration). Revoke any time from the dashboard.

## GitHub App — PR Checks

**Automatic API contract checks on every pull request — no workflow YAML required.**

Install once at **Dashboard → GitHub Integration**, choose your repos, done. Every PR that touches the OpenAPI spec gets:

- A GitHub check run (pass/fail) visible on the PR
- A sticky PR comment with the full diff (breaking changes highlighted)
- Configurable `failOnBreaking` per repository

Configure per-repo via `.specshield.yml`:

```yaml
github:
  specPath: api/openapi.yaml
  failOnBreaking: true
  commentOnPr: true
```

---

# Bi-Directional Contract Testing (BDCT)

**Compatibility without Pact's broker overhead or DSL.**

Both sides publish what they have — provider publishes its OpenAPI spec, consumer publishes either an OpenAPI subset *or* a Pact JSON file — and SpecShield's engine verifies that every endpoint/field the consumer relies on is satisfied by the provider. `can-i-deploy` then gates the deploy.

### How BDCT Works

1. Consumer publishes a contract (OpenAPI subset *or* Pact JSON).
2. Provider publishes its full OpenAPI spec.
3. SpecShield compares: endpoint presence, request schemas, response fields, status codes, types.
4. `can-i-deploy` returns `0` only when all consumers are compatible.

### Publish a Provider Spec

```bash
specshield bdct publish-provider \
  --org acme-store \
  --provider payment-service \
  --version v2.1.0 \
  --spec ./api/openapi.yaml \
  --env production \
  --branch main
```

`--branch` is optional — stamped on the published spec so you can correlate a spec version with the git branch it came from in `bdct list-providers`.

### Publish a Consumer Contract (OpenAPI subset or Pact JSON)

The consumer contract is an OpenAPI subset describing only the endpoints the consumer uses:

```yaml
# consumer-contract.yaml — only the subset checkout-ui uses
openapi: "3.0.0"
info: { title: checkout-ui → payment-service contract, version: "1.0.0" }
paths:
  /payments:
    post:
      requestBody:
        content:
          application/json:
            schema:
              type: object
              required: [orderId, amount, currency]
              properties:
                orderId:  { type: string }
                amount:   { type: number }
                currency: { type: string }
      responses:
        "201":
          content:
            application/json:
              schema:
                type: object
                properties:
                  paymentId: { type: string }
                  status:    { type: string }
```

```bash
specshield bdct publish-consumer \
  --org acme-store \
  --consumer checkout-ui \
  --provider payment-service \
  --version 2.0.0 \
  --contract ./contracts/checkout-ui-payment.yaml \
  --format OPENAPI
```

**Pact JSON contracts are also supported** — pass `--format PACT` and point `--contract` at a Pact file. The same compatibility engine runs against your provider's OpenAPI spec:

```bash
specshield bdct publish-consumer \
  --org acme-store \
  --consumer checkout-ui \
  --provider payment-service \
  --version 2.0.0 \
  --contract ./pacts/checkout-ui-payment-service.json \
  --format PACT
```

`--format` defaults to `OPENAPI` if omitted.

### Verify Compatibility

```bash
specshield bdct verify \
  --org acme-store \
  --consumer checkout-ui --consumer-version 2.0.0 \
  --provider payment-service --provider-version v2.1.0 \
  --env production
```

```
  ✖  INCOMPATIBLE

  Endpoints checked: 2
  Compatible       : 1
  Incompatible     : 1

  Issues
  ● POST /payments [ERROR] RESPONSE_FIELD_MISSING
    field: $.status
    Consumer expects it — provider spec does not return it

  ● GET /payments/{id} [WARNING] TYPE_MISMATCH
    field: $.amount
    consumer: integer  →  provider: string
```

### Can I Deploy?

```bash
specshield bdct can-i-deploy \
  --org acme-store --service payment-service \
  --version v2.1.0 --env production
```

```
  ✔  PASS: payment-service v2.1.0 is deployable in production
  ─────────────────────────────────────────────────────

  Consumer     Version  Status      Verified At
  ───────────  ───────  ──────────  ───────────────
  checkout-ui  2.0.0    COMPATIBLE  2026-05-13 14:32
  mobile-app   1.5.0    COMPATIBLE  2026-05-13 14:32
  partner-sdk  3.2.1    COMPATIBLE  2026-05-13 14:32
```

Exit codes: `0` = deployable · `1` = blocked · `2` = error.

### Compatibility Matrix

```bash
specshield bdct matrix --org acme-store --env production
```

```
  Consumer \ Provider  payment-service  order-service
  ───────────────────  ───────────────  ─────────────
  checkout-ui          COMPATIBLE       COMPATIBLE
  mobile-app           INCOMPATIBLE     COMPATIBLE
  partner-sdk          COMPATIBLE       UNKNOWN
```

### List Provider Specs / Consumer Contracts / Verifications

```bash
specshield bdct list-providers --org acme-store
specshield bdct list-providers --org acme-store --provider payment-service

specshield bdct list-consumers --org acme-store
specshield bdct list-consumers --org acme-store --consumer checkout-ui

specshield bdct list --org acme-store --provider payment-service --env production
```

### Full BDCT Workflow

```bash
# 1. Provider publishes spec on every release
specshield bdct publish-provider \
  --org acme-store --provider payment-service \
  --version v2.1.0 --spec ./api/openapi.yaml

# 2. Each consumer publishes their contract (update on contract change)
specshield bdct publish-consumer \
  --org acme-store --consumer checkout-ui \
  --provider payment-service --version 2.0.0 \
  --contract ./contracts/checkout-ui.yaml

# 3. Gate the provider deployment
specshield bdct can-i-deploy \
  --org acme-store --service payment-service \
  --version v2.1.0 --env production
```

### BDCT JSON Output

All BDCT commands support `--json` for CI parsing:

```bash
specshield bdct can-i-deploy --org acme-store --service payment-service --version v2.1.0 --json
```

```json
{
  "deployable": false,
  "service": "payment-service",
  "version": "v2.1.0",
  "environment": "production",
  "reason": "payment-service v2.1.0 is INCOMPATIBLE with: checkout-ui@2.0.0",
  "verifications": [
    { "consumerName": "checkout-ui", "consumerVersion": "2.0.0", "status": "INCOMPATIBLE",
      "compatibleCount": 1, "incompatibleCount": 1 }
  ]
}
```

---

# `bdct capture from-har` — record real traffic, get a consumer contract

**The Pact alternative for teams that don't want to adopt a DSL.**

`from-har` reads a [HAR file](https://en.wikipedia.org/wiki/HAR_(file_format)) (HTTP Archive — any browser, Cypress, Playwright, k6, Insomnia, or Charles Proxy can export one), filters to your provider's host, infers an OpenAPI 3.0 consumer-contract subset from what your tests actually called, and writes it to a file you can publish with `bdct publish-consumer`.

Why this matters: a hand-written consumer subset can be wrong (you forget the `currency` field your code reads, and the provider can remove it without anyone noticing). A HAR recording **captures what your code actually does** — without the Pact DSL, language-agnostic, runs anywhere.

### Generate a contract from a recorded test run

```bash
# Record a HAR (one of many ways)
#   - Chrome DevTools → Network → right-click → "Save all as HAR"
#   - Playwright:  page.on('request')... or use BROWSER_TOOLS_HAR
#   - Cypress:     cy.intercept(...) + plugins like cypress-har-generator
#   - k6:          k6 run --out har=run.har script.js

specshield bdct capture from-har \
  --in tests/checkout-run.har \
  --base-url https://api.acme.com \
  --out contracts/checkout-ui-payment.yaml
```

```
✔ Wrote contracts/checkout-ui-payment.yaml  (2 endpoints, 3 ops from 17/24 entries)
```

### Options

| Flag | Purpose |
|---|---|
| `--in <path>`           | **Required.** Input HAR file (HTTP Archive 1.2). |
| `--out <path>`          | Output file (default: stdout). |
| `--base-url <url>`      | Keep only entries matching this URL prefix (e.g. `https://api.acme.com` or `https://api.acme.com/v1`). |
| `--method <verbs>`      | Comma-separated methods to include (e.g. `GET,POST`). Default: all. |
| `--title <title>`       | OpenAPI `info.title`. Default: `Captured consumer contract`. |
| `--version <ver>`       | OpenAPI `info.version`. Default: `0.1.0`. |
| `--format <fmt>`        | Output format: `yaml` (default) or `json`. |
| `--include-non-json`    | Keep entries with non-JSON bodies (default: drop them — schemas can't be inferred). |

### What you get

- **Path templating:** concrete paths like `/users/123/orders/abc-2026` are turned into `/users/{userId}/orders/{orderId}` (the param is named from the preceding noun, not a generic `{id}`).
- **Per-status schema merging:** if two recorded GETs return slightly different shapes, the emitted schema is the merger — fields seen in EVERY sample stay `required`, fields seen in only SOME become optional, integer + number widens to number.
- **Format detection:** UUIDs, RFC 3339 date-times, and emails get `format: uuid|date-time|email`.
- **JSON-only by default:** non-JSON bodies are dropped (schemas can't be inferred from binary/HTML); override with `--include-non-json` for debugging.

### Use the captured contract in BDCT

```bash
specshield bdct publish-consumer \
  --org acme-store --consumer checkout-ui \
  --provider payment-service --version 2.0.0 \
  --contract contracts/checkout-ui-payment.yaml \
  --format OPENAPI
```

---

# `bdct verify-provider` — does your live provider actually match its spec?

**Active spec-vs-production conformance — Dredd-style, in CI.**

Most teams trust the provider's OpenAPI as the source of truth and never check whether the running service actually matches it. SpecShield's compatibility engine for BDCT is only as accurate as that trust — so `verify-provider` closes the loop by **firing probes derived from the spec at a running endpoint** (staging, usually) and validating every response body against the spec's schema for its status code.

Catches things like: the spec says `status ∈ {paid, pending, refunded}` but the live API sometimes returns `partially_refunded`. Or a field documented as `required` is sometimes missing. Or a `format: uuid` field actually contains a numeric ID.

### Safe by default

By default `verify-provider` only probes **safe** methods (GET, HEAD, OPTIONS) — it must never side-effect your staging data. Mutating methods are opt-in with `--include-mutating`.

### Run it

```bash
specshield bdct verify-provider \
  --spec api/openapi.yaml \
  --base-url https://staging.payments.acme.com
```

```
  Provider conformance — spec vs https://staging.payments.acme.com
  ────────────────────────────────────────────────────────────
    PASS   GET    /health  (200)
    FAIL   GET    /payments/{paymentId}  (200)
             /amount: must be number
    PASS   GET    /orders  (200)
    SKIP   GET    /unconfigured/{thingId}
             unresolved path params (no --path-params or spec example): thingId
  ────────────────────────────────────────────────────────────
  2 pass · 1 fail · 0 error · 1 skip   (4 probes)
```

Exit codes: `0` = all pass · `1` = at least one fail/error · `2` = config/spec error.

### Options

| Flag | Purpose |
|---|---|
| `--spec <path>`           | **Required.** Provider OpenAPI spec (YAML or JSON; `$ref`s are resolved). |
| `--base-url <url>`        | **Required.** Base URL of the running provider (e.g. `https://staging.payments.acme.com`). |
| `--include-mutating`      | Also probe POST/PUT/PATCH/DELETE. **Off by default** — never side-effects staging. |
| `--path-params <kvList>`  | Resolve path params: `paymentId=pay-123,userId=u-7`. Overrides spec examples. Repeatable. |
| `--header <header>`       | Extra request header to send, e.g. `--header "Authorization: Bearer $TOKEN"`. Repeatable. |
| `--timeout-ms <ms>`       | Per-request timeout (default: `8000`). |
| `--json`                  | Machine-readable JSON output (for CI parsing). |

### Path-parameter resolution

For path templates like `/payments/{paymentId}`, the resolution priority is:

1. `--path-params paymentId=pay-123` on the CLI (always wins)
2. The spec's `parameters[].example` for that param
3. **SKIPPED** with a reason if neither resolves

So you can declare examples in the spec once and never repeat them on the CLI:

```yaml
paths:
  /payments/{paymentId}:
    get:
      parameters:
        - name: paymentId
          in: path
          required: true
          schema: { type: string }
          example: pay-123       # ← verify-provider uses this automatically
```

### What the validator checks (per response)

- **Type / format** — `string`/`integer`/`number`/`boolean`/`array`/`object`, plus `format: uuid|date-time|email|...` (via `ajv-formats`).
- **Required fields** — flags any `required` field that's missing.
- **Enums** — flags values outside the documented enum set.
- **`nullable: true`** — properly allows `null` values (OAS-3.0-isms handled).
- **Status code coverage** — actual status must match an exact code, a wildcard (`4XX`), or the `default` response. An undocumented status is a FAIL.

### Run it from CI

```yaml
- name: Verify production matches spec
  env:
    STAGING_TOKEN: ${{ secrets.STAGING_TOKEN }}
  run: |
    specshield bdct verify-provider \
      --spec api/openapi.yaml \
      --base-url https://staging.payments.acme.com \
      --header "Authorization: Bearer $STAGING_TOKEN" \
      --json > conformance.json
```

---

# CI/CD — GitHub Actions

### On Pull Request — Catch breaking spec changes before merge

```yaml
name: API Contract Check
on:
  pull_request:
    branches: [main]

jobs:
  check-api-contract:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - uses: actions/setup-node@v4
        with: { node-version: '20' }
      - run: npm install -g specshield
      - run: git show origin/main:api/openapi.yaml > /tmp/base.yaml
      - run: specshield compare /tmp/base.yaml api/openapi.yaml --fail-on-breaking
```

### On Push — Publish provider spec + gate the deploy

```yaml
name: BDCT Publish & Deploy Gate
on:
  push:
    branches: [main]
    paths: ['api/openapi.yaml']

jobs:
  publish-bdct:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20' }
      - run: npm install -g specshield
      - name: Publish provider spec
        env: { SPECSHIELD_API_KEY: ${{ secrets.SPECSHIELD_API_KEY }} }
        run: |
          specshield bdct publish-provider \
            --org ${{ vars.SPECSHIELD_ORG }} \
            --provider payment-service \
            --version ${{ github.sha }} \
            --spec ./api/openapi.yaml \
            --env production
      - name: Gate the deploy
        env: { SPECSHIELD_API_KEY: ${{ secrets.SPECSHIELD_API_KEY }} }
        run: |
          specshield bdct can-i-deploy \
            --org ${{ vars.SPECSHIELD_ORG }} \
            --service payment-service \
            --version ${{ github.sha }} \
            --env production
```

### Nightly — Spec-vs-production conformance

```yaml
name: Provider Conformance
on:
  schedule: [{ cron: '0 7 * * *' }]   # daily 07:00 UTC
  workflow_dispatch:

jobs:
  conformance:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20' }
      - run: npm install -g specshield
      - name: Verify production matches its spec
        env: { STAGING_TOKEN: ${{ secrets.STAGING_TOKEN }} }
        run: |
          specshield bdct verify-provider \
            --spec api/openapi.yaml \
            --base-url https://staging.payments.acme.com \
            --header "Authorization: Bearer $STAGING_TOKEN"
```

---

## vs. Alternatives

| | **SpecShield** | **Pact / PactFlow** (SmartBear) | **oasdiff** | **Specmatic** / **Microcks** (OSS) |
|---|---|---|---|---|
| OpenAPI-native | ✅ | partial (Pact DSL) | ✅ | ✅ |
| No broker required | ✅ | ❌ (Pact Broker) | ✅ | ✅ |
| Bi-directional contract testing | ✅ | ✅ (Pactflow paid) | ❌ | partial |
| Breaking-change detection | ✅ | ❌ | ✅ | ❌ |
| `can-i-deploy` gating | ✅ | ✅ (broker) | ❌ | ❌ |
| **Pact JSON ingest** | ✅ | native | ❌ | ❌ |
| **HAR → consumer contract capture** | ✅ | ❌ (requires Pact DSL in tests) | ❌ | ❌ |
| **Spec-vs-production conformance** | ✅ | partial (ReadyAPI / Dredd) | ❌ | ✅ |
| GitHub App PR checks | ✅ | ❌ | ❌ | ❌ |
| Hosted dashboard | ✅ | ✅ (paid) | partial | ❌ |
| CLI-first | ✅ | ❌ | ✅ | partial |
| Free tier | ✅ | ❌ | ✅ (OSS) | ✅ (OSS) |

---

## Pricing

| Plan | Price | What's included |
|---|---|---|
| **Free** | $0 forever | Local compare · `bdct capture from-har` · `bdct verify-provider` · public web diff · 7-day compare history · 1 GitHub App PR check |
| **Team** | $89/mo ($75 annual) | Everything in Free + consumer registry · enforced `can-i-deploy` gate · audit trail · BDCT compatibility matrix · Slack alerts · team workspace + RBAC · priority email support |
| **Enterprise** | Talk to us | Everything in Team + SAML SSO · SCIM · on-prem / private-cloud · advanced RBAC + audit-log export · dedicated onboarding + SLA |

No credit card for the free plan. **[Get started free →](https://specshield.io)** · For Enterprise: [sales@specshield.io](mailto:sales@specshield.io).

---

## `specshield init` — first-run setup wizard

Run once at the root of your project. The wizard:

1. Detects your OpenAPI spec (looks under `api/`, `spec/`, `docs/`, repo root).
2. Detects your service name (`package.json`, `pyproject.toml`, `pom.xml`, `go.mod`, `Cargo.toml`, or directory name).
3. Detects your git branch and suggests `production` for `main`/`master`, `staging` otherwise.
4. Asks whether this project is a provider, a consumer, or both.
5. Asks for your org key (autocompletes from your account if signed in).
6. Validates / stores your API key.
7. Writes **`.specshield.yml`** and (optionally) a starter **`.github/workflows/specshield-bdct.yml`** using [`specshield26/bdct-action@v1`](https://github.com/marketplace/actions/specshield-bdct).

```bash
specshield init
```

### Example `.specshield.yml`

```yaml
schemaVersion: 1

failOnBreaking: true
severity: error

bdct:
  org: acme-pay
  environment: staging

  provider:
    name: payment-service
    spec: api/openapi.yaml

  # consumer (optional — present when --kind=consumer or --kind=both):
  # consumer:
  #   name: checkout-ui
  #   provider: payment-service
  #   contract: contracts/payment-service.yaml
  #   format: OPENAPI

github:
  specPath: api/openapi.yaml
  failOnBreaking: true
  commentOnPr: true
```

CLI flags **always** override this file. Paths in the file are resolved relative to the file's own directory, so you can run `specshield bdct …` from any subdirectory.

### Non-interactive (scriptable) mode

```bash
# Provider-only project
specshield init --no-interactive \
  --kind provider --org acme-pay \
  --provider payment-service --spec api/openapi.yaml \
  --env staging --write-workflow

# Consumer-only project
specshield init --no-interactive \
  --kind consumer --org acme-pay \
  --consumer checkout-ui --consumer-provider payment-service \
  --contract contracts/payment-service.yaml --format OPENAPI \
  --env staging
```

### All `init` flags

| Flag | Purpose |
|---|---|
| `--no-interactive` | Run without prompts; required fields must come from flags or auto-detection. |
| `--print` | Detect everything, print the proposed YAML to stdout, write nothing. |
| `--force` | Skip the overwrite-confirmation if `.specshield.yml` already exists. |
| `--server <url>` | Use a non-default SpecShield endpoint (self-hosted / staging). |
| `--kind <kind>` | `provider`, `consumer`, `both`, or `skip`. |
| `--org <key>` | Organization key. |
| `--provider <name>` | Provider service name. |
| `--spec <path>` | Path to the provider OpenAPI spec. |
| `--consumer <name>` | Consumer service name. |
| `--consumer-provider <name>` | The provider this consumer talks to. |
| `--contract <path>` | Path to the consumer contract (OpenAPI or Pact JSON). |
| `--format <fmt>` | Consumer contract format: `OPENAPI` (default) or `PACT`. |
| `--env <environment>` | Default environment for BDCT operations. |
| `--write-workflow` | Also write a starter GitHub Actions workflow. |

> **What is _not_ written into `.specshield.yml`:** your API key. It's stored in `~/.specshield/config.json` (set by `specshield login`) or read from `SPECSHIELD_API_KEY` in CI. The project file is committed; never commit a secret into it.

---

## Login & Authentication

**Step 1 — Create your account**

Go to [https://specshield.io](https://specshield.io) and sign in with GitHub or Google (30 seconds).

**Step 2 — Generate an API key**

Dashboard → **API Keys** → **Generate Key** → copy the `ss_` token.

**Step 3 — Authenticate the CLI**

```bash
specshield login --api-key ss_your_token_here
```

```
✔ Logged in successfully.
  Customer : Your Name
  Plan     : FREE
```

The token is stored in `~/.specshield/config.json` — no need to pass it on every command.

**Or use an environment variable (recommended for CI):**

```bash
export SPECSHIELD_API_KEY=ss_your_token_here
```

This one env var works for every command — `compare`, `login`, and every `bdct` subcommand all read it.

**Token resolution order:**
- `compare` / `login`: `--api-key` flag → `SPECSHIELD_API_KEY` env var → stored config → `.specshield.yml`
- `bdct …` subcommands: `--api-token` flag → `SPECSHIELD_API_KEY` env var → stored config

> **Why two flag names?** `compare` and `login` were built first and used `--api-key`. The newer `bdct` commands use `--api-token` to keep "key" reserved for the stored-config concept. The env var unifies both.

> **`bdct capture from-har` and `bdct verify-provider` don't require auth** — they run entirely locally against files / your own staging URL, and nothing is uploaded.

---

## Config File

Run [`specshield init`](#specshield-init--first-run-setup-wizard) to generate `.specshield.yml`, or hand-write it. Every `specshield …` invocation reads it from the project root (or any parent directory) and uses its values as defaults — CLI flags always win.

```yaml
schemaVersion: 1

# Local-compare defaults.
failOnBreaking: true
severity: error                  # info | warning | error
ignore:
  - "DELETE /admin removed"      # match by substring; repeatable

# Hosted compare (set --remote on the CLI to override).
remote:
  enabled: false
  url: https://specshield.io/compare
  timeout: 10000

# BDCT defaults (used by every `specshield bdct …` subcommand).
bdct:
  org: acme-pay
  environment: staging
  # server: https://specshield.io   # only for self-hosted / staging

  provider:
    name: payment-service
    spec: api/openapi.yaml          # paths are relative to this file
    # branch: main                  # informational tag on each publish

  # consumer:
  #   name: checkout-ui
  #   provider: payment-service
  #   contract: contracts/payment-service.yaml
  #   format: OPENAPI               # OPENAPI | PACT

# GitHub App + bdct-action defaults.
github:
  specPath: api/openapi.yaml
  failOnBreaking: true
  commentOnPr: true
```

With this file, BDCT commands collapse to `--version`:

```bash
specshield bdct publish-provider --version $GITHUB_SHA
specshield bdct can-i-deploy     --version $GITHUB_SHA
```

---

## All Options

```bash
specshield compare <base> <target> [options]
```

| Option | Description |
|---|---|
| `--remote` | Use the SpecShield hosted API |
| `--api-key <key>` | API token |
| `--fail-on-breaking` | Exit code 1 on breaking changes |
| `--allow-breaking` | Override fail-on-breaking |
| `--json` | Machine-readable JSON output |
| `--output <file>` | Save result to file |
| `--ignore <change>` | Ignore a specific change (repeatable) |
| `--severity <level>` | `info` / `warning` / `error` |
| `--config <path>` | Path to `.specshield.yml` |
| `--timeout <ms>` | Request timeout for remote mode |

```bash
specshield history [options]
```

| Option | Description |
|---|---|
| `--limit <n>` | Number of comparisons to list (default 20) |
| `--json` | Machine-readable JSON output |
| `--api-key <key>` | Override stored API key |

```bash
specshield share <reportId | base.yaml target.yaml> [options]
```

| Option | Description |
|---|---|
| `--expires <days>` | Make the link expire after N days (default: never) |
| `--api-key <key>` | Override stored API key |

```bash
specshield bdct <subcommand> [options]
```

| Subcommand | Description |
|---|---|
| `publish-provider` | Publish a provider OpenAPI spec |
| `publish-consumer` | Publish a consumer contract (OpenAPI subset or Pact JSON) |
| `verify` | Manually trigger verification for a consumer/provider pair |
| `can-i-deploy` | Check if a service version is safe to deploy |
| `matrix` | Compatibility matrix across all consumer/provider pairs |
| `list-providers` | List published provider specs |
| `list-consumers` | List published consumer contracts |
| `list` | List verification history |
| **`capture from-har`** | **Turn a recorded HAR file into an OpenAPI consumer contract** |
| **`verify-provider`** | **Check that a running provider service matches its OpenAPI spec** |

Every `bdct` subcommand accepts these flags in common:

| Flag | Purpose |
|---|---|
| `--org <key>` | Organization key (or read from `.specshield.yml`'s `bdct.org`) |
| `--json` | Machine-readable JSON output |
| `--server <url>` | Override SpecShield server URL (self-hosted / staging) |
| `--api-token <token>` | API token (overrides env / stored config) |

Per-subcommand flags:

| Subcommand | Flags |
|---|---|
| `publish-provider` | `--spec <path>`, `--provider <name>`, `--version <ver>`, `--env <env>`, `--branch <branch>` |
| `publish-consumer` | `--contract <path>`, `--consumer <name>`, `--provider <name>`, `--version <ver>`, `--format OPENAPI\|PACT` |
| `verify` | `--consumer <name>`, `--provider <name>`, `--consumer-version <ver>`, `--provider-version <ver>`, `--env <env>` |
| `can-i-deploy` | `--service <name>`, `--version <ver>`, `--env <env>` |
| `matrix` | `--env <env>` |
| `list-providers` | `--provider <name>` (filter) |
| `list-consumers` | `--consumer <name>`, `--provider <name>` (filters) |
| `list` | `--consumer <name>`, `--provider <name>`, `--env <env>`, `--page <n>`, `--size <n>` |
| **`capture from-har`** | `--in <path>` *required*, `--out <path>`, `--base-url <url>`, `--method <verbs>`, `--title <s>`, `--version <s>`, `--format yaml\|json`, `--include-non-json` |
| **`verify-provider`** | `--spec <path>` *required*, `--base-url <url>` *required*, `--include-mutating`, `--path-params <kv>` (repeatable), `--header <h>` (repeatable), `--timeout-ms <n>`, `--json` |

---

## Exit Codes

| Code | Meaning |
|---|---|
| `0` | Clean — no breaking changes / deployable / all probes pass |
| `1` | Breaking changes found / not deployable / one or more probes failed |
| `2` | Config error, missing token, or runtime error |

---

## License

MIT © Deepak Satyam

---

## Support

- 📧 [admin@specshield.io](mailto:admin@specshield.io)
- 🐛 [Open an issue on GitHub](https://github.com/specshield26/specshield-cli/issues)
- 🌐 [specshield.io](https://specshield.io)

---

<div align="center">

**[⭐ Star on GitHub](https://github.com/specshield26/specshield-cli) · [📦 View on npm](https://www.npmjs.com/package/specshield) · [🚀 Create free account](https://specshield.io)**

*Stop finding out about API breakage from your users.*

</div>
