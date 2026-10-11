/**
 * @fileoverview Hermetic test suite for ensure() in @lmctl-ai/lmts/modules.
 * Tests evergreen module refresh semantics, TTL checks, conditional GET with If-None-Match,
 * 304 freshness updates, 200 atomic replacements, fallback to stale-cache on all failures,
 * atomicity, concurrency, and security invariants.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, promises as fs } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  ensure,
  entryDir,
  install,
  parseSpec,
  resolveCached,
  upgrade,
  type CachedModule,
  type EnsureOutcome,
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
      name: 'status',
      access: 'read',
      description: 'Check status',
      params: [],
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
      name: 'status',
      access: 'read',
      description: 'Check status',
      params: [],
    },
    {
      name: 'deploy',
      access: 'write',
      description: 'Deploy resource',
      params: [],
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

async function cachedDir(root: string): Promise<string> {
  const cached = await resolveCached('@owner/repo#latest', { root });
  if (!cached.ok) throw new Error(cached.message);
  return dirname(cached.value.path);
}

describe('Module Store: ensure()', () => {
  let tempRoot: string;

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'lmts-ensure-test-'));
  });

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  // 1. Fresh entry makes zero fetch calls
  test('fresh entry (< TTL) makes zero fetch calls and returns source: cache', async () => {
    let fetchCount = 0;
    const fetchImpl = createMockFetch(() => {
      fetchCount++;
      return new Response(JSON.stringify(VALID_SCHEMA_V1), {
        headers: { ETag: '"etag-1"' },
      });
    });

    const t0 = new Date('2026-10-10T10:00:00.000Z');
    const installRes = await install('@owner/repo#latest', {
      root: tempRoot,
      fetchImpl,
      now: () => t0,
    });
    expect(installRes.ok).toBe(true);
    expect(fetchCount).toBe(1);

    // 1 hour later (TTL is 6 hours)
    const t1 = new Date('2026-10-10T11:00:00.000Z');
    const ensureRes = await ensure('@owner/repo#latest', {
      root: tempRoot,
      fetchImpl,
      now: () => t1,
    });

    expect(ensureRes.ok).toBe(true);
    if (!ensureRes.ok) return;
    expect(ensureRes.value.source).toBe('cache');
    expect(ensureRes.value.module.version).toBe('1.0.0');
    expect(fetchCount).toBe(1); // No new network call
  });

  // 2. TTL boundary check
  test('entry exactly at or past TTL is treated as stale and executes conditional GET', async () => {
    let fetchCount = 0;
    const fetchImpl = createMockFetch((url, init) => {
      fetchCount++;
      return new Response(null, { status: 304 });
    });

    const t0 = new Date('2026-10-10T10:00:00.000Z');
    const initialFetch = createMockFetch(() => new Response(JSON.stringify(VALID_SCHEMA_V1), { headers: { ETag: '"e1"' } }));
    await install('@owner/repo#latest', { root: tempRoot, fetchImpl: initialFetch, now: () => t0 });

    // Exactly 6 hours later
    const t1 = new Date('2026-10-10T16:00:00.000Z');
    const res = await ensure('@owner/repo#latest', {
      root: tempRoot,
      fetchImpl,
      now: () => t1,
      ttlMs: 6 * 60 * 60 * 1000,
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(fetchCount).toBe(1);
    expect(res.value.source).toBe('network');
  });

  // 3. Stale + 304 bumps last_checked only
  test('stale entry + 304 bumps last_checked, updates etag, returns source: network, leaves schema untouched', async () => {
    const t0 = new Date('2026-10-10T10:00:00.000Z');
    const initialFetch = createMockFetch(() => new Response(JSON.stringify(VALID_SCHEMA_V1), { headers: { ETag: '"etag-v1"' } }));
    await install('@owner/repo#latest', { root: tempRoot, fetchImpl: initialFetch, now: () => t0 });

    const spec = parseSpec('@owner/repo#latest');
    if (!spec.ok) throw new Error('parseSpec failed');
    const dir = await cachedDir(tempRoot);
    const schemaPath = join(dir, 'cli.schema.latest.json');
    const schemaBytesBefore = readFileSync(schemaPath);

    const captured = { sentIfNoneMatch: null as string | null };
    const refreshFetch = createMockFetch((url, init) => {
      captured.sentIfNoneMatch = (init?.headers as any)?.['If-None-Match'] ?? null;
      return new Response(null, {
        status: 304,
        headers: { ETag: '"etag-v1-refreshed"' },
      });
    });

    // 7 hours later
    const t1 = new Date('2026-10-10T17:00:00.000Z');
    const res = await ensure('@owner/repo#latest', {
      root: tempRoot,
      fetchImpl: refreshFetch,
      now: () => t1,
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.source).toBe('network');
    expect(captured.sentIfNoneMatch).toBe('"etag-v1"');
    expect(res.value.module.lastChecked).toBe(t1.toISOString());
    expect(res.value.module.etag).toBe('"etag-v1-refreshed"');

    // Schema file must be byte-identical
    const schemaBytesAfter = readFileSync(schemaPath);
    expect(schemaBytesAfter).toEqual(schemaBytesBefore);

    // Meta file has updated last_checked
    const metaText = readFileSync(join(dirname(res.value.module.path), 'meta.json'), 'utf-8');
    const parsedMeta = JSON.parse(metaText);
    expect(parsedMeta.last_checked).toBe(t1.toISOString());
    expect(parsedMeta.etag).toBe('"etag-v1-refreshed"');
  });

  // 4. Stale + 200 replaces document
  test('stale entry + 200 replaces entry atomically and returns source: network with new document', async () => {
    const t0 = new Date('2026-10-10T10:00:00.000Z');
    const initialFetch = createMockFetch(() => new Response(JSON.stringify(VALID_SCHEMA_V1), { headers: { ETag: '"etag-v1"' } }));
    await install('@owner/repo#latest', { root: tempRoot, fetchImpl: initialFetch, now: () => t0 });

    const refreshFetch = createMockFetch(() => {
      return new Response(JSON.stringify(VALID_SCHEMA_V2), {
        status: 200,
        headers: { ETag: '"etag-v2"' },
      });
    });

    const t1 = new Date('2026-10-10T18:00:00.000Z');
    const res = await ensure('@owner/repo#latest', {
      root: tempRoot,
      fetchImpl: refreshFetch,
      now: () => t1,
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.source).toBe('network');
    expect(res.value.module.version).toBe('2.0.0');
    expect(res.value.module.etag).toBe('"etag-v2"');
    expect(res.value.module.lastChecked).toBe(t1.toISOString());
    expect(res.value.module.document.operations.map((o) => o.name)).toContain('deploy');

    // Verified in cache
    const cached = await resolveCached('@owner/repo#latest', { root: tempRoot });
    expect(cached.ok).toBe(true);
    if (!cached.ok) return;
    expect(cached.value.version).toBe('2.0.0');
    expect(cached.value.etag).toBe('"etag-v2"');
  });

  // 5. Stale + network error (offline) -> stale-cache fallback
  test('stale entry + network error falls back to source: stale-cache with warning and leaves files untouched', async () => {
    const t0 = new Date('2026-10-10T10:00:00.000Z');
    const initialFetch = createMockFetch(() => new Response(JSON.stringify(VALID_SCHEMA_V1)));
    await install('@owner/repo#latest', { root: tempRoot, fetchImpl: initialFetch, now: () => t0 });

    const spec = parseSpec('@owner/repo#latest');
    if (!spec.ok) throw new Error('parseSpec failed');
    const dir = await cachedDir(tempRoot);
    const schemaPath = join(dir, 'cli.schema.latest.json');
    const metaPath = join(dir, 'meta.json');
    const schemaBefore = readFileSync(schemaPath, 'utf-8');
    const metaBefore = readFileSync(metaPath, 'utf-8');

    const offlineFetch = createMockFetch(() => {
      throw new Error('ENOTFOUND raw.githubusercontent.com');
    });

    const t1 = new Date('2026-10-10T20:00:00.000Z');
    const res = await ensure('@owner/repo#latest', {
      root: tempRoot,
      fetchImpl: offlineFetch,
      now: () => t1,
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.source).toBe('stale-cache');
    expect(res.value.warning).toContain('ENOTFOUND');
    expect(res.value.module.version).toBe('1.0.0');

    // Files are byte-for-byte identical
    expect(readFileSync(schemaPath, 'utf-8')).toBe(schemaBefore);
    expect(readFileSync(metaPath, 'utf-8')).toBe(metaBefore);
  });

  // 6. Stale + timeout -> stale-cache fallback
  test('stale entry + timeout falls back to source: stale-cache with warning', async () => {
    const t0 = new Date('2026-10-10T10:00:00.000Z');
    const initialFetch = createMockFetch(() => new Response(JSON.stringify(VALID_SCHEMA_V1)));
    await install('@owner/repo#latest', { root: tempRoot, fetchImpl: initialFetch, now: () => t0 });

    const timeoutFetch = createMockFetch(async () => {
      const err = new Error('The operation was aborted');
      err.name = 'TimeoutError';
      throw err;
    });

    const t1 = new Date('2026-10-10T20:00:00.000Z');
    const res = await ensure('@owner/repo#latest', {
      root: tempRoot,
      fetchImpl: timeoutFetch,
      timeoutMs: 50,
      now: () => t1,
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.source).toBe('stale-cache');
    expect(res.value.warning).toContain('timed out');
  });

  // 7. Stale + 404 -> stale-cache fallback
  test('stale entry + 404 response falls back to source: stale-cache with warning', async () => {
    const t0 = new Date('2026-10-10T10:00:00.000Z');
    const initialFetch = createMockFetch(() => new Response(JSON.stringify(VALID_SCHEMA_V1)));
    await install('@owner/repo#latest', { root: tempRoot, fetchImpl: initialFetch, now: () => t0 });

    const notFoundFetch = createMockFetch(() => new Response('Not Found', { status: 404, statusText: 'Not Found' }));

    const t1 = new Date('2026-10-10T20:00:00.000Z');
    const res = await ensure('@owner/repo#latest', {
      root: tempRoot,
      fetchImpl: notFoundFetch,
      now: () => t1,
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.source).toBe('stale-cache');
    expect(res.value.warning).toContain('404');
  });

  // 8. Stale + 500 -> stale-cache fallback
  test('stale entry + 500 response falls back to source: stale-cache with warning', async () => {
    const t0 = new Date('2026-10-10T10:00:00.000Z');
    const initialFetch = createMockFetch(() => new Response(JSON.stringify(VALID_SCHEMA_V1)));
    await install('@owner/repo#latest', { root: tempRoot, fetchImpl: initialFetch, now: () => t0 });

    const errorFetch = createMockFetch(() => new Response('Server Error', { status: 500, statusText: 'Internal Error' }));

    const t1 = new Date('2026-10-10T20:00:00.000Z');
    const res = await ensure('@owner/repo#latest', {
      root: tempRoot,
      fetchImpl: errorFetch,
      now: () => t1,
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.source).toBe('stale-cache');
    expect(res.value.warning).toContain('500');
  });

  // 9. Stale + oversized payload -> stale-cache fallback
  test('stale entry + oversized payload falls back to source: stale-cache with warning', async () => {
    const t0 = new Date('2026-10-10T10:00:00.000Z');
    const initialFetch = createMockFetch(() => new Response(JSON.stringify(VALID_SCHEMA_V1)));
    await install('@owner/repo#latest', { root: tempRoot, fetchImpl: initialFetch, now: () => t0 });

    const bigPayload = 'x'.repeat(2000);
    const bigFetch = createMockFetch(() => new Response(bigPayload, { status: 200 }));

    const t1 = new Date('2026-10-10T20:00:00.000Z');
    const res = await ensure('@owner/repo#latest', {
      root: tempRoot,
      fetchImpl: bigFetch,
      maxBytes: 500,
      now: () => t1,
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.source).toBe('stale-cache');
    expect(res.value.warning).toContain('exceeds maximum size');
  });

  // 10. Stale + bad JSON -> stale-cache fallback
  test('stale entry + bad JSON falls back to source: stale-cache with warning', async () => {
    const t0 = new Date('2026-10-10T10:00:00.000Z');
    const initialFetch = createMockFetch(() => new Response(JSON.stringify(VALID_SCHEMA_V1)));
    await install('@owner/repo#latest', { root: tempRoot, fetchImpl: initialFetch, now: () => t0 });

    const badJsonFetch = createMockFetch(() => new Response('<html>Error</html>', { status: 200 }));

    const t1 = new Date('2026-10-10T20:00:00.000Z');
    const res = await ensure('@owner/repo#latest', {
      root: tempRoot,
      fetchImpl: badJsonFetch,
      now: () => t1,
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.source).toBe('stale-cache');
    expect(res.value.warning).toContain('JSON');
  });

  // 11. Stale + invalid schema -> stale-cache fallback
  test('stale entry + invalid schema falls back to source: stale-cache with warning', async () => {
    const t0 = new Date('2026-10-10T10:00:00.000Z');
    const initialFetch = createMockFetch(() => new Response(JSON.stringify(VALID_SCHEMA_V1)));
    await install('@owner/repo#latest', { root: tempRoot, fetchImpl: initialFetch, now: () => t0 });

    const invalidDoc = { ...VALID_SCHEMA_V1, tool: 'INVALID_TOOL_UPPER' };
    const invalidFetch = createMockFetch(() => new Response(JSON.stringify(invalidDoc), { status: 200 }));

    const t1 = new Date('2026-10-10T20:00:00.000Z');
    const res = await ensure('@owner/repo#latest', {
      root: tempRoot,
      fetchImpl: invalidFetch,
      now: () => t1,
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.source).toBe('stale-cache');
    expect(res.value.warning).toBeDefined();
  });

  // 12. Missing etag still works (plain GET)
  test('missing etag sends plain GET without If-None-Match header', async () => {
    const t0 = new Date('2026-10-10T10:00:00.000Z');
    // Response without ETag header
    const initialFetch = createMockFetch(() => new Response(JSON.stringify(VALID_SCHEMA_V1)));
    await install('@owner/repo#latest', { root: tempRoot, fetchImpl: initialFetch, now: () => t0 });

    let sentHeaders: any = null;
    const refreshFetch = createMockFetch((url, init) => {
      sentHeaders = init?.headers;
      return new Response(JSON.stringify(VALID_SCHEMA_V2), { status: 200 });
    });

    const t1 = new Date('2026-10-10T20:00:00.000Z');
    const res = await ensure('@owner/repo#latest', {
      root: tempRoot,
      fetchImpl: refreshFetch,
      now: () => t1,
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.source).toBe('network');
    expect(sentHeaders?.['If-None-Match']).toBeUndefined();
  });

  // 13. If-None-Match sent exactly when etag stored
  test('If-None-Match header is sent exactly when an etag is stored in meta.json', async () => {
    const t0 = new Date('2026-10-10T10:00:00.000Z');
    const initialFetch = createMockFetch(() => new Response(JSON.stringify(VALID_SCHEMA_V1), {
      headers: { ETag: 'W/"exact-etag-123"' },
    }));
    await install('@owner/repo#latest', { root: tempRoot, fetchImpl: initialFetch, now: () => t0 });

    const captured = { sentIfNoneMatch: undefined as string | undefined };
    const refreshFetch = createMockFetch((url, init) => {
      captured.sentIfNoneMatch = (init?.headers as any)?.['If-None-Match'];
      return new Response(null, { status: 304 });
    });

    const t1 = new Date('2026-10-10T20:00:00.000Z');
    await ensure('@owner/repo#latest', {
      root: tempRoot,
      fetchImpl: refreshFetch,
      now: () => t1,
    });

    expect(captured.sentIfNoneMatch).toBe('W/"exact-etag-123"');
  });

  // 14. Future last_checked treated stale
  test('future last_checked is treated as stale and triggers revalidation', async () => {
    const t0 = new Date('2026-10-10T10:00:00.000Z');
    const initialFetch = createMockFetch(() => new Response(JSON.stringify(VALID_SCHEMA_V1)));
    await install('@owner/repo#latest', { root: tempRoot, fetchImpl: initialFetch, now: () => t0 });

    // Manually set last_checked to a future time
    const spec = parseSpec('@owner/repo#latest');
    if (!spec.ok) throw new Error('parseSpec failed');
    const dir = await cachedDir(tempRoot);
    const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf-8'));
    meta.last_checked = '2026-10-10T23:59:59.000Z';
    writeFileSync(join(dir, 'meta.json'), JSON.stringify(meta));

    let fetchCount = 0;
    const refreshFetch = createMockFetch(() => {
      fetchCount++;
      return new Response(null, { status: 304 });
    });

    // Current time is 11:00 (before last_checked)
    const tCurrent = new Date('2026-10-10T11:00:00.000Z');
    const res = await ensure('@owner/repo#latest', {
      root: tempRoot,
      fetchImpl: refreshFetch,
      now: () => tCurrent,
    });

    expect(res.ok).toBe(true);
    expect(fetchCount).toBe(1);
    if (!res.ok) return;
    expect(res.value.source).toBe('network');
  });

  // 15. Missing last_checked treated stale
  test('missing last_checked in meta is treated as stale and triggers revalidation', async () => {
    const t0 = new Date('2026-10-10T10:00:00.000Z');
    const initialFetch = createMockFetch(() => new Response(JSON.stringify(VALID_SCHEMA_V1)));
    await install('@owner/repo#latest', { root: tempRoot, fetchImpl: initialFetch, now: () => t0 });

    const spec = parseSpec('@owner/repo#latest');
    if (!spec.ok) throw new Error('parseSpec failed');
    const dir = await cachedDir(tempRoot);
    const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf-8'));
    delete meta.last_checked;
    delete meta.fetched_at;
    writeFileSync(join(dir, 'meta.json'), JSON.stringify(meta));

    let fetchCount = 0;
    const refreshFetch = createMockFetch(() => {
      fetchCount++;
      return new Response(null, { status: 304 });
    });

    const res = await ensure('@owner/repo#latest', {
      root: tempRoot,
      fetchImpl: refreshFetch,
    });

    expect(res.ok).toBe(true);
    expect(fetchCount).toBe(1);
  });

  // 16. update=false returns source: cache regardless of age
  test('update=false returns source: cache with zero network calls regardless of age', async () => {
    const t0 = new Date('2020-01-01T00:00:00.000Z');
    const initialFetch = createMockFetch(() => new Response(JSON.stringify(VALID_SCHEMA_V1)));
    await install('@owner/repo#latest', { root: tempRoot, fetchImpl: initialFetch, now: () => t0 });

    let fetchCount = 0;
    const refreshFetch = createMockFetch(() => {
      fetchCount++;
      return new Response(null, { status: 304 });
    });

    // 6 years later
    const t1 = new Date('2026-10-10T12:00:00.000Z');
    const res = await ensure('@owner/repo#latest', {
      root: tempRoot,
      fetchImpl: refreshFetch,
      update: false,
      now: () => t1,
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.source).toBe('cache');
    expect(fetchCount).toBe(0);
  });

  // 17. install=true installs when not installed
  test('NOT_INSTALLED and install=true installs the module and returns source: installed', async () => {
    const fetchImpl = createMockFetch(() => new Response(JSON.stringify(VALID_SCHEMA_V1), { headers: { ETag: '"e1"' } }));

    const res = await ensure('@owner/repo#latest', {
      root: tempRoot,
      fetchImpl,
      install: true,
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.source).toBe('installed');
    expect(res.value.module.tool).toBe('mytool');
  });

  // 18. install=false returns NOT_INSTALLED error with lmbee message
  test('NOT_INSTALLED and install=false returns NOT_INSTALLED ending with run: lmbee module install <key>', async () => {
    const res = await ensure('@owner/repo#latest', {
      root: tempRoot,
      install: false,
    });

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe('NOT_INSTALLED');
    expect(res.message.endsWith('run: lmbee module install @owner/repo#latest')).toBe(true);
  });

  // 19. Corrupt entry returns CACHE_CORRUPT unchanged
  test('corrupt entry returns CACHE_CORRUPT unchanged telling user to run lmbee module install <key> --force', async () => {
    const fetchImpl = createMockFetch(() => new Response(JSON.stringify(VALID_SCHEMA_V1)));
    await install('@owner/repo#latest', { root: tempRoot, fetchImpl });

    const spec = parseSpec('@owner/repo#latest');
    if (!spec.ok) throw new Error('parseSpec failed');
    const dir = await cachedDir(tempRoot);
    // Tamper with the schema file
    writeFileSync(join(dir, 'cli.schema.latest.json'), 'tampered');

    let fetchCount = 0;
    const refreshFetch = createMockFetch(() => {
      fetchCount++;
      return new Response(JSON.stringify(VALID_SCHEMA_V1));
    });

    const res = await ensure('@owner/repo#latest', {
      root: tempRoot,
      fetchImpl: refreshFetch,
    });

    expect(res.ok).toBe(false);
    expect(fetchCount).toBe(0); // No silent refetch
    if (res.ok) return;
    expect(res.code).toBe('CACHE_CORRUPT');
    expect(res.message).toContain('run: lmbee module install @owner/repo#latest --force');
  });

  // 20. Atomic write failure on 200 keeps old entry byte-identical
  test('atomic write failure on 200 keeps old entry and returns source: stale-cache', async () => {
    const t0 = new Date('2026-10-10T10:00:00.000Z');
    const initialFetch = createMockFetch(() => new Response(JSON.stringify(VALID_SCHEMA_V1)));
    await install('@owner/repo#latest', { root: tempRoot, fetchImpl: initialFetch, now: () => t0 });

    const spec = parseSpec('@owner/repo#latest');
    if (!spec.ok) throw new Error('parseSpec failed');
    const dir = await cachedDir(tempRoot);
    const schemaPath = join(dir, 'cli.schema.latest.json');
    const schemaBefore = readFileSync(schemaPath, 'utf-8');

    const entry = entryDir(tempRoot, spec.value);
    // Make the CURRENT parent read-only to simulate publication failure (on POSIX)
    if (process.platform !== 'win32') {
      await fs.chmod(entry, 0o500);
    }

    try {
      const refreshFetch = createMockFetch(() => new Response(JSON.stringify(VALID_SCHEMA_V2), { status: 200 }));
      const t1 = new Date('2026-10-10T20:00:00.000Z');
      const res = await ensure('@owner/repo#latest', {
        root: tempRoot,
        fetchImpl: refreshFetch,
        now: () => t1,
      });

      if (process.platform !== 'win32') {
        expect(res.ok).toBe(true);
        if (!res.ok) return;
        expect(res.value.source).toBe('stale-cache');
        expect(res.value.module.version).toBe('1.0.0');
      }
    } finally {
      if (process.platform !== 'win32') {
        await fs.chmod(entry, 0o700);
      }
    }

    expect(readFileSync(schemaPath, 'utf-8')).toBe(schemaBefore);
  });

  // 21. Concurrency: parallel ensure calls on stale entry
  test('concurrency: parallel ensure calls on a stale entry end with a valid entry', async () => {
    const t0 = new Date('2026-10-10T10:00:00.000Z');
    const initialFetch = createMockFetch(() => new Response(JSON.stringify(VALID_SCHEMA_V1)));
    await install('@owner/repo#latest', { root: tempRoot, fetchImpl: initialFetch, now: () => t0 });

    const refreshFetch = createMockFetch(() => new Response(JSON.stringify(VALID_SCHEMA_V2), { status: 200 }));
    const t1 = new Date('2026-10-10T20:00:00.000Z');

    const [r1, r2, r3, r4] = await Promise.all([
      ensure('@owner/repo#latest', { root: tempRoot, fetchImpl: refreshFetch, now: () => t1 }),
      ensure('@owner/repo#latest', { root: tempRoot, fetchImpl: refreshFetch, now: () => t1 }),
      ensure('@owner/repo#latest', { root: tempRoot, fetchImpl: refreshFetch, now: () => t1 }),
      ensure('@owner/repo#latest', { root: tempRoot, fetchImpl: refreshFetch, now: () => t1 }),
    ]);

    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    expect(r3.ok).toBe(true);
    expect(r4.ok).toBe(true);

    const verified = await resolveCached('@owner/repo#latest', { root: tempRoot });
    expect(verified.ok).toBe(true);
    if (!verified.ok) return;
    expect(verified.value.version).toBe('2.0.0');
  });

  // 22. Cross-host redirect refused and falls back to stale-cache
  test('cross-host redirect on refresh falls back to source: stale-cache with warning', async () => {
    const t0 = new Date('2026-10-10T10:00:00.000Z');
    const initialFetch = createMockFetch(() => new Response(JSON.stringify(VALID_SCHEMA_V1)));
    await install('@owner/repo#latest', { root: tempRoot, fetchImpl: initialFetch, now: () => t0 });

    const redirectFetch = createMockFetch(() => {
      return new Response(null, {
        status: 302,
        headers: { location: 'https://evil.com/schema.json' },
      });
    });

    const t1 = new Date('2026-10-10T20:00:00.000Z');
    const res = await ensure('@owner/repo#latest', {
      root: tempRoot,
      fetchImpl: redirectFetch,
      now: () => t1,
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.source).toBe('stale-cache');
    expect(res.value.warning).toContain('refused');
  });

  // 23. Non-https redirect refused and falls back to stale-cache
  test('non-https redirect on refresh falls back to source: stale-cache with warning', async () => {
    const t0 = new Date('2026-10-10T10:00:00.000Z');
    const initialFetch = createMockFetch(() => new Response(JSON.stringify(VALID_SCHEMA_V1)));
    await install('@owner/repo#latest', { root: tempRoot, fetchImpl: initialFetch, now: () => t0 });

    const httpRedirectFetch = createMockFetch(() => {
      return new Response(null, {
        status: 302,
        headers: { location: 'http://raw.githubusercontent.com/owner/repo/HEAD/cli.schema.latest.json' },
      });
    });

    const t1 = new Date('2026-10-10T20:00:00.000Z');
    const res = await ensure('@owner/repo#latest', {
      root: tempRoot,
      fetchImpl: httpRedirectFetch,
      now: () => t1,
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.source).toBe('stale-cache');
    expect(res.value.warning).toContain('refused');
  });

  // 24. Redirect missing Location header falls back to stale-cache
  test('redirect missing location header falls back to source: stale-cache with warning', async () => {
    const t0 = new Date('2026-10-10T10:00:00.000Z');
    const initialFetch = createMockFetch(() => new Response(JSON.stringify(VALID_SCHEMA_V1)));
    await install('@owner/repo#latest', { root: tempRoot, fetchImpl: initialFetch, now: () => t0 });

    const badRedirectFetch = createMockFetch(() => {
      return new Response(null, { status: 301 });
    });

    const t1 = new Date('2026-10-10T20:00:00.000Z');
    const res = await ensure('@owner/repo#latest', {
      root: tempRoot,
      fetchImpl: badRedirectFetch,
      now: () => t1,
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.source).toBe('stale-cache');
    expect(res.value.warning).toContain('Location header');
  });

  // 25. Same-host HTTPS redirect is accepted and updates cache
  test('same-host HTTPS redirect on refresh is accepted and updates cache', async () => {
    const t0 = new Date('2026-10-10T10:00:00.000Z');
    const initialFetch = createMockFetch(() => new Response(JSON.stringify(VALID_SCHEMA_V1)));
    await install('@owner/repo#latest', { root: tempRoot, fetchImpl: initialFetch, now: () => t0 });

    const sameHostRedirectFetch = createMockFetch((url) => {
      if (url.includes('HEAD')) {
        return new Response(null, {
          status: 302,
          headers: {
            location: 'https://raw.githubusercontent.com/owner/repo/main/cli.schema.latest.json',
          },
        });
      }
      return new Response(JSON.stringify(VALID_SCHEMA_V2), { status: 200 });
    });

    const t1 = new Date('2026-10-10T20:00:00.000Z');
    const res = await ensure('@owner/repo#latest', {
      root: tempRoot,
      fetchImpl: sameHostRedirectFetch,
      now: () => t1,
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.source).toBe('network');
    expect(res.value.module.version).toBe('2.0.0');
  });

  // 26. Upgrade ignores TTL and records etag
  test('upgrade ignores TTL, forces refresh, and records etag in meta.json', async () => {
    const t0 = new Date('2026-10-10T10:00:00.000Z');
    const initialFetch = createMockFetch(() => new Response(JSON.stringify(VALID_SCHEMA_V1), {
      headers: { ETag: '"etag-1"' },
    }));
    await install('@owner/repo#latest', { root: tempRoot, fetchImpl: initialFetch, now: () => t0 });

    // Only 5 minutes later (fresh under 6h TTL)
    const t1 = new Date('2026-10-10T10:05:00.000Z');
    const upgradeFetch = createMockFetch(() => new Response(JSON.stringify(VALID_SCHEMA_V2), {
      headers: { ETag: '"etag-2"' },
    }));

    const outcomes = await upgrade('@owner/repo#latest', {
      root: tempRoot,
      fetchImpl: upgradeFetch,
      now: () => t1,
    });

    expect(outcomes.length).toBe(1);
    expect(outcomes[0]!.action).toBe('updated');

    const cached = await resolveCached('@owner/repo#latest', { root: tempRoot });
    expect(cached.ok).toBe(true);
    if (!cached.ok) return;
    expect(cached.value.etag).toBe('"etag-2"');
    expect(cached.value.lastChecked).toBe(t1.toISOString());
  });

  // 27. Install records etag and last_checked in meta.json
  test('install records etag and last_checked in meta.json', async () => {
    const t0 = new Date('2026-10-10T10:00:00.000Z');
    const fetchImpl = createMockFetch(() => new Response(JSON.stringify(VALID_SCHEMA_V1), {
      headers: { ETag: '"my-etag"' },
    }));

    const res = await install('@owner/repo#dev', {
      root: tempRoot,
      fetchImpl,
      now: () => t0,
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.entry.etag).toBe('"my-etag"');
    expect(res.value.entry.lastChecked).toBe(t0.toISOString());

    const resolved = await resolveCached('@owner/repo#dev', { root: tempRoot });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.value.etag).toBe('"my-etag"');
    expect(resolved.value.lastChecked).toBe(t0.toISOString());
  });

  // 28. Ensure works on dev channel
  test('ensure works cleanly on dev channel (@owner/repo#dev)', async () => {
    const t0 = new Date('2026-10-10T10:00:00.000Z');
    const fetchImpl = createMockFetch(() => new Response(JSON.stringify(VALID_SCHEMA_V1)));

    const res = await ensure('@owner/repo#dev', {
      root: tempRoot,
      fetchImpl,
      now: () => t0,
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.source).toBe('installed');
    expect(res.value.module.channel).toBe('dev');
  });

  // 29. Path traversal in spec is refused by ensure
  test('path traversal in spec is refused by ensure with PATH_TRAVERSAL', async () => {
    const res = await ensure({
      owner: '..',
      repo: 'escaped',
      channel: 'latest',
      key: '@../escaped#latest',
      requested: '@../escaped',
    }, { root: tempRoot });

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe('PATH_TRAVERSAL');
  });

  // 30. Invalid syntax in spec is refused by ensure
  test('invalid syntax in spec is refused by ensure with SPEC_SYNTAX', async () => {
    const res = await ensure('bad-spec', { root: tempRoot });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe('SPEC_SYNTAX');
  });

  // 31. Invalid channel in spec is refused by ensure
  test('invalid channel in spec is refused by ensure with SPEC_CHANNEL', async () => {
    const res = await ensure('@owner/repo#v1.0.0', { root: tempRoot });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe('SPEC_CHANNEL');
    expect(res.message).toContain('only the latest and dev channels are supported');
  });

  // 32. Ensure accepts ModuleSpec object directly
  test('ensure accepts ModuleSpec object directly', async () => {
    const spec = parseSpec('@owner/repo');
    if (!spec.ok) throw new Error('parseSpec failed');

    const fetchImpl = createMockFetch(() => new Response(JSON.stringify(VALID_SCHEMA_V1)));
    const res = await ensure(spec.value, { root: tempRoot, fetchImpl });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.source).toBe('installed');
    expect(res.value.module.channel).toBe('latest');
  });
});
