/**
 * @fileoverview Tests for the published cli.schema.v1 document and generated
 * help — the "Swagger-for-CLI" acceptance criteria.
 */

import { describe, expect, test } from 'bun:test';

import {
  findOperation,
  parsePublishedSchema,
  parsePublishedSchemaOrThrow,
  publishSchema,
  renderOpHelp,
  renderToolHelp,
  synopsisForParam,
  validateParams,
  type OperationSchema,
} from '../src/index.js';

const LM_STATUS: OperationSchema = {
  name: 'lm_status',
  access: 'read',
  description: 'Structured git status',
  params: [
    { name: 'path', type: 'string', occurs: '?', default: '.' },
    { name: 'ignored', type: 'boolean', occurs: '?', default: false },
  ],
};

const LM_BLAME: OperationSchema = {
  name: 'lm_blame',
  access: 'read',
  description: 'Per-line blame',
  params: [
    { name: 'path', type: 'string', occurs: '?', default: '.' },
    { name: 'file', type: 'string' },
    { name: 'revision', type: 'string', occurs: '?', default: 'HEAD' },
  ],
};

describe('publishSchema', () => {
  test('documents carry the v1 tag and advertise all three input forms', () => {
    const doc = publishSchema('git2', [LM_STATUS, LM_BLAME]);
    expect(doc.schema).toBe('cli.schema.v1');
    expect(doc.tool).toBe('git2');
    expect(doc.inputs).toEqual(['flags', 'json', 'graphql']);
    expect(doc.policy).toEqual({ dryrun: true, readonly: true });
    expect(doc.operations.map((o) => o.name)).toEqual(['lm_status', 'lm_blame']);
  });

  test('findOperation locates by name', () => {
    const doc = publishSchema('git2', [LM_STATUS, LM_BLAME]);
    expect(findOperation(doc, 'lm_blame')?.params.length).toBe(3);
    expect(findOperation(doc, 'nope')).toBeUndefined();
  });
});

describe('parsePublishedSchema', () => {
  test('accepts a well-formed document', () => {
    const doc = publishSchema('git2', [LM_STATUS]);
    const res = parsePublishedSchema(doc);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value).toEqual(doc);
    expect(parsePublishedSchemaOrThrow(doc)).toEqual(doc);
  });

  test('rejects wrong schema tag', () => {
    expect(() =>
      parsePublishedSchemaOrThrow({ schema: 'v2', tool: 'x', operations: [] }),
    ).toThrow(/unsupported schema tag/);
    const res = parsePublishedSchema({ schema: 'v2', tool: 'x', operations: [] });
    expect(res.ok).toBe(false);
  });

  test('rejects non-array operations', () => {
    expect(() =>
      parsePublishedSchemaOrThrow({ schema: 'cli.schema.v1', tool: 'x', operations: {} }),
    ).toThrow(/operations must be an array/);
    const res = parsePublishedSchema({ schema: 'cli.schema.v1', tool: 'x', operations: {} });
    expect(res.ok).toBe(false);
  });
});

describe('renderOpHelp', () => {
  test('generates usage line with brackets for optional, bare for required', () => {
    const help = renderOpHelp('git2', LM_BLAME);
    expect(help).toContain('git2 lm_blame');
    expect(help).toContain('--path <string>');
    expect(help).toContain('--file <string>');
    expect(help).toContain('[--revision <string>]');
    expect(help).toContain('[required]');
  });

  test('enums are rendered with `one of:`', () => {
    const help = renderOpHelp('gh2', {
      name: 'list_pull_requests',
      access: 'read',
      params: [
        {
          name: 'state',
          type: 'string',
          occurs: '?',
          enum: ['open', 'closed', 'all'],
          default: 'open',
        },
      ],
    });
    expect(help).toContain('one of: open, closed, all');
    expect(help).toContain('(default: "open")');
  });

  test('cardinality marks and aliases on positional and flag parameters', () => {
    const schema: OperationSchema = {
      name: 'test_cardinality',
      access: 'read',
      description: 'Op to test all 4 cardinality marks and aliases',
      params: [
        { name: 'reqPos', type: 'string', positional: true, occurs: '1', description: 'required positional' },
        { name: 'optPos', type: 'string', positional: true, occurs: '?', description: 'optional positional' },
        { name: 'plusPos', type: 'string', positional: true, occurs: '+', description: 'one-or-more positional' },
        { name: 'starPos', type: 'string', positional: true, occurs: '*', description: 'zero-or-more positional' },
        { name: 'reqFlag', type: 'string', occurs: '1', aliases: ['rf', 'req-alias'], description: 'required flag' },
        { name: 'optFlag', type: 'string', occurs: '?', default: 'def_val', description: 'optional flag' },
        { name: 'plusFlag', type: 'string', occurs: '+', description: 'one-or-more flag' },
        { name: 'starFlag', type: 'string', occurs: '*', aliases: ['sf'], description: 'zero-or-more flag' },
      ],
    };
    const help = renderOpHelp('tool', schema);

    // 1. required positional <x>
    expect(help).toContain('<reqPos>');
    // 2. optional positional [x]
    expect(help).toContain('[optPos]');
    // 3. one-or-more positional <x>...
    expect(help).toContain('<plusPos>...');
    // 4. zero-or-more positional [x]...
    expect(help).toContain('[starPos]...');

    // 5. flag cardinality marks in usage line
    expect(help).toContain('--req-flag <string>');
    expect(help).toContain('[--opt-flag <string>]');
    expect(help).toContain('--plus-flag <string>...');
    expect(help).toContain('[--star-flag <string>]...');

    // 6. options section marks, aliases, defaults
    expect(help).toContain('--plus-flag <string>...');
    expect(help).toContain('--star-flag <string>...');
    expect(help).toContain('(aliases: --rf, --req-alias)');
    expect(help).toContain('(aliases: --sf)');
    expect(help).toContain('(default: "def_val")');
  });

  test('renderToolHelp lists first-line description and global options', () => {
    const schemas: OperationSchema[] = [
      {
        name: 'multi_line_op',
        access: 'write',
        description: 'First line summary\nSecond line details that should be omitted\nThird line',
        params: [],
      },
    ];
    const globals = [
      { name: 'dryrun', type: 'boolean' as const, occurs: '?' as const, aliases: ['dry-run'], description: 'Simulate' },
      { name: 'confirm', type: 'boolean' as const, occurs: '?' as const, description: 'Confirm dangerous ops' },
    ];
    const helpWithGlobals = renderToolHelp('mytool', 'My tool desc', schemas, globals);
    expect(helpWithGlobals).toContain('multi_line_op            [write]  First line summary');
    expect(helpWithGlobals).not.toContain('Second line details');
    expect(helpWithGlobals).toContain('--dryrun (--dry-run)');
    expect(helpWithGlobals).toContain('--confirm');
    expect(helpWithGlobals).toContain('Simulate');
  });
});

