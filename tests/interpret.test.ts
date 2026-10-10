/**
 * @fileoverview Tests for command-line interpreter, tokenizer, classifier, and prompt describer.
 */

import { describe, expect, test } from 'bun:test';
import {
  classifyOperation,
  describeForPrompt,
  interpretCommand,
  tokenizeSimpleCommand,
} from '../src/interpret.js';
import type { OperationSchema, ParamSpec, PublishedCliSchema } from '../src/types.js';
import git2Fixture from './fixtures/git2.cli.schema.v1.json';

const git2Schema = git2Fixture as unknown as PublishedCliSchema;

const sampleOpRead: OperationSchema = {
  name: 'inspect',
  access: 'read',
  description: 'Inspect resource',
  params: [
    { name: 'id', type: 'string', occurs: '1', positional: true, description: 'Resource ID' },
    { name: 'verbose', type: 'boolean', occurs: '?', description: 'Verbose mode' },
  ],
};

const sampleOpWrite: OperationSchema = {
  name: 'create',
  access: 'write',
  description: 'Create resource',
  params: [
    { name: 'name', type: 'string', occurs: '1', description: 'Resource name' },
    { name: 'count', type: 'number', occurs: '?', default: 1, description: 'Count' },
    { name: 'tags', type: 'array', items: 'string', occurs: '*', description: 'Tags' },
  ],
};

const sampleOpDynamic: OperationSchema = {
  name: 'sync',
  access: 'dynamic',
  description: 'Sync resources',
  params: [],
};

const sampleOpMissingAccess: OperationSchema = {
  name: 'unspecified',
  description: 'Op without access field',
  params: [],
};

const sampleToolSchema: PublishedCliSchema = {
  schema: 'cli.schema.v1',
  tool: 'mytool',
  version: '1.0.0',
  policy: { dryrun: true, readonly: true },
  inputs: ['flags', 'json', 'graphql'],
  globals: [
    { name: 'dryrun', type: 'boolean', occurs: '?', aliases: ['dry-run'] },
    { name: 'confirm', type: 'boolean', occurs: '?' },
  ],
  operations: [sampleOpRead, sampleOpWrite, sampleOpDynamic, sampleOpMissingAccess],
};

