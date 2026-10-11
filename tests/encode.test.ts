/**
 * @fileoverview Encoder round trips (T10b): encode -> server-side parser.
 */

import { describe, expect, test } from 'bun:test';

import { parseArgvForm } from '../src/argv-form.js';
import { encodeArgv, encodeGraphql, encodeJson } from '../src/encode.js';
import { parseGraphqlInput } from '../src/graphql-form.js';
import { parseJsonInput } from '../src/json-form.js';
import type { OperationSchema } from '../src/types.js';

const SCHEMA: OperationSchema = {
  name: 'lm_commit',
  access: 'write',
  params: [
    { name: 'repo', type: 'string', positional: true, occurs: '?' },
    { name: 'message', type: 'string', occurs: '?' },
    { name: 'rev', type: 'string', occurs: '?' },
    { name: 'limit', type: 'number', occurs: '?' },
    { name: 'dryRun', type: 'boolean', occurs: '?' },
    { name: 'wip', type: 'boolean', occurs: '?' },
    { name: 'config', type: 'object', occurs: '?' },
    { name: 'paths', type: 'array', items: 'string', occurs: '*' },
    { name: 'ids', type: 'array', items: 'number', occurs: '*' },
    { name: 'tag', type: 'string', occurs: '+' },
  ],
};

const CASES: Array<[string, Record<string, unknown>]> = [
  ['plain', { message: 'hello', limit: 5, wip: true, dryRun: false }],
  ['space', { message: 'hello world', repo: '/tmp/my repo' }],
  ['equals', { message: 'a=b=c' }],
  ['leading dash', { message: '-x', rev: '--not-a-flag', limit: -3.5 }],
  ['string-like literals', { message: 'true', rev: '123' }],
  ['more string-like', { message: 'false', rev: '2024-01-01' }],
  ['arrays', { paths: ['a b', '-c', 'd=e'], ids: [1, 2.5, -3], tag: ['x'] }],
  ['nested object', { config: { a: { b: [1, 'two', null, true] }, s: 'q"uote\\n' } }],
  ['unicode/newline', { message: 'line1\nline2\t☃ "q"' }],
];

describe('encodeArgv -> parseArgvForm', () => {
  test.each(CASES)('%s', (_, params) => {
    const argv = encodeArgv(SCHEMA, params);
    const r = parseArgvForm(argv, SCHEMA);
    if (!r.ok) throw new Error(JSON.stringify(r.issues));
    expect(r.value.params).toEqual(params);
  });
  test('positional option emits bare words after --', () => {
    const argv = encodeArgv(SCHEMA, { repo: '--weird', wip: true }, { positional: true });
    expect(argv).toEqual(['--wip', '--', '--weird']);
    const r = parseArgvForm(argv, SCHEMA);
    expect(r.ok && r.value.params).toEqual({ repo: '--weird', wip: true });
  });
  test('undefined params are omitted', () => {
    expect(encodeArgv(SCHEMA, { message: undefined, wip: true })).toEqual(['--wip']);
  });
  test('booleans use --k / --no-k', () => {
    expect(encodeArgv(SCHEMA, { wip: true, dryRun: false })).toEqual(['--wip', '--no-dry-run']);
  });
  test('additionalParams round-trip via json coercion', () => {
    const lenient: OperationSchema = { name: 'run', params: [], additionalParams: true };
    const params = { a: 1, b: 'hello world', c: { x: [1] }, d: false };
    const r = parseArgvForm(encodeArgv(lenient, params), lenient);
    expect(r.ok && r.value.params).toEqual(params);
  });
});

describe('encodeJson -> parseJsonInput', () => {
  test.each(CASES)('%s', (_, params) => {
    const doc = parseJsonInput(encodeJson(SCHEMA, params));
    expect(doc.op).toBe('lm_commit');
    expect(doc.params).toEqual(params);
  });
  test('envelope shape, undefined omitted', () => {
    expect(JSON.parse(encodeJson(SCHEMA, { message: 'm', rev: undefined }))).toEqual({
      op: 'lm_commit',
      params: { message: 'm' },
    });
  });
});

describe('encodeGraphql -> parseGraphqlInput', () => {
  test.each(CASES)('%s', (_, params) => {
    const doc = parseGraphqlInput(encodeGraphql(SCHEMA, params));
    expect(doc.op).toBe('lm_commit');
    expect(doc.params).toEqual(params);
  });
  test('uses mutation for write ops, query otherwise', () => {
    expect(encodeGraphql(SCHEMA, {})).toBe('mutation { lm_commit { __typename } }');
    expect(encodeGraphql({ ...SCHEMA, access: 'read' }, { limit: 1 })).toBe(
      'query { lm_commit(limit: 1) { __typename } }',
    );
  });
  test('rejects values the subset cannot express', () => {
    expect(() => encodeGraphql(SCHEMA, { config: { 'bad-key': 1 } })).toThrow();
    expect(() => encodeGraphql(SCHEMA, { limit: Number.NaN })).toThrow();
  });
});

// Positionals are emitted in schema order (the order the runner assigns them in), whatever the
// key order of the params object.
describe('encodeArgv positional order', () => {
  const positional = (...names: string[]): OperationSchema => ({
    name: 'op',
    params: names.map((name) => ({ name, type: 'string', positional: true })),
  });

  test('reverse-key params follow schema order', () => {
    const schema = positional('symbol', 'path');
    const argv = encodeArgv(schema, { path: 'src', symbol: 'Parser' }, { positional: true });
    expect(argv).toEqual(['--', 'Parser', 'src']);
    const back = parseArgvForm(argv, schema);
    expect(back.ok && back.value.positionals).toEqual(['Parser', 'src']);
  });

  test('sorted-key, schema-order and shuffled params all encode in schema order', () => {
    const two = positional('alpha', 'beta');
    expect(encodeArgv(two, { beta: '2', alpha: '1' }, { positional: true })).toEqual(['--', '1', '2']);
    expect(encodeArgv(two, { alpha: '1', beta: '2' }, { positional: true })).toEqual(['--', '1', '2']);
    const three = positional('mode', 'from', 'to');
    expect(encodeArgv(three, { to: 'c', mode: 'a', from: 'b' }, { positional: true })).toEqual([
      '--',
      'a',
      'b',
      'c',
    ]);
  });

  test('a variadic positional expands after the single ones; named flags stay first', () => {
    const schema: OperationSchema = {
      name: 'grep',
      params: [
        { name: 'pattern', type: 'string', positional: true },
        { name: 'limit', type: 'number', occurs: '?' },
        { name: 'paths', type: 'array', items: 'string', occurs: '*', positional: true },
      ],
    };
    const argv = encodeArgv(schema, { paths: ['src', 'tests'], limit: 5, pattern: '-x' }, { positional: true });
    expect(argv).toEqual(['--limit=5', '--', '-x', 'src', 'tests']);
  });
});
