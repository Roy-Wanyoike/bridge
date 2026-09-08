// create-pr-42.mjs — open the PR for fix/42-compiler-robustness (issue #42)
// Token is read from the origin remote URL and never printed.
import { execSync } from 'node:child_process';

const url = execSync('git config --get remote.origin.url', { encoding: 'utf8' }).trim();
const m = url.match(/^https:\/\/([^@]+)@github\.com\//);
if (!m) { console.error('no embedded credential in remote url'); process.exit(1); }
const TOKEN = decodeURIComponent(m[1]).replace(/^.*:/, '');
if (!TOKEN) { console.error('no token found'); process.exit(1); }

const REPO = 'Roy-Wanyoike/bridge';

const body = `Fixes #42

## What

All six robustness gaps from the issue, closed inside \`packages/bridge-core\` only (parser, lexer, formatter, fuzzer, diagnostics + tests). \`semantic.ts\` is intentionally untouched — the parallel fix/41-semantic-constraints branch owns it.

1. **parseType depth limit (BR1005).** Type-expression recursion is now bounded by the new \`MAX_TYPE_DEPTH = 256\` (exported from the parser). Past the threshold the parser reports \`BR1005\` *"Type nesting too deep — type expressions may nest at most 256 levels."* (syntax family, per the code conventions — **not** BR2999) exactly once, then recovers by skipping the balanced remainder of the type expression; enclosing composite frames close silently so the recovery does not cascade into hundreds of "Expected \`>\`" errors, and parsing of following declarations continues. An 8000-deep \`list<\` seed — previously \`BR2999 "Maximum call stack size exceeded"\` — now yields exactly one BR1005 in ~7 ms. The same protection covers \`formatSource\`: the formatter parses first, so over-deep input fails at the parse step with BR1005 instead of overflowing the stack while rendering (its never-throw catch stays as the last resort).
2. **Fuzzer counts BR2999 as crashes.** \`runTarget\` now returns the diagnostics array (was a count), and a new exported \`classifyTargetRun\` buckets each target run as \`clean\` / \`diagnostics\` / \`internal-error\`. Any result containing a BR2999 diagnostic is recorded as a crash (\`FuzzCrash.errorKind: 'internal-error'\`) instead of the "good path" \`diagnosticsFound\` — the fuzzer is no longer structurally blind to internal errors. (The issue's 8000-deep seed can no longer produce BR2999 post-fix; the classification is covered by unit tests on synthetic BR2999 results plus the end-to-end deep-seed regression test.)
3. **UTF-8 BOM accepted silently.** The lexer skips U+FEFF at position 0 (editors emit BOMs routinely); no diagnostic, first token stays at line 1 column 1. A BOM anywhere after position 0 is still BR1001.
4. **CRLF doc comments canonicalized.** The lexer strips the trailing \`\\r\` from \`///\` comment bodies, and the formatter's \`pushDocs\` strips a trailing \`\\r\` per doc line (defense in depth). CRLF files now format to canonical LF output.
5. **Redundant optional markers warn (BR2104).** \`a: string ? ?\`, \`a?: string?\`, \`a: string??\` — previously silently swallowed — now emit \`BR2104\` (warning, BR21xx style-warning family alongside BR2101–2103): *"Field \`amount\` declares the optional marker \`?\` more than once."* with a canonical-style hint. Advisory only: warnings never block compilation or formatting (verified \`compileSource(...).ok === true\`).
6. **diagnostics.ts line index computed once.** \`formatDiagnostics\` splits the source into lines once and shares it across every diagnostic — O(diags × lines) → O(lines). Public API unchanged; output is byte-identical (asserted), and a split-count spy test asserts exactly one \`split('\\n')\` for N diagnostics.

## Files

- \`packages/bridge-core/src/parser.ts\` — \`MAX_TYPE_DEPTH\`, BR1005 + one-shot recovery (\`skipTypeTail\`, \`closeComposite\`), \`warn\` helper, BR2104 redundant-marker count
- \`packages/bridge-core/src/lexer.ts\` — BOM skip at position 0, CRLF doc-body strip
- \`packages/bridge-core/src/format.ts\` — CRLF doc canonicalization in \`pushDocs\`, depth-protection doc note
- \`packages/bridge-core/src/fuzz/fuzz.ts\` — \`runTarget\` → \`Diagnostic[]\`, \`classifyTargetRun\`, \`internal-error\` crash bucket, header/FuzzSummary doc updates
- \`packages/bridge-core/src/fuzz/index.ts\` — export \`classifyTargetRun\` + \`TargetRunOutcome\`
- \`packages/bridge-core/src/diagnostics.ts\` — shared pre-split line index (public API unchanged)
- Tests: \`src/test/lexer.test.ts\` (new, 7), \`src/test/parser.test.ts\` (+8), \`src/test/format.test.ts\` (+2), \`src/test/errors.test.ts\` (+2), \`src/test/property/fuzz.property.test.ts\` (+2, plus accounting fix)

## Tests

| Issue item | Tests |
| --- | --- |
| Depth limit | \`type depth limit: nesting up to 256 levels parses cleanly\`, \`257 levels report BR1005 "type nesting too deep", not a crash\`, \`unbounded \`list<\` seed (8000 deep) recovers with one diagnostic\`, \`parsing continues after a too-deep type\`, format-side \`deeply nested types fail with BR1005, never an internal formatter error\` (200-deep still formats ok) |
| Fuzz BR2999 → crash | \`classifyTargetRun counts BR2999 diagnostics as internal-error crashes\` (BR2999 alone, mixed with real diagnostics, BR1004/warning/clean buckets), \`an 8000-deep \`list<\` seed yields BR1005 diagnostics — no crash, no BR2999\` (direct + through \`fuzzIdl\`) |
| BOM | \`BOM at position 0 is skipped silently\`, \`file containing only a BOM\`, \`BOM-compiling file compiles cleanly end to end\`, \`BOM after position 0 is still an unexpected character\` |
| CRLF | lexer \`trailing \\r stripped from doc text\` + \`parses with clean doc text end to end\` + lone-\\r line counting; formatter \`CRLF files format to canonical LF output\` (no CR anywhere, idempotent) |
| Redundant \`?\` | \`warn (BR2104): \`a: string ? ?\`\`, \`warn for \`a?: string?\` and \`a: string??\`\`, \`a single optional marker never warns\` (6 positive shapes), \`advisory: compilation still succeeds\` |
| Line index once | \`formatDiagnostics splits the source once, not once per diagnostic\` (String.prototype.split spy, restored in finally), \`output is byte-identical to per-diagnostic rendering\` |

Also fixed while touching: \`assertAccounting\` in the fuzz property suite multiplied \`crashes.length\` by 2 — only accidentally correct while crashes were always 0 (a crash consumes **one** target run; both targets always run). Now \`clean + diagnosticsFound + crashes === executed × 2\`, which the new internal-error bucket can actually exercise.

## API notes

- \`runTarget\` (exported from \`@bridge/core/dist/fuzz\`) changed return type \`number\` → \`Diagnostic[]\`; the only in-repo caller (property test) ignores the result. New exports: \`classifyTargetRun\`, \`TargetRunOutcome\`, \`MAX_TYPE_DEPTH\` (via parser root re-export).
- Diagnostic codes chosen per the documented families: **BR1005** extends the syntax family (BR1001–BR1004), **BR2104** extends the style-warning family (BR2101–BR2103, emitted here from the parser). Issue #41's branch adds BR2016–BR2019 only — no collision; if BR2104 ever clashes, it is a one-line const renumber.

## Validation (Actions billing-locked → local suite is the gate)

- \`npm run build\` PASS; \`npm run lint\` 0 errors / 13 warnings (all pre-existing, max-warnings 25)
- **Full \`npm test\`: 590/590 PASS, 0 fail** (cli 85, compat 101, core **141** [was 120, +21], ffi 10, generators 18, lsp 33, registry 65, registry-service 53, serialization 84). Branch based on c9d866d (pre-#61 merge, which touches only bridge-registry-service).
- CLI end-to-end on a BOM + CRLF + \`amount?: int64?\` fixture: \`validate\` ok (exit 0, warning advisory), \`fmt -w\` rewrites to UTF-8-no-BOM LF canonical \`amount: int64?\`, \`lint\` then passes; \`validate --json\` / \`lint\` render BR2104 with caret + hint; \`lint --strict\` semantics unchanged (BR2104 counts as a tolerated finding by default like BR2101–2103).
- Deep-input perf: 8000-deep \`list<\` compiles in ~7 ms with exactly one BR1005; fuzz batches over a deep-seed corpus complete with \`crashes: 0\`.

## Coordination notes

- \`fix/41-semantic-constraints\` (issue #41) also edits \`fuzz/fuzz.ts\` (drops \`@length(0)\` from a corpus seed, different hunk) and \`contract-gen.ts\` — no overlapping hunks with this branch; semantic.ts deliberately untouched here.
- \`docs/IDL_REFERENCE.md\` diagnostic-code table should gain a BR1005 (syntax) and BR2104 (style warnings) row when a docs surface opens — docs are outside this task's bounded surface (packages/bridge-core only).

## Billing lock

GitHub Actions remains account-locked ("The job was not started because your account is locked due to a billing issue."), so CI for this PR will stay queued until the account owner resolves the billing issue (Settings → Billing and plans). Local build + full test suite (590/590, 0 fail) are the green gate for this PR; re-run CI after the unlock.
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
    title: 'fix(core): bounded parser depth, fuzz BR2999 crash detection, BOM/CRLF canonicalization',
    head: 'fix/42-compiler-robustness',
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
