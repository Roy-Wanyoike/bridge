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
 */
export function unifiedDiff(oldText: string, newText: string, label: string, context = 3): string[] {
  const a = splitLines(oldText);
  const b = splitLines(newText);
  const ops = diffOps(a, b);
  if (ops.every((op) => op.type === 'same')) return [];

  const lines: string[] = [`--- a/${label}`, `+++ b/${label}`];
  let aLine = 0;
  let bLine = 0;
  let idx = 0;

  while (idx < ops.length) {
    if (ops[idx]!.type === 'same') {
      aLine++;
      bLine++;
      idx++;
      continue;
    }

    // Hunk start: include up to `context` preceding unchanged lines.
    let start = idx;
    let lead = 0;
    while (start > 0 && ops[start - 1]!.type === 'same' && lead < context) {
      start--;
      lead++;
    }

    // Hunk end: extend through changes, stopping after `context` trailing
    // unchanged lines (or at end of input).
    let end = idx;
    let sameRun = 0;
    for (let k = idx; k < ops.length; k++) {
      end = k + 1;
      if (ops[k]!.type === 'same') {
        sameRun++;
        if (sameRun > context) {
          end = k;
          break;
        }
      } else {
        sameRun = 0;
      }
    }

    // Header line numbers from the running counters.
    let aHeader = aLine + 1;
    let bHeader = bLine + 1;
    for (let k = 0; k < start; k++) {
      const op = ops[k]!;
      if (op.type === 'same') {
        aHeader++;
        bHeader++;
      } else if (op.type === 'del') {
        aHeader++;
      } else {
        bHeader++;
      }
    }

    let aCount = 0;
    let bCount = 0;
    const body: string[] = [];
    for (let k = start; k < end; k++) {
      const op = ops[k]!;
      if (op.type === 'same') {
        aCount++;
        bCount++;
        body.push(' ' + op.text);
      } else if (op.type === 'del') {
        aCount++;
        body.push('-' + op.text);
      } else {
        bCount++;
        body.push('+' + op.text);
      }
    }
    // Pure-insertion hunks report the position *before* the insertion.
    if (aCount === 0) aHeader = Math.max(1, aHeader - 1);
    if (bCount === 0) bHeader = Math.max(1, bHeader - 1);

    lines.push(`@@ -${aHeader},${aCount} +${bHeader},${bCount} @@`);
    for (const bodyLine of body) lines.push(bodyLine);

    // Advance the running counters past everything consumed.
    for (let k = 0; k < end; k++) {
      const op = ops[k]!;
      if (op.type === 'same') {
        aLine++;
        bLine++;
      } else if (op.type === 'del') {
        aLine++;
      } else {
        bLine++;
      }
    }
    idx = end;
  }

  return lines;
}
