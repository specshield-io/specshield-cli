'use strict';

// Characterization of the `specshield compare` command-line surface.
//
// The GitHub Action (specshield-bdct-action) and users' CI scripts map directly
// onto these flags. Removing or renaming any of them is a breaking change even
// if the diff engine is untouched. This test locks the flag set, the two
// positional arguments, and the defaults that downstream behavior relies on
// (severity=info so all changes show; timeout=10000 for remote mode).
//
// If this test fails you are almost certainly making a breaking CLI change —
// update the Action inputs and the baseline doc deliberately, do not just edit
// the expectation to make it green.

const compare = require('../src/commands/compare');

describe('compare command surface (non-breaking baseline)', () => {
  test('command is named "compare"', () => {
    expect(compare.name()).toBe('compare');
  });

  test('takes exactly the base and target positional arguments', () => {
    const args = (compare.registeredArguments || compare._args || []).map((a) => a.name());
    expect(args).toEqual(['base', 'target']);
  });

  test('exposes exactly the current set of options', () => {
    const longs = compare.options.map((o) => o.long).sort();
    expect(longs).toEqual(
      [
        '--allow-breaking',
        '--api-key',
        '--config',
        '--fail-on-breaking',
        '--ignore',
        '--json',
        '--output',
        '--remote',
        '--remote-url',
        '--severity',
        '--timeout',
      ].sort()
    );
  });

  test('preserves defaults that downstream behavior depends on', () => {
    const byLong = Object.fromEntries(compare.options.map((o) => [o.long, o]));
    // Default severity 'info' => additions + modifications are visible by default.
    expect(byLong['--severity'].defaultValue).toBe('info');
    // Default remote-mode request timeout.
    expect(byLong['--timeout'].defaultValue).toBe('10000');
    // --ignore is repeatable and accumulates into an array.
    expect(byLong['--ignore'].defaultValue).toEqual([]);
  });
});
