/**
 * `bridge check <old-file> <new-file> [--compatible] [--strict] [--format …]`
 * `bridge check <new-file> --against <ref-file|name@version> […]`
 *
 * Machine-oriented compatibility gate for CI. The baseline is either the
 * first positional file or, with --against, a file or a published registry
 * reference. Gate fail sets:
 *
 *   default        BREAKING, UNKNOWN
 *   --strict       BREAKING, UNKNOWN, WARNING (full governance)
 *   --compatible   BREAKING
 */
import * as fs from 'node:fs';
import { diffPackages, formatReportMarkdown, Classification, CompatReport } from '@bridge/compat';
import { RegistryStore } from '@bridge/registry';
import { ParsedArgs, positionals } from '../args';
import { compileOrThrow } from '../compile';
import { CliError, UsageError } from '../errors';
import { out, printJson } from '../output';
import { registryDir } from '../registry-cli';
import { resolveRef } from '../refs';

/** Verdicts that fail the gate, per mode. */
type GateMode = 'strict' | 'strict+warnings' | 'compatible';

const FAIL_SETS: Readonly<Record<GateMode, readonly Classification[]>> = {
  strict: ['BREAKING', 'UNKNOWN'],
  'strict+warnings': ['BREAKING', 'UNKNOWN', 'WARNING'],
  compatible: ['BREAKING'],
};

/** Human-readable description of a failed gate, per mode. */
function failureDetail(mode: GateMode, report: CompatReport): string {
  const { breaking, unknown, warning } = report.summary;
  switch (mode) {
    case 'compatible':
      return `compatibility gate failed (compatible mode): ${breaking} breaking change(s)`;
    case 'strict+warnings':
      return (
        `compatibility gate failed (strict mode, warnings gated): ` +
        `${breaking} breaking, ${unknown} unknown, ${warning} warning change(s)`
      );
    default:
      return `compatibility gate failed (strict mode): ${breaking} breaking, ${unknown} unknown change(s)`;
  }
}

export function run(args: ParsedArgs): void {
  const pos = positionals(args, 'check', '<old-file> <new-file>  |  <new-file> --against <ref>', 1, 2);
  const jsonFlag = args.flags.has('--json');
  const compatible = args.flags.has('--compatible');
  const strict = args.flags.has('--strict');
  const against = args.values.get('--against');
  const format = args.values.get('--format');

  if (compatible && strict) {
    throw new UsageError("options '--compatible' and '--strict' are mutually exclusive");
  }
  if (pos.length === 2 && against !== undefined) {
    throw new UsageError("pass either '<old-file> <new-file>' or '<new-file> --against <ref>', not both");
  }
  if (pos.length === 1 && against === undefined) {
    throw new UsageError('a single file needs a baseline: pass --against <ref-file|name@version>');
  }
  const fmt = format ?? (jsonFlag ? 'json' : 'table');
  if (fmt !== 'table' && fmt !== 'json' && fmt !== 'markdown') {
    throw new UsageError(`unknown --format '${format}' for 'bridge check' (expected table|json|markdown)`);
  }

  // Candidate is always the last positional (the only one in --against form).
  const candidate = compileOrThrow(pos[pos.length - 1] as string);

  let baselineIr;
  let baselineLabel: string;
  if (against !== undefined) {
    const root = registryDir(args);
    const store = fs.existsSync(root) ? new RegistryStore(root) : undefined;
    const resolved = resolveRef(against, store, `pass a file path to --against instead (looked at '${root}')`);
    baselineIr = resolved.ir;
    baselineLabel = resolved.label;
  } else {
    const compiled = compileOrThrow(pos[0] as string);
    baselineIr = compiled.ir;
    baselineLabel = compiled.file;
  }

  const mode: GateMode = compatible ? 'compatible' : strict ? 'strict+warnings' : 'strict';
  const report: CompatReport = diffPackages(baselineIr, candidate.ir);
  const passed = !FAIL_SETS[mode].includes(report.verdict);

  switch (fmt) {
    case 'json':
      printJson({
        package: report.packageName,
        baseline: baselineLabel,
        mode,
        passed,
        verdict: report.verdict,
        summary: report.summary,
        changes: report.changes,
      });
      break;
    case 'markdown':
      out(formatReportMarkdown(report, passed, mode));
      break;
    default:
      out(`baseline: ${baselineLabel}`);
      out(`package: ${report.packageName}`);
      out(`mode: ${mode}`);
      out(`verdict: ${report.verdict}`);
      out(`passed: ${passed ? 'true' : 'false'}`);
      out(
        `changes: ${report.changes.length} (breaking ${report.summary.breaking}, ` +
          `unknown ${report.summary.unknown}, warning ${report.summary.warning}, safe ${report.summary.safe})`,
      );
  }

  if (!passed) {
    throw new CliError(failureDetail(mode, report));
  }
}
