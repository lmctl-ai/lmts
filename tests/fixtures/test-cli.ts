#!/usr/bin/env bun
/**
 * @fileoverview Fixture CLI tool for testing runCli and server runtime.
 */

import { readFileSync } from 'node:fs';
import { checkPolicy, runCli, type OpDef, type Policy } from '../../src/server/index.js';
import type { OperationSchema } from '../../src/index.js';

const STATUS_SCHEMA: OperationSchema = {
  name: 'lm_status',
  access: 'read',
  description: 'Structured status',
  params: [
    { name: 'path', type: 'string', occurs: '?', default: '.' },
    { name: 'ignored', type: 'boolean', occurs: '?' },
  ],
};

const COMMIT_SCHEMA: OperationSchema = {
  name: 'commit',
  access: 'write',
  description: 'Record changes to the repository',
  params: [
    { name: 'message', type: 'string', occurs: '1', description: 'Commit message' },
    { name: 'path', type: 'string', occurs: '?', default: '.', description: 'Working dir' },
  ],
};

const CHECKOUT_SCHEMA: OperationSchema = {
  name: 'checkout',
  access: 'write',
  description: 'Switch branches or restore files',
  params: [
    { name: 'branch', type: 'string', occurs: '?', description: 'Branch to checkout' },
  ],
  additionalParams: true,
};

const LOG_SCHEMA: OperationSchema = {
  name: 'log',
  access: 'read',
  description: 'Show commit logs',
  params: [
    { name: 'maxCount', type: 'number', occurs: '?', aliases: ['max-count'], description: 'Max commits' },
  ],
};

interface TestCtx {
  policy: Policy;
}

const ops: OpDef<TestCtx>[] = [
  {
    name: 'lm_status',
    access: 'read',
    description: 'Structured status',
    inputSchema: STATUS_SCHEMA,
    run: async (p) => ({ clean: true, workdir: p['path'] ?? '.' }),
  },
  {
    name: 'commit',
    access: 'write',
    description: 'Record changes to the repository',
    inputSchema: COMMIT_SCHEMA,
    run: async (p, ctx) => {
      const guarded = checkPolicy('write', ctx.policy, { name: 'commit' });
      if (guarded) return guarded;
      return { success: true, message: p['message'] };
    },
  },
  {
    name: 'checkout',
    access: 'write',
    description: 'Switch branches or restore files',
    inputSchema: CHECKOUT_SCHEMA,
    run: async (p, ctx) => {
      const guarded = checkPolicy('write', ctx.policy, { name: 'checkout' });
      if (guarded) return guarded;
      return { success: true, branch: p['branch'] };
    },
  },
  {
    name: 'log',
    access: 'read',
    description: 'Show commit logs',
    inputSchema: LOG_SCHEMA,
    run: async (p) => ({
      commits: [{ author: 'Test User', count: p['maxCount'] ?? 10 }],
    }),
  },
];

async function main(): Promise<number> {
  const pkg = JSON.parse(
    readFileSync(new URL('../../package.json', import.meta.url), 'utf-8'),
  ) as { version?: string };

  return runCli<TestCtx>(
    {
      toolName: 'testtool',
      version: pkg.version ?? 'unknown',
      description: 'Test CLI tool for runCli integration tests',
      ops,
      buildContext: (policy: Policy) => ({ policy }),
    },
    process.argv.slice(2),
  );
}

void main().then((code) => process.exit(code));
