/**
 * Structure-aware fuzzing for the Bridge compiler front-end.
 *
 * The fuzz engine takes a corpus of *valid* IDL sources, mutates them with
 * seeded character/block-level operations (delete/insert/duplicate/swap/
 * truncate — including nasty bytes: control characters, quotes, angle
 * brackets, unicode), and asserts the compiler pipeline honors its
 * never-throw contract:
 *
 * - `compileSource` / `formatSource` must NEVER throw on any input. The
 *   pipeline reports malformed input as diagnostics (or `BR2999` internal
 *   errors) instead. Any exception escaping either function is a bug and is
 *   recorded as a crash — throwing a non-Error value (string, number, bare
 *   object) is recorded as the worst crash class.
 *
 * Hangs cannot be observed from inside a synchronous call: a case that
 * never returns blocks the event loop. The runner therefore supports a
 * wall-clock `deadlineMs` (checked between cases) and is normally executed
 * inside a child process with a hard timeout by the test suites — see
 * docs/TESTING.md.
 *
 * Everything is seeded: case `i` derives its PRNG from
 * `mix(seed, firstCase + i)`, so any crash replays exactly with
 * `--seed <seed> --case <i>`.
 */

import { compileSource } from '../compiler/compile';
import { formatSource } from '../format';

// Self-contained PRNG (mulberry32 + splitmix-style mixer) — kept identical
// to packages/*/src/test/property/harness.ts so seeds mean the same thing.

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

/** Tiny deterministic RNG (subset of the test harness Rng). */
class FuzzRng implements RandomSource {
  private readonly nextFloat: () => number;
  constructor(seed: number) {
    this.nextFloat = mulberry32(seed);
  }
  float(): number {
    return this.nextFloat();
  }
  int(min: number, max: number): number {
    return min + Math.floor(this.nextFloat() * (max - min + 1));
  }
  bool(p = 0.5): boolean {
    return this.nextFloat() < p;
  }
  pick<T>(items: readonly T[]): T {
    return items[this.int(0, items.length - 1)] as T;
  }
}

/** Structural RNG surface consumed by the mutation engine (keeps the fuzzer
 * testable with any compatible rng, e.g. the property-harness Rng). */
export interface RandomSource {
  float(): number;
  int(min: number, max: number): number;
  bool(p?: number): boolean;
  pick<T>(items: readonly T[]): T;
}

// ---------------------------------------------------------------------------
// Corpus — valid IDL seeds covering the grammar surface
// ---------------------------------------------------------------------------

/** Default corpus: valid contracts exercising every declaration kind. */
export const DEFAULT_CORPUS: readonly string[] = [
  // Services + structs + enums + constraints (mirrors examples/payments).
  `package payments.v1

type Money {
    amount: int64
    currency: string @length(3)
}

enum PaymentStatus {
    PENDING
    COMPLETED
    FAILED
}

type Payment {
    id: uuid
    customer_id: uuid
    amount: Money
    status: PaymentStatus
    memo: string? = "none"
    created_at: timestamp
}

service Payments {
    CreatePayment(CreatePaymentRequest) -> Payment
    GetPayment(GetPaymentRequest) -> Payment
}

type CreatePaymentRequest {
    customer_id: uuid
    amount: Money
}

type GetPaymentRequest {
    id: uuid
}
`,
  // Unions, aliases, optionals, defaults, deprecations, docs.
  `/// Package-level documentation.
package support.tickets.v2

alias TicketId = uuid
alias Amount = decimal

union Contact {
    email: string @email
    phone: string @pattern("^+[0-9]{7,15}$")
    handle: string?
}

type Ticket {
    id: TicketId
    priority: int32 @min(1) @max(5) = 3
    contact: Contact
    tags: list<string> @length(0)
    score: float64?
    /// deprecated legacy field
    old_ref: uuid? @deprecated("use id")
    payload: json
}

event TicketClosed {
    ticket_id: uuid
    resolution: string @length(1, "must not be empty")
}
`,
  // Imports + qualified references + map/set types.
  `package orders.v1

import identity.v2
import common.types

type Order {
    id: common.types.Uuid
    owner: identity.v2.User
    lines: list<OrderLine>
    attributes: map<string, string>
    flags: set<string>
    total: Amount
}

alias Amount = decimal

type OrderLine {
    sku: string @pattern("^[A-Z0-9-]+$")
    quantity: uint32 @min(1)
}

service Orders {
    PlaceOrder(Order) -> Order
}
`,
  // Events with nested optionals and every primitive.
  `package telemetry.events.v1

enum Level {
    DEBUG
    INFO
    WARN
    ERROR
}

event MetricSampled {
    name: string
    value: float64
    unit: string?
    labels: map<string, string>
    recorded_at: timestamp
    raw: bytes?
    big: int64
    small: uint64
    flag: bool = true
}
`,
];

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

