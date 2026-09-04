/**
 * `bridge validate [files...]` — compile contracts and report diagnostics.
 */
import * as fs from 'node:fs';
import { compileSource, formatDiagnostics, shortHash } from '@bridge/core';
import { ParsedArgs } from '../args';
import { inputFiles } from '../files';
import { CliError } from '../errors';
import { out, CHECK, printJson } from '../output';

interface ValidateResultJson {
  file: string;
  ok: boolean;
  package?: string;
  hash?: string;
  diagnostics: unknown[];
}

export function run(args: ParsedArgs): void {
  const json = args.flags.has('--json');
  const files = inputFiles(args, 'validate');
  const results: ValidateResultJson[] = [];
  let failures = 0;

  for (const file of files) {
    let text: string;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (e) {
      throw new CliError(readFailure(file, e));
    }
    const result = compileSource(text, file);
    if (result.ok && result.ir) {
      const hash = shortHash(result.ir);
      results.push({
        file,
        ok: true,
        package: result.ir.name,
        hash,
        diagnostics: result.diagnostics,
      });
      if (!json) out(`${CHECK} ${file} ok (package ${result.ir.name}, hash ${hash})`);
    } else {
      failures++;
      results.push({ file, ok: false, diagnostics: result.diagnostics });
      if (!json) out(formatDiagnostics(result.diagnostics, text));
    }
  }

  if (json) {
    printJson(results);
  } else if (files.length > 1) {
    out(`${files.length - failures}/${files.length} file(s) valid`);
  }

  if (failures > 0) {
    throw new CliError(`${failures} of ${files.length} file(s) failed validation`);
  }
}

function readFailure(file: string, e: unknown): string {
  const code = (e as NodeJS.ErrnoException | null)?.code;
  if (code === 'ENOENT') return `file not found: ${file}`;
  if (code === 'EISDIR') return `${file} is a directory, not a file`;
  return `cannot read ${file}: ${e instanceof Error ? e.message : String(e)}`;
}
