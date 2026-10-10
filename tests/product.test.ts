/**
 * @fileoverview Hermetic tests for product metadata schema validation,
 * product version detection (checkProductVersion), caching, and runCli gating.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parsePublishedSchema,
  publishSchema,
  type ProductInfo,
  type PublishedCliSchema,
} from '../src/index.js';
import { runCli } from '../src/server/cli.js';
import { ErrorCode } from '../src/server/errors.js';
import { checkProductVersion, resetProductVersionCache } from '../src/server/product.js';
import type { OpDef } from '../src/server/types.js';

describe('product schema validation in parsePublishedSchema', () => {
  const baseDoc: PublishedCliSchema = {
    schema: 'cli.schema.v1',
    tool: 'git2',
    version: '1.0.0',
    policy: { dryrun: true, readonly: true },
    inputs: ['flags', 'json'],
    operations: [
      {
        name: 'status',
        params: [],
      },
    ],
  };

  test('accepts valid product with detect block', () => {
    const doc = {
      ...baseDoc,
      product: {
        name: 'git',
        supported: '>=2.43.0 <3.0.0',
        detect: {
          argv: ['git', '--version'],
          pattern: '(\\d+\\.\\d+\\.\\d+)',
        },
      },
    };
    const res = parsePublishedSchema(doc);
    expect(res.ok).toBe(true);
  });

  test('accepts valid product without detect block', () => {
    const doc = {
      ...baseDoc,
      product: {
        name: 'git',
        supported: '>=2.43.0',
      },
    };
    const res = parsePublishedSchema(doc);
    expect(res.ok).toBe(true);
  });

  test('rejects non-object product', () => {
    const doc = { ...baseDoc, product: 'not-an-object' };
    const res = parsePublishedSchema(doc);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues.some((i) => i.code === 'TYPE_MISMATCH')).toBe(true);
    }
  });

  test('rejects unknown property in product', () => {
    const doc = {
      ...baseDoc,
      product: {
        name: 'git',
        supported: '>=2.43.0',
        extra: 'not allowed',
      },
    };
    const res = parsePublishedSchema(doc);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues.some((i) => i.code === 'UNKNOWN_PARAM')).toBe(true);
    }
  });

  test('rejects invalid product name with uppercase or symbols', () => {
    const doc = {
      ...baseDoc,
      product: {
        name: 'Git_Tool',
        supported: '>=2.43.0',
      },
    };
    const res = parsePublishedSchema(doc);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues.some((i) => i.code === 'DOCUMENT_PARSE')).toBe(true);
    }
  });

  test('rejects product name starting with non-letter', () => {
    const doc = {
      ...baseDoc,
      product: {
        name: '1git',
        supported: '>=2.43.0',
      },
    };
    const res = parsePublishedSchema(doc);
    expect(res.ok).toBe(false);
  });

  test('rejects invalid supported range', () => {
    const doc = {
      ...baseDoc,
      product: {
        name: 'git',
        supported: 'bad-range',
      },
    };
    const res = parsePublishedSchema(doc);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues.some((i) => i.code === 'DOCUMENT_PARSE')).toBe(true);
    }
  });

  test('rejects detect with non-object', () => {
    const doc = {
      ...baseDoc,
      product: {
        name: 'git',
        supported: '>=2.43.0',
        detect: 'not-an-object',
      },
    };
    const res = parsePublishedSchema(doc);
    expect(res.ok).toBe(false);
  });

  test('rejects detect with empty argv array', () => {
    const doc = {
      ...baseDoc,
      product: {
        name: 'git',
        supported: '>=2.43.0',
        detect: {
          argv: [],
          pattern: '(\\d+)',
        },
      },
    };
    const res = parsePublishedSchema(doc);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues.some((i) => i.code === 'DOCUMENT_PARSE')).toBe(true);
    }
  });

  test('rejects detect argv[0] with slashes', () => {
    const doc = {
      ...baseDoc,
      product: {
        name: 'git',
        supported: '>=2.43.0',
        detect: {
          argv: ['/usr/bin/git', '--version'],
          pattern: '(\\d+)',
        },
      },
    };
    const res = parsePublishedSchema(doc);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues.some((i) => i.code === 'DOCUMENT_PARSE')).toBe(true);
    }
  });

  test('rejects detect pattern with invalid regex', () => {
    const doc = {
      ...baseDoc,
      product: {
        name: 'git',
        supported: '>=2.43.0',
        detect: {
          argv: ['git', '--version'],
          pattern: '[invalid-regex',
        },
      },
    };
    const res = parsePublishedSchema(doc);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues.some((i) => i.code === 'DOCUMENT_PARSE')).toBe(true);
    }
  });

  test('rejects detect pattern with two capture groups', () => {
    const doc = {
      ...baseDoc,
      product: {
        name: 'git',
        supported: '>=2.43.0',
        detect: {
          argv: ['git', '--version'],
          pattern: '(\\d+)\\.(\\d+)',
        },
      },
    };
    const res = parsePublishedSchema(doc);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues.some((i) => i.code === 'DOCUMENT_PARSE')).toBe(true);
    }
  });

  test('publishSchema includes product option when provided', () => {
    const prod: ProductInfo = {
      name: 'git',
      supported: '>=2.43.0',
    };
    const published = publishSchema('git2', baseDoc.operations, { product: prod });
    expect(published.product).toEqual(prod);
  });
});

describe('checkProductVersion with realistic fake executables', () => {
  let tempBinDir: string;
  let savedPath: string | undefined;

  beforeEach(() => {
    resetProductVersionCache();
    tempBinDir = mkdtempSync(join(tmpdir(), 'lmts-product-test-'));
    savedPath = process.env.PATH;
    process.env.PATH = `${tempBinDir}:${savedPath ?? ''}`;
  });

  afterEach(() => {
    process.env.PATH = savedPath;
    resetProductVersionCache();
    rmSync(tempBinDir, { recursive: true, force: true });
  });

  function createFakeExecutable(name: string, scriptContent: string) {
    const filePath = join(tempBinDir, name);
    writeFileSync(filePath, `#!/bin/sh\n${scriptContent}\n`);
    chmodSync(filePath, 0o755);
  }

  test('succeeds for realistic git output: git version 2.43.0', async () => {
    createFakeExecutable('git', 'echo "git version 2.43.0"');

    const product: ProductInfo = {
      name: 'git',
      supported: '>=2.43.0 <3.0.0',
      detect: {
        argv: ['git', '--version'],
        pattern: 'git\\s+version\\s+(\\d+\\.\\d+\\.\\d+)',
      },
    };

    const res = await checkProductVersion(product);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.found).toBe('2.43.0');
    }
  });

  test('succeeds for realistic gh output: gh version 2.45.0 (2025-07-18 Ubuntu 2.45.0-1ubuntu0.3)', async () => {
    createFakeExecutable('gh', 'echo "gh version 2.45.0 (2025-07-18 Ubuntu 2.45.0-1ubuntu0.3)"');

    const product: ProductInfo = {
      name: 'gh',
      supported: '>=2.40.0 <3.0.0',
      detect: {
        argv: ['gh', '--version'],
        pattern: 'gh\\s+version\\s+(\\d+\\.\\d+\\.\\d+)',
      },
    };

    const res = await checkProductVersion(product);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.found).toBe('2.45.0');
    }
  });

  test('succeeds for realistic aws output: aws-cli/2.34.48 Python/3.14.4 Linux/...', async () => {
    createFakeExecutable('aws', 'echo "aws-cli/2.34.48 Python/3.14.4 Linux/6.6.137 x86_64"');

    const product: ProductInfo = {
      name: 'aws',
      supported: '>=2.30.0 <3.0.0',
      detect: {
        argv: ['aws', '--version'],
        pattern: 'aws-cli\\/(\\d+\\.\\d+\\.\\d+)',
      },
    };

    const res = await checkProductVersion(product);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.found).toBe('2.34.48');
    }
  });

  test('fails with unsupported version code 10 when version is too low', async () => {
    createFakeExecutable('git', 'echo "git version 1.9.5"');

    const product: ProductInfo = {
      name: 'git',
      supported: '>=2.43.0 <3.0.0',
      detect: {
        argv: ['git', '--version'],
        pattern: 'git\\s+version\\s+(\\d+\\.\\d+\\.\\d+)',
      },
    };

    const res = await checkProductVersion(product);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe(ErrorCode.UnsupportedProductVersion);
      expect(res.data.product).toBe('git');
      expect(res.data.found).toBe('1.9.5');
      expect(res.data.supported).toBe('>=2.43.0 <3.0.0');
    }
  });

  test('fails with found: null when binary is missing on PATH', async () => {
    const product: ProductInfo = {
      name: 'nonexistent-tool',
      supported: '>=1.0.0',
      detect: {
        argv: ['nonexistent-bin', '--version'],
        pattern: '(\\d+\\.\\d+\\.\\d+)',
      },
    };

    const res = await checkProductVersion(product);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe(ErrorCode.UnsupportedProductVersion);
      expect(res.data.found).toBeNull();
      expect(res.message).toContain('not found on PATH');
    }
  });

  test('fails with found: null when output does not match pattern', async () => {
    createFakeExecutable('badtool', 'echo "unrecognized message with no numbers"');

    const product: ProductInfo = {
      name: 'badtool',
      supported: '>=1.0.0',
      detect: {
        argv: ['badtool', '--version'],
        pattern: 'version\\s+(\\d+\\.\\d+\\.\\d+)',
      },
    };

    const res = await checkProductVersion(product);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe(ErrorCode.UnsupportedProductVersion);
      expect(res.data.found).toBeNull();
    }
  });

  test('caches result per process and respects reset hook', async () => {
    let callCount = 0;
    createFakeExecutable('counting', 'echo "counting version 2.0.0"');

    const product: ProductInfo = {
      name: 'counting',
      supported: '>=2.0.0',
      detect: {
        argv: ['counting', '--version'],
        pattern: 'version\\s+(\\d+\\.\\d+\\.\\d+)',
      },
    };

    const customExec = async (cmd: string, args: string[]) => {
      callCount++;
      return { stdout: 'version 2.0.0\n', stderr: '', exitCode: 0 };
    };

    const res1 = await checkProductVersion(product, { exec: customExec });
    expect(res1.ok).toBe(true);
    expect(callCount).toBe(1);

    // Second call uses cache, exec not invoked again
    const res2 = await checkProductVersion(product, { exec: customExec });
    expect(res2.ok).toBe(true);
    expect(callCount).toBe(1);

    // After reset hook, exec is invoked again
    resetProductVersionCache();
    const res3 = await checkProductVersion(product, { exec: customExec });
    expect(res3.ok).toBe(true);
    expect(callCount).toBe(2);
  });

  test('fails with found: null when execution times out', async () => {
    createFakeExecutable('slowtool', 'sleep 5\necho "done"');

    const product: ProductInfo = {
      name: 'slowtool',
      supported: '>=1.0.0',
      detect: {
        argv: ['slowtool'],
        pattern: '(\\d+)',
      },
    };

    const res = await checkProductVersion(product, { timeoutMs: 50 });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe(ErrorCode.UnsupportedProductVersion);
      expect(res.data.found).toBeNull();
    }
  });

  test('fails when detect or detect.argv is missing/empty', async () => {
    const p1: any = { name: 'no-detect', supported: '>=1.0.0' };
    const res1 = await checkProductVersion(p1);
    expect(res1.ok).toBe(false);
    if (res1.ok) return;
    expect(res1.message).toContain('no detection configuration');

    const p2: any = { name: 'empty-argv', supported: '>=1.0.0', detect: { argv: [] } };
    const res2 = await checkProductVersion(p2);
    expect(res2.ok).toBe(false);
  });

  test('fails when argv[0] contains invalid characters or slashes', async () => {
    const p: any = {
      name: 'slash-bin',
      supported: '>=1.0.0',
      detect: { argv: ['../bin/mytool', '--version'], pattern: '(\\d+)' },
    };
    const res = await checkProductVersion(p);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.data.found).toBeNull();
  });

  test('fails when extracted version is not a valid semver', async () => {
    createFakeExecutable('notsemver', 'echo "version abc.def"');
    const p: ProductInfo = {
      name: 'notsemver',
      supported: '>=1.0.0',
      detect: { argv: ['notsemver'], pattern: 'version\\s+(\\S+)' },
    };
    const res = await checkProductVersion(p);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.message).toContain('not a valid semver version');
  });
});

describe('runCli integration with product compatibility', () => {
  let tempBinDir: string;
  let savedPath: string | undefined;

  beforeEach(() => {
    resetProductVersionCache();
    tempBinDir = mkdtempSync(join(tmpdir(), 'lmts-cli-product-test-'));
    savedPath = process.env.PATH;
    process.env.PATH = `${tempBinDir}:${savedPath ?? ''}`;
  });

  afterEach(() => {
    process.env.PATH = savedPath;
    resetProductVersionCache();
    rmSync(tempBinDir, { recursive: true, force: true });
  });

  function createFakeExecutable(name: string, scriptContent: string) {
    const filePath = join(tempBinDir, name);
    writeFileSync(filePath, `#!/bin/sh\n${scriptContent}\n`);
    chmodSync(filePath, 0o755);
  }

  const dummyOps: OpDef<{}>[] = [
    {
      name: 'status',
      access: 'read',
      description: 'Check status',
      inputSchema: {
        name: 'status',
        params: [],
      },
      run: async () => ({ status: 'clean' }),
    },
  ];

  test('runCli --schema and --list succeed even when product check fails', async () => {
    // Missing git executable -> product check would fail
    const config = {
      toolName: 'git2',
      version: '1.0.0',
      ops: dummyOps,
      buildContext: () => ({}),
      product: {
        name: 'git',
        supported: '>=2.43.0',
        detect: {
          argv: ['nonexistent-git', '--version'],
          pattern: '(\\d+\\.\\d+\\.\\d+)',
        },
      },
    };

    // Capture stdout
    let stdoutData = '';
    const origWrite = process.stdout.write;
    process.stdout.write = ((chunk: any) => {
      stdoutData += String(chunk);
      return true;
    }) as any;

    try {
      const schemaExit = await runCli(config, ['--schema']);
      expect(schemaExit).toBe(0);
      expect(stdoutData).toContain('"schema": "cli.schema.v1"');
      expect(stdoutData).toContain('"product"');

      stdoutData = '';
      const listExit = await runCli(config, ['--list']);
      expect(listExit).toBe(0);
      expect(stdoutData).toContain('status');

      stdoutData = '';
      const helpExit = await runCli(config, ['--help']);
      expect(helpExit).toBe(0);
      expect(stdoutData).toContain('Operations');

      stdoutData = '';
      const explainExit = await runCli(config, ['--explain', 'status']);
      expect(explainExit).toBe(0);
    } finally {
      process.stdout.write = origWrite;
    }
  });

  test('runCli refuses operation execution with exit code 10 when product version is unsupported', async () => {
    createFakeExecutable('mygit', 'echo "mygit version 1.8.0"');

    const config = {
      toolName: 'git2',
      version: '1.0.0',
      ops: dummyOps,
      buildContext: () => ({}),
      product: {
        name: 'mygit',
        supported: '>=2.43.0',
        detect: {
          argv: ['mygit', '--version'],
          pattern: 'version\\s+(\\d+\\.\\d+\\.\\d+)',
        },
      },
    };

    let stdoutData = '';
    const origWrite = process.stdout.write;
    process.stdout.write = ((chunk: any) => {
      stdoutData += String(chunk);
      return true;
    }) as any;

    try {
      const exitCode = await runCli(config, ['status']);
      expect(exitCode).toBe(10);
      const parsed = JSON.parse(stdoutData);
      expect(parsed.success).toBe(false);
      expect(parsed.error.code).toBe('UNSUPPORTED_PRODUCT_VERSION');
      expect(parsed.error.data.product).toBe('mygit');
      expect(parsed.error.data.found).toBe('1.8.0');
      expect(parsed.error.data.supported).toBe('>=2.43.0');
    } finally {
      process.stdout.write = origWrite;
    }
  });

  test('runCli executes operation successfully when product check passes', async () => {
    createFakeExecutable('mygit', 'echo "mygit version 2.45.0"');

    const config = {
      toolName: 'git2',
      version: '1.0.0',
      ops: dummyOps,
      buildContext: () => ({}),
      product: {
        name: 'mygit',
        supported: '>=2.43.0',
        detect: {
          argv: ['mygit', '--version'],
          pattern: 'version\\s+(\\d+\\.\\d+\\.\\d+)',
        },
      },
    };

    let stdoutData = '';
    const origWrite = process.stdout.write;
    process.stdout.write = ((chunk: any) => {
      stdoutData += String(chunk);
      return true;
    }) as any;

    try {
      const exitCode = await runCli(config, ['status']);
      expect(exitCode).toBe(0);
      const parsed = JSON.parse(stdoutData);
      expect(parsed.status).toBe('clean');
    } finally {
      process.stdout.write = origWrite;
    }
  });
});
