# Bridge Roadmap

This roadmap tracks the major capability areas of Bridge and their current status. Work is tracked in [GitHub issues](https://github.com/Roy-Wanyoike/bridge/issues).

Legend: 🔲 planned · 🟡 in progress · ✅ done

## Phase 1 — Foundation (current)

| Capability | Status | Notes |
|------------|--------|-------|
| Bridge IDL grammar + lexer | 🟡 | Primitives, structs, enums, imports, packages |
| Parser + AST with source locations | 🟡 | |
| Semantic analysis + type resolution | 🟡 | Reference checking, duplicate detection |
| Canonical IR (deterministic, hashable) | 🟡 | Stable ordering, schema hashing |
| Compatibility engine (`bridge diff`) | 🟡 | SAFE / WARNING / BREAKING / UNKNOWN classification |
| Go generator | 🟡 | |
| Rust generator | 🟡 | |
| TypeScript generator | 🟡 | |
| Python generator | 🟡 | |
| CLI: `init`, `fmt`, `lint`, `validate`, `generate`, `diff`, `check`, `version` | 🟡 | |
| Local registry (`publish`, `pull`, `versions`, `inspect`) | 🟡 | Filesystem-backed, content-addressed |
| CI: build, test, generated-code verification | 🟡 | GitHub Actions |

## Phase 2 — Contracts in earnest

- Full IDL surface: unions, generics, aliases, sets, maps, annotations, defaults, constraints, events, errors, deprecation
- Validation codegen for constraints (`@email`, `@min`, `@max`, `@length`, …)
- Serialization round-trip guarantees: Go ↔ Rust ↔ TypeScript ↔ Python
- RPC contract generation (clients + server interfaces, HTTP + gRPC shapes)
- Event contracts (schemas, publishers, consumers)
- Deterministic caching keyed on schema hash + compiler/generator versions
- Reproducible generation (byte-identical output for identical input)
- Property-based testing harness for generated code
- Fuzzing the parser and compatibility engine

## Phase 3 — Platform

- Registry service with API, auth (OIDC), multi-tenancy, audit logs
- Contract dependency graph + consumer-aware impact analysis
- Governance policies enforceable in CI
- Documentation generator (Markdown, HTML, OpenAPI, JSON Schema)
- Dashboard (Next.js): contracts, versions, consumers, compatibility, graphs
- GitHub App / PR comments for contract checks
- Go ↔ Rust FFI support (C ABI with safe wrappers)
- WASM target

## Phase 4 — Ecosystem

- `bridge doctor`, `bridge dev` watch mode, `bridge docs`, `bridge migrate`
- LSP (VS Code, Neovim, JetBrains) + editor tooling
- Release engineering: binaries (Linux/macOS/Windows, amd64/arm64), Homebrew, Docker images, SBOM, signing
- Java and C# generators
- AI-assisted migration proposals (deterministic pipeline remains source of truth)
