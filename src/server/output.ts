/**
 * @fileoverview Structured JSON output for all tool results and errors.
 *
 * Success responses print the operation result as a single JSON document.
 * Errors print a structured error envelope to stdout (never plain stderr
 * text, so callers never scrape logs) and set a non-zero exit code.
 * @module @lmctl-ai/lmts/server/output
 */

import { CliError, toCliError } from './errors.js';

export interface ErrorEnvelope {
  success: false;
  error: {
    code: string;
    message: string;
    data?: Record<string, unknown>;
  };
}

/** Serialize a successful result to stdout. */
export function printResult(result: unknown): void {
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}

/** Serialize an error envelope to stdout. */
export function printError(error: unknown): void {
  const err: CliError = toCliError(error);
  const envelope: ErrorEnvelope = {
    success: false,
    error: {
      code: err.code,
      message: err.message,
      ...(err.data ? { data: err.data } : {}),
    },
  };
  process.stdout.write(JSON.stringify(envelope, null, 2) + '\n');
}

/** Exit code for a thrown error (CliError carries its own code). */
export function exitCodeFor(error: unknown): number {
  const err = toCliError(error);
  return err.exitCode;
}
