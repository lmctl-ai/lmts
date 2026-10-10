/**
 * @fileoverview Command-line interpreter and classifier for LLM-produced CLI calls.
 * Provides safe lexical tokenization, strict command validation against published schemas,
 * effect classification ('read' | 'effectful'), and compact LLM prompt generation.
 *
 * PURE SDK module: zero external dependencies, no Node or process globals.
 * @module @lmctl-ai/lmts/interpret
 */
import type { Interpreted, OperationSchema, ParamSpec, PublishedCliSchema, Result } from './types.js';
export { type Interpreted } from './types.js';
/**
 * Tokenize a single command line into an argv array.
 *
 * Rules:
 * - POSIX-style quoting: single quotes literal; double quotes with backslash escaping
 *   only of `"` and `\`.
 * - In double quotes, `$` and backtick (`` ` ``) are strictly REFUSED.
 * - Backslash escapes outside quotes.
 * - Whitespace separated.
 * - REFUSES (code SHELL_SYNTAX): unquoted `; & | < > ( ) { } $ \``, newline/CR/NUL,
 *   unterminated quote, unquoted globs `* ? [`, words starting with unquoted `~`,
 *   leading `NAME=value` env assignment words, and `#` comment starts at word start.
 * - Quoted forms pass through literally; never expands anything.
 */
export declare function tokenizeSimpleCommand(line: string): Result<string[]>;
/**
 * Classify operation effect as 'read' or 'effectful'.
 * Returns 'read' only when op.access === 'read'.
 * Missing access, write, and dynamic are all classified as 'effectful'.
 *
 * Security invariant: A schema cannot upgrade itself to read-only;
 * dynamic access or missing access must always be treated as effectful.
 */
export declare function classifyOperation(op: OperationSchema): 'read' | 'effectful';
/**
 * Interpret and validate an LLM-produced command line against one or more published CLI schemas.
 * Never executes a shell; parses, validates, and classifies the command deterministically.
 */
export declare function interpretCommand(schemas: PublishedCliSchema | PublishedCliSchema[], line: string, opts?: {
    globals?: ParamSpec[];
}): Result<Interpreted>;
/**
 * Render a compact, deterministic text description of CLI schemas for LLM prompts.
 * Includes per-tool header, per-op synopsis line with effect tag and description,
 * and 3 lines of execution rules.
 */
export declare function describeForPrompt(schemas: PublishedCliSchema | PublishedCliSchema[]): string;
