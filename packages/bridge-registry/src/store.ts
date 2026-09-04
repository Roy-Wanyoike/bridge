import { join, resolve } from 'node:path';
import { canonicalJson, hashPackage } from '@bridge/core';
import type { IRPackage } from '@bridge/core';
import { RegistryError } from './errors';
import { assertValidPackageName, isValidPackageName } from './name';
import {
  assertSha256Hex,
  atomicWriteFile,
  parseJsonFile,
  pathExists,
  readdirDirentsOrNull,
} from './fsutil';
import { compareVersions, normalizeVersion, splitPackageVersion } from './version';
import type { ContractMeta, PublishMeta, PublishOptions, RegistryPaths } from './types';

/** Pointer file inside `packages/<base>/<version>/`. */
const POINTER_FILE = 'contract.json';
/** Metadata file inside `packages/<base>/<version>/`. */
const META_FILE = 'meta.json';
/** Store-wide index file. */
const INDEX_FILE = 'index.json';
/** Object store directory name. */
const OBJECTS_DIR = 'objects';
/** Package tree directory name. */
const PACKAGES_DIR = 'packages';

/** Version directory names are always canonical `v<digits>`. */
const VERSION_DIR_RE = /^v\d+$/;

/** Shape of `packages/<base>/<version>/contract.json`. */
interface PointerFile {
  hash: string;
  package: string;
}

/** Shape of `index.json`. */
interface IndexFile {
  contracts: ContractMeta[];
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function storageKey(base: string, version: string): string {
  return `${base}@${version}`;
}

/** Canonical deterministic order for contract metas: (base, version). */
function compareMeta(a: ContractMeta, b: ContractMeta): number {
  if (a.base !== b.base) return a.base < b.base ? -1 : 1;
  return compareVersions(a.version, b.version);
}

/** Validate an untrusted parsed meta record; `'corrupt'` on any deviation. */
function assertMetaShape(value: unknown, file: string): ContractMeta {
  if (!isPlainObject(value)) {
    throw new RegistryError('corrupt', `${file}: expected a JSON object`);
  }
  for (const field of ['packageName', 'base', 'version', 'hash', 'shortHash'] as const) {
    if (typeof value[field] !== 'string') {
      throw new RegistryError('corrupt', `${file}: field '${field}' must be a string`);
    }
  }
  if (!Array.isArray(value.imports) || !value.imports.every((x) => typeof x === 'string')) {
    throw new RegistryError('corrupt', `${file}: field 'imports' must be an array of strings`);
  }
  assertSha256Hex(value.hash, `${file}: meta.hash`);
  return value as unknown as ContractMeta;
}

/** Validate an untrusted parsed pointer record; `'corrupt'` on any deviation. */
function assertPointerShape(value: unknown, file: string): PointerFile {
  if (!isPlainObject(value)) {
    throw new RegistryError('corrupt', `${file}: expected a JSON object`);
  }
  const hash = assertSha256Hex(value.hash, `${file}: pointer.hash`);
  if (typeof value.package !== 'string' || !isValidPackageName(value.package)) {
    throw new RegistryError(
      'corrupt',
      `${file}: pointer.package ${JSON.stringify(value.package)} is not a valid package name`,
    );
  }
  return { hash, package: value.package };
}

/**
 * Local, content-addressed registry of immutable contract versions.
 *
 * Storage layout (all writes atomic: hidden same-directory tmp file +
 * rename; all JSON deterministic — sorted keys via `canonicalJson`):
 *
 * ```
 * <root>/
 *   objects/<hash[0:2]>/<hash>.json          ← canonicalJson(ir), content-addressed
 *   packages/<base>/<version>/contract.json  ← { "hash": ..., "package": <name> }
 *   packages/<base>/<version>/meta.json      ← ContractMeta
 *   index.json                               ← { "contracts": [ContractMeta...] }
 * ```
 *
 * Key semantics:
 * - **Content addressing.** A version's identity is `hashPackage(ir)`.
 *   Republishing identical content is a no-op returning the original meta;
 *   republishing different content under an existing base/version throws
 *   `'immutable'` — published versions are never mutated.
 * - **Lookups are keyed by `(base, version)`.** The base is the package name
 *   minus a version-shaped final segment (`'payments.v1'` and `'payments'`
 *   both address the base `'payments'`).
 * - **Path safety.** Every name/version/hash that reaches a filesystem path
 *   is validated first, whether it came from a caller or from stored data.
 * - **Scope.** Designed for single-process local use (no cross-process
 *   locking); concurrent writers in separate processes are not supported.
 *
 * The constructor performs no filesystem access; directories are created
 * lazily on first publish, so read-only use against an empty/missing root
 * yields empty results rather than side effects.
 */
export class RegistryStore {
  /** Filesystem layout of this store (for CLI display and tooling). */
  public readonly paths: RegistryPaths;

