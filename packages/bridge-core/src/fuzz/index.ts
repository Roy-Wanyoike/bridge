/**
 * @bridge/core fuzz module — structure-aware fuzzing for the compiler
 * front-end. Imported as `@bridge/core/dist/fuzz` (not part of the main
 * index so the compiler's public surface stays unchanged).
 */
export {
  DEFAULT_CORPUS,
  DEFAULT_FUZZ_SEED,
  classifyThrow,
  fuzzIdl,
  mixSeed,
  mulberry32,
  mutateSource,
  runTarget,
} from './fuzz';
export type {
  CrashClassification,
  FuzzCrash,
  FuzzOptions,
  FuzzSummary,
  FuzzTarget,
  MutationOp,
} from './fuzz';
export { USAGE, parseCliArgs, runCli, summaryLine } from './cli';
export type { CliOptions } from './cli';
