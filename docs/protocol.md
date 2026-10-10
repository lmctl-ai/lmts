# CLI Tool Protocol Specification (`cli.schema.v1`)

This document defines the interface and wire protocol for building schema-driven CLI tools. It is language-agnostic and intended for implementers building compatible CLI servers in Go, Rust, Python, C++, or any other language.

---

## 1. Architectural Model

A compliant CLI tool acts as a **structured server**, while caller software (such as `lmscript`, agent engines, or LLM host environments) acts as the **client**:
- **Stdout is machine-readable**: All standard command output MUST be valid JSON.
- **Stderr is for non-critical logging**: Structured communication and error envelopes are never written to stderr alone.
- **Zero-setup schema discovery**: Tools must describe their entire API statically on demand.

---

## 2. Schema Discovery: `<tool> --schema`

Every compliant tool must implement the `--schema` flag at the root invocation level:

```console
$ <tool> --schema
```

### Constraints
1. **Immediate Execution**: Must execute instantly without requiring network access, filesystem initialization, repository discovery, or authentication tokens.
2. **Stdout Output**: Emits a single JSON document matching schema tag `cli.schema.v1`.
3. **Exit Code**: Must exit with code `0`.

### Schema Document Format (`cli.schema.v1`)

```json
{
  "schema": "cli.schema.v1",
  "tool": "mytool",
  "version": "1.0.0",
  "policy": {
    "dryrun": true,
    "readonly": true
  },
  "inputs": ["flags", "json", "graphql"],
  "globals": [
    {
      "name": "dryrun",
      "type": "boolean",
      "occurs": "?",
      "aliases": ["dry-run"],
      "description": "Simulate write operations without making changes"
    },
    {
      "name": "readonly",
      "type": "boolean",
      "occurs": "?",
      "aliases": ["read-only"],
      "description": "Refuse write operations"
    },
    {
      "name": "confirm",
      "type": "boolean",
      "occurs": "?",
      "aliases": ["i-understand"],
      "description": "Confirm dangerous or destructive operations"
    }
  ],
  "operations": [
    {
      "name": "status",
      "access": "read",
      "returns": "object",
      "description": "Show system status",
      "params": [
        {
          "name": "path",
          "type": "string",
          "occurs": "?",
          "default": ".",
          "description": "Target directory"
        }
      ]
    },
    {
      "name": "deploy",
      "access": "write",
      "returns": "object",
      "description": "Deploy build artifacts",
      "params": [
        {
          "name": "environment",
          "type": "string",
          "occurs": "1",
          "description": "Deployment environment"
        }
      ]
    }
  ]
}
```

### Parameter Cardinality (`occurs`)
Cardinalities represent presence and multiplicity:
- `'1'`: Exactly one value required (default if omitted).
- `'?'`: Zero or one value (optional).
- `'+'`: One or more values required (array representation).
- `'*'`: Zero or more values allowed (optional array representation).

### Reserved Identifiers & Security Guarantees
To prevent prototype pollution and language-level collision attacks:
1. **Reserved Names**: Tools, operations, parameters, aliases, and global parameters MUST NOT use the reserved names:
   - `__proto__`
   - `constructor`
   - `prototype`
2. **Schema Rejection**: Any published schema declaring a reserved name for a tool, operation, parameter, alias, or global MUST be rejected with error code `RESERVED_NAME`.
3. **Input Hardening**: Any hostile input attempting to pass reserved parameter keys across argv (`--__proto__`), JSON documents (`{"__proto__": ...}`), or GraphQL documents (`(__proto__: ...)`) MUST be rejected as `UNKNOWN_PARAM` or `RESERVED_NAME`.
4. **Prototype-less Records**: Implementations parsing input documents or validating parameters MUST construct records with a `null` prototype (e.g. `Object.create(null)` in JavaScript) so that `Object.getPrototypeOf(params) === null` and the global object prototype remains completely unpolluted.

### Operation Access & `isEffectful` Semantics
- `access: 'read'`: Pure read operations that do not modify external state.
- `access: 'write'`: Mutating operations.
- `access: 'dynamic'`: Operations determining effectfulness at runtime.
- **Default (Missing Access)**: When `access` is omitted or undefined, clients and runners MUST treat the operation as effectful (`isEffectful(op) === true`). Only operations explicitly declaring `access: 'read'` are non-effectful.

---

## 3. Input Forms & Invocation

Tools must support three input forms:

### 3.1. Command-Line Flags Form
- Positional parameters are bound by index if defined with `positional: true`.
- Named options follow standard UNIX flag syntax:
  - Long flags: `--param value` or `--param=value`
  - Booleans: `--param` (true), `--no-param` (false)
  - Short flags and aliases: e.g. `-h`, `--read-only`
