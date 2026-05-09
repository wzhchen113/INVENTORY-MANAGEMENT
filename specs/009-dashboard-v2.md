# Spec 009: Dashboard v2 (All-Stores rollup)

Status: READY_FOR_REVIEW

## User story

As an admin overseeing the 2AM PROJECT chain, I want the All-Stores rollup
dashboard to surface trends, cost-of-goods variance, day-over-day food-cost
patterns, and a per-store action queue at a glance so that I can spot
operational drift in seconds instead of clicking through Reconciliation,
Inventory, and Audit screens to assemble the picture myself.

The current v1 dashboard
([src/screens/cmd/sections/DashboardSection.tsx](../src/screens/cmd/sections/DashboardSection.tsx),
328 lines) shows current-state KPIs + a 14-day food-cost line + a stock-alerts
list + raw activity log. v2 augments that with: (1) sparklines on each KPI,
(2) a CoGS theoretical-vs-actual variance card with top-5 line items, (3) a
4-stores × 7-days food-cost variance heatmap, (4) per-store priority
"attention queues" replacing the recent-activity column.

## Source materials

- Owner-authored handoff: `/tmp/handoff-inspect/dashboard_v2_handoff/README.md`
- v2 component reference (raw React + DOM, not RN): `/tmp/handoff-inspect/dashboard_v2_handoff/screens-dashboard-v2.jsx`
- Sample data shapes: `/tmp/handoff-inspect/dashboard_v2_handoff/data.jsx`
- v1 reference component (for comparison): `/tmp/handoff-inspect/dashboard_v2_handoff/screens-ops.jsx`

The handoff is a self-contained HTML preview using `window.cmdTokens(dark)` /
`window.cmdMono` / `window.IM_DATA` shims and raw `<div>` / inline style
primitives. It does NOT drop into our codebase as-is — we use React Native +
react-native-web. Translation is mechanical (`<div>` → `<View>`, `<span>` →
`<Text>`, CSS grid → flex-with-flexBasis or our existing layout atoms) but
verbose; see Q5.

The handoff zip is not yet committed to the repo. Precedent: spec 005's
`docs/internal/prep-canonicalness-notes.md` was committed as a reference doc;
the user can decide separately whether to copy `dashboard_v2_handoff/` into
`docs/internal/` for posterity.

## Acceptance criteria

Phase 1 (this spec; assuming PM leans on Q1–Q8 are accepted — see Open
questions). Each criterion is independently testable:

- [ ] **A1.** `src/screens/cmd/sections/DashboardSection.tsx` renders 5 KPI
  tiles in a single horizontal strip, each with: label, value, sub-label,
  delta pill (color-coded by tone), and an inline SVG sparkline of 7–14
  data points. KPIs: total inventory value, avg food cost %, waste/wk, EOD
  submitted (n/total), stock alerts.
- [ ] **A2.** A new `<Sparkline />` primitive lives at
  `src/components/cmd/Sparkline.tsx`, takes
  `{ values: number[]; color: string; width?: number; height?: number; fill?: boolean }`,
  renders a polyline (and optional 12%-opacity area fill) using
  `react-native-svg`, and works on both web and native.
- [ ] **A3.** A "CoGS · theoretical vs actual" card renders for the current
  week with three Stat sub-tiles (theoretical, actual, Δ variance with %)
  followed by a "top variance items" list (top 5 by `|Δ$|`, each row showing
  item name, store, reason, signed Δ$ in tone-colored mono).
- [ ] **A4.** Theoretical-vs-actual numbers are derived by reusing the
  existing variance computation in
  [ReconciliationSection.tsx](../src/screens/cmd/sections/ReconciliationSection.tsx)
  rather than duplicating the per-item math. The shared computation is
  extracted into `src/lib/cmdSelectors.ts` (or a sibling) as a pure function
  callable from both screens, with no behavioral change to Reconciliation.
- [ ] **A5.** A "food cost variance · last 7 days" heatmap renders one row
  per store (4 rows in current state), one column per day (7 cols), each
  cell labeled with the signed pp delta and color-graded per the threshold
  table in the handoff README §"Heatmap thresholds" (`>=+2.5` red,
  `>=+1.5` deep amber, `>=+0.5` amber, `±0.5` neutral, `<=-0.5` green).
- [ ] **A6.** The per-store column grid replaces the v1 single-store
  recent-activity feed with one card per store in the user's accessible
  store set (respecting `auth_can_see_store()`), each card containing:
  store header (name, status pill, slug-style mono subtitle), 4-cell mini
  stats grid (inv, food%, alerts, eod), the new attention queue (see A7),
  and a footer with manager + last-sync.
- [ ] **A7.** The attention queue per store lists alerts client-derived from
  existing data sources (no new tables, no new edge function in Phase 1):
    - **EOD missing** (severity: high if 0 entries past `eodDeadlineTime`,
      med otherwise) — derived from `eodSubmissions` for today + the store's
      `eodDeadlineTime`.
    - **Out of stock** (high) and **low stock** (med) — derived from
      `inventory` + `getItemStatus()` (already in store).
    - **Food-cost streak ≥3 days over target** (high) — derived from the
      existing per-day variance computation extended to the last 7 days.
    - **Unconfirmed POs >3 days old** (med) — derived from
      `orderSubmissions` (or whichever store table backs PO state today;
      architect to confirm exact source).
  Each item carries `{ sev: 'high'|'med'|'low', text: string }`. List sorted
  high → med → low. Empty state: a single "✓ all clear" row.
- [ ] **A8.** When a store has zero queue items, its store-header count
  badge renders in `C.ok`; with any high-severity item, in `C.danger`;
  otherwise `C.warn`. Count is `q.length`.
- [ ] **A9.** The dashboard reads from the existing `useStore` selectors;
  no new Zustand actions are introduced for this spec. If a derivation gets
  expensive enough to warrant memoization beyond `React.useMemo`, it lands
  in `src/lib/cmdSelectors.ts` (precedent: `useStockSeries`).
- [ ] **A10.** All visual primitives reuse existing Cmd UI atoms where they
  exist (`StatCard`, `SectionCaption`, `StatusPill`, `StatusDot`, `TabStrip`,
  `useCmdColors`, `mono`/`sans`/`Type`). The only new components introduced
  are `<Sparkline />` (A2) and a `<Heatmap />` primitive at
  `src/components/cmd/Heatmap.tsx` (matching the cell threshold + opacity
  ramp from the handoff `heatColor()`).
- [ ] **A11.** Type-check passes (`npx tsc --noEmit`) and the dashboard
  renders without runtime errors in the local Supabase dev stack
  (admin@local.test / password) for both empty-data and seeded-data cases.
- [ ] **A12.** v1 is fully removed (assuming Q6 = (a)) — no feature flag,
  no dual-render path. The 328-line v1 implementation is replaced in place.

## In scope

- Replace `src/screens/cmd/sections/DashboardSection.tsx` with the v2
  layout.
- Add `src/components/cmd/Sparkline.tsx` and `src/components/cmd/Heatmap.tsx`.
- Extract the per-item variance computation from
  `ReconciliationSection.tsx` into a shared selector in
  `src/lib/cmdSelectors.ts`. Reconciliation imports the extracted function;
  zero behavior change there.
- Client-derived attention-queue logic for the four alert types in A7.
- Web-only (assuming Q7 = web-only). Mobile native fallback continues to
  use the existing mobile screens; Cmd UI is desktop-first.

## Out of scope (explicitly)

- **Server-side `/stores/:id/attention` endpoint.** The handoff README
  recommends this; we are deferring per Q4b PM lean. Phase 2 spec.
  Rationale: avoids coupling Phase 1 ship to an edge-function rollout and
  lets the alert-set stabilize against real usage first.
- **New alert types requiring schema changes**: invoice matching, expiry
  tracking, temperature logging. These need new tables + UI for data entry
  (see Q4a). Each is a separate downstream spec (010 placeholder).
- **Daily KPI rollup table.** If Q1 = (a) we'll synthesize sparkline series
  from existing data points (e.g., the 14-day food-cost trend already
  computed in v1). A persisted `kpi_rollups_daily` table is deferred unless
  the synthesized series proves too noisy.
