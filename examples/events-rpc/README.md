# events-rpc example

Events + RPC end to end: generate code for this contract, then run the
cross-language verification:

```sh
bridge validate store.bridge
bridge generate store.bridge --language python --out generated/python
bridge generate store.bridge --language typescript --out generated/ts
../../scripts/verify-events-rpc.sh
```

What the verification proves (all over real TCP loopback):

1. Python client ↔ Python server round trip (stdlib `http.server`).
2. **TypeScript client ↔ Python server** — different processes, different
   languages, one wire shape.
3. A Python-emitted event envelope is decoded by the generated TypeScript
   dispatcher (identical CloudEvents-style envelope in every language).
4. Server-side constraint validation: `currency: "EURO"` → 400
   `invalid_argument` before any handler code runs.
5. Generated Go compiles and its `httptest` round-trip tests pass.
6. Generated Rust compiles and its loopback `tests/roundtrip.rs` pass.

See [docs/EVENTS.md](../../docs/EVENTS.md) and [docs/RPC.md](../../docs/RPC.md)
for the wire contracts.
