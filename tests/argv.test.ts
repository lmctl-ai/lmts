/**
 * @fileoverview Array-based argv form (T6a): B1–B8 regressions and rules.
 */

import { describe, expect, test } from 'bun:test';

import { parseArgvForm } from '../src/argv-form.js';
import type { OperationSchema, ParamSpec, Result } from '../src/types.js';

const SCHEMA: OperationSchema = {
  name: 'lm_commit',
  params: [
    { name: 'repo', type: 'string', positional: true, occurs: '?' },
    { name: 'path', type: 'string', occurs: '?' },
    { name: 'message', type: 'string', occurs: '?' },
    { name: 'rev', type: 'string', occurs: '?' },
    { name: 'limit', type: 'number', occurs: '?' },
    { name: 'wip', type: 'boolean', occurs: '?' },
    { name: 'ignored', type: 'boolean', occurs: '?' },
    { name: 'config', type: 'object', occurs: '?' },
    { name: 'paths', type: 'array', items: 'string', occurs: '*' },
    { name: 'tag', type: 'string', occurs: '+' },
    { name: 'dryRunLocal', type: 'boolean', occurs: '?', aliases: ['dr'] },
  ],
};

const GLOBALS: ParamSpec[] = [
  { name: 'dryrun', type: 'boolean', occurs: '?', aliases: ['dry-run'] },
  { name: 'format', type: 'string', occurs: '?' },
  { name: 'help', type: 'boolean', occurs: '?', aliases: ['h'] },
];

function ok(r: Result<{ params: Record<string, unknown>; positionals: string[]; globals: Record<string, unknown> }>) {
  if (!r.ok) throw new Error('expected ok, got ' + JSON.stringify(r.issues, null, 2));
  return r.value;
}
function fail(r: Result<unknown>) {
  if (r.ok) throw new Error('expected failure, got ' + JSON.stringify(r.value));
  return r.issues;
}
const parse = (argv: string[], schema: OperationSchema = SCHEMA) => parseArgvForm(argv, schema, GLOBALS);

describe('parseArgvForm: values are taken verbatim', () => {
  test('B1 space in value', () => {
    expect(ok(parse(['--path', '/tmp/my repo'])).params).toEqual({ path: '/tmp/my repo' });
  });
  test('B2 "=" in value (separate and inline)', () => {
    expect(ok(parse(['--message', 'a=b'])).params.message).toBe('a=b');
    expect(ok(parse(['--message=a=b=c'])).params.message).toBe('a=b=c');
  });
  test('B3 nested JSON object', () => {
    expect(ok(parse(['--config', '{"a":{"b":1}}'])).params.config).toEqual({ a: { b: 1 } });
  });
  test('B3 bad JSON is TYPE_MISMATCH with argvIndex of the value', () => {
    const [i] = fail(parse(['--config', '{"a":']));
    expect(i!.code).toBe('TYPE_MISMATCH');
    expect(i!.param).toBe('config');
    expect(i!.argvIndex).toBe(1);
  });
  test.each(['trueish', '123abc', '1.2.3', '2024-01-01', 'false', 'true'])('B4 string param keeps %p', (v) => {
    expect(ok(parse(['--rev', v])).params.rev).toBe(v);
  });
  test('B5 --message false is a string; --wip false is a boolean', () => {
    expect(ok(parse(['--message', 'false'])).params.message).toBe('false');
    expect(ok(parse(['--wip', 'false'])).params.wip).toBe(false);
    expect(ok(parse(['--wip=true'])).params.wip).toBe(true);
  });
  test('value may start with "-" via --k=v and as next token', () => {
    expect(ok(parse(['--message=--not-a-flag'])).params.message).toBe('--not-a-flag');
    expect(ok(parse(['--message', '-x'])).params.message).toBe('-x');
    expect(ok(parse(['--limit', '-5'])).params.limit).toBe(-5);
  });
  test('number param parses and rejects NaN', () => {
    expect(ok(parse(['--limit', '1e3'])).params.limit).toBe(1000);
    const [i] = fail(parse(['--limit', 'ten']));
    expect(i!.code).toBe('TYPE_MISMATCH');
  });
  test('boolean param rejects non-boolean inline value', () => {
    expect(fail(parse(['--wip=yes']))[0]!.code).toBe('TYPE_MISMATCH');
  });
  test('boolean flag followed by a non-boolean word leaves it positional', () => {
    const v = ok(parse(['--wip', 'myrepo']));
    expect(v.params).toEqual({ wip: true, repo: 'myrepo' });
  });
});

