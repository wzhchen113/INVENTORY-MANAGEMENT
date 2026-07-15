# Spec 123: Reorder per-vendor exports + persistent "PO CREATED"

Status: READY_FOR_REVIEW

## User story
As a store manager on the admin Reorder screen, I want CSV and PDF export to live
on each vendor card (not as one global export of the whole list), and I want a
vendor's "+ CREATE PO" button to change to "PO CREATED" and stay that way after I
refresh or reopen the screen, so that I can export exactly one vendor's order at a
time and never accidentally create a duplicate PO for the same vendor and delivery
date.

## Acceptance criteria

### Part 1 — per-vendor CSV + PDF
- [ ] The global top-of-screen CSV and PDF export buttons are removed from
  `ReorderSection.tsx`. The top REFRESH button and the date picker remain.
- [ ] Each `VendorCard` footer renders a CSV button and a PDF button (alongside
  the existing "QUICK-ORDER LIST" and Create-PO buttons).
- [ ] Pressing a vendor's CSV button exports a CSV containing ONLY that vendor's
  order (narrowed payload `{...reorderPayload, vendors:[v], kpis: computeReorderKpis([v])}`),
  not the whole list.
- [ ] Pressing a vendor's PDF button exports a PDF containing ONLY that vendor's
  order.
- [ ] When a vendor is configured with a US Foods / SYSCO import format, that
  vendor's CSV button emits that vendor's import order-file format (the existing
  `pickImportVendor` / `handleImportExport` path), now scoped to that single
  vendor card rather than triggered globally.
- [ ] A vendor NOT configured with an import format exports the standard
  `buildReorderCsv` output for that one vendor.
- [ ] The per-vendor CSV and PDF buttons are web-only and remain gated by the
  existing `showExport` condition — they do not render on native.

### Part 2 — "+ CREATE PO" → "PO CREATED" (persistent)
- [ ] After a PO is successfully created for a vendor, that vendor's card button
  displays "PO CREATED" instead of "+ CREATE PO".
- [ ] The "PO CREATED" state persists across REFRESH, full page reload, and
  navigating away and reopening the Reorder screen — it is derived from persisted
  backend state (a PO row for that store + vendor + selected reorder date), not
  from in-memory session state alone.
- [ ] The state is keyed by (store, vendor, selected reorder date). Changing the
  date picker to a date with no PO for that vendor shows "+ CREATE PO" again for
  that vendor; changing back to a date that has a PO shows "PO CREATED".
- [ ] Creating a PO threads the currently-selected reorder date through as
  `referenceDate` so `createPurchaseOrderDraft` persists a non-null
  `reference_date`, and the persistence check matches on that date.
- [ ] Two vendors on the same date are independent: creating a PO for vendor A
  does not change vendor B's button.

## In scope
- Moving CSV + PDF export from global buttons into each `VendorCard` footer,
  scoped to one vendor.
- Removing the two global top-of-screen CSV/PDF buttons.
- Preserving the US Foods / SYSCO import-format CSV path, scoped per-vendor.
- Threading the selected reorder date into `createPoDraft` /
  `createPurchaseOrderDraft` as `referenceDate`.
- Deriving and rendering a persistent per-(vendor, date) "PO CREATED" button
  state on the Reorder screen.

## Out of scope (explicitly)
- Any change to the QUICK-ORDER LIST button behavior — untouched.
- Any change to the CSV/PDF export builders' signatures or output format
  (`buildReorderCsv`, inline `handlePdfExport`) — they already loop
  `payload.vendors`; we only narrow the payload passed in.
- PO editing, PO status transitions beyond creation, or a PO detail/review view —
  not part of this spec.
- Undo / "un-create" a PO, or deleting the draft to flip the button back — not
  requested; a different date is the only way to get "+ CREATE PO" back.
- Native CSV/PDF export — remains web-only per existing `showExport` gating.
- Realtime/live updates to the reorder list — it stays fetch-on-demand.

