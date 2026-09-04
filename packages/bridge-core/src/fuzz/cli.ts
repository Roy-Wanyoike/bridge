/**
 * CLI plumbing for the Bridge IDL fuzzer (`bin/bridge-fuzz.js`).
 *
 * Usage:
 *   node bin/bridge-fuzz.js [--iterations N] [--seed S] [--case K]
 *                           [--corpus FILE] [--max-mutations N]
 *                           [--deadline-ms MS] [--json]
 *
 * Prints a one-line summary and exits 0 when no crashes were found; exits 1
 * with per-crash details and a `--seed`/`--case` reproduction recipe
 * otherwise; exits 2 on invalid arguments.
 */

import { readFileSync } from 'node:fs';
import { DEFAULT_CORPUS, fuzzIdl, type FuzzSummary } from './fuzz';

export const USAGE = `bridge-fuzz — structure-aware fuzzer for the Bridge IDL compiler

Usage:
  bridge-fuzz [options]

Options:
  --iterations N       Number of mutated cases (default 1000).
  --seed S             Base seed (default 1592524062 = 0x5EEDC0DE).
  --case K             Run only case K (implies --iterations 1); repro helper.
  --corpus FILE        Use the given file as the single seed source
                       (defaults to the built-in corpus of valid contracts).
  --max-mutations N    Max mutation operations per case (default 8).
  --deadline-ms MS     Stop between cases after this wall-clock budget.
  --json               Print the full summary as JSON instead of one line.

Exit codes: 0 = no crashes, 1 = crashes found, 2 = bad arguments.
`;

export interface CliOptions {
  iterations: number;
  seed: number;
  firstCase: number;
  corpus?: readonly string[];
  maxMutationsPerCase: number;
  deadlineMs?: number;
  json: boolean;
}

export function parseCliArgs(
  argv: readonly string[],
): { ok: true; options: CliOptions } | { ok: false; error: string } {
  const options: CliOptions = {
    iterations: 1000,
    seed: 0x5eedc0de,
    firstCase: 0,
    maxMutationsPerCase: 8,
    json: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = (): string | undefined => {
      const v = argv[i + 1];
      i += 1;
      return v;
    };
    switch (arg) {
      case '--iterations': {
        const n = Number(value());
        if (!Number.isInteger(n) || n < 1) return { ok: false, error: `--iterations needs a positive integer` };
        options.iterations = n;
        break;
      }
      case '--seed': {
        const n = Number(value());
        if (!Number.isInteger(n) || n < 0) return { ok: false, error: `--seed needs a non-negative integer` };
        options.seed = n >>> 0;
        break;
      }
      case '--case': {
        const n = Number(value());
        if (!Number.isInteger(n) || n < 0) return { ok: false, error: `--case needs a non-negative integer` };
        options.firstCase = n;
        options.iterations = 1;
        break;
      }
      case '--max-mutations': {
        const n = Number(value());
        if (!Number.isInteger(n) || n < 1) return { ok: false, error: `--max-mutations needs a positive integer` };
        options.maxMutationsPerCase = n;
        break;
      }
      case '--deadline-ms': {
        const n = Number(value());
        if (!Number.isInteger(n) || n < 1) return { ok: false, error: `--deadline-ms needs a positive integer` };
        options.deadlineMs = n;
        break;
      }
      case '--corpus': {
        const file = value();
        if (file === undefined || file === '') return { ok: false, error: `--corpus needs a file path` };
        try {
          options.corpus = [readFileSync(file, 'utf8')];
        } catch (cause) {
          const message = cause instanceof Error ? cause.message : String(cause);
          return { ok: false, error: `cannot read corpus file ${file}: ${message}` };
        }
        break;
      }
      case '--json':
        options.json = true;
        break;
      case '--help':
      case '-h':
        return { ok: false, error: '' };
      default:
        return { ok: false, error: `unknown argument: ${arg ?? '<empty>'}` };
    }
  }
  return { ok: true, options };
}

/** One-line summary, e.g. `bridge-fuzz: iterations=10000 seed=1337 crashes=0 …` */
export function summaryLine(summary: FuzzSummary): string {
  return (
    `bridge-fuzz: iterations=${summary.iterations} seed=${summary.seed}` +
    ` executed=${summary.executed} crashes=${summary.crashes.length}` +
    ` clean=${summary.clean} diagnostics=${summary.diagnosticsFound}` +
    ` stoppedEarly=${summary.stoppedEarly} elapsedMs=${summary.elapsedMs}`
  );
}

/** Run the CLI. Returns the process exit code. */
export function runCli(argv: readonly string[]): number {
  const parsed = parseCliArgs(argv);
  if (!parsed.ok) {
    if (parsed.error !== '') {
      process.stderr.write(`bridge-fuzz: ${parsed.error}\n\n${USAGE}`);
    } else {
      process.stdout.write(USAGE);
      return 0;
    }
    return 2;
  }

  const summary = fuzzIdl({
    iterations: parsed.options.iterations,
    seed: parsed.options.seed,
    corpus: parsed.options.corpus ?? DEFAULT_CORPUS,
    maxMutationsPerCase: parsed.options.maxMutationsPerCase,
    firstCase: parsed.options.firstCase,
    deadlineMs: parsed.options.deadlineMs,
  });

  if (parsed.options.json) {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  } else {
    process.stdout.write(`${summaryLine(summary)}\n`);
    for (const crash of summary.crashes) {
      process.stdout.write(
        [
          `CRASH case=${crash.case} target=${crash.target} kind=${crash.errorKind}`,
          `  ops: ${crash.ops.join(', ')}`,
          `  message: ${crash.message}`,
          `  repro: node bin/bridge-fuzz.js --seed ${summary.seed} --case ${crash.case}`,
          `  mutated source (first 400 chars):`,
          ...chunk(crash.mutatedSource, 400),
          '',
        ].join('\n'),
      );
    }
  }
  return summary.crashes.length === 0 ? 0 : 1;
}

function chunk(text: string, max: number): string[] {
  const head = text.slice(0, max);
  return head.length === 0 ? ['<empty>'] : [head.length < text.length ? `${head}…` : head];
}
