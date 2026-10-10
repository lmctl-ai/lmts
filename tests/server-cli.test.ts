/**
 * @fileoverview Unit tests for the server CLI runner (src/server/cli.ts).
 * Tests all branches of runCli in-process: help, list, schema, explain,
 * document inputs, mixed input prevention, env floors, op dispatch, and error handling.
 */

import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  GLOBAL_FLAGS,
  dryRunFromEnv,
  readOnlyFromEnv,
  runCli,
  synthesizeSchema,
  type RunnerConfig,
} from '../src/server/cli.js';
import { CliError, ErrorCode } from '../src/server/errors.js';
import type { OpDef } from '../src/server/types.js';
import type { Policy } from '../src/server/policy.js';
import type { OperationSchema } from '../src/types.js';

interface TestContext {
  policy: Policy;
}

const TEST_OP_SCHEMA: OperationSchema = {
  name: 'greet',
  access: 'read',
  description: 'Say hello',
  params: [
    { name: 'name', type: 'string', occurs: '1', description: 'Name to greet' },
    { name: 'shout', type: 'boolean', occurs: '?', description: 'Shout greeting' },
  ],
};

const WRITE_OP_SCHEMA: OperationSchema = {
  name: 'save',
  access: 'write',
  description: 'Save data',
  params: [
    { name: 'item', type: 'string', occurs: '1', description: 'Item name' },
  ],
};

function createTestConfig(overrides?: Partial<RunnerConfig<TestContext>>): RunnerConfig<TestContext> {
  const ops: OpDef<TestContext>[] = [
    {
      name: 'greet',
      description: 'Say hello',
      access: 'read',
      inputSchema: TEST_OP_SCHEMA,
      run: async (params, ctx) => {
        const name = params['name'] as string;
        const shout = params['shout'] as boolean | undefined;
        const msg = `Hello, ${name}!`;
        return { message: shout ? msg.toUpperCase() : msg };
      },
    },
    {
      name: 'save',
      description: 'Save data',
      access: 'write',
      inputSchema: WRITE_OP_SCHEMA,
      run: async (params, ctx) => {
        if (ctx.policy.readOnly) {
          throw new CliError(ErrorCode.ReadOnlyViolation, 'Cannot save in read-only mode');
        }
        if (ctx.policy.dryRun) {
          return { success: true, dryRun: true, simulated: 'save', item: params['item'] };
        }
        return { success: true, saved: params['item'] };
      },
    },
    {
      name: 'fail',
      description: 'Always fails',
      access: 'read',
      run: async () => {
        throw new Error('generic execution failure');
      },
    },
    {
      name: 'cli_fail',
      description: 'Fails with CliError',
      access: 'read',
      run: async () => {
        throw new CliError(ErrorCode.Conflict, 'resource conflict', { id: 123 });
      },
    },
    {
      name: 'legacy_raw',
      description: 'Legacy op without schema',
      access: 'dynamic',
      // No inputSchema -> tests synthesizeSchema
      run: async (params) => {
        return { received: params };
      },
    },
  ];

  return {
    toolName: 'mytool',
    version: '1.2.3',
    description: 'My test tool CLI',
    ops,
    buildContext: (policy) => ({ policy }),
    ...overrides,
  };
}

/** Intercept process.stdout.write during execution. */
async function captureOutput(fn: () => Promise<number>): Promise<{ code: number; stdout: string }> {
  let stdout = '';
  const origWrite = process.stdout.write;
  try {
    process.stdout.write = ((chunk: any) => {
      stdout += String(chunk);
      return true;
    }) as any;
    const code = await fn();
    return { code, stdout };
  } finally {
    process.stdout.write = origWrite;
  }
}

