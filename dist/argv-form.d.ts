/**
 * @fileoverview Array-based argv (flags) form. The shell has already
 * tokenized argv, so each element is taken as-is: no joining, no lexing.
 * Value types come from the schema, never from the token shape. Produces a
 * raw typed record; required/enum checks are left to `validate()`.
 *
 * Rules:
 *   --k v | --k=v        value (may contain spaces, '=', JSON, or start with '-')
 *   --k                  boolean true (boolean / json params)
 *   --no-k               boolean false (boolean / json params)
 *   --k a --k b          accumulates for occurs '+'/'*' or type 'array'
 *   --                   ends flag parsing; the rest are positionals
 * @module @lmctl-ai/lmts/argv-form
 */
import type { OperationSchema, ParamSpec, Result } from './types.js';
export interface ArgvFormValue {
    params: Record<string, unknown>;
    positionals: string[];
    globals: Record<string, unknown>;
}
/** Loose literal coercion used for 'json' params and additionalParams. */
export declare function coerceJsonLiteral(raw: string): unknown;
/**
 * Parse an argv array (op name already removed) against an op schema.
 * Collects every issue instead of stopping at the first.
 */
export declare function parseArgvForm(argv: string[], schema: OperationSchema, globals?: ParamSpec[]): Result<ArgvFormValue>;
