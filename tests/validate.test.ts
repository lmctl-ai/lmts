/**
 * @fileoverview Unit tests for aggregating validate() function and validateParams() throwing wrapper.
 */

import { describe, expect, test } from 'bun:test';
import {
  validate,
  validateParams,
  SchemaValidationError,
  type OperationSchema,
} from '../src/index.js';

describe('validate: T3b aggregating validator', () => {
  // 1. two bad params -> two issues
  test('two bad params -> two issues', () => {
    const schema: OperationSchema = {
      name: 'two_bad_demo',
      params: [
        { name: 'count', type: 'number', occurs: '?' },
        { name: 'flag', type: 'boolean', occurs: '?' },
      ],
    };
    const res = validate(schema, { count: 'not-a-number', flag: 'not-a-bool' });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues.length).toBe(2);
      expect(res.issues.map((i) => i.code)).toEqual(['TYPE_MISMATCH', 'TYPE_MISMATCH']);
      expect(res.issues.map((i) => i.param)).toEqual(['count', 'flag']);
    }
  });

  // 2. suggestion (--pth -> path)
  test('suggestion (--pth -> path)', () => {
    const schema: OperationSchema = {
      name: 'suggest_demo',
      params: [
        { name: 'path', type: 'string', occurs: '?' },
        { name: 'verbose', type: 'boolean', occurs: '?' },
      ],
    };
    const resFlag = validate(schema, { '--pth': '/tmp' });
    expect(resFlag.ok).toBe(false);
    if (!resFlag.ok) {
      expect(resFlag.issues[0]?.code).toBe('UNKNOWN_PARAM');
      expect(resFlag.issues[0]?.suggestion).toBe('path');
    }

    const resBare = validate(schema, { pth: '/tmp' });
    expect(resBare.ok).toBe(false);
    if (!resBare.ok) {
      expect(resBare.issues[0]?.code).toBe('UNKNOWN_PARAM');
      expect(resBare.issues[0]?.suggestion).toBe('path');
    }
  });

  // 3. numeric enum violation
  test('numeric enum violation', () => {
    const schema: OperationSchema = {
      name: 'num_enum_demo',
      params: [
        { name: 'level', type: 'number', enum: [1, 2, 3] },
      ],
    };
    const res = validate(schema, { level: 5 });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues[0]?.code).toBe('ENUM_VIOLATION');
      expect(res.issues[0]?.allowed).toEqual([1, 2, 3]);
      expect(res.issues[0]?.received).toBe(5);
    }
  });

  // 4. '+' empty -> MISSING_REQUIRED
  test('+ with empty array -> MISSING_REQUIRED', () => {
    const schema: OperationSchema = {
      name: 'plus_empty_demo',
      params: [
        { name: 'items', type: 'string', occurs: '+' },
      ],
    };
    const res = validate(schema, { items: [] });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues[0]?.code).toBe('MISSING_REQUIRED');
      expect(res.issues[0]?.param).toBe('items');
    }
  });

  // 5. '*' accepts empty
  test('* accepts empty array', () => {
    const schema: OperationSchema = {
      name: 'star_empty_demo',
      params: [
        { name: 'tags', type: 'string', occurs: '*' },
      ],
    };
    const res = validate(schema, { tags: [] });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value['tags']).toEqual([]);
    }
  });

  // 6. '?' null treated absent
  test('? null treated absent', () => {
    const schema: OperationSchema = {
      name: 'opt_null_demo',
      params: [
        { name: 'maybe', type: 'string', occurs: '?' },
      ],
    };
    const res = validate(schema, { maybe: null });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value['maybe']).toBeUndefined();
      expect('maybe' in res.value).toBe(false);
    }
  });

  // 7. required null mismatch -> TYPE_MISMATCH
  test('required null mismatch -> TYPE_MISMATCH', () => {
    const schema: OperationSchema = {
      name: 'req_null_demo',
      params: [
        { name: 'mustHave', type: 'string', occurs: '1' },
      ],
    };
    const res = validate(schema, { mustHave: null });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues[0]?.code).toBe('TYPE_MISMATCH');
      expect(res.issues[0]?.received).toBeNull();
      expect(res.issues[0]?.param).toBe('mustHave');
    }
  });

  // 8. cliOnly/docOnly FORM_NOT_ALLOWED
  test('cliOnly/docOnly FORM_NOT_ALLOWED when opts.form is specified', () => {
    const schema: OperationSchema = {
      name: 'form_constraint_demo',
      params: [
        { name: 'cliParam', type: 'string', occurs: '?', cliOnly: true },
        { name: 'docParam', type: 'string', occurs: '?', docOnly: true },
      ],
    };

    const resJson = validate(schema, { cliParam: 'hello' }, { form: 'json' });
    expect(resJson.ok).toBe(false);
    if (!resJson.ok) {
      expect(resJson.issues[0]?.code).toBe('FORM_NOT_ALLOWED');
      expect(resJson.issues[0]?.param).toBe('cliParam');
    }

    const resGql = validate(schema, { cliParam: 'hello' }, { form: 'graphql' });
    expect(resGql.ok).toBe(false);
    if (!resGql.ok) {
      expect(resGql.issues[0]?.code).toBe('FORM_NOT_ALLOWED');
      expect(resGql.issues[0]?.param).toBe('cliParam');
    }

    const resFlags = validate(schema, { docParam: 'hello' }, { form: 'flags' });
    expect(resFlags.ok).toBe(false);
    if (!resFlags.ok) {
      expect(resFlags.issues[0]?.code).toBe('FORM_NOT_ALLOWED');
      expect(resFlags.issues[0]?.param).toBe('docParam');
    }

    // Allowed forms pass without issue
    expect(validate(schema, { cliParam: 'hello' }, { form: 'flags' }).ok).toBe(true);
    expect(validate(schema, { docParam: 'hello' }, { form: 'json' }).ok).toBe(true);
  });

  // 9. every issue has non-empty synopsis and usage
  test('every issue has non-empty synopsis and usage', () => {
    const schema: OperationSchema = {
      name: 'multi_issues_demo',
      params: [
        { name: 'file', type: 'string', occurs: '1' },
        { name: 'limit', type: 'number', occurs: '?' },
      ],
    };
    const res = validate(schema, { limit: 'bad', bogus: true });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues.length).toBeGreaterThanOrEqual(3); // unknown bogus, bad limit, missing file
      for (const issue of res.issues) {
        expect(issue.code.length).toBeGreaterThan(0);
        expect(issue.message.length).toBeGreaterThan(0);
        expect(issue.synopsis.length).toBeGreaterThan(0);
        expect(issue.usage.length).toBeGreaterThan(0);
      }
    }
  });

  // 10. defaults applied
  test('defaults applied when parameter omitted', () => {
    const schema: OperationSchema = {
      name: 'defaults_demo',
      params: [
        { name: 'host', type: 'string', occurs: '?', default: 'localhost' },
        { name: 'port', type: 'number', occurs: '?', default: 8080 },
      ],
    };
    const res = validate(schema, {});
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value).toEqual({ host: 'localhost', port: 8080 });
    }
  });

  // 11. additionalParams allows unknown
  test('additionalParams allows unknown keys', () => {
    const schema: OperationSchema = {
      name: 'additional_params_demo',
      additionalParams: true,
      params: [
        { name: 'known', type: 'string', occurs: '?' },
      ],
    };
    const res = validate(schema, {
      known: 'explicit',
      customA: 42,
      customB: { nested: true },
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value['known']).toBe('explicit');
      expect(res.value['customA']).toBe(42);
      expect(res.value['customB']).toEqual({ nested: true });
    }
  });

  // 12. wrapper still throws with details.synopsis
  test('validateParams wrapper still throws with details.synopsis and details.issues', () => {
    const schema: OperationSchema = {
      name: 'wrapper_demo',
      params: [
        { name: 'file', type: 'string', occurs: '1' },
      ],
    };
    expect(() => validateParams(schema, {})).toThrowError(SchemaValidationError);
    try {
      validateParams(schema, {});
      expect.unreachable();
    } catch (e) {
      const err = e as SchemaValidationError;
      expect(err).toBeInstanceOf(SchemaValidationError);
      expect(err.operation).toBe('wrapper_demo');
      expect(err.details?.synopsis).toBe('--file <string>');
      expect(Array.isArray(err.details?.issues)).toBe(true);
      expect((err.details?.issues as unknown[]).length).toBeGreaterThan(0);
    }
  });

  // 13. S1: reject --prefixed keys in validate()
  test('S1: validate rejects -- prefixed keys as UNKNOWN_PARAM', () => {
    const schema: OperationSchema = {
      name: 'prefix_demo',
      params: [{ name: 'path', type: 'string', occurs: '?' }],
    };
    const res = validate(schema, { '--path': '/nonexistent-dir-xyz' });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues[0]?.code).toBe('UNKNOWN_PARAM');
      expect(res.issues[0]?.param).toBe('--path');
    }
  });

  // 14. S6: number coercion requires at least one digit
  test('S6: number coercion rejects "", "-", "." as TYPE_MISMATCH', () => {
    const schema: OperationSchema = {
      name: 'number_coercion_demo',
      params: [{ name: 'count', type: 'number', occurs: '?' }],
    };
    for (const invalid of ['', '-', '.', '-.']) {
      const res = validate(schema, { count: invalid });
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.issues[0]?.code).toBe('TYPE_MISMATCH');
        expect(res.issues[0]?.param).toBe('count');
      }
    }

    // Valid numbers with at least one digit succeed
    for (const valid of ['0', '42', '-42', '3.14', '.5', '-.5', '1e5', '-1.2e-3']) {
      const res = validate(schema, { count: valid });
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(typeof res.value['count']).toBe('number');
        expect(Number.isFinite(res.value['count'])).toBe(true);
      }
    }
  });

  // 15. validate rejects schema with reserved operation name
  test('validate rejects schema with reserved operation name (__proto__, constructor, prototype)', () => {
    for (const reserved of ['__proto__', 'constructor', 'prototype']) {
      const schema: OperationSchema = {
        name: reserved,
        params: [{ name: 'arg', type: 'string', occurs: '?' }],
      };
      const res = validate(schema, { arg: 'val' });
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.issues.some((i) => i.code === 'RESERVED_NAME')).toBe(true);
      }
    }
  });

  // 16. validate rejects schema with reserved parameter name or alias
  test('validate rejects schema with reserved parameter name or alias', () => {
    for (const reserved of ['__proto__', 'constructor', 'prototype']) {
      const schemaParam: OperationSchema = {
        name: 'test_op',
        params: [{ name: reserved, type: 'string', occurs: '?' }],
      };
      const resParam = validate(schemaParam, {});
      expect(resParam.ok).toBe(false);
      if (!resParam.ok) {
        expect(resParam.issues.some((i) => i.code === 'RESERVED_NAME' && i.param === reserved)).toBe(true);
      }

      const schemaAlias: OperationSchema = {
        name: 'test_op',
        params: [{ name: 'okParam', type: 'string', occurs: '?', aliases: [reserved] }],
      };
      const resAlias = validate(schemaAlias, {});
      expect(resAlias.ok).toBe(false);
      if (!resAlias.ok) {
        expect(resAlias.issues.some((i) => i.code === 'RESERVED_NAME' && i.param === reserved)).toBe(true);
      }
    }
  });

  // 17. validate returns prototype-less record
  test('validate returns prototype-less record (Object.getPrototypeOf is null)', () => {
    const schema: OperationSchema = {
      name: 'proto_demo',
      params: [
        { name: 'name', type: 'string', occurs: '?' },
        { name: 'active', type: 'boolean', occurs: '?', default: true },
      ],
    };
    const res = validate(schema, { name: 'alice' });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(Object.getPrototypeOf(res.value)).toBeNull();
      expect(res.value['name']).toBe('alice');
      expect(res.value['active']).toBe(true);
    }
  });

  // 18. Hostile input with __proto__, constructor, prototype does not pollute Object.prototype
  test('hostile input with __proto__, constructor, prototype rejected as UNKNOWN_PARAM and does not pollute Object.prototype', () => {
    const schema: OperationSchema = {
      name: 'safe_demo',
      params: [{ name: 'target', type: 'string', occurs: '?' }],
    };
    const hostilePayload = JSON.parse(
      '{"__proto__": {"polluted": true}, "constructor": {"prototype": {"polluted": true}}, "prototype": {"polluted": true}}',
    );
    const res = validate(schema, hostilePayload);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues.some((i) => i.code === 'UNKNOWN_PARAM' && i.param === '__proto__')).toBe(true);
    }
    // Critical assertion: Object.prototype has not been polluted
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
    expect((Object.prototype as Record<string, unknown>)['polluted']).toBeUndefined();
  });

  // 19. additionalParams: true rejects hostile reserved keys and protects prototype
  test('additionalParams: true rejects __proto__, constructor, prototype without polluting prototype', () => {
    const schema: OperationSchema = {
      name: 'add_params_demo',
      params: [{ name: 'path', type: 'string', occurs: '?' }],
      additionalParams: true,
    };
    const hostile = JSON.parse('{"__proto__": "danger", "constructor": "danger", "prototype": "danger", "custom": "ok"}');
    const res = validate(schema, hostile);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      const paramNames = res.issues.map((i) => i.param);
      expect(paramNames).toContain('__proto__');
      expect(paramNames).toContain('constructor');
      expect(paramNames).toContain('prototype');
    }
    expect(({} as Record<string, unknown>)['danger']).toBeUndefined();
    expect((Object.prototype as Record<string, unknown>)['danger']).toBeUndefined();
  });
});

