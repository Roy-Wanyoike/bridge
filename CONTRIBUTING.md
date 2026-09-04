# Contributing to Bridge

Thank you for your interest in contributing to Bridge! This document explains how to get started, how we review changes, and what we expect from every contribution.

## Code of Conduct

By participating in this project you agree to abide by our [Code of Conduct](CODE_OF_CONDUCT.md).

## Getting started

1. Fork the repository and create your branch from `main`.
2. Install dependencies: `npm install` (Node.js >= 20 required).
3. Run the test suite: `npm test`.
4. Make your changes with tests. A feature is not done when the code exists — it is done when it is implemented, tested, documented, and verified.

## Repository layout

| Path | Description |
|------|-------------|
| `packages/bridge-core` | IDL lexer, parser, AST, semantic analysis, canonical IR |
| `packages/bridge-compat` | Compatibility engine (diff, classification, impact analysis) |
| `packages/bridge-generators` | Code generators (Go, Rust, TypeScript, Python) |
| `packages/bridge-registry` | Contract registry |
| `packages/bridge-cli` | The `bridge` CLI |
| `examples/` | Runnable examples |

## Pull request guidelines

- One feature or fix per pull request. Keep PRs reviewable.
- Every PR must include tests that fail without your change and pass with it.
- Generated code must be deterministic: no timestamps, random IDs, or machine-specific paths in output.
- Never weaken validation or disable tests to make CI green.
- Update documentation when behavior changes.
- Write clear commit messages: imperative mood, e.g. `Add enum value detection to compat engine`.

## Area-specific guides

### Compiler (bridge-core)

The compiler pipeline is: `IDL → Lexer → Parser → AST → Semantic Analysis → Canonical IR → Generators`. Language generators must depend only on the canonical IR, never on parser internals. Identical input must always produce identical IR (deterministic, hashable, stable ordering).

### Compatibility engine (bridge-compat)

Every detected change must be classified as `SAFE`, `WARNING`, `BREAKING`, or `UNKNOWN`. When in doubt, classify conservatively (`BREAKING` or `UNKNOWN`), never silently.

### Generators (bridge-generators)

Generated code must compile, pass lint in the target language, follow language conventions, and round-trip serialize correctly. Include snapshot tests for every generator.

## Reporting issues

- Bug reports: use the bug report template and include a minimal repro.
- Feature requests: use the feature request template and describe the use case, not just the solution.
- Security issues: do **not** open a public issue. Follow [SECURITY.md](SECURITY.md).

## Review process

Maintainers review PRs for correctness, tests, documentation, and architectural fit. CI must pass (build, lint, tests) before merge. Larger changes should start as a GitHub issue or discussion so the design can be agreed before implementation.
