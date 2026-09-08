/** Presentation helpers: dates, hashes, labels. */

const DATE_OPTS: Intl.DateTimeFormatOptions = {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
};

const TIME_OPTS: Intl.DateTimeFormatOptions = {
  hour: '2-digit',
  minute: '2-digit',
  timeZone: 'UTC',
};

/** `2026-08-21T11:42:30Z` -> `Aug 21, 2026` (UTC, deterministic). */
export function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat('en-US', DATE_OPTS).format(d);
}

/** `2026-08-21T11:42:30Z` -> `Aug 21, 2026, 11:42 UTC` (UTC, deterministic). */
export function formatDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${new Intl.DateTimeFormat('en-US', DATE_OPTS).format(d)}, ${new Intl.DateTimeFormat(
    'en-US',
    TIME_OPTS,
  ).format(d)} UTC`;
}

/** `35b333676c86...` — first 12 chars, ellipsis-free display form. */
export function shortHash(hash: string, len = 12): string {
  return hash.slice(0, len);
}

/** Language display labels. */
export const LANGUAGE_LABELS: Record<string, string> = {
  typescript: 'TypeScript',
  go: 'Go',
  rust: 'Rust',
  python: 'Python',
};

/** Human label for a change kind: `field-removed` -> `Field removed`. */
export function kindLabel(kind: string): string {
  return kind
    .split('-')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/** One-line suggested follow-up per change kind (mirrors impact guidance). */
export function suggestedAction(kind: string): string {
  switch (kind) {
    case 'field-removed':
    case 'enum-value-removed':
    case 'union-variant-removed':
    case 'type-removed':
    case 'method-removed':
    case 'event-removed':
      return 'Re-add with the original shape, or ship under a new major version and migrate consumers first.';
    case 'field-renamed':
      return 'Keep the old name as a deprecated alias for one release cycle.';
    case 'field-type-changed':
      return 'Prefer a new field alongside the old one; migrate writers, then retire the original.';
    case 'field-optional-changed':
    case 'field-default-changed':
    case 'field-constraint-changed':
      return 'Restore the previous optionality/default/constraint; tighten only in a major version.';
    case 'method-signature-changed':
      return 'Add an overload-style method instead of mutating the existing signature.';
    case 'enum-value-added':
    case 'union-variant-added':
      return 'Ensure consumer switches handle unknown values or use a default arm before upgrading.';
    case 'field-deprecated':
      return 'Announce the removal window and stop writing the field in new payloads.';
    case 'event-field-changed':
      return 'Verify subscribers tolerate the new event shape; consider a new event version.';
    case 'package-renamed':
      return 'Publish under the old name for one cycle pointing at the new package.';
    case 'import-removed':
      return 'Confirm no consumer relied on transitive visibility of the removed import.';
    default:
      return 'Review the change with consumers before merging.';
  }
}