- **Drill-through deep links from queue items** (e.g., clicking "1 invoice
  unmatched" jumps to a filtered Inventory view). Handoff calls this out
  as a follow-up; we mark queue items non-interactive in Phase 1.
- **Native (mobile) variant of v2.** The v1 mobile screens
  (`InventoryListScreen`, `ItemDetailScreen`) remain; v2 is web/Cmd only.
- **Tab strip changes.** v1 has `overview.tsx` + `today.tsx`. The handoff
  shows `overview.tsx` + `by_store.tsx` + `variance.tsx`. We keep the v1
  tab set in Phase 1 and treat v2 as the new content of `overview.tsx`.
  Splitting into multiple tabs is a follow-up.
- **Modifying `AdminScreens.tsx`** (legacy, frozen per CLAUDE.md).
- **Modifying `useSupabaseStore.ts` / `useJsonServerSync.ts` / `db.json`**
  (legacy, frozen).
- **Changing `app.json` slug** (load-bearing, requires explicit user
  approval — see CLAUDE.md).

## Open questions resolved

Locked 2026-05-08 by user — ratified all 8 PM-recommended defaults as
written.

- **Q1 = (a) ship sparklines.** 5 KPI tiles get inline SVG sparklines.
  Synthetic interpolation from existing data points is acceptable for
  the first ship where daily rollups don't yet exist; architect to
  surface what's actually computed daily today vs what needs back-fill.
- **Q2 = (a) ship CoGS variance card.** Theoretical (POS depletion ×
  recipe BoM) vs actual (physical EOD counts) for the week + top-5
  high-variance line items with reason. Refactor existing
  `ReconciliationSection.tsx` math into a shared `cmdSelectors.ts` so
  both surfaces consume one implementation (per A4, no dupe).
- **Q3 = (a) ship variance heatmap.** 4 stores × 7 days color-graded
  grid showing daily food-cost variance pp from target. Same data
  source as Q2; thresholds per the handoff README's `heatColor()`.
- **Q4a = (a) only alert types we have data for today.** EOD missing,
  low/out stock, food-cost streaks, unconfirmed POs. Expiry tracking
  (b), invoice matching (c), temp logging (d) are deferred to Spec 010
  placeholder, each with its own data-modeling work.
- **Q4b = client-derived attention queue.** No new edge function or
  RPC for v1; the queue is computed in the Dashboard component from
  the existing `useStore` slices. Promote to server-computed
  `/stores/:id/attention` endpoint once the alert set stabilizes.
- **Q5 = (a) hand-translate to RN primitives.** Replace `<div>` /
  inline DOM styles with `<View>` / `<Text>` / `<ScrollView>` and
  reuse existing Cmd atoms (StatCard, SectionCaption, StatusPill,
  StatusDot, TabStrip). Two NEW components only: `Sparkline` and
  `Heatmap`.
- **Q6 = (a) v2 fully replaces v1.** `DashboardSection.tsx` (328
  lines) is replaced wholesale once v2 ships. No feature flag, no
  side-by-side. Single source of truth.
- **Q7 = web only.** Cmd UI shell only renders above 1100 px
  breakpoint per existing project convention; v1 already follows this
  rule, v2 inherits.
- **Q8 = (a) Phase 1 scope** as defined above. Phase 2 (expanded
  attention queue alert types) is filed as a separate placeholder
  spec (010), to be scoped when the underlying data sources land.

### Pinned scope shape (architect's contract)

- **Read-side**: Dashboard reads from existing `useStore` slices
  (`inventory`, `eodSubmissions`, `auditLog`, `currentStore`,
  `wasteLog`, `recipes`, `prepRecipes`, `posImports`, `orderSubmissions`
  or equivalent — architect verifies). No new fetches; no new edge
  functions.
- **Computation**: per-store + cross-store rollups computed in a new
  `src/lib/cmdSelectors.ts` (extracted from `ReconciliationSection`'s
  existing logic). Single implementation feeds both Reconciliation and
  the new Dashboard CoGS card.
- **New components**: `src/components/cmd/Sparkline.tsx` (~50 LOC,
  pure SVG via `react-native-svg`) and `src/components/cmd/Heatmap.tsx`
  (~80 LOC, View grid with color thresholds). Both reusable across
  future surfaces.
- **Replaced**: `src/screens/cmd/sections/DashboardSection.tsx` — full
  rewrite per Q6.
- **Architect-level open flags** (your call): whether KPI sparkline
  series come from a daily-rollup query that doesn't exist yet (= new
  data work) vs synthetic interpolation from current snapshots (=
  zero data work, less informative line). Default: synthetic for
  Phase 1, file daily rollups as a follow-up.

## Backend design

Architect: backend-architect (design mode), 2026-05-06.

This spec is read-only — no migrations, no edge functions, no `db.ts`
changes. The "backend" surface is the new pure-function selectors in
`src/lib/cmdSelectors.ts` (extracted from
`ReconciliationSection.tsx`) and the shape contract that the new
Dashboard component consumes from the existing `useStore` slices.

### §0 Probes (read-only verification)

Done before the design. Verified findings:

- **`react-native-svg` is a direct dep** (`package.json:51` —
  `"react-native-svg": "15.12.1"`). Direct import is fine; the spec's
  Dependencies note about it being "transitive via react-native-chart-kit"
  is wrong but harmless.
- **All listed `useStore` slices exist** (`src/store/useStore.ts:194-220`
  — `inventory`, `recipes`, `prepRecipes`, `wasteLog`, `eodSubmissions`,
  `vendors`, `posImports`, `auditLog`, `orderSubmissions`, `currentStore`,
  `stores`, `getItemStatus`).
- **`OrderSubmission` has no `confirmed` / `status` field**
  (`src/types/index.ts:338-346` — only id, storeId, day, date,
  vendorName, submittedBy, submittedAt). The spec's A7 "unconfirmed POs"
  alert as written is **not derivable from current data** — see §7
  below for the mitigation.
- **`Store` has no `manager`, `slug`, `lastSync` fields**
  (`src/types/index.ts:317-326` — only id, brandId, name, address,
  status, eodDeadlineTime). Handoff's per-store column header relies on
  these. Each renders as either an existing field or `'—'` per §5.
- **`useStore` slice loader only ever holds one store's
  `eodSubmissions`, `posImports`, `orderSubmissions`**
  (`src/store/useStore.ts:248-263`). The `__all__` mode dispatcher
  redirects to a focal store and the flatMap-across-stores hypothesis
  used in earlier drafts of this spec is wrong. The slice partiality
  is unconditional, not conditional. This is a hard architectural
  blocker for the per-store rollup grid (A6) and the heatmap (A5).
  See §7 (Decision D2) for the mitigation. *Doc-drift fix
  2026-05-08: previous wording cited an `__all__`-mode-conditional
  flatMap that no longer exists.*
- **`ReconciliationSection.tsx` math** is in three places: `rows` memo
  (line 56-84) for variance items, `ReconByCategoryTab.rows` memo (line
  268-288) for category roll-up, `ReconTimelineTab.days` memo (line
  341-361) for the 90-day delta-per-day grid. The "actual minus
  expected" definition differs per tab — variance.tsx uses prior EOD as
  expected, byCategory uses parLevel as expected, timeline uses
  parLevel as expected. The Dashboard heatmap should match
  `timeline.tsx`'s definition (parLevel-based) for visual consistency
  with the existing 90-day grid. See §2.
- **Cmd atoms are sufficient.** `StatCard`, `SectionCaption`,
  `StatusPill`, `StatusDot`, `TabStrip` cover the existing UI patterns;
  `useCmdColors()` exposes every token the handoff uses (`bg`, `panel`,
  `panel2`, `border`, `fg`, `fg2`, `fg3`, `accent`, `accentBg`, `ok`,
  `okBg`, `warn`, `warnBg`, `danger`, `dangerBg`). No fork needed.

### §1 Schema changes

**None.** Phase 1 is client-derived only. No migrations, no RLS
changes, no edge function changes. Confirmed per Q4b lock.

The realtime publication-membership gotcha and the local edge-runtime
bind-mount gotcha are both N/A for this spec (no `supabase_realtime`
delta, no edge functions modified).

### §2 `src/lib/cmdSelectors.ts` — extracted shared selectors (NEW)

Extend the existing `cmdSelectors.ts` (the file is already the home
for shared pure selectors — precedent: `getStockSeries`,
`getRecipesUsingItem`). Add five exported pure functions plus their
Zustand-shaped hook wrappers where useful.

All selectors take primitive args (no Zustand reach-in) so they're
unit-testable when a runner lands. The hook variants pull slices via
`useStore` and `React.useMemo` — same pattern as `useStockSeries`.

