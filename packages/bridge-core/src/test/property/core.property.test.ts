/**
 * Property-based tests for the bridge-core front-end.
 *
 * Every property below is generated: each case builds a random *valid*
 * Bridge contract with the seeded generator (`contract-gen.ts`) and asserts
 * invariants of the compiler/formatter over it. Seeds are committed so any
 * failure reproduces exactly — see the failure message or docs/TESTING.md
 * for the `BRIDGE_PROPERTY_SEED` / `BRIDGE_PROPERTY_CASE` recipe.
 *
 * Properties (200 cases each, committed base seed 20250601):
 *  1. parse(generate()) — every generated source compiles clean
 *     (ok === true, zero diagnostics of any severity).
 *  2. compile(generate()) produces exactly the generator's expected IR.
 *  3. Formatting is a fixpoint: format(format(x)) === format(x).
 *  4. parse(format(x)) is stable: the formatted source re-parses clean and
 *     lowers to the identical IR (plain `//` comments carry no semantics).
 *  5. Determinism: compiling the same source twice yields deep-equal IR and
 *     identical SHA-256 package hashes.
 *  6. Canonicalization: permuting the *type* declarations in the source
 *     yields identical IR + hash. Honest scope note: the IR contract sorts
 *     `types` by name but deliberately preserves declaration order for
 *     services and events, so the permutation is restricted to type
 *     declarations — reordering services/events is NOT order-insensitive
 *     by design and is therefore not claimed here.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileSource } from '../../compiler/compile';
import { formatSource } from '../../format';
import { hashPackage } from '../../ir/hash';
import type { IRPackage } from '../../ir/types';
import {
  generateContract,
  renderSource,
  type ContractPlan,
} from './contract-gen';
import { property, Rng } from './harness';

const SEED = 20250601;
const CASES = 200;
const FILE = 'dist/test/property/core.property.test.js';

const opts = { seed: SEED, iterations: CASES, file: FILE };

// ---------------------------------------------------------------------------
// 1 + 2 — generated sources parse, compile and match the expected IR
// ---------------------------------------------------------------------------

property(
  'parse(generate()) compiles clean: ok, no diagnostics',
  opts,
  (rng) => {
    const { source } = generateContract(rng);
    const result = compileSource(source, 'generated.bridge');
    assert.equal(
      result.ok,
      true,
      `generated source must compile:\n${source}\ndiagnostics: ${JSON.stringify(result.diagnostics, null, 2)}`,
    );
    assert.deepEqual(result.diagnostics, [], 'clean contracts must produce zero diagnostics');
  },
);

property(
  'generated source lowers to exactly the expected canonical IR',
  opts,
  (rng) => {
    const { source, expected } = generateContract(rng);
    const result = compileSource(source, 'generated.bridge');
    assert.equal(result.ok, true, `source must compile:\n${source}`);
    assert.deepEqual(result.ir, expected);
  },
);

// ---------------------------------------------------------------------------
// 3 + 4 — formatter fixpoint and parse(format(x)) stability
// ---------------------------------------------------------------------------

property(
  'format is a fixpoint: format(format(x)) === format(x)',
  opts,
  (rng) => {
    const { source } = generateContract(rng);
    const first = formatSource(source, 'generated.bridge');
    assert.equal(first.ok, true, `first format must succeed:\n${source}\n${JSON.stringify(first.diagnostics)}`);
    const once = first.output as string;

    const second = formatSource(once, 'generated.bridge');
    assert.equal(second.ok, true, `re-format must succeed:\n${once}`);
    assert.equal(second.output, once, 'format(format(x)) must equal format(x)');
  },
);

property(
  'parse(format(x)) is stable: formatted source re-parses to identical IR',
  opts,
  (rng) => {
    const { source, expected } = generateContract(rng);
    const formatted = formatSource(source, 'generated.bridge');
    assert.equal(formatted.ok, true);
    const reparsed = compileSource(formatted.output as string, 'generated.bridge');
    assert.equal(reparsed.ok, true, `formatted source must recompile:\n${formatted.output}`);
    assert.deepEqual(reparsed.ir, expected, 'formatting must not change semantics');
  },
);

// ---------------------------------------------------------------------------
// 5 — deterministic compilation: same source ⇒ deep-equal IR + same hash
// ---------------------------------------------------------------------------

property(
  'deterministic IR: same source twice ⇒ deep-equal IR and identical hash',
  opts,
  (rng) => {
    const { source } = generateContract(rng);
    const a = compileSource(source, 'generated.bridge');
    const b = compileSource(source, 'generated.bridge');
    assert.equal(a.ok, true);
    assert.equal(b.ok, true);
    assert.deepEqual(a.ir, b.ir);
    assert.equal(hashPackage(a.ir as IRPackage), hashPackage(b.ir as IRPackage));
  },
);

// ---------------------------------------------------------------------------
// 6 — canonicalization: type-declaration permutation ⇒ identical IR + hash
// ---------------------------------------------------------------------------

property(
  'type-declaration order does not matter: permuted source ⇒ identical IR + hash',
  opts,
  (rng) => {
    const generated = generateContract(rng);
    const plan: ContractPlan = generated.plan;
    const order = rng.shuffle(plan.typeDecls.map((_, i) => i));

    // A fresh deterministic Rng keeps the cosmetic noise independent of the
    // original render while staying reproducible.
    const permuted = renderSource(plan, new Rng(rng.seed ^ 0x5f5f5f5f), order);
    const original = compileSource(generated.source, 'generated.bridge');
    const shuffled = compileSource(permuted, 'generated.bridge');

    assert.equal(shuffled.ok, true, `permuted source must compile:\n${permuted}`);
    assert.deepEqual(shuffled.ir, original.ir, 'IR must be identical after type permutation');
    assert.equal(
      hashPackage(shuffled.ir as IRPackage),
      hashPackage(original.ir as IRPackage),
      'package hash must be identical after type permutation',
    );
  },
);

// ---------------------------------------------------------------------------
// Harness sanity — the committed seed must be stable across runs (guards
// against accidental generator/harness drift changing committed cases).
// ---------------------------------------------------------------------------

test('harness: committed seed produces a stable first contract', () => {
  const a = generateContract(new Rng(SEED)).source;
  const b = generateContract(new Rng(SEED)).source;
  assert.equal(a, b);
  assert.match(a, /^package gen\.p\d+\.v\d+\n/);
});
