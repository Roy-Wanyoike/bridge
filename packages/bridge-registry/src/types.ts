/**
 * Public metadata types of the registry.
 *
 * `ContractMeta` records are stored verbatim as JSON (canonical form, sorted
 * keys) at `packages/<base>/<version>/meta.json` and mirrored in the store
 * index. Optional fields are omitted from storage when not provided.
 */

/** Optional descriptive metadata attached at publish time. */
export interface PublishMeta {
  /** Owning team or person, e.g. `'team-payments'`. */
  owner?: string;
  /** Human-readable summary, searchable via `RegistryStore.search`. */
  description?: string;
  /** Repository URL or identifier for the contract's source. */
  repository?: string;
}

/** Options that modify publish behavior. */
export interface PublishOptions {
  /**
   * ISO8601 publication timestamp recorded **verbatim** as `publishedAt`.
   * Never generated implicitly: when omitted, no `publishedAt` field is
   * stored at all.
   */
  publishTime?: string;
  /**
   * Explicit version for package names without a version-shaped final
   * segment (e.g. name `'payments'` with `version: 'v3'`). Required in that
   * case; when the name already carries a version segment it must match,
   * otherwise publish throws `'invalid-version'`.
   */
  version?: string;
}

/** Public metadata for one immutable, published contract version. */
export interface ContractMeta extends PublishMeta {
  /** Full dotted package name as published, e.g. `'payments.v1'`. */
  packageName: string;
  /** Storage base derived from the name, e.g. `'payments'`. */
  base: string;
  /** Normalized version, e.g. `'v1'`. */
  version: string;
  /** SHA-256 (hex) of the canonical JSON of the IR — the content address. */
  hash: string;
  /** First 12 characters of `hash`, for display. */
  shortHash: string;
  /** Dependencies of this contract as recorded from `ir.imports`. */
  imports: string[];
  /** ISO8601 timestamp — present **only** when publish was given one. */
  publishedAt?: string;
}

/** Filesystem layout of a registry root (for CLI display and tooling). */
export interface RegistryPaths {
  /** Absolute store root as given to `RegistryStore` (resolved). */
  root: string;
  /** Content-addressed object store: `objects/<hash[0:2]>/<hash>.json`. */
  objects: string;
  /** Package pointers and metadata: `packages/<base>/<version>/`. */
  packages: string;
  /** JSON index of all contracts, rebuilt on every publish. */
  index: string;
}
