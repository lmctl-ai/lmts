/**
 * @fileoverview Unified runtime: given an op schema and the raw CLI input
 * mixture, resolve the effective params from (in precedence order):
 *
 *   1. --input-file / --input-json / --input-graphql (documented input)
 *   2. Command-line flags / positionals (array-based, via parseArgvForm)
 *
 * Documented inputs and CLI flags cannot be mixed on a single invocation
 * (enforced here).
 * @module @lmctl-ai/lmts/inputs
 */

import type { OperationSchema, ParamSpec, ValidationIssue } from './types.js';
import { SchemaValidationError, validate } from './validate.js';
import { parseArgvForm } from './argv-form.js';
import { parseJsonInput, validateJsonParams } from './json-form.js';
import { parseGraphqlInput, validateGraphqlParams } from './graphql-form.js';

export type InputKind = 'flags' | 'json' | 'graphql';

export interface ResolvedInput {
  /** Which input form produced the params. */
  kind: InputKind;
  /** Typed params, defaults applied, enum checked. */
  params: Record<string, unknown>;
}

export interface ResolveArgs {
  schema: OperationSchema;
  /** Raw CLI tokens after the op name (already split by the host shell). */
  argv?: string[];
  /** Runner-owned global flags; extracted from argv, never reported unknown. */
  globals?: ParamSpec[];
  /** Optional JSON document (from --input-file or --input-json). */
  jsonDocument?: string;
  /** Optional GraphQL document (from --input-graphql). */
  graphqlDocument?: string;
}

/** Throw the first issue as a SchemaValidationError carrying all issues. */
function throwIssues(schema: OperationSchema, issues: ValidationIssue[]): never {
  const first = issues[0]!;
  throw new SchemaValidationError(schema.name, first.message, {
    ...first,
    issues,
  });
}

export function resolveInput(args: ResolveArgs): ResolvedInput {
  const { schema } = args;
  const hasJson = args.jsonDocument !== undefined;
  const hasGraphql = args.graphqlDocument !== undefined;

  if (hasJson && hasGraphql) {
    throw new SchemaValidationError(schema.name, 'cannot mix --input-json and --input-graphql', {});
  }
  if ((hasJson || hasGraphql) && args.argv && args.argv.length > 0) {
    // Global flags may accompany a document; op flags and positionals may not.
    const flags = parseArgvForm(args.argv, schema, args.globals);
    const mixed = !flags.ok || Object.keys(flags.value.params).length > 0 || flags.value.positionals.length > 0;
    if (mixed) {
      const which = hasJson ? '--input-json' : '--input-graphql';
      throw new SchemaValidationError(schema.name, `cannot mix ${which} with other flags`, {});
    }
  }

  if (hasJson) {
    const doc = parseJsonInput(args.jsonDocument!);
    if (doc.op !== undefined && doc.op !== schema.name) {
      throw new SchemaValidationError(schema.name, `input document op "${doc.op}" does not match invoked op "${schema.name}"`, {
        expected: schema.name, received: doc.op,
      });
    }
    return { kind: 'json', params: validateJsonParams(schema, doc) };
  }

  if (hasGraphql) {
    const doc = parseGraphqlInput(args.graphqlDocument!);
    if (doc.op !== undefined && doc.op !== schema.name) {
      throw new SchemaValidationError(schema.name, `graphql selection "${doc.op}" does not match invoked op "${schema.name}"`, {
        expected: schema.name, received: doc.op,
      });
    }
    return { kind: 'graphql', params: validateGraphqlParams(schema, doc) };
  }

  // Command-line form: argv is used as the shell split it, never re-joined.
  const parsed = parseArgvForm(args.argv ?? [], schema, args.globals);
  if (!parsed.ok) throwIssues(schema, parsed.issues);
  const validated = validate(schema, parsed.value.params, { form: 'flags' });
  if (!validated.ok) throwIssues(schema, validated.issues);
  return { kind: 'flags', params: validated.value };
}
