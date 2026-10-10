/**
 * @fileoverview Array-based argv (flags) form. The shell has already
 * tokenized argv, so each element is taken as-is: no joining, no lexing.
 * Value types come from the schema, never from the token shape. Produces a
 * raw typed record; required/enum checks are left to `validate()`.
 *
 * Rules:
 *   --k v | --k=v        value (may contain spaces, '=', JSON, or start with '-')
 *   --k                  boolean true (boolean / json params)
 *   --no-k               boolean false (boolean / json params)
 *   --k a --k b          accumulates for occurs '+'/'*' or type 'array'
 *   --                   ends flag parsing; the rest are positionals
 * @module @gitpoc/clischema/argv-form
 */

import type { OperationSchema, ParamSpec, Result, ValidationIssue } from './types.js';
import { isReservedName } from './types.js';
import { synopsisForParam, toKebab } from './synopsis.js';

export interface ArgvFormValue {
  params: Record<string, unknown>;
  positionals: string[];
  globals: Record<string, unknown>;
}

type Scope = 'param' | 'global';

interface FlagTarget {
  spec: ParamSpec;
  scope: Scope;
}

/** kebab-case -> camelCase (`dry-run` -> `dryRun`). */
function toCamel(name: string): string {
  return name.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

/** Op usage line without the tool name: `<op> [<positional>] [flags]`. */
function usageFor(schema: OperationSchema): string {
  const parts = [schema.name];
  for (const p of schema.params) {
    if (p.positional === true) parts.push(`[<${p.name}>]`);
  }
  parts.push('[flags]');
  return parts.join(' ');
}

function isMulti(spec: ParamSpec): boolean {
  return spec.type === 'array' || spec.occurs === '+' || spec.occurs === '*';
}

/** Element type used to coerce one occurrence of the flag. */
function elementType(spec: ParamSpec): ParamSpec['type'] {
  if (spec.type === 'array') return spec.items ?? 'string';
  return spec.type;
}

/** Loose literal coercion used for 'json' params and additionalParams. */
export function coerceJsonLiteral(raw: string): unknown {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (raw === 'null') return null;
  if (/^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(raw)) return Number(raw);
  const t = raw.trim();
  if ((t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']'))) {
    try {
      return JSON.parse(t);
    } catch {
      // plain string
    }
  }
  return raw;
}

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

/**
 * Parse an argv array (op name already removed) against an op schema.
 * Collects every issue instead of stopping at the first.
 */
