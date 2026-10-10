/**
 * @fileoverview Module spec parsing and validation for @lmctl-ai/lmts/modules.
 */
import { err, ok } from './types.js';
const SPEC_BASE_REGEX = /^@([A-Za-z0-9][A-Za-z0-9._-]*)\/([A-Za-z0-9][A-Za-z0-9._-]*)$/;
/**
 * Parses a module specifier string (@owner/repo[#(latest|dev)]) into a validated ModuleSpec.
 * Defaults channel to 'latest' when omitted.
 * Rejects any other channel/ref with code SPEC_CHANNEL.
 * Rejects syntax or name errors with code SPEC_SYNTAX.
 */
export function parseSpec(spec) {
    if (typeof spec !== 'string' || spec.trim() === '') {
        return err('SPEC_SYNTAX', 'Module spec must be a non-empty string');
    }
    const hashIndex = spec.indexOf('#');
    if (hashIndex !== -1) {
        const basePart = spec.slice(0, hashIndex);
        const channelPart = spec.slice(hashIndex + 1);
        const baseMatch = SPEC_BASE_REGEX.exec(basePart);
        if (!baseMatch) {
            return err('SPEC_SYNTAX', `Invalid module spec syntax: "${spec}" (expected @owner/repo[#(latest|dev)])`);
        }
        const owner = baseMatch[1];
        const repo = baseMatch[2];
        if (owner === '.' || owner === '..' || repo === '.' || repo === '..') {
            return err('SPEC_SYNTAX', `Invalid owner or repo name: "${spec}"`);
        }
        if (channelPart !== 'latest' && channelPart !== 'dev') {
            return err('SPEC_CHANNEL', 'only the latest and dev channels are supported');
        }
        const channel = channelPart;
        const key = `@${owner}/${repo}#${channel}`;
        return ok({
            owner,
            repo,
            channel,
            key,
            requested: spec,
        });
    }
    const match = SPEC_BASE_REGEX.exec(spec);
    if (!match) {
        return err('SPEC_SYNTAX', `Invalid module spec syntax: "${spec}" (expected @owner/repo[#(latest|dev)])`);
    }
    const owner = match[1];
    const repo = match[2];
    if (owner === '.' || owner === '..' || repo === '.' || repo === '..') {
        return err('SPEC_SYNTAX', `Invalid owner or repo name: "${spec}"`);
    }
    const channel = 'latest';
    const key = `@${owner}/${repo}#${channel}`;
    return ok({
        owner,
        repo,
        channel,
        key,
        requested: spec,
    });
}