```ts
// All inputs primitive; output deterministic and pure.

export interface VarianceLine {
  itemId: string;          // catalog id (FK to inventory_items.catalogId)
  itemName: string;
  storeId: string;
  storeName: string;
  expected: number;        // base units
  counted: number;
  delta: number;           // counted - expected
  deltaCost: number;       // delta * costPerUnit (signed)
  reason: 'over-portion' | 'shrinkage' | 'spoilage' | 'under-portion';
  unit: string;
}

export type VarianceMode = 'priorEod' | 'parLevel';

/**
 * Per-item variance for one store, latest EOD vs an "expected" baseline.
 *
 * Modes:
 *   - 'priorEod' (default): expected = previous EOD's actualRemaining.
 *     Mirrors `ReconciliationSection.tsx:rows` (the variance.tsx tab).
 *   - 'parLevel': expected = item.parLevel. Mirrors
 *     `ReconByCategoryTab.rows` and `ReconTimelineTab.days`.
 *
 * Returns rows where delta !== 0 and the item still exists in inventory.
 * NOT sorted; caller decides ordering (Reconciliation sorts by |dollar|
 * desc; the Dashboard CoGS card uses computeTopVarianceItems below).
 *
 * The reason field is heuristic for Phase 1 (no invoice/POS-depletion
 * data to attribute by): delta < 0 + |pct| >= 25 → 'shrinkage';
 * delta < 0 + |pct| < 25 → 'over-portion'; delta > 0 → 'under-portion';
 * negative on Produce category → 'spoilage' overrides the above. Encode
 * the heuristic in one place; document inline that it's a placeholder
 * pending real attribution data.
 */
export function computeVarianceLines(
  storeId: string,
  inventory: InventoryItem[],
  eodSubmissions: EODSubmission[],
  stores: Store[],
  mode?: VarianceMode,                // default 'priorEod'
): VarianceLine[];

/**
 * CoGS theoretical for one store, one ISO date range [startDate, endDate].
 * Theoretical = sum over POSImport rows in range of:
 *   sum(saleItem.qtySold * recipe.ingredients[i].quantity * costPerUnit_at_store)
 * resolving recipeId → recipe → ingredients[] → catalogId → inventory[storeId].costPerUnit.
 *
 * Skips sale items where recipeMapped === false (no recipe to depleting against).
 * Returns 0 when no POS data exists in range — surfaces as "no POS imports yet".
 */
export function computeCogsTheoretical(
  storeId: string,
  startDate: string,            // ISO yyyy-mm-dd inclusive
  endDate: string,              // ISO yyyy-mm-dd inclusive
  posImports: POSImport[],
  recipes: Recipe[],
  inventory: InventoryItem[],
): number;

/**
 * CoGS actual for one store, one ISO date range. Sum of dollar-valued
 * EOD-vs-priorEOD deltas across the period:
 *   for each (date in range) where an EOD exists:
 *     sum(delta_per_item * costPerUnit) where delta = priorEod - currentEod
 *     (i.e. depletion is positive: stock went down).
 * If the prior EOD is outside the range, walk backward to find it
 * (mirrors `ReconciliationSection.previous` lookup).
 *
 * Returns 0 when no EOD exists in range. Negative values are possible
 * if a count went up (receiving wasn't logged) — surface as-is, don't
 * clamp.
 */
export function computeCogsActual(
  storeId: string,
  startDate: string,
  endDate: string,
  inventory: InventoryItem[],
  eodSubmissions: EODSubmission[],
): number;

/**
 * Top-N variance lines across a date range, one store. Aggregates per
 * itemId across all dates in range (sum of deltaCost per item), sorts
 * by |deltaCost| desc, returns top N.
 *
 * Used by the Dashboard CoGS card's "top variance items" list (A3).
 * Phase 1 limit defaults to 5; spec lock explicitly says top-5.
 */
export function computeTopVarianceItems(
  storeId: string,
  startDate: string,
  endDate: string,
  inventory: InventoryItem[],
  eodSubmissions: EODSubmission[],
  stores: Store[],
  limit?: number,               // default 5
): VarianceLine[];

/**
 * Per-store, per-day food-cost variance in *percentage points* from a
 * target food-cost ratio. Returns one number per day in [startDate,
 * endDate] (length = day count). Days with no EOD return 0 (treated
 * as "on target / no signal").
 *
 * Definition (Phase 1):
 *   day's variance pp = (day's actual food-cost % - TARGET_FOOD_COST_PCT)
 *   where actual food-cost % = (day's CoGS actual / day's POS revenue) * 100
 *
 * If POS revenue is 0 for the day, falls back to the depletion-only
 * proxy used in v1 (sub.entries.length % 5 + 30) so the heatmap still
 * paints rather than going blank — mirrors the existing v1 behavior at
 * `DashboardSection.tsx:64-74`. Document the fallback in code; flag for
 * removal in Phase 2 once POS data lands.
 *
 * `target` is passed in by caller (default 30 — see §11 D3 below).
 * Used by both the Dashboard heatmap (A5) and by computeAttentionQueue's
 * food-cost-streak rule.
 */
export function computeStoreFoodCostVariancePp(
  storeId: string,
  startDate: string,
  endDate: string,
  inventory: InventoryItem[],
  eodSubmissions: EODSubmission[],
  posImports: POSImport[],
  target?: number,              // default 30
): number[];

/**
 * Client-derived attention queue for one store. Reads from passed-in
 * slices; returns an ordered (high → med → low) list. Items have a
 * stable shape that downstream UI renders as severity-coded rows.
 *
 * Severity rules — see §7 below for the full ladder.
 */
export interface AttentionItem {
  /** Stable per-render id so React keys + future drill-through both work.
   *  Format: `<storeId>:<rule>:<scope>` (e.g. `s1:eod:today`). */
  id: string;
  sev: 'high' | 'med' | 'low';
  text: string;
  /** Rule that fired — useful for filtering, telemetry, future
   *  drill-through routing. Don't render to user verbatim. */
  rule: 'eod_missing' | 'low_out_stock' | 'food_cost_streak' | 'unconfirmed_po';
}

export function computeAttentionQueue(
  storeId: string,
  inventory: InventoryItem[],
  eodSubmissions: EODSubmission[],
  posImports: POSImport[],
  orderSubmissions: OrderSubmission[],
  orderSchedule: OrderSchedule,
  stores: Store[],
  getItemStatus: (i: InventoryItem) => ItemStatus,
  now?: Date,                   // injectable for determinism in tests
): AttentionItem[];

// ─── Hooks (Zustand-shaped wrappers) ─────────────────────────

export function useStoreFoodCostHeatmap(days?: number): Array<{
  storeId: string;
  storeName: string;
  values: number[];             // length = days, oldest → newest
}>;

export function useTopVarianceItems(days?: number, limit?: number): VarianceLine[];

export function useCogsForCurrentStore(days?: number): {
  theoretical: number;
  actual: number;
  delta: number;
  pct: number;
};

export function useAttentionQueueByStore(): Record<string, AttentionItem[]>;
```

**Reconciliation refactor (A4 — no behavioral change to that screen).**
After `computeVarianceLines` lands, change `ReconciliationSection.tsx`'s
inline `rows` memo to call `computeVarianceLines(currentStore.id,
inventory, eodSubmissions, stores, 'priorEod')` and then apply the
same `.sort((a,b) => Math.abs(b.dollar) - Math.abs(a.dollar))`. The
existing `dollar`/`pct`/`category`/`unit` fields map cleanly:
`dollar` = `deltaCost`, `pct` = `Math.round((delta / expected) * 100)`,
`unit` and `category` come from the matched inventory item.

**Risk:** the `reason` heuristic adds a new field to the Reconciliation
row shape that the existing screen doesn't render. Backwards-compatible
— existing screen ignores extra field. Dashboard reads it.

### §3 `src/components/cmd/Sparkline.tsx` (NEW)

Pure presentational SVG. ~30-50 LOC.

```ts
interface SparklineProps {
  /** Oldest → newest. Length 2-30. */
  values: number[];
  /** Hex or rgb(); usually a token from useCmdColors() (ok/warn/danger/fg3). */
  color: string;
  width?: number;               // default 88
  height?: number;              // default 22
  /** When true, render an area fill at 12% opacity below the polyline. */
  fill?: boolean;
  /** Optional accessibility label (rendered as <title> child of <Svg>). */
  label?: string;
}
export const Sparkline: React.FC<SparklineProps>;
```

Implementation:

- Import `Svg, Path` from `react-native-svg` (NOT `react-native-svg/Path`
  — the package re-exports both styles but the bare-import path is what
  the rest of this codebase uses; check sibling components if any exist).
- Compute `min`, `max`, `range = max - min || 1`, `step = width /
  (values.length - 1)`. Build path string `M x0,y0 L x1,y1 ...`.
- Optional fill: same path with `L width,height L 0,height Z` appended,
  rendered first at `fillOpacity={0.12}`.
- Polyline: `strokeWidth={1.4}`, `strokeLinejoin="round"`,
  `strokeLinecap="round"`, no fill.
- Empty / single-point input: render an `<Svg>` of the requested size
  with no children. Don't throw.

Web-only is the spec's lock (Q7). `react-native-svg` works on
react-native-web out of the box (other Cmd UI components like
`StockHistoryChart` already use it), so no platform branch needed.

### §4 `src/components/cmd/Heatmap.tsx` (NEW)

Pure presentational. SVG OR `View` grid — `View` grid is simpler,
matches `ReconTimelineTab`'s 90-day grid pattern (line 394-419), and
gets free reflow. Pick **`View` grid**.

```ts
interface HeatmapRow {
  /** Free-form row label, mono caps in the renderer. */
  label: string;
  /** Length must equal dayLabels.length. */
  values: number[];
}

interface HeatmapProps {
  rows: HeatmapRow[];
  dayLabels: string[];          // e.g. ['Sa','Su','Mo','Tu','We','Th','Fr']
  /** Cell value range that is colored. Outside range = clamp to ends. */
  thresholds?: {
    danger: number;             // ≥ this → danger color
    deepWarn: number;           // ≥ this → deep amber
    warn: number;               // ≥ this → warn color
    neutral: number;            // |value| ≤ this → neutral
    ok: number;                 // ≤ this → ok color
  };
  /** Cell height in px. Default 30. */
  cellHeight?: number;
}
export const Heatmap: React.FC<HeatmapProps>;
```