describe('tokenizeSimpleCommand', () => {
  // 1. Basic tokenization
  test('tokenizes simple whitespace-separated words', () => {
    const res = tokenizeSimpleCommand('git2 commit --message hello');
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value).toEqual(['git2', 'commit', '--message', 'hello']);
    }
  });

  // 2. Single quotes literal
  test('single quotes preserve content literally including shell characters', () => {
    const res = tokenizeSimpleCommand("git2 commit --message 'hello world; && | > < $VAR `cmd`'");
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value).toEqual(['git2', 'commit', '--message', 'hello world; && | > < $VAR `cmd`']);
    }
  });

  // 3. Double quotes with spaces
  test('double quotes preserve spaces and regular characters', () => {
    const res = tokenizeSimpleCommand('git2 commit --message "hello world"');
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value).toEqual(['git2', 'commit', '--message', 'hello world']);
    }
  });

  // 4. Double quotes with escaped quotes and backslashes
  test('double quotes allow escaping only of " and \\', () => {
    const res = tokenizeSimpleCommand('git2 commit --message "hello \\"world\\" and \\\\ path"');
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value).toEqual(['git2', 'commit', '--message', 'hello "world" and \\ path']);
    }
  });

  // 5. Backslash escapes outside quotes
  test('backslash escapes space outside quotes', () => {
    const res = tokenizeSimpleCommand('git2 commit --message hello\\ world');
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value).toEqual(['git2', 'commit', '--message', 'hello world']);
    }
  });

  // 6. Backslash escapes quotes and backslashes outside quotes
  test('backslash escapes quotes and backslashes outside quotes', () => {
    const res = tokenizeSimpleCommand('git2 commit --message \\"hello\\"\\\\world');
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value).toEqual(['git2', 'commit', '--message', '"hello"\\world']);
    }
  });

  // 7. Empty string argument in double quotes
  test('empty string argument in double quotes produces empty string token', () => {
    const res = tokenizeSimpleCommand('git2 commit --message ""');
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value).toEqual(['git2', 'commit', '--message', '']);
    }
  });

  // 8. Empty string argument in single quotes
  test('empty string argument in single quotes produces empty string token', () => {
    const res = tokenizeSimpleCommand("git2 commit --message ''");
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value).toEqual(['git2', 'commit', '--message', '']);
    }
  });

  // 9. Multiple empty string arguments
  test('multiple empty string arguments are preserved', () => {
    const res = tokenizeSimpleCommand('git2 test "" \'\'');
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value).toEqual(['git2', 'test', '', '']);
    }
  });

  // 10. = in flag value outside quotes
  test('= in flag value outside quotes works as a single token', () => {
    const res = tokenizeSimpleCommand('git2 commit --message=hello');
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value).toEqual(['git2', 'commit', '--message=hello']);
    }
  });

  // 11. = in quoted flag value
  test('= with quoted value works', () => {
    const res = tokenizeSimpleCommand('git2 commit --message="key=value with spaces"');
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value).toEqual(['git2', 'commit', '--message=key=value with spaces']);
    }
  });

  // 12. Unicode arguments
  test('unicode characters and emojis are preserved', () => {
    const res = tokenizeSimpleCommand('git2 commit --message "コミット 🚀 日本語"');
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value).toEqual(['git2', 'commit', '--message', 'コミット 🚀 日本語']);
    }
  });

  // 13. Empty line or whitespace returns empty array
  test('empty input returns empty token array', () => {
    const res1 = tokenizeSimpleCommand('');
    expect(res1.ok).toBe(true);
    if (res1.ok) expect(res1.value).toEqual([]);

    const res2 = tokenizeSimpleCommand('    \t   ');
    expect(res2.ok).toBe(true);
    if (res2.ok) expect(res2.value).toEqual([]);
  });

  // 14. Adjacent quotes and text concatenate
  test('adjacent quotes and unquoted parts concatenate into one token', () => {
    const res = tokenizeSimpleCommand(`git2 commit --message="hello "'world'`);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value).toEqual(['git2', 'commit', '--message=hello world']);
    }
  });

  // 15. # inside word is not a comment
  test('# in middle of word is not treated as a comment', () => {
    const res = tokenizeSimpleCommand('git2 commit --message issue#123');
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value).toEqual(['git2', 'commit', '--message', 'issue#123']);
    }
  });

  // 16. ~ in middle of word is not tilde expansion
  test('~ in middle of word is not treated as tilde expansion', () => {
    const res = tokenizeSimpleCommand('git2 lm_diff HEAD~1');
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value).toEqual(['git2', 'lm_diff', 'HEAD~1']);
    }
  });

  // Refusal tests
  test('refuses unquoted semicolon ;', () => {
    const res = tokenizeSimpleCommand('git2 lm_status; rm -rf /');
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues[0]!.code).toBe('SHELL_SYNTAX');
      expect(res.issues[0]!.message).toContain(';');
    }
  });

  test('refuses unquoted ampersand &', () => {
    const res = tokenizeSimpleCommand('git2 lm_status &');
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues[0]!.code).toBe('SHELL_SYNTAX');
      expect(res.issues[0]!.message).toContain('&');
    }
  });

  test('refuses unquoted double ampersand &&', () => {
    const res = tokenizeSimpleCommand('git2 lm_status && curl x');
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues[0]!.code).toBe('SHELL_SYNTAX');
      expect(res.issues[0]!.message).toContain('&&');
    }
  });

  test('refuses unquoted pipe |', () => {
    const res = tokenizeSimpleCommand('git2 lm_status | sh');
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues[0]!.code).toBe('SHELL_SYNTAX');
      expect(res.issues[0]!.message).toContain('|');
    }
  });

  test('refuses unquoted double pipe ||', () => {
    const res = tokenizeSimpleCommand('git2 lm_status || echo fail');
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues[0]!.code).toBe('SHELL_SYNTAX');
      expect(res.issues[0]!.message).toContain('||');
    }
  });

  test('refuses unquoted command substitution $(id)', () => {
    const res = tokenizeSimpleCommand('git2 lm_status $(id)');
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues[0]!.code).toBe('SHELL_SYNTAX');
      expect(res.issues[0]!.message).toContain('$');
    }
  });

  test('refuses unquoted variable expansion $VAR', () => {
    const res = tokenizeSimpleCommand('git2 lm_status $HOME');
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues[0]!.code).toBe('SHELL_SYNTAX');
      expect(res.issues[0]!.message).toContain('$');
    }
  });

  test('refuses unquoted backticks `id`', () => {
    const res = tokenizeSimpleCommand('git2 lm_status `id`');
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues[0]!.code).toBe('SHELL_SYNTAX');
      expect(res.issues[0]!.message).toContain('`');
    }
  });

  test('refuses unquoted redirection >', () => {
    const res = tokenizeSimpleCommand('git2 lm_status > /etc/passwd');
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues[0]!.code).toBe('SHELL_SYNTAX');
      expect(res.issues[0]!.message).toContain('>');
    }
  });

  test('refuses unquoted append redirection >>', () => {
    const res = tokenizeSimpleCommand('git2 lm_status >> out.txt');
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues[0]!.code).toBe('SHELL_SYNTAX');
      expect(res.issues[0]!.message).toContain('>>');
    }
  });

  test('refuses unquoted input redirection <', () => {
    const res = tokenizeSimpleCommand('git2 lm_status < /dev/null');
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues[0]!.code).toBe('SHELL_SYNTAX');
      expect(res.issues[0]!.message).toContain('<');
    }
  });

  test('refuses unquoted heredoc redirection <<', () => {
    const res = tokenizeSimpleCommand('git2 lm_status << EOF');
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues[0]!.code).toBe('SHELL_SYNTAX');
      expect(res.issues[0]!.message).toContain('<<');
    }
  });

  test('refuses unquoted parentheses ( )', () => {
    const res = tokenizeSimpleCommand('git2 (subshell)');
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues[0]!.code).toBe('SHELL_SYNTAX');
      expect(res.issues[0]!.message).toContain('(');
    }
  });

  test('refuses unquoted braces { }', () => {
    const res = tokenizeSimpleCommand('git2 { echo hi; }');
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues[0]!.code).toBe('SHELL_SYNTAX');
      expect(res.issues[0]!.message).toContain('{');
    }
  });

  test('refuses leading NAME=value environment assignment', () => {
    const res = tokenizeSimpleCommand('FOO=1 git2 lm_status');
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues[0]!.code).toBe('SHELL_SYNTAX');
      expect(res.issues[0]!.message).toContain('FOO=1');
    }
  });

  test('refuses newline \\n in command', () => {
    const res = tokenizeSimpleCommand('git2 lm_status\nrm x');
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues[0]!.code).toBe('SHELL_SYNTAX');
      expect(res.issues[0]!.message).toContain('newline');
    }
  });

  test('refuses carriage return \\r in command', () => {
    const res = tokenizeSimpleCommand('git2 lm_status\rrm x');
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues[0]!.code).toBe('SHELL_SYNTAX');
      expect(res.issues[0]!.message).toContain('newline');
    }
  });

  test('refuses NUL byte in command', () => {
    const res = tokenizeSimpleCommand('git2 lm_status\0rm x');
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues[0]!.code).toBe('SHELL_SYNTAX');
    }
  });

  test('refuses unquoted glob *', () => {
    const res = tokenizeSimpleCommand('git2 lm_diff *.ts');
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues[0]!.code).toBe('SHELL_SYNTAX');
      expect(res.issues[0]!.message).toContain('*');
    }
  });

  test('refuses unquoted glob ?', () => {
    const res = tokenizeSimpleCommand('git2 lm_diff file?.ts');
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues[0]!.code).toBe('SHELL_SYNTAX');
      expect(res.issues[0]!.message).toContain('?');
    }
  });

  test('refuses unquoted glob [', () => {
    const res = tokenizeSimpleCommand('git2 lm_diff file[0-9].ts');
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues[0]!.code).toBe('SHELL_SYNTAX');
      expect(res.issues[0]!.message).toContain('[');
    }
  });

  test('refuses word starting with unquoted ~', () => {
    const res1 = tokenizeSimpleCommand('git2 lm_log ~');
    expect(res1.ok).toBe(false);
    if (!res1.ok) {
      expect(res1.issues[0]!.code).toBe('SHELL_SYNTAX');
      expect(res1.issues[0]!.message).toContain('~');
    }

    const res2 = tokenizeSimpleCommand('git2 lm_log ~/repo');
    expect(res2.ok).toBe(false);
    if (!res2.ok) {
      expect(res2.issues[0]!.code).toBe('SHELL_SYNTAX');
      expect(res2.issues[0]!.message).toContain('~');
    }
  });

  test('refuses shell comment # at word start', () => {
    const res = tokenizeSimpleCommand('git2 lm_status # a comment');
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues[0]!.code).toBe('SHELL_SYNTAX');
      expect(res.issues[0]!.message).toContain('#');
    }
  });

  test('refuses shell comment # at beginning of line', () => {
    const res = tokenizeSimpleCommand('# just a comment');
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues[0]!.code).toBe('SHELL_SYNTAX');
      expect(res.issues[0]!.message).toContain('#');
    }
  });

  test('refuses unterminated single quote', () => {
    const res = tokenizeSimpleCommand("git2 commit --message 'unterminated");
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues[0]!.code).toBe('SHELL_SYNTAX');
      expect(res.issues[0]!.message).toContain('unterminated single quote');
    }
  });

  test('refuses unterminated double quote', () => {
    const res = tokenizeSimpleCommand('git2 commit --message "unterminated');
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues[0]!.code).toBe('SHELL_SYNTAX');
      expect(res.issues[0]!.message).toContain('unterminated double quote');
    }
  });

  test('refuses $ variable expansion inside double quotes', () => {
    const res = tokenizeSimpleCommand('git2 commit --message "$FOO"');
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues[0]!.code).toBe('SHELL_SYNTAX');
      expect(res.issues[0]!.message).toContain('$');
    }
  });

  test('refuses $(...) command substitution inside double quotes', () => {
    const res = tokenizeSimpleCommand('git2 commit --message "$(whoami)"');
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues[0]!.code).toBe('SHELL_SYNTAX');
      expect(res.issues[0]!.message).toContain('$(...)');
    }
  });

  test('refuses backtick substitution inside double quotes', () => {
    const res = tokenizeSimpleCommand('git2 commit --message "`whoami`"');
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues[0]!.code).toBe('SHELL_SYNTAX');
      expect(res.issues[0]!.message).toContain('`');
    }
  });
});

