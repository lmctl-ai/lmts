/**
 * @fileoverview Comprehensive unit tests for server process execution (exec.ts).
 * Tests both Bun and Node runtime adapters, timeout, abort signals, exit code
 * policies, and verifies argv is passed without shell interpretation.
 */

import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectRuntime, spawnCommand, spawnWithBun, spawnWithNode } from '../src/server/exec.js';

describe('server/exec', () => {
  test('detectRuntime returns bun in Bun test environment', () => {
    expect(detectRuntime()).toBe('bun');
  });

  test('spawnCommand and spawnWithBun success', async () => {
    const res = await spawnCommand(
      process.execPath,
      ['-e', 'console.log("hello world"); process.stderr.write("info");'],
      process.cwd(),
      {},
      5000,
    );
    expect(res.stdout.trim()).toBe('hello world');
    expect(res.stderr.trim()).toBe('info');
    expect(res.exitCode).toBe(0);

    const resDirect = await spawnWithBun(
      process.execPath,
      ['-e', 'console.log("direct bun");'],
      process.cwd(),
      {},
      5000,
    );
    expect(resDirect.stdout.trim()).toBe('direct bun');
  });

  test('spawnCommand non-zero exit handling under Bun', async () => {
    // 1. allowNonZeroExit = false -> throws Error
    let threw = false;
    try {
      await spawnCommand(
        process.execPath,
        ['-e', 'process.stderr.write("fatal error"); process.exit(42);'],
        process.cwd(),
        {},
        5000,
        undefined,
        false,
      );
    } catch (err: any) {
      threw = true;
      expect(err.message).toContain('Exit Code: 42');
      expect(err.message).toContain('fatal error');
    }
    expect(threw).toBe(true);

    // 2. allowNonZeroExit = true -> returns ExecResult
    const res = await spawnCommand(
      process.execPath,
      ['-e', 'process.stderr.write("soft error"); process.exit(7);'],
      process.cwd(),
      {},
      5000,
      undefined,
      true,
    );
    expect(res.exitCode).toBe(7);
    expect(res.stderr.trim()).toBe('soft error');
  });

  test('spawnCommand timeout under Bun', async () => {
    let threw = false;
    try {
      await spawnCommand(
        process.execPath,
        ['-e', 'setTimeout(() => {}, 5000);'],
        process.cwd(),
        {},
        100, // 100ms timeout
      );
    } catch (err: any) {
      threw = true;
      expect(err.message).toContain('timed out after 0.1s');
    }
    expect(threw).toBe(true);
  });

  test('spawnCommand signal already aborted under Bun', async () => {
    const controller = new AbortController();
    controller.abort();

    let threw = false;
    try {
      await spawnCommand(
        process.execPath,
        ['-e', 'console.log("nope");'],
        process.cwd(),
        {},
        5000,
        controller.signal,
      );
    } catch (err: any) {
      threw = true;
      expect(err.message).toContain('Command cancelled before execution');
    }
    expect(threw).toBe(true);
  });

  test('spawnCommand signal aborted during execution under Bun', async () => {
    const controller = new AbortController();
    const promise = spawnCommand(
      process.execPath,
      ['-e', 'setTimeout(() => {}, 3000);'],
      process.cwd(),
      {},
      5000,
      controller.signal,
    );

    setTimeout(() => {
      controller.abort();
    }, 50);

    let threw = false;
    try {
      await promise;
    } catch (err: any) {
      threw = true;
      expect(err.message).toContain('Command cancelled');
    }
    expect(threw).toBe(true);
  });

  test('spawnCommand never interprets argv through a shell', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'lmts-exec-argv-'));
    const scriptPath = join(tmp, 'echo-args.js');
    try {
      writeFileSync(scriptPath, 'console.log(JSON.stringify(process.argv.slice(2)));');

      const testArgs = [
        '; echo pwned;',
        '$(whoami)',
        '| cat',
        '> /tmp/injected',
        '*.txt',
        'hello world with spaces',
      ];

      const res = await spawnCommand(
        process.execPath,
        [scriptPath, ...testArgs],
        process.cwd(),
        {},
        5000,
      );

      const received = JSON.parse(res.stdout.trim());
      expect(received).toEqual(testArgs);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('spawnCommand with Node adapter (spawnWithNode)', async () => {
    // 1. Success under Node adapter via spawnWithNode & spawnCommand(..., 'node')
    const res = await spawnCommand(
      process.execPath,
      ['-e', 'console.log("node success"); process.stderr.write("node log");'],
      process.cwd(),
      {},
      5000,
      undefined,
      false,
      'node',
    );
    expect(res.stdout.trim()).toBe('node success');
    expect(res.stderr.trim()).toBe('node log');
    expect(res.exitCode).toBe(0);

    // Direct spawnWithNode
    const resDirect = await spawnWithNode(
      process.execPath,
      ['-e', 'console.log("direct node");'],
      process.cwd(),
      {},
      5000,
    );
    expect(resDirect.stdout.trim()).toBe('direct node');

    // 2. Non-zero exit allowed
    const resSoft = await spawnWithNode(
      process.execPath,
      ['-e', 'process.stderr.write("node soft err"); process.exit(3);'],
      process.cwd(),
      {},
      5000,
      undefined,
      true,
    );
    expect(resSoft.exitCode).toBe(3);
    expect(resSoft.stderr.trim()).toBe('node soft err');

    // 3. Non-zero exit disallowed
    let threwNonZero = false;
    try {
      await spawnWithNode(
        process.execPath,
        ['-e', 'process.stderr.write("node hard err"); process.exit(5);'],
        process.cwd(),
        {},
        5000,
        undefined,
        false,
      );
    } catch (err: any) {
      threwNonZero = true;
      expect(err.message).toContain('Exit Code: 5');
      expect(err.message).toContain('node hard err');
    }
    expect(threwNonZero).toBe(true);

    // 4. Pre-aborted signal
    const preAborted = new AbortController();
    preAborted.abort();
    let threwPreAbort = false;
    try {
      await spawnWithNode(
        process.execPath,
        ['-e', 'console.log(1)'],
        process.cwd(),
        {},
        5000,
        preAborted.signal,
      );
    } catch (err: any) {
      threwPreAbort = true;
      expect(err.message).toContain('Command cancelled before execution');
    }
    expect(threwPreAbort).toBe(true);

    // 5. Aborted during execution
    const abortMid = new AbortController();
    const midPromise = spawnWithNode(
      process.execPath,
      ['-e', 'setTimeout(() => {}, 3000);'],
      process.cwd(),
      {},
      5000,
      abortMid.signal,
    );
    setTimeout(() => abortMid.abort(), 50);
    let threwMidAbort = false;
    try {
      await midPromise;
    } catch (err: any) {
      threwMidAbort = true;
      expect(err.message).toContain('Command cancelled');
    }
    expect(threwMidAbort).toBe(true);

    // 6. Timeout
    let threwTimeout = false;
    try {
      await spawnWithNode(
        process.execPath,
        ['-e', 'setTimeout(() => {}, 3000);'],
        process.cwd(),
        {},
        100, // 100ms
      );
    } catch (err: any) {
      threwTimeout = true;
      expect(err.message).toContain('Command timed out');
    }
    expect(threwTimeout).toBe(true);

    // 7. Command not found (ENOENT)
    let threwNotFound = false;
    try {
      await spawnWithNode(
        'non_existent_binary_12345_xyz',
        [],
        process.cwd(),
        {},
        5000,
      );
    } catch (err: any) {
      threwNotFound = true;
      expect(err).toBeDefined();
    }
    expect(threwNotFound).toBe(true);
  });
});
