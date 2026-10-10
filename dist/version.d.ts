/**
 * @fileoverview Pure semver-style version parsing, range satisfaction, and product validation.
 * @module @lmctl-ai/lmts/version
 */
export interface ParsedVersion {
    major: number;
    minor: number;
    patch: number;
    raw: string;
}
/**
 * Parses a version string into major, minor, patch numbers.
 * Tolerant of prefixes ('v') and extra suffixes (e.g. '-rc1', '.windows.1', ' (Ubuntu)').
 * If patch is omitted (e.g. '2.43'), patch defaults to 0.
 */
export declare function parseVersion(version: string): ParsedVersion | null;
/**
 * Compares two parsed versions.
 * Returns negative if a < b, 0 if a == b, positive if a > b.
 */
export declare function compareVersions(a: ParsedVersion, b: ParsedVersion): number;
/**
 * Checks if a range string is a valid conjunction of 1 to 4 comparators.
 * Each comparator must be one of >=, >, <=, <, = followed by numeric x.y.z.
 */
export declare function isValidSupportedRange(range: string): boolean;
/**
 * Checks if a version satisfies a range expression.
 * Range expression is a conjunction of 1 to 4 space-separated comparators,
 * each formatted as `>=x.y.z`, `>x.y.z`, `<=x.y.z`, `<x.y.z`, or `=x.y.z`.
 */
export declare function satisfies(version: string, range: string): boolean;
export declare const PRODUCT_NAME_REGEX: RegExp;
export declare const PRODUCT_ARGV0_REGEX: RegExp;
/**
 * Counts capturing groups in a regular expression source.
 * Returns -1 if the pattern is an invalid regular expression.
 */
export declare function countRegExpGroups(pattern: string): number;