  constructor(rootDir: string) {
    if (typeof rootDir !== 'string' || rootDir.length === 0) {
      throw new TypeError('RegistryStore: rootDir must be a non-empty string');
    }
    const root = resolve(rootDir);
    this.paths = {
      root,
      objects: join(root, OBJECTS_DIR),
      packages: join(root, PACKAGES_DIR),
      index: join(root, INDEX_FILE),
    };
  }

  // ------------------------------------------------------------------ publish

  /**
   * Publish an immutable contract version.
   *
   * The version coordinates come from the package name's final segment
   * (`'payments.v1'` → version `v1`); names without one require
   * `opts.version`. Behavior when `packages/<base>/<version>/` already
   * exists:
   * - identical content → idempotent no-op, returns the originally stored
   *   meta (later publish metadata is ignored — versions are immutable);
   * - different content → {@link RegistryError} `'immutable'`.
   *
   * Every publish also rebuilds `index.json` from disk. `meta` fields
   * (`owner`, `description`, `repository`) and `opts.publishTime` are stored
   * verbatim; `publishedAt` is never generated implicitly.
   *
   * Throws `'invalid-name'` / `'invalid-version'` for bad coordinates,
   * `'hash-conflict'` if the content-addressed object slot holds different
   * content, `'immutable'` on version conflicts, `'io'` on filesystem
   * failures.
   */
  public publish(ir: IRPackage, meta: PublishMeta = {}, opts: PublishOptions = {}): ContractMeta {
    if (!isPlainObject(ir)) {
      throw new TypeError('publish(): ir must be an IRPackage object');
    }
    if (typeof ir.name !== 'string') {
      throw new TypeError("publish(): ir.name must be a string");
    }
    assertValidPackageName(ir.name);
    if (!Array.isArray(ir.imports) || !ir.imports.every((x) => typeof x === 'string')) {
      throw new TypeError("publish(): ir.imports must be an array of strings");
    }
    this.assertPublishMeta(meta);

    const { base, version: derived } = splitPackageVersion(ir.name);
    const version = this.resolvePublishVersion(ir.name, derived, opts);

    const hash = hashPackage(ir);
    assertSha256Hex(hash, `computed hash of '${ir.name}'`);

    const verDir = join(this.paths.packages, base, version);
    const pointerPath = join(verDir, POINTER_FILE);
    const metaPath = join(verDir, META_FILE);

    const rawPointer = parseJsonFile<unknown>(pointerPath);
    if (rawPointer !== null) {
      const pointer = assertPointerShape(rawPointer, pointerPath);
      if (pointer.hash !== hash) {
        throw new RegistryError(
          'immutable',
          `${base}@${version} is already published with different content ` +
            `(stored ${pointer.hash}, incoming ${hash}). Published versions are immutable — ` +
            `publish a new version instead.`,
        );
      }
      // Idempotent republish of identical content: a true no-op.
      const rawMeta = parseJsonFile<unknown>(metaPath);
      if (rawMeta === null) {
        throw new RegistryError(
          'corrupt',
          `${pointerPath} exists but ${metaPath} is missing; registry state is inconsistent`,
        );
      }
      const existingMeta = assertMetaShape(rawMeta, metaPath);
      this.ensureObject(ir, hash); // self-heal a missing object, detect tampering
      return existingMeta;
    }
    if (pathExists(metaPath)) {
      throw new RegistryError(
        'corrupt',
        `${metaPath} exists without ${POINTER_FILE}; registry state is inconsistent`,
      );
    }

    const contractMeta = this.buildMeta(ir, base, version, hash, meta, opts);
    // Write order matters: the content-addressed object must exist before
    // anything references it. Each individual write is atomic.
    this.ensureObject(ir, hash);
    atomicWriteFile(pointerPath, canonicalJson({ hash, package: ir.name } satisfies PointerFile));
    atomicWriteFile(metaPath, canonicalJson(contractMeta));
    this.rebuildIndex();
    return contractMeta;
  }

