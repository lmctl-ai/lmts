# @gitpoc/clischema

Schema-driven CLI tooling providing declarative schema validation and a standard CLI server runtime.

## Overview

Tools built with `@gitpoc/clischema` act as structured CLI servers that publish machine-readable schema contracts for consumption by software clients, agent runtimes, and LLMs, while deriving human-friendly `--help` output automatically.

The package provides two primary entry points:
- **`@gitpoc/clischema/validate` (Client-side)**: A pure, lightweight validation engine with zero runtime dependencies. Re-exports `validate()`, parameter and operation types, serializers (`encodeArgv`, `encodeJson`, `encodeGraphql`), and document publishing/parsing helpers.
- **`@gitpoc/clischema/server` (Server-side)**: A complete CLI runner (`runCli`), policy engine (`checkPolicy`), cross-runtime process execution (`spawnCommand`), and structured error envelope generator.

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

## Durable Memory

Further architectural decisions and internal invariants are documented in [`durable-memory/`](durable-memory/):
- [`durable-memory/index.md`](durable-memory/index.md): Package architecture and client/server framing.
- [`durable-memory/argv-form.md`](durable-memory/argv-form.md): Array-based flag parsing rules and regression controls.
- [`durable-memory/server-runtime.md`](durable-memory/server-runtime.md): CLI runner execution flow and global dispatch.
- [`durable-memory/policy.md`](durable-memory/policy.md): Dry-run, read-only, and confirmation policy model.
