/**
 * @fileoverview Unit tests for publish.ts and synopsis.ts edge cases.
 * Covers warning generation, structural validation error branches in parsePublishedSchema,
 * and synopsis helpers.
 */

import { describe, expect, test } from 'bun:test';
import {
  parsePublishedSchema,
  publishSchema,
  schemaWarnings,
  synopsisForParam,
  toCamel,
  usageLine,
  type OperationSchema,
  type ParamSpec,
  type PublishedCliSchema,
} from '../src/index.js';

describe('publish.ts schemaWarnings & publishSchema edge cases', () => {
  test('schemaWarnings detects globals without description', () => {
    const doc: PublishedCliSchema = {
      schema: 'cli.schema.v1',
      tool: 'mytool',
      policy: { dryrun: true, readonly: true },
      inputs: ['flags'],
      globals: [
        { name: 'dryrun', type: 'boolean', description: '' },
        { name: 'verbose', type: 'boolean' } as any,
      ],
      operations: [],
    };
    const warnings = schemaWarnings(doc);
    expect(warnings.length).toBe(2);
    expect(warnings[0]).toContain('global param "dryrun" is missing a description');
    expect(warnings[1]).toContain('global param "verbose" is missing a description');
  });

  test('publishSchema with default/custom options', () => {
    const ops: OperationSchema[] = [
      {
        name: 'op1',
        access: 'read',
        description: 'First op',
        params: [],
      },
    ];
    // With version undefined -> defaults to 'unknown'
    const doc1 = publishSchema('mytool', ops, { version: undefined });
    expect(doc1.version).toBe('unknown');

    // With explicit version, globals, inputs, policy
    const doc2 = publishSchema('mytool', ops, {
      version: '2.0.0',
      globals: [{ name: 'flag', type: 'boolean', occurs: '?' }],
      inputs: ['flags', 'json'],
      policy: { dryrun: false, readonly: true },
    });
    expect(doc2.version).toBe('2.0.0');
    expect(doc2.globals?.length).toBe(1);
    expect(doc2.inputs).toEqual(['flags', 'json']);
    expect(doc2.policy.dryrun).toBe(false);
  });
});