  // ------------------------------------------------------------------ pulling

  /**
   * Fetch one published version.
   *
   * Returns the parsed IR and its metadata. The stored artifact is re-hashed
   * on every pull: a mismatch between content and the recorded hash throws
   * `'corrupt'` (tamper detection). Unknown coordinates throw `'not-found'`.
   */
  public pull(packageName: string, version: string): { ir: IRPackage; meta: ContractMeta } {
    const { base } = this.baseOf(packageName);
    const ver = normalizeVersion(version);
    const verDir = join(this.paths.packages, base, ver);
    const pointer = this.requirePointer(join(verDir, POINTER_FILE), base, ver);
    const ir = this.readVerifiedObject(pointer.hash, base, ver);
    const meta = this.requireMeta(join(verDir, META_FILE), base, ver);
    if (meta.hash !== pointer.hash) {
      throw new RegistryError(
        'corrupt',
        `Meta for ${base}@${ver} records hash ${meta.hash} but the pointer records ${pointer.hash}`,
      );
    }
    return { ir, meta };
  }

  /**
   * Re-hash the stored artifact for `packageName@version` and compare it to
   * the recorded content address. Returns `{ ok: true, hash }` on success;
   * throws `'corrupt'` on tampering, `'not-found'` when unknown.
   */
  public verify(packageName: string, version: string): { ok: true; hash: string } {
    const { base } = this.baseOf(packageName);
    const ver = normalizeVersion(version);
    const verDir = join(this.paths.packages, base, ver);
    const pointer = this.requirePointer(join(verDir, POINTER_FILE), base, ver);
    this.readVerifiedObject(pointer.hash, base, ver);
    return { ok: true, hash: pointer.hash };
  }

  /**
   * Metadata for one version. Reads only `meta.json` (no integrity check —
   * use {@link verify} for that). Unknown versions throw `'not-found'`.
   */
  public inspect(packageName: string, version: string): ContractMeta {
    const { base } = this.baseOf(packageName);
    return this.inspectAt(base, normalizeVersion(version));
  }

  /**
   * Latest published version of a package (numeric ordering, `v2 < v10`),
   * by base name — both `'payments'` and any `'payments vX'` name address
   * the same package. Throws `'not-found'` when nothing is published.
   */
  public latest(packageName: string): ContractMeta {
    const { base } = this.baseOf(packageName);
    const versions = this.versionsByBase(base);
    const newest = versions.at(-1);
    if (newest === undefined) {
      throw new RegistryError('not-found', `No versions published for package '${packageName}'`);
    }
    return this.inspectAt(base, newest);
  }

  /**
   * All published versions of a package (by base name), ordered
   * oldest → newest. Empty array for unknown packages.
   */
  public versions(packageName: string): string[] {
    const { base } = this.baseOf(packageName);
    return this.versionsByBase(base);
  }

  /**
   * All packages with their latest meta, one entry per base, sorted by base
   * name. Reads the index (fast path); empty array for a fresh store.
   */
  public list(): ContractMeta[] {
    const latestByBase = new Map<string, ContractMeta>();
    for (const meta of this.readIndex()) {
      const prev = latestByBase.get(meta.base);
      if (prev === undefined || compareVersions(meta.version, prev.version) > 0) {
        latestByBase.set(meta.base, meta);
      }
    }
    return [...latestByBase.values()].sort(compareMeta);
  }

