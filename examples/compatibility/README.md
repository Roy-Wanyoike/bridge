# compatibility — a compatible evolution passes the gate

Two revisions of an orders contract containing only consumer-safe changes:

- **v2 adds** the optional field `Order.note` → **SAFE**
- **v2 widens** the counter `Order.quantity` from `int32` to `int64` →
  **WARNING** (a widening primitive change: every generated language
  tolerates it, TypeScript consumers see the documented 2^53 precision
  caveat)

## Expected verdict: `WARNING` — passes in every mode

The report produced by the demo (verbatim):

```text
BRIDGE COMPATIBILITY REPORT
package: orders.v1

⚠ Type changed: Order.quantity (int32 → int64)
✓ Added optional field: Order.note

Summary: 1 safe, 1 warnings, 0 breaking, 0 unknown
Verdict: WARNING
Compatibility: PASSED
strict gate:      PASSED
compatible gate:  PASSED
Both modes pass: adding optional fields and widening int32 -> int64 never breaks consumers.
```

Compare with [versioning](../versioning), where a removed field produces a
`BREAKING` verdict and the strict gate fails.

## Files

| File | What it is |
| --- | --- |
| `v1.orders.bridge` | Revision 1 — the published baseline |
| `v2.orders.bridge` | Revision 2 — adds `note`, widens `quantity` |
| `demo.mjs` | Compiles both, prints the report, evaluates both gate modes |

## Run

From the repository root, build the workspace once:

```sh
npm install
npm run build
```

Then, from this directory:

```sh
node demo.mjs
```

## Which mode should CI use?

| Mode | SAFE | WARNING | UNKNOWN | BREAKING |
| --- | --- | --- | --- | --- |
| `strict` (default) | pass | pass | **fail** | **fail** |
| `compatible` | pass | pass | pass | **fail** |

`strict` never lets an undecidable diff slip through silently; `compatible`
is for teams that explicitly accept warnings and unknowns during a migration
window. See [COMPATIBILITY](../../docs/COMPATIBILITY.md) for the exit codes
and a ready-made GitHub Actions job.
