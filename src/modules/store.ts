/**
 * @fileoverview Module store implementation for @lmctl-ai/lmts/modules.
 * Implements resolveCached, ensure, install, list, upgrade, and remove for latest and dev channels.
 */

import { createHash, randomUUID } from 'node:crypto';
import { existsSync, promises as fs } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { parsePublishedSchema } from '../publish.js';
import type { PublishedCliSchema } from '../types.js';
import { cacheRoot, entryDir, findOnPath, schemaFileName } from './paths.js';
import { parseSpec } from './spec.js';
import {
  err,
  ok,
  type CachedModule,
  type Channel,
  type EnsureOptions,
  type EnsureOutcome,
  type InstallOptions,
  type InstallOutcome,
  type ListOptions,
  type MetaDocument,
  type ModuleEntry,
  type ModuleSpec,
  type RemoveOptions,
  type RemoveOutcome,
  type ResolveOptions,
  type Result,
  type UpgradeOptions,
  type UpgradeOutcome,
} from './types.js';

const GITHUB_RAW_BASE = 'https://raw.githubusercontent.com';
const SEGMENT_REGEX = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const MAX_SCHEMA_BYTES = 2 * 1024 * 1024; // 2 MiB default cap

function normalizeSpec(spec: ModuleSpec | string): Result<ModuleSpec> {
  if (typeof spec === 'string') {
    return parseSpec(spec);
  }
  return ok(spec);
}

/**
 * Resolves a module from the local cache, verifying the schema's SHA-256 integrity.
 * Returns NOT_INSTALLED if missing, CACHE_CORRUPT on checksum mismatch,
 * or INVALID_SCHEMA if the cached document fails schema validation.
 */
export async function resolveCached(
  spec: ModuleSpec | string,
  options?: ResolveOptions,
): Promise<Result<CachedModule>> {
  const specResult = normalizeSpec(spec);
  if (!specResult.ok) {
    return err(specResult.code, specResult.message);
  }
  const parsedSpec = specResult.value;
  const root = options?.root ?? cacheRoot();

  let dir: string;
  try {
    dir = entryDir(root, parsedSpec);
  } catch (e: any) {
    return err('PATH_TRAVERSAL', e?.message ?? String(e));
  }

  const sFileName = schemaFileName(parsedSpec.channel);
  const schemaPath = join(dir, sFileName);
  const metaPath = join(dir, 'meta.json');

  if (!existsSync(schemaPath) || !existsSync(metaPath)) {
    return err('NOT_INSTALLED', `Module ${parsedSpec.key} is not installed`);
  }

  let schemaBytes: Buffer;
  let meta: MetaDocument;

  try {
    schemaBytes = await fs.readFile(schemaPath);
  } catch (e: any) {
    return err('CACHE_CORRUPT', `Failed to read ${schemaPath}: ${e?.message ?? String(e)}; run: lmbee module install ${parsedSpec.key} --force`, {
      file: schemaPath,
    });
  }

  try {
    const metaText = await fs.readFile(metaPath, 'utf-8');
    meta = JSON.parse(metaText) as MetaDocument;
  } catch (e: any) {
    return err('CACHE_CORRUPT', `Failed to read or parse ${metaPath}: ${e?.message ?? String(e)}; run: lmbee module install ${parsedSpec.key} --force`, {
      file: metaPath,
    });
  }

  const computedSha = createHash('sha256').update(schemaBytes).digest('hex');
  if (computedSha !== meta.sha256) {
    return err(
      'CACHE_CORRUPT',
      `Cached schema hash mismatch in ${schemaPath}: expected ${meta.sha256}, got ${computedSha}; run: lmbee module install ${parsedSpec.key} --force`,
      { file: schemaPath },
    );
  }

  let schemaJson: unknown;
  try {
    schemaJson = JSON.parse(schemaBytes.toString('utf-8'));
  } catch (e: any) {
    return err('BAD_JSON', `Failed to parse ${schemaPath} as JSON: ${e?.message ?? String(e)}`, {
      file: schemaPath,
    });
  }

  const validation = parsePublishedSchema(schemaJson);
  if (!validation.ok) {
    return err('INVALID_SCHEMA', `Cached schema in ${schemaPath} is invalid: ${validation.issues[0]?.message}`, {
      file: schemaPath,
      issues: validation.issues,
    });
  }

  return ok({
    spec: parsedSpec,
    dir,
    path: schemaPath,
    sha256: computedSha,
    fetchedAt: meta.fetched_at,
    lastChecked: meta.last_checked ?? meta.fetched_at,
    etag: meta.etag,
    channel: parsedSpec.channel,
    tool: validation.value.tool,
    version: validation.value.version,
    document: validation.value,
  });
}

