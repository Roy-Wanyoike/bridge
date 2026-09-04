/**
 * Semantic analysis tests: every check, did-you-mean hints, severity, and
 * compilePackage cross-package resolution.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compilePackage, compileSource } from '../index';
import { analyzeFile, didYouMean, levenshtein, SEMANTIC_CODES } from '../semantic';
import { parse } from '../parser';
import { tokenize } from '../lexer';
import type { Diagnostic, IRPackage } from '../ir/types';

function analyze(text: string, deps?: Map<string, IRPackage>): Diagnostic[] {
  const lexed = tokenize(text, 'test.bridge');
  const parsed = parse(lexed.tokens, 'test.bridge');
  return [
    ...lexed.diagnostics,
    ...parsed.diagnostics,
    ...analyzeFile(parsed.file, 'test.bridge', deps === undefined ? {} : { dependencies: deps }),
  ];
}

function codes(diags: Diagnostic[]): string[] {
  return diags.map((d) => d.code);
}

function makeDep(name: string, typeNames: string[], kind: 'struct' | 'enum' = 'struct'): IRPackage {
  return {
    name,
    imports: [],
    types: typeNames.map((n) => ({ kind, name: n, fields: [], variants: [] })),
    services: [],
    events: [],
  };
}

// ------------------------------------------------------------- unknown types

test('unknown type reference gets a did-you-mean hint within distance 2', () => {
  const diags = analyze(`
package payments.v1
type Money {
    units: int64
}
type Payment {
    amount: money
}
`);
  const unknown = diags.find((d) => d.code === SEMANTIC_CODES.unknownType);
  assert.ok(unknown, 'unknown type must be reported');
  assert.equal(unknown.line, 7);
  assert.equal(unknown.column, 13);
  assert.equal(unknown.hint, 'Did you mean `Money`?');
  assert.equal(unknown.severity, 'error');
});

test('unknown type referencing a primitive typo suggests the primitive', () => {
  const diags = analyze(`
package p
type T {
    a: strng
    b: in32
    c: timestmp
}
`);
  const hints = diags
    .filter((d) => d.code === SEMANTIC_CODES.unknownType)
    .map((d) => d.hint);
  assert.deepEqual(hints, [
    'Did you mean `string`?',
    'Did you mean `int32`?',
    'Did you mean `timestamp`?',
  ]);
});

test('no hint when nothing is within edit distance 2', () => {
  const diags = analyze(`
package p
type T {
    a: xyzzymnoop
}
`);
  const unknown = diags.find((d) => d.code === SEMANTIC_CODES.unknownType);
  assert.ok(unknown);
  assert.equal(unknown.hint, undefined);
});

test('levenshtein distances are exact', () => {
  assert.equal(levenshtein('money', 'Money'), 1);
  assert.equal(levenshtein('strng', 'string'), 1);
  assert.equal(levenshtein('abc', 'abc'), 0);
  assert.equal(levenshtein('abc', 'yabc'), 1);
  assert.equal(levenshtein('kitten', 'sitting'), 3);
  assert.equal(levenshtein('', 'ab'), 2);
});

test('didYouMean picks the closest candidate and breaks ties alphabetically', () => {
  assert.equal(didYouMean('money', ['Money', 'Moneys', 'monkey']), 'Money');
  assert.equal(didYouMean('PENDING', ['PENDING_A', 'PENDING_B']), 'PENDING_A');
  assert.equal(didYouMean('zzzzzz', ['Money', 'Payment']), undefined);
});

test('self-qualified references resolve to the enclosing package', () => {
  const diags = analyze(`
package p
type U {
    id: int64
}
type T {
    owner: p.U
}
`);
  assert.deepEqual(diags, []);
});

// ---------------------------------------------------------------- duplicates

test('duplicate type, event and service names are errors', () => {
  const diags = analyze(`
package p
type Money {
    amount: int64
}
type Money {
    units: int64
}
event Money {
    at: timestamp
}
service Money {
    Get(Money) -> Money
}
service Money {
    Get(Money) -> Money
}
`);
  // Types and events/services live in separate top-level namespaces; the
  // two type declarations collide, and the two services collide.
  const dups = diags.filter((d) => d.code === SEMANTIC_CODES.duplicateDeclaration);
  assert.deepEqual(dups.map((d) => d.message), [
    'Duplicate type name `Money`.',
    'Duplicate service name `Money`.',
  ]);
  assert.equal(dups[0]?.line, 6);
});

test('duplicate field names in struct, union and event bodies', () => {
  const diags = analyze(`
package p
type T {
    id: uuid
    id: string
}
union U {
    a: T
    a: bool
}
event E {
    at: timestamp
    at: timestamp
}
`);
  const dupFields = diags.filter((d) => d.code === SEMANTIC_CODES.duplicateField);
  assert.equal(dupFields.length, 3);
  assert.deepEqual(
    dupFields.map((d) => d.line),
    [5, 9, 13],
  );
});

test('duplicate enum variant and duplicate method names', () => {
  const diags = analyze(`
package p
type R {
    ok: bool
}
enum E {
    SAME
    SAME
}
service S {
    Call(R) -> R
    Call(R) -> R
}
`);
  assert.ok(codes(diags).includes(SEMANTIC_CODES.duplicateEnumVariant));
  assert.ok(codes(diags).includes(SEMANTIC_CODES.duplicateMethod));
});

test('duplicate imports are errors', () => {
  const diags = analyze(`
package p
import a.b
import a.b
import c.d
`);
  const dups = diags.filter((d) => d.code === SEMANTIC_CODES.duplicateImport);
  assert.equal(dups.length, 1);
  assert.equal(dups[0]?.line, 4);
});

// ------------------------------------------------------------------ package

test('missing package statement is BR2007 at 1:1', () => {
  const diags = analyze('type T {\n    x: int32\n}\n');
  const missing = diags.find((d) => d.code === SEMANTIC_CODES.packageStatement);
  assert.ok(missing);
  assert.equal(missing.line, 1);
  assert.equal(missing.column, 1);
  assert.ok(missing.hint !== undefined);
});

test('package and import names must be dotted lowercase identifiers', () => {
  const diags = analyze(`
package Payments.V1
import Bad_Name
import ok.name2
`);
  assert.deepEqual(codes(diags), [SEMANTIC_CODES.invalidDottedName, SEMANTIC_CODES.invalidDottedName]);
  assert.equal(diags[0]?.line, 2);
  assert.equal(diags[1]?.line, 3);
});

// -------------------------------------------------------------- alias cycles

test('alias cycle across two aliases is reported once', () => {
  const diags = analyze(`
package p
alias A = B
alias B = A
`);
  const cycles = diags.filter((d) => d.code === SEMANTIC_CODES.aliasCycle);
  assert.equal(cycles.length, 1);
  assert.match(cycles[0]?.message ?? '', /A -> B -> A/);
});

test('self-referential alias and composite-wrapped cycles are detected', () => {
  const diags = analyze(`
package p
alias Self = Self
alias List1 = list<Alias2>
alias Alias2 = List1
`);
  const cycles = diags.filter((d) => d.code === SEMANTIC_CODES.aliasCycle);
  assert.equal(cycles.length, 2);
});

test('non-cyclic alias chains are accepted', () => {
  const diags = analyze(`
package p
alias UserId = uuid
alias OwnerId = UserId
alias AccountId = OwnerId
type T {
    id: AccountId
}
`);
  assert.deepEqual(diags, []);
});

// ------------------------------------------------------------ method checks

test('method input/output must be named struct references', () => {
  const diags = analyze(`
package p
type Req {
    id: uuid
}
enum Kind {
    A
}
alias Id = uuid
service S {
    Create(Req) -> int64
    Update(Req) -> Kind
    Delete(list<Req>) -> Req
    Get(Req) -> Id
}
`);
  const sigErrors = diags.filter((d) => d.code === SEMANTIC_CODES.methodSignature);
  // int64 output, enum output, list input, and an alias output are all
  // rejected: method I/O must name a struct directly (aliases are not
  // followed for signatures).
  assert.equal(sigErrors.length, 4, 'int64, Kind (enum), list<Req> and alias Id are rejected');
  assert.match(sigErrors[0]?.message ?? '', /Create/);
  assert.match(sigErrors[1]?.message ?? '', /Update/);
  assert.match(sigErrors[2]?.message ?? '', /Delete/);
  assert.match(sigErrors[3]?.message ?? '', /Get/);
});

test('method referencing an unknown type gets BR2001 (not silently accepted)', () => {
  const diags = analyze(`
package p
service S {
    Get(Missing) -> Missing
}
`);
  const unknown = diags.filter((d) => d.code === SEMANTIC_CODES.unknownType);
  assert.equal(unknown.length, 2);
});

// ------------------------------------------------------------- map keys

test('map keys must be hashable primitives', () => {
  const diags = analyze(`
package p
type Money {
    units: int64
}
type T {
    ok1: map<string, int32>
    ok2: map<uuid, string>
    ok3: map<uint64, bool>
    bad1: map<float64, string>
    bad2: map<Money, string>
    bad3: map<list<int32>, string>
    bad4: map<decimal, string>
    bad5: map<timestamp, string>
}
`);
  const bad = diags.filter((d) => d.code === SEMANTIC_CODES.invalidMapKey);
  assert.equal(bad.length, 5, 'float64, Money, list, decimal and timestamp keys are rejected');
  assert.deepEqual(
    bad.map((d) => d.line),
    [10, 11, 12, 13, 14],
  );
});

// ------------------------------------------------- optional collection items

test('optional-wrapped list/set elements are rejected, map values and optional collections are fine', () => {
  const diags = analyze(`
package p
type T {
    bad1: list<string?>
    bad2: set<int32?>
    bad3: list<list<bool?>>
    ok1: list<string>?
    ok2: map<string, int32?>
    ok3: map<string?, int32>
}
`);
  const bad = diags.filter((d) => d.code === SEMANTIC_CODES.optionalCollectionElement);
  assert.equal(bad.length, 3);
  // `map<string?, int32>` also trips the map-key check.
  assert.ok(codes(diags).includes(SEMANTIC_CODES.invalidMapKey));
});

// ------------------------------------------------- constraint applicability

test('@min/@max apply to numeric types only (alias-transparent)', () => {
  const diags = analyze(`
package p
alias Qty = int64
alias Label = string
type T {
    ok1: int32 @min(0) @max(10)
    ok2: float32 @min(-1.5)
    ok3: Qty @min(1)
    ok4: Qty? @min(1)
    bad1: string @min(0)
    bad2: bool @max(1)
    bad3: Label @min(0)
    bad4: bytes @max(3)
}
`);
  const bad = diags.filter((d) => d.code === SEMANTIC_CODES.constraintNotApplicable);
  assert.equal(bad.length, 4);
  assert.deepEqual(
    bad.map((d) => d.line),
    [10, 11, 12, 13],
  );
  assert.ok((bad[0]?.hint ?? '').includes('@min/@max support'));
});

test('@length/@email/@url/@pattern/@uuid apply to string fields only', () => {
  const diags = analyze(`
package p
type T {
    ok1: string @length(3)
    ok2: string @email
    ok3: string? @url
    bad1: uuid @uuid
    bad2: int32 @length(5)
    bad3: bool @pattern("x")
    bad4: timestamp @email
}
`);
  const bad = diags.filter((d) => d.code === SEMANTIC_CODES.constraintNotApplicable);
  assert.equal(bad.length, 4);
  assert.deepEqual(
    bad.map((d) => d.line),
    [7, 8, 9, 10],
  );
});

test('constraints on unknown-typed fields are not double-reported', () => {
  const diags = analyze(`
package p
type T {
    a: WhatsThis @min(0)
}
`);
  assert.deepEqual(codes(diags), [SEMANTIC_CODES.unknownType]);
});

// ---------------------------------------------------------------- warnings

test('style warnings: PascalCase types, SCREAMING_SNAKE_CASE variants, snake_case fields', () => {
  const diags = analyze(`
package p
type money_bag {
    customerId: string
}
enum PaymentStatus {
    pending
    COMPLETED
}
`);
  const warnings = diags.filter((d) => d.severity === 'warning');
  assert.deepEqual(
    warnings.map((d) => d.code),
    [SEMANTIC_CODES.typeNameStyle, SEMANTIC_CODES.fieldNameStyle, SEMANTIC_CODES.enumVariantStyle],
  );
  assert.ok(warnings.every((d) => d.severity === 'warning'));
  // Warnings must hint at the canonical convention with an example.
  assert.match(warnings[0]?.hint ?? '', /`PaymentStatus`/);
  assert.match(warnings[1]?.hint ?? '', /`customer_id`/);
  assert.match(warnings[2]?.hint ?? '', /`PAYMENT_FAILED`/);
});

test('warnings do not make compilation fail', () => {
  const result = compileSource('package p\n\ntype lower {\n    someField: string\n}\n', 'w.bridge');
  assert.equal(result.ok, true, 'warnings are not errors');
  assert.ok(result.ir !== undefined);
  assert.ok(result.diagnostics.every((d) => d.severity === 'warning'));
  assert.ok(result.diagnostics.length >= 2);
});

// --------------------------------------------------- compilePackage (cross)

test('compilePackage resolves cross-package references through dependencies', () => {
  const identity = makeDep('identity.v1', ['User', 'Org']);
  const result = compilePackage(
    `
package payments.v1

import identity.v1

type Payment {
    id: uuid
    owner: identity.v1.User
    org: identity.v1.Org
}
`,
    'payments.bridge',
    new Map([['identity.v1', identity]]),
  );
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  assert.ok(result.ir !== undefined);
});

test('compilePackage flags imports missing from the dependency map', () => {
  const result = compilePackage(
    'package p\n\nimport ghost.v9\n\ntype T {\n    x: int32\n}\n',
    'p.bridge',
    new Map(),
  );
  assert.equal(result.ok, false);
  assert.deepEqual(codes(result.diagnostics), [SEMANTIC_CODES.unknownImport]);
  assert.match(result.diagnostics[0]?.message ?? '', /ghost\.v9/);
});

test('compilePackage detects unknown types inside an imported package (with hint)', () => {
  const identity = makeDep('identity.v1', ['User', 'Organization']);
  const result = compilePackage(
    `
package p

import identity.v1

type T {
    who: identity.v1.Usr
}
`,
    'p.bridge',
    new Map([['identity.v1', identity]]),
  );
  const unknown = result.diagnostics.find((d) => d.code === SEMANTIC_CODES.unknownType);
  assert.ok(unknown);
  assert.equal(unknown.hint, 'Did you mean `User`?');
});

test('compilePackage rejects methods whose output resolves to a dependency enum', () => {
  const kinds = makeDep('kinds.v1', ['PaymentKind'], 'enum');
  const result = compilePackage(
    `
package p

import kinds.v1

type Req {
    ok: bool
}

service S {
    Get(Req) -> kinds.v1.PaymentKind
}
`,
    'p.bridge',
    new Map([['kinds.v1', kinds]]),
  );
  const sig = result.diagnostics.find((d) => d.code === SEMANTIC_CODES.methodSignature);
  assert.ok(sig);
  assert.match(sig.message, /must reference a struct/);
});

test('compilePackage flags qualified references to unimported packages', () => {
  const known = makeDep('known.v1', ['Thing']);
  const result = compilePackage(
    `
package p

import known.v1

type T {
    x: other.v1.Thing
    y: known.v1.Thing
}
`,
    'p.bridge',
    new Map([['known.v1', known]]),
  );
  const unknown = result.diagnostics.filter((d) => d.code === SEMANTIC_CODES.unknownType);
  assert.equal(unknown.length, 1);
  assert.match(unknown[0]?.message ?? '', /other\.v1/);
  assert.equal(unknown[0]?.hint, 'Add `import other.v1` below the package statement, or reference a type from an imported package.');
});

test('compilePackage suggests a close package name for typos in the package part', () => {
  const known = makeDep('identity.v1', ['User']);
  const result = compilePackage(
    `
package p

import identity.v1

type T {
    x: identiy.v1.User
}
`,
    'p.bridge',
    new Map([['identity.v1', known]]),
  );
  const unknown = result.diagnostics.find((d) => d.code === SEMANTIC_CODES.unknownType);
  assert.ok(unknown);
  assert.equal(unknown.hint, 'Did you mean package `identity.v1`?');
});

test('compileSource does not validate imports against dependencies', () => {
  const result = compileSource(
    'package p\n\nimport somewhere.else\n\ntype T {\n    x: int32\n}\n',
    'p.bridge',
  );
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
});

test('compileSource does not resolve qualified refs but still requires the import', () => {
  const result = compileSource(
    `
package p

import known.v1

type T {
    x: known.v1.Thing
}
`,
    'p.bridge',
  );
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
});
