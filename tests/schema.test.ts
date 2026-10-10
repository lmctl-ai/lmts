/**
 * @fileoverview Tests covering the three input forms against a single schema.
 */

import { describe, expect, test } from 'bun:test';

import {
  parseArgvForm,
  parseGraphqlInput,
  parseJsonInput,
  resolveInput,
  SchemaValidationError,
  validateParams,
  type OperationSchema,
} from '../src/index.js';

const STATUS_SCHEMA: OperationSchema = {
  name: 'lm_status',
  access: 'read',
  description: 'Structured git status',
  params: [
    { name: 'path', type: 'string', occurs: '?', description: 'Working dir', default: '.' },
    { name: 'ignored', type: 'boolean', occurs: '?', description: 'Include ignored files' },
    { name: 'maxFiles', type: 'number', occurs: '?', description: 'Cap' },
    { name: 'paths', type: 'string', occurs: '*', description: 'Limit to paths' },
    { name: 'query', type: 'string', occurs: '?', description: 'JMESPath-ish filter' },
    { name: 'config', type: 'object', occurs: '?', description: 'Nested config blob' },
    { name: 'state', type: 'string', occurs: '?', enum: ['open', 'closed', 'all'] },
    { name: 'repo', type: 'string', occurs: '?', positional: true, description: 'Positional repo arg' },
  ],
};

describe('validateParams', () => {
  test('applies defaults and coerces CLI strings', () => {
    const out = validateParams(STATUS_SCHEMA, {
      ignored: 'true',
      maxFiles: '50',
      paths: '["a.txt","b.txt"]',
      query: 'Users[].Name',
      config: '{"debug":true}',
    });
    expect(out['path']).toBe('.');
    expect(out['ignored']).toBe(true);
    expect(out['maxFiles']).toBe(50);
    expect(out['paths']).toEqual(['a.txt', 'b.txt']);
    expect(out['config']).toEqual({ debug: true });
  });

  test('enum violation reports the allowed set', () => {
    expect(() => validateParams(STATUS_SCHEMA, { state: 'purple' })).toThrowError(
      SchemaValidationError,
    );
  });

  test('missing required param', () => {
    const schema: OperationSchema = {
      name: 'lm_blame',
      params: [{ name: 'file', type: 'string' }],
    };
    expect(() => validateParams(schema, {})).toThrowError(/missing required param: file/);
  });

  test('unknown params are rejected', () => {
    expect(() => validateParams(STATUS_SCHEMA, { bogus: 1 })).toThrowError(/unknown param: bogus/);
  });

  test('array accepts single string as one-element array', () => {
    const out = validateParams(STATUS_SCHEMA, { paths: 'a.txt' });
    expect(out['paths']).toEqual(['a.txt']);
  });
});

describe('CLI argv form (array-based)', () => {
  test('parses flags, values, positionals, repeated array flags', () => {
    const r = parseArgvForm(
      ['/tmp/repo', '--path', '/tmp/repo', '--paths', 'a.txt', '--paths', 'b.txt', '--max-files', '50', '--ignored', '--query', 'Users[].Name'],
      STATUS_SCHEMA,
    );
    if (!r.ok) throw new Error(JSON.stringify(r.issues));
    expect(r.value.params).toEqual({
      repo: '/tmp/repo',
      path: '/tmp/repo',
      paths: ['a.txt', 'b.txt'],
      maxFiles: 50,
      ignored: true,
      query: 'Users[].Name',
    });
  });

  test('mixed positional + flag + json + number works in sequence', () => {
    const r = parseArgvForm(['main', '--ignored', '--max-files=3', '--config', '{"debug":true}'], STATUS_SCHEMA);
    if (!r.ok) throw new Error(JSON.stringify(r.issues));
    expect(r.value.params).toEqual({ repo: 'main', ignored: true, maxFiles: 3, config: { debug: true } });
  });

  test('stray tokens beyond the positional slots are EXTRA_POSITIONAL', () => {
    const r = parseArgvForm(['one', '=bad'], STATUS_SCHEMA);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues[0]!.code).toBe('EXTRA_POSITIONAL');
  });

  test('flag values are kept verbatim (quotes are the shell\'s job)', () => {
    const r = parseArgvForm(['--path', '/tmp', '--query', '"Users[].Name"'], STATUS_SCHEMA);
    if (!r.ok) throw new Error(JSON.stringify(r.issues));
    expect(r.value.params).toEqual({ path: '/tmp', query: '"Users[].Name"' });
  });
});

