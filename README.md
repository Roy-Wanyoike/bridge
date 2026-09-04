# Bridge

> **One contract. Every language. Zero interoperability drift.**

## The problem

If your stack spans more than one language, you live this: the same data contract — `Payment`, `PaymentStatus`, the rule that currency is exactly 3 characters — is hand-implemented in Go, re-implemented in TypeScript, re-implemented again in Python. Nothing keeps those copies in sync. A "harmless" field rename ships, and three weeks later a consumer in another runtime discovers it in production. Breaking-change checks, where they exist at all, are per-tool and per-format: a linter for your proto files, a differ for your OpenAPI specs — and nothing that knows *who consumes what*.

## The solution

Bridge is a polyglot contract compiler and compatibility platform. You define data and service contracts once in the Bridge IDL. The compiler produces a canonical, hashable IR and from it:

- **generates** idiomatic, dependency-free Go / Rust / TypeScript / Python — types, enums, tagged unions, service clients, event envelopes — with **runtime validators for every constraint**, so the same rules are enforced in every runtime, not just one;
- **detects breaking changes** before they ship: `bridge diff` classifies every change SAFE / WARNING / BREAKING / UNKNOWN against the IR, and `bridge check` fails your pipeline (strict mode fails undecidable changes too — never silently safe);
- **governs contracts** in a content-addressed registry: SHA-256 identity, immutable versions, tamper detection, and a dependency graph (`dependents`, `dependencies`) so impact analysis becomes a query, not archaeology.

## See it in 30 seconds

Real commands, real output — from the [runnable examples](examples/):

```console
$ bridge validate payments.bridge
✓ payments.bridge ok (package payments.v1, hash 1f7292582f39)

$ bridge generate payments.bridge --language go
✓ wrote generated/go/enums.go
✓ wrote generated/go/go.mod
✓ wrote generated/go/services.go
✓ wrote generated/go/types.go
✓ wrote generated/go/validate.go
5 file(s) written to generated/go (go)

$ bridge diff v1.payments.bridge v2.payments.bridge
BRIDGE COMPATIBILITY REPORT
package: payments.v1

❌ Breaking: Field renamed: Payment.currency → Payment.reference
⚠ Added enum value: PaymentStatus.REFUNDED

Summary: 0 safe, 1 warnings, 1 breaking, 0 unknown
Verdict: BREAKING
Compatibility: FAILED
```

That last one is the point: the rename a code reviewer would wave through fails the report — and `bridge check` (the CI form) exits non-zero so it never merges. Generated output is byte-deterministic: regenerating never produces diff churn, and a contract's hash is its identity.

## Why it matters

- **One contract, N languages — by compiler, not by discipline.** Hand-maintained bindings and per-language validators are where drift enters. Bridge generates all four languages and the validators from one IR, so parity is enforced, not hoped for.
- **Breaking changes are caught at merge time, with honest classification.** Checks are built into the compiler (not bolted onto a spec parser), deterministic, and conservative — an undecidable change is reported as UNKNOWN and fails the default gate.
- **The registry answers the question no other tool can:** "who consumes this contract, and what does this change do to them?" Content-addressed, immutable, with a real dependency graph — one registry for your services, events, and APIs, not one per wire format.
- **Built for the AI-agent era.** Agents calling typed tools are just more consumers of contracts. Bridge's constraint parity, deterministic hashing, and compatibility gates apply to machine-to-machine and model-to-tool surfaces the same way they apply to your Go and Python services.

## Architecture

```
                    Contract / IDL  (.bridge)
                         │
                  Compiler → canonical IR (frozen, SHA-256 hashed)
                         │
    ┌──────────┬─────────┼─────────┬──────────┐
    ▼          ▼         ▼         ▼          ▼
   Go        Rust        TS     Python      WASM*
    └──────────┴─────────┼─────────┴──────────┘
                         │
              Compatibility Engine
        (SAFE / WARNING / BREAKING / UNKNOWN)
                         │
        Contract Graph → Registry → CI Governance
```

\* planned. The five packages behind this diagram (`bridge-core`, `bridge-compat`, `bridge-generators`, `bridge-registry`, `bridge-cli`) communicate only through the frozen IR — details in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Language support

Every target below is generated from the same IR — types, enums, tagged unions, aliases, constraint validators, service clients/traits, and event envelopes:

