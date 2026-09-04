import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canonicalJson } from '../canonical';
import { BridgeSet, BridgeTimestamp, valueFromTagged } from '../index';

const bytes = (...xs: number[]) => new Uint8Array(xs);

test('canonical JSON: scalars', () => {
  assert.equal(canonicalJson(null), 'null');
  assert.equal(canonicalJson(true), 'true');
  assert.equal(canonicalJson(false), 'false');
  assert.equal(canonicalJson(0n), '0');
  assert.equal(canonicalJson(18446744073709551615n), '18446744073709551615');
  assert.equal(canonicalJson(-9223372036854775808n), '-9223372036854775808');
  // f64 always via ECMAScript shortest round-trip; integral floats lose ".0"
  assert.equal(canonicalJson(1.0), '1');
  assert.equal(canonicalJson(3.14), '3.14');
  assert.equal(canonicalJson(-0.5), '-0.5');
  assert.equal(canonicalJson(''), '""');
  assert.equal(canonicalJson('héllo 🌉'), '"héllo 🌉"');
});

test('canonical JSON: ints stay integer literals, never floats', () => {
  // 2^53 + 1 is not representable as an f64; canonical JSON must carry it
  // as exact digits.
  assert.equal(canonicalJson(9007199254740993n), '9007199254740993');
});

test('canonical JSON: bytes → base64', () => {
  assert.equal(canonicalJson(bytes()), '""');
  assert.equal(canonicalJson(bytes(0, 1, 2, 255)), '"AAEC/w=="');
});

test('canonical JSON: timestamp → RFC 3339 UTC', () => {
  // 1717515600 = 2024-06-04T15:40:00Z (byte-verified with Python datetime).
  assert.equal(canonicalJson(new BridgeTimestamp(1717515600n)), '"2024-06-04T15:40:00Z"');
  assert.equal(
    canonicalJson(new BridgeTimestamp(1717515600n, 500_000_000)),
    '"2024-06-04T15:40:00.5Z"',
  );
});

test('canonical JSON: map keys sorted by UTF-8 byte order', () => {
  const v = valueFromTagged({
    t: 'map',
    v: { b: { t: 'i64', v: '1' }, a: { t: 'i64', v: '2' }, 'é': { t: 'i64', v: '3' } },
  });
  // "a" = 61 sorts before "b" = 62 before "é" = c3 a9
  assert.equal(canonicalJson(v), '{"a":2,"b":1,"é":3}');
});

test('canonical JSON: undefined values are omitted (absent optional)', () => {
  const v = { present: 'x', missing: undefined, nulled: null };
  assert.equal(canonicalJson(v), '{"nulled":null,"present":"x"}');
});

test('canonical JSON: arrays keep contract order', () => {
  assert.equal(canonicalJson([2n, 1n, 3n]), '[2,1,3]');
  assert.equal(canonicalJson([]), '[]');
});

test('canonical JSON: sets render as their sorted deduped entries', () => {
  const s = new BridgeSet([3n, 1n, 2n, 1n]);
  assert.equal(canonicalJson(s), '[1,2,3]');
});

test('canonical JSON: nested struct-like map', () => {
  const v = valueFromTagged({
    t: 'map',
    v: {
      id: { t: 'str', v: 'pay_01' },
      amount: { t: 'decimal', v: '19.99' },
      created: { t: 'timestamp', iso: '2024-06-04T17:00:00Z' },
      tags: { t: 'set', v: [{ t: 'str', v: 'card' }, { t: 'str', v: 'recurring' }] },
      meta: { t: 'map', v: { retry: { t: 'bool', v: false }, attempts: { t: 'i64', v: '2' } } },
      receipt: { t: 'bytes', b64: 'AAEC/w==' },
      voided_at: { t: 'null' },
    },
  });
  assert.equal(
    canonicalJson(v),
    '{"amount":"19.99","created":"2024-06-04T17:00:00Z",' +
      '"id":"pay_01","meta":{"attempts":2,"retry":false},' +
      '"receipt":"AAEC/w==","tags":["card","recurring"],"voided_at":null}',
  );
});