describe('resolveInput: flags form', () => {
  test('positional binding binds the schema-declared positional param', () => {
    const result = resolveInput({
      schema: STATUS_SCHEMA,
      argv: ['/tmp/lmdemo', '--ignored', '--max-files', '10'],
    });
    expect(result.kind).toBe('flags');
    expect(result.params['repo']).toBe('/tmp/lmdemo');
    expect(result.params['ignored']).toBe(true);
    expect(result.params['maxFiles']).toBe(10);
    expect(result.params['path']).toBe('.');
  });

  test('flags form validates enums', () => {
    expect(() =>
      resolveInput({ schema: STATUS_SCHEMA, argv: ['--state', 'purple'] }),
    ).toThrowError(SchemaValidationError);
  });
});

describe('resolveInput: json form', () => {
  test('envelope with matching op validates', () => {
    const result = resolveInput({
      schema: STATUS_SCHEMA,
      jsonDocument: JSON.stringify({
        op: 'lm_status',
        params: { path: '/x', ignored: true, paths: ['a'], state: 'open' },
      }),
    });
    expect(result.kind).toBe('json');
    expect(result.params['path']).toBe('/x');
    expect(result.params['ignored']).toBe(true);
    expect(result.params['state']).toBe('open');
  });

  test('reject op mismatch', () => {
    expect(() =>
      resolveInput({
        schema: STATUS_SCHEMA,
        jsonDocument: JSON.stringify({ op: 'other_op', params: { path: '/x' } }),
      }),
    ).toThrowError(/does not match invoked op/);
  });

  test('bare params form (no envelope) works', () => {
    const result = resolveInput({
      schema: STATUS_SCHEMA,
      jsonDocument: JSON.stringify({ ignored: false }),
    });
    expect(result.kind).toBe('json');
    expect(result.params['ignored']).toBe(false);
  });

  test('cannot mix --input-json with flags', () => {
    expect(() =>
      resolveInput({
        schema: STATUS_SCHEMA,
        argv: ['--path', '/x'],
        jsonDocument: '{"params":{"path":"/y"}}',
      }),
    ).toThrowError(/cannot mix/);
  });
});

describe('resolveInput: graphql form', () => {
  test('simple query', () => {
    const result = resolveInput({
      schema: STATUS_SCHEMA,
      graphqlDocument: `query { lm_status(path: "/r", ignored: true, maxFiles: 7) { __typename } }`,
    });
    expect(result.kind).toBe('graphql');
    expect(result.params['path']).toBe('/r');
    expect(result.params['ignored']).toBe(true);
    expect(result.params['maxFiles']).toBe(7);
  });

  test('args with arrays and objects', () => {
    const result = resolveInput({
      schema: STATUS_SCHEMA,
      graphqlDocument: `{ lm_status(paths: ["a.txt", "b.txt"], config: {debug: true, level: 2}) { __typename } }`,
    });
    expect(result.params['paths']).toEqual(['a.txt', 'b.txt']);
    expect(result.params['config']).toEqual({ debug: true, level: 2 });
  });

  test('selection without explicit query keyword', () => {
    const result = resolveInput({
      schema: STATUS_SCHEMA,
      graphqlDocument: `{ lm_status { __typename } }`,
    });
    expect(result.params['path']).toBe('.');
  });

  test('reject extra content after selection set', () => {
    expect(() =>
      parseGraphqlInput('{ lm_status { __typename } } trailing'),
    ).toThrowError(/trailing content/);
  });

  test('reject schema mismatch via resolver', () => {
    expect(() =>
      resolveInput({ schema: STATUS_SCHEMA, graphqlDocument: '{ lm_other { __typename } }' }),
    ).toThrowError(/does not match invoked op/);
  });
});

describe('resolveInput: flags errors', () => {
  test('argv problems surface as SchemaValidationError with issues and synopsis', () => {
    try {
      resolveInput({ schema: STATUS_SCHEMA, argv: ['--bogus', '--max-files', 'ten'] });
      throw new Error('expected failure');
    } catch (e) {
      expect(e).toBeInstanceOf(SchemaValidationError);
      const details = (e as SchemaValidationError).details!;
      const issues = details['issues'] as Array<{ code: string }>;
      expect(issues.map((i) => i.code)).toEqual(['UNKNOWN_PARAM', 'TYPE_MISMATCH']);
      expect(typeof details['synopsis']).toBe('string');
    }
  });

  test('value with spaces is not split (B1)', () => {
    const r = resolveInput({ schema: STATUS_SCHEMA, argv: ['--path', '/tmp/my repo'] });
    expect(r.params['path']).toBe('/tmp/my repo');
  });
});
