/**
 * @fileoverview Publish a tool's operation schemas as a single discoverable
 * document. Think of this shape as "Swagger for CLI": a consumer can fetch
 * it, validate input against it, and generate documentation from it.
 *
 * Document version: cli.schema.v1
 * @module @lmctl-ai/lmts/publish
 */
import type { OperationSchema, ParamSpec, PublishedCliSchema, Result } from './types.js';
export type { PublishedCliSchema } from './types.js';
export interface PublishOptions {
    version?: string;
    globals?: ParamSpec[];
    inputs?: Array<'flags' | 'json' | 'graphql'>;
    policy?: {
        dryrun: boolean;
        readonly: boolean;
    };
    toolDescription?: string;
}
/**
 * Build the publishable document for a tool. Callers pass every op that
 * declares a schema.
 */
export declare function publishSchema(tool: string, operations: OperationSchema[], opts?: PublishOptions): PublishedCliSchema;
/**
 * Detect missing descriptions on operations, params, and globals.
 * Populates `doc.warnings` and returns the warnings array.
 */
export declare function schemaWarnings(doc: PublishedCliSchema): string[];
/**
 * Validate that an arbitrary object is a well-formed PublishedCliSchema.
 * Returns a Result with all issues found during structural validation.
 */
export declare function parsePublishedSchema(value: unknown): Result<PublishedCliSchema>;
/**
 * Throwing compat wrapper around parsePublishedSchema.
 */
export declare function parsePublishedSchemaOrThrow(value: unknown): PublishedCliSchema;
/**
 * Look up an op in a published document.
 */
export declare function findOperation(doc: PublishedCliSchema, name: string): OperationSchema | undefined;
