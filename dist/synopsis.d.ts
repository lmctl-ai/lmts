/**
 * @fileoverview Pure string formatting helpers for parameter synopses and CLI usage lines.
 * @module @lmctl-ai/lmts/synopsis
 */
import type { OperationSchema, ParamSpec } from './types.js';
/** Convert camelCase to kebab-case (e.g. `maxFiles` -> `max-files`). */
export declare function toKebab(name: string): string;
/** Convert kebab-case to camelCase (e.g. `max-files` -> `maxFiles`). */
export declare function toCamel(name: string): string;
/** Check if a parameter is required based on its occurs mark. */
export declare function isRequired(p: ParamSpec): boolean;
/**
 * Build the synopsis fragment for a param (without [optional]), used in error messages.
 * Examples:
 *   --file <string>
 *   --state <string> one of: open, closed, all
 *   --ignored
 */
export declare function buildSynopsis(spec: ParamSpec): string;
/**
 * Derive a one-line synopsis for a param, used in error messages and docs.
 * Examples:
 *   --path <string> [optional]
 *   --state <string> one of: open, closed
 */
export declare function synopsisForParam(p: ParamSpec): string;
/**
 * Op usage line without or with the tool name: `[<tool>] <op> [<positional>] [flags]`.
 */
export declare function usageLine(schema: OperationSchema, toolName?: string): string;
