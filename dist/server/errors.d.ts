/**
 * @fileoverview Standardized error codes and error class for the CLI wrappers.
 * Adapted (simplified) from git-mcp-server src/types-global/errors.ts:
 * MCP/JSON-RPC naming replaced with CLI-oriented naming, zod schema dropped.
 * @module @lmctl-ai/lmts/server/errors
 */
/**
 * Standard error codes surfaced in structured error envelopes.
 * Values are stable strings so callers never depend on numeric codes.
 */
export declare enum ErrorCode {
    InvalidRequest = "INVALID_REQUEST",
    ValidationError = "VALIDATION_ERROR",
    NotFound = "NOT_FOUND",
    Conflict = "CONFLICT",
    Forbidden = "FORBIDDEN",
    Timeout = "TIMEOUT",
    ReadOnlyViolation = "READONLY_VIOLATION",
    InternalError = "INTERNAL_ERROR",
    ServiceUnavailable = "SERVICE_UNAVAILABLE",
    CommandFailed = "COMMAND_FAILED",
    CommandNotFound = "COMMAND_NOT_FOUND",
    MissingConfirmation = "MISSING_CONFIRMATION",
    ParseError = "PARSE_ERROR",
    UnknownError = "UNKNOWN_ERROR"
}
/** Map error codes to process exit codes. */
export declare const EXIT_CODES: Record<ErrorCode, number>;
/**
 * Structured error thrown by all operations. The CLI runner converts it
 * into a JSON error envelope on stdout and a non-zero exit code.
 */
export declare class CliError extends Error {
    readonly code: ErrorCode;
    readonly data?: Record<string, unknown>;
    readonly exitCode: number;
    constructor(code: ErrorCode, message?: string, data?: Record<string, unknown>, options?: {
        cause?: unknown;
    });
}
/** Convert any thrown value into a CliError. */
export declare function toCliError(error: unknown, fallbackMessage?: string): CliError;
