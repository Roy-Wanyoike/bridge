/**
 * Property tests for the deterministic compilation cache (src/cache.ts).
 *
 * Core guarantee: a cache hit is indistinguishable from a fresh compile —
 * deep-equal AND byte-identical JSON (key order included), identical package
 * hash for ok results. The generator feeds random valid contracts; broken
 * sources (negative caching) are covered too.
 *
 * Seed 20250605, 150 fs-backed cases per property (file IO keeps the suites
 * honest but is deliberately not free).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCompileCache, CACHE_FORMAT_VERSION, compilerVersion } from '../../cache';
import { compileSource } from '../../compiler/compile';
import { hashPackage } from '../../ir/hash';
import type { CompileResult, IRPackage } from '../../ir/types';
import { generateContract } from './contract-gen';
import { property, Rng } from './harness';

const SEED = 20250605;
const CASES = 150;
const FILE = 'dist/test/property/cache.property.test.js';

const FILE_PATH = 'generated.bridge';

function freshCompile(source: string): CompileResult {
  return compileSource(source, FILE_PATH);
}

// ---------------------------------------------------------------------------
// Round-trip properties
// ---------------------------------------------------------------------------

property(
  'cache hits are byte-identical to fresh compiles (valid contracts)',
  { seed: SEED, iterations: CASES, file: FILE },
  (rng) => {
    const { source } = generateContract(rng);
    const dir = mkdtempSync(join(tmpdir(), 'bridge-cache-prop-'));
    try {
      const cache = createCompileCache(dir);
      const fresh = freshCompile(source);
      assert.equal(fresh.ok, true);

      cache.set(source, fresh, FILE_PATH);
      const cached = cache.get(source, FILE_PATH);

      assert.notEqual(cached, undefined, 'set must be followed by a hit');
      assert.deepEqual(cached, fresh, 'cached result must deep-equal the fresh compile');
      assert.equal(
        JSON.stringify(cached),
        JSON.stringify(fresh),
        'cached result must serialize byte-identically to the fresh compile',
      );
      assert.equal(
        hashPackage((cached as CompileResult).ir as IRPackage),
        hashPackage(fresh.ir as IRPackage),
        'IR hash must be identical on a hit',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

property(
  'cache round-trips whatever the compiler returns (incl. failed compiles)',
  { seed: SEED + 1, iterations: CASES, file: FILE },
  (rng) => {
    const { source } = generateContract(rng);
    // Truncate at a random position: often invalid (negative caching), but
    // the property only requires hit === fresh, whatever the outcome is.
    const truncated = source.slice(0, rng.int(0, source.length - 1));
    const dir = mkdtempSync(join(tmpdir(), 'bridge-cache-prop-'));
    try {
      const cache = createCompileCache(dir);
      const fresh = freshCompile(truncated);
      cache.set(truncated, fresh, FILE_PATH);
      const cached = cache.get(truncated, FILE_PATH);
      assert.deepEqual(cached, fresh);
      assert.equal(JSON.stringify(cached), JSON.stringify(fresh));
      assert.equal(fresh.ok, cached?.ok);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

// ---------------------------------------------------------------------------
// Key semantics
// ---------------------------------------------------------------------------

test('cache: key is content-addressed (source + filePath + version + format)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-cache-key-'));
  try {
    const a = createCompileCache(dir);
    const b = createCompileCache(dir, { version: '9.9.9-test' });
    const { source } = generateContract(new Rng(1));

    assert.equal(a.keyFor(source), a.keyFor(source), 'same inputs ⇒ same key');
    assert.notEqual(a.keyFor(source), a.keyFor(source, 'other.bridge'), 'filePath changes the key');
    assert.notEqual(a.keyFor(source), b.keyFor(source), 'compiler version changes the key');
    assert.equal(a.sourceHash(source).length, 64);
    assert.equal(a.version, compilerVersion());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('cache: misses are undefined (unknown source, unknown filePath)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-cache-miss-'));
  try {
    const cache = createCompileCache(dir);
    const { source } = generateContract(new Rng(2));
    const other = `${source}\n// different`;
    cache.set(source, freshCompile(source), FILE_PATH);
    assert.equal(cache.get(other, FILE_PATH), undefined);
    assert.equal(cache.get(source, 'other.bridge'), undefined);
    assert.equal(cache.get(source), undefined); // default filePath ≠ ours
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('cache: entries persist across cache instances (same dir)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-cache-persist-'));
  try {
    const writer = createCompileCache(dir);
    const { source } = generateContract(new Rng(3));
    const fresh = freshCompile(source);
    writer.set(source, fresh, FILE_PATH);

    const reader = createCompileCache(dir);
    const cached = reader.get(source, FILE_PATH);
    assert.deepEqual(cached, fresh);
    assert.equal(JSON.stringify(cached), JSON.stringify(fresh));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Corruption / versioning safety
// ---------------------------------------------------------------------------

test('cache: corrupt or invalid entries are misses, never throws', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-cache-bad-'));
  try {
    const cache = createCompileCache(dir);
    const { source } = generateContract(new Rng(4));
    const fresh = freshCompile(source);
    cache.set(source, fresh, FILE_PATH);
    assert.notEqual(cache.get(source, FILE_PATH), undefined);

    const entryPath = join(dir, `${cache.keyFor(source, FILE_PATH)}.json`);

    // 1. torn write: invalid JSON
    writeFileSync(entryPath, '{"cacheFormatVersion": 1, "resu', 'utf8');
    assert.equal(cache.get(source, FILE_PATH), undefined);

    // 2. valid JSON, wrong shape
    writeFileSync(entryPath, JSON.stringify({ hello: 'world' }), 'utf8');
    assert.equal(cache.get(source, FILE_PATH), undefined);

    // 3. result shape violated (ok=true without ir)
    const broken = JSON.parse(readFileSync(entryPath, 'utf8'));
    writeFileSync(
      entryPath,
      JSON.stringify({ ...broken, result: { ok: true, diagnostics: [] } }),
      'utf8',
    );
    assert.equal(cache.get(source, FILE_PATH), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('cache: compiler-version mismatch invalidates entries', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-cache-ver-'));
  try {
    const { source } = generateContract(new Rng(5));
    const fresh = freshCompile(source);

    const v1 = createCompileCache(dir, { version: '1.0.0' });
    v1.set(source, fresh, FILE_PATH);
    assert.notEqual(v1.get(source, FILE_PATH), undefined);

    const v2 = createCompileCache(dir, { version: '2.0.0' });
    assert.equal(v2.get(source, FILE_PATH), undefined, 'other compiler version must miss');

    // …and writing under v2 does not disturb v1's entry.
    v2.set(source, fresh, FILE_PATH);
    assert.notEqual(v1.get(source, FILE_PATH), undefined);
    assert.notEqual(v2.get(source, FILE_PATH), undefined);
    assert.equal(readdirSync(dir).filter((f) => f.endsWith('.json')).length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('cache: set writes atomically (no .tmp leftovers) and get never throws on missing dirs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-cache-atomic-'));
  try {
    const cache = createCompileCache(dir);
    const { source } = generateContract(new Rng(6));
    cache.set(source, freshCompile(source), FILE_PATH);
    assert.deepEqual(
      readdirSync(dir).filter((f) => f.includes('.tmp-')),
      [],
      'atomic rename must leave no temp files',
    );

    const empty = createCompileCache(join(dir, 'does-not-exist'));
    assert.equal(empty.get(source, FILE_PATH), undefined, 'missing dir is a miss, not a throw');
    assert.equal(existsSync(join(dir, 'does-not-exist')), false, 'get must not create directories');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('cache: format version is exposed and stable', () => {
  assert.equal(typeof CACHE_FORMAT_VERSION, 'number');
  assert.ok(CACHE_FORMAT_VERSION >= 1);
});