  /**
   * Substring search (case-insensitive) over package name, base,
   * description and owner, using the index. Results follow the canonical
   * deterministic `(base, version)` order — identical queries return
   * identical arrays. An empty query matches everything.
   */
  public search(query: string): ContractMeta[] {
    if (typeof query !== 'string') throw new TypeError('search(): query must be a string');
    const q = query.toLowerCase();
    return this.readIndex().filter((meta) => {
      if (meta.packageName.toLowerCase().includes(q)) return true;
      if (meta.base.toLowerCase().includes(q)) return true;
      if (meta.owner !== undefined && meta.owner.toLowerCase().includes(q)) return true;
      if (meta.description !== undefined && meta.description.toLowerCase().includes(q)) return true;
      return false;
    });
  }

  // ------------------------------------------------------------------- graph

  /**
   * Direct dependents of a package: index contracts whose recorded imports
   * include `packageName` **or** its base. Deterministic `(base, version)`
   * order. A contract is never its own dependent.
   */
  public dependents(packageName: string): ContractMeta[] {
    assertValidPackageName(packageName);
    const base = splitPackageVersion(packageName).base;
    return this.readIndex().filter(
      (meta) =>
        meta.packageName !== packageName &&
        (meta.imports.includes(packageName) || meta.imports.includes(base)),
    );
  }

  /**
   * Transitive dependency closure of a package, breadth-first over the
   * imports recorded in each dependency's stored meta.
   *
   * - Import references appear in the result as recorded (full names like
   *   `'payments.v1'`, or bare bases like `'payments'`), in BFS discovery
   *   order, deduplicated; the root package itself is excluded.
   * - Bare-base imports resolve to the latest published version of that
   *   base; unpublished dependencies are included but not traversed.
   * - Cycle-safe: visited state is tracked by name and storage key, so
   *   `a → b → a` terminates.
   *
   * `version` selects the root version; defaults to the latest. Unknown
   * roots throw `'not-found'`.
   */
  public dependencies(packageName: string, version?: string): string[] {
    const { base } = this.baseOf(packageName);
    let rootVersion: string;
    if (version !== undefined) {
      rootVersion = normalizeVersion(version);
    } else {
      const newest = this.versionsByBase(base).at(-1);
      if (newest === undefined) {
        throw new RegistryError(
          'not-found',
          `No versions published for package '${packageName}'`,
        );
      }
      rootVersion = newest;
    }
    const rootMeta = this.inspectAt(base, rootVersion);

    const seenNames = new Set<string>([rootMeta.packageName, rootMeta.base]);
    const seenKeys = new Set<string>([storageKey(base, rootVersion)]);
    const result: string[] = [];
    const queue: string[] = [...rootMeta.imports];

    while (queue.length > 0) {
      const name = queue.shift();
      if (name === undefined) break; // unreachable given the length guard
      if (seenNames.has(name)) continue;
      seenNames.add(name);
      result.push(name);
      const meta = this.findImportMeta(name);
      if (meta === null) continue; // unpublished dependency: report, don't traverse
      const key = storageKey(meta.base, meta.version);
      if (seenKeys.has(key)) continue; // same package reached via another alias
      seenKeys.add(key);
      for (const imp of meta.imports) {
        if (!seenNames.has(imp)) queue.push(imp);
      }
    }
    return result;
  }

  // ----------------------------------------------------------------- private

  /** Validate a caller-supplied package name and reduce it to its base. */
  private baseOf(packageName: string): { base: string } {
    assertValidPackageName(packageName);
    return { base: splitPackageVersion(packageName).base };
  }

  /** Validate publish metadata values (defensive against JS callers). */
  private assertPublishMeta(meta: PublishMeta): void {
    for (const field of ['owner', 'description', 'repository'] as const) {
      const value = meta[field];
      if (value !== undefined && typeof value !== 'string') {
        throw new TypeError(`publish(): meta.${field} must be a string when provided`);
      }
    }
  }

  /**
   * Decide the storage version for a publish: the name-derived version when
   * present (then `opts.version` must match it), otherwise `opts.version`
   * is required and normalized.
   */
  private resolvePublishVersion(
    packageName: string,
    derived: string,
    opts: PublishOptions,
  ): string {
    if (derived !== '') {
      if (opts.version !== undefined) {
        const given = normalizeVersion(opts.version);
        if (given !== derived) {
          throw new RegistryError(
            'invalid-version',
            `opts.version ${JSON.stringify(given)} does not match the version ` +
              `${JSON.stringify(derived)} derived from package name '${packageName}'`,
          );
        }
      }
      return derived;
    }
    if (opts.version === undefined) {
      throw new RegistryError(
        'invalid-version',
        `Package name '${packageName}' carries no version segment; pass opts.version (e.g. 'v1')`,
      );
    }
    return normalizeVersion(opts.version);
  }

