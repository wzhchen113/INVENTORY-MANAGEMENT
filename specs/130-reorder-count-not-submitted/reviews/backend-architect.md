# Backend-architect drift review — Spec 130 (Reorder "Count not submitted yet")

Mode: post-implementation architectural drift review. Frontend-only spec; no
prod-apply. Reviewed the staged implementation against the `## Backend design`
section I authored in `specs/130-reorder-count-not-submitted.md`.

Verdict: **No Critical drift. Implementation matches the design.** One Minor
observation (a coherent-but-vestigial KPI sub-label consequence) worth PM
awareness. Details below.

## Confirmations requested

### (1) NO backend change — CONFIRMED

- No migration, RPC, edge-function, RLS, or realtime change for spec 130. The
  `20260721000000_ingredient_photos.sql` in `git status` belongs to spec 127,
  not this spec.
- `src/lib/db.ts` untouched: `mapReorderVendor` already carried both signal
  fields — `on_hand_source` → `onHandSource` and `eod_submitted_at` →
  `eodSubmittedAt` at `src/lib/db.ts:4027,4034-4035`. The branch keys off the
  existing camelCased payload fields exactly as designed.
- No `src/store/useStore.ts` slice change and no `useStaffStore` change — the
  new state is pure derived `useMemo` over the already-loaded
  `reorderPayload` / `payload`. Read-only screen, so no optimistic-then-revert /
  `notifyBackendError` path applies (matches design "Realtime / store" section).

### (2) Shared `isReorderCountNotSubmitted` predicate — CONFIRMED

- Lives in `src/utils/reorderDayFilter.ts:204-206`, exported alongside
  `computeReorderKpis` / `splitReorderVendorsByNeed`, body is
  `return vendor.eodSubmittedAt == null;` — the Q1 predicate (`== null`, not
  `=== null`, so absent/undefined also reads as uncounted).
- Imported and used by BOTH screens: admin `ReorderSection.tsx:25`, staff
  `Reorder.tsx:53`. No inline re-derivation of the predicate anywhere — mirrors
  the `vendorHasPo` centralization pattern the design cited.
- Predicate unit coverage present at `reorderDayFilter.test.ts:264-280`
  (null → true, undefined → true, ISO string → false).

### (3) Filter BEFORE split + KPI + export gate — CONFIRMED (both surfaces)

Admin (`ReorderSection.tsx:1192-1227`):
- `countedPrimary = primary.filter(!isReorderCountNotSubmitted)` and
  `notSubmittedPrimary = primary.filter(isReorderCountNotSubmitted)` computed
  BEFORE the split.
- `splitReorderVendorsByNeed(countedPrimary, …)` feeds both needs/enough; then
  `computeReorderKpis(needsOrderVendors)` — uncounted vendors reach neither.
- `showExport` gate now keys on `countedPrimary.length > 0`, so an
  uncounted-only view offers no export.

Staff (`Reorder.tsx:498-535`):
- `countedDisplay` / `notSubmittedDisplay` split off `displayVendors` before the
  needs/enough split, `computeReorderKpis`, `exportPayload`
  (`vendors: countedDisplay`), and `showExport` (`countedDisplay.length > 0`).

This delivers the design's stated goal: no KPI/est-cost inflation from the
stale `on_hand=0 → order N` lines, and no needs/enough double-render.

Dedicated top group with no dollar total — CONFIRMED: admin group header is
`{countNotSubmittedGroupTitle} · {count}` (`ReorderSection.tsx:1459-1471`,
rendered ABOVE the needs section); staff renders the group title above
needs/enough (`Reorder.tsx:808-820`). Count only, no `formatMoney` on either
group header.

### (4) Not-submitted VendorCard: header kept, item rows replaced, four actions hidden — CONFIRMED (admin + staff)

- Admin `VendorCard` self-branches on `isReorderCountNotSubmitted(vendor)` FIRST
  (`ReorderSection.tsx:513-566`) and returns before the column strip / item
  rows / footer. Because `CreatePoButton`, `ReorderQuickOrderButton`, and
  `ReorderVendorExportButtons` all live in that omitted footer, the four
  testIDs (`reorder-create-po-*`, `reorder-quick-order-*`,
  `reorder-export-csv-*`, `reorder-export-pdf-*`) never render. Header retains
  name + source/schedule badges + next-delivery line. State block testID
  `reorder-count-not-submitted-${vendorId}`.
- Staff `VendorCard` branch (`Reorder.tsx:175-211`) keeps header (name + source
  badge + `reorder.vendor.nextDelivery`), drops item rows + the item-count
  footer, renders state block `staff-reorder-count-not-submitted-${vendorId}`.
  Staff has no per-vendor order/export buttons (global export gated on
  `countedDisplay`), consistent with the design's Q3 note.
