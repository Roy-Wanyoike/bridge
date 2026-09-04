/**
 * Canonical IR tests: determinism, stable ordering, optionality lowering,
 * default/constraint preservation and JSON round-trip stability.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileSource } from '../compiler/compile';
import type { IRField, IRPackage, IRTypeDefinition } from '../ir/types';

/** A rich package exercising every declaration kind and ordering hazard. */
const RICH = `
/// Shop contracts.
package shop.v1

import zeta.v1
import alpha.v1

/// Money.
type Money {
    amount: int64 @min(0)
    currency: string @length(3) = "USD"
}

/// User profile.
type User {
    id: uuid
    nickname?: string
    tags: list<string>?
    scores: map<string, int32>
    wallet: Money?
    remote: alpha.v1.Thing
    slug: string @pattern("^[a-z]+$", "lowercase only") @length(1, 64)
    retries: int32 = 3
    floor: int32 = -5
    mode: string = AUTO
}

enum Status {
    ACTIVE
    BANNED
}

service Users {
    Get(User) -> User
}

event UserBanned {
    user_id: uuid
}
`;

/** Reordered variant of RICH: type declarations in a different order. */
const RICH_REORDERED = `
/// Shop contracts.
package shop.v1

import alpha.v1
import zeta.v1

enum Status {
    ACTIVE
    BANNED
}

/// User profile.
type User {
    id: uuid
    nickname?: string
    tags: list<string>?
    scores: map<string, int32>
    wallet: Money?
    remote: alpha.v1.Thing
    slug: string @pattern("^[a-z]+$", "lowercase only") @length(1, 64)
    retries: int32 = 3
    floor: int32 = -5
    mode: string = AUTO
}

/// Money.
type Money {
    amount: int64 @min(0)
    currency: string @length(3) = "USD"
}

service Users {
    Get(User) -> User
}

event UserBanned {
    user_id: uuid
}
`;

function compileRich(): IRPackage {
  const result = compileSource(RICH, 'rich.bridge');
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  assert.ok(result.ir !== undefined);
  return result.ir;
}

function typeByName(ir: IRPackage, name: string): IRTypeDefinition {
  const def = ir.types.find((t) => t.name === name);
  assert.ok(def !== undefined, `type ${name} must exist in the IR`);
  return def;
}

/** The struct member of the IR type-definition union (with name/docs/deprecated). */
type IRStructDef = Extract<IRTypeDefinition, { kind: 'struct' }>;
/** The enum member of the IR type-definition union. */
type IREnumDef = Extract<IRTypeDefinition, { kind: 'enum' }>;

function structByName(ir: IRPackage, name: string): IRStructDef {
  const def = typeByName(ir, name);
  if (def.kind !== 'struct') {
    return assert.fail(`type ${name} must be a struct, got ${def.kind}`);
  }
  return def;
}

function enumByName(ir: IRPackage, name: string): IREnumDef {
  const def = typeByName(ir, name);
  if (def.kind !== 'enum') {
    return assert.fail(`type ${name} must be an enum, got ${def.kind}`);
  }
  return def;
}

function fieldByName(fields: IRField[], name: string): IRField {
  const field = fields.find((f) => f.name === name);
  assert.ok(field !== undefined, `field ${name} must exist`);
  return field;
}

// ------------------------------------------------------------------ ordering

test('imports are sorted and deduplicated', () => {
  const ir = compileRich();
  assert.deepEqual(ir.imports, ['alpha.v1', 'zeta.v1']);
});

test('types are sorted by name regardless of declaration order', () => {
  const ir = compileRich();
  assert.deepEqual(
    ir.types.map((t) => t.name),
    ['Money', 'Status', 'User'],
  );
});

test('services and events keep declaration order', () => {
  const result = compileSource(
    `
package p
service B { Get(Ping) -> Ping }
service A { Get(Ping) -> Ping }
event Second { at: timestamp }
event First { at: timestamp }
type Ping { ok: bool }
`,
    'order.bridge',
  );
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  assert.ok(result.ir !== undefined);
  assert.deepEqual(
    result.ir.services.map((s) => s.name),
    ['B', 'A'],
    'service order is declaration order, not sorted',
  );
  assert.deepEqual(
    result.ir.events.map((e) => e.name),
    ['Second', 'First'],
    'event order is declaration order, not sorted',
  );
  assert.deepEqual(
    result.ir.services[0]?.methods.map((m) => m.name),
    ['Get'],
  );
});

// --------------------------------------------------------------- determinism

test('determinism: compiling the same source twice yields deep-equal IR', () => {
  const a = compileRich();
  const b = compileRich();
  assert.deepEqual(a, b);
  assert.equal(JSON.stringify(a), JSON.stringify(b), 'byte-identical JSON');
});

