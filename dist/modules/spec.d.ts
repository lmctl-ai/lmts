/**
 * @fileoverview Module spec parsing and validation for @lmctl-ai/lmts/modules.
 */
import { type ModuleSpec, type Result } from './types.js';
/**
 * Parses a module specifier string (@owner/repo[#ref]) into a validated ModuleSpec.
 * Rejects invalid syntax, traversal attempts, empty refs, and illegal ref segments.
 */
export declare function parseSpec(spec: string): Result<ModuleSpec>;
