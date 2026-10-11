/**
 * @fileoverview Conformance test runner for lmts against ../lmapi/conformance vectors.
 * If ../lmapi/conformance does not exist, tests skip cleanly.
 */

import { describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  describeForPrompt,
  encodeArgv,
  interpretCommand,
  parseArgvForm,
  parsePublishedSchema,
  resolveInput,
  validate,
  type OperationSchema,
  type ParamSpec,
  type PublishedCliSchema,
} from '../src/index.js';
import { parseSpec } from '../src/modules/index.js';

const CONFORMANCE_DIR = resolve(import.meta.dir, '../../lmapi/conformance');
const hasConformance = existsSync(CONFORMANCE_DIR);

describe('conformance vectors (lmapi)', () => {
  if (!hasConformance) {
    if (process.env.GITHUB_ACTIONS === 'true') {
      // In CI a missing lmapi checkout must fail the run, never silently skip the vectors.
      test('lmapi conformance vectors are checked out next to lmts', () => {
        throw new Error('../lmapi/conformance not found: check out lmctl-ai/lmapi beside lmts in the workflow');
      });
    } else {
      test.skip('Skipping conformance suite: ../lmapi/conformance directory not found', () => {});
    }
    return;
  }

  // 1. Validate vectors
  const validateDir = resolve(CONFORMANCE_DIR, 'validate');
  if (existsSync(validateDir)) {
    const files = readdirSync(validateDir).filter((f) => f.endsWith('.json'));
    for (const file of files) {
      const content = JSON.parse(readFileSync(resolve(validateDir, file), 'utf-8'));
      const cases: any[] = content.cases ?? (Array.isArray(content) ? content : [content]);

      describe(`validate/${file}`, () => {
        for (const tc of cases) {
          test(tc.name, () => {
            const schema: OperationSchema = tc.schema;
            const form = tc.form ?? 'flags';
            const res = validate(schema, tc.input, { form });

            if (tc.expect.ok === true) {
              expect(res.ok).toBe(true);
              if (res.ok) {
                expect(res.value).toEqual(tc.expect.params);
              }
            } else {
              expect(res.ok).toBe(false);
              if (!res.ok) {
                for (const expIssue of tc.expect.issues) {
                  const match = res.issues.find(
                    (i) =>
                      i.code === expIssue.code &&
                      (!expIssue.param || i.param === expIssue.param) &&
                      (!expIssue.suggestion || i.suggestion === expIssue.suggestion),
                  );
                  expect(match).toBeDefined();
                  if (match) {
                    expect(match.synopsis.length).toBeGreaterThan(0);
                    expect(match.usage.length).toBeGreaterThan(0);
                  }
                }
              }
            }
          });
        }
      });
    }
  }

  // 2. Argv vectors
  const argvDir = resolve(CONFORMANCE_DIR, 'argv');
  if (existsSync(argvDir)) {
    const files = readdirSync(argvDir).filter((f) => f.endsWith('.json'));
    for (const file of files) {
      const content = JSON.parse(readFileSync(resolve(argvDir, file), 'utf-8'));
      const cases: any[] = content.cases ?? (Array.isArray(content) ? content : [content]);

      describe(`argv/${file}`, () => {
        for (const tc of cases) {
          test(tc.name, () => {
            const schema: OperationSchema = tc.schema;
            const globals: ParamSpec[] = tc.globals ?? [];
            const res = parseArgvForm(tc.argv, schema, globals);

            if (tc.expect.ok === true) {
              expect(res.ok).toBe(true);
              if (res.ok) {
                expect(res.value.params).toEqual(tc.expect.params);
                if (tc.expect.positionals) {
                  expect(res.value.positionals).toEqual(tc.expect.positionals);
                }
                if (tc.expect.globals) {
                  expect(res.value.globals).toEqual(tc.expect.globals);
                }
              }
            } else {
              expect(res.ok).toBe(false);
              if (!res.ok) {
                for (const expIssue of tc.expect.issues) {
                  const match = res.issues.find(
                    (i) =>
                      i.code === expIssue.code &&
                      (!expIssue.param || i.param === expIssue.param) &&
                      (!expIssue.suggestion || i.suggestion === expIssue.suggestion),
                  );
                  expect(match).toBeDefined();
                  if (match) {
                    expect(match.synopsis.length).toBeGreaterThan(0);
                    expect(match.usage.length).toBeGreaterThan(0);
                  }
                }
              }
            }
          });
        }
      });
    }
  }

  // 3. Interpret vectors
  const interpretDir = resolve(CONFORMANCE_DIR, 'interpret');
  if (existsSync(interpretDir)) {
    const files = readdirSync(interpretDir).filter((f) => f.endsWith('.json'));
    for (const file of files) {
      const content = JSON.parse(readFileSync(resolve(interpretDir, file), 'utf-8'));
      const cases: any[] = content.cases ?? (Array.isArray(content) ? content : [content]);

      describe(`interpret/${file}`, () => {
        for (const tc of cases) {
          test(tc.name, () => {
            let schemas: PublishedCliSchema | PublishedCliSchema[];
            if (typeof tc.schemas === 'string') {
              const fixturePath = resolve(CONFORMANCE_DIR, tc.schemas);
              schemas = JSON.parse(readFileSync(fixturePath, 'utf-8'));
            } else {
              schemas = tc.schemas;
            }

            const res = interpretCommand(schemas, tc.line);

            if (tc.expect.ok === true) {
              expect(res.ok).toBe(true);
              if (res.ok) {
                expect(res.value.tool).toBe(tc.expect.tool);
                expect(res.value.op).toBe(tc.expect.op);
                expect(res.value.argv).toEqual(tc.expect.argv);
                expect(res.value.params).toEqual(tc.expect.params);
                if (tc.expect.positionals) {
                  expect(res.value.positionals).toEqual(tc.expect.positionals);
                }
                if (tc.expect.globals) {
                  expect(res.value.globals).toEqual(tc.expect.globals);
                }
                expect(res.value.effect).toBe(tc.expect.effect);
              }
            } else {
              expect(res.ok).toBe(false);
              if (!res.ok) {
                for (const expIssue of tc.expect.issues) {
                  const match = res.issues.find(
                    (i) =>
                      i.code === expIssue.code &&
                      (!expIssue.suggestion || i.suggestion === expIssue.suggestion),
                  );
                  expect(match).toBeDefined();
                  if (match) {
                    expect(match.synopsis.length).toBeGreaterThan(0);
                    expect(match.usage.length).toBeGreaterThan(0);
                  }
                }
              }
            }
          });
        }
      });
    }
  }

  // 4. Publish vectors
  const publishDir = resolve(CONFORMANCE_DIR, 'publish');
  if (existsSync(publishDir)) {
    const files = readdirSync(publishDir).filter((f) => f.endsWith('.json'));
    for (const file of files) {
      const content = JSON.parse(readFileSync(resolve(publishDir, file), 'utf-8'));
      const cases: any[] = content.cases ?? (Array.isArray(content) ? content : [content]);

      describe(`publish/${file}`, () => {
        for (const tc of cases) {
          test(tc.name, () => {
            const res = parsePublishedSchema(tc.document);

            if (tc.expect.ok === true) {
              expect(res.ok).toBe(true);
            } else {
              expect(res.ok).toBe(false);
              if (!res.ok) {
                for (const expIssue of tc.expect.issues) {
                  const match = res.issues.find(
                    (i) =>
                      i.code === expIssue.code &&
                      (!expIssue.param || i.param === expIssue.param) &&
                      (!expIssue.op || i.op === expIssue.op),
                  );
                  expect(match).toBeDefined();
                }
              }
            }
          });
        }
      });
    }
  }

  // 5. Prompt vectors
  const promptDir = resolve(CONFORMANCE_DIR, 'prompt');
  if (existsSync(promptDir)) {
    const casesFile = resolve(promptDir, 'cases.json');
    if (existsSync(casesFile)) {
      const content = JSON.parse(readFileSync(casesFile, 'utf-8'));
      const cases: any[] = content.cases ?? [content];

      describe('prompt', () => {
        for (const tc of cases) {
          test(tc.name, () => {
            const fixturePath = resolve(CONFORMANCE_DIR, tc.schemas);
            const goldenPath = resolve(promptDir, tc.golden);
            const schemaDoc: PublishedCliSchema = JSON.parse(readFileSync(fixturePath, 'utf-8'));
            const expected = readFileSync(goldenPath, 'utf-8');

            const rendered = describeForPrompt(schemaDoc);
            expect(rendered).toBe(expected);
          });
        }
      });
    }
  }

  // 6. Encode vectors: tokens after `--` compared exactly (schema order), named flags before it
  // as a multiset (their order follows the params object); the argv resolves back to the params.
  const encodeDir = resolve(CONFORMANCE_DIR, 'encode');
  if (existsSync(encodeDir)) {
    const files = readdirSync(encodeDir).filter((f) => f.endsWith('.json'));
    for (const file of files) {
      const content = JSON.parse(readFileSync(resolve(encodeDir, file), 'utf-8'));
      const cases: any[] = content.cases ?? (Array.isArray(content) ? content : [content]);

      describe(`encode/${file}`, () => {
        for (const tc of cases) {
          test(tc.name, () => {
            const schema: OperationSchema = tc.schema;
            const argv = encodeArgv(schema, tc.params, { positional: tc.options?.positional === true });
            const split = (a: string[]) => {
              const i = a.indexOf('--');
              return i < 0 ? { named: [...a], rest: [] as string[] } : { named: a.slice(0, i), rest: a.slice(i + 1) };
            };
            const got = split(argv);
            const want = split(tc.expect.argv);
            expect([...got.named].sort()).toEqual([...want.named].sort());
            expect(got.rest).toEqual(want.rest);
            expect(argv.includes('--')).toBe(tc.expect.argv.includes('--'));
            expect(resolveInput({ schema, argv }).params).toEqual(tc.params);
          });
        }
      });
    }
  }

  // 7. Spec vectors
  const specDir = resolve(CONFORMANCE_DIR, 'spec');
  if (existsSync(specDir)) {
    const files = readdirSync(specDir).filter((f) => f.endsWith('.json'));
    for (const file of files) {
      const content = JSON.parse(readFileSync(resolve(specDir, file), 'utf-8'));
      const cases: any[] = content.cases ?? (Array.isArray(content) ? content : [content]);

      describe(`spec/${file}`, () => {
        for (const tc of cases) {
          test(tc.name, () => {
            const res = parseSpec(tc.spec);
            if (tc.expect.ok === true) {
              expect(res.ok).toBe(true);
              if (res.ok) {
                expect(res.value.owner).toBe(tc.expect.owner);
                expect(res.value.repo).toBe(tc.expect.repo);
                expect(res.value.channel).toBe(tc.expect.channel);
                expect(res.value.key).toBe(tc.expect.key);
              }
            } else {
              expect(res.ok).toBe(false);
              if (!res.ok) {
                if (tc.expect.code) {
                  expect(res.code).toBe(tc.expect.code);
                }
              }
            }
          });
        }
      });
    }
  }
});