## Open questions resolved
- Q: Should CSV/PDF be per-vendor or stay global? → A: Per-vendor only; remove the
  global top buttons. REFRESH + date picker stay.
- Q: Should "PO CREATED" persist across reload? → A: Yes, persisted, keyed by
  (store, vendor, selected reorder date).

## Open questions for the architect (genuinely technical)
1. **PO-existence detection source.** Persist the "PO CREATED" signal via (a) a new
   per-vendor `has_po` flag on the `report_reorder_list` RPC, or (b) client-side
   matching the already-loaded `orderSubmissions` slice
   (`refreshPurchaseOrders` → `fetchRecentPurchaseOrders(storeId, 14d)`, each row
   carrying vendorId + referenceDate/date + status) by vendor + selected date?
   Note the 14-day window in (b) may not cover an arbitrary selected reorder date —
   factor that into the choice.
2. **Which PO statuses count as "exists"?** Does "PO CREATED" mean any
   `purchase_orders` row for that (vendor, date) regardless of status, or only
   specific statuses (e.g. `draft` and beyond, excluding cancelled/voided)? Define
   the status predicate.
3. **Should CREATE PO be blocked once a PO exists?** Options: (a) render "PO
   CREATED" as disabled / non-clickable (hard duplicate-prevention), or (b) keep it
   pressable to allow an intentional second PO. Product intent is
   duplicate-prevention, so default lean is disabled unless the architect surfaces
   a reason to keep it actionable. Architect to confirm and, if disabled, confirm
   there is no other create-PO entry point for that vendor+date.
4. **Legacy null-reference-date drafts.** Existing draft POs created before this
   spec have `reference_date = null`. Confirm they are simply never matched (so
   they never show "PO CREATED") and no backfill is attempted — or specify a
   fallback match rule if one is desired.

## Dependencies
- `ReorderSection.tsx` (`src/screens/cmd/sections/ReorderSection.tsx`) — VendorCard
  footer, CreatePoButton (`:194-250`), global export buttons removal, `showExport`
  gating (`:1030`), inline `handlePdfExport` (`:694`).
- `reorderExport.ts` `buildReorderCsv` (`:168`) — payload-narrowing call site only.
- `computeReorderKpis` — already imported in `ReorderSection.tsx`.
- Store: `createPoDraft(vendor)` (`useStore.ts:2662-2712`) — thread `referenceDate`;
  reads reorder state incl. selected date. `loadReorderSuggestions()` already
  refetches after create.
- DB: `db.createPurchaseOrderDraft` (`db.ts:1532-1590`) — already accepts optional
  `referenceDate`; must be passed the selected reorder date.
- PO detection path: either `report_reorder_list` RPC (new flag) OR the
  `orderSubmissions` slice / `fetchRecentPurchaseOrders`. Architect decides.
- `pickImportVendor` / `handleImportExport` — US Foods / SYSCO per-vendor CSV path.
- `ReorderVendor` type (`src/types/index.ts:895-905`) — may gain a `hasPo` field if
  the RPC-flag route is chosen.

## Project-specific notes
- Cmd UI section / legacy: Cmd UI — `src/screens/cmd/sections/ReorderSection.tsx`.
  No legacy surface.
- Per-store or admin-global: Per-store. PO existence is scoped by store (via the
  reorder fetch / `fetchRecentPurchaseOrders(storeId, …)`), and must respect the
  per-store RLS on `purchase_orders`.
- Realtime channels touched: None. Reorder list is fetch-on-demand; `createPoDraft`
  already re-fetches in-session. No new realtime publication.
- Migrations needed: Only if the architect chooses the RPC-flag route for PO
  detection (add a per-vendor `has_po` to `report_reorder_list`). None if the
  client-match-on-`orderSubmissions` route is chosen. Architect decides.
- Edge functions touched: None.
- Web/native scope: CSV/PDF export is web-only (preserve `showExport` gating). The
  "PO CREATED" button-state change applies on both web and native.
