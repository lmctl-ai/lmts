/**
 * @fileoverview Structured JSON output for all tool results and errors.
 *
 * Success responses print the operation result as a single JSON document.
 * Errors print a structured error envelope to stdout (never plain stderr
 * text, so callers never scrape logs) and set a non-zero exit code.
 * @module @lmctl-ai/lmts/server/output
 */
import { toCliError } from './errors.js';
/** Serialize a successful result to stdout. */
export function printResult(result) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}
/** Serialize an error envelope to stdout. */
export function printError(error) {
    const err = toCliError(error);
    const envelope = {
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
export function exitCodeFor(error) {
    const err = toCliError(error);
    return err.exitCode;
}
