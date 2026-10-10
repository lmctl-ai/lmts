/**
 * @fileoverview Edge case unit tests for inputs.ts, encode.ts, argv-form.ts, and interpret.ts.
 */

import { describe, expect, test } from 'bun:test';
import {
  describeForPrompt,
  encodeGraphql,
  parseArgvForm,
  resolveInput,
  SchemaValidationError,
  tokenizeSimpleCommand,
  type OperationSchema,
} from '../src/index.js';

describe('inputs.ts edge cases', () => {
  const schema: OperationSchema = {
    name: 'sync',
    access: 'write',
    params: [
      { name: 'remote', type: 'string', occurs: '1' },
      { name: 'branch', type: 'string', occurs: '?' },
    ],
  };

  test('mixing --input-json and --input-graphql throws SchemaValidationError', () => {
    expect(() =>
      resolveInput({
        schema,
        jsonDocument: '{"remote":"origin"}',
        graphqlDocument: 'mutation { sync(remote: "origin") { __typename } }',
      }),
    ).toThrow(SchemaValidationError);
  });

  test('document input mixed with op flags throws SchemaValidationError', () => {
    expect(() =>
      resolveInput({
        schema,
        jsonDocument: '{"remote":"origin"}',
        argv: ['--branch', 'main'],
      }),
    ).toThrow(SchemaValidationError);

    expect(() =>
      resolveInput({
        schema,
        graphqlDocument: 'mutation { sync(remote: "origin") { __typename } }',
        argv: ['--branch', 'main'],
      }),
    ).toThrow(SchemaValidationError);
  });

  test('input document op mismatch throws SchemaValidationError', () => {
    // JSON op mismatch
    expect(() =>
      resolveInput({
        schema,
        jsonDocument: JSON.stringify({ op: 'other_op', params: { remote: 'origin' } }),
      }),
    ).toThrow(SchemaValidationError);

    // GraphQL op mismatch
    expect(() =>
      resolveInput({
        schema,
        graphqlDocument: 'mutation { other_op(remote: "origin") { __typename } }',
      }),
    ).toThrow(SchemaValidationError);
  });
});

describe('encode.ts edge cases', () => {
  test('encodeGraphql with unsupported value type throws TypeError', () => {
    const schema: OperationSchema = {
      name: 'set_value',
      access: 'write',
      params: [{ name: 'val', type: 'json' }],
    };
    expect(() =>
      encodeGraphql(schema, { val: BigInt(12345) as any }),
    ).toThrow(TypeError);
  });
});

describe('argv-form.ts edge cases', () => {
  const schema: OperationSchema = {
    name: 'config',
    access: 'write',
    params: [
      { name: 'flag', type: 'boolean', occurs: '?' },
      { name: 'data', type: 'json', occurs: '?' },
      { name: 'count', type: 'number', positional: true, occurs: '1' },
    ],
  };

  test('negated boolean with inline value --no-flag=val produces TYPE_MISMATCH', () => {
    const res = parseArgvForm(['--no-flag=true', '42'], schema);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues.some((i) => i.code === 'TYPE_MISMATCH' && i.message.includes('does not take a value'))).toBe(true);
    }
  });

  test('malformed json literal string in coerceJsonLiteral falls back to raw string', () => {
    // "{not valid json}" starts with { and ends with }
    const res = parseArgvForm(['--data', '{not valid json}', '42'], schema);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.params['data']).toBe('{not valid json}');
    }
  });

  test('positional argument type mismatch (non-multi slot advance)', () => {
    const res = parseArgvForm(['not_a_number'], schema);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues.some((i) => i.code === 'TYPE_MISMATCH')).toBe(true);
    }
  });
});

describe('interpret.ts edge cases', () => {
  test('unterminated escape in double quotes', () => {
    const res = tokenizeSimpleCommand('git2 commit --message "hello\\');
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues.some((i) => i.message.includes('unterminated escape in double quotes'))).toBe(true);
    }
  });

  test('escaped variable and backtick inside double quotes', () => {
    const res1 = tokenizeSimpleCommand('git2 commit --message "\\$FOO"');
    expect(res1.ok).toBe(false);
    if (!res1.ok) {
      expect(res1.issues.some((i) => i.message.includes('variable expansion'))).toBe(true);
    }

    const res2 = tokenizeSimpleCommand('git2 commit --message "\\`cmd\\`"');
    expect(res2.ok).toBe(false);
    if (!res2.ok) {
      expect(res2.issues.some((i) => i.message.includes('backtick command substitution'))).toBe(true);
    }
  });

  test('literal preserved backslash in double quotes for non-special character', () => {
    const res = tokenizeSimpleCommand('git2 commit --message "\\n\\a"');
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value[3]).toBe('\\n\\a');
    }
  });

  test('unterminated backslash escape outside quotes at end of line', () => {
    const res = tokenizeSimpleCommand('git2 status \\');
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues.some((i) => i.message.includes('unterminated backslash escape'))).toBe(true);
    }
  });

  test('backslash followed by refused character outside quotes', () => {
    const res = tokenizeSimpleCommand('git2 status \\;');
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues.some((i) => i.message.includes('shell character ";"'))).toBe(true);
    }
  });

  test('describeForPrompt handles single PublishedCliSchema object', () => {
    const singleSchema = {
      schema: 'cli.schema.v1' as const,
      tool: 'solo',
      policy: { dryrun: true, readonly: true },
      inputs: ['flags'] as any,
      operations: [
        {
          name: 'ping',
          access: 'read' as const,
          description: 'Ping service',
          params: [],
        },
      ],
    };
    const rendered = describeForPrompt(singleSchema);
    expect(rendered).toContain('# solo');
    expect(rendered).toContain('solo ping (read) — Ping service');
  });
});
