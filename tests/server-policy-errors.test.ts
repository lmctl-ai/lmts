/**
 * @fileoverview Unit tests for server policy, errors, and output modules.
 */

import { describe, expect, test } from 'bun:test';
import {
  CliError,
  ErrorCode,
  EXIT_CODES,
  toCliError,
} from '../src/server/errors.js';
import {
  checkPolicy,
  isDryRunResult,
  type Policy,
} from '../src/server/policy.js';
import {
  exitCodeFor,
  printError,
  printResult,
} from '../src/server/output.js';

describe('server/errors', () => {
  test('EXIT_CODES covers all ErrorCode values', () => {
    for (const code of Object.values(ErrorCode)) {
      expect(typeof EXIT_CODES[code]).toBe('number');
    }
    expect(EXIT_CODES[ErrorCode.InvalidRequest]).toBe(2);
    expect(EXIT_CODES[ErrorCode.ReadOnlyViolation]).toBe(6);
    expect(EXIT_CODES[ErrorCode.MissingConfirmation]).toBe(9);
    expect(EXIT_CODES[ErrorCode.CommandNotFound]).toBe(127);
  });

  test('CliError properties and defaults', () => {
    const err = new CliError(ErrorCode.Conflict, 'conflict message', { key: 'val' });
    expect(err.name).toBe('CliError');
    expect(err.code).toBe(ErrorCode.Conflict);
    expect(err.exitCode).toBe(5);
    expect(err.message).toBe('conflict message');
    expect(err.data).toEqual({ key: 'val' });

    // Without data
    const err2 = new CliError(ErrorCode.InternalError);
    expect(err2.data).toBeUndefined();
    expect(err2.exitCode).toBe(1);

    // With cause
    const cause = new Error('original');
    const errWithCause = new CliError(ErrorCode.UnknownError, 'wrapped', undefined, { cause });
    expect(errWithCause.cause).toBe(cause);
  });

  test('toCliError conversions', () => {
    const original = new CliError(ErrorCode.NotFound, 'not found');
    expect(toCliError(original)).toBe(original);

    const jsErr = new Error('some error');
    const convertedJs = toCliError(jsErr);
    expect(convertedJs.code).toBe(ErrorCode.UnknownError);
    expect(convertedJs.message).toBe('some error');
    expect(convertedJs.cause).toBe(jsErr);

    const emptyErr = new Error('');
    expect(toCliError(emptyErr, 'fallback msg').message).toBe('fallback msg');

    const strErr = toCliError('string failure');
    expect(strErr.code).toBe(ErrorCode.UnknownError);
    expect(strErr.message).toBe('string failure');

    const numErr = toCliError(404);
    expect(numErr.message).toBe('404');
  });
});

describe('server/output', () => {
  test('printResult formats JSON to stdout', () => {
    let captured = '';
    const origWrite = process.stdout.write;
    try {
      process.stdout.write = ((chunk: any) => {
        captured += String(chunk);
        return true;
      }) as any;

      printResult({ success: true, count: 42 });
      expect(JSON.parse(captured)).toEqual({ success: true, count: 42 });
    } finally {
      process.stdout.write = origWrite;
    }
  });

  test('printError formats error envelope to stdout', () => {
    let captured = '';
    const origWrite = process.stdout.write;
    try {
      process.stdout.write = ((chunk: any) => {
        captured += String(chunk);
        return true;
      }) as any;

      const cliErr = new CliError(ErrorCode.ValidationError, 'bad input', { field: 'name' });
      printError(cliErr);
      const parsed = JSON.parse(captured);
      expect(parsed.success).toBe(false);
      expect(parsed.error.code).toBe('VALIDATION_ERROR');
      expect(parsed.error.message).toBe('bad input');
      expect(parsed.error.data).toEqual({ field: 'name' });
    } finally {
      process.stdout.write = origWrite;
    }
  });

  test('exitCodeFor maps errors correctly', () => {
    expect(exitCodeFor(new CliError(ErrorCode.ReadOnlyViolation))).toBe(6);
    expect(exitCodeFor(new Error('generic'))).toBe(1);
  });
});

describe('server/policy', () => {
  const basePolicy: Policy = { dryRun: false, readOnly: false };

  test('read and dynamic access always proceed', () => {
    expect(checkPolicy('read', { dryRun: true, readOnly: true }, { name: 'status' })).toBeUndefined();
    expect(checkPolicy('dynamic', { dryRun: true, readOnly: true }, { name: 'query' })).toBeUndefined();
  });

  test('write access under readOnly throws ReadOnlyViolation', () => {
    expect(() =>
      checkPolicy('write', { dryRun: false, readOnly: true }, { name: 'commit', command: ['git', 'commit'] }),
    ).toThrow(CliError);

    try {
      checkPolicy('write', { dryRun: false, readOnly: true }, { name: 'commit', command: ['git', 'commit'] });
    } catch (e: any) {
      expect(e.code).toBe(ErrorCode.ReadOnlyViolation);
      expect(e.data?.operation).toBe('commit');
      expect(e.data?.command).toEqual(['git', 'commit']);
    }
  });

  test('write access under dryRun returns synthetic DryRunResult', () => {
    const res = checkPolicy(
      'write',
      { dryRun: true, readOnly: false },
      { name: 'push', command: ['git', 'push', 'origin'], data: { branch: 'main' } },
    );
    expect(res).toBeDefined();
    expect(isDryRunResult(res)).toBe(true);
    expect(res?.success).toBe(true);
    expect(res?.dryRun).toBe(true);
    expect(res?.simulated).toBe('push');
    expect(res?.command).toEqual(['git', 'push', 'origin']);
    expect((res as any)?.branch).toBe('main');
  });

  test('write access with dangerous requires confirmation', () => {
    // Missing confirmation throws
    expect(() =>
      checkPolicy('write', basePolicy, { name: 'drop_database', dangerous: true }),
    ).toThrow(CliError);

    try {
      checkPolicy('write', basePolicy, { name: 'drop_database', dangerous: true });
    } catch (e: any) {
      expect(e.code).toBe(ErrorCode.MissingConfirmation);
      expect(e.exitCode).toBe(9);
    }

    // Confirmed via ctx
    expect(
      checkPolicy('write', basePolicy, { name: 'drop_database', dangerous: true, confirmed: true }),
    ).toBeUndefined();

    // Confirmed via policy
    expect(
      checkPolicy('write', { ...basePolicy, confirmed: true }, { name: 'drop_database', dangerous: true }),
    ).toBeUndefined();
  });

  test('regular write without dryRun/readOnly proceeds', () => {
    expect(checkPolicy('write', basePolicy, { name: 'commit' })).toBeUndefined();
  });

  test('isDryRunResult helper', () => {
    expect(isDryRunResult(null)).toBe(false);
    expect(isDryRunResult(undefined)).toBe(false);
    expect(isDryRunResult('string')).toBe(false);
    expect(isDryRunResult({})).toBe(false);
    expect(isDryRunResult({ dryRun: false })).toBe(false);
    expect(isDryRunResult({ dryRun: true, success: true })).toBe(true);
  });
});
