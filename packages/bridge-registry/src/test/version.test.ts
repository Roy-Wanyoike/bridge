import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RegistryError } from '../errors';
import { compareVersions, normalizeVersion, splitPackageVersion } from '../version';

function assertInvalidVersion(fn: () => unknown, label: string): void {
  assert.throws(
    fn,
    (err: unknown) => err instanceof RegistryError && err.code === 'invalid-version',
    `expected 'invalid-version' for ${label}`,
  );
}

function assertInvalidName(fn: () => unknown, label: string): void {
  assert.throws(
    fn,
    (err: unknown) => err instanceof RegistryError && err.code === 'invalid-name',
    `expected 'invalid-name' for ${label}`,
  );
}

test('normalizeVersion: bare digits get a v prefix', () => {
  assert.equal(normalizeVersion('1'), 'v1');
  assert.equal(normalizeVersion('2'), 'v2');
  assert.equal(normalizeVersion('42'), 'v42');
});

test('normalizeVersion: uppercase V is normalized to lowercase', () => {
  assert.equal(normalizeVersion('V2'), 'v2');
  assert.equal(normalizeVersion('v2'), 'v2');
});

test('normalizeVersion: multi-digit versions pass through unchanged', () => {
  assert.equal(normalizeVersion('v10'), 'v10');
  assert.equal(normalizeVersion('v100'), 'v100');
});

test('normalizeVersion: leading zeros collapse so versions have one spelling', () => {
  assert.equal(normalizeVersion('v007'), 'v7');
  assert.equal(normalizeVersion('007'), 'v7');
  assert.equal(normalizeVersion('v0'), 'v0');
});

test('normalizeVersion rejects junk with invalid-version', () => {
  const junk = ['', 'v', 'V', 'abc', 'v1.2', '1.2', '-1', 'v-1', 'v1a', ' 1', '1 ', 'version1', '+1', '../../etc'];
  for (const bad of junk) {
    assertInvalidVersion(() => normalizeVersion(bad), JSON.stringify(bad));
  }
});

test('compareVersions: v2 < v10 (numeric, not lexicographic)', () => {
  assert.equal(compareVersions('v2', 'v10'), -1);
  assert.equal(compareVersions('v10', 'v2'), 1);
});

test('compareVersions: equal versions compare as 0 across spellings', () => {
  assert.equal(compareVersions('v3', 'v3'), 0);
  assert.equal(compareVersions('3', 'v3'), 0);
  assert.equal(compareVersions('V2', '2'), 0);
});

test('compareVersions sorts the full numeric ladder correctly from any input order', () => {
  const ladder = ['v1', 'v2', 'v9', 'v10', 'v11', 'v99', 'v100'];
  assert.deepEqual([...ladder].sort(compareVersions), ladder);
  assert.deepEqual([...ladder].reverse().sort(compareVersions), ladder);
  assert.deepEqual(['v10', 'v2'].sort(compareVersions), ['v2', 'v10']);
});

test('compareVersions rejects junk with invalid-version', () => {
  assertInvalidVersion(() => compareVersions('v1', 'nope'), "compareVersions('v1','nope')");
  assertInvalidVersion(() => compareVersions('junk', 'v1'), "compareVersions('junk','v1')");
});

test('splitPackageVersion: single version suffix', () => {
  assert.deepEqual(splitPackageVersion('payments.v1'), { base: 'payments', version: 'v1' });
});

test('splitPackageVersion: multi-segment base keeps all but the last segment', () => {
  assert.deepEqual(splitPackageVersion('identity.internal.v2'), {
    base: 'identity.internal',
    version: 'v2',
  });
});

test('splitPackageVersion: bare numeric suffix counts as a version', () => {
  assert.deepEqual(splitPackageVersion('payments.3'), { base: 'payments', version: 'v3' });
});

test('splitPackageVersion: name without a version segment yields empty version', () => {
  assert.deepEqual(splitPackageVersion('payments'), { base: 'payments', version: '' });
});

test('splitPackageVersion: single segment that looks like a version stays a base', () => {
  assert.deepEqual(splitPackageVersion('v1'), { base: 'v1', version: '' });
});

test('splitPackageVersion: non-version last segment stays part of the base', () => {
  assert.deepEqual(splitPackageVersion('payments.beta'), { base: 'payments.beta', version: '' });
});

test('splitPackageVersion rejects empty and non-string input with invalid-name', () => {
  assertInvalidName(() => splitPackageVersion(''), "splitPackageVersion('')");
  assertInvalidName(
    () => splitPackageVersion(undefined as unknown as string),
    'splitPackageVersion(undefined)',
  );
});