/**
 * Shared fetch helper supporting manual redirect validation and conditional GET headers.
 */
async function fetchSchemaWithRedirects(
  url: string,
  options: {
    timeoutMs: number;
    fetchImpl: typeof fetch;
    etag?: string;
  },
): Promise<Result<Response>> {
  const { timeoutMs, fetchImpl, etag } = options;
  let response: Response;
  try {
    const signal = AbortSignal.timeout(timeoutMs);
    const headers: Record<string, string> = {};
    if (etag) {
      headers['If-None-Match'] = etag;
    }
    response = await fetchImpl(url, { signal, headers, redirect: 'manual' });

    // Handle redirects manually to enforce https and same host (except 304 Not Modified)
    if (response.status >= 300 && response.status < 400 && response.status !== 304) {
      const location = response.headers.get('location');
      if (!location) {
        return err('FETCH_FAILED', `Redirect response from ${url} missing Location header`);
      }
      const targetUrl = new URL(location, url);
      if (targetUrl.protocol !== 'https:' || targetUrl.hostname !== 'raw.githubusercontent.com') {
        return err(
          'FETCH_FAILED',
          `Cross-host or non-HTTPS redirect to "${location}" refused (must stay on raw.githubusercontent.com)`,
        );
      }
      response = await fetchImpl(targetUrl.href, { signal, headers, redirect: 'manual' });
    }
  } catch (e: any) {
    if (e?.name === 'TimeoutError' || e?.name === 'AbortError') {
      return err('FETCH_FAILED', `Fetch timed out after ${timeoutMs}ms for ${url}`);
    }
    return err('FETCH_FAILED', `Network error fetching ${url}: ${e?.message ?? String(e)}`);
  }

  return ok(response);
}

/**
 * Shared helper to stream, cap, parse JSON, and validate against cli.schema.v1.
 */
async function readAndValidatePayload(
  response: Response,
  maxBytes: number,
  timeoutMs: number,
  specKey: string,
  fileName: string,
  url: string,
): Promise<Result<{ buffer: Buffer; sha256: string; schema: PublishedCliSchema }>> {
  let buffer: Buffer;
  try {
    if (response.body && typeof response.body.getReader === 'function') {
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let totalBytes = 0;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        totalBytes += value.length;
        if (totalBytes > maxBytes) {
          await reader.cancel();
          return err('OUTPUT_LIMIT', `Schema exceeds maximum size limit of ${maxBytes} bytes`);
        }
        chunks.push(value);
      }
      buffer = Buffer.concat(chunks);
    } else {
      const ab = await response.arrayBuffer();
      if (ab.byteLength > maxBytes) {
        return err('OUTPUT_LIMIT', `Schema exceeds maximum size limit of ${maxBytes} bytes`);
      }
      buffer = Buffer.from(ab);
    }
  } catch (e: any) {
    if (e?.name === 'TimeoutError' || e?.name === 'AbortError') {
      return err('FETCH_FAILED', `Fetch stream timed out after ${timeoutMs}ms`);
    }
    return err('FETCH_FAILED', `Error reading response stream: ${e?.message ?? String(e)}`);
  }

  let schemaJson: unknown;
  try {
    schemaJson = JSON.parse(buffer.toString('utf-8'));
  } catch (e: any) {
    return err('BAD_JSON', `Failed to parse ${fileName} from ${url} as JSON: ${e?.message ?? String(e)}`);
  }

  const validation = parsePublishedSchema(schemaJson);
  if (!validation.ok) {
    const firstIssue = validation.issues[0]?.message ?? 'Schema validation failed';
    return err('INVALID_SCHEMA', `Invalid schema for ${specKey}: ${firstIssue}`, {
      issues: validation.issues,
    });
  }

  const sha256 = createHash('sha256').update(buffer).digest('hex');
  return ok({ buffer, sha256, schema: validation.value });
}

