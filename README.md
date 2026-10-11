# @lmctl-ai/lmts

Schema-driven CLI tooling providing declarative schema validation, LLM command interpretation, and a standard CLI server runtime for `cli.schema.v1`.

## Installation

```bash
npm install git+https://github.com/lmctl-ai/lmts.git#v0.2.0
# or with Bun
bun add git+https://github.com/lmctl-ai/lmts.git#v0.2.0
```

### Node.js vs. Bun Runtime Resolution

- **Bun**: Uses the `"bun"` condition in `package.json` `exports` to execute directly from TypeScript sources (`src/`).
- **Node.js**: Plain Node.js cannot strip or transpile TypeScript inside `node_modules` and resolves to the pre-compiled JavaScript and `.d.ts` declarations in `dist/` via the `"default"` condition.
- **Committed `dist/`**: The `dist/` directory is committed to git so git-based dependencies (`git+https://...`) work out of the box in plain Node environments without requiring a post-install build step. Whenever source files in `src/` are modified, `dist/` must be rebuilt (`bun run build`) and committed.

## Overview

Tools built with `@lmctl-ai/lmts` act as structured CLI servers that publish machine-readable schema contracts for consumption by software clients, agent runtimes, and LLMs, while deriving human-friendly `--help` output automatically.

The package provides four primary entry points:
- **`@lmctl-ai/lmts` (Main / Client-side)**: Full pure client SDK including `validate()`, `parsePublishedSchema()`, `publishSchema()`, command tokenizer (`tokenizeSimpleCommand`), interpreter (`interpretCommand`), operation classifier (`classifyOperation`), prompt formatter (`describeForPrompt`), and serializers (`encodeArgv`, `encodeJson`, `encodeGraphql`).
- **`@lmctl-ai/lmts/validate` (Lightweight Validator)**: A pure, lightweight validation engine with minimal transitive dependency closure. Re-exports `validate()`, parameter and operation types, serializers, and document publishing/parsing helpers (excluding argv and GraphQL parsers).
- **`@lmctl-ai/lmts/server` (Server-side)**: A complete CLI runner (`runCli`), policy engine (`checkPolicy`), cross-runtime process execution (`spawnCommand`), and structured error envelope generator.
- **`@lmctl-ai/lmts/modules` (Module Store)**: A Node.js module cache manager that fetches, verifies, and installs remote tool schemas from GitHub (`@owner/repo[#ref]`), handling atomic file storage, checksum verification, immutability, and local PATH discovery.


## Three Input Forms

Every operation declared under an `OperationSchema` accepts input through three interchangeable representations:
1. **Command-Line Flags**: Array-based token parsing (`--path /repo --ignored`), short flags (`-h`), flag aliases, and positional arguments.
2. **JSON Document**: Structured JSON passed inline via `--input-json '<json>'` or read from disk via `--input-file <path>`.
3. **GraphQL Document**: GraphQL query/mutation syntax passed via `--input-graphql '<doc>'`.

All three input forms resolve into a unified parameter dictionary validated by the single `validate()` engine.

## Security & Prototype Safety

- **Prototype-less Records**: All parsed and validated parameter dictionaries (`validate().value`, `parseArgvForm().value.params`, `parseJsonDocument().value.params`, `parseGraphqlDocument().value.params`) are prototype-less objects created via `Object.create(null)` (`Object.getPrototypeOf(params) === null`).
- **Reserved Names**: The names `__proto__`, `constructor`, and `prototype` are strictly reserved. Schemas declaring them are rejected (`RESERVED_NAME`), and hostile inputs attempting to pass them are rejected as `UNKNOWN_PARAM`. `Object.prototype` remains completely unpolluted.
- **Effectfulness (`isEffectful`)**: Operations declare `access: 'read' | 'write' | 'dynamic'`. The pure helper `isEffectful(op)` returns `false` only when `op.access === 'read'`; omitted or undefined access safely defaults to effectful (`true`).

## Cardinality: `1`, `?`, `+`, `*`

