/**
 * @fileoverview Command-line interpreter and classifier for LLM-produced CLI calls.
 * Provides safe lexical tokenization, strict command validation against published schemas,
 * effect classification ('read' | 'effectful'), and compact LLM prompt generation.
 *
 * PURE SDK module: zero external dependencies, no Node or process globals.
 * @module @gitpoc/clischema/interpret
 */

import type {
  Interpreted,
  OperationSchema,
  ParamSpec,
  PublishedCliSchema,
  Result,
  ValidationIssue,
} from './types.js';
import { isReservedName } from './types.js';
import { isEffectful } from './schema.js';
import { parseArgvForm } from './argv-form.js';
import { validate } from './validate.js';
import { toKebab } from './synopsis.js';

export { type Interpreted } from './types.js';

/**
 * Standard Levenshtein edit distance for spelling suggestions.
 */
function levenshtein(a: string, b: string): number {
  const dp: number[] = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0]!;
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j]!;
      dp[j] = Math.min(dp[j]! + 1, dp[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[b.length]!;
}

const DEFAULT_SYNOPSIS = '<tool> <operation> [flags]';
const DEFAULT_USAGE = '<tool> <operation> [flags]';

/**
 * Set of characters that are dangerous shell operators/characters outside of quotes.
 */
const REFUSED_OUTSIDE_CHARS = new Set<string>([
  ';',
  '&',
  '|',
  '<',
  '>',
  '(',
  ')',
  '{',
  '}',
  '$',
  '`',
  '*',
  '?',
  '[',
]);

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
export function tokenizeSimpleCommand(line: string): Result<string[]> {
  const issues: ValidationIssue[] = [];

  const addSyntaxIssue = (message: string): void => {
    issues.push({
      code: 'SHELL_SYNTAX',
      message: `${message}; quote it or send one simple command`,
      synopsis: DEFAULT_SYNOPSIS,
      usage: DEFAULT_USAGE,
    });
  };

  // Immediate check for line breaks or NUL characters
  if (/[\r\n\0]/.test(line)) {
    addSyntaxIssue('newline, carriage return, or NUL character');
    return { ok: false, issues };
  }

  const tokens: string[] = [];
  let current = '';
  let inToken = false;
  let mode: 'normal' | 'single' | 'double' = 'normal';
  let isWordStart = true;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;

    if (mode === 'single') {
      if (ch === "'") {
        mode = 'normal';
      } else {
        current += ch;
      }
      continue;
    }

    if (mode === 'double') {
      if (ch === '"') {
        mode = 'normal';
      } else if (ch === '$') {
        if (i + 1 < line.length && line[i + 1] === '(') {
          addSyntaxIssue('command substitution "$(...)" inside double quotes');
          i++;
        } else {
          addSyntaxIssue('variable expansion "$" inside double quotes');
        }
      } else if (ch === '`') {
        addSyntaxIssue('backtick command substitution "`" inside double quotes');
      } else if (ch === '\\') {
        if (i + 1 >= line.length) {
          addSyntaxIssue('unterminated escape in double quotes');
        } else {
          const next = line[i + 1]!;
          if (next === '"' || next === '\\') {
            current += next;
            i++;
          } else if (next === '$') {
            addSyntaxIssue('variable expansion "$" inside double quotes');
            i++;
          } else if (next === '`') {
            addSyntaxIssue('backtick command substitution "`" inside double quotes');
            i++;
          } else {
            // POSIX: backslash before other characters inside double quotes is preserved literally
            current += '\\' + next;
            i++;
          }
        }
      } else {
        current += ch;
      }
      continue;
    }

    // mode === 'normal'
    if (ch === ' ' || ch === '\t') {
      if (inToken) {
        tokens.push(current);
        current = '';
        inToken = false;
      }
      isWordStart = true;
      continue;
    }

    // Word start checks
    if (isWordStart) {
      if (ch === '#') {
        addSyntaxIssue('shell comment starting with "#"');
        break; // Ignore rest of line or stop with issue
      }
      if (ch === '~') {
        addSyntaxIssue('tilde expansion "~"');
        isWordStart = false;
        inToken = true;
        continue;
      }
    }

    // Quotes
    if (ch === "'") {
      inToken = true;
      mode = 'single';
      isWordStart = false;
      continue;
    }

    if (ch === '"') {
      inToken = true;
      mode = 'double';
      isWordStart = false;
      continue;
    }

    // Backslash outside quotes
    if (ch === '\\') {
      inToken = true;
      isWordStart = false;
      if (i + 1 >= line.length) {
        addSyntaxIssue('unterminated backslash escape at end of line');
      } else {
        const next = line[i + 1]!;
        if (REFUSED_OUTSIDE_CHARS.has(next)) {
          addSyntaxIssue(`shell character "${next}"`);
          i++;
        } else {
          current += next;
          i++;
        }
      }
      continue;
    }

    // Refused unquoted characters
    if (REFUSED_OUTSIDE_CHARS.has(ch)) {
      if (ch === '&' && i + 1 < line.length && line[i + 1] === '&') {
        addSyntaxIssue('shell operator "&&"');
        i++;
      } else if (ch === '|' && i + 1 < line.length && line[i + 1] === '|') {
        addSyntaxIssue('shell operator "||"');
        i++;
      } else if (ch === '>' && i + 1 < line.length && line[i + 1] === '>') {
        addSyntaxIssue('redirection operator ">>"');
        i++;
      } else if (ch === '<' && i + 1 < line.length && line[i + 1] === '<') {
        addSyntaxIssue('redirection operator "<<"');
        i++;
      } else if (ch === '$' && i + 1 < line.length && line[i + 1] === '(') {
        addSyntaxIssue('command substitution "$(...)"');
        i++;
      } else if (ch === ';' || ch === '&' || ch === '|') {
        addSyntaxIssue(`shell operator "${ch}"`);
      } else if (ch === '<' || ch === '>') {
        addSyntaxIssue(`redirection operator "${ch}"`);
      } else if (ch === '(' || ch === ')') {
        addSyntaxIssue(`subshell operator "${ch}"`);
      } else if (ch === '{' || ch === '}') {
        addSyntaxIssue(`brace operator "${ch}"`);
      } else if (ch === '$') {
        addSyntaxIssue('variable expansion or subshell "$"');
      } else if (ch === '`') {
        addSyntaxIssue('backtick command substitution "`"');
      } else if (ch === '*' || ch === '?' || ch === '[') {
        addSyntaxIssue(`glob pattern "${ch}"`);
      }
      inToken = true;
      isWordStart = false;
      continue;
    }

    // Regular character
    inToken = true;
    current += ch;
    isWordStart = false;
  }

  if (mode === 'single') {
    addSyntaxIssue('unterminated single quote');
  } else if (mode === 'double') {
    addSyntaxIssue('unterminated double quote');
  }

  if (inToken) {
    tokens.push(current);
  }

  // Refuse leading NAME=value environment assignment word
  if (tokens.length > 0 && /^[a-zA-Z_][a-zA-Z0-9_]*=/.test(tokens[0]!)) {
    addSyntaxIssue(`leading environment assignment "${tokens[0]}"`);
  }

  if (issues.length > 0) {
    return { ok: false, issues };
  }

  return { ok: true, value: tokens };
}