describe('interpretCommand', () => {
  test('rejects unknown tool with edit distance suggestion', () => {
    const res = interpretCommand([git2Schema, sampleToolSchema], 'gti2 lm_status');
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues[0]!.code).toBe('UNKNOWN_TOOL');
      expect(res.issues[0]!.suggestion).toBe('git2');
      expect(res.issues[0]!.message).toContain('Available tools:');
      expect(res.issues[0]!.synopsis.length).toBeGreaterThan(0);
      expect(res.issues[0]!.usage.length).toBeGreaterThan(0);
    }
  });

  test('rejects unknown tool without suggestion when distance > 2', () => {
    const res = interpretCommand([git2Schema], 'foobar lm_status');
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues[0]!.code).toBe('UNKNOWN_TOOL');
      expect(res.issues[0]!.suggestion).toBeUndefined();
    }
  });

  test('rejects missing operation after tool', () => {
    const res = interpretCommand(git2Schema, 'git2');
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues[0]!.code).toBe('UNKNOWN_OPERATION');
      expect(res.issues[0]!.message).toContain('missing operation');
    }
  });

  test('rejects flag immediately after tool with FLAG_BEFORE_OP', () => {
    const res = interpretCommand(git2Schema, 'git2 --schema');
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues[0]!.code).toBe('FLAG_BEFORE_OP');
      expect(res.issues[0]!.message).toContain('--schema');
      expect(res.issues[0]!.synopsis.length).toBeGreaterThan(0);
      expect(res.issues[0]!.usage.length).toBeGreaterThan(0);
    }
  });

  test('rejects unknown operation with edit distance suggestion', () => {
    const res = interpretCommand(git2Schema, 'git2 lm_statux');
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues[0]!.code).toBe('UNKNOWN_OPERATION');
      expect(res.issues[0]!.suggestion).toBe('lm_status');
      expect(res.issues[0]!.message).toContain('Available operations:');
    }
  });

  test('parses and validates typed params and positionals into Interpreted', () => {
    const res = interpretCommand(sampleToolSchema, 'mytool inspect res123 --verbose');
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.tool).toBe('mytool');
      expect(res.value.op).toBe('inspect');
      expect(res.value.argv).toEqual(['mytool', 'inspect', 'res123', '--verbose']);
      expect(res.value.positionals).toEqual(['res123']);
      expect(res.value.params).toEqual({ id: 'res123', verbose: true });
      expect(res.value.effect).toBe('read');
      expect(res.value.access).toBe('read');
    }
  });

  test('extracts globals without polluting params', () => {
    const res = interpretCommand(
      sampleToolSchema,
      'mytool create --name myres --dryrun --confirm',
      {
        globals: [
          { name: 'dryrun', type: 'boolean', occurs: '?' },
          { name: 'confirm', type: 'boolean', occurs: '?' },
        ],
      },
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.globals).toEqual({ dryrun: true, confirm: true });
      expect(res.value.params.dryrun).toBeUndefined();
      expect(res.value.params.confirm).toBeUndefined();
      expect(res.value.params.name).toBe('myres');
      expect(res.value.params.count).toBe(1); // default applied
      expect(res.value.effect).toBe('effectful');
      expect(res.value.access).toBe('write');
    }
  });

  test('collects duplicate flags as issues', () => {
    const res = interpretCommand(sampleToolSchema, 'mytool create --name a --name b');
    expect(res.ok).toBe(false);
    if (!res.ok) {
      const dup = res.issues.find((i) => i.code === 'DUPLICATE_FLAG');
      expect(dup).toBeDefined();
    }
  });

  test('collects missing required parameter issue', () => {
    const res = interpretCommand(sampleToolSchema, 'mytool create');
    expect(res.ok).toBe(false);
    if (!res.ok) {
      const missing = res.issues.find((i) => i.code === 'MISSING_REQUIRED');
      expect(missing).toBeDefined();
      expect(missing!.param).toBe('name');
    }
  });

  test('all issues always carry non-empty synopsis and usage', () => {
    const res = interpretCommand(sampleToolSchema, 'mytool create --unknown-flag');
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues.length).toBeGreaterThan(0);
      for (const issue of res.issues) {
        expect(typeof issue.synopsis).toBe('string');
        expect(issue.synopsis.length).toBeGreaterThan(0);
        expect(typeof issue.usage).toBe('string');
        expect(issue.usage.length).toBeGreaterThan(0);
      }
    }
  });

  test('null-prototype safe records in Interpreted', () => {
    const res = interpretCommand(sampleToolSchema, 'mytool inspect res123');
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(Object.getPrototypeOf(res.value.params)).toBeNull();
      expect(Object.getPrototypeOf(res.value.globals)).toBeNull();
    }
  });
});

