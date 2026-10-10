/**
 * @fileoverview Generate help text from a declared OperationSchema. The
 * schema is the single source of truth; help is derived, never hand-written.
 * @module @lmctl-ai/lmts/help
 */

import type { OperationSchema, ParamSpec } from './types.js';
import { isRequired, toKebab } from './synopsis.js';
export { synopsisForParam, toKebab, usageLine } from './synopsis.js';


/**
 * Render --help for one op, derived from the schema.
 *
 * Shape mirrors common CLI help: name + description, usage, flags section
 * (long form), required/optional split, and per-flag type hint with enum and
 * default. Output is meant to be stable and to round-trip against the schema.
 */
export function renderOpHelp(toolName: string, schema: OperationSchema): string {
  const lines: string[] = [];
  lines.push(`${toolName} ${schema.name}`);
  if (schema.description) lines.push('', schema.description);
  if (schema.access) lines.push('', `Access: ${schema.access}`);

  // Usage line
  const usageParts: string[] = [`${toolName} ${schema.name}`];

  // 1. Positional parameters first
  const positionalParams = schema.params.filter((p) => p.positional === true);
  for (const p of positionalParams) {
    const occurs = p.occurs ?? '1';
    if (occurs === '1') {
      usageParts.push(`<${p.name}>`);
    } else if (occurs === '?') {
      usageParts.push(`[${p.name}]`);
    } else if (occurs === '+') {
      usageParts.push(`<${p.name}>...`);
    } else if (occurs === '*') {
      usageParts.push(`[${p.name}]...`);
    }
  }

  // 2. Flag parameters
  const flagParams = schema.params.filter((p) => p.positional !== true);
  for (const p of flagParams) {
    const flag = `--${toKebab(p.name)}`;
    const elemType = p.type === 'array' ? (p.items ?? 'string') : p.type;
    const valueHint = p.type === 'boolean' ? '' : ` <${elemType}>`;
    const item = `${flag}${valueHint}`;
    const occurs = p.occurs ?? '1';
    if (occurs === '1') {
      usageParts.push(item);
    } else if (occurs === '?') {
      usageParts.push(`[${item}]`);
    } else if (occurs === '+') {
      usageParts.push(`${item}...`);
    } else if (occurs === '*') {
      usageParts.push(`[${item}]...`);
    }
  }
  lines.push('', 'Usage:', `  ${usageParts.join(' ')}`);

  if (schema.params.length > 0) {
    lines.push('', 'Options:');
    for (const p of schema.params) {
      const flag = `--${toKebab(p.name)}`;
      const elemType = p.type === 'array' ? (p.items ?? 'string') : p.type;
      const isRepeated = p.occurs === '+' || p.occurs === '*';
      const typeHint = p.type === 'boolean' ? '' : ` <${elemType}${p.items ? ` of ${p.items}` : ''}>${isRepeated ? '...' : ''}`;
      const tag = p.positional === true ? ' [positional]' : '';
      const aliasTag = p.aliases && p.aliases.length > 0
        ? ` (aliases: ${p.aliases.map((a) => (a.startsWith('-') ? a : a.length === 1 ? `-${a}` : `--${toKebab(a)}`)).join(', ')})`
        : '';
      const enumTag = p.enum && p.enum.length > 0 ? ` one of: ${p.enum.join(', ')}` : '';
      const defaultTag = p.default !== undefined ? ` (default: ${JSON.stringify(p.default)})` : '';
      const requiredTag = isRequired(p) ? ' [required]' : '';
      const description = p.description ? `  ${p.description}` : '';
      lines.push(`  ${flag}${typeHint}${tag}${requiredTag}${enumTag}${defaultTag}${aliasTag}${description}`);
    }
  }

  return lines.join('\n') + '\n';
}

/**
 * Render the top-level --help output for the whole tool: a summary line per
 * op derived from each op's schema.
 */
export function renderToolHelp(
  toolName: string,
  toolDescription: string | undefined,
  schemas: OperationSchema[],
  globals?: ParamSpec[],
): string {
  const lines: string[] = [];
  lines.push(`${toolName} — structured CLI wrapper`);
  if (toolDescription) lines.push('', toolDescription);
  lines.push(
    '',
    'Usage:',
    `  ${toolName} <operation> [options]`,
  );

  if (globals && globals.length > 0) {
    lines.push('', 'Global options:');
    for (const g of globals) {
      const flag = `--${toKebab(g.name)}`;
      const aliasStr = g.aliases && g.aliases.length > 0
        ? ` (${g.aliases.map((a) => (a.startsWith('-') ? a : a.length === 1 ? `-${a}` : `--${toKebab(a)}`)).join(', ')})`
        : '';
      const desc = g.description ? `  ${g.description}` : '';
      lines.push(`  ${(flag + aliasStr).padEnd(20)}${desc}`);
    }
  }

  lines.push(
    '',
    'Input forms (when the op declares a schema):',
    '  --flag value                command-line flags',
    '  --input-json \'<json>\'      --input-file <path>      JSON document',
    '  --input-graphql \'<doc>\'                              GraphQL document',
    '',
    'Operations (name [access] — description):',
  );
  for (const s of schemas) {
    const access = s.access ?? 'read';
    const firstLineDesc = s.description ? s.description.split('\n')[0]?.trim() : '';
    lines.push(
      `  ${s.name.padEnd(24)} [${access}]${firstLineDesc ? '  ' + firstLineDesc : ''}`,
    );
  }
  return lines.join('\n') + '\n';
}