  /** Build the stored meta for a fresh publish. */
  private buildMeta(
    ir: IRPackage,
    base: string,
    version: string,
    hash: string,
    meta: PublishMeta,
    opts: PublishOptions,
  ): ContractMeta {
    const out: ContractMeta = {
      packageName: ir.name,
      base,
      version,
      hash,
      shortHash: hash.slice(0, 12),
      // IR contract guarantees sorted+deduped imports; enforce it so meta is
      // deterministic even for hand-built fixtures.
      imports: [...new Set(ir.imports)].sort(),
    };
    if (meta.owner !== undefined) out.owner = meta.owner;
    if (meta.description !== undefined) out.description = meta.description;
    if (meta.repository !== undefined) out.repository = meta.repository;
    if (opts.publishTime !== undefined) out.publishedAt = opts.publishTime;
    return out;
  }

  /**
   * Path of the content-addressed object for `hash`. The hash is validated
   * before it touches a path (traversal-safe even for hashes read from disk).
   */
  private objectPath(hash: string): string {
    assertSha256Hex(hash, 'object hash');
    return join(this.paths.objects, hash.slice(0, 2), `${hash}.json`);
  }

  /**
   * Write the content-addressed object if absent. If the slot already holds
   * content, it must be byte-equivalent (canonically) to the incoming IR —
   * anything else is a SHA-256 collision or store tampering and throws
   * `'hash-conflict'` rather than silently overwriting.
   */
  private ensureObject(ir: IRPackage, hash: string): string {
    const objectPath = this.objectPath(hash);
    const existing = parseJsonFile<unknown>(objectPath);
    if (existing !== null) {
      if (canonicalJson(existing) !== canonicalJson(ir)) {
        throw new RegistryError(
          'hash-conflict',
          `Content-addressed object ${objectPath} already holds different content; ` +
            `refusing to overwrite (SHA-256 collision or store tampering).`,
        );
      }
      return objectPath;
    }
    atomicWriteFile(objectPath, canonicalJson(ir));
    return objectPath;
  }

  /** Read an object and verify it hashes to the recorded address. */
  private readVerifiedObject(hash: string, base: string, version: string): IRPackage {
    const objectPath = this.objectPath(hash);
    const stored = parseJsonFile<unknown>(objectPath);
    if (stored === null) {
      throw new RegistryError(
        'corrupt',
        `Object ${objectPath} referenced by ${base}@${version} is missing`,
      );
    }
    const actual = hashPackage(stored as IRPackage);
    if (actual !== hash) {
      throw new RegistryError(
        'corrupt',
        `Integrity check failed for ${base}@${version}: recorded hash ${hash} but content ` +
          `hashes to ${actual} (artifact tampered or corrupted)`,
      );
    }
    return stored as IRPackage;
  }

  /** Read a pointer or throw `'not-found'` when absent. */
  private requirePointer(pointerPath: string, base: string, version: string): PointerFile {
    const raw = parseJsonFile<unknown>(pointerPath);
    if (raw === null) {
      throw new RegistryError(
        'not-found',
        `No contract published at ${base}@${version} (missing ${pointerPath})`,
      );
    }
    return assertPointerShape(raw, pointerPath);
  }

  /** Read a meta file in a context where the pointer is known to exist. */
  private requireMeta(metaPath: string, base: string, version: string): ContractMeta {
    const raw = parseJsonFile<unknown>(metaPath);
    if (raw === null) {
      throw new RegistryError(
        'corrupt',
        `Meta file ${metaPath} missing for ${base}@${version}; registry state is inconsistent`,
      );
    }
    return assertMetaShape(raw, metaPath);
  }

