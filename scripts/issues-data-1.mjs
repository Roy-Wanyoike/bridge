// Issue payloads 1-8 (compiler, cli, generators, serialization, registry security)
export const issues1 = [
{
  title: "[compiler] Semantic validation gaps: non-numeric constraint args, recursive structs, constraint arity, RE2-incompatible @pattern",
  labels: ["area:compiler", "kind:bug", "priority:high"],
  body: `## Problem
The semantic analyzer accepts contracts that **compile clean but generate non-compiling output** in every target language, violating Bridge's core promise ("one contract, every language"). All items below were verified against the built compiler.

### 1. Non-numeric \`@min\`/\`@max\` args compile clean
- \`@min(foo)\` / \`@max(bar)\` on any field passes semantic analysis (only the field type is checked, never the arg shape).
- All six generators then emit \`if (count < foo)\` → broken Go, Rust, TS, Python, Java, C# output. Verified end-to-end.

### 2. Recursive structs are accepted → invalid Go/Rust
- \`type Node { next: Node }\` compiles (only alias cycles BR2009 are checked).
- Generates \`type Node struct { Next Node }\` (Go: "invalid recursive type") and \`pub struct Node { pub next: Node }\` (Rust E0072).
- Fix: require self-references to go through \`list\`/\`map\`/optional, mirroring protobuf semantics.

### 3. Constraint arity / arg-shape never validated
- \`@min("abc", "oops")\` on an \`int64\` field compiles clean (string arg to numeric constraint unchecked).
- \`@min(5)\` on a struct-typed field and \`@length(0)\` on a \`list<string>\` are **silently ignored** (\`resolveToPrimitive\` → \`continue\`).
- \`@email("foo")\` silently becomes message-only (surplus string treated as message).

### 4. RE2-incompatible \`@pattern\` accepted → Go panics at init
- \`@pattern("^a(?=b)")\` compiles fine; generated Go calls \`regexp.MustCompile\` at package init → panic, while Java/C#/TS/Python compile fine. Language-parity break.

### 5. Struct-in-set element rules
- \`set<struct>\` is legal per BR2012 but cross-language ordering is non-canonical (see generators issue) and Java/Python sort paths crash. Decide + enforce a rule: either forbid struct sets or pin wire ordering by serialized bytes.

### 6. Perf: O(refs × dep types) lookups
- \`semantic.ts:472-481\` + \`:561\`: \`dep.types.map(...).includes(...)\` per reference — build a Set once.

## Acceptance criteria
- [ ] BR2013-style diagnostics for non-numeric/wrong-arity constraint args (per constraint kind)
- [ ] Diagnostic for non-resolvable constraint target types (no more silent ignore)
- [ ] Recursive struct diagnostic (self-reference outside list/map/optional)
- [ ] RE2-dialect validation for @pattern with actionable message
- [ ] Set element-type rule decided, documented in IDL_REFERENCE, enforced
- [ ] New negative fixtures + tests for every case above
- [ ] All existing 569 tests still pass`
},
{
  title: "[compiler] Robustness: unbounded parseType recursion, fuzzer blind to BR2999, BOM/CRLF handling, redundant optional marker",
  labels: ["area:compiler", "kind:bug", "priority:medium"],
  body: `## Problem
Compiler degrades ungracefully or silently on adversarial / unusual input. All verified.

1. **parseType unbounded recursion** (parser.ts:966-1034): depth 200 OK, depth 5000 → \`BR2999 "Maximum call stack size exceeded"\` internal error instead of a proper syntax diagnostic. Fix: depth counter + "type nesting too deep" diagnostic past threshold (e.g. 256). Same for \`formatSource\`.
2. **Fuzzer structurally blind to internal errors** (fuzz.ts:433-449): any non-empty diagnostics array counts as the "good path" (\`diagnosticsFound\`), so BR2999 stack-exhaustion is invisible: an 8000-deep \`list<\` seed yields \`crashes: 0\`. Fix: classify results containing a BR2999 diagnostic as crashes.
3. **UTF-8 BOM** at file start → \`BR1001 Unexpected character\` with no hint (lexer.ts:305-314). Editors emit BOMs routinely. Fix: skip U+FEFF at position 0.
4. **CRLF doc comments**: trailing \`\\r\` retained in doc text (format.ts:224-229, lexer.ts:163-168) → formatter emits mixed line endings. Fix: strip trailing \\r.
5. **Redundant optional markers** silently swallowed (parser.ts:504-537): \`a: string ? ?\` → 0 diagnostics. Fix: warn.
6. **diagnostics.ts:45** re-splits entire source per diagnostic — O(diags × lines). Split once, share.

## Acceptance criteria
- [ ] Parser depth limit with proper diagnostic (not BR2999) + test
- [ ] Fuzz harness counts BR2999 as crash + regression test
- [ ] BOM accepted silently + test
- [ ] CRLF files format to canonical output + test
- [ ] Redundant \`?\` warning diagnostic + test
- [ ] Diagnostics line-index computed once (benchmark or unit assert)`
},
{
  title: "[cli] Correctness batch: unified-diff hunk headers wrong, validate --json aborts without JSON, failures on stdout, help text missing java/csharp",
  labels: ["area:cli", "kind:bug", "priority:high"],
  body: `## Problem
User-visible CLI defects, all reproduced live.

1. **[HIGH] unified-diff emits wrong hunk headers** (difftext.ts:117-129, 156-166): \`bridge fmt --diff\` prints \`@@ -2,4 +2,5 @@\` where git prints \`@@ -1,4 +1,5 @@\`; two-hunk case off by 13 lines (\`-22,4\` vs \`-9,4\`). Root cause: \`aHeader = aLine + 1\` never subtracts leading context; counter loops double-count / re-advance from 0. No test asserts header numbers (basics.test.ts:219 only regex-matches \`@@ -\\d+,\\d+\`) — that's why it survived.
2. **validate --json on read failure prints no JSON** (commands/validate.ts:25-31): \`bridge validate a.bridge missing.bridge --json\` aborts the loop before printJson → stderr-only output, exit 1. CI consumers get no machine-readable result. Fix: emit \`{ file, ok: false, diagnostics: [...] }\` and continue.
3. **Failure notes go to stdout** (commands/lint.ts:44-46 comment says stderr, code calls \`out()\`; same in commands/fmt.ts:38 write-failure path). Fix: \`errOut()\`.
4. **Help/usage lists only 4 of 6 languages** (usage.ts:15,89 + commands/generate.ts:15): \`java\`/\`csharp\` accepted but undocumented.
5. **Arg parsing swallows flags as values** (args.ts:49-62): \`--registry --json\` silently sets registry="--json"; \`--out=\` accepts empty string. Fix: reject next-tokens starting with \`--\` and empty inline values.
6. **check --json silently overridden by --format** (commands/check.ts:65): document precedence or error.
7. **[LOW perf] impact.ts:331-372**: \`collectRefsTo\` full IR walk inside per-source loop → O(consumers² × IR size). Index qualified refs once per node.
8. **[LOW] fuzz/cli.ts**: \`--help/-h\` accepted but absent from USAGE list; \`chunk()\` misnamed (returns single truncated head).

## Acceptance criteria
- [ ] Hunk headers byte-identical to \`git diff --no-index\` for: insertion-only, deletion-only, multi-hunk, context-at-EOF cases + header-value tests
- [ ] validate --json always emits valid JSON array, even on read failures + test
- [ ] lint/fmt failure notes on stderr + test
- [ ] Help lists go/rust/typescript/python/java/csharp
- [ ] args.ts rejects flag-as-value and empty inline values + tests
- [ ] check --json precedence documented (help text) 
- [ ] impact analysis: refs indexed once (benchmark or complexity note in code)`
},
{
  title: "[generators] Compile-breaking output: Java primitive generics, Rust keyword fields, C# set sort, wasm module gating, cross-package service refs",
  labels: ["area:generators", "kind:bug", "priority:critical"],
  body: `## Problem
Several legal Bridge contracts generate code that **does not compile** in the target language. Every item below was reproduced end-to-end (generate → inspect output), except where marked.

1. **[HIGH] Java: \`List<int>\` for primitive collections** (gen/java.ts:318,330): \`list<int32>\` field → \`List<int> l0 = new ArrayList<>();\` (also \`List<long>\`, \`List<boolean>\`, \`Set<int>\`) → javac fails. Fix: \`boxedJava(...)\` element wrapping in fromDict/serialize paths.
2. **[HIGH] Rust: validate.rs uses raw keyword field names** (gen/rust.ts:473-481,569,575): types.rs emits \`r#type\` but validate.rs references \`self.type\` → rustc syntax error for any keyword-named field with a constraint. Fix: use \`rustFieldName(...)\` everywhere.
3. **[HIGH] wasm: \`pub mod enums;\` emitted unconditionally** (bridge-ffi/src/wasm.ts:102-104): enum-less package → lib.rs references missing enums.rs → cargo build fails. Fix: gate on file presence like rust-ffi.ts:105-110.
4. **[HIGH] Cross-package struct refs as method input/output break 4 backends** (BR2010 allows them): Rust \`req.validate()\` on opaque alias (rust.ts:755-758, rust-wire.ts:434); Java undeclared \`LoyaltyProfile\` (java.ts:1604-1608); C# (csharp.ts:1160-1172); Python \`X.from_dict\` on Any (python.ts:768,829-839). Go/TS degrade to opaque passthrough correctly — apply the same guard (go.ts:639-647 pattern) to rust/java/csharp/python.
5. **[HIGH] C#: set serialization sorts non-string sets with StringComparer** (csharp.ts:182): \`set<int32>\` → CS1503 [UNVERIFIED-compile — no dotnet locally; static reading unambiguous]. Fix: project via \`x?.ToString()\` before OrderBy.
6. **[MEDIUM] Go: union variant payload zero value for primitive aliases** (mappings.ts:429 → go.ts:259,276): \`type OrderId = string\` → emits \`OrderId{}, false\` (invalid composite literal). Resolve alias targets to primitive zero values.
7. **[MEDIUM] Python: union classmethod names collide** (python.ts:621-623): variants \`SELF\`/\`KIND\` → \`def self(cls, …)\` (unusable) / \`def kind(cls, …)\` (collides with dataclass field). Fix: lower-snake + reserved/field-collision escape list.
8. **[MEDIUM] TS: validator locals collide with field names** (typescript.ts:505-536): struct with field \`value\`/\`obj\`/\`errors\` redeclares validator locals → tsc fails. Fix: \`__bridge_*\` prefixes or tsSafeIdent against local-symbol set.
9. **[LOW] Generated test gaps**: java/csharp RoundTripTest covers \`structs.slice(0, 2)\` only; \`sampleJsonForRef\` returns null for required union fields → generated tests throw. Cover all structs, emit union samples via first variant.

## Acceptance criteria
- [ ] New adversarial fixtures: primitive lists/sets, keyword-named constrained fields, enum-less wasm package, cross-package service signatures, union-colliding variants, \`value\`/\`errors\` field names
- [ ] Every listed case fixed + unit test asserting the exact previously-broken output shape
- [ ] verify-go.sh / verify-rust.sh green locally (CI covers java/csharp)
- [ ] Dead code sweep in generators while touching files (python.ts:872-985 unreachable events file, csharp.ts:289/1402/1407/1538/379, java.ts:1424/1531, wasm.ts:300, abi.ts:138, naming.ts:139/59, docs.ts:64/116, tagged.ts:130, typescript.ts:396 dead ternary)`
},
{
  title: "[generators] Generated-code hardening: no request body caps (DoS), doc-comment injection, cross-language validation parity drift",
  labels: ["area:generators", "kind:security", "priority:high"],
  body: `## Problem
Generated services/clients are deployable as-is — so their defects are production defects.

1. **[HIGH] Generated HTTP servers buffer untrusted bodies without limits**: rust-wire.ts:347 \`vec![0u8; content_length]\` (attacker-controlled Content-Length → immediate OOM), java.ts:1719 \`readAllBytes()\`, python-wire.ts:400-401, go.ts:841. Fix: enforce max body size (default 1 MiB, configurable) before allocation, in all backends.
2. **[MEDIUM] Doc-comment injection**: \`*/\` terminates JSDoc/Javadoc (docs.ts:51-57, java.ts:130-141); \`"""\` terminates Python docstrings (docs.ts:78-89) — a \`/// say """hi"""\` line is legal IDL. Fix: escape per language in docLines consumers.
3. **[MEDIUM] Validation regex anchoring drift**: @email/@url anchored \`^…$\` in Go/TS but unanchored in Java/C#/Python → \`"[email protected]!!!"\` validates differently per language for the same contract. Fix: full-match semantics everywhere.
4. **[LOW] Rust clients accept only status==200** (rust-wire.ts:384) while Go/TS/Python accept 2xx. Fix: accept 2xx everywhere.
5. **[LOW] Java uint64 > 2^63-1 parsed via Double.parseDouble** (java.ts:616-620,763-769) → silent clamp to Long.MAX_VALUE. Fix: BigInteger/unsigned parse or clear error.
6. **[LOW] Python: explicit JSON null bypasses field default** (python.ts:451-453): defaulted field stores None. Fix: treat null as missing for defaulted fields (match java/csharp handling).

## Acceptance criteria
- [ ] Body-size cap emitted in all 6 server backends + generated-test proving 413 on oversized body
- [ ] Doc-escaping fixtures: \`*/\`, \`"""\`, backslash tails round-trip without breaking generated files
- [ ] One parity fixture contract exercised in all 6 languages asserting identical accept/reject for email/url/pattern
- [ ] 2xx acceptance parity test in wire layers
- [ ] uint64 full-range round-trip in Java
- [ ] null-vs-default parity test`
},
{
  title: "[serialization] CBOR tag-1 timestamp round-trip failures + precision parity + missing edge-case vectors",
  labels: ["area:serialization", "kind:bug", "priority:medium"],
  body: `## Problem
Verified with the shipped codecs.

1. **CBOR tag-1 pre-1970 sub-second timestamps cannot round-trip**: \`BridgeTimestamp(-1n, 500ms)\` encodes to \`c1fbbfe0…\` and the library's **own decoder** throws \`RangeError: timestamp nanos out of range: -500000000\`. Encoder produces bytes its decoder rejects.
2. **Sub-µs nanos silently lost** in CBOR (binary64 epoch) vs msgpack timestamp96 → cross-format divergence for the same value.
3. **int64-range seconds lose precision** through \`Number()\` in CBOR epoch conversion.
4. **BridgeTimestamp.fromISO drops sub-millisecond precision** (types.ts:54-72): \`.123456\` → nanos 123000000 → renders \`.123\`.
5. **toISO throws RangeError** for seconds near int64 max (constructor permits, renderer can't render).

## Fix direction
- Encode CBOR tag-1 as int/float pair consistent with the decoder, or switch to a 96-bit ext mirroring msgpack; make decode/encode symmetrical for negative seconds.
- Parse RFC 3339 fractions arithmetically (no Date.parse for the fraction); clamp/validate seconds to representable range or render arithmetically.

## Acceptance criteria
- [ ] Pre-1970 sub-second timestamps round-trip in CBOR (TS + Rust + Python legs)
- [ ] Documented precision contract per format (what's exact vs truncated) in docs/SERIALIZATION.md
- [ ] New golden vectors: pre-1970 sub-second, sub-ms, int64-max seconds, -0.0, subnormals, NaN/Inf rejection
- [ ] All four language legs pass the new vectors (Go leg in CI)`
},
{
  title: "[registry-service][security] Cross-tenant audit exposure + unsynchronized shared PostgreSQL connection",
  labels: ["area:registry", "kind:security", "priority:critical"],
  body: `## Problem
Two HIGH-severity defects in the multi-tenant HTTP registry. Both must be fixed before multi-tenant production.

### 1. Cross-tenant audit read (server.ts:228-237)
\`GET /v1/audit\` takes the \`org\` filter from the query string **instead of intersecting with \`principal.org\`**:
- org-scoped admin can read other orgs' audit entries via \`?org=other\`
- with no \`org\` param, the driver returns **every tenant's** entries
- \`ctx.org = principal.org\` (line 227) is recorded but never applied to the query
- Same pattern as /v1/search (which does scope correctly) — apply the same force-scoping.

### 2. Shared PgClient with no serialization (storage/postgres/wire.ts:642-662 + driver.ts:72-89)
All HTTP traffic multiplexes over **one shared \`PgClient\`**; \`nextMessage()\` overwrites the single \`waiter\` slot:
- two concurrent queries → one caller's promise hangs forever and responses can be consumed by the wrong loop
- **rows can be delivered to the wrong request** (pull for org A returning org B's contract IR)
Fix: mutex/queue around \`query()\`/\`simpleQuery()\` per connection (or a connection pool); broadcast failures to all in-flight waiters on socket close.

## Acceptance criteria
- [ ] \`GET /v1/audit?org=other\` as org-scoped principal → 404/403, never foreign rows; no-org query returns only principal.org rows
- [ ] Concurrent-query regression test (≥50 parallel pulls/queries against a real PG in CI service container) asserting zero cross-delivery and zero hangs
- [ ] Waiter-failure broadcast on socket close + test
- [ ] PG integration tests un-skipped in CI (needs the postgres service-container job from the CI issue)`
},
{
  title: "[registry-service][security] Insecure defaults & operational hardening (rate limit off, signing optional, TLS disable, JWKS amplification, timeouts)",
  labels: ["area:registry", "kind:security", "priority:high"],
  body: `## Problem
The service's capability is strong but **defaults are silently weak** — a naive deployment is far weaker than the code. Plus operational gaps.

### Defaults
1. **Rate limiting disabled by default** (server.ts:86 \`options.rateLimit ?? { enabled: false }\`) contradicting types.ts:338 ("Defaults to on"); shipped CLI (bin:216-230) never sets it → token guessing / publish floods unthrottled. Fix: default enabled with DEFAULTS buckets.
2. **Artifact signing silently optional** (signing.ts:39-64 + server.ts:413): no \`signing\` config → mode 'optional', unsigned publishes accepted from any write principal, no startup warning. Fix: loud boot warning + "production profile" (env/CLI) defaulting mode:'required'.
3. **Postgres TLS 'disable' by default** (wire.ts:363, parseDsn 50-59) + cleartext-password auth supported (code 3) over plaintext. Fix: default 'prefer' ('require' for non-loopback), refuse cleartext auth unless TLS active.

### DoS / abuse
4. **Unknown JWT kid → forced JWKS re-fetch per request** (auth.ts:403-417), no negative cache, no single-flight → unauthenticated garbage tokens turn the service into a fetch amplifier against the IdP. Fix: negative-cache kid misses (short TTL), single-flight refresh, serve stale keys on refresh failure.
5. **Audit ring pollution**: every /v1 request appends audit (including pre-auth 401s, 429s, and openapi.json served before the limiter) → unauthenticated flood evicts legitimate history; failed auth stored as action:'read' instead of 'auth' (server.ts:131-151, audit.ts:80-102). Fix: skip/segment pre-auth entries, correct action, retention story for postgres.
6. **canonicalJson recursion unbounded** during signature verification (server.ts:413 + core ir/hash.ts:26-44): ~10k-deep body → RangeError → 500 instead of 400. Fix: depth cap / map to 400.

### Operational
7. **413 handling destroys connection before writing envelope** (server.ts:514-530); no headersTimeout/requestTimeout/keepAliveTimeout; shutdown can hang on keep-alive sockets. Fix: respond-then-destroy, explicit timeouts, closeIdleConnections().
8. **publishTime stored verbatim** (server.ts:445-448); \`assertIsoTimestamp\` exists (validation.ts:585) but never wired; audit from/to unvalidated. Fix: wire it.
9. **Static-token prototype-chain lookup** (auth.ts:114-125): \`Bearer constructor\` resolves to inherited value → principal with undefined org (fails closed, but noise). Fix: \`Object.hasOwn\`/Map + constant-time compare.
10. **Migration runner without advisory lock** (driver.ts:94-122): concurrent boots race. Fix: pg_advisory_lock.
11. **bridge_audit missing (org, project, time DESC) index**; gin imports index unused (0001_init.sql:55-59 + driver.ts:274-304). Fix: index + SQL-side import filter or drop index.
12. **/v1/openapi.json served before the limiter** (server.ts:185-191) contradicting its own comment. Fix: move below limiter or correct comment.
13. **JWKS URL disclosed to unauthenticated clients** on fetch failure (auth.ts:447). Fix: generic client message, details to logs.

## Acceptance criteria
- [ ] Rate limit + signing-warning + TLS defaults changed, each with a boot-log line
- [ ] kid negative cache + single-flight + test
- [ ] Audit: pre-auth not stored (or separate class), action:'auth' correct, postgres retention config
- [ ] 413 envelope test, explicit timeouts set, graceful shutdown test
- [ ] publishTime + audit bounds validated
- [ ] Token lookup via Map/hasOwn + test
- [ ] Advisory lock + index migration (0002) 
- [ ] All existing registry-service tests pass`
}
];
