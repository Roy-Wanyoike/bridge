/**
 * Property-based tests for the serialization codecs.
 *
 * Over seeded, generated BridgeValue trees (within the wire profile):
 *  - round-trip byte identity: encode → decode → encode is byte-identical
 *    for BOTH MessagePack and CBOR;
 *  - value stability: decode(encode(v)) deep-equals v (via valueToTagged);
 *  - decoder robustness (fuzz): mutated/truncated/spliced valid bytes never
 *    throw a non-Error, never hang, and any successful decode re-encodes to
 *    bytes that decode to the same value again.
 *
 * Reproduce a failure with: BRIDGE_PROPERTY_SEED=<seed> BRIDGE_PROPERTY_CASE=<n>
 *   npm test --workspace @bridge/serialization
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  decodeCbor,
  decodeMsgpack,
  encodeCbor,
  encodeMsgpack,
  valueEquals,
  valueToTagged,
} from '../../index';
import type { BridgeValue } from '../../types';
import { property, Rng } from '@bridge/core/dist/test/property/harness';

// ---------------------------------------------------------------------------
// Value generator (within the BridgeValue wire profile)
// ---------------------------------------------------------------------------

const MAX_DEPTH = 3;

function genValue(rng: Rng, depth: number): BridgeValue {
  const kinds =
    depth >= MAX_DEPTH
      ? ['int', 'negint', 'float', 'string', 'bytes', 'bool', 'null']
      : ['int', 'negint', 'float', 'string', 'bytes', 'bool', 'null', 'array', 'map', 'set'];
  const kind = rng.pick(kinds);
  switch (kind) {
    case 'int':
      return BigInt(rng.int(0, 2 ** 53));
    case 'negint':
      return -BigInt(rng.int(0, 2 ** 31));
    case 'float': {
      const pick = rng.int(0, 2);
      if (pick === 0) return rng.float() * 2 ** rng.int(-30, 30);
      if (pick === 1) return -rng.float();
      return Number((rng.float() * 100).toFixed(6));
    }
    case 'string': {
      const len = rng.int(0, 40);
      let s = '';
      for (let i = 0; i < len; i++) {
        s += rng.pick(['a', 'b', 'z', 'é', ' Bridge ', '🎉', '0', '_'] as const);
      }
      return s;
    }
    case 'bytes': {
      const len = rng.int(0, 48);
      const out = new Uint8Array(len);
      for (let i = 0; i < len; i++) out[i] = rng.int(0, 255);
      return out;
    }
    case 'bool':
      return rng.bool();
    case 'null':
      return null;
    case 'array': {
      const len = rng.int(0, 5);
      const out: BridgeValue[] = [];
      for (let i = 0; i < len; i++) out.push(genValue(rng, depth + 1));
      return out;
    }
    case 'map': {
      const len = rng.int(0, 5);
      const out: Record<string, BridgeValue> = {};
      for (let i = 0; i < len; i++) {
        out[`k${i}_${rng.int(0, 99)}`] = genValue(rng, depth + 1);
      }
      return out;
    }
    case 'set': {
      const len = rng.int(0, 5);
      const out: BridgeValue[] = [];
      for (let i = 0; i < len; i++) {
        const pick = rng.int(0, 1);
        out.push(pick === 0 ? BigInt(rng.int(0, 50)) : rng.pick(['x', 'y', 'z']));
      }
      return out as BridgeValue; // BridgeSet normalization happens in the codec tests
    }
    default:
      throw new Error(`unreachable kind ${kind}`);
  }
}

/** Mutation strategies for the decoder fuzz. */
function mutateBytes(rng: Rng, bytes: Uint8Array): Uint8Array {
  const out = Uint8Array.from(bytes);
  const strategy = rng.int(0, 3);
  switch (strategy) {
    case 0: {
      // truncate
      const keep = rng.int(0, Math.max(0, out.length - 1));
      return out.slice(0, keep);
    }
    case 1: {
      // flip one byte
      if (out.length > 0) {
        const i = rng.int(0, out.length - 1);
        const current = out[i] as number;
        out[i] = (current + rng.int(1, 255)) % 256;
      }
      return out;
    }
    case 2: {
      // splice random bytes in
      const insertLen = rng.int(1, 8);
      const insert = new Uint8Array(insertLen);
      for (let i = 0; i < insertLen; i++) insert[i] = rng.int(0, 255);
      const pos = rng.int(0, out.length);
      const merged = new Uint8Array(out.length + insertLen);
      merged.set(out.slice(0, pos), 0);
      merged.set(insert, pos);
      merged.set(out.slice(pos), pos + insertLen);
      return merged;
    }
    default: {
      // append junk
      const junk = new Uint8Array(rng.int(1, 6));
      for (let i = 0; i < junk.length; i++) junk[i] = rng.int(0, 255);
      const merged = new Uint8Array(out.length + junk.length);
      merged.set(out, 0);
      merged.set(junk, out.length);
      return merged;
    }
  }
}