describe('publish.ts parsePublishedSchema structural errors', () => {
  const baseDoc = {
    schema: 'cli.schema.v1',
    tool: 'mytool',
    policy: { dryrun: true, readonly: true },
    inputs: ['flags'],
    operations: [{ name: 'testop', params: [] }],
  };

  test('version not a string', () => {
    const res = parsePublishedSchema({ ...baseDoc, version: 123 } as any);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues.some((i) => i.code === 'TYPE_MISMATCH' && i.message.includes('version must be a string'))).toBe(true);
    }
  });

  test('policy not an object or missing boolean properties', () => {
    const res1 = parsePublishedSchema({ ...baseDoc, policy: 'invalid' } as any);
    expect(res1.ok).toBe(false);
    if (!res1.ok) {
      expect(res1.issues.some((i) => i.code === 'TYPE_MISMATCH' && i.message.includes('policy must be an object'))).toBe(true);
    }

    const res2 = parsePublishedSchema({ ...baseDoc, policy: { dryrun: 'yes', readonly: true } } as any);
    expect(res2.ok).toBe(false);
    if (!res2.ok) {
      expect(res2.issues.some((i) => i.code === 'TYPE_MISMATCH' && i.message.includes('boolean dryrun and readonly'))).toBe(true);
    }
  });

  test('inputs not an array or containing invalid input forms', () => {
    const res1 = parsePublishedSchema({ ...baseDoc, inputs: 'flags' } as any);
    expect(res1.ok).toBe(false);
    if (!res1.ok) {
      expect(res1.issues.some((i) => i.code === 'TYPE_MISMATCH' && i.message.includes('inputs must be an array'))).toBe(true);
    }

    const res2 = parsePublishedSchema({ ...baseDoc, inputs: ['flags', 'rest-api'] } as any);
    expect(res2.ok).toBe(false);
    if (!res2.ok) {
      expect(res2.issues.some((i) => i.code === 'ENUM_VIOLATION' && i.message.includes('unsupported form'))).toBe(true);
    }
  });

  test('param not an object or missing string name', () => {
    const docWithBadParam = {
      ...baseDoc,
      operations: [{ name: 'testop', params: ['string_not_obj'] }],
    };
    const res1 = parsePublishedSchema(docWithBadParam as any);
    expect(res1.ok).toBe(false);
    if (!res1.ok) {
      expect(res1.issues.some((i) => i.code === 'TYPE_MISMATCH' && i.message.includes('must be an object'))).toBe(true);
    }

    const docWithNoName = {
      ...baseDoc,
      operations: [{ name: 'testop', params: [{ type: 'string' }] }],
    };
    const res2 = parsePublishedSchema(docWithNoName as any);
    expect(res2.ok).toBe(false);
    if (!res2.ok) {
      expect(res2.issues.some((i) => i.code === 'TYPE_MISMATCH' && i.message.includes('needs a string name'))).toBe(true);
    }
  });

  test('param enum not an array of strings or numbers', () => {
    const doc = {
      ...baseDoc,
      operations: [
        {
          name: 'testop',
          params: [{ name: 'choice', type: 'string', enum: [true, false] }],
        },
      ],
    };
    const res = parsePublishedSchema(doc as any);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues.some((i) => i.code === 'TYPE_MISMATCH' && i.message.includes('enum must be an array'))).toBe(true);
    }
  });

  test('param items invalid', () => {
    const doc = {
      ...baseDoc,
      operations: [
        {
          name: 'testop',
          params: [{ name: 'items', type: 'array', items: 'function' }],
        },
      ],
    };
    const res = parsePublishedSchema(doc as any);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues.some((i) => i.code === 'ENUM_VIOLATION' && i.message.includes('invalid items type'))).toBe(true);
    }
  });

  test('default value type mismatches: enum, array, object, json', () => {
    // Enum mismatch
    const docEnum = {
      ...baseDoc,
      operations: [{
        name: 'testop',
        params: [{ name: 'mode', type: 'string', enum: ['fast', 'slow'], default: 'turbo' }],
      }],
    };
    const resEnum = parsePublishedSchema(docEnum as any);
    expect(resEnum.ok).toBe(false);
    if (!resEnum.ok) {
      expect(resEnum.issues.some((i) => i.code === 'TYPE_MISMATCH' && i.message.includes('default value'))).toBe(true);
    }

    // Array mismatch
    const docArr = {
      ...baseDoc,
      operations: [{
        name: 'testop',
        params: [{ name: 'tags', type: 'array', default: 'not-an-array' }],
      }],
    };
    const resArr = parsePublishedSchema(docArr as any);
    expect(resArr.ok).toBe(false);

    // Object default valid
    const docObj = {
      ...baseDoc,
      operations: [{
        name: 'testop',
        params: [
          { name: 'cfg', type: 'object', default: { key: 'val' } },
          { name: 'anydata', type: 'json', default: 123 },
          { name: 'flag', type: 'boolean', default: true },
        ],
      }],
    };
    const resObj = parsePublishedSchema(docObj as any);
    expect(resObj.ok).toBe(true);
  });

  test('globals not an array', () => {
    const doc = { ...baseDoc, globals: 'not-array' };
    const res = parsePublishedSchema(doc as any);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues.some((i) => i.code === 'TYPE_MISMATCH' && i.message.includes('globals must be an array'))).toBe(true);
    }
  });

  test('operation not an object or without string name or missing params', () => {
    const res1 = parsePublishedSchema({ ...baseDoc, operations: ['bad_op'] } as any);
    expect(res1.ok).toBe(false);
    if (!res1.ok) {
      expect(res1.issues.some((i) => i.code === 'DOCUMENT_PARSE' && i.message.includes('must be an object'))).toBe(true);
    }

    const res2 = parsePublishedSchema({ ...baseDoc, operations: [{ access: 'read' }] } as any);
    expect(res2.ok).toBe(false);
    if (!res2.ok) {
      expect(res2.issues.some((i) => i.code === 'DOCUMENT_PARSE' && i.message.includes('needs a string name'))).toBe(true);
    }

    const res3 = parsePublishedSchema({ ...baseDoc, operations: [{ name: 'testop' }] } as any);
    expect(res3.ok).toBe(false);
    if (!res3.ok) {
      expect(res3.issues.some((i) => i.code === 'DOCUMENT_PARSE' && i.message.includes('needs a params array'))).toBe(true);
    }
  });
});

