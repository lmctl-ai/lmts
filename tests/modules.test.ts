/**
 * @fileoverview Hermetic tests for @lmctl-ai/lmts/modules.
 * Tests spec parsing, cacheRoot, entryDir, resolveCached, install, list,
 * upgrade, remove, findOnPath, atomic writes, tamper detection, and error codes.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  cacheRoot,
  entryDir,
  findOnPath,
  install,
  list,
  parseSpec,
  remove,
  resolveCached,
  upgrade,
  type CachedModule,
  type ModuleSpec,
  type Result,
} from '../src/modules/index.js';

const VALID_SCHEMA_V1 = {
  schema: 'cli.schema.v1',
  tool: 'mytool',
  version: '1.0.0',
  policy: { dryrun: true, readonly: true },
  inputs: ['flags', 'json'],
  globals: [],
  operations: [
    {
      name: 'query',
      access: 'read',
      description: 'Query items',
      params: [{ name: 'filter', type: 'string', occurs: '?' }],
    },
    {
      name: 'apply',
      access: 'write',
      description: 'Apply changes',
      params: [{ name: 'name', type: 'string' }],
    },
  ],
};

const VALID_SCHEMA_V2 = {
  schema: 'cli.schema.v1',
  tool: 'mytool',
  version: '2.0.0',
  policy: { dryrun: true, readonly: true },
  inputs: ['flags', 'json'],
  globals: [],
  operations: [
    {
      name: 'query',
      access: 'read',
      description: 'Query items',
      params: [{ name: 'filter', type: 'string', occurs: '?' }],
    },
    {
      name: 'batch',
      access: 'write',
      description: 'Batch changes',
      params: [{ name: 'items', type: 'array' }],
    },
  ],
};

function createMockFetch(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
): typeof fetch {
  return (async (input: any, init?: any) => {
    const url = typeof input === 'string' ? input : input.url;
    return handler(url, init);
  }) as unknown as typeof fetch;
}

function mustParse(specStr: string): ModuleSpec {
  const res = parseSpec(specStr);
  if (!res.ok) {
    throw new Error(`Failed to parse spec ${specStr}: ${res.message}`);
  }
  return res.value;
}

function mustResolve<T>(res: Result<T>): T {
  if (!res.ok) {
    throw new Error(`Expected ok result, got error: ${res.code} - ${res.message}`);
  }
  return res.value;
}

describe('Module Store: parseSpec', () => {
  test('parses basic spec @owner/repo with default HEAD', () => {
    const res = parseSpec('@lmctl-ai/lmgit');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.owner).toBe('lmctl-ai');
    expect(res.value.repo).toBe('lmgit');
    expect(res.value.ref).toBeUndefined();
    expect(res.value.refOrHead).toBe('HEAD');
    expect(res.value.key).toBe('@lmctl-ai/lmgit');
    expect(res.value.immutable).toBe(false);
  });

  test('parses semver tag as immutable (v1.0.0)', () => {
    const res = parseSpec('@lmctl-ai/lmgit#v1.0.0');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.ref).toBe('v1.0.0');
    expect(res.value.immutable).toBe(true);
    expect(res.value.key).toBe('@lmctl-ai/lmgit#v1.0.0');
  });

  test('parses semver tag without leading v as immutable (1.2.3)', () => {
    const res = parseSpec('@owner/repo#1.2.3');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.immutable).toBe(true);
  });

  test('parses semver prerelease metadata as immutable', () => {
    const res = parseSpec('@owner/repo#v2.1.0-alpha.1');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.immutable).toBe(true);
  });

  test('parses 40 hex char commit sha as immutable', () => {
    const sha = 'e1613098921f45271c3b7bbcb40f92f6b10beaed';
    const res = parseSpec(`@owner/repo#${sha}`);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.immutable).toBe(true);
  });

  test('parses uppercase 40 hex char commit sha as immutable', () => {
    const sha = 'E1613098921F45271C3B7BBCB40F92F6B10BEAED';
    const res = parseSpec(`@owner/repo#${sha}`);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.immutable).toBe(true);
  });

  test('parses branch name "main" as moving (not immutable)', () => {
    const res = parseSpec('@owner/repo#main');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.immutable).toBe(false);
  });

  test('parses nested branch name "feature/branch-name" as moving', () => {
    const res = parseSpec('@owner/repo#feature/branch-name');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.ref).toBe('feature/branch-name');
    expect(res.value.refOrHead).toBe('feature/branch-name');
    expect(res.value.immutable).toBe(false);
  });

  test('parses deep branch name "releases/2026/q1" as moving', () => {
    const res = parseSpec('@owner/repo#releases/2026/q1');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.immutable).toBe(false);
  });

  test('rejects empty string with SPEC_SYNTAX', () => {
    const res = parseSpec('');
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe('SPEC_SYNTAX');
  });

  test('rejects non-string input with SPEC_SYNTAX', () => {
    const res = parseSpec(null as unknown as string);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe('SPEC_SYNTAX');
  });

  test('rejects spec without leading @ with SPEC_SYNTAX', () => {
    const res = parseSpec('owner/repo');
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe('SPEC_SYNTAX');
  });

  test('rejects spec with only @owner with SPEC_SYNTAX', () => {
    const res = parseSpec('@owner');
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe('SPEC_SYNTAX');
  });

  test('rejects path traversal attempt in owner (@../repo) with SPEC_SYNTAX', () => {
    const res = parseSpec('@../repo');
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe('SPEC_SYNTAX');
  });

  test('rejects path traversal attempt in repo (@owner/..) with SPEC_SYNTAX', () => {
    const res = parseSpec('@owner/..');
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe('SPEC_SYNTAX');
  });

  test('rejects empty ref after hash (@owner/repo#) with SPEC_SYNTAX', () => {
    const res = parseSpec('@owner/repo#');
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe('SPEC_SYNTAX');
  });

  test('rejects leading slash in ref (@owner/repo#/main) with SPEC_REF', () => {
    const res = parseSpec('@owner/repo#/main');
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe('SPEC_REF');
  });

  test('rejects trailing slash in ref (@owner/repo#main/) with SPEC_REF', () => {
    const res = parseSpec('@owner/repo#main/');
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe('SPEC_REF');
  });

  test('rejects consecutive slashes in ref (@owner/repo#a//b) with SPEC_REF', () => {
    const res = parseSpec('@owner/repo#a//b');
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe('SPEC_REF');
  });

  test('rejects traversal segment ".." in ref (@owner/repo#../../etc) with SPEC_REF', () => {
    const res = parseSpec('@owner/repo#../../etc');
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe('SPEC_REF');
  });

  test('rejects traversal segment ".." mid-ref (@owner/repo#a/../b) with SPEC_REF', () => {
    const res = parseSpec('@owner/repo#a/../b');
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe('SPEC_REF');
  });

  test('rejects segment "." in ref (@owner/repo#.) with SPEC_REF', () => {
    const res = parseSpec('@owner/repo#.');
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe('SPEC_REF');
  });

  test('rejects segment "." mid-ref (@owner/repo#a/./b) with SPEC_REF', () => {
    const res = parseSpec('@owner/repo#a/./b');
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe('SPEC_REF');
  });

  test('rejects illegal characters in owner with SPEC_SYNTAX', () => {
    const res = parseSpec('@bad$owner/repo');
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe('SPEC_SYNTAX');
  });

  test('rejects illegal characters in repo with SPEC_SYNTAX', () => {
    const res = parseSpec('@owner/repo$name');
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe('SPEC_SYNTAX');
  });
});

describe('Module Store: cacheRoot & entryDir', () => {
  test('cacheRoot uses LMCTL_HOME when present', () => {
    const root = cacheRoot({ LMCTL_HOME: '/custom/lmctl' });
    expect(root).toBe('/custom/lmctl/modules');
  });

  test('cacheRoot uses HOME/.lmctl/modules when LMCTL_HOME is unset', () => {
    const root = cacheRoot({ HOME: '/home/testuser' });
    expect(root).toBe('/home/testuser/.lmctl/modules');
  });

  test('cacheRoot uses HOME/.lmctl/modules when LMCTL_HOME is empty string', () => {
    const root = cacheRoot({ LMCTL_HOME: '', HOME: '/home/testuser' });
    expect(root).toBe('/home/testuser/.lmctl/modules');
  });

  test('entryDir formats root/github.com/<owner>/<repo>/<encodedRef>', () => {
    const spec = mustParse('@owner/repo#feature/v1');
    const dir = entryDir('/cache/root', spec);
    expect(dir).toBe('/cache/root/github.com/owner/repo/feature%2Fv1');
  });

  test('entryDir uses HEAD when ref is omitted', () => {
    const spec = mustParse('@owner/repo');
    const dir = entryDir('/cache/root', spec);
    expect(dir).toBe('/cache/root/github.com/owner/repo/HEAD');
  });

  test('entryDir containment check verifies path does not escape root', () => {
    const spec = mustParse('@owner/repo');
    const dir = entryDir('/tmp/test-modules', spec);
    expect(dir.startsWith('/tmp/test-modules')).toBe(true);
  });
});

describe('Module Store: resolveCached', () => {
  let tempRoot: string;

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'lmts-test-cache-'));
  });

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  test('returns NOT_INSTALLED when entry directory does not exist', async () => {
    const res = await resolveCached('@owner/repo', { root: tempRoot });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe('NOT_INSTALLED');
  });

  test('returns NOT_INSTALLED when cli.schema.v1.json is missing', async () => {
    const spec = mustParse('@owner/repo');
    const dir = entryDir(tempRoot, spec);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'meta.json'), JSON.stringify({ sha256: 'abc' }));

    const res = await resolveCached(spec, { root: tempRoot });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe('NOT_INSTALLED');
  });

  test('returns NOT_INSTALLED when meta.json is missing', async () => {
    const spec = mustParse('@owner/repo');
    const dir = entryDir(tempRoot, spec);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'cli.schema.v1.json'), JSON.stringify(VALID_SCHEMA_V1));

    const res = await resolveCached(spec, { root: tempRoot });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe('NOT_INSTALLED');
  });

  test('returns CachedModule on valid cached entry with verified hash', async () => {
    const spec = mustParse('@owner/repo');
    const dir = entryDir(tempRoot, spec);
    mkdirSync(dir, { recursive: true });

    const schemaStr = JSON.stringify(VALID_SCHEMA_V1, null, 2);
    const sha = createHash('sha256').update(schemaStr).digest('hex');

    writeFileSync(join(dir, 'cli.schema.v1.json'), schemaStr);
    writeFileSync(
      join(dir, 'meta.json'),
      JSON.stringify({
        spec: '@owner/repo',
        url: 'https://raw.githubusercontent.com/owner/repo/HEAD/cli.schema.v1.json',
        sha256: sha,
        fetched_at: '2026-10-10T12:00:00Z',
        tool: 'mytool',
        version: '1.0.0',
        bytes: schemaStr.length,
      }),
    );

    const res = await resolveCached(spec, { root: tempRoot });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.sha256).toBe(sha);
    expect(res.value.tool).toBe('mytool');
    expect(res.value.version).toBe('1.0.0');
    expect(res.value.document.tool).toBe('mytool');
    expect(res.value.path).toBe(join(dir, 'cli.schema.v1.json'));
  });

  test('tamper detection: returns CACHE_CORRUPT naming file when sha mismatch', async () => {
    const spec = mustParse('@owner/repo');
    const dir = entryDir(tempRoot, spec);
    mkdirSync(dir, { recursive: true });

    const schemaStr = JSON.stringify(VALID_SCHEMA_V1);
    writeFileSync(join(dir, 'cli.schema.v1.json'), schemaStr + ' // tampered');
    writeFileSync(
      join(dir, 'meta.json'),
      JSON.stringify({
        spec: '@owner/repo',
        sha256: 'original-sha',
        fetched_at: '2026-10-10T12:00:00Z',
      }),
    );

    const res = await resolveCached(spec, { root: tempRoot });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe('CACHE_CORRUPT');
    expect(res.file).toBe(join(dir, 'cli.schema.v1.json'));
  });

  test('returns BAD_JSON when cached schema file contains invalid JSON', async () => {
    const spec = mustParse('@owner/repo');
    const dir = entryDir(tempRoot, spec);
    mkdirSync(dir, { recursive: true });

    const corruptedStr = 'not json';
    const sha = createHash('sha256').update(corruptedStr).digest('hex');
    writeFileSync(join(dir, 'cli.schema.v1.json'), corruptedStr);
    writeFileSync(
      join(dir, 'meta.json'),
      JSON.stringify({ spec: '@owner/repo', sha256: sha, fetched_at: '2026-10-10T12:00:00Z' }),
    );

    const res = await resolveCached(spec, { root: tempRoot });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe('BAD_JSON');
  });

  test('returns INVALID_SCHEMA when cached document fails schema validation', async () => {
    const spec = mustParse('@owner/repo');
    const dir = entryDir(tempRoot, spec);
    mkdirSync(dir, { recursive: true });

    const invalidDoc = { ...VALID_SCHEMA_V1, tool: 'INVALID_TOOL_NAME' };
    const invalidStr = JSON.stringify(invalidDoc);
    const sha = createHash('sha256').update(invalidStr).digest('hex');

    writeFileSync(join(dir, 'cli.schema.v1.json'), invalidStr);
    writeFileSync(
      join(dir, 'meta.json'),
      JSON.stringify({ spec: '@owner/repo', sha256: sha, fetched_at: '2026-10-10T12:00:00Z' }),
    );

    const res = await resolveCached(spec, { root: tempRoot });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe('INVALID_SCHEMA');
  });
});

describe('Module Store: install', () => {
  let tempRoot: string;

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'lmts-test-install-'));
  });

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  test('happy path: installs valid schema with correct directory and file permissions', async () => {
    const specStr = '@lmctl-ai/mytool#v1.0.0';
    const fetchImpl = createMockFetch(() => {
      return new Response(JSON.stringify(VALID_SCHEMA_V1, null, 2), { status: 200 });
    });

    const fixedDate = new Date('2026-10-10T10:00:00.000Z');
    const res = await install(specStr, {
      root: tempRoot,
      fetchImpl,
      now: () => fixedDate,
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.action).toBe('installed');
    expect(res.value.entry.tool).toBe('mytool');
    expect(res.value.entry.fetchedAt).toBe(fixedDate.toISOString());

    const dir = res.value.entry.dir;
    expect(existsSync(join(dir, 'cli.schema.v1.json'))).toBe(true);
    expect(existsSync(join(dir, 'meta.json'))).toBe(true);

    // Verify permissions on POSIX
    if (process.platform !== 'win32') {
      const dirStat = statSync(dir);
      expect(dirStat.mode & 0o777).toBe(0o700);

      const fileStat = statSync(join(dir, 'cli.schema.v1.json'));
      expect(fileStat.mode & 0o777).toBe(0o600);
    }
  });

  test('idempotent: repeated install returns action "unchanged" without re-fetching', async () => {
    let fetchCount = 0;
    const fetchImpl = createMockFetch(() => {
      fetchCount++;
      return new Response(JSON.stringify(VALID_SCHEMA_V1), { status: 200 });
    });

    const first = await install('@owner/repo', { root: tempRoot, fetchImpl });
    expect(first.ok).toBe(true);
    expect(fetchCount).toBe(1);

    const second = await install('@owner/repo', { root: tempRoot, fetchImpl });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.action).toBe('unchanged');
    expect(fetchCount).toBe(1); // fetchImpl not invoked on second call
  });

  test('force: true forces re-fetch and updates entry', async () => {
    let fetchCount = 0;
    const fetchImpl = createMockFetch(() => {
      fetchCount++;
      return new Response(JSON.stringify(VALID_SCHEMA_V1), { status: 200 });
    });

    await install('@owner/repo', { root: tempRoot, fetchImpl });
    expect(fetchCount).toBe(1);

    const res = await install('@owner/repo', { root: tempRoot, fetchImpl, force: true });
    expect(res.ok).toBe(true);
    expect(fetchCount).toBe(2);
  });

  test('404 response returns FETCH_FAILED naming expected path cli.schema.v1.json', async () => {
    const fetchImpl = createMockFetch(() => {
      return new Response('Not Found', { status: 404, statusText: 'Not Found' });
    });

    const res = await install('@owner/repo', { root: tempRoot, fetchImpl });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe('FETCH_FAILED');
    expect(res.message).toContain('expected cli.schema.v1.json at repository root');
  });

  test('404 response leaves an existing good entry untouched', async () => {
    const goodFetch = createMockFetch(() => new Response(JSON.stringify(VALID_SCHEMA_V1)));
    await install('@owner/repo', { root: tempRoot, fetchImpl: goodFetch });

    const notFoundFetch = createMockFetch(() => new Response('Not Found', { status: 404 }));
    const failRes = await install('@owner/repo', { root: tempRoot, fetchImpl: notFoundFetch, force: true });
    expect(failRes.ok).toBe(false);

    // Existing entry must still be intact
    const cached = await resolveCached('@owner/repo', { root: tempRoot });
    expect(cached.ok).toBe(true);
    if (!cached.ok) return;
    expect(cached.value.tool).toBe('mytool');
  });

  test('500 server error returns FETCH_FAILED and leaves existing entry untouched', async () => {
    const goodFetch = createMockFetch(() => new Response(JSON.stringify(VALID_SCHEMA_V1)));
    await install('@owner/repo', { root: tempRoot, fetchImpl: goodFetch });

    const errFetch = createMockFetch(() => new Response('Server Error', { status: 500 }));
    const res = await install('@owner/repo', { root: tempRoot, fetchImpl: errFetch, force: true });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe('FETCH_FAILED');

    const cached = await resolveCached('@owner/repo', { root: tempRoot });
    expect(cached.ok).toBe(true);
  });

  test('timeout returns FETCH_FAILED and leaves existing entry untouched', async () => {
    const goodFetch = createMockFetch(() => new Response(JSON.stringify(VALID_SCHEMA_V1)));
    await install('@owner/repo', { root: tempRoot, fetchImpl: goodFetch });

    const timeoutFetch = createMockFetch(async () => {
      const err = new Error('The operation was aborted');
      err.name = 'TimeoutError';
      throw err;
    });

    const res = await install('@owner/repo', { root: tempRoot, fetchImpl: timeoutFetch, timeoutMs: 50, force: true });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe('FETCH_FAILED');

    const cached = await resolveCached('@owner/repo', { root: tempRoot });
    expect(cached.ok).toBe(true);
  });

  test('oversized payload returns OUTPUT_LIMIT and leaves existing entry untouched', async () => {
    const goodFetch = createMockFetch(() => new Response(JSON.stringify(VALID_SCHEMA_V1)));
    await install('@owner/repo', { root: tempRoot, fetchImpl: goodFetch });

    const bigPayload = 'x'.repeat(2000);
    const bigFetch = createMockFetch(() => new Response(bigPayload));

    const res = await install('@owner/repo', { root: tempRoot, fetchImpl: bigFetch, maxBytes: 500, force: true });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe('OUTPUT_LIMIT');

    const cached = await resolveCached('@owner/repo', { root: tempRoot });
    expect(cached.ok).toBe(true);
  });

  test('bad JSON response returns BAD_JSON and leaves existing entry untouched', async () => {
    const goodFetch = createMockFetch(() => new Response(JSON.stringify(VALID_SCHEMA_V1)));
    await install('@owner/repo', { root: tempRoot, fetchImpl: goodFetch });

    const badJsonFetch = createMockFetch(() => new Response('<html>Error</html>'));
    const res = await install('@owner/repo', { root: tempRoot, fetchImpl: badJsonFetch, force: true });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe('BAD_JSON');

    const cached = await resolveCached('@owner/repo', { root: tempRoot });
    expect(cached.ok).toBe(true);
  });

  test('invalid schema returns INVALID_SCHEMA with first issue and leaves existing untouched', async () => {
    const goodFetch = createMockFetch(() => new Response(JSON.stringify(VALID_SCHEMA_V1)));
    await install('@owner/repo', { root: tempRoot, fetchImpl: goodFetch });

    const invalidSchemaFetch = createMockFetch(() => {
      return new Response(JSON.stringify({ schema: 'cli.schema.v1', tool: 'INVALID_TOOL' }));
    });

    const res = await install('@owner/repo', { root: tempRoot, fetchImpl: invalidSchemaFetch, force: true });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe('INVALID_SCHEMA');
    expect(res.issues).toBeDefined();

    const cached = await resolveCached('@owner/repo', { root: tempRoot });
    expect(cached.ok).toBe(true);
  });

  test('cross-host redirect is refused with FETCH_FAILED', async () => {
    const redirectFetch = createMockFetch((url) => {
      if (url.includes('raw.githubusercontent.com')) {
        return new Response(null, {
          status: 302,
          headers: { location: 'https://evil-host.com/schema.json' },
        });
      }
      return new Response(JSON.stringify(VALID_SCHEMA_V1));
    });

    const res = await install('@owner/repo', { root: tempRoot, fetchImpl: redirectFetch });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe('FETCH_FAILED');
    expect(res.message).toContain('refused');
  });

  test('same-host HTTPS redirect to raw.githubusercontent.com is accepted', async () => {
    let redirectsFollowed = 0;
    const sameHostRedirectFetch = createMockFetch((url) => {
      if (url.includes('HEAD')) {
        redirectsFollowed++;
        return new Response(null, {
          status: 302,
          headers: {
            location: 'https://raw.githubusercontent.com/owner/repo/main/cli.schema.v1.json',
          },
        });
      }
      return new Response(JSON.stringify(VALID_SCHEMA_V1));
    });

    const res = await install('@owner/repo', { root: tempRoot, fetchImpl: sameHostRedirectFetch });
    expect(res.ok).toBe(true);
    expect(redirectsFollowed).toBe(1);
  });

  test('concurrent installs of the same spec succeed without corrupting entry', async () => {
    const fetchImpl = createMockFetch(() => new Response(JSON.stringify(VALID_SCHEMA_V1)));

    const [r1, r2, r3] = await Promise.all([
      install('@owner/repo', { root: tempRoot, fetchImpl }),
      install('@owner/repo', { root: tempRoot, fetchImpl }),
      install('@owner/repo', { root: tempRoot, fetchImpl }),
    ]);

    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    expect(r3.ok).toBe(true);

    const verified = await resolveCached('@owner/repo', { root: tempRoot });
    expect(verified.ok).toBe(true);
  });
});

describe('Module Store: list', () => {
  let tempRoot: string;

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'lmts-test-list-'));
  });

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  test('returns empty array when cache root is empty', async () => {
    const entries = await list({ root: tempRoot });
    expect(entries).toEqual([]);
  });

  test('lists installed entries with spec, tool, version, sha256, dir', async () => {
    const fetchImpl = createMockFetch(() => new Response(JSON.stringify(VALID_SCHEMA_V1)));
    await install('@owner/repo1#v1.0.0', { root: tempRoot, fetchImpl });
    await install('@owner/repo2', { root: tempRoot, fetchImpl });

    const entries = await list({ root: tempRoot });
    expect(entries.length).toBe(2);
    expect(entries[0]!.spec).toBe('@owner/repo1#v1.0.0');
    expect(entries[0]!.tool).toBe('mytool');
    expect(entries[0]!.version).toBe('1.0.0');
    expect(entries[0]!.immutable).toBe(true);

    expect(entries[1]!.spec).toBe('@owner/repo2');
    expect(entries[1]!.immutable).toBe(false);
  });

  test('reports corrupt entry directory as a problem row', async () => {
    const fetchImpl = createMockFetch(() => new Response(JSON.stringify(VALID_SCHEMA_V1)));
    await install('@owner/good', { root: tempRoot, fetchImpl });

    // Manually create a corrupt entry directory missing meta.json
    const corruptDir = join(tempRoot, 'github.com', 'owner', 'bad', 'HEAD');
    mkdirSync(corruptDir, { recursive: true });
    writeFileSync(join(corruptDir, 'cli.schema.v1.json'), '{}');

    const entries = await list({ root: tempRoot });
    expect(entries.length).toBe(2);

    const badEntry = entries.find((e) => e.spec === '@owner/bad');
    expect(badEntry).toBeDefined();
    expect(badEntry?.problem).toBeDefined();
  });

  test('reports checksum mismatch in entry directory as a problem row', async () => {
    const fetchImpl = createMockFetch(() => new Response(JSON.stringify(VALID_SCHEMA_V1)));
    await install('@owner/tampered', { root: tempRoot, fetchImpl });

    const entry = mustResolve(await resolveCached('@owner/tampered', { root: tempRoot }));
    writeFileSync(entry.path, 'tampered content');

    const entries = await list({ root: tempRoot });
    const tampered = entries.find((e) => e.spec === '@owner/tampered');
    expect(tampered).toBeDefined();
    expect(tampered?.problem).toContain('Checksum mismatch');
  });
});

describe('Module Store: upgrade', () => {
  let tempRoot: string;

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'lmts-test-upgrade-'));
  });

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  test('moving ref with identical sha reports action "unchanged"', async () => {
    const fetchImpl = createMockFetch(() => new Response(JSON.stringify(VALID_SCHEMA_V1)));
    await install('@owner/moving', { root: tempRoot, fetchImpl });

    const outcomes = await upgrade('@owner/moving', { root: tempRoot, fetchImpl });
    expect(outcomes.length).toBe(1);
    expect(outcomes[0]!.action).toBe('unchanged');
  });

  test('moving ref with different sha replaces entry and reports operations added and removed', async () => {
    let version = 1;
    const fetchImpl = createMockFetch(() => {
      const doc = version === 1 ? VALID_SCHEMA_V1 : VALID_SCHEMA_V2;
      return new Response(JSON.stringify(doc));
    });

    await install('@owner/moving', { root: tempRoot, fetchImpl });
    version = 2;

    const outcomes = await upgrade('@owner/moving', { root: tempRoot, fetchImpl });
    expect(outcomes.length).toBe(1);
    const out = outcomes[0]!;
    expect(out.action).toBe('updated');
    if (out.action !== 'updated') return;
    expect(out.fromVersion).toBe('1.0.0');
    expect(out.toVersion).toBe('2.0.0');
    expect(out.operationsAdded).toEqual(['batch']);
    expect(out.operationsRemoved).toEqual(['apply']);

    // Cache now holds v2
    const updated = mustResolve(await resolveCached('@owner/moving', { root: tempRoot }));
    expect(updated.version).toBe('2.0.0');
  });

  test('immutable ref is skipped with reason "immutable"', async () => {
    const fetchImpl = createMockFetch(() => new Response(JSON.stringify(VALID_SCHEMA_V1)));
    await install('@owner/immutable#v1.0.0', { root: tempRoot, fetchImpl });

    const outcomes = await upgrade('@owner/immutable#v1.0.0', { root: tempRoot, fetchImpl });
    expect(outcomes.length).toBe(1);
    expect(outcomes[0]!.action).toBe('skipped');
    if (outcomes[0]!.action !== 'skipped') return;
    expect(outcomes[0]!.reason).toBe('immutable');
  });

  test('immutable ref with option "to" installs new ref while preserving old ref', async () => {
    const fetchImpl = createMockFetch((url) => {
      if (url.includes('v2.0.0')) {
        return new Response(JSON.stringify(VALID_SCHEMA_V2));
      }
      return new Response(JSON.stringify(VALID_SCHEMA_V1));
    });

    await install('@owner/repo#v1.0.0', { root: tempRoot, fetchImpl });

    const outcomes = await upgrade('@owner/repo#v1.0.0', { root: tempRoot, fetchImpl, to: 'v2.0.0' });
    expect(outcomes.length).toBe(1);
    expect(outcomes[0]!.action).toBe('installed');

    // Both refs exist now
    const oldRef = await resolveCached('@owner/repo#v1.0.0', { root: tempRoot });
    expect(oldRef.ok).toBe(true);

    const newRef = await resolveCached('@owner/repo#v2.0.0', { root: tempRoot });
    expect(newRef.ok).toBe(true);
  });

  test('upgrade with no arguments upgrades all installed moving modules', async () => {
    const fetchImpl = createMockFetch(() => new Response(JSON.stringify(VALID_SCHEMA_V1)));
    await install('@owner/m1', { root: tempRoot, fetchImpl });
    await install('@owner/m2', { root: tempRoot, fetchImpl });
    await install('@owner/tag#v1.0.0', { root: tempRoot, fetchImpl });

    const outcomes = await upgrade(undefined, { root: tempRoot, fetchImpl });
    expect(outcomes.length).toBe(3);

    const m1 = outcomes.find((o) => o.spec === '@owner/m1');
    expect(m1?.action).toBe('unchanged');

    const tag = outcomes.find((o) => o.spec === '@owner/tag#v1.0.0');
    expect(tag?.action).toBe('skipped');
  });

  test('partial failure in upgrade does not prevent other modules from upgrading', async () => {
    const fetchImpl = createMockFetch((url) => {
      if (url.includes('failing')) {
        return new Response('Server Error', { status: 500 });
      }
      return new Response(JSON.stringify(VALID_SCHEMA_V1));
    });

    const staticFetch = createMockFetch(() => new Response(JSON.stringify(VALID_SCHEMA_V1)));
    await install('@owner/ok', { root: tempRoot, fetchImpl: staticFetch });
    await install('@owner/failing', { root: tempRoot, fetchImpl: staticFetch });

    const outcomes = await upgrade(['@owner/ok', '@owner/failing'], { root: tempRoot, fetchImpl });
    expect(outcomes.length).toBe(2);

    const okOut = outcomes.find((o) => o.spec === '@owner/ok');
    expect(okOut?.action).toBe('unchanged');

    const failOut = outcomes.find((o) => o.spec === '@owner/failing');
    expect(failOut?.action).toBe('failed');
  });
});

describe('Module Store: remove', () => {
  let tempRoot: string;

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'lmts-test-remove-'));
  });

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  test('removes single entry directory and prunes empty parents', async () => {
    const fetchImpl = createMockFetch(() => new Response(JSON.stringify(VALID_SCHEMA_V1)));
    await install('@owner/repo#v1.0.0', { root: tempRoot, fetchImpl });

    const rem = await remove('@owner/repo#v1.0.0', { root: tempRoot });
    expect(rem.ok).toBe(true);

    const cached = await resolveCached('@owner/repo#v1.0.0', { root: tempRoot });
    expect(cached.ok).toBe(false);

    // Parent directories should be pruned up to github.com
    expect(existsSync(join(tempRoot, 'github.com', 'owner', 'repo'))).toBe(false);
  });

  test('removes all refs for owner/repo with allRefs: true', async () => {
    const fetchImpl = createMockFetch(() => new Response(JSON.stringify(VALID_SCHEMA_V1)));
    await install('@owner/repo#v1.0.0', { root: tempRoot, fetchImpl });
    await install('@owner/repo#v2.0.0', { root: tempRoot, fetchImpl });
    await install('@owner/repo#main', { root: tempRoot, fetchImpl });

    const rem = await remove('@owner/repo', { root: tempRoot, allRefs: true });
    expect(rem.ok).toBe(true);

    expect(existsSync(join(tempRoot, 'github.com', 'owner', 'repo'))).toBe(false);
  });

  test('returns NOT_INSTALLED when removing non-existent module', async () => {
    const rem = await remove('@owner/nonexistent', { root: tempRoot });
    expect(rem.ok).toBe(false);
    if (rem.ok) return;
    expect(rem.code).toBe('NOT_INSTALLED');
  });

  test('returns NOT_INSTALLED when allRefs: true on non-existent module', async () => {
    const rem = await remove('@owner/nonexistent', { root: tempRoot, allRefs: true });
    expect(rem.ok).toBe(false);
    if (rem.ok) return;
    expect(rem.code).toBe('NOT_INSTALLED');
  });
});

describe('Module Store: findOnPath', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'lmts-test-path-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test('finds executable in absolute PATH directory', () => {
    const binPath = join(tempDir, 'mytool');
    writeFileSync(binPath, '#!/bin/sh\necho ok\n');
    chmodSync(binPath, 0o755);

    const found = findOnPath('mytool', tempDir);
    expect(found).toBe(binPath);
  });

  test('ignores relative PATH entries', () => {
    const binPath = join(tempDir, 'mytool');
    writeFileSync(binPath, '#!/bin/sh\necho ok\n');
    chmodSync(binPath, 0o755);

    const found = findOnPath('mytool', './relative-dir:bin');
    expect(found).toBeUndefined();
  });

  test('ignores empty PATH entries (e.g. ::)', () => {
    const found = findOnPath('mytool', '::');
    expect(found).toBeUndefined();
  });

  test('ignores regular non-executable files', () => {
    if (process.platform === 'win32') return;

    const binPath = join(tempDir, 'nonexec');
    writeFileSync(binPath, 'text file');
    chmodSync(binPath, 0o644);

    const found = findOnPath('nonexec', tempDir);
    expect(found).toBeUndefined();
  });

  test('returns undefined when binary does not exist on PATH', () => {
    const found = findOnPath('missingtool', tempDir);
    expect(found).toBeUndefined();
  });

  test('refuses tool names with uppercase characters', () => {
    const found = findOnPath('MyTool', tempDir);
    expect(found).toBeUndefined();
  });

  test('refuses tool names with punctuation / command injection attempts', () => {
    const found = findOnPath('tool;rm', tempDir);
    expect(found).toBeUndefined();
  });
});

describe('Module Store: edge cases and failure paths', () => {
  let tempRoot: string;

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'lmts-test-edge-'));
  });

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  test('parseSpec detects invalid ref characters and returns SPEC_REF', () => {
    const res = parseSpec('@owner/repo#invalid!ref');
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe('SPEC_REF');
  });

  test('parseSpec rejects dot segments in owner or repo', () => {
    const r1 = parseSpec('@./repo');
    expect(r1.ok).toBe(false);
    expect((r1 as any).code).toBe('SPEC_SYNTAX');

    const r2 = parseSpec('@owner/.');
    expect(r2.ok).toBe(false);
    expect((r2 as any).code).toBe('SPEC_SYNTAX');
  });

  test('entryDir throws on traversal spec', () => {
    const maliciousSpec: ModuleSpec = {
      owner: '..',
      repo: 'escaped',
      refOrHead: 'HEAD',
      key: '@../escaped',
      immutable: false,
    };
    expect(() => entryDir(tempRoot, maliciousSpec)).toThrow('Path traversal detected');
  });

  test('resolveCached returns PATH_TRAVERSAL when entryDir escapes root', async () => {
    const maliciousSpec: ModuleSpec = {
      owner: '..',
      repo: 'escaped',
      refOrHead: 'HEAD',
      key: '@../escaped',
      immutable: false,
    };
    const res = await resolveCached(maliciousSpec, { root: tempRoot });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe('PATH_TRAVERSAL');
  });

  test('install returns PATH_TRAVERSAL when entryDir escapes root', async () => {
    const maliciousSpec: ModuleSpec = {
      owner: '..',
      repo: 'escaped',
      refOrHead: 'HEAD',
      key: '@../escaped',
      immutable: false,
    };
    const res = await install(maliciousSpec, { root: tempRoot });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe('PATH_TRAVERSAL');
  });

  test('install returns FETCH_FAILED on generic network throw', async () => {
    const fetchImpl = createMockFetch(() => {
      throw new Error('Connection refused');
    });
    const res = await install('@owner/repo', { root: tempRoot, fetchImpl });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe('FETCH_FAILED');
    expect(res.message).toContain('Connection refused');
  });

  test('install returns FETCH_FAILED on redirect missing location header', async () => {
    const fetchImpl = createMockFetch(() => {
      return new Response(null, { status: 301 });
    });
    const res = await install('@owner/repo', { root: tempRoot, fetchImpl });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe('FETCH_FAILED');
    expect(res.message).toContain('Location header');
  });

  test('install with force: true replaces entry even if identical sha', async () => {
    const fetchImpl = createMockFetch(() => new Response(JSON.stringify(VALID_SCHEMA_V1)));
    await install('@owner/repo', { root: tempRoot, fetchImpl });

    const res = await install('@owner/repo', { root: tempRoot, fetchImpl, force: true });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.action).toBe('replaced');
  });

  test('upgrade returns failed when spec has invalid syntax', async () => {
    const outcomes = await upgrade('invalid-spec-without-at', { root: tempRoot });
    expect(outcomes.length).toBe(1);
    expect(outcomes[0]!.action).toBe('failed');
  });

  test('upgrade returns failed when moving ref is not installed in cache', async () => {
    const outcomes = await upgrade('@owner/not-installed', { root: tempRoot });
    expect(outcomes.length).toBe(1);
    expect(outcomes[0]!.action).toBe('failed');
  });

  test('upgrade returns failed when moving ref re-fetch fails', async () => {
    const goodFetch = createMockFetch(() => new Response(JSON.stringify(VALID_SCHEMA_V1)));
    await install('@owner/moving', { root: tempRoot, fetchImpl: goodFetch });

    const brokenFetch = createMockFetch(() => new Response('500 Internal Error', { status: 500 }));
    const outcomes = await upgrade('@owner/moving', { root: tempRoot, fetchImpl: brokenFetch });
    expect(outcomes.length).toBe(1);
    expect(outcomes[0]!.action).toBe('failed');
  });

  test('upgrade with --to returns failed when ref has invalid syntax', async () => {
    const goodFetch = createMockFetch(() => new Response(JSON.stringify(VALID_SCHEMA_V1)));
    await install('@owner/repo#v1.0.0', { root: tempRoot, fetchImpl: goodFetch });

    const outcomes = await upgrade('@owner/repo#v1.0.0', { root: tempRoot, fetchImpl: goodFetch, to: 'bad//ref' });
    expect(outcomes.length).toBe(1);
    expect(outcomes[0]!.action).toBe('failed');
  });

  test('upgrade with --to returns failed when fetch of new ref fails', async () => {
    const goodFetch = createMockFetch(() => new Response(JSON.stringify(VALID_SCHEMA_V1)));
    await install('@owner/repo#v1.0.0', { root: tempRoot, fetchImpl: goodFetch });

    const failFetch = createMockFetch(() => new Response('Not Found', { status: 404 }));
    const outcomes = await upgrade('@owner/repo#v1.0.0', { root: tempRoot, fetchImpl: failFetch, to: 'v2.0.0' });
    expect(outcomes.length).toBe(1);
    expect(outcomes[0]!.action).toBe('failed');
  });

  test('remove returns PATH_TRAVERSAL when spec escapes root', async () => {
    const maliciousSpec: ModuleSpec = {
      owner: '..',
      repo: 'escaped',
      refOrHead: 'HEAD',
      key: '@../escaped',
      immutable: false,
    };
    const res = await remove(maliciousSpec, { root: tempRoot });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe('PATH_TRAVERSAL');

    const resAll = await remove(maliciousSpec, { root: tempRoot, allRefs: true });
    expect(resAll.ok).toBe(false);
    if (resAll.ok) return;
    expect(resAll.code).toBe('PATH_TRAVERSAL');
  });

  test('list ignores non-directory files inside github.com tree', async () => {
    const ghDir = join(tempRoot, 'github.com');
    mkdirSync(ghDir, { recursive: true });
    writeFileSync(join(ghDir, 'stray-file.txt'), 'hello');

    const ownerDir = join(ghDir, 'owner');
    mkdirSync(ownerDir, { recursive: true });
    writeFileSync(join(ownerDir, 'stray-file-2.txt'), 'hello');

    const entries = await list({ root: tempRoot });
    expect(entries).toEqual([]);
  });
});