| Language | Status | Notes |
|----------|--------|-------|
| Go       | ✅ Shipped | stdlib only; `encoding/json` tags; validator methods |
| Rust     | ✅ Shipped | serde; `@pattern` limitations documented |
| TypeScript | ✅ Shipped | strict types; documented `int64` (2^53) caveat |
| Python   | ✅ Shipped | stdlib dataclasses; `to_dict`/`from_dict` round-trip |
| Java / C# | 🔲 Planned | [issue #25](https://github.com/Roy-Wanyoike/bridge/issues/25) |
| WASM     | 🔲 Planned | [issue #22](https://github.com/Roy-Wanyoike/bridge/issues/22) (with Go ↔ Rust FFI) |

## Status

**Bridge 0.1.0 — the Phase 1 foundation is complete and tested: 355+ tests green across five packages.** See the [roadmap](docs/ROADMAP.md) and [open issues](https://github.com/Roy-Wanyoike/bridge/issues) for what's next.

| Area | Status |
|------|--------|
| Bridge IDL (lexer, parser, AST, semantic analysis) | ✅ Shipped |
| Canonical IR + deterministic schema hashing | ✅ Shipped |
| Canonical formatter (`bridge fmt`) | ✅ Shipped |
| Compatibility engine (`bridge diff`) | ✅ Shipped |
| Generators (Go / Rust / TypeScript / Python) | ✅ Shipped |
| CLI (init/validate/fmt/lint/generate/diff/check/publish/pull/versions/inspect/search/doctor) | ✅ Shipped |
| Local registry (immutable, content-addressed) | ✅ Shipped |
| Examples + docs + verification scripts | ✅ Shipped |
| Serialization round-trip matrix (Go↔Rust↔TS↔Python) | 🔬 In flight ([#15](https://github.com/Roy-Wanyoike/bridge/issues/15)) |
| Event + RPC transports | 🔬 In flight ([#16](https://github.com/Roy-Wanyoike/bridge/issues/16), [#17](https://github.com/Roy-Wanyoike/bridge/issues/17)) |
| Consumer-aware impact analysis + CI governance (`bridge impact`, `bridge check --against`) | ✅ Shipped |
| Registry service (server, auth, multi-tenancy) | 🔲 Planned ([#18](https://github.com/Roy-Wanyoike/bridge/issues/18)) |
| Dashboard | 🔲 Planned ([#20](https://github.com/Roy-Wanyoike/bridge/issues/20)) |
| LSP / IDE integration | 🔲 Planned ([#21](https://github.com/Roy-Wanyoike/bridge/issues/21)) |
| FFI (Go ↔ Rust) + WASM target | 🔲 Planned ([#22](https://github.com/Roy-Wanyoike/bridge/issues/22)) |

## Quick start

```sh
git clone https://github.com/Roy-Wanyoike/bridge.git
cd bridge
npm install && npm run build
alias bridge="node $(pwd)/packages/bridge-cli/dist/bin/bridge.js"

bridge init payments-service
cd payments-service
bridge validate                # compile the scaffolded contract
bridge generate --language go  # also: rust | typescript | python
bridge doctor
```

Requires Node.js >= 22.

Read the [Quickstart](docs/QUICKSTART.md), the [IDL reference](docs/IDL_REFERENCE.md), and the [compatibility guide](docs/COMPATIBILITY.md). Browse the [runnable examples](examples/) — including [versioning](examples/versioning), a complete BREAKING diff, and [go-python](examples/go-python), a live round-trip of generated code.

## Documentation

| Doc | What it covers |
|-----|----------------|
| [docs/QUICKSTART.md](docs/QUICKSTART.md) | From empty directory to generated, verified code |
| [docs/IDL_REFERENCE.md](docs/IDL_REFERENCE.md) | The full Bridge IDL: enums, unions, services, events, constraints |
| [docs/COMPATIBILITY.md](docs/COMPATIBILITY.md) | The classification matrix, CI gates, GitHub Actions recipe |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | The pipeline, the frozen IR contract, determinism guarantees |
| [docs/ROADMAP.md](docs/ROADMAP.md) | Three-phase public roadmap, linked to issues |
| [docs/strategy/MARKET_ANALYSIS.md](docs/strategy/MARKET_ANALYSIS.md) | Landscape, market gaps, competitive matrix, risks |
| [docs/strategy/POSITIONING.md](docs/strategy/POSITIONING.md) | Positioning, category, pitches, product principles |

## Repository layout

```
bridge/
├── packages/
│   ├── bridge-core/         # IDL lexer, parser, AST, semantic analysis, canonical IR
│   ├── bridge-compat/       # Compatibility engine: diff, classification, impact
│   ├── bridge-generators/   # Code generators: Go, Rust, TypeScript, Python
│   ├── bridge-registry/     # Contract registry (local + service)
│   └── bridge-cli/          # The `bridge` command line interface
├── examples/                # Seven complete, runnable examples with verified demos
└── docs/                    # Public documentation + strategy
```

## Development

```bash
git clone https://github.com/Roy-Wanyoike/bridge.git
cd bridge
npm install
npm run build
npm test
```

Requires Node.js >= 22. The test suite covers all five packages (compiler, generators, compat engine, registry, CLI); the `scripts/verify-*.sh` files additionally type-check and round-trip the generated code for every example.

## Contributing

Bridge is an open-source project and contributions are welcome. Start with [CONTRIBUTING.md](CONTRIBUTING.md). Good first issues are labeled [`good first issue`](https://github.com/Roy-Wanyoike/bridge/labels/good%20first%20issue), and the [roadmap issues](https://github.com/Roy-Wanyoike/bridge/issues) are the fastest way to see where help is needed.

## License

[MIT](LICENSE)