describe('synopsis.ts coverage helpers', () => {
  test('usageLine with toolName and positional params', () => {
    const schema: OperationSchema = {
      name: 'clone',
      access: 'write',
      params: [
        { name: 'url', type: 'string', positional: true },
        { name: 'dir', type: 'string', positional: true },
        { name: 'depth', type: 'number', occurs: '?' },
      ],
    };
    const lineWithTool = usageLine(schema, 'git2');
    expect(lineWithTool).toBe('git2 clone [<url>] [<dir>] [flags]');

    const lineNoTool = usageLine(schema);
    expect(lineNoTool).toBe('clone [<url>] [<dir>] [flags]');
  });

  test('toCamel converts kebab-case to camelCase', () => {
    expect(toCamel('max-files')).toBe('maxFiles');
    expect(toCamel('branch-name-target')).toBe('branchNameTarget');
  });

  test('synopsisForParam for array with items, enum, and required', () => {
    const pReq: ParamSpec = { name: 'target', type: 'string', occurs: '1' };
    expect(synopsisForParam(pReq)).toBe('--target <string>');

    const pArray: ParamSpec = { name: 'files', type: 'array', items: 'string', occurs: '*' };
    expect(synopsisForParam(pArray)).toContain('--files <string of string>');
    expect(synopsisForParam(pArray)).toContain('[optional]');

    const pEnum: ParamSpec = { name: 'level', type: 'string', occurs: '?', enum: ['debug', 'info'] };
    expect(synopsisForParam(pEnum)).toContain('one of: debug, info');
  });

  test('array param enum applies to each default item, not to the whole array', () => {
    const doc = (param: Record<string, unknown>) => ({
      schema: 'cli.schema.v1',
      tool: 'probe',
      policy: { dryrun: true, readonly: true },
      inputs: ['flags', 'json'],
      operations: [{ name: 'find', access: 'read', params: [param] }],
    });
    const cols = ['name', 'lastmod', 'size', 'type'];
    // Valid: every item of the array default is in the enum (occurs * / + and type array).
    expect(parsePublishedSchema(doc({ name: 'display', type: 'string', occurs: '*', enum: cols, default: ['name', 'size'] })).ok).toBe(true);
    expect(parsePublishedSchema(doc({ name: 'display', type: 'string', occurs: '+', enum: cols, default: ['size'] })).ok).toBe(true);
    expect(parsePublishedSchema(doc({ name: 'display', type: 'array', items: 'string', enum: cols, default: [] })).ok).toBe(true);
    // Invalid: an item outside the enum is TYPE_MISMATCH, like a scalar default outside its enum.
    for (const bad of [
      { name: 'display', type: 'string', occurs: '*', enum: cols, default: ['name', 'owner'] },
      { name: 'display', type: 'array', items: 'string', enum: cols, default: ['color'] },
      { name: 'display', type: 'string', occurs: '?', enum: cols, default: 'owner' },
      { name: 'display', type: 'string', occurs: '*', enum: cols, default: 'name' },
    ]) {
      const res = parsePublishedSchema(doc(bad));
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.issues.map((i) => i.code)).toEqual(['TYPE_MISMATCH']);
    }
  });
});
