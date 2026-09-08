/**
 * BridgeTimestamp arithmetic contract (#46): RFC 3339 parsing/rendering is
 * done with proleptic-Gregorian integer math — never Date.parse, never
 * binary64 seconds — so the full int64-second range parses, renders, and
 * round-trips exactly, including pre-1970 sub-second values and expanded
 * years.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BridgeTimestamp } from '../types';

test('fromISO: parses fractions arithmetically at full nanosecond precision', () => {
  assert.equal(BridgeTimestamp.fromISO('2024-06-04T17:00:00.123456789Z').nanos, 123_456_789);
  assert.equal(BridgeTimestamp.fromISO('2024-06-04T17:00:00.123456Z').nanos, 123_456_000);
  assert.equal(BridgeTimestamp.fromISO('2024-06-04T17:00:00.1Z').nanos, 100_000_000);
  assert.equal(BridgeTimestamp.fromISO('2024-06-04T17:00:00Z').nanos, 0);
  // no Date.parse float drift: the digits land exactly
  const t = BridgeTimestamp.fromISO('1970-01-01T00:00:00.000000001Z');
  assert.equal(t.seconds, 0n);
  assert.equal(t.nanos, 1);
});

test('fromISO: rejects fractions beyond nanosecond precision', () => {
  assert.throws(() => BridgeTimestamp.fromISO('2024-06-04T17:00:00.1234567891Z'), RangeError);
});

test('fromISO: honors offsets and lowercase designators', () => {
  const utc = BridgeTimestamp.fromISO('2024-06-04T17:00:00Z').seconds; // 1717520400n
  // +01:00 → one hour behind UTC
  assert.equal(BridgeTimestamp.fromISO('2024-06-04T17:00:00+01:00').seconds, utc - 3600n);
  assert.equal(BridgeTimestamp.fromISO('2024-06-04T17:00:00-01:00').seconds, utc + 3600n);
  assert.equal(BridgeTimestamp.fromISO('2024-06-04T17:00:00z').seconds, utc);
  assert.equal(BridgeTimestamp.fromISO('2024-06-04t17:00:00Z').seconds, utc);
});

test('fromISO: rejects malformed input', () => {
  assert.throws(() => BridgeTimestamp.fromISO('not a timestamp'), RangeError);
  assert.throws(() => BridgeTimestamp.fromISO('2024-13-01T00:00:00Z'), RangeError);
  assert.throws(() => BridgeTimestamp.fromISO('2024-02-30T00:00:00Z'), RangeError);
  assert.throws(() => BridgeTimestamp.fromISO('2024-06-04T24:00:00Z'), RangeError);
  assert.throws(() => BridgeTimestamp.fromISO('2023-02-29T00:00:00Z'), RangeError); // non-leap
  assert.ok(BridgeTimestamp.fromISO('2024-02-29T00:00:00Z')); // leap day accepted
});

test('toISO: renders at full nanosecond precision (no millisecond truncation)', () => {
  assert.equal(
    new BridgeTimestamp(1717520400n, 123_456_789).toISO(),
    '2024-06-04T17:00:00.123456789Z',
  );
  assert.equal(
    new BridgeTimestamp(1717520400n, 123_456).toISO(),
    '2024-06-04T17:00:00.000123456Z',
  );
  assert.equal(
    new BridgeTimestamp(1717520400n, 500_000_000).toISO(),
    '2024-06-04T17:00:00.5Z',
  );
  assert.equal(new BridgeTimestamp(1717520400n).toISO(), '2024-06-04T17:00:00Z');
});

test('toISO/fromISO: negative seconds normalize onto the pre-epoch day', () => {
  // -1s + 0.5s is the instant half a second before the epoch.
  const t = new BridgeTimestamp(-1n, 500_000_000);
  assert.equal(t.toISO(), '1969-12-31T23:59:59.5Z');
  assert.ok(BridgeTimestamp.fromISO('1969-12-31T23:59:59.5Z').equals(t));
  const nano = new BridgeTimestamp(-1n, 1);
  assert.equal(nano.toISO(), '1969-12-31T23:59:59.000000001Z');
  assert.ok(BridgeTimestamp.fromISO('1969-12-31T23:59:59.000000001Z').equals(nano));
});

test('toISO: renders arithmetically for extreme seconds (int64 bounds)', () => {
  assert.equal(
    new BridgeTimestamp(9223372036854775807n).toISO(),
    '292277026596-12-04T15:30:07Z',
  );
  assert.equal(
    new BridgeTimestamp(-9223372036854775808n).toISO(),
    '-292277022657-01-27T08:29:52Z',
  );
  // ...and the renderer is its own parser's inverse across the extremes.
  assert.ok(BridgeTimestamp.fromISO('292277026596-12-04T15:30:07Z').equals(new BridgeTimestamp(9223372036854775807n)));
  assert.ok(
    BridgeTimestamp.fromISO('-292277022657-01-27T08:29:52Z').equals(new BridgeTimestamp(-9223372036854775808n)),
  );
});

test('fromISO/toISO: proleptic calendar spot checks', () => {
  // 1582-10-15 (Gregorian adoption day) → days since epoch = -141427
  assert.equal(BridgeTimestamp.fromISO('1582-10-15T00:00:00Z').seconds, -141427n * 86_400n);
  // 2000-02-29 leap day, 1900-02-29 invalid (century, not 400)
  assert.ok(BridgeTimestamp.fromISO('2000-02-29T00:00:00Z'));
  assert.throws(() => BridgeTimestamp.fromISO('1900-02-29T00:00:00Z'), RangeError);
});

test('ISO round-trip sweep over representative (seconds, nanos) pairs', () => {
  const samples = [
    0n, 1n, -1n, 86_399n, -86_400n, 951_782_400n, -951_782_400n,
    2_147_483_647n, -2_147_483_648n, 4_102_444_800n,
    9223372036854775807n, -9223372036854775808n, 9223372036854775806n,
  ];
  for (const seconds of samples) {
    for (const nanos of [0, 1, 123, 456_789, 999_999_999]) {
      const t = new BridgeTimestamp(seconds, nanos);
      assert.ok(BridgeTimestamp.fromISO(t.toISO()).equals(t), `${t.toISO()} round-trip`);
    }
  }
});
