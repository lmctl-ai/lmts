/**
 * @fileoverview GraphQL-style input form. Accepts a small, documented subset:
 *
 *   mutation { opName(paramA: "x", paramB: [1,2], paramC: true) { __typename } }
 *   query { opName(paramA: "x") { __typename } }
 *   { opName(paramA: "x") { __typename } }
 *
 * The selection set is ignored; only the arguments are validated against the
 * op's schema. Variables and named operations are rejected.
 * @module @lmctl-ai/lmts/graphql-form
 */
import { SchemaValidationError, validateParams } from './validate.js';
import { usageLine } from './synopsis.js';
class InternalParseError extends Error {
    code;
    extra;
    constructor(message, code = 'DOCUMENT_PARSE', extra = {}) {
        super(message);
        this.code = code;
        this.extra = extra;
        this.name = 'InternalParseError';
    }
}
function skipWs(text, i) {
    while (i.pos < text.length) {
        const c = text[i.pos];
        if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
            i.pos++;
        }
        else if (c === '#') {
            while (i.pos < text.length && text[i.pos] !== '\n')
                i.pos++;
        }
        else {
            break;
        }
    }
}
function parseString(text, i) {
    i.pos++; // consume "
    let out = '';
    while (i.pos < text.length) {
        const c = text[i.pos];
        if (c === '"') {
            i.pos++;
            return out;
        }
        if (c === '\\') {
            const next = text[i.pos + 1];
            switch (next) {
                case '"':
                    out += '"';
                    i.pos += 2;
                    break;
                case '\\':
                    out += '\\';
                    i.pos += 2;
                    break;
                case 'n':
                    out += '\n';
                    i.pos += 2;
                    break;
                case 't':
                    out += '\t';
                    i.pos += 2;
                    break;
                case 'r':
                    out += '\r';
                    i.pos += 2;
                    break;
                case '/':
                    out += '/';
                    i.pos += 2;
                    break;
                case 'b':
                    out += '\b';
                    i.pos += 2;
                    break;
                case 'f':
                    out += '\f';
                    i.pos += 2;
                    break;
                case 'u': {
                    const hex = text.slice(i.pos + 2, i.pos + 6);
                    const code = Number.parseInt(hex, 16);
                    if (Number.isNaN(code)) {
                        throw new InternalParseError('invalid \\u escape', 'DOCUMENT_PARSE', { offset: i.pos });
                    }
                    out += String.fromCharCode(code);
                    i.pos += 6;
                    break;
                }
                default:
                    throw new InternalParseError(`unknown escape \\${next}`, 'DOCUMENT_PARSE', { offset: i.pos });
            }
        }
        else {
            out += c;
            i.pos++;
        }
    }
    throw new InternalParseError('unterminated string literal', 'DOCUMENT_PARSE', { offset: i.pos });
}
function parseNumber(text, i) {
    const m = /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(i.pos));
    if (!m)
        throw new InternalParseError('invalid number', 'DOCUMENT_PARSE', { offset: i.pos });
    i.pos += m[0].length;
    return Number(m[0]);
}
function parseArray(text, i) {
    i.pos++; // [
    const out = [];
    skipWs(text, i);
    if (text[i.pos] === ']') {
        i.pos++;
        return out;
    }
    while (i.pos < text.length) {
        out.push(parseValue(text, i));
        skipWs(text, i);
        const c = text[i.pos];
        if (c === ',') {
            i.pos++;
            skipWs(text, i);
            continue;
        }
        if (c === ']') {
            i.pos++;
            return out;
        }
        throw new InternalParseError('expected , or ] in array', 'DOCUMENT_PARSE', { offset: i.pos });
    }
    throw new InternalParseError('unterminated array', 'DOCUMENT_PARSE', { offset: i.pos });
}
function parseObject(text, i) {
    i.pos++; // {
    const out = Object.create(null);
    skipWs(text, i);
    if (text[i.pos] === '}') {
        i.pos++;
        return out;
    }
    while (i.pos < text.length) {
        skipWs(text, i);
        if (text[i.pos] === '$') {
            throw new InternalParseError('variables and operation names are not supported; inline literal values', 'DOCUMENT_PARSE', { offset: i.pos });
        }
        const keyM = /^[A-Za-z_][A-Za-z0-9_]*/.exec(text.slice(i.pos));
        if (!keyM) {
            throw new InternalParseError('expected object key', 'DOCUMENT_PARSE', { offset: i.pos });
        }
        const key = keyM[0];
        i.pos += key.length;
        skipWs(text, i);
        if (text[i.pos] !== ':') {
            throw new InternalParseError('expected : after object key', 'DOCUMENT_PARSE', { offset: i.pos });
        }
        i.pos++;
        out[key] = parseValue(text, i);
        skipWs(text, i);
        const c = text[i.pos];
        if (c === ',') {
            i.pos++;
            continue;
        }
        if (c === '}') {
            i.pos++;
            return out;
        }
        throw new InternalParseError('expected , or } in object', 'DOCUMENT_PARSE', { offset: i.pos });
    }
    throw new InternalParseError('unterminated object', 'DOCUMENT_PARSE', { offset: i.pos });
}
function parseValue(text, i) {
    skipWs(text, i);
    const c = text[i.pos];
    if (c === '$') {
        throw new InternalParseError('variables and operation names are not supported; inline literal values', 'DOCUMENT_PARSE', { offset: i.pos });
    }
    if (c === '"')
        return parseString(text, i);
    if (c === '[')
        return parseArray(text, i);
    if (c === '{')
        return parseObject(text, i);
    if (c === '-' || (c !== undefined && c >= '0' && c <= '9'))
        return parseNumber(text, i);
    if (text.startsWith('true', i.pos)) {
        i.pos += 4;
        return true;
    }
    if (text.startsWith('false', i.pos)) {
        i.pos += 5;
        return false;
    }
    if (text.startsWith('null', i.pos)) {
        i.pos += 4;
        return null;
    }
    // Enum or bare identifier
    const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(text.slice(i.pos));
    if (m) {
        i.pos += m[0].length;
        return m[0];
    }
    throw new InternalParseError(`unexpected value at offset ${i.pos}`, 'DOCUMENT_PARSE', { offset: i.pos });
}
/**
 * Parse a minimal GraphQL document returning a Result.
 * Variables and named operations are rejected.
 * Multiple top-level fields are rejected.
 * Null arguments are omitted so parameter defaults apply.
 */
