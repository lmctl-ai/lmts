/**
 * @fileoverview Minimal opinionated CLI runner.
 *
 * Usage shape:
 *   <tool> <op> [--flag value ...] [--bool-flag ...]
 *
 * Global flags:
 *   --dryrun / --dry-run     Simulate write operations
 *   --readonly / --read-only Refuse to run write operations
 *   --confirm / --i-understand User attestation for dangerous operations
 *   --json                   (default; kept for explicitness)
 *   --help
 *   --list
 *   --schema
 *   --explain <op> [--format text]
 *   --input-json '<json>'
 *   --input-graphql '<doc>'
 *   --input-file <path>
 *
 * Values arriving on the CLI are parsed against the op's schema.
 * @module @lmctl-ai/lmts/server/cli
 */
import { type OperationSchema, type ParamSpec } from '../index.js';
import type { OpDef } from './types.js';
import type { Policy } from './policy.js';
export interface RunnerConfig<C> {
    /** Tool binary name, used in help/error text and env prefixes. */
    toolName: string;
    /** Tool version, typically from package.json (defaults to "unknown"). */
    version?: string;
    /** Summary printed at the top of --help. */
    description?: string;
    /** All operations, keyed by name. */
    ops: OpDef<C>[];
    /** Build the shared context handed to every op (after policy parsing). */
    buildContext: (policy: Policy) => C;
}
/** Global flags recognized across all CLI tools. */
export declare const GLOBAL_FLAGS: ParamSpec[];
/** Read read-only mode from the environment. `<TOOL>_READONLY=1|true|yes` enables it. */
export declare function readOnlyFromEnv(toolName: string): boolean;
/** Read dry-run from the environment. `<TOOL>_DRYRUN=1|true|yes` enables it. */
export declare function dryRunFromEnv(toolName: string): boolean;
/**
 * Build a minimal OperationSchema for an OpDef that does not declare one.
 * Params are typed 'json', 'occurs: ?', 'derived: true', and schema has 'additionalParams: true'
 * so legacy/free-form ops keep their exact behaviour under the single validator.
 */
export declare function synthesizeSchema<C>(op: OpDef<C>): OperationSchema;
/**
 * Run a CLI: resolve input via schema validation, apply policy, execute the op, print JSON.
 * Returns the process exit code.
 */
export declare function runCli<C>(config: RunnerConfig<C>, argv: string[]): Promise<number>;
