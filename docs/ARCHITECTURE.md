# Bridge Architecture

How a `.bridge` file becomes generated code, a compatibility verdict, and a
registry entry — and why the intermediate representation is the load-bearing
wall of the whole system.

```
                        ┌─────────────────────────────────────────────┐
                        │              @bridge/core                   │
                        │                                             │
  .bridge source  ───►  │  lexer ──► parser ──► AST ──► semantic ──┐  │
  (text, UTF-8)         │                              analysis    │  │
                        │                                          ▼  │
                        │                                    canonical │
                        │                                    IR        │
                        │                                          │  │
                        │              hashPackage ◄───────────────┤  │
                        └──────────────┬───────────────────────────┴──┘
                                       │  IRPackage (frozen)
             ┌─────────────────┬───────┴────────┬──────────────────┐
             ▼                 ▼                ▼                  ▼
      ┌─────────────┐   ┌─────────────┐  ┌─────────────┐   ┌─────────────┐
      │  generators │   │    compat   │  │   registry  │   │  CLI + docs │
      │ @bridge/    │   │ @bridge/    │  │ @bridge/    │   │ (thin       │
      │ generators  │   │ compat      │  │ registry    │   │  wrappers)  │
      └──────┬──────┘   └──────┬──────┘  └──────┬──────┘   └─────────────┘
             ▼                 ▼                ▼
      Go / Rust /       CompatReport       .bridge-registry/
      TypeScript /      SAFE/WARNING/      objects/<hash>.json
      Python files      BREAKING/UNKNOWN   packages/<base>/<version>/
      (byte-deterministic)  (deterministic)   (content-addressed)
```

## Pipeline (inside @bridge/core)

1. **Lexer** — turns source text into tokens. Knows keywords, the 13
   primitives, punctuation, `///` doc comments and string literals with
   escapes. Lexical errors (`BR1001`–`BR1003`) are reported, never thrown.
2. **Parser** — recursive descent over the token stream producing an AST
   with 1-based line/column on every node. Grammar:
   `package`, `import`, `type`, `enum`, `union`, `alias`, `service`,
   `event`, fields with constraints/defaults/deprecation. Syntax errors
   (`BR1004`) are recoverable — the parser reports and continues.
3. **Semantic analysis** — name resolution (locals + imported packages),
   duplicate detection, method-signature, map-key, optionality and
   constraint-applicability rules (`BR2001`–`BR2015`), plus style warnings
   (`BR2101`–`BR2103`). Cross-package references are validated only when the
   caller supplies already-compiled dependencies (`compilePackage`);
   `compileSource` records imports without resolving them.
4. **Canonical IR** — the semantic stage emits an `IRPackage`: dotted
   package name, sorted deduplicated `imports`, types **sorted by name**,
   services and events in declaration order, all constraints with their
   textual arguments, and doc comments.

The compiler **never throws on malformed input**: every entry point returns
`{ ok, ir?, diagnostics }` and renders through `formatDiagnostic` (the
canonical `bridge validate` output shape).

## The frozen IR contract

`@bridge/core`'s IR types are marked **FROZEN**: generators, compat,
registry and CLI all program against these shapes, and changing an existing
signature is a breaking change to every consumer. Extension requires
coordination; rewrites are out. This is deliberate — the IR is the only
contract the four downstream packages share, which keeps package boundaries
honest:

| Package | Depends on | Responsibility |
| --- | --- | --- |
| `@bridge/core` | — | lexer, parser, semantic, IR, hashing, formatter, diagnostics |
| `@bridge/generators` | core (IR types) | `generate(ir, { language })` → `GeneratedFile[]` |
| `@bridge/compat` | core (IR types) | `diffPackages` / `check` / `formatReport` |
| `@bridge/registry` | core (IR types + hashing) | content-addressed local store |
| `bridge-cli` | all of the above | command surface: `init`, `validate`, `fmt`, `lint`, `generate`, `diff`, `check`, `publish`, `pull`, `versions`, `inspect`, `search`, `doctor`, `version` |

No package reaches into another package's internals; everything flows
through the IR (or, in the registry's case, through IR hashes).

## Determinism guarantees

Bridge's reproducibility story rests on three rules, enforced end to end:

1. **Deterministic IR.** Identical IDL input produces deep-equal IR.
   Sorted/deduplicated arrays, no ambient state, no float arithmetic in
   compilation.
2. **Deterministic hashing.** `hashPackage(ir)` = SHA-256 of the *canonical
   JSON* encoding: object keys sorted recursively, arrays in their
   contract-guaranteed order, no insignificant whitespace, UTF-8 encoded.
   `shortHash` is the first 12 hex chars — the display form used by
   `bridge inspect` and registry metadata. Whitespace and `//` comments in
   the source are invisible to the hash; a one-byte semantic change always
   changes it.
3. **Deterministic generation and reporting.** `generate` re-sorts the IR
   arrays defensively, reads no clock/environment/randomness, and emits
   files with headers (`Code generated by bridge DO NOT EDIT.` + generator
   version) but **no timestamps** — so regeneration in CI never produces
   diff churn. `formatReport` and `toJson` canonically order changes
   (`BREAKING → UNKNOWN → WARNING → SAFE`, then path, kind, message).

## Where hashing fits

```
compile ──► IRPackage ──► canonicalJson ──► SHA-256 ──► hash
                              │
        ┌─────────────────────┼──────────────────────┐
        ▼                     ▼                      ▼
  registry content      compat sanity        reproducibility
  address: objects/     (identical IR ⇔      proof: regenerate
  <hash>.json;          identical hash)      and compare hashes in CI
  republish-same = no-op,
  republish-different = immutable error
```

The registry is the primary consumer: a version's identity **is** its hash,
which makes publishes idempotent, makes `verify()` a re-hash-and-compare
tamper check, and makes `dependents()`/`search()` safe index lookups rather
than source scans.

## Verification of generated code

Determinism makes the generated code verifiable: the repository's
`scripts/verify-*.sh` regenerate every example contract, then
- round-trip every generated Python dataclass through `to_dict`/`from_dict`
  (`scripts/python_roundtrip.py`),
- type-check every generated TypeScript package with the workspace `tsc`
  (strict, 0 errors),
- `go vet`/`go build` and `cargo check`/`cargo clippy` when the toolchains
  exist (CI covers them otherwise).

Because output is byte-deterministic, a generator regression shows up as a
reviewable diff, and a wire-format regression shows up as a failing
round-trip.

## Extending the system

- **New generator language:** implement the per-language module, add the
  mapping table entry, wire `TargetLanguage`. IR stays untouched.
- **New change kind in compat:** extend the detection rules and the
  classification matrix in [COMPATIBILITY](./COMPATIBILITY.md); reports
  remain deterministic because ordering is canonical.
- **IR evolution:** additive only, and coordinated across all consumers —
  see the frozen contract above.

## Where to next

- [QUICKSTART](./QUICKSTART.md) — the user-facing tour
- [IDL_REFERENCE](./IDL_REFERENCE.md) — the language the pipeline consumes
- [COMPATIBILITY](./COMPATIBILITY.md) — the diff engine in detail
- [`examples/`](../examples) — the pipeline, runnable end to end
