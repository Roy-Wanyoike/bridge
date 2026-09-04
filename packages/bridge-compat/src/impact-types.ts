/**
 * Public types of the Bridge consumer-aware impact engine.
 *
 * The engine answers one question: *this contract changed — who feels it?*
 * It reuses the diff classification from `diff.ts` and combines it with a
 * transitive walk over the registry's dependent graph. See `impact.ts` for
 * the reachability heuristics and `impact-report.ts` for rendering.
 */
import type { IRPackage } from '@bridge/core';
import type { Change, ChangeKind, Classification, CompatReport } from './types';

/**
 * Minimal structural view of one published contract's metadata.
 *
 * A structural subset of `ContractMeta` from `@bridge/registry` — the engine
 * deliberately does NOT depend on the registry package; any object with this
 * shape works (real stores, test doubles, remote mirrors).
 */
export interface ContractMetaLike {
  /** Full dotted package name as published, e.g. `'fraud.v2'`. */
  readonly packageName: string;
  /** Storage base derived from the name, e.g. `'fraud'`. */
  readonly base: string;
  /** Normalized version, e.g. `'v2'`. */
  readonly version: string;
  /** Names of the packages this contract imports (recorded at publish). */
  readonly imports: readonly string[];
  /** Owning team or person, when recorded. */
  readonly owner?: string;
  /** Repository URL or identifier, when recorded. */
  readonly repository?: string;
}

/**
 * Minimal structural registry view used to walk the consumer graph.
 *
 * `RegistryStore` from `@bridge/registry` satisfies this interface as-is;
 * declaring it structurally keeps `@bridge/compat` dependency-free.
 */
export interface ImpactRegistry {
  /** Direct dependents of a package (contracts importing it, by name or base). */
  dependents(packageName: string): ContractMetaLike[];
  /** Load one stored contract version (IR plus its metadata). */
  pull(packageName: string, version: string): { ir: IRPackage; meta: ContractMetaLike };
  /** Latest published metadata of a package (by base name). */
  latest(packageName: string): ContractMetaLike;
}

/**
 * How the change was determined to reach a consumer. Priority when several
 * apply (strongest wins): `package-renamed` > `direct-type` > `through` >
 * `event` > `unscannable` > `unaffected`.
 */
export type ContactReason =
  /**
   * The consumer's IR references at least one changed type of the changed
   * package by qualified name (e.g. `payments.v1.Money`).
   */
  | 'direct-type'
  /** Reached through a tainted intermediate contract that the consumer references. */
  | 'through'
  /**
   * Direct dependent flagged for an event-level change (event subscriptions
   * are not visible in contract IR, so this is a conservative direct-only rule).
   */
  | 'event'
  /** The package itself was renamed — every dependent is conservatively affected. */
  | 'package-renamed'
  /** The consumer's IR could not be pulled; conservatively counted as affected. */
  | 'unscannable'
  /** Scanned successfully; no changed type is reachable from this consumer. */
  | 'unaffected';

/** One discovered consumer contract and how the change reaches it. */
export interface AffectedConsumer {
  /** Full package name of the consumer contract, e.g. `'fraud.v2'`. */
  packageName: string;
  /** Published version of the consumer contract, e.g. `'v2'`. */
  version: string;
  /**
   * BFS depth from the changed package: 1 = direct dependent, 2 = depends on
   * a direct dependent, … (minimum depth over all paths, via the registry's
   * deterministic dependents order).
   */
  depth: number;
  /** Worst classification among the changes that reach this consumer. */
  severity: Classification;
  /** Strongest contact reason (see {@link ContactReason} ordering). */
  reason: ContactReason;
  /** `false` when the consumer's IR could not be pulled from the registry. */
  scanned: boolean;
  /**
   * Type names (or event names for the `event` reason) through which the
   * change reaches this consumer, sorted. Empty for rename/unscannable.
   */
  viaTypes: string[];
  /**
   * Package route from the changed package to this consumer, in path order:
   * `[anchor, …intermediates, consumer]`. Deterministic (first BFS discovery
   * path).
   */
  viaPackages: string[];
  /** Owner metadata, verbatim from the registry meta (omitted when absent). */
  owner?: string;
  /** Repository metadata, verbatim from the registry meta (omitted when absent). */
  repository?: string;
}

