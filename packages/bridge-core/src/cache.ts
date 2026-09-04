/**
 * Deterministic, content-addressed compilation cache for `compileSource`.
 *
 * Design (issue #23, "deterministic caching" half):
 * - Entries are keyed by (cache format version, compiler version, file path,
 *   SHA-256 of the source text). Same inputs ⇒ same key ⇒ the stored
 *   `CompileResult` JSON is returned verbatim, which is byte-identical to a
 *   fresh compile of that source (property-tested in
 *   src/test/property/cache.property.test.ts).
 * - `filePath` is part of the key because diagnostics embed it; cache hits
 *   must be indistinguishable from fresh compiles *including* diagnostics.
 * - Entries are single JSON files written atomically (tmp file + rename), so
 *   a crashed writer can never leave a torn entry: the worst case is a
 *   parse-able=false file, which `get` treats as a miss.
 * - `get` NEVER throws: any IO/parse/shape/version problem is a cache miss.
 *   `set` propagates IO errors (the caller owns the directory).
 *
 * Shipped as a library only in this change — deliberately NOT wired into the
 * compiler or CLI (no behavior change). Integration is a documented
 * follow-up in docs/TESTING.md.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CompileResult } from './ir/types';

/** Bump when the stored entry shape changes (invalidates every cache dir). */
export const CACHE_FORMAT_VERSION = 1;

/** Resolve the compiler package version (falls back to a dev marker). */
export function compilerVersion(): string {
  try {
    // Compiled layout: dist/cache.js → ../package.json. Tests always import
    // the compiled file, so this relative require is stable.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const pkg = require('../package.json') as { version?: unknown };
    return typeof pkg.version === 'string' && pkg.version.length > 0 ? pkg.version : '0.0.0-dev';
  } catch {
    return '0.0.0-dev';
  }
}

export interface CompileCacheOptions {
  /**
   * Compiler version mixed into every key. Defaults to the @bridge/core
   * package version. Override in tests (or to invalidate manually).
   */
  version?: string;
}

export interface CompileCache {
  /** Root directory holding `<key>.json` entries. */
  readonly dir: string;
  /** Compiler version mixed into every key. */
  readonly version: string;
  /** Content-addressed key for a source text (exposed for debugging/tests). */
  keyFor(source: string, filePath?: string): string;
  /** SHA-256 of the source text (entry payload + debugging aid). */
  sourceHash(source: string): string;
  /**
   * Return the cached CompileResult for this source, or undefined on a miss
   * (never set, version mismatch, unreadable/corrupt entry). Never throws.
   */
  get(source: string, filePath?: string): CompileResult | undefined;
  /** Store a CompileResult for this source atomically. */
  set(source: string, result: CompileResult, filePath?: string): void;
}

const DEFAULT_FILE_PATH = '<input>';

/** Create a content-addressed compile cache rooted at `dir`. */
export function createCompileCache(dir: string, options: CompileCacheOptions = {}): CompileCache {
  const version = options.version ?? compilerVersion();

  const keyFor = (source: string, filePath: string = DEFAULT_FILE_PATH): string => {
    const payload = [
      `bridge-compile-cache/v${CACHE_FORMAT_VERSION}`,
      version,
      filePath,
      source,
    ].join('\u0000');
    return createHash('sha256').update(payload, 'utf8').digest('hex');
  };

  const entryPath = (key: string): string => join(dir, `${key}.json`);

  return {
    dir,
    version,
    keyFor,
    sourceHash: (source: string) => createHash('sha256').update(source, 'utf8').digest('hex'),
    get(source: string, filePath: string = DEFAULT_FILE_PATH): CompileResult | undefined {
      let raw: string;
      try {
        raw = readFileSync(entryPath(keyFor(source, filePath)), 'utf8');
      } catch {
        return undefined; // missing dir/file or unreadable → miss
      }
      let entry: unknown;
      try {
        entry = JSON.parse(raw);
      } catch {
        return undefined; // torn/corrupt entry → miss
      }
      if (!isEntry(entry) || entry.compilerVersion !== version) {
        return undefined;
      }
      if (entry.sourceHash !== createHash('sha256').update(source, 'utf8').digest('hex')) {
        return undefined; // hash collision paranoia — treat as a miss
      }
      if (!isCompileResultLike(entry.result)) {
        return undefined;
      }
      return entry.result;
    },
    set(source: string, result: CompileResult, filePath: string = DEFAULT_FILE_PATH): void {
      const entry = {
        cacheFormatVersion: CACHE_FORMAT_VERSION,
        compilerVersion: version,
        sourceHash: createHash('sha256').update(source, 'utf8').digest('hex'),
        filePath,
        result,
      };
      mkdirSync(dir, { recursive: true });
      const final = entryPath(keyFor(source, filePath));
      const tmp = `${final}.tmp-${process.pid}-${nextTmpCounter()}`;
      writeFileSync(tmp, JSON.stringify(entry), 'utf8');
      renameSync(tmp, final);
    },
  };
}

let tmpCounter = 0;
function nextTmpCounter(): number {
  tmpCounter += 1;
  return tmpCounter;
}

interface CacheEntryShape {
  compilerVersion: string;
  sourceHash: string;
  result: unknown;
}

function isEntry(value: unknown): value is CacheEntryShape {
  if (value === null || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return typeof record.compilerVersion === 'string' && typeof record.sourceHash === 'string';
}

/** Minimal structural validation so a hand-edited file can't poison callers. */
function isCompileResultLike(value: unknown): value is CompileResult {
  if (value === null || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  if (typeof record.ok !== 'boolean' || !Array.isArray(record.diagnostics)) return false;
  if (record.ok && typeof record.ir !== 'object') return false;
  if (!record.ok && record.ir !== undefined) return false;
  for (const diagnostic of record.diagnostics as unknown[]) {
    if (diagnostic === null || typeof diagnostic !== 'object') return false;
    const d = diagnostic as Record<string, unknown>;
    if (
      typeof d.severity !== 'string' ||
      typeof d.code !== 'string' ||
      typeof d.message !== 'string' ||
      typeof d.file !== 'string' ||
      typeof d.line !== 'number' ||
      typeof d.column !== 'number'
    ) {
      return false;
    }
  }
  return true;
}
