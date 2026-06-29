# Spec 102: Multi-vendor ingredients (shared on-hand, per-vendor cost)

Status: READY_FOR_REVIEW

## Summary

Today an inventory item belongs to exactly one vendor via the scalar
`inventory_items.vendor_id`. Managers want a single ingredient (e.g. "French
Fries") to be orderable from more than one vendor (e.g. US FOOD **and** Sysco),
so the item appears in each of those vendors' EOD count and reorder lists.

The physical stock stays **one shared on-hand quantity** — assigning an item to
multiple vendors only changes where it *appears*, never how much there is. What
**is** per-vendor is the **cost** (US FOOD French Fries $10, Sysco French Fries
$8) and, by extension, the reorder estimate. Per-vendor cost does not exist
today and must be added.

## Current state (verified against code, 2026-06-29)

- **Item↔vendor link is 1:1.** `inventory_items.vendor_id` is a single nullable
  FK — [supabase/migrations/20260405000759_init_schema.sql:61](supabase/migrations/20260405000759_init_schema.sql). No junction table exists.
- **Cost is one number per item.** `inventory_items.cost_per_unit` and
  `inventory_items.case_price`; brand defaults `catalog_ingredients.default_cost`
  / `default_case_price`. There is no per-vendor cost table anywhere.
- **EOD submissions are keyed `(store_id, date, vendor_id)`** —
  [supabase/migrations/20260514120000_eod_submissions_vendor_id.sql](supabase/migrations/20260514120000_eod_submissions_vendor_id.sql).
  The per-item on-hand write is **vendor-scoped**: `UPDATE inventory_items SET
  eod_remaining=… WHERE id=… AND vendor_id=submission.vendorId` —
  [src/lib/db.ts:636-641](src/lib/db.ts). An entry written under a non-matching
  vendor lands an `eod_entries` row but skips the item mutation.
- **Reorder RPC `report_reorder_list`** joins each item 1:1 to its vendor,
  filters `ii.vendor_id IS NOT NULL`, groups by vendor, and computes
  `estimated_cost = suggested_qty * cost_per_unit` from the single item cost. It
  is already schedule/delivery-day aware via `order_schedule` (per-vendor
  next-delivery offset) — [supabase/migrations/20260514130000_report_reorder_list.sql](supabase/migrations/20260514130000_report_reorder_list.sql).
- **Admin EOD vendor tabs** filter `storeInventory.filter(i => i.vendorId ===
  selectedVendorId)` — [src/screens/cmd/sections/EODCountSection.tsx:271-274](src/screens/cmd/sections/EODCountSection.tsx).
  The count-everything gate + live "X of N counted" label (shipped 2026-06-28,
  commits 638fe08 / 0fc51f7) count against the items in the selected vendor's
  tab.
- **Staff EOD** fetches items `.eq('vendor_id', vendorId)` —
  [src/screens/staff/screens/EODCount.tsx:124-150](src/screens/staff/screens/EODCount.tsx);
  vendors-for-today come from `order_schedule`.
- **Item editor** is a single "primary vendor" picker —
  [src/components/cmd/IngredientForm.tsx:947-956](src/components/cmd/IngredientForm.tsx),
  written as scalar `vendor_id` via `createInventoryItem` / `updateInventoryItem`
  ([src/lib/db.ts:272-382](src/lib/db.ts)).
- **Staff Weekly count** ([src/screens/staff/screens/WeeklyCount.tsx](src/screens/staff/screens/WeeklyCount.tsx),
  spec 098) is a full-store advisory snapshot — not vendor-scoped, no ordering.

## User stories

### US-1 — Assign an ingredient to multiple vendors (item editor)
As a **store manager**, I want to assign an inventory item to **more than one
vendor**, each with its own cost and case price, so the item shows up in each of
those vendors' count and reorder lists with the correct cost.

### US-2 — Count a shared item under any of its vendors (admin EOD)
As a **store manager doing the EOD count**, I want a shared item to appear under
**each** of its assigned vendor tabs, and counting it under any one tab to
update the **single** shared on-hand, so I never have to count "French Fries"
twice and the two tabs never disagree on quantity.

### US-3 — Count a shared item under any scheduled vendor (staff EOD)
As a **staff member doing the nightly count**, I want a shared item to appear
under **each** of its assigned vendors that are scheduled for today, with the
same shared on-hand behavior as US-2.

### US-4 — Reorder picks the scheduled vendor at its own cost (reorder)
As a **store manager reviewing the reorder list**, I want a shared item to be
ordered from whichever vendor is **scheduled to order that day**, priced at
**that vendor's** per-vendor cost, so each vendor card reflects what I actually
buy from that vendor on that day.

### US-5 — Weekly count warns on low stock vs. next delivery (weekly)
As a **store manager (or staff) reviewing the weekly full-store count**, I want
each ingredient to **warn** when its on-hand is **too low to last until its next
delivery date**, so I catch shortfalls the schedule-driven reorder would
otherwise only surface on the vendor's order day. The weekly screen remains
**advisory only** — it does **not** place or suggest orders.

## Acceptance criteria

Grouped by sub-area. Exact SQL shapes are the architect's call; behavior and
payload contracts below are binding.

### AC-A — Data model & migration
- [ ] A many-to-many relationship exists linking an inventory item to one or
      more vendors, carrying a **per-(item, vendor) cost** (`cost_per_unit` and
      `case_price` at minimum). One item may have N≥0 vendor links.
- [ ] An existing single-vendor item (prod) is **backfilled** into the new
      structure: each item with a non-null `vendor_id` produces exactly one
      link row carrying that item's current `cost_per_unit` and `case_price` as
      the per-vendor cost. Item count and total cost are unchanged immediately
      after migration (no data loss, no double-counting).
- [ ] Items with `vendor_id IS NULL` produce **zero** link rows and continue to
      behave as today (absent from vendor tabs and reorder cards).
- [ ] The disposition of `inventory_items.vendor_id` (kept as primary/default
      vs. dropped) is decided by the architect per OQ-2; whichever path, the
      migration is reversible-by-design and the backfill is idempotent.
- [ ] Re-running the migration (or its data backfill) on already-migrated data
      does not duplicate link rows.

### AC-B — RLS on the new structure
- [ ] The new link table is **store-scoped** and its RLS policies mirror
      `inventory_items` (read/write gated by `auth_can_see_store()` for the
      owning store; admin/privileged paths consistent with current item
      policies). A user who cannot see a store cannot read or write that store's
      item↔vendor links.
- [ ] The pgTAP permissive-policy lint (spec 053) stays green — no new
      trivially-wide permissive policy on `public.*` lands without an explicit
      allowlist entry.

### AC-C — Item editor (admin Cmd UI)
- [ ] The IngredientForm replaces the single "primary vendor" picker with an
      affordance to attach **multiple** vendors, each with its own editable
      cost and case price.
- [ ] Saving an item with vendors V1+V2 persists two link rows with their
      respective costs; removing a vendor removes its link row; editing a
      vendor's cost updates only that link.
- [ ] The form prevents attaching the **same vendor twice** to one item.
- [ ] Backward compatible: an item that previously had one vendor opens showing
      that vendor with its existing cost, and can be saved without change with
      no data drift.

### AC-D — Admin EOD count
- [ ] A shared item assigned to V1 and V2 appears under **both** V1's and V2's
      vendor tab (subject to the existing day-schedule filter +
      show-unscheduled override).
- [ ] Entering a count for the shared item under **either** tab updates the
      **single** shared on-hand; switching to the other tab shows the same
      value (the two tabs never disagree).
- [ ] The count-everything gate and the "X of N counted" label remain coherent:
      a shared item that has been counted reads as counted in **every** tab it
      appears in (it is not re-counted as a fresh uncounted item per tab). The
      architect specifies whether "N" counts the item once globally or once per
      tab; either way an item counted once must not show as an outstanding gap
      in another tab.

### AC-E — Staff EOD count
- [ ] Same appears-under-each-scheduled-vendor and shared-on-hand behavior as
      AC-D, on the staff surface.
- [ ] The staff fetch returns a shared item for each of its assigned vendors
      that is scheduled today (replacing the current single `.eq('vendor_id',…)`
      filter).

### AC-F — EOD submission consistency
- [ ] When a shared item is referenced by **more than one** vendor submission on
      the same day, the resulting shared on-hand is a **single** consistent
      value (the same physical count), not two competing writes that depend on
      submission order. The architect specifies the reconciliation rule (e.g.
      shared on-hand keyed by item, not by `(item, vendor)`), and the vendor-
      scoped `.eq('vendor_id', …)` write at [src/lib/db.ts:640](src/lib/db.ts)
      is reconciled so a shared item's on-hand is not silently dropped when
      counted under a non-matching vendor.
- [ ] The `eod_submissions (store_id, date, vendor_id)` uniqueness is unaffected
      — this spec does not change submission identity, only how a shared item's
      on-hand is resolved across submissions.

### AC-G — Reorder RPC + screens
- [ ] `report_reorder_list` explodes a shared item to the vendor that is
      **scheduled to order on the as-of day**, and prices its
      `estimated_cost` using **that vendor's** per-vendor cost (not a single
      item cost).
- [ ] The existing schedule/delivery-day grouping, next-delivery math, hybrid
      `suggested_qty` formula, and per-vendor KPIs continue to work; the payload
      envelope shape (`{vendors[], kpis, _warnings, as_of_date}`) is unchanged.
- [ ] On **non-overlapping** schedule days, a shared item appears under exactly
      one vendor card on a given day (no double-ordering) — naturally, because
      only the scheduled vendor is exploded that day.
- [ ] The **coincident-schedule** behavior (two of an item's vendors scheduled
      the same day) is implemented per the resolution of OQ-1.
- [ ] Reorder screens ([src/screens/cmd/sections/ReorderSection.tsx](src/screens/cmd/sections/ReorderSection.tsx)
      and the staff reorder) render the exploded per-vendor rows + per-vendor
      cost without client-side changes beyond consuming the (unchanged-shape)
      payload.

### AC-H — Weekly count low-stock warning
- [ ] The weekly full-store count shows, per ingredient, on-hand and a
      **low-stock warning** when projected on-hand will not cover usage until
      that ingredient's **next delivery date**.
- [ ] "Next delivery date" for a multi-vendor item is computed per the
      resolution of OQ-4 (nearest delivery across all its vendors, unless the
      architect/user choose per-vendor).
- [ ] The weekly screen remains advisory: it surfaces the warning and the
      remaining quantity only — it does **not** create orders, reorder
      suggestions, or PO drafts.

### AC-I — Tests
- [ ] **pgTAP** (track per [tests/README.md](tests/README.md)): the backfill
      idempotency + count/cost-preservation (AC-A), the new RLS policies
      (AC-B), and the reorder explosion + per-vendor cost (AC-G) are covered.
- [ ] **jest**: the item-editor multi-vendor add/remove/dup-guard mapping
      (AC-C) and the shared-on-hand "counted in every tab" gate logic (AC-D) are
      covered at the unit/store level.
- [ ] Existing reorder pgTAP and EOD jest suites are updated (not deleted) to
      reflect the new behavior; no suite is left pinning the old single-vendor
      shape (cf. the stale-EOD-test-turned-main-red incident).

## In scope
- Many-to-many item↔vendor data model with per-(item, vendor) cost +
  case_price, plus a backward-compatible, idempotent backfill of existing
  single-vendor items.
