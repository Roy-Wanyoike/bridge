/**
 * `bridge lint [files...] [--strict]` — errors fail; warnings tolerated
 * unless --strict.
 */
import { compileSource, formatDiagnostics } from '@bridge/core';
import { ParsedArgs } from '../args';
import { inputFiles, readText } from '../files';
import { CliError } from '../errors';
import { out, CHECK, WARN } from '../output';

export function run(args: ParsedArgs): void {
  const strict = args.flags.has('--strict');
  const files = inputFiles(args, 'lint');
  let errors = 0;
  let findings = 0;

  for (const file of files) {
    const text = readText(file);
    const result = compileSource(text, file);
    const errs = result.diagnostics.filter((d) => d.severity === 'error');
    const others = result.diagnostics.filter((d) => d.severity !== 'error');
    errors += errs.length;
    findings += others.length;

    if (result.diagnostics.length > 0) {
      out(formatDiagnostics(result.diagnostics, text));
    } else {
      out(`${CHECK} ${file} ok`);
    }
  }

  if (files.length > 1) {
    out(`${errors} error(s), ${findings} finding(s) across ${files.length} file(s)`);
  } else if (errors === 0 && findings > 0) {
    out(`${findings} finding(s)`);
  }

  if (errors > 0) {
    throw new CliError(`lint failed: ${errors} error(s)`);
  }
  if (strict && findings > 0) {
    throw new CliError(`lint failed (--strict): ${findings} finding(s) treated as errors`);
  }
  if (findings > 0 && !strict) {
    // tolerated — note it on stderr so CI logs show why exit is still 0
    out(`${WARN} ${findings} finding(s) tolerated (lint passes; use --strict to fail on warnings)`);
  }
}
