import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeCbor, encodeCbor, valueEquals, valueFromTagged } from '../index';
import { BridgeSet, BridgeTimestamp } from '../types';

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

function unhex(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, 'hex'));
}

const b = (...xs: number[]) => new Uint8Array(xs);

function assertRoundTrip(value: Parameters<typeof encodeCbor>[0], expectedHex: string): void {
  const encoded = encodeCbor(value);
  assert.equal(hex(encoded), expectedHex, `encode mismatch for ${String(value)}`);
  const decoded = decodeCbor(unhex(expectedHex));
  assert.ok(valueEquals(decoded, value as never), `decode mismatch for ${expectedHex}`);
}

test('cbor: simple values (false/true/null)', () => {
  assertRoundTrip(false, 'f4');
  assertRoundTrip(true, 'f5');
  assertRoundTrip(null, 'f6');
});

test('cbor: unsigned ints use minimal-length arguments (major 0)', () => {
  assertRoundTrip(0n, '00');
  assertRoundTrip(23n, '17');
  assertRoundTrip(24n, '1818');
  assertRoundTrip(255n, '18ff');
  assertRoundTrip(256n, '190100');
  assertRoundTrip(65535n, '19ffff');
  assertRoundTrip(65536n, '1a00010000');
  assertRoundTrip(4294967295n, '1affffffff');
  assertRoundTrip(4294967296n, '1b0000000100000000');
  assertRoundTrip(18446744073709551615n, '1bffffffffffffffff');
});

test('cbor: negative ints are -1-n (major 1)', () => {
  assertRoundTrip(-1n, '20');
  assertRoundTrip(-24n, '37');
  assertRoundTrip(-25n, '3818');
  // -256 → n = 255 → minimal one-byte argument (RFC 8949 preferred form;
  // byte-verified against Python cbor2).
  assertRoundTrip(-256n, '38ff');
  assertRoundTrip(-257n, '390100');
  assertRoundTrip(-65536n, '39ffff');
  assertRoundTrip(-65537n, '3a00010000');
  assertRoundTrip(-4294967296n, '3affffffff');
  // int64 floor: -2^63 → n = 2^63 - 1
  assertRoundTrip(-9223372036854775808n, '3b7fffffffffffffff');
});

test('cbor: int64 values beyond 2^53 stay exact', () => {
  assertRoundTrip(9007199254740993n, '1b0020000000000001');
  // -9007199254740993 → n = 9007199254740992
  assertRoundTrip(-9007199254740993n, '3b0020000000000000');
});

test('cbor: floats are always binary64 (0xfb)', () => {
  assertRoundTrip(3.14, 'fb40091eb851eb851f');
  assertRoundTrip(1.0, 'fb3ff0000000000000');
  assertRoundTrip(-0.5, 'fbbfe0000000000000');
});

test('cbor: definite-length text strings (major 3)', () => {
  assertRoundTrip('', '60');
  assertRoundTrip('a', '6161');
  assertRoundTrip('héllo 🌉 世界', '7268c3a96c6c6f20f09f8c8920e4b896e7958c');
  const long = 'x'.repeat(256); // 256 needs a 2-byte argument: 0x79 (ai 25) 0x0100
  assertRoundTrip(long, '790100' + '78'.repeat(256));
});

test('cbor: byte strings (major 2)', () => {
  assertRoundTrip(b(), '40');
  assertRoundTrip(b(0, 1, 2, 255), '44000102ff');
  assertRoundTrip(b(...new Array(256).fill(7)), '590100' + '07'.repeat(256));
});

test('cbor: arrays (major 4, definite length)', () => {
  assertRoundTrip([], '80');
  assertRoundTrip([1n, 2n, 3n], '83010203');
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
  // [1, "two", false, null, 3.5] — byte-verified against Python cbor2.
  assertRoundTrip(tagged, '85016374776ff4f6fb400c000000000000');
});

test('cbor: maps sort keys by UTF-8 bytes (major 5, definite length)', () => {
  assertRoundTrip({}, 'a0');
  assertRoundTrip({ b: 1n, a: 2n }, 'a2616102616201');
  assertRoundTrip({ 'é': 1n, a: 2n }, 'a261610262c3a901');
});

test('cbor: undefined map values are absent keys', () => {
  // "missing" is dropped; keys sort by UTF-8 bytes: "nulled" (6e) < "present" (70).
  assertRoundTrip({ present: 'x', missing: undefined, nulled: null }, 'a2666e756c6c6564f66770726573656e746178');
});

test('cbor: timestamp is Tag(1) with binary64 epoch seconds', () => {
  assertRoundTrip(new BridgeTimestamp(1717515600n), 'c1fb41d997cd54000000');
  assertRoundTrip(new BridgeTimestamp(0n), 'c1fb0000000000000000');
});

test('cbor: decodes integer-tag epochs and half/single floats leniently', () => {
  // Tag 1 with an integer content (RFC 8949 §3.4.2 preferred form): 0xc1 0x00
  const t = decodeCbor(unhex('c100')) as unknown;
  assert.ok(t instanceof BridgeTimestamp);
  assert.equal((t as BridgeTimestamp).seconds, 0n);
  // half-float 1.0 (0xf9 0x3c00) decodes (widened) to 1.0
  assert.equal(decodeCbor(unhex('f93c00')), 1.0);
});

test('cbor: sets encode as sorted deduped arrays (decode sees plain arrays)', () => {
  const nums = new BridgeSet([3n, 1n, 2n, 1n]);
  assert.equal(hex(encodeCbor(nums)), '83010203');
  assert.ok(valueEquals(decodeCbor(unhex('83010203')), nums.entries as never));

  const strs = new BridgeSet(['b', 'a', 'b']);
  assert.equal(hex(encodeCbor(strs)), '8261616162');
  assert.ok(valueEquals(decodeCbor(unhex('8261616162')), strs.entries as never));
});

test('cbor: rejects values outside the profile', () => {
  assert.throws(() => encodeCbor(2n ** 64n), RangeError); // > uint64
  assert.throws(() => encodeCbor(Number.NaN), RangeError);
  assert.throws(() => encodeCbor(undefined as never)); // undefined is not a top-level value
  assert.throws(() => encodeCbor(new Map() as never)); // only BridgeMap objects
  assert.throws(() => decodeCbor(unhex('5fff'))); // indefinite byte string
  assert.throws(() => decodeCbor(unhex('c201'))); // tag 2 (bignum) unsupported
  assert.throws(() => decodeCbor(unhex('f800'))); // unknown simple value
  assert.throws(() => decodeCbor(unhex('a1'))); // truncated
});

test('cbor: deep round-trip of a struct-like map', () => {
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
  const encoded = encodeCbor(value);
  assert.ok(valueEquals(decodeCbor(encoded), value as never));
});
