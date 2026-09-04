/**
 * Rendering for impact reports: terminal-friendly text, GitHub-PR-comment
 * markdown, and deterministic JSON. All three are pure functions of the
 * report — identical inputs produce byte-identical output.
 */
import { compareChanges } from './report';
import type { AffectedConsumer, ImpactReport } from './impact-types';
import type { Change, Classification } from './types';

// ---------------------------------------------------------------------------
// Shared rendering bits
// ---------------------------------------------------------------------------

const CHANGE_SYMBOL: Readonly<Record<Classification, string>> = {
  BREAKING: '❌',
  UNKNOWN: '?',
  WARNING: '⚠',
  SAFE: '✓',
};

const BADGE: Readonly<Record<Classification, string>> = {
  BREAKING: '🔴 BREAKING',
  UNKNOWN: '🟠 UNKNOWN',
  WARNING: '🟡 WARNING',
  SAFE: '⚪ SAFE',
};

/** Render one change line the same way `formatReport` does. */
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

/** Escape pipes for GitHub markdown tables. */
function cell(text: string): string {
  return text.replace(/\|/g, '\\|');
}

/** How a consumer is reached, as a compact phrase (shared by both formatters). */
function viaPhrase(c: AffectedConsumer): string {
  switch (c.reason) {
    case 'direct-type':
      return `references ${c.viaTypes.join(', ')}`;
    case 'through':
      return `through \`${c.viaPackages[c.viaPackages.length - 2] ?? '?'}\` (${c.viaTypes.join(', ')})`;
    case 'event':
      return `direct dependent of the changed package's events`;
    case 'package-renamed':
      return 'the package was renamed';
    case 'unscannable':
      return 'IR could not be pulled — conservatively affected';
    case 'unaffected':
      return 'no changed type is referenced';
  }
}

// ---------------------------------------------------------------------------
// Terminal text
// ---------------------------------------------------------------------------

/**
 * Format an impact report as terminal-friendly text:
 *
 * ```
 * BRIDGE IMPACT REPORT
 * package: payments.v1
 * change: payments.v1@v1 → payments.v1@v2
 *
 * ❌ Breaking: Payment.currency removed
 * ✓ Added optional field: Payment.reference
 *
 * Summary: 1 safe, 0 warnings, 1 breaking, 0 unknown
 * Verdict: BREAKING
 *
 * Consumers: 3 discovered, 2 affected (breaking 1, unknown 0, warning 1, safe 1)
 *   ❌ fraud.v2@v2 — depth 1 — BREAKING — references Money (direct)
 *   ✓ reporting.v1@v1 — depth 1 — SAFE — no changed type is referenced
 *
 * Suggested actions:
 *   ❌ Payment.currency (field-removed)
 *      Deprecate the field first, migrate the listed consumers, then remove it in a future version.
 *      Consumers to migrate first: billing.v3
 * ```
 */
