/**
 * @fileoverview Table-driven unit tests for parseVersion, compareVersions, and satisfies.
 */

import { describe, expect, test } from 'bun:test';
import {
  compareVersions,
  countRegExpGroups,
  isValidSupportedRange,
  parseVersion,
  satisfies,
} from '../src/version.js';

describe('parseVersion', () => {
  const table = [
    { input: '1.0.0', expected: { major: 1, minor: 0, patch: 0 } },
    { input: 'v1.2.3', expected: { major: 1, minor: 2, patch: 3 } },
    { input: '2.43.0', expected: { major: 2, minor: 43, patch: 0 } },
    { input: '2.43.0-rc1', expected: { major: 2, minor: 43, patch: 0 } },
    { input: '2.43.0.windows.1', expected: { major: 2, minor: 43, patch: 0 } },
    { input: '2.45.0 (2025-07-18 Ubuntu 2.45.0-1ubuntu0.3)', expected: { major: 2, minor: 45, patch: 0 } },
    { input: 'aws-cli/2.34.48 Python/3.14.4 Linux', expected: null },
    { input: '2.34.48 Python/3.14.4', expected: { major: 2, minor: 34, patch: 48 } },
    { input: '10.200.300', expected: { major: 10, minor: 200, patch: 300 } },
    { input: '2.43', expected: { major: 2, minor: 43, patch: 0 } },
    { input: 'v2.43', expected: { major: 2, minor: 43, patch: 0 } },
    { input: '', expected: null },
    { input: 'not_a_version', expected: null },
    { input: '1', expected: null },
    { input: null as unknown as string, expected: null },
  ];

  for (const tc of table) {
    test(`parses "${tc.input}" -> ${JSON.stringify(tc.expected)}`, () => {
      const result = parseVersion(tc.input);
      if (tc.expected === null) {
        expect(result).toBeNull();
      } else {
        expect(result).not.toBeNull();
        expect(result?.major).toBe(tc.expected.major);
        expect(result?.minor).toBe(tc.expected.minor);
        expect(result?.patch).toBe(tc.expected.patch);
      }
    });
  }
});

describe('compareVersions', () => {
  test('correctly orders major, minor, patch', () => {
    const v1 = parseVersion('1.0.0')!;
    const v2 = parseVersion('2.0.0')!;
    const v1_1 = parseVersion('1.1.0')!;
    const v1_0_1 = parseVersion('1.0.1')!;

    expect(compareVersions(v1, v2)).toBeLessThan(0);
    expect(compareVersions(v2, v1)).toBeGreaterThan(0);
    expect(compareVersions(v1, v1)).toBe(0);
    expect(compareVersions(v1, v1_1)).toBeLessThan(0);
    expect(compareVersions(v1, v1_0_1)).toBeLessThan(0);
  });
});

describe('isValidSupportedRange', () => {
  const table = [
    { range: '>=2.43.0 <3.0.0', valid: true },
    { range: '=2.43.0', valid: true },
    { range: '>1.0.0 <=2.0.0', valid: true },
    { range: '>=1.0.0 >1.1.0 <=2.0.0 <2.0.0', valid: true },
    { range: '', valid: false },
    { range: '   ', valid: false },
    { range: '>=1.0.0 >1.1.0 <=2.0.0 <2.0.0 =1.5.0', valid: false }, // 5 comparators (max 4)
    { range: '2.43.0', valid: false }, // missing operator
    { range: '~1.0.0', valid: false }, // unsupported operator
    { range: '^1.0.0', valid: false },
    { range: '>=2.43', valid: false }, // must be x.y.z
    { range: '>=2.43.0-rc1', valid: false }, // must be numeric x.y.z
  ];

  for (const tc of table) {
    test(`range "${tc.range}" validity: ${tc.valid}`, () => {
      expect(isValidSupportedRange(tc.range)).toBe(tc.valid);
    });
  }
});

describe('satisfies', () => {
  const table = [
    // Conjunction >=2.43.0 <3.0.0
    { version: '2.43.0', range: '>=2.43.0 <3.0.0', expected: true },
    { version: '2.43.1', range: '>=2.43.0 <3.0.0', expected: true },
    { version: '2.43.0-rc1', range: '>=2.43.0 <3.0.0', expected: true },
    { version: '2.99.9', range: '>=2.43.0 <3.0.0', expected: true },
    { version: '2.42.9', range: '>=2.43.0 <3.0.0', expected: false },
    { version: '3.0.0', range: '>=2.43.0 <3.0.0', expected: false },
    { version: '3.1.0', range: '>=2.43.0 <3.0.0', expected: false },
    { version: '1.9.0', range: '>=2.43.0 <3.0.0', expected: false },

    // Exact equal =2.0.0
    { version: '2.0.0', range: '=2.0.0', expected: true },
    { version: '2.0.1', range: '=2.0.0', expected: false },
    { version: '1.9.9', range: '=2.0.0', expected: false },

    // Strict greater >1.5.0
    { version: '1.5.0', range: '>1.5.0', expected: false },
    { version: '1.5.1', range: '>1.5.0', expected: true },

    // Less or equal <=2.10.0
    { version: '2.10.0', range: '<=2.10.0', expected: true },
    { version: '2.9.99', range: '<=2.10.0', expected: true },
    { version: '2.10.1', range: '<=2.10.0', expected: false },

    // Strict less <2.0.0
    { version: '2.0.0', range: '<2.0.0', expected: false },
    { version: '1.99.99', range: '<2.0.0', expected: true },

    // Invalid ranges or versions
    { version: 'invalid', range: '>=1.0.0', expected: false },
    { version: '1.0.0', range: 'invalid_range', expected: false },
    { version: '1.0.0', range: '', expected: false },
    { version: '1.0.0', range: '>=1.0.0 >=1.0.0 >=1.0.0 >=1.0.0 >=1.0.0', expected: false },
  ];

  for (const tc of table) {
    test(`"${tc.version}" satisfies "${tc.range}" -> ${tc.expected}`, () => {
      expect(satisfies(tc.version, tc.range)).toBe(tc.expected);
    });
  }
});

describe('countRegExpGroups', () => {
  test('returns 1 for single capture group', () => {
    expect(countRegExpGroups('(\\d+\\.\\d+\\.\\d+)')).toBe(1);
    expect(countRegExpGroups('version\\s+([0-9.]+)')).toBe(1);
    expect(countRegExpGroups('(?:git\\s+version\\s+)(\\d+\\.\\d+\\.\\d+)')).toBe(1);
  });

  test('returns 2 for two capture groups', () => {
    expect(countRegExpGroups('(\\d+)\\.(\\d+)')).toBe(2);
  });

  test('returns 0 for no capture groups', () => {
    expect(countRegExpGroups('\\d+\\.\\d+\\.\\d+')).toBe(0);
    expect(countRegExpGroups('(?:\\d+\\.\\d+)')).toBe(0);
  });

  test('returns -1 for invalid regex syntax or over 200 chars', () => {
    expect(countRegExpGroups('[invalid')).toBe(-1);
    expect(countRegExpGroups('a'.repeat(201))).toBe(-1);
  });
});