- RLS on the new structure, store-scoped, mirroring `inventory_items`.
- Item-editor UI to attach/detach multiple vendors with per-vendor cost.
- Admin + staff EOD: shared item under each (scheduled) vendor tab; single
  shared on-hand; coherent count-everything gate / "X of N" label.
- EOD submission consistency for shared items across multiple same-day vendor
  submissions.
- Reorder RPC + screens: schedule-driven per-vendor explosion at per-vendor
  cost.
- Weekly count: advisory low-stock-vs-next-delivery warning.
- Tests across the three tracks per AC-I.

## Out of scope (explicitly)
- **Separate per-vendor stock.** On-hand is one shared physical quantity per
  item — we are NOT tracking distinct inventory per vendor. (User decision 1.)
- **Weekly-count ordering.** The weekly screen stays advisory; no PO/reorder
  generation there. (User decision 4.)
- **PO write path / `po_items` population.** The reorder RPC's `pending_po_qty`
  stays 0 in this spec exactly as today; the v2 PO-subtraction is a separate
  follow-up (per the existing `report_reorder_list` header). Not reopened here.
- **Vendor SKU per item.** `vendor sku` is still "schema pending" in the form
  ([src/components/cmd/IngredientForm.tsx:958](src/components/cmd/IngredientForm.tsx));
  this spec adds per-vendor cost, not per-vendor SKU. Surfaced only because it's
  adjacent — rationale: keep the change to the user's stated need (multi-vendor
  + per-vendor cost).
- **Realtime for the staff surface.** Staff stack has no realtime in v1 (specs
  062/063); this spec does not add it. The admin realtime reload already covers
  inventory/vendor changes via `store-{id}` — see Project-specific notes.
- **Customer PWA / `pwa-catalog`.** This is the admin+staff repo; the customer
  PWA folds in via a future spec and is untouched.
- **Changing the brand-default cost model.** `catalog_ingredients.default_cost`
  semantics are unchanged; per-vendor cost is a store-level item concept.

## Open questions (for architect / user — do NOT assume)
- **OQ-1 — Coincident schedules.** If two of an item's vendors are scheduled to
  order the **same day**, does the item appear in **both** vendor cards (manager
  picks which to actually buy), or is there a tiebreak/primary that wins?
  *(Recommendation to evaluate: surface in both with a "also available from N"
  hint to avoid silently hiding an option — but this risks the double-order the
  schedule split was meant to prevent. Architect/user decide.)*
- **OQ-2 — `inventory_items.vendor_id` disposition.** Keep it as a
  "primary/default vendor" pointer (and have the link table carry the rest), or
  drop it entirely and move all item↔vendor truth into the link table? Affects
  the backfill shape, the form's "primary" concept, and the on-hand-write
  reconciliation at [src/lib/db.ts:640](src/lib/db.ts).
- **OQ-3 — Par / reorder level scope.** Is `par_level` (and any reorder
  threshold) **per-item (shared)** or **per-vendor**? User confirmed on-hand is
  shared; par is presumed shared, but this directly changes the reorder math
  (`par_replacement = par_level - on_hand - …`). Confirm.
- **OQ-4 — Weekly "next delivery date" for a multi-vendor item.** Nearest
  delivery across **all** its vendors' schedules, or per-vendor (and the warning
  is per-vendor)? Nearest-across-all is the simpler advisory; confirm.
- **OQ-5 — Per-vendor cost vs. fallback.** Does per-vendor cost **replace**
  `inventory_items.cost_per_unit` entirely, or does the item keep a default cost
  as a fallback (e.g. for an item with zero vendors, or for non-reorder cost
  displays like COGS/variance reports that read `cost_per_unit` today)? COGS and
  variance runners read `inventory_items.cost_per_unit` — dropping it has blast
  radius beyond reorder.
- **OQ-6 — Surface scope.** Admin + staff, or staff-only? Recent count features
  (counted-everything gate, ingredient-name search) were scoped per surface.
  This spec is written **admin + staff** (US-1/US-2/US-4 are admin; US-3 is
  staff; US-5 is both); confirm before build so a surface isn't built that
  wasn't wanted.

## Dependencies
- New migration(s): the link table, its RLS, the backfill, and per-vendor cost
  columns.
- `report_reorder_list` RPC rewrite (schedule-driven per-vendor explosion at
  per-vendor cost) — [supabase/migrations/20260514130000_report_reorder_list.sql](supabase/migrations/20260514130000_report_reorder_list.sql).
- EOD on-hand write reconciliation — [src/lib/db.ts:636-641](src/lib/db.ts) and
  the staff fetch — [src/screens/staff/screens/EODCount.tsx:124-150](src/screens/staff/screens/EODCount.tsx).
- Item editor — [src/components/cmd/IngredientForm.tsx](src/components/cmd/IngredientForm.tsx)
  + `createInventoryItem`/`updateInventoryItem` in [src/lib/db.ts:272-382](src/lib/db.ts).
- Admin EOD section vendor-tab filter + count gate —
  [src/screens/cmd/sections/EODCountSection.tsx:271-274](src/screens/cmd/sections/EODCountSection.tsx).
- Weekly count — [src/screens/staff/screens/WeeklyCount.tsx](src/screens/staff/screens/WeeklyCount.tsx).
- Admin store ([src/store/useStore.ts](src/store/useStore.ts)) item↔vendor shape
  for the editor + EOD tabs.
- pgTAP runner ([scripts/test-db.sh](scripts/test-db.sh)) and jest.

## Project-specific notes
- **Cmd UI section / legacy:** Admin work lands in the existing item editor
  ([src/components/cmd/IngredientForm.tsx](src/components/cmd/IngredientForm.tsx))
  and `src/screens/cmd/sections/` (EOD, Reorder). No legacy admin surface (spec
  025 deleted it). Staff work lands in [src/screens/staff/](src/screens/staff/).
- **Per-store or admin-global:** Per-store. Item↔vendor links are store-scoped
  and must respect `auth_can_see_store()` (per-store RLS hardening).
- **Realtime channels touched:** `store-{id}` — item↔vendor link and per-vendor
  cost changes must reach other admin clients live (the debounced 400 ms reload
  in [src/hooks/useRealtimeSync.ts](src/hooks/useRealtimeSync.ts)). **Risk /
  gotcha:** a NEW table added to the realtime publication mid-session needs
  `docker restart supabase_realtime_imr-inventory` to re-snapshot the slot
  locally, or live updates for the new table silently won't fire. Staff stack
  has no realtime in v1 — unchanged.
- **Edge function or PostgREST:** PostgREST + the `report_reorder_list` Postgres
  RPC (via `src/lib/db.ts`). No edge function expected. If the architect needs
  server logic for on-hand reconciliation, prefer an RPC over a new edge
  function to stay on the JWT-protected path.
- **Migrations needed:** Yes — link table + RLS + per-vendor cost + idempotent
  backfill, and a `report_reorder_list` rewrite. Migration must be `supabase db
  push`ed to prod or the `db-migrations-applied` CI gate goes red.
- **Edge functions touched:** None expected.
- **Web/native scope:** Web + native (admin Cmd UI ships to Vercel; staff EOD
  ships to both). No web-only or native-only affordances in this feature.
- **`app.json` slug:** Not touched. (Flagged per policy; this feature has no
  build-identifier impact.)
- **Tests:** All three tracks — pgTAP (model/RLS/reorder), jest (editor mapping
  + count-gate logic). No new shell smoke is strictly required; the
  test-engineer routes per AC-I.
```

---

# Backend design

Authored by backend-architect, 2026-06-29. All six open questions are
RESOLVED per the dispatch; this design implements those resolutions and does
not re-open them. Two **new sub-decisions** (SD-1, SD-2) and one **found gap**
(FG-1, a second vendor-scoped on-hand write the spec brief did not name) are
flagged inline and must be honored by the implementers.

## 0. Decisions register (read first)

- **SD-1 — primary representation.** `inventory_items.vendor_id` stays the
  **single source of truth** for "which link is primary." The junction
  (`item_vendors`) carries an `is_primary boolean not null default false`
  that is a **derived mirror** of the scalar, kept consistent by the writer
  in `db.ts` (the create/update helpers below set exactly one `is_primary=true`
  row, matching `vendor_id`). Rationale: OQ-2 says keep `vendor_id` as the
  primary pointer AND have the junction carry all links. Two independent
  "is this primary?" truths invite drift; making the scalar authoritative and
  the boolean a mirror gives the reorder/EOD joins a column to read without a
  correlated lookup back to `inventory_items`, while the scalar remains the
  one place a write must touch to re-point primary. A partial unique index
  enforces "≤1 primary per item" defensively. The boolean is **not** read by
  any reorder/EOD logic in this spec — it exists for the editor UI and future
  "primary wins" features; reorder explodes by **schedule**, not by primary
  (OQ-1).
- **SD-2 — low-stock warning is server-computed via a new tiny RPC**
  (`report_weekly_lowstock(p_store_id, p_params)`), not client-side. Rationale:
  the "nearest next delivery" date requires the same DOW/cutoff offset math the
  reorder RPC already encodes (`vendor_delivery_offsets`, lines 344-409 of the
  current body). Re-deriving that in TS in `WeeklyCount.tsx` would fork a
  subtle, well-tested algorithm onto the advisory surface. A small read-only
  RPC reuses the pattern and stays on the JWT-protected `security invoker` path
  (per spec note "prefer an RPC over a new edge function").
- **FG-1 — there are TWO vendor-scoped on-hand writes, not one.** The spec
  brief names only `src/lib/db.ts:636-641` (admin path). The **staff** path
  writes the identical predicate inside the `staff_submit_eod` RPC —
  [supabase/migrations/20260601000000_staff_submit_eod_cases_each.sql:210-215](supabase/migrations/20260601000000_staff_submit_eod_cases_each.sql)
  (`update inventory_items set current_stock=…, eod_remaining=… where id=… and
  vendor_id = p_vendor_id`). A shared item counted under a non-primary vendor
  would have its on-hand silently dropped on the staff surface too (AC-E /
  AC-F break). **Both** writes must be reconciled identically (§5). The admin
  store's optimistic mirror at [src/store/useStore.ts:1686-1711](src/store/useStore.ts)
  is a **third** copy of the same predicate (`itemMatchesSubmittedVendor`) and
  must move in lockstep or the optimistic UI disagrees with the server (§7).

- **Migration-body drift trap (reorder RPC).** The current effective body of
  `report_reorder_list` is **NOT** the 20260514 file. It is
  [supabase/migrations/20260623000000_reorder_list_i18n_names.sql](supabase/migrations/20260623000000_reorder_list_i18n_names.sql)
  (the latest `create or replace`), which is the 20260514 body **plus** spec
  088 case math **plus** spec 100 i18n keys. The rewrite migration MUST copy
  **that** body as its baseline (the function-header rule both prior migrations
  state verbatim). Copying the spec-021-era body silently reverts spec 088 +
  100. The illustrative diff in §4 is expressed against the *latest* body.

## 1. Data model — `item_vendors` junction

New migration: `supabase/migrations/20260630000000_item_vendors.sql`
(additive; non-destructive — `inventory_items.vendor_id`,
`inventory_items.cost_per_unit`, `inventory_items.case_price` all stay per
OQ-2 / OQ-5).

```sql
create table if not exists public.item_vendors (
  id            uuid primary key default uuid_generate_v4(),
  item_id       uuid not null references public.inventory_items(id) on delete cascade,
  vendor_id     uuid not null references public.vendors(id)         on delete cascade,
  cost_per_unit numeric(10,2) default 0,   -- per-(item,vendor) cost (OQ-5 additive)
  case_price    numeric(10,2) default 0,   -- per-(item,vendor) case price
  is_primary    boolean not null default false,  -- SD-1: derived mirror of inventory_items.vendor_id
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint item_vendors_item_vendor_unique unique (item_id, vendor_id)
);

