/**
 * @fileoverview Verifies that the committed dist/ directory is completely
 * fresh, deterministic, and byte-identical to a freshly compiled build.
 */

import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';

const ROOT_DIR = resolve(import.meta.dir, '..');
const DIST_DIR = resolve(ROOT_DIR, 'dist');

function getAllFiles(dir: string, baseDir: string = dir): string[] {
  const files: string[] = [];
  const entries = readdirSync(dir);
  for (const entry of entries) {
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      files.push(...getAllFiles(fullPath, baseDir));
    } else {
      files.push(relative(baseDir, fullPath));
    }
  }
  return files.sort();
}

describe('dist freshness & determinism', () => {
  test('committed dist/ is byte-identical to fresh tsc build', () => {
    const tmpOutDir = mkdtempSync(join(tmpdir(), 'lmts-dist-fresh-'));
    try {
      execFileSync(
        'bunx',
        ['tsc', '-p', 'tsconfig.build.json', '--outDir', tmpOutDir],
        { cwd: ROOT_DIR, encoding: 'utf-8' },
      );

      const committedFiles = getAllFiles(DIST_DIR);
      const freshFiles = getAllFiles(tmpOutDir);

      if (committedFiles.length !== freshFiles.length || committedFiles.some((f, i) => f !== freshFiles[i])) {
        throw new Error(
          `File list in dist/ does not match fresh build. Run \`bun run build\` and commit dist/.\nCommitted: [${committedFiles.join(', ')}]\nFresh: [${freshFiles.join(', ')}]`,
        );
      }
      expect(committedFiles).toEqual(freshFiles);

      for (const file of committedFiles) {
        const committedContent = readFileSync(join(DIST_DIR, file));
        const freshContent = readFileSync(join(tmpOutDir, file));

        const isIdentical = Buffer.compare(committedContent, freshContent) === 0;
        if (!isIdentical) {
          throw new Error(
            `File dist/${file} differs from freshly built file. Run \`bun run build\` and commit dist/.`,
          );
        }
        expect(isIdentical).toBe(true);
      }
    } finally {
      rmSync(tmpOutDir, { recursive: true, force: true });
    }
  }, 30000);
});
