/**
 * @fileoverview Schema validation core. Validates raw input records against an OperationSchema,
 * collecting all issues, applying defaults, enforcing types, enums, occurrences, and form constraints.
 * @module @gitpoc/clischema/validate
 */

import type {
  OperationSchema,
  ParamSpec,
  ParamType,
  Result,
  ValidationIssue,
  ValidationOptions,
} from './types.js';
import { isReservedName } from './types.js';
import { buildSynopsis, isRequired, toCamel, toKebab, usageLine } from './synopsis.js';

export class SchemaValidationError extends Error {
  constructor(
    public readonly operation: string,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'SchemaValidationError';
  }
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

function findSuggestion(key: string, params: ParamSpec[]): string | undefined {
  const clean = toCamel(key.replace(/^--/, ''));
  let bestMatch: string | undefined;
  let minDistance = 3; // only suggestion when edit distance <= 2
  for (const p of params) {
    const dCamel = levenshtein(clean, p.name);
    const dKebab = levenshtein(toKebab(clean), toKebab(p.name));
    const d = Math.min(dCamel, dKebab);
    if (d < minDistance) {
      minDistance = d;
      bestMatch = p.name;
    }
  }
  return bestMatch;
}

export function toArrayValue(value: unknown): unknown[] | undefined {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      try {
        const parsed: unknown = JSON.parse(trimmed);
        if (Array.isArray(parsed)) return parsed;
      } catch {
        /* fall through */
      }
    }
    return [value];
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return [value];
  }
  return undefined;
}

interface CoerceResult {
  ok: boolean;
  value?: unknown;
  received?: unknown;
}

function coerceScalar(expected: ParamType, value: unknown): CoerceResult {
  switch (expected) {
    case 'boolean': {
      if (typeof value === 'boolean') return { ok: true, value };
      if (value === 'true') return { ok: true, value: true };
      if (value === 'false') return { ok: true, value: false };
      return { ok: false, received: value };
    }
    case 'number': {
      if (typeof value === 'number') {
        if (Number.isFinite(value)) return { ok: true, value };
        return { ok: false, received: value };
      }
      if (typeof value === 'string') {
        if (value.trim() === '') return { ok: false, received: value };
        if (/^-?\d+$/.test(value)) {
          return { ok: true, value: Number.parseInt(value, 10) };
        }
        if (/^-?(?:\d+\.?\d*|\d*\.\d+)(?:[eE][+-]?\d+)?$/.test(value)) {
          const n = Number(value);
          if (Number.isFinite(n)) return { ok: true, value: n };
        }
      }
      return { ok: false, received: value };
    }
    case 'string': {
      if (typeof value === 'string') return { ok: true, value };
      if (typeof value === 'number' || typeof value === 'boolean') {
        return { ok: true, value: String(value) };
      }
      return { ok: false, received: value };
    }
    case 'object': {
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
        return { ok: true, value };
      }
      if (typeof value === 'string') {
        try {
          const parsed = JSON.parse(value);
          if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
            return { ok: true, value: parsed };
          }
        } catch {
          /* fall through */
        }
      }
      return { ok: false, received: value };
    }
    case 'json': {
      return { ok: true, value };
    }
    default:
      return { ok: true, value };
  }
}

/**
 * Validate a raw param record against an OperationSchema, collecting all issues.
 */
