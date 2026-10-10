/**
 * @fileoverview End-to-end tests for core runCli:
 * Spawns fixture CLI as child process and verifies flags, schemas, error envelopes,
 * mixed inputs, and policy behavior.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { parsePublishedSchema } from '../src/index.js';

const TEST_CLI = resolve(import.meta.dir, 'fixtures/test-cli.ts');
const PKG_PATH = resolve(import.meta.dir, '../package.json');

function run(
  cliPath: string,
  args: string[],
  cwd?: string,
): { status: number; stdout: string; stderr: string; json: any } {
  const res = spawnSync('bun', [cliPath, ...args], {
    encoding: 'utf-8',
    cwd: cwd ?? process.cwd(),
  });
  let json: any = undefined;
  try {
    json = JSON.parse(res.stdout);
  } catch {
    // not json or empty
  }
  return {
    status: res.status ?? 0,
    stdout: res.stdout,
    stderr: res.stderr,
    json,
  };
}

describe('runCli integration', () => {
  let spaceDir: string;

  beforeAll(() => {
    spaceDir = mkdtempSync(join(tmpdir(), 'cli test space '));
    writeFileSync(join(spaceDir, 'README.md'), '# Test\n');
  });

  afterAll(() => {
    try {
      rmSync(spaceDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  // 1. lm_status --path "<tmp dir with a space>" succeeds
  test('1. lm_status --path "<tmp dir with a space>" succeeds', () => {
    const res = run(TEST_CLI, ['lm_status', '--path', spaceDir]);
    expect(res.status).toBe(0);
    expect(res.json).toBeDefined();
    expect(res.json.workdir).toBe(spaceDir);
    expect(res.json.clean).toBe(true);
  });

  // 2. lm_status --confirm succeeds
  test('2. lm_status --confirm succeeds', () => {
    const res = run(TEST_CLI, ['lm_status', '--confirm', '--path', spaceDir]);
    expect(res.status).toBe(0);
    expect(res.json).toBeDefined();
    expect(res.json.clean).toBe(true);
  });

  // 3. lm_status --bogus exit 2, envelope issues[0].code UNKNOWN_PARAM with synopsis containing --path
  test('3. lm_status --bogus exit 2, envelope issues[0].code UNKNOWN_PARAM with synopsis containing --path', () => {
    const res = run(TEST_CLI, ['lm_status', '--bogus', '--path', spaceDir]);
    expect(res.status).toBe(2);
    expect(res.json).toBeDefined();
    expect(res.json.success).toBe(false);
    expect(res.json.error.code).toBe('VALIDATION_ERROR');
    expect(res.json.error.data).toBeDefined();
    expect(res.json.error.data.op).toBe('lm_status');
    const issues = res.json.error.data.issues;
    expect(Array.isArray(issues)).toBe(true);
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0].code).toBe('UNKNOWN_PARAM');
    expect(issues[0].synopsis).toContain('--path');
  });

  // 4. --input-json '{"op":"lm_status","params":{"ignored":true}}' works
  test('4. --input-json envelope works', () => {
    const doc = JSON.stringify({
      op: 'lm_status',
      params: { path: spaceDir, ignored: true },
    });
    const res = run(TEST_CLI, ['--input-json', doc]);
    expect(res.status).toBe(0);
    expect(res.json).toBeDefined();
    expect(res.json.workdir).toBe(spaceDir);
    expect(res.json.clean).toBe(true);
  });

  // 5. --input-json + --path -> MIXED_INPUT exit 2
  test('5. --input-json + --path -> MIXED_INPUT exit 2', () => {
    const doc = JSON.stringify({
      op: 'lm_status',
      params: { ignored: true },
    });
    const res = run(TEST_CLI, ['lm_status', '--input-json', doc, '--path', spaceDir]);
    expect(res.status).toBe(2);
    expect(res.json).toBeDefined();
    expect(res.json.success).toBe(false);
    expect(res.json.error.code).toBe('VALIDATION_ERROR');
    expect(res.json.error.data.issues[0].code).toBe('MIXED_INPUT');
  });

  // 6. --input-json ... --dryrun accepted
  test('6. --input-json ... --dryrun accepted', () => {
    const doc = JSON.stringify({
      op: 'lm_status',
      params: { path: spaceDir, ignored: true },
    });
    const res = run(TEST_CLI, ['--input-json', doc, '--dryrun']);
    expect(res.status).toBe(0);
    expect(res.json).toBeDefined();
    expect(res.json.workdir).toBe(spaceDir);
  });

  // 7. checkout list is NOT treated as list mode
  test('7. checkout list is NOT treated as list mode', () => {
    const res = run(TEST_CLI, ['checkout', 'list', '--dryrun'], spaceDir);
    expect(res.status).toBe(0);
    expect(res.json).toBeDefined();
    expect(res.json.success).toBe(true);
    expect(res.json.dryRun).toBe(true);
  });

  // 8. op log --max-count 2 receives number 2 and succeeds
  test('8. op log --max-count 2 receives number 2 and succeeds', () => {
    const res = run(TEST_CLI, ['log', '--max-count', '2'], spaceDir);
    expect(res.status).toBe(0);
    expect(res.json).toBeDefined();
    expect(Array.isArray(res.json.commits)).toBe(true);
    expect(res.json.commits.length).toBeGreaterThanOrEqual(1);
    expect(res.json.commits[0].author).toBe('Test User');
    expect(res.json.commits[0].count).toBe(2);
  });

  // 9. --schema publishes valid document whose version matches package.json and globals array
  test('9. --schema publishes valid document whose version matches package.json and globals array', () => {
    const pkg = JSON.parse(readFileSync(PKG_PATH, 'utf-8'));
    const res = run(TEST_CLI, ['--schema']);
    expect(res.status).toBe(0);
    expect(res.json).toBeDefined();
    expect(res.json.schema).toBe('cli.schema.v1');
    expect(res.json.version).toBe(pkg.version);
    expect(Array.isArray(res.json.globals)).toBe(true);
    expect(res.json.globals.length).toBeGreaterThan(0);

    const parsed = parsePublishedSchema(res.json);
    expect(parsed.ok).toBe(true);
  });

  // 10. --help exit 0 lists every op
  test('10. --help exit 0 lists every op', () => {
    const res = run(TEST_CLI, ['--help']);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('testtool — structured CLI wrapper');
    expect(res.stdout).toContain('Operations (name [access] — description):');
    expect(res.stdout).toContain('lm_status');
    expect(res.stdout).toContain('commit');
    expect(res.stdout).toContain('checkout');
    expect(res.stdout).toContain('log');
  });

  // 11. S1: live CLI rejects --prefixed keys in JSON input as UNKNOWN_PARAM
  test('11. S1 live CLI rejects --prefixed keys in JSON input as UNKNOWN_PARAM', () => {
    const doc = JSON.stringify({
      op: 'lm_status',
      params: { '--path': '/nonexistent-dir-xyz' },
    });
    const res = run(TEST_CLI, ['lm_status', '--input-json', doc]);
    expect(res.status).toBe(2);
    expect(res.json).toBeDefined();
    expect(res.json.success).toBe(false);
    expect(res.json.error.code).toBe('VALIDATION_ERROR');
    expect(res.json.error.data.issues[0].code).toBe('UNKNOWN_PARAM');
    expect(res.json.error.data.issues[0].param).toBe('--path');
  });

  // 12. S2: globals before op name work
  test('12. S2 globals before op name work: testtool --readonly lm_status, testtool --dryrun commit', () => {
    const resReadonly = run(TEST_CLI, ['--readonly', 'lm_status', '--path', spaceDir]);
    expect(resReadonly.status).toBe(0);
    expect(resReadonly.json).toBeDefined();
    expect(resReadonly.json.clean).toBe(true);

    const resDryrun = run(TEST_CLI, ['--dryrun', 'commit', '--message', 'test commit'], spaceDir);
    expect(resDryrun.status).toBe(0);
    expect(resDryrun.json).toBeDefined();
    expect(resDryrun.json.success).toBe(true);
    expect(resDryrun.json.dryRun).toBe(true);
  });

  // 13. N4: unrelated flag parse failure with --input-json reports validation error, not MIXED_INPUT
  test('13. N4 unrelated flag parse failure with --input-json reports validation error, not MIXED_INPUT', () => {
    const doc = JSON.stringify({
      op: 'lm_status',
      params: { path: spaceDir },
    });
    const res = run(TEST_CLI, ['lm_status', '--input-json', doc, '--dryrun=maybe']);
    expect(res.status).toBe(2);
    expect(res.json).toBeDefined();
    expect(res.json.error.code).toBe('VALIDATION_ERROR');
    expect(res.json.error.data.issues[0].code).toBe('TYPE_MISMATCH');
    expect(res.json.error.data.issues[0].code).not.toBe('MIXED_INPUT');
  });
});
