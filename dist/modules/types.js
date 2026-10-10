/**
 * @fileoverview Type definitions for the lmapi module store (@lmctl-ai/lmts/modules).
 * Defines module specs, cache entries, outcomes, channels, and Result types.
 */
export function ok(value) {
    return { ok: true, value };
}
export function err(code, message, extra = {}) {
    const error = { code, message, ...extra };
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