  /** Meta at `packages/<base>/<version>/meta.json`, with honest errors. */
  private inspectAt(base: string, version: string): ContractMeta {
    const verDir = join(this.paths.packages, base, version);
    const metaPath = join(verDir, META_FILE);
    const raw = parseJsonFile<unknown>(metaPath);
    if (raw !== null) return assertMetaShape(raw, metaPath);
    if (pathExists(join(verDir, POINTER_FILE))) {
      throw new RegistryError(
        'corrupt',
        `${verDir} has a pointer but no ${META_FILE}; registry state is inconsistent`,
      );
    }
    throw new RegistryError('not-found', `No contract published at ${base}@${version}`);
  }

  /** Meta or `null` — used when absence is an expected, non-fatal outcome. */
  private inspectOrNull(base: string, version: string): ContractMeta | null {
    const metaPath = join(this.paths.packages, base, version, META_FILE);
    const raw = parseJsonFile<unknown>(metaPath);
    if (raw === null) return null;
    return assertMetaShape(raw, metaPath);
  }

  /** Published versions under one base, oldest → newest. */
  private versionsByBase(base: string): string[] {
    assertValidPackageName(base); // defense in depth for stored-derived bases
    const baseDir = join(this.paths.packages, base);
    const dirents = readdirDirentsOrNull(baseDir);
    if (dirents === null) return [];
    const out: string[] = [];
    for (const dirent of dirents) {
      if (!dirent.isDirectory()) continue;
      if (!VERSION_DIR_RE.test(dirent.name)) continue;
      if (pathExists(join(baseDir, dirent.name, POINTER_FILE))) out.push(dirent.name);
    }
    out.sort(compareVersions);
    return out;
  }

  /** Resolve an import reference (full name or bare base) to a stored meta. */
  private findImportMeta(name: string): ContractMeta | null {
    if (!isValidPackageName(name)) {
      throw new RegistryError(
        'corrupt',
        `Stored import reference ${JSON.stringify(name)} is not a valid package name`,
      );
    }
    const { base, version } = splitPackageVersion(name);
    if (version !== '') return this.inspectOrNull(base, version);
    // Bare-base import: resolve to the latest published version.
    const newest = this.versionsByBase(base).at(-1);
    return newest === undefined ? null : this.inspectOrNull(base, newest);
  }

  /** All metas from `index.json`, re-sorted into canonical order. */
  private readIndex(): ContractMeta[] {
    const raw = parseJsonFile<unknown>(this.paths.index);
    if (raw === null) return [];
    if (!isPlainObject(raw) || !Array.isArray(raw.contracts)) {
      throw new RegistryError(
        'corrupt',
        `${this.paths.index}: expected {"contracts": ContractMeta[]}`,
      );
    }
    return raw.contracts
      .map((entry, i) => assertMetaShape(entry, `${this.paths.index}[contracts][${i}]`))
      .sort(compareMeta);
  }

  /** Rebuild `index.json` from disk (atomic). */
  private rebuildIndex(): void {
    const contracts: IndexFile = { contracts: this.scanMetas() };
    atomicWriteFile(this.paths.index, canonicalJson(contracts));
  }

  /**
   * Scan every `packages/<base>/<version>/meta.json` into a sorted array.
   * Lenient by design: corrupt or partial entries are skipped so one bad
   * file cannot block publishing; direct accessors (pull/inspect/verify)
   * still surface those errors loudly.
   */
  private scanMetas(): ContractMeta[] {
    const dirents = readdirDirentsOrNull(this.paths.packages);
    if (dirents === null) return [];
    const out: ContractMeta[] = [];
    for (const baseDir of dirents) {
      if (!baseDir.isDirectory()) continue;
      const versions = readdirDirentsOrNull(join(this.paths.packages, baseDir.name));
      if (versions === null) continue;
      for (const verDir of versions) {
        if (!verDir.isDirectory()) continue;
        const metaPath = join(this.paths.packages, baseDir.name, verDir.name, META_FILE);
        try {
          const raw = parseJsonFile<unknown>(metaPath);
          if (raw === null) continue;
          out.push(assertMetaShape(raw, metaPath));
        } catch {
          continue; // corrupt unrelated entry — skip, don't block the index
        }
      }
    }
    return out.sort(compareMeta);
  }
}