describe('parseArgvForm: cardinality', () => {
  test('B6 repeated flag accumulates for array and occurs "+"', () => {
    const v = ok(parse(['--paths', 'a', '--paths', 'b', '--tag', 'x', '--tag=y']));
    expect(v.params.paths).toEqual(['a', 'b']);
    expect(v.params.tag).toEqual(['x', 'y']);
  });
  test('single occurrence of a multi param is still an array', () => {
    expect(ok(parse(['--tag', 'x'])).params.tag).toEqual(['x']);
  });
  test('B6 repeated scalar flag is DUPLICATE_FLAG', () => {
    const issues = fail(parse(['--path', 'a', '--path', 'b']));
    expect(issues).toHaveLength(1);
    expect(issues[0]!.code).toBe('DUPLICATE_FLAG');
    expect(issues[0]!.argvIndex).toBe(2);
  });
});

describe('parseArgvForm: flag syntax', () => {
  test('B8 --message --wip is MISSING_VALUE', () => {
    const [i] = fail(parse(['--message', '--wip']));
    expect(i!.code).toBe('MISSING_VALUE');
    expect(i!.param).toBe('message');
    expect(i!.argvIndex).toBe(0);
  });
  test('trailing non-boolean flag is MISSING_VALUE', () => {
    expect(fail(parse(['--message']))[0]!.code).toBe('MISSING_VALUE');
  });
  test('-- terminates flag parsing', () => {
    const v = ok(parse(['--wip', '--', '--message']));
    expect(v.params).toEqual({ wip: true, repo: '--message' });
    expect(v.positionals).toEqual(['--message']);
  });
  test('--no-flag sets false', () => {
    expect(ok(parse(['--no-ignored'])).params.ignored).toBe(false);
  });
  test('kebab-case maps to camelCase, aliases honored', () => {
    expect(ok(parse(['--dry-run-local'])).params.dryRunLocal).toBe(true);
    expect(ok(parse(['--dr'])).params.dryRunLocal).toBe(true);
  });
  test('UNKNOWN_PARAM with suggestion; all issues collected', () => {
    const issues = fail(parse(['--mesage', 'hi', '--limit', 'x', '--bogus']));
    expect(issues.map((i) => i.code)).toEqual(['UNKNOWN_PARAM', 'TYPE_MISMATCH', 'UNKNOWN_PARAM']);
    expect(issues[0]!.suggestion).toBe('--message');
    expect(issues[0]!.argvIndex).toBe(0);
    expect(issues[2]!.argvIndex).toBe(4);
  });
});

