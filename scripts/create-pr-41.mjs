// create-pr-41.mjs — open the PR for fix/41-semantic-constraints (issue #41)
// Token is read from the origin remote URL and never printed.
import { execSync } from 'node:child_process';

const url = execSync('git config --get remote.origin.url', { encoding: 'utf8' }).trim();
const m = url.match(/^https:\/\/([^@]+)@github\.com\//);
if (!m) { console.error('no embedded credential in remote url'); process.exit(1); }
const TOKEN = decodeURIComponent(m[1]).replace(/^.*:/, '');
if (!TOKEN) { console.error('no token found'); process.exit(1); }

const REPO = 'Roy-Wanyoike/bridge';

const body = `Fixes #41

## What

Semantic analysis now rejects contracts that compile clean but generate non-compiling or non-deterministic output in target languages. All six audit findings are closed:

1. **BR2016 — constraint argument shape/arity, per kind.** \`@min\`/\`@max\` take exactly one unquoted number, \`@length\` one or two, \`@pattern\` one quoted string, \`@email\`/\`@url\`/\`@uuid\` none; a single trailing quoted string is always the custom violation message (mirrors \`lowerConstraint\` in compile.ts exactly). \`@min(foo)\`, \`@min("abc")\`, \`@min("abc", "oops")\`, \`@min()\`, \`@min(1, 2)\`, \`@length(1, 2, 3)\`, \`@pattern(5)\`, \`@email(5)\` are all diagnosed. This kills the \`@min(foo)\` → \`if (count < foo)\` broken-codegen bug in all six languages.
2. **No silent skip for non-resolvable constraint targets.** Constraints on struct/enum/union/composite fields (\`@min(5)\` on a struct, \`@length(0)\` on \`list<string>\`, \`@email\` on a map) now produce BR2013 instead of being ignored via \`resolveToPrimitive → continue\`. Unknown references still report only BR2001 (no double-report — pre-existing test \`constraints on unknown-typed fields are not double-reported\` guards this). Cross-package aliases are now followed when dependencies are available (\`compilePackage\`); they remain opaque in \`compileSource\` mode.
3. **BR2017 — recursive structs.** \`type Node { next: Node }\` (direct, mutual, or through transparent aliases) is rejected at the closing reference with the full cycle path (\`A -> B -> A\`). Self-references through \`optional\`/\`list\`/\`set\`/\`map\` stay legal (protobuf-style indirection). Otherwise Go generates "invalid recursive type" and Rust E0072. DFS is cycle-safe (stack coloring + per-field alias guard; BR2009 still covers pure alias cycles).
4. **BR2018 — \`@pattern\` must be plain RE2.** Lookahead \`(?=\`, negative lookahead \`(?!\`, lookbehind \`(?<=\`, negative lookbehind \`(?<!\`, atomic groups \`(?>\`, possessive/nested repetition (\`a*+\`, \`a**\`, \`a?+\`) and backreferences are diagnosed with an actionable rewrite hint. Backreferences: **every** \`\\1\`–\`\\9\` escape is rejected because Go's regexp/syntax \`parseEscape\` treats a single non-zero digit as a backreference error (octal escapes must start with \`\\0\`; see golang/go#42549) — so \`\\12\` panics Go too. Lazy quantifiers (\`a*?\`, \`a+?\`, \`a??\`) are RE2-legal and accepted. The scanner is character-class aware (\`[*+]\` is a literal pair) and escape-aware.
5. **BR2019 — set element rule decided: forbid unhashable elements.** \`set<T>\` requires T ∈ \`string, bool, int32, int64, uint32, uint64, uuid\` or an alias to one — the same domain as map keys. \`set<Money>\`, \`set<Kind>\` (enum), \`set<float64>\`, \`set<json>\`, \`set<bytes>\`, \`set<timestamp>\`, \`set<list<string>>\` are all diagnosed. Rationale (documented in IDL_REFERENCE.md): cross-language set ordering is non-canonical, Rust's \`BTreeSet<T>\` needs \`Ord\` (structs/enums/floats don't implement it), Go's \`map[T]struct{}\` wrapper needs comparable keys. Use \`list<T>\` for complex or ordered elements.
6. **Perf — O(refs × dep-types) lookups removed.** \`dep.types.map(...).includes(...)\` and \`dep.types.find(...)\` per reference (base semantic.ts:472-481/:561) replaced by a per-package \`name → definition\` index built once and shared by reference checking, named-type resolution, constraint-target resolution and did-you-mean suggestions.

### Review notes (corrections applied on top of the in-progress draft)

The branch carried uncommitted draft work; before commit, every hunk was verified and several defects fixed:

- \`checkSetElement\` early-returned for **all** unresolved resolutions, so \`set<Money>\`/\`set<list<string>>\` would have stayed silently accepted (its own new test would fail). Now only unknown/opaque references skip, struct/enum/union/composite elements are diagnosed.
- The RE2 scanner accepted \`\\12\` as an octal escape — Go rejects it (backreference error). Corrected + test.
- The scanner false-flagged RE2-legal lazy quantifiers (\`a*?\`, \`a+?\`, \`a??\`) as nested repetition. Corrected + tests.
- Diagnostic phrasing ("1 or 2 numeric arguments"), backtick quoting of the backreference construct, a broken test-title string literal (\`Go\\\\'s\` — file did not compile), and two broken assertion regexes (\`\\?\` unescaped) were fixed.

## Files

- \`packages/bridge-core/src/semantic.ts\` — BR2016/2017/2018/2019 checks, exported \`re2UnsupportedConstruct\`, \`depTypes\` index, family doc block
- \`packages/bridge-core/src/fuzz/fuzz.ts\` — fuzz seed fixture: dropped \`@length(0)\` from \`tags: list<string>\` (previously silently ignored; the "valid" seed must stay clean under BR2013)
- \`packages/bridge-core/src/test/property/contract-gen.ts\` — property generator draws set elements from the map-key domain (BR2019) so generated roundtrip contracts stay green
- \`packages/bridge-core/src/test/semantic.test.ts\` — 11 new tests (31 → 43 in file)
- \`docs/IDL_REFERENCE.md\` — recursion rule, per-kind argument grammar, set-element rule + rationale, RE2 dialect details (incl. \`\\0\`-prefixed octal and the retained Rust v1 limitation note), diagnostic table rows BR2016–BR2019
- \`packages/bridge-core/src/compiler/compile.ts\` — intentionally untouched; BR2016 mirrors its lowering rule

## Tests

New negative fixtures + tests for **every** issue item:

| Item | Tests |
| --- | --- |
| BR2016 args | \`@min/@max reject non-numeric and wrong-arity arguments (BR2016)\`, \`@length/@pattern/@email argument rules per kind (BR2016)\` |
| BR2013 no silent skip | \`constraints on struct/enum/composite fields are BR2013, not silently ignored\` |
| BR2017 recursion | \`direct recursive struct is BR2017 at the closing reference\`, \`mutual recursion through two structs is reported once\`, \`self-reference through an alias still closes a cycle\`, \`self-references through optional, list and map are allowed\`, \`mutual recursion broken by an optional field is allowed\` |
| BR2019 sets | \`set elements must be hashable, orderable values (BR2019)\` (7 negative + 5 positive cases) |
| BR2018 RE2 | \`@pattern rejects regex syntax unsupported by Go's regexp (BR2018)\` (7 negative + 4 positive), \`re2UnsupportedConstruct scans patterns precisely\` |

Updated tests that previously asserted buggy behavior (all from the in-progress draft; main had **no** coverage for any of the six gaps, which is why they shipped):

- \`re2UnsupportedConstruct scans patterns precisely\`: originally asserted \`\\12\`-style escapes are accepted. Now asserts \`\\012\`-style octal is fine and \`\\12\` is a backreference error, and adds lazy-quantifier positives the draft scanner would have rejected.
- fuzz seed fixture (\`fuzz.ts\`): \`tags: list<string> @length(0)\` relied on silent ignore; \`@length(0)\` removed so the valid seed stays valid.
- property generator (\`contract-gen.ts\`): previously emitted \`set<\`any primitive\`>\` including \`float64\`/\`json\`-class elements — now restricted to the BR2019 domain.

## Validation (Actions billing-locked → local suite is the gate)

- \`npm run build\` PASS
- \`npm test\`: **580/580 PASS, 0 fail** (cli 85, compat 101, core **131** [was 120, +11], ffi 10, generators 18, lsp 33, registry 65, registry-service 53, serialization 84). Branch is based on c9d866d (pre-#61 merge); the #61 registry change does not touch core, so the 593+ total materializes once this merges on top.
- \`PATH=$PATH:/home/z/.cargo/bin bash scripts/verify-all.sh\`: generate-all PASS, verify-python PASS, verify-ts PASS, **verify-rust PASS** (the Rust leg compiles all generated fixture code — the new diagnostics reject nothing that previously compiled), go/java/csharp SKIP (no local toolchain; CI covers).

## Billing lock

GitHub Actions remains account-locked ("The job was not started because your account is locked due to a billing issue."), so CI for this PR will stay queued until the account owner resolves the billing issue (Settings → Billing and plans). Local build + full test suite (580/580) + \`verify-all.sh\` incl. the Rust codegen leg are the green gate for this PR; re-run CI after the unlock.
`;

const res = await fetch(`https://api.github.com/repos/${REPO}/pulls`, {
  method: 'POST',
  headers: {
    Authorization: `token ${TOKEN}`,
    Accept: 'application/vnd.github+json',
    'Content-Type': 'application/json',
    'User-Agent': 'bridge-task-agent',
  },
  body: JSON.stringify({
    title: 'fix(core): enforce constraint arg/arity rules, recursive type + RE2 checks, set element rules',
    head: 'fix/41-semantic-constraints',
    base: 'main',
    body,
  }),
});
const j = await res.json();
if (res.status === 201) {
  console.log(`PR #${j.number} created: ${j.html_url}`);
} else {
  console.error(`FAILED ${res.status}: ${JSON.stringify(j).slice(0, 500)}`);
  process.exit(1);
}