/**
 * Atomically writes both the schema file and meta.json with restrictive permissions (0700/0600).
 */
async function atomicWriteEntry(
  dir: string,
  sFileName: string,
  buffer: Buffer,
  metaDoc: MetaDocument,
): Promise<Result<void>> {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });

  const tempSchema = join(dir, `.tmp.schema.${Date.now()}.${randomUUID()}`);
  const tempMeta = join(dir, `.tmp.meta.${Date.now()}.${randomUUID()}`);
  const targetSchema = join(dir, sFileName);
  const targetMeta = join(dir, 'meta.json');

  try {
    await fs.writeFile(tempSchema, buffer, { mode: 0o600 });
    await fs.rename(tempSchema, targetSchema);
    await safeChmod(targetSchema, 0o600);

    await fs.writeFile(tempMeta, JSON.stringify(metaDoc, null, 2) + '\n', { mode: 0o600 });
    await fs.rename(tempMeta, targetMeta);
    await safeChmod(targetMeta, 0o600);
  } catch (e: any) {
    await safeUnlink(tempSchema);
    await safeUnlink(tempMeta);
    return err('ATOMIC_WRITE_FAILED', `Failed to write cached module files: ${e?.message ?? String(e)}`);
  }

  return ok(undefined);
}

/**
 * Atomically writes meta.json only (e.g. for 304 freshness updates).
 */
async function atomicWriteMeta(dir: string, metaDoc: MetaDocument): Promise<Result<void>> {
  const tempMeta = join(dir, `.tmp.meta.${Date.now()}.${randomUUID()}`);
  const targetMeta = join(dir, 'meta.json');
  try {
    await fs.writeFile(tempMeta, JSON.stringify(metaDoc, null, 2) + '\n', { mode: 0o600 });
    await fs.rename(tempMeta, targetMeta);
    await safeChmod(targetMeta, 0o600);
  } catch (e: any) {
    await safeUnlink(tempMeta);
    return err('ATOMIC_WRITE_FAILED', `Failed to write meta.json: ${e?.message ?? String(e)}`);
  }
  return ok(undefined);
}

/**
 * Ensures an evergreen module is cached and sufficiently fresh.
 * Younger than TTL -> uses cache directly without network.
 * Stale + update=true -> conditional GET (304: touch meta.json, 200: atomic replace, failure: stale fallback).
 * Missing + install=true -> downloads and caches.
 */
