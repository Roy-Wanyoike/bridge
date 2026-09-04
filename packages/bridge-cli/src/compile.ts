/**
 * Compile helpers shared by validate/lint/generate/diff/check/publish.
 */
import { compileSource, formatDiagnostics, IRPackage } from '@bridge/core';
import { CliError } from './errors';
import { readText } from './files';

export interface Compiled {
  readonly file: string;
  readonly text: string;
  readonly ir: IRPackage;
}

/**
 * Read + compile one file. Compile errors are rendered with source context
 * and thrown as a {@link CliError} (exit 1) — never a stack trace.
 */
export function compileOrThrow(file: string): Compiled {
  const text = readText(file);
  const result = compileSource(text, file);
  if (!result.ok || !result.ir) {
    throw new CliError(`${file} does not compile:\n\n${formatDiagnostics(result.diagnostics, text)}`);
  }
  return { file, text, ir: result.ir };
}
