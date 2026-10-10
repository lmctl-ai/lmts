/**
 * @fileoverview Structured JSON output for all tool results and errors.
 *
 * Success responses print the operation result as a single JSON document.
 * Errors print a structured error envelope to stdout (never plain stderr
 * text, so callers never scrape logs) and set a non-zero exit code.
 * @module @lmctl-ai/lmts/server/output
 */
export interface ErrorEnvelope {
    success: false;
    error: {
        code: string;
        message: string;
        data?: Record<string, unknown>;
    };
}
/** Serialize a successful result to stdout. */
export declare function printResult(result: unknown): void;
/** Serialize an error envelope to stdout. */
export declare function printError(error: unknown): void;
/** Exit code for a thrown error (CliError carries its own code). */
export declare function exitCodeFor(error: unknown): number;
