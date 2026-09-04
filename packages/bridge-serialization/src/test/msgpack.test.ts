import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeMsgpack, encodeMsgpack, valueFromTagged, valueEquals } from '../index';
import { BridgeSet, BridgeTimestamp } from '../types';

/** Hex helpers — expected byte strings in this file are hand-computed. */
function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

function unhex(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, 'hex'));
}

const b = (...xs: number[]) => new Uint8Array(xs);

function assertRoundTrip(value: Parameters<typeof encodeMsgpack>[0], expectedHex: string): void {
  const encoded = encodeMsgpack(value);
  assert.equal(hex(encoded), expectedHex, `encode mismatch for ${JSON.stringify(String(value))}`);
  const decoded = decodeMsgpack(unhex(expectedHex));
  assert.ok(valueEquals(decoded, value as never), `decode mismatch for ${expectedHex}`);
}

test('msgpack: nil and bools', () => {
  assertRoundTrip(null, 'c0');
  assertRoundTrip(false, 'c2');
  assertRoundTrip(true, 'c3');
});

test('msgpack: unsigned ints use minimal uint encodings', () => {
  assertRoundTrip(0n, '00');
  assertRoundTrip(127n, '7f');
  assertRoundTrip(128n, 'cc80');
  assertRoundTrip(255n, 'ccff');
  assertRoundTrip(256n, 'cd0100');
  assertRoundTrip(65535n, 'cdffff');
  assertRoundTrip(65536n, 'ce00010000');
  assertRoundTrip(4294967295n, 'ceffffffff');
  assertRoundTrip(4294967296n, 'cf0000000100000000');
  assertRoundTrip(18446744073709551615n, 'cfffffffffffffffff');
});

test('msgpack: negative ints use minimal signed encodings', () => {
  assertRoundTrip(-1n, 'ff');
  assertRoundTrip(-32n, 'e0');
  assertRoundTrip(-33n, 'd0df');
  assertRoundTrip(-128n, 'd080');
  assertRoundTrip(-129n, 'd1ff7f');
  assertRoundTrip(-32768n, 'd18000');
  assertRoundTrip(-32769n, 'd2ffff7fff');
  assertRoundTrip(-2147483648n, 'd280000000');
  assertRoundTrip(-2147483649n, 'd3ffffffff7fffffff');
  assertRoundTrip(-9223372036854775808n, 'd38000000000000000');
});

test('msgpack: int64 values beyond 2^53 stay exact', () => {
  // The canonical large-integer vector: Number(9007199254740993) is already
  // off by one, so bigint handling is not optional.
  assertRoundTrip(9007199254740993n, 'cf0020000000000001');
  assertRoundTrip(-9007199254740993n, 'd3ffdfffffffffffff');
});

test('msgpack: floats are always binary64 (0xcb)', () => {
  assertRoundTrip(3.14, 'cb40091eb851eb851f');
  assertRoundTrip(1.0, 'cb3ff0000000000000');
  assertRoundTrip(-0.5, 'cbbfe0000000000000');
});

test('msgpack: strings (fixstr/str8/str16)', () => {
  assertRoundTrip('', 'a0');
  assertRoundTrip('a', 'a161');
  // 18 UTF-8 bytes → fixstr 0xb2 (0xa0 | 18); byte-verified against Python msgpack.
  assertRoundTrip('héllo 🌉 世界', 'b268c3a96c6c6f20f09f8c8920e4b896e7958c');
  const long = 'x'.repeat(32); // fixstr holds ≤31, so 32 → str8
  assertRoundTrip(long, 'd920' + '78'.repeat(32));
  const longer = 'y'.repeat(256); // str8 holds ≤255, so 256 → str16
  assertRoundTrip(longer, 'da0100' + '79'.repeat(256));
});

test('msgpack: bytes use bin family', () => {
  assertRoundTrip(b(), 'c400');
  assertRoundTrip(b(0, 1, 2, 255), 'c404000102ff');
  assertRoundTrip(b(...new Array(256).fill(7)), 'c50100' + '07'.repeat(256));
});

