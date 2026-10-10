/**
 * @fileoverview Publish a tool's operation schemas as a single discoverable
 * document. Think of this shape as "Swagger for CLI": a consumer can fetch
 * it, validate input against it, and generate documentation from it.
 *
 * Document version: cli.schema.v1
 * @module @lmctl-ai/lmts/publish
 */
import { isReservedName } from './types.js';
import { SchemaValidationError } from './validate.js';
/**
 * Build the publishable document for a tool. Callers pass every op that
 * declares a schema.
 */
export function publishSchema(tool, operations, opts) {
    const doc = {
        schema: 'cli.schema.v1',
        tool,
        version: opts?.version ?? 'unknown',
        policy: opts?.policy ?? { dryrun: true, readonly: true },
        inputs: opts?.inputs ?? ['flags', 'json', 'graphql'],
        operations,
    };
    if (opts?.globals !== undefined) {
        doc.globals = opts.globals;
    }
    return doc;
}
/**
 * Detect missing descriptions on operations, params, and globals.
 * Populates `doc.warnings` and returns the warnings array.
 */
export function schemaWarnings(doc) {
    const warnings = [];
    for (const op of doc.operations) {
        if (!op.description || op.description.trim() === '') {
            warnings.push(`operation "${op.name}" is missing a description`);
        }
        for (const p of op.params) {
            if (!p.description || p.description.trim() === '') {
                warnings.push(`param "${p.name}" of operation "${op.name}" is missing a description`);
            }
        }
    }
    if (doc.globals) {
        for (const g of doc.globals) {
            if (!g.description || g.description.trim() === '') {
                warnings.push(`global param "${g.name}" is missing a description`);
            }
        }
    }
    doc.warnings = warnings;
    return warnings;
}
const VALID_PARAM_TYPES = new Set([
    'string',
    'number',
    'boolean',
    'object',
    'array',
    'json',
]);
const VALID_PARAM_OCCURS = new Set(['1', '?', '+', '*']);
const VALID_PARAM_ITEMS = new Set(['string', 'number', 'boolean', 'object']);
const VALID_ACCESS = new Set(['read', 'write', 'dynamic']);
const VALID_RETURNS = new Set([
    'object',
    'array',
    'string',
    'number',
    'boolean',
    'null',
]);
const TOOL_AND_OP_NAME_RE = /^[a-z][a-z0-9_]*$/;
const PARAM_NAME_RE = /^[A-Za-z_]\w*$/;
const GLOBAL_PARAM_NAME_RE = /^[A-Za-z_][A-Za-z0-9_-]*$/;
const ALLOWED_PARAM_KEYS = new Set([
    'name',
    'type',
    'occurs',
    'default',
    'enum',
    'positional',
    'items',
    'description',
    'aliases',
    'cliOnly',
    'docOnly',
    'derived',
]);
function defaultMatchesType(val, type, items, occurs, allowedEnum) {
    if (val === undefined)
        return true;
    if (allowedEnum && allowedEnum.length > 0) {
        if (!allowedEnum.includes(val)) {
            return false;
        }
    }
    if (occurs === '+' || occurs === '*' || type === 'array') {
        if (!Array.isArray(val))
            return false;
        const elemType = items ?? (type === 'array' ? 'string' : type);
        return val.every((item) => defaultMatchesScalar(item, elemType));
    }
    return defaultMatchesScalar(val, type);
}
function defaultMatchesScalar(val, type) {
    switch (type) {
        case 'string':
            return typeof val === 'string';
        case 'number':
            return typeof val === 'number' && !Number.isNaN(val);
        case 'boolean':
            return typeof val === 'boolean';
        case 'object':
            return typeof val === 'object' && val !== null && !Array.isArray(val);
        case 'array':
            return Array.isArray(val);
        case 'json':
            return val !== undefined;
        default:
            return false;
    }
}
/**
 * Validate that an arbitrary object is a well-formed PublishedCliSchema.
 * Returns a Result with all issues found during structural validation.
 */
