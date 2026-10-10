/**
 * @fileoverview Unit tests for GraphQL input form (T5): parseGraphqlDocument and parseGraphqlInput.
 */

import { describe, expect, test } from 'bun:test';
import {
  parseGraphqlDocument,
  parseGraphqlInput,
  validateGraphqlParams,
  validate,
  SchemaValidationError,
  type OperationSchema,
} from '../src/index.js';

const STATUS_SCHEMA: OperationSchema = {
  name: 'lm_status',
  access: 'read',
  params: [
    { name: 'path', type: 'string', occurs: '?', default: '.' },
    { name: 'ignored', type: 'boolean', occurs: '?' },
    { name: 'maxFiles', type: 'number', occurs: '?' },
    { name: 'state', type: 'string', occurs: '?', enum: ['open', 'closed'] },
  ],
};

describe('graphql-form: parseGraphqlDocument (T5)', () => {
  // 1. Happy path: query, mutation, bare form with arguments and selection set
  test('happy path: parses query, mutation, and bare forms', () => {
    const q1 = parseGraphqlDocument('query { lm_status(path: "/tmp", ignored: true) { __typename } }');
    expect(q1.ok).toBe(true);
    if (q1.ok) {
      expect(q1.value.op).toBe('lm_status');
      expect(q1.value.params).toEqual({ path: '/tmp', ignored: true });
    }

    const q2 = parseGraphqlDocument('mutation { lm_commit(message: "feat: add stuff") }');
    expect(q2.ok).toBe(true);
    if (q2.ok) {
      expect(q2.value.op).toBe('lm_commit');
      expect(q2.value.params).toEqual({ message: 'feat: add stuff' });
    }

    const q3 = parseGraphqlDocument('{ lm_status }');
    expect(q3.ok).toBe(true);
    if (q3.ok) {
      expect(q3.value.op).toBe('lm_status');
      expect(q3.value.params).toEqual({});
    }
  });

  // 2. Reject variables ($x)
  test('reject variables ($x) with clear DOCUMENT_PARSE message', () => {
    const r1 = parseGraphqlDocument('{ lm_status(path: $myPath) }');
    expect(r1.ok).toBe(false);
    if (!r1.ok) {
      expect(r1.issues.length).toBe(1);
      const issue = r1.issues[0]!;
      expect(issue.code).toBe('DOCUMENT_PARSE');
      expect(issue.message).toContain(
        'variables and operation names are not supported; inline literal values',
      );
      expect(issue.op).toBe('lm_status');
      expect(issue.synopsis.length).toBeGreaterThan(0);
      expect(issue.usage.length).toBeGreaterThan(0);
    }

    const r2 = parseGraphqlDocument('query ($var: String) { lm_status(path: $var) }');
    expect(r2.ok).toBe(false);
    if (!r2.ok) {
      expect(r2.issues[0]!.code).toBe('DOCUMENT_PARSE');
      expect(r2.issues[0]!.message).toContain(
        'variables and operation names are not supported; inline literal values',
      );
    }

    const r3 = parseGraphqlDocument('{ lm_status(items: [$var]) }');
    expect(r3.ok).toBe(false);
    if (!r3.ok) {
      expect(r3.issues[0]!.code).toBe('DOCUMENT_PARSE');
      expect(r3.issues[0]!.message).toContain(
        'variables and operation names are not supported; inline literal values',
      );
    }
  });

  // 3. Reject named operations
  test('reject named operations with DOCUMENT_PARSE message', () => {
    const r1 = parseGraphqlDocument('query GetStatus { lm_status { __typename } }');
    expect(r1.ok).toBe(false);
    if (!r1.ok) {
      expect(r1.issues.length).toBe(1);
      const issue = r1.issues[0]!;
      expect(issue.code).toBe('DOCUMENT_PARSE');
      expect(issue.message).toContain(
        'variables and operation names are not supported; inline literal values',
      );
    }

    const r2 = parseGraphqlDocument('mutation CreateRepo { lm_init }');
    expect(r2.ok).toBe(false);
    if (!r2.ok) {
      expect(r2.issues[0]!.code).toBe('DOCUMENT_PARSE');
      expect(r2.issues[0]!.message).toContain(
        'variables and operation names are not supported; inline literal values',
      );
    }
  });

  // 4. Reject more than one top-level field
  test('reject more than one top-level field', () => {
    const res = parseGraphqlDocument(`
      {
        lm_status { __typename }
        lm_commit(message: "hello") { __typename }
      }
    `);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues.length).toBe(1);
      const issue = res.issues[0]!;
      expect(issue.code).toBe('DOCUMENT_PARSE');
      expect(issue.op).toBe('lm_status');
      expect(issue.message).toContain('more than one top-level field is not supported');
      expect(issue.synopsis.length).toBeGreaterThan(0);
      expect(issue.usage.length).toBeGreaterThan(0);
    }
  });

  // 5. Issue op is set to the parsed field name when known
  test('issue op is set to the parsed field name when error happens after op name', () => {
    const res = parseGraphqlDocument('{ lm_status(unclosed: "val" }');
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues[0]!.op).toBe('lm_status');
      expect(res.issues[0]!.code).toBe('DOCUMENT_PARSE');
    }
  });

  // 6. null argument -> key omitted (so defaults apply)
  test('null argument -> key omitted so schema defaults apply during validation', () => {
    const doc = parseGraphqlDocument('{ lm_status(path: null, ignored: true) }');
    expect(doc.ok).toBe(true);
    if (doc.ok) {
      expect('path' in doc.value.params).toBe(false);
      expect(doc.value.params).toEqual({ ignored: true });

      // When validated against STATUS_SCHEMA, default '.' for path is applied
      const validated = validate(STATUS_SCHEMA, doc.value.params);
      expect(validated.ok).toBe(true);
      if (validated.ok) {
        expect(validated.value['path']).toBe('.');
        expect(validated.value['ignored']).toBe(true);
      }
    }
  });

  // 7. Keep # comments
  test('keep # comments throughout document', () => {
    const text = `
      # Header comment
      query {
        # Field comment
        lm_status(
          # Arg comment
          path: "/workspace",
          ignored: false # inline comment
        ) {
          # Selection comment
          __typename
        }
      }
      # Trailing comment
    `;
    const res = parseGraphqlDocument(text);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.op).toBe('lm_status');
      expect(res.value.params).toEqual({ path: '/workspace', ignored: false });
    }
  });

  // 8. Throwing compat wrapper parseGraphqlInput
  test('parseGraphqlInput compat wrapper succeeds or throws SchemaValidationError', () => {
    const okDoc = parseGraphqlInput('{ lm_status(path: "/foo") }');
    expect(okDoc.op).toBe('lm_status');
    expect(okDoc.params).toEqual({ path: '/foo' });

    expect(() => parseGraphqlInput('{ lm_status(bad: $var) }')).toThrowError(
      SchemaValidationError,
    );
    try {
      parseGraphqlInput('{ lm_status(bad: $var) }');
      expect.unreachable();
    } catch (e) {
      const err = e as SchemaValidationError;
      expect(err).toBeInstanceOf(SchemaValidationError);
      expect(err.operation).toBe('lm_status');
      expect(err.details?.synopsis).toBeDefined();
      expect(Array.isArray(err.details?.issues)).toBe(true);
    }
  });

  // 9. Nested data types (arrays, objects, numbers, booleans, enums)
  test('nested arrays, objects, booleans, numbers, and enums parse accurately', () => {
    const text = `
      {
        custom_op(
          str: "hello",
          num: 42.5,
          neg: -10,
          bool: true,
          enumVal: OPEN,
          arr: [1, 2, "three"],
          obj: { key: "value", innerArr: [true, false] }
        )
      }
    `;
    const res = parseGraphqlDocument(text);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.op).toBe('custom_op');
      expect(res.value.params).toEqual({
        str: 'hello',
        num: 42.5,
        neg: -10,
        bool: true,
        enumVal: 'OPEN',
        arr: [1, 2, 'three'],
        obj: { key: 'value', innerArr: [true, false] },
      });
    }
  });

  // 10. Reject trailing content
  test('reject unexpected trailing content', () => {
    const res = parseGraphqlDocument('{ lm_status } extra');
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues[0]!.code).toBe('DOCUMENT_PARSE');
      expect(res.issues[0]!.message).toContain('unexpected trailing content');
      expect(res.issues[0]!.op).toBe('lm_status');
    }
  });

  // 11. parseGraphqlDocument returns null-prototype params
  test('parseGraphqlDocument returns null-prototype params and nested objects', () => {
    const res = parseGraphqlDocument('{ lm_status(path: "/tmp", meta: { tag: "test" }) }');
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(Object.getPrototypeOf(res.value.params)).toBeNull();
      const meta = res.value.params['meta'];
      if (meta && typeof meta === 'object') {
        expect(Object.getPrototypeOf(meta)).toBeNull();
      }
    }
  });

  // 12. hostile GraphQL with __proto__ does not pollute Object.prototype and validate rejects it
  test('hostile GraphQL input with __proto__ preserves clean prototype and fails validation', () => {
    const res = parseGraphqlDocument('{ lm_status(__proto__: "danger", path: "/safe") }');
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(Object.getPrototypeOf(res.value.params)).toBeNull();
      const valRes = validate(STATUS_SCHEMA, res.value.params);
      expect(valRes.ok).toBe(false);
      if (!valRes.ok) {
        expect(valRes.issues.some((i) => i.code === 'UNKNOWN_PARAM' && i.param === '__proto__')).toBe(true);
      }
    }
    expect(({} as Record<string, unknown>)['danger']).toBeUndefined();
    expect((Object.prototype as Record<string, unknown>)['danger']).toBeUndefined();
  });
});