- Tests: If the RPC gains a `has_po` flag → pgTAP DB test for the new column/logic.
  Jest coverage for per-vendor payload narrowing and the (vendor, date)-keyed
  button-state derivation. No shell smoke needed.

---

## Backend design

### Resolution of the four open technical questions

**Q1 — PO-detection source: RPC `has_po` flag (option a). Confirmed.**
The signal is a per-vendor boolean computed server-side by `report_reorder_list`
for the reorder list's own reference date. Rationale over the client-match route:

- The reorder list already carries the exact `(store, vendor, reference_date)`
  key the check needs. The reference date IS `v_as_of_date` inside the RPC (the
  function has **no `p_reference_date` param** — the date arrives as
  `p_params->>'as_of_date'`; see "no signature change" below). Computing the
  EXISTS in the same statement means the flag can never disagree with the date
  the card is rendered for.
- The client-match alternative reads `fetchRecentPurchaseOrders(storeId, 14d)`
  (`refreshPurchaseOrders`). That 14-day window does not cover an arbitrary
  selected reorder date (the date picker can point at any day), so it would
  produce false "+ CREATE PO" for a PO outside the window — a duplicate-creation
  hazard, which is the exact thing Part 2 exists to prevent. Rejected.
- Keeps `ReorderSection` from having to join the `orderSubmissions` slice and
  re-derive per-vendor/per-date matching in the render path.

This choice REQUIRES #4 (thread the selected reorder date into draft create) so a
freshly-created draft is keyed to the same date the flag queries.

**Q2 — Status predicate: any `purchase_orders` row for `(store_id, vendor_id,
reference_date)` whose `status <> 'cancelled'`. Confirmed and pinned.**
The `purchase_orders_status_check` constraint
([supabase/migrations/20260704000000_po_loop.sql:109](supabase/migrations/20260704000000_po_loop.sql)) pins the enum to exactly
`('draft','sent','partial','received','cancelled')`. **There is no `voided`
status** — the spec steer's "cancelled/voided" collapses to just `cancelled` on
this schema. So `draft / sent / partial / received` all count as "created"; only
`cancelled` is excluded. If a future spec adds `voided`, extend the NOT-IN list
in this RPC and the pgTAP fixture together.

**Q3 — Block on exists: yes, "PO CREATED" renders disabled / non-pressable.**
Confirmed. Product intent is hard duplicate-prevention. When `vendor.hasPo` is
true the card shows the "PO CREATED" label with `disabled` and no press handler.
Confirmed there is **no other create-PO entry point for a (vendor, date)** —
`createPoDraft` is only invoked from `CreatePoButton` in `ReorderSection.tsx`
([src/store/useStore.ts:2662](src/store/useStore.ts) is the sole call target). The POsSection/ReceivingSection
paths operate on already-existing POs; they do not create drafts from a reorder
vendor card. So disabling this one button fully closes the duplicate path from
the UI. (RLS still allows a determined psql INSERT — out of scope; this is a
UX-level guard, not a DB constraint.)

**Q4 — Legacy null-`reference_date` drafts: not backfilled, never matched.
Go-forward path fixed.** Confirmed. Pre-spec drafts have `reference_date = null`;
the EXISTS is keyed on `reference_date = v_as_of_date`, and `null = date` is never
true, so they simply never light "PO CREATED". No backfill. The go-forward fix:
`createPoDraft` threads the currently-displayed reorder date so new drafts persist
a non-null `reference_date` (see §"Store impact"). No fallback match rule.

### Data model changes

**Migration:** `supabase/migrations/20260718000000_reorder_list_has_po.sql`
(next free slot — latest on disk is `20260717000000_apply_item_scalars_to_brand.sql`;
verified no collision).

- **Additive, non-destructive.** `CREATE OR REPLACE FUNCTION
  public.report_reorder_list(uuid, jsonb)` — **same `(uuid, jsonb)` signature, no
  param change, ACL preserved** (`security invoker`, `set search_path = public`).
  The reference date already arrives via `p_params->>'as_of_date'` → `v_as_of_date`;
  no new call sites, no `db.ts` param change for the date.
