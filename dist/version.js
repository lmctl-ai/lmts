/**
 * @fileoverview Pure semver-style version parsing, range satisfaction, and product validation.
 * @module @lmctl-ai/lmts/version
 */
const VERSION_REGEX = /^v?(\d+)\.(\d+)(?:\.(\d+))?/;
/**
 * Parses a version string into major, minor, patch numbers.
 * Tolerant of prefixes ('v') and extra suffixes (e.g. '-rc1', '.windows.1', ' (Ubuntu)').
 * If patch is omitted (e.g. '2.43'), patch defaults to 0.
 */
export function parseVersion(version) {
    if (typeof version !== 'string')
        return null;
    const trimmed = version.trim();
    const match = trimmed.match(VERSION_REGEX);
    if (!match)
        return null;
    const major = parseInt(match[1], 10);
    const minor = parseInt(match[2], 10);
    const patch = match[3] !== undefined ? parseInt(match[3], 10) : 0;
    if (!Number.isFinite(major) || !Number.isFinite(minor) || !Number.isFinite(patch)) {
        return null;
    }
    return { major, minor, patch, raw: trimmed };
}
/**
 * Compares two parsed versions.
 * Returns negative if a < b, 0 if a == b, positive if a > b.
 */
export function compareVersions(a, b) {
    if (a.major !== b.major)
        return a.major - b.major;
    if (a.minor !== b.minor)
        return a.minor - b.minor;
    return a.patch - b.patch;
}
const COMPARATOR_REGEX = /^(>=|>|<=|<|=)(\d+\.\d+\.\d+)$/;
/**
 * Checks if a range string is a valid conjunction of 1 to 4 comparators.
 * Each comparator must be one of >=, >, <=, <, = followed by numeric x.y.z.
 */
export function isValidSupportedRange(range) {
    if (typeof range !== 'string')
        return false;
    const parts = range.trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0 || parts.length > 4)
        return false;
    for (const part of parts) {
        if (!COMPARATOR_REGEX.test(part))
            return false;
    }
    return true;
}
/**
 * Checks if a version satisfies a range expression.
 * Range expression is a conjunction of 1 to 4 space-separated comparators,
 * each formatted as `>=x.y.z`, `>x.y.z`, `<=x.y.z`, `<x.y.z`, or `=x.y.z`.
 */
export function satisfies(version, range) {
    const parsed = parseVersion(version);
    if (!parsed)
        return false;
    if (typeof range !== 'string')
        return false;
    const parts = range.trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0 || parts.length > 4)
        return false;
    for (const part of parts) {
        const match = part.match(COMPARATOR_REGEX);
        if (!match)
            return false;
        const op = match[1];
        const targetVer = parseVersion(match[2]);
        if (!targetVer)
            return false;
        const cmp = compareVersions(parsed, targetVer);
        switch (op) {
            case '>=':
                if (cmp < 0)
                    return false;
                break;
            case '>':
                if (cmp <= 0)
                    return false;
                break;
            case '<=':
                if (cmp > 0)
                    return false;
                break;
            case '<':
                if (cmp >= 0)
                    return false;
                break;
            case '=':
                if (cmp !== 0)
                    return false;
                break;
            default:
                return false;
        }
    }
    return true;
}
export const PRODUCT_NAME_REGEX = /^[a-z][a-z0-9_.-]{0,63}$/;
export const PRODUCT_ARGV0_REGEX = /^[a-z][a-z0-9_.-]*$/;
/**
 * Counts capturing groups in a regular expression source.
 * Returns -1 if the pattern is an invalid regular expression.
 */
export function countRegExpGroups(pattern) {
    if (typeof pattern !== 'string' || pattern.length > 200)
        return -1;
    try {
        const re = new RegExp(pattern + '|()');
        const m = re.exec('');
        return m ? m.length - 2 : -1;
    }
    catch {
        return -1;
    }
}