describe('server/cli env helpers', () => {
  test('readOnlyFromEnv recognizes true values and ignores false values', () => {
    delete process.env['MYTOOL_READONLY'];
    expect(readOnlyFromEnv('mytool')).toBe(false);

    process.env['MYTOOL_READONLY'] = '1';
    expect(readOnlyFromEnv('mytool')).toBe(true);

    process.env['MYTOOL_READONLY'] = 'true';
    expect(readOnlyFromEnv('mytool')).toBe(true);

    process.env['MYTOOL_READONLY'] = 'yes';
    expect(readOnlyFromEnv('mytool')).toBe(true);

    process.env['MYTOOL_READONLY'] = 'on';
    expect(readOnlyFromEnv('mytool')).toBe(true);

    process.env['MYTOOL_READONLY'] = '0';
    expect(readOnlyFromEnv('mytool')).toBe(false);

    process.env['MYTOOL_READONLY'] = 'false';
    expect(readOnlyFromEnv('mytool')).toBe(false);
    delete process.env['MYTOOL_READONLY'];
  });

  test('dryRunFromEnv recognizes true values and ignores false values', () => {
    delete process.env['MYTOOL_DRYRUN'];
    expect(dryRunFromEnv('mytool')).toBe(false);

    process.env['MYTOOL_DRYRUN'] = '1';
    expect(dryRunFromEnv('mytool')).toBe(true);

    process.env['MYTOOL_DRYRUN'] = 'YES';
    expect(dryRunFromEnv('mytool')).toBe(true);

    process.env['MYTOOL_DRYRUN'] = 'false';
    expect(dryRunFromEnv('mytool')).toBe(false);
    delete process.env['MYTOOL_DRYRUN'];
  });

  test('synthesizeSchema builds schema with additionalParams: true', () => {
    const opDef: OpDef<any> = {
      name: 'synth_op',
      description: 'synthetic op',
      access: 'read',
      run: async () => ({}),
    };
    const schema = synthesizeSchema(opDef);
    expect(schema.name).toBe('synth_op');
    expect(schema.access).toBe('read');
    expect(schema.additionalParams).toBe(true);
    expect(schema.params).toEqual([]);
  });
});

describe('server/cli runCli global actions', () => {
  const config = createTestConfig();

  test('empty argv displays tool help and exits 0', async () => {
    const { code, stdout } = await captureOutput(() => runCli(config, []));
    expect(code).toBe(0);
    expect(stdout).toContain('mytool');
    expect(stdout).toContain('My test tool CLI');
    expect(stdout).toContain('Global options:');
  });

  test('--help and -h at root displays tool help and exits 0', async () => {
    const res1 = await captureOutput(() => runCli(config, ['--help']));
    expect(res1.code).toBe(0);
    expect(res1.stdout).toContain('Global options:');

    const res2 = await captureOutput(() => runCli(config, ['-h']));
    expect(res2.code).toBe(0);
    expect(res2.stdout).toContain('Global options:');
  });

  test('--list prints ops as JSON array and exits 0', async () => {
    const { code, stdout } = await captureOutput(() => runCli(config, ['--list']));
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.some((o: any) => o.name === 'greet')).toBe(true);
  });

  test('--schema prints cli.schema.v1 JSON document and exits 0', async () => {
    const { code, stdout } = await captureOutput(() => runCli(config, ['--schema']));
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.schema).toBe('cli.schema.v1');
    expect(parsed.tool).toBe('mytool');
    expect(parsed.version).toBe('1.2.3');
    expect(parsed.operations.length).toBeGreaterThan(0);
  });

  test('--explain handles json and text formats', async () => {
    // 1. Missing op name
    const missing = await captureOutput(() => runCli(config, ['--explain']));
    expect(missing.code).toBe(2);
    expect(JSON.parse(missing.stdout).error.code).toBe('INVALID_REQUEST');

    // 2. Unknown op name
    const unknown = await captureOutput(() => runCli(config, ['--explain', 'nonexistent']));
    expect(unknown.code).toBe(2);
    expect(JSON.parse(unknown.stdout).error.code).toBe('INVALID_REQUEST');

    // 3. JSON format (default)
    const jsonFmt = await captureOutput(() => runCli(config, ['--explain', 'greet']));
    expect(jsonFmt.code).toBe(0);
    const parsedSchema = JSON.parse(jsonFmt.stdout);
    expect(parsedSchema.name).toBe('greet');

    // 4. Text format (--format text)
    const textFmt = await captureOutput(() => runCli(config, ['--explain', 'greet', '--format', 'text']));
    expect(textFmt.code).toBe(0);
    expect(textFmt.stdout).toContain('mytool greet');
    expect(textFmt.stdout).toContain('--name');
  });

  test('no operation specified and no inferred op exits 2', async () => {
    const res = await captureOutput(() => runCli(config, ['--confirm', '--dryrun']));
    expect(res.code).toBe(2);
    const parsed = JSON.parse(res.stdout);
    expect(parsed.error.code).toBe('INVALID_REQUEST');
    expect(parsed.error.message).toContain('No operation specified');
  });
});

