/**
 * @fileoverview Pure string formatting helpers for parameter synopses and CLI usage lines.
 * @module @gitpoc/clischema/synopsis
 */

import type { OperationSchema, ParamSpec } from './types.js';

/** Convert camelCase to kebab-case (e.g. `maxFiles` -> `max-files`). */
export function toKebab(name: string): string {
  return name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
}

/** Convert kebab-case to camelCase (e.g. `max-files` -> `maxFiles`). */
export function toCamel(name: string): string {
  return name.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

/** Check if a parameter is required based on its occurs mark. */
export function isRequired(p: ParamSpec): boolean {
  return p.occurs === '1' || p.occurs === '+' || p.occurs === undefined;
}

/**
 * Build the synopsis fragment for a param (without [optional]), used in error messages.
 * Examples:
 *   --file <string>
 *   --state <string> one of: open, closed, all
 *   --ignored
 */
export function buildSynopsis(spec: ParamSpec): string {
  const flag = `--${toKebab(spec.name)}`;
  const elemType = spec.type === 'array' ? (spec.items ?? 'string') : spec.type;
  const typeHint = spec.type === 'boolean' ? '' : ` <${elemType}${spec.items ? ` of ${spec.items}` : ''}>`;
  const enumTag = spec.enum && spec.enum.length > 0 ? ` one of: ${spec.enum.join(', ')}` : '';
  return `${flag}${typeHint}${enumTag}`;
}

/**
 * Derive a one-line synopsis for a param, used in error messages and docs.
 * Examples:
 *   --path <string> [optional]
 *   --state <string> one of: open, closed
 */
export function synopsisForParam(p: ParamSpec): string {
  const flag = `--${toKebab(p.name)}`;
  const elemType = p.type === 'array' ? (p.items ?? 'string') : p.type;
  const typeHint = p.type === 'boolean' ? '' : ` <${elemType}${p.items ? ` of ${p.items}` : ''}>`;
  const req = isRequired(p) ? '' : ' [optional]';
  const enumTag = p.enum && p.enum.length > 0 ? ` one of: ${p.enum.join(', ')}` : '';
  return `${flag}${typeHint}${req}${enumTag}`;
}

/**
 * Op usage line without or with the tool name: `[<tool>] <op> [<positional>] [flags]`.
 */
export function usageLine(schema: OperationSchema, toolName?: string): string {
  const parts: string[] = [];
  if (toolName) {
    parts.push(toolName);
  }
  parts.push(schema.name);
  for (const p of schema.params) {
    if (p.positional === true) {
      parts.push(`[<${p.name}>]`);
    }
  }
  parts.push('[flags]');
  return parts.join(' ');
}
