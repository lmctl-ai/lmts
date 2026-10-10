/**
 * @fileoverview Cache directory layout, path resolution, and PATH lookups.
 */

import { accessSync, constants, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import type { Channel, ModuleSpec } from './types.js';

const TOOL_NAME_REGEX = /^[a-z][a-z0-9_]*$/;

/**
 * Returns the default or configured modules cache root.
 * Defaults to `${LMCTL_HOME:-~/.lmctl}/modules`.
 */
export function cacheRoot(env: Record<string, string | undefined> = process.env): string {
  const lmctlHome =
    env.LMCTL_HOME && env.LMCTL_HOME.trim() !== ''
      ? env.LMCTL_HOME
      : join(env.HOME ?? homedir(), '.lmctl');
  return join(lmctlHome, 'modules');
}

/**
 * Resolves the cache directory for a given module spec inside root.
 * Format: root/github.com/<owner>/<repo>/<channel>
 * Verifies that the resulting path does not escape the cache root.
 */
export function entryDir(root: string, spec: ModuleSpec): string {
  const absRoot = resolve(root);
  const ghRoot = resolve(absRoot, 'github.com');
  const dir = resolve(ghRoot, spec.owner, spec.repo, spec.channel);

  const relRoot = relative(absRoot, dir);
  const relGh = relative(ghRoot, dir);
  if (relRoot.startsWith('..') || isAbsolute(relRoot) || relGh.startsWith('..') || isAbsolute(relGh)) {
    throw new Error(`Path traversal detected: entry directory "${dir}" escapes cache root "${absRoot}"`);
  }

  return dir;
}

/**
 * Returns the schema filename for a given channel: `cli.schema.<channel>.json`.
 */
export function schemaFileName(channel: Channel): string {
  return `cli.schema.${channel}.json`;
}

/**
 * Searches absolute PATH entries for a regular executable file matching `name`.
 * Ignores relative entries, empty entries, and the current working directory.
 * Refuses invalid tool names (must match ^[a-z][a-z0-9_]*$).
 */
export function findOnPath(name: string, pathVar?: string): string | undefined {
  if (typeof name !== 'string' || !TOOL_NAME_REGEX.test(name)) {
    return undefined;
  }

  const pVar = pathVar ?? process.env.PATH ?? '';
  const delimiter = process.platform === 'win32' ? ';' : ':';
  const parts = pVar.split(delimiter);

  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed || !isAbsolute(trimmed)) {
      continue;
    }

    const candidate = join(trimmed, name);
    try {
      const stat = statSync(candidate);
      if (!stat.isFile()) {
        continue;
      }

      if (process.platform === 'win32') {
        return candidate;
      }

      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Missing, not executable, or permission denied: proceed to next
    }
  }

  return undefined;
}