-- Reorder/EOD lookup paths: "all vendors for this item" and
-- "all items for this vendor". Both are hot in the explode/fetch joins.
create index if not exists item_vendors_item_id_idx   on public.item_vendors (item_id);
create index if not exists item_vendors_vendor_id_idx on public.item_vendors (vendor_id);

-- SD-1 enforcement: at most one primary link per item.
create unique index if not exists item_vendors_one_primary_per_item
  on public.item_vendors (item_id) where is_primary;
```

**Store scoping is transitive** via `item_id → inventory_items.store_id`. No
redundant `store_id` column. Justification: (a) `inventory_items` is the
existing per-store anchor and already RLS-gated by store; (b) a denormalized
`store_id` would need a trigger or app-discipline to stay consistent with the
item's store and is pure drift surface; (c) the RLS policy (§2) joins to
`inventory_items` exactly as the existing child-table policies do for
`eod_entries`/`po_items`/`pos_import_items` (the per-store-RLS-hardening
pattern). The composite unique `(item_id, vendor_id)` is the editor's
dup-guard backstop (AC-C "prevents attaching the same vendor twice").

`cost_per_unit` / `case_price` semantics mirror `inventory_items` (numeric(10,2),
default 0). **Per OQ-5 these are additive**: `inventory_items.cost_per_unit`
stays the COGS/variance fallback and is untouched.

### 1a. Backfill (idempotent, reversible-by-design)

Same migration file, after the DDL:

```sql
insert into public.item_vendors (item_id, vendor_id, cost_per_unit, case_price, is_primary)
select ii.id, ii.vendor_id,
       coalesce(ii.cost_per_unit, 0), coalesce(ii.case_price, 0), true
  from public.inventory_items ii
 where ii.vendor_id is not null
on conflict (item_id, vendor_id) do nothing;   -- idempotent: re-run = no dup rows (AC-A)
```

- Items with `vendor_id IS NULL` produce **zero** rows (AC-A) — the `where`
  excludes them; they stay absent from vendor tabs and reorder cards.
- Each backfilled row is `is_primary = true` and carries the item's *current*
  `cost_per_unit` + `case_price` (AC-A "count and total cost unchanged
  immediately after migration").
- **Idempotent** via `on conflict … do nothing` on the composite unique
  (AC-A re-run requirement). Re-running the whole migration is a no-op:
  `create table if not exists`, `create index if not exists`, conflict-skipped
  insert.
- **`supabase db push`-compatible** (the `db-migrations-applied` CI gate): pure
  forward DDL + idempotent DML, no `supabase`-CLI-only constructs.
- **Reversible-by-design:** a down-path is `drop table public.item_vendors
  cascade;` — `inventory_items.vendor_id` was never dropped, so the system
  returns exactly to single-vendor behavior with no data reconstruction. (We
  do not ship a down migration file — the project has no down-migration
  convention — but the design is reversible by that one statement.)

## 2. RLS — mirrors `inventory_items`, store-scoped via the parent join

`item_vendors` has no `store_id`, so policies join to `inventory_items` and
gate on `auth_can_see_store(ii.store_id)` — identical shape to the
`eod_entries` / `po_items` policies in
[20260504173035_per_store_rls_hardening.sql](supabase/migrations/20260504173035_per_store_rls_hardening.sql).
All four commands. Same migration file:

```sql
alter table public.item_vendors enable row level security;

create policy "store_member_read_item_vendors"   on public.item_vendors for select
  using (exists (select 1 from public.inventory_items ii
                  where ii.id = item_vendors.item_id
                    and public.auth_can_see_store(ii.store_id)));

create policy "store_member_insert_item_vendors" on public.item_vendors for insert
  with check (exists (select 1 from public.inventory_items ii
                       where ii.id = item_vendors.item_id
                         and public.auth_can_see_store(ii.store_id)));

create policy "store_member_update_item_vendors" on public.item_vendors for update
  using      (exists (select 1 from public.inventory_items ii
                       where ii.id = item_vendors.item_id
                         and public.auth_can_see_store(ii.store_id)))
  with check (exists (select 1 from public.inventory_items ii
                       where ii.id = item_vendors.item_id
                         and public.auth_can_see_store(ii.store_id)));

create policy "store_member_delete_item_vendors" on public.item_vendors for delete
  using (exists (select 1 from public.inventory_items ii
                  where ii.id = item_vendors.item_id
                    and public.auth_can_see_store(ii.store_id)));
```

- **Privileged paths** are covered automatically: `auth_can_see_store()`
  already returns true for admins/masters via `auth_is_admin()` (it is defined
  as `auth_is_admin() OR exists(user_stores …)`). No separate admin policy
  needed — consistent with how `inventory_items` itself does it (no standalone
  admin policy on that table either).
- **spec-053 permissive-policy lint stays green (AC-B):** none of these four
  policies is trivially-wide. Each USING/WITH CHECK is an `exists(... and
  auth_can_see_store(...))` — the helper call is the head token, not
  `auth.uid() IS NOT NULL` / `true` / `auth.role() = 'authenticated'`, and
  there is no OR-tail. **No allowlist entry is required or added.** The lint's
  arm (1)/(2) detection regex does not match a predicate whose only token is a
  helper-function call.
- **Grants:** `item_vendors` is a normal table read/written via PostgREST under
  the caller's JWT. It inherits the project's explicit `public.*` grant posture
  from [20260618000000_public_grants_explicit.sql](supabase/migrations/20260618000000_public_grants_explicit.sql);
  the implementer must confirm `authenticated` has table-level
  `select/insert/update/delete` (add an explicit grant in this migration if the
  blanket grant migration does not auto-cover newly created tables — verify
  locally, this is the spec-097 silent-grant-revocation class).

## 3. Realtime

`item_vendors` writes (add/remove a vendor link, edit a per-vendor cost) must
reach other **admin** clients live so a second manager's EOD tabs / item editor
reflect the change. Add `item_vendors` to the `supabase_realtime` publication
in the migration:

```sql
alter publication supabase_realtime add table public.item_vendors;
```

- **Channel:** `store-{id}`. [useRealtimeSync.ts](src/hooks/useRealtimeSync.ts)
  already subscribes `postgres_changes` on the store channel with a debounced
  400ms full reload; a new table in the publication is picked up by the
  existing wildcard subscription (verify the hook subscribes by-schema/`*` and
  not an explicit per-table list — if it lists tables explicitly, add
  `item_vendors` there too). The 400ms reload re-runs `fetchInventory`, which
  will carry the new `vendors[]` embed (§6), so the editor + EOD tabs
  re-derive.
- **PUBLICATION GOTCHA (deploy/dev step, not runtime):** adding a table to
  `supabase_realtime` mid-session requires
  `docker restart supabase_realtime_imr-inventory` after `npm run dev:db` for
  local live updates to fire — the replication slot must re-snapshot its table
  set. This is the documented gotcha (CLAUDE.md "Realtime publication gotcha" +
  the spec's own Project-specific note). **Flag in the PR description and the
  local-verification steps.** Not a code concern; a container-restart concern.
- **Staff stack:** no realtime in v1 (specs 062/063) — unchanged. Staff re-reads
  on vendor/store switch.

## 4. `report_reorder_list` rewrite — explode shared items to scheduled vendors

Baseline = the **latest** body
([20260623000000_reorder_list_i18n_names.sql](supabase/migrations/20260623000000_reorder_list_i18n_names.sql)),
copied verbatim, then the hunks below. New migration:
`supabase/migrations/20260630000100_report_reorder_list_multi_vendor.sql`
(ordered AFTER `20260630000000_item_vendors.sql` so the table exists). Envelope
shape `{vendors[], kpis, _warnings, as_of_date}` is **unchanged** (AC-G).
`security invoker` and the GRANT are byte-identical → preserved by
`create or replace`.

**The core change is in CTE `(4f) item_on_hand`.** Today it joins each item
1:1 to `inventory_items.vendor_id` and filters `ii.vendor_id IS NOT NULL`
(lines 281-289). Replace the item→vendor source with a join to
`item_vendors`, so a shared item produces **one row per linked vendor**, each
carrying that vendor's per-vendor cost (falling back to the item cost):

```sql
-- (4f) item_on_hand — now item × linked-vendor (was item 1:1 vendor_id).
item_on_hand as (
  select
    ii.id                                              as item_id,
    ii.store_id,
    iv.vendor_id,                                      -- from junction, not ii.vendor_id
    ii.catalog_id,
    ii.par_level::numeric                              as par_level,       -- OQ-3: per-item, shared
    coalesce(ii.usage_per_portion, 0)::numeric         as usage_per_portion,
    -- OQ-5: per-vendor cost from the junction, FALLBACK to item cost when null/0.
    coalesce(nullif(iv.cost_per_unit, 0), ii.cost_per_unit, 0)::numeric as cost_per_unit,
    coalesce(ii.current_stock, 0)::numeric             as current_stock,
    lev.submission_id,
    lev.submitted_at,
    e.actual_remaining,
    case when lev.submission_id is not null and e.actual_remaining is not null
         then e.actual_remaining::numeric
         else coalesce(ii.current_stock, 0)::numeric end as on_hand,
    case when lev.submission_id is not null and e.actual_remaining is not null
         then 'eod'::text else 'stock'::text end         as item_on_hand_source,
    (lev.submission_id is not null
       and (e.id is null or e.actual_remaining is null))  as eod_missing_for_item
    from public.inventory_items ii
    join public.item_vendors iv  on iv.item_id = ii.id          -- explode by link
    left join latest_eod_per_vendor lev on lev.vendor_id = iv.vendor_id
    left join public.eod_entries e on e.submission_id = lev.submission_id
                                  and e.item_id = ii.id
   where ii.store_id = p_store_id
)
```

Downstream is **structurally unchanged** because everything after `(4f)` already
keys on `(ioh.vendor_id, ioh.item_id)`:

- **Schedule-driven explosion / non-overlap (AC-G, US-4):** `vendor_delivery`
  (4j) and the existing per-vendor next-delivery offsets are unchanged. A
  vendor only surfaces a card when it has suggested rows AND
  (implicitly) when the manager is looking at the day it is scheduled — the
  existing day-grouping/sort by `next_delivery_date` is preserved. On a
  non-overlapping day, the shared item's row under the *non-scheduled* vendor
  carries that vendor's own `next_delivery_date` (its next cycle) — the
  vendor-card sort + the screen's day context already separate them. **No
  double-order on non-overlapping days** falls out naturally: each (item,
  vendor) row is priced and placed under its own vendor's delivery cadence.
- **Per-vendor cost (AC-G):** `estimated_cost` (and the spec-088 case-rounded
  cost) now multiply by the junction cost via the `cost_per_unit` resolved in
  (4f). No formula edit — the column it reads simply changed source.
- **`par_level` / `suggested_qty` (OQ-3):** unchanged shape. `par_level`,
  `usage_per_portion`, `current_stock`, the hybrid `greatest(par_replacement,
  usage_forecasted)` — all per-item, read once, shared across the item's vendor
  rows. (A shared item near par produces the same `suggested_qty` under each of
  its vendors; the manager buys it from one — see the OQ-1 hint below.)

**OQ-1 — coincident-schedule "also from N" hint.** When two of an item's
vendors are scheduled the same as-of day, the item legitimately appears under
**both** cards (resolution: surface in both, accept double-order risk, mitigate
with a hint). The explosion above already produces both rows. Add the hint data
to the per-item `jsonb_build_object` in CTE `(4l) vendors_with_items` — compute,
per (item), the set of OTHER vendors this item is linked to, as an additive
sub-CTE keyed by item:

```sql
-- new sub-CTE before (4l): per item, the full set of linked vendors (id+name).
item_vendor_set as (
  select iv.item_id,
         jsonb_agg(jsonb_build_object('vendor_id', iv.vendor_id,
                                      'vendor_name', v.name)
                   order by v.name) as vendor_links,
         count(*) as vendor_link_count
    from public.item_vendors iv
    join public.vendors v on v.id = iv.vendor_id
    join public.inventory_items ii on ii.id = iv.item_id
   where ii.store_id = p_store_id
   group by iv.item_id
)
```

Then in the per-item object (4l), add TWO additive keys (envelope shape
unchanged — these are new keys inside the existing per-item object, which the
mapper ignores until taught):

```sql
'other_vendor_count', greatest(0, ivs.vendor_link_count - 1),
'also_from_vendors',  coalesce(
   (select jsonb_agg(l) from jsonb_array_elements(ivs.vendor_links) l
     where (l->>'vendor_id')::uuid <> pif.vendor_id), '[]'::jsonb),
