/**
 * Property tests for the bridge-core fuzz harness (`src/fuzz`).
 *
 * The fuzzer mutates valid IDL sources (character/block-level operations,
 * nasty bytes) and asserts the compiler pipeline honors its never-throw
 * contract. Any exception escaping `compileSource`/`formatSource` is a
 * crash; throwing a non-Error value is the worst class. Hangs are covered
 * by the child-process CLI test (a synchronous hang would blow the spawned
 * process' hard timeout — see docs/TESTING.md).
 *
 * Committed seeds: in-process batches use 987654321 and 424242; the
 * generator-linked property uses the core seed 20250601.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { generateContract } from './contract-gen';
import { property, Rng } from './harness';
import {
  classifyTargetRun,
  classifyThrow,
  fuzzIdl,
  mutateSource,
  runTarget,
  type FuzzSummary,
} from '../../fuzz';
import type { Diagnostic } from '../../ir/types';

const PROPERTY_SEED = 20250601;
const PROPERTY_CASES = 200;

// ---------------------------------------------------------------------------
// Bounded fuzz batches against the built-in corpus
// ---------------------------------------------------------------------------

function assertAccounting(summary: FuzzSummary): void {
  // Each executed case runs exactly two targets (compile + format); every
  // target run lands in exactly one bucket: clean, diagnosticsFound or a
  // crash (a thrown exception OR a BR2999 internal-error diagnostic).
  assert.equal(
    summary.clean + summary.diagnosticsFound + summary.crashes.length,
    summary.executed * 2,
    'clean + diagnostics + crashes must account for every (case × target) run',
  );
}

test('fuzz: 500 seeded cases over the default corpus find zero crashes (seed 987654321)', () => {
  const summary = fuzzIdl({ iterations: 500, seed: 987654321 });
  assertAccounting(summary);
  assert.deepEqual(
    summary.crashes,
    [],
    `crashes found: ${JSON.stringify(summary.crashes.map((c) => [c.case, c.target, c.message]))}`,
  );
  assert.equal(summary.executed, 500);
});

test('fuzz: 500 seeded cases over the default corpus find zero crashes (seed 424242)', () => {
  const summary = fuzzIdl({ iterations: 500, seed: 424242 });
  assertAccounting(summary);
  assert.deepEqual(summary.crashes, []);
});

test('fuzz: same seed ⇒ identical case sequence (crash reproducibility)', () => {
  const a = fuzzIdl({ iterations: 120, seed: 777 });
  const b = fuzzIdl({ iterations: 120, seed: 777 });
  const strip = (s: FuzzSummary): Omit<FuzzSummary, 'elapsedMs'> => {
    const { elapsedMs: _elapsed, ...rest } = s;
    return rest;
  };
  assert.deepEqual(strip(a), strip(b));
});

// ---------------------------------------------------------------------------
// Generator-linked property: mutated *generated* contracts never throw
// ---------------------------------------------------------------------------

property(
  'fuzz targets never throw on mutated generated contracts',
  { seed: PROPERTY_SEED, iterations: PROPERTY_CASES, file: 'dist/test/property/fuzz.property.test.js' },
  (rng) => {
    const { source } = generateContract(rng);
    const { text, ops } = mutateSource(rng, source, 10);
    for (const target of ['compile', 'format'] as const) {
      try {
        runTarget(target, text);
      } catch (error) {
        const classified = classifyThrow(error);
        assert.fail(
          `target=${target} threw (${classified.errorKind}): ${classified.message}\n` +
            `ops: ${ops.join(',')}\nmutated source:\n${text}`,
        );
      }
    }
  },
);

test('fuzz: mutation op sequence is deterministic for a seed', () => {
  const a = mutateSource(new Rng(99), 'package a.v1\ntype T { x: int32 }', 6);
  const b = mutateSource(new Rng(99), 'package a.v1\ntype T { x: int32 }', 6);
  assert.deepEqual(a, b);
});

test('fuzz: classifyThrow separates throwable from non-throwable', () => {
  assert.deepEqual(classifyThrow(new TypeError('nope')), {
    errorKind: 'throwable',
    message: 'TypeError: nope',
  });
  assert.equal(classifyThrow('boom').errorKind, 'non-throwable');
  assert.equal(classifyThrow(42).errorKind, 'non-throwable');
  assert.equal(classifyThrow({ code: 1 }).errorKind, 'non-throwable');
});

// ---------------------------------------------------------------------------
// BR2999 internal-error diagnostics count as crashes (issue #42)
// ---------------------------------------------------------------------------

const INTERNAL_BR2999: Diagnostic = {
  severity: 'error',
  code: 'BR2999',
  message: 'Internal compiler error: Maximum call stack size exceeded',
  file: 'fuzz.bridge',
  line: 1,
  column: 1,
};

test('fuzz: classifyTargetRun counts BR2999 diagnostics as internal-error crashes', () => {
  assert.equal(classifyTargetRun([INTERNAL_BR2999]), 'internal-error');
  assert.equal(
    classifyTargetRun([
      { severity: 'error', code: 'BR1004', message: 'syntax', file: 'f', line: 1, column: 1 },
      INTERNAL_BR2999,
    ]),
    'internal-error',
    'BR2999 anywhere in the result is a crash, even mixed with real diagnostics',
  );
  assert.equal(
    classifyTargetRun([
      { severity: 'error', code: 'BR1004', message: 'syntax', file: 'f', line: 1, column: 1 },
    ]),
    'diagnostics',
  );
  assert.equal(
    classifyTargetRun([
      { severity: 'warning', code: 'BR2104', message: 'style', file: 'f', line: 1, column: 1 },
    ]),
    'diagnostics',
    'warnings are diagnostics, not crashes and not clean',
  );
  assert.equal(classifyTargetRun([]), 'clean');
});

test('fuzz: an 8000-deep `list<` seed yields BR1005 diagnostics — no crash, no BR2999', () => {
  // Regression for issue #42: pre-fix this seed produced a BR2999 internal
  // error that the harness counted under diagnosticsFound (crashes: 0) —
  // the classification and the parser depth limit together now make the
  // outcome a proper syntax diagnostic.
  const deep = `package p\ntype T {\n    x: ${'list<'.repeat(8000)}\n}\n`;
  for (const target of ['compile', 'format'] as const) {
    const diagnostics = runTarget(target, deep);
    assert.ok(diagnostics.some((d) => d.code === 'BR1005'), `${target}: BR1005 expected`);
    assert.ok(
      diagnostics.every((d) => d.code !== 'BR2999'),
      `${target}: internal error must not appear`,
    );
    assert.equal(classifyTargetRun(diagnostics), 'diagnostics');
  }

  // End-to-end through the runner: a deep-seed corpus finds no crashes.
  const summary = fuzzIdl({ corpus: [deep], iterations: 8, seed: 4242 });
  assertAccounting(summary);
  assert.equal(summary.crashes.length, 0);
  assert.equal(summary.executed, 8);
  assert.equal(summary.clean, 0, 'every mutation of the deep seed reports diagnostics');
  assert.equal(summary.diagnosticsFound, 16);
});

// ---------------------------------------------------------------------------
// CLI (child process) — doubles as the hang tripwire for the whole loop
// ---------------------------------------------------------------------------

const BIN = join(__dirname, '..', '..', '..', 'bin', 'bridge-fuzz.js');

test('fuzz CLI: bin/bridge-fuzz.js --iterations 300 --seed 424242 exits 0 with summary line', () => {
  const result = spawnSync(process.execPath, [BIN, '--iterations', '300', '--seed', '424242'], {
    encoding: 'utf8',
    timeout: 60_000, // hard kill — a hang in the pipeline fails this test
    killSignal: 'SIGKILL',
  });
  assert.equal(result.error, undefined, `spawn failed: ${result.error}`);
  assert.equal(
    result.status,
    0,
    `exit=${result.status} signal=${result.signal}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
  );
  assert.match(
    result.stdout,
    /^bridge-fuzz: iterations=300 seed=424242 executed=300 crashes=0 /,
    'one-line summary expected',
  );
});

test('fuzz CLI: --case repro mode runs exactly one case', () => {
  const result = spawnSync(process.execPath, [BIN, '--seed', '987654321', '--case', '17'], {
    encoding: 'utf8',
    timeout: 60_000,
  });
  assert.equal(result.status, 0, `exit=${result.status}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
  assert.match(result.stdout, /^bridge-fuzz: iterations=1 seed=987654321 executed=1 /);
});

test('fuzz CLI: invalid arguments exit 2 with usage on stderr', () => {
  const result = spawnSync(process.execPath, [BIN, '--bogus'], { encoding: 'utf8', timeout: 60_000 });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /unknown argument: --bogus/);
  assert.match(result.stderr, /Usage:/);
});
