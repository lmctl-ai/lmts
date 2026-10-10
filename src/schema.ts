/**
 * @fileoverview Declarative per-operation input schemas.
 *
 * One schema, three input forms: command-line flags, a JSON document, and a
 * GraphQL-style request document. Each op declares its full parameter shape
 * here; the runtime validates every input form against that declaration.
 * @module @gitpoc/clischema/schema
 */

export type { ParamType, ParamOccurs, ParamSpec, OperationSchema } from './types.js';
import type { OperationSchema } from './types.js';

export {
  validate,
  validateParams,
  SchemaValidationError,
  toArrayValue,
} from './validate.js';

export {
  toKebab,
  toCamel,
  isRequired,
  buildSynopsis,
  synopsisForParam,
  usageLine,
} from './synopsis.js';

export { RESERVED_NAMES, isReservedName } from './types.js';

/**
 * Determine whether an operation is effectful (may modify state or execute non-read actions).
 * Returns true unless op.access === 'read'.
 * When access is omitted or undefined, operations are safely treated as effectful (true).
 */
export function isEffectful(op: OperationSchema | { access?: string }): boolean {
  return op.access !== 'read';
}


