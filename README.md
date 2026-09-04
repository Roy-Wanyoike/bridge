# Bridge

> **One contract. Every language. Zero interoperability drift.**

Bridge is a polyglot contract compiler and compatibility platform. Define your data and service contracts once in the Bridge IDL, then generate idiomatic, validated, production-ready code for every language in your stack — and detect breaking changes before they ship.

```bridge
package payments.v1

type Money {
    amount: int64
    currency: string @length(3)
}

enum PaymentStatus {
    PENDING
    COMPLETED
    FAILED
    REFUNDED
}

type Payment {
    id: uuid
    customer_id: uuid
    amount: Money
    status: PaymentStatus
    created_at: timestamp
}

service Payments {
    CreatePayment(CreatePaymentRequest) -> Payment
    GetPayment(GetPaymentRequest) -> Payment
}
```

## Status

**Bridge 0.1.0 — the Phase 1 foundation is complete and tested (311 tests green).** See the [roadmap](docs/ROADMAP.md) and [open issues](https://github.com/Roy-Wanyoike/bridge/issues) for what's next.

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
| RPC + event transports | 🔲 Planned |
| Registry service (server, auth, multi-tenancy) | 🔲 Planned |
| Dashboard | 🔲 Planned |
| LSP / IDE integration | 🔲 Planned |
| FFI (Go ↔ Rust) + WASM target | 🔲 Planned |

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

Read the [Quickstart](docs/QUICKSTART.md), the [IDL reference](docs/IDL_REFERENCE.md), and the [compatibility guide](docs/COMPATIBILITY.md). Browse the [runnable examples](examples/).

## Vision

```
                    Contract / IDL
                         │
                  Compiler / IR
                         │
    ┌──────────┬─────────┼─────────┬──────────┐
    ▼          ▼         ▼         ▼          ▼
   Go        Rust        TS     Python      WASM
    └──────────┴─────────┼─────────┴──────────┘
                         │
              Compatibility Engine
                         │
        Contract Graph → Registry → CI Governance
```

## Repository layout

```
bridge/
├── packages/
│   ├── bridge-core/         # IDL lexer, parser, AST, semantic analysis, canonical IR
│   ├── bridge-compat/       # Compatibility engine: diff, classification, impact
│   ├── bridge-generators/   # Code generators: Go, Rust, TypeScript, Python
│   ├── bridge-registry/     # Contract registry (local + service)
│   └── bridge-cli/          # The `bridge` command line interface
├── examples/                # Complete, runnable examples
└── docs/                    # Public documentation
```

## Development

```bash
git clone https://github.com/Roy-Wanyoike/bridge.git
cd bridge
npm install
npm test
```

Requires Node.js >= 20.

## Contributing

Bridge is an open-source project and contributions are welcome. Start with [CONTRIBUTING.md](CONTRIBUTING.md). Good first issues are labeled [`good first issue`](https://github.com/Roy-Wanyoike/bridge/labels/good%20first%20issue).

## License

[MIT](LICENSE)