- Because the branch is INSIDE `VendorCard`, an uncounted no-schedule vendor
  also renders correctly as the not-submitted card inside the collapsed
  no-schedule group — the design's accepted-for-v1 edge (Risks §). Matches.

### (5) `computeReorderKpis` stays pure/unchanged — CONFIRMED

- `reorderDayFilter.ts:208-228` — function body is byte-identical to prior; no
  parameter or logic change. It is simply fed the counted needs-order set. Still
  reused by `narrowReorderToVendor` (`ReorderSection.tsx:91`) for per-vendor
  export. No new pattern introduced.

### i18n — CONFIRMED

- Admin `section.reorder.countNotSubmittedGroupTitle` / `…Title` / `…Body`
  present in all three locale files (`src/i18n/en.json:1024-1026`, `es.json`,
  `zh-CN.json`).
- Staff nested `reorder.countNotSubmitted.groupTitle` / `.title` / `.body`
  present in all three staff locale files (`src/screens/staff/i18n/en.json:167-171`,
  `es.json`, `zh-CN.json`). Routed through `useI18n()` `t` (staff) and `useT()`
  (admin) as designed.

## Findings

### Minor 1 — "stock fallback" KPI sub-count is now structurally ~always 0

Because uncounted vendors are pulled out before `computeReorderKpis`, and the
predicate `eodSubmittedAt == null` is equivalent to `onHandSource === 'stock'`
per the payload-contract invariant, the counted needs-order set fed to
`computeReorderKpis` contains only `onHandSource === 'eod'` vendors. Consequently
`kpis.stockFallbackVendorCount` is now effectively always 0 and
`kpis.eodSourcedVendorCount` equals `kpis.vendorCount`.

This surfaces in:
- Admin "On-hand source" StatCard sub-label `${stockFallbackVendorCount} stock
  fallback` (`ReorderSection.tsx:1310-1314`) — now near-always "0 stock fallback".
- Staff "source" KpiCard `reorder.kpi.sourceSub` (`Reorder.tsx:647-651`) — same.

This is a *coherent consequence* of the design (Q4 explicitly fed
`computeReorderKpis` the counted set), not contract drift — the stock-fallback
population now lives in the dedicated "Count not submitted" group instead of the
KPI strip. But it makes that KPI sub-label vestigial. Surfacing for PM decision:
either drop the now-always-zero sub-count, or repurpose it to show the
not-submitted vendor count. No code change required for correctness; flagging so
a reviewer doesn't read the always-zero sub-label as a regression.

### Minor 2 — dead `showExport` prop on the not-submitted admin card (cosmetic)

The admin not-submitted group passes `showExport={showExport}` into `VendorCard`
(`ReorderSection.tsx:1468`), but the not-submitted branch returns before the
footer that consumes it. Harmless (no behavioral effect), but the prop is dead
on that path. Leave as-is or drop for tidiness; not worth a redo.

## Test coverage sanity

- Admin `ReorderSection.spec130.test.tsx` asserts (a) the state block +
  group header render, (b) all four action testIDs ABSENT for the uncounted
  vendor, (c) a counted vendor renders all four actions, and (d) the
  `Items` / `Est. total` / `Vendors` StatCards exclude the uncounted vendor's
  stale 2 items / $20 (reads 1 / $10.00 / 1). This directly pins Minor 1's
  filtering behavior and the design's KPI-exclusion claim.
- Staff `Reorder.test.tsx` and the shared `reorderDayFilter.test.ts` predicate
  cases round out the coverage named in the design's Jest surface.

Note (carried from the dev's own verification note, not a new finding):
live-browser verification of the seeded uncounted-vendor data condition was not
performed; the jest suites render the real screens and pin the branch instead.
Acceptable for a pure render/derived-state change, but a manual pass against a
store with a genuinely missing EOD for the selected date would close the loop.

## Handoff
next_agent: NONE
prompt: Architectural drift review complete. No Critical drift — implementation
  matches the design on all five confirmation points (no backend change; shared
  predicate; filter-before-split/KPI/export; header-kept/rows-replaced/actions-
  hidden on both surfaces; computeReorderKpis pure). 2 Minor findings: (1) the
  "stock fallback" KPI sub-count is now structurally ~always 0 as a coherent
  consequence of feeding computeReorderKpis the counted set — PM to decide
  whether to drop/repurpose the sub-label; (2) a cosmetic dead showExport prop
  on the admin not-submitted card.
payload_paths:
  - specs/130-reorder-count-not-submitted/reviews/backend-architect.md
