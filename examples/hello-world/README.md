# hello-world — your first Bridge contract

The smallest possible Bridge contract: one package, one type, one constraint,
one optional field.

## Files

| File | What it is |
| --- | --- |
| `hello.bridge` | The contract: `hello.v1` with a `Greeting` type |
| `demo.mjs` | Compiles the contract and inspects the canonical IR |

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
package: hello.v1
Greeting fields:
  name: string @length(1)
  message: string (optional)
short hash: d58f3181e672
The hash is content-addressed: identical contracts always produce the identical digest.
```

## What to notice

- `@length(1)` is a validation constraint; it travels into the IR and every
  generator (see [IDL_REFERENCE](../../docs/IDL_REFERENCE.md#constraints) for
  the full set).
- `message: string?` marks an optional field — absent-aware on the wire in
  every generated language.
- The short hash is the SHA-256 of the canonical JSON encoding of the IR.
  Whitespace and comments in the `.bridge` file do not matter; the IR does.

## Next steps

- [payments](../payments) — a fuller contract with services
- [QUICKSTART](../../docs/QUICKSTART.md) — install → contract → generate
- [IDL_REFERENCE](../../docs/IDL_REFERENCE.md) — the whole language
