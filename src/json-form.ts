/**
 * @fileoverview JSON input form. Accepts either a raw JSON object mapping
 * param names to values, or an envelope { op, params }. Always validated
 * against the op's schema.
 * @module @gitpoc/clischema/json-form
 */

import type { OperationSchema, Result, ValidationIssue } from './types.js';
import { SchemaValidationError, validateParams } from './validate.js';
import { usageLine } from './synopsis.js';

export interface JsonInputDocument {
  /** Optional envelope: { op: "status", params: {...} }. */
  op?: string;
  params: Record<string, unknown>;
}

function toNullPrototypeRecord(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = Object.create(null);
  for (const key of Object.keys(obj)) {
    result[key] = obj[key];
  }
  return result;
}

/**
 * Parse a JSON document string into op and params.
 * The { op, params } envelope is recognised ONLY when an `op` key is present
 * and is a string; otherwise the whole object is treated as bare params.
 */
export function parseJsonDocument(text: string): Result<JsonInputDocument> {
  const fallbackSchema: OperationSchema = { name: '<unknown>', params: [] };
  const fallbackUsage = usageLine(fallbackSchema);

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    const parseError = err instanceof Error ? err.message : String(err);
    const message = `Invalid JSON: ${parseError}. Expected: ${fallbackUsage}`;
    return {
      ok: false,
      issues: [
        {
          code: 'DOCUMENT_PARSE',
          message,
          synopsis: fallbackUsage,
          usage: fallbackUsage,
        },
      ],
    };
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    const receivedType = parsed === null ? 'null' : Array.isArray(parsed) ? 'array' : typeof parsed;
    const message = `JSON input must be an object, received ${receivedType}. Expected: ${fallbackUsage}`;
    return {
      ok: false,
      issues: [
        {
          code: 'DOCUMENT_PARSE',
          message,
          received: parsed,
          synopsis: fallbackUsage,
          usage: fallbackUsage,
        },
      ],
    };
  }

  const obj = parsed as Record<string, unknown>;

  // Envelope is recognised ONLY when an `op` key is present and is a string
  if (typeof obj['op'] === 'string') {
    const op = obj['op'];
    const opUsage = usageLine({ name: op, params: [] });
    if ('params' in obj) {
      const params = obj['params'];
      if (params === null || typeof params !== 'object' || Array.isArray(params)) {
        const receivedType = params === null ? 'null' : Array.isArray(params) ? 'array' : typeof params;
        const message = `"params" in envelope must be an object, received ${receivedType}. Expected: ${opUsage}`;
        return {
          ok: false,
          issues: [
            {
              code: 'DOCUMENT_PARSE',
              op,
              message,
              received: params,
              synopsis: opUsage,
              usage: opUsage,
            },
          ],
        };
      }
      return {
        ok: true,
        value: {
          op,
          params: toNullPrototypeRecord(params as Record<string, unknown>),
        },
      };
    }
    // op present but no params key: default to empty params
    return {
      ok: true,
      value: {
        op,
        params: Object.create(null),
      },
    };
  }

  // Bare params form: entire object is params
  return {
    ok: true,
    value: {
      params: toNullPrototypeRecord(obj),
    },
  };
}

/** Throwing compat wrapper around parseJsonDocument. */
export function parseJsonInput(text: string): JsonInputDocument {
  const result = parseJsonDocument(text);
  if (!result.ok) {
    const first = result.issues[0]!;
    throw new SchemaValidationError(first.op ?? '<unknown>', first.message, {
      code: first.code,
      synopsis: first.synopsis,
      issues: result.issues,
    });
  }
  return result.value;
}

/** Validate the params against the op schema. */
export function validateJsonParams(
  schema: OperationSchema,
  doc: JsonInputDocument,
): Record<string, unknown> {
  return validateParams(schema, doc.params);
}
