/**
 * @fileoverview Underlying product compatibility detection and verification.
 * Runs detect.argv through spawnCommand, extracts the version with pattern,
 * and checks range satisfaction. Caches per product per process.
 * @module @lmctl-ai/lmts/server/product
 */
import type { ProductInfo } from '../types.js';
import { ErrorCode } from './errors.js';
import { type ExecResult } from './exec.js';
export interface CheckProductVersionOptions {
    exec?: (command: string, args: string[], cwd: string, env: Record<string, string>, timeout?: number) => Promise<ExecResult>;
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
export type CheckProductVersionResult = CheckProductVersionSuccess | CheckProductVersionFailure;
/**
 * Clears the per-process product version detection cache.
 * Exported as a test hook.
 */
export declare function resetProductVersionCache(): void;
/**
 * Checks that the host environment satisfies the product's version requirements.
 * Resolves argv[0] from PATH, spawns it, extracts the version with pattern,
 * and validates using satisfies(found, product.supported).
 * Results are cached per process per product name.
 */
export declare function checkProductVersion(product: ProductInfo, options?: CheckProductVersionOptions): Promise<CheckProductVersionResult>;