const NASTY_GROUPS = [
  '{}()<>[]', '?:@=,.;;', '"\'`', '/\\|', ' \t\n', '->', 'é🐍\u00e9',
  '\x00\x01\x02\x7f', 'type enum union alias', '0123456789', '%^&*!',
].join('');

/** Individual characters the mutators insert (surrogate-pair-safe). */
const NASTY_CHARS: readonly string[] = Array.from(NASTY_GROUPS);

const OP_NAMES = [
  'delete-char',
  'insert-char',
  'duplicate-block',
  'delete-block',
  'swap-blocks',
  'truncate',
  'insert-garbage',
] as const;

export type MutationOp = (typeof OP_NAMES)[number];

/**
 * Apply 1..maxOps random mutations to `source`. Exported for tests; the op
 * sequence is fully determined by the rng.
 */
export function mutateSource(
  rng: RandomSource,
  source: string,
  maxOps: number,
): { text: string; ops: MutationOp[] } {
  let text = source;
  const ops: MutationOp[] = [];
  const count = rng.int(1, Math.max(1, maxOps));
  for (let i = 0; i < count; i++) {
    const op = rng.pick(OP_NAMES);
    ops.push(op);
    text = applyOp(rng, op, text);
  }
  return { text, ops };
}

function applyOp(rng: RandomSource, op: MutationOp, text: string): string {
  if (text.length === 0) return randomGarbage(rng, rng.int(1, 20));
  switch (op) {
    case 'delete-char': {
      const at = rng.int(0, text.length - 1);
      return text.slice(0, at) + text.slice(at + 1);
    }
    case 'insert-char': {
      const at = rng.int(0, text.length);
      return text.slice(0, at) + rng.pick(NASTY_CHARS) + text.slice(at);
    }
    case 'duplicate-block': {
      const lines = text.split('\n');
      if (lines.length < 2) return text;
      const start = rng.int(0, lines.length - 2);
      const size = rng.int(1, Math.min(4, lines.length - start));
      const block = lines.slice(start, start + size);
      return [...lines.slice(0, start + size), ...block, ...lines.slice(start + size)].join('\n');
    }
    case 'delete-block': {
      const lines = text.split('\n');
      if (lines.length < 2) return text;
      const start = rng.int(0, lines.length - 1);
      const size = rng.int(1, Math.min(4, lines.length - start));
      return [...lines.slice(0, start), ...lines.slice(start + size)].join('\n');
    }
    case 'swap-blocks': {
      const lines = text.split('\n');
      if (lines.length < 3) return text;
      const aStart = rng.int(0, lines.length - 2);
      const aSize = rng.int(1, Math.min(3, lines.length - aStart));
      const bStart = rng.int(0, lines.length - 1);
      const bSize = rng.int(1, Math.min(3, lines.length - bStart));
      if (aStart === bStart) return text;
      const [lo, hi] = aStart < bStart ? [[aStart, aSize], [bStart, bSize]] : [[bStart, bSize], [aStart, aSize]];
      const lowStart = lo[0] as number;
      const lowSize = lo[1] as number;
      const highStart = hi[0] as number;
      const highSize = hi[1] as number;
      if (lowStart + lowSize > highStart) return text; // overlapping — skip
      const low = lines.slice(lowStart, lowStart + lowSize);
      const high = lines.slice(highStart, highStart + highSize);
      return [
        ...lines.slice(0, lowStart),
        ...high,
        ...lines.slice(lowStart + lowSize, highStart),
        ...low,
        ...lines.slice(highStart + highSize),
      ].join('\n');
    }
    case 'truncate': {
      const at = rng.int(0, text.length);
      return text.slice(0, at);
    }
    case 'insert-garbage': {
      const at = rng.int(0, text.length);
      return text.slice(0, at) + '\n' + randomGarbage(rng, rng.int(5, 60)) + '\n' + text.slice(at);
    }
  }
}

function randomGarbage(rng: RandomSource, length: number): string {
  let out = '';
  for (let i = 0; i < length; i++) out += rng.pick(NASTY_CHARS);
  return out;
}

