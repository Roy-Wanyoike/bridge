/**
 * Hashing tests: canonicalJson contract (returns a STRING), hashPackage
 * stability under reordering, and sensitivity to semantic changes.
 *
 * Contract history note: `canonicalJson` once returned the canonicalized
 * object instead of a string, making every `hashPackage` call throw. These
 * tests pin the string contract so that regression cannot reintroduce.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalJson, hashPackage, shortHash } from '../ir/hash';
import { compileSource } from '../compiler/compile';
import type { IRPackage } from '../ir/types';

const SCHEMA = `
package payments.v1

import other.v1
import example.v0

type Money {
    amount: int64
    currency: string @length(3)
}

enum PaymentStatus {
    PENDING
    COMPLETED
}

type Payment {
    id: uuid
    amount: Money
    status: PaymentStatus
}
`;

/** Same declarations, different order (and imports in a different order). */
const SCHEMA_REORDERED = `
package payments.v1

import example.v0
import other.v1

type Payment {
    id: uuid
    amount: Money
    status: PaymentStatus
}

enum PaymentStatus {
    PENDING
    COMPLETED
}

type Money {
    amount: int64
    currency: string @length(3)
}
`;

const WHITESPACE_VARIANT = `
package payments.v1

import other.v1
import example.v0

type    Money   {
        amount: int64
        currency: string @length(3)
}


enum PaymentStatus { PENDING
    COMPLETED }

type Payment { id: uuid
    amount: Money
    status: PaymentStatus }
`;

function compile(text: string, file: string): IRPackage {
  const result = compileSource(text, file);
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  assert.ok(result.ir !== undefined);
  return result.ir;
}

// ------------------------------------------------------------- canonicalJson

test('canonicalJson returns a string (the recovered-object regression is pinned out)', () => {
  const value = { b: 2, a: 1 };
  const json = canonicalJson(value);
  assert.equal(typeof json, 'string');
  assert.equal(json, '{"a":1,"b":2}');
});

test('canonicalJson is deterministic for the same object', () => {
  const value = { z: [1, { m: true, k: 'x' }], a: null };
  assert.equal(canonicalJson(value), canonicalJson(value));
});

test('canonicalJson sorts keys recursively and drops undefined values', () => {
  assert.equal(canonicalJson({ a: { d: 4, c: undefined, b: 3 } }), '{"a":{"b":3,"d":4}}');
  assert.equal(canonicalJson({ keep: 1, drop: undefined }), '{"keep":1}');
});

test('canonicalJson keeps array order (IR order is semantic)', () => {
  assert.equal(canonicalJson([3, 1, 2]), '[3,1,2]');
  assert.equal(canonicalJson({ list: ['b', 'a'] }), '{"list":["b","a"]}');
});

// --------------------------------------------------------------- hashPackage

test('hashPackage is a 64-char lowercase hex sha256 and stable for identical IR', () => {
  const ir = compile(SCHEMA, 'a.bridge');
  const hash = hashPackage(ir);
  assert.match(hash, /^[0-9a-f]{64}$/);
  assert.equal(hash, hashPackage(compile(SCHEMA, 'a.bridge')));
});

test('reordering type declarations and imports does not change the hash', () => {
  const a = hashPackage(compile(SCHEMA, 'a.bridge'));
  const b = hashPackage(compile(SCHEMA_REORDERED, 'b.bridge'));
  assert.equal(a, b, 'types are sorted and imports deduplicated before hashing');
});

test('whitespace and layout changes do not change the hash', () => {
  const a = hashPackage(compile(SCHEMA, 'a.bridge'));
  const b = hashPackage(compile(WHITESPACE_VARIANT, 'c.bridge'));
  assert.equal(a, b);
});

test('semantic changes do change the hash', () => {
  const base = hashPackage(compile(SCHEMA, 'a.bridge'));

  const changedField = hashPackage(
    compile(SCHEMA.replace('amount: int64', 'amount: int32'), 'd.bridge'),
  );
  assert.notEqual(base, changedField, 'field type is part of the identity');

  const addedField = hashPackage(
    compile(SCHEMA.replace('status: PaymentStatus', 'status: PaymentStatus\n    memo: string?'), 'e.bridge'),
  );
  assert.notEqual(base, addedField, 'added field is part of the identity');

  const changedDocs = hashPackage(
    compile(SCHEMA.replace('type Money {', '/// Docs.\ntype Money {'), 'f.bridge'),
  );
  assert.notEqual(base, changedDocs, 'docs are part of the identity');
});

test('shortHash is a 12-char prefix of the package hash', () => {
  const ir = compile(SCHEMA, 'a.bridge');
  const hash = hashPackage(ir);
  const short = shortHash(ir);
  assert.equal(short.length, 12);
  assert.equal(hash.startsWith(short), true);
});