/**
 * Classify operation effect as 'read' or 'effectful'.
 * Returns 'read' only when op.access === 'read'.
 * Missing access, write, and dynamic are all classified as 'effectful'.
 *
 * Security invariant: A schema cannot upgrade itself to read-only;
 * dynamic access or missing access must always be treated as effectful.
 */
export function classifyOperation(op: OperationSchema): 'read' | 'effectful' {
  return isEffectful(op) ? 'effectful' : 'read';
}

/**
 * Interpret and validate an LLM-produced command line against one or more published CLI schemas.
 * Never executes a shell; parses, validates, and classifies the command deterministically.
 */
export function interpretCommand(
  schemas: PublishedCliSchema | PublishedCliSchema[],
  line: string,
  opts?: { globals?: ParamSpec[] },
): Result<Interpreted> {
  const schemaList = Array.isArray(schemas) ? schemas : [schemas];
  const knownTools = schemaList.map((s) => s.tool);
  const toolsUsage = knownTools.length > 0
    ? knownTools.map((t) => `${t} <op> [flags]`).join(' | ')
    : DEFAULT_USAGE;

  // Step 1: Tokenize
  const tokResult = tokenizeSimpleCommand(line);
  if (!tokResult.ok) {
    return { ok: false, issues: tokResult.issues };
  }
  const tokens = tokResult.value;

  if (tokens.length === 0) {
    return {
      ok: false,
      issues: [
        {
          code: 'UNKNOWN_TOOL',
          message: `empty command; expected a tool name. Available tools: ${knownTools.join(', ')}`,
          synopsis: toolsUsage,
          usage: toolsUsage,
        },
      ],
    };
  }

  // Step 2: First token must match tool exactly
  const toolName = tokens[0]!;
  const toolSchema = schemaList.find((s) => s.tool === toolName);

  if (!toolSchema) {
    let suggestion: string | undefined;
    let minDistance = 3;
    for (const t of knownTools) {
      const d = levenshtein(toolName, t);
      if (d < minDistance) {
        minDistance = d;
        suggestion = t;
      }
    }

    return {
      ok: false,
      issues: [
        {
          code: 'UNKNOWN_TOOL',
          message: `unknown tool "${toolName}". Available tools: ${knownTools.join(', ')}`,
          synopsis: toolsUsage,
          usage: toolsUsage,
          ...(suggestion ? { suggestion } : {}),
        },
      ],
    };
  }

  const opNames = toolSchema.operations.map((o) => o.name);
  const toolUsage = `${toolSchema.tool} <op> [flags] (available operations: ${opNames.join(', ')})`;

  // Step 3: Second token must be an operation of that tool
  if (tokens.length < 2) {
    return {
      ok: false,
      issues: [
        {
          code: 'UNKNOWN_OPERATION',
          message: `missing operation for tool "${toolSchema.tool}". Available operations: ${opNames.join(', ')}`,
          synopsis: toolUsage,
          usage: toolUsage,
        },
      ],
    };
  }

  const secondToken = tokens[1]!;

  // If the first token after the tool is a flag (e.g. git2 --schema), return a specific issue
  if (secondToken.startsWith('-')) {
    return {
      ok: false,
      issues: [
        {
          code: 'FLAG_BEFORE_OP',
          message: `flag "${secondToken}" provided where an operation name was expected; specify an operation before flags. Available operations: ${opNames.join(', ')}`,
          synopsis: toolUsage,
          usage: toolUsage,
        },
      ],
    };
  }

  const opSchema = toolSchema.operations.find((o) => o.name === secondToken);
  if (!opSchema) {
    let suggestion: string | undefined;
    let minDistance = 3;
    for (const o of toolSchema.operations) {
      const d = levenshtein(secondToken, o.name);
      if (d < minDistance) {
        minDistance = d;
        suggestion = o.name;
      }
    }

    return {
      ok: false,
      issues: [
        {
          code: 'UNKNOWN_OPERATION',
          message: `unknown operation "${secondToken}" for tool "${toolSchema.tool}". Available operations: ${opNames.join(', ')}`,
          op: secondToken,
          synopsis: toolUsage,
          usage: toolUsage,
          ...(suggestion ? { suggestion } : {}),
        },
      ],
    };
  }

  // Step 4: Parse argv form
  const rest = tokens.slice(2);
  const globalsMap = new Map<string, ParamSpec>();
  for (const g of toolSchema.globals ?? []) {
    globalsMap.set(g.name, g);
  }
  for (const g of opts?.globals ?? []) {
    globalsMap.set(g.name, g);
  }
  const combinedGlobals = Array.from(globalsMap.values());

  const argvResult = parseArgvForm(rest, opSchema, combinedGlobals);
  const issues: ValidationIssue[] = [];

  if (!argvResult.ok) {
    issues.push(...argvResult.issues);
  }

  // Step 5: Validate params
  const rawParams = argvResult.ok ? argvResult.value.params : Object.create(null);
  const valResult = validate(opSchema, rawParams, { form: 'flags' });

  if (!valResult.ok) {
    issues.push(...valResult.issues);
  }

  if (issues.length > 0 || !valResult.ok || !argvResult.ok) {
    return { ok: false, issues };
  }

  // Step 6: Classification & Safe result construction
  const effect = classifyOperation(opSchema);
  const access = opSchema.access;

  const safeParams: Record<string, unknown> = Object.create(null);
  for (const [k, v] of Object.entries(valResult.value)) {
    if (!isReservedName(k)) {
      safeParams[k] = v;
    }
  }

  const safeGlobals: Record<string, unknown> = Object.create(null);
  for (const [k, v] of Object.entries(argvResult.value.globals)) {
    if (!isReservedName(k)) {
      safeGlobals[k] = v;
    }
  }

  return {
    ok: true,
    value: {
      tool: toolSchema.tool,
      op: opSchema.name,
      argv: tokens,
      params: safeParams,
      positionals: argvResult.ok ? argvResult.value.positionals : [],
      globals: safeGlobals,
      effect,
      access,
    },
  };
}

