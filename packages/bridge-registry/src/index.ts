/**
 * @bridge/registry — Bridge's local, content-addressed contract registry.
 *
 * Stores immutable contract versions keyed by the SHA-256 of their canonical
 * IR (`hashPackage` from `@bridge/core`), with an index for fast
 * search/dependency-graph queries:
 *
 * ```
 * <root>/
 *   objects/<hash[0:2]>/<hash>.json          ← canonicalJson(ir)
 *   packages/<base>/<version>/contract.json  ← { hash, package } pointer
 *   packages/<base>/<version>/meta.json      ← ContractMeta
 *   index.json                               ← { contracts: ContractMeta[] }
 * ```
 *
 * Public API:
 * - `RegistryStore` — publish (immutable, idempotent), pull, verify,
 *   inspect, latest, versions, list, search, dependents, dependencies
 * - `RegistryError` — every expected failure, with a stable `code`
 * - `splitPackageVersion` / `normalizeVersion` / `compareVersions`
 * - IR types and hashing helpers, re-exported from `@bridge/core`
 *
 * @example
 * ```ts
 * import { RegistryStore } from '@bridge/registry';
 * const store = new RegistryStore('.bridge-registry');
 * const meta = store.publish(ir, { owner: 'team-payments' });
 * const { ir: pulled } = store.pull('payments.v1', 'v1');
 * ```
 */
export * from '@bridge/core';
export { RegistryError } from './errors';
export type { RegistryErrorCode } from './errors';
export { compareVersions, normalizeVersion, splitPackageVersion } from './version';
export type { PackageNameParts } from './version';
export type { ContractMeta, PublishMeta, PublishOptions, RegistryPaths } from './types';
export { RegistryStore } from './store';
