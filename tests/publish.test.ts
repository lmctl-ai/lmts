/**
 * @fileoverview Unit tests for published schema (T10): structural validation,
 * schemaWarnings, globals, returns, and consumer-entry round trips.
 *
 * NOTE: As required by T10, imports are ONLY from '../src/validate-entry.js'
 * to prove the consumer validate-entry barrel is sufficient.
 */

import { describe, expect, test } from 'bun:test';
import {
  findOperation,
  isEffectful,
  parsePublishedSchema,
  parsePublishedSchemaOrThrow,
  publishSchema,
  schemaWarnings,
  validate,
  type OperationSchema,
  type PublishedCliSchema,
} from '../src/validate-entry.js';

describe('publish: T10 PublishedCliSchema validation and round-trip', () => {
  const SAMPLE_OP: OperationSchema = {
    name: 'lm_status',
    access: 'read',
    returns: 'object',
    description: 'Show git status',
    params: [
      { name: 'path', type: 'string', occurs: '?', default: '.', description: 'Directory' },
      { name: 'ignored', type: 'boolean', occurs: '?', default: false, description: 'Show ignored' },
      { name: 'limit', type: 'number', occurs: '?', description: 'Limit items' },
      { name: 'state', type: 'string', occurs: '?', enum: ['open', 'closed'], description: 'State' },
    ],
  };

  // 1. Full Consumer Round-Trip
  test('round-trip publish -> JSON.stringify -> JSON.parse -> parsePublishedSchema -> findOperation -> validate', () => {
    const published = publishSchema('git2', [SAMPLE_OP], { version: '1.0.0' });
    const jsonStr = JSON.stringify(published);
    const parsedObj = JSON.parse(jsonStr);

    const result = parsePublishedSchema(parsedObj);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const doc = result.value;
    expect(doc.tool).toBe('git2');
    expect(doc.version).toBe('1.0.0');

    const op = findOperation(doc, 'lm_status');
    expect(op).toBeDefined();
    if (!op) return;

    // Validate accepts good input
    const goodRes = validate(op, { path: '/home/workspace', ignored: true, limit: 10 });
    expect(goodRes.ok).toBe(true);
    if (goodRes.ok) {
      expect(goodRes.value['path']).toBe('/home/workspace');
      expect(goodRes.value['ignored']).toBe(true);
      expect(goodRes.value['limit']).toBe(10);
    }

    // Validate rejects bad input with synopsis
    const badRes = validate(op, { limit: 'not-a-number' });
    expect(badRes.ok).toBe(false);
    if (!badRes.ok) {
      expect(badRes.issues.length).toBeGreaterThan(0);
      expect(badRes.issues[0]!.code).toBe('TYPE_MISMATCH');
      expect(badRes.issues[0]!.synopsis.length).toBeGreaterThan(0);
      expect(badRes.issues[0]!.usage.length).toBeGreaterThan(0);
    }
  });

  // 2. Version passthrough & default
  test('version passthrough and fallback to "unknown"', () => {
    const custom = publishSchema('git2', [SAMPLE_OP], { version: '2.4.0' });
    expect(custom.version).toBe('2.4.0');

    const fallback = publishSchema('git2', [SAMPLE_OP]);
    expect(fallback.version).toBe('unknown');

    const undefinedVersion = publishSchema('git2', [SAMPLE_OP], { version: undefined });
    expect(undefinedVersion.version).toBe('unknown');
  });

  // 3. Globals round-trip
  test('globals round-trip', () => {
    const doc = publishSchema('git2', [SAMPLE_OP], {
      globals: [
        { name: 'dry-run', type: 'boolean', aliases: ['dryrun'], description: 'Simulate' },
        { name: 'confirm', type: 'boolean', description: 'Confirm action' },
      ],
    });
    const parsed = parsePublishedSchema(JSON.parse(JSON.stringify(doc)));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.globals?.length).toBe(2);
      expect(parsed.value.globals?.[0]?.name).toBe('dry-run');
    }
  });

  // 4. Returns round-trip
  test('returns field round-trip on OperationSchema', () => {
    const opWithReturns: OperationSchema = {
      name: 'list_tags',
      access: 'read',
      returns: 'array',
      description: 'List git tags',
      params: [],
    };
    const doc = publishSchema('git2', [opWithReturns]);
    const parsed = parsePublishedSchema(JSON.parse(JSON.stringify(doc)));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      const op = findOperation(parsed.value, 'list_tags');
      expect(op?.returns).toBe('array');
    }
  });

  // 5. Non-object document rejected
  test('rejects non-object documents', () => {
    for (const val of [null, undefined, 'string', 123, true, []]) {
      const res = parsePublishedSchema(val);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.issues[0]!.code).toBe('DOCUMENT_PARSE');
      }
    }
  });

  // 6. Unsupported schema tag rejected
  test('rejects unsupported schema tag', () => {
    const res = parsePublishedSchema({ schema: 'cli.schema.v2', tool: 'git2', operations: [] });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues.some((i) => i.message.includes('unsupported schema tag'))).toBe(true);
    }
  });

  // 7. Invalid tool name rejected
  test('rejects invalid tool names', () => {
    for (const badTool of ['Git2', '123tool', 'tool-kebab', 'tool.dot', '']) {
      const res = parsePublishedSchema({ schema: 'cli.schema.v1', tool: badTool, operations: [] });
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.issues.some((i) => i.param === undefined && i.message.includes('tool must be a string matching'))).toBe(true);
      }
    }
  });

  // 8. Duplicate operations rejected
  test('rejects duplicate operation names', () => {
    const op1: OperationSchema = { name: 'status', params: [] };
    const op2: OperationSchema = { name: 'status', params: [] };
    const res = parsePublishedSchema({
      schema: 'cli.schema.v1',
      tool: 'git2',
      operations: [op1, op2],
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues.some((i) => i.message.includes('duplicate operation name "status"'))).toBe(true);
    }
  });

  // 9. Invalid operation name rejected
  test('rejects invalid operation names', () => {
    const badOp = { name: 'Status-Op', params: [] };
    const res = parsePublishedSchema({
      schema: 'cli.schema.v1',
      tool: 'git2',
      operations: [badOp],
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues.some((i) => i.message.includes('operation name "Status-Op" must match'))).toBe(true);
    }
  });

  // 10. Invalid access rejected
  test('rejects invalid operation access', () => {
    const op = { name: 'status', access: 'unsafe', params: [] };
    const res = parsePublishedSchema({
      schema: 'cli.schema.v1',
      tool: 'git2',
      operations: [op],
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues.some((i) => i.code === 'ENUM_VIOLATION' && i.message.includes('invalid access'))).toBe(true);
    }
  });

  // 11. Invalid returns rejected
  test('rejects invalid returns type', () => {
    const op = { name: 'status', returns: 'custom_class', params: [] };
    const res = parsePublishedSchema({
      schema: 'cli.schema.v1',
      tool: 'git2',
      operations: [op],
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues.some((i) => i.code === 'ENUM_VIOLATION' && i.message.includes('invalid returns'))).toBe(true);
    }
  });

  // 12. Param named dryrun rejected
  test('rejects param named dryrun', () => {
    const op = {
      name: 'commit',
      params: [{ name: 'dryrun', type: 'boolean' }],
    };
    const res = parsePublishedSchema({
      schema: 'cli.schema.v1',
      tool: 'git2',
      operations: [op],
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues.some((i) => i.message.includes('cannot be named "dryrun"'))).toBe(true);
    }
  });

  // 13. Invalid param name rejected
  test('rejects invalid param names in operations', () => {
    const op = {
      name: 'commit',
      params: [{ name: 'dry-run', type: 'boolean' }], // kebab-case not allowed in op params
    };
    const res = parsePublishedSchema({
      schema: 'cli.schema.v1',
      tool: 'git2',
      operations: [op],
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues.some((i) => i.message.includes('name must match ^[A-Za-z_]\\w*$'))).toBe(true);
    }
  });

  // 14. Invalid param type rejected
  test('rejects invalid param type', () => {
    const op = {
      name: 'status',
      params: [{ name: 'path', type: 'filepath' }],
    };
    const res = parsePublishedSchema({
      schema: 'cli.schema.v1',
      tool: 'git2',
      operations: [op],
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues.some((i) => i.code === 'ENUM_VIOLATION' && i.message.includes('invalid type'))).toBe(true);
    }
  });

  // 15. Invalid occurs rejected
  test('rejects invalid occurs', () => {
    const op = {
      name: 'status',
      params: [{ name: 'path', type: 'string', occurs: 'many' }],
    };
    const res = parsePublishedSchema({
      schema: 'cli.schema.v1',
      tool: 'git2',
      operations: [op],
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues.some((i) => i.code === 'ENUM_VIOLATION' && i.message.includes('invalid occurs'))).toBe(true);
    }
  });

  // 16. Invalid default value rejected
  test('rejects default value not matching param type', () => {
    const op = {
      name: 'status',
      params: [{ name: 'count', type: 'number', default: 'ten' }],
    };
    const res = parsePublishedSchema({
      schema: 'cli.schema.v1',
      tool: 'git2',
      operations: [op],
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues.some((i) => i.code === 'TYPE_MISMATCH' && i.message.includes('default value does not match'))).toBe(true);
    }
  });

  // 17. Global param names allow kebab-case
  test('global param names allow kebab-case like "dry-run"', () => {
    const doc: PublishedCliSchema = {
      schema: 'cli.schema.v1',
      tool: 'git2',
      policy: { dryrun: true, readonly: true },
      inputs: ['flags', 'json', 'graphql'],
      globals: [
        { name: 'dry-run', type: 'boolean', aliases: ['dryrun'] },
        { name: 'read-only', type: 'boolean' },
      ],
      operations: [],
    };
    const res = parsePublishedSchema(doc);
    expect(res.ok).toBe(true);
  });

  // 18. Schema warnings helper detects missing descriptions without failing
  test('schemaWarnings identifies missing descriptions and attaches doc.warnings', () => {
    const doc = publishSchema('git2', [
      {
        name: 'undocumented_op',
        params: [
          { name: 'undocumented_param', type: 'string' },
          { name: 'documented_param', type: 'string', description: 'Has description' },
        ],
      },
    ]);

    // Validation passes despite missing descriptions
    const res = parsePublishedSchema(doc);
    expect(res.ok).toBe(true);

    // schemaWarnings helper populates warnings
    const warnings = schemaWarnings(doc);
    expect(warnings.length).toBe(2);
    expect(warnings.some((w) => w.includes('operation "undocumented_op" is missing a description'))).toBe(true);
    expect(warnings.some((w) => w.includes('param "undocumented_param" of operation "undocumented_op" is missing a description'))).toBe(true);
    expect(doc.warnings).toEqual(warnings);
  });

  // 19. parsePublishedSchemaOrThrow compatibility wrapper
  test('parsePublishedSchemaOrThrow returns value or throws', () => {
    const validDoc = publishSchema('git2', [SAMPLE_OP]);
    expect(parsePublishedSchemaOrThrow(validDoc)).toEqual(validDoc);

    expect(() =>
      parsePublishedSchemaOrThrow({ schema: 'bad', tool: 'x', operations: [] }),
    ).toThrow();
  });

  // 20. isEffectful helper
  test('isEffectful returns false only for read access, true otherwise', () => {
    expect(isEffectful({ name: 'read_op', access: 'read', params: [] })).toBe(false);
    expect(isEffectful({ name: 'write_op', access: 'write', params: [] })).toBe(true);
    expect(isEffectful({ name: 'dyn_op', access: 'dynamic', params: [] })).toBe(true);
    expect(isEffectful({ name: 'unspecified_op', params: [] })).toBe(true);
    expect(isEffectful({ access: undefined })).toBe(true);
    expect(isEffectful({ access: 'read' })).toBe(false);
  });

  // 21. Rejects tool named __proto__, constructor, prototype
  test('parsePublishedSchema rejects tool named __proto__, constructor, prototype', () => {
    for (const reserved of ['__proto__', 'constructor', 'prototype']) {
      const doc = {
        schema: 'cli.schema.v1',
        tool: reserved,
        operations: [],
      };
      const res = parsePublishedSchema(doc);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.issues.some((i) => i.code === 'RESERVED_NAME' || i.code === 'DOCUMENT_PARSE')).toBe(true);
      }
    }
  });

  // 22. Rejects operation named __proto__, constructor, prototype
  test('parsePublishedSchema rejects operation named __proto__, constructor, prototype', () => {
    for (const reserved of ['__proto__', 'constructor', 'prototype']) {
      const doc = {
        schema: 'cli.schema.v1',
        tool: 'mytool',
        operations: [{ name: reserved, params: [] }],
      };
      const res = parsePublishedSchema(doc);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.issues.some((i) => i.code === 'RESERVED_NAME' || i.code === 'DOCUMENT_PARSE')).toBe(true);
      }
    }
  });

  // 23. Rejects param named __proto__, constructor, prototype
  test('parsePublishedSchema rejects param named __proto__, constructor, prototype', () => {
    for (const reserved of ['__proto__', 'constructor', 'prototype']) {
      const doc = {
        schema: 'cli.schema.v1',
        tool: 'mytool',
        operations: [
          {
            name: 'op1',
            params: [{ name: reserved, type: 'string' }],
          },
        ],
      };
      const res = parsePublishedSchema(doc);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.issues.some((i) => i.code === 'RESERVED_NAME')).toBe(true);
        expect(res.issues[0]?.message).toContain('reserved name');
      }
    }
  });

  // 24. Rejects param alias named __proto__, constructor, prototype
  test('parsePublishedSchema rejects param alias named __proto__, constructor, prototype', () => {
    for (const reserved of ['__proto__', 'constructor', 'prototype']) {
      const doc = {
        schema: 'cli.schema.v1',
        tool: 'mytool',
        operations: [
          {
            name: 'op1',
            params: [{ name: 'validParam', type: 'string', aliases: [reserved] }],
          },
        ],
      };
      const res = parsePublishedSchema(doc);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.issues.some((i) => i.code === 'RESERVED_NAME')).toBe(true);
        expect(res.issues[0]?.message).toContain('reserved name');
      }
    }
  });

  // 25. Rejects global param named __proto__, constructor, prototype
  test('parsePublishedSchema rejects global param named __proto__, constructor, prototype', () => {
    for (const reserved of ['__proto__', 'constructor', 'prototype']) {
      const doc = {
        schema: 'cli.schema.v1',
        tool: 'mytool',
        globals: [{ name: reserved, type: 'string' }],
        operations: [],
      };
      const res = parsePublishedSchema(doc);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.issues.some((i) => i.code === 'RESERVED_NAME')).toBe(true);
        expect(res.issues[0]?.message).toContain('reserved name');
      }
    }
  });

  // 26. Rejects global param alias named __proto__, constructor, prototype
  test('parsePublishedSchema rejects global param alias named __proto__, constructor, prototype', () => {
    for (const reserved of ['__proto__', 'constructor', 'prototype']) {
      const doc = {
        schema: 'cli.schema.v1',
        tool: 'mytool',
        globals: [{ name: 'validGlobal', type: 'string', aliases: [reserved] }],
        operations: [],
      };
      const res = parsePublishedSchema(doc);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.issues.some((i) => i.code === 'RESERVED_NAME')).toBe(true);
        expect(res.issues[0]?.message).toContain('reserved name');
      }
    }
  });
});

