# payments — the canonical Bridge example

`payments.bridge` is the reference contract used throughout the Bridge
documentation: two services, a nested `Money` type, an enum, UUID/timestamp
primitives and a `@length` constraint.

## Files

| File | What it is |
| --- | --- |
| `payments.bridge` | The contract: package `payments.v1` |
| `demo.mjs` | Compiles the contract and prints the IR summary + content hash |

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

Expected output (deterministic — identical on every machine):

```text
package:  payments.v1
imports:  (none)
types:    CreatePaymentRequest, GetPaymentRequest, Money, Payment, PaymentStatus
service:  Payments { CreatePayment, GetPayment }
events:   (none)
short hash: 1f7292582f39
full hash:  1f7292582f39548a388fddeb60f08de8184e5fe149e042b47aa0939702b37565
The hash is content-addressed (SHA-256 of the canonical JSON of the IR):
identical contracts always produce the identical digest.
```

## What to notice

- Types are emitted sorted by name in the IR (`CreatePaymentRequest` before
  `Money`), regardless of declaration order — part of the determinism
  guarantees in [ARCHITECTURE](../../docs/ARCHITECTURE.md).
- Method signatures reference named structs only
  (`CreatePayment(CreatePaymentRequest) -> Payment`).
- The content hash is what the
  [registry](../registry) uses as a content address, and what
  [versioning](../versioning) diffs are compared against.

## Next steps

- [versioning](../versioning) — evolve this exact contract across versions
- [go-typescript](../go-typescript) / [go-python](../go-python) — generate
  real client/server types from contracts like this one
- [IDL_REFERENCE](../../docs/IDL_REFERENCE.md) — the whole language