describe('server/cli runCli op dispatch and arguments', () => {
  const config = createTestConfig();

  test('successful flag-based execution', async () => {
    const { code, stdout } = await captureOutput(() =>
      runCli(config, ['greet', '--name', 'Alice', '--shout']),
    );
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toEqual({ message: 'HELLO, ALICE!' });
  });

  test('leading globals before op name', async () => {
    const { code, stdout } = await captureOutput(() =>
      runCli(config, ['--dryrun', 'greet', '--name', 'Bob']),
    );
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toEqual({ message: 'Hello, Bob!' });
  });

  test('negated global flag before op', async () => {
    const { code, stdout } = await captureOutput(() =>
      runCli(config, ['--no-dryrun', 'greet', '--name', 'Carol']),
    );
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toEqual({ message: 'Hello, Carol!' });
  });

  test('synthesized op with double dash separator', async () => {
    const { code, stdout } = await captureOutput(() =>
      runCli(config, ['legacy_raw', '--', 'arg1', 'arg2']),
    );
    expect(code).toBe(0);
  });

  test('op-level --help displays op help text', async () => {
    const { code, stdout } = await captureOutput(() =>
      runCli(config, ['greet', '--help']),
    );
    expect(code).toBe(0);
    expect(stdout).toContain('mytool greet');
    expect(stdout).toContain('Say hello');
  });

  test('unknown op name reports error and exits 2', async () => {
    const { code, stdout } = await captureOutput(() =>
      runCli(config, ['unknown_command']),
    );
    expect(code).toBe(2);
    const err = JSON.parse(stdout);
    expect(err.error.code).toBe('INVALID_REQUEST');
    expect(err.error.message).toContain('Unknown operation: unknown_command');
  });

  test('synthesizeSchema op runs successfully', async () => {
    const { code, stdout } = await captureOutput(() =>
      runCli(config, ['legacy_raw', '--foo', 'bar', '--count', '10']),
    );
    expect(code).toBe(0);
    const res = JSON.parse(stdout);
    expect(res.received.foo).toBe('bar');
  });

  test('op throwing generic Error outputs INTERNAL_ERROR envelope and exits 1', async () => {
    const { code, stdout } = await captureOutput(() =>
      runCli(config, ['fail']),
    );
    expect(code).toBe(1);
    const err = JSON.parse(stdout);
    expect(err.success).toBe(false);
    expect(err.error.message).toContain('generic execution failure');
  });

  test('op throwing CliError outputs structured envelope and mapped exit code', async () => {
    const { code, stdout } = await captureOutput(() =>
      runCli(config, ['cli_fail']),
    );
    expect(code).toBe(5); // Conflict -> 5
    const err = JSON.parse(stdout);
    expect(err.error.code).toBe('CONFLICT');
    expect(err.error.data).toEqual({ id: 123 });
  });
});

