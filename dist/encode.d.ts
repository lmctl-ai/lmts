/**
 * @fileoverview Client-side encoders: params -> argv array / JSON document /
 * GraphQL document, each the inverse of the matching server-side parser
 * (`parseArgvForm`, `parseJsonInput`, `parseGraphqlInput`). Depends on types
 * only, so it is safe for the consumer ("./validate") entry.
 *
 * Limitations of the argv form: an empty array cannot be expressed (it is
 * omitted), and a 'json'-typed param holding a string that looks like a
 * literal (e.g. "true", "12") is re-read as that literal.
 * @module @lmctl-ai/lmts/encode
 */
import type { OperationSchema } from './types.js';
export interface EncodeArgvOptions {
    /** Emit positional params as bare words after `--` instead of as flags. */
    positional?: boolean;
}
/**
 * Encode params as an argv array (op name not included). Values always use
 * the `--k=v` form so a value may start with '-' or contain anything.
 * Booleans use `--k` / `--no-k`; multi params repeat the flag. With
 * `positional`, positional params follow a `--` in schema order.
 */
export declare function encodeArgv(schema: OperationSchema, params: Record<string, unknown>, opts?: EncodeArgvOptions): string[];
/** Encode as a JSON envelope `{"op": name, "params": {...}}`. */
export declare function encodeJson(schema: OperationSchema, params: Record<string, unknown>): string;
/**
 * Encode as the inline-literal GraphQL subset accepted by `parseGraphqlInput`:
 * `query|mutation { op(arg: <literal>, …) { __typename } }`.
 */
export declare function encodeGraphql(schema: OperationSchema, params: Record<string, unknown>): string;