```

The UI renders "also available from {other_vendor_count} other vendor(s)"
using `also_from_vendors` for the names. **This is advisory text only — it does
not change which card the item appears on.** `other_vendor_count` is 0 for a
single-vendor item, so existing rendering is unaffected. KPIs (4n) are
unchanged — they still count exploded rows; a shared item scheduled under two
vendors the same day legitimately counts under both (that is the double-order
the manager is being asked to resolve, surfaced honestly).

**Warnings / `_warnings`:** unchanged. The `schedule_unknown` A5 fallback still
applies per vendor.

## 5. EOD on-hand reconciliation (AC-D, AC-E, AC-F) — drop the vendor predicate, key by item-membership

The shared on-hand is keyed by **item**, not `(item, vendor)`. The fix in all
three writers: replace `WHERE id = <item> AND vendor_id = <submission vendor>`
with `WHERE id = <item> AND EXISTS (a link for this submission's vendor)` —
i.e. write the on-hand for any item that is **legitimately countable under the
submitting vendor** (it has a junction row for that vendor), regardless of which
link is "primary." Items with **no** link to the submitting vendor (the
unscheduled-item escape hatch / a truly off-vendor entry) keep the current
skip-the-mutation behavior, preserving the documented escape-hatch invariant.

This is correct and order-independent (AC-F): two same-day vendor submissions
that both include the shared item write the **same** physical count to the
**same** `inventory_items` row (the client sends the same total under each
tab because the on-hand is one value the UI shows identically in both tabs).
Whichever submission lands last writes the same number — no competing writes.

**5a — admin `db.ts` (`submitEODCount`, lines 635-647).** Change the per-entry
update from the `.eq('vendor_id', submission.vendorId)` predicate to a
membership check. Cleanest within PostgREST: keep a guard that the item is
linked to the submitting vendor (so the escape-hatch skip survives), but drop
the *vendor-equality on inventory_items*:

```ts
// was: .eq('id', entry.itemId).eq('vendor_id', submission.vendorId)
// now: write on-hand for the item itself; the item is countable under this
// vendor iff it has an item_vendors link (checked once per submission below).
const upd = await supabase
  .from('inventory_items')
  .update({ eod_remaining: entry.actualRemaining, current_stock: entry.actualRemaining,
            last_updated_by: submission.submittedByUserId })
  .eq('id', entry.itemId)
  .in('id', linkedItemIdsForVendor)   // membership gate; precomputed (see below)
  .abortSignal(signal);
```

where `linkedItemIdsForVendor` is fetched once at the top of `submitEODCount`:
`select item_id from item_vendors where vendor_id = submission.vendorId` (the
items the vendor legitimately covers at this store, RLS-scoped). An entry whose
`itemId` is not in that set is the escape-hatch case → no on-hand write (matches
today's behavior). **Note** this also fixes a latent admin-path asymmetry:
today the admin write only sets `eod_remaining`, while the staff RPC sets BOTH
`current_stock` and `eod_remaining`; aligning the admin write to set both makes
the two surfaces consistent (the admin store *already* mirrors `currentStock`
optimistically at useStore.ts:1699, so the server now matches the optimistic
state). Implementer: confirm this with the test-engineer — it is a deliberate
consistency fix, not scope creep, and the `eod_submissions_edit_flow` /
`eod_submissions_consistency` pgTAP suites must be checked for any assertion
that pins admin-writes-only-eod_remaining.

**5b — staff `staff_submit_eod` RPC (FG-1).** New migration
`supabase/migrations/20260630000200_staff_submit_eod_multi_vendor.sql`,
`create or replace` copying the **latest** body
([20260601000000_staff_submit_eod_cases_each.sql](supabase/migrations/20260601000000_staff_submit_eod_cases_each.sql))
verbatim with exactly ONE hunk: the inventory write (lines 210-215) changes its
predicate from `and vendor_id = p_vendor_id` to a junction-membership check:

```sql
update public.inventory_items ii
   set current_stock = v_entry.actual_remaining,
       eod_remaining = v_entry.actual_remaining,
       updated_at = now()
 where ii.id = v_entry.ingredient_id
   and exists (select 1 from public.item_vendors iv
                where iv.item_id = ii.id
                  and iv.vendor_id = p_vendor_id);   -- was: and ii.vendor_id = p_vendor_id
```

Signature, GRANT, security-definer posture, idempotency, the
`eod_submissions (store,date,vendor)` upsert, the two consistency triggers, and
the audit-log row are **all unchanged** (the audit row still emits for
off-vendor entries — that behavior is preserved; only the on-hand write's gate
changed). **AC-F submission identity is untouched** — this changes only how a
shared item's on-hand resolves, not `eod_submissions` uniqueness.

**5c — admin store optimistic mirror (useStore.ts:1686-1711).** The
`itemMatchesSubmittedVendor = item?.vendorId === subVendorId` guard must become
a **link-membership** check so the optimistic UI matches the server (§7). With
the new inventory shape carrying `vendorIds: string[]` (§6), this is
`item?.vendorIds?.includes(subVendorId)`. Escape-hatch items (no link to the
submitted vendor) still skip the optimistic write, exactly as the server skips
the persisted write.

## 6. EOD fetch + admin tabs + count gate

### 6a. Inventory carries its vendor list (db.ts `fetchInventory` + `mapItem`)

`fetchInventory` adds an `item_vendors` embed alongside the existing
`vendor:vendors(name)` and `catalog:` embeds:

```ts
.select(`*,
  vendor:vendors(name),
  item_vendors:item_vendors(vendor_id, cost_per_unit, case_price, is_primary,
                            vendor:vendors(id, name)),
  updater:profiles!last_updated_by(name),
  catalog:catalog_ingredients(id, name, unit, category, case_qty, sub_unit_size, sub_unit_unit, i18n_names)`)
```

`mapItem` (db.ts:3803) gains a new mapped field (snake_case → camelCase):

```ts
// NEW on InventoryItem (extend src/types/index.ts — frontend-dev lane):
vendors: Array<{ vendorId: string; vendorName: string;
                 costPerUnit: number; casePrice: number; isPrimary: boolean }>;
vendorIds: string[];           // convenience: vendors.map(v => v.vendorId)
```

- `vendorId` / `vendorName` (the existing scalar fields) stay — they remain the
  **primary** pointer (SD-1) for back-compat with every current consumer
  (dashboard, reorder display, the editor's primary picker default).
- `vendors[]` is the full link set with per-vendor cost. `vendorIds` is the
  derived membership array used by the EOD tab filter and the on-hand
  reconciliation guard (§5c).
- Items with no links → `vendors: []`, `vendorIds: []` — render exactly as
  today (absent from every vendor tab).

### 6b. Admin EOD vendor tabs (EODCountSection.tsx)

- **Tab membership** (lines 250-258): the per-vendor item count is derived from
  `vendorIds` instead of the scalar — an item with two links counts toward both
  vendors' tab counts:
  ```ts
  for (const i of storeInventory)
    for (const vid of (i.vendorIds ?? (i.vendorId ? [i.vendorId] : [])))
      counts.set(vid, (counts.get(vid) || 0) + 1);
  ```
- **Items in the selected tab** (`vendorItems`, lines 271-274): change
  `i.vendorId === selectedVendorId` to
  `(i.vendorIds ?? []).includes(selectedVendorId)` so a shared item appears
  under each of its vendor tabs (AC-D, US-2). The day-schedule filter +
  show-unscheduled override (lines 260-264) are unchanged — they gate which
  *vendors* show as tabs, not which items.

### 6c. Count-everything gate / "X of N counted" — COUNTED-ONCE-GLOBALLY (AC-D)

**Decision: "N" counts each distinct item once per (store, date), not once per
tab; a shared item counted under any tab reads as counted in every tab.** This
is the only coherent choice given a single shared on-hand: counting "French
Fries" once is the physical truth, and re-counting it per tab would be the
"count it twice" the spec explicitly forbids.

Mechanism: the gate's "is this row counted?" predicate (`hasEntry`, lines
411-413; the `onSubmit` completeness gate, lines 515-525) currently reads the
**current tab's local input state** (`caseCounts`/`unitCounts`, which are
per-vendor maps keyed `[vendorId][itemId]`). Widen the counted-check to: a row
is counted if it has an entry **in the current tab's inputs OR in any other
tab's inputs for the same item OR in an already-submitted submission for any
vendor this (store,date)**. Concretely, derive a `countedItemIds: Set<string>`
for the (store, date) from (a) all per-vendor input maps and (b)
`eodSubmissions` entries for the date, then `hasEntry(id)` becomes
`localHasEntry(id) || countedItemIds.has(id)`.

- `countedNum`/`total` (lines 413-414) and the "X of N" label (lines 1073-1075,
  1329-1330) stay per-tab in their denominator (N = items in this tab) but the
  numerator credits a shared item that was counted elsewhere → it never shows
  as an outstanding gap in another tab (AC-D binding requirement).
- The red "uncounted" row styling (`rowUncounted`, line 1197) and the
  jump-to-first-gap on blocked submit (lines 515-518) consume the same widened
  predicate, so a shared item counted under tab V1 is not painted red or
  jumped-to under tab V2.
- `buildSubmission` (lines 429-476) is unchanged — it still ships the current
  tab's entered items; the shared item simply isn't a *blocking gap* if already
  counted, and if the manager does enter it under both tabs the server resolves
  to the same on-hand (§5).
- **jest coverage (AC-I):** the `countedItemIds` derivation + the
  "counted in every tab" predicate is the unit under test.

### 6d. Staff EOD fetch (EODCount.tsx `fetchItemsForVendor`, lines 124-166)

Replace the single `.eq('vendor_id', vendorId)` filter with a junction join so a
shared item returns for the selected (scheduled) vendor (AC-E):

```ts
// query item_vendors for the vendor, embedding the item + its catalog.
const { data } = await supabase
  .from('item_vendors')
  .select(`vendor_id, cost_per_unit,
           item:inventory_items!inner(id, store_id,
             catalog:catalog_ingredients(name, unit, case_qty, i18n_names))`)
  .eq('vendor_id', vendorId)
  .eq('item.store_id', storeId)
  .order('item_id', { ascending: true });
```

Map to the existing `EodItem` shape (`id`, `vendorId`, `name`, `unit`,
`caseQty`, `i18nNames`) — `id` = the inventory item id (unchanged), `vendorId`
= the selected vendor. Per-vendor `cost_per_unit` is available here if the
staff screen wants to show it (optional; staff EOD shows count, not cost). The
staff surface counts per scheduled vendor; the shared on-hand is reconciled by
the RPC (§5b). Staff has no cross-tab "counted elsewhere" notion in v1 (one
vendor at a time, no realtime) — the shared on-hand consistency is purely a
server concern there, which §5b delivers. This is a documented carve-out file
(staff subtree) and stays on its verbatim-port pattern; the change is the
minimal query swap.

## 7. Frontend store impact (useStore.ts)

- **`inventory` slice shape** gains `vendors[]` + `vendorIds` (§6a). The
  optimistic-then-revert paths for `addItem`/`updateItem`
  (useStore.ts:1098-1186) already snapshot `prev` and revert on error via
  `notifyBackendError` — that pattern is **unchanged**; the new fields ride
  along in the snapshot/restore automatically.
- **`submitEOD` optimistic mirror** (§5c): the `itemMatchesSubmittedVendor`
  guard becomes a `vendorIds.includes()` membership check. Optimistic-then-…
  here is fire-and-forget local mutation + a `db` persist; on persist failure
  the existing console.warn path applies (the on-hand mirror is "nice-to-have"
  per the existing comment). No new revert logic.
- **Item editor add/remove-vendor writes** are NOT optimistic in this design —
  they go through `updateInventoryItem` (§8) which is already wrapped in
  `track()` + the store's optimistic-then-revert for the item row. The vendor
  link set is part of that item's optimistic snapshot.

## 8. Item editor contract (IngredientForm.tsx + db.ts create/update)

The form (lines 947-957) replaces the single "primary vendor" `SelectField`
with a multi-vendor affordance: a primary picker (writes `vendorId`) **plus** a
repeatable list of `{ vendor, costPerUnit, casePrice }` rows with add/remove and
a dup-guard (AC-C). The form's value shape feeds a new `vendors[]` field on the
create/update payload.

**`createInventoryItem` (db.ts:272-317)** — after the existing
`create_inventory_item_with_catalog` RPC returns the new item, write the
`item_vendors` rows. The primary link (matching `vendorId`) gets
`is_primary=true`; the RPC's `p_per_store.vendor_id` already sets the scalar.
Add to the input type `vendors?: Array<{ vendorId; costPerUnit; casePrice }>`:

```ts
// after mapItem(data):
const links = (item.vendors ?? (vendorId ? [{ vendorId,
  costPerUnit: item.costPerUnit ?? 0, casePrice: item.casePrice ?? 0 }] : []));
if (links.length) {
  await supabase.from('item_vendors').upsert(
    links.map(l => ({ item_id: data.id, vendor_id: l.vendorId,
      cost_per_unit: l.costPerUnit ?? 0, case_price: l.casePrice ?? 0,
      is_primary: l.vendorId === vendorId })),
    { onConflict: 'item_id,vendor_id' });   // dup-guard backstop (AC-C)
}
```

**`updateInventoryItem` (db.ts:324-382)** — gains a `vendors?` partial. When
present, **reconcile** the link set (the editor's "removing a vendor removes its
link; editing a cost updates only that link" — AC-C): upsert the present links,
then delete links for this item whose `vendor_id` is not in the submitted set.
Keep `is_primary` consistent with the scalar `vendorId` write that already
happens at line 370 (SD-1 — one writer owns both):

```ts
if (updates.vendors !== undefined) {
  const ids = updates.vendors.map(v => v.vendorId);
  if (updates.vendors.length)
    await supabase.from('item_vendors').upsert(
      updates.vendors.map(v => ({ item_id: id, vendor_id: v.vendorId,
        cost_per_unit: v.costPerUnit ?? 0, case_price: v.casePrice ?? 0,
        is_primary: v.vendorId === (vendorId ?? null) })),
      { onConflict: 'item_id,vendor_id' });
  // remove de-selected links (empty `ids` ⇒ remove all links for the item)
  let del = supabase.from('item_vendors').delete().eq('item_id', id);
  if (ids.length) del = del.not('vendor_id', 'in', `(${ids.join(',')})`);
  await del.abortSignal(signal);
}
```

- **Dup-guard (AC-C):** enforced three ways — the form prevents adding a vendor
  already in its list (client), the composite unique `(item_id, vendor_id)`
  rejects a dup at the DB, and `onConflict` makes a re-submit idempotent.
- **Backward compatible (AC-C):** an item with one vendor opens with that vendor
  + its cost in the list (from `vendors[]`), and saving unchanged re-upserts the
  same single row + deletes nothing (its id is in `ids`). The scalar `vendorId`
  path at line 370 is unchanged, so a form that only touches the primary picker
  still works without sending `vendors[]`.
- **jest coverage (AC-I):** the add/remove/dup-guard → payload mapping
  (`vendors[]` → upsert/delete shape, `is_primary` resolution) is the unit
  under test.

## 9. Weekly low-stock warning (AC-H, US-5) — new RPC `report_weekly_lowstock`

New migration `supabase/migrations/20260630000300_report_weekly_lowstock.sql`,
ordered after the reorder rewrite. `security invoker`, JWT path,
`auth_can_see_store` pre-flight + per-read RLS — same security shape as the
reports trilogy. The weekly screen stays **advisory** (AC-H) — this RPC returns
read-only warning data and creates nothing.

```sql
-- signature (mirrors report_reorder_list's):
create or replace function public.report_weekly_lowstock(
  p_store_id uuid, p_params jsonb default '{}'::jsonb
) returns jsonb language plpgsql security invoker set search_path = public ...
-- revoke execute from public, anon; grant execute to authenticated;
```

**Contract:**
- **Inputs:** `p_store_id`; `p_params.as_of_date` (store-local today, same
  caveat as reorder). No write.
- **Per item** (all store items with ≥1 vendor link), compute:
  - `on_hand` — same EOD-first / current_stock fallback as reorder's (4f), but
    item-grained (one row per item, not per link — the shared on-hand is one
    number).
  - `next_delivery_date` — **NEAREST across all the item's vendors** (OQ-4):
    `min(next_delivery_date)` over the item's linked vendors, reusing the
    existing `vendor_delivery` offset CTE filtered to the item's links.
  - `days_until` — `next_delivery_date - as_of_date`.
  - `usage_per_day` — reuse reorder's `pos_daily_per_item` (4h) per-day rate;
    degrades to 0 when no usage signal (same as reorder).
  - `projected_on_hand = on_hand - usage_per_day * days_until`.
  - `low_stock` (boolean) = `projected_on_hand < 0` (the item will run out
    before its nearest delivery). When `usage_per_day = 0` (no signal),
    fall back to `on_hand <= 0` so a zero-stock item still warns; otherwise
    `low_stock = false` (advisory, conservative — don't cry wolf without a
    usage rate).
- **Envelope:**
  ```json
  { "as_of_date": "YYYY-MM-DD",
    "items": [ { "item_id","item_name","unit","on_hand",
                 "next_delivery_date","days_until","usage_per_day",
                 "projected_on_hand","low_stock" } ] }
  ```
- **db.ts surface:** `fetchWeeklyLowStock(storeId, asOfDate?): Promise<WeeklyLowStock>`
  mirroring `fetchReorderSuggestions` (db.ts:2807) — `supabase.rpc(...)`,
  snake→camel map per item (`itemId`, `itemName`, `onHand`, `nextDeliveryDate`,
  `daysUntil`, `usagePerDay`, `projectedOnHand`, `lowStock`). Wrapped in
  `track({ kind: 'read' })`.
- **`WeeklyCount.tsx`** consumes the mapped list to render on-hand + a low-stock
  badge per ingredient. **No order/PO/suggestion affordance** (AC-H, out-of-scope
  "weekly-count ordering"). This is the only place US-5 lands; the weekly screen
  is full-store, not vendor-scoped, so it shows one row per item with the
  nearest-delivery warning.

**Sub-decision:** the warning is computed for items that have ≥1 vendor link
(otherwise there is no "next delivery date" to compare against — a no-vendor
item simply renders on-hand with no badge). pgTAP covers the explode is not
applied here (one row per item) and the nearest-delivery min.

## 10. API contract summary (PostgREST vs RPC)

| Surface | Mechanism | Notes |
|---|---|---|
| `item_vendors` CRUD | **PostgREST** table | RLS-gated; via `db.ts` create/update item helpers (§8). No RPC — simple row writes, the editor reconciles client-side. |
| Reorder explode | **RPC** `report_reorder_list` (rewrite) | Envelope unchanged; per-item gains `other_vendor_count` + `also_from_vendors` (§4). |
| Staff EOD on-hand | **RPC** `staff_submit_eod` (1-hunk change) | Predicate swap only (§5b). |
| Admin EOD on-hand | **PostgREST** update in `submitEODCount` | Predicate swap + membership prefetch (§5a). |
| Weekly low-stock | **RPC** `report_weekly_lowstock` (new) | Read-only advisory (§9). |
| Inventory + links read | **PostgREST** `fetchInventory` embed | New `item_vendors` embed (§6a). |
| Staff EOD items read | **PostgREST** `fetchItemsForVendor` (junction join) | §6d. |

No new edge function (per spec). All server logic stays on the JWT-protected
PostgREST/RPC path.

## 11. Migration ordering & drift risks

1. `20260630000000_item_vendors.sql` — table + indexes + RLS + backfill +
   publication add. **Restart `supabase_realtime_imr-inventory` after
   `npm run dev:db`** (§3 gotcha).
2. `20260630000100_report_reorder_list_multi_vendor.sql` — **copy the LATEST
   body** (20260623…), not spec-021. Depends on (1).
3. `20260630000200_staff_submit_eod_multi_vendor.sql` — copy the LATEST staff
   body (20260601…). Depends on (1).
4. `20260630000300_report_weekly_lowstock.sql` — new RPC. Depends on (1).

**Drift risks:**
- **RPC-body-drift (highest):** both reorder and staff RPCs are
  `create-or-replace`-in-place lineages. Copying a stale body silently reverts
  prior specs (088/100 on reorder; 086/061 on staff). Mitigated by the explicit
  "copy LATEST body" instruction + the existing pgTAP suites that pin those
  behaviors (`report_reorder_list_cases`, `…_i18n_names`,
  `staff_submit_eod_cases_each`) — they go red if a hunk is dropped.
- **`db-migrations-applied` CI gate:** every one of the four migrations must be
  `supabase db push`ed to prod or the gate goes red (CLAUDE.md hard rule). All
  four are forward-only DDL/idempotent-DML/`create or replace` — push-compatible.
- **Grant drift (spec-097 class):** confirm `authenticated` gets table grants on
  `item_vendors` (§2) — newly created tables are exactly where the
  silent-grant-revocation bug bit before. Verify locally + add explicit grant if
  needed.
- **Triple-write divergence (§5):** the on-hand predicate lives in 3 places
  (admin db.ts, staff RPC, admin store optimistic). All three must change
  together; the `eod_submissions_consistency` / `_edit_flow` pgTAP and the EOD
  jest suites must be updated (not deleted) to the new behavior (AC-I, and the
  stale-EOD-test-turned-main-red precedent).
- **Performance on the 286 KB seed:** `item_vendors` is small (≤ N items × few
  vendors). The reorder (4f) join changes from a `left join` on a scalar FK to a
  `join` on an indexed junction (`item_vendors_vendor_id_idx` /
  `_item_id_idx`); same order of magnitude, indexed both ways. No N+1 — the
  explode is set-based. The weekly RPC reuses reorder's already-bounded CTEs.
- **Realtime publication membership** changed (item added) → the documented
  container-restart dev step; not a runtime risk.

## 12. Open question surfaced to PM (non-blocking)

None blocking. One observation for the PM/test-engineer, not a blocker: the
admin on-hand write is being aligned to set BOTH `current_stock` and
`eod_remaining` (§5a) to match the staff RPC and the admin optimistic mirror.
This is a deliberate consistency fix, in-scope as part of "reconcile the
on-hand write," but it is a behavior change to the admin persist path — calling
it out so the test-engineer can confirm no existing pgTAP/jest assertion pins
"admin writes only eod_remaining." If the PM wants the admin path to keep
writing only `eod_remaining`, the optimistic `currentStock` mirror at
useStore.ts:1699 should be revisited in the same breath (it would otherwise
disagree with the server) — but the recommended path is BOTH, for consistency
with staff.

## Handoff
next_agent: backend-developer, frontend-developer
prompt: Implement against the Backend design section in this spec. Backend
  owns the four migrations (item_vendors table+RLS+backfill+publication; the
  report_reorder_list rewrite copying the LATEST 20260623 body; the
  staff_submit_eod 1-hunk predicate swap copying the LATEST 20260601 body; the
  new report_weekly_lowstock RPC), the db.ts on-hand reconciliation in
  submitEODCount (§5a, membership prefetch + predicate swap, set both
  current_stock and eod_remaining), the fetchInventory item_vendors embed +
  mapItem fields (§6a), the staff fetchItemsForVendor junction join (§6d), the
  create/update item link reconciliation (§8), and fetchWeeklyLowStock (§9).
  Frontend owns the IngredientForm multi-vendor affordance + dup-guard (§8),
  the EODCountSection vendor-tab membership + counted-once-globally gate (§6b,
  §6c), the useStore inventory shape + submitEOD optimistic membership guard
  (§7, §5c), the reorder "also from N" hint rendering (§4 / mapReorderVendor),
  and the WeeklyCount low-stock badge (§9). Honor SD-1 (scalar vendor_id is the
  primary source of truth, is_primary is its mirror), FG-1 (the staff RPC write
  is the second on-hand predicate and MUST change too), and the migration-body
  drift trap (copy the LATEST RPC bodies). After the realtime publication add,
  flag `docker restart supabase_realtime_imr-inventory` in the PR + local steps.
  After implementation, set Status: READY_FOR_REVIEW and list files changed
  under ## Files changed.
payload_paths:
  - specs/102-multi-vendor-ingredients.md

---

# Backend implementation

Implemented by backend-developer, 2026-06-29. **BACKEND SLICE ONLY** — the
UI + store layer (IngredientForm multi-vendor affordance, EODCountSection
tab membership + counted-once gate, useStore inventory shape + submitEOD
optimistic mirror reconciliation §5c, reorder "also from N" hint rendering,
WeeklyCount low-stock badge) is the **frontend phase** and is NOT in this
slice. Status intentionally left `READY_FOR_BUILD` for the frontend pass.

## Files changed (backend slice)

### Migrations (added — local-applied + verified; NOT yet `db push`ed to prod)
- `supabase/migrations/20260630000000_item_vendors.sql` — junction table +
  FKs + composite unique `(item_id, vendor_id)` + the two lookup indexes +
  the partial unique `item_vendors_one_primary_per_item` (SD-1 ≤1 primary) +
  explicit anon/authenticated (no-TRUNCATE) / service_role grants + the four
  `auth_can_see_store(ii.store_id)`-via-`exists` RLS policies + the
  idempotent backfill + `alter publication supabase_realtime add table`.
- `supabase/migrations/20260630000100_report_reorder_list_multi_vendor.sql`
  — `create or replace` copying the **LATEST** body
  (20260623000000_reorder_list_i18n_names.sql — carries spec 088 case math +
  spec 100 i18n). Hunks: (4f) `item_on_hand` explodes by `item_vendors` with
  per-vendor cost + OQ-5 fallback to item cost; new `item_vendor_set`
  sub-CTE; (4l) two additive OQ-1 hint keys `other_vendor_count` /
  `also_from_vendors`. **Plus two consequential fixes the design's
  illustrative diff did not spell out** (see "Design deltas" below).
- `supabase/migrations/20260630000200_staff_submit_eod_multi_vendor.sql` —
  `create or replace` copying the **LATEST** staff body
  (20260601000000_staff_submit_eod_cases_each.sql). ONE hunk: the on-hand
  write predicate `and ii.vendor_id = p_vendor_id` → junction-membership
  `exists(item_vendors …)` (FG-1). Already sets BOTH current_stock +
  eod_remaining (unchanged from the latest body).
- `supabase/migrations/20260630000300_report_weekly_lowstock.sql` — new
  `report_weekly_lowstock(uuid, jsonb)` advisory RPC (security invoker,
  auth_can_see_store gate, anon-revoke / authenticated-grant). Item-grained
  shared on-hand + nearest-delivery-across-vendors (OQ-4) + projected-on-hand
  + low_stock (with the usage=0 → on_hand<=0 fallback).

### src/lib/db.ts
- `submitEODCount` (§5a) — membership prefetch (`select item_id from
  item_vendors where vendor_id = …`) + per-entry write gated on that set,
  drops the `.eq('vendor_id', …)` predicate, sets BOTH current_stock +
  eod_remaining (§12 consistency fix).
- `fetchInventory` (§6a) — adds the `item_vendors` embed.
- `mapItem` (§6a) — hydrates `vendors[]` (per-vendor cost/case/isPrimary) +
  derived `vendorIds`.
- `createInventoryItem` (§8) — `vendors?` input; writes item_vendors links
  after the RPC (synthesizes a single primary link from the scalar when
  `vendors[]` omitted).
- `updateInventoryItem` (§8) — `vendors?` partial; reconciles the link set
  (upsert present, delete de-selected); restructured so a `vendors`-only
  edit is not short-circuited by the empty-perStore early-return.
- `fetchWeeklyLowStock` (§9) — new fetcher mapping `report_weekly_lowstock`.

### src/types/index.ts (types only — frontend will consume; store untouched)
- `InventoryItem` gains optional `vendors?: ItemVendorLink[]` + `vendorIds?:
  string[]`; new `ItemVendorLink`, `WeeklyLowStockItem`, `WeeklyLowStock`.

### src/screens/staff/screens/EODCount.tsx (staff carve-out — minimal query swap, §6d)
- `fetchItemsForVendor` — queries `item_vendors` with embedded
  `item:inventory_items!inner(...)` instead of `inventory_items.eq(vendor_id)`.

### src/hooks/useRealtimeSync.ts (§3 fallback — the hook lists tables explicitly)
- Adds an `item_vendors` `postgres_changes` subscription on the `store-{id}`
  channel (no store filter — item_vendors has no store_id; the 400ms debounce
  absorbs it, same posture as ingredient_conversions). Required because the
  publication is an explicit list and the hook subscribes per-table by name —
  without this line the publication add is inert. The design (§3) explicitly
  authorized this conditional fallback.

### pgTAP tests updated to the new contract (AC-I — updated, not deleted)
- `report_reorder_list_cases` / `_hybrid_formula` / `_i18n_names` /
  `_min_dow` / `_on_hand_source` and `spec093_case_qty_backfill` — each now
  inserts the matching `item_vendors` link(s) for its test/seed items so the
  reorder explosion (now junction-driven) surfaces them. Without this the
  RPC keys on the junction and the items produce no rows (the old tests
  pinned the scalar-`vendor_id` shape).

## Design deltas (consequential fixes beyond the literal §4 diff — flagged for review)
1. **`vendor_delivery_offsets` (4i) EXISTS filter** changed from
   `ii.vendor_id = v.id` to a `join item_vendors iv … iv.vendor_id = v.id`.
   Necessary: a vendor linked to an item ONLY via the junction (not the
   scalar) must still get a `vendor_delivery` row, or its exploded items get
   dropped by the `join vendor_delivery` in `per_item`. Same membership
   semantics the (4f) change implies; not a redesign.
2. **`pending_po_qty` (4g) gained `select distinct`.** `item_on_hand` is now
   per-(item,vendor), so it carries duplicate item_ids for a shared item;
   `pending_po_qty` keys on item_id and is left-joined back ON item_id, which
   without DISTINCT fanned each shared item's `per_item` row out by its
   vendor-link count (observed live as "Flour appears twice in the BJs
   card"). `distinct` collapses to one row per item — correct because
   pending_po is per-item (and v1 value is 0). **This was a real duplication
   bug caught during local verification.**

## Local verification (all green; prod push deferred)
- **Migrations applied** to the local stack via `supabase migration up
  --local` (and re-verified through a full `supabase db reset`). All four in
  the correct order.
- **Backfill** — 564 vendor-bearing seed items → exactly 564 link rows, 564
  primary, 8 null-vendor items → 0 rows, **0 cost mismatches**, 0 links not
  matching the scalar. **Idempotent**: re-running the backfill DML → `INSERT
  0 0`, count stays 564. Partial-unique index rejects a 2nd `is_primary` for
  an item. RLS verified: a non-member sees 0 of another store's links, the
  member sees theirs.
- **Reorder explosion + per-vendor cost** — a 2-vendor Flour item surfaces
  under BOTH cards: GOLDEN CITY @ $5 → est $500, BJs @ $8 → est $800;
  `other_vendor_count=1` + `also_from_vendors` names the other vendor. With
  the BJs link cost zeroed, est falls back to the item cost ($5 → $500) —
  **OQ-5 fallback confirmed**. Dup-check: 0 items appearing >1× in any single
  card (post-fix #2).
- **report_weekly_lowstock** — `{as_of_date, items[]}`; no-vendor items
  absent; the usage=0 → on_hand<=0 fallback warns 110 zero-stock items; the
  low_stock CASE proven on all four branches.
- **pgTAP** — FULL suite **51/51 PASS** under BOTH the backfill-populated
  state AND the **CI-fresh `truncate item_vendors` condition** (seed-loads-
  after-migration on `db reset` → 0 backfilled links). This proves no
  local-green/CI-red asymmetry. spec-053 permissive-policy lint stays green.
  staff_submit_eod GRANT preserved; report_weekly_lowstock anon-denied /
  authenticated-allowed.
- **jest** — FULL `npx jest` **694/694 PASS** (66 suites), incl. the updated
  EODCount staff fixtures (new junction row shape).
- **tsc** — `npx tsc --noEmit` clean.

## Carryover — frontend phase (NOT done here) + deploy steps still PENDING
- **§5c** admin store optimistic mirror at `useStore.ts` (~1687,
  `itemMatchesSubmittedVendor`) → must become `vendorIds.includes(subVendorId)`
  or the optimistic UI disagrees with the now-membership-based server. **The
  THIRD on-hand predicate copy — still using the scalar — frontend MUST fix.**
- **IngredientForm** multi-vendor affordance + per-vendor cost rows + client
  dup-guard (§8); feeds `vendors[]` to create/update.
- **EODCountSection** vendor-tab membership via `vendorIds` (§6b) +
  counted-once-globally gate / "X of N" (§6c).
- **Reorder hint UI** — render `other_vendor_count` / `also_from_vendors`
  (mapReorderVendor + ReorderSection); db.ts mapper currently ignores them.
- **WeeklyCount low-stock badge** consuming `fetchWeeklyLowStock` (§9).
- **PROD PUSH** — none of the four migrations is `supabase db push`ed yet
  (user authorizes prod separately). The `db-migrations-applied` CI gate will
  go red until pushed.
- **REALTIME RESTART** — after deploy/local boot, `docker restart
  supabase_realtime_imr-inventory` is required (the publication gained
  `item_vendors`). Done on this local box; must be repeated on any fresh boot.

---

# Frontend implementation

Implemented by frontend-developer, 2026-06-29. **FRONTEND SLICE** — the
UI + store layer consuming the already-built, locally-verified backend
contract. Backend (migrations, RPCs, db.ts core query logic, types) was
unchanged except for ONE type-only correction flagged below (a contract gap
that blocked the whole frontend from compiling).

## Files changed (frontend slice)

### Editor (AC-C — IngredientForm multi-vendor editor)
- `src/components/cmd/IngredientForm.tsx` — replaced the single "primary
  vendor" `SelectField` with the multi-vendor editor: a per-vendor row list
  (each with its own editable cost + case price, a "primary" badge / "make
  primary" toggle, and a remove `×`) + a "+ attach vendor" picker that
  excludes already-attached vendors (UI-layer dup-guard). Added `vendors[]`
  to `IngredientFormValues` + `blankValues`. Added pure exported helpers
  (`vendorAlreadyLinked`, `addVendorLink`, `removeVendorLink`,
  `updateVendorLinkField`, `vendorRowsToLinkPayload` + `VendorLinkRow` type)
  for the add/remove/dup-guard/primary logic + the form→db payload mapping.
- `src/components/cmd/IngredientFormDrawer.tsx` — `fromItem` hydrates the
  editor rows from the item's `item_vendors` embed (back-compat: a
  single-vendor item synthesizes one row from the scalar `vendorId` + cost);
  `toUpdates` emits the `vendors` link-set payload; the NEW-mode `addItem`
  threads `vendors` explicitly (pulled out of the spread).

### Admin EOD (AC-D — vendor tabs + counted-once-globally gate)
- `src/screens/cmd/sections/EODCountSection.tsx` — vendor-tab membership
  (`allVendorTabs` counts + `vendorItems` filter) now reads `vendorIds`
  (junction membership) instead of the scalar `vendorId`, so a shared item
  appears under each of its vendor tabs. Added the pure exported
  `deriveCountedItemIds(...)` (counted-once-globally set from all per-vendor
  input maps + submitted submissions for the (store, date)); `hasEntry`
  widened to `localHasEntry || countedItemIds.has`; `buildSubmission` +
  est-value/variance reducers kept on `localHasEntry` (ship/sum only this
  tab's entries); the red `rowUncounted` styling + the gap-jump consume the
  widened predicate (a shared item counted under one tab is not a gap under
  another).

### Store (FG-1 §5c + signatures)
- `src/store/useStore.ts` — widened `addItem`/`updateItem` signatures to
  accept the editor's `vendors?` payload (`Omit<…,'vendors'>` to avoid the
  uninhabitable `ItemVendorLink[] & payload` intersection); both
  optimistic-mirror implementations synthesize the InventoryItem-shaped
  `vendors[]` + `vendorIds` so the editor + EOD tabs reflect the link set
  immediately; **fixed the THIRD on-hand predicate** —
  `itemMatchesSubmittedVendor` now uses `vendorIds.includes(subVendorId)`
  (membership), agreeing with the server's junction-membership write.

### Reorder "also from N" hint (AC-G / OQ-1)
- `src/lib/db.ts` — `mapReorderVendor` now maps the additive
  `other_vendor_count` / `also_from_vendors` keys (the backend dev's flagged
  carryover — the mapper previously ignored them). **Plus a type-only
  contract-gap fix** (see below).
- `src/screens/staff/lib/fetchReorder.ts` — same hint mapping on the staff
  reorder mapper (verbatim-port copy).
- `src/screens/cmd/sections/ReorderSection.tsx` — renders the hint under each
  card (admin English copy, matching the section's other strings + the
  byte-for-byte exports).
- `src/screens/staff/screens/Reorder.tsx` — renders the localized hint
  (`reorder.item.alsoFromOne` / `alsoFromMany`) + the `itemAlsoFrom` style.

### WeeklyCount low-stock badge (AC-H / US-5)
- `src/screens/staff/screens/WeeklyCount.tsx` — added `fetchLowStock`
  (`report_weekly_lowstock` RPC, staff carve-out direct `supabase.rpc`) +
  a `lowStockByItem` map fetched in parallel on mount; renders a "LOW" badge
  + a localized "runs out before next delivery {date}" detail on flagged
  rows (advisory only, no ordering). Added `itemNameRow` / `lowBadge` /
  `lowBadgeText` / `itemLowDetail` styles.

### Types
- `src/types/index.ts` — added optional `otherVendorCount?` /
  `alsoFromVendors?` to `ReorderItem` (the OQ-1 hint fields; backend mapper
  carryover). (`ItemVendorLink`, `WeeklyLowStock*` were already added by the
  backend slice.)

### i18n (EN/ES/中文 — staff surface; parity test stays green)
- `src/screens/staff/i18n/{en,es,zh-CN}.json` — `reorder.item.alsoFromOne` /
  `alsoFromMany` and `weekly.lowStock.{badge,detail,detailNoUnit}` in all
  three locales.

### Tests (AC-I frontend items)
- `src/components/cmd/IngredientForm.test.ts` — added the multi-vendor
  add/remove/dup-guard/cost-edit + `vendorRowsToLinkPayload` mapping coverage
  (+ an end-to-end attach→edit→remove sequence).
- `src/screens/cmd/sections/__tests__/EODCountSection.countedOnce.test.tsx`
  (NEW) — covers `deriveCountedItemIds` incl. THE KEY CASE (a shared item
  counted under vendor A reads as counted from vendor B's perspective), the
  blank/whitespace guard, draft + submitted submissions, store/date scoping,
  and the multi-tab union.

## Contract gap found + minimal fix (flagged for review)
- **db.ts create/update item signatures were uninhabitable for the
  frontend.** `createInventoryItem`/`updateInventoryItem` were typed
  `Omit<InventoryItem,'id'> & { vendors?: <payload> }` — but
  `Omit<InventoryItem,'id'>` still carries `vendors?: ItemVendorLink[]`, so
  the intersection's `vendors` is `ItemVendorLink[] & <payload>[]`
  (uninhabitable — requires `vendorName`/`isPrimary` on the payload). The
  backend's `tsc` was green only because nothing called these with `vendors`
  until the frontend wired it. Minimal **type-only** correction:
  `Omit<InventoryItem,'id'|'vendors'>` / `Omit<Partial<InventoryItem>,'vendors'>`
  on both signatures. **No query-logic / body change.** Surfaced here rather
  than silently absorbed because it touches db.ts; the backend-architect
  post-impl review should confirm it's a pure annotation fix.

## Local verification (browser + full suite; prod push NOT done)
Test data (set up + **torn down**, local DB restored to original): linked
"French Fries" at Towson to a SECOND vendor (US FOOD @ $8.00, alongside the
existing SYSCO @ $5.86 primary) via `item_vendors`, plus two coincident
Monday `order_schedule` rows (SYSCO + US FOOD) so the reorder explodes both
the same day. All test rows deleted afterward (`item_vendors` back to 564
links, Towson schedule back to 0 rows, French Fries back to 1 SYSCO link).
**No EOD/weekly counts were submitted** (in-session typing only) — verified 0
`eod_submissions` / `eod_entries` for the date.

- **IngredientForm (AC-C)** — Playwright (admin@local.test, Towson): the
  editor opens showing BOTH SYSCO (primary badge, $5.86) + US FOOD ($8.00)
  rows. Dup-guard: the attach picker EXCLUDES the already-linked SYSCO/US
  FOOD; attaching BJs → 3 rows, BJs then excluded from the picker; removing
  BJs → 2 rows; "make primary" on US FOOD moves the single primary badge.
  **SAVE persists per-vendor cost**: edited US FOOD $8→$9.25, verified the
  `item_vendors` row updated (SYSCO untouched), then reset to $8. 0 console
  errors.
- **Admin EOD (AC-D)** — French Fries appears under BOTH SYSCO (14) and US
  FOOD (32) tabs. Counting it =42 under SYSCO → "1 of 14 items counted";
  switching to US FOOD shows it in normal (NOT red) text with neutral
  borders and "1 of 32 items counted" (counted-once-globally), while a
  genuinely-uncounted US FOOD item (Margarine) stays red. 0 console errors.
- **Reorder "also from N" (AC-G / OQ-1)** — admin + staff: French Fries in
  BOTH cards, hint "also available from US FOOD"/"…from SYSCO" under each;
  **per-vendor cost (OQ-5)** confirmed: SYSCO est $562.56 (96×$5.86) vs US
  FOOD $768.00 (96×$8.00), matching the DB. 0 console errors.
- **WeeklyCount badge (AC-H)** — staff (manager@local.test, Towson, Weekly
  tab): French Fries shows a "LOW" badge + "0 bags on hand — runs out before
  next delivery 2026-07-01" (nearest of the two vendors' deliveries — OQ-4),
  amber warning styling, no ordering affordance. 141 low-stock items
  warned (the usage=0 → on_hand<=0 fallback). 0 console errors.
- **i18n** — all three locales carry the new keys (badge LOW/BAJO/偏低); the
  jest i18n-parity suite stays green.
- **jest** — FULL `npx jest` **721/721 PASS** (67 suites — was 694/66; +27
  new spec-102 tests, +1 suite).
- **tsc** — `npx tsc --noEmit` clean.

## Files changed
- specs/102-multi-vendor-ingredients.md
- src/components/cmd/IngredientForm.tsx
- src/components/cmd/IngredientForm.test.ts
- src/components/cmd/IngredientFormDrawer.tsx
- src/lib/db.ts (frontend: mapReorderVendor hint mapping + 2 type-only signature fixes)
- src/screens/cmd/sections/EODCountSection.tsx
- src/screens/cmd/sections/ReorderSection.tsx
- src/screens/cmd/sections/__tests__/EODCountSection.countedOnce.test.tsx (new)
- src/screens/staff/lib/fetchReorder.ts
- src/screens/staff/screens/Reorder.tsx
- src/screens/staff/screens/WeeklyCount.tsx
- src/screens/staff/i18n/en.json
- src/screens/staff/i18n/es.json
- src/screens/staff/i18n/zh-CN.json
- src/store/useStore.ts
- src/types/index.ts (frontend: ReorderItem otherVendorCount/alsoFromVendors)

## Code-review fix-pass — Critical: inline "+ new vendor" in EDIT mode wiped links (2026-06-29)

Resolves the lone **Critical** in `specs/102/reviews/code-reviewer.md`
(`IngredientFormDrawer.tsx:184–191`). Scope of this pass was ONLY this Critical
— the four Should-fix / five Nit items are handled in a separate pass.

- **The bug.** `handleVendorDrawerClose` set the scalar `vendorId`/`vendorName`
  to a newly inline-created vendor but did NOT add it to `values.vendors` (the
  per-vendor row list). On SAVE in EDIT mode, `updateInventoryItem`'s reconcile
  deletes every `item_vendors` row whose vendor is not in the submitted
  `vendors[]`. So the new "primary" vendor became a **dangling scalar
  `inventory_items.vendor_id` with zero junction rows** — invisible in every
  vendor tab + reorder explosion. (For a vendorless item, `values.vendors`
  started `[]`, so the SAVE sent `vendors: []` → wiped ALL links — the worst
  case named in the review.)
- **The change (`src/components/cmd/IngredientFormDrawer.tsx`).**
  `handleVendorDrawerClose` now mirrors `handleAttachVendor`: it appends the new
  vendor to `values.vendors` via `addVendorLink(prev.vendors, added.id, {
  costPerUnit: prev.costPerUnit, casePrice: prev.casePrice })` (seeded from the
  form's current cost/case price), in addition to setting the primary scalar.
  `addVendorLink`'s dup-guard makes it idempotent (returns the same reference
  when the vendor is already present → a re-close never double-adds). Added
  `addVendorLink` to the existing `./IngredientForm` import.
- **The jest guard (`src/components/cmd/IngredientForm.test.ts`).** New
  sub-block "inline-new-vendor (EDIT mode) seeds the row list, never an empty
  payload" pins the fix at the pure-helper level the review asked for: after the
  inline path's `addVendorLink` transform, `vendorRowsToLinkPayload(...)` (the
  array `toUpdates` threads to `db.updateInventoryItem`) INCLUDES the new vendor
  alongside the original (no wipe); plus the vendorless-item case and the
  dup-guard (re-add is a no-op, no duplicate row).
- **Verification.** FULL `npx jest` **724/724 PASS** (67 suites — was 721; +3
  new tests). `npx tsc --noEmit` clean. End-to-end DB proof against the live
  LOCAL stack under a real admin JWT + RLS (the actual `updateInventoryItem`
  upsert/delete REST calls; the `preview_*`/chrome browser-driver tools were not
  available in this session, so the SAVE path was exercised via the same
  authenticated PostgREST endpoints the app calls): editing "16oz Fries Cup"
  (Towson, originally 1 WEBSTAURANT link) + inline-creating "ZZ TEST VENDOR 102"
  → **both** links present (`link_count=2`), scalar = new vendor with its link's
  `is_primary=t`, WEBSTAURANT link retained. Pre-fix payload reproduced the
  dangle (`scalar_has_link_row=f`). **Torn down**: `item_vendors` back to 564,
  test vendor deleted (0 orphans), item restored to its original single
  WEBSTAURANT-primary link. No prod push.

## Backend fix-pass — review gaps (pgTAP suites + db.ts should-fixes, 2026-06-29)

Closes the BACKEND review gaps from `specs/102/reviews/{test-engineer,code-reviewer,backend-architect}.md`.
Scope was ONLY these gaps — the frontend Critical (already fixed), the nits, the
pre-existing 6-arg overload, and the frontend are untouched. No prod push.

### Part 1 — the four missing AC-I pgTAP suites (the test-engineer Criticals + the architect's SF-2)

Each new suite **seeds its own `item_vendors` links inside the transaction**, so it
passes identically under the 564-row backfill-seeded state AND the CI-fresh
`truncate item_vendors` state (the documented local-green/CI-red asymmetry). None
reads the seed's links. No `set role anon` (segfaults CI per spec 067 — anon
checked via `has_function_privilege`; non-member via `throws_ok 42501`).

- **`supabase/tests/item_vendors_backfill.test.sql`** (AC-A, 7 assertions) — runs
  the EXACT inline backfill DML from `20260630000000` against in-transaction
  fixtures: a vendor-bearing item produces exactly ONE `is_primary` link whose
  `cost_per_unit` (7.25) + `case_price` (33.40) equal the item's (cost
  preservation); a re-run of the SAME INSERT adds ZERO rows (idempotent
  `ON CONFLICT … DO NOTHING`); a `vendor_id IS NULL` item produces ZERO links.
- **`supabase/tests/item_vendors_rls.test.sql`** (AC-B, 8 assertions) — under the
  manager JWT (Towson+Frederick member; Charles = non-member): non-member SELECT
  of a Charles item's link returns 0 rows; non-member INSERT of a link for a
  Charles item raises 42501 (WITH CHECK re-validates the joined store); a UPDATE
  re-pointing a visible Frederick link's `item_id` AT a Charles item raises 42501
  (WITH CHECK guards cross-store moves); a non-member UPDATE of the Charles link
  is a silent USING no-op (cost unchanged); the member CAN insert/select/delete
  its own Frederick link.
- **`supabase/tests/eod_submissions_multi_vendor.test.sql`** (AC-F / FG-1, 5
  assertions) — the architect-flagged gap (the existing
  `staff_submit_eod_cases_each.test.sql:79-83` picks its target by the scalar
  `vendor_id` and seeds no `item_vendors`). A SHARED item linked to V1(primary)+V2,
  counted under **V2 (the NON-primary vendor)** via `staff_submit_eod`, updates the
  single shared on-hand — both `current_stock` AND `eod_remaining` == the submitted
  count (the junction-membership write; the OLD scalar-equality predicate would
  leave it at the seeded 100). The escape-hatch (an item with no link to V2) is
  NOT written (stays 100).
- **`supabase/tests/report_reorder_list_multi_vendor.test.sql`** (AC-G/OQ-1/OQ-5,
  11 assertions) — a shared item linked to TWO vendors at DISTINCT costs (V1 @ $5,
  V2 @ $8), both scheduled the SAME day, appears under BOTH cards each priced at
  THAT vendor's junction cost (est $50 vs $80 — a single-cost regression can't
  pass); a second item with junction cost 0 falls back to the item's
  `cost_per_unit` ($3 → est $30); `other_vendor_count` = 1 + `also_from_vendors`
  names V2 on the shared item, 0 on the single-vendor item; the shared item
  appears in EXACTLY two cards (explosion cardinality).
- **`supabase/tests/report_weekly_lowstock.test.sql`** (AC-H, 9 assertions — the
  new RPC had ZERO coverage) — anon lacks EXECUTE / authenticated retains it /
  non-member call refused (42501); the usage-driven LOW branch (on_hand 5,
  usage_per_day 10 via recipe+POS, future delivery → projected < 0 → true); the
  NOT-LOW branch (on_hand 100, usage 0 → false); the usage=0 fallback LOW branch
  (on_hand 0 → true via `on_hand <= 0`); `usage_per_day` wired through (= 10); a
  no-vendor-link item is ABSENT from the payload.

### Part 2 — db.ts should-fixes (code-reviewer + architect SF-1)

- **`submitEODCount` prefetch swallow → THROW** (db.ts ~774-790). A failed
  `item_vendors` membership prefetch previously emptied the set and silently
  skipped EVERY on-hand update for the whole submission (entries persist,
  `current_stock`/`eod_remaining` go stale until the next fetch). Chose **throw**
  over fall-back-to-entry-IDs: it is consistent with every other failure in
  `submitEODCount` (parent upsert, entry delete, entry insert all throw) and
  triggers the store's optimistic-revert + toast, whereas falling back would
  persist a half-correct on-hand on a backend fault. The per-item "don't throw"
  rationale only covers a single item's nice-to-have write, not a batch-wide
  prefetch failure.
- **`submitEODCount` membership prefetch store-scoped** (db.ts ~774-778). Added
  `item:inventory_items!inner(store_id)` + `.eq('item.store_id', submission.storeId)`
  (mirroring the staff `fetchItemsForVendor` embed-filter), so the set never spans
  wider than the submission's store. Fixed the misleading "RLS-scoped" comment.
- **`updateInventoryItem` is_primary fallback** (db.ts ~460-485). When
  `updates.vendorId` is omitted but `updates.vendors` is present, the writer now
  loads the item's existing `inventory_items.vendor_id` and uses it as the
  `is_primary` basis (`primaryVendorId`), so a cost-only / vendors-only edit no
  longer clears every `is_primary` and wipes the SD-1 mirror.
- **dead `db.fetchWeeklyLowStock` DELETED** (architect SF-1). WeeklyCount forked
  its own staff-carve-out `fetchLowStock`, so the db.ts helper had ZERO callers
  (grep-confirmed). Deleted the function + its now-unused `WeeklyLowStock` /
  `WeeklyLowStockItem` import from db.ts; left a pointer comment toward the staff
  mapper. The two types stay in `src/types/index.ts` (consumed by the staff
  mapper); their two doc-comments were updated to cite the staff mapper, not the
  removed helper. No dead exported code left behind.

### Files changed (fix-pass)

**pgTAP (new):**
- `supabase/tests/item_vendors_backfill.test.sql`
- `supabase/tests/item_vendors_rls.test.sql`
- `supabase/tests/eod_submissions_multi_vendor.test.sql`
- `supabase/tests/report_reorder_list_multi_vendor.test.sql`
- `supabase/tests/report_weekly_lowstock.test.sql`

**src/lib/db.ts** — `submitEODCount` (prefetch throw + store-scope),
`updateInventoryItem` (is_primary fallback), deleted dead `fetchWeeklyLowStock`
+ its unused type import.

**src/types/index.ts** — two `WeeklyLowStock*` doc-comments re-pointed to the
staff mapper (types unchanged).

### Verification (local only; NO prod push)

- **pgTAP (`bash scripts/test-db.sh`, FULL):** **56/56 PASS** under the
  backfill-SEEDED state (564 `item_vendors` rows), and **56/56 PASS** under the
  CI-FRESH state (`truncate public.item_vendors` → 0 rows). The new suites + the
  six patched reorder suites all seed their own links → no local-green/CI-red
  asymmetry. The 564-row seed was restored after the truncate run via the
  idempotent backfill (`INSERT 0 564` → back to 564). (51/51 → 56/56: +5 new files.)
- **jest (`npx jest`, FULL):** **724/724 PASS** (67 suites) — held green from the
  frontend pass (the db.ts changes don't touch any jest-covered path; the two
  db-adjacent suites test pure helpers / mocked supabase).
- **tsc:** `npx tsc --noEmit` clean; `npm run typecheck:test` clean.
- **DB-layer proof of the store-scoped prefetch:** the inner-join + `store_id`
  filter returns 14 Frederick-scoped links under the manager JWT with RLS on; the
  junction-membership on-hand write is additionally pinned end-to-end by the new
  AC-F pgTAP suite.