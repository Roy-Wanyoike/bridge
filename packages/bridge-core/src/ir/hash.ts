/**
 * Deterministic hashing for the canonical IR.
 *
 * The schema hash is the identity of a contract version: the registry keys
 * stored artifacts by it, the compatibility engine compares by it, and cache
 * entries are keyed by it. It must be byte-stable across machines and time.
 */
import { createHash } from 'node:crypto';
import type { IRPackage } from './types';

/**
 * Produce canonical JSON: object keys sorted recursively, arrays kept in
 * order (IR contract guarantees semantic order), no insignificant
 * whitespace. Undefined properties are omitted.
 *
 * ADDITIVE PARAMETER (registry-service security wave, issue #48 — this file
 * is otherwise owned by the compiler wave): `maxDepth` bounds recursion so
 * a hostile, deeply nested document throws `RangeError` instead of
 * exhausting the stack. The default `Infinity` preserves the previous
 * behavior byte for byte; compiler/hash callers pass nothing.
 *
 * NOTE (core-compiler agent): the recovered scaffold returned the
 * intermediate canonicalized *object* here (with an `as string` cast), which
 * made `hashPackage` throw on every call. The `JSON.stringify` step is the
 * missing final encoding — this fix restores the documented contract and
 * does not change the digest format: SHA-256 of the UTF-8 canonical JSON.
 */
export function canonicalJson(value: unknown, maxDepth: number = Number.POSITIVE_INFINITY): string {
  return JSON.stringify(canonicalize(value, 0, maxDepth));
}

function canonicalize(value: unknown, depth: number, maxDepth: number): unknown {
  if (depth > maxDepth) {
    throw new RangeError(`canonicalJson: document nesting exceeds maxDepth ${maxDepth}`);
  }
  if (value === null) return null;
  if (Array.isArray(value)) {
    return value.map((item) => canonicalize(item, depth + 1, maxDepth));
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v === undefined) continue;
      out[key] = canonicalize(v, depth + 1, maxDepth);
    }
    return out;
  }
  return value;
}

/**
 * SHA-256 of the canonical JSON encoding of the package, hex-encoded.
 * Identical IR must always produce an identical digest.
 *
 * `maxDepth` mirrors {@link canonicalJson} (default `Infinity` — unchanged
 * behavior; the registry service passes a cap for untrusted payloads).
 */
export function hashPackage(ir: IRPackage, maxDepth: number = Number.POSITIVE_INFINITY): string {
  return createHash('sha256').update(canonicalJson(ir, maxDepth), 'utf8').digest('hex');
}

/** Short 12-char digest for display (`bridge inspect`, reports). */
export function shortHash(ir: IRPackage): string {
  return hashPackage(ir).slice(0, 12);
}