- **No table/column/index change.** `purchase_orders.reference_date` (type `date`)
  and `purchase_orders.status` already exist. No new index is required for the
  seed dataset (0 `purchase_orders` rows in seed; prod has ~6). The EXISTS is a
  point lookup on `(store_id, vendor_id, reference_date)`; if prod PO volume grows
  a partial/composite index can follow in a later spec — do **not** add one here
  speculatively.

**Developer discipline (dump-exact + one edit).** Base the new migration on the
verbatim body of the latest reorder definition,
[supabase/migrations/20260711000000_reorder_list_include_stocked.sql](supabase/migrations/20260711000000_reorder_list_include_stocked.sql) (the current
live definition — matches the "dump exact tested function" rule). Make exactly ONE
additive edit: add a `'has_po'` key to the `vendor_rows` `jsonb_build_object`
(the CTE at ~line 576-591 of that file), computed as a scalar EXISTS:

```
'has_po', exists (
  select 1
    from public.purchase_orders po
   where po.store_id      = p_store_id
     and po.vendor_id     = vwi.vendor_id
     and po.reference_date = v_as_of_date
     and po.status <> 'cancelled'
)
```

Placing it in `vendor_rows` (which iterates `vendors_with_items vwi`) keys the
flag per surfaced vendor card. Every other CTE, the KPI block, the warnings block,
and the final envelope stay byte-for-byte identical. Admin already passes
`include_stocked=true`, so all vendors-with-items surface and each gets a flag.
The key is additive JSON — the staff reorder mapper and any other consumer that
doesn't read `has_po` are unaffected.

### RLS impact

**None.** No new table, so no new policy. `report_reorder_list` is
`security invoker` and gates on `auth_can_see_store(p_store_id)` as its first
statement (unchanged). The inner EXISTS reads `public.purchase_orders`, which is
already under per-store RLS via `auth_can_see_store()`
([supabase/migrations/20260504173035_per_store_rls_hardening.sql](supabase/migrations/20260504173035_per_store_rls_hardening.sql)) — but because the
function is `security invoker` the subquery runs as the caller and the outer
`p_store_id` gate already scopes it; the caller can only ever see their own
store's POs. No `auth_is_admin()` path involved.

### API contract

- **PostgREST vs RPC:** unchanged — RPC. Same `supabase.rpc('report_reorder_list',
  { p_store_id, p_params })` call in `fetchReorderSuggestions`
  ([src/lib/db.ts:3929](src/lib/db.ts)). No request-shape change.
- **Response shape:** each element of `vendors[]` gains one additive key,
  `has_po: boolean`. Existing keys unchanged. Error cases unchanged (the RPC still
  raises `42501` on an unauthorized store; `fetchReorderSuggestions` rethrows and
  the store slice swallows to `reorderError`).

### Edge function changes

**None.** No edge function touched. No `verify_jwt` / service-token consideration.

### `src/lib/db.ts` surface

No new helper. Two existing spots change, both in the reorder block:

- `mapReorderVendor` ([src/lib/db.ts:3965](src/lib/db.ts)) — add to the returned
  `ReorderVendor`:
  ```ts
  hasPo: Boolean(v?.has_po ?? false),
  ```
  snake_case `has_po` → camelCase `hasPo`. Absent → `false` (a below-par-only or
  older envelope defaults to "no PO", i.e. shows "+ CREATE PO").
- `createPurchaseOrderDraft` ([src/lib/db.ts:1532](src/lib/db.ts)) — **no change**;
  it already accepts optional `referenceDate` and conditionally sets
  `reference_date` on the header insert (line 1559). The caller must now pass it.

### `ReorderVendor` type

[src/types/index.ts:895-905](src/types/index.ts) — add one field to the interface:

