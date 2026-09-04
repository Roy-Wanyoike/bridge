import { RegistryError } from './errors';

/** Result of splitting a dotted package name into storage coordinates. */
export interface PackageNameParts {
  /**
   * Package base (everything but the version segment), e.g. `'payments'` for
   * `'payments.v1'` or `'identity.internal'` for `'identity.internal.v2'`.
   */
  base: string;
  /**
   * Normalized version when the final segment is version-shaped
   * (`/^v\d+$/` or `/^\d+$/`), otherwise `''` — in which case a version must
   * be supplied explicitly (see `RegistryStore.publish`).
   */
  version: string;
}

/** Accepts an optionally-`v`-prefixed decimal version: `'v1'`, `'2'`, `'V10'`. */
const VERSION_INPUT_RE = /^v?(\d+)$/i;

/**
 * A version segment inside a dotted package name. Case-sensitive by design:
 * package names are lowercase, so `'payments.V2'` is not a valid name to
 * begin with (the name validator rejects it).
 */
const VERSION_SEGMENT_RE = /^(?:v\d+|\d+)$/;

/** Collapses leading zeros while keeping at least one digit (`007` → `7`). */
const LEADING_ZEROS_RE = /^0+(?=\d)/;

/**
 * Normalize a version to its canonical `v<digits>` form.
 *
 * `'1'` → `'v1'`, `'V2'` → `'v2'`, `'v10'` → `'v10'`. Leading zeros collapse
 * (`'v007'` → `'v7'`) so the same version cannot be spelled two ways.
 * Anything else — empty strings, `'v'`, `'v1.2'`, `'v1a'`, negatives,
 * whitespace — throws {@link RegistryError} with code `'invalid-version'`.
 */
export function normalizeVersion(v: string): string {
  const invalid = (): RegistryError =>
    new RegistryError(
      'invalid-version',
      `Invalid version ${JSON.stringify(v)}: expected digits with an optional leading 'v' ` +
        `(e.g. 'v1', '2'); got junk.`,
    );
  if (typeof v !== 'string' || v.length === 0) throw invalid();
  const digits = VERSION_INPUT_RE.exec(v)?.[1];
  if (digits === undefined) throw invalid();
  return `v${digits.replace(LEADING_ZEROS_RE, '')}`;
}

/**
 * Numeric-aware version comparison: `v2 < v10` (not lexicographic).
 *
 * Both inputs are normalized first, so `'2'` and `'V2'` are accepted.
 * Returns a negative number if `a` sorts before `b`, positive if after,
 * `0` if equal. Junk versions throw `'invalid-version'`.
 */
export function compareVersions(a: string, b: string): number {
  const na = normalizeVersion(a);
  const nb = normalizeVersion(b);
  // parseInt is exact well below 2^53; for absurd digit counts the
  // lexicographic fallback below still yields a stable total order.
  const an = Number.parseInt(na.slice(1), 10);
  const bn = Number.parseInt(nb.slice(1), 10);
  if (an !== bn) return an < bn ? -1 : 1;
  // Lexicographic fallback (defensive: equal numerics normalize equal today).
  return na < nb ? -1 : na > nb ? 1 : 0;
}

/**
 * Split a dotted package name into `{ base, version }`.
 *
 * The final segment is treated as the version when it matches `/^v\d+$/` or
 * `/^\d+$/` (and there is at least one segment before it):
 * - `'payments.v1'`          → `{ base: 'payments', version: 'v1' }`
 * - `'identity.internal.v2'` → `{ base: 'identity.internal', version: 'v2' }`
 * - `'payments.3'`           → `{ base: 'payments', version: 'v3' }`
 * - `'payments'`             → `{ base: 'payments', version: '' }`
 * - `'payments.beta'`        → `{ base: 'payments.beta', version: '' }`
 * - `'v1'`                   → `{ base: 'v1', version: '' }` (single segment:
 *   nothing precedes it, so it cannot be a version suffix)
 *
 * Empty/non-string input throws `'invalid-name'`. The result is otherwise
 * returned as-is — call {@link isValidPackageName} for full validation.
 */
export function splitPackageVersion(packageName: string): PackageNameParts {
  if (typeof packageName !== 'string' || packageName.length === 0) {
    throw new RegistryError('invalid-name', 'Package name must be a non-empty string.');
  }
  const dot = packageName.lastIndexOf('.');
  if (dot > 0) {
    const last = packageName.slice(dot + 1);
    if (VERSION_SEGMENT_RE.test(last)) {
      return { base: packageName.slice(0, dot), version: normalizeVersion(last) };
    }
  }
  return { base: packageName, version: '' };
}
