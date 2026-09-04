/**
 * Report assembly and rendering for the Bridge compatibility engine:
 * canonical change ordering, verdict aggregation, human-readable text
 * format and deterministic JSON serialization.
 */
import type { Change, Classification, CompatReport } from './types';
import { cmp } from './equal';

/** Severity rank: lower sorts first (BREAKING first, SAFE last). */
const SEVERITY: Readonly<Record<Classification, number>> = {
  BREAKING: 0,
  UNKNOWN: 1,
  WARNING: 2,
  SAFE: 3,
};

/**
 * Canonical total order for changes: BREAKING first, then UNKNOWN, WARNING,
 * SAFE; within a group ordered by path, then kind, then message. Applied to
 * `report.changes` so reports are byte-identical regardless of input array
 * order.
 */
export function compareChanges(a: Change, b: Change): number {
  const bySeverity = SEVERITY[a.classification] - SEVERITY[b.classification];
  if (bySeverity !== 0) return bySeverity;
  const byPath = cmp(a.path, b.path);
  if (byPath !== 0) return byPath;
  const byKind = cmp(a.kind, b.kind);
  if (byKind !== 0) return byKind;
  return cmp(a.message, b.message);
}

/**
 * Aggregate the worst classification across changes:
 * BREAKING > UNKNOWN > WARNING > SAFE. An empty change list is SAFE.
 */
export function verdictOf(changes: readonly Change[]): Classification {
  if (changes.some((c) => c.classification === 'BREAKING')) return 'BREAKING';
  if (changes.some((c) => c.classification === 'UNKNOWN')) return 'UNKNOWN';
  if (changes.some((c) => c.classification === 'WARNING')) return 'WARNING';
  return 'SAFE';
}

/** Count changes per classification. */
export function summarize(changes: readonly Change[]): CompatReport['summary'] {
  const summary = { safe: 0, warning: 0, breaking: 0, unknown: 0 };
  for (const c of changes) {
    switch (c.classification) {
      case 'SAFE':
        summary.safe += 1;
        break;
      case 'WARNING':
        summary.warning += 1;
        break;
      case 'BREAKING':
        summary.breaking += 1;
        break;
      case 'UNKNOWN':
        summary.unknown += 1;
        break;
    }
  }
  return summary;
}

/**
 * Whether a verdict passes the default ('strict') compatibility gate used
 * by `formatReport`: breaking and unknown changes fail; warnings and safe
 * diffs pass. See `DiffOptions.mode` for the full truth table.
 */
export function passesStrict(verdict: Classification): boolean {
  return verdict === 'SAFE' || verdict === 'WARNING';
}

/**
 * Render one change line. Symbols: `❌` (BREAKING, with a `Breaking:` lead),
 * `⚠` (WARNING), `✓` (SAFE), `?` (UNKNOWN).
 */
function renderChange(c: Change): string {
  switch (c.classification) {
    case 'BREAKING':
      return `❌ Breaking: ${c.message}`;
    case 'WARNING':
      return `⚠ ${c.message}`;
    case 'SAFE':
      return `✓ ${c.message}`;
    case 'UNKNOWN':
      return `? ${c.message}`;
  }
}

/**
 * Format a report as terminal-friendly text:
 *
 * ```
 * BRIDGE COMPATIBILITY REPORT
 * package: payments.v1
 *
 * ✓ Added optional field: Payment.reference
 * ⚠ Constraint changed: Money.amount (min 0 → min 1)
 * ❌ Breaking: Payment.currency removed
 *
 * Summary: 1 safe, 1 warnings, 1 breaking, 0 unknown
 * Verdict: BREAKING
 * Compatibility: FAILED
 * ```
 *
 * Lines are sorted BREAKING → UNKNOWN → WARNING → SAFE (path ascending
 * within a group). The `Compatibility` line reflects the default strict
 * gate: `FAILED` for BREAKING and UNKNOWN verdicts, `PASSED` otherwise.
 * The report contains no hashes — the IR carries none — so no old/new hash
 * lines are emitted.
 */
export function formatReport(report: CompatReport): string {
  const sorted = [...report.changes].sort(compareChanges);
  const lines: string[] = [];
  lines.push('BRIDGE COMPATIBILITY REPORT');
  lines.push(`package: ${report.packageName}`);
  lines.push('');
  for (const change of sorted) lines.push(renderChange(change));
  lines.push('');
  lines.push(
    `Summary: ${report.summary.safe} safe, ${report.summary.warning} warnings, ` +
      `${report.summary.breaking} breaking, ${report.summary.unknown} unknown`,
  );
  lines.push(`Verdict: ${report.verdict}`);
  lines.push(`Compatibility: ${passesStrict(report.verdict) ? 'PASSED' : 'FAILED'}`);
  return lines.join('\n');
}

/**
 * Serialize a report to pretty-printed JSON. Deterministic: object keys
 * appear in construction order (`packageName`, `changes`, `verdict`,
 * `summary`; per change: `path`, `kind`, `classification`, `message`,
 * `old?`, `new?`) and absent `old`/`new` values are omitted entirely.
 */
export function toJson(report: CompatReport): string {
  return JSON.stringify(report, null, 2);
}
