# @gitpoc/clischema — Array-Based Argv Form (`argv-form.ts`)

Array-based command-line parsing without external parser generators or string re-serialization.

## Principles

1. **Direct Array Processing**: `parseArgvForm(argvTokens, schema, globals)` operates directly on `string[]`. It never joins argv with spaces and never re-lexes tokens, avoiding lossy round trips.
2. **Schema-Driven Coercion**: Token interpretation is strictly guided by `ParamSpec`:
   - `boolean`: Bare `--flag` or `--flag=true|false` or `--flag true|false`. `--no-<flag>` sets `false`.
   - `string`: Consumes the next token or value after `=`. Values are never coerced to numbers or booleans.
   - `number`: Parses decimal, exponential (`1e3`), or negative numbers; non-numeric values emit `TYPE_MISMATCH`.
   - `object` / `array`: Parsed with `JSON.parse`.
   - `json`: Loose literal coercion (scalar, object, or array).
3. **Cardinality Enforcement**:
   - `occurs: '1'` or `'?'`: Scalar. Specifying the flag more than once emits `DUPLICATE_FLAG`.
   - `occurs: '+'` or `'*'`: Multi-value. Repeated flags accumulate into an array.
4. **Globals Segregation**: Global flags (`globals: ParamSpec[]`) are recognized and extracted into `result.value.globals`, never triggering `UNKNOWN_PARAM` or polluting op params.
5. **Issue Reporting**: All syntax and type issues are collected (never stop on first error). Every issue includes `code`, `message`, `synopsis`, `usage`, and `argvIndex`.
6. **Prototype Safety**: `result.value.params` and `result.value.globals` are created via `Object.create(null)`. Flags matching reserved names (`__proto__`, `constructor`, `prototype`) are rejected as `UNKNOWN_PARAM` and never accepted even when `additionalParams: true`.

## Regressions Fixed (B1–B8)

Each corresponds directly to test names in `tests/argv.test.ts`:

- **B1 (`space in value`)**: Arguments like `--path "/tmp/my repo"` are kept intact; array tokens are never split by whitespace.
- **B2 (`"=" in value (separate and inline)`)**: Values containing `=` (e.g. `--message "a=b"` or `--message=a=b=c`) preserve all `=` characters. Splitting occurs strictly on the first `=`.
- **B3 (`nested JSON object` / `bad JSON is TYPE_MISMATCH`)**: Nested JSON payloads (`--config '{"a":{"b":1}}'`) parse directly. Malformed JSON yields `TYPE_MISMATCH` citing the token's `argvIndex`.
- **B4 (`string param keeps ...`)**: Preserves literal strings like `'trueish'`, `'false'`, `'123abc'`, `'1.2.3'`, `'2024-01-01'` without unintended type coercion.
- **B5 (`--message false is a string; --wip false is a boolean`)**: Disambiguates values by declared param type instead of guessing based on token text.
- **B6 (`repeated flag accumulates for array` / `repeated scalar flag is DUPLICATE_FLAG`)**: Repeated occurrences for `+` and `*` accumulate; repeated scalar flags produce `DUPLICATE_FLAG`.
- **B7/B8 (`--message --wip is MISSING_VALUE` / `trailing non-boolean flag is MISSING_VALUE`)**: Flags expecting values followed by another flag or end of input emit `MISSING_VALUE`.