```ts
export interface ReorderVendor {
  // ...existing fields...
  vendorTotalCost: number;
  /**
   * Spec 123 — true when a non-cancelled purchase_orders row exists for
   * (store, this vendor, the reorder list's as-of/reference date). Drives the
   * persistent "PO CREATED" (disabled) button state. Computed server-side by
   * report_reorder_list against v_as_of_date; keyed to the same date the card
   * renders for. `false` for legacy null-reference_date drafts (never matched).
   */
  hasPo: boolean;
}
```

### Store impact (`src/store/useStore.ts`)

Single slice change in `createPoDraft` ([src/store/useStore.ts:2662](src/store/useStore.ts)):
thread the currently-displayed reorder date into the draft create. The date is
already in the store as `reorderPayload.asOfDate` (populated by
`fetchReorderSuggestions` from `envelope.as_of_date`), so no new state or
plumbing from the component is needed:

```ts
const referenceDate = get().reorderPayload?.asOfDate || undefined;
const poId = await db.createPurchaseOrderDraft({
  storeId,
  vendorId: vendor.vendorId,
  createdByUserId: get().currentUser?.id,
  referenceDate,                 // spec 123 — key the draft to the reorder date
  lines,
});
```

Reading `reorderPayload.asOfDate` (rather than a component-passed value)
guarantees the persisted `reference_date` equals `v_as_of_date` the `has_po`
EXISTS will query on the next `loadReorderSuggestions()` — the two dates come from
the same source string. `createPoDraft` already calls `loadReorderSuggestions()`
on success (line 2706), which re-fetches and flips `hasPo` to true for that
vendor. **Optimistic-then-revert does not apply** — this is a create that
re-fetches authoritative state; the existing `notifyBackendError` on failure and
`refreshPurchaseOrders()` + `loadReorderSuggestions()` on success are unchanged.
No `useStore` slice other than `createPoDraft` changes.

### Frontend impact (`src/screens/cmd/sections/ReorderSection.tsx`)

Per the spec's Part 1 and Part 2 (frontend-developer owns this):

- **Remove** the two global top-of-screen CSV and PDF export buttons. **Keep** the
  top REFRESH button and the date picker.
- **Per-vendor CSV/PDF in each `VendorCard` footer**, alongside QUICK-ORDER LIST
  and the create button. Narrow the payload to a single vendor before calling the
  existing builders — do NOT change the builders' signatures (they already loop
  `payload.vendors`):
  ```ts
  const narrowed = { ...reorderPayload, vendors: [v], kpis: computeReorderKpis([v]) };
  ```
  Feed `narrowed` to `buildReorderCsv` ([reorderExport.ts:168](src/screens/cmd/sections/reorderExport.ts)) and the inline
  `handlePdfExport` (`:694`). `computeReorderKpis` is already imported.
- **Import-format vendors (US Foods / SYSCO):** reuse the existing
  `pickImportVendor` / `handleImportExport` path, now invoked from the single
  vendor card instead of globally. A vendor with an import format emits its import
  order-file format; a vendor without one emits standard `buildReorderCsv`. This
  is the same decision logic that lived behind the global button — only the
  trigger scope changes.
- **Web-only gating preserved.** The per-vendor CSV/PDF buttons render only under
  the existing `showExport` condition (`:1030`) — no native render.
- **`CreatePoButton` ([src/screens/cmd/sections/ReorderSection.tsx:194](src/screens/cmd/sections/ReorderSection.tsx)):** when `vendor.hasPo` is
  true, render the "PO CREATED" label, `disabled`, no `onPress` (guard early), and
  drop the confirm/create flow for that render. When false, current behavior
  (confirm → `createPoDraft` → toast). Two vendors are independent because
  `hasPo` is per-vendor on the payload. Add an i18n key for the "PO CREATED"
  label (e.g. `section.reorder.poCreatedLabel`) in all three locales (en/es/zh),
  matching the localized-download discipline used across the reorder screen.
  Keep the existing `testID={`reorder-create-po-${vendor.vendorId}`}` so the
  disabled state is assertable.

