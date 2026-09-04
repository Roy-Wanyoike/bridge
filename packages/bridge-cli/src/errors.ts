/**
 * CLI error taxonomy.
 *
 * - `CliError` (exit 1) — runtime failures: compile errors, failed checks,
 *   missing files, registry failures. Never a stack trace.
 * - `UsageError` (exit 2) — the user invoked the CLI incorrectly.
 */
export class CliError extends Error {
  /** Process exit code to use when this error reaches the top level. */
  readonly exitCode: 1 | 2;

  constructor(message: string, exitCode: 1 | 2 = 1) {
    super(message);
    this.name = 'CliError';
    this.exitCode = exitCode;
  }
}

/** The command line itself is wrong: unknown flag, missing argument, … */
export class UsageError extends CliError {
  constructor(message: string) {
    super(message, 2);
    this.name = 'UsageError';
  }
}

/** Best-effort message for arbitrary thrown values. */
export function describeError(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}
