/**
 * @fileoverview Operation policy layer: read/write classification, dry-run
 * simulation, and read-only enforcement.
 *
 * Semantics:
 * - Read operations always execute (even in dry-run and read-only mode).
 * - Write operations:
 *   - dry-run: NOT executed. A successful synthetic DryRunResult is returned,
 *     including the command that would have run (when available).
 *   - read-only mode: execution aborts with a ReadOnlyViolation error.
 * @module @lmctl-ai/lmts/server/policy
 */
import { CliError, ErrorCode } from './errors.js';
/**
 * Guard an operation against the current policy.
 *
 * Returns undefined when execution may proceed. For write operations under
 * dry-run, returns a synthetic success result instead. For write operations
 * under read-only, throws CliError(ReadOnlyViolation).
 */
export function checkPolicy(access, policy, ctx) {
    if (access === 'read' || access === 'dynamic') {
        return undefined;
    }
    if (policy.readOnly) {
        throw new CliError(ErrorCode.ReadOnlyViolation, `Operation "${ctx.name}" is a write operation and this tool is running in read-only mode. Aborting.`, {
            operation: ctx.name,
            command: ctx.command,
            hint: 'Remove the readonly configuration to allow write operations.',
            ...ctx.data,
        });
    }
    if (policy.dryRun) {
        // Merge additional context into the top level for convenient access.
        const extra = (ctx.data ?? {});
        return {
            success: true,
            dryRun: true,
            simulated: ctx.name,
            ...extra,
            ...(ctx.command ? { command: ctx.command } : {}),
        };
    }
    if (ctx.dangerous && !ctx.confirmed && !policy.confirmed) {
        throw new CliError(ErrorCode.MissingConfirmation, `Operation "${ctx.name}" is destructive/irreversible. Re-run with --confirm (or --i-understand) to proceed; use --dryrun to preview the command.`, {
            operation: ctx.name,
            command: ctx.command,
            ...ctx.data,
        });
    }
    return undefined;
}
/**
 * Type guard: true when a result is a synthetic dry-run result rather than a
 * real operation result.
 */
export function isDryRunResult(value) {
    return (typeof value === 'object' &&
        value !== null &&
        value['dryRun'] === true);
}
