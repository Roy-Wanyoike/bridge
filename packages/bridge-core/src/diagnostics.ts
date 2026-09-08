/**
 * Human-readable diagnostic rendering.
 *
 * Produces the canonical `bridge check` output shape:
 * ```
 * payments.bridge:18:13: error BR2001: Unknown type `money`.
 *
 *   18 |     amount: money
 *      |             ^
 *
 *   Did you mean `Money`?
 * ```
 * The caret points at the diagnostic's column on the echoed source line.
 * Rendering never throws: when `sourceText` is missing, or the line is out
 * of range (e.g. EOF diagnostics), the snippet is simply omitted.
 */

import type { Diagnostic } from './ir/types';

/** Render one diagnostic as a multi-line string. */
export function formatDiagnostic(diagnostic: Diagnostic, sourceText?: string): string {
  const sourceLines = sourceText === undefined ? undefined : sourceText.split('\n');
  return renderDiagnostic(diagnostic, sourceLines);
}

/**
 * Render the header + snippet + hint block. `sourceLines` is the source
 * pre-split into lines (or `undefined` when no source is available) so that
 * rendering N diagnostics costs one split, not N.
 */
function renderDiagnostic(
  diagnostic: Diagnostic,
  sourceLines: readonly string[] | undefined,
): string {
  const { file, line, column, severity, code, message } = diagnostic;
  const lines: string[] = [`${file}:${line}:${column}: ${severity} ${code}: ${message}`];

  const snippet = renderSnippet(diagnostic, sourceLines);
  if (snippet.length > 0) {
    lines.push('');
    lines.push(...snippet);
  }

  if (diagnostic.hint !== undefined) {
    lines.push('');
    lines.push(`  ${diagnostic.hint}`);
  }

  return lines.join('\n');
}

/**
 * Render the `NNN | source` / `    | ^^^^` snippet pair. Returns an empty
 * array when no source lines are available or the line is out of range.
 */
function renderSnippet(diagnostic: Diagnostic, sourceLines: readonly string[] | undefined): string[] {
  if (sourceLines === undefined) return [];
  const index = diagnostic.line - 1;
  const raw = sourceLines[index];
  if (raw === undefined) return [];

  // Expand tabs so the caret lines up in the rendered output.
  const expanded = raw.replace(/\t/g, '    ');
  const lineLabel = String(diagnostic.line);
  const gutterPad = ' '.repeat(lineLabel.length);

  // Column is 1-based; count tabs occurring before the caret column in the
  // raw line so the caret matches the expanded rendering.
  const caretOffset = Math.max(0, diagnostic.column - 1);
  let tabsBefore = 0;
  for (let i = 0; i < Math.min(caretOffset, raw.length); i++) {
    if (raw.charAt(i) === '\t') tabsBefore++;
  }
  const caretColumn = caretOffset + tabsBefore * 3;

  return [
    `  ${lineLabel} | ${expanded}`,
    `  ${gutterPad} | ${' '.repeat(caretColumn)}^`,
  ];
}

/**
 * Render many diagnostics, separated by a blank line. Convenience for CLI
 * output; individual rendering is {@link formatDiagnostic}.
 *
 * The source is split into lines exactly once and shared across every
 * diagnostic: O(lines) work total instead of O(diagnostics × lines).
 */
export function formatDiagnostics(diagnostics: readonly Diagnostic[], sourceText?: string): string {
  const sourceLines = sourceText === undefined ? undefined : sourceText.split('\n');
  return diagnostics.map((d) => renderDiagnostic(d, sourceLines)).join('\n\n');
}