describe('classifyOperation', () => {
  test('read access yields read', () => {
    expect(classifyOperation(sampleOpRead)).toBe('read');
  });

  test('write access yields effectful', () => {
    expect(classifyOperation(sampleOpWrite)).toBe('effectful');
  });

  test('dynamic access yields effectful', () => {
    expect(classifyOperation(sampleOpDynamic)).toBe('effectful');
  });

  test('missing access yields effectful', () => {
    expect(classifyOperation(sampleOpMissingAccess)).toBe('effectful');
  });

  test('schema cannot upgrade itself to read-only', () => {
    // Dynamic access can mutate state depending on inputs, so safety invariant treats it as effectful
    const dynOp: OperationSchema = { name: 'safe_looking', access: 'dynamic', params: [] };
    expect(classifyOperation(dynOp)).toBe('effectful');
  });
});

describe('describeForPrompt', () => {
  test('matches golden rendering of git2 fixture', () => {
    const rendered = describeForPrompt(git2Schema);

    // Verify key elements
    expect(rendered.startsWith('# git2')).toBe(true);
    expect(rendered).toContain('git2 commit [--allow-empty] [--amend] [--author <object>] --message <string> [--no-verify] [--path <string>] (effectful) — Create a commit');
    expect(rendered).toContain('git2 cherry_pick --commits <string>... [--mainline <number>] [--no-commit] [--path <string>] [--signoff] [--strategy <string>] (effectful) — Apply commits on top');
    expect(rendered).toContain('git2 status [--ignore-submodules] [--include-untracked] [--path <string>] (read) — Show working tree status');
    expect(rendered).toContain('Rules:');
    expect(rendered).toContain('1. One simple command:');
    expect(rendered).toContain('2. Quote values with spaces:');
    expect(rendered).toContain('3. No shell operators:');

    // Golden string snapshot check
    const expected = "# git2\ngit2 add [--all] [--force] [--path <string>] [--paths <string>...] [--update] (effectful) — Stage files\ngit2 blame [--end-line <number>] --file <string> [--ignore-whitespace] [--path <string>] [--start-line <number>] (read) — Blame a file\ngit2 branch_create --branch-name <string> [--force] [--path <string>] [--start-point <string>] (effectful) — Create a branch\ngit2 branch_current [--path <string>] (read) — Show current branch\ngit2 branch_delete --branch-name <string> [--force] [--path <string>] (effectful) — Delete a branch\ngit2 branch_list [--all] [--limit <number>] [--merged] [--no-merged] [--path <string>] [--remote] (read) — List branches\ngit2 branch_rename --branch-name <string> [--force] --new-branch-name <string> [--path <string>] (effectful) — Rename a branch\ngit2 checkout <target> [--create-branch] [--force] [--path <string>] [--paths <string>...] [--track] (effectful) — Checkout a branch/commit/paths\ngit2 cherry_pick --commits <string>... [--mainline <number>] [--no-commit] [--path <string>] [--signoff] [--strategy <string>] (effectful) — Apply commits on top\ngit2 clean [--directories] [--dry-run] [--force] [--ignored] [--path <string>] (effectful) — Remove untracked files / directories\ngit2 clone [--bare] [--branch <string>] [--depth <number>] --local-path <string> [--mirror] --remote-url <string> (effectful) — Clone a remote repository\ngit2 commit [--allow-empty] [--amend] [--author <object>] --message <string> [--no-verify] [--path <string>] (effectful) — Create a commit\ngit2 diff [--commit1 <string>] [--commit2 <string>] [--exclude-patterns <string>...] [--include-untracked] [--name-only] [--path <string>] [--paths <string>...] [--staged] [--stat] [--unified <number>] (read) — Show diffs\ngit2 fetch [--depth <number>] [--path <string>] [--prune] [--remote <string>] [--tags] (effectful) — Fetch from a remote\ngit2 init [--bare] [--initial-branch <string>] [--path <string>] (effectful) — Initialize a new git repository\ngit2 lm_blame --file <string> [--path <string>] [--revision <string>] (read) — Per-line blame with author metadata\ngit2 lm_branch [--all] [--path <string>] (read) — Branches with upstream and ahead/behind\ngit2 lm_diff [--from <string>] [--path <string>] [--paths <string>...] [--staged] [--to <string>] (read) — Structured unified diff with hunks and byte-preserving content\ngit2 lm_log [--max-count <number>] [--path <string>] [--revision <string>] (read) — Structured commit log with author/committer metadata\ngit2 lm_ls_files [--path <string>] [--paths <string>...] (read) — List index entries with mode/stage\ngit2 lm_remote [--path <string>] (read) — Remotes with credentials redacted from URLs\ngit2 lm_rev_parse [--path <string>] [--revision <string>] (read) — Resolve a revision and peel to commit\ngit2 lm_show [--file <string>] [--path <string>] [--revision <string>] (read) — Show a commit with metadata, or a file from its tree\ngit2 lm_status [--ignored] [--path <string>] (read) — Structured git status (porcelain v1, byte-preserving paths)\ngit2 log [--author <string>] [--branch <string>] [--file <string>] [--follow] [--grep <string>] [--max-count <number>] [--path <string>] [--since <string>] [--skip <number>] [--until <string>] (read) — Commit history\ngit2 merge [--abort] --branch <string> [--message <string>] [--no-fast-forward] [--path <string>] [--squash] [--strategy <string>] (effectful) — Merge a branch\ngit2 pull [--branch <string>] [--ff-only] [--path <string>] [--rebase] [--remote <string>] (effectful) — Pull from a remote\ngit2 push [--branch <string>] [--delete] [--dry-run] [--force] [--force-with-lease] [--path <string>] [--remote <string>] [--set-upstream] [--tags] (effectful) — Push to a remote\ngit2 rebase [--abort] --branch <string> [--continue-op] [--interactive] [--onto <string>] [--path <string>] [--preserve-merges] (effectful) — Rebase current branch\ngit2 reflog [--max-count <number>] [--path <string>] [--ref <string>] (read) — Show reflog\ngit2 remote_add --name <string> [--path <string>] --url <string> (effectful) — Add a remote\ngit2 remote_get_url --name <string> [--path <string>] (read) — Get remote URL\ngit2 remote_list [--path <string>] (read) — List remotes\ngit2 remote_remove --name <string> [--path <string>] (effectful) — Remove a remote\ngit2 remote_set_url --name <string> [--path <string>] [--push] --url <string> (effectful) — Set remote URL\ngit2 reset [--commit <string>] [--mode <soft|mixed|hard|merge|keep>] [--path <string>] [--paths <string>...] (effectful) — Reset HEAD / unstage paths\ngit2 show [--file-path <string>] [--format <string>] --object <string> [--path <string>] [--stat] (read) — Show a git object (commit, tree, blob, tag)\ngit2 stash_apply [--path <string>] (effectful) — Apply a stash\ngit2 stash_clear [--path <string>] (effectful) — Clear all stashes\ngit2 stash_drop [--path <string>] [--stash-ref <string>] (effectful) — Drop a stash\ngit2 stash_list [--limit <number>] [--path <string>] (read) — List stashes\ngit2 stash_pop [--path <string>] (effectful) — Pop a stash\ngit2 stash_push [--include-untracked] [--keep-index] [--message <string>] [--path <string>] (effectful) — Stash changes\ngit2 status [--ignore-submodules] [--include-untracked] [--path <string>] (read) — Show working tree status\ngit2 tag_create [--annotated] [--commit <string>] [--force] [--message <string>] [--path <string>] --tag-name <string> (effectful) — Create a tag\ngit2 tag_delete [--path <string>] --tag-name <string> (effectful) — Delete a tag\ngit2 tag_list [--limit <number>] [--path <string>] (read) — List tags\ngit2 tag_verify [--path <string>] --tag-name <string> (read) — Verify a tag\ngit2 worktree_add [--branch <string>] [--commitish <string>] [--detach] [--force] --path <string> [--repo <string>] (effectful) — Add a worktree\ngit2 worktree_list [--repo <string>] (read) — List worktrees\ngit2 worktree_prune [--dry-run] [--repo <string>] [--verbose] (effectful) — Prune stale worktrees\ngit2 worktree_remove [--force] --path <string> [--repo <string>] (effectful) — Remove a worktree\n\nRules:\n1. One simple command: execute exactly one command line starting with the tool name; do not chain commands.\n2. Quote values with spaces: wrap parameter values containing spaces or special characters in quotes.\n3. No shell operators: operators, pipes, redirects, subshells, backticks, globs, and env prefixes are refused.";

    expect(rendered).toBe(expected);
  });
});

