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
 *
 * Consumer-aware impact analysis (`computeImpact`) builds on the diff and a
 * registry-backed dependents walk; it takes a structural `ImpactRegistry`
 * (satisfied by `RegistryStore` from `@bridge/registry`) so this package
 * stays dependency-free. See docs/IMPACT.md for the heuristics and limits.
 */
export type { Classification, Change, ChangeKind, CompatReport, DiffOptions } from './types';
export { diffPackages, check } from './diff';
export { formatReport, toJson } from './report';
export { formatReportMarkdown } from './report-md';
export type {
  AffectedConsumer,
  ContactReason,
  ContractMetaLike,
  ImpactAnalysis,
  ImpactOptions,
  ImpactRegistry,
  ImpactReport,
  ImpactStats,
  SuggestedAction,
} from './impact-types';
export { computeImpact, ImpactError } from './impact';
export { formatImpactText, formatImpactMarkdown, formatImpactJson } from './impact-report';

/**
 * Re-export the canonical IR types (and hashing helpers) from `@bridge/core`
 * so downstream tooling can resolve everything compat-related from one
 * module. The engine consumes ONLY these types.
 */
export * from '@bridge/core';
