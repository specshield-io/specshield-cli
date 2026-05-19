'use strict';

/**
 * Unit tests for the placeholder helpers in `init`. These functions handle
 * the "user pressed Enter on a wizard prompt" path. The CLI's interactive
 * flow is hard to test deterministically (piped stdin behaves differently
 * from a real TTY), so we test the pure functions directly.
 */

const { __test__ } = require('../src/commands/init');
const { fillPlaceholders, collectPlaceholders, PLACEHOLDER } = __test__;

describe('fillPlaceholders', () => {
  it('replaces empty strings with the placeholder token', () => {
    const a = { providerName: '', specPath: '', kind: 'provider' };
    fillPlaceholders(a);
    expect(a.providerName).toBe(PLACEHOLDER);
    expect(a.specPath).toBe(PLACEHOLDER);
    expect(a.kind).toBe('provider');  // non-placeholder field untouched
  });

  it('replaces nulls with the placeholder token', () => {
    const a = { org: null, providerName: 'svc' };
    fillPlaceholders(a);
    expect(a.org).toBe(PLACEHOLDER);
    expect(a.providerName).toBe('svc');
  });

  it('leaves non-empty values untouched', () => {
    const a = { providerName: 'payment-service', specPath: 'openapi.yaml', org: 'acme' };
    fillPlaceholders(a);
    expect(a).toEqual({ providerName: 'payment-service', specPath: 'openapi.yaml', org: 'acme' });
  });

  it('does NOT operate on fields outside PLACEHOLDER_FIELDS', () => {
    // contractFormat is a select with constrained values; it should never
    // be turned into a placeholder even if somehow blank.
    const a = { contractFormat: '', kind: 'consumer' };
    fillPlaceholders(a);
    expect(a.contractFormat).toBe('');
    expect(a.kind).toBe('consumer');
  });
});

describe('collectPlaceholders', () => {
  it('finds placeholders at any depth and reports their dotted path', () => {
    const cfg = {
      bdct: {
        org: PLACEHOLDER,
        environment: 'staging',
        provider: { name: 'svc', spec: PLACEHOLDER },
      },
    };
    const ps = collectPlaceholders(cfg);
    const paths = ps.map(p => p.path).sort();
    expect(paths).toEqual(['bdct.org', 'bdct.provider.spec']);
  });

  it('returns an empty array when nothing is a placeholder', () => {
    const cfg = { bdct: { org: 'acme', provider: { name: 'svc' } } };
    expect(collectPlaceholders(cfg)).toEqual([]);
  });

  it('ignores nested non-string values', () => {
    const cfg = {
      schemaVersion: 1,
      failOnBreaking: true,
      bdct: { org: PLACEHOLDER },
    };
    const ps = collectPlaceholders(cfg);
    expect(ps).toHaveLength(1);
    expect(ps[0].path).toBe('bdct.org');
  });
});
