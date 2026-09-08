/**
 * Property-based tests for the compatibility engine.
 *
 * Over seeded, generated contract pairs:
 *  - determinism: diffPackages is a pure function of the IR pair — repeated
 *    runs produce deep-equal reports and byte-identical rendered output;
 *  - monotonicity: removing a required field is ALWAYS BREAKING; adding an
 *    optional field is NEVER BREAKING (and SAFE) regardless of the rest of
 *    the contract;
 *  - verdict consistency: the report verdict equals the worst classification
 *    of its changes (the invariant `bridge check` gates on).
 *
 * Reproduce a failure with: BRIDGE_PROPERTY_SEED=<seed> BRIDGE_PROPERTY_CASE=<n>
 *   npm test --workspace @bridge/compat
 */
import { diffPackages, formatReportMarkdown } from '../../index';
import type { Change, CompatReport, IRPackage } from '../../index';
import type { IRField, IRTypeDefinition } from '@bridge/core';
import { property, Rng } from '@bridge/core/dist/test/property/harness';

// ---------------------------------------------------------------------------
// Local contract generation — small, self-contained, deterministic
// ---------------------------------------------------------------------------

const PRIMS = ['string', 'bool', 'int32', 'int64', 'uuid', 'timestamp'] as const;
const NAMES = ['Alpha', 'Beta', 'Gamma', 'Delta'];

function randomContract(rng: Rng): IRPackage {
  const typeCount = 1 + Math.floor(rng.float() * 3);
  const types: IRTypeDefinition[] = [];
  for (let i = 0; i < typeCount; i++) {
    const fieldCount = 1 + Math.floor(rng.float() * 4);
    const fields: IRField[] = [];
    for (let f = 0; f < fieldCount; f++) {
      const prim = PRIMS[Math.floor(rng.float() * PRIMS.length)] as (typeof PRIMS)[number];
      fields.push({
        name: `f${f}`,
        type: { kind: 'primitive', primitive: prim },
        optional: false,
        constraints: [],
      });
    }
    types.push({ kind: 'struct', name: NAMES[i % NAMES.length] + (i >= NAMES.length ? String(i) : ''), fields });
  }
  return {
    name: 'props.v1',
    imports: [],
    types: types.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
    services: [],
    events: [],
  };
}

/** Drop one required field from one struct (index picked by the rng). */
function dropRequiredField(ir: IRPackage, rng: Rng): { ir: IRPackage; path: string } {
  const structs = ir.types.filter(
    (t): t is IRTypeDefinition & { kind: 'struct' } => t.kind === 'struct' && t.fields.length > 0,
  );
  const target = structs[Math.floor(rng.float() * structs.length)];
  if (target === undefined) throw new Error('no struct with fields generated');
  const fieldIndex = Math.floor(rng.float() * target.fields.length);
  const field = target.fields[fieldIndex];
  if (field === undefined) throw new Error('no field picked');
  const types = ir.types.map((t) =>
    t === target
      ? ({ ...t, fields: t.fields.filter((_, i) => i !== fieldIndex) } as IRTypeDefinition)
      : t,
  );
  return { ir: { ...ir, types }, path: `${target.name}.${field.name}` };
}

/** Add an optional field to one struct. */
function addOptionalField(ir: IRPackage, rng: Rng): { ir: IRPackage; path: string } {
  const structs = ir.types.filter(
    (t): t is IRTypeDefinition & { kind: 'struct' } => t.kind === 'struct',
  );
  const target = structs[Math.floor(rng.float() * structs.length)];
  if (target === undefined) throw new Error('no struct generated');
  const suffix = Math.floor(rng.float() * 1000);
  const field: IRField = {
    name: `added_${suffix}`,
    type: { kind: 'primitive', primitive: 'string' },
    optional: true,
    constraints: [],
  };
  const types = ir.types.map((t) =>
    t === target ? ({ ...t, fields: [...t.fields, field] } as IRTypeDefinition) : t,
  );
  return { ir: { ...ir, types }, path: `${target.name}.${field.name}` };
}

function worstClass(changes: readonly Change[]): string {
  const rank = { BREAKING: 0, UNKNOWN: 1, WARNING: 2, SAFE: 3 };
  let worst = 'SAFE';
  for (const c of changes) {
    if (rank[c.classification] < rank[worst as keyof typeof rank]) {
      worst = c.classification;
    }
  }
  return worst;
}

// ---------------------------------------------------------------------------
// Properties
// ---------------------------------------------------------------------------

property(
  'compat: diff is deterministic — repeated runs are deep-equal with byte-identical markdown',
  { seed: 20260905, iterations: 200 },
  (rng) => {
    const base = randomContract(rng);
    const candidate = randomContract(rng);
    const r1: CompatReport = diffPackages(base, candidate);
    const r2: CompatReport = diffPackages(base, candidate);
    if (JSON.stringify(r1) !== JSON.stringify(r2)) {
      throw new Error('diffPackages is not deterministic (JSON differs between runs)');
    }
    if (formatReportMarkdown(r1, true, 'strict') !== formatReportMarkdown(r2, true, 'strict')) {
      throw new Error('markdown rendering is not deterministic');
    }
  },
);

property(
  'compat: removing a required field is always BREAKING',
  { seed: 20260906, iterations: 200 },
  (rng) => {
    const base = randomContract(rng);
    const mutation = dropRequiredField(base, rng);
    const report = diffPackages(base, mutation.ir);
    const removal = report.changes.find((c) => c.path === mutation.path);
    if (removal === undefined) {
      throw new Error(`expected a change at ${mutation.path}, got ${JSON.stringify(report.changes)}`);
    }
    if (removal.classification !== 'BREAKING') {
      throw new Error(`field removal classified ${removal.classification}, want BREAKING`);
    }
    if (report.verdict !== 'BREAKING') {
      throw new Error(`verdict ${report.verdict}, want BREAKING`);
    }
  },
);

property(
  'compat: adding an optional field is never BREAKING (SAFE)',
  { seed: 20260907, iterations: 200 },
  (rng) => {
    const base = randomContract(rng);
    const mutation = addOptionalField(base, rng);
    const report = diffPackages(base, mutation.ir);
    const addition = report.changes.find((c) => c.path === mutation.path);
    if (addition === undefined) {
      throw new Error(`expected a change at ${mutation.path}`);
    }
    if (addition.classification !== 'SAFE') {
      throw new Error(`optional-field addition classified ${addition.classification}, want SAFE`);
    }
    if (report.verdict === 'BREAKING') {
      throw new Error('verdict BREAKING from an optional-field addition');
    }
  },
);

property(
  'compat: verdict equals the worst change classification',
  { seed: 20260908, iterations: 200 },
  (rng) => {
    const base = randomContract(rng);
    const candidate = randomContract(rng);
    const report = diffPackages(base, candidate);
    const worst = worstClass(report.changes);
    if (report.verdict !== worst) {
      throw new Error(`verdict ${report.verdict} but worst change is ${worst}`);
    }
    const summaryTotal =
      report.summary.safe + report.summary.warning + report.summary.breaking + report.summary.unknown;
    if (summaryTotal !== report.changes.length) {
      throw new Error('summary counts do not match changes.length');
    }
  },
);
