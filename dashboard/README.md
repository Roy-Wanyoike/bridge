# Bridge Dashboard

The web console for the Bridge contract registry: browse contracts and their
published versions, inspect consumers and producers, read compatibility
reports between any two versions, explore the dependency graph and follow the
audit log.

Next.js (App Router) + TypeScript + Tailwind CSS + shadcn-style components.

## Quickstart

```bash
cd dashboard
npm install
npm run dev          # http://localhost:3000 — demo mode, no backend needed
```

The dashboard boots in **demo mode** by default: it renders a realistic
seeded dataset derived from the example contracts (`examples/*.bridge`),
including deliberate breaking-change scenarios, so the UI is fully browsable
with zero backend.

## Going live

Point it at a running registry service (see
`packages/bridge-registry-service`):

```bash
NEXT_PUBLIC_DEMO_MODE=false \
NEXT_PUBLIC_REGISTRY_URL=http://localhost:4350 \
npm run dev
```

The REST client (`src/lib/registry-client.ts`) targets the service API:
`/v1/orgs/{org}/projects/{project}/contracts...`, `/v1/search`, `/v1/audit`.

## Routes

| Route | Shows |
|-------|-------|
| `/` | Overview: totals, recent publishes, recent breaking changes |
| `/contracts` | Searchable contract list with consumer counts + language coverage |
| `/contracts/[org]/[project]/[contract]` | Version timeline, consumers/producers, publish metadata, pull command |
| `/contracts/[org]/[project]/[contract]/diff?from=&to=` | Compatibility report (SAFE/WARNING/BREAKING change list) |
| `/graph` | Dependency graph (pure SVG, deterministic layered layout) |
| `/audit` | Audit log with filters |

## Environment

| Variable | Default | Meaning |
|----------|---------|---------|
| `NEXT_PUBLIC_DEMO_MODE` | `true` | Render seeded demo data instead of calling the registry |
| `NEXT_PUBLIC_REGISTRY_URL` | `http://localhost:8080` | Registry service base URL (live mode) |

## Scripts

- `npm run dev` — dev server
- `npm run build` / `npm run start` — production build + serve
- `npm run lint` — ESLint
- `npm run typecheck` — `tsc --noEmit`
