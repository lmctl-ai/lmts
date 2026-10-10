/**
 * @fileoverview Unit tests for JSON input form (T4): parseJsonDocument and parseJsonInput.
 */

import { describe, expect, test } from 'bun:test';
import {
  parseJsonDocument,
  parseJsonInput,
  resolveInput,
  SchemaValidationError,
  type OperationSchema,
} from '../src/index.js';

const DEMO_SCHEMA: OperationSchema = {
  name: 'lm_status',
  access: 'read',
  params: [
    { name: 'path', type: 'string', occurs: '?', default: '.' },
    { name: 'ignored', type: 'boolean', occurs: '?' },
  ],
};

describe('json-form: parseJsonDocument (T4)', () => {
  // 1. Bare params
  test('bare params form', () => {
    const res = parseJsonDocument('{"path": "/tmp", "limit": 10}');
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.op).toBeUndefined();
      expect(res.value.params).toEqual({ path: '/tmp', limit: 10 });
    }
  });

  // 2. {"params":{...}} without op treated as bare params
  test('{"params":{...}} without op treated as bare params', () => {
    const text = JSON.stringify({ params: { Bucket: 'my-bucket', Key: 'data.txt' } });
    const res = parseJsonDocument(text);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.op).toBeUndefined();
      expect(res.value.params).toEqual({
        params: { Bucket: 'my-bucket', Key: 'data.txt' },
      });
    }
  });

  // 3. Envelope with op
  test('envelope with op', () => {
    const text = JSON.stringify({
      op: 'lm_status',
      params: { path: '/workspace', ignored: true },
    });
    const res = parseJsonDocument(text);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.op).toBe('lm_status');
      expect(res.value.params).toEqual({ path: '/workspace', ignored: true });
    }
  });

  // 4. Envelope with op and missing params defaults to empty object
  test('envelope with op but no params key defaults to empty object', () => {
    const res = parseJsonDocument('{"op": "lm_status"}');
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.op).toBe('lm_status');
      expect(res.value.params).toEqual({});
    }
  });

  // 5. Envelope with op and non-object params returns DOCUMENT_PARSE with issue op
  test('envelope with non-object params returns DOCUMENT_PARSE', () => {
    const res = parseJsonDocument('{"op": "lm_status", "params": "string-not-object"}');
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues.length).toBe(1);
      const issue = res.issues[0]!;
      expect(issue.code).toBe('DOCUMENT_PARSE');
      expect(issue.op).toBe('lm_status');
      expect(issue.message).toContain('"params" in envelope must be an object');
      expect(issue.synopsis.length).toBeGreaterThan(0);
      expect(issue.usage.length).toBeGreaterThan(0);
    }
  });

  // 6. Op mismatch via resolveInput
  test('op mismatch checked by resolveInput', () => {
    const text = JSON.stringify({ op: 'lm_other', params: { path: '/tmp' } });
    expect(() =>
      resolveInput({
        schema: DEMO_SCHEMA,
        jsonDocument: text,
      }),
    ).toThrowError(/does not match invoked op/);
  });

  // 7. Invalid JSON -> DOCUMENT_PARSE issue with JSON.parse error in message and non-empty synopsis/usage
  test('invalid JSON -> DOCUMENT_PARSE issue with parse error', () => {
    const res = parseJsonDocument('{ invalid json content:');
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues.length).toBe(1);
      const issue = res.issues[0]!;
      expect(issue.code).toBe('DOCUMENT_PARSE');
      expect(issue.message).toContain('Invalid JSON');
      expect(issue.synopsis.length).toBeGreaterThan(0);
      expect(issue.usage.length).toBeGreaterThan(0);
    }
  });

  // 8. Array and scalar documents -> DOCUMENT_PARSE
  test('array or scalar documents -> DOCUMENT_PARSE', () => {
    for (const input of ['[1, 2, 3]', '"plain string"', '42', 'null', 'true']) {
      const res = parseJsonDocument(input);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.issues[0]!.code).toBe('DOCUMENT_PARSE');
        expect(res.issues[0]!.message).toContain('JSON input must be an object');
        expect(res.issues[0]!.synopsis.length).toBeGreaterThan(0);
        expect(res.issues[0]!.usage.length).toBeGreaterThan(0);
      }
    }
  });

  // 9. Nested objects and arrays pass through untouched
  test('nested objects/arrays pass through untouched', () => {
    const nestedData = {
      config: {
        retries: 3,
        headers: { 'X-Custom': 'header-val' },
        tags: ['alpha', 'beta', { id: 1 }],
      },
    };
    const res = parseJsonDocument(JSON.stringify(nestedData));
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.params).toEqual(nestedData);
    }
  });

  // 10. parseJsonInput compat wrapper throws SchemaValidationError with details
  test('parseJsonInput compat wrapper throws SchemaValidationError on invalid input', () => {
    expect(() => parseJsonInput('bad json')).toThrowError(SchemaValidationError);
    try {
      parseJsonInput('bad json');
      expect.unreachable();
    } catch (e) {
      const err = e as SchemaValidationError;
      expect(err).toBeInstanceOf(SchemaValidationError);
      expect(err.details?.synopsis).toBeDefined();
      expect(Array.isArray(err.details?.issues)).toBe(true);
    }
  });

  // 11. parseJsonDocument returns null-prototype params record
  test('parseJsonDocument returns null-prototype params record', () => {
    const res = parseJsonDocument('{"path": "/tmp", "limit": 10}');
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(Object.getPrototypeOf(res.value.params)).toBeNull();
    }

    const envRes = parseJsonDocument('{"op": "lm_status", "params": {"path": "/tmp"}}');
    expect(envRes.ok).toBe(true);
    if (envRes.ok) {
      expect(Object.getPrototypeOf(envRes.value.params)).toBeNull();
    }
  });

  // 12. hostile JSON with __proto__ key yields UNKNOWN_PARAM and does not pollute Object.prototype
  test('hostile JSON with __proto__ key yields UNKNOWN_PARAM and preserves prototype clean', () => {
    const res = parseJsonDocument('{"op": "lm_status", "params": {"__proto__": {"polluted": true}, "path": "/safe"}}');
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(Object.getPrototypeOf(res.value.params)).toBeNull();
      expect(() =>
        resolveInput({
          schema: DEMO_SCHEMA,
          jsonDocument: '{"op": "lm_status", "params": {"__proto__": {"polluted": true}, "path": "/safe"}}',
        }),
      ).toThrow(SchemaValidationError);
    }
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
    expect((Object.prototype as Record<string, unknown>)['polluted']).toBeUndefined();
  });
});

