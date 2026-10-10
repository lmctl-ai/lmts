/**
 * @fileoverview Client-side encoders: params -> argv array / JSON document /
 * GraphQL document, each the inverse of the matching server-side parser
 * (`parseArgvForm`, `parseJsonInput`, `parseGraphqlInput`). Depends on types
 * only, so it is safe for the consumer ("./validate") entry.
 *
 * Limitations of the argv form: an empty array cannot be expressed (it is
 * omitted), and a 'json'-typed param holding a string that looks like a
 * literal (e.g. "true", "12") is re-read as that literal.
 * @module @lmctl-ai/lmts/encode
 */

import type { OperationSchema, ParamSpec } from './types.js';

export interface EncodeArgvOptions {
  /** Emit positional params as bare words after `--` instead of as flags. */
  positional?: boolean;
}

function kebab(name: string): string {
  return name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
}

function isMulti(spec: ParamSpec): boolean {
  return spec.type === 'array' || spec.occurs === '+' || spec.occurs === '*';
}

function elementType(spec: ParamSpec): ParamSpec['type'] {
  return spec.type === 'array' ? (spec.items ?? 'string') : spec.type;
}

/** Render one element as the raw string `parseArgvForm` will coerce back. */
function argvValue(type: ParamSpec['type'], value: unknown): string {
  if (typeof value === 'string' && (type === 'string' || type === 'json')) return value;
  if (type === 'number' || type === 'boolean') return String(value);
  return JSON.stringify(value);
}

/**
 * Encode params as an argv array (op name not included). Values always use
 * the `--k=v` form so a value may start with '-' or contain anything.
 * Booleans use `--k` / `--no-k`; multi params repeat the flag.
 */
export function encodeArgv(
  schema: OperationSchema,
  params: Record<string, unknown>,
  opts: EncodeArgvOptions = {},
): string[] {
  const out: string[] = [];
  const trailing: string[] = [];
  const specs = new Map(schema.params.map((p) => [p.name, p]));

  for (const [name, value] of Object.entries(params)) {
    if (value === undefined) continue;
    const declared = specs.get(name);
    const spec: ParamSpec = declared ?? { name, type: 'json', occurs: '?' };
    const flag = `--${kebab(name)}`;
    const type = elementType(spec);

    if (opts.positional && spec.positional === true) {
      const items = isMulti(spec) && Array.isArray(value) ? value : [value];
      for (const v of items) trailing.push(argvValue(type, v));
      continue;
    }
    if (isMulti(spec) && Array.isArray(value)) {
      for (const v of value) out.push(`${flag}=${argvValue(type, v)}`);
      continue;
    }
    // `--no-k` only resolves for declared params; undeclared ones use `--k=false`.
    if (typeof value === 'boolean' && declared && (type === 'boolean' || type === 'json')) {
      out.push(value ? flag : `--no-${kebab(name)}`);
      continue;
    }
    out.push(`${flag}=${argvValue(type, value)}`);
  }
  if (trailing.length > 0) out.push('--', ...trailing);
  return out;
}

/** Encode as a JSON envelope `{"op": name, "params": {...}}`. */
export function encodeJson(schema: OperationSchema, params: Record<string, unknown>): string {
  const clean: Record<string, unknown> = Object.create(null);
  for (const [k, v] of Object.entries(params)) if (v !== undefined) clean[k] = v;
  return JSON.stringify({ op: schema.name, params: clean });
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

function graphqlValue(value: unknown, path: string): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'boolean':
      return String(value);
    case 'number':
      if (!Number.isFinite(value)) throw new TypeError(`${path}: cannot encode non-finite number in GraphQL`);
      return JSON.stringify(value);
    case 'object': {
      if (Array.isArray(value)) return `[${value.map((v, i) => graphqlValue(v, `${path}[${i}]`)).join(', ')}]`;
      const fields: string[] = [];
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        if (v === undefined) continue;
        if (!IDENT.test(k)) throw new TypeError(`${path}.${k}: object key is not a GraphQL name`);
        fields.push(`${k}: ${graphqlValue(v, `${path}.${k}`)}`);
      }
      return `{${fields.join(', ')}}`;
    }
    default:
      throw new TypeError(`${path}: cannot encode ${typeof value} in GraphQL`);
  }
}

/**
 * Encode as the inline-literal GraphQL subset accepted by `parseGraphqlInput`:
 * `query|mutation { op(arg: <literal>, …) { __typename } }`.
 */
export function encodeGraphql(schema: OperationSchema, params: Record<string, unknown>): string {
  if (!IDENT.test(schema.name)) throw new TypeError(`op name ${schema.name} is not a GraphQL name`);
  const args: string[] = [];
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined) continue;
    if (!IDENT.test(k)) throw new TypeError(`param ${k} is not a GraphQL name`);
    args.push(`${k}: ${graphqlValue(v, k)}`);
  }
  const kw = schema.access === 'write' ? 'mutation' : 'query';
  const argList = args.length > 0 ? `(${args.join(', ')})` : '';
  return `${kw} { ${schema.name}${argList} { __typename } }`;
}
