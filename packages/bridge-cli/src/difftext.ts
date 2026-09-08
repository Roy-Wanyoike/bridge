/**
 * Minimal unified-diff renderer (LCS line diff). Used by `bridge fmt` to
 * show what would change; deliberately dependency-free and simple.
 */

interface LineOp {
  readonly type: 'same' | 'del' | 'add';
  readonly text: string;
}

/** Maximum cells in the LCS table before falling back to a whole-file diff. */
const MAX_TABLE_CELLS = 4_000_000;

function diffOps(a: readonly string[], b: readonly string[]): LineOp[] {
  const n = a.length;
  const m = b.length;
  if (n * m > MAX_TABLE_CELLS) {
    return [
      ...a.map((text) => ({ type: 'del' as const, text })),
      ...b.map((text) => ({ type: 'add' as const, text })),
    ];
  }

  // table[i][j] = LCS length of a[i..] vs b[j..]
  const table: Uint32Array[] = [];
  for (let i = 0; i <= n; i++) table.push(new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i]![j] = a[i] === b[j]
        ? table[i + 1]![j + 1]! + 1
        : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    }
  }

  const ops: LineOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ type: 'same', text: a[i] as string });
      i++;
      j++;
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) {
      ops.push({ type: 'del', text: a[i] as string });
      i++;
    } else {
      ops.push({ type: 'add', text: b[j] as string });
      j++;
    }
  }
  while (i < n) {
    ops.push({ type: 'del', text: a[i] as string });
    i++;
  }
  while (j < m) {
    ops.push({ type: 'add', text: b[j] as string });
    j++;
  }
  return ops;
}

/** Drop one trailing newline so split() does not yield a phantom empty line. */
function splitLines(text: string): string[] {
  const stripped = text.endsWith('\n') ? text.slice(0, -1) : text;
  return stripped.length === 0 ? [] : stripped.split('\n');
}

/**
 * Render a unified diff (`---`/`+++` headers plus `@@` hunks) between two
 * source texts. Returns one array element per output line.
 *
 * Hunk headers follow git's conventions (verified byte-for-byte against
 * `git diff --no-index`):
 *   - `@@ -aStart,aCount +bStart,bCount @@`, with the count omitted when it
 *     is exactly 1 (`@@ -1 +1 @@`);
 *   - a pure-insertion hunk (no a-side lines) reports the a-side position
 *     *before* the insertion — `-0,0` when it is at the very start of the
 *     file; a pure-deletion hunk reports the b-side position after the last
 *     deleted line (`+0,0` when the whole file is deleted);
 *   - two changes separated by up to `2 * context` unchanged lines are
 *     merged into one hunk (git's rule with the default inter-hunk context
 *     of 0);
 *   - the optional trailing funcname annotation git appends after the
 *     closing `@@` is deliberately not emitted (no language heuristics).
 */
export function unifiedDiff(oldText: string, newText: string, label: string, context = 3): string[] {
  const a = splitLines(oldText);
  const b = splitLines(newText);
  const ops = diffOps(a, b);
  if (ops.every((op) => op.type === 'same')) return [];

  // 1-based line numbers per op index: aLine[k] is the old-file line that
  // ops[k] consumes on the a-side (bLine for the b-side). The extra final
  // entry is the line *after* the last op, so counts are index differences.
  const aLine = new Uint32Array(ops.length + 1);
  const bLine = new Uint32Array(ops.length + 1);
  let aNext = 1;
  let bNext = 1;
  for (let k = 0; k < ops.length; k++) {
    aLine[k] = aNext;
    bLine[k] = bNext;
    const op = ops[k]!;
    if (op.type === 'same') {
      aNext++;
      bNext++;
    } else if (op.type === 'del') {
      aNext++;
    } else {
      bNext++;
    }
  }
  aLine[ops.length] = aNext;
  bLine[ops.length] = bNext;

  // Indices of changed ops, grouped into hunks. Consecutive changes merge
  // while ≤ 2*context unchanged lines separate them.
  const changes: number[] = [];
  for (let k = 0; k < ops.length; k++) {
    if (ops[k]!.type !== 'same') changes.push(k);
  }

  const lines: string[] = [`--- a/${label}`, `+++ b/${label}`];
  let g = 0;
  while (g < changes.length) {
    let last = changes[g]!;
    let next = g + 1;
    while (next < changes.length && changes[next]! - (changes[next - 1]! + 1) <= 2 * context) {
      last = changes[next]!;
      next++;
    }

    // Hunk range: up to `context` unchanged lines before the first change
    // and after the last one, clamped to the file edges.
    const start = Math.max(0, changes[g]! - context);
    let end = last + 1;
    for (let trail = 0; end < ops.length && trail < context && ops[end]!.type === 'same'; trail++) {
      end++;
    }

    const aCount = aLine[end]! - aLine[start]!;
    const bCount = bLine[end]! - bLine[start]!;
    let aHeader = aLine[start]!;
    let bHeader = bLine[start]!;
    // Pure-insertion / pure-deletion hunks report the position *before* the
    // change (0 when it is at the very start of the file).
    if (aCount === 0) aHeader--;
    if (bCount === 0) bHeader--;

    lines.push(`@@ -${range(aHeader, aCount)} +${range(bHeader, bCount)} @@`);
    for (let k = start; k < end; k++) {
      const op = ops[k]!;
      lines.push(op.type === 'same' ? ' ' + op.text : op.type === 'del' ? '-' + op.text : '+' + op.text);
    }
    g = next;
  }

  return lines;
}

/** One side of a hunk header: git omits the count when it is exactly 1. */
function range(header: number, count: number): string {
  return count === 1 ? String(header) : `${header},${count}`;
}