export async function ensure(
  spec: ModuleSpec | string,
  options?: EnsureOptions,
): Promise<Result<EnsureOutcome>> {
  const specResult = normalizeSpec(spec);
  if (!specResult.ok) {
    return err(specResult.code, specResult.message);
  }
  const parsedSpec = specResult.value;

  const root = options?.root ?? cacheRoot();
  const ttlMs = options?.ttlMs ?? 6 * 60 * 60 * 1000;
  const now = options?.now ?? (() => new Date());
  const fetchImpl = options?.fetchImpl ?? globalThis.fetch;
  const installOpt = options?.install ?? true;
  const updateOpt = options?.update ?? true;
  const timeoutMs = options?.timeoutMs ?? 3000;
  const maxBytes = options?.maxBytes ?? 1048576; // 1 MiB default for ensure

  const cached = await resolveCached(parsedSpec, { root });

  if (!cached.ok) {
    if (cached.code === 'CACHE_CORRUPT') {
      return cached;
    }

    if (cached.code === 'NOT_INSTALLED') {
      if (!installOpt) {
        return err(
          'NOT_INSTALLED',
          `Module ${parsedSpec.key} is not installed; run: lmbee module install ${parsedSpec.key}`,
        );
      }

      const installRes = await install(parsedSpec, {
        root,
        fetchImpl,
        now,
        timeoutMs,
        maxBytes,
      });

      if (!installRes.ok) {
        return err(installRes.code, installRes.message, {
          file: installRes.file,
          issues: installRes.issues,
          details: installRes.details,
        });
      }

      return ok({
        module: installRes.value.entry,
        source: 'installed',
      });
    }

    return cached;
  }

  const currentModule = cached.value;
  const currentTime = now().getTime();
  const lastCheckedTime = currentModule.lastChecked
    ? new Date(currentModule.lastChecked).getTime()
    : NaN;

  const isFuture = !isNaN(lastCheckedTime) && lastCheckedTime > currentTime;
  const isMissing = isNaN(lastCheckedTime);
  const age = currentTime - lastCheckedTime;
  const isFresh = !isMissing && !isFuture && age >= 0 && age < ttlMs;

  if (isFresh || !updateOpt) {
    return ok({
      module: currentModule,
      source: 'cache',
    });
  }

  // Stale and update=true: execute one conditional GET
  const sFileName = schemaFileName(parsedSpec.channel);
  const url = `${GITHUB_RAW_BASE}/${parsedSpec.owner}/${parsedSpec.repo}/HEAD/${sFileName}`;

  const fetchRes = await fetchSchemaWithRedirects(url, {
    timeoutMs,
    fetchImpl,
    etag: currentModule.etag,
  });

  if (!fetchRes.ok) {
    return ok({
      module: currentModule,
      source: 'stale-cache',
      warning: fetchRes.message,
    });
  }

  const response = fetchRes.value;

  if (response.status === 304) {
    const newLastChecked = now().toISOString();
    const newEtag = response.headers.get('etag') ?? response.headers.get('ETag') ?? currentModule.etag;
    let byteSize = 0;
    try {
      byteSize = (await fs.stat(currentModule.path)).size;
    } catch {
      byteSize = 0;
    }

    const metaDoc: MetaDocument = {
      spec: parsedSpec.key,
      url,
      sha256: currentModule.sha256,
      fetched_at: currentModule.fetchedAt,
      last_checked: newLastChecked,
      etag: newEtag,
      channel: parsedSpec.channel,
      tool: currentModule.tool,
      version: currentModule.version,
      bytes: byteSize,
    };

    const writeMetaRes = await atomicWriteMeta(currentModule.dir, metaDoc);
    if (!writeMetaRes.ok) {
      return ok({
        module: currentModule,
        source: 'stale-cache',
        warning: writeMetaRes.message,
      });
    }

    const updatedModule: CachedModule = {
      ...currentModule,
      lastChecked: newLastChecked,
      etag: newEtag,
    };

    return ok({
      module: updatedModule,
      source: 'network',
    });
  }

  if (response.status !== 200) {
    return ok({
      module: currentModule,
      source: 'stale-cache',
      warning: `Failed to refresh ${parsedSpec.key}: HTTP ${response.status} ${response.statusText}`,
    });
  }

  const payloadRes = await readAndValidatePayload(
    response,
    maxBytes,
    timeoutMs,
    parsedSpec.key,
    sFileName,
    url,
  );

  if (!payloadRes.ok) {
    return ok({
      module: currentModule,
      source: 'stale-cache',
      warning: payloadRes.message,
    });
  }

  const { buffer, sha256, schema } = payloadRes.value;
  const responseEtag = response.headers.get('etag') ?? response.headers.get('ETag') ?? undefined;
  const fetchedAt = now().toISOString();
  const lastChecked = fetchedAt;

  const metaDoc: MetaDocument = {
    spec: parsedSpec.key,
    url,
    sha256,
    fetched_at: fetchedAt,
    last_checked: lastChecked,
    etag: responseEtag,
    channel: parsedSpec.channel,
    tool: schema.tool,
    version: schema.version ?? 'unknown',
    bytes: buffer.length,
  };

  const writeRes = await atomicWriteEntry(currentModule.dir, sFileName, buffer, metaDoc);
  if (!writeRes.ok) {
    return ok({
      module: currentModule,
      source: 'stale-cache',
      warning: writeRes.message,
    });
  }

  const newModule: CachedModule = {
    spec: parsedSpec,
    dir: currentModule.dir,
    path: currentModule.path,
    sha256,
    fetchedAt,
    lastChecked,
    etag: responseEtag,
    channel: parsedSpec.channel,
    tool: schema.tool,
    version: schema.version,
    document: schema,
  };

  return ok({
    module: newModule,
    source: 'network',
  });
}

/**
 * Installs a module schema from GitHub raw content into the local cache.
 * Streamed with a 2 MiB hard limit, verified with parsePublishedSchema,
 * and atomically written to disk with restrictive permissions (0700/0600).
 */
