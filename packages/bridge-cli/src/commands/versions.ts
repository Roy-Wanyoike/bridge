/**
 * `bridge versions <package> [--registry dir]` — list published versions,
 * oldest → newest, marking the latest.
 */
import { RegistryStore } from '@bridge/registry';
import { ParsedArgs, positionals } from '../args';
import { CliError } from '../errors';
import { out } from '../output';
import { registryCliError, registryDir } from '../registry-cli';

export function run(args: ParsedArgs): void {
  const pos = positionals(args, 'versions', '<package>', 1, 1);
  const packageName = pos[0] as string;
  const store = new RegistryStore(registryDir(args));

  let versions: string[];
  let latest: string;
  try {
    versions = store.versions(packageName);
    latest = store.latest(packageName).version;
  } catch (e) {
    throw registryCliError(e);
  }

  if (versions.length === 0) {
    throw new CliError(`no versions published for '${packageName}' in ${store.paths.root}`);
  }

  out(`${packageName} (${versions.length} version(s), registry ${store.paths.root}):`);
  for (const version of versions) {
    out(`  ${version}${version === latest ? '  (latest)' : ''}`);
  }
}
