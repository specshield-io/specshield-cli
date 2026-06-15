# SpecShield CLI

[![npm](https://img.shields.io/npm/v/specshield)](https://www.npmjs.com/package/specshield)
[![downloads](https://img.shields.io/npm/dw/specshield)](https://www.npmjs.com/package/specshield)
[![license](https://img.shields.io/badge/license-MIT-blue)](#license)
[![node](https://img.shields.io/badge/node-%3E%3D20-green)](https://nodejs.org)

## Contents

**Get started**
- [Quick Start](#quick-start) · [`specshield init` wizard](#specshield-init--first-run-setup-wizard) · [Login & Authentication](#login--authentication)

**Why SpecShield**
- [The Problem](#the-problem) · [The Solution](#the-solution) · [See It in Action](#see-it-in-action) · [Use Cases](#use-cases)
- [Local vs Cloud](#local-vs-cloud) · [vs. Alternatives](#vs-alternatives) · [Pricing](#pricing)

**Commands — local & hosted compare**
- [Local Compare](#local-compare) · [Remote Compare](#remote-compare) · [Comparison History](#comparison-history) · [Share a Comparison](#share-a-comparison) · [GitHub App PR Checks](#github-app--pr-checks)

**Contract Compatibility Testing — the `bdct` commands**
- [Overview & full command reference](#bi-directional-contract-testing-bdct)
- [`bdct capture from-har` — HAR → consumer contract](#bdct-capture-from-har--turn-real-traffic-into-a-consumer-contract)
  - [Step 1 — record a HAR](#step-1--record-a-har-file) · [Step 2 — generate contract](#step-2--turn-the-har-into-a-consumer-contract) · [Step 3 — publish + gate](#step-3--publish--gate) · [Operational concerns](#operational-concerns-read-this-before-going-live)
- [`bdct verify-provider` — spec-vs-production conformance](#bdct-verify-provider--does-your-live-provider-actually-match-its-spec)

**CI/CD**
- [GitHub Actions workflows](#cicd--github-actions)

**Reference**
- [Config File](#config-file) · [All Options](#all-options) · [Exit Codes](#exit-codes)

**Project**
- [License](#license) · [Support](#support)

---

> **Contract Compatibility Testing · OpenAPI Diff · Breaking-Change Detection · `can-i-deploy` Deploy Gate · Pact-File Ingest · Live-Traffic Capture · Spec-vs-Production Conformance · GitHub PR Checks**

---

## Never ship a breaking change to your API consumers

**SpecShield is contract compatibility testing for APIs** — catch breaking changes before they reach your consumers, and gate every deploy with `can-i-deploy`. *(Contract compatibility testing is also known as bidirectional contract testing.)*

It's the one CLI that does four things to keep your API safe:

1. **Diff** two OpenAPI specs and fail CI on breaking changes.
2. **Contract compatibility testing** with `can-i-deploy` — block a deploy that would break a consumer.
3. **`bdct capture from-har`** — turn recorded traffic into an accurate consumer contract (no Pact DSL).
4. **`bdct verify-provider`** — prove the running provider actually matches its OpenAPI spec.

```
OpenAPI diff  +  contract compatibility checks  +  HAR → consumer contract  +  spec-vs-production conformance  —  in one CLI.
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

Sends your specs to SpecShield's hosted diff engine. Useful for keeping the
heavy comparison off your CI runner and for cross-validating against the
exact engine the dashboard uses. Requires a free account.

```bash
specshield compare base.yaml target.yaml --remote
specshield compare base.yaml target.yaml --remote --fail-on-breaking
specshield compare base.yaml target.yaml --remote --json --output result.json
```

> **History note:** with an API key set (run `specshield login`, or pass
> `--api-key` / `SPECSHIELD_API_KEY`), `--remote` saves each comparison to
> your history and the response includes a `historyId` you can hand to
> `specshield share`. Without a key the diff still runs — it just isn't saved.

## Comparison History

Every comparison you run with `--remote` (and every one from the dashboard) is
saved to your account — useful for tracking API drift over time across team
members and machines. List them straight from the CLI:

```bash
specshield history                # last 20 comparisons
specshield history --limit 50
specshield history --json
```

The dashboard at
[specshield.io/account/history](https://specshield.io/account/history) shows
the same data with per-comparison drill-down.

Example output:

```
  Your recent comparisons
  ─────────────────────────────────────────────────────
  482        3 breaking         2026-05-17 14:30   payment-v1.yaml → payment-v2.yaml
  481        0 breaking         2026-05-17 11:02   user-api.yaml → user-api-updated.yaml
  480        7 breaking         2026-05-16 18:55   billing-v3.yaml → billing-v4.yaml
```

## Share a Comparison

Generate a public `/r/<token>` link for any comparison — paste it into Slack, a
GitHub PR comment, or a Jira ticket and anyone can view the diff without a
SpecShield account. You can also create links from the dashboard (open a
comparison at [specshield.io/account/history](https://specshield.io/account/history)
→ "Share").

Usage:

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

Links use a 256-bit random token (unguessable by enumeration). Revoke any
time from the dashboard.

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

# `bdct capture from-har` — turn real traffic into a consumer contract

**This is the feature that makes BDCT actually work for normal teams.**
Pact requires every consumer team to learn a DSL, instrument their tests,
and run a broker. SpecShield asks for something they already have: a
recording of an HTTP test run, in the universal HAR format that every
browser, every test framework, and every recording proxy already produces.

A hand-written consumer contract drifts the moment you forget a field. A
HAR-derived contract reflects what your code **actually called**, every
time you re-record. It's the difference between "we documented the
integration" and "we proved the integration."

### The 3-step mental model

```
┌─────────────────────────────────────────────────────────────────────────┐
│  1. RECORD                  2. CAPTURE                  3. GATE          │
│                                                                          │
│  Your existing test run  →  specshield bdct          →  publish-consumer │
│  → traffic.har               capture from-har           verify           │
│  (browser / Playwright /     → consumer-contract.yaml   can-i-deploy     │
│   Cypress / mitmproxy /                                                  │
│   Postman / k6 / …)         ← language-agnostic       ← every provider   │
│                              CLI does the OpenAPI       PR re-checks     │
│                              inference                  every consumer   │
└─────────────────────────────────────────────────────────────────────────┘
```

Step 1 already happens in your team — you're just saving the file. Step 2
is one CLI command. Step 3 is the BDCT registry you publish to.

---

## Step 1 — record a HAR file

Pick the recorder that matches **how the consumer is exercised** in your
project. You almost never have to write recorder code yourself.

| Recorder | Use when the consumer is… | Effort |
|---|---|---|
| **[Browser DevTools](https://developer.chrome.com/docs/devtools/network/reference#save)** (Chrome / Firefox / Edge / Safari) | A frontend SPA, a Swagger UI, or any browser-driven app | Zero code |
| **[Playwright](https://playwright.dev/docs/api/class-browser#browser-new-context-option-record-har)** with `recordHar` | Exercised by Playwright UI/integration tests | **One config field** |
| **[Cypress](https://github.com/NeuraLegion/cypress-har-generator)** + `cypress-har-generator` | Exercised by Cypress UI tests | One plugin |
| **[mitmproxy](https://docs.mitmproxy.org/stable/addons-examples/#har-dump)** | A backend service-to-service caller in a test env | One brew install, no consumer changes |
| **[Postman](https://learning.postman.com/docs/getting-started/importing-and-exporting/exporting-postman-data/#exporting-as-har)** / Insomnia / Bruno | Manually exercised during exploratory testing | Right-click → export |
| **[k6](https://grafana.com/docs/k6/latest/results-output/real-time/json/#har)** load tests | Already running k6 against the provider | One `--out har=…` flag |

**Recipes follow** — keep reading for the exact commands per tool, then jump
to Step 2 (the capture command, which is identical regardless of recorder).

### 1a. Chrome / Firefox / Edge DevTools (zero code — best for frontend)

1. Open the page that calls your API in the browser.
2. Open DevTools (`F12` / `Cmd+Opt+I`) → **Network** tab.
3. Click the 🚫 button to clear, then reload the page and click through the
   flows you want to record.
4. Right-click anywhere in the request list → **Save all as HAR with
   content** → save as `traffic.har`.

That's the entire recording. The file is byte-compatible with everything
SpecShield does.

> **Safari note:** Safari's "Export HAR" is under the Develop menu →
> *Export…* in the Network tab; it produces the same format.

### 1b. Playwright (best for teams with UI tests)

Add one option to your `playwright.config.js`:

```js
// playwright.config.js
const path = require('path');
module.exports = {
  testDir: './tests',
  use: {
    baseURL: 'https://staging.acme.com',
    recordHar: { path: path.resolve(__dirname, 'traffic.har'), mode: 'full', content: 'embed' },
  },
};
```

Run your tests as usual:

```bash
npx playwright test
# → writes traffic.har on context close
```

The HAR will contain every HTTP call the browser made during the test —
HTML, JS, images, and the API JSON. The `--onlyJson` default in Step 2
filters out the noise automatically.

> Need the HAR file flushed **per test**? Create the context explicitly in
> your test and call `await context.close()` at the end. A runnable
> copy-paste starter lives in [`examples/playwright-har/`](examples/playwright-har/)
> of this repo — clone, `npm install`, `npx playwright install chromium`,
> `npm test` produces `traffic.har` against the public JSONPlaceholder
> sandbox so you can verify the toolchain works before pointing it at your
> own provider.

### 1c. Cypress

```bash
npm i -D @neuralegion/cypress-har-generator
```

```js
// cypress.config.js
const { install } = require('@neuralegion/cypress-har-generator');
module.exports = { e2e: { setupNodeEvents(on, config) { install(on); return config; } } };

// cypress/support/e2e.js
beforeEach(() => cy.recordHar());
afterEach(() => cy.saveHar({ outDir: './har-out' }));
```

Run `npx cypress run` and the HAR for each spec lands in `har-out/`.

### 1d. mitmproxy (best for backend service-to-service)

When the consumer is a backend service (no browser), point it through
mitmproxy in your integration-test env. No consumer code change.

```bash
# Install once
brew install mitmproxy            # macOS — also available via pip and apt

# Start the proxy and tell it to dump HAR
mitmdump --set hardump=traffic.har --listen-port 8080

# In another terminal: run your tests with HTTPS_PROXY pointing at it
HTTPS_PROXY=http://localhost:8080 HTTP_PROXY=http://localhost:8080 \
  ./run-integration-tests.sh

# Ctrl-C mitmdump when done — traffic.har is on disk
```

The `hardump` add-on is built into mitmproxy ≥ 9.0. For TLS hosts you'll
need to trust mitmproxy's CA in your test JVM/runtime (see the
[mitmproxy CA docs](https://docs.mitmproxy.org/stable/concepts-certificates/));
in many test environments it's a single env var
(`NODE_EXTRA_CA_CERTS`, `REQUESTS_CA_BUNDLE`, `CURL_CA_BUNDLE`, or a
JVM `cacerts` import).

### 1e. Postman / Insomnia / Bruno

Run the request (or a whole collection runner). Right-click the response
→ **Save Response as HAR**. Repeat for each request you want included,
then either keep them as separate `.har` files (pass `--in` once per file
via a loop in CI) or merge them with any HAR-merge tool.

### 1f. k6 load test (bonus — recording while load-testing)

```bash
k6 run --out har=traffic.har script.js
```

k6 emits a HAR alongside its load metrics. Same file works with
`bdct capture from-har`.

---

## Step 2 — turn the HAR into a consumer contract

This is the one CLI command. The same command works regardless of which
recorder produced the HAR.

```bash
specshield bdct capture from-har \
  --in       traffic.har \
  --base-url https://api.acme.com \
  --out      consumer-contract.yaml
```

Expected output:

```
✔ Wrote consumer-contract.yaml  (4 endpoints, 6 ops from 23/41 entries)
```

The `23/41` summary means **23 entries** survived the filters (right host,
JSON body) out of **41 total** the recorder captured. Open the YAML to see
exactly what your code talks to — endpoint by endpoint, field by field.

### All options

| Flag | Purpose | Default |
|---|---|---|
| `--in <path>`           | **Required.** Input HAR file (HAR 1.2). | — |
| `--out <path>`          | Output file. If omitted, writes to stdout. | stdout |
| `--base-url <url>`      | Keep only entries matching this URL prefix. Critical when the consumer talks to multiple backends — see "multi-host" below. | (no filter — keeps every host) |
| `--method <verbs>`      | Comma-separated methods to include, e.g. `GET,POST`. | all methods |
| `--title <title>`       | OpenAPI `info.title`. | `Captured consumer contract` |
| `--version <ver>`       | OpenAPI `info.version` — usually your git SHA in CI. | `0.1.0` |
| `--format <fmt>`        | `yaml` or `json`. | `yaml` |
| `--include-non-json`    | Keep entries with non-JSON bodies (HTML, images, binary). Schemas can't be inferred but the endpoints will appear. | off |

### What the engine actually does

For every HAR entry that passes the filters:

- **Path templating.** `/users/123/orders/abc-2026` becomes
  `/users/{userId}/orders/{orderId}`. Parameter names come from the
  preceding noun in the URL — *not* a generic `{id}` — so the resulting
  OpenAPI matches the parameter names your provider likely already uses
  (`{userId}`, `{orderId}`, `{accountId}`, …).
- **Per-status schema merging.** If three `GET /users/{userId}` samples
  return slightly different shapes, the emitted schema is the *merger*:
  fields seen in **every** sample stay `required`; fields seen in **some**
  samples become optional; `integer` + `number` widens to `number`; a
  type conflict falls back to `string`.
- **Format detection.** UUIDs, RFC 3339 date-times, and email addresses
  get `format: uuid` / `format: date-time` / `format: email`.
- **Status-code coverage.** A 404 sample produces its own response schema
  alongside the 200 — so the contract documents the error shapes your code
  handles, not just the happy path.
- **JSON-only by default.** Entries with non-JSON bodies are dropped; the
  HTML page load from a Playwright test never ends up in the contract.

---

## Step 3 — publish + gate

```bash
# 1. Publish the captured contract (run on every consumer PR)
specshield bdct publish-consumer \
  --org   acme-store \
  --consumer checkout-ui \
  --provider payment-service \
  --version  "$GIT_SHA" \
  --format   OPENAPI \
  --contract consumer-contract.yaml

# 2. Gate the deploy (run before promoting the consumer)
specshield bdct can-i-deploy \
  --org acme-store \
  --service checkout-ui --version "$GIT_SHA" --env staging
# exit 0 = safe; exit 1 = a verification says NO and the deploy is blocked
```

Full BDCT command reference is in the [Bi-Directional Contract Testing](#bi-directional-contract-testing-bdct)
section above.

---

## Operational concerns (read this before going live)

### Scrubbing auth tokens, cookies, and PII

A raw HAR can contain `Authorization` headers, session cookies, and real
PII in request/response bodies. **Scrub before publishing.** Two patterns:

**Quick scrub with jq** (zero deps if you already have jq):

```bash
jq 'del(.. | .headers? | .[]? | select(.name | ascii_downcase | IN("authorization","cookie","set-cookie","x-api-key")))' \
  traffic.har > scrubbed.har
```

**Heavier scrub via `har-sanitizer`** (npm tool — supports body redaction
patterns, allowlists, etc.):

```bash
npx har-sanitizer --input traffic.har --output scrubbed.har --scrub-words 'email,ssn,creditCard'
```

The contract that `bdct capture from-har` emits only carries field *names
and types* — not values — so once the HAR is scrubbed of secrets, the
published contract is safe to share with the provider team.

### Multi-host filtering (consumer talks to several backends)

`--base-url` is a prefix match, so it doubles as a host filter:

```bash
# Keep only calls to the payment service
specshield bdct capture from-har \
  --in traffic.har --base-url https://payment.acme.com \
  --out contracts/checkout-ui-payment.yaml

# Same HAR, different provider — keep only calls to inventory
specshield bdct capture from-har \
  --in traffic.har --base-url https://inventory.acme.com \
  --out contracts/checkout-ui-inventory.yaml
```

One test run → one HAR → N consumer contracts, one per provider.

### Keeping contracts fresh in CI

The whole pattern is "record from your existing tests, publish from CI." A
typical `.github/workflows/contract-test.yml`:

```yaml
- name: Run integration tests (produces traffic.har)
  run: npx playwright test            # or ./mvnw verify, or whatever you use

- name: HAR → consumer contract
  run: |
    specshield bdct capture from-har \
      --in traffic.har \
      --base-url ${{ vars.PROVIDER_BASE_URL }} \
      --out consumer-contract.yaml

- name: Publish contract
  env:
    SPECSHIELD_API_KEY: ${{ secrets.SPECSHIELD_API_KEY }}
  run: |
    specshield bdct publish-consumer \
      --org ${{ vars.SPECSHIELD_ORG }} \
      --consumer ${{ vars.SERVICE_NAME }} \
      --provider ${{ vars.PROVIDER_NAME }} \
      --version  ${{ github.sha }} \
      --format   OPENAPI \
      --contract consumer-contract.yaml

- name: Gate the deploy
  env:
    SPECSHIELD_API_KEY: ${{ secrets.SPECSHIELD_API_KEY }}
  run: |
    specshield bdct can-i-deploy \
      --org ${{ vars.SPECSHIELD_ORG }} \
      --service ${{ vars.SERVICE_NAME }} \
      --version ${{ github.sha }} \
      --env staging
```

Identical pattern on GitLab, CircleCI, Jenkins — only the secret-injection
syntax changes.

### Common pitfalls

| Symptom | Cause | Fix |
|---|---|---|
| `0 endpoints, 0 ops from 0/N entries` | `--base-url` doesn't match any host in the HAR | Drop `--base-url` to see what hosts ARE in the HAR; re-run with the right prefix. |
| Contract is missing your POST | Recorder captured a 4xx for that POST | Fix the test so the POST succeeds, OR keep the 4xx (it'll document the error path). |
| Path got templated when you didn't want it to | A literal path segment looked like a numeric/UUID id | Path segments are templated when **multiple** entries share a prefix but differ on that segment. A single entry stays literal. |
| Playwright HAR file is empty / not written | `context.close()` didn't run | Create the context explicitly with `chromium.launch()` → `browser.newContext({ recordHar })` and `await context.close()` at the end of the test. |
| Backend rejects POST when mitmproxy is in the path | TLS cert not trusted by the consumer | See the mitmproxy CA-cert link above; one env var or one JKS import. |

---

## Why this is the most valuable piece of the CLI

Every other contract-testing product on the market asks the consumer team
to **change their code** — adopt a DSL, instrument their tests, run a
broker. That tax is why most teams that "should" be doing contract testing
aren't.

`bdct capture from-har` removes the tax. Your team's existing test run is
already the contract; the CLI just converts the format. The HAR-capture →
publish → can-i-deploy loop is what turns "we have OpenAPI specs in a
folder" into "no provider PR merges if it would break a deployed consumer"
— with measurable enforcement, in one CI step, and no per-language SDK.

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