/**
 * Format a parameter specification for compact LLM prompt rendering.
 */
function formatParamForPrompt(p: ParamSpec): string {
  const isPositional = p.positional === true;
  const occurs = p.occurs ?? '1';
  const kebabName = toKebab(p.name);
  const isList = p.type === 'array' || occurs === '+' || occurs === '*';
  const isOptional = occurs === '?' || occurs === '*';

  if (isPositional) {
    const base = isOptional ? `[${p.name}]` : `<${p.name}>`;
    return isList ? `${base}...` : base;
  }

  // Determine type hint / enum hint
  let typeHint = '';
  if (p.enum && p.enum.length > 0) {
    typeHint = `<${p.enum.join('|')}>`;
  } else if (p.type === 'array') {
    typeHint = `<${p.items ?? 'string'}>...`;
  } else if (p.type !== 'boolean') {
    typeHint = `<${p.type}>`;
  }

  const flag = `--${kebabName}`;
  const flagWithVal = typeHint ? `${flag} ${typeHint}` : flag;

  return isOptional ? `[${flagWithVal}]` : flagWithVal;
}

/**
 * Render a compact, deterministic text description of CLI schemas for LLM prompts.
 * Includes per-tool header, per-op synopsis line with effect tag and description,
 * and 3 lines of execution rules.
 */
