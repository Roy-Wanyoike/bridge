# registry — publish, discover, verify, depend

The local, content-addressed contract registry (`@bridge/registry`). The demo
publishes the canonical `payments.v1` contract plus a second contract
(`orders.v1`) that **imports** it, then walks the registry API.

## Files

| File | What it is |
| --- | --- |
| `orders.bridge` | A contract with `import payments.v1` and cross-package field types |
| `demo.mjs` | Publishes both contracts into a temp registry, runs the API walkthrough |

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

Expected output (deterministic — the publish timestamp is fixed, and hashes
are content addresses, not clock readings):

```text
published payments.v1  hash=1f7292582f39  version=v1
published orders.v1     hash=6ff00384acbd  version=v1
versions('payments.v1'): v1
search('payment'): payments.v1@v1
inspect('payments.v1', 'v1'): owner=team-payments imports=(none)
verify('payments.v1', 'v1'): ok=true hash matches content address (1f7292582f39)
dependents('payments.v1'): orders.v1@v1
```

## What to notice

- **Content addressing.** A version's identity is the SHA-256 of its canonical
  IR (`hashPackage`). Republishing identical content is a no-op; republishing
  different content under the same version throws `immutable`. Published
  versions are never mutated — see [versioning](../versioning) for how to
  evolve a contract instead.
- **The dependents graph.** Because `orders.v1` imports `payments.v1`, the
  registry knows `payments.v1` has a dependent. Before shipping a change to a
  shared contract, check who depends on it — and diff the change with the
  [compatibility engine](../compatibility).
- **Cross-package references.** `orders.bridge` references
  `payments.v1.Money`; the demo compiles it with
  `compilePackage(..., dependencies)` passing the already-compiled payments
  IR. Cross-package types are *opaque aliases* in generated code — see
  [IDL_REFERENCE](../../docs/IDL_REFERENCE.md#cross-package-references).
- **The version comes from the name.** `payments.v1` publishes as version
  `v1`; names without a version segment require an explicit version option.

## Storage layout

Everything lives under a single directory (the demo uses a temp dir; a real
team would commit `.bridge-registry/` or host it):

```
<root>/
  objects/<hash[0:2]>/<hash>.json          ← canonicalJson(ir), content-addressed
  packages/<base>/<version>/contract.json  ← { hash, package } pointer
  packages/<base>/<version>/meta.json      ← metadata (owner, description, …)
  index.json                               ← rebuilt on every publish
```

## CLI equivalents

```sh
bridge publish examples/payments/payments.bridge --registry .bridge-registry
bridge versions payments.v1 --registry .bridge-registry
bridge search payment --registry .bridge-registry
bridge inspect payments.v1 v1 --registry .bridge-registry
bridge pull payments.v1 v1 --registry .bridge-registry
```

See [QUICKSTART](../../docs/QUICKSTART.md) for the full command surface.
