# @lmctl-ai/lmts — durable memory

Portable knowledge for the schema package and server runtime. Read this, then `./argv-form.md` for array-based flag parser rules, `./server-runtime.md` for the CLI runner, and `./policy.md` for policy gating.

## What it is

Declarative input schema, validation engine, and server runtime shared by CLI tools.
Contains two primary parts:
1. **Pure Schema & Validation Core** (`.` and `./validate`): Zero runtime dependencies. One `OperationSchema` per op is the source of truth for:
   - Three input forms: command-line flags (`argv-form.ts`), JSON document (`json-form.ts`), and GraphQL document (`graphql-form.ts`).
   - Single aggregating `validate()` returning `Result<T>`.
   - Generated human `--help` and `--explain` text.
   - Published `cli.schema.v1` document (`publish.ts`), which is the contract consumed by lmscript and client software.
2. **Server Runtime** (`./server`): Generic CLI runner, process execution (`exec.ts` via `cross-spawn`), policy enforcement (`policy.ts`), and structured JSON error envelopes (`errors.ts`, `output.ts`).

## Client / Server Framing

The CLI tools behave as servers; caller software (e.g. `lmscript`, agent runtimes, LLMs) are clients.
- The schema is the published machine-readable contract for software and LLMs.
- `--help` is secondary: derived from the schema for human readers, never the source of truth.
- Both server and client share the same validation logic (`validate()`).

## Cardinality: `1`, `?`, `+`, `*`

Cardinality is regex-style and nothing finer:
- `'1'`: exactly one (required, default if omitted).
- `'?'`: zero or one (optional).
- `'+'`: one or more (array, required).
- `'*'`: zero or more (array, optional).

**Why no ranges/bounds in the schema**: Limits like timeouts (`1..300`) or string lengths belong in server business logic, not the structural schema. The schema models structure and presence, keeping the schema format lightweight and portable.

## Three Input Forms & One Validator

- **Flags form** (`parseArgvForm`): Array-based token parsing, schema-directed type coercion, positionals and globals extraction.
- **JSON form** (`parseJsonDocument`): Recognizes `{ op, params }` envelopes when `op` is present; otherwise interprets the entire JSON object as `params`.
- **GraphQL form** (`parseGraphqlDocument`): Single mutation/query field syntax.
- **`resolveInput`**: Chooses exactly one form based on inputs, rejecting mixed inputs (e.g. flags mixed with `--input-json`), while allowing global flags (`--dryrun`, `--readonly`, `--confirm`) alongside document inputs.
- **Single Validator** (`validate`): Aggregates all validation issues (never stops on first error). Every `ValidationIssue` provides `code`, `message`, `synopsis`, and `usage`. Unknown params include edit-distance suggestions.

## The `./validate` Entry & `dist/`

- `@lmctl-ai/lmts/validate` is the lightweight consumer-facing entry point re-exporting `validate()`, `types.ts`, `schema.ts`, `json-form.ts`, `publish.ts`, `help.ts`, and `encode.ts`.
- Its transitive import closure excludes the CLI-specific argv parser (`argv-form.ts`), GraphQL parser (`graphql-form.ts`), and `inputs.ts`.
- The `dist/` directory contains compiled JavaScript and TypeScript declarations (`.d.ts`) so Node.js consumers (such as `lmscript`) can import `@lmctl-ai/lmts/validate` without requiring a Bun-specific runtime.

## Encoders & Round-Trip

`encode.ts` provides client-side serialization:
- `encodeArgv(schema, params)` -> string[]
- `encodeJson(schema, params, opts)` -> string
- `encodeGraphql(schema, params)` -> string
Round-trip tested against server-side parsers to guarantee client-encoded inputs parse back to identical structures.

## Publish and Parse Rules (`publish.ts`)

