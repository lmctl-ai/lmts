# CLI Tool Protocol Specification

The canonical, language-neutral wire protocol and schema specification for `cli.schema.v1` has moved to the **`lmapi`** repository:

- **Repository**: [`lmctl-ai/lmapi`](https://github.com/lmctl-ai/lmapi)
- **Specification**: [`lmapi/docs/protocol.md`](https://github.com/lmctl-ai/lmapi/blob/main/docs/protocol.md)
- **JSON Schema (draft 2020-12)**: [`lmapi/schema/cli.schema.v1.schema.json`](https://github.com/lmctl-ai/lmapi/blob/main/schema/cli.schema.v1.schema.json)
- **Conformance Test Vectors**: [`lmapi/conformance/`](https://github.com/lmctl-ai/lmapi/tree/main/conformance)

## TypeScript SDK (`lmts`) Public API

The `lmts` package implements the protocol for TypeScript / JavaScript runtimes:

### 1. Pure Client Surface (`@lmctl-ai/lmts`)
- `validate(schema, raw, opts)`: Validates input records against an `OperationSchema`, accumulating all issues.
- `parsePublishedSchema(val)`: Full structural validator parsing a published `cli.schema.v1` document.
- `publishSchema(tool, ops, opts)`: Builds and serializes a compliant `cli.schema.v1` document.
- `tokenizeSimpleCommand(line)`: Safe POSIX tokenizer rejecting all shell meta-characters.
- `interpretCommand(schemas, line, opts)`: Turn LLM command lines into typed, validated calls without a shell.
- `classifyOperation(op)`: Classifies operations as `'read'` or `'effectful'`.
- `describeForPrompt(schemas)`: Deterministic compact prompt rendering for LLMs.
- Encoders: `encodeArgv`, `encodeJson`, `encodeGraphql`.

### 2. Lightweight Validator Entry (`@lmctl-ai/lmts/validate`)
Minimal dependency closure for browser/edge environments excluding argv and GraphQL parsers.

### 3. Server Runtime (`@lmctl-ai/lmts/server`)
- `runCli(spec)`: Complete CLI dispatcher handling global flags (`--schema`, `--list`, `--help`, `--dryrun`, `--readonly`, `--confirm`), input parsing, execution, and error envelopes.
- `checkPolicy(policy, effect, opName, confirmPassed)`: Execution policy gating.
- `spawnCommand(argv, opts)`: Cross-runtime process execution.
