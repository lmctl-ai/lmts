/**
 * @fileoverview JSON input form. Accepts either a raw JSON object mapping
 * param names to values, or an envelope { op, params }. Always validated
 * against the op's schema.
 * @module @lmctl-ai/lmts/json-form
 */
import type { OperationSchema, Result } from './types.js';
export interface JsonInputDocument {
    /** Optional envelope: { op: "status", params: {...} }. */
    op?: string;
    params: Record<string, unknown>;
}
/**
 * Parse a JSON document string into op and params.
 * The { op, params } envelope is recognised ONLY when an `op` key is present
 * and is a string; otherwise the whole object is treated as bare params.
 */
export declare function parseJsonDocument(text: string): Result<JsonInputDocument>;
/** Throwing compat wrapper around parseJsonDocument. */
export declare function parseJsonInput(text: string): JsonInputDocument;
/** Validate the params against the op schema. */
export declare function validateJsonParams(schema: OperationSchema, doc: JsonInputDocument): Record<string, unknown>;
