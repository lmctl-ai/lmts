/**
 * @fileoverview Smoke tests verifying that standard Node.js can import the compiled
 * dist/ artifacts from an external working directory, asserting key exports and that
 * all package.json export targets exist on disk.
 */

import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT_DIR = resolve(import.meta.dir, '..');
const PACKAGE_JSON_PATH = resolve(ROOT_DIR, 'package.json');

describe('Node.js runtime import smoke tests', () => {
  test('all package.json exports targets exist on disk', () => {
    const pkg = JSON.parse(readFileSync(PACKAGE_JSON_PATH, 'utf-8'));
    const exportsMap = pkg.exports;

    expect(exportsMap).toBeDefined();

    for (const [subpath, conditions] of Object.entries<Record<string, string>>(exportsMap)) {
      for (const [cond, relPath] of Object.entries(conditions)) {
        const fullPath = resolve(ROOT_DIR, relPath);
        const exists = existsSync(fullPath);
        if (!exists) {
          throw new Error(
            `Export target for "${subpath}" condition "${cond}" (${relPath}) does not exist at ${fullPath}`,
          );
        }
        expect(exists).toBe(true);
      }
    }
  });

  test('node --input-type=module imports dist entries and validates exports from outside repo', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'lmts-node-smoke-'));

    const mainDist = resolve(ROOT_DIR, 'dist/index.js');
    const validateDist = resolve(ROOT_DIR, 'dist/validate-entry.js');
    const serverDist = resolve(ROOT_DIR, 'dist/server/index.js');
    const modulesDist = resolve(ROOT_DIR, 'dist/modules/index.js');

    const nodeScript = `
import assert from 'node:assert';
import * as main from ${JSON.stringify(mainDist)};
import * as validateEntry from ${JSON.stringify(validateDist)};
import * as server from ${JSON.stringify(serverDist)};
import * as modules from ${JSON.stringify(modulesDist)};

// 1. Assert validate entry exports
assert.strictEqual(typeof validateEntry.validate, 'function', 'validateEntry.validate must be a function');
assert.strictEqual(typeof validateEntry.isEffectful, 'function', 'validateEntry.isEffectful must be a function');
assert.strictEqual(typeof validateEntry.satisfies, 'function', 'validateEntry.satisfies must be a function');
assert.strictEqual(typeof validateEntry.parseVersion, 'function', 'validateEntry.parseVersion must be a function');
assert.strictEqual('interpretCommand' in validateEntry, false, 'validateEntry must NOT export interpretCommand');

// 2. Assert main entry exports
assert.strictEqual(typeof main.interpretCommand, 'function', 'main.interpretCommand must be a function');
assert.strictEqual(typeof main.tokenizeSimpleCommand, 'function', 'main.tokenizeSimpleCommand must be a function');
assert.strictEqual(typeof main.classifyOperation, 'function', 'main.classifyOperation must be a function');
assert.strictEqual(typeof main.describeForPrompt, 'function', 'main.describeForPrompt must be a function');
assert.strictEqual(typeof main.satisfies, 'function', 'main.satisfies must be a function');
assert.strictEqual(typeof main.parseVersion, 'function', 'main.parseVersion must be a function');

// 3. Assert server entry exports
assert.strictEqual(typeof server.runCli, 'function', 'server.runCli must be a function');
assert.strictEqual(typeof server.checkPolicy, 'function', 'server.checkPolicy must be a function');
assert.strictEqual(typeof server.spawnCommand, 'function', 'server.spawnCommand must be a function');
assert.strictEqual(typeof server.checkProductVersion, 'function', 'server.checkProductVersion must be a function');

// 4. Assert modules entry exports
assert.strictEqual(typeof modules.parseSpec, 'function', 'modules.parseSpec must be a function');
assert.strictEqual(typeof modules.cacheRoot, 'function', 'modules.cacheRoot must be a function');
assert.strictEqual(typeof modules.entryDir, 'function', 'modules.entryDir must be a function');
assert.strictEqual(typeof modules.resolveCached, 'function', 'modules.resolveCached must be a function');
assert.strictEqual(typeof modules.ensure, 'function', 'modules.ensure must be a function');
assert.strictEqual(typeof modules.install, 'function', 'modules.install must be a function');
assert.strictEqual(typeof modules.list, 'function', 'modules.list must be a function');
assert.strictEqual(typeof modules.upgrade, 'function', 'modules.upgrade must be a function');
assert.strictEqual(typeof modules.remove, 'function', 'modules.remove must be a function');
assert.strictEqual(typeof modules.findOnPath, 'function', 'modules.findOnPath must be a function');

console.log('NODE_IMPORT_OK');
`;

    try {
      const output = execFileSync(
        'node',
        ['--input-type=module', '-e', nodeScript],
        {
          cwd: tmpDir,
          encoding: 'utf-8',
        },
      );

      expect(output.trim()).toBe('NODE_IMPORT_OK');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
