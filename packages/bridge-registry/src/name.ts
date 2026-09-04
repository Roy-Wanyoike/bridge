import { RegistryError } from './errors';

/**
 * Package-name charset: dotted lowercase identifiers.
 *
 * The name must start with a lowercase letter; the remainder may contain
 * lowercase letters, digits, `.`, `_` and `-`. This single rule rejects —
 * outright and by construction — path separators (`/`, `\`), `~`, whitespace,
 * uppercase letters, and leading dots/digits/dashes.
 */
const PACKAGE_NAME_RE = /^[a-z][a-z0-9_.-]*$/;

/** Upper bound on package-name length (defensive; keeps paths manageable). */
export const MAX_PACKAGE_NAME_LENGTH = 200;

/**
 * Structural check for a valid Bridge package name.
 *
 * A valid name:
 * - is a non-empty string of at most {@link MAX_PACKAGE_NAME_LENGTH} chars,
 * - matches `/^[a-z][a-z0-9_.-]*$/` (so `/`, `\`, `~`, uppercase and leading
 *   dots are impossible),
 * - contains no `..` segment and no trailing `.` or `-`.
 */
export function isValidPackageName(name: unknown): name is string {
  if (typeof name !== 'string' || name.length === 0 || name.length > MAX_PACKAGE_NAME_LENGTH) {
    return false;
  }
  if (!PACKAGE_NAME_RE.test(name)) return false;
  if (name.includes('..')) return false;
  if (name.endsWith('.') || name.endsWith('-')) return false;
  return true;
}

/**
 * Validate a package name or throw {@link RegistryError} with code
 * `'invalid-name'`. Returns the name unchanged on success.
 *
 * Every package name that reaches a filesystem path — whether from a caller
 * or read back from stored data — must pass through here first.
 */
export function assertValidPackageName(name: unknown): string {
  if (!isValidPackageName(name)) {
    throw new RegistryError(
      'invalid-name',
      `Invalid package name ${JSON.stringify(name)}: expected dotted lowercase identifiers ` +
        `(e.g. 'payments.v1'); path separators, '..', '~', uppercase letters, leading dots, ` +
        `trailing '.'/'-' and empty names are rejected.`,
    );
  }
  return name;
}
