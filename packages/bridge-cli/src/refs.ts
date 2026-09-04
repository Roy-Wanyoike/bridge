/**
 * Contract-reference resolution shared by `bridge impact` and
 * `bridge check --against`: a reference is either a file path (compiled on
 * the fly) or a published registry ref (`name` for the latest version, or
 * `name@version` pinned). An existing file path always wins over a registry
 * name — registry lookups only happen for strings that are not files.
 */
import * as fs from 'node:fs';
import { IRPackage } from '@bridge/core';
import { RegistryStore, RegistryError } from '@bridge/registry';
import { compileOrThrow } from './compile';
import { CliError } from './errors';
import { registryCliError } from './registry-cli';

export interface ResolvedRef {
  /** Compiled (or pulled) IR of the referenced contract. */
  readonly ir: IRPackage;
  /** Human-readable identity for reports: file path or `name@version`. */
  readonly label: string;
}

const VERSION_SEGMENT = /^(?:v\d+|\d+)$/;

/**
 * Pull `name` / `name@version` from a store.
 *
 * Unpinned resolution order (mirrors how the registry names contracts):
 * 1. explicit `name@version` → pull exactly that;
 * 2. a versioned full name (`payments.v1`) → pull exactly that name+segment
 *    (so a baseline stays pinned even when `payments.v2` exists);
 * 3. otherwise (`payments`) → the latest published version of that base.
 */
export function pullRef(ref: string, store: RegistryStore): ResolvedRef {
  const at = ref.lastIndexOf('@');
  const name = at > 0 ? ref.slice(0, at) : ref;
  const version = at > 0 ? ref.slice(at + 1) : undefined;
  try {
    if (version !== undefined) {
      const { ir, meta } = store.pull(name, version);
      return { ir, label: `${meta.packageName}@${meta.version}` };
    }
    const dot = name.lastIndexOf('.');
    const last = dot > 0 ? name.slice(dot + 1) : '';
    if (dot > 0 && VERSION_SEGMENT.test(last)) {
      try {
        const { ir, meta } = store.pull(name, last);
        return { ir, label: `${meta.packageName}@${meta.version}` };
      } catch (e) {
        if (!(e instanceof RegistryError && e.code === 'not-found')) throw e;
        // Name segment never published as such — fall through to base-latest.
      }
    }
    const meta = store.latest(name);
    const { ir } = store.pull(meta.packageName, meta.version);
    return { ir, label: `${meta.packageName}@${meta.version}` };
  } catch (e) {
    throw registryCliError(e);
  }
}

/**
 * Resolve one contract reference. `noRegistryHint` is surfaced when the ref
 * is not a file and no registry root exists — the common misconfiguration.
 */
export function resolveRef(ref: string, store: RegistryStore | undefined, noRegistryHint: string): ResolvedRef {
  if (fs.existsSync(ref)) {
    const compiled = compileOrThrow(ref);
    return { ir: compiled.ir, label: compiled.file };
  }
  if (store === undefined) {
    throw new CliError(`'${ref}' is not a file and no registry is available — ${noRegistryHint}`);
  }
  return pullRef(ref, store);
}