### Realtime / publication impact

**None.** The change is RPC-body-only plus a header-insert field already present.
`purchase_orders` is already in the `supabase_realtime` publication
([supabase/migrations/20260704000000_po_loop.sql:73](supabase/migrations/20260704000000_po_loop.sql)); this spec does not alter
publication membership, so **no `docker restart supabase_realtime_imr-inventory`
is required**. The reorder list stays fetch-on-demand (no channel replays it);
`createPoDraft` already re-fetches in-session via `loadReorderSuggestions()`.
Neither `store-{id}` nor `brand-{id}` needs a change.

### Tests surface (for reviewers)

- **pgTAP** (`supabase/tests/`): assert `report_reorder_list` emits `has_po` per
  vendor. Fixture cases — (1) a non-cancelled PO at `(store, vendor, as_of_date)`
  → `has_po = true`; (2) a `cancelled` PO only → `has_po = false`; (3) a PO at a
  DIFFERENT `reference_date` → `has_po = false`; (4) a legacy `reference_date =
  null` draft → `has_po = false`; (5) two vendors, PO for A only → A true / B
  false. Reuse the `auth_can_see_store` test harness the other reorder pgTAP
  tests use.
- **jest**: (a) `mapReorderVendor` maps `has_po` → `hasPo` and defaults absent to
  `false`; (b) per-vendor payload narrowing produces a single-vendor
  `{ vendors:[v], kpis: computeReorderKpis([v]) }`; (c) `CreatePoButton` renders
  "PO CREATED" disabled when `hasPo` is true and does not call `createPoDraft`.
  Run the FULL `npx jest` (a stale reorder/EOD test could pin old behavior).

### Risks and tradeoffs (explicit)

- **Migration ordering.** `20260718000000` must sort after `20260717000000`
  (it does) and be `db push`ed to prod, then verified via the
  `db-migrations-applied` gate (the local-green / CI-red asymmetry noted in
  CLAUDE.md). This is a `CREATE OR REPLACE` of a hot, frequently-redefined
  function — the developer MUST base it on the *current live* body
  (`20260711000000`), not an older reorder migration, or an unrelated regression
  (include_stocked, spec-104 cost basis, i18n names) silently reverts.
- **Date-string identity is load-bearing.** The `has_po` correctness depends on
  the persisted `reference_date` string equalling `v_as_of_date`. Both derive
  from the same `as_of_date` string (`reorderPayload.asOfDate` ← `envelope.as_of_date`
  ← `to_char(v_as_of_date,'YYYY-MM-DD')`), so they round-trip exactly. If a future
  change introduces a separate date source for create vs. list, this guarantee
  breaks — flagged for reviewers.
- **RLS gap:** none introduced. The disabled button is UX-only; it does not
  prevent a direct INSERT (out of scope, and RLS still store-scopes writes).
- **Performance:** one correlated EXISTS per surfaced vendor (a handful per store)
  against a tiny `purchase_orders` table — negligible on the 286 KB seed and prod.
- **Cold start:** N/A — no edge function.
- **Legacy drafts stay invisible** to the flag by design; if a manager created a
  draft before this spec they will see "+ CREATE PO" again and could create a
  second (now date-keyed) draft. Accepted per Q4 (no backfill). Surfaced as
  expected behavior, not a bug.

## Handoff
next_agent: backend-developer, frontend-developer
prompt: Implement against the ## Backend design in this spec. Backend-developer:
  add migration `20260718000000_reorder_list_has_po.sql` (base on the verbatim
  body of `20260711000000_reorder_list_include_stocked.sql`, single additive
  edit — the `has_po` EXISTS in `vendor_rows`), the `mapReorderVendor` `hasPo`
  mapping and `ReorderVendor` type field, the `createPoDraft` referenceDate
  threading, and pgTAP coverage. Frontend-developer: remove the two global
  CSV/PDF buttons, add per-vendor CSV/PDF (narrowed payload + existing
  import-format path, web-only `showExport` gating), and the disabled
  "PO CREATED" `CreatePoButton` state driven by `vendor.hasPo` (+ en/es/zh i18n
  key), plus jest coverage. After implementation, set Status: READY_FOR_REVIEW
  and list files changed under ## Files changed.