export function formatImpactText(report: ImpactReport): string {
  const lines: string[] = [];
  lines.push('BRIDGE IMPACT REPORT');
  lines.push(`package: ${report.packageName}`);
  lines.push(`change: ${report.from} → ${report.to}`);
  lines.push('');
  for (const change of [...report.changes].sort(compareChanges)) lines.push(renderChange(change));
  lines.push('');
  lines.push(
    `Summary: ${report.summary.safe} safe, ${report.summary.warning} warnings, ` +
      `${report.summary.breaking} breaking, ${report.summary.unknown} unknown`,
  );
  lines.push(`Verdict: ${report.verdict}`);
  lines.push('');
  const s = report.stats;
  lines.push(
    `Consumers: ${s.consumersTotal} discovered, ${s.consumersAffected} affected ` +
      `(breaking ${s.bySeverity.breaking}, unknown ${s.bySeverity.unknown}, warning ${s.bySeverity.warning}, safe ${s.bySeverity.safe})`,
  );
  if (!report.analysis.graphTraversed) {
    lines.push('  (no registry provided — consumer graph not traversed)');
  } else {
    for (const c of report.consumers) {
      lines.push(`  ${CHANGE_SYMBOL[c.severity]} ${c.packageName}@${c.version} — depth ${c.depth} — ${c.severity} — ${viaPhrase(c)}`);
    }
  }
  lines.push('');
  lines.push('Suggested actions:');
  for (const action of report.suggestedActions) {
    lines.push(`  ${CHANGE_SYMBOL[action.classification]} ${action.path} (${action.kind})`);
    lines.push(`    ${action.action}`);
    if (action.reaches.length > 0 && action.classification !== 'SAFE') {
      lines.push(`    Consumers to migrate first: ${action.reaches.join(', ')}`);
    }
  }
  if (report.analysis.notes.length > 0) {
    lines.push('');
    lines.push('Notes:');
    for (const note of report.analysis.notes) lines.push(`  - ${note}`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// GitHub markdown
// ---------------------------------------------------------------------------

/**
 * Format an impact report as GitHub-PR-comment-ready markdown with a summary
 * table, a per-change action table and an affected-consumers table. Contains
 * no timestamps or volatile data: identical reports render byte-identically.
 */
export function formatImpactMarkdown(report: ImpactReport): string {
  const s = report.stats;
  const lines: string[] = [];

  lines.push(`## Bridge impact report: \`${report.packageName}\``);
  lines.push('');
  lines.push(
    `**${cell(report.from)} → ${cell(report.to)}** · verdict **${report.verdict}** · ` +
      `${report.summary.breaking} breaking · ${report.summary.unknown} unknown · ` +
      `${report.summary.warning} warnings · ${report.summary.safe} safe`,
  );
  lines.push('');

  if (report.analysis.graphTraversed) {
    lines.push('| Consumers | Count |');
    lines.push('| --- | --- |');
    lines.push(`| Discovered | ${s.consumersTotal} |`);
    lines.push(`| Affected (non-safe) | ${s.consumersAffected} |`);
    lines.push(`| 🔴 Breaking | ${s.bySeverity.breaking} |`);
    lines.push(`| 🟠 Unknown | ${s.bySeverity.unknown} |`);
    lines.push(`| 🟡 Warning | ${s.bySeverity.warning} |`);
    lines.push(`| ⚪ Safe / unaffected | ${s.bySeverity.safe} |`);
    lines.push('');

    const affected = report.consumers.filter((c) => c.severity !== 'SAFE');
    const untouched = report.consumers.filter((c) => c.severity === 'SAFE');

    lines.push(`### Affected consumers (${affected.length})`);
    lines.push('');
    if (affected.length === 0) {
      lines.push('_No discovered consumer is touched by a non-safe change._');
    } else {
      lines.push('| Consumer | Depth | Severity | Reached via |');
      lines.push('| --- | --- | --- | --- |');
      for (const c of affected) {
        const owner = c.owner !== undefined ? ` · owner: ${cell(c.owner)}` : '';
        lines.push(
          `| \`${c.packageName}@${c.version}\`${owner} | ${c.depth} | ${BADGE[c.severity]} | ${cell(viaPhrase(c))} |`,
        );
      }
    }
    lines.push('');

    if (untouched.length > 0) {
      lines.push(`<details><summary>Unaffected consumers (${untouched.length})</summary>`);
      lines.push('');
      for (const c of untouched) {
        lines.push(`- \`${c.packageName}@${c.version}\` — ${cell(viaPhrase(c))}`);
      }
      lines.push('');
      lines.push('</details>');
      lines.push('');
    }
  } else {
    lines.push('_No registry was provided, so the consumer graph was not traversed._');
    lines.push('');
  }

  lines.push('### Changes and suggested actions');
  lines.push('');
  if (report.suggestedActions.length === 0) {
    lines.push('_No changes detected._');
  } else {
    lines.push('| Severity | Change | Suggested action |');
    lines.push('| --- | --- | --- |');
    report.suggestedActions.forEach((action, index) => {
      // suggestedActions is index-aligned with changes by construction.
      const message = cell(report.changes[index]?.message ?? action.path);
      let guidance = cell(action.action);
      if (action.reaches.length > 0 && action.classification !== 'SAFE') {
        guidance += ` Consumers to migrate first: ${action.reaches.map((r) => `\`${r}\``).join(', ')}.`;
      }
      lines.push(`| ${BADGE[action.classification]} | ${message} | ${guidance} |`);
    });
  }
  lines.push('');
  lines.push(
    '> **Coverage note** — impact is computed by static type-reference reachability over the registry ' +
      'dependency graph: a consumer counts as affected when it references a changed type (directly or through ' +
      'an intermediate contract). Field-level tracking, service callers and event subscribers are not visible ' +
      'in contract IR; event changes are attributed to direct dependents. Consumers whose IR cannot be pulled ' +
      'are conservatively counted as affected.',
  );
  if (report.analysis.notes.length > 0) {
    lines.push('');
    for (const note of report.analysis.notes) lines.push(`> ⚠ ${cell(note)}`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// JSON
// ---------------------------------------------------------------------------

/**
 * Serialize an impact report to pretty-printed JSON. Deterministic: object
 * keys appear in construction order and optional fields are omitted when
 * absent, so identical inputs produce byte-identical output.
 */
export function formatImpactJson(report: ImpactReport): string {
  return JSON.stringify(report, null, 2);
}
