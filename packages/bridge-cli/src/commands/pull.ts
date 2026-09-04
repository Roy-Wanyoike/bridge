/**
 * `bridge pull <package> <version> [--registry dir] [--out file]` — fetch a
 * published contract; print a summary or write canonical IR JSON.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { canonicalJson } from '@bridge/core';
import { RegistryStore } from '@bridge/registry';
import { ParsedArgs, positionals } from '../args';
import { CliError } from '../errors';
import { out, CHECK } from '../output';
import { registryCliError, registryDir } from '../registry-cli';

export function run(args: ParsedArgs): void {
  const pos = positionals(args, 'pull', '<package> <version>', 2, 2);
  const [packageName, version] = pos as [string, string];
  const outFile = args.values.get('--out');
  const root = registryDir(args);
  const store = new RegistryStore(root);

  let ir;
  let meta;
  try {
    ({ ir, meta } = store.pull(packageName, version));
  } catch (e) {
    throw registryCliError(e);
  }

  if (outFile !== undefined) {
    try {
      fs.mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true });
      fs.writeFileSync(outFile, canonicalJson(ir) + '\n', 'utf8');
    } catch (e) {
      throw new CliError(`cannot write ${outFile}: ${e instanceof Error ? e.message : String(e)}`);
    }
    out(`${CHECK} wrote ${outFile} (${meta.packageName}@${meta.version}, hash ${meta.shortHash})`);
    return;
  }

  out(`${CHECK} pulled ${meta.packageName}@${meta.version}`);
  out(`    registry: ${store.paths.root}`);
  out(`    hash: ${meta.hash}`);
  if (meta.owner !== undefined) out(`    owner: ${meta.owner}`);
  if (meta.description !== undefined) out(`    description: ${meta.description}`);
  if (meta.publishedAt !== undefined) out(`    published: ${meta.publishedAt}`);

  let methods = 0;
  for (const service of ir.services) methods += service.methods.length;
  out(`    types: ${ir.types.length}, services: ${ir.services.length} (${methods} methods), events: ${ir.events.length}`);
  out(`    imports: ${ir.imports.length > 0 ? ir.imports.join(', ') : '(none)'}`);
}
