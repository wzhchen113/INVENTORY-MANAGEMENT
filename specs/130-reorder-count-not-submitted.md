# Spec 130: Reorder — suppress order lines for vendors whose EOD count is not submitted

Status: READY_FOR_REVIEW

## Problem

On both reorder screens — admin Cmd (`src/screens/cmd/sections/ReorderSection.tsx`)
and staff (`src/screens/staff/screens/Reorder.tsx`) — a vendor whose end-of-day
(EOD) count was NOT submitted for the reorder date still renders full item/order
lines. Those lines are computed off a `current_stock` fallback (stale/zero
on-hand), so the suggested order quantities are wrong (typically every item reads
"on hand: 0 → order N"). Today the only cue is a subtle "STOCK FALLBACK" badge,
which managers and staff can miss — leading to orders placed off bad numbers.

## User story

As a store manager (admin Cmd) or a staff member (staff app) opening the reorder
screen for a given date, I want a vendor whose EOD count was not submitted for
that date to clearly show "Count not submitted yet" instead of order quantities,
so that I do not accidentally order off stale on-hand numbers.

## Acceptance criteria

- [ ] On the admin Cmd reorder screen, a vendor with no submitted EOD count for
  the reorder date (`eodSubmittedAt == null`, equivalently `onHandSource ===
  'stock'`) renders a card with its header (vendor name + next-delivery line) and
  a clear "Count not submitted yet" message in place of the per-item breakdown /
  order rows. No `on hand → order` quantities are rendered for that vendor.
- [ ] On the staff reorder screen, the same vendor renders the same
  "Count not submitted yet" state (header + message, no item/order rows).
- [ ] A vendor WITH a submitted EOD count for the date (`eodSubmittedAt != null`
  / `onHandSource === 'eod'`) renders its per-item breakdown and order lines
  exactly as today — no visual or behavioral change.
- [ ] The "count not submitted" treatment keys off the per-vendor signal already
  present in the `report_reorder_list` payload; no change to the reorder math and
  no change to the existing EOD-vs-stock detection.
- [ ] The "Count not submitted yet" message text is routed through the existing
  i18n catalogs on both surfaces (admin `src/i18n/*.json`, staff
  `src/screens/staff/i18n/*.json`), consistent with how "STOCK FALLBACK" is
  already localized (`reorderExport.sourceStock`, `reorder.source.stockFallback`).
- [ ] Per-vendor order actions on a "count not submitted" vendor behave per the
  architect's resolution of open question Q2 (recommended: disabled/hidden — see
  Open questions).
- [ ] Top-level reorder KPIs and the NEEDS-TO-ORDER / HAVE-ENOUGH split handle
  the un-counted vendor per the architect's resolution of open question Q3
  (recommended: card stays visible but its suppressed lines do not inflate item /
  est-cost KPIs).
- [ ] Jest coverage on both surfaces asserts: (a) an un-counted vendor renders the
  message and renders NO order-quantity rows, and (b) a counted vendor is
  unchanged.

## In scope

- Frontend-only rendering change on the two reorder screens to detect the
  per-vendor "no submitted EOD" signal and replace the item/order rows with a
  "Count not submitted yet" state (vendor header retained).
- i18n catalog string additions for the new message on both surfaces.
- Whatever minimal action-gating and KPI/section handling the architect resolves
  for Q2 / Q3 below.
- Jest tests on both admin and staff reorder screens.

## Out of scope (explicitly)

- Any change to the `report_reorder_list` RPC, its SQL, or the DB — the signal is
  already in the payload; this is expected to be frontend-only. (Architect to
  confirm; see Dependencies.)
- Changing the reorder math / suggested-order computation. Rationale: the numbers
  are correct given the inputs; the fix is to not act on stale inputs, not to
  recompute.
- Changing the existing EOD-vs-stock detection or the "STOCK FALLBACK" badge
  semantics. Rationale: the same signal drives both; we are adding a display
  branch, not redefining the source model.