test('msgpack: arrays (fixarray/array16)', () => {
  assertRoundTrip([], '90');
  assertRoundTrip([1n, 2n, 3n], '93010203');
  const tagged = valueFromTagged({
    t: 'array',
    v: [
      { t: 'i64', v: '1' },
      { t: 'str', v: 'two' },
      { t: 'bool', v: false },
      { t: 'null' },
      { t: 'f64', v: 3.5 },
    ],
  });
  // [1, "two", false, null, 3.5] — byte-verified against Python msgpack.
  assertRoundTrip(tagged, '9501a374776fc2c0cb400c000000000000');
});

test('msgpack: maps sort keys by UTF-8 bytes', () => {
  assertRoundTrip({}, '80');
  // {"b":1,"a":2} encodes as {"a":2,"b":1}
  assertRoundTrip({ b: 1n, a: 2n }, '82a16102a16201');
  // non-ASCII keys order by UTF-8 bytes: "a" (61) < "é" (c3 a9)
  assertRoundTrip({ 'é': 1n, a: 2n }, '82a16102a2c3a901');
});

test('msgpack: undefined map values are absent keys', () => {
  // "missing" is dropped; keys sort by UTF-8 bytes: "nulled" (6e) < "present" (70).
  assertRoundTrip({ present: 'x', missing: undefined, nulled: null }, '82a66e756c6c6564c0a770726573656e74a178');
});

test('msgpack: timestamp is ext(-1) in timestamp96 form', () => {
  const t = new BridgeTimestamp(1717515600n);
  assertRoundTrip(t, 'c70cff0000000000000000665f3550');
  const t0 = new BridgeTimestamp(0n);
  assertRoundTrip(t0, 'c70cff000000000000000000000000');
});

test('msgpack: decodes timestamp 32/64 forms for interoperability', () => {
  // timestamp 32: d6 ff <u32 seconds>
  const t32 = decodeMsgpack(unhex('d6ff665f3550'));
  assert.ok(t32 instanceof BridgeTimestamp);
  assert.equal((t32 as BridgeTimestamp).seconds, 1717515600n);
  // timestamp 64: c7 08 ff <nanos<<2 | seconds (34 bits)>
  const packed = (0n << 34n) | 1717515600n;
  const t64 = decodeMsgpack(unhex('c708ff' + packed.toString(16).padStart(16, '0')));
  assert.ok(t64 instanceof BridgeTimestamp);
  assert.equal((t64 as BridgeTimestamp).seconds, 1717515600n);
});

test('msgpack: sets encode as sorted deduped arrays (decode sees plain arrays)', () => {
  const nums = new BridgeSet([3n, 1n, 2n, 1n]);
  assert.equal(hex(encodeMsgpack(nums)), '93010203');
  assert.ok(valueEquals(decodeMsgpack(unhex('93010203')), nums.entries as never));

  const strs = new BridgeSet(['b', 'a', 'b']);
  assert.equal(hex(encodeMsgpack(strs)), '92a161a162');
  assert.ok(valueEquals(decodeMsgpack(unhex('92a161a162')), strs.entries as never));
});

test('msgpack: rejects values outside the profile', () => {
  assert.throws(() => encodeMsgpack(9007199254740993n * 1000000n), RangeError); // > u64
  assert.throws(() => encodeMsgpack(Number.NaN), RangeError); // non-finite float
  assert.throws(() => encodeMsgpack(undefined as never)); // undefined is not a top-level value
  assert.throws(() => encodeMsgpack(new Map() as never)); // only BridgeMap objects
  assert.throws(() => decodeMsgpack(unhex('c70120ff'))); // ext type 32 is not in the profile
  assert.throws(() => decodeMsgpack(unhex('c0ff00'))); // trailing garbage
  assert.throws(() => decodeMsgpack(unhex('92'))); // truncated array
});

test('msgpack: deep round-trip of a struct-like map', () => {
  const value = valueFromTagged({
    t: 'map',
    v: {
      id: { t: 'str', v: 'pay_01' },
      amount: { t: 'decimal', v: '19.99' },
      created: { t: 'timestamp', iso: '2024-06-04T17:00:00Z' },
      meta: { t: 'map', v: { retry: { t: 'bool', v: false }, attempts: { t: 'i64', v: '2' } } },
      receipt: { t: 'bytes', b64: 'AAEC/w==' },
      tags: { t: 'set', v: [{ t: 'str', v: 'card' }, { t: 'str', v: 'recurring' }] },
      voided_at: { t: 'null' },
    },
  });
  const encoded = encodeMsgpack(value);
  assert.ok(valueEquals(decodeMsgpack(encoded), value as never));
});
