# Consumer-aware impact analysis & CI governance

> *This contract changed — who feels it?*

`bridge impact` combines the compatibility diff with the registry's dependency
graph. Instead of reporting "Money.currency removed" and stopping there, it
walks every transitive consumer of the contract and tells you which of them
the change reaches, how it reaches them, and what to do before shipping.

## Quick tour

Publish a few contracts that depend on each other, then evolve the base one:

```sh
bridge publish payments.bridge --registry .bridge-registry --owner payments-team
bridge publish fraud.bridge    --registry .bridge-registry   # imports payments.v1
bridge publish orders.bridge   --registry .bridge-registry   # imports fraud.v2

bridge impact payments.v1 --to candidate.bridge --registry .bridge-registry
```

Terminal output (abridged):

```
BRIDGE IMPACT REPORT
contract: payments.v1
change: payments.v1@v1 → candidate.bridge

❌ Breaking: Money.currency removed

Summary: 0 safe, 0 warnings, 1 breaking, 0 unknown
Verdict: BREAKING

Consumers: 3 discovered, 2 affected (breaking 2, unknown 0, warning 0, safe 1)
  ❌ fraud.v2@v2 — depth 1 — BREAKING — references Money
  ❌ orders.v1@v1 — depth 2 — BREAKING — through `fraud.v2` (FraudCheck)
  ✓ catalog.v1@v1 — depth 1 — SAFE — no changed type is referenced

Suggested actions:
  ❌ Money.currency (field-removed)
     Deprecate the field first, migrate the listed consumers, then remove it in a future version.
     Consumers to migrate first: fraud.v2, orders.v1
```

One line of output answers the question most tooling cannot: **orders.v1, two
hops away, breaks because it references FraudCheck, which references Money.**

## The reachability model

The engine answers "who feels this change?" with a three-step analysis:

1. **Diff** — the candidate is diffed against the baseline with the standard
   compatibility engine (SAFE / WARNING / BREAKING / UNKNOWN, see
   [COMPATIBILITY.md](COMPATIBILITY.md)).
2. **Graph walk** — starting from the changed package, the registry's
   `dependents` relation is walked breadth-first. Depth 1 are direct
   dependents (contracts importing the changed package); depth 2+ are reached
   through intermediates. The walk is cycle-safe and deterministic.
3. **Reachability filter** — each discovered consumer's IR is scanned for
   references to the changed types. A consumer is counted as affected when a
   change reaches it through one of these contact reasons (strongest wins):

| Reason          | Meaning                                                                    |
| --------------- | -------------------------------------------------------------------------- |
| `direct-type`   | The consumer's IR references a changed type by qualified name.             |
| `through`       | Reached via a tainted intermediate contract the consumer references.        |
| `event`         | Direct dependent flagged for an event-level change (see limits).           |
| `package-renamed` | The package itself was renamed — every dependent is conservatively affected. |
| `unscannable`   | The consumer's IR could not be pulled — conservatively counted as affected. |
| `unaffected`    | Scanned successfully; no changed type is reachable. Reported as SAFE.      |

Every discovered consumer appears in the report — the unaffected ones carry
`severity: SAFE` — so the list doubles as a census of who was scanned and
cleared, not just who was hit.

### Honest limits

Impact analysis is **static type-reference reachability**. It does not track:

- **Field-level usage** — a consumer that references `Payment` but never reads
  `Payment.currency` still counts as affected by its removal.
- **Service callers and event subscribers** — IR records that a service or
  event exists, not which contracts call or subscribe to it. Event changes are
  attributed to direct dependents only.
- **Dynamic references** — types referenced only through `json` fields or
  built dynamically are invisible.

These limits are stated in every report (the "Coverage note"), and the JSON
output exposes `analysis.method` so downstream tooling can assert on how a
report was produced. Consumers whose IR cannot be pulled are always counted as
affected — absence of evidence never clears a consumer.

## Output formats

| Format     | Use                                                       |
| ---------- | --------------------------------------------------------- |
| `table`    | Default terminal report (shown above).                    |
| `json`     | Deterministic, stable keys — for automation.              |
| `markdown` | GitHub PR-comment ready: summary table, consumer tables with owners, per-change suggested actions. |

All three are pure functions of the report: identical inputs produce
byte-identical output, which makes snapshot assertions and caching safe.

## CI governance

Two commands gate changes, both exit `1` on failure and `0` on pass —
designed to be the only bridge-aware step a pipeline needs.

### `bridge check` — the gate

```sh
# Fail on BREAKING or UNKNOWN changes vs the published baseline:
bridge check candidate.bridge --against payments.v1 --registry .bridge-registry

# Full governance: also fail on WARNING changes:
bridge check candidate.bridge --against payments.v1 --registry .bridge-registry --strict
```

Baselines are either a file (`--against ./old/payment.bridge`) or a published
registry reference (`--against payments.v1` / `--against payments.v1@v1`).
`--format markdown` renders a PR-comment-ready verdict.

### `bridge impact` — the gate with a consumer report

```sh
bridge impact payments.v1 --to candidate.bridge --registry .bridge-registry --strict
```

Advisory by default (exit 0); with `--strict` it exits 1 when any BREAKING
change reaches at least one consumer contract, after walking the graph.

### Example workflow

[`.github/workflows/bridge-governance.yml.example`](../.github/workflows/bridge-governance.yml.example)
is a copy-pasteable PR workflow that posts the markdown impact report as a
sticky PR comment and fails the PR on breaking changes. Copy it into
`.github/workflows/bridge-governance.yml` and adjust the registry path.

## JSON schema (stabilized fields)

```
ImpactReport {
  contract: string            # changed package name
  fromRef / toRef: string     # human-readable baseline / candidate labels
  changes: Change[]           # standard compat changes (path, kind, classification, …)
  affectedConsumers: [{
    packageName, version      # consumer identity
    depth                     # BFS depth: 1 = direct dependent
    severity                  # worst classification reaching it
    reason                    # contact reason (table above)
    scanned                   # false when IR could not be pulled
    viaTypes, viaPackages     # how the change reaches it (sorted, deterministic)
    owner?, repository?       # registry metadata, verbatim
  }]
  stats: { total, breaking, warning, safe, unknown,
           consumersAffected, consumersBreakingAffected }
  suggestedActions: [{ path, kind, classification, action, reaches[] }]
  verdict: Classification     # worst across changes
  analysis: { graphTraversed, method, notes[] }
}
```

`method` is always `"type-reference-reachability"` — treat any other value as
a signal that a future engine version changed the semantics.