Default thresholds match handoff `heatColor()`:
`{ danger: 2.5, deepWarn: 1.5, warn: 0.5, neutral: 0.5, ok: -0.5 }`.

Cell color and opacity rules (translated from handoff JSX line 142-147
to `useCmdColors()`):

| Value (vv)                  | bg color    | opacity | text color |
|-----------------------------|-------------|---------|-----------|
| `vv >= 2.5`                 | `C.danger`  | 1.0     | `#fff`    |
| `1.5 <= vv < 2.5`           | `C.warn`*   | 0.85    | `#fff`    |
| `0.5 <= vv < 1.5`           | `C.warn`    | 0.65    | `#fff`    |
| `-0.5 < vv < 0.5`           | `C.fg3`     | 0.35    | `C.fg`    |
| `vv <= -0.5`                | `C.ok`      | 0.55    | `C.fg`    |

\* Handoff uses a custom deep-amber hex (`#B5530F` / `#E08840`). The
project palette doesn't have a "deep amber" token. Either add one to
`useCmdColors()` (token bloat) OR collapse 1.5-2.5pp and 0.5-1.5pp to
the same `C.warn` with different opacity (visually close, no token
add). **Decision D1: collapse to `C.warn` with opacity 0.85 vs 0.65.**
Document the deviation in a code comment so a future visual-QA pass
doesn't read it as a bug.

Layout: outer `View` with `flexDirection: 'row'` repeated as one
column per (label + 7 cells), OR a flexbox grid using `flexBasis`. The
v1 reference uses CSS `display: grid`, which RN doesn't support; build
it as a row-of-rows. The handoff's 72px label column + 7 equal cells
translates to: header row (empty corner + 7 day labels), then one row
per heatmap row (label cell width 72, then 7 flex:1 cells with gap 3).

Cell label is `{vv > 0 ? '+' : ''}{vv.toFixed(1)}` per handoff (line
147). Use `mono(600)`, `fontSize: 10.5`, `fontVariant: ['tabular-nums']`.

### §5 `src/screens/cmd/sections/DashboardSection.tsx` (REWRITE)

Replace the file entirely. Layout per handoff `screens-dashboard-v2.jsx`,
hand-translated to RN primitives (Q5 lock). One file, one default
export, ~300-400 LOC.

```
<View flex:1 bg:C.bg>
  <TabStrip
    tabs={[overview, by_store, variance]}    # 3 tabs per handoff
    activeId={tabId}                         # state preserved across switches
    onChange={setTabId}
    rightSlot={<Text>store: all (N) · period: today</Text>}
  />
  <ScrollView padding:18,22>
    <View>                                   # hero greeting
      <Text mono fg3>// good morning, admin · {dateString} · {N} stores</Text>
      <Text Type.h1>All stores · day in progress</Text>
    </View>

    <View flexDirection:row gap:10>          # KPI strip — 5 tiles, see Kpi atom below
      <Kpi label="TOTAL INV VALUE" value sub series tone delta />
      <Kpi label="AVG FOOD COST %" ... />
      <Kpi label="WASTE / WK" ... />
      <Kpi label="EOD SUBMITTED" ... />
      <Kpi label="STOCK ALERTS" ... />
    </View>

    <View flexDirection:row gap:12>          # CoGS card (1.1fr) + Heatmap (1fr)
      <CogsCard flex:1.1 ... />
      <View flex:1>
        <SectionCaption>food cost variance · last 7 days</SectionCaption>
        <Heatmap rows={...} dayLabels={...} />
        <Legend />
      </View>
    </View>

    <View flexDirection:row flexWrap:wrap gap:12>   # 4-up store grid
      {visibleStores.map(s => <StoreCol store={s} queue={queueByStore[s.id]} />)}
    </View>
  </ScrollView>
</View>
```

**Tabs (Decision D4).** Ship 1 tab — `overview.tsx` — only. The handoff
shows 3 tabs but defines content for one. Stub-tabs would ship a
"coming soon" footgun and the explicit Out-of-scope section in the
spec already says "Splitting into multiple tabs is a follow-up."
Single-tab `<TabStrip>` still gives the visual filename header. (If
later spec wants multi-tab, the existing v1 has `today.tsx` precedent
and the swap is trivial.)

**Local sub-components in the same file** (matches v1 pattern of inline
helpers):

- `<Kpi label value sub series tone delta />` — 1px-bordered panel,
  label row + `<Sparkline />` to the right of value. ~25 LOC.
- `<CogsCard theoretical actual delta pct topRows />` — handoff line
  100-123 translated. ~40 LOC.
- `<StoreCol store kpi queue activity manager lastSync />` — handoff
  line 168-225 translated. ~80 LOC. The store header derives:
  - `status`: maps `Store.status === 'active'` → `'open'` for the dot
    color; if today is past `eodDeadlineTime` and EOD not submitted →
    `'late'` → `C.warn`; else `'open'` → `C.ok`.
  - `slug`: `store.id.slice(0, 6).toLowerCase()` (handoff's
    `inv://{slug}` format) — Store has no slug field today.
  - `manager`: derive from `users[]` filtered to those with this store
    in their `stores` array, role `'admin'`, take first; render `'—'`
    if none.
  - `lastSync`: most recent `auditLog[i].timestamp` for this store; use
    `relativeTime(...)`. `'—'` if no events.
  - The 4-mini-stat grid: `inv` = sum(currentStock × costPerUnit) for
    that store; `food%` = latest day's actual food-cost % (clamp to 1
    decimal); `alerts` = count(getItemStatus(i) ∈ {low, out}); `eod` =
    `${eodSubmittedToday ? 1 : 0}/1` (we don't have a per-store
    "expected EOD count" — just one per day).

**Cross-store data — the showstopper.** §0 found that
`useStore.eodSubmissions` and `posImports` are only loaded for the
*current* store. Without cross-store data, the heatmap and the per-store
CoGS / variance cards can't compute for stores other than `currentStore.id`.

**Decision D2.** Pick option (b) below. Reasoning at the bottom of §7.

  - (a) **Mutate `useStore.loadFromSupabase`** to flatMap
    `eodSubmissions` and `posImports` across stores in the `__all__`
    branch. This is the architecturally correct fix but it touches the
    legacy "All Stores" code path and the store mutation is exactly
    the kind of thing CLAUDE.md "no dupes / utilize existing"
    encourages. The risk: every other Cmd section that consumed
    `eodSubmissions` while in `__all__` mode previously saw "current
    store only" and might silently change behavior (audit log section,
    Reconciliation, etc.). The user's spec lock says the dashboard is
    "admin-global view (rolls up across all stores the admin can see)"
    — so this is the right shape.
  - (b) **Add a `db.fetchEodSubmissionsForAllStores()` helper** that
    pulls from every store the admin can see, called from the
    Dashboard's mount effect, with the result held in component-local
    state (NOT the Zustand slice). Same for posImports. This avoids
    perturbing `__all__` mode behavior for other sections; the cost is
    the dashboard does its own fetch on mount and won't reflect
    realtime updates without a re-fetch.
  - (c) **Render the rollup using only data the user has loaded.**
    When in `__all__` mode, the heatmap rows and per-store CoGS/variance
    will show real data only for the focal store; other rows render with
    empty values (zeros / "—"). Honest about the limitation; obviously
    incomplete. Spec lock A6 says "every per-store column respects
    `auth_can_see_store()` because the store list comes from
    `useStore.stores`, which is already RLS-filtered" — but RLS scoping
    is not the same as data being loaded.

  **Decision D2: pick (b).** Reasoning: (a) silently changes the
  semantics of `eodSubmissions` for every other section in `__all__`
  mode (Reconciliation, AuditLog, the existing Dashboard chart) — a
  blast radius the spec doesn't authorize. (c) ships a half-broken
  feature. (b) is local, reversible, and explicit. The new helpers
  belong in `src/lib/db.ts` per the global "all DB access via db.ts"
  rule. New functions:

  ```ts
  // src/lib/db.ts — new
  export async function fetchEodSubmissionsForStores(
    storeIds: string[],
    sinceDate: string,            // ISO date, inclusive
  ): Promise<EODSubmission[]>;

  export async function fetchPosImportsForStores(
    storeIds: string[],
    sinceDate: string,
  ): Promise<POSImport[]>;
  ```

  Both fan out one PostgREST select per store (or a single
  `IN (storeId list)` select if RLS allows it; recommended — single
  round trip, RLS will silently drop unauthorized rows). Map snake_case
  → camelCase via existing helpers in `db.ts`. Honor the per-store RLS
  via `auth_can_see_store()` — no policy work needed. The Dashboard's
  `useEffect` calls them at mount + on any `currentStore.id` change,
  stores results in `React.useState`. `sinceDate` = today minus 7 days
  for the heatmap; minus 14 for sparklines.

