// @ts-check
const { test, expect, chromium } = require('@playwright/test');
const path = require('path');

/**
 * Drives a few endpoints against the configured base URL (defaults to the
 * public JSONPlaceholder sandbox so this runs without any setup). Every
 * fetch the browser makes is recorded into traffic.har by Playwright's
 * built-in recordHar — no SDK, no custom recorder code.
 *
 * To adapt for your own provider:
 *   1. Set BASE_URL to your API root, e.g.
 *        BASE_URL=https://api.acme.com npx playwright test
 *   2. Replace the page.evaluate(...) fetch calls below with the actual
 *      flows your consumer exercises against your provider. Anything
 *      goes — fetch, XMLHttpRequest, even axios from a real frontend you
 *      load via page.goto(); Playwright records all of it.
 */
test('records traffic for the SpecShield HAR-capture example', async () => {
  const harPath = path.resolve(__dirname, '..', 'traffic.har');
  const baseURL = process.env.BASE_URL || 'https://jsonplaceholder.typicode.com';

  const browser = await chromium.launch();
  const context = await browser.newContext({
    baseURL,
    // The line that produces the HAR. `content: 'embed'` is required so
    // response bodies are inlined — specshield needs them for schema
    // inference.
    recordHar: { path: harPath, mode: 'full', content: 'embed' },
  });
  const page = await context.newPage();

  try {
    // about:blank gives us a page context to run fetch() from. In a real
    // project this would be page.goto('https://your-app.local') and the
    // app's own code would make the fetches; we keep it minimal here.
    await page.goto('about:blank');

    // The actual API calls your consumer makes. Replace these for your own
    // provider. Each unique (method, path) ends up as one endpoint in the
    // generated contract; repeated calls to /users/{id} merge into a single
    // templated endpoint.
    const results = await page.evaluate(async (base) => {
      const out = [];
      const get  = async (p) => { const r = await fetch(base + p); out.push({ p, s: r.status }); return r.json().catch(() => null); };
      const post = async (p, body) => {
        const r = await fetch(base + p, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify(body),
        });
        out.push({ p, s: r.status });
        return r.json().catch(() => null);
      };

      await get('/users');
      await get('/users/1');
      await get('/users/2');
      await get('/posts/1');
      await post('/posts', { title: 'hello', body: 'from playwright', userId: 1 });
      return out;
    }, baseURL);

    console.log('captured calls:', results);
    expect(results.length).toBeGreaterThan(0);
  } finally {
    // Closing the context flushes the HAR. Closing the browser releases
    // the chromium process.
    await context.close();
    await browser.close();
  }
});
