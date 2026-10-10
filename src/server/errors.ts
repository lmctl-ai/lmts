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
export enum ErrorCode {
  InvalidRequest = 'INVALID_REQUEST',
  ValidationError = 'VALIDATION_ERROR',
  NotFound = 'NOT_FOUND',
  Conflict = 'CONFLICT',
  Forbidden = 'FORBIDDEN',
  Timeout = 'TIMEOUT',
  ReadOnlyViolation = 'READONLY_VIOLATION',
  InternalError = 'INTERNAL_ERROR',
  ServiceUnavailable = 'SERVICE_UNAVAILABLE',
  CommandFailed = 'COMMAND_FAILED',
  CommandNotFound = 'COMMAND_NOT_FOUND',
  MissingConfirmation = 'MISSING_CONFIRMATION',
  ParseError = 'PARSE_ERROR',
  UnknownError = 'UNKNOWN_ERROR',
}

/** Map error codes to process exit codes. */
export const EXIT_CODES: Record<ErrorCode, number> = {
  [ErrorCode.InvalidRequest]: 2,
  [ErrorCode.ValidationError]: 2,
  [ErrorCode.NotFound]: 4,
  [ErrorCode.Conflict]: 5,
  [ErrorCode.Forbidden]: 6,
  [ErrorCode.ReadOnlyViolation]: 6,
  [ErrorCode.Timeout]: 7,
  [ErrorCode.InternalError]: 1,
  [ErrorCode.ServiceUnavailable]: 8,
  [ErrorCode.CommandFailed]: 1,
  [ErrorCode.CommandNotFound]: 127,
  [ErrorCode.MissingConfirmation]: 9,
  [ErrorCode.ParseError]: 3,
  [ErrorCode.UnknownError]: 1,
};

/**
 * Structured error thrown by all operations. The CLI runner converts it
 * into a JSON error envelope on stdout and a non-zero exit code.
 */
export class CliError extends Error {
  public readonly code: ErrorCode;
  public readonly data?: Record<string, unknown>;
  public readonly exitCode: number;

  constructor(
    code: ErrorCode,
    message?: string,
    data?: Record<string, unknown>,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'CliError';
    this.code = code;
    if (data) {
      this.data = data;
    }
    this.exitCode = EXIT_CODES[code] ?? 1;
    Object.setPrototypeOf(this, CliError.prototype);
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, CliError);
    }
  }
}

/** Convert any thrown value into a CliError. */
export function toCliError(error: unknown, fallbackMessage = 'Unknown error'): CliError {
  if (error instanceof CliError) {
    return error;
  }
  if (error instanceof Error) {
    return new CliError(ErrorCode.UnknownError, error.message || fallbackMessage, undefined, {
      cause: error,
    });
  }
  return new CliError(ErrorCode.UnknownError, String(error) || fallbackMessage);
}