describe('property-based security invariant test', () => {
  test('2000 random strings never throw and never return ok:true when containing unquoted refused characters', () => {
    // Seeded PRNG (Mulberry32)
    function mulberry32(seed: number) {
      return function () {
        let t = (seed += 0x6d2b79f5);
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    }

    const rand = mulberry32(1337);

    const safeChars = 'abcdefghijklmnopqrstuvwxyz0123456789-_=./: ';
    const quotes = '\'"';
    const dangerousChars = ';&|<>(){}*?[\n\r\0`$#~';
    const allChars = safeChars + quotes + dangerousChars;

    function hasUnquotedRefusal(s: string): boolean {
      if (/[\r\n\0]/.test(s)) return true;
      let mode: 'normal' | 'single' | 'double' = 'normal';
      let isWordStart = true;

      for (let i = 0; i < s.length; i++) {
        const ch = s[i]!;

        if (mode === 'single') {
          if (ch === "'") mode = 'normal';
          continue;
        }

        if (mode === 'double') {
          if (ch === '"') mode = 'normal';
          else if (ch === '$' || ch === '`') return true;
          else if (ch === '\\' && i + 1 < s.length) i++;
          continue;
        }

        // mode === 'normal'
        if (ch === ' ' || ch === '\t') {
          isWordStart = true;
          continue;
        }

        if (isWordStart && (ch === '#' || ch === '~')) return true;

        if (ch === "'") {
          mode = 'single';
          isWordStart = false;
          continue;
        }

        if (ch === '"') {
          mode = 'double';
          isWordStart = false;
          continue;
        }

        if (ch === '\\') {
          isWordStart = false;
          if (i + 1 < s.length) {
            const next = s[i + 1]!;
            if (';&|<>(){}*?[\n\r\0`$'.includes(next)) return true;
            i++;
          }
          continue;
        }

        if (';&|<>(){}*?[\n\r\0`$'.includes(ch)) {
          return true;
        }

        isWordStart = false;
      }

      if (mode !== 'normal') return true; // unterminated quote
      return false;
    }

    for (let iter = 0; iter < 2000; iter++) {
      // Generate string of length 1 to 40
      const len = Math.floor(rand() * 40) + 1;
      let str = '';
      for (let j = 0; j < len; j++) {
        const charIdx = Math.floor(rand() * allChars.length);
        str += allChars[charIdx]!;
      }

      // Assert interpretCommand never throws
      let result;
      expect(() => {
        result = interpretCommand(git2Schema, str);
      }).not.toThrow();

      // If the string contains any unquoted dangerous character, it MUST be refused
      if (hasUnquotedRefusal(str)) {
        expect(result!.ok).toBe(false);
      }
    }
  });
});
