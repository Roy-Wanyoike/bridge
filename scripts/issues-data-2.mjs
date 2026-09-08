// Issue payloads 9-16 (dashboard a11y, data layer, polish, ci, release, docker, docs, hygiene)
export const issues2 = [
{
  title: "[dashboard][a11y] Keyboard-unreachable tabs, non-compliant dialog, contrast failures, graph roles",
  labels: ["area:dashboard", "kind:a11y", "priority:high"],
  body: `## Problem
Accessibility blockers in the registry console (WCAG 2.1 AA). The UI is otherwise polished and type-safe (tsc clean, 0 eslint errors).

1. **[HIGH] Tabs unreachable by keyboard** (components/ui/tabs.tsx:67): roving tabindex with **no arrow-key handler** — "Consumers/Producers/Schema" tabs on contract detail pages cannot be reached via keyboard (WCAG 2.1.1 failure). Fix: WAI-ARIA APG tabs pattern (arrow-key nav on TabsList) or adopt Radix Tabs.
2. **[HIGH] Hand-rolled dialog is non-compliant** (components/ui/dialog.tsx:18-47): no focus trap, no initial focus move, no focus restore, no aria-labelledby/describedby wiring, no body scroll lock — Tab escapes into background, SRs never announce it. Fix: focus content on open, trap Tab, restore focus on close, label wiring. (audit-detail-dialog.tsx:22 also renders a second onOpenChange — clean up while here.)
3. **[MEDIUM] compat-graph wraps interactive nodes in role="img"** (compat-graph.tsx:104-108 vs 155-169): \`role="img"\` makes the subtree presentational — 10+ node "links" invisible to SRs. Fix: role="group" (keep aria-label) or restructure.
4. **[MEDIUM] Contrast below AA**: \`text-muted-foreground/70\` on 11px text in contracts/page.tsx:189, [contract]/page.tsx:256, audit/page.tsx:150, graph/page.tsx:106 (≈4.27:1); graph labels fill-zinc-500 at 10px (≈4.09:1), edges stroke-zinc-600 (≈2.76:1). Fix: /80 opacity, lighter graph colors.
5. **[LOW] ScopeSwitcher never syncs to URL** (app-shell.tsx:76-98): uncontrolled defaultValue; navigating leaves it stale vs the page. Fix: derive from usePathname/useSearchParams.
6. **[LOW] graph org "tabs" lack aria-current** (graph/page.tsx:47-64); tables lack captions.

## Acceptance criteria
- [ ] Full keyboard walkthrough: every interactive element reachable and operable (tabs, dialogs, graph nodes)
- [ ] Dialog: focus trap + restore + labels + scroll lock + test
- [ ] Contrast: all text ≥4.5:1, non-text ≥3:1 (document audit in PR)
- [ ] Graph nodes exposed as links to AT
- [ ] Scope switcher reflects current URL scope`
},
{
  title: "[dashboard] Live-mode data layer: errors masked as 'not found', no fetch timeouts, N+1 cascades, missing loading states",
  labels: ["area:dashboard", "kind:bug", "priority:high"],
  body: `## Problem
Demo mode always succeeds, so these are invisible in demos but will bite the first real registry hiccup — blocking live-mode customer onboarding.

1. **[HIGH] Errors render as "Contract not found"**: registry-client.ts:105-113,122-135,149-163 \`catch { return null }\` → pages call notFound() ([contract]/page.tsx:46, diff/page.tsx:66,79). A 500/timeout/outage renders as a 404 page instead of the error boundary with Retry. Fix: rethrow on non-404 (\`res.status === 404\` only → null).
2. **[HIGH] No loading states anywhere**: no loading.tsx exists; Skeleton component exported but never used; every page force-dynamic → navigation blocks with zero feedback. Fix: per-route loading.tsx skeletons (or Suspense).
3. **[MEDIUM] No AbortController/timeout** (registry-client.ts:66-75): a hung registry hangs the render forever. Fix: AbortSignal.timeout(…).
4. **[MEDIUM] Sequential N+1 cascades**: listAllContracts (orgs→projects→contracts) and getOverview (:185-237, versions+diff per breaking contract) + per-version-pair getDiff in [contract]/page.tsx:57-68. Fix: Promise.all fan-out.
5. **[MEDIUM] pickArray silently returns []** on any schema drift (registry-client.ts:55-61) → empty pages labeled "No contracts match" instead of an error. Fix: warn/error when expected key missing.
6. **[MEDIUM] error.tsx never logs** (error.tsx:6-19): no console.error, digest not shown, hardcodes "Could not reach the registry" even for render bugs; no global-error.tsx. Fix: log + digest + global-error.
7. **[LOW] isDemoMode() treats 'FALSE' as demo** (registry-client.ts:36-40). Fix: strict parse + warning.

## Acceptance criteria
- [ ] Non-404 failures hit error.tsx with retry; 404s hit not-found; test both paths (mock fetch)
- [ ] loading.tsx per route + skeleton usage
- [ ] Fetch timeout with typed error
- [ ] Overview/detail fan-out parallelized (document request counts before/after)
- [ ] Schema-drift detection with actionable console error
- [ ] error.tsx logs with digest; global-error.tsx added`
},
{
  title: "[dashboard] Correctness & polish: broken demo deep links, fabricated columns, dead code, SEO/metadata gaps",
  labels: ["area:dashboard", "priority:medium", "kind:hygiene"],
  body: `## Problem
Polish batch for customer-facing quality.

1. **[MEDIUM] 3 broken audit deep links in demo data** (demo-data.ts:864-883): pull rows hardcode project → acme/commerce/risk-engine, acme/commerce/payments, globex/billing/reporting all 404 (contracts actually live under acme/payments). Fix: record correct org/project per row.
2. **[LOW] Live getOverview fabricates \`languages: []\`** (registry-client.ts:219-232, table shows "none") and \`packageName\` with trailing dot. Fix: join or omit.
3. **[LOW] "Latest" assumes versions[] ascending** ([contract]/page.tsx:49-50, diff/page.tsx:71-76) — sort by publishedAt client-side. diff-version-picker allows from===to / from>to → misleading empty diff; disable/swim.
4. **[LOW] Full 64-char SHA dumped inline** ([contract]/page.tsx:115-118,191-193) wraps on mobile — use shortHash + existing CopyButton.
5. **[LOW] not-found.tsx says "Contract not found" for every unknown URL** — neutral copy.
6. **[LOW] audit/page.tsx double-fetches the trail** (:48-54) for the actor dropdown — fetch once, filter client-side.
7. **[LOW] Graph keyed by base alone** (graph/page.tsx:29 + demo-data.ts:1091-1119) — duplicate bases across orgs collide. Key by org/project/base.
8. **[LOW] Dead code (lint-confirmed)**: ScrollText import, LANGS_ALL, toVersion, unused generic T, format.ts ageInDays/shortHash (wire shortHash in per #4), ui/skeleton.tsx (wire per data-layer issue), demoPublishers + demoListConsumers ignores version param (demo-data.ts:989-993).
9. **[LOW] SEO/metadata**: only layout.tsx has metadata; per-page titles missing; no metadataBase/OG/favicon/robots/themeColor; no public/ dir (favicon; white browser chrome on dark app). Add title/description per route, icons, themeColor '#0a0a0c'.
10. **[LOW] copy-button timer not cleared on unmount** (copy-button.tsx:43-48); select input has no dropdown chevron (ui/input.tsx:26); compat-graph fixed 940×560 viewBox → ~5px labels on phones (min-width + horizontal scroll or responsive sizing; dynamic layer height compat-graph.tsx:65-80).
11. **[LOW] Dark-only theme is an explicit product choice** — document in README/dashboard docs so customers aren't surprised.

## Acceptance criteria
- [ ] All demo deep links resolve (click-audit test against demo registry)
- [ ] Per-route metadata + favicon + themeColor
- [ ] Dead code removed or wired
- [ ] Hash UX fixed; graph usable at 375px width
- [ ] Timer cleanup + chevron`
},
{
  title: "[ci] Unmask generator verifiers, add dashboard + postgres jobs, least-privilege permissions, fix skip semantics and hardcoded paths",
  labels: ["area:ci", "kind:bug", "priority:high"],
  body: `## Problem
CI is structurally blind in six places — it can be green while real things are broken.

1. **[HIGH] \`continue-on-error: true\` on all 4 generator-verify jobs** (ci.yml:42,61,80,100) masks real generator regressions. The \`if [ -f scripts/verify-*.sh ]\` fallbacks (:56,75,95,114,134) are dead code — all scripts exist. Fix: drop continue-on-error + fallbacks; call scripts bare.
2. **[HIGH] dashboard/ has ZERO CI coverage** (own package-lock, outside workspaces): no next build / eslint / tsc --noEmit job. Fix: dedicated dashboard job (npm ci && lint && typecheck && build).
3. **[MEDIUM] Postgres driver never tested in CI**: postgres.test.ts skips without PG_DSN and no service container exists. Fix: job with a postgres service container + PG_DSN.
4. **[MEDIUM] No workflow-level \`permissions: contents: read\`** (ci.yml) — jobs inherit potentially-writable tokens. Fix: least-privilege block (release.yml already scopes correctly).
5. **[MEDIUM] Caching/pinning**: no Swatinem/rust-cache (serde rebuilt every run); pip install without setup-python pip cache; go-version 'stable' (:51) vs '1.23' (:128) inconsistent. Fix all.
6. **[MEDIUM] verify scripts report PASS when toolchain missing** (verify-{go,rust,java,csharp,python}.sh skip guards exit 0; verify-all.sh prints PASS for unverified legs). Fix: exit 77 + SKIP label in verify-all.sh; hard-fail on skip in CI contexts.
7. **[MEDIUM] Sandbox path leaked into committed scripts**: verify-serialization.sh:29 + verify-events-rpc.sh:43 hardcode /home/z/toolchain/go/bin/go. Fix: \${GO:-go} override.
8. **[MEDIUM] Root lint is a no-op** (package.json:24 — no workspace defines lint; no eslint config covers packages/). Fix: shared eslint config + workspace lint scripts (flat config, TS-aware) or delete the script honestly.

## Acceptance criteria
- [ ] ci.yml: no continue-on-error on verify jobs; scripts called bare
- [ ] dashboard job green (lint+typecheck+build)
- [ ] postgres service-container job runs the driver tests (when billing lock clears)
- [ ] workflow permissions least-privilege
- [ ] rust-cache + pip cache + pinned go version
- [ ] SKIP semantics distinct from PASS; verify-all fails if a leg was skipped in CI mode
- [ ] No absolute machine paths in scripts`
},
{
  title: "[release] Release pipeline masked end-to-end: npm publish triple-shielded, false multi-arch claim, broken smoke tests, cliff.toml error, homebrew formula broken",
  labels: ["area:release", "kind:bug", "priority:critical"],
  body: `## Problem
A release can go **fully green while artifacts are missing, unsigned, or unpublished**.

1. **[CRITICAL] npm publish triple-masked** (release.yml:217-224): job-level continue-on-error + per-package \`|| echo "publish skipped"\` + NPM_TOKEN unset (comment-only prerequisite) → green release, nothing on npm. Also **@bridge/serialization is published but never built by \`npm run build\`** (no tsconfig reference) → empty tarball. Fix: unmask, whoami preflight, fail on error, build every published workspace, \`npm publish --dry-run\` sanity in a prior step.
2. **[HIGH] Multi-arch container claim is false** (release.yml:156-193): per-platform matrix jobs push the SAME tags (X.Y.Z, X.Y) independently — last writer wins, no manifest list ever created (contradicts Dockerfile header + RELEASE.md:33-34). Fix: push by digest + \`docker buildx imagetools create\`, or single job with both platforms.
3. **[HIGH] Binary smoke test broken** (:70-72): \`|| true\` masks everything; \`!= 'darwin-*'\` is a literal string compare (no globs in GHA if) so darwin exclusion is a no-op; the basename/sed pipeline resolves to \`bridge-v0\` and only works by glob accident. Fix: direct glob invocation, proper condition, no masking.
4. **[HIGH] No arm64 smoke testing** anywhere (binary excluded; arm64 image built under qemu, never run). Fix: run the built image per platform; run linux-arm64 binary via qemu where feasible.
5. **[HIGH] homebrew/bridge.rb can never install** (:36-39): \`File.delete(binary)\` runs BEFORE \`bin.install binary\`; \`File.exist?(nil)\` raises when glob misses. Fix: \`bin.install Dir["bridge-v#{version}-*"].first => "bridge"\` guarded; also hardcoded version "0.1.0" + four \`sha256 :no_check\` placeholders → have the workflow pin real digests.
6. **[MEDIUM] cliff.toml:8 \`split("\\n")\`** passes positional arg; Tera needs named (\`split(pat="\\n")\`) → render error silently swallowed by release.yml:145 continue-on-error → every release body degraded to fallback text. Fix + unmask.
7. **[MEDIUM] cosign image sign masked** (:202) and digest read from a mutable tag mid-race with sibling matrix job; no SBOM/provenance attestation despite id-token:write. Fix: sign steps.build.outputs.digest, unmask, add attest steps.
8. **[MEDIUM] Version drift unguarded**: root 0.1.0 / registry-service 0.2.0 / CHANGELOG 0.2.0 / homebrew 0.1.0; no tag==version assertion. Fix: single version source + guard step before any publish.
9. **[MEDIUM] RELEASE.md:48 cosign verify command uses vX.Y.Z but metadata-action emits tags without 'v'**; no latest tag. Fix: align (add \`type=raw,value=v{{version}}\` or fix doc).
10. **[LOW] verify-release.sh:26,32** echoes --help but runs help; checksum check skipped silently when file missing. Fix both. scripts/package-release.mjs:33 'arch64' typo → darwin-arch64 naming mismatch (RELEASE.md:27 also wrongly says the workflow uses this script).

## Acceptance criteria
- [ ] Release workflow: no masked failures; publish fails loudly without NPM_TOKEN in dry-run mode
- [ ] True multi-arch manifest list verified in workflow (inspect step)
- [ ] Smoke tests real for amd64 + arm64 (binary + container)
- [ ] cliff changelog renders (local git-cliff run green)
- [ ] cosign signs digest, attest steps added
- [ ] Version guard step fails on drift; all manifests aligned to 0.2.0 (ties to docs issue)
- [ ] Homebrew formula installs (local install test with local binary)`
},
{
  title: "[docker] Image is doubly broken: dead CLI symlink path + registry-service never built by root build",
  labels: ["area:release", "kind:bug", "priority:critical"],
  body: `## Problem
The container deliverable — a documented delivery mode — cannot run either entrypoint.

1. **[CRITICAL] CLI symlink dead** (Dockerfile:54): targets \`/app/packages/bridge-cli/dist/src/bin/bridge.js\` but tsconfig rootDir:'src' emits \`dist/bin/bridge.js\` (verified on disk) → \`docker run … bridge <cmd>\` fails, guaranteed. The governance example workflow gets the right path — align.
2. **[CRITICAL] registry-service symlink dangling** (Dockerfile:55 + package.json:22): root build never builds @bridge/registry-service (no tsconfig reference) → \`docker run … service\` always fails.
3. **[MEDIUM] Runtime bloat + missing ops hygiene** (Dockerfile:50-51): full dev node_modules (typescript, @types/*) + whole source trees copied; no HEALTHCHECK; base not digest-pinned. Fix: prune --omit=dev stage, copy dist+package.json+migrations only, HEALTHCHECK for service mode.

## Acceptance criteria
- [ ] Root \`npm run build\` builds every package incl. registry-service (and @bridge/serialization — ties to release issue)
- [ ] \`docker build\` + \`docker run … version\` + \`docker run … serve --help\` smoke steps added to CI
- [ ] Slim runtime image; HEALTHCHECK present
- [ ] Image size before/after documented in PR`
},
{
  title: "[docs] Full documentation sync: nonexistent --mode flag, wrong exit-code contract, version unification to 0.2.0, stale counts/trees/indexes",
  labels: ["area:docs", "kind:bug", "priority:high"],
  body: `## Problem
Docs are unusually verifiable (all snippets compile, all demos byte-match) but the 0.1.x→0.2.0 transition left rot — including two defects in the CI-gating path users copy-paste.

### HIGH
1. **Nonexistent flag in copy-pasteable CI recipe**: docs/COMPATIBILITY.md:13,162 + docs/QUICKSTART.md:150 document \`--mode compatible\`; actual flags are \`--compatible\`/\`--strict\` (main.ts:46-52) → the documented GitHub Actions recipe fails every PR. Fix: \`bridge check --compatible\`.
2. **Wrong exit-code contract**: docs/COMPATIBILITY.md:8,102 say \`bridge diff\` "always exits 0"; it actually exits 1 on BREAKING/UNKNOWN (verified; intended per pipeline.test.ts:121-141). Fix: document gate behavior for both diff and check.
3. **Version story incoherent**: README says 0.2.0, CHANGELOG has [0.2.0] section but no link definition; root + 8/9 packages are 0.1.0; no git tags; GENERATOR_VERSION stale (generators/src/index.ts:36). Fix: **unify everything to 0.2.0**, add [0.2.0] link def, bump GENERATOR_VERSION — this is the version the first tag will carry.
4. **CHANGELOG omits three shipped features** (impact analysis #28, events+RPC #29, serialization matrix #31). Add under 0.2.0.

### MEDIUM (stale counts / wrong facts)
5. README transcript shows "5 file(s) written" — actual is 6 (:25-31).
6. QUICKSTART binary path wrong: dist/index.js → dist/bin/bridge.js (:17).
7. QUICKSTART: init creates **bridge.json** not bridge.config.json (:29).
8. ROADMAP "every phase shipped" contradicts AI-native Phase-3 item (:49-51); README repeats it (:104).
9. ROADMAP "15 commands" lists 14 — add impact (:20).
10. "Seven examples with verified demos" — there are 8 dirs; events-rpc has no demo.mjs (README:169, QUICKSTART:211, ROADMAP:22).
11. README/ARCHITECTURE/CONTRIBUTING package trees list 5 of 9 packages; test counts stale (README:159-171,183; ARCHITECTURE.md:68-74; CONTRIBUTING.md:16-25; TESTING.md:9 → 569/9 packages).
12. ARCHITECTURE diagram omits Java/C# + impact command (:28-31).
13. Docs index omits EVENTS/RPC/SERIALIZATION/IMPACT/TESTING (README:146-158).
14. IMPACT.md --strict semantics: code gates on any BREAKING (impact.ts:748), doc says "reaches at least one consumer" (:129-130).
15. CONTRIBUTING "Node >= 20" vs engines >=22 (:12).
16. dashboard/README default port 8080 vs service default 4350 (:53).
17. COMPATIBILITY output description inverted (:105-107).
18. SECURITY.md scope omits registry-service + dashboard (:18-22).
19. POSITIONING stale numbers ("five packages, 311+ tests") + horizons marked in-flight though shipped (:32-80).

### LOW
20. IDL_REFERENCE "four languages" (:5); EVENTS/RPC language tables omit Java/C#; README WASM row in generate-language table (not a generate target).
21. events-rpc README pointless generate steps (:8-9).
22. README/ROADMAP mark release engineering "✅ Shipped" though zero tags exist — reword "pipeline shipped, first release pending".
23. CHANGELOG "shipped earlier in the 0.1.x line" phrasing (no 0.1.x releases exist).

## Acceptance criteria
- [ ] Every documented command/flag runs verbatim (scripted spot-check in PR description)
- [ ] Version unified to 0.2.0 across manifests + GENERATOR_VERSION + CHANGELOG links
- [ ] Counts/trees/indexes reflect 9 packages / 569+ tests / 8 examples / 6 languages / impact command
- [ ] SECURITY.md scope includes registry-service + dashboard
- [ ] README badges (CI status) added — CI badge will show pending until billing lock clears`
},
{
  title: "[hygiene] Repo cleanup: bun.lock, vendored rustup-init.sh, generate-ffi mkdir bug, issue templates config, dead code sweep",
  labels: ["kind:hygiene", "priority:low"],
  body: `## Problem
Small cleanup items with real (if low) risk.

1. **bun.lock untracked at root**, project is npm-workspaces with package-lock.json authoritative → permanent status noise. Fix: ignore bun.lock/bun.lockb (or commit if bun becomes the release build tool — it IS used by release.yml bun build; decide and document).
2. **rustup-init.sh (930-line vendored bootstrap) tracked at root**, referenced by nothing — supply-chain surface. Delete (local archive tag preserves nothing of value here; upstream rustup is the source).
3. **scripts/generate-ffi.mjs:28** \`mkdirSync(path.slice(0, path.lastIndexOf('/')))\` on flat filenames → lastIndexOf = -1 → junk sibling dirs (Cargo.tom, go.mo). Fix: node:path dirname + recursive.
4. **Issue/PR templates**: add config.yml (blank issues + contacts), extend PR checklist with lint/typecheck + version-bump + dashboard items; consider YAML issue forms.
5. **Dead code sweep** (verified by audit): compat/src/report.ts:137 toJson (unused export), bridge-core/src/cache.ts unwired (documented decision needed — track until integrated), fuzz/cli.ts chunk() misname + missing --help in USAGE, bin/bridge-fuzz.js missing module shape check.
6. **Remote branch hygiene**: merged feat/* branches deleted locally; delete remote merged branches (origin/feat/*) to keep the repo tidy (GitHub preserves PR refs).

## Acceptance criteria
- [ ] git status shows zero noise on a fresh clone + npm install
- [ ] rustup-init.sh gone from HEAD
- [ ] generate-ffi output has no junk dirs (assert in test)
- [ ] config.yml present; PR checklist updated
- [ ] Dead code removed or explicitly documented as intentional`
}
];
