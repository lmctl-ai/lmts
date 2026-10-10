/**
 * @fileoverview Module spec parsing and validation for @lmctl-ai/lmts/modules.
 */
import { err, ok } from './types.js';
const SPEC_REGEX = /^@([A-Za-z0-9][A-Za-z0-9._-]*)\/([A-Za-z0-9][A-Za-z0-9._-]*)(?:#([A-Za-z0-9._/-]+))?$/;
const SEMVER_REGEX = /^v?\d+\.\d+\.\d+([-+].*)?$/;
const COMMIT_HEX_REGEX = /^[0-9a-fA-F]{40}$/;
/**
 * Parses a module specifier string (@owner/repo[#ref]) into a validated ModuleSpec.
 * Rejects invalid syntax, traversal attempts, empty refs, and illegal ref segments.
 */
export function parseSpec(spec) {
    if (typeof spec !== 'string' || spec.trim() === '') {
        return err('SPEC_SYNTAX', 'Module spec must be a non-empty string');
    }
    // Check for trailing or empty hash first
    if (spec.includes('#')) {
        const hashIndex = spec.indexOf('#');
        const refPart = spec.slice(hashIndex + 1);
        if (refPart.length === 0) {
            return err('SPEC_SYNTAX', 'Empty ref in module spec after "#"');
        }
    }
    const match = SPEC_REGEX.exec(spec);
    if (!match) {
        // If the base owner/repo part matched but ref had invalid characters, return SPEC_REF
        if (spec.startsWith('@') && spec.includes('/') && spec.includes('#')) {
            const hashIndex = spec.indexOf('#');
            const basePart = spec.slice(0, hashIndex);
            if (/^@[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(basePart)) {
                return err('SPEC_REF', 'Invalid characters or formatting in ref');
            }
        }
        return err('SPEC_SYNTAX', `Invalid module spec syntax: "${spec}" (expected @owner/repo[#ref])`);
    }
    const owner = match[1];
    const repo = match[2];
    const ref = match[3];
    if (owner === '.' || owner === '..' || repo === '.' || repo === '..') {
        return err('SPEC_SYNTAX', `Invalid owner or repo name: "${spec}"`);
    }
    if (ref !== undefined) {
        if (ref.startsWith('/') || ref.endsWith('/')) {
            return err('SPEC_REF', `Invalid ref "${ref}": leading or trailing slash not allowed`);
        }
        if (ref.includes('//')) {
            return err('SPEC_REF', `Invalid ref "${ref}": consecutive slashes not allowed`);
        }
        const segments = ref.split('/');
        for (const segment of segments) {
            if (segment === '..') {
                return err('SPEC_REF', `Invalid ref "${ref}": traversal segment ".." not allowed`);
            }
            if (segment === '.') {
                return err('SPEC_REF', `Invalid ref "${ref}": segment "." not allowed`);
            }
            if (segment.length === 0) {
                return err('SPEC_REF', `Invalid ref "${ref}": empty segment not allowed`);
            }
        }
    }
    const refOrHead = ref ?? 'HEAD';
    const key = `@${owner}/${repo}${ref ? '#' + ref : ''}`;
    const immutable = ref !== undefined && (SEMVER_REGEX.test(ref) || COMMIT_HEX_REGEX.test(ref));
    return ok({
        owner,
        repo,
        ...(ref !== undefined ? { ref } : {}),
        refOrHead,
        key,
        immutable,
    });
}
