// @ts-check
const { defineConfig } = require('@playwright/test');
const path = require('path');

/**
 * Minimal config: one `recordHar` line is the entire SpecShield "integration"
 * on the consumer side. Playwright writes traffic.har when the browser
 * context closes; the next step (`specshield bdct capture from-har`) reads
 * it and emits a clean OpenAPI consumer contract.
 *
 * Point `BASE_URL` (env var) at YOUR provider when adapting this for a real
 * project. Default: a free public sandbox so the example runs out-of-the-box.
 */
module.exports = defineConfig({
  testDir: './tests',
  fullyParallel: false,
  workers: 1,
  reporter: 'list',

  use: {
    baseURL: process.env.BASE_URL || 'https://jsonplaceholder.typicode.com',
    // recordHar is also set inside the test, where we create the context
    // explicitly and `await context.close()` — that's what guarantees the
    // HAR file is flushed before the process exits.
  },
});
