/**
 * `bridge check <old-file> <new-file> [--compatible] [--json]` —
 * machine-oriented compatibility gate for CI.
 */
import { check, CompatReport } from '@bridge/compat';
import { ParsedArgs, positionals } from '../args';
import { compileOrThrow } from '../compile';
import { CliError, UsageError } from '../errors';
import { out, printJson } from '../output';

export function run(args: ParsedArgs): void {
  const pos = positionals(args, 'check', '<old-file> <new-file>', 2, 2);
  const json = args.flags.has('--json');
  const mode = args.flags.has('--compatible') ? 'compatible' : 'strict';
  const [oldFile, newFile] = pos as [string, string];

  const oldIr = compileOrThrow(oldFile).ir;
  const newIr = compileOrThrow(newFile).ir;

  const gate = check(oldIr, newIr, { mode });
  const report: CompatReport = gate.report;

  if (json) {
    printJson({
      package: report.packageName,
      mode,
      passed: gate.passed,
      verdict: report.verdict,
      summary: report.summary,
      changes: report.changes,
    });
  } else {
    out(`package: ${report.packageName}`);
    out(`mode: ${mode}`);
    out(`verdict: ${report.verdict}`);
    out(`passed: ${gate.passed ? 'true' : 'false'}`);
    out(
      `changes: ${report.changes.length} (breaking ${report.summary.breaking}, ` +
      `unknown ${report.summary.unknown}, warning ${report.summary.warning}, safe ${report.summary.safe})`,
    );
  }

  if (!gate.passed) {
    throw new CliError(
      `compatibility gate failed (${mode} mode): ${report.summary.breaking} breaking, ${report.summary.unknown} unknown change(s)`,
    );
  }
}