- **Leading Globals**: Global flags may precede the operation name:
  ```console
  $ mytool --readonly status --path /srv
  $ mytool --dryrun deploy --environment prod
  ```
  The runner scans for the first token that is not a recognized global flag (or a global flag's parameter value) to determine the operation name.

### 3.2. JSON Document Form
Parameters can be passed as JSON either inline or via file:
- Inline: `<tool> <op> --input-json '{"param": "value"}'`
- File: `<tool> <op> --input-file /path/to/doc.json`
- Envelope: If invoked at the root level without an operation name, the JSON document may supply the `op` key:
  ```json
  {
    "op": "deploy",
    "params": {
      "environment": "prod"
    }
  }
  ```

### 3.3. GraphQL Document Form
Passed via `--input-graphql '<doc>'`:
```graphql
mutation {
  deploy(environment: "prod") {
    id
    status
  }
}
```

### 3.4. Mixed Input Constraint (`MIXED_INPUT`)
- Document inputs (`--input-json`, `--input-file`, `--input-graphql`) **may** accompany global flags (`--dryrun`, `--readonly`, `--confirm`).
- Document inputs **must not** be combined with operation-specific flags or positional arguments.
- Any violation MUST be rejected with exit code `2` and issue code `MIXED_INPUT`.

---

## 4. Policy Model & Global Flags

Every tool implements access classification on its operations:
- `access: 'read'`: Read-only queries that do not alter state.
- `access: 'write'`: Mutating operations that change state.
- `access: 'dynamic'`: Operations that classify access at runtime based on arguments (e.g. arbitrary RPC/API calls).

### 4.1. `--dryrun` / `--dry-run` (or `<TOOL>_DRYRUN=1`)
- **Read Operations**: Execute normally.
- **Write Operations**: MUST NOT execute state modifications. The tool returns a synthetic success envelope and exits `0`:
  ```json
  {
    "success": true,
    "dryRun": true,
    "simulated": "deploy",
    "command": ["deploy-engine", "--target", "prod"]
  }
  ```

### 4.2. `--readonly` / `--read-only` (or `<TOOL>_READONLY=1`)
- **Read Operations**: Execute normally.
- **Write Operations**: MUST NOT execute. Aborts immediately with exit code `6` (`READONLY_VIOLATION`).

### 4.3. `--confirm` / `--i-understand`
- Destructive operations marked as dangerous must require confirmation. If omitted, aborts with exit code `9` (`MISSING_CONFIRMATION`).

---

## 5. Output Envelopes & Error Reporting

### 5.1. Success Output
All successful operations output a valid JSON document to stdout and exit `0`.

### 5.2. Error Output Envelope
Any failure, invalid argument, or policy violation MUST emit a JSON error envelope to stdout:

```json
{
  "success": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "invalid arguments for \"deploy\"",
    "data": {
      "op": "deploy",
      "issues": [
        {
          "code": "MISSING_REQUIRED",
          "message": "missing required parameter: environment",
          "param": "environment",
          "synopsis": "--environment <string>",
          "usage": "mytool deploy --environment <string>"
        }
      ]
    }
  }
}
```

---

## 6. Exit Code Specification

Implementations must map internal error classifications to the following exit codes:

| Exit Code | Error Code | Description |
|---|---|---|
| `0` | *(Success)* | Operation completed successfully |
| `1` | `COMMAND_FAILED` | Underlying subprocess or external command failed |
| `1` | `INTERNAL_ERROR` | Unhandled internal exception or invariant failure |
| `1` | `UNKNOWN_ERROR` | Generic unexpected error |
| `2` | `INVALID_REQUEST` | Missing operation name, unknown operation, or invalid CLI flag usage |
| `2` | `VALIDATION_ERROR` | Parameter validation failure (`UNKNOWN_PARAM`, `TYPE_MISMATCH`, `MISSING_REQUIRED`, `ENUM_VIOLATION`, `MIXED_INPUT`, `RESERVED_NAME`) |
| `3` | `PARSE_ERROR` | Malformed JSON document, GraphQL syntax error, or unreadable document input |
| `4` | `NOT_FOUND` | Requested entity, branch, revision, or file not found |
| `5` | `CONFLICT` | State conflict (e.g. merge conflict, existing branch, conflicting resource) |
| `6` | `FORBIDDEN` | Access denied or permission error |
| `6` | `READONLY_VIOLATION`| Attempted write operation while running under `--readonly` |
| `7` | `TIMEOUT` | Operation exceeded deadline or execution timeout |
| `8` | `SERVICE_UNAVAILABLE`| Remote service, daemon, or network connection unavailable |
| `9` | `MISSING_CONFIRMATION` | Dangerous operation attempted without `--confirm` or `--i-understand` |
| `127`| `COMMAND_NOT_FOUND` | Required external binary not found on system PATH |

---

## 7. Zero-Dependency Client Guidelines

Client implementations (such as `@gitpoc/clischema/validate`) consume only the published schema document:
1. Load schema via `<tool> --schema`.
2. Inspect `operations` and their `params`.
3. Validate user inputs against declared `type`, `occurs`, and `enum` constraints before invoking the tool binary.
4. Serialize input into either `--input-json` or CLI flags.
5. Execute `<tool>` with serialized arguments and parse JSON output from stdout.