- The staff EOD count-entry flow, or any change to how/when an EOD is submitted.
- The per-vendor CSV/PDF export file FORMAT (spec 123) — only whether the action
  is offered for an un-counted vendor (Q2) is in play here, not the file contents.
- Realtime behavior. The staff stack has no realtime (spec 062); admin already
  reloads via `useRealtimeSync`. No channel changes.

## Open questions resolved (baked-in decisions — do NOT re-open)

- Q: What do we show for a vendor with no submitted EOD count for the date?
  → A: Still show the vendor CARD (header: name + next delivery), but REPLACE the
  item/order lines with a clear "Count not submitted yet" state. No order
  quantities, because they would be based on stale on-hand.
- Q: Which surfaces? → A: BOTH the admin Cmd reorder screen AND the staff reorder
  screen.

## Open questions for the architect

1. **Exact signal.** `eodSubmittedAt == null` and `onHandSource === 'stock'` are
   equivalent per the payload contract (a vendor with no submitted EOD for the
   as-of date has both). Pick ONE explicit predicate and use it consistently on
   both surfaces. Recommendation: `eodSubmittedAt == null` (reads as the literal
   intent: "no count was submitted").
2. **Order actions on an un-counted vendor.** Should +CREATE PO / QUICK-ORDER LIST
   / per-vendor CSV / per-vendor PDF be DISABLED or hidden for a "count not
   submitted" vendor? Recommendation: DISABLE (or hide) all four — there is
   nothing trustworthy to order or export. Confirm the treatment (disabled vs
   hidden) and apply identically on both surfaces.
3. **KPI + section placement.** The top KPIs ("N below par", "est cost") and the
   NEEDS-TO-ORDER vs HAVE-ENOUGH split currently include stock-fallback vendors
   (`computeReorderKpis` / `splitReorderVendorsByNeed` in
   `src/utils/reorderDayFilter.ts`). Decide the minimal consistent v1 handling:
   recommendation is to keep the un-counted vendor's card VISIBLE (under NEEDS TO
   ORDER or its own state) but ensure its suppressed lines do NOT inflate the
   actionable item / est-cost KPI totals. Architect picks the least-invasive
   change that keeps KPIs and the visible cards consistent.
4. **Staff signal parity.** Confirm the staff reorder screen exposes the same
   per-vendor signal. (Verified during spec authoring: `src/screens/staff/lib/
   fetchReorder.ts:102-103` maps `onHandSource` + `eodSubmittedAt` from the same
   RPC payload, and `Reorder.tsx:158` already branches on `onHandSource`.)

## Dependencies

- `report_reorder_list` RPC — read-only consumer; expected NO change. Architect to
  confirm the payload's per-vendor `onHandSource` / `eodSubmittedAt` are
  sufficient (they appear to be — mapped at `src/lib/db.ts:4034-4035` and
  `src/screens/staff/lib/fetchReorder.ts:102-103`).
- `ReorderVendor` type (`src/types/index.ts:917-918`) — already carries
  `onHandSource` and `eodSubmittedAt`; no field addition expected.
- Shared reorder utils (`src/utils/reorderDayFilter.ts` — `computeReorderKpis`,
  `splitReorderVendorsByNeed`, `partitionReorderVendors`) — may be touched if Q3
  resolves to excluding un-counted vendors from KPI totals.
- i18n catalogs: `src/i18n/*.json` (admin) and `src/screens/staff/i18n/*.json`
  (staff) for the new message string.

## Project-specific notes

- Cmd UI section / legacy: admin Cmd section `src/screens/cmd/sections/
  ReorderSection.tsx` (the only admin surface; no legacy) AND staff peer
  `src/screens/staff/screens/Reorder.tsx`.
- Per-store or admin-global: per-store — reorder data is store-scoped via the
  same store selection that drives `report_reorder_list`. No change to scope or
  RLS.
- Realtime channels touched: none. Admin already reloads via `store-{id}` /
  `brand-{id}` in `useRealtimeSync`; staff has no realtime (spec 062).
- Migrations needed: no (expected). Frontend-only; architect to confirm no RPC
  change.
