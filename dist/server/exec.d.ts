/**
 * @fileoverview Cross-runtime CLI process execution.
 * Ported from git-mcp-server
 * src/services/git/providers/cli/utils/runtime-adapter.ts and generalized so
 * the spawned binary and default environment are parameters instead of being
 * hard-wired to git.
 * @module @lmctl-ai/lmts/server/exec
 */
/** Result of executing a command. */
export interface ExecResult {
    /** Standard output from the command */
    stdout: string;
    /** Standard error from the command */
    stderr: string;
    /**
     * Process exit code. Non-zero values are only returned when
     * `allowNonZeroExit` is true; otherwise the command throws on non-zero exit.
     */
    exitCode: number;
}
/** Options for spawning a command. */
export interface ExecOptions {
    /** Timeout in milliseconds (default: 60000) */
    timeout?: number;
    /** Optional AbortSignal for cancellation */
    signal?: AbortSignal;
    /**
     * If true, return the result with the non-zero exit code instead of
     * throwing. Used by operations that need to inspect output on a "soft"
     * failure such as a merge conflict.
     */
    allowNonZeroExit?: boolean;
}
/** Detects the current JavaScript runtime. */
export declare function detectRuntime(): 'bun' | 'node';
/**
 * Spawns a command using the optimal method for the current runtime
 * (Bun.spawn in Bun, child_process spawn via cross-spawn in Node).
 *
 * Arguments are always passed as an array (no shell), so shell-metacharacter
 * injection is impossible by construction.
 */
export declare function spawnCommand(command: string, args: string[], cwd: string, env: Record<string, string>, timeout?: number, signal?: AbortSignal, allowNonZeroExit?: boolean): Promise<ExecResult>;
