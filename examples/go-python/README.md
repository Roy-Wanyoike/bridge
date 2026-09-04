# go-python — the flagship interop proof

Generates a Go module and a Python package from the single `billing.bridge`
contract — then, live, in front of you, **executes the generated Python** to
prove the wire format round-trips.

## Files

| File | What it is |
| --- | --- |
| `billing.bridge` | The contract: package `billing.v1` (`Money`, `Invoice`, `Billing` service) |
| `demo.mjs` | Generates Go + Python, runs a live Python `Money` round-trip via `python3` |
| `generated/` | Go output (gitignored — regenerate any time) |

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

Expected output (deterministic):

```text
go files:
  go.mod
  types.go
  enums.go
  validate.go
  services.go
wire dict: {'amount': 1250, 'currency': 'USD'}
round-trip OK: Money(amount=1250, currency=USD)
python files executed from a temp dir: 6
```

If `python3` is not installed, the demo prints
`python3 not available — skipping the live round-trip (CI covers this)` and
still exits 0; CI runs the check via `scripts/verify-python.sh`.

## What just happened

1. The demo compiled `billing.bridge` to the canonical IR.
2. It generated the **Go** module into `generated/go` for inspection, and the
   **Python** package into a throwaway temp directory.
3. It executed, with your system `python3`:

   ```python
   from billing_v1 import Money
   money = Money(amount=1250, currency="USD")
   wire = money.to_dict()
   decoded = Money.from_dict(wire)
   assert decoded == money
   ```

`to_dict()` produces the Bridge wire representation — the exact same JSON a
Go service marshalling `generated/go/types.go` would emit:
`{"amount": 1250, "currency": "USD"}`. That is the whole point of Bridge:
**one contract, every language, zero interoperability drift.**

The Python package is a plain `billing_v1` module: dataclasses with
`to_dict` / `from_dict` / `validate`, enums in `billing_v1/enums.py`, no
third-party dependencies. `verify-python.sh` re-runs this proof (plus
`ast.parse` on every generated file) across all examples.

## Verify the Go side

```sh
scripts/verify-go.sh   # go vet + go build per generated module; skips gracefully without a Go toolchain (CI covers it)
```

## Next steps

- [registry](../registry) — publish this contract once, depend on it everywhere
- [COMPATIBILITY](../../docs/COMPATIBILITY.md) — keep the wire format stable as the contract evolves
