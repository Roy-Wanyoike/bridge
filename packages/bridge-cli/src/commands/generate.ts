/**
 * `bridge generate --language <lang> [--out dir] [--package-name name]
 *        [--force] [file]` — code generation.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { generate, TargetLanguage } from '@bridge/generators';
import { ParsedArgs } from '../args';
import { loadConfig } from '../config';
import { compileOrThrow } from '../compile';
import { inputFiles } from '../files';
import { CliError, UsageError } from '../errors';
import { out, CHECK } from '../output';

const LANGUAGES: readonly TargetLanguage[] = ['go', 'rust', 'typescript', 'python'];

export function run(args: ParsedArgs): void {
  const language = args.values.get('--language');
  if (language === undefined) {
    throw new UsageError(`missing required option --language (one of: ${LANGUAGES.join(', ')})`);
  }
  if (!LANGUAGES.includes(language as TargetLanguage)) {
    throw new UsageError(`unknown language '${language}' (expected one of: ${LANGUAGES.join(', ')})`);
  }
  const lang = language as TargetLanguage;

  const force = args.flags.has('--force');
  const packageName = args.values.get('--package-name');
  const files = inputFiles(args, 'generate');

  const outDir = args.values.get('--out') ?? path.join(defaultOutRoot(), lang);

  // Compile everything first, then generate, so errors surface before writes.
  const generated = new Map<string, string>();
  for (const file of files) {
    const { ir } = compileOrThrow(file);
    for (const g of generate(ir, { language: lang, packageName })) {
      generated.set(path.join(outDir, g.path), g.content);
    }
  }

  const targets = [...generated.keys()].sort();
  const existing = targets.filter((t) => fs.existsSync(t));
  if (existing.length > 0 && !force) {
    throw new CliError(
      `refusing to overwrite ${existing.length} existing file(s) — use --force to overwrite:\n` +
      existing.map((t) => `  ${t}`).join('\n'),
    );
  }

  try {
    fs.mkdirSync(outDir, { recursive: true });
    for (const [target, content] of generated) {
      fs.writeFileSync(target, content, 'utf8');
    }
  } catch (e) {
    throw new CliError(`cannot write generated files: ${e instanceof Error ? e.message : String(e)}`);
  }

  for (const target of targets) out(`${CHECK} wrote ${target}`);
  out(`${targets.length} file(s) written to ${outDir} (${lang})`);
}

/** Default output root: the "out" from bridge.json when present, else "generated". */
function defaultOutRoot(): string {
  return loadConfig()?.out ?? 'generated';
}
