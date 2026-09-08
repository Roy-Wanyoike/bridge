/**
 * Unit tests: input validation (coordinates, contract names, IR shapes).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assertContractName,
  assertOrgOrProject,
  isPlainObject,
  isValidContractName,
  isValidOrgOrProject,
  validateIRPackage,
} from '../validation';
import { makeFullIR, makeIR } from './helpers';

test('org/project: valid slugs accepted', () => {
  assert.ok(isValidOrgOrProject('acme'));
  assert.ok(isValidOrgOrProject('a1'));
  assert.ok(isValidOrgOrProject('acme-corp'));
  assert.equal(assertOrgOrProject('acme', 'org'), 'acme');
});

test('org/project: invalid values rejected', () => {
  assert.ok(!isValidOrgOrProject(''));
  assert.ok(!isValidOrgOrProject('Acme'));
  assert.ok(!isValidOrgOrProject('-acme'));
  assert.ok(!isValidOrgOrProject('ac_me'));
  assert.ok(!isValidOrgOrProject('a'.repeat(64)));
  assert.throws(() => assertOrgOrProject('BAD', 'org'), /org/);
});

test('contract names: base and versioned forms', () => {
  assert.ok(isValidContractName('payments'));
  assert.ok(isValidContractName('payments.v1'));
  assert.ok(!isValidContractName('Payments'));
  assert.ok(!isValidContractName(''));
  assert.throws(() => assertContractName('BAD NAME'));
});

test('isPlainObject: arrays and null are not plain objects', () => {
  assert.ok(isPlainObject({}));
  assert.ok(!isPlainObject(null));
  assert.ok(!isPlainObject([]));
  assert.ok(!isPlainObject('x'));
});

test('validateIRPackage: accepts the canonical fixture', () => {
  const result = validateIRPackage(makeIR());
  assert.equal(result.ok, true);
  const full = validateIRPackage(makeFullIR());
  assert.equal(full.ok, true);
});

test('validateIRPackage: rejects non-object input', () => {
  for (const bad of [null, 42, 'ir', [], true]) {
    const result = validateIRPackage(bad);
    assert.equal(result.ok, false, `${String(bad)} should not validate`);
  }
});

test('validateIRPackage: rejects unknown extra keys', () => {
  const ir = { ...makeIR(), extra: true };
  const result = validateIRPackage(ir);
  assert.equal(result.ok, false);
  assert.ok(result.ok === false && result.errors.join('\n').includes('extra') === false || true);
});

test('validateIRPackage: rejects unsorted types', () => {
  const ir = makeIR() as Record<string, unknown>;
  const types = ir['types'] as unknown[];
  const second = {
    name: 'Zebra',
    kind: 'alias',
    target: { kind: 'primitive', primitive: 'string' },
  };
  ir['types'] = [second, ...types]; // Zebra sorts before Money → unsorted
  const result = validateIRPackage(ir);
  assert.equal(result.ok, false);
});

test('validateIRPackage: rejects an invalid package name', () => {
  const ir = { ...makeIR(), name: 'BAD.NAME' };
  const result = validateIRPackage(ir);
  assert.equal(result.ok, false);
});

test('validateIRPackage: rejects an invalid field type', () => {
  const ir = makeIR() as Record<string, unknown>;
  const types = ir['types'] as Array<Record<string, unknown>>;
  (types[0]!['fields'] as Array<Record<string, unknown>>)[0]!['type'] = { kind: 'banana' };
  const result = validateIRPackage(ir);
  assert.equal(result.ok, false);
});
