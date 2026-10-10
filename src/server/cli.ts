/**
 * @fileoverview Minimal opinionated CLI runner.
 *
 * Usage shape:
 *   <tool> <op> [--flag value ...] [--bool-flag ...]
 *
 * Global flags:
 *   --dryrun / --dry-run     Simulate write operations
 *   --readonly / --read-only Refuse to run write operations
 *   --confirm / --i-understand User attestation for dangerous operations
 *   --json                   (default; kept for explicitness)
 *   --help
 *   --list
 *   --schema
 *   --explain <op> [--format text]
 *   --input-json '<json>'
 *   --input-graphql '<doc>'
 *   --input-file <path>
 *
 * Values arriving on the CLI are parsed against the op's schema.
 * @module @lmctl-ai/lmts/server/cli
 */

import { readFileSync } from 'node:fs';
import {
  findOperation,
  parseArgvForm,
  parseGraphqlDocument,
  parseJsonDocument,
  publishSchema,
  renderOpHelp,
  renderToolHelp,
  resolveInput,
  SchemaValidationError,
  toKebab,
  type OperationSchema,
  type ParamSpec,
  type ProductInfo,
  type ValidationIssue,
  type ValidationIssueCode,
} from '../index.js';
import { CliError, ErrorCode, toCliError } from './errors.js';
import { printError, printResult, exitCodeFor } from './output.js';
import { checkProductVersion } from './product.js';
import type { OpDef } from './types.js';
import type { Policy } from './policy.js';

export interface RunnerConfig<C> {
  /** Tool binary name, used in help/error text and env prefixes. */
  toolName: string;
  /** Tool version, typically from package.json (defaults to "unknown"). */
  version?: string;
  /** Summary printed at the top of --help. */
  description?: string;
  /** All operations, keyed by name. */
  ops: OpDef<C>[];
  /** Build the shared context handed to every op (after policy parsing). */
  buildContext: (policy: Policy) => C;
  /** Optional underlying product metadata and compatibility range. */
  product?: ProductInfo;
}

/** Global flags recognized across all CLI tools. */
export const GLOBAL_FLAGS: ParamSpec[] = [
  { name: 'dryrun', type: 'boolean', occurs: '?', aliases: ['dry-run'], description: 'Simulate write operations' },
  { name: 'readonly', type: 'boolean', occurs: '?', aliases: ['read-only'], description: 'Refuse to run write operations' },
  { name: 'confirm', type: 'boolean', occurs: '?', aliases: ['i-understand'], description: 'Confirm dangerous operations' },
  { name: 'json', type: 'boolean', occurs: '?', description: 'Output as JSON' },
  { name: 'help', type: 'boolean', occurs: '?', aliases: ['h'], description: 'Show help' },
  { name: 'list', type: 'boolean', occurs: '?', description: 'List operations as JSON' },
  { name: 'schema', type: 'boolean', occurs: '?', description: 'Print schema document' },
  { name: 'explain', type: 'string', occurs: '?', description: 'Explain an operation' },
  { name: 'format', type: 'string', occurs: '?', description: 'Format for explain (text or json)' },
  { name: 'input-json', type: 'string', occurs: '?', aliases: ['inputJson'], description: 'JSON document input' },
  { name: 'input-graphql', type: 'string', occurs: '?', aliases: ['inputGraphql'], description: 'GraphQL document input' },
  { name: 'input-file', type: 'string', occurs: '?', aliases: ['inputFile'], description: 'Path to file containing JSON document input' },
];