describe('server/cli document inputs and MIXED_INPUT', () => {
  const config = createTestConfig();

  test('--input-json execution and envelope inference', async () => {
    // 1. With explicit op
    const res1 = await captureOutput(() =>
      runCli(config, ['greet', '--input-json', '{"name":"Dave"}']),
    );
    expect(res1.code).toBe(0);
    expect(JSON.parse(res1.stdout)).toEqual({ message: 'Hello, Dave!' });

    // 2. Root inference from json envelope { op: "greet", params: { name: "Eve" } }
    const res2 = await captureOutput(() =>
      runCli(config, ['--input-json', '{"op":"greet","params":{"name":"Eve"}}']),
    );
    expect(res2.code).toBe(0);
    expect(JSON.parse(res2.stdout)).toEqual({ message: 'Hello, Eve!' });
  });

  test('--input-graphql execution and envelope inference', async () => {
    // 1. With explicit op
    const res1 = await captureOutput(() =>
      runCli(config, ['greet', '--input-graphql', 'query { greet(name: "Frank") { __typename } }']),
    );
    expect(res1.code).toBe(0);
    expect(JSON.parse(res1.stdout)).toEqual({ message: 'Hello, Frank!' });

    // 2. Root inference
    const res2 = await captureOutput(() =>
      runCli(config, ['--input-graphql', 'query { greet(name: "Grace") { __typename } }']),
    );
    expect(res2.code).toBe(0);
    expect(JSON.parse(res2.stdout)).toEqual({ message: 'Hello, Grace!' });
  });

  test('--input-file execution and errors', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'lmts-cli-doc-'));
    const validFile = join(tmp, 'doc.json');
    const invalidFile = join(tmp, 'nonexistent.json');

    try {
      writeFileSync(validFile, JSON.stringify({ name: 'Heidi' }));

      // 1. Valid file
      const res = await captureOutput(() =>
        runCli(config, ['greet', '--input-file', validFile]),
      );
      expect(res.code).toBe(0);
      expect(JSON.parse(res.stdout)).toEqual({ message: 'Hello, Heidi!' });

      // 2. Nonexistent file
      const resErr = await captureOutput(() =>
        runCli(config, ['greet', '--input-file', invalidFile]),
      );
      expect(resErr.code).toBe(2);
      expect(JSON.parse(resErr.stdout).error.code).toBe('INVALID_REQUEST');

      // 3. Root nonexistent file
      const resRootErr = await captureOutput(() =>
        runCli(config, ['--input-file', invalidFile]),
      );
      expect(resRootErr.code).toBe(2);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('MIXED_INPUT prevention', async () => {
    // 1. Document input mixed with op flag
    const resFlag = await captureOutput(() =>
      runCli(config, ['greet', '--input-json', '{"name":"Ivan"}', '--shout']),
    );
    expect(resFlag.code).toBe(2);
    const errFlag = JSON.parse(resFlag.stdout);
    expect(errFlag.error.code).toBe('VALIDATION_ERROR');
    expect(errFlag.error.data.issues[0].code).toBe('MIXED_INPUT');

    // 2. Document input mixed with unknown/invalid flag
    const resBadFlag = await captureOutput(() =>
      runCli(config, ['greet', '--input-json', '{"name":"Ivan"}', '--invalid-flag']),
    );
    expect(resBadFlag.code).toBe(2);
  });

  test('validation failure in resolveInput maps to VALIDATION_ERROR envelope', async () => {
    // Missing required param 'name'
    const res = await captureOutput(() =>
      runCli(config, ['greet', '--shout']),
    );
    expect(res.code).toBe(2);
    const err = JSON.parse(res.stdout);
    expect(err.error.code).toBe('VALIDATION_ERROR');
    expect(err.error.data.issues.some((i: any) => i.code === 'MISSING_REQUIRED')).toBe(true);

    // Unknown param triggers UNKNOWN_PARAM synopsis enhancement
    const resUnknown = await captureOutput(() =>
      runCli(config, ['greet', '--name', 'Judy', '--nonexistent']),
    );
    expect(resUnknown.code).toBe(2);
    const errUnknown = JSON.parse(resUnknown.stdout);
    expect(errUnknown.error.data.issues.some((i: any) => i.code === 'UNKNOWN_PARAM')).toBe(true);
  });

  test('policy floors from environment variables cannot be bypassed', async () => {
    try {
      process.env['MYTOOL_READONLY'] = '1';
      // Trying to run write op 'save' must fail even if --readonly wasn't on CLI
      const res = await captureOutput(() =>
        runCli(config, ['save', '--item', 'file.txt']),
      );
      expect(res.code).toBe(6); // ReadOnlyViolation
      expect(JSON.parse(res.stdout).error.code).toBe('READONLY_VIOLATION');
    } finally {
      delete process.env['MYTOOL_READONLY'];
    }

    try {
      process.env['MYTOOL_DRYRUN'] = '1';
      const resDry = await captureOutput(() =>
        runCli(config, ['save', '--item', 'file.txt']),
      );
      expect(resDry.code).toBe(0);
      expect(JSON.parse(resDry.stdout)).toEqual({
        success: true,
        dryRun: true,
        simulated: 'save',
        item: 'file.txt',
      });
    } finally {
      delete process.env['MYTOOL_DRYRUN'];
    }
  });
});
