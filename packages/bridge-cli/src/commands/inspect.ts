/**
 * `bridge inspect <package> [version] [--registry dir]` — metadata and
 * shape of a published contract (defaults to the latest version).
 */
import { IRPackage } from '@bridge/core';
import { RegistryStore } from '@bridge/registry';
import { ParsedArgs, positionals } from '../args';
import { CliError } from '../errors';
import { out } from '../output';
import { registryCliError, registryDir } from '../registry-cli';

export function run(args: ParsedArgs): void {
  const pos = positionals(args, 'inspect', '<package> [version]', 1, 2);
  const packageName = pos[0] as string;
  const version = pos[1];
  const store = new RegistryStore(registryDir(args));

  let meta;
  let ir: IRPackage;
  try {
    meta = version !== undefined ? store.inspect(packageName, version) : store.latest(packageName);
    ({ ir } = store.pull(packageName, meta.version));
  } catch (e) {
    throw registryCliError(e);
  }

  let structs = 0;
  let enums = 0;
  let unions = 0;
  let aliases = 0;
  for (const t of ir.types) {
    switch (t.kind) {
      case 'struct':
        structs++;
        break;
      case 'enum':
        enums++;
        break;
      case 'union':
        unions++;
        break;
      case 'alias':
        aliases++;
        break;
    }
  }
  let methods = 0;
  for (const service of ir.services) methods += service.methods.length;

  out(`${meta.packageName}@${meta.version}`);
  out(`    registry: ${store.paths.root}`);
  out(`    hash: ${meta.shortHash} (${meta.hash})`);
  if (meta.owner !== undefined) out(`    owner: ${meta.owner}`);
  if (meta.description !== undefined) out(`    description: ${meta.description}`);
  if (meta.repository !== undefined) out(`    repository: ${meta.repository}`);
  if (meta.publishedAt !== undefined) out(`    published: ${meta.publishedAt}`);
  out(`    types: ${ir.types.length} (structs ${structs}, enums ${enums}, unions ${unions}, aliases ${aliases})`);
  out(`    services: ${ir.services.length} (${methods} methods)`);
  out(`    events: ${ir.events.length}`);
  out(`    imports: ${ir.imports.length > 0 ? ir.imports.join(', ') : '(none)'}`);
}