- Edge functions touched: none.
- Web/native scope: both. Admin Cmd is web-primary; staff ships web + native. The
  change is plain React Native view rendering + i18n — no web-only APIs.
- Tests: jest track (two suites — admin `src/screens/cmd/sections/__tests__/`
  reorder tests and staff `src/screens/staff/screens/Reorder.test.tsx`). No pgTAP
  or shell-smoke track expected since there is no DB/RPC change.

## Backend design

### Frontend-only — confirmed

No migration, no RPC change, no edge-function change, no RLS change, no realtime
change. The per-vendor signal is already in the `report_reorder_list` payload and
already mapped on BOTH surfaces:

- Admin: `db.ts:mapReorderVendor` maps `eod_submitted_at` → `eodSubmittedAt` and
  `on_hand_source` → `onHandSource` (`src/lib/db.ts:4034-4035`).
- Staff: `fetchReorder.ts:95,103` maps the same two fields into the SHARED
  `ReorderVendor` type.

`ReorderVendor.eodSubmittedAt: string | null` and `onHandSource: 'eod' | 'stock'`
already exist on the type (`src/types/index.ts:917-918`). Nothing to add to the
type, the mappers, or the DB. This spec is a pure render + client-KPI change.

### Q1 — Predicate (resolved: `eodSubmittedAt == null`)

Add ONE shared pure helper to `src/utils/reorderDayFilter.ts` (the existing
framework-free reorder util, already imported by both screens), exported
alongside `computeReorderKpis` / `splitReorderVendorsByNeed`:

```ts
/**
 * Spec 130 — a vendor whose EOD count was NOT submitted for the reorder date.
 * `eodSubmittedAt == null` is the literal "no count submitted" signal
 * (equivalent to `onHandSource === 'stock'` per the payload contract; we key
 * off eodSubmittedAt as the clearer intent). Its per-item order quantities are
 * computed off a stale current_stock fallback and must not be acted on.
 * `== null` (not `=== null`) so an absent/undefined field is also treated as
 * uncounted.
 */
export function isReorderCountNotSubmitted(vendor: ReorderVendor): boolean {
  return vendor.eodSubmittedAt == null;
}
```

Both screens import and use this helper — no inline re-derivation of the
predicate anywhere (mirrors how `vendorHasPo` centralizes the spec-123 signal).
A vendor WITH a non-null `eodSubmittedAt` renders exactly as today, even if some
items carry the `eod_missing_for_item` flag — per-item gaps are out of scope.

### Q2 — Not-submitted card (resolved)

`VendorCard` self-branches on `isReorderCountNotSubmitted(vendor)` FIRST, before
the items/columns/footer. When true it renders:

- The vendor header UNCHANGED: name + next-delivery line (+ source/schedule
  badges as today — the `STOCK FALLBACK` badge stays, it is consistent with this
  state). Keep the `SCHEDULE UNKNOWN` / `7-DAY DEFAULT` badges too.
- In place of the column strip + per-item rows + footer actions: a single
  "Count not submitted yet" state block (localized message + a subtle icon/glyph;
  admin can use a muted mono glyph consistent with the section, staff a muted
  emoji/glyph in the staff theme). NO `on hand → order` breakdown lines, NO
  est-$ column, NO per-item rows, NO coincident-schedule hints.

Card testIDs so jest can assert the branch:
- Admin: `reorder-count-not-submitted-${vendorId}` on the state block.
- Staff: `staff-reorder-count-not-submitted-${vendorId}` on the state block.

Because the branch is INSIDE `VendorCard`, it renders correctly no matter which
group the card lands in (needs / enough / no-schedule / single-vendor filter).

### Q3 — Order actions (resolved: HIDE all four)

For an un-counted vendor there is nothing trustworthy to order or export, so all
four per-vendor actions are HIDDEN (not merely disabled) — they live in the
footer block that the not-submitted branch replaces, so they simply never render.
Confirmed on BOTH surfaces:

- Admin `ReorderSection.tsx` VendorCard footer: `CreatePoButton`,
  `ReorderQuickOrderButton`, and the spec-123 `ReorderVendorExportButtons`
  (`CSV`/`PDF`) are all inside the footer that is not rendered in the
  not-submitted branch. Result: `reorder-create-po-${id}`,
  `reorder-quick-order-${id}`, `reorder-export-csv-${id}`,
  `reorder-export-pdf-${id}` are absent for an un-counted vendor.
- Staff `Reorder.tsx`: the staff VendorCard footer is item-count-only (no
  per-vendor order/export buttons — staff export is global, gated separately;
  see below). The staff card's not-submitted branch simply omits the item rows +
  the item-count footer.

Staff GLOBAL export (`showExport` → CSV/text/PDF share buttons) must also not
offer an un-counted-only view: gate `showExport` and `exportPayload` on the
COUNTED display set (see Q4). If the user filters to a single un-counted vendor,
the global export row hides.

### Q4 — KPI + section handling (resolved: pull uncounted out before split;
dedicated group; no dollar total)

Rationale for pulling uncounted vendors OUT of `primary`/`displayVendors` BEFORE
`splitReorderVendorsByNeed` rather than relying only on the card self-branch: a
stock-fallback vendor reads `on_hand = 0`, so today ALL its items are below par
and it lands in `needsOrderVendors`, inflating `computeReorderKpis`
(`itemCount`, `totalEstimatedCost`, `stockFallbackVendorCount`) and the
`vendorTotalCost`. A mixed-item vendor could also appear in BOTH the needs and
enough splits → double-render. Filtering first fixes both.

Minimal change, identical shape on both screens:

```ts
// admin: over `primary`; staff: over `displayVendors`
const counted = base.filter((v) => !isReorderCountNotSubmitted(v));
const notSubmitted = base.filter((v) => isReorderCountNotSubmitted(v));

const needsOrderVendors = splitReorderVendorsByNeed(counted, true);
const enoughStockVendors = splitReorderVendorsByNeed(counted, false);
const kpis = computeReorderKpis(needsOrderVendors); // now excludes uncounted
```

- **KPIs**: recomputed client-side (both screens ALREADY call `computeReorderKpis`
  over the filtered set — spec 087/123). We just feed it `counted` needs-order
  vendors. No change to `computeReorderKpis` itself (it stays pure; still used by
  `narrowReorderToVendor` for per-vendor export). The un-counted vendors
  contribute nothing to "N below par" / "est cost" / `vendorTotalCost`.
- **Placement**: render `notSubmitted` in its OWN group at the TOP of the vendor
  list (above NEEDS TO ORDER), with a distinct localized group header
  ("Count not submitted"), each vendor as the not-submitted card. No dollar
  total on the group. This keeps the NEEDS/ENOUGH sections purely "counted" and
  makes the un-submitted vendors the first thing the manager sees (they need a
  count). Simplest coherent v1; avoids interleaving special-cased cards inside
  the needs map.
- **`noSchedule` group**: leave the existing `splitReorderVendorsByNeed(noSchedule,
  true)` map as-is — it only renders the `true` split (no double-render risk) and
  `VendorCard`'s internal branch renders any un-counted no-schedule vendor as the
  not-submitted card. `noSchedule` vendors never feed `computeReorderKpis`, so no
  KPI inflation there regardless. No plumbing change to the no-schedule group.
- **Export gate**: base admin `showExport` and staff `showExport` / `exportPayload`
  on `counted` (staff: `countedDisplay`) rather than the raw `primary` /
  `displayVendors`, so an un-counted-only view doesn't offer export.

### `src/lib/db.ts` surface

No change. `mapReorderVendor` already carries `eodSubmittedAt` + `onHandSource`.
No new helper, no new query.

### i18n

