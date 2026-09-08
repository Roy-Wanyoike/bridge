Fixes #49

Accessibility pass over the registry console (WCAG 2.1 AA blockers from the audit). Bounded surface: `dashboard/**`.

## Changes

### 1. Tabs are keyboard-operable (HIGH, WCAG 2.1.1)
`components/ui/tabs.tsx` — `TabsList` now implements the WAI-ARIA APG tabs pattern:
- **ArrowLeft/ArrowRight** move focus to prev/next tab with **automatic activation** (wraps around)
- **Home/End** jump to first/last tab
- roving `tabIndex` (already present) is now actually usable; `data-tabs-value` carries the tab value to the activation handler
- `aria-selected`/`aria-controls`/`aria-labelledby` wiring kept — and now fully operable

The Versions/Consumers/Producers/Schema tabs on contract detail pages are reachable and operable via keyboard.

### 2. Dialog is WCAG-compliant (HIGH)
`components/ui/dialog.tsx` reworked:
- **Focus trap**: Tab/Shift+Tab cycle within dialog content (focusables enumerated at keypress time, hidden elements excluded)
- **Initial focus** moves to the dialog content on open
- **Focus restore** to the trigger on close (previous `document.activeElement` saved and restored)
- **aria-labelledby / aria-describedby** wired via generated ids — `DialogContent` provides title/description ids through context; `DialogDescription` registers itself so `aria-describedby` is only emitted when a description exists
- **Body scroll lock** while open (previous overflow restored on close/unmount)
- `role="dialog"` + `aria-modal="true"` now live on the content element that carries the label ids
- `DialogClose` reads `onOpenChange` from dialog context instead of a prop
- `audit-detail-dialog.tsx:22`: removed the second `onOpenChange` hand-off — `<DialogClose />` is now context-driven

### 3. Graph nodes exposed to AT (MEDIUM)
`compat-graph.tsx` — `role="img"` → `role="group"` (aria-label kept) so the subtree (10+ `role="link"` nodes) is no longer forced presentational.

### 4. Contrast fixes (MEDIUM)
Text `text-muted-foreground/70` (≈4.3:1) → `/80` (≈5.4:1, ≥4.5:1 AA) at:
- `contracts/page.tsx:189`, `[contract]/page.tsx:256` (+ ProducerChips "none" at :383), `audit/page.tsx:150`, `graph/page.tsx:106`

Graph non-text ≥3:1 (all ratios vs `#0a0a0c` background):
- edges `stroke-zinc-600` (≈2.5:1) → `stroke-zinc-500` (≈4.1:1); arrow marker was already zinc-500, now matches
- default node ring `#52525b` (≈2.5:1) → `#71717a` (≈4.1:1)
- 10px version label `fill-zinc-500` (≈4.1:1) → `fill-zinc-400` (≈7.6:1)
- `GraphLegend` sample graphics updated to the same colors

**Contrast audit (sRGB → WCAG relative luminance, bg `#0a0a0c`):**

| Element | Before | After |
|---|---|---|
| muted-foreground/70 text (11px) | 4.27:1 ✗ | `/80` = 5.4:1 ✓ (≥4.5) |
| graph edges / default ring | 2.53:1 ✗ | 4.07:1 ✓ (≥3 non-text) |
| version label (10px text) | 4.07:1 ✗ | 7.56:1 ✓ |
| zinc-300 contract id label | 12.6:1 ✓ | unchanged |

### 5. ScopeSwitcher reflects the URL (LOW)
`app-shell.tsx` — was uncontrolled `defaultValue='all'` and went stale after navigation. Now **controlled**, derived from `usePathname` + `useSearchParams` (wrapped in `Suspense`): `/contracts?org=acme&project=payments` → "acme / payments"; breadcrumb org-only links → synthetic "org / all projects" option; everywhere else → "All orgs".

### 6. Graph org tabs + table captions (LOW)
- `graph/page.tsx`: org scope tabs get `aria-current="page"`
- sr-only `<caption>` on every data table where natural: contracts list, audit trail, graph (most-consumed + node census), contract consumers, publishers, overview recent publishes

## Validation

- `npm run lint` → **0 errors** (6 pre-existing warnings — dead code cleaned in the stacked #51 PR)
- `npm run typecheck` (tsc --noEmit) → clean
- `npm run build` → **7 routes** green
- Keyboard walkthrough: Tab reaches the tablist; ←/→/Home/End switch + activate tabs; Tab falls through into panel content; dialog: focus moves in on open, Tab/Shift+Tab trapped, Esc closes, focus returns to the trigger

## Stacking

PR 2 (data layer, #50) branches off this branch; PR 3 (polish, #51) off PR 2. Merge in order.