/** Read read-only mode from the environment. `<TOOL>_READONLY=1|true|yes` enables it. */
export function readOnlyFromEnv(toolName: string): boolean {
  const key = `${toolName.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_READONLY`;
  const value = process.env[key];
  if (value === undefined) return false;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

/** Read dry-run from the environment. `<TOOL>_DRYRUN=1|true|yes` enables it. */
export function dryRunFromEnv(toolName: string): boolean {
  const key = `${toolName.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_DRYRUN`;
  const value = process.env[key];
  if (value === undefined) return false;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

/**
 * Build a minimal OperationSchema for an OpDef that does not declare one.
 * Params are typed 'json', 'occurs: ?', 'derived: true', and schema has 'additionalParams: true'
 * so legacy/free-form ops keep their exact behaviour under the single validator.
 */
export function synthesizeSchema<C>(op: OpDef<C>): OperationSchema {
  return {
    name: op.name,
    access: op.access,
    description: op.description,
    params: [],
    additionalParams: true,
  };
}

function getAllSchemas<C>(config: RunnerConfig<C>): OperationSchema[] {
  return config.ops.map((op) => op.inputSchema ?? synthesizeSchema(op));
}

function printHelp<C>(config: RunnerConfig<C>): void {
  const schemas = getAllSchemas(config);
  process.stdout.write(renderToolHelp(config.toolName, config.description, schemas, GLOBAL_FLAGS));
}

function printOpList<C>(config: RunnerConfig<C>): void {
  printResult(
    config.ops.map((op) => ({
      name: op.name,
      access: op.access,
      description: op.description,
      ...(op.inputSchema ? { schema: op.inputSchema } : {}),
    })),
  );
}

function printSchema<C>(config: RunnerConfig<C>): void {
  const ops = getAllSchemas(config);
  const version = config.version ?? 'unknown';
  const doc = publishSchema(config.toolName, ops, {
    version,
    globals: GLOBAL_FLAGS,
    product: config.product,
  });
  printResult(doc);
}

function handleExplain<C>(config: RunnerConfig<C>, argv: string[]): number {
  const explainIdx = argv.indexOf('--explain');
  const opName = argv[explainIdx + 1];
  const wantsText = argv.includes('--format') && argv[argv.indexOf('--format') + 1] === 'text';

  if (!opName || opName.startsWith('--')) {
    printError(new CliError(ErrorCode.InvalidRequest, 'Missing operation name for --explain'));
    return 2;
  }

  const op = config.ops.find((o) => o.name === opName);
  if (!op) {
    printError(
      new CliError(ErrorCode.InvalidRequest, `Unknown operation for --explain: ${opName}`),
    );
    return 2;
  }

  const schema = op.inputSchema ?? synthesizeSchema(op);
  if (wantsText) {
    process.stdout.write(renderOpHelp(config.toolName, schema));
    return 0;
  }
  printResult(schema);
  return 0;
}

/** Extract document string from flags or files if present. */
function extractDocString(
  globalValues: Record<string, unknown>,
): { jsonDoc?: string; graphqlDoc?: string; error?: CliError } {
  const jsonDocRaw = (globalValues['input-json'] ?? globalValues['inputJson']) as string | undefined;
  const graphqlDocRaw = (globalValues['input-graphql'] ?? globalValues['inputGraphql']) as string | undefined;
  const inputFileRaw = (globalValues['input-file'] ?? globalValues['inputFile']) as string | undefined;

  let jsonDocFromFile: string | undefined;
  if (inputFileRaw !== undefined) {
    try {
      jsonDocFromFile = readFileSync(inputFileRaw, 'utf-8');
    } catch (err) {
      return {
        error: new CliError(ErrorCode.InvalidRequest, `cannot read input file: ${inputFileRaw}`, {
          detail: String(err),
        }),
      };
    }
  }

  return {
    jsonDoc: jsonDocFromFile ?? jsonDocRaw,
    graphqlDoc: graphqlDocRaw,
  };
}

function findOpTokenIndex(argv: string[]): number {
  const globalBooleans = new Set<string>();
  const globalStrings = new Set<string>();
  for (const g of GLOBAL_FLAGS) {
    const names = [g.name, ...(g.aliases ?? [])];
    for (const n of names) {
      if (g.type === 'boolean') {
        globalBooleans.add(n);
        globalBooleans.add(toKebab(n));
      } else {
        globalStrings.add(n);
        globalStrings.add(toKebab(n));
      }
    }
  }

  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i]!;
    if (tok === '--') {
      return i + 1 < argv.length ? i + 1 : -1;
    }
    if (tok.startsWith('--')) {
      const eqIdx = tok.indexOf('=');
      const name = eqIdx === -1 ? tok.slice(2) : tok.slice(2, eqIdx);
      if (globalBooleans.has(name) || (name.startsWith('no-') && globalBooleans.has(name.slice(3)))) {
        continue;
      }
      if (globalStrings.has(name)) {
        if (eqIdx === -1) {
          const next = argv[i + 1];
          if (next !== undefined && !next.startsWith('--')) {
            i++;
          }
        }
        continue;
      }
      continue;
    }
    if (tok.startsWith('-')) {
      continue;
    }
    return i;
  }
  return -1;
}

