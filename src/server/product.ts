/**
 * @fileoverview Underlying product compatibility detection and verification.
 * Runs detect.argv through spawnCommand, extracts the version with pattern,
 * and checks range satisfaction. Caches per product per process.
 * @module @lmctl-ai/lmts/server/product
 */

import { accessSync, constants, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import type { ProductInfo } from '../types.js';
import { parseVersion, satisfies } from '../version.js';
import { ErrorCode } from './errors.js';
import { spawnCommand, type ExecResult } from './exec.js';

export interface CheckProductVersionOptions {
  exec?: (
    command: string,
    args: string[],
    cwd: string,
    env: Record<string, string>,
    timeout?: number,
  ) => Promise<ExecResult>;
  timeoutMs?: number;
  maxOutputBytes?: number;
  env?: NodeJS.ProcessEnv;
}

export interface CheckProductVersionSuccess {
  ok: true;
  found: string;
}

export interface CheckProductVersionFailure {
  ok: false;
  code: ErrorCode.UnsupportedProductVersion;
  message: string;
  data: {
    product: string;
    found: string | null;
    supported: string;
  };
}

export type CheckProductVersionResult =
  | CheckProductVersionSuccess
  | CheckProductVersionFailure;

const productVersionCache = new Map<string, CheckProductVersionResult>();

/**
 * Clears the per-process product version detection cache.
 * Exported as a test hook.
 */
export function resetProductVersionCache(): void {
  productVersionCache.clear();
}

const TOOL_NAME_REGEX = /^[a-z][a-z0-9_.-]*$/;

/**
 * Searches absolute PATH entries for an executable matching name.
 * Ignores relative entries, empty entries, and current working directory.
 */
function findExecutableOnPath(name: string, pathVar?: string): string | undefined {
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

/**
 * Checks that the host environment satisfies the product's version requirements.
 * Resolves argv[0] from PATH, spawns it, extracts the version with pattern,
 * and validates using satisfies(found, product.supported).
 * Results are cached per process per product name.
 */
export async function checkProductVersion(
  product: ProductInfo,
  options?: CheckProductVersionOptions,
): Promise<CheckProductVersionResult> {
  if (productVersionCache.has(product.name)) {
    return productVersionCache.get(product.name)!;
  }

  if (!product.detect || !Array.isArray(product.detect.argv) || product.detect.argv.length === 0) {
    const failure: CheckProductVersionFailure = {
      ok: false,
      code: ErrorCode.UnsupportedProductVersion,
      message: `Product "${product.name}" has no detection configuration`,
      data: {
        product: product.name,
        found: null,
        supported: product.supported,
      },
    };
    productVersionCache.set(product.name, failure);
    return failure;
  }

  const [cmdName, ...cmdArgs] = product.detect.argv;
  const pathVar = options?.env?.PATH ?? process.env.PATH;
  const binPath = findExecutableOnPath(cmdName!, pathVar);

  if (!binPath) {
    const failure: CheckProductVersionFailure = {
      ok: false,
      code: ErrorCode.UnsupportedProductVersion,
      message: `Product "${product.name}" executable "${cmdName}" not found on PATH`,
      data: {
        product: product.name,
        found: null,
        supported: product.supported,
      },
    };
    productVersionCache.set(product.name, failure);
    return failure;
  }

  const execFn =
    options?.exec ??
    ((cmd, args, cwd, env, timeout) =>
      spawnCommand(cmd, args, cwd, env, timeout, undefined, true));
  const timeoutMs = options?.timeoutMs ?? 3000;
  const maxBytes = options?.maxOutputBytes ?? 4096;

  const envMap: Record<string, string> = {};
  const srcEnv = options?.env ?? process.env;
  for (const [k, v] of Object.entries(srcEnv)) {
    if (v !== undefined) {
      envMap[k] = v;
    }
  }

  let execRes: ExecResult;
  try {
    execRes = await execFn(binPath, cmdArgs, process.cwd(), envMap, timeoutMs);
  } catch (err: any) {
    const failure: CheckProductVersionFailure = {
      ok: false,
      code: ErrorCode.UnsupportedProductVersion,
      message: `Failed to execute product detector for "${product.name}": ${err?.message ?? String(err)}`,
      data: {
        product: product.name,
        found: null,
        supported: product.supported,
      },
    };
    productVersionCache.set(product.name, failure);
    return failure;
  }

  const combinedOutput = `${execRes.stdout}\n${execRes.stderr}`.slice(0, maxBytes);

  let extracted: string | null = null;
  try {
    const re = new RegExp(product.detect.pattern);
    const match = combinedOutput.match(re);
    if (match && match[1] !== undefined) {
      extracted = match[1];
    }
  } catch {
    extracted = null;
  }

  if (!extracted) {
    const failure: CheckProductVersionFailure = {
      ok: false,
      code: ErrorCode.UnsupportedProductVersion,
      message: `Could not parse version for product "${product.name}" from detector output`,
      data: {
        product: product.name,
        found: null,
        supported: product.supported,
      },
    };
    productVersionCache.set(product.name, failure);
    return failure;
  }

  const parsed = parseVersion(extracted);
  if (!parsed) {
    const failure: CheckProductVersionFailure = {
      ok: false,
      code: ErrorCode.UnsupportedProductVersion,
      message: `Extracted version "${extracted}" for product "${product.name}" is not a valid semver version`,
      data: {
        product: product.name,
        found: null,
        supported: product.supported,
      },
    };
    productVersionCache.set(product.name, failure);
    return failure;
  }

  if (!satisfies(extracted, product.supported)) {
    const failure: CheckProductVersionFailure = {
      ok: false,
      code: ErrorCode.UnsupportedProductVersion,
      message: `Product "${product.name}" version ${extracted} does not satisfy supported range "${product.supported}"`,
      data: {
        product: product.name,
        found: extracted,
        supported: product.supported,
      },
    };
    productVersionCache.set(product.name, failure);
    return failure;
  }

  const success: CheckProductVersionSuccess = {
    ok: true,
    found: extracted,
  };
  productVersionCache.set(product.name, success);
  return success;
}
