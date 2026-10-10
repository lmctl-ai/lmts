/**
 * @fileoverview Dependency-direction and purity guard tests.
 * Asserts src/ (pure) remains dependency-free with no node, process, cross-spawn, or server/modules imports,
 * that validate-entry.ts has a minimal closure, and that dependency direction flows only from
 * server and modules -> pure library, never vice versa.
 */

import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';

const SRC_DIR = resolve(import.meta.dir, '../src');
const SERVER_DIR = resolve(SRC_DIR, 'server');
const MODULES_DIR = resolve(SRC_DIR, 'modules');

describe('dependency guards', () => {
  // Top-level files in src/ are the pure library
  const pureFiles = readdirSync(SRC_DIR)
    .filter((f) => f.endsWith('.ts'))
    .map((f) => resolve(SRC_DIR, f));

  // Server runtime files in src/server/
  const serverFiles = readdirSync(SERVER_DIR)
    .filter((f) => f.endsWith('.ts'))
    .map((f) => resolve(SERVER_DIR, f));

  // Module store files in src/modules/
  const modulesFiles = readdirSync(MODULES_DIR)
    .filter((f) => f.endsWith('.ts'))
    .map((f) => resolve(MODULES_DIR, f));

  test('(a) src/ (pure) does not import node: and does not use process.', () => {
    for (const file of pureFiles) {
      const content = readFileSync(file, 'utf-8');
      expect(content).not.toContain('node:');
      const processMatches = content.match(/\bprocess\.[a-zA-Z_]\w*/g) ?? [];
      expect(processMatches).toEqual([]);
    }
  });

  test('(b) src/ (pure) does not import cross-spawn', () => {
    for (const file of pureFiles) {
      const content = readFileSync(file, 'utf-8');
      expect(content).not.toContain('cross-spawn');
    }
  });

  test('(c) src/ (pure) does not import src/server or src/modules', () => {
    for (const file of pureFiles) {
      const content = readFileSync(file, 'utf-8');
      expect(content).not.toMatch(/from\s+['"][^'"]*\/server(\/[^'"]*)?['"]/);
      expect(content).not.toMatch(/require\(['"][^'"]*\/server(\/[^'"]*)?['"]\)/);
      expect(content).not.toMatch(/import\(['"][^'"]*\/server(\/[^'"]*)?['"]\)/);

      expect(content).not.toMatch(/from\s+['"][^'"]*\/modules(\/[^'"]*)?['"]/);
      expect(content).not.toMatch(/require\(['"][^'"]*\/modules(\/[^'"]*)?['"]\)/);
      expect(content).not.toMatch(/import\(['"][^'"]*\/modules(\/[^'"]*)?['"]\)/);
    }
  });

  test('(d) no import of legacy parser in src/ (pure)', () => {
    const legacyPkg = ['chevro', 'tain'].join('');
    const legacyImportRe = new RegExp(`from\\s+['"]${legacyPkg}['"]`);
    const legacyRequireRe = new RegExp(`require\\(['"]${legacyPkg}['"]\\)`);
    const legacyDynImportRe = new RegExp(`import\\(['"]${legacyPkg}['"]\\)`);
    for (const file of pureFiles) {
      const content = readFileSync(file, 'utf-8');
      expect(content).not.toMatch(legacyImportRe);
      expect(content).not.toMatch(legacyRequireRe);
      expect(content).not.toMatch(legacyDynImportRe);
    }
  });

  test('(e) validate-entry.ts transitive closure excludes argv-form.ts, graphql-form.ts, inputs.ts, server, and modules', () => {
    const entryFile = resolve(SRC_DIR, 'validate-entry.ts');
    const visited = new Set<string>();

    function extractImports(filePath: string): string[] {
      const content = readFileSync(filePath, 'utf-8');
      const imports: string[] = [];
      const regex = /(?:import|export)\s+(?:[\s\S]*?from\s+)?['"](\.\/[^'"]+)['"]/g;
      let match: RegExpExecArray | null;
      while ((match = regex.exec(content)) !== null) {
        imports.push(match[1]!);
      }
      return imports;
    }

    function trace(filePath: string) {
      if (visited.has(filePath)) return;
      visited.add(filePath);

      const relImports = extractImports(filePath);
      for (const rel of relImports) {
        const tsName = rel.endsWith('.js') ? rel.slice(0, -3) + '.ts' : rel + '.ts';
        const targetPath = resolve(dirname(filePath), tsName);
        trace(targetPath);
      }
    }

    trace(entryFile);

    const visitedBasenames = Array.from(visited).map((p) => basename(p));
    expect(visitedBasenames).not.toContain('argv-form.ts');
    expect(visitedBasenames).not.toContain('graphql-form.ts');
    expect(visitedBasenames).not.toContain('inputs.ts');
    expect(visitedBasenames).not.toContain('interpret.ts');
    for (const visitedPath of visited) {
      expect(visitedPath).not.toContain('/server/');
      expect(visitedPath).not.toContain('/modules/');
    }
    expect(visitedBasenames).toContain('validate.ts');
    expect(visitedBasenames).toContain('types.ts');
  });

  test('(f) server and modules may import pure library, but pure library never imports server or modules', () => {
    // Verify server files exist and can import ../index.js or ../types.js
    expect(serverFiles.length).toBeGreaterThan(0);
    let serverImportsPure = false;
    for (const file of serverFiles) {
      const content = readFileSync(file, 'utf-8');
      if (content.includes('../index.js') || content.includes('../types.js')) {
        serverImportsPure = true;
      }
    }
    expect(serverImportsPure).toBe(true);

    // Verify modules files exist and can import pure library
    expect(modulesFiles.length).toBeGreaterThan(0);
    let modulesImportsPure = false;
    for (const file of modulesFiles) {
      const content = readFileSync(file, 'utf-8');
      if (content.includes('../publish.js') || content.includes('../types.js')) {
        modulesImportsPure = true;
      }
    }
    expect(modulesImportsPure).toBe(true);

    // Verify pure library has zero server or modules references
    for (const file of pureFiles) {
      const content = readFileSync(file, 'utf-8');
      expect(content).not.toContain('./server');
      expect(content).not.toContain('src/server');
      expect(content).not.toContain('./modules');
      expect(content).not.toContain('src/modules');
    }
  });

  test('(g) server does not import modules, and modules does not import server', () => {
    for (const file of serverFiles) {
      const content = readFileSync(file, 'utf-8');
      expect(content).not.toMatch(/from\s+['"][^'"]*\/modules(\/[^'"]*)?['"]/);
      expect(content).not.toMatch(/require\(['"][^'"]*\/modules(\/[^'"]*)?['"]\)/);
    }
    for (const file of modulesFiles) {
      const content = readFileSync(file, 'utf-8');
      expect(content).not.toMatch(/from\s+['"][^'"]*\/server(\/[^'"]*)?['"]/);
      expect(content).not.toMatch(/require\(['"][^'"]*\/server(\/[^'"]*)?['"]\)/);
    }
  });
});
