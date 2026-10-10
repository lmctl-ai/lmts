/**
 * @fileoverview Cross-runtime CLI process execution.
 * Ported from git-mcp-server
 * src/services/git/providers/cli/utils/runtime-adapter.ts and generalized so
 * the spawned binary and default environment are parameters instead of being
 * hard-wired to git.
 * @module @lmctl-ai/lmts/server/exec
 */
import spawn from 'cross-spawn';
/** Detects the current JavaScript runtime. */
export function detectRuntime() {
    if (typeof globalThis.Bun !== 'undefined') {
        return 'bun';
    }
    if (process.versions?.bun) {
        return 'bun';
    }
    return 'node';
}
export async function spawnWithBun(command, args, cwd, env, timeout, signal, allowNonZeroExit = false) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const bunApi = globalThis.Bun;
    if (signal?.aborted) {
        throw new Error(`Command cancelled before execution: ${command} ${args.join(' ')}`);
    }
    const proc = bunApi.spawn([command, ...args], {
        cwd,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    const abortPromise = new Promise((_, reject) => {
        if (signal) {
            signal.addEventListener('abort', () => {
                proc.kill();
                reject(new Error(`Command cancelled: ${command} ${args.join(' ')}`));
            }, { once: true });
        }
    });
    const timeoutPromise = new Promise((_, reject) => {
        const timeoutId = setTimeout(() => {
            proc.kill();
            reject(new Error(`Command timed out after ${timeout / 1000}s: ${command} ${args.join(' ')}`));
        }, timeout);
        void proc.exited.finally(() => clearTimeout(timeoutId));
    });
    const exitCode = await Promise.race([
        proc.exited,
        timeoutPromise,
        ...(signal ? [abortPromise] : []),
    ]);
    const [stdout, stderr] = await Promise.all([
        proc.stdout.text(),
        proc.stderr.text(),
    ]);
    if (exitCode !== 0 && !allowNonZeroExit) {
        const combinedOutput = `Exit Code: ${exitCode}\nStderr: ${stderr}\nStdout: ${stdout}`;
        throw new Error(combinedOutput);
    }
    return { stdout, stderr, exitCode };
}
export async function spawnWithNode(command, args, cwd, env, timeout, signal, allowNonZeroExit = false) {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(new Error(`Command cancelled before execution: ${command} ${args.join(' ')}`));
            return;
        }
        const proc = spawn(command, args, {
            cwd,
            env,
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        if (!proc.stdout || !proc.stderr) {
            reject(new Error('Failed to capture process streams'));
            return;
        }
        const stdoutChunks = [];
        const stderrChunks = [];
        proc.stdout.on('data', (chunk) => {
            stdoutChunks.push(chunk);
        });
        proc.stderr.on('data', (chunk) => {
            stderrChunks.push(chunk);
        });
        const abortHandler = () => {
            proc.kill('SIGTERM');
            reject(new Error(`Command cancelled: ${command} ${args.join(' ')}`));
        };
        if (signal) {
            signal.addEventListener('abort', abortHandler, { once: true });
        }
        const timeoutHandle = setTimeout(() => {
            proc.kill('SIGTERM');
            reject(new Error(`Command timed out after ${timeout / 1000}s: ${command} ${args.join(' ')}`));
        }, timeout);
        proc.on('error', (error) => {
            clearTimeout(timeoutHandle);
            if (signal) {
                signal.removeEventListener('abort', abortHandler);
            }
            reject(error);
        });
        proc.on('close', (exitCode) => {
            clearTimeout(timeoutHandle);
            if (signal) {
                signal.removeEventListener('abort', abortHandler);
            }
            const stdout = Buffer.concat(stdoutChunks).toString('utf-8');
            const stderr = Buffer.concat(stderrChunks).toString('utf-8');
            const code = exitCode ?? 0;
            if (code !== 0 && !allowNonZeroExit) {
                const combinedOutput = `Exit Code: ${code}\nStderr: ${stderr}\nStdout: ${stdout}`;
                reject(new Error(combinedOutput));
            }
            else {
                resolve({ stdout, stderr, exitCode: code });
            }
        });
    });
}
/**
 * Spawns a command using the optimal method for the current runtime
 * (Bun.spawn in Bun, child_process spawn via cross-spawn in Node).
 *
 * Arguments are always passed as an array (no shell), so shell-metacharacter
 * injection is impossible by construction.
 */
export async function spawnCommand(command, args, cwd, env, timeout = 60000, signal, allowNonZeroExit = false, runtimeOverride) {
    const runtime = runtimeOverride ?? detectRuntime();
    if (runtime === 'bun') {
        return spawnWithBun(command, args, cwd, env, timeout, signal, allowNonZeroExit);
    }
    return spawnWithNode(command, args, cwd, env, timeout, signal, allowNonZeroExit);
}
