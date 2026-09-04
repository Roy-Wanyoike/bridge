# versioning — evolving a contract across versions

Two revisions of the payments contract and the Bridge compatibility engine
(`@bridge/compat`) diffing them:

- **v2 adds** the optional field `Payment.reference` and the enum value
  `PaymentStatus.REFUNDED`.
- **v2 removes** the field `Payment.currency` (the denormalized copy — the
  authoritative one is `amount.currency`). Removing a field is **BREAKING**.

## Expected diff verdict: `BREAKING`

The report produced by the demo (verbatim):

```text
BRIDGE COMPATIBILITY REPORT
package: payments.v1

❌ Breaking: Field renamed: Payment.currency → Payment.reference
⚠ Added enum value: PaymentStatus.REFUNDED

Summary: 0 safe, 1 warnings, 1 breaking, 0 unknown
Verdict: BREAKING
Compatibility: FAILED
CI gate: `bridge check` would exit 1 — release the candidate under a NEW major name, never overwrite the published version.
```

Three things worth understanding:

1. **The verdict is BREAKING and the strict gate fails.** A pipeline running
   `bridge check v1.payments.bridge v2.payments.bridge` exits `1` and blocks
   the release. The demo script itself still exits `0` — it *successfully
   demonstrated* a breaking diff; CI gates on the `check()` boolean / CLI exit
   code instead.

2. **Why "Field renamed" instead of "field removed + field added"?** The
   engine synthesizes a rename when a version contains *exactly one* removed
   field and *exactly one* added field with deeply equal types. Here both
   `currency` and `reference` are `string` fields (optional-ness and
   constraints live outside the type), so the engine reports the more precise
   diagnosis: a rename. Renames are always BREAKING — old readers keep asking
   for `currency`, new writers stop sending it. Had the added field carried a
   different type, you would see separate `field-removed` (BREAKING) and
   `field-added` (SAFE) lines instead.

3. **The enum addition is a WARNING, not SAFE.** Existing readers tolerate the
   new value, but exhaustive switches (Rust `match`, Go swarms of `case`)
   may not handle `REFUNDED`. See
   [COMPATIBILITY](../../docs/COMPATIBILITY.md) for the full classification
   matrix.

## Files

| File | What it is |
| --- | --- |
| `v1.payments.bridge` | Revision 1 — the published baseline |
| `v2.payments.bridge` | Revision 2 — the candidate (adds `reference`, adds `REFUNDED`, removes `currency`) |
| `demo.mjs` | Compiles both, runs `diffPackages` + `check`, prints the report |

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

The report is deterministic — identical bytes on every machine and in CI.

## Try the CLI instead

The same check from the command line (see [QUICKSTART](../../docs/QUICKSTART.md)):

```sh
bridge diff examples/versioning/v1.payments.bridge examples/versioning/v2.payments.bridge
bridge check examples/versioning/v1.payments.bridge examples/versioning/v2.payments.bridge   # exit 1
```

## Next steps

- [compatibility](../compatibility) — a SAFE/WARNING-grade change that passes
- [COMPATIBILITY](../../docs/COMPATIBILITY.md) — classification table, modes,
  CI recipes
