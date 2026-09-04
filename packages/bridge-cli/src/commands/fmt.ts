/**
 * `bridge fmt [-w] [files...]` — canonical source formatter.
 */
import * as fs from 'node:fs';
import { formatSource, formatDiagnostics } from '@bridge/core';
import { ParsedArgs } from '../args';
import { inputFiles, readText } from '../files';
import { CliError } from '../errors';
import { out, CHECK } from '../output';
import { unifiedDiff } from '../difftext';

export function run(args: ParsedArgs): void {
  const writeInPlace = args.flags.has('-w');
  const files = inputFiles(args, 'fmt');
  let unformatted = 0;
  let failures = 0;

  for (const file of files) {
    const text = readText(file);
    const result = formatSource(text, file);
    if (!result.ok) {
      failures++;
      out(formatDiagnostics(result.diagnostics, text));
      continue;
    }
    const formatted = result.output as string; // ok === true guarantees output

    if (formatted === text) {
      out(`${CHECK} ${file} already formatted`);
      continue;
    }

    if (writeInPlace) {
      try {
        fs.writeFileSync(file, formatted, 'utf8');
      } catch (e) {
        failures++;
        out(`cannot write ${file}: ${e instanceof Error ? e.message : String(e)}`);
        continue;
      }
      out(`${CHECK} formatted ${file}`);
    } else {
      unformatted++;
      for (const line of unifiedDiff(text, formatted, file)) out(line);
    }
  }

  if (failures > 0) {
    throw new CliError(`${failures} of ${files.length} file(s) could not be formatted`);
  }
  if (!writeInPlace && unformatted > 0) {
    throw new CliError(
      `${unformatted} of ${files.length} file(s) need formatting — run 'bridge fmt -w' to fix in place`,
    );
  }
}
