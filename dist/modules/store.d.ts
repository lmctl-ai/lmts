/**
 * @fileoverview Module store implementation for @lmctl-ai/lmts/modules.
 * Implements resolveCached, install, list, upgrade, and remove.
 */
import { type CachedModule, type InstallOptions, type InstallOutcome, type ListOptions, type ModuleEntry, type ModuleSpec, type RemoveOptions, type RemoveOutcome, type ResolveOptions, type Result, type UpgradeOptions, type UpgradeOutcome } from './types.js';
/**
 * Resolves a module from the local cache, verifying the schema's SHA-256 integrity.
 * Returns NOT_INSTALLED if missing, CACHE_CORRUPT on checksum mismatch,
 * or INVALID_SCHEMA if the cached document fails schema validation.
 */
export declare function resolveCached(spec: ModuleSpec | string, options?: ResolveOptions): Promise<Result<CachedModule>>;
/**
 * Downloads and caches a published CLI schema from GitHub.
 * Verifies HTTPS, enforces byte caps, validates published schema structure,
 * and writes files atomically (0700 dir, 0600 files).
 * An invalid download will never corrupt or replace an existing good entry.
 */
export declare function install(spec: ModuleSpec | string, options?: InstallOptions): Promise<Result<InstallOutcome>>;
/**
 * Lists all installed modules in the cache.
 * Skips corrupt entries or reports them with a `problem` description.
 */
export declare function list(options?: ListOptions): Promise<ModuleEntry[]>;
/**
 * Upgrades installed modules on moving refs (HEAD/branches), or installs a new ref with `to`.
 * Immutable refs (semver tags/commit shas) are skipped unless `to` is specified.
 */
export declare function upgrade(specOrSpecs?: string | string[] | ModuleSpec | ModuleSpec[], options?: UpgradeOptions): Promise<UpgradeOutcome[]>;
/**
 * Removes a module entry (or all refs with `allRefs`) and prunes empty parent directories.
 * Refuses any deletion outside cache root.
 */
export declare function remove(spec: ModuleSpec | string, options?: RemoveOptions): Promise<Result<RemoveOutcome>>;