**Re-render trigger.** The dashboard subscribes via `useStore` to
`stores`, `inventory`, `auditLog`, `wasteLog`, `currentStore`,
`getItemStatus`, plus its own component-local cross-store EOD/POS
state. When `useRealtimeSync.ts` fires its 400ms debounced reload for
the focal store, the Zustand slices update and the dashboard
re-renders for that one store. Cross-store EOD/POS won't update on
realtime — refresh-on-mount only. **Document this latency** in a code
comment. Promote to subscribe-to-all-store-channels if it bites.

### §6 Synthetic-vs-real KPI series

Per Q1 lock + §11 D5: Phase 1 ships **synthetic series**. Each KPI
gets a 10-point series derived from the current snapshot:

```ts
// Inside DashboardSection — local helper, NOT exported. Tagged with
// SYNTHETIC_KPI_SERIES so a future grep finds the placeholder.

/** SYNTHETIC_KPI_SERIES — Phase 1 placeholder.
 * No daily KPI rollups exist yet; this paints a sparkline that visually
 * reads but doesn't reflect real history. Generates 10 deterministic
 * points anchored to `current` with ±8% pseudo-variance derived from a
 * stable seed (storeId + label) so the line doesn't reshuffle on every
 * render. Replace with real daily-rollup query once Spec 010-or-similar
 * lands a `kpi_rollups_daily` table. */
function synthSeries(current: number, seed: string): number[];
```

Render an explicit "synthetic" tooltip is **deferred**. The handoff
doesn't show one and adding it requires a tooltip primitive we don't
have. Mitigation: the `SYNTHETIC_KPI_SERIES` comment makes it
discoverable in code; the spec's Out of scope section already mentions
the daily rollup table is deferred.

**Exception: the AVG FOOD COST % sparkline.** Real data exists — the v1
code already computes a 14-day food-cost trend
(`DashboardSection.tsx:64-74`). Reuse that path — pass the trend's
last 10 (non-null) points to `<Sparkline />` for that one tile. Only
the other four tiles (`inv`, `waste`, `eod`, `alerts`) are synthetic
in Phase 1.

### §7 Attention queue derivation rules

Per Q4a + Q4b lock. All client-derived in `computeAttentionQueue`. Order
output: high → med → low, then by alphabetic `text` for stable ordering
across renders.

| Rule              | Trigger                                                                                                                                       | Severity ladder                                                                          | Stable id format                          |
|-------------------|-----------------------------------------------------------------------------------------------------------------------------------------------|------------------------------------------------------------------------------------------|-------------------------------------------|
| `eod_missing`     | `eodSubmissions.find(s.storeId === storeId && s.date === todayISO)` is undefined.                                                             | `now > store.eodDeadlineTime` (HH:MM) → high; else med if today; low if missing yesterday too. | `<storeId>:eod:<dateISO>`                 |
| `low_out_stock`   | `inventory.filter(i => i.storeId === storeId).filter(getItemStatus(i) ∈ {'low','out'})`. Bucket by status.                                    | `out > 0` → high (text: "{n} items out of stock"); else `low > 5` → med; `1 ≤ low ≤ 5` → low. | `<storeId>:stock:<status>`                |
| `food_cost_streak`| `computeStoreFoodCostVariancePp(storeId, last 7 days)` — count consecutive trailing days where `pp >= 1`. Streak ≥ 3.                         | streak ≥ 5 → high; 3-4 → med.                                                            | `<storeId>:fc_streak:<streakLen>`         |
| `unconfirmed_po`  | **See blocker below** — `OrderSubmission` has no `confirmed` field. Falls back to: scheduled vendor in `orderSchedule[today's day]` with no matching `orderSubmissions[s].day === today.day && vendorName === ...` row, AND today > 3 days from the schedule entry. | Always med (no signal to escalate to high in Phase 1).                                  | `<storeId>:po:<vendorId>`                 |

**`unconfirmed_po` blocker (§0 finding).** The spec's A7 says
"Unconfirmed POs >3 days old" but `OrderSubmission` doesn't model PO
state — it only records that a staff member submitted an order. Two
options:

  - **Option A (recommended): redefine the rule** to "vendors scheduled
    on `orderSchedule[<today-N>]` with no matching submission" — i.e.
    "we missed placing the order for that day". Detectable from existing
    data (`orderSubmissions` matches by `day` + `vendorName`).
  - Option B: drop the unconfirmed_po rule entirely from Phase 1 and
    note in the inline `// TODO` that a `purchase_orders` schema spec is
    needed to support it as written.

  **Decision D6: pick Option A.** Same operator value (catches missed
  orders), uses existing data, doesn't require schema work. Document the
  semantic shift in the rule's inline comment so it's not mistaken for
  a literal "PO not yet confirmed" check when the schema lands later.

**Empty state.** When the queue is empty, the renderer shows a single
`✓ all clear` row — handled in the JSX, not the selector. Selector
returns `[]`.

**Count badge color (A8).** `q.length === 0` → `C.ok`;
`q.some(x => x.sev === 'high')` → `C.danger`; else `C.warn`. Encoded
in the `<StoreCol>` renderer, not the selector.

### §8 Test strategy

No test framework exists (CLAUDE.md "Gaps and unknowns"). The new
selectors in §2 are pure functions and would be the single highest-
value place in the codebase to introduce vitest, BUT introducing it is
out of scope for this spec.

**Recommendation for test-engineer reviewer:** treat this spec as
visual-acceptance only. File a separate "introduce vitest, test the
cmdSelectors module first" spec — that's a load-bearing decision the
PM should weigh, not the architect. The selectors are designed to be
unit-testable when the runner lands (pure inputs, no Zustand reach-in,
deterministic via injected `now?: Date`).

### §9 Verification probes (post-impl, manual browser walk)

Local dev stack: `npm run dev:db` then `npm run web`, login
`admin@local.test` / `password`. Switch to All Stores via the store
switcher.

  1. Dashboard renders without runtime errors (TS strict + browser console clean).
  2. KPI strip shows 5 tiles, each with sparkline, value, sub-text,
     delta pill.
  3. CoGS card: theoretical $ and actual $ both render numeric (not
     `NaN` or `$0` if any POS data exists for the period). Δ row shows
     signed $ + % with correct tone color (red if actual > theoretical).
  4. Top-5 variance items list: 5 rows max, sorted by |Δ$|, each row
     has name + store name + reason + signed Δ$ in tone color.
  5. Heatmap renders 4 rows × 7 cells. Cells show `+0.5` / `−0.3` /
     etc. format, color-graded per the table in §4.
  6. Per-store grid: one card per visible store, count badge color
     follows A8 rule.
  7. Attention queue: each card shows queue items with severity badge
     (H/M/L) on the left; empty store shows "✓ all clear" row.
  8. Reconciliation Section opens to its variance.tsx tab and renders
     identical rows to the pre-refactor version (regression check on
     §2 extraction).
  9. Type-check: `npx tsc --noEmit` passes.

### §10 Risks and out-of-scope leakage flags

  - **R1: Sparkline data is synthetic for 4 of 5 tiles.** Operators
    seeing a downward-trending sparkline on "STOCK ALERTS" might infer
    real-world progress that doesn't exist. Mitigation: code comment
    `SYNTHETIC_KPI_SERIES` and the spec's Out of scope section.
    Severity: low (visual decoration; the headline number is real).
  - **R2: Heatmap target food-cost is hard-coded to 30%.** Per-store
    target config doesn't exist in the schema today. Adding it touches
    `Store` schema + a settings UI. Mitigation: Decision D3 hard-codes
    30% with an in-component constant `TARGET_FOOD_COST_PCT`. File a
    follow-up spec for per-store target config when the operator team
    asks for it.
  - **R3: Reconciliation refactor regression.** Extracting
    `computeVarianceLines` from `ReconciliationSection.rows` could
    silently change row output if my translation drifts from the
    inline math. Mitigation: probe #8 in §9. Stronger mitigation: the
    backend-developer should temporarily render BOTH inline-rows and
    selector-rows side-by-side in a debug fixture, compare, then
    delete inline. Don't ship without a manual diff.
  - **R4: Cross-store fetch happens on mount, not on realtime updates.**
    Per Decision D2(b), the Dashboard fetches cross-store EOD/POS once
    at mount. New EODs submitted by another admin after the dashboard
    opens won't appear until refresh. Mitigation: documented in code;
    promote to subscribed-to-all-store-channels if user complains.
    Severity: low (admin sessions are short, refresh is cheap).
  - **R5: `unconfirmed_po` rule semantic shift.** Per Decision D6,
    we're calling "missed scheduled orders" "unconfirmed POs". This is
    OK as a Phase 1 placeholder but the eventual `purchase_orders`
    schema (Spec 010+) will need to deprecate this rule and replace
    with the literal check. Document the placeholder in code.
  - **R6: 286KB seed dataset.** All selectors are O(N · M) over inventory
    × eodSubmissions worst case. The Reconciliation screen already runs
    similar math against the same dataset without complaint, so this
    should be safe — but if profiling shows hitches on the Dashboard,
    memoize aggressively (the hooks in §2 already wrap in `useMemo`).
  - **R7: Edge-runtime cold start.** N/A — no edge functions touched.