/** One suggested follow-up per detected change (aligned with `changes`). */
export interface SuggestedAction {
  /** Path of the corresponding change (e.g. `Payment.currency`). */
  path: string;
  /** Kind of the corresponding change. */
  kind: ChangeKind;
  /** Classification of the corresponding change. */
  classification: Classification;
  /** Concrete, kind-specific guidance for evolving the contract safely. */
  action: string;
  /**
   * Consumer contracts this specific change reaches (transitive, sorted).
   * Empty when no discovered consumer is touched by this change.
   */
  reaches: string[];
}

/** Roll-up counts over the discovered consumer graph. */
export interface ImpactStats {
  /** All transitive dependents discovered in the registry. */
  consumersTotal: number;
  /** Consumers whose IR was pulled and analyzed. */
  consumersScanned: number;
  /** Consumers touched by at least one non-SAFE change. */
  consumersAffected: number;
  /** Direct dependents (depth 1). */
  direct: number;
  /** Indirect dependents (depth ≥ 2). */
  indirect: number;
  /** Consumers by the worst severity reaching them (`safe` = scanned but untouched). */
  bySeverity: { breaking: number; unknown: number; warning: number; safe: number };
}

/** How the analysis was produced — surfaced so reports state their own limits. */
export interface ImpactAnalysis {
  /** `false` when no registry was supplied: no consumer graph was traversed. */
  graphTraversed: boolean;
  /** Fixed identifier of the reachability method used. */
  method: 'type-reference-reachability';
  /** Situational caveats encountered during the walk (deterministic order). */
  notes: string[];
}

/** Result of {@link computeImpact}: diff + consumer graph + guidance. */
export interface ImpactReport {
  /**
   * Name of the changed (anchor) package — the OLD name consumers reference.
   * A rename surfaces as a change in `changes`; the new name appears in
   * `to` and in the rename change itself.
   */
  packageName: string;
  /** Human-readable identity of the baseline, e.g. `payments.v1@v1`. */
  from: string;
  /** Human-readable identity of the candidate, e.g. `payments.v1@v2`. */
  to: string;
  /** All detected changes in the canonical order of `diffPackages`. */
  changes: Change[];
  /** Worst classification across `changes` (BREAKING > UNKNOWN > WARNING > SAFE). */
  verdict: Classification;
  /** Count of changes per classification. */
  summary: CompatReport['summary'];
  /** One suggested action per change, same order as `changes`. */
  suggestedActions: SuggestedAction[];
  /**
   * Every discovered transitive dependent, sorted by name then version.
   * Consumers untouched by any non-SAFE change carry `reason: 'unaffected'`.
   */
  consumers: AffectedConsumer[];
  /** Aggregate counts over `consumers`. */
  stats: ImpactStats;
  /** How the analysis was performed, including its limits. */
  analysis: ImpactAnalysis;
}

/** Input for {@link computeImpact}. See the function docs for the exact rules. */
export interface ImpactOptions {
  /**
   * Baseline (published) IR. Omit when `oldName` is given — the baseline is
   * then pulled from the registry (`oldName` with `@version`, else latest).
   */
  oldIR?: IRPackage;
  /**
   * Candidate (new) IR. Omit when `newVersion` is given — the candidate is
   * then pulled from the registry as the next version of the same package.
   */
  newIR?: IRPackage;
  /**
   * Published name of the baseline contract, e.g. `'payments.v1'`,
   * `'payments.v1@v1'` or `'payments'` (→ latest). Requires `registry`.
   */
  oldName?: string;
  /** Published version of the candidate, e.g. `'v2'`. Requires `oldName` + `registry`. */
  newVersion?: string;
  /**
   * Registry to walk for the consumer graph (satisfied by `RegistryStore`).
   * Optional: without it the diff is still computed but no consumers are
   * reported (`analysis.graphTraversed === false`).
   */
  registry?: ImpactRegistry;
  /** Overrides for the human-readable `from`/`to` labels (e.g. file paths). */
  labels?: { from?: string; to?: string };
}
