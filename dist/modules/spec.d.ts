/**
 * @fileoverview Module spec parsing and validation for @lmctl-ai/lmts/modules.
 */
import { type ModuleSpec, type Result } from './types.js';
/**
 * Parses a module specifier string (@owner/repo[#(latest|dev)]) into a validated ModuleSpec.
 * Defaults channel to 'latest' when omitted.
 * Rejects any other channel/ref with code SPEC_CHANNEL.
 * Rejects syntax or name errors with code SPEC_SYNTAX.
 */
export declare function parseSpec(spec: string): Result<ModuleSpec>;
