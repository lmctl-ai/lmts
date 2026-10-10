# Command Interpreter & LLM Interface (`interpret.ts`)

Portable knowledge for interpreting LLM-produced CLI command lines into typed, validated calls without running a shell.

## Problem & Purpose

When an LLM (brain) interacts with CLI tools (hands) without native structured tool calling, the model outputs a single shell command line as text.
Directly passing this text to a shell (`sh -c`, `bash -c`) introduces severe security vulnerabilities: command injection (`;`, `&&`, `|`), subshell execution (`$(...)`, `` `...` ``), redirections (`>`, `<`), globbing (`*`, `?`), tilde expansions (`~`), and environment overrides (`NAME=value`).

The interpreter parses and validates the text strictly in TypeScript without ever spawning a shell process, producing an `argv` array executed directly via `spawnCommand([tool, ...rest])`.

## Tokenization Grammar (`tokenizeSimpleCommand`)

- **POSIX Quoting**:
  - Single quotes (`'...'`): Completely literal; no escape sequences; passes shell characters through as data.
  - Double quotes (`"..."`): Allows backslash escaping only for `"` and `\`. Any occurrence of `$` or `` ` `` inside double quotes is strictly refused (`SHELL_SYNTAX`) to prevent unexpanded variable injection or subshell command evaluation.
  - Outside quotes: Whitespace separates tokens. Backslash escapes spaces (`\ `), quotes, and backslashes.
  - Empty strings: `""` or `''` emit empty string tokens (`""`).
  - Adjacent segments: Concatenate into single tokens (e.g. `--message="hello "'world'` -> `--message=hello world`).
- **Refused Constructs (`SHELL_SYNTAX`)**:
  - Unquoted control characters: Newline (`\n`), carriage return (`\r`), NUL (`\0`).
  - Unquoted chaining/redirection operators: `;`, `&`, `|`, `<`, `>`, `(`, `)`, `{`, `}`.
  - Unquoted substitution/expansion: `$`, `` ` ``.
  - Unquoted glob wildcards: `*`, `?`, `[`.
  - Tilde expansion: A word starting with unquoted `~` (e.g. `~`, `~/path`). Note: `~` within a word (e.g. `HEAD~1`) is permitted.
  - Shell comments: `#` at the start of a word. Note: `#` within a word (e.g. `issue#12`) is permitted.
  - Leading environment variable assignment: First token matching `^[a-zA-Z_][a-zA-Z0-9_]*=`.
  - Unterminated quotes or escape sequences.

## Validation & Dispatch (`interpretCommand`)

1. **Tokenize**: Invokes `tokenizeSimpleCommand`. Refusals return `SHELL_SYNTAX` issues.
2. **Tool Lookup**: First token must exactly equal a schema's `tool` name. On mismatch, returns `UNKNOWN_TOOL` with known tool list and edit-distance suggestion (distance <= 2).
3. **Operation Lookup**: Second token must match an operation name of that tool.
   - If missing, returns `UNKNOWN_OPERATION`.
   - If the token is a flag (`-h`, `--schema`), returns `FLAG_BEFORE_OP` explaining that operations must precede flags.
   - On mismatch, returns `UNKNOWN_OPERATION` with allowed operations and edit-distance suggestion.
4. **Argv Form Parsing**: `parseArgvForm(rest, op, globals)` maps flags and positionals, extracting global flags into `globals` and parameters into `params`.
5. **Schema Validation**: `validate(op, params, { form: 'flags' })` applies default values, checks types, enums, and required parameters.
6. **Prototype Safety**: Returns null-prototype records (`Object.create(null)`) for `params` and `globals`, strictly omitting reserved names.

## Classification (`classifyOperation`)

- `'read'`: Only when `op.access === 'read'`.
- `'effectful'`: When `op.access` is `'write'`, `'dynamic'`, undefined, or omitted.
- **Security Invariant**: A schema cannot upgrade itself to read-only. Dynamic operations may perform writes at runtime depending on inputs, so safety defaults to effectful.

## LLM Prompt Rendering (`describeForPrompt`)

Renders a compact, deterministic multi-tool specification formatted for LLM system prompts:
- Per tool: One header line (`# <tool>`).
- Per op: One line formatted as `<tool> <op> [<positionals>] [--flags <type>]... (read|effectful) — <description>`.
  - Required parameters: `<name>`.
  - Optional parameters: `[name]`.
  - List parameters: `<name>...` or `[--flag <type>]...`.
  - Enums: `<val1|val2|val3>`.
- Rules block: 3 deterministic instruction lines mandating one simple command, quoting values with spaces, and prohibiting shell operators.
