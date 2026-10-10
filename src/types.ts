/**
 * @fileoverview Type definitions for CLI schemas, parameters, and validation.
 * @module @lmctl-ai/lmts/types
 */

export type ParamType = 'string' | 'number' | 'boolean' | 'object' | 'array' | 'json';

export type ParamOccurs = '1' | '?' | '+' | '*';

export interface ParamSpec {
  /** Camel-case param name (as exposed on the CLI). */
  name: string;
  /** Transport or element type. */
  type: ParamType;
  /**
   * Cardinality / presence:
   * '1' = exactly one (required, default)
   * '?' = zero or one (optional)
   * '+' = one or more (array, required)
   * '*' = zero or more (array, optional)
   */
  occurs?: ParamOccurs;
  /** Default value applied during validation if omitted. */
  default?: unknown;
  /** Allowed string or numeric values for enum validation. */
  enum?: Array<string | number>;
  /** Positional index (0-based) for flags form. */
  positional?: boolean;
  /** Array item type when type === 'array'. */
  items?: 'string' | 'number' | 'boolean' | 'object';
  /** Human-readable explanation for help output. */
  description?: string;
  /** CLI flag aliases, e.g. ['dry-run']. */
  aliases?: string[];
  /** Hidden from CLI flags (e.g. envelope-only metadata). */
  cliOnly?: boolean;
  /** Documentation-only (not validated, for help). */
  docOnly?: boolean;
  /** Auto-generated / derived from an untyped op. */
  derived?: boolean;
}

export type OperationReturnType = 'object' | 'array' | 'string' | 'number' | 'boolean' | 'null';

export interface OperationSchema {
  name: string;
  access?: 'read' | 'write' | 'dynamic';
  returns?: OperationReturnType;
  description?: string;
  params: ParamSpec[];
  additionalParams?: boolean;
}

export interface PublishedCliSchema {
  /** Document version tag (bump on breaking shape changes). */
  schema: 'cli.schema.v1';
  /** Tool name, e.g. 'git2'. */
  tool: string;
  /** Tool version, when known. */
  version?: string;
  /** Global policy flags understood by the tool. */
  policy: {
    dryrun: boolean;
    readonly: boolean;
  };
  /** Input forms understood per op (all, when an op has a schema). */
  inputs: Array<'flags' | 'json' | 'graphql'>;
  /** Global flags declared by the tool / runner. */
  globals?: ParamSpec[];
  /** Declared operations. */
  operations: OperationSchema[];
  /** Optional documentation warnings (missing descriptions). */
  warnings?: string[];
}

export const RESERVED_NAMES = new Set<string>(['__proto__', 'constructor', 'prototype']);

export function isReservedName(name: string): boolean {
  return RESERVED_NAMES.has(name);
}

export type ValidationIssueCode =
  | 'UNKNOWN_PARAM'
  | 'MISSING_REQUIRED'
  | 'TYPE_MISMATCH'
  | 'ENUM_VIOLATION'
  | 'FORM_NOT_ALLOWED'
  | 'MISSING_VALUE'
  | 'EXTRA_POSITIONAL'
  | 'DOCUMENT_PARSE'
  | 'OP_MISMATCH'
  | 'MIXED_INPUT'
  | 'DUPLICATE_FLAG'
  | 'RESERVED_NAME'
  | 'SHELL_SYNTAX'
  | 'UNKNOWN_TOOL'
  | 'UNKNOWN_OPERATION'
  | 'FLAG_BEFORE_OP';

export interface ValidationIssue {
  code: ValidationIssueCode;
  message: string;
  op?: string;
  param?: string;
  synopsis: string;
  usage: string;
  received?: unknown;
  allowed?: unknown[];
  suggestion?: string;
  argvIndex?: number;
  offset?: number;
}

export interface ValidationOptions {
  form?: 'flags' | 'json' | 'graphql';
}

export interface Interpreted {
  tool: string;
  op: string;
  argv: string[];
  params: Record<string, unknown>;
  positionals: string[];
  globals: Record<string, unknown>;
  effect: 'read' | 'effectful';
  access: 'read' | 'write' | 'dynamic' | undefined;
}

export type Result<T> = { ok: true; value: T } | { ok: false; issues: ValidationIssue[] };

