/**
 * Terminal output helpers. Plain text only — no color dependencies.
 * ✓ / ✗ / ⚠ unicode markers are safe on every supported terminal.
 */

export const CHECK = '✓';
export const CROSS = '✗';
export const WARN = '⚠';

/** Write one line to stdout. */
export function out(line: string = ''): void {
  process.stdout.write(line + '\n');
}

/** Write one line to stderr. */
export function errOut(line: string = ''): void {
  process.stderr.write(line + '\n');
}

/** Pretty-print a value as JSON on stdout (machine-readable output). */
export function printJson(value: unknown): void {
  out(JSON.stringify(value, null, 2));
}