test('determinism: declaration order does not change the IR', () => {
  const a = compileRich();
  const reordered = compileSource(RICH_REORDERED, 'reordered.bridge');
  assert.equal(reordered.ok, true, JSON.stringify(reordered.diagnostics));
  assert.ok(reordered.ir !== undefined);
  assert.deepEqual(a, reordered.ir);
});

// ---------------------------------------------------------------- optionality

test('`T?` lowers to optional=true with the plain type (no wrapper)', () => {
  const ir = compileRich();
  const user = structByName(ir, 'User');

  const nickname = fieldByName(user.fields, 'nickname');
  assert.deepEqual(nickname, {
    name: 'nickname',
    type: { kind: 'primitive', primitive: 'string' },
    optional: true,
    constraints: [],
  });

  const tags = fieldByName(user.fields, 'tags');
  assert.equal(tags.optional, true);
  assert.deepEqual(tags.type, {
    kind: 'list',
    element: { kind: 'primitive', primitive: 'string' },
  });

  const wallet = fieldByName(user.fields, 'wallet');
  assert.equal(wallet.optional, true);
  assert.deepEqual(wallet.type, { kind: 'named', name: 'Money' });

  // Required fields stay required.
  const id = fieldByName(user.fields, 'id');
  assert.equal(id.optional, false);
});

// ------------------------------------------------------- values and messages

test('defaults preserve quoting: strings re-quoted, numbers and identifiers raw', () => {
  const ir = compileRich();
  const user = structByName(ir, 'User');
  const money = structByName(ir, 'Money');
  assert.equal(fieldByName(money.fields, 'currency').default, '"USD"');
  assert.equal(fieldByName(user.fields, 'retries').default, '3');
  assert.equal(fieldByName(user.fields, 'floor').default, '-5');
  assert.equal(fieldByName(user.fields, 'mode').default, 'AUTO');
});

test('constraints keep textual args; a trailing string arg becomes the message', () => {
  const ir = compileRich();
  const user = structByName(ir, 'User');

  const slug = fieldByName(user.fields, 'slug');
  assert.deepEqual(slug.constraints, [
    { kind: 'pattern', args: ['^[a-z]+$'], message: 'lowercase only' },
    { kind: 'length', args: ['1', '64'] },
  ]);

  const money = structByName(ir, 'Money');
  assert.deepEqual(fieldByName(money.fields, 'amount').constraints, [
    { kind: 'min', args: ['0'] },
  ]);
});

test('qualified references keep the package; local references do not', () => {
  const ir = compileRich();
  const user = structByName(ir, 'User');
  assert.deepEqual(fieldByName(user.fields, 'remote').type, {
    kind: 'named',
    name: 'Thing',
    package: 'alpha.v1',
  });
  assert.deepEqual(fieldByName(user.fields, 'wallet').type, {
    kind: 'named',
    name: 'Money',
  });
});

// ------------------------------------------------------------ docs & metadata

test('docs and deprecation markers are carried into the IR', () => {
  const result = compileSource(
    `
/// Package-level docs.
package p

/// A deprecated struct.
type Old @deprecated {
    /// The replacement field.
    new_field: string
    legacy: string @deprecated("use new_field")
}

enum E {
    /// Still fine.
    OK
    GONE @deprecated
}
`,
    'docs.bridge',
  );
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  assert.ok(result.ir !== undefined);
  assert.equal(result.ir.docs, 'Package-level docs.');

  const old = structByName(result.ir, 'Old');
  assert.equal(old.docs, 'A deprecated struct.');
  assert.equal(old.deprecated, true);
  const legacy = old.fields.find((f) => f.name === 'legacy');
  assert.ok(legacy !== undefined);
  assert.equal(legacy.deprecated, 'use new_field');
  const newField = old.fields.find((f) => f.name === 'new_field');
  assert.ok(newField !== undefined);
  assert.equal(newField.docs, 'The replacement field.');

  const e = enumByName(result.ir, 'E');
  assert.deepEqual(e.variants, [
    { name: 'OK', docs: 'Still fine.' },
    { name: 'GONE', deprecated: true },
  ]);
});

// ------------------------------------------------------------- JSON stability

test('JSON round-trip is identity (no undefined-valued keys anywhere)', () => {
  const ir = compileRich();
  const round = JSON.parse(JSON.stringify(ir)) as IRPackage;
  assert.deepEqual(round, ir);
});

test('errors suppress the IR; warnings keep it', () => {
  const bad = compileSource('package p\n\ntype T {\n    x: Missing\n}\n', 'bad.bridge');
  assert.equal(bad.ok, false);
  assert.equal(bad.ir, undefined);

  const warny = compileSource('package p\n\ntype lower {\n    someField: string\n}\n', 'warny.bridge');
  assert.equal(warny.ok, true);
  assert.ok(warny.ir !== undefined);
  assert.ok(warny.diagnostics.length >= 2);
});
