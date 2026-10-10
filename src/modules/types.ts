/**
 * @fileoverview Type definitions for the lmapi module store (@lmctl-ai/lmts/modules).
 * Defines module specs, cache entries, outcomes, and Result types.
 */

import type { PublishedCliSchema } from '../types.js';

export interface ModuleSpec {
  owner: string;
  repo: string;
  ref?: string;
  refOrHead: string;
  key: string;
  immutable: boolean;
}

export interface CachedModule {
  spec: ModuleSpec;
  dir: string;
  path: string;
  sha256: string;
  fetchedAt: string;
  tool: string;
  version?: string;
  document: PublishedCliSchema;
}

export interface ModuleEntry {
  spec: string;
  ref?: string;
  tool?: string;
  version?: string;
  sha256?: string;
  fetchedAt?: string;
  dir: string;
  immutable?: boolean;
  problem?: string;
}

export interface InstallOutcome {
  action: 'installed' | 'unchanged' | 'replaced';
  entry: CachedModule;
}

export interface UpgradeOutcomeUnchanged {
  action: 'unchanged';
  spec: string;
  sha256: string;
}

export interface UpgradeOutcomeUpdated {
  action: 'updated';
  spec: string;
  fromSha: string;
  toSha: string;
  fromVersion?: string;
  toVersion?: string;
  operationsAdded: string[];
  operationsRemoved: string[];
}

export interface UpgradeOutcomeSkipped {
  action: 'skipped';
  spec: string;
  reason: string;
}

export interface UpgradeOutcomeInstalled {
  action: 'installed';
  spec: string;
  toSha: string;
  toVersion?: string;
}

export interface UpgradeOutcomeFailed {
  action: 'failed';
  spec: string;
  error: string;
}

export type UpgradeOutcome =
  | UpgradeOutcomeUnchanged
  | UpgradeOutcomeUpdated
  | UpgradeOutcomeSkipped
  | UpgradeOutcomeInstalled
  | UpgradeOutcomeFailed;

export interface RemoveOutcome {
  removed: string[];
}

export interface ModuleError {
  code: string;
  message: string;
  file?: string;
  issues?: unknown[];
  details?: Record<string, unknown>;
}

export type Result<T, E = ModuleError> =
  | { ok: true; value: T }
  | { ok: false; error: E; code: string; message: string; file?: string; issues?: unknown[]; details?: Record<string, unknown> };

export interface ResolveOptions {
  root?: string;
}

export interface InstallOptions {
  root?: string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  timeoutMs?: number;
  maxBytes?: number;
  force?: boolean;
}

export interface ListOptions {
  root?: string;
}

export interface UpgradeOptions {
  root?: string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  to?: string;
}

export interface RemoveOptions {
  root?: string;
  allRefs?: boolean;
}

export interface MetaDocument {
  spec: string;
  url: string;
  sha256: string;
  fetched_at: string;
  ref?: string;
  tool: string;
  version?: string;
  bytes: number;
}

export function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

export function err<T = never>(
  code: string,
  message: string,
  extra: { file?: string; issues?: unknown[]; details?: Record<string, unknown> } = {},
): Result<T> {
  const error: ModuleError = { code, message, ...extra };
  return {
    ok: false,
    error,
    code,
    message,
    ...(extra.file ? { file: extra.file } : {}),
    ...(extra.issues ? { issues: extra.issues } : {}),
    ...(extra.details ? { details: extra.details } : {}),
  };
}