export async function install(
  spec: ModuleSpec | string,
  options?: InstallOptions,
): Promise<Result<InstallOutcome>> {
  const specResult = normalizeSpec(spec);
  if (!specResult.ok) {
    return err(specResult.code, specResult.message);
  }
  const parsedSpec = specResult.value;

  const root = options?.root ?? cacheRoot();
  const fetchImpl = options?.fetchImpl ?? globalThis.fetch;
  const now = options?.now ?? (() => new Date());
  const timeoutMs = options?.timeoutMs ?? 10000;
  const maxBytes = options?.maxBytes ?? MAX_SCHEMA_BYTES;
  const force = options?.force ?? false;

  let dir: string;
  try {
    dir = entryDir(root, parsedSpec);
  } catch (e: any) {
    return err('PATH_TRAVERSAL', e?.message ?? String(e));
  }

  const sFileName = schemaFileName(parsedSpec.channel);
  const url = `${GITHUB_RAW_BASE}/${parsedSpec.owner}/${parsedSpec.repo}/HEAD/${sFileName}`;

  const prior = await resolveCached(parsedSpec, { root });
  if (!force && prior.ok) {
    return ok({
      action: 'unchanged',
      entry: prior.value,
    });
  }

  const fetchRes = await fetchSchemaWithRedirects(url, {
    timeoutMs,
    fetchImpl,
  });

  if (!fetchRes.ok) {
    return fetchRes as Result<InstallOutcome>;
  }

  const response = fetchRes.value;

  if (response.status === 404) {
    return err(
      'FETCH_FAILED',
      `Module ${parsedSpec.key} not found: expected ${sFileName} at the root of the default branch for ${parsedSpec.owner}/${parsedSpec.repo}`,
      { details: { status: 404, url, file: sFileName } },
    );
  }

  if (!response.ok) {
    return err('FETCH_FAILED', `Failed to fetch ${url}: HTTP ${response.status} ${response.statusText}`, {
      details: { status: response.status, url },
    });
  }

  const payloadRes = await readAndValidatePayload(
    response,
    maxBytes,
    timeoutMs,
    parsedSpec.key,
    sFileName,
    url,
  );

  if (!payloadRes.ok) {
    return payloadRes as Result<InstallOutcome>;
  }

  const { buffer, sha256, schema } = payloadRes.value;

  if (!force && prior.ok && prior.value.sha256 === sha256) {
    return ok({
      action: 'unchanged',
      entry: prior.value,
    });
  }

  const responseEtag = response.headers.get('etag') ?? response.headers.get('ETag') ?? undefined;
  const fetchedAt = now().toISOString();
  const lastChecked = fetchedAt;

  const metaDoc: MetaDocument = {
    spec: parsedSpec.key,
    url,
    sha256,
    fetched_at: fetchedAt,
    last_checked: lastChecked,
    etag: responseEtag,
    channel: parsedSpec.channel,
    tool: schema.tool,
    version: schema.version ?? 'unknown',
    bytes: buffer.length,
  };

  const writeRes = await atomicWriteEntry(dir, sFileName, buffer, metaDoc);
  if (!writeRes.ok) {
    return writeRes as Result<InstallOutcome>;
  }

  const entry: CachedModule = {
    spec: parsedSpec,
    dir,
    path: join(dir, sFileName),
    sha256,
    fetchedAt,
    lastChecked,
    etag: responseEtag,
    channel: parsedSpec.channel,
    tool: schema.tool,
    version: schema.version,
    document: schema,
  };

  return ok({
    action: prior.ok ? 'replaced' : 'installed',
    entry,
  });
}

/**
 * Lists all installed modules in the cache.
 * Skips corrupt entries or reports them with a `problem` description.
 */
