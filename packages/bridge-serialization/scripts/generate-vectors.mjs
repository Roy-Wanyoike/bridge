#!/usr/bin/env node
/**
 * Generates the cross-language golden vectors committed under
 * packages/bridge-serialization/vectors/. Every runtime verifier (Go, Rust,
 * Python, TypeScript) asserts byte-identical encode/decode behavior against
 * these files, which makes the wire contract executable.
 *
 * Deterministic: the values below are fixed literals — regenerating always
 * produces byte-identical vector files.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import pkg from '../dist/index.js';
const { encodeCbor, encodeMsgpack, canonicalJson, valueToTagged } = pkg;
import { BridgeSet, BridgeTimestamp } from '../dist/types.js';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(here, '..', 'vectors');
fs.mkdirSync(outDir, { recursive: true });

const enc = (id, value) => ({
  id,
  /** Tagged model — the unambiguous mapping every runtime implements. */
  model: valueToTagged(value),
  /** Canonical JSON of the value (integers as exact digits). */
  json: canonicalJson(value),
  msgpack: Buffer.from(encodeMsgpack(value)).toString('hex'),
  cbor: Buffer.from(encodeCbor(value)).toString('hex'),
});

const vectors = [
  // --- scalars ------------------------------------------------------------
  enc('null', null),
  enc('true', true),
  enc('false', false),
  enc('int_zero', 0n),
  enc('int_small', 42n),
  enc('int_u8_max', 255n),
  enc('int_u16_max', 65535n),
  enc('int_u32_max', 4294967295n),
  enc('int_u64_max', 18446744073709551615n),
  enc('int_neg_one', -1n),
  enc('int_neg_i8_min', -128n),
  enc('int_neg_i16_min', -32768n),
  enc('int_neg_i32_min', -2147483648n),
  enc('int_neg_i64_min', -9223372036854775808n),
  enc('int_beyond_2p53', 9007199254740993n),
  enc('int_neg_beyond_2p53', -9007199254740993n),
  enc('float_zero', 0.0),
  enc('float_pi', 3.14),
  enc('float_neg_half', -0.5),
  enc('float_large', 1e300),
  enc('string_empty', ''),
  enc('string_ascii', 'hello'),
  enc('string_unicode', 'héllo 🌉 世界'),
  enc('string_32', 'x'.repeat(32)),
  enc('string_256', 'y'.repeat(256)),
  enc('bytes_empty', new Uint8Array(0)),
  enc('bytes_small', new Uint8Array([0, 1, 2, 255])),
  enc('bytes_256', new Uint8Array(256).fill(7)),
  enc('timestamp_epoch', new BridgeTimestamp(1717515600n)),
  enc('timestamp_nanos', new BridgeTimestamp(1717515600n, 500_000_000)),
  enc('timestamp_epoch_zero', new BridgeTimestamp(0n)),
  // --- collections ----------------------------------------------------------
  enc('array_empty', []),
  enc('array_mixed', [1n, 'two', false, null, 3.5]),
  enc('map_empty', {}),
  enc('map_sorted', { b: 1n, a: 2n }),
  enc('map_unicode_keys', { 'é': 1n, a: 2n }),
  enc('map_undefined_dropped', { present: 'x', missing: undefined, nulled: null }),
  enc('set_ints', new BridgeSet([3n, 1n, 2n, 1n])),
  enc('set_strings', new BridgeSet(['b', 'a', 'b'])),
  // --- nested struct-like value ------------------------------------------
  enc('nested_struct', {
    id: 'pay_01',
    amount: '19.99',
    created: new BridgeTimestamp(1717520400n),
    meta: { retry: false, attempts: 2n },
    receipt: new Uint8Array([0, 1, 2, 255]),
    tags: new BridgeSet(['card', 'recurring']),
    voided_at: null,
    optional_absent: undefined,
    flag: true,
    ratio: -0.5,
    big: 9007199254740993n,
  }),
];

// The canonical JSON string is the decoded expectation. It is written as a
// STRING (not re-parsed) so integers beyond 2^53 keep exact digits — every
// runtime parses it with bigint-aware JSON parsing (Python int, Go json.Number,
// Rust serde_json arbitrary_precision off + i64/u64 pass, TS via BigInt revival
// in the verifier).
const payload = {
  profile: 'bridge-serialization v1 (docs/SERIALIZATION.md)',
  vectors,
};
fs.writeFileSync(path.join(outDir, 'vectors.json'), JSON.stringify(payload, null, 2) + '\n');
console.log(`wrote ${vectors.length} vectors to ${path.join(outDir, 'vectors.json')}`);