export function parsePublishedSchema(value) {
    const issues = [];
    const addIssue = (code, message, opts = {}) => {
        const usage = opts.usage ?? (opts.op ? `${opts.op} [flags]` : '<unknown> [flags]');
        const synopsis = opts.synopsis ?? usage;
        issues.push({
            code,
            message: `${message}. Expected: ${synopsis}`,
            ...(opts.op ? { op: opts.op } : {}),
            ...(opts.param ? { param: opts.param } : {}),
            synopsis,
            usage,
            ...(opts.received !== undefined ? { received: opts.received } : {}),
            ...(opts.allowed !== undefined ? { allowed: opts.allowed } : {}),
        });
    };
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        addIssue('DOCUMENT_PARSE', 'cli.schema.v1: document must be an object', {
            received: value,
        });
        return { ok: false, issues };
    }
    const doc = value;
    if (doc['schema'] !== 'cli.schema.v1') {
        addIssue('DOCUMENT_PARSE', `cli.schema.v1: unsupported schema tag: ${JSON.stringify(doc['schema'])}`, { received: doc['schema'], allowed: ['cli.schema.v1'] });
    }
    const tool = doc['tool'];
    if (typeof tool !== 'string' || !TOOL_AND_OP_NAME_RE.test(tool)) {
        addIssue('DOCUMENT_PARSE', `cli.schema.v1: tool must be a string matching ^[a-z][a-z0-9_]*$, received ${JSON.stringify(tool)}`, { received: tool });
    }
    else if (isReservedName(tool)) {
        addIssue('RESERVED_NAME', `cli.schema.v1: tool cannot be named "${tool}" (reserved name)`, { received: tool });
    }
    if (doc['version'] !== undefined && typeof doc['version'] !== 'string') {
        addIssue('TYPE_MISMATCH', `cli.schema.v1: version must be a string, received ${typeof doc['version']}`, { received: doc['version'] });
    }
    if (doc['policy'] !== undefined) {
        if (doc['policy'] === null || typeof doc['policy'] !== 'object' || Array.isArray(doc['policy'])) {
            addIssue('TYPE_MISMATCH', 'cli.schema.v1: policy must be an object', {
                received: doc['policy'],
            });
        }
        else {
            const pol = doc['policy'];
            if (typeof pol['dryrun'] !== 'boolean' || typeof pol['readonly'] !== 'boolean') {
                addIssue('TYPE_MISMATCH', 'cli.schema.v1: policy must contain boolean dryrun and readonly properties', { received: doc['policy'] });
            }
        }
    }
    if (doc['inputs'] !== undefined) {
        if (!Array.isArray(doc['inputs'])) {
            addIssue('TYPE_MISMATCH', 'cli.schema.v1: inputs must be an array', {
                received: doc['inputs'],
            });
        }
        else {
            for (const input of doc['inputs']) {
                if (!['flags', 'json', 'graphql'].includes(input)) {
                    addIssue('ENUM_VIOLATION', `cli.schema.v1: inputs contains unsupported form "${String(input)}"`, { received: input, allowed: ['flags', 'json', 'graphql'] });
                }
            }
        }
    }
    const validateParamSpec = (p, opName, isGlobal = false) => {
        if (p === null || typeof p !== 'object' || Array.isArray(p)) {
            addIssue('TYPE_MISMATCH', `cli.schema.v1: param${opName ? ` in "${opName}"` : ''} must be an object`, { op: opName, received: p });
            return;
        }
        const po = p;
        const pName = po['name'];
        if (typeof pName !== 'string') {
            addIssue('TYPE_MISMATCH', `cli.schema.v1: param${opName ? ` in "${opName}"` : ''} needs a string name`, { op: opName, received: pName });
            return;
        }
        for (const key of Object.keys(po)) {
            if (!ALLOWED_PARAM_KEYS.has(key)) {
                addIssue('UNKNOWN_PARAM', `cli.schema.v1: param "${pName}"${opName ? ` in "${opName}"` : ''} has unknown property "${key}"`, {
                    op: opName,
                    param: pName,
                    received: key,
                    allowed: Array.from(ALLOWED_PARAM_KEYS),
                });
            }
        }
        const nameRegex = isGlobal ? GLOBAL_PARAM_NAME_RE : PARAM_NAME_RE;
        if (!nameRegex.test(pName)) {
            addIssue('DOCUMENT_PARSE', `cli.schema.v1: param "${pName}"${opName ? ` in "${opName}"` : ''} name must match ${isGlobal ? '^[A-Za-z_][A-Za-z0-9_-]*$' : '^[A-Za-z_]\\w*$'}`, { op: opName, param: pName, received: pName });
        }
        else if (isReservedName(pName)) {
            addIssue('RESERVED_NAME', `cli.schema.v1: ${isGlobal ? 'global ' : ''}param "${pName}"${opName ? ` in "${opName}"` : ''} is a reserved name`, { op: opName, param: pName, received: pName });
        }
        if (!isGlobal && pName === 'dryrun') {
            addIssue('DOCUMENT_PARSE', `cli.schema.v1: param cannot be named "dryrun" (reserved global policy flag)`, { op: opName, param: pName, received: pName });
        }
        const pAliases = po['aliases'];
        if (pAliases !== undefined) {
            if (Array.isArray(pAliases)) {
                for (const alias of pAliases) {
                    if (typeof alias === 'string' && isReservedName(alias)) {
                        addIssue('RESERVED_NAME', `cli.schema.v1: param "${pName}"${opName ? ` in "${opName}"` : ''} alias "${alias}" is a reserved name`, { op: opName, param: pName, received: alias });
                    }
                }
            }
        }
        const pType = po['type'];
        if (typeof pType !== 'string' || !VALID_PARAM_TYPES.has(pType)) {
            addIssue('ENUM_VIOLATION', `cli.schema.v1: param "${pName}"${opName ? ` in "${opName}"` : ''} has invalid type: ${JSON.stringify(pType)}`, {
                op: opName,
                param: pName,
                received: pType,
                allowed: Array.from(VALID_PARAM_TYPES),
            });
        }
        const pOccurs = po['occurs'];
        if (pOccurs !== undefined && !VALID_PARAM_OCCURS.has(pOccurs)) {
            addIssue('ENUM_VIOLATION', `cli.schema.v1: param "${pName}"${opName ? ` in "${opName}"` : ''} has invalid occurs: ${JSON.stringify(pOccurs)}`, {
                op: opName,
                param: pName,
                received: pOccurs,
                allowed: Array.from(VALID_PARAM_OCCURS),
            });
        }
        const pEnum = po['enum'];
        if (pEnum !== undefined) {
            if (!Array.isArray(pEnum) || !pEnum.every((e) => typeof e === 'string' || typeof e === 'number')) {
                addIssue('TYPE_MISMATCH', `cli.schema.v1: param "${pName}"${opName ? ` in "${opName}"` : ''} enum must be an array of strings or numbers`, { op: opName, param: pName, received: pEnum });
            }
        }
        const pItems = po['items'];
        if (pItems !== undefined && !VALID_PARAM_ITEMS.has(pItems)) {
            addIssue('ENUM_VIOLATION', `cli.schema.v1: param "${pName}"${opName ? ` in "${opName}"` : ''} has invalid items type: ${JSON.stringify(pItems)}`, {
                op: opName,
                param: pName,
                received: pItems,
                allowed: Array.from(VALID_PARAM_ITEMS),
            });
        }
        if (po['default'] !== undefined && VALID_PARAM_TYPES.has(pType)) {
            const enumArr = Array.isArray(pEnum) ? pEnum : undefined;
            if (!defaultMatchesType(po['default'], pType, pItems, pOccurs, enumArr)) {
                addIssue('TYPE_MISMATCH', `cli.schema.v1: param "${pName}"${opName ? ` in "${opName}"` : ''} default value does not match declared type "${pType}"`, {
                    op: opName,
                    param: pName,
                    received: po['default'],
                });
            }
        }
    };
    if (doc['globals'] !== undefined) {
        if (!Array.isArray(doc['globals'])) {
            addIssue('TYPE_MISMATCH', 'cli.schema.v1: globals must be an array', {
                received: doc['globals'],
            });
        }
        else {
            for (const g of doc['globals']) {
                validateParamSpec(g, undefined, true);
            }
        }
    }
    if (!Array.isArray(doc['operations'])) {
        addIssue('DOCUMENT_PARSE', 'cli.schema.v1: operations must be an array', {
            received: doc['operations'],
        });
    }
    else {
        const seenOps = new Set();
        for (const op of doc['operations']) {
            if (op === null || typeof op !== 'object' || Array.isArray(op)) {
                addIssue('DOCUMENT_PARSE', 'cli.schema.v1: every operation must be an object', {
                    received: op,
                });
                continue;
            }
            const opObj = op;
            const opName = opObj['name'];
            if (typeof opName !== 'string') {
                addIssue('DOCUMENT_PARSE', 'cli.schema.v1: every operation needs a string name', {
                    received: opName,
                });
                continue;
            }
            if (!TOOL_AND_OP_NAME_RE.test(opName)) {
                addIssue('DOCUMENT_PARSE', `cli.schema.v1: operation name "${opName}" must match ^[a-z][a-z0-9_]*$`, { op: opName, received: opName });
            }
            else if (isReservedName(opName)) {
                addIssue('RESERVED_NAME', `cli.schema.v1: operation cannot be named "${opName}" (reserved name)`, { op: opName, received: opName });
            }
            if (seenOps.has(opName)) {
                addIssue('DOCUMENT_PARSE', `cli.schema.v1: duplicate operation name "${opName}"`, {
                    op: opName,
                });
            }
            seenOps.add(opName);
            if (opObj['access'] !== undefined) {
                if (!VALID_ACCESS.has(opObj['access'])) {
                    addIssue('ENUM_VIOLATION', `cli.schema.v1: operation "${opName}" has invalid access: ${JSON.stringify(opObj['access'])}`, {
                        op: opName,
                        received: opObj['access'],
                        allowed: Array.from(VALID_ACCESS),
                    });
                }
            }
            if (opObj['returns'] !== undefined) {
                if (!VALID_RETURNS.has(opObj['returns'])) {
                    addIssue('ENUM_VIOLATION', `cli.schema.v1: operation "${opName}" has invalid returns: ${JSON.stringify(opObj['returns'])}`, {
                        op: opName,
                        received: opObj['returns'],
                        allowed: Array.from(VALID_RETURNS),
                    });
                }
            }
            if (!Array.isArray(opObj['params'])) {
                addIssue('DOCUMENT_PARSE', `cli.schema.v1: operation "${opName}" needs a params array`, { op: opName, received: opObj['params'] });
            }
            else {
                for (const p of opObj['params']) {
                    validateParamSpec(p, opName, false);
                }
            }
        }
    }
    if (issues.length > 0) {
        return { ok: false, issues };
    }
    return { ok: true, value: value };
}
/**
 * Throwing compat wrapper around parsePublishedSchema.
 */
export function parsePublishedSchemaOrThrow(value) {
    const result = parsePublishedSchema(value);
    if (!result.ok) {
        const first = result.issues[0];
        throw new SchemaValidationError(first.op ?? '<unknown>', first.message, {
            code: first.code,
            synopsis: first.synopsis,
            issues: result.issues,
        });
    }
    return result.value;
}
/**
 * Look up an op in a published document.
 */
export function findOperation(doc, name) {
    return doc.operations.find((op) => op.name === name);
}