payload_paths:
  - specs/123-reorder-per-vendor-exports-po-created.md

## Files changed (frontend — spec 123)

Frontend-only scope. Backend files (`src/lib/db.ts`, `src/store/useStore.ts`,
`src/types/index.ts`, the `20260718000000_reorder_list_has_po.sql` migration,
pgTAP) are owned by the parallel backend-developer pass and were NOT touched here.

- `src/screens/cmd/sections/ReorderSection.tsx`
  - Removed the two GLOBAL top-of-screen CSV/PDF buttons from the TabStrip
    rightSlot; kept the date picker + REFRESH. Removed the now-unused
    `onCsvPress`/`onPdfPress` callbacks and the main-component `locale` /
    `vendorsList` / `inventory` selectors they used.
  - Added `ReorderVendorExportButtons` — per-vendor CSV + PDF in each
    `VendorCard` footer (web-only, gated by the existing `showExport`, threaded
    as a `VendorCard` prop). Narrows the payload to one vendor via the new
    exported `narrowReorderToVendor(payload, vendor)` helper and feeds the SAME
    `buildReorderCsv` / `handlePdfExport` builders (no signature change). The
    US Foods / SYSCO import-format path (`pickImportVendor` / `handleImportExport`)
    now runs against the single-vendor narrowed payload. testIDs
    `reorder-export-csv-${vendorId}` / `reorder-export-pdf-${vendorId}`.
  - `CreatePoButton`: when `vendor.hasPo` is true, renders a disabled, muted
    "PO CREATED" chip (no press handler → cannot create a duplicate draft),
    keeping the `reorder-create-po-${vendorId}` testID; unchanged
    confirm→create→toast when false. Reads via a small `vendorHasPo(v)` helper
    (`v.hasPo ?? false`) so an older/absent field defaults to "no PO".
- `src/i18n/en.json`, `src/i18n/es.json`, `src/i18n/zh-CN.json`
  - Added `section.reorder.poCreatedLabel` and `section.reorder.poCreatedAria`
    (all three locales, parity kept).
- `src/screens/cmd/sections/__tests__/ReorderSection.spec123.test.tsx` (new)
  - Unit-tests `narrowReorderToVendor` (single vendor + recomputed KPIs +
    preserved envelope fields); per-vendor CSV/PDF buttons render while the
    global export testIDs are gone; per-vendor CSV press calls `buildReorderCsv`
    with a single-vendor narrowed payload; `hasPo:true` renders a disabled
    "PO CREATED" that does not call `createPoDraft`; `hasPo:false` renders a
    pressable "+ CREATE PO"; two vendors are independent.

### Verification
- `npx tsc --noEmit` — clean.
- `npx jest` (full) — 107 suites / 1213 tests green, incl. the 6 new spec-123
  tests and the pre-existing ReorderSection / ReorderSectionCases suites.
- Combined tree: the parallel backend pass (db.ts `mapReorderVendor` hasPo,
  `ReorderVendor.hasPo` type, `createPoDraft` referenceDate threading, the
  `20260718000000_reorder_list_has_po.sql` migration + pgTAP) landed in the
  working tree during this pass. `npx tsc --noEmit` and full `npx jest` were
  re-run against the combined tree and are both green.
- Browser: not run live. Preview tooling is not available in this environment;
  the live golden path additionally needs a store with seeded reorder data (EOD
  counts) to surface vendor cards. The new jest tests render the real
  `ReorderSection` with `Platform.OS='web'` and assert the per-vendor export
  buttons, the removal of the global buttons, the single-vendor narrowing, and
  the disabled "PO CREATED" state — the reliable proxies for the web-only
  behavior.
