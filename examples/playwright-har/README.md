# `examples/playwright-har` — Playwright → HAR → consumer contract

A minimal, runnable starter showing the "real customer" path for
`specshield bdct capture from-har`. Playwright records every HTTP call the
browser makes; SpecShield turns the resulting HAR into a clean OpenAPI
consumer contract. **No custom recorder code anywhere in this directory.**

The default target is the public [JSONPlaceholder] sandbox so the example
runs end-to-end without any setup. Adapt it to your own provider by setting
`BASE_URL` and editing the fetch calls in `tests/api.spec.js`.

[JSONPlaceholder]: https://jsonplaceholder.typicode.com/

## What you'll have after running this

```
examples/playwright-har/
├── traffic.har                ← Playwright wrote this (every HTTP call the test made)
└── consumer-contract.yaml     ← specshield wrote this (OpenAPI subset, ready to publish)
```

## Run it

```bash
cd examples/playwright-har

# One-time
npm install
npx playwright install chromium    # ~90 MB browser binary

# Each time
npm test                           # → traffic.har
BASE_URL=https://jsonplaceholder.typicode.com npm run capture
                                   # → consumer-contract.yaml
```

Expected `npm test` output:

```
Running 1 test using 1 worker
  ✓ tests/api.spec.js:13:1 › records traffic for the SpecShield HAR-capture example
  1 passed
```

Expected `npm run capture` output:

```
✔ Wrote consumer-contract.yaml  (N endpoints, M ops from K/L entries)
```

Open `consumer-contract.yaml` and you'll see the GET/POST endpoints, the
inferred response schemas (including UUID/date-time/email format
detection), and templated path parameters like `/users/{userId}` collapsing
all the per-id samples.

## Point it at your own API

Two edits, both in `tests/api.spec.js`:

1. **Set `BASE_URL`** to your API root (or override via env var):
   ```bash
   BASE_URL=https://api.acme.com npm test
   BASE_URL=https://api.acme.com npm run capture
   ```
2. **Replace the fetch calls** in the `page.evaluate(...)` block with the
   actual endpoints your consumer exercises. For a real frontend, replace
   `page.goto('about:blank')` with `page.goto('https://your-app.local')`
   and let the app's own code make the fetches — Playwright records all
   browser HTTP regardless of who triggers it.

## Then publish + gate

The capture step produces the contract. The remaining two steps register
it with SpecShield and gate deploys on it:

```bash
specshield bdct publish-consumer \
  --org      your-org-key \
  --consumer your-service-name \
  --provider their-service-name \
  --version  "$GIT_SHA" \
  --format   OPENAPI \
  --contract consumer-contract.yaml

specshield bdct can-i-deploy \
  --org your-org-key \
  --service your-service-name --version "$GIT_SHA" --env staging
```

See the [main CLI README](../../README.md#bdct-capture-from-har--turn-real-traffic-into-a-consumer-contract)
for the full workflow including auth scrubbing, multi-host filtering, and
CI integration.

## Why this works without a custom recorder

The Playwright `recordHar` context option is built into Playwright; the
file it writes is standard [HAR 1.2]. SpecShield's `bdct capture from-har`
reads the same format that Chrome DevTools, Cypress, mitmproxy, k6, and
Postman emit. One spec, every recorder.

[HAR 1.2]: http://www.softwareishard.com/blog/har-12-spec/
