# Bridge Compatibility Guide

The Bridge compatibility engine (`@bridge/compat`, CLI `diff` / `check`)
compares two versions of a package's canonical IR and classifies every
change so CI can block breaking contract evolution.

```
bridge diff <old.bridge> <new.bridge>   # report only — always exits 0
bridge check <old.bridge> <new.bridge>  # CI gate — exits 1 when the gate fails
```

Both commands accept the same optional flags as the API
(`--mode compatible`, see [Modes](#modes) below).

---

## Classification

Every detected change gets exactly one of four classifications:

| Classification | Meaning |
| --- | --- |
| `SAFE` | Provably harmless to all consumers. |
| `WARNING` | Visible change that well-behaved consumers tolerate — but strict readers or exhaustive switches may not. |
| `BREAKING` | Guaranteed to break at least one class of consumers. |
| `UNKNOWN` | The engine cannot decide confidently (e.g. a `json` primitive is involved in a type change). **Never silently downgraded** — UNKNOWN fails the default strict gate. |

## Classification matrix

### Struct fields (matched by name; also applied nested to event fields)

| Change | Classification |
| --- | --- |
| Optional field added | SAFE |
| Required field added | WARNING |
| Field removed | BREAKING |
| Field removed + field added with deeply equal types (exactly one of each) | **BREAKING** — synthesized into one `field-renamed` |
| Field renamed | BREAKING |
| Type change — primitive widening (e.g. `int32 → int64`) | WARNING |
| Type change — anything else | BREAKING |
| Required → optional | SAFE |
| Optional → required | BREAKING |
| Default value changed | WARNING |
| Constraint added / removed / arguments changed | WARNING |
| Constraint message-only change | SAFE |
| Deprecation added | SAFE |
| Deprecation removed | WARNING |

### Enums, unions, aliases, types

| Change | Classification |
| --- | --- |
| Enum value added | WARNING |
| Enum value removed | BREAKING |
| Union variant added | WARNING |
| Union variant removed | BREAKING |
| Union variant type changed | BREAKING |
| Alias target changed | BREAKING (aliases are transparent) |
| Type / alias added | SAFE |
| Type / alias removed | BREAKING |
| Type kind changed (struct → enum, …) | BREAKING |

### Services, events, package envelope

| Change | Classification |
| --- | --- |
| Method added | SAFE |
| Method removed | BREAKING |
| Method signature changed (`input`/`output`) | BREAKING |
| Event added | SAFE |
| Event removed | BREAKING |
| Event field changed (any field rule, nested) | per field rule above, kind `event-field-changed` |
| Package renamed | BREAKING (default) — downgrade to WARNING with `packageRenameBreaking: false` |
| Import added / removed | SAFE |

The report's **verdict** is the worst classification across all changes:
`BREAKING > UNKNOWN > WARNING > SAFE`. An unchanged package diffs to SAFE
with an empty change list.

## Modes

`check()` — and `bridge check` — apply a failure policy to the verdict:

| Verdict | `strict` (default) | `compatible` |
| --- | --- | --- |
| SAFE | passes | passes |
| WARNING | passes | passes |
| UNKNOWN | **fails** | passes |
| BREAKING | **fails** | **fails** |

- `strict` implements the strict compatibility policy: breaking **and**
  undecidable changes fail. This is the default because the engine never
  classifies an undecidable change as SAFE — the mode only decides whether
  such a verdict gates the pipeline.
- `compatible` fails only on definite BREAKING changes — for teams that
  explicitly accept warnings and unknowns during a migration window.

## Exit codes

| Command | Exit `0` | Exit `1` |
| --- | --- | --- |
| `bridge diff <old> <new>` | always (report-only) | — |
| `bridge check <old> <new>` | gate passed | gate failed (BREAKING or UNKNOWN under `strict`; BREAKING under `compatible`) |

Both commands print the same human-readable report (plus, for `check`, the
`Compatibility: PASSED/FAILED` line). Use `diff` in PR descriptions and
`check` in CI steps.

## Report format

```
BRIDGE COMPATIBILITY REPORT
package: payments.v1

❌ Breaking: Field renamed: Payment.currency → Payment.reference
⚠ Added enum value: PaymentStatus.REFUNDED

Summary: 0 safe, 1 warnings, 1 breaking, 0 unknown
Verdict: BREAKING
Compatibility: FAILED
```

- Lines are sorted `BREAKING → UNKNOWN → WARNING → SAFE` (path ascending
  within a group) — reports are byte-identical regardless of input order.
- `toJson(report)` serializes deterministically for machine consumption.

## CI usage

### GitHub Actions

```yaml
name: contract-compat
on:
  pull_request:
    paths:
      - "**.bridge"

jobs:
  compat:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0          # need the baseline from main
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npm install && npm run build
      - name: Fetch baseline contracts from main
        run: git checkout origin/main -- contracts/ || echo "no baseline yet"
      - name: Check compatibility
        run: |
          for contract in contracts/*.bridge; do
            base="baseline/$(basename "$contract")"
            [ -f "$base" ] || continue
            bridge check "$base" "$contract"
          done
```

A failing `bridge check` exits non-zero and blocks the merge. Teams that
accept unknowns during a migration window switch that step to
`bridge check --mode compatible "$base" "$contract"`.

### Why gate on the IR and not the source text?

Source formatting and comment changes never affect the IR, so reformatting
a contract cannot fail your pipeline. The engine compares the canonical IR
(`IRPackage` from `@bridge/core`) — the same structure the generators and
registry consume (see [ARCHITECTURE](./ARCHITECTURE.md)).

## Worked examples

The [examples](../examples) directory ships two complete, runnable diffs:

- [examples/versioning](../examples/versioning) — BREAKING: field removal
  (synthesized as a rename) + enum value addition → strict gate fails.
- [examples/compatibility](../examples/compatibility) — SAFE/WARNING:
  optional field added + `int32 → int64` widening → passes in both modes.

## API quick reference

```ts
import { compileSource } from '@bridge/core';
import { diffPackages, check, formatReport, toJson } from '@bridge/compat';

const oldIr = compileSource(oldText, 'v1.bridge').ir;
const newIr = compileSource(newText, 'v2.bridge').ir;

const report = diffPackages(oldIr, newIr);          // full CompatReport
const { passed } = check(oldIr, newIr);             // strict gate decision
const { passed: lenient } = check(oldIr, newIr, { mode: 'compatible' });

console.log(formatReport(report));
console.log(toJson(report));                        // deterministic JSON
```

Guarantees: deterministic (identical inputs → byte-identical reports,
regardless of array order inside the IR), conservative (undecidable is
never silently SAFE), and zero runtime dependencies beyond the frozen IR
types.