export function describeForPrompt(schemas: PublishedCliSchema | PublishedCliSchema[]): string {
  const schemaList = (Array.isArray(schemas) ? [...schemas] : [schemas]).sort((a, b) =>
    a.tool.localeCompare(b.tool),
  );

  const lines: string[] = [];

  for (const s of schemaList) {
    lines.push(`# ${s.tool}`);

    const sortedOps = [...s.operations].sort((a, b) => a.name.localeCompare(b.name));
    for (const op of sortedOps) {
      const positionals = op.params.filter((p) => p.positional === true);
      const flags = op.params
        .filter((p) => p.positional !== true)
        .sort((a, b) => toKebab(a.name).localeCompare(toKebab(b.name)));

      const paramParts: string[] = [];
      for (const p of positionals) {
        paramParts.push(formatParamForPrompt(p));
      }
      for (const p of flags) {
        paramParts.push(formatParamForPrompt(p));
      }

      const opLineParts = [`${s.tool} ${op.name}`];
      if (paramParts.length > 0) {
        opLineParts.push(...paramParts);
      }
      opLineParts.push(`(${classifyOperation(op)})`);
      if (op.description) {
        opLineParts.push(`— ${op.description}`);
      }

      lines.push(opLineParts.join(' '));
    }
  }

  lines.push('');
  lines.push('Rules:');
  lines.push('1. One simple command: execute exactly one command line starting with the tool name; do not chain commands.');
  lines.push('2. Quote values with spaces: wrap parameter values containing spaces or special characters in quotes.');
  lines.push('3. No shell operators: operators, pipes, redirects, subshells, backticks, globs, and env prefixes are refused.');

  return lines.join('\n');
}
