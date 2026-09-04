/**
 * GitHub-PR-comment markdown rendering for plain compatibility reports
 * (shared by `bridge check --format markdown`). Deterministic: identical
 * reports render byte-identically.
 */
import type { Classification, CompatReport } from './types';
import { compareChanges } from './report';

const BADGE: Readonly<Record<Classification, string>> = {
  BREAKING: '🔴 BREAKING',
  UNKNOWN: '🟠 UNKNOWN',
  WARNING: '🟡 WARNING',
  SAFE: '✅ SAFE',
};

/** Escape pipes for GitHub markdown tables. */
function cell(text: string): string {
  return text.replace(/\|/g, '\\|');
}

/**
 * Render a compatibility report as PR-comment markdown: a verdict header, a
 * summary table and a changes table.
 *
 * @param report  the compatibility report to render
 * @param passed  the gate decision computed by the caller (see `check`)
 * @param mode    label of the gate mode, surfaced in the footer
 */
export function formatReportMarkdown(report: CompatReport, passed: boolean, mode = 'strict'): string {
  const lines: string[] = [];
  lines.push(`### Compatibility: \`${report.packageName}\` — ${passed ? '✅ PASSED' : '❌ FAILED'}`);
  lines.push('');
  lines.push(
    `Verdict **${report.verdict}** · ${report.summary.breaking} breaking · ` +
      `${report.summary.unknown} unknown · ${report.summary.warning} warnings · ${report.summary.safe} safe`,
  );
  lines.push('');
  lines.push('| Severity | Change |');
  lines.push('| --- | --- |');
  for (const c of [...report.changes].sort(compareChanges)) {
    lines.push(`| ${BADGE[c.classification]} | ${cell(c.message)} |`);
  }
  if (report.changes.length === 0) {
    lines.push(`| ${BADGE.SAFE} | _No detectable changes._ |`);
  }
  lines.push('');
  lines.push(`_Gate: ${cell(mode)} mode._`);
  return lines.join('\n');
}
