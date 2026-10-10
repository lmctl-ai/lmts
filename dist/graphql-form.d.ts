/**
 * @fileoverview GraphQL-style input form. Accepts a small, documented subset:
 *
 *   mutation { opName(paramA: "x", paramB: [1,2], paramC: true) { __typename } }
 *   query { opName(paramA: "x") { __typename } }
 *   { opName(paramA: "x") { __typename } }
 *
 * The selection set is ignored; only the arguments are validated against the
 * op's schema. Variables and named operations are rejected.
 * @module @lmctl-ai/lmts/graphql-form
 */
import type { OperationSchema, Result } from './types.js';
export interface GraphqlInputDocument {
    op?: string;
    params: Record<string, unknown>;
}
/**
 * Parse a minimal GraphQL document returning a Result.
 * Variables and named operations are rejected.
 * Multiple top-level fields are rejected.
 * Null arguments are omitted so parameter defaults apply.
 */
export declare function parseGraphqlDocument(text: string): Result<GraphqlInputDocument>;
/** Throwing compat wrapper around parseGraphqlDocument. */
export declare function parseGraphqlInput(text: string): GraphqlInputDocument;
/** Validate against the op schema. */
export declare function validateGraphqlParams(schema: OperationSchema, doc: GraphqlInputDocument): Record<string, unknown>;