/**
 * Run a CLI: resolve input via schema validation, apply policy, execute the op, print JSON.
 * Returns the process exit code.
 */
export async function runCli<C>(
  config: RunnerConfig<C>,
  argv: string[],
): Promise<number> {
  // 1. Empty argv -> show help
  if (argv.length === 0) {
    printHelp(config);
    return 0;
  }

  const opIdx = findOpTokenIndex(argv);

  // 2. Global-only invocation check when no operation name is found
  if (opIdx === -1) {
    if (argv.includes('--help') || argv.includes('-h')) {
      printHelp(config);
      return 0;
    }
    if (argv.includes('--list')) {
      printOpList(config);
      return 0;
    }
    if (argv.includes('--schema')) {
      printSchema(config);
      return 0;
    }
    if (argv.includes('--explain')) {
      return handleExplain(config, argv);
    }

    // Check if an envelope input (--input-json / --input-file / --input-graphql) was passed at root
    const dummySchema: OperationSchema = { name: '<unknown>', params: [], additionalParams: true };
    const parsedGlobals = parseArgvForm(argv, dummySchema, GLOBAL_FLAGS);
    const globalValues = parsedGlobals.ok ? parsedGlobals.value.globals : {};
    const docInfo = extractDocString(globalValues);
    if (docInfo.error) {
      printError(docInfo.error);
      return exitCodeFor(docInfo.error);
    }

    let inferredOp: string | undefined;
    if (docInfo.jsonDoc !== undefined) {
      const parsed = parseJsonDocument(docInfo.jsonDoc);
      if (parsed.ok && parsed.value.op) {
        inferredOp = parsed.value.op;
      }
    } else if (docInfo.graphqlDoc !== undefined) {
      const parsed = parseGraphqlDocument(docInfo.graphqlDoc);
      if (parsed.ok && parsed.value.op) {
        inferredOp = parsed.value.op;
      }
    }

    if (!inferredOp) {
      const err = new CliError(
        ErrorCode.InvalidRequest,
        'No operation specified',
        { hint: `Run "${config.toolName} --help" to see available operations.` },
      );
      printError(err);
      return exitCodeFor(err);
    }

    // Re-route with the inferred operation name from the document envelope
    return runOp(config, inferredOp, argv);
  }

  // 3. Operation specified
  const opName = argv[opIdx]!;
  const rest = argv.filter((_, idx) => idx !== opIdx);

  if (rest.includes('--help') || rest.includes('-h')) {
    const op = config.ops.find((o) => o.name === opName);
    if (op) {
      const schema = op.inputSchema ?? synthesizeSchema(op);
      process.stdout.write(renderOpHelp(config.toolName, schema));
      return 0;
    }
  }

  return runOp(config, opName, rest);
}