Admin (`src/i18n/en.json` / `es.json` / `zh-CN.json`) under `section.reorder.*`:
- `section.reorder.countNotSubmittedGroupTitle` — group header, e.g. "Count not submitted"
- `section.reorder.countNotSubmittedTitle` — card state title, e.g. "Count not submitted yet"
- `section.reorder.countNotSubmittedBody` — one-line explanation, e.g. "No end-of-day count was submitted for this date, so order quantities are hidden. Submit the count to see suggestions."

Staff (`src/screens/staff/i18n/en.json` / `es.json` / `zh-CN.json`) under `reorder.*`:
- `reorder.countNotSubmitted.groupTitle`
- `reorder.countNotSubmitted.title`
- `reorder.countNotSubmitted.body`

All three locale files on EACH surface get all keys (matches how
`reorderExport.sourceStock` / `reorder.source.stockFallback` are localized). Staff
strings route through the reactive `useI18n()` `t`; admin through `useT()`.
Vendor names and the source badge stay as they are today.

### Realtime / store / edge functions

- Realtime: no change. Admin reloads via `store-{id}`/`brand-{id}` in
  `useRealtimeSync`; staff has no realtime (spec 062). No publication change → no
  `docker restart supabase_realtime_imr-inventory` step.
- Store: no `useStore.ts` slice change and no `useStaffStore` slice change. This
  is derived render state (`useMemo` over the already-loaded payload). No
  optimistic-then-revert path (read-only screen).
- Edge functions: none.

### Q5 — Staff parity (confirmed)

`fetchReorder.ts` already maps `eodSubmittedAt` (line 103) and `onHandSource`
(line 95) into the SHARED `ReorderVendor`; `Reorder.tsx` already branches on
`onHandSource` for its badge (line 158) and already computes KPIs client-side via
`computeReorderKpis` (line 461). The staff screen adds the same
`isReorderCountNotSubmitted` filter over `displayVendors`, the same dedicated
not-submitted group at the top, and a `StateCard`-style not-submitted block in
the staff theme (reuse the existing `StateCard` component or the `VendorCard`
header + a muted body, `testID="staff-reorder-count-not-submitted-${vendorId}"`).
The staff card keeps its header (name + `reorder.vendor.nextDelivery`) and drops
the item rows + the item-count footer.

### Risks / tradeoffs

- **Predicate equivalence assumption.** `eodSubmittedAt == null` ⇔
  `onHandSource === 'stock'` is a payload-contract invariant, not enforced in
  code. If the RPC ever emitted a non-null `eodSubmittedAt` with
  `onHandSource === 'stock'` (or vice-versa) the two would diverge. We key off
  ONE field consistently (per Q1) so the screens are self-consistent regardless;
  the reorderDayFilter unit test documents the chosen predicate.
- **Double-render / KPI-inflation** — both eliminated by filtering uncounted out
  of `primary`/`displayVendors` before the needs/enough split (Q4), rather than
  relying solely on the in-card branch.
- **Performance**: two extra `Array.filter` passes over the already-filtered
  vendor list per render (memoized). Negligible on the 286 KB seed dataset
  (vendor counts are single/low-double digits per store).
- **`noSchedule` edge**: an un-counted no-schedule vendor renders as not-submitted
  via the in-card branch but stays inside the collapsed no-schedule group rather
  than the top group. Acceptable for v1 (rare combination; still correct + no KPI
  impact). Called out so a reviewer doesn't read it as a miss.

### Jest surface

- `src/utils/reorderDayFilter.test.ts` (existing) — add `isReorderCountNotSubmitted`
  cases: null/undefined `eodSubmittedAt` → true; ISO string → false. Optionally
  assert `computeReorderKpis` over a counted-only array excludes an uncounted
  vendor's items/cost (the filtering happens at the call site, so this is really a
  screen-level assertion — keep the helper test focused on the predicate).
- Admin `src/screens/cmd/sections/__tests__/` (new suite or extend
  `ReorderSection.test.tsx`): un-counted vendor renders
  `reorder-count-not-submitted-${id}` + renders NO `BreakdownLine`/order-qty rows,
  and `reorder-create-po-${id}` / `reorder-quick-order-${id}` /
  `reorder-export-csv-${id}` / `reorder-export-pdf-${id}` are ABSENT; a counted
  vendor is unchanged (breakdown + actions present); the KPI strip
  (`Items` / `Est. total`) excludes the un-counted vendor's items/cost.
