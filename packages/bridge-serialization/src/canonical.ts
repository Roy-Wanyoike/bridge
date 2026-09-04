/**
 * Canonical JSON encoding of Bridge values.
 *
 * Mirrors the canonicalization approach of `@bridge/core`'s IR hashing
 * (packages/bridge-core/src/ir/hash.ts) — object keys sorted, arrays kept in
 * contract order, no insignificant whitespace, absent keys omitted — extended
 * with the Bridge value-model mappings that IR hashing never sees:
 *
 *   bigint            → bare integer digits (int64/uint64 are never floats)
 *   number (f64)      → ECMAScript shortest round-trip formatting
 *   Uint8Array        → RFC 4648 base64 (standard alphabet, padded)
 *   BridgeTimestamp   → RFC 3339 UTC string (…Z)
 *   BridgeSet         → already-sorted array
 *   map keys          → sorted by UTF-8 byte order (language-neutral total
 *                       order; matches CBOR bytewise key sorting)
 *
 * Canonical JSON is the human-readable member of the serialization matrix.
 * It is lossy by design for two cases, both documented in the wire spec:
 * non-finite floats (rejected by the binary codecs, mapped to `null` here)
 * and map entries whose value is `undefined` (absent keys are omitted).
 */
import {
  BridgeSet,
  BridgeTimestamp,
  BridgeMap,
  BridgeValue,
  sortedMapKeys,
} from './types';

export function canonicalJson(value: BridgeValue): string {
  return writeCanonical(value);
}

function writeCanonical(value: BridgeValue): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number') {
    // ECMAScript Number::toString — shortest round-trip. NaN/±Infinity are
    // not Bridge values; canonical JSON degrades them to null (documented).
    return JSON.stringify(value);
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (value instanceof Uint8Array) {
    return JSON.stringify(Buffer.from(value).toString('base64'));
  }
  if (value instanceof BridgeTimestamp) {
    return JSON.stringify(value.toISO());
  }
  if (value instanceof BridgeSet) {
    return writeArray(value.entries);
  }
  if (Array.isArray(value)) {
    return writeArray(value);
  }
  // BridgeMap: sorted keys, undefined = absent.
  const map = value as BridgeMap;
  const keys = sortedMapKeys(map);
  const parts = keys.map((key) => `${JSON.stringify(key)}:${writeCanonical(map[key] as BridgeValue)}`);
  return `{${parts.join(',')}}`;
}

function writeArray(items: readonly BridgeValue[]): string {
  return `[${items.map(writeCanonical).join(',')}]`;
}