export function parseArgvForm(
  argv: string[],
  schema: OperationSchema,
  globals: ParamSpec[] = [],
): Result<ArgvFormValue> {
  const params: Record<string, unknown> = Object.create(null);
  const globalValues: Record<string, unknown> = Object.create(null);
  const positionals: string[] = [];
  const positionalIndex: number[] = [];
  const issues: ValidationIssue[] = [];
  const usage = usageFor(schema);
  const seen = new Set<string>();
  const extraCount = new Map<string, number>();

  // Lookup table: kebab name, camel name and aliases -> spec. Op params win
  // over globals on collision.
  const lookup = new Map<string, FlagTarget>();
  const register = (spec: ParamSpec, scope: Scope): void => {
    if (isReservedName(spec.name)) return;
    for (const key of [spec.name, toKebab(spec.name), ...(spec.aliases ?? [])]) {
      if (!isReservedName(key) && !lookup.has(key)) lookup.set(key, { spec, scope });
    }
  };
  for (const p of schema.params) register(p, 'param');
  for (const g of globals) register(g, 'global');

  const issue = (
    code: ValidationIssue['code'],
    message: string,
    argvIndex: number,
    spec?: ParamSpec,
    extra: Partial<ValidationIssue> = {},
  ): void => {
    const synopsis = spec ? synopsisForParam(spec) : usage;
    issues.push({
      code,
      message: `${message}. Expected: ${synopsis}`,
      ...(spec ? { param: spec.name } : {}),
      synopsis,
      usage,
      argvIndex,
      ...extra,
    });
  };

  /** Coerce one raw string by element type; reports and returns ok:false on failure. */
  const coerce = (spec: ParamSpec, raw: string, idx: number): { ok: boolean; value?: unknown } => {
    const t = elementType(spec);
    switch (t) {
      case 'string':
        return { ok: true, value: raw };
      case 'number': {
        const n = raw.trim() === '' ? Number.NaN : Number(raw);
        if (Number.isNaN(n)) {
          issue('TYPE_MISMATCH', `--${toKebab(spec.name)}: expected a number, received "${raw}"`, idx, spec, {
            received: raw,
          });
          return { ok: false };
        }
        return { ok: true, value: n };
      }
      case 'boolean':
        if (raw === 'true') return { ok: true, value: true };
        if (raw === 'false') return { ok: true, value: false };
        issue('TYPE_MISMATCH', `--${toKebab(spec.name)}: expected true or false, received "${raw}"`, idx, spec, {
          received: raw,
          allowed: [true, false],
        });
        return { ok: false };
      case 'object':
      case 'array':
        try {
          return { ok: true, value: JSON.parse(raw) };
        } catch (err) {
          issue(
            'TYPE_MISMATCH',
            `--${toKebab(spec.name)}: value is not valid JSON (${(err as Error).message})`,
            idx,
            spec,
            { received: raw },
          );
          return { ok: false };
        }
      case 'json':
        return { ok: true, value: coerceJsonLiteral(raw) };
    }
  };

  const assign = (target: FlagTarget, value: unknown, idx: number): void => {
    const { spec, scope } = target;
    const bag = scope === 'param' ? params : globalValues;
    const key = `${scope}:${spec.name}`;
    if (isMulti(spec)) {
      const arr = (bag[spec.name] as unknown[] | undefined) ?? [];
      arr.push(value);
      bag[spec.name] = arr;
    } else if (seen.has(key)) {
      issue('DUPLICATE_FLAG', `--${toKebab(spec.name)} given more than once`, idx, spec, { received: value });
    } else {
      bag[spec.name] = value;
    }
    seen.add(key);
  };

  const takesNoValue = (spec: ParamSpec): boolean => elementType(spec) === 'boolean';

  let i = 0;
  let flagsDone = false;
  for (; i < argv.length; i++) {
    const tok = argv[i]!;
    if (flagsDone) {
      positionals.push(tok);
      positionalIndex.push(i);
      continue;
    }
    if (tok === '--') {
      flagsDone = true;
      continue;
    }

    let name: string | undefined;
    let inline: string | undefined;
    if (tok.startsWith('--') && tok.length > 2) {
      const body = tok.slice(2);
      const eq = body.indexOf('=');
      name = eq === -1 ? body : body.slice(0, eq);
      inline = eq === -1 ? undefined : body.slice(eq + 1);
    } else if (/^-[A-Za-z]$/.test(tok) && lookup.has(tok.slice(1))) {
      name = tok.slice(1);
    }
    if (name === undefined) {
      positionals.push(tok);
      positionalIndex.push(i);
      continue;
    }

    let target = lookup.get(name) ?? lookup.get(toCamel(name));
    let negated = false;
    if (!target && name.startsWith('no-')) {
      const base = name.slice(3);
      const t = lookup.get(base) ?? lookup.get(toCamel(base));
      if (t && (elementType(t.spec) === 'boolean' || t.spec.type === 'json')) {
        target = t;
        negated = true;
      }
    }

    const next = argv[i + 1];
    const nextIsValue = next !== undefined && !next.startsWith('--');

    if (!target) {
      if (schema.additionalParams && !isReservedName(name) && !isReservedName(toCamel(name))) {
        const key = toCamel(name);
        let value: unknown;
        if (inline !== undefined) value = coerceJsonLiteral(inline);
        else if (nextIsValue) value = coerceJsonLiteral(argv[++i]!);
        else value = true;
        // A single occurrence stays unwrapped; repeats accumulate into an array.
        const count = extraCount.get(key) ?? 0;
        if (count === 0) params[key] = value;
        else if (count === 1) params[key] = [params[key], value];
        else (params[key] as unknown[]).push(value);
        extraCount.set(key, count + 1);
        continue;
      }
      const known = [...new Set(schema.params.map((p) => toKebab(p.name)))];
      const best = known
        .map((k) => ({ k, d: levenshtein(name!, k) }))
        .filter((x) => x.d <= 2)
        .sort((a, b) => a.d - b.d)[0];
      let swallowed: string | undefined;
      // Swallow a following value so it does not become a stray positional.
      if (inline === undefined && nextIsValue) {
        swallowed = argv[++i];
      }
      const swallowedStr = swallowed !== undefined ? ` (swallowed value '${swallowed}')` : '';
      issues.push({
        code: 'UNKNOWN_PARAM',
        message: `unknown flag --${name}${swallowedStr}. Expected one of: ${known.map((k) => `--${k}`).join(', ') || '(none)'}`,
        param: toCamel(name),
        synopsis: usage,
        usage,
        argvIndex: i - (swallowed !== undefined ? 1 : 0),
        received: tok,
        ...(best ? { suggestion: `--${best.k}` } : {}),
      });
      continue;
    }

    const { spec } = target;
    if (negated) {
      if (inline !== undefined) {
        issue('TYPE_MISMATCH', `--${name} does not take a value`, i, spec, { received: inline });
        continue;
      }
      assign(target, false, i);
      continue;
    }

    if (inline !== undefined) {
      const r = coerce(spec, inline, i);
      if (r.ok) assign(target, r.value, i);
      continue;
    }

    if (takesNoValue(spec)) {
      if (next === 'true' || next === 'false') {
        assign(target, next === 'true', i);
        i++;
      } else {
        assign(target, true, i);
      }
      continue;
    }

    if (!nextIsValue) {
      if (spec.type === 'json') {
        assign(target, true, i);
        continue;
      }
      issue(
        'MISSING_VALUE',
        `--${toKebab(spec.name)} requires a value` + (next === undefined ? '' : `, but was followed by ${next}`),
        i,
        spec,
      );
      continue;
    }

    const r = coerce(spec, next, i + 1);
    i++;
    if (r.ok) assign(target, r.value, i - 1);
  }

  // Bind positionals in order to positional params not already set by flags.
  const slots = schema.params.filter((p) => p.positional === true);
  let slot = 0;
  for (let k = 0; k < positionals.length; k++) {
    while (slot < slots.length && params[slots[slot]!.name] !== undefined && !isMulti(slots[slot]!)) slot++;
    const spec = slots[slot];
    const idx = positionalIndex[k]!;
    if (!spec) {
      if (!schema.additionalParams) {
        issues.push({
          code: 'EXTRA_POSITIONAL',
          message: `unexpected positional argument "${positionals[k]}". Expected: ${usage}`,
          synopsis: usage,
          usage,
          argvIndex: idx,
          received: positionals[k],
        });
      }
      continue;
    }
    const r = coerce(spec, positionals[k]!, idx);
    if (!r.ok) {
      if (!isMulti(spec)) slot++;
      continue;
    }
    if (isMulti(spec)) {
      const arr = (params[spec.name] as unknown[] | undefined) ?? [];
      arr.push(r.value);
      params[spec.name] = arr;
    } else {
      params[spec.name] = r.value;
      slot++;
    }
  }

  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, value: { params, positionals, globals: globalValues } };
}
