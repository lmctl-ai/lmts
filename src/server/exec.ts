/**
 * @fileoverview Cross-runtime CLI process execution.
 * Ported from git-mcp-server
 * src/services/git/providers/cli/utils/runtime-adapter.ts and generalized so
 * the spawned binary and default environment are parameters instead of being
 * hard-wired to git.
 * @module @lmctl-ai/lmts/server/exec
 */

import spawn from 'cross-spawn';

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

/**
 * Minimal typed interface for Bun's spawn API.
 * @internal
 */
interface BunSpawnAPI {
  spawn(
    cmd: string[],
    options: {
      cwd: string;
      env: Record<string, string>;
      stdio: [string, string, string];
    },
  ): BunSubprocess;
}

/** @internal */
interface BunReadableStream extends ReadableStream<Uint8Array> {
  text(): Promise<string>;
}

/** @internal */
interface BunSubprocess {
  readonly stdout: BunReadableStream;
  readonly stderr: BunReadableStream;
  readonly exited: Promise<number>;
  kill(): void;
}

/** Detects the current JavaScript runtime. */
export function detectRuntime(): 'bun' | 'node' {
  if (typeof globalThis.Bun !== 'undefined') {
    return 'bun';
  }
  if (process.versions?.bun) {
    return 'bun';
  }
  return 'node';
}

async function spawnWithBun(
  command: string,
  args: string[],
  cwd: string,
  env: Record<string, string>,
  timeout: number,
  signal?: AbortSignal,
  allowNonZeroExit = false,
): Promise<ExecResult> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const bunApi = globalThis.Bun as any as BunSpawnAPI;

  if (signal?.aborted) {
    throw new Error(
      `Command cancelled before execution: ${command} ${args.join(' ')}`,
    );
  }

  const proc = bunApi.spawn([command, ...args], {
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const abortPromise = new Promise<never>((_, reject) => {
    if (signal) {
      signal.addEventListener(
        'abort',
        () => {
          proc.kill();
          reject(
            new Error(`Command cancelled: ${command} ${args.join(' ')}`),
          );
        },
        { once: true },
      );
    }
  });

  const timeoutPromise = new Promise<never>((_, reject) => {
    const timeoutId = setTimeout(() => {
      proc.kill();
      reject(
        new Error(
          `Command timed out after ${timeout / 1000}s: ${command} ${args.join(' ')}`,
        ),
      );
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

async function spawnWithNode(
  command: string,
  args: string[],
  cwd: string,
  env: Record<string, string>,
  timeout: number,
  signal?: AbortSignal,
  allowNonZeroExit = false,
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(
        new Error(
          `Command cancelled before execution: ${command} ${args.join(' ')}`,
        ),
      );
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

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    proc.stdout.on('data', (chunk: Buffer) => {
      stdoutChunks.push(chunk);
    });

    proc.stderr.on('data', (chunk: Buffer) => {
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
      reject(
        new Error(
          `Command timed out after ${timeout / 1000}s: ${command} ${args.join(' ')}`,
        ),
      );
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
      } else {
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
export async function spawnCommand(
  command: string,
  args: string[],
  cwd: string,
  env: Record<string, string>,
  timeout = 60000,
  signal?: AbortSignal,
  allowNonZeroExit = false,
): Promise<ExecResult> {
  const runtime = detectRuntime();

  if (runtime === 'bun') {
    return spawnWithBun(command, args, cwd, env, timeout, signal, allowNonZeroExit);
  }
  return spawnWithNode(command, args, cwd, env, timeout, signal, allowNonZeroExit);
}