- **Identifier-safe naming**: tool and operation names must match `^[a-z][a-z0-9_]*$`; parameter names must match `^[A-Za-z_]\w*$`.
- **Reserved names (`__proto__`, `constructor`, `prototype`)**: Tools, operations, parameters, aliases, and globals MUST NOT use the names `__proto__`, `constructor`, or `prototype`. Any declaration is rejected with code `RESERVED_NAME`.
- **No reserved parameter names**: operations cannot declare a parameter named `dryrun` (reserved for runner policy).
- **Tool versions**: published documents include the real tool version from `package.json` (defaults to `'unknown'`).
- **Globals**: global flags (`dryrun`, `readonly`, `confirm`, etc.) are declared and published under stable names.
- **Returns**: operations optionally publish `returns?: 'object' | 'array' | 'string' | 'number' | 'boolean' | 'null'` (default `'object'`).
- **Effectfulness**: `isEffectful(op)` determines if an operation modifies state. Returns `false` ONLY when `op.access === 'read'`. When `access` is omitted or undefined, operations are safely treated as effectful (`true`).
- **Parameter attributes**: attributes `cliOnly`, `docOnly`, and `derived` exist in `ParamSpec` for metadata modeling, but no shipped schemas set them (all tool operations are fully authored).
- **Zero unknown param keys**: `parsePublishedSchema` strictly validates param properties; unknown keys (such as `min`, `max`, `conflicts`) produce validation issues.
- **Linting / Warnings**: `schemaWarnings(doc)` detects missing descriptions or potential schema issues.
- **Zero runtime dependencies**: Pure TypeScript with no external libraries.

## Prototype Safety & Convention

- **Convention**: All parsed and validated parameter dictionaries (`result.value` from `validate()`, `params` and `globals` from `parseArgvForm()`, `params` from `parseJsonDocument()`, and `params` from `parseGraphqlDocument()`) are prototype-less objects created via `Object.create(null)`.
- `Object.getPrototypeOf(record) === null` consistently across all forms.
- Internal object assembly and intermediate dictionaries (including `encodeJson`) use `Object.create(null)` or `Map`.
- Hostile inputs attempting to supply `__proto__`, `constructor`, or `prototype` keys are rejected as `UNKNOWN_PARAM` (or `RESERVED_NAME`) across all three input forms, and `Object.prototype` remains completely unpolluted (`({}).polluted === undefined`).

## Protocol Specification and Conformance Vectors

The formal protocol specification (`protocol.md`), JSON Schema (`cli.schema.v1.schema.json`), and language-neutral conformance test vectors live in the `lmapi` repository ([github.com/lmctl-ai/lmapi](https://github.com/lmctl-ai/lmapi)).
`lmts` validates against these conformance vectors via `tests/conformance.test.ts` (which cleanly skips when `lmapi` is not present).

## Committed `dist/` & Git Dependency Support

- The `dist/` directory is committed to git so plain Node.js consumers can install `@lmctl-ai/lmts` directly as a git dependency (`"git+https://github.com/lmctl-ai/lmts.git#v0.1.0"`).
- Node.js cannot strip or compile TypeScript types from packages within `node_modules` and resolves to `./dist/index.js` or `./dist/validate-entry.js` via the `exports` configuration.
- To avoid sourcemap discrepancies across build environments, `declarationMap` and `sourceMap` are disabled in `tsconfig.build.json`.
- `tests/dist-fresh.test.ts` enforces that committed `dist/` matches a fresh build byte-for-byte.

## Release Procedure

To cut a new release tag (e.g. `v0.1.0`):
1. Run `bun run build` to compile `dist/`.
2. Run `bun test` to ensure all tests (including `tests/dist-fresh.test.ts` and `tests/node-import.test.ts`) pass.
3. Verify with `git status` that any changes in `dist/` and `src/` are staged.
4. Commit the changes: `git commit -m "release: v0.1.0"`.
5. Tag the commit: `git tag v0.1.0`.
6. Push commits and tags: `git push origin main --tags`.