### §11 Architect-level open flags (Decisions resolved)

  - **D1. Heatmap deep-amber tone:** collapse to `C.warn` with two
    different opacity levels (0.85 vs 0.65). Avoids adding a new
    palette token. **Resolved.**
  - **D2. Cross-store data loading:** add
    `db.fetchEodSubmissionsForStores` + `db.fetchPosImportsForStores`
    helpers, called from a Dashboard mount effect, results held in
    component-local state. Don't mutate `useStore.loadFromSupabase`'s
    `__all__` branch. **Resolved.**
  - **D3. Target food-cost:** hard-code 30% as
    `TARGET_FOOD_COST_PCT = 30` constant inside DashboardSection.
    File a follow-up "per-store food-cost target config" spec when
    needed. **Resolved.**
  - **D4. Tab strip:** ship `overview.tsx` only. Don't stub the other
    two tabs. **Resolved.**
  - **D5. Sparkline series:** synthetic for 4 of 5 KPIs; the food-cost
    sparkline uses the real v1 14-day trend. **Resolved.**
  - **D6. `unconfirmed_po` rule:** rule means "scheduled vendor with
    no matching `orderSubmissions` row for the day, > 3 days old".
    Document the placeholder semantics. **Resolved.**
  - **D7. Sparkline / Heatmap dependency:** use `react-native-svg`
    directly (already a direct dep). Don't wrap in `react-native-chart-kit`
    — the kit's API is overkill for a 30-LOC polyline and a `View` grid.
    **Resolved.**

### §12 File summary (deliverables)

New files:

- `src/components/cmd/Sparkline.tsx` — ~40 LOC, pure SVG.
- `src/components/cmd/Heatmap.tsx` — ~80 LOC, View grid.

Modified files:

- `src/lib/cmdSelectors.ts` — add 5 pure functions + 4 hook wrappers
  (§2). Keep existing exports unchanged.
- `src/lib/db.ts` — add `fetchEodSubmissionsForStores` and
  `fetchPosImportsForStores` (§5 D2).
- `src/screens/cmd/sections/DashboardSection.tsx` — full rewrite
  (~300-400 LOC), v1 deleted (Q6 lock).
- `src/screens/cmd/sections/ReconciliationSection.tsx` — replace
  `rows` memo body with a call to `computeVarianceLines(...)` then
  the existing `.sort(...)`. Zero behavior change. (~5 LOC delta.)

No migrations, no edge function changes, no `supabase/config.toml`
edits. Realtime publication unchanged.

## Dependencies

- Existing `useStore` selectors: `inventory`, `eodSubmissions`,
  `auditLog`, `currentStore`, `getItemStatus`, `wasteLog`, plus
  `orderSubmissions` (or equivalent for unconfirmed-PO check — architect
  to confirm).
- Existing variance math in `ReconciliationSection.tsx` (to be extracted
  per A4).
- Existing Cmd atoms: `StatCard`, `SectionCaption`, `StatusPill`,
  `StatusDot`, `TabStrip`, `useCmdColors`, `mono`/`sans`/`Type`.
- `react-native-svg` (already a transitive dep via `react-native-chart-kit`;
  architect to confirm direct dep is not needed).
- Per-store data visibility via existing `auth_can_see_store()` RLS
  (no new policy work).

## Project-specific notes

- **Cmd UI section / legacy:** Cmd UI only.
  `src/screens/cmd/sections/DashboardSection.tsx`. Legacy
  `AdminScreens.tsx` not touched.
- **Per-store or admin-global:** Admin-global view (rolls up across all
  stores the admin can see) — but every per-store column respects
  `auth_can_see_store()` because the store list comes from
  `useStore.stores`, which is already RLS-filtered.
- **Realtime channels touched:** None new. The dashboard re-renders on
  the existing `store-{id}` and `brand-{id}` debounced reload (400 ms,
  [src/hooks/useRealtimeSync.ts](../src/hooks/useRealtimeSync.ts)) wired
  from CmdNavigator.
- **Migrations needed:** No (Phase 1, client-derived only).
- **Edge functions touched:** None (Phase 1; deferred to follow-up spec
  per Q4b).
- **Web/native scope:** Web-only (assuming Q7). The Cmd UI shell only
  renders above the 1100 px breakpoint; v1 already follows this rule.
- **Tests:** No test framework wired up yet. Per CLAUDE.md "Gaps and
  unknowns": flag for the test-engineer reviewer to decide whether to
  introduce a framework here or treat this as visual-acceptance only.
- **Conventions to honor:**
  - Hydrator-vs-setter separation (spec 008 precedent) — N/A for this
    spec since no new Zustand actions land.
  - Pre-mutation per-prep assertion ordering (spec 003 precedent) — N/A,
    no mutations.
  - Optimistic-then-revert + `notifyBackendError` — N/A, read-only screen.
  - All DB access via `src/lib/db.ts` — already enforced; no new DB calls.
  - "No dupes / utilize existing" — A4 explicitly extracts shared
    variance math instead of copying.

## Open questions (PENDING USER ANSWER)

The 4 v2 additions are independent in scope. Each gets a separate yes/no +
phase-1-vs-defer. Acceptance criteria above assume the PM lean for each.

### Q1 — Sparklines on KPI tiles

(a) Ship in v2 — synthesize 7–14 point series from existing data
    (food-cost trend already exists; inventory/waste/EOD/alerts derived
    from current store data + last-N-days reduction).
(b) Skip for v1; ship v2 without sparklines.

**PM lean:** (a). Sparklines are the smallest-data feature and the
synthetic series degrades gracefully (a flat line if there's only one data
point). Adds visual richness with low backend risk.

### Q2 — CoGS variance card (theoretical vs actual + top-5)

(a) Ship in v2 — depletion math already exists in Reconciliation;
    refactor to feed the card.
(b) Skip; defer to spec 010.

**PM lean:** (a). High-leverage; reuses existing computation; smallest
delta on backend (just an extraction + a new card layout).

### Q3 — Variance heatmap (4 stores × 7 days)

(a) Ship — needs daily food-cost variance per store. Same data sources
    as Q1 + Q2.
(b) Skip.

**PM lean:** (a). Closely related to Q2's data side; the visual primitive
(`<Heatmap />`) is small.

### Q4 — Attention queue per store

#### Q4a — In-scope alert types for v2

(a) Only alert types we have data for today: EOD missing, low/out stock,
    unconfirmed POs, food-cost streaks.
(b) (a) + add expiry tracking. Needs `expires_at` column on inventory +
    UI for setting it. (`InventoryItem.expiryDate` already exists in the
    type; backing column status TBD by architect — may already be present.)
(c) (a) + (b) + add invoice matching. Needs new `invoices` table +
    matching workflow.
(d) (a) + (b) + (c) + temp logging. Needs new `temperature_logs` table +
    UI for entry.

**PM lean:** (a) for v2. File (b)/(c)/(d) as separate downstream specs
each with their own data-modeling work. Rationale: Phase 1 should not
block on schema additions.

#### Q4b — Server-computed vs client-derived

(a) Client-derived for v1 (no new edge function; alert logic lives in a
    selector).
(b) Single `/stores/:id/attention` edge function (or RPC) computed
    server-side.

**PM lean:** (a) client-derived for v1; promote to server-side once the
alert set stabilizes. Rationale: faster ship, avoids verifying JWT-vs-
service-token edge-fn auth model for a first pass, and the data is
already in-memory client-side.

### Q5 — Translation strategy (raw React/DOM → React Native + RNW)

(a) Hand-translate every primitive, reuse existing Cmd UI atoms
    (StatCard, SectionCaption, StatusPill).
(b) For the visual-only pieces (sparklines, heatmap) write thin RN
    primitives matching the handoff design tokens; let the rest fall back
    to existing v1 layout where possible.

**PM lean:** (a). RN/RNW is the project's commitment; new components are
RN primitives, and we reuse what exists. (b) leaves the dashboard
visually inconsistent with the rest of the Cmd UI.

### Q6 — Replace v1 entirely vs feature-flag side-by-side

(a) v2 fully replaces `DashboardSection.tsx` once shipped. v1 is deleted.
(b) v1 stays as fallback under a feature flag; user toggles.

**PM lean:** (a). The existing UI is small (328 lines), Cmd UI is
already the active development target, and a single source of truth is
cleaner. Feature-flagging adds maintenance burden for unclear benefit.

### Q7 — Mobile native scope

(a) Web-only (same as v1; Cmd UI only renders above 1100 px).
(b) Add a native variant.

