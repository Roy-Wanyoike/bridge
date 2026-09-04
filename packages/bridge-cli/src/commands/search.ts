/**
 * `bridge search <query> [--registry dir]` — search published contracts.
 */
import { RegistryStore } from '@bridge/registry';
import { ParsedArgs, positionals } from '../args';
import { out } from '../output';
import { registryCliError, registryDir } from '../registry-cli';

export function run(args: ParsedArgs): void {
  const pos = positionals(args, 'search', '<query>', 1, 1);
  const query = pos[0] as string;
  const store = new RegistryStore(registryDir(args));

  let results;
  try {
    results = store.search(query);
  } catch (e) {
    throw registryCliError(e);
  }

  if (results.length === 0) {
    out(`no contracts matching '${query}' (registry ${store.paths.root})`);
    return;
  }

  out(`${results.length} result(s) for '${query}':`);
  for (const meta of results) {
    const bits = [
      `${meta.packageName}@${meta.version}`,
      meta.shortHash,
    ];
    if (meta.owner !== undefined) bits.push(meta.owner);
    if (meta.description !== undefined) bits.push(`— ${meta.description}`);
    out(`  ${bits.join('  ')}`);
  }
}