Parameter occurrences follow regex-style cardinalities:
- `'1'`: Exactly one (required, default if omitted).
- `'?'`: Zero or one (optional).
- `'+'`: One or more (array, required).
- `'*'`: Zero or more (array, optional).

Ranges, string limits, or business validation logic are intentionally excluded from the schema contract and handled in application logic.

## LLM Command Interpreter & Safety Classifier

When an LLM generates a single-line CLI command (e.g. `git2 commit --message "initial"`), the SDK provides a safe interpreter and classifier without invoking a shell:

- **`tokenizeSimpleCommand(line)`**: Lexes command arguments following POSIX quoting rules (literal single quotes, double quotes with only `"` and `\` escaped). Rejects hostile shell constructs with code `SHELL_SYNTAX`: unquoted `;`, `&`, `|`, `<`, `>`, `(`, `)`, `{`, `}`, `$`, backticks, newlines, unquoted globs (`*`, `?`, `[`), tildes (`~`), `#` comments, and leading `NAME=value` env assignments.
- **`interpretCommand(schemas, line, opts?)`**: Validates tool, operation, flags, and types against `PublishedCliSchema` documents. Extracts positionals, options, and global flags into null-prototype records without executing any shell process.
- **`classifyOperation(op)`**: Returns `'read'` if and only if `op.access === 'read'`. Missing, write, and dynamic access are classified as `'effectful'`.
- **`describeForPrompt(schemas)`**: Generates a compact, deterministic text description of available tools and operations formatted for LLM system prompts, complete with syntax rules.

## CLI Protocol & Contract

Any CLI tool implementing the protocol (in TypeScript, Go, Rust, Python, etc.) must follow these core principles:
1. **`--schema` Inspection**: Running `<tool> --schema` emits a valid `cli.schema.v1` JSON document to stdout and exits `0`. It must execute instantly without requiring network access, credentials, or a specific working directory.
2. **Transport**: Tools support flag arguments or document inputs (`--input-json`, `--input-file`, `--input-graphql`). Document inputs may be accompanied by global flags, but not operation-specific flags (`MIXED_INPUT`).
3. **Global Flags**:
   - `--dryrun` (alias `--dry-run`): Simulates write operations, returning a synthetic success envelope without executing state changes.
   - `--readonly` (alias `--read-only`): Refuses write operations, exiting with code 6 (`READONLY_VIOLATION`).
   - `--confirm` (alias `--i-understand`): Confirms dangerous operations.
4. **Structured Output**: Successful operations print their result as structured JSON to stdout and exit `0`.
5. **Error Envelope**: Errors and validation failures print a structured JSON envelope to stdout and exit with a non-zero exit code:
   ```json
   {
     "success": false,
     "error": {
       "code": "VALIDATION_ERROR",
       "message": "invalid arguments for \"commit\"",
       "data": {
         "op": "commit",
         "issues": [ ... ]
       }
     }
   }
   ```
6. **Exit Codes**: Mapped to standard categories:
   - `0`: Success
   - `1`: Command / Internal error
   - `2`: Invalid request / Validation error
   - `3`: Document parse error
   - `4`: Resource not found
   - `5`: Conflict
   - `6`: Forbidden / Read-only violation
   - `7`: Timeout
   - `8`: Service unavailable
   - `9`: Missing confirmation for dangerous operation
   - `127`: Binary / command not found

For a complete specification aimed at implementing tools in Go, Rust, or other languages, see [`docs/protocol.md`](docs/protocol.md).

## Module Store

The `@lmctl-ai/lmts/modules` entry point manages locally cached schemas downloaded from GitHub repositories using the evergreen auto-refresh model:

```ts
import {
  parseSpec,
  cacheRoot,
  entryDir,
  resolveCached,
  ensure,
  install,
  list,
  upgrade,
  remove,
  findOnPath,
} from '@lmctl-ai/lmts/modules';

// Parse module specifier (latest or dev channel)
const specResult = parseSpec('@lmctl-ai/lmgit');
if (specResult.ok) {
  const spec = specResult.value;
  console.log(spec.owner, spec.repo, spec.channel, spec.key);
}

// Evergreen resolution: uses cache (< TTL, default 6h), conditionally checks upstream (304/200),
// falls back to stale cache on network failure, or installs if missing
const ensureResult = await ensure('@lmctl-ai/lmgit#latest');
if (ensureResult.ok) {
  console.log(`Source: ${ensureResult.value.source}`); // 'cache' | 'network' | 'stale-cache' | 'installed'
  console.log(`Schema path: ${ensureResult.value.module.path}`);
  console.log(`Tool: ${ensureResult.value.module.tool}`);
  if (ensureResult.value.warning) {
    console.warn(`Warning: ${ensureResult.value.warning}`);
  }
}

// Fast resolution from local cache with SHA-256 verification (no network)
const cached = await resolveCached('@lmctl-ai/lmgit#latest');

// Explicit upgrade: refetches moving channels (latest/dev) and reports diff
const upgradeResults = await upgrade();

// Remove from cache
await remove('@lmctl-ai/lmgit#latest');

// Check PATH for local CLI binary
const binaryPath = findOnPath('lmgit');
```

### Evergreen Resolution Fallback Table

`ensure(spec, options?)` implements the browser auto-upgrade model:

| Cache State | Age vs TTL | Network Response | Result Source | Disk Action |
| :--- | :--- | :--- | :--- | :--- |
| Present | Age < TTL | *(No network request)* | `'cache'` | None (fast path) |
| Present | Age $\ge$ TTL | `304 Not Modified` | `'network'` | Publish a complete generation with updated `last_checked` |
| Present | Age $\ge$ TTL | `200 OK` (valid schema) | `'network'` | Publish a complete schema/metadata generation |
| Present | Age $\ge$ TTL | Error / timeout / 4xx / 5xx / invalid | `'stale-cache'` | Unmodified (returns warning, preserves files) |
| Present | *(Any age)* | `update: false` | `'cache'` | None (offline mode) |
| Missing | N/A | `install: true` (default) | `'installed'` | Atomically install new cache entry |
| Missing | N/A | `install: false` | *(Error: `NOT_INSTALLED`)* | Suggests `lmbee module install <spec>` |
| Corrupt | N/A | *(Any)* | *(Error: `CACHE_CORRUPT`)* | Never silently refetched (suggests `--force`) |

Key guarantees:
- **Streaming Byte Cap**: Enforces a 2 MiB limit (`OUTPUT_LIMIT`) on fetched schemas to prevent runaway resource consumption.
- **Atomic Cache Operations**: Schema and metadata are stored in immutable generations, published by an atomic `CURRENT` pointer rename with `0700` directory and `0600` file permissions. Readers retain a consistent snapshot; legacy fixed-file entries remain readable. Old generations are retained until removal.
- **Tamper Detection**: Every cached schema is verified against its recorded SHA-256 hash in `meta.json` before being returned by `resolveCached` or `ensure`.
- **Path Traversal Protection**: Spec parsing and path resolution strictly forbid directory traversal (`..`) and escape from the cache root.

## Durable Memory

Further architectural decisions and internal invariants are documented in [`durable-memory/`](durable-memory/):
- [`durable-memory/index.md`](durable-memory/index.md): Package architecture and client/server framing.
- [`durable-memory/modules.md`](durable-memory/modules.md): Module Store layout, spec grammar, atomic writes, and error codes.
- [`durable-memory/interpreter.md`](durable-memory/interpreter.md): Tokenizer grammar, command interpreter, safety classification, and LLM prompt rendering.
- [`durable-memory/argv-form.md`](durable-memory/argv-form.md): Array-based flag parsing rules and regression controls.
- [`durable-memory/server-runtime.md`](durable-memory/server-runtime.md): CLI runner execution flow and global dispatch.
- [`durable-memory/policy.md`](durable-memory/policy.md): Dry-run, read-only, and confirmation policy model.
