/**
 * @fileoverview Cache directory layout, path resolution, and PATH lookups.
 */
import type { Channel, ModuleSpec } from './types.js';
/**
 * Returns the default or configured modules cache root.
 * Defaults to `${LMCTL_HOME:-~/.lmctl}/modules`.
 */
export declare function cacheRoot(env?: Record<string, string | undefined>): string;
/**
 * Resolves the cache directory for a given module spec inside root.
 * Format: root/github.com/<owner>/<repo>/<channel>
 * Verifies that the resulting path does not escape the cache root.
 */
export declare function entryDir(root: string, spec: ModuleSpec): string;
/**
 * Returns the schema filename for a given channel: `cli.schema.<channel>.json`.
 */
export declare function schemaFileName(channel: Channel): string;
/**
 * Searches absolute PATH entries for a regular executable file matching `name`.
 * Ignores relative entries, empty entries, and the current working directory.
 * Refuses invalid tool names (must match ^[a-z][a-z0-9_]*$).
 */
export declare function findOnPath(name: string, pathVar?: string): string | undefined;
