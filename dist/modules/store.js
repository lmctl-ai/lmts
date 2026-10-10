/**
 * @fileoverview Module store implementation for @lmctl-ai/lmts/modules.
 * Implements resolveCached, install, list, upgrade, and remove.
 */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, promises as fs } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { parsePublishedSchema } from '../publish.js';
import { cacheRoot, entryDir } from './paths.js';
import { parseSpec } from './spec.js';
import { err, ok, } from './types.js';
const GITHUB_RAW_BASE = 'https://raw.githubusercontent.com';
function normalizeSpec(spec) {
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
export async function resolveCached(spec, options) {
    const specResult = normalizeSpec(spec);
    if (!specResult.ok) {
        return err(specResult.code, specResult.message);
    }
    const parsedSpec = specResult.value;
    const root = options?.root ?? cacheRoot();
    let dir;
    try {
        dir = entryDir(root, parsedSpec);
    }
    catch (e) {
        return err('PATH_TRAVERSAL', e?.message ?? String(e));
    }
    const schemaPath = join(dir, 'cli.schema.v1.json');
    const metaPath = join(dir, 'meta.json');
    if (!existsSync(schemaPath) || !existsSync(metaPath)) {
        return err('NOT_INSTALLED', `Module ${parsedSpec.key} is not installed`);
    }
    let schemaBytes;
    let meta;
    try {
        schemaBytes = await fs.readFile(schemaPath);
    }
    catch (e) {
        return err('CACHE_CORRUPT', `Failed to read ${schemaPath}: ${e?.message ?? String(e)}`, {
            file: schemaPath,
        });
    }
    try {
        const metaText = await fs.readFile(metaPath, 'utf-8');
        meta = JSON.parse(metaText);
    }
    catch (e) {
        return err('CACHE_CORRUPT', `Failed to read or parse ${metaPath}: ${e?.message ?? String(e)}`, {
            file: metaPath,
        });
    }
    const computedSha = createHash('sha256').update(schemaBytes).digest('hex');
    if (computedSha !== meta.sha256) {
        return err('CACHE_CORRUPT', `Cached schema hash mismatch in ${schemaPath}: expected ${meta.sha256}, got ${computedSha}`, { file: schemaPath });
    }
    let schemaJson;
    try {
        schemaJson = JSON.parse(schemaBytes.toString('utf-8'));
    }
    catch (e) {
        return err('BAD_JSON', `Failed to parse ${schemaPath} as JSON: ${e?.message ?? String(e)}`, {
            file: schemaPath,
        });
    }
    const validation = parsePublishedSchema(schemaJson);
    if (!validation.ok) {
        const firstIssue = validation.issues[0]?.message ?? 'Invalid schema';
        return err('INVALID_SCHEMA', `Cached schema in ${schemaPath} is invalid: ${firstIssue}`, {
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
        tool: validation.value.tool,
        version: validation.value.version,
        document: validation.value,
    });
}
/**
 * Downloads and caches a published CLI schema from GitHub.
 * Verifies HTTPS, enforces byte caps, validates published schema structure,
 * and writes files atomically (0700 dir, 0600 files).
 * An invalid download will never corrupt or replace an existing good entry.
 */
export async function install(spec, options) {
    const specResult = normalizeSpec(spec);
    if (!specResult.ok) {
        return err(specResult.code, specResult.message);
    }
    const parsedSpec = specResult.value;
    const root = options?.root ?? cacheRoot();
    const force = options?.force ?? false;
    const timeoutMs = options?.timeoutMs ?? 10000;
    const maxBytes = options?.maxBytes ?? 1048576; // 1 MiB
    const fetchImpl = options?.fetchImpl ?? globalThis.fetch;
    const now = options?.now ?? (() => new Date());
    let dir;
    try {
        dir = entryDir(root, parsedSpec);
    }
    catch (e) {
        return err('PATH_TRAVERSAL', e?.message ?? String(e));
    }
    if (!force) {
        const cached = await resolveCached(parsedSpec, { root });
        if (cached.ok) {
            return ok({
                action: 'unchanged',
                entry: cached.value,
            });
        }
    }
    const prior = await resolveCached(parsedSpec, { root });
    const url = `${GITHUB_RAW_BASE}/${parsedSpec.owner}/${parsedSpec.repo}/${parsedSpec.refOrHead}/cli.schema.v1.json`;
    let parsedUrl;
    try {
        parsedUrl = new URL(url);
        if (parsedUrl.protocol !== 'https:') {
            return err('FETCH_FAILED', `Refusing non-HTTPS URL: ${url}`);
        }
    }
    catch (e) {
        return err('FETCH_FAILED', `Invalid URL: ${url}`);
    }
    let response;
    try {
        const signal = AbortSignal.timeout(timeoutMs);
        response = await fetchImpl(url, { signal, redirect: 'manual' });
        // Handle redirects manually to enforce https and same host
        if (response.status >= 300 && response.status < 400) {
            const location = response.headers.get('location');
            if (!location) {
                return err('FETCH_FAILED', `Redirect response from ${url} missing Location header`);
            }
            const targetUrl = new URL(location, url);
            if (targetUrl.protocol !== 'https:' || targetUrl.hostname !== 'raw.githubusercontent.com') {
                return err('FETCH_FAILED', `Cross-host or non-HTTPS redirect to "${location}" refused (must stay on raw.githubusercontent.com)`);
            }
            response = await fetchImpl(targetUrl.href, { signal, redirect: 'manual' });
        }
    }
    catch (e) {
        if (e?.name === 'TimeoutError' || e?.name === 'AbortError') {
            return err('FETCH_FAILED', `Fetch timed out after ${timeoutMs}ms for ${url}`);
        }
        return err('FETCH_FAILED', `Network error fetching ${url}: ${e?.message ?? String(e)}`);
    }
    if (response.status === 404) {
        return err('FETCH_FAILED', `Module ${parsedSpec.key} not found at ${url} (expected cli.schema.v1.json at repository root)`, { details: { status: 404, url } });
    }
    if (!response.ok) {
        return err('FETCH_FAILED', `Failed to fetch ${url}: HTTP ${response.status} ${response.statusText}`, {
            details: { status: response.status, url },
        });
    }
    // Stream with hard byte cap
    let buffer;
    try {
        if (response.body && typeof response.body.getReader === 'function') {
            const reader = response.body.getReader();
            const chunks = [];
            let totalBytes = 0;
            while (true) {
                const { done, value } = await reader.read();
                if (done)
                    break;
                totalBytes += value.length;
                if (totalBytes > maxBytes) {
                    await reader.cancel();
                    return err('OUTPUT_LIMIT', `Schema exceeds maximum size limit of ${maxBytes} bytes`);
                }
                chunks.push(value);
            }
            buffer = Buffer.concat(chunks);
        }
        else {
            const ab = await response.arrayBuffer();
            if (ab.byteLength > maxBytes) {
                return err('OUTPUT_LIMIT', `Schema exceeds maximum size limit of ${maxBytes} bytes`);
            }
            buffer = Buffer.from(ab);
        }
    }
    catch (e) {
        if (e?.name === 'TimeoutError' || e?.name === 'AbortError') {
            return err('FETCH_FAILED', `Fetch stream timed out after ${timeoutMs}ms`);
        }
        return err('FETCH_FAILED', `Error reading response stream: ${e?.message ?? String(e)}`);
    }
    let schemaJson;
    try {
        schemaJson = JSON.parse(buffer.toString('utf-8'));
    }
    catch (e) {
        return err('BAD_JSON', `Failed to parse cli.schema.v1.json from ${url} as JSON: ${e?.message ?? String(e)}`);
    }
    const validation = parsePublishedSchema(schemaJson);
    if (!validation.ok) {
        const firstIssue = validation.issues[0]?.message ?? 'Schema validation failed';
        return err('INVALID_SCHEMA', `Invalid schema for ${parsedSpec.key}: ${firstIssue}`, {
            issues: validation.issues,
        });
    }
    const sha256 = createHash('sha256').update(buffer).digest('hex');
    if (!force && prior.ok && prior.value.sha256 === sha256) {
        return ok({
            action: 'unchanged',
            entry: prior.value,
        });
    }
    // Atomic write to cache
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    await safeChmod(dir, 0o700);
    const tempSchema = join(dir, `.tmp.schema.${Date.now()}.${randomUUID()}`);
    const tempMeta = join(dir, `.tmp.meta.${Date.now()}.${randomUUID()}`);
    const targetSchema = join(dir, 'cli.schema.v1.json');
    const targetMeta = join(dir, 'meta.json');
    const metaDoc = {
        spec: parsedSpec.key,
        url,
        sha256,
        fetched_at: now().toISOString(),
        ...(parsedSpec.ref !== undefined ? { ref: parsedSpec.ref } : {}),
        tool: validation.value.tool,
        version: validation.value.version,
        bytes: buffer.length,
    };
    try {
        await fs.writeFile(tempSchema, buffer, { mode: 0o600 });
        await fs.rename(tempSchema, targetSchema);
        await safeChmod(targetSchema, 0o600);
        await fs.writeFile(tempMeta, JSON.stringify(metaDoc, null, 2) + '\n', { mode: 0o600 });
        await fs.rename(tempMeta, targetMeta);
        await safeChmod(targetMeta, 0o600);
    }
    catch (e) {
        // Clean up temporary files on failure
        await safeUnlink(tempSchema);
        await safeUnlink(tempMeta);
        return err('ATOMIC_WRITE_FAILED', `Failed to write cached module files: ${e?.message ?? String(e)}`);
    }
    const entry = {
        spec: parsedSpec,
        dir,
        path: targetSchema,
        sha256,
        fetchedAt: metaDoc.fetched_at,
        tool: validation.value.tool,
        version: validation.value.version,
        document: validation.value,
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
export async function list(options) {
    const root = options?.root ?? cacheRoot();
    const ghDir = join(root, 'github.com');
    if (!existsSync(ghDir)) {
        return [];
    }
    const entries = [];
    let owners;
    try {
        owners = await fs.readdir(ghDir);
    }
    catch {
        return [];
    }
    for (const owner of owners) {
        const ownerDir = join(ghDir, owner);
        let ownerStat;
        try {
            ownerStat = await fs.stat(ownerDir);
        }
        catch {
            continue;
        }
        if (!ownerStat.isDirectory())
            continue;
        let repos;
        try {
            repos = await fs.readdir(ownerDir);
        }
        catch {
            continue;
        }
        for (const repo of repos) {
            const repoDir = join(ownerDir, repo);
            let repoStat;
            try {
                repoStat = await fs.stat(repoDir);
            }
            catch {
                continue;
            }
            if (!repoStat.isDirectory())
                continue;
            let refDirs;
            try {
                refDirs = await fs.readdir(repoDir);
            }
            catch {
                continue;
            }
            for (const encodedRef of refDirs) {
                const dir = join(repoDir, encodedRef);
                let dirStat;
                try {
                    dirStat = await fs.stat(dir);
                }
                catch {
                    continue;
                }
                if (!dirStat.isDirectory())
                    continue;
                let decodedRef;
                try {
                    decodedRef = decodeURIComponent(encodedRef);
                }
                catch {
                    decodedRef = encodedRef;
                }
                const isHead = decodedRef === 'HEAD';
                const ref = isHead ? undefined : decodedRef;
                const specKey = `@${owner}/${repo}${ref ? '#' + ref : ''}`;
                const schemaFile = join(dir, 'cli.schema.v1.json');
                const metaFile = join(dir, 'meta.json');
                if (!existsSync(schemaFile) || !existsSync(metaFile)) {
                    entries.push({
                        spec: specKey,
                        ref,
                        dir,
                        problem: 'Missing cli.schema.v1.json or meta.json',
                    });
                    continue;
                }
                let meta;
                let schemaBytes;
                try {
                    meta = JSON.parse(await fs.readFile(metaFile, 'utf-8'));
                    schemaBytes = await fs.readFile(schemaFile);
                }
                catch (e) {
                    entries.push({
                        spec: specKey,
                        ref,
                        dir,
                        problem: `Unreadable or corrupt files: ${e?.message ?? String(e)}`,
                    });
                    continue;
                }
                const sha = createHash('sha256').update(schemaBytes).digest('hex');
                if (sha !== meta.sha256) {
                    entries.push({
                        spec: specKey,
                        ref,
                        dir,
                        problem: `Checksum mismatch: expected ${meta.sha256}, got ${sha}`,
                    });
                    continue;
                }
                const specRes = parseSpec(meta.spec ?? specKey);
                const immutable = specRes.ok ? specRes.value.immutable : false;
                entries.push({
                    spec: meta.spec ?? specKey,
                    ref: meta.ref,
                    tool: meta.tool,
                    version: meta.version,
                    sha256: meta.sha256,
                    fetchedAt: meta.fetched_at,
                    dir,
                    immutable,
                });
            }
        }
    }
    entries.sort((a, b) => a.spec.localeCompare(b.spec));
    return entries;
}
/**
 * Upgrades installed modules on moving refs (HEAD/branches), or installs a new ref with `to`.
 * Immutable refs (semver tags/commit shas) are skipped unless `to` is specified.
 */
export async function upgrade(specOrSpecs, options) {
    const root = options?.root ?? cacheRoot();
    const fetchImpl = options?.fetchImpl;
    const now = options?.now;
    const to = options?.to;
    let specs = [];
    if (specOrSpecs !== undefined) {
        const rawList = Array.isArray(specOrSpecs) ? specOrSpecs : [specOrSpecs];
        for (const item of rawList) {
            const res = normalizeSpec(item);
            if (res.ok) {
                specs.push(res.value);
            }
            else {
                // Return immediate failure for invalid spec syntax
                return [
                    {
                        action: 'failed',
                        spec: typeof item === 'string' ? item : item.key,
                        error: res.message,
                    },
                ];
            }
        }
    }
    else {
        const all = await list({ root });
        for (const entry of all) {
            if (!entry.problem) {
                const res = parseSpec(entry.spec);
                if (res.ok) {
                    specs.push(res.value);
                }
            }
        }
    }
    const outcomes = [];
    for (const spec of specs) {
        if (to !== undefined) {
            const newKey = `@${spec.owner}/${spec.repo}#${to}`;
            const newSpec = parseSpec(newKey);
            if (!newSpec.ok) {
                outcomes.push({ action: 'failed', spec: spec.key, error: newSpec.message });
                continue;
            }
            const res = await install(newSpec.value, { root, fetchImpl, now, force: true });
            if (res.ok) {
                outcomes.push({
                    action: 'installed',
                    spec: newSpec.value.key,
                    toSha: res.value.entry.sha256,
                    toVersion: res.value.entry.version,
                });
            }
            else {
                outcomes.push({ action: 'failed', spec: newSpec.value.key, error: res.message });
            }
            continue;
        }
        if (spec.immutable) {
            outcomes.push({ action: 'skipped', spec: spec.key, reason: 'immutable' });
            continue;
        }
        // Moving ref: check current
        const current = await resolveCached(spec, { root });
        if (!current.ok) {
            outcomes.push({ action: 'failed', spec: spec.key, error: current.message });
            continue;
        }
        const res = await install(spec, { root, fetchImpl, now, force: true });
        if (!res.ok) {
            outcomes.push({ action: 'failed', spec: spec.key, error: res.message });
            continue;
        }
        if (res.value.entry.sha256 === current.value.sha256) {
            outcomes.push({
                action: 'unchanged',
                spec: spec.key,
                sha256: current.value.sha256,
            });
        }
        else {
            const oldOps = new Set(current.value.document.operations.map((o) => o.name));
            const newOps = new Set(res.value.entry.document.operations.map((o) => o.name));
            const operationsAdded = [...newOps].filter((x) => !oldOps.has(x)).sort();
            const operationsRemoved = [...oldOps].filter((x) => !newOps.has(x)).sort();
            outcomes.push({
                action: 'updated',
                spec: spec.key,
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
 * Removes a module entry (or all refs with `allRefs`) and prunes empty parent directories.
 * Refuses any deletion outside cache root.
 */
export async function remove(spec, options) {
    const specResult = normalizeSpec(spec);
    if (!specResult.ok) {
        return err(specResult.code, specResult.message);
    }
    const parsedSpec = specResult.value;
    const root = options?.root ?? cacheRoot();
    const allRefs = options?.allRefs ?? false;
    const absRoot = resolve(root);
    if (allRefs) {
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
    let dir;
    try {
        dir = entryDir(root, parsedSpec);
    }
    catch (e) {
        return err('PATH_TRAVERSAL', e?.message ?? String(e));
    }
    if (!existsSync(dir)) {
        return err('NOT_INSTALLED', `Module ${parsedSpec.key} is not installed`);
    }
    await fs.rm(dir, { recursive: true, force: true });
    await pruneParents(dir, absRoot);
    return ok({ removed: [dir] });
}
async function pruneParents(deletedPath, root) {
    let current = dirname(deletedPath);
    while (current !== root && current.startsWith(root) && current !== dirname(current)) {
        try {
            const files = await fs.readdir(current);
            if (files.length === 0) {
                await fs.rmdir(current);
                current = dirname(current);
            }
            else {
                break;
            }
        }
        catch {
            break;
        }
    }
}
async function safeChmod(targetPath, mode) {
    try {
        await fs.chmod(targetPath, mode);
    }
    catch {
        // Ignore chmod failure (e.g. filesystems not supporting POSIX permissions)
    }
}
async function safeUnlink(targetPath) {
    try {
        await fs.unlink(targetPath);
    }
    catch {
        // Ignore error if file does not exist or cannot be removed
    }
}