/** Feed a decoder, catching anything non-Error as a hard failure. */
function decodeSafely(decode: (b: Uint8Array) => BridgeValue, bytes: Uint8Array): { ok: true; value: BridgeValue } | { ok: false; error: unknown } {
  try {
    return { ok: true, value: decode(bytes) };
  } catch (error) {
    return { ok: false, error };
  }
}

function assertErrorIsError(error: unknown, label: string): void {
  if (error instanceof Error) return;
  throw new Error(`${label}: decoder threw a non-Error value: ${String(error)}`);
}

// ---------------------------------------------------------------------------
// Properties
// ---------------------------------------------------------------------------

property(
  'serialization: msgpack encode→decode→encode is byte-identical over generated values',
  { seed: 20260910, iterations: 300 },
  (rng) => {
    const value = genValue(rng, 0);
    const first = encodeMsgpack(value);
    const decoded = decodeMsgpack(first);
    const second = encodeMsgpack(decoded);
    assert.deepEqual(
      Buffer.from(first).toString('hex'),
      Buffer.from(second).toString('hex'),
      `msgpack round-trip bytes differ for ${JSON.stringify(valueToTagged(value))}`,
    );
    assert.deepEqual(
      valueToTagged(decoded),
      valueToTagged(value),
      'msgpack decoded value differs from the original',
    );
  },
);

property(
  'serialization: cbor encode→decode→encode is byte-identical over generated values',
  { seed: 20260911, iterations: 300 },
  (rng) => {
    const value = genValue(rng, 0);
    const first = encodeCbor(value);
    const decoded = decodeCbor(first);
    const second = encodeCbor(decoded);
    assert.deepEqual(
      Buffer.from(first).toString('hex'),
      Buffer.from(second).toString('hex'),
      `cbor round-trip bytes differ for ${JSON.stringify(valueToTagged(value))}`,
    );
    assert.ok(valueEquals(decoded, value), 'cbor decoded value differs from the original');
  },
);

property(
  'serialization: decoders never throw non-Errors on mutated bytes and stay stable',
  { seed: 20260912, iterations: 400 },
  (rng) => {
    const seedValue = genValue(rng, 1);
    const base = rng.bool() ? encodeMsgpack(seedValue) : encodeCbor(seedValue);
    const mutated = mutateBytes(rng, base);
    const isMsgpack = Buffer.from(base).toString('hex') === Buffer.from(encodeMsgpack(seedValue)).toString('hex');
    const decode = isMsgpack ? decodeMsgpack : decodeCbor;
    const result = decodeSafely(decode, mutated);
    if (result.ok) {
      // Whatever decoded must re-encode to bytes that decode to the same value.
      const reencoded = isMsgpack ? encodeMsgpack(result.value) : encodeCbor(result.value);
      const again = decodeSafely(decode, reencoded);
      if (!again.ok) {
        assertErrorIsError(again.error, 'second decode');
        throw new Error(`second decode failed: ${String(again.error)}`);
      }
      if (!valueEquals(again.value, result.value)) {
        throw new Error('decode→encode→decode is not stable');
      }
    } else {
      assertErrorIsError(result.error, 'first decode');
    }
  },
);

// Guard: the generator actually exercises the interesting shapes.
test('serialization property generator: coverage smoke', () => {
  const rng = new Rng(20260913);
  const seen = new Set<string>();
  for (let i = 0; i < 200; i++) {
    const v = genValue(rng, 0);
    seen.add(typeof v === 'bigint' ? 'bigint' : v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);
  }
  for (const kind of ['bigint', 'number', 'string', 'boolean', 'object', 'null', 'array']) {
    assert.ok(seen.has(kind), `generator never produced ${kind}`);
  }
});