export async function list(options?: ListOptions): Promise<ModuleEntry[]> {
  const root = options?.root ?? cacheRoot();
  const ghDir = join(root, 'github.com');
  if (!existsSync(ghDir)) {
    return [];
  }

  let ownerDirs: string[];
  try {
    ownerDirs = await fs.readdir(ghDir);
  } catch {
    return [];
  }

  const entries: ModuleEntry[] = [];

  for (const owner of ownerDirs) {
    const ownerDir = join(ghDir, owner);
    let ownerStat;
    try {
      ownerStat = await fs.stat(ownerDir);
    } catch {
      continue;
    }
    if (!ownerStat.isDirectory()) continue;

    let repoDirs: string[];
    try {
      repoDirs = await fs.readdir(ownerDir);
    } catch {
      continue;
    }

    for (const repo of repoDirs) {
      const repoDir = join(ownerDir, repo);
      let repoStat;
      try {
        repoStat = await fs.stat(repoDir);
      } catch {
        continue;
      }
      if (!repoStat.isDirectory()) continue;

      let channelDirs: string[];
      try {
        channelDirs = await fs.readdir(repoDir);
      } catch {
        continue;
      }

      for (const channelName of channelDirs) {
        const dir = join(repoDir, channelName);
        let dirStat;
        try {
          dirStat = await fs.stat(dir);
        } catch {
          continue;
        }
        if (!dirStat.isDirectory()) continue;

        const specKey = `@${owner}/${repo}#${channelName}`;
        const isKnownChannel = channelName === 'latest' || channelName === 'dev';
        const channel: Channel | undefined = isKnownChannel ? (channelName as Channel) : undefined;
        const sFileName = channel ? schemaFileName(channel) : `cli.schema.${channelName}.json`;

        const schemaFile = join(dir, sFileName);
        const metaFile = join(dir, 'meta.json');

        if (!existsSync(schemaFile) || !existsSync(metaFile)) {
          entries.push({
            spec: specKey,
            channel,
            dir,
            problem: `Missing ${sFileName} or meta.json`,
          });
          continue;
        }

        let sha: string;
        let meta: MetaDocument;
        try {
          const content = await fs.readFile(schemaFile);
          sha = createHash('sha256').update(content).digest('hex');
          meta = JSON.parse(await fs.readFile(metaFile, 'utf-8'));
        } catch (e: any) {
          entries.push({
            spec: specKey,
            channel,
            dir,
            problem: `Unreadable or corrupt files: ${e?.message ?? String(e)}`,
          });
          continue;
        }

        if (sha !== meta.sha256) {
          entries.push({
            spec: specKey,
            channel,
            dir,
            problem: `Checksum mismatch: expected ${meta.sha256}, got ${sha}`,
          });
          continue;
        }

        const binaryOnPath = meta.tool ? (findOnPath(meta.tool) ?? null) : null;

        entries.push({
          spec: meta.spec ?? specKey,
          channel: meta.channel ?? channel,
          tool: meta.tool,
          version: meta.version,
          sha256: meta.sha256,
          fetchedAt: meta.fetched_at,
          dir,
          binaryOnPath,
        });
      }
    }
  }

  return entries;
}

/**
 * Upgrades installed modules on moving channels (latest and dev).
 * Both channels are moving: refetches every installed entry (or specified specs)
 * and reports unchanged/updated with added/removed operations.
 */
export async function upgrade(
  specOrSpecs?: string | string[] | ModuleSpec | ModuleSpec[],
  options?: UpgradeOptions,
): Promise<UpgradeOutcome[]> {
  const root = options?.root ?? cacheRoot();
  const fetchImpl = options?.fetchImpl;
  const now = options?.now;

  let specs: ModuleSpec[] = [];

  if (specOrSpecs !== undefined) {
    const rawList = Array.isArray(specOrSpecs) ? specOrSpecs : [specOrSpecs];
    for (const item of rawList) {
      const res = normalizeSpec(item);
      if (res.ok) {
        specs.push(res.value);
      } else {
        return [
          {
            action: 'failed',
            spec: typeof item === 'string' ? item : item.key,
            error: res.message,
          },
        ];
      }
    }
  } else {
    const installed = await list({ root });
    for (const entry of installed) {
      if (entry.channel) {
        const parsed = parseSpec(entry.spec);
        if (parsed.ok) {
          specs.push(parsed.value);
        }
      }
    }
  }

  const outcomes: UpgradeOutcome[] = [];

  for (const spec of specs) {
    const current = await resolveCached(spec, { root });
    if (!current.ok) {
      outcomes.push({ action: 'failed', spec: spec.key, channel: spec.channel, error: current.message });
      continue;
    }

    const res = await install(spec, { root, fetchImpl, now, force: true });
    if (!res.ok) {
      outcomes.push({ action: 'failed', spec: spec.key, channel: spec.channel, error: res.message });
      continue;
    }

    if (res.value.entry.sha256 === current.value.sha256) {
      outcomes.push({
        action: 'unchanged',
        spec: spec.key,
        channel: spec.channel,
        sha256: current.value.sha256,
        version: current.value.version,
      });
    } else {
      const oldOps = new Set(current.value.document.operations.map((o) => o.name));
      const newOps = new Set(res.value.entry.document.operations.map((o) => o.name));

      const operationsAdded = [...newOps].filter((x) => !oldOps.has(x)).sort();
      const operationsRemoved = [...oldOps].filter((x) => !newOps.has(x)).sort();

      outcomes.push({
        action: 'updated',
        spec: spec.key,
        channel: spec.channel,
        fromSha: current.value.sha256,
        toSha: res.value.entry.sha256,
        fromVersion: current.value.version,
        toVersion: res.value.entry.version,
        operationsAdded,
        operationsRemoved,
      });
    }
  }

  return outcomes;
}

