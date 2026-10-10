# @lmctl-ai/lmts/server — CLI runner (`cli.ts`)

Execution flow in `runCli(config, argv)`:

1. **Empty Argv**: Spawning with no arguments invokes `printHelp(config)` (exit 0).
2. **Op Discovery & Global Dispatch**:
   - The runner scans for the first token in argv that is not a known global flag (or a global flag's value).
   - Leading globals before the operation name work naturally (e.g. `git2 --readonly lm_status`, `git2 --dryrun commit --message x`).
   - If no operation name is present:
     - `--help` / `-h` -> `printHelp` (exit 0).
     - `--list` -> `printOpList` (JSON array of operations with access and schemas, exit 0).
     - `--schema` -> `printSchema` (publishes `cli.schema.v1` JSON document with real version and `GLOBAL_FLAGS`, exit 0). This document is the contract consumed by lmscript's generated module (see `issues/005`).
     - `--explain <op> [--format text]` -> `handleExplain` (JSON schema or human text help, exit 0).
     - Document-only inputs (`--input-json`, `--input-file`, `--input-graphql`) without a leading op infer the op name from the document envelope.
     - Otherwise exits with `CliError(INVALID_REQUEST, 'No operation specified')`.
3. **Operation Dispatch**:
   - The identified operation token is extracted as `opName`, and remaining argv tokens are passed to input resolution.
   - Unknown operation -> `CliError(INVALID_REQUEST)` with hint to `--list`.
4. **Input Resolution via `@lmctl-ai/lmts`**:
   - Resolves input via `resolveInput({ schema, argv, jsonDocument, graphqlDocument, globals: GLOBAL_FLAGS })`.
   - File inputs (`--input-file`) are loaded with static `readFileSync`.
   - Document inputs allow global flags (`--dryrun`, `--readonly`, `--confirm`) but strictly reject mixing with operation flags (`MIXED_INPUT`). Unrelated flag parse failures are reported as validation errors rather than `MIXED_INPUT`.
   - Flags form is parsed directly from argv tokens without re-serialization or string splitting.
   - Ops without an authored schema fall back to `synthesizeSchema(op)` (`additionalParams: true`).
5. **Policy Building & Enforcement**:
   - The runner constructs a `Policy` object from extracted globals and environment (`<TOOL>_DRYRUN`, `<TOOL>_READONLY`), passing it to `config.buildContext(policy)`.
   - Tool and op implementations enforce policy by invoking `checkPolicy(policy, access, dangerous)`.
   - `access: 'read'`: Always executes, even under `--dryrun` and `--readonly`.
   - `access: 'write'`:
     - `--readonly` -> Aborts with `CliError(READONLY_VIOLATION)`.
     - `--dryrun` -> Returns synthetic success envelope `{ success: true, dryRun: true, ... }` without executing writes.
     - Destructive operations (`ctx.dangerous`) require `--confirm` or `--i-understand`.
   - `access: 'dynamic'`: Op-specific runtime classification gates execution.
6. **Error Envelope**:
   - Thrown errors or validation failures produce structured JSON on stdout:
     `{ success: false, error: { code, message, data: { op, issues } } }`
   - Non-zero exit code mapped from `ErrorCode`.

## Invariants

- Static ESM imports only: `@lmctl-ai/lmts` and `node:fs` are statically imported; no dynamic runtime `await import()`.
- Global flags are declared centrally in `GLOBAL_FLAGS: ParamSpec[]` exported by the server runtime (`src/server/cli.ts`).
