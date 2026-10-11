/**
 * @fileoverview Module store implementation for @lmctl-ai/lmts/modules.
 * Implements resolveCached, ensure, install, list, upgrade, and remove for latest and dev channels.
 */
import { type CachedModule, type EnsureOptions, type EnsureOutcome, type InstallOptions, type InstallOutcome, type ListOptions, type ModuleEntry, type ModuleSpec, type RemoveOptions, type RemoveOutcome, type ResolveOptions, type Result, type UpgradeOptions, type UpgradeOutcome } from './types.js';
/**
 * Resolves a module from the local cache, verifying the schema's SHA-256 integrity.
 * Returns NOT_INSTALLED if missing, CACHE_CORRUPT on checksum mismatch,
 * or INVALID_SCHEMA if the cached document fails schema validation.
 */
export declare function resolveCached(spec: ModuleSpec | string, options?: ResolveOptions): Promise<Result<CachedModule>>;
/**
 * Ensures an evergreen module is cached and sufficiently fresh.
 * Younger than TTL -> uses cache directly without network.
 * Stale + update=true -> conditional GET (304/200: publish a complete generation, failure: stale fallback).
 * Missing + install=true -> downloads and caches.
 */
export declare function ensure(spec: ModuleSpec | string, options?: EnsureOptions): Promise<Result<EnsureOutcome>>;
/**
 * Installs a module schema from GitHub raw content into the local cache.
 * Streamed with a 2 MiB hard limit, verified with parsePublishedSchema,
 * and atomically written to disk with restrictive permissions (0700/0600).
 */
export declare function install(spec: ModuleSpec | string, options?: InstallOptions): Promise<Result<InstallOutcome>>;
/**
 * Lists all installed modules in the cache.
 * Skips corrupt entries or reports them with a `problem` description.
 */
export declare function list(options?: ListOptions): Promise<ModuleEntry[]>;
/**
 * Upgrades installed modules on moving channels (latest and dev).
 * Both channels are moving: refetches every installed entry (or specified specs)
 * and reports unchanged/updated with added/removed operations.
 */
export declare function upgrade(specOrSpecs?: string | string[] | ModuleSpec | ModuleSpec[], options?: UpgradeOptions): Promise<UpgradeOutcome[]>;
/**
 * Removes a module entry (or all channels with `allChannels`) and prunes empty parent directories.
 * Refuses any deletion outside cache root.
 */
export declare function remove(spec: ModuleSpec | string, options?: RemoveOptions): Promise<Result<RemoveOutcome>>;
