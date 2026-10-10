/**
 * @fileoverview Schema validation core. Validates raw input records against an OperationSchema,
 * collecting all issues, applying defaults, enforcing types, enums, occurrences, and form constraints.
 * @module @lmctl-ai/lmts/validate
 */
import type { OperationSchema, Result, ValidationOptions } from './types.js';
export declare class SchemaValidationError extends Error {
    readonly operation: string;
    readonly details?: Record<string, unknown> | undefined;
    constructor(operation: string, message: string, details?: Record<string, unknown> | undefined);
}
export declare function toArrayValue(value: unknown): unknown[] | undefined;
/**
 * Validate a raw param record against an OperationSchema, collecting all issues.
 */
export declare function validate(schema: OperationSchema, raw: Record<string, unknown>, opts?: ValidationOptions): Result<Record<string, unknown>>;
/**
 * Compatibility throwing wrapper around validate().
 */
export declare function validateParams(schema: OperationSchema, raw: Record<string, unknown>): Record<string, unknown>;
