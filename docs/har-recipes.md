# Recording a HAR file — recipes per tool

Companion to the [`bdct capture from-har`](../README.md#bdct-capture-from-har--turn-real-traffic-into-a-consumer-contract)
section of the README. Record with whichever tool already exercises your
consumer, then run Step 2 from the README — the capture command is the same
for every recorder.

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
> copy-paste starter lives in [`examples/playwright-har/`](../examples/playwright-har/)
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