- Staff `src/screens/staff/screens/Reorder.test.tsx` (existing): un-counted vendor
  renders `staff-reorder-count-not-submitted-${id}` + no `reorder.item.order`
  rows; counted vendor unchanged; `computeReorderKpis`-driven KPI cards exclude
  the un-counted vendor.

No pgTAP, no shell-smoke (no DB/RPC change).

## Handoff
next_agent: frontend-developer
prompt: Implement spec 130 against the Backend design section — frontend-only.
  Add the `isReorderCountNotSubmitted` predicate to `src/utils/reorderDayFilter.ts`;
  branch `VendorCard` to the not-submitted state (header retained, item/order rows
  + all per-vendor actions removed) on both `src/screens/cmd/sections/ReorderSection.tsx`
  and `src/screens/staff/screens/Reorder.tsx`; filter un-counted vendors out of the
  needs/enough split and the KPI/export inputs, and render them in a dedicated
  "Count not submitted" group at the top; add the i18n keys to all three locale
  files on each surface; add the jest coverage named in the design. After
  implementation, set Status: READY_FOR_REVIEW and list files changed under
  ## Files changed.
payload_paths:
  - specs/130-reorder-count-not-submitted.md

## Files changed

Implementation (frontend-only, per the Backend design — no migration / RPC / DB
/ store change):

- `src/utils/reorderDayFilter.ts` — added the shared `isReorderCountNotSubmitted`
  predicate (`eodSubmittedAt == null`), imported by both screens.
- `src/screens/cmd/sections/ReorderSection.tsx` — VendorCard self-branches to a
  "Count not submitted yet" state block (header retained; column strip / item
  rows / footer actions omitted, so Create PO / Quick-order / CSV / PDF never
  render). Section filters un-counted vendors OUT of the needs/enough split +
  `computeReorderKpis` input + `showExport` gate, and renders them in a
  dedicated "Count not submitted" group at the top.
- `src/screens/staff/screens/Reorder.tsx` — same treatment: not-submitted branch
  in the staff VendorCard, un-counted vendors filtered out of the needs/enough
  split + KPIs + `exportPayload` / `showExport`, rendered in a top group.
- `src/i18n/en.json`, `src/i18n/es.json`, `src/i18n/zh-CN.json` — admin
  `section.reorder.countNotSubmittedGroupTitle` / `…Title` / `…Body`.
- `src/screens/staff/i18n/en.json`, `es.json`, `zh-CN.json` — staff
  `reorder.countNotSubmitted.groupTitle` / `.title` / `.body`.

Tests:

- `src/utils/reorderDayFilter.test.ts` — predicate cases (null / undefined →
  true; ISO string → false).
- `src/screens/cmd/sections/__tests__/ReorderSection.spec130.test.tsx` — new
  suite: un-counted vendor renders the state block + none of the four action
  testIDs; counted vendor renders normally; KPIs exclude the un-counted vendor.
- `src/screens/staff/screens/Reorder.test.tsx` — added spec-130 cases (state
  block + no item/order rows; KPI + export-payload exclusion).
- `src/screens/cmd/sections/__tests__/ReorderSection.test.tsx`,
  `ReorderSection.spec123.test.tsx`, `ReorderSectionCases.test.tsx` — updated the
  vendor fixtures' default `eodSubmittedAt` to a non-null ISO so they keep
  exercising the normal (counted) render path under the new predicate.

Verification: `npx tsc --noEmit` clean, `npm run typecheck:test` clean, full
`npx jest` green (122 suites / 1306 tests, including the i18n parity suite).
Live-browser verification of the specific data condition (a vendor with no
submitted EOD for the selected date) was NOT performed — preview tooling was
unavailable in the implementation session and the state needs a seeded
un-counted vendor; the new jest suites render the real screens and pin the
branch instead.
