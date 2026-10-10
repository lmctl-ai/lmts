/**
 * @fileoverview Type definitions for CLI schemas, parameters, and validation.
 * @module @lmctl-ai/lmts/types
 */
export const RESERVED_NAMES = new Set(['__proto__', 'constructor', 'prototype']);
export function isReservedName(name) {
    return RESERVED_NAMES.has(name);
}
