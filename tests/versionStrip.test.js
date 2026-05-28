'use strict';

const { stripVersionPrefix } = require('../src/util/versionStrip');

describe('stripVersionPrefix', () => {

  test('removes a leading "v" before a digit', () => {
    expect(stripVersionPrefix('v1.0.0')).toBe('1.0.0');
    expect(stripVersionPrefix('v1.0.0-1779978907')).toBe('1.0.0-1779978907');
    expect(stripVersionPrefix('V2.3.4')).toBe('2.3.4');           // case-insensitive
  });

  test('does NOT strip a "v" followed by a letter', () => {
    expect(stripVersionPrefix('vendor-tag')).toBe('vendor-tag');
    expect(stripVersionPrefix('vNext')).toBe('vNext');
    expect(stripVersionPrefix('valpha')).toBe('valpha');
  });

  test('does NOT strip a bare "v"', () => {
    expect(stripVersionPrefix('v')).toBe('v');
  });

  test('does NOT strip a mid-string "v" followed by a digit', () => {
    expect(stripVersionPrefix('1.0-v2')).toBe('1.0-v2');
    expect(stripVersionPrefix('build-v123')).toBe('build-v123');
  });

  test('passes through versions without a leading v', () => {
    expect(stripVersionPrefix('1.0.0')).toBe('1.0.0');
    expect(stripVersionPrefix('har-1779978907')).toBe('har-1779978907');
    expect(stripVersionPrefix('pact-incompat-42')).toBe('pact-incompat-42');
  });

  test('passes through non-strings unchanged', () => {
    expect(stripVersionPrefix(undefined)).toBeUndefined();
    expect(stripVersionPrefix(null)).toBeNull();
    expect(stripVersionPrefix(42)).toBe(42);
  });

  test('reproduces the exact bug case from the 28May UI report', () => {
    // User copied "v1.0.0-1779978907" out of the result pill and pasted it
    // into the form. Before the fix, the query sent that literal string and
    // matched nothing in the registry. The strip recovers the real stored
    // version.
    expect(stripVersionPrefix('v1.0.0-1779978907')).toBe('1.0.0-1779978907');
  });
});
