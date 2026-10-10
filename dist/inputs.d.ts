/**
 * @fileoverview Unified runtime: given an op schema and the raw CLI input
 * mixture, resolve the effective params from (in precedence order):
 *
 *   1. --input-file / --input-json / --input-graphql (documented input)
 *   2. Command-line flags / positionals (array-based, via parseArgvForm)
 *
 * Documented inputs and CLI flags cannot be mixed on a single invocation
 * (enforced here).
 * @module @lmctl-ai/lmts/inputs
 */
import type { OperationSchema, ParamSpec } from './types.js';
export type InputKind = 'flags' | 'json' | 'graphql';
export interface ResolvedInput {
    /** Which input form produced the params. */
    kind: InputKind;
    /** Typed params, defaults applied, enum checked. */
    params: Record<string, unknown>;
}
export interface ResolveArgs {
    schema: OperationSchema;
    /** Raw CLI tokens after the op name (already split by the host shell). */
    argv?: string[];
    /** Runner-owned global flags; extracted from argv, never reported unknown. */
    globals?: ParamSpec[];
    /** Optional JSON document (from --input-file or --input-json). */
    jsonDocument?: string;
    /** Optional GraphQL document (from --input-graphql). */
    graphqlDocument?: string;
}
export declare function resolveInput(args: ResolveArgs): ResolvedInput;