/**
 * Removes a module entry (or all channels with `allChannels`) and prunes empty parent directories.
 * Refuses any deletion outside cache root.
 */
export async function remove(
  spec: ModuleSpec | string,
  options?: RemoveOptions,
): Promise<Result<RemoveOutcome>> {
  const specResult = normalizeSpec(spec);
  if (!specResult.ok) {
    return err(specResult.code, specResult.message);
  }
  const parsedSpec = specResult.value;
  const root = options?.root ?? cacheRoot();
  const allChannels = options?.allChannels ?? false;

  const absRoot = resolve(root);

  if (allChannels) {
    // Hand-built specs bypass parseSpec: refuse names it would reject, so "." / ".." can never
    // resolve to github.com itself (or the owner directory) and delete every cached module.
    for (const segment of [parsedSpec.owner, parsedSpec.repo]) {
      if (!SEGMENT_REGEX.test(segment) || segment === '.' || segment === '..') {
        return err('PATH_TRAVERSAL', `Invalid owner or repo name "${segment}" in ${parsedSpec.key}`);
      }
    }
    const ghRoot = resolve(absRoot, 'github.com');
    const repoDir = resolve(ghRoot, parsedSpec.owner, parsedSpec.repo);
    const relRoot = relative(absRoot, repoDir);
    const relGh = relative(ghRoot, repoDir);
    if (relRoot.startsWith('..') || isAbsolute(relRoot) || relGh.startsWith('..') || isAbsolute(relGh)) {
      return err('PATH_TRAVERSAL', 'Target path escapes cache root');
    }

    if (!existsSync(repoDir)) {
      return err('NOT_INSTALLED', `Module ${parsedSpec.owner}/${parsedSpec.repo} not found in cache`);
    }

    await fs.rm(repoDir, { recursive: true, force: true });
    await pruneParents(repoDir, absRoot);
    return ok({ removed: [repoDir] });
  }

  let dir: string;
  try {
    dir = entryDir(root, parsedSpec);
  } catch (e: any) {
    return err('PATH_TRAVERSAL', e?.message ?? String(e));
  }

  if (!existsSync(dir)) {
    return err('NOT_INSTALLED', `Module ${parsedSpec.key} is not installed`);
  }

  await fs.rm(dir, { recursive: true, force: true });
  await pruneParents(dir, absRoot);
  return ok({ removed: [dir] });
}

async function pruneParents(deletedPath: string, root: string): Promise<void> {
  let current = dirname(deletedPath);
  while (current !== root && current.startsWith(root) && current !== dirname(current)) {
    try {
      const files = await fs.readdir(current);
      if (files.length === 0) {
        await fs.rmdir(current);
        current = dirname(current);
      } else {
        break;
      }
    } catch {
      break;
    }
  }
}

async function safeChmod(targetPath: string, mode: number): Promise<void> {
  try {
    await fs.chmod(targetPath, mode);
  } catch {
    // Ignore chmod failure (e.g. filesystems not supporting POSIX permissions)
  }
}

async function safeUnlink(targetPath: string): Promise<void> {
  try {
    await fs.unlink(targetPath);
  } catch {
    // Ignore error if file does not exist or cannot be removed
  }
}