describe('synopsisForParam', () => {
  test('used in error messages', () => {
    const p = {
      name: 'state',
      type: 'string' as const,
      enum: ['open', 'closed'],
    };
    expect(synopsisForParam(p)).toContain('--state <string>');
    expect(synopsisForParam(p)).toContain('one of: open, closed');
  });
});

describe('validation errors reference the schema', () => {
  test('missing required includes synopsis', () => {
    try {
      validateParams(LM_BLAME, {});
      throw new Error('unreachable');
    } catch (e) {
      const err = e as { message: string; details?: { synopsis?: string } };
      expect(err.message).toContain('missing required param');
      expect(err.details?.synopsis).toBe('--file <string>');
    }
  });

  test('enum violation includes synopsis and allowed set', () => {
    const schema: OperationSchema = {
      name: 'list_pull_requests',
      params: [
        { name: 'state', type: 'string', occurs: '?', enum: ['open', 'closed', 'all'], default: 'open' },
      ],
    };
    try {
      validateParams(schema, { state: 'purple' });
      throw new Error('unreachable');
    } catch (e) {
      const err = e as { message: string; details?: { synopsis?: string; allowed?: string[] } };
      expect(err.message).toContain('allowed: open, closed, all');
      expect(err.details?.synopsis).toBe('--state <string> one of: open, closed, all');
    }
  });

  test('type mismatch includes synopsis', () => {
    try {
      validateParams(LM_STATUS, { ignored: 'maybe' });
      throw new Error('unreachable');
    } catch (e) {
      const err = e as { details?: { synopsis?: string } };
      expect(err.details?.synopsis).toBe('--ignored');
    }
  });
});

describe('consumer round-trip', () => {
  test('a consumer can validate input against the published document', () => {
    // The producer publishes its schema:
    const doc = publishSchema('git2', [LM_STATUS]);

    // A consumer finds the op and validates a candidate input against the
    // published schema (not the producer's in-memory copy):
    const op = findOperation(doc, 'lm_status');
    if (!op) throw new Error('unreachable');

    const ok = validateParams(op, { ignored: true, path: '/x' });
    expect(ok).toEqual({ ignored: true, path: '/x' });

    expect(() => validateParams(op, { bogus: 1 })).toThrow(/unknown param: bogus/);
  });

  test('S5: parsePublishedSchema rejects unknown param keys (min, max, conflicts)', () => {
    const rawDoc = {
      schema: 'cli.schema.v1',
      tool: 'git2',
      operations: [
        {
          name: 'op_with_ranges',
          params: [
            {
              name: 'count',
              type: 'number',
              min: 1,
              max: 10,
              conflicts: ['other'],
            },
          ],
        },
      ],
    };
    const res = parsePublishedSchema(rawDoc);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      const issueCodes = res.issues.map((i) => i.code);
      expect(issueCodes).toContain('UNKNOWN_PARAM');
      const messages = res.issues.map((i) => i.message);
      expect(messages.some((m) => m.includes('min'))).toBe(true);
      expect(messages.some((m) => m.includes('max'))).toBe(true);
      expect(messages.some((m) => m.includes('conflicts'))).toBe(true);
    }
  });
});