export function validate(
  schema: OperationSchema,
  raw: Record<string, unknown>,
  opts?: ValidationOptions,
): Result<Record<string, unknown>> {
  const issues: ValidationIssue[] = [];
  const out: Record<string, unknown> = Object.create(null);
  const usage = usageLine(schema);

  if (isReservedName(schema.name)) {
    issues.push({
      code: 'RESERVED_NAME',
      message: `operation name "${schema.name}" is a reserved name. Expected: ${usage}`,
      op: schema.name,
      synopsis: usage,
      usage,
    });
  }

  for (const p of schema.params) {
    if (isReservedName(p.name)) {
      issues.push({
        code: 'RESERVED_NAME',
        message: `param "${p.name}" is a reserved name. Expected: ${usage}`,
        op: schema.name,
        param: p.name,
        synopsis: usage,
        usage,
      });
    }
    if (p.aliases) {
      for (const a of p.aliases) {
        if (isReservedName(a)) {
          issues.push({
            code: 'RESERVED_NAME',
            message: `param "${p.name}" alias "${a}" is a reserved name. Expected: ${usage}`,
            op: schema.name,
            param: a,
            synopsis: usage,
            usage,
          });
        }
      }
    }
  }

  const specByName = new Map<string, ParamSpec>();
  for (const p of schema.params) {
    if (!isReservedName(p.name)) {
      specByName.set(p.name, p);
    }
    for (const a of p.aliases ?? []) {
      if (!isReservedName(a)) {
        specByName.set(a, p);
      }
    }
  }

  // 1. Check for unknown parameters
  for (const key of Object.keys(raw)) {
    if (key.startsWith('--') || !specByName.has(key)) {
      if (!key.startsWith('--') && schema.additionalParams === true && !isReservedName(key)) {
        out[key] = raw[key];
      } else {
        const suggestion = findSuggestion(key, schema.params);
        issues.push({
          code: 'UNKNOWN_PARAM',
          message: `unknown param: ${key}. Expected: ${usage}`,
          param: key,
          synopsis: usage,
          usage,
          received: raw[key],
          ...(suggestion !== undefined ? { suggestion } : {}),
        });
      }
    }
  }

  // 2. Validate declared parameters
  for (const spec of schema.params) {
    if (isReservedName(spec.name)) {
      continue;
    }
    const synopsis = buildSynopsis(spec);
    let value = raw[spec.name];
    if (value === undefined && spec.aliases) {
      for (const alias of spec.aliases) {
        if (raw[alias] !== undefined) {
          value = raw[alias];
          break;
        }
      }
    }

    const isReq = isRequired(spec);

    // Form restrictions (cliOnly / docOnly)
    if (opts?.form && value !== undefined) {
      if (spec.cliOnly === true && (opts.form === 'json' || opts.form === 'graphql')) {
        issues.push({
          code: 'FORM_NOT_ALLOWED',
          message: `param "${spec.name}" is CLI-only and not allowed in ${opts.form} form. Expected: ${synopsis}`,
          param: spec.name,
          synopsis,
          usage,
          received: value,
        });
        continue;
      }
      if (spec.docOnly === true && opts.form === 'flags') {
        issues.push({
          code: 'FORM_NOT_ALLOWED',
          message: `param "${spec.name}" is doc-only and not allowed in flags form. Expected: ${synopsis}`,
          param: spec.name,
          synopsis,
          usage,
          received: value,
        });
        continue;
      }
    }

    // Null handling: optional param -> treated as absent; required param -> TYPE_MISMATCH
    if (value === null) {
      if (isReq) {
        issues.push({
          code: 'TYPE_MISMATCH',
          message: `expected ${spec.type} for param "${spec.name}", received null. Expected: ${synopsis}`,
          param: spec.name,
          synopsis,
          usage,
          received: null,
        });
        continue;
      } else {
        // Optional param with null is treated as absent
        value = undefined;
      }
    }

    // Missing / default handling
    if (value === undefined) {
      if (spec.default !== undefined) {
        out[spec.name] = spec.default;
        continue;
      }
      if (isReq) {
        issues.push({
          code: 'MISSING_REQUIRED',
          message: `missing required param: ${spec.name}. Expected: ${synopsis}`,
          param: spec.name,
          synopsis,
          usage,
        });
      }
      continue;
    }

    // Multi (array / '+' / '*') vs scalar
    const isMulti = spec.occurs === '+' || spec.occurs === '*' || spec.type === 'array';
    if (isMulti) {
      const arr = toArrayValue(value);
      if (arr === undefined) {
        issues.push({
          code: 'TYPE_MISMATCH',
          message: `expected array for param "${spec.name}". Expected: ${synopsis}`,
          param: spec.name,
          synopsis,
          usage,
          received: value,
        });
        continue;
      }

      if (spec.occurs === '+' && arr.length === 0) {
        issues.push({
          code: 'MISSING_REQUIRED',
          message: `param "${spec.name}" requires at least one item. Expected: ${synopsis}`,
          param: spec.name,
          synopsis,
          usage,
          received: value,
        });
        continue;
      }

      if (arr.length === 0) {
        out[spec.name] = [];
        continue;
      }

      const elemType: ParamType = spec.type === 'array' ? (spec.items ?? 'string') : spec.type;
      const coercedItems: unknown[] = [];
      let itemFailed = false;

      for (const item of arr) {
        const coerced = coerceScalar(elemType, item);
        if (!coerced.ok) {
          issues.push({
            code: 'TYPE_MISMATCH',
            message: `expected ${elemType} item for param "${spec.name}". Expected: ${synopsis}`,
            param: spec.name,
            synopsis,
            usage,
            received: item,
          });
          itemFailed = true;
          break;
        }

        // Enum check for items
        if (spec.enum && spec.enum.length > 0 && !spec.enum.includes(coerced.value as never)) {
          issues.push({
            code: 'ENUM_VIOLATION',
            message: `invalid value for param "${spec.name}": ${JSON.stringify(coerced.value)}; allowed: ${spec.enum.join(', ')}. Expected: ${synopsis}`,
            param: spec.name,
            synopsis,
            usage,
            received: coerced.value,
            allowed: spec.enum,
          });
          itemFailed = true;
          break;
        }

        coercedItems.push(coerced.value);
      }

      if (!itemFailed) {
        out[spec.name] = coercedItems;
      }
      continue;
    }

    // Scalar coercion
    const coerced = coerceScalar(spec.type, value);
    if (!coerced.ok) {
      issues.push({
        code: 'TYPE_MISMATCH',
        message: `expected ${spec.type} for param "${spec.name}". Expected: ${synopsis}`,
        param: spec.name,
        synopsis,
        usage,
        received: value,
      });
      continue;
    }

    // Enum check for scalar
    if (spec.enum && spec.enum.length > 0 && !spec.enum.includes(coerced.value as never)) {
      issues.push({
        code: 'ENUM_VIOLATION',
        message: `invalid value for param "${spec.name}": ${JSON.stringify(coerced.value)}; allowed: ${spec.enum.join(', ')}. Expected: ${synopsis}`,
        param: spec.name,
        synopsis,
        usage,
        received: coerced.value,
        allowed: spec.enum,
      });
      continue;
    }

    out[spec.name] = coerced.value;
  }

  if (issues.length > 0) {
    return { ok: false, issues };
  }
  return { ok: true, value: out };
}

/**
 * Compatibility throwing wrapper around validate().
 */
export function validateParams(
  schema: OperationSchema,
  raw: Record<string, unknown>,
): Record<string, unknown> {
  const result = validate(schema, raw);
  if (result.ok) {
    return result.value;
  }
  const first = result.issues[0]!;
  throw new SchemaValidationError(schema.name, first.message, {
    spec: first.param,
    known: schema.params.map((p) => p.name),
    issues: result.issues,
    ...first,
  });
}
