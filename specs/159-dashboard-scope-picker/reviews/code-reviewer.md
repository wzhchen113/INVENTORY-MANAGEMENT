# Code review for spec 159

Scope reviewed: `src/screens/cmd/sections/DashboardSection.tsx`, `src/lib/cmdSelectors.ts`,
`src/lib/db.ts` (`fetchWasteLogForStores`), `src/lib/storeVisibility.ts` (`brandNameFor`),
`src/i18n/{en,es,zh-CN}.json`, `e2e/dashboard-window.spec.ts`, and the three new/extended
test files (`DashboardSection.scopePicker.spec159.test.tsx`,
`cmdSelectors.scopedRollups.test.ts`, `db.crossStoreLoaders.test.ts` extension,
`storeVisibility.test.ts` extension).

I traced every consumer of `stores` / `scopedStores` / `visibleStores` in
`DashboardSection.tsx` by hand against the architect's §6.4 re-keying table rather than
trusting the "Files changed" summary, checked every new/changed `useMemo` dependency array,
and read the render-phase AC-P4 reset against the actual React "adjust state during
render" pattern. I did not find a missed consumer, a stale dependency array, or a
mixed-scope regression. This is a clean, faithful implementation of the spec.

## Critical

None found.

## Should-fix

- `src/screens/cmd/sections/DashboardSection.tsx:393-411` and `:446-453` — `wasteWeek` and
  `wasteEventCount` duplicate the identical five-line filter predicate byte-for-byte
  (`scopeIdSet.has(w.storeId)` + the new R-A `Number.isFinite(Date.parse(w.timestamp))`
  guard + the 7-day cutoff), one reducing to a sum and the other to a `.length`. This is new
  duplication introduced by this diff (the R-A guard didn't exist before spec 159), and it's
  exactly the kind of "two copies of one invariant" the R-A docblock itself warns about: if
  the locale-string/ISO asymmetry is ever fixed in one copy of the guard and not the other,
  WASTE/WK and the phone's waste KPI will silently diverge again. Extract a
  `wasteInWindow(allWaste, scopeIdSet, cutoffMs): WasteEntry[]` helper and have both memos
  call it (`.reduce(...)` / `.length` respectively).

## Nits

- `src/screens/cmd/sections/DashboardSection.tsx:125` — `DashboardScope` is exported
  (`export type DashboardScope = ...`) but has no consumer outside this file (confirmed via
  grep). Harmless, but an unnecessary public surface for a type the architect explicitly
  designed as component-local (D1/PM-2).
- `src/screens/cmd/sections/DashboardSection.tsx:879-888` — `ScopePickerProps.stores` is
  named `stores`, which reads as "the raw store slice" at the call site
  (`<ScopePicker stores={visibleStores} .../>`) even though it's always `visibleStores`. The
  JSDoc comment on the prop clarifies it, but `visibleStores` as the prop name would remove
  the need to read the comment.
- `src/lib/cmdSelectors.ts:1049-1070` (`computeScopedFoodCostSeries`) and `:1097-1117`
  (`computeScopedCogs`) — both single-store-identity short-circuits are correct and tested,
  but `computeScopedCogs` doesn't take the same `storeIds.length === 1` fast path that
  `computeScopedFoodCostSeries` does; it always loops-and-sums even for one store. This is
  provably safe (the docblock's own N×0.005 rounding-drift note bounds it to N=1 → zero
  drift) and it's already pinned by an AC-S6 identity test, so this is a style-only
  observation, not a correctness concern — flagging only because the asymmetry between the
  two functions' short-circuit strategy could look like an oversight on a future read.
- `src/screens/cmd/sections/DashboardSection.tsx:619-635` (`aggregateLabelFor`) is invoked
  twice per render in `all` mode with the same `list` argument (`allOptionLabel` from
  `visibleStores`, `heroScopeLabel` from `scopedStores`, which is the same array reference
  when `effectiveScope.mode === 'all'`). Cheap and intentional (different fallback keys per
  §9.1), not worth a memo, just noting it's not accidental duplication.

## What I checked and did not find a problem with

- **Consumer completeness (focus area 1).** Every entry in the architect's §6.4 table is
  re-keyed correctly: `totalInvValue` / `itemCount` / `lowOutAll` / `outCount` / `lowCount`
  / `outItems` all route through the single `scopedInventory` memo
  (`DashboardSection.tsx:376-379`); `storeCount`, `eodSubmittedToday`, `heatmapRows`,
  `queueByStore`, and the store-card grid all iterate `scopedStores`; `wasteWeek` /
  `wasteEventCount` read `allWaste` + `scopeIdSet`; `foodCostTrend14` / `cogs` /
  `topVariance` all take `scopeStoreIds`; all five `synthSeries` seeds use `scopeKey`. The
  picker options, the mount-effect id list, the heatmap/card iteration, and the `x/N`
  denominator all read `visibleStoresFor(...)` rather than the raw `stores` slice (AC-V1).
  `focalInventory`, `eodRows`, and `recentActivity` are deliberately left focal per the
  design notes and are not KPI surfaces. `StoreCol`'s per-card mini-stats filter `inventory`
  by the card's own `store.id`, which is correct regardless of scope (each card is always
  exactly its own store's numbers). I did not find a place still reading the raw `stores`
  slice for a rendering decision or a denominator.
- **Dependency arrays (focus area 2).** Checked every new/changed `useMemo` — `visibleStores`,
  `effectiveScope`, `scopedStores`, `scopeIdsKey`/`scopeStoreIds`/`scopeIdSet`,
  `visibleStoreIdsKey`, `scopedInventory`, `totalInvValue`, `wasteWeek`, `lowOutAll`,
  `eodSubmittedToday`, `outItems`, `wasteEventCount`, `foodCostTrend14`, `fcSeries`, `cogs`,
  `topVariance`, `heatmapRows`, `queueByStore` — against what each memo body actually reads.
  All are complete; none reference a value outside their dep list. `scopeStoreIds` deriving
  from `scopeIdsKey` (a joined string) rather than directly from `scopedStores` is a
  deliberate identity-stabilization trick, not a bug — it keeps `scopeStoreIds`/`scopeIdSet`
  referentially stable across renders where the store *set* hasn't changed even if the
  `stores` array reference rotates (this is exactly what the R-D performance note asks for).
- **Render-phase scope reset (focus area 3).** The AC-P4 reset
  (`DashboardSection.tsx:199-203`) is the React-documented "adjust state during rendering"
  pattern — comparing `seenStoreId` to `currentStore.id` and calling both setters
  unconditionally inside the render body when they differ. This bails out and re-renders
  synchronously before commit (no flash), cannot loop (the guard condition is false on the
  very next render), and is exercised by the AC-P4 jest case. It correctly handles the
  global-store-change case, including resetting out of `all` mode.
- **Duplication between scoped and per-store selectors (focus area 4).** None of the four
  new `cmdSelectors.ts` functions reimplement math — each loops the existing per-store pure
  function (`computeStoreFoodCostSeries`, `computeCogsTheoretical`/`computeCogsActual`,
  `computeTopVarianceItems`) and combines results (mean, sum, merge+re-rank). Single-element
  `storeIds` is pinned byte-identical to the pre-159 focal path by dedicated tests
  (AC-S4/S6/S7). The one duplication I did find is the DashboardSection-local waste-filter
  predicate noted above, which is a different layer than the cmdSelectors functions this
  focus area was primarily aimed at.
- **CLAUDE.md conventions (focus area 5).** `fetchWasteLogForStores` (`db.ts:843-875`) is
  the only new Supabase call and it lives in `db.ts`, follows the sibling cross-store-loader
  shape exactly (`useInflight.getState().track`, `.abortSignal(signal)`, narrow `select`, no
  embeds, empty-input short-circuit, `console.warn` + `[]` degrade, no toast — correctly
  citing that this spec adds zero writes so `notifyBackendError` doesn't apply). No
  `supabase.from`/`.rpc` calls appear outside `db.ts` in this diff. No inline hex/color
  literals in `DashboardSection.tsx` or the new `ScopePicker` — every color goes through
  `useCmdColors()`. No `window.*`/`Alert.alert`/raw `confirm()` calls introduced (no
  destructive actions in this spec). All six new i18n keys plus the one deleted key
  (`heroTitle`) are present/absent consistently across `en.json`, `es.json`, `zh-CN.json`
  with real (non-English-copy) translations; the parity test's set-equality assertion
  stays satisfiable. No new realtime channel or `supabase_realtime` publication touch. No
  migration, RPC, or edge function change — matches the "PostgREST read, no schema change"
  contract. `PhoneDashboard.tsx` and its acReg test are untouched, and `TabStrip.tsx` is
  untouched (the z-index fix lives in a wrapper `View` inside `DashboardSection`, as the
  design called for). `e2e/dashboard-window.spec.ts` correctly drives the new
  `dashboard-scope-picker` / `dashboard-scope-option-{storeId}` testIDs before asserting on
  the dedicated non-focal store's card (AC-R4); `e2e/dashboard.spec.ts` is untouched and
  still asserts only `dashboard-root`/`dashboard-kpis`, both unaffected by the default-scope
  change.

## Handoff
next_agent: NONE
prompt: Code review complete. 0 Critical, 1 Should-fix, 4 Nits. The implementation is a faithful, well-tested build of the spec's design; the one Should-fix is a small duplicated filter predicate (wasteWeek/wasteEventCount) that carries a drift risk on the new R-A locale-string guard, not a behavioral bug.
payload_paths:
  - specs/159-dashboard-scope-picker/reviews/code-reviewer.md