**PM lean:** (a) web-only.

### Q8 — Phasing

(a) **Phase 1 ship (this spec):** visual layer + sparklines + heatmap +
    CoGS card + attention queue (alert types we already have data for).
(b) **Phase 2 (separate spec, file as 010):** expand attention queue
    alert types as data sources land — expiry tracking, invoice matching,
    temp logging — each its own spec; promote attention queue to a
    server-computed endpoint once alert set stabilizes.

**PM lean:** (a) for this spec; user can decide later whether to file
the 010 placeholder pre-emptively.

## Handoff zip — commit to repo or leave on disk?

The handoff zip is currently at `/tmp/handoff-inspect/dashboard_v2_handoff/`.
Spec 005 set the precedent of committing reference docs to
`docs/internal/`. The user can decide whether to copy this handoff there
for posterity, or leave it as a transient reference. Not blocking; surfacing
for awareness.

## Build notes

### Backend pass

Backend-developer, 2026-05-06. Implemented the §2 selectors and §5/D2
fetch helpers per architect's design. Frontend-developer's parallel
pass owns the UI rewrite and the trailing-edge Reconciliation refactor
(both gated on the selector signatures landing).

**§2 selectors added to `src/lib/cmdSelectors.ts`** (all exported):

- Types: `VarianceLine`, `VarianceMode`, `AttentionItem`,
  `TARGET_FOOD_COST_PCT_DEFAULT` constant.
- Pure functions:
  - `computeVarianceLines(storeId, inventory, eodSubmissions, stores, mode='priorEod')` —
    extracts the Reconciliation `rows` memo math; supports both
    `priorEod` (variance.tsx) and `parLevel` (timeline.tsx /
    byCategory.tsx) modes via the architect's `VarianceMode` enum.
    Reason field is added per architect's classification heuristic
    (encapsulated in a private `classifyVarianceReason` helper so a
    future rewrite has a single touch point). Frontend-dev's
    Reconciliation refactor maps `dollar` → `deltaCost` and ignores the
    `reason` field — backwards-compatible per architect's risk note.
  - `computeCogsTheoretical(storeId, startDate, endDate, posImports, recipes, inventory)` —
    POS qty × recipe ingredient quantity × per-store costPerUnit.
    Resolves recipe ingredient `itemId` (catalog id) → inventory
    `catalogId` for the per-store cost lookup, matching the post-Phase-3
    catalog refactor. Skips sale items where `recipeMapped === false`.
  - `computeCogsActual(storeId, startDate, endDate, inventory, eodSubmissions)` —
    sums `(priorEod - currentEod) × cost` across EOD-vs-prior-EOD pairs
    in the range. Walks back outside the range when the prior is
    earlier (mirrors `ReconciliationSection.previous` lookup). Negative
    values are returned as-is per architect's "don't clamp" rule.
  - `computeTopVarianceItems(storeId, startDate, endDate, inventory, eodSubmissions, stores, limit=5)` —
    aggregates per-itemId across the date range, sorts by
    `|deltaCost|` desc, returns top N. Uses the same priorEod
    definition as `computeCogsActual` so dollars roll up cleanly.
  - `computeStoreFoodCostVariancePp(storeId, startDate, endDate, inventory, eodSubmissions, posImports, target=30)` —
    per-day pp delta from `target` (default 30 per Decision D3, exposed
    as `TARGET_FOOD_COST_PCT_DEFAULT` constant for callers). Falls back
    to the v1 `entries.length % 5 + 30` proxy when POS revenue is 0,
    so the heatmap stays painted; documented inline as a Phase 1 stop-gap.
  - `computeAttentionQueue(storeId, inventory, eodSubmissions, posImports, orderSubmissions, orderSchedule, stores, getItemStatus, now=new Date())` —
    full §7 ladder. Stable per-render ids per architect's spec
    (`<storeId>:<rule>:<scope>` format). Severity sort then alphabetic
    `text` for stable cross-render ordering. Empty-state row handled
    in the renderer per architect's note ("[] from selector, ✓ all
    clear text in JSX").
- Hook wrappers (Zustand-bound):
  - `useStoreFoodCostHeatmap(days=7)` — per-store rows with `values:
    number[]` (oldest → newest). Reflects what's in `useStore.stores`
    + `useStore.eodSubmissions`. **Limitation:** `__all__` mode's
    eodSubmissions / posImports slice is partial (only the focal
    store's data), so this hook only paints one row of real data.
    Dashboard's mount effect must call the §5/D2 helpers below and
    pass the cross-store data directly to `computeStoreFoodCostVariancePp`
    for non-focal rows. Documented in the hook's leading block comment.
  - `useTopVarianceItems(days=7, limit=5)` — current store, trailing
    window. Pure focal-store scope so the slice limitation above
    doesn't bite.
  - `useCogsForCurrentStore(days=7)` — `{ theoretical, actual, delta,
    pct }` for the focal store. `pct` is signed; collapses to 0 when
    `theoretical === 0` (renderer should show "—" in that case).
  - `useAttentionQueueByStore()` — `Record<storeId, AttentionItem[]>`.
    Same focal-store-data caveat for non-focal stores' food-cost-streak
    rule (other rules — eod_missing, low_out_stock, unconfirmed_po —
    use slices that ARE cross-store-aware in `__all__` mode:
    inventory, orderSubmissions, orderSchedule).

**§5/D2 fetch helpers added to `src/lib/db.ts`**:

- `fetchEodSubmissionsForStores(storeIds: string[], sinceDate: string): Promise<EODSubmission[]>` —
  single `IN(...)` select; mirrors the snake_case → camelCase mapper
  shape from `fetchRecentEODSubmissions` so downstream selectors are
  drop-in interchangeable. RLS via `auth_can_see_store()` silently
  drops unauthorized rows (no client-side pre-filter needed).
- `fetchPosImportsForStores(storeIds: string[], sinceDate: string): Promise<POSImport[]>` —
  single round trip joining `pos_import_items`. Returns the camelCase
  `POSImport` shape matching `useStore.posImports` semantics.
  **Note:** there was no pre-existing single-store `fetchPosImports`
  helper to mirror — the architect's spec said "match the existing
  fetchPosImports(storeId) snake_case → camelCase mapper patterns",
  but no such helper exists in `db.ts` (only `savePOSImport` /
  `hasPOSImportForDate`). Built the new mapper from scratch using the
  `POSImport` type as the contract; sibling pos_imports queries (e.g.
  the unmapped-items lookup at db.ts:1337) follow the same schema so
  the mapper is consistent with existing call sites.

**STOP conditions evaluated during build:**

- `cmdSelectors.ts` does exist (255 LOC pre-build, 5 selectors + 4
  hooks added). No STOP triggered.
- Reconciliation refactor is FRONTEND-dev's per the prompt; my
  selector signatures are landed and the diff for ReconciliationSection
  should compile against `computeVarianceLines(currentStore.id,
  inventory, eodSubmissions, stores, 'priorEod')`. The architect's
  field-mapping note (`dollar` → `deltaCost`, `pct` derived from
  `(delta / expected) * 100`) is honored in `VarianceLine`'s shape.
- `OrderSubmission` has no `confirmed`/`status` field per architect's
  §0 finding; `computeAttentionQueue` implements Decision D6
  ("scheduled vendor with no matching submission, > 3 days old")
  using `orderSchedule[dayName]` × `orderSubmissions` cross-reference.
  Documented in the function's inline comment.

**Boundary clarifications (none required architect re-design):**

- Rule fired in `__all__` mode for the food_cost_streak alert
  per-non-focal-store will show 0-pp days (the proxy fallback won't
  trigger because the EOD itself is missing from the slice in
  `__all__` mode). This is consistent with the §5/D2(b) decision to
  hold cross-store data in component-local state — frontend-dev's
  Dashboard mount effect can pass cross-store EODs/POSs directly to
  `computeAttentionQueue` for the per-store grid if accuracy matters
  more than ergonomics, OR accept the focal-store-only signal and
  document the limitation. Not blocking.
- No new Zustand actions / no DB writes introduced (read-only spec).
- `TARGET_FOOD_COST_PCT_DEFAULT = 30` is exported as a named constant
  so the Dashboard component can reference it from the same source as
  the selector default — avoids the architect's "hard-code 30 in two
  places" footgun.

**Type-check:** `npx tsc --noEmit` shows zero errors in
`src/lib/cmdSelectors.ts` or `src/lib/db.ts`. Pre-existing errors
elsewhere (legacy AdminScreens, IngredientsScreen, edge functions
Deno paths) are unrelated.

**Runtime smoke:** local stack already running
(`supabase_*_imr-inventory` containers up), schema verified for
`pos_imports`, `pos_import_items`, `eod_submissions` — all column
names and JOIN aliases used in the new helpers match the live tables.
No new code paths are wired into a screen yet (frontend-dev's
trailing-edge work), so no UI smoke test possible from this slice.

## Files changed

### Backend slice

- `src/lib/cmdSelectors.ts` — added §2 selectors:
  - Types: `VarianceLine`, `VarianceMode`, `AttentionItem`,
    `TARGET_FOOD_COST_PCT_DEFAULT` constant.
  - Pure functions: `computeVarianceLines`, `computeCogsTheoretical`,
    `computeCogsActual`, `computeTopVarianceItems`,
    `computeStoreFoodCostVariancePp`, `computeAttentionQueue`.
  - Hook wrappers: `useStoreFoodCostHeatmap`, `useTopVarianceItems`,
    `useCogsForCurrentStore`, `useAttentionQueueByStore`.
  - Helper (private): `classifyVarianceReason`, `isPastDeadline`.
  - Imports extended: `Store`, `OrderSubmission`, `OrderSchedule`,
    `ItemStatus`.
- `src/lib/db.ts` — added §5/D2 cross-store fetch helpers:
  - `fetchEodSubmissionsForStores(storeIds, sinceDate)`.
  - `fetchPosImportsForStores(storeIds, sinceDate)`.
  - Imports extended: `POSImport`.

### Frontend pass

Frontend-developer, 2026-05-06. Implemented §3 (Sparkline), §4 (Heatmap),
§5 (DashboardSection full rewrite), and the §2 trailing-edge
Reconciliation refactor. Backend-developer's selectors + db helpers
landed during this pass (parallel slot); my imports resolve cleanly.

**§3 — `src/components/cmd/Sparkline.tsx` (NEW, ~50 LOC).** Pure SVG
via `react-native-svg` (already a direct dep). Polyline + optional 12%
opacity area fill. Handles empty / single-point input as an empty
`<Svg>` of the requested size — never throws, per architect's spec.
No theming hook (color comes in as a prop), no platform branch (SVG is
RNW-clean).

**§4 — `src/components/cmd/Heatmap.tsx` (NEW, ~140 LOC).** View-grid
(no SVG) per architect's §4 — matches the `ReconTimelineTab` 90-day
grid pattern. Header row of day labels + one row per `HeatmapRow`
(label cell width 72 + N flex:1 value cells, 3-px gaps). Cell painter
follows architect's table exactly (Decision D1 — collapse deep amber
to `C.warn` at 0.85 vs 0.65 opacity; no new palette token added).
Inline comment documents the deviation.

