Fixes #51

Correctness & polish batch for the console. **Stacked**: fix/51-dashboard-polish → fix/50-dashboard-data (#68) → fix/49-dashboard-a11y (#67) → main. Merge in order. Bounded surface: `dashboard/**`.

## Correctness

### 1. Demo audit deep links (MEDIUM)
`demo-data.ts` pull rows hardcoded `project` derived from the detail string (`org === 'globex' ? 'billing' : 'commerce'`) and parsed the contract name out of free text. Pull rows are now explicit records carrying the **real org/project/contract/version**, so the audit page's `/contracts/${org}/${project}/${contract}` links always resolve:

```
$ node scripts/verify-demo-links.mjs   (before the fix)
audit rows: 32, demo contracts: 11
404       evt-0028  pull         /contracts/acme/commerce/risk-engine
404       evt-0031  pull         /contracts/acme/commerce/payments
2 BROKEN DEEP LINK(S)

$ node scripts/verify-demo-links.mjs   (after the fix)
RESOLVES  evt-0027  pull         /contracts/acme/commerce/catalog@v2
RESOLVES  evt-0028  pull         /contracts/acme/payments/risk-engine@v2
RESOLVES  evt-0029  pull         /contracts/acme/commerce/store@v2
RESOLVES  evt-0030  pull         /contracts/globex/billing/billing@v2
RESOLVES  evt-0031  pull         /contracts/acme/payments/payments@v3
RESOLVES  evt-0032  pull         /contracts/globex/billing/reporting@v1
... (all 32 rows)
ALL AUDIT DEEP LINKS RESOLVE
```

The script (`scripts/verify-demo-links.mjs`, harness only — not committed to the dashboard) compiles the demo dataset with the dashboard's tsconfig and asserts every audit row's contract link exists in the demo contract set. Note: the issue counted 3 broken links; the audit found **2** (risk-engine and payments were filed under `acme/commerce` instead of `acme/payments`; `globex/billing/reporting` did resolve). The acceptance criterion is nonetheless enforced exactly: *all* audit rows' contract links resolve.

### 2. Live `getOverview` no longer fabricates columns (LOW)
`registry-client.ts` `recentPublishes` (built from audit events):
- `packageName: "${e.contract}.${e.version ?? ''}"` → trailing dot removed: `e.version ? \`${e.contract}.${e.version}\` : e.contract`
- `languages: []` fabrication → **joined** from the published contract's real language union (contract summaries are already in scope); unknown → `[]` omitted honestly
- `version: e.version ?? 'v0'` → no invented version; empty renders as "—" on the overview
- `hash/shortHash/owner` also joined from the contract summary where available

### 3. Versions sorted by `publishedAt` before "Latest"/window indexing (LOW)
`[contract]/page.tsx` and `diff/page.tsx` sort `listVersions` output by `publishedAt` client-side — "Latest" and the adjacent-diff windows no longer assume ascending API order. (`getOverview`'s window indexing was already fed by this ordering on this branch.)

### 4. Diff version picker: inverted/empty diffs disabled (LOW)
`diff-version-picker.tsx` now orders versions chronologically and **disables** options that would produce `from >= to` (index-based, so `v2` vs `v10` compares correctly). The current selection stays visible even when disabled.

### 5. Graph keyed by `org/project/base` (LOW)
`demoGetGraph` node ids are now the fully-qualified storage key `org/project/base` (imports resolve through the provider contract's key), so duplicate bases across orgs can't collide; `compat-graph.tsx` navigates/labels by `n.base`, `graph/page.tsx` verdict lookup keys by `${org}/${project}/${base}`, `GraphNode.id` documents the contract. `Node census` rows key on the now-unique id.

### 6. Audit page single fetch (LOW)
`audit/page.tsx` fetched the trail twice (filtered + unfiltered) just to populate the actor dropdown. Now **one** fetch; action/actor/contract filters are applied client-side (same semantics as the demo filters).

## Polish

### 7. Hash UX: `shortHash` + CopyButton (LOW)
Full 64-char SHAs no longer dump inline on the contract page — header shows `latestShortHash` and the version timeline shows `sha256:{shortHash}`, each with a `CopyButton` carrying the full hash (mobile no longer wraps). `format.ts` `shortHash` is now **wired** (demo-data uses it everywhere it slices hashes; audit detail strings too).

### 8. `not-found.tsx` neutral copy (LOW)
"Page not found" instead of "Contract not found" — an unknown URL is no longer misdiagnosed as a missing contract.

### 9. Metadata / SEO (LOW)
- `layout.tsx`: `metadataBase` (`NEXT_PUBLIC_CONSOLE_URL`, default `http://localhost:3000`), OpenGraph block, robots, and `viewport` export with `themeColor: '#0a0a0c'` + `colorScheme: 'dark'` (dark browser chrome)
- **`app/icon.svg` favicon added** — the BRIDGE bridge glyph on the dark base color (dark-theme aware)
- Per-route titles/descriptions: Overview (had none), Contracts, Audit log, Dependency graph gained descriptions; contract detail and diff `generateMetadata` return title + description (titles already existed there)
- Build now emits the `/icon.svg` static route (8 routes total)

### 10. Dark-only theme documented (LOW)
`dashboard/README.md` gains a **Theme** section (dark-only is an explicit product choice; no light toggle) and documents `NEXT_PUBLIC_CONSOLE_URL` plus the strict demo-mode parsing.

### 11. Timer cleanup + select chevron (LOW)
- `copy-button.tsx`: the 1600 ms "Copied" reset timer is tracked in a ref, cleared before re-arm and on unmount (no state fire into detached components)
- `ui/input.tsx` `Select`: dropdown chevron drawn as an inline SVG background image (no wrapper element, so no layout regressions; `appearance-none` hides the UA arrow)

### 12. compat-graph responsive (LOW)
- SVG wrapped in an `overflow-x-auto` container with `min-w-[860px]` — legible at 375 px via horizontal scroll instead of ~5 px labels
- **Dynamic layer height**: canvas height = `max(420, densestLayer × 92 + margins)`, so a wide layer spreads instead of crushing (previous fixed 940×560 viewBox)

## Dead code (lint-verified)
- `ScrollText` unused import in `audit/page.tsx` — removed
- `LANGS_ALL` in `demo-data.ts` — removed
- `toVersion` unused local in `demoGetDiff` — removed
- unused generic `T` in `pickArray` — removed (with #50's rework)
- `format.ts` `ageInDays` — removed; `shortHash` — **wired** (see #7)
- `ui/skeleton.tsx` — wired by #50's loading states
- `demoListConsumers` / `demoPublishers` now honor the `version` param (consumers' verdict comes from the adjacent diff that produced the requested version; publishers roll up only versions up to the requested one)

## Validation
- `npm run lint` → **0 errors, 1 warning** (was 6 warnings; the only remaining one is a pre-existing style nit in `eslint.config.mjs` itself — anonymous default export — untouched as out of scope)
- `npm run typecheck` (tsc --noEmit) → clean
- `npm run build` → **8 routes** green (7 pages + `/icon.svg`)
- Demo deep links resolve for all 32 audit rows (script output above; run before & after)
- `scripts/verify-registry-client.mjs` re-run after the `recentPublishes` rework: **ALL CHECKS PASS** (404/throw split, timeout, schema drift, concurrency unchanged)

## Stacking
Merge order: #67 (a11y) → #68 (data layer) → this.
