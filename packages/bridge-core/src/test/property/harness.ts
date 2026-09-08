/**
 * Deterministic property-testing harness for the Bridge test suites.
 *
 * Zero dependencies, no shrinking (v1 — see docs/TESTING.md): every property
 * runs a fixed number of cases, where case `i` gets a PRNG seeded with
 * `mix(baseSeed, i)`. The same base seed therefore produces the exact same
 * case sequence on every machine and every run, and any failing case can be
 * replayed in isolation:
 *
 *   BRIDGE_PROPERTY_SEED=<base> BRIDGE_PROPERTY_CASE=<i> \
 *     node --test <the compiled .test.js file>
 *
 * Environment overrides (used by the failure message above and by CI):
 * - `BRIDGE_PROPERTY_SEED`       — override the committed base seed.
 * - `BRIDGE_PROPERTY_CASE`       — run a single case index (repro mode).
 * - `BRIDGE_PROPERTY_ITERATIONS` — override the case count.
 */

import { test } from 'node:test';

// ---------------------------------------------------------------------------
// Seeded PRNG — mulberry32 (tiny, fast, well-distributed; deterministic).
// ---------------------------------------------------------------------------

/** Create a mulberry32 generator: returns floats in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** splitmix32-style mixer: spreads consecutive case indices over the seed space. */
export function mixSeed(baseSeed: number, caseIndex: number): number {
  let z = ((baseSeed ^ 0x9e3779b9) + Math.imul(caseIndex + 1, 0x85ebca6b)) >>> 0;
  z = Math.imul(z ^ (z >>> 16), 0x21f0aaad) >>> 0;
  z = Math.imul(z ^ (z >>> 15), 0x735a2d97) >>> 0;
  return (z ^ (z >>> 15)) >>> 0;
}

/** Random source with the draws the generators need. Fully deterministic. */
export class Rng {
  private readonly nextFloat: () => number;

  constructor(seed: number) {
    this.nextFloat = mulberry32(seed);
    this.seed = seed >>> 0;
  }

  /** The seed this Rng was constructed with (for repro messages). */
  readonly seed: number;

  /** Float in [0, 1). */
  float(): number {
    return this.nextFloat();
  }

  /** Integer in [min, max] (inclusive). */
  int(min: number, max: number): number {
    return min + Math.floor(this.nextFloat() * (max - min + 1));
  }

  /** True with probability `p`. */
  bool(p = 0.5): boolean {
    return this.nextFloat() < p;
  }

  /** Uniform pick; the array must be non-empty. */
  pick<T>(items: readonly T[]): T {
    return items[this.int(0, items.length - 1)] as T;
  }

  /** Fisher–Yates shuffle (returns a copy; input untouched). */
  shuffle<T>(items: readonly T[]): T[] {
    const out = [...items];
    for (let i = out.length - 1; i > 0; i--) {
      const j = this.int(0, i);
      const tmp = out[i] as T;
      out[i] = out[j] as T;
      out[j] = tmp;
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// Property runner
// ---------------------------------------------------------------------------

export const ENV_SEED = 'BRIDGE_PROPERTY_SEED';
export const ENV_CASE = 'BRIDGE_PROPERTY_CASE';
export const ENV_ITERATIONS = 'BRIDGE_PROPERTY_ITERATIONS';

function envInt(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return undefined;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer, got: ${raw}`);
  }
  return parsed;
}

export interface PropertyOptions {
  /** Committed base seed. Override at runtime with `BRIDGE_PROPERTY_SEED`. */
  seed: number;
  /** Number of generated cases. Override at runtime with `BRIDGE_PROPERTY_ITERATIONS`. */
  iterations: number;
  /** Compiled suite file name (relative to the package root), for repro messages. */
  file?: string;
}

/**
 * Register a node:test that runs `iterations` generated cases.
 *
 * Case `i` receives `new Rng(mixSeed(baseSeed, i))`. The first failure fails
 * the whole test with a message carrying the base seed, the case index and a
 * copy-pasteable reproduction command. Shrinking is out of scope for v1 —
 * reproducibility is the substitute: the failing case replays exactly.
 */
export function property(
  name: string,
  options: PropertyOptions,
  runCase: (rng: Rng, caseIndex: number) => void,
): void {
  const committedSeed = options.seed;
  const committedIterations = options.iterations;
  const file = options.file ?? 'dist/test/property/<suite>.test.js';

  test(`${name} [seed=${committedSeed}, cases=${committedIterations}]`, () => {
    const baseSeed = envInt(ENV_SEED) ?? committedSeed;
    const iterations = envInt(ENV_ITERATIONS) ?? committedIterations;
    const onlyCase = envInt(ENV_CASE);

    const first = onlyCase ?? 0;
    const last = onlyCase ?? iterations - 1;
    if (last >= iterations) {
      throw new Error(`case ${onlyCase} out of range (iterations=${iterations})`);
    }

    for (let i = first; i <= last; i++) {
      const caseSeed = mixSeed(baseSeed, i);
      try {
        runCase(new Rng(caseSeed), i);
      } catch (cause) {
        const detail = cause instanceof Error ? cause.message : String(cause);
        const stack = cause instanceof Error && cause.stack ? `\n${cause.stack}` : '';
        throw new Error(
          [
            `Property FAILED: ${name}`,
            `  case:      ${i}`,
            `  base seed: ${baseSeed}${onlyCase === undefined ? '' : ` (committed: ${committedSeed})`}`,
            `  case seed: ${caseSeed}`,
            `  repro:     ${ENV_SEED}=${baseSeed} ${ENV_CASE}=${i} node --test ${file}`,
            ``,
            `  error: ${detail}${stack}`,
          ].join('\n'),
        );
      }
    }
  });
}

// ---------------------------------------------------------------------------
// Comparison helpers
// ---------------------------------------------------------------------------

/** Byte equality for Uint8Array-ish values. */
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
