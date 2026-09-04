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
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value)) as string;
}

function canonicalize(value: unknown): unknown {
  if (value === null) return null;
  if (Array.isArray(value)) {
    return value.map((item) => canonicalize(item));
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v === undefined) continue;
      out[key] = canonicalize(v);
    }
    return out;
  }
  return value;
}

/**
 * SHA-256 of the canonical JSON encoding of the package, hex-encoded.
 * Identical IR must always produce an identical digest.
 */
export function hashPackage(ir: IRPackage): string {
  return createHash('sha256').update(canonicalJson(ir), 'utf8').digest('hex');
}

/** Short 12-char digest for display (`bridge inspect`, reports). */
export function shortHash(ir: IRPackage): string {
  return hashPackage(ir).slice(0, 12);
}
