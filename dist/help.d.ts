/**
 * @fileoverview Generate help text from a declared OperationSchema. The
 * schema is the single source of truth; help is derived, never hand-written.
 * @module @lmctl-ai/lmts/help
 */
import type { OperationSchema, ParamSpec } from './types.js';
export { synopsisForParam, toKebab, usageLine } from './synopsis.js';
/**
 * Render --help for one op, derived from the schema.
 *
 * Shape mirrors common CLI help: name + description, usage, flags section
 * (long form), required/optional split, and per-flag type hint with enum and
 * default. Output is meant to be stable and to round-trip against the schema.
 */
export declare function renderOpHelp(toolName: string, schema: OperationSchema): string;
/**
 * Render the top-level --help output for the whole tool: a summary line per
 * op derived from each op's schema.
 */
export declare function renderToolHelp(toolName: string, toolDescription: string | undefined, schemas: OperationSchema[], globals?: ParamSpec[]): string;
