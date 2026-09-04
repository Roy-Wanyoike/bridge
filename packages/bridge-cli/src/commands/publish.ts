/**
 * `bridge publish <file> [--registry dir] [--owner name]
 *        [--description text] [--version vX]` — publish to the local
 * content-addressed registry.
 */
import { RegistryStore, PublishMeta } from '@bridge/registry';
import { ParsedArgs, positionals } from '../args';
import { compileOrThrow } from '../compile';
import { out, CHECK } from '../output';
import { registryCliError, registryDir } from '../registry-cli';

export function run(args: ParsedArgs): void {
  const pos = positionals(args, 'publish', '<file>', 1, 1);
  const file = pos[0] as string;

  const meta: PublishMeta = {};
  const owner = args.values.get('--owner');
  if (owner !== undefined) meta.owner = owner;
  const description = args.values.get('--description');
  if (description !== undefined) meta.description = description;
  const version = args.values.get('--version');

  const { ir } = compileOrThrow(file);
  const root = registryDir(args);
  const store = new RegistryStore(root);

  let published;
  try {
    published = store.publish(ir, meta, version !== undefined ? { version } : undefined);
  } catch (e) {
    throw registryCliError(e);
  }

  out(`${CHECK} published ${published.packageName}@${published.version} (hash ${published.shortHash})`);
  out(`    registry: ${store.paths.root}`);
  if (published.owner !== undefined) out(`    owner: ${published.owner}`);
  if (published.description !== undefined) out(`    description: ${published.description}`);
  if (published.imports.length > 0) out(`    imports: ${published.imports.join(', ')}`);
}