**§5 — `src/screens/cmd/sections/DashboardSection.tsx` (REWRITE,
~600 LOC).** v1 deleted in place per Q6 lock. Single tab
(`overview.tsx`) per Decision D4 — no stub `by_store` / `variance`
tabs.
- KPI strip: 5 tiles via local `<Kpi>` sub-component, each with
  inline `<Sparkline />` to the right of value. AVG FOOD COST sparkline
  uses the real v1 14-day food-cost trend; the other four use
  `synthSeries(current, seed)` tagged `SYNTHETIC_KPI_SERIES` per
  Decision D5 + R1 mitigation. Stable seed = `${storeId}:${kpi}` so
  lines don't reshuffle on render.
- CoGS card: feeds from `useCogsForCurrentStore(7)` (theoretical /
  actual / Δ / pct) plus `useTopVarianceItems(7, 5)` for the top-5
  list. Local `<CogsCard>` + `<CogsStat>` sub-components.
- Heatmap: calls `computeStoreFoodCostVariancePp` (pure function, not
  the hook) once per store using component-local cross-store EOD/POS
  state, so non-focal stores paint real data instead of zeros. Hard-
  codes `TARGET_FOOD_COST_PCT = 30` per Decision D3, named for grep.
  Day labels derived from the actual weekday letters of the trailing
  7 days.
- Per-store grid: 4-up wrapping flex grid (`flexWrap: 'wrap'` +
  `flex: 1, minWidth: 240`). Per-store attention queues from
  `computeAttentionQueue` (pure function), again with cross-store
  EOD/POS passed explicitly so all rules fire correctly across all
  stores. Local `<StoreCol>` and `<Mini2>` sub-components encode A8's
  count-badge color rule and the empty-state ✓ all clear row.
- **Decision D2 wiring:** mount effect calls
  `db.fetchEodSubmissionsForStores(storeIds, todayMinus14d)` and
  `db.fetchPosImportsForStores(...)` once on mount + on
  `currentStore.id` change. Results held in `React.useState`. The
  focal-store slice from `useStore` is merged in over the cross-store
  cache so realtime updates land on the focal store's rows. R4 caveat
  documented inline (cross-store rows refresh on mount only).

**§2 trailing-edge — `ReconciliationSection.tsx` (~70 LOC delta).**
Replaced the inline `rows` memo with a call to
`computeVarianceLines(currentStore.id, inventory, eodSubmissions,
stores, 'priorEod')` + a mapping shim that translates
`VarianceLine.deltaCost` → screen-local `dollar` and derives `pct =
Math.round((delta / expected) * 100)`. The `latest` memo is preserved
for the screen's `Reconciliation · {date}` subtitle. **R3 mitigation:**
added a dev-only `useEffect` that recomputes the inline math one more
time and `console.log`s a diff against the selector output — fires only
in `__DEV__` builds and only when row count, order, or dollar values
diverge by > $0.01. Slated for removal in a follow-up commit after
manual visual diff confirms parity.

**Verification.**
- `npx tsc --noEmit` — zero errors in any file I touched
  (`Sparkline.tsx`, `Heatmap.tsx`, `DashboardSection.tsx`,
  `ReconciliationSection.tsx`). Project total dropped from baseline
  ~149 to 119 (no new errors introduced; backend-dev's clean pass and
  my rewrites removed several pre-existing ones in
  `DashboardSection.tsx`).
- **Web bundle compile probe:** ran the running dev server's web
  bundle URL (`http://localhost:8082/node_modules/expo/AppEntry.bundle?...`)
  → HTTP 200, 11.84 MB output. Grep'd the bundle for my new exports
  (`Sparkline`, `Heatmap`, `HeatmapLegend`) and backend-dev's
  (`computeStoreFoodCostVariancePp`, `computeAttentionQueue`,
  `useStoreFoodCostHeatmap`, `fetchEodSubmissionsForStores`,
  `fetchPosImportsForStores`) — all present. No `Module build failed`
  / `SyntaxError` strings in the bundle output. Bundle compiles
  cleanly.
- **Browser verification gap:** my available toolset doesn't include
  the `preview_*` MCP tools called out in CLAUDE.md, so I couldn't
  exercise the UI directly (login → switch to All Stores → confirm
  KPI tiles / CoGS card / heatmap / per-store grid render). The
  bundle-compile probe confirms the code links cleanly and all
  imports resolve at module-graph level, but a browser-side render
  smoke test still needs to happen — flagging for the reviewers /
  user. Specific things to verify manually (per spec §9):
  1. KPI strip shows 5 tiles with sparklines (AVG FOOD COST shows real
     trend, others show synthetic ±8% bands).
  2. CoGS card's theoretical / actual / Δ render numeric (not NaN /
     `$0` if any POS data exists).
  3. Top-5 variance list shows store name + reason + signed Δ$ in
     tone color.
  4. Heatmap renders 4 rows × 7 cells with the threshold-graded
     colors per architect's §4 table.
  5. Per-store cards: count-badge color follows A8 (ok / warn /
     danger), empty store shows ✓ all clear.
  6. Reconciliation variance.tsx tab still renders identical rows to
     the pre-refactor version (R3 dev console probe will surface any
     divergence).

### Frontend slice

- `src/components/cmd/Sparkline.tsx` — NEW. Pure SVG polyline + optional
  area fill. ~50 LOC.
- `src/components/cmd/Heatmap.tsx` — NEW. View-grid rendering of
  per-row × per-day cells. Inline `cellPaint()` helper encodes the
  Decision D1 deep-amber collapse. ~140 LOC.
- `src/screens/cmd/sections/DashboardSection.tsx` — REWRITE. v1's
  KPI strip + chart + alerts + activity layout deleted in place
  (Q6 lock). New layout: 5-up KPI strip with sparklines, CoGS card +
  heatmap row, 4-up wrapping per-store grid with attention queues.
  Local sub-components (`<Kpi>`, `<CogsCard>`, `<CogsStat>`,
  `<HeatmapLegend>`, `<StoreCol>`, `<Mini2>`) match v1's "inline
  helpers in same file" pattern. Decision D2 wiring lives in the
  mount effect; D3's `TARGET_FOOD_COST_PCT = 30` is a named constant;
  D5's `synthSeries` is tagged `SYNTHETIC_KPI_SERIES` for
  greppability. ~600 LOC.
- `src/screens/cmd/sections/ReconciliationSection.tsx` — REFACTOR.
  Imports `computeVarianceLines` from cmdSelectors; `rows` memo body
  delegates to it and maps the result to the screen's existing
  `VarianceRow` shape. R3 dev-only `console.log` parity probe added
  (compares inline math against selector output, fires only on
  divergence in `__DEV__`). Net delta ~70 LOC; behavior unchanged.