// ---------------------------------------------------------------------------
// Targets + crash classification
// ---------------------------------------------------------------------------

export type FuzzTarget = 'compile' | 'format';

/**
 * Run one fuzz target. By contract `compileSource`/`formatSource` never
 * throw — if this function throws at all, the pipeline violated its
 * contract. Exported for tests.
 */
export function runTarget(target: FuzzTarget, source: string): number {
  switch (target) {
    case 'compile':
      return compileSource(source, 'fuzz.bridge').diagnostics.length;
    case 'format':
      return formatSource(source, 'fuzz.bridge').diagnostics.length;
  }
}

export interface CrashClassification {
  errorKind: 'non-throwable' | 'throwable';
  message: string;
}

/** Classify a value that escaped the pipeline (exported for tests). */
export function classifyThrow(error: unknown): CrashClassification {
  if (error instanceof Error) {
    return { errorKind: 'throwable', message: `${error.name}: ${error.message}` };
  }
  return { errorKind: 'non-throwable', message: `non-Error thrown: ${typeof error} ${String(error)}` };
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

export interface FuzzOptions {
  /** Number of mutated cases. Default 1000. */
  iterations?: number;
  /** Base seed. Default 0x5EEDC0DE (1592524062). */
  seed?: number;
  /** Valid seed sources. Defaults to {@link DEFAULT_CORPUS}. */
  corpus?: readonly string[];
  /** Maximum mutation operations per case. Default 8. */
  maxMutationsPerCase?: number;
  /** First case index (used by `--case` reproduction). Default 0. */
  firstCase?: number;
  /** Wall-clock budget in ms, checked between cases. Default: none. */
  deadlineMs?: number;
}

export interface FuzzCrash {
  /** Case index (absolute, i.e. includes firstCase). */
  case: number;
  caseSeed: number;
  ops: MutationOp[];
  target: FuzzTarget;
  errorKind: 'non-throwable' | 'throwable';
  message: string;
  mutatedSource: string;
}

export interface FuzzSummary {
  iterations: number;
  seed: number;
  /** Cases actually executed (may be < iterations with a deadline). */
  executed: number;
  /** Cases that produced zero diagnostics. */
  clean: number;
  /** Cases that produced at least one diagnostic (the good path). */
  diagnosticsFound: number;
  crashes: FuzzCrash[];
  stoppedEarly: boolean;
  elapsedMs: number;
}

export const DEFAULT_FUZZ_SEED = 0x5eedc0de;

/**
 * Run the fuzz loop. Never throws — crashes are returned, not raised, so
 * the CLI can print a reproduction recipe and exit non-zero.
 */
export function fuzzIdl(options: FuzzOptions = {}): FuzzSummary {
  const iterations = options.iterations ?? 1000;
  const seed = (options.seed ?? DEFAULT_FUZZ_SEED) >>> 0;
  const corpus = options.corpus ?? DEFAULT_CORPUS;
  const maxOps = options.maxMutationsPerCase ?? 8;
  const firstCase = options.firstCase ?? 0;
  const deadline = options.deadlineMs;

  const started = Date.now();
  const summary: FuzzSummary = {
    iterations,
    seed,
    executed: 0,
    clean: 0,
    diagnosticsFound: 0,
    crashes: [],
    stoppedEarly: false,
    elapsedMs: 0,
  };

  if (corpus.length === 0) {
    summary.elapsedMs = Date.now() - started;
    return summary;
  }

  for (let i = 0; i < iterations; i++) {
    if (deadline !== undefined && Date.now() - started > deadline) {
      summary.stoppedEarly = true;
      break;
    }
    const caseIndex = firstCase + i;
    const rng = new FuzzRng(mixSeed(seed, caseIndex));
    const seedSource = rng.pick(corpus);
    const { text, ops } = mutateSource(rng, seedSource, maxOps);

    for (const target of ['compile', 'format'] as const) {
      try {
        const diagnostics = runTarget(target, text);
        if (diagnostics > 0) summary.diagnosticsFound += 1;
        else summary.clean += 1;
      } catch (error) {
        const classified = classifyThrow(error);
        summary.crashes.push({
          case: caseIndex,
          caseSeed: mixSeed(seed, caseIndex),
          ops,
          target,
          errorKind: classified.errorKind,
          message: classified.message,
          mutatedSource: text,
        });
      }
    }
    summary.executed += 1;
  }

  summary.elapsedMs = Date.now() - started;
  return summary;
}
