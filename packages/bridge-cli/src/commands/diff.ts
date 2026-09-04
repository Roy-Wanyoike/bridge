/**
 * `bridge diff <old-file> <new-file> [--compatible]` — human-readable
 * compatibility report between two contract versions.
 */
import { check, diffPackages, formatReport } from '@bridge/compat';
import { ParsedArgs, positionals } from '../args';
import { compileOrThrow } from '../compile';
import { CliError, UsageError } from '../errors';
import { out } from '../output';

export function run(args: ParsedArgs): void {
  const pos = positionals(args, 'diff', '<old-file> <new-file>', 2, 2);
  const mode = args.flags.has('--compatible') ? 'compatible' : 'strict';
  const [oldFile, newFile] = pos as [string, string];

  const oldIr = compileOrThrow(oldFile).ir;
  const newIr = compileOrThrow(newFile).ir;

  const report = diffPackages(oldIr, newIr, { mode });
  const gate = check(oldIr, newIr, { mode });

  out(formatReport(report));
  if (mode === 'compatible') {
    out(`mode: compatible — only definite breaking changes gate this mode`);
  }

  if (!gate.passed) {
    throw new CliError(`compatibility check FAILED (${mode} mode): ${report.summary.breaking} breaking, ${report.summary.unknown} unknown change(s)`);
  }
}
