/**
 * @fileoverview Operation definition types for CLI servers.
 * @module @gitpoc/clischema/server/types
 */

import type { OperationSchema } from '../types.js';
import type { Access } from './policy.js';

/**
 * Definition of one CLI operation. Operations are pure: they receive their
 * parameters and shared context, and either return a structured result or
 * throw. The CLI runner handles output formatting and exit codes.
 */
export interface OpDef<C> {
  /** Programmatic operation name, e.g. 'status', 'list_issues'. */
  name: string;
  /** One-line human description used in help output. */
  description: string;
  /** 'read' operations always run; 'write' operations are governed by policy. */
  access: Access;
  /**
   * Optional declarative input schema. When present, input resolution
   * (CLI / JSON / GraphQL forms) and validation happen against this schema
   * before the op's `run` is invoked.
   */
  inputSchema?: OperationSchema;
  /** Implementation. */
  run: (params: Record<string, unknown>, ctx: C) => Promise<unknown>;
}
