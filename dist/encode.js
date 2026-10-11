/**
 * @fileoverview Client-side encoders: params -> argv array / JSON document /
 * GraphQL document, each the inverse of the matching server-side parser
 * (`parseArgvForm`, `parseJsonInput`, `parseGraphqlInput`). Depends on types
 * only, so it is safe for the consumer ("./validate") entry.
 *
 * Limitations of the argv form: an empty array cannot be expressed (it is
 * omitted), and a 'json'-typed param holding a string that looks like a
 * literal (e.g. "true", "12") is re-read as that literal.
 * @module @lmctl-ai/lmts/encode
 */
function kebab(name) {
    return name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
}
function isMulti(spec) {
    return spec.type === 'array' || spec.occurs === '+' || spec.occurs === '*';
}
function elementType(spec) {
    return spec.type === 'array' ? (spec.items ?? 'string') : spec.type;
}
/** Render one element as the raw string `parseArgvForm` will coerce back. */
function argvValue(type, value) {
    if (typeof value === 'string' && (type === 'string' || type === 'json'))
        return value;
    if (type === 'number' || type === 'boolean')
        return String(value);
    return JSON.stringify(value);
}
/**
 * Encode params as an argv array (op name not included). Values always use
 * the `--k=v` form so a value may start with '-' or contain anything.
 * Booleans use `--k` / `--no-k`; multi params repeat the flag. With
 * `positional`, positional params follow a `--` in schema order.
 */
export function encodeArgv(schema, params, opts = {}) {
    const out = [];
    // Values of each positional param by schema index: emitted in schema order (the order the
    // runner assigns positionals in), whatever the key order of `params`.
    const trailing = [];
    const specs = new Map(schema.params.map((p) => [p.name, p]));
    const indexOf = new Map(schema.params.map((p, i) => [p.name, i]));
    for (const [name, value] of Object.entries(params)) {
        if (value === undefined)
            continue;
        const declared = specs.get(name);
        const spec = declared ?? { name, type: 'json', occurs: '?' };
        const flag = `--${kebab(name)}`;
        const type = elementType(spec);
        if (opts.positional && spec.positional === true) {
            const items = isMulti(spec) && Array.isArray(value) ? value : [value];
            const index = indexOf.get(name) ?? Number.MAX_SAFE_INTEGER;
            trailing.push({ index, values: items.map((v) => argvValue(type, v)) });
            continue;
        }
        if (isMulti(spec) && Array.isArray(value)) {
            for (const v of value)
                out.push(`${flag}=${argvValue(type, v)}`);
            continue;
        }
        // `--no-k` only resolves for declared params; undeclared ones use `--k=false`.
        if (typeof value === 'boolean' && declared && (type === 'boolean' || type === 'json')) {
            out.push(value ? flag : `--no-${kebab(name)}`);
            continue;
        }
        out.push(`${flag}=${argvValue(type, value)}`);
    }
    if (trailing.length > 0) {
        trailing.sort((a, b) => a.index - b.index);
        out.push('--', ...trailing.flatMap((t) => t.values));
    }
    return out;
}
/** Encode as a JSON envelope `{"op": name, "params": {...}}`. */
export function encodeJson(schema, params) {
    const clean = Object.create(null);
    for (const [k, v] of Object.entries(params))
        if (v !== undefined)
            clean[k] = v;
    return JSON.stringify({ op: schema.name, params: clean });
}
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
function graphqlValue(value, path) {
    if (value === null)
        return 'null';
    switch (typeof value) {
        case 'string':
            return JSON.stringify(value);
        case 'boolean':
            return String(value);
        case 'number':
            if (!Number.isFinite(value))
                throw new TypeError(`${path}: cannot encode non-finite number in GraphQL`);
            return JSON.stringify(value);
        case 'object': {
            if (Array.isArray(value))
                return `[${value.map((v, i) => graphqlValue(v, `${path}[${i}]`)).join(', ')}]`;
            const fields = [];
            for (const [k, v] of Object.entries(value)) {
                if (v === undefined)
                    continue;
                if (!IDENT.test(k))
                    throw new TypeError(`${path}.${k}: object key is not a GraphQL name`);
                fields.push(`${k}: ${graphqlValue(v, `${path}.${k}`)}`);
            }
            return `{${fields.join(', ')}}`;
        }
        default:
            throw new TypeError(`${path}: cannot encode ${typeof value} in GraphQL`);
    }
}
/**
 * Encode as the inline-literal GraphQL subset accepted by `parseGraphqlInput`:
 * `query|mutation { op(arg: <literal>, …) { __typename } }`.
 */
export function encodeGraphql(schema, params) {
    if (!IDENT.test(schema.name))
        throw new TypeError(`op name ${schema.name} is not a GraphQL name`);
    const args = [];
    for (const [k, v] of Object.entries(params)) {
        if (v === undefined)
            continue;
        if (!IDENT.test(k))
            throw new TypeError(`param ${k} is not a GraphQL name`);
        args.push(`${k}: ${graphqlValue(v, k)}`);
    }
    const kw = schema.access === 'write' ? 'mutation' : 'query';
    const argList = args.length > 0 ? `(${args.join(', ')})` : '';
    return `${kw} { ${schema.name}${argList} { __typename } }`;
}
