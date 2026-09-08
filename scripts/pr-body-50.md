Fixes #50

Live-mode data-layer hardening for the registry console. Errors can no longer masquerade as "not found", hung backends can no longer hang renders, and data fan-out is parallel. Bounded surface: `dashboard/**`. **Stacked on #67** (fix/50-dashboard-data ⊂ fix/49-dashboard-a11y) — merge #67 first.

## Changes

### 1. Errors are honest: 404 → null; everything else THROWS (HIGH)
`registry-client.ts` now has a typed **`RegistryError`** (name, `status`, `path`; exported with an `isNotFound()` guard):
- `getContract` / `getVersion` / `getDiff`: `res.status === 404` → `null` (pages keep calling `notFound()`); **any other failure rethrows** — a 500/timeout/outage now hits the error boundary with Retry instead of rendering "Contract not found"
- `listOrgs` / `listContracts` / `listVersions` / `listConsumers` / `listAudit` / `getGraph` / `listAllContracts` / `getOverview`: throw through unchanged (no silent nulls anywhere)

### 2. Fetch timeout with typed error (MEDIUM)
`get()` passes `AbortSignal.timeout(10_000)`; a hung registry now aborts after 10s and surfaces as a `RegistryError` (`status: 0`, message "registry request timed out after 10000ms …"). Connection-refused/DNS failures also map to the same typed error.

### 3. Parallel fan-out — N+1 cascades killed (MEDIUM)
- `listAllContracts`: the org→projects→contracts walk now fans out per org, then per (org, project) via `Promise.all`
- `getOverview`: `listAllContracts` + `listOrgs` + `listAudit` run concurrently (were strictly sequential); the per-candidate (versions → diff) lookups for non-SAFE contracts all run concurrently

Request counts (documented per acceptance criteria):

| Call path | Before (sequential depth) | After |
|---|---|---|
| `listAllContracts`, O orgs / P projects | `1 + O + P` round-trips strictly sequential | same count, **depth 2** (orgs → parallel per-org projects+contracts) |
| `getOverview` | `(1 + O + P) + 1 + 1 + 2B` sequential | depth 2: `[contracts-walk ‖ orgs ‖ audit]` → parallel per-candidate `versions → diff` |

Wall-clock for the demo-shaped registry (2 orgs, 4 projects) drops from ~11 sequential round-trips to 2 dependency levels on `/`. Verified with a mock-fetch harness: **max in-flight = 2** during `listAllContracts` (was 1), **4** during `getOverview`.

### 4. Schema-drift detection (MEDIUM)
`pickArray` no longer silently returns `[]` when none of the expected array keys is present — it throws `RegistryError("…has none of the expected array keys [orgs] — API schema drift", {status: 0, path})`. Drift now shows the error boundary instead of an empty page labeled "No contracts match".

### 5. Per-route `loading.tsx` (HIGH)
Six route skeletons (new `components/skeletons.tsx`, composed from the previously-unused `ui/skeleton.tsx` `Skeleton` primitive, `aria-busy` on the shell):
- `/` → `OverviewSkeleton` (stat cards, verdict cards, recent-publishes table)
- `/contracts` + `/audit` → `TableSkeleton` (filter card + rows)
- `/contracts/[org]/[project]/[contract]` → `ContractDetailSkeleton`
- `.../diff` → `DiffSkeleton` (verdict banner, summary cards, change list)
- `/graph` → `GraphSkeleton`

### 6. `error.tsx` logs + digest; `global-error.tsx` added (MEDIUM)
- Route boundary now `console.error('[dashboard] route error:', error)` in an effect, shows `error.digest`, stops hardcoding "Could not reach the registry" — registry failures (detected via `instanceof RegistryError`) get the registry copy incl. `error.message`; render bugs get a generic copy
- New `app/global-error.tsx` catches layout/runtime-level failures: own `<html>/<body>` shell, inline dark theme (root layout is bypassed), logs, digest, Retry

### 7. `isDemoMode()` strict parse (LOW)
Only exact `'false'`/`'0'` disables demo mode; exact `'true'`/`'1'`/empty/undefined behave as before; **any other value (e.g. `'FALSE'`) keeps demo ON and emits a `console.warn`** naming the accepted values. Previously `'FALSE'` silently meant "demo".

## Validation
- `npm run lint` → **0 errors** (5 pre-existing warnings; one — the unused `pickArray` generic — is gone as a side effect of the rework; rest cleaned in #51)
- `npm run typecheck` (tsc --noEmit) → clean
- `npm run build` → **7 routes** green
- Mock-fetch harness (`scripts/verify-registry-client.mjs`, local evidence — compiles the client with the dashboard's tsconfig, stubs `globalThis.fetch`, exercises both paths):

```
PASS  404 on getContract resolves to null (notFound() path)
PASS  500 on getContract throws RegistryError — status=500
PASS  non-404 RegistryError is not isNotFound
PASS  timeout surfaces typed RegistryError — registry request timed out after 10000ms on GET /v1/orgs
PASS  network failure surfaces typed RegistryError — registry unreachable on GET /v1/audit
PASS  missing expected key throws (no silent empty page) — registry response for GET /v1/orgs has none of the expected array keys [orgs] — API schema drift
PASS  listAllContracts returns all org/project contracts — got 2 (2 orgs × 1 project × 1 contract)
PASS  fan-out is concurrent (max in-flight fetches > 1) — maxInFlight=2, calls=3
PASS  request sequence is breadth-first (orgs first, then parallel per-org work)
PASS  getOverview composes concurrently — maxInFlight=4

ALL CHECKS PASS
```

## Stacking
Branch off `fix/49-dashboard-a11y` (#67). PR 3 (#51) branches off this branch. Merge order: #67 → this → #51.
