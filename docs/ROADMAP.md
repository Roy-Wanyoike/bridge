# Bridge Roadmap

A three-phase public roadmap. Every item links to a tracked [GitHub issue](https://github.com/Roy-Wanyoike/bridge/issues) — subscribe there for progress and design discussion. The strategy behind the sequence is in [docs/strategy/MARKET_ANALYSIS.md](strategy/MARKET_ANALYSIS.md) and [docs/strategy/POSITIONING.md](strategy/POSITIONING.md).

Legend: 🔲 planned · 🟡 in progress · ✅ done

## Phase 1 — The compiler era (shipped)

One IDL → one deterministic IR → validated code in four languages, with compatibility checking and an immutable registry. 355+ tests green across five packages.

| Capability | Status | Notes |
|------------|--------|-------|
| Bridge IDL grammar + lexer | ✅ | Primitives, structs, enums, unions, aliases, imports, packages, constraints, defaults, deprecation |
| Parser + AST with source locations | ✅ | Recoverable errors, did-you-mean hints |
| Semantic analysis + type resolution | ✅ | Reference checking, duplicate detection, constraint applicability (`BR1xxx`–`BR2xxx` diagnostics) |
| Canonical IR (deterministic, hashable) | ✅ | Stable ordering, SHA-256 over canonical JSON, frozen contract |
| Canonical formatter (`bridge fmt`) | ✅ | Idempotent, meaning-preserving |
| Compatibility engine (`bridge diff` / `check`) | ✅ | SAFE / WARNING / BREAKING / UNKNOWN; rename synthesis; strict + compatible gates |
| Go, Rust, TypeScript, Python generators | ✅ | Types, enums, tagged unions, aliases, validators, service clients/traits, event envelopes; byte-deterministic output |
| CLI (15 commands) | ✅ | `init` `validate` `fmt` `lint` `generate` `diff` `check` `publish` `pull` `versions` `inspect` `search` `doctor` `version` |
| Local registry | ✅ | Content-addressed, immutable, tamper detection, `dependents`/`dependencies` graph |
| Examples + verification scripts + docs | ✅ | Seven runnable examples; generated-code type-check and round-trip verification |
| CI: build, test matrix, generated-code verification | ✅ | GitHub Actions (Node 22/24 matrix + Go/Rust verify jobs) |

## Phase 2 — The governance era (in flight)

Prove wire-level correctness across languages, then turn the registry into the place where "who is affected?" is answerable — and make it a service.

| Capability | Status | Issue | Notes |
|------------|--------|-------|-------|
| Cross-language serialization round-trip matrix (Go↔Rust↔TS↔Python) | 🟡 | [#15](https://github.com/Roy-Wanyoike/bridge/issues/15) | Wire-format parity proofs, automated |
| Event contracts: transports + generated publishers/consumers | 🟡 | [#16](https://github.com/Roy-Wanyoike/bridge/issues/16) | IR already models events; transports land here |
| RPC transports beyond JSON clients (HTTP shapes, gRPC, Connect) | 🟡 | [#17](https://github.com/Roy-Wanyoike/bridge/issues/17) | Server + client generation |
| Consumer-aware impact analysis + CI governance | 🟡 | [#19](https://github.com/Roy-Wanyoike/bridge/issues/19) | "17 consumers affected" — diff × registry graph, enforced in CI |
| Registry service: server, OIDC auth, multi-tenancy, audit logs | 🔲 | [#18](https://github.com/Roy-Wanyoike/bridge/issues/18) | Networked evolution of the shipped local store |
| Dashboard (Next.js): contracts, versions, consumers, dependency graph | 🔲 | [#20](https://github.com/Roy-Wanyoike/bridge/issues/20) | Make the contract graph legible |
| Release engineering: binaries, package managers, containers, SBOM | 🔲 | [#24](https://github.com/Roy-Wanyoike/bridge/issues/24) | Linux/macOS/Windows, amd64/arm64; Homebrew, Docker, signing |
| Property-based + fuzz harness expansion, deterministic caching | 🔲 | [#23](https://github.com/Roy-Wanyoike/bridge/issues/23) | Parser/compat fuzzing; cache keyed on schema hash |

## Phase 3 — The platform & AI-native era (planned)

Widen the languages, lower the friction, and carry contracts across language boundaries — including to non-human consumers.

| Capability | Status | Issue | Notes |
|------------|--------|-------|-------|
| LSP server for the Bridge IDL | 🔲 | [#21](https://github.com/Roy-Wanyoike/bridge/issues/21) | VS Code, Neovim, JetBrains |
| Go ↔ Rust FFI (C ABI, safe wrappers) + WASM target | 🔲 | [#22](https://github.com/Roy-Wanyoike/bridge/issues/22) | One contract carries a function across the boundary, not just data |
| Java + C# generators | 🔲 | [#25](https://github.com/Roy-Wanyoike/bridge/issues/25) | Widens polyglot coverage to the JVM/.NET estates |
| AI-native tooling: tool-call/MCP schema emission from the IR | 🔲 | tracked under [#19](https://github.com/Roy-Wanyoike/bridge/issues/19) + [#22](https://github.com/Roy-Wanyoike/bridge/issues/22) discussion | Agent-facing contracts get the same governance plane (see [strategy](strategy/MARKET_ANALYSIS.md), Gap 6) |

Sequencing principle: every phase ships standalone value — the compiler, the gate, the registry, then the service — so no phase depends on a later one to be useful. Issues are the source of truth for scope; this file is the map.