describe('parseArgvForm: positionals and globals', () => {
  test('positional binds in order', () => {
    const v = ok(parse(['myrepo', '--wip']));
    expect(v.params).toEqual({ repo: 'myrepo', wip: true });
    expect(v.positionals).toEqual(['myrepo']);
  });
  test('positional slot already set by flag is skipped -> EXTRA_POSITIONAL', () => {
    const [i] = fail(parse(['--repo', 'a', 'b']));
    expect(i!.code).toBe('EXTRA_POSITIONAL');
    expect(i!.argvIndex).toBe(2);
  });
  test('EXTRA_POSITIONAL for surplus positionals', () => {
    const [i] = fail(parse(['a', 'b']));
    expect(i!.code).toBe('EXTRA_POSITIONAL');
    expect(i!.received).toBe('b');
    expect(i!.argvIndex).toBe(1);
  });
  test('globals extracted and never UNKNOWN', () => {
    const v = ok(parse(['--dry-run', '--format', 'json', '-h', '--wip']));
    expect(v.globals).toEqual({ dryrun: true, format: 'json', help: true });
    expect(v.params).toEqual({ wip: true });
  });
  test('additionalParams keeps unknown flags with loose coercion', () => {
    const lenient: OperationSchema = { name: 'run', params: [], additionalParams: true };
    const v = ok(parse(['--a', 'true', '--b=12', '--c', '{"x":[1]}', '--d', 'hello world', '--e', '--f', 'x', '--f', 'y', 'extra'], lenient));
    expect(v.params).toEqual({ a: true, b: 12, c: { x: [1] }, d: 'hello world', e: true, f: ['x', 'y'] });
    expect(v.positionals).toEqual(['extra']);
  });
  test('json-typed param uses loose literal coercion', () => {
    const s: OperationSchema = { name: 'x', params: [{ name: 'v', type: 'json', occurs: '?' }] };
    expect(ok(parse(['--v', '42'], s)).params.v).toBe(42);
    expect(ok(parse(['--v', 'abc'], s)).params.v).toBe('abc');
    expect(ok(parse(['--v'], s)).params.v).toBe(true);
  });
});

describe('parseArgvForm: issue shape', () => {
  test('every issue has code, message, synopsis, usage, argvIndex', () => {
    const issues = fail(parse(['--path', 'a', '--path', 'b', '--message', '--zzz', 'p1', 'p2', '--limit=NaN']));
    expect(issues.length).toBeGreaterThanOrEqual(4);
    for (const i of issues) {
      expect(i.code.length).toBeGreaterThan(0);
      expect(i.message.length).toBeGreaterThan(0);
      expect(i.synopsis!.length).toBeGreaterThan(0);
      expect(i.usage!.length).toBeGreaterThan(0);
      expect(typeof i.argvIndex).toBe('number');
    }
    const dup = issues.find((i) => i.code === 'DUPLICATE_FLAG')!;
    expect(dup.synopsis).toBe('--path <string> [optional]');
    expect(dup.usage).toBe('lm_commit [<repo>] [flags]');
  });

  test('N1: unknown flag issue message mentions swallowed following value', () => {
    const issues = fail(parse(['--bogus', 'swallowed_value']));
    const unknown = issues.find((i) => i.code === 'UNKNOWN_PARAM');
    expect(unknown).toBeDefined();
    expect(unknown!.message).toContain("swallowed value 'swallowed_value'");
  });

  test('parseArgvForm returns null-prototype params and globals', () => {
    const res = ok(parse(['--path', '/tmp', '--dryrun']));
    expect(Object.getPrototypeOf(res.params)).toBeNull();
    expect(Object.getPrototypeOf(res.globals)).toBeNull();
  });

  test('hostile flags --__proto__, --constructor, --prototype rejected as UNKNOWN_PARAM without polluting Object.prototype', () => {
    for (const flag of ['--__proto__=evil', '--constructor=evil', '--prototype=evil']) {
      const issues = fail(parse([flag]));
      expect(issues.some((i) => i.code === 'UNKNOWN_PARAM')).toBe(true);
    }
    expect(({} as Record<string, unknown>)['evil']).toBeUndefined();
    expect((Object.prototype as Record<string, unknown>)['evil']).toBeUndefined();
  });

  test('schema with additionalParams: true rejects --__proto__ and preserves prototype clean', () => {
    const addSchema: OperationSchema = { name: 'add_op', params: [], additionalParams: true };
    const issues = fail(parseArgvForm(['--__proto__=danger', '--constructor=danger', '--prototype=danger'], addSchema));
    expect(issues.some((i) => i.code === 'UNKNOWN_PARAM' && i.param === '__proto__')).toBe(true);
    expect(({} as Record<string, unknown>)['danger']).toBeUndefined();
    expect((Object.prototype as Record<string, unknown>)['danger']).toBeUndefined();
  });
});

