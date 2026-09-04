/**
 * `bridge impact <contract> --to <name@version|file> [--registry dir]
 *        [--format table|json|markdown] [--strict]` — consumer-aware
 * impact analysis: diff the contract against its baseline and walk the
 * registry's transitive dependent graph to report who feels the change.
 */
import * as fs from 'node:fs';
import {
  computeImpact,
  formatImpactJson,
  formatImpactMarkdown,
  formatImpactText,
  ImpactReport,
} from '@bridge/compat';
import { RegistryStore } from '@bridge/registry';
import { ParsedArgs, positionals } from '../args';
import { CliError, UsageError } from '../errors';
import { out } from '../output';
import { registryDir } from '../registry-cli';
import { resolveRef } from '../refs';

const FORMATS: ReadonlySet<string> = new Set(['table', 'json', 'markdown']);

export function run(args: ParsedArgs): void {
  const pos = positionals(args, 'impact', '<contract> --to <name@version|file>', 1, 1);
  const to = args.values.get('--to');
  if (to === undefined) {
    throw new UsageError("required option '--to <name@version|file>' is missing");
  }
  const format = args.values.get('--format') ?? 'table';
  if (!FORMATS.has(format)) {
    throw new UsageError(`unknown --format '${format}' for 'bridge impact' (expected table|json|markdown)`);
  }
  const strict = args.flags.has('--strict');

  const root = registryDir(args);
  // A missing registry directory degrades gracefully: the diff is still
  // computed and the report says the consumer graph was not traversed.
  const store = fs.existsSync(root) ? new RegistryStore(root) : undefined;
  const noRegistryHint = `run 'bridge publish' first or pass --registry <dir> (looked at '${root}')`;

  const baseline = resolveRef(pos[0] as string, store, noRegistryHint);
  const candidate = resolveRef(to, store, noRegistryHint);

  const report: ImpactReport = computeImpact({
    oldIR: baseline.ir,
    newIR: candidate.ir,
    registry: store,
    labels: { from: baseline.label, to: candidate.label },
  });

  switch (format) {
    case 'json':
      out(formatImpactJson(report));
      break;
    case 'markdown':
      out(formatImpactMarkdown(report));
      break;
    default:
      out(formatImpactText(report));
  }

  if (strict && report.stats.breaking > 0) {
    throw new CliError(
      `impact gate failed (strict): ${report.stats.breaking} breaking change(s) reach ` +
        `${report.stats.consumersBreakingAffected} consumer contract(s)`,
    );
  }
}