async function runOp<C>(
  config: RunnerConfig<C>,
  opName: string,
  argvTokens: string[],
): Promise<number> {
  if (config.product) {
    const productCheck = await checkProductVersion(config.product);
    if (!productCheck.ok) {
      const err = new CliError(
        ErrorCode.UnsupportedProductVersion,
        productCheck.message,
        productCheck.data,
      );
      printError(err);
      return err.exitCode;
    }
  }

  const op = config.ops.find((o) => o.name === opName);
  if (!op) {
    const error = new CliError(
      ErrorCode.InvalidRequest,
      `Unknown operation: ${opName}`,
      { hint: `Run "${config.toolName} --list" to see available operations.` },
    );
    printError(error);
    return error.exitCode;
  }

  const schema = op.inputSchema ?? synthesizeSchema(op);

  // Parse flags against schema and GLOBAL_FLAGS to extract document and globals
  const argvParsed = parseArgvForm(argvTokens, schema, GLOBAL_FLAGS);
  const globalValues = argvParsed.ok ? argvParsed.value.globals : {};
  const opParams = argvParsed.ok ? argvParsed.value.params : {};
  const positionals = argvParsed.ok ? argvParsed.value.positionals : [];

  const docInfo = extractDocString(globalValues);
  if (docInfo.error) {
    printError(docInfo.error);
    return exitCodeFor(docInfo.error);
  }

  const hasDoc = docInfo.jsonDoc !== undefined || docInfo.graphqlDoc !== undefined;

  // Enforce MIXED_INPUT: document inputs may accompany global flags, but not op flags or positionals
  if (hasDoc) {
    const hasOpFlags = Object.keys(opParams).length > 0;
    const hasPositionals = positionals.length > 0;
    if (hasOpFlags || hasPositionals) {
      const which = docInfo.jsonDoc !== undefined ? '--input-json' : '--input-graphql';
      const paramSynopsisParts = schema.params.map((p) => {
        const flag = `--${toKebab(p.name)}`;
        const typeHint = p.type === 'boolean' ? '' : ` <${p.type}>`;
        return `[${flag}${typeHint}]`;
      });
      const opSynopsis = [schema.name, ...paramSynopsisParts].join(' ');
      const issue: ValidationIssue = {
        code: 'MIXED_INPUT',
        message: `cannot mix ${which} with other flags for op "${op.name}". Expected: ${opSynopsis}`,
        op: op.name,
        synopsis: opSynopsis,
        usage: `${config.toolName} ${op.name} [flags]`,
      };
      const err = new CliError(
        ErrorCode.ValidationError,
        `cannot mix ${which} with other flags for op "${op.name}"`,
        { op: op.name, issues: [issue] },
      );
      printError(err);
      return exitCodeFor(err);
    }
    if (!argvParsed.ok) {
      const err = new CliError(
        ErrorCode.ValidationError,
        `invalid arguments for "${op.name}"`,
        { op: op.name, issues: argvParsed.issues },
      );
      printError(err);
      return exitCodeFor(err);
    }
  }

  // Build policy from extracted globals and environment
  const dryRun = globalValues['dryrun'] === true || dryRunFromEnv(config.toolName);
  const readOnly = globalValues['readonly'] === true || readOnlyFromEnv(config.toolName);
  const confirmed = globalValues['confirm'] === true;
  const policy: Policy = {
    dryRun,
    readOnly,
    confirmed,
  };

  let effectiveParams: Record<string, unknown>;
  try {
    const resolved = resolveInput({
      schema,
      argv: argvTokens,
      globals: GLOBAL_FLAGS,
      ...(docInfo.jsonDoc !== undefined ? { jsonDocument: docInfo.jsonDoc } : {}),
      ...(docInfo.graphqlDoc !== undefined ? { graphqlDocument: docInfo.graphqlDoc } : {}),
    });
    effectiveParams = resolved.params;
  } catch (err) {
    if (err instanceof SchemaValidationError) {
      const rawIssues = (err.details?.['issues'] as ValidationIssue[] | undefined) ?? [];
      const issues = (rawIssues.length > 0 ? rawIssues : [
        {
          code: (err.details?.['code'] as ValidationIssueCode) ?? 'DOCUMENT_PARSE',
          message: err.message,
          op: op.name,
          synopsis: (err.details?.['synopsis'] as string) ?? `${op.name} [flags]`,
          usage: `${config.toolName} ${op.name} [flags]`,
        },
      ]).map((issue) => {
        if (issue.code === 'UNKNOWN_PARAM') {
          const paramParts = schema.params.map((p) => {
            const flag = `--${toKebab(p.name)}`;
            const typeHint = p.type === 'boolean' ? '' : ` <${p.type}>`;
            return `[${flag}${typeHint}]`;
          });
          const synopsis = [schema.name, ...paramParts].join(' ');
          return {
            ...issue,
            synopsis,
          };
        }
        return issue;
      });

      const firstIssue = issues[0]!;
      const cliError = new CliError(ErrorCode.ValidationError, firstIssue.message, {
        op: op.name,
        issues,
      });
      printError(cliError);
      return exitCodeFor(cliError);
    }
    throw err;
  }

  try {
    const ctx = config.buildContext(policy);
    const result = await op.run(effectiveParams, ctx);
    printResult(result);
    return 0;
  } catch (error) {
    printError(toCliError(error));
    return exitCodeFor(error);
  }
}
