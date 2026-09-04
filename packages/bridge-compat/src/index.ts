/**
 * @bridge/compat — the Bridge compatibility engine.
 *
 * Compares two versions of a package's canonical IR (`IRPackage` from
 * `@bridge/core`) and classifies every change as SAFE / WARNING / BREAKING /
 * UNKNOWN so CI can block breaking contract evolution.
 *
 * Quick start:
 * ```ts
 * import { diffPackages, check, formatReport } from '@bridge/compat';
 *
 * const { passed, report } = check(publishedIr, candidateIr);
 * if (!passed) {
 *   console.error(formatReport(report));
 *   process.exitCode = 1;
 * }
 * ```
 *
 * Guarantees:
 * - Deterministic: identical inputs produce byte-identical reports,
 *   regardless of array order inside the IR.
 * - Conservative: undecidable comparisons (e.g. `json` involved in a type
 *   change) classify as UNKNOWN and fail the default strict gate — never
 *   silently SAFE.
 * - Zero runtime dependencies beyond `@bridge/core` (the frozen IR types).
 */
export type { Classification, Change, ChangeKind, CompatReport, DiffOptions } from './types';
export { diffPackages, check } from './diff';
export { formatReport, toJson } from './report';

/**
 * Re-export the canonical IR types (and hashing helpers) from `@bridge/core`
 * so downstream tooling can resolve everything compat-related from one
 * module. The engine consumes ONLY these types.
 */
export * from '@bridge/core';
