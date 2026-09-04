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

**⚠ Bridge is under active development.** The foundation (IDL parser, canonical IR, compatibility engine, generators, CLI) is being built out. See the [roadmap](docs/ROADMAP.md) and [open issues](https://github.com/Roy-Wanyoike/bridge/issues) for current progress.

| Area | Status |
|------|--------|
| Bridge IDL (lexer, parser, AST) | 🟡 In progress |
| Canonical IR + schema hashing | 🟡 In progress |
| Compatibility engine (`bridge diff`) | 🟡 In progress |
| Generators (Go / Rust / TypeScript / Python) | 🟡 In progress |
| CLI | 🟡 In progress |
| Registry | 🔲 Planned |
| RPC + event contracts | 🔲 Planned |
| Dashboard | 🔲 Planned |

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