export function parseGraphqlDocument(text) {
    const i = { pos: 0 };
    let parsedOp;
    try {
        skipWs(text, i);
        // Optional operation keyword: query|mutation|subscription
        const opKw = /^(query|mutation|subscription)\b/.exec(text.slice(i.pos));
        if (opKw) {
            i.pos += opKw[0].length;
            skipWs(text, i);
            if (text[i.pos] !== '{') {
                // Named operation or variable definitions follow keyword
                throw new InternalParseError('variables and operation names are not supported; inline literal values', 'DOCUMENT_PARSE', { offset: i.pos });
            }
        }
        if (text[i.pos] !== '{') {
            if (text[i.pos] === '$' || /^[A-Za-z_]/.test(text.slice(i.pos))) {
                throw new InternalParseError('variables and operation names are not supported; inline literal values', 'DOCUMENT_PARSE', { offset: i.pos });
            }
            throw new InternalParseError(`expected { at offset ${i.pos}`, 'DOCUMENT_PARSE', { offset: i.pos });
        }
        i.pos++; // consume {
        skipWs(text, i);
        if (text[i.pos] === '$') {
            throw new InternalParseError('variables and operation names are not supported; inline literal values', 'DOCUMENT_PARSE', { offset: i.pos });
        }
        const fieldM = /^[A-Za-z_][A-Za-z0-9_]*/.exec(text.slice(i.pos));
        if (!fieldM) {
            throw new InternalParseError('expected operation field name', 'DOCUMENT_PARSE', { offset: i.pos });
        }
        const field = fieldM[0];
        parsedOp = field;
        i.pos += field.length;
        skipWs(text, i);
        const params = Object.create(null);
        if (text[i.pos] === '(') {
            i.pos++;
            skipWs(text, i);
            while (i.pos < text.length && text[i.pos] !== ')') {
                if (text[i.pos] === '$') {
                    throw new InternalParseError('variables and operation names are not supported; inline literal values', 'DOCUMENT_PARSE', { offset: i.pos });
                }
                const keyM = /^[A-Za-z_][A-Za-z0-9_]*/.exec(text.slice(i.pos));
                if (!keyM) {
                    throw new InternalParseError('expected argument name', 'DOCUMENT_PARSE', { offset: i.pos });
                }
                const key = keyM[0];
                i.pos += key.length;
                skipWs(text, i);
                if (text[i.pos] !== ':') {
                    throw new InternalParseError(`expected : after argument name "${key}"`, 'DOCUMENT_PARSE', { offset: i.pos });
                }
                i.pos++;
                skipWs(text, i);
                const val = parseValue(text, i);
                // null argument -> key omitted (so defaults apply)
                if (val !== null) {
                    params[key] = val;
                }
                skipWs(text, i);
                if (text[i.pos] === ',') {
                    i.pos++;
                    skipWs(text, i);
                }
            }
            if (text[i.pos] !== ')') {
                throw new InternalParseError('expected ) after arguments', 'DOCUMENT_PARSE', { offset: i.pos });
            }
            i.pos++;
        }
        // Skip the selection set { … } if present
        skipWs(text, i);
        if (text[i.pos] === '{') {
            let depth = 0;
            let inString = false;
            let escaped = false;
            const start = i.pos;
            for (; i.pos < text.length; i.pos++) {
                const c = text[i.pos];
                if (escaped) {
                    escaped = false;
                    continue;
                }
                if (c === '\\') {
                    escaped = true;
                    continue;
                }
                if (c === '"') {
                    inString = !inString;
                    continue;
                }
                if (inString)
                    continue;
                if (c === '#') {
                    while (i.pos < text.length && text[i.pos] !== '\n')
                        i.pos++;
                    continue;
                }
                if (c === '{')
                    depth++;
                if (c === '}') {
                    depth--;
                    if (depth === 0) {
                        i.pos++;
                        break;
                    }
                }
            }
            if (depth !== 0) {
                throw new InternalParseError('unbalanced braces in selection set', 'DOCUMENT_PARSE', { offset: start });
            }
        }
        skipWs(text, i);
        if (text[i.pos] === '}') {
            i.pos++;
        }
        else {
            if (i.pos >= text.length) {
                throw new InternalParseError('unclosed operation: expected }', 'DOCUMENT_PARSE', { offset: i.pos });
            }
            // Another field or invalid content within root braces
            throw new InternalParseError('more than one top-level field is not supported', 'DOCUMENT_PARSE', { offset: i.pos });
        }
        skipWs(text, i);
        if (i.pos < text.length) {
            throw new InternalParseError('unexpected trailing content', 'DOCUMENT_PARSE', { offset: i.pos });
        }
        return {
            ok: true,
            value: {
                op: field,
                params,
            },
        };
    }
    catch (err) {
        if (err instanceof InternalParseError) {
            const op = parsedOp;
            const usage = usageLine({ name: op ?? '<graphql>', params: [] });
            return {
                ok: false,
                issues: [
                    {
                        code: err.code,
                        message: `${err.message}. Expected: ${usage}`,
                        ...(op ? { op } : {}),
                        synopsis: usage,
                        usage,
                        ...err.extra,
                    },
                ],
            };
        }
        throw err;
    }
}
/** Throwing compat wrapper around parseGraphqlDocument. */
export function parseGraphqlInput(text) {
    const result = parseGraphqlDocument(text);
    if (!result.ok) {
        const first = result.issues[0];
        throw new SchemaValidationError(first.op ?? '<graphql>', first.message, {
            code: first.code,
            synopsis: first.synopsis,
            issues: result.issues,
            offset: first.offset,
        });
    }
    return result.value;
}
/** Validate against the op schema. */
export function validateGraphqlParams(schema, doc) {
    return validateParams(schema, doc.params);
}
