# Spec 021: Reorder / delivery list

Status: READY_FOR_REVIEW

## User story

As a store manager who just finished an EOD count, I want to see one page per
vendor that tells me exactly what to order from that vendor for their next
delivery — quantity per item, taking into account what's on hand, what's
already on the way (pending POs), and the vendor's delivery schedule — so I
can place the order quickly without re-deriving the math from the count
screen myself.

## Background — what's there today and what isn't

The user said this used to exist in legacy. After audit, **it didn't.** Both
`src/screens/AdminScreens.tsx` (legacy) and
`src/screens/cmd/sections/RestockSection.tsx` (Cmd UI) compute a "suggested"
quantity, but neither:

- groups suggestions by vendor for delivery,
- uses the most recent EOD `actual_remaining` as input,
- subtracts pending PO quantities,
- respects each vendor's delivery schedule / cutoff.

`RestockSection.tsx` uses
`suggested = ceil((parLevel - currentStock) × 1.2)`, store-wide, with no
vendor grouping and no PO subtraction. The "1.2" buffer is hardcoded.

The feature gap is real even if the legacy reference is wrong. SURFACE THIS
DISCREPANCY GENTLY TO THE USER — they may be remembering a different feature
or a different repo. (One possibility: the staff-app PWA they use may have
this view and they're confusing the two apps.)

## Acceptance criteria

- [ ] A new Cmd UI section "Reorder" appears in `CmdNavigator.tsx` sidebar as
  a sibling entry to "Restock" — `RestockSection.tsx` is unchanged (A4).
- [ ] The section renders one card or panel per vendor whose
  `order_schedule` says today is a valid order day OR whose next-cutoff is
  imminent.
- [ ] For each item, "on hand" is sourced from the **most recent EOD
  submission for that item's vendor** today (`eod_submissions(store_id, date,
  vendor_id)` joined to `eod_entries.actual_remaining`). If no EOD has been
  submitted for that vendor today, fall back to
  `inventory_items.current_stock`. The UI must indicate which source was used
  per vendor (badge or footer line) (A1).
- [ ] Each vendor card lists per-item suggested quantities computed by the
  **hybrid formula**:
  `suggested = max(par_replacement, usage_forecasted)` where
  `par_replacement = max(0, par_level - on_hand - pending_po_qty)` and
  `usage_forecasted = max(0, (usage_per_portion × days_until_next_delivery) - on_hand - pending_po_qty)` (A2).
- [ ] `pending_po_qty` is computed from `purchase_orders` rows whose
  `status IN ('sent', 'partial_received')` for the same store + vendor + item.
  **`draft` POs are excluded** from the subtraction (A3).
- [ ] Each line item displays the breakdown inline in the format
  `on hand: <n> | inbound: <n> | par: <n> → order: <n>` so the manager can
  see the math behind each suggested quantity (A3).
- [ ] Each vendor card has a "Create PO" action that pre-fills a draft PO
  with the suggested items + quantities.
- [ ] If a vendor has zero suggested items, the card is hidden (or collapsed
  with a "nothing to order" state).
- [ ] Vendors with no `order_schedule` row are surfaced per A5
  (default-buffer-with-badge).
- [ ] Cost-per-unit is shown per item; vendor totals are shown per card.
- [ ] Page refreshes when underlying `eod_submissions`, `purchase_orders`, or
  `inventory_items` change — realtime via the existing `store-{id}` channel.
- [ ] Vendor list is store-scoped via `auth_can_see_store()`.

## In scope

- New Cmd UI section file at
  `src/screens/cmd/sections/ReorderSection.tsx`.
- Wiring into `src/navigation/CmdNavigator.tsx` sidebar as a sibling entry
  to "Restock".
- A new database read RPC `report_reorder_list(p_store_id uuid, p_params
  jsonb)` OR a client-side composition reading from the existing tables —
  exact path depends on architect's call, but if RPC, the migration goes
  with this spec.
- "Create PO" hookup to the existing PO flow.
- Empty / loading / error states.
- Inline breakdown UI showing `on hand | inbound | par → order` per line item.
- Per-vendor indicator of whether `on_hand` came from today's EOD or from
  the `current_stock` fallback.

## Out of scope (explicitly)

- Replacing or modifying `RestockSection.tsx`. The two sections are siblings;
  Restock stays as-is (A4 resolved).
- Automated ordering / vendor API integrations.
- Forecasting beyond next delivery — no ML, no time-series modeling.
- POS-sales-based usage forecasting beyond what's already available in
  `inventory_items.usage_per_portion` and existing recipe / POS data.
- Touching `src/screens/AdminScreens.tsx` (legacy, frozen per CLAUDE.md).
- Order placement (email / EDI / phone) — output is a draft PO only.
- Including `draft` POs in the `pending_po_qty` subtraction — they are
  explicitly excluded (A3 resolved).

## Open questions resolved

### A1 — Input signal: which "on hand" do we use? ⟪RESOLVED⟫

**Decision:** EOD-first with `current_stock` fallback. For each item, use the
most-recent EOD submission's `actual_remaining` for that item's vendor today
(`eod_submissions(store_id, date, vendor_id)` joined to
`eod_entries.actual_remaining`). If no EOD has been submitted for that vendor
today, fall back to `inventory_items.current_stock`. The UI surfaces which
source was used per vendor so the manager knows whether the numbers reflect
a fresh count or a stale snapshot.

Rationale: the reorder list is meant to be run right after EOD, so the EOD
count is the authoritative number when available. The fallback prevents the
page from being useless on days where some vendors haven't been counted yet.

### A2 — Reorder window ⟪RESOLVED⟫

**Decision:** Hybrid formula —
`suggested = max(par_replacement, usage_forecasted)` where
`par_replacement = max(0, par_level - on_hand - pending_po_qty)` and
`usage_forecasted = max(0, (usage_per_portion × days_until_next_delivery) - on_hand - pending_po_qty)`.
`days_until_next_delivery` is read from the vendor's `order_schedule` row.

Rationale: hybrid covers both the "keep par stocked" and "make sure we don't
run out before the next truck" cases. Whichever yields a larger order wins,
which is the conservative (safer) choice for a restaurant inventory.

### A3 — Pending PO subtraction ⟪RESOLVED⟫

**Decision:** Subtract qty from POs whose
`status IN ('sent', 'partial_received')`. **`draft` POs do NOT subtract** —
they represent manager intent, not committed orders. The UI shows the
breakdown inline as `on hand: 4 | inbound: 6 | par: 12 → order: 2` so the
manager can see the math.

Rationale: subtracting draft POs would create a feedback loop where saving a
draft hides the reason it was created. Sent / partial_received POs represent
real inbound stock that should reduce the suggestion.

### A4 — Relationship to `RestockSection.tsx` ⟪RESOLVED⟫

**Decision:** Sibling. `RestockSection.tsx` stays as-is. A new "Reorder"
sidebar entry is added next to it, vendor-grouped and schedule-aware. No
deprecation, no toggle, no link-through.

Rationale: Restock is store-wide-by-category and works for stores that use
it that way; Reorder is vendor-grouped-for-delivery-day. Different mental
models, lowest-risk to keep both.

### A5 — Vendors with no `order_schedule` row ⟪RESOLVED⟫

**Decision (default applied):** Show with a "Schedule unknown — using
default 7-day buffer" badge. Card still renders so the manager can act on it;
the badge makes the assumption explicit.

### A6 — Legacy reference ⟪RESOLVED⟫

**Decision:** Audit confirmed the feature didn't exist in legacy. Proceed as
a new feature, not a port. PM has already surfaced the discrepancy to the
user; no further action needed at this stage.

### A7 — Series of "delivery days" or one-shot today? ⟪RESOLVED⟫

**Decision (default applied):** One delivery's worth by default. A date
picker lets the manager look ahead to future delivery days. No multi-tab
weekly view in v1.

## Dependencies

- `order_schedule` table — already exists (see
  `supabase/migrations/20260507214842_spec007_order_schedule_unique.sql`).
- `purchase_orders` + `po_items` tables — already exist. Architect must
  audit the actual `status` lifecycle values in use before the RPC sets
  filters; this spec assumes `'draft'` / `'sent'` / `'partial_received'` /
  `'received'` exist.
- `inventory_items.par_level` / `usage_per_portion` / `current_stock` —
  already exist in init schema.
- `vendors.order_cutoff_time` — already exists per
  `supabase/migrations/20260424001643_vendor_order_cutoff.sql`.
- `eod_submissions` + `eod_entries` per-vendor shape — A1 resolution
  depends on this. **This spec depends on spec 020 landing first** since
  spec 020 establishes the per-vendor EOD shape that makes "most recent
  EOD for vendor X today" a well-defined query.

## Project-specific notes

- **Cmd UI section / legacy**: New file at
  `src/screens/cmd/sections/ReorderSection.tsx`. Sidebar wiring in
  `src/navigation/CmdNavigator.tsx`. NOT in `AdminScreens.tsx`.
- **Per-store or admin-global**: Per-store. Vendor list is filtered by
  inventory's `store_id`. RLS via `auth_can_see_store()`.
- **Realtime channels touched**: `store-{id}` — when a PO is received or an
  EOD is submitted, the reorder list should re-render. Architect should
  call out the realtime publication gotcha (mid-session pub changes need
  `docker restart supabase_realtime_imr-inventory`) if new tables are added
  to the realtime publication.
- **Migrations needed**: LIKELY — architect's call on whether the read path
  is a server-side RPC `report_reorder_list` (recommended for testability
  and to keep the hybrid formula server-authoritative) or a client-side
  composition. If RPC, migration ships with this spec.
- **Edge functions touched**: None expected.
- **Web/native scope**: Both. No web-only or native-only branches.
- **Tests**: No test framework. test-engineer should flag and recommend.
- **app.json**: No changes.

## Risk register

- **Formula choice is product-loaded.** The hybrid formula is committed for
  v1; architect should note "per-store formula override" as a future-spec
  candidate, not a v1 deliverable.
- **Pending PO status lifecycle.** `purchase_orders.status` actual values
  must be audited before the RPC's status filter is finalized. This spec
  assumes `'sent'` and `'partial_received'` exist and are the right
  "in flight" states; architect verifies.
- **Empty-state risk.** New stores with no EOD history, no POs, no usage
  data will see an empty page. Need a friendly first-run state.
- **Spec 020 hard dependency.** A1 EOD-first sourcing requires the
  per-vendor EOD shape from spec 020. This spec cannot be built until 020
  has landed.
- **Realtime publication.** If the architect adds new tables to the
  publication, the realtime publication gotcha applies (per CLAUDE.md).

## Backend Architecture

### 0. TL;DR — what's actually buildable in v1 vs deferred

This audit changed the shape of what v1 can do. The spec's locked-in
decisions assumed a `purchase_orders` lifecycle and a populated `po_items`
table that don't match the live system. **Reviewed in §1 below.** The
design honours the spec's intent but updates the mechanics:

- **v1 SHIPS** with a server-side RPC (`report_reorder_list`) that joins
  EOD entries + inventory + order_schedule + vendors and returns a
  per-vendor payload with par_replacement-only suggestions. Pending PO
  qty is exposed as a column (always 0 in v1) so the UI breakdown
  matches the spec's `on hand | inbound | par → order` format unchanged.
- **v1 SHIPS** the usage-forecast path **conservatively**: a single
  shared 7-day rolling `pos_import_items` average per recipe →
  `usage_per_portion` × portions/day × days_until_next. If the input
  data is sparse (no recent imports, or item not in any recipe) the
  forecast contributes 0 and `par_replacement` carries the day. The
  hybrid `max(par_replacement, usage_forecasted)` still applies — it
  just degrades to par-only when there's no signal.
- **v1 DEFERS** the real `pending_po_qty` subtraction (A3 mechanics)
  to v2 once the `po_items` write path lands or the
  `purchase_orders.status` lifecycle gets a coded "in flight" state.
  Spec's A3 contract (column shape, breakdown UI) is preserved with
  inbound = 0 in v1, so v2 is a swap-in.
- **v1 DEFERS** the "Create PO" action to a follow-up. Surfaced and
  flagged as a v1 deliverable in the spec, but the existing
  `db.createPurchaseOrder` writes the PO header **only** — no
  `po_items`. Wiring "Create PO" without `po_items` would persist a
  zero-line PO that the receiving / variance flows can't reconcile.
  See §10 for the deferred-feature breakout and the PM question this
  raises.

The five spec ACs **fully shipping in v1**:
- New "Reorder" sidebar entry, Planning group, after Restock.
- Per-vendor cards with EOD-first / current_stock-fallback `on_hand`,
  badged per vendor.
- Inline `on hand | inbound | par → order` breakdown.
- Vendor without `order_schedule` → 7-day buffer badge.
- Store-scoped via `auth_can_see_store()`.

The two spec ACs **partially shipping in v1, with the contract preserved
for v2**:
- Pending PO subtraction — column is in the payload; computed value is
  0 in v1 (see §1, §5).
- "Create PO" action — present as a disabled-with-explainer button in
  v1; full action deferred (see §10).

### 1. CRITICAL — `purchase_orders` lifecycle audit

The spec's A3 — "Subtract qty from POs whose
`status IN ('sent', 'partial_received')` … via
`po_items.ordered_qty - po_items.received_qty`" — does not work against
the live schema. Findings:

**1a. There is no CHECK constraint on `purchase_orders.status`.**

The init schema (`20260405000759_init_schema.sql:160`) declares:

```
status text default 'draft'  -- 'draft' | 'sent' | 'received' | 'partial'
```

That's a COMMENT, not a CHECK constraint. The value `'partial_received'`
the spec cites doesn't appear anywhere in the migrations or the live
app code. The comment says `'partial'` (without `_received`).

**1b. The live app writes `status = 'submitted'`.**

`db.createPurchaseOrder` (`src/lib/db.ts:885`) hardcodes
`status: 'submitted'`. None of the four values from the schema comment
(`'draft'`, `'sent'`, `'received'`, `'partial'`) are written by the live
code path. Only one place in the codebase queries for `'received'`: the
variance report (`20260512120000_report_run_variance.sql:407`) using
`status = 'received' OR received_at is not null`. The `'received'` rows
that exist must come from seed data, not from the live write path.

**1c. `po_items` is NEVER WRITTEN by the live app.**

A repo-wide grep confirms `po_items` is referenced only in:
- Init schema (declaration).
- Per-store RLS hardening (policies).
- Multi-brand RLS & brand-delete cascade (audit counts).
- Variance report SQL (read path, expecting historical data).

`db.createPurchaseOrder` writes ONLY the `purchase_orders` header row.
No line items. Any `po_items` rows that exist are seed-data artefacts
from before the live app's PO flow shipped.

**1d. The current "PO" flow is logically an "order submission ack", not
a line-itemised PO.**

`POsSection.tsx:40-43` derives a `'sent' | 'rcvd'` label from
`created_at` age (≤24h → `'sent'`, else → `'rcvd'`) precisely because
the real status field has no useful values to read. The header has a
`reference_date`, a `total_cost`, and that's it — no per-item ordered
qty exists anywhere.

**Implication for v1.**

The spec's A3 PO-subtraction cannot be implemented as written. Even if
the architect picked some status value out of the spec's enumeration,
there's nothing to sum because `po_items` is empty.

**Decision (architect's call, surfaced to PM in §10):**

- v1 RPC returns a `pending_po_qty` column in the payload, **always 0**.
  The frontend breakdown line still reads `on hand: X | inbound: 0 |
  par: Z → order: N`. The UI contract is unchanged.
- The RPC includes a commented-out filter block showing where the
  pending-PO subquery would slot in. v2 implements it once either
  (a) `po_items` becomes a real write target, or (b) the PO header
  gains a totals/in-flight-qty column.
- The v1 RPC's status-filter audit recommendation: when the PO flow
  lands properly (v2), filter on `status IN ('submitted', 'sent',
  'partial')` AND `received_at IS NULL` to capture "in flight" without
  needing a coded `'partial_received'` state. `'submitted'` is the
  current write value; `'sent'`/`'partial'` are the schema comment's
  intended values; `received_at IS NULL` is the receipt gate that
  works regardless of which status string is in use.

### 2. RPC vs client-side composition — RPC, mirroring reports

Decision: **server-side RPC**. Four reasons match the reports trilogy
(`20260511120000_report_run_cogs.sql`,
`20260512120000_report_run_variance.sql`):

- The hybrid formula (A2) must be server-authoritative for v2's
  potential per-store override path; embedding it in client TS would
  fork the math.
- Five joins minimum (`eod_submissions` + `eod_entries`,
  `inventory_items` + `catalog_ingredients`, `vendors`,
  `order_schedule`, `pos_imports` + `pos_import_items` +
  `recipe_ingredients`/`recipe_prep_items`/`prep_recipe_ingredients`).
  PostgREST shape forces N round-trips; one RPC keeps it to one.
- Per-store auth gate via `auth_can_see_store()` is a single line in
  PL/pgSQL; the equivalent in TS is a check-then-fetch race window.
- The reports trilogy convention is set and `release-coordinator`
  already approved the shape — same envelope is reusable.

**Important:** this RPC is **NOT registered as a report template**. The
report-runs framework (`report_runs` table, `runReport`,
`fetchLatestRun`) is for KPI/columns/rows/series envelopes. Reorder is
a live-data screen with no persisted-run history. It's a standalone RPC
with the same security shape (security invoker, search_path locked,
auth gate, grant authenticated / revoke public+anon).

**Signature:**

```sql
public.report_reorder_list(
  p_store_id uuid,
  p_params   jsonb default '{}'::jsonb
) returns jsonb
language plpgsql
security invoker
set search_path = public
```

`p_params` is reserved for the A7 date picker ("look ahead to future
delivery days"). v1 supports one optional key:
- `as_of_date` (text, YYYY-MM-DD, default: today in store-local tz,
  with the same UTC-day fallback as the variance runner). Drives the
  "most-recent EOD" lookup and the `days_until_next_delivery` math.

Unknown keys are ignored (forward-compat with v2 per-vendor filters).

### 3. RPC return shape

```json
{
  "as_of_date": "2026-05-13",
  "vendors": [
    {
      "vendor_id": "uuid",
      "vendor_name": "string",
      "schedule_known": true,
      "next_delivery_date": "2026-05-15",
      "days_until_next_delivery": 2,
      "on_hand_source": "eod" | "stock",
      "eod_submitted_at": "2026-05-13T22:00:00+00:00" | null,
      "items": [
        {
          "item_id": "uuid",
          "item_name": "string",
          "unit": "string",
          "on_hand": 4.0,
          "pending_po_qty": 0.0,
          "par_level": 12.0,
          "usage_forecasted": 2.5,
          "par_replacement": 8.0,
          "suggested_qty": 8.0,
          "cost_per_unit": 1.25,
          "estimated_cost": 10.00,
          "flags": []
        }
      ],
      "vendor_total_cost": 10.00
    }
  ],
  "kpis": {
    "vendor_count": 3,
    "item_count": 17,
    "total_estimated_cost": 240.50,
    "eod_sourced_vendor_count": 2,
    "stock_fallback_vendor_count": 1
  },
  "_warnings": []
}
```

Notes on the shape:
- `on_hand_source` is per-vendor (NOT per-item). Spec AC line 47
  ("The UI must indicate which source was used per vendor") matches.
  If ANY EOD entry exists for that vendor today, the vendor is
  `'eod'`-sourced for all its items; per-item missing-entry fallback
  uses `inventory_items.current_stock` but the vendor badge stays
  `'eod'` with a per-item warning flag (see `flags` below).
- `flags` per item — string array, lowercase tokens. Possible values:
  `'no_par'` (par_level NULL or 0 — see §9), `'no_usage_rate'`
  (usage_per_portion NULL or 0), `'eod_missing_for_item'` (vendor is
  EOD-sourced but this item's row is missing from today's EOD entries
  — fell back to current_stock for THIS item only), `'truncated'`
  (recipe-graph depth cap hit during forecast — same precedence as
  the reports trilogy).
- `_warnings` — array of `{ code, message }` for non-fatal issues
  (e.g. vendor has items but no schedule row → one warning per such
  vendor). Empty in the happy path.
- Vendors with zero suggested items are **filtered out** of the
  payload entirely (AC line 62: "If a vendor has zero suggested items,
  the card is hidden"). The KPIs reflect only surfaced vendors.

### 4. Auth gate + grants — boilerplate from reports trilogy

```sql
if not public.auth_can_see_store(p_store_id) then
  raise exception 'Not authorized for store %', p_store_id
    using errcode = '42501';
end if;
```

```sql
revoke execute on function public.report_reorder_list(uuid, jsonb)
  from public, anon;
grant  execute on function public.report_reorder_list(uuid, jsonb)
  to authenticated;
```

The function is `security invoker` so the underlying RLS policies on
each joined table still gate the data — the auth gate above is a
defence-in-depth pre-flight, not the primary boundary.

### 5. RPC SQL structure — pseudocode walk

The dev writes the full SQL. Structure:

```
-- (1) AUTH GATE — first statement.
-- (2) AS-OF DATE RESOLUTION — coalesce(p_params->>'as_of_date',
--     current_date). Document the tz caveat (server is UTC; the
--     "today" matters for the EOD lookup window). See §6.
-- (3) PER-VENDOR EOD LOOKUP CTE: latest_eod_per_vendor.
--     For each (p_store_id, vendor_id) pair found via the eod
--     submission for as_of_date, get the (submission_id, submitted_at)
--     and downstream eod_entries.
--     Per spec 020: eod_submissions(store_id, date, vendor_id) is now
--     unique. So per (store, date, vendor) we have AT MOST one row.
--     If there's a 'draft' status row, EXCLUDE it — same shape as
--     variance lines 158-159.
-- (4) ITEM-LEVEL on_hand CTE:
--       per-item:
--         if vendor has today's eod_submission AND that submission has
--           an eod_entries row for this item with non-null actual_remaining
--         then on_hand = actual_remaining, source='eod'
--         else if vendor has today's eod_submission (other items)
--           then on_hand = inventory_items.current_stock,
--                source='eod', flag='eod_missing_for_item'
--         else on_hand = inventory_items.current_stock, source='stock'
--     The vendor-level on_hand_source flag (returned in payload)
--     reflects 'eod' if any eod_submission exists today for that
--     vendor, else 'stock'. Per-item override stays internal via flags.
-- (5) NEXT-DELIVERY CTE:
--     For each vendor (vendor_id) joined to order_schedule
--       (store_id, day_of_week, vendor_id) compute next_delivery_date.
--     See §6 for the day-of-week / cutoff math. Vendors with no
--     order_schedule row → next_delivery_date = as_of_date + 7,
--     schedule_known=false. Add to _warnings.
-- (6) PENDING PO QTY CTE — v1 returns 0. STRUCTURE the CTE so v2 can
--     swap in real values. Documented as zero-valued, no early return:
--       select item_id, 0::numeric as pending_po_qty from
--         (some empty-set selector) — or simply LEFT JOIN nothing.
--     The COLUMN is in the shape regardless. See §1 for the v2 swap.
-- (7) USAGE FORECAST CTE (v1 conservative path):
--     For each item:
--       per-day usage = inventory_items.usage_per_portion ×
--                       average_portions_per_day_for_recipes_using_this_item
--     average_portions_per_day = sum(qty_sold) / 7
--       over pos_import_items joined pos_imports where
--       import_date BETWEEN as_of_date - 7 AND as_of_date - 1.
--     Per-item portions/day = sum over recipes that touch this item
--       of that recipe's daily qty_sold avg × per-recipe usage of
--       the item (from recipe_ingredients OR through recipe_prep_items
--       → prep_recipe_ingredients).
--     This subquery is structurally the same as the variance runner's
--     `sales_depletion` CTE (`20260512120000_report_run_variance.sql:
--     417-435`) but with a different window and divided by 7 to get
--     per-day rate. REUSE that CTE pattern.
--     Items with NULL usage_per_portion OR not in any recipe → forecast
--     contributes 0 (the max() degrades to par_replacement). Add
--     'no_usage_rate' flag where applicable.
--     Truncated recipe-graph depth cap → 'truncated' flag, same
--     precedence as variance.
-- (8) FINAL JOIN — per-vendor, per-item:
--     joined = on_hand ⊕ pending_po ⊕ next_delivery ⊕ forecast ⊕
--              inventory_items metadata (par_level, cost_per_unit, unit)
--              ⊕ catalog_ingredients (name)
--     compute:
--       par_replacement  = greatest(0,
--                            par_level - on_hand - pending_po_qty)
--       usage_forecasted = greatest(0,
--                            usage_per_portion *
--                            portions_forecast_per_day *
--                            days_until_next_delivery
--                            - on_hand - pending_po_qty)
--       suggested_qty    = greatest(par_replacement, usage_forecasted)
--       estimated_cost   = suggested_qty * coalesce(cost_per_unit, 0)
--     Filter rows where suggested_qty < 0.001 (the "nothing to order"
--     case at item-grain).
-- (9) VENDOR ROLLUP — group_by vendor; vendors with zero rows are
--     dropped here (matches AC "If a vendor has zero suggested items,
--     the card is hidden"). vendor_total_cost = sum(estimated_cost).
-- (10) KPI ROLLUP — count(vendor), count(item), sum(total),
--      count(distinct vendor where on_hand_source='eod'),
--      count(distinct vendor where on_hand_source='stock').
-- (11) FINAL ENVELOPE — jsonb_build_object as above.
```

Performance note: the seed dataset is 286 KB. Per-store inventory is
tens of items, vendors tens, recipes tens. The recursive prep CTE
already runs in <50ms in the variance runner. No new indexes needed.

### 6. `days_until_next_delivery` — schedule math

`order_schedule` shape (verified via
`20260424211732_recover_undeclared_tables.sql:86-94` + the remote-schema
diff at `20260502071736_remote_schema.sql:101-103`):

```
order_schedule (
  store_id     uuid not null,
  day_of_week  text not null,     -- e.g. 'Monday', 'Tuesday', ...
  vendor_id    uuid,
  vendor_name  text not null,
  delivery_day text not null,     -- e.g. 'Wednesday'
  unique (store_id, day_of_week, vendor_id)  -- spec007
)
```

`day_of_week` is the **order day**, `delivery_day` is when it arrives.
For the reorder list, the manager cares about `delivery_day` — the
next time a truck shows up — not the order day. (The vendor reminder
cron flow uses the order day; this is the reverse direction.)

`vendors.order_cutoff_time` (text, 24-hour `HH:MM`, from
`20260424001643_vendor_order_cutoff.sql`) gates whether today's order
day is still actionable.

**Algorithm — next delivery date strictly after `as_of_date`:**

```
-- pseudo, in PL/pgSQL CTE form:
with v_delivery_days as (
  select vendor_id,
         array_agg(distinct delivery_day) as delivery_days
    from order_schedule
   where store_id = p_store_id
   group by vendor_id
),
v_today_dow as (
  select to_char(v_as_of_date, 'FMDay') as dow  -- e.g. 'Wednesday'
),
v_next as (
  select vd.vendor_id,
         -- For each candidate delivery_day in delivery_days, compute
         -- (target_dow_num - today_dow_num + 7) % 7. If 0, the candidate
         -- is today — see edge cases below.
         min(
           ((extract(dow from
              (v_as_of_date::text || ' ' || cd.delivery_day)::date)
            - extract(dow from v_as_of_date)
            + 7)::int % 7)
         ) as days_offset
    from v_delivery_days vd,
         unnest(vd.delivery_days) as cd(delivery_day)
   group by vd.vendor_id
)
```

The `extract(dow from ...)` trick is the simplest portable shape;
the dev may prefer a CASE-on-day-name lookup for readability. The
output is `days_offset INTEGER` ∈ [0..6].

**Edge cases:**

1. **Today is itself a delivery_day.** `days_offset = 0`. The spec
   doesn't specify whether "today's delivery" counts. Decision: treat
   `days_offset = 0` as "delivery is TODAY, next one is in 7 days"
   only when `vendors.order_cutoff_time` has already passed; otherwise
   `days_offset = 0` IS the next delivery (truck arriving today).
   Concretely: if today's wall-clock time > vendor's
   `order_cutoff_time`, force `days_offset = 7`. This matches the
   intent — once you're past cutoff, the reorder for the next cycle
   is in scope.

2. **Vendor has no `order_schedule` row.** Per A5: 7-day default,
   `schedule_known = false`, `next_delivery_date = as_of_date + 7`,
   add a `_warnings` entry. Done in the CTE via a LEFT JOIN —
   vendors without a schedule row fall through to `COALESCE(..., 7)`.

3. **Vendor has multiple delivery days/week.** The
   `unique(store_id, day_of_week, vendor_id)` constraint allows
   multiple `(day_of_week)` rows per vendor — but `delivery_day` per
   row is what matters. We take the MIN distance across all of that
   vendor's delivery_days. So if vendor X delivers Mon and Thu, on
   Tuesday we'd pick Thu (2 days), not Mon (6 days). Correct intent.

4. **`order_cutoff_time` is NULL.** Treat as "no cutoff" — same as
   "cutoff hasn't passed". `days_offset = 0` stays "deliver today".
   This is the safest assumption when the field is unset.

5. **Server TZ vs store TZ.** The variance runner uses
   `current_date` (server-local). The store may be in NY while the
   server is UTC. v1 acceptance: `as_of_date` defaults to server's
   `current_date` UTC; explicit override via `p_params->>'as_of_date'`
   lets the client pass the store's local date. Frontend always
   passes the store-local "today" string (matching the EOD/POS
   convention elsewhere) so this caveat is invisible to users.

### 7. Realtime impact

`useRealtimeSync.ts:34-42` currently subscribes the `store-{id}`
channel to: `inventory_items`, `waste_log`, `eod_submissions`.

The spec AC line 67 says:

> Page refreshes when underlying `eod_submissions`, `purchase_orders`,
> or `inventory_items` change

Two of three are already subscribed. **Add `purchase_orders` to
`store-{storeId}` in `useRealtimeSync.ts`** so the reorder list
re-renders when an order is submitted (which would change
`pending_po_qty` in v2; in v1 it's a no-op signal but the contract
matches the spec). The vendor list refresh is already covered by the
`brand-{brandId}` channel's `vendors` subscription.

**Publication gotcha:** `supabase_realtime` is `FOR ALL TABLES`
(`20260502190000_realtime_publication.sql:14`). Adding a JS-side
subscription doesn't change publication membership — no docker restart
needed. Flag this only as a positive: the migration changes nothing
publication-shaped.

The reorder section component itself does NOT need a section-local
subscription (per the spec 019 pattern note in
`useRealtimeSync.ts:37-42`). The global `onSync` re-fetch covers it
since the section reads from the RPC on mount + on every store-slice
change.

### 8. `src/lib/db.ts` surface

One new helper:

```typescript
export interface ReorderSuggestionItem {
  itemId: string;
  itemName: string;
  unit: string;
  onHand: number;
  pendingPoQty: number;
  parLevel: number;
  usageForecasted: number;
  parReplacement: number;
  suggestedQty: number;
  costPerUnit: number;
  estimatedCost: number;
  flags: string[];
}

export interface ReorderSuggestionVendor {
  vendorId: string;
  vendorName: string;
  scheduleKnown: boolean;
  nextDeliveryDate: string;       // YYYY-MM-DD
  daysUntilNextDelivery: number;
  onHandSource: 'eod' | 'stock';
  eodSubmittedAt: string | null;  // ISO-8601 or null
  items: ReorderSuggestionItem[];
  vendorTotalCost: number;
}

export interface ReorderSuggestionPayload {
  asOfDate: string;
  vendors: ReorderSuggestionVendor[];
  kpis: {
    vendorCount: number;
    itemCount: number;
    totalEstimatedCost: number;
    eodSourcedVendorCount: number;
    stockFallbackVendorCount: number;
  };
  warnings: Array<{ code: string; message: string }>;
}

export async function fetchReorderSuggestions(
  storeId: string,
  asOfDate?: string,
): Promise<ReorderSuggestionPayload>;
```

snake_case → camelCase mapping is the standard local `mapItem`-style
pattern. The RPC returns one JSONB envelope, the helper unpacks and
maps. Errors surface to the caller; `useStore`'s slice wraps with
`notifyBackendError`.

### 9. `useStore` slice — lazy-loaded, mirrors REPORTS-1 `loadLatestRun`

New slice fields:

```typescript
reorderSuggestions: ReorderSuggestionPayload | null;
reorderLoading: boolean;
reorderError: string | null;
loadReorderSuggestions: (asOfDate?: string) => Promise<void>;
```

Actions:

- `loadReorderSuggestions` — calls `db.fetchReorderSuggestions`, sets
  `reorderLoading`/`reorderError`/`reorderSuggestions`. Mirrors the
  `loadLatestRun` pattern in `useStore.ts:2019-2030`. No optimistic
  pre-write — this is a pure read.
- ReorderSection's `useEffect` triggers `loadReorderSuggestions(...)`
  on mount and on `currentStore.id` change. The global realtime
  `onSync` triggers `loadFromSupabase` which does NOT include reorder
  by default — instead the section subscribes to its own
  dependency-driven re-fetch via a second useEffect watching the
  store-slice subscription signals exposed by the global sync. The
  simplest shape: re-call `loadReorderSuggestions()` when `inventory`,
  `eod_submissions` (via the lastSyncToken pattern), or
  `orderSubmissions` change. See §11.

**Edge cases — handled in `useStore` or RPC:**

- Item with NULL `par_level` (§9 in dispatch): SQL treats NULL as 0;
  `par_replacement` falls to 0 → only `usage_forecasted` can drive
  the suggestion. Flag `'no_par'` is attached. **Item is NOT
  excluded** — usage path can still surface it. Matches AC line 62
  hide-when-zero filtering at the vendor grain.
- Item with NULL `usage_per_portion`: forecast contributes 0; flag
  `'no_usage_rate'` attached; `par_replacement` carries it. If both
  are missing → suggested_qty is 0 → item is filtered out (AC line
  62).
- Recipe depth cap hit: `'truncated'` flag, same as variance.
- Vendor with no items in inventory: vendor isn't returned at all —
  there's no row to surface. Matches AC.

### 10. PO creation — DEFERRED to follow-up

The spec lists "Create PO action" as an AC line 60 deliverable.
Audit reality:

- `db.createPurchaseOrder` writes ONLY the `purchase_orders` header.
  No `po_items` write path exists in the live app.
- Wiring "Create PO" without `po_items` would persist a zero-line PO
  the receiving / variance flows can't reconcile against.
- A full implementation needs either a new `db.createPurchaseOrderWithItems`
  helper writing both header + lines, OR a more conservative
  `db.upsertPoDraft(storeId, vendorId, items[])` that creates a
  draft-status PO with line items.

**v1 ships:** a disabled "Create PO" button on each vendor card with
tooltip "Coming soon — manual PO entry only for now". The reorder
list still surfaces the math; the manager copies numbers into the
existing day-card / Orders flow.

**v2 ships:** the new helper. This is a separate spec — surface to
PM as an open question (§Q1 below).

### 11. Frontend section + sidebar registration

New file: `src/screens/cmd/sections/ReorderSection.tsx`. Mirror
`RestockSection.tsx` layout: header KPIs (vendor count, item count,
total estimated cost, eod-vs-stock vendor split), then a per-vendor
card. Each card shows:

- Header: vendor name, `next delivery: <YYYY-MM-DD>` (badge), source
  badge (`EOD` green / `STOCK FALLBACK` warn / `SCHEDULE UNKNOWN`
  warn).
- Item rows: name · breakdown (`on hand: X | inbound: Y | par: Z →
  order: N`) · unit · est cost. Right-aligned numbers in mono font
  (matches variance/cogs).
- Footer: vendor total cost, disabled "Create PO" button (§10).

**Column mapping (RPC field → UI column):**

| RPC field            | UI label / placement                  |
|----------------------|---------------------------------------|
| `item_name`          | Item (left)                           |
| `on_hand`            | "on hand" segment of breakdown        |
| `pending_po_qty`     | "inbound" segment                     |
| `par_level`          | "par" segment                         |
| `suggested_qty`      | "order" segment + standalone column   |
| `unit`               | Suffix on suggested_qty               |
| `cost_per_unit`      | Optional column / hover               |
| `estimated_cost`     | Right-most column                     |
| `flags`              | Icon row next to item name            |

**Sidebar registration** — `src/lib/cmdSelectors.ts`:

```diff
   { id: 'PurchaseOrders',  label: 'Purchase orders' },
   { id: 'Vendors',         label: 'Vendors' },
   { id: 'Categories',      label: 'Categories' },
   { id: 'OrderSchedule',   label: 'Order schedule' },
   { id: 'Recipes',         label: 'Menu items / BOM' },
   { id: 'PrepRecipes',     label: 'Prep recipes' },
   { id: 'Restock',         label: 'Restock' },
+  { id: 'Reorder',         label: 'Reorder' },
```

(Position: immediately after `Restock` in the `Planning` group at
`cmdSelectors.ts:1056`. Also add to `SCREEN_ENTRIES` at line 169 —
the palette index uses this list separately.)

**InventoryDesktopLayout section binding** — add:

```diff
   ) : section === 'Restock' ? (
     <RestockSection />
+  ) : section === 'Reorder' ? (
+    <ReorderSection />
   ) : section === 'PurchaseOrders' ? (
```

at `src/screens/cmd/InventoryDesktopLayout.tsx:164-166`.

### 12. Data-model changes — single migration

Migration filename:
`supabase/migrations/20260514130000_report_reorder_list.sql`

(Date 2026-05-14 sits one day ahead of today's 2026-05-13. The dev
can pick the actual timestamp at write-time; 2026-05-14 is the
template since the EOD-per-vendor work landed on 20260514. Keep it
chronologically after `eod_submissions_vendor_id.sql` since that's
the dependency.)

**Contents — pure additive, no destructive changes:**

- `create or replace function public.report_reorder_list(uuid, jsonb)
  returns jsonb` — the RPC body per §5.
- `revoke execute … from public, anon;`
- `grant execute … to authenticated;`

**Rollout safety:**

- Pure additive — no schema mutation, no FK changes, no policy edits.
- The RPC is `security invoker`, so existing RLS policies on
  `eod_submissions`, `eod_entries`, `inventory_items`,
  `purchase_orders`, `po_items`, `vendors`, `order_schedule`,
  `pos_imports`, `pos_import_items`, `recipes`, `recipe_ingredients`,
  `prep_recipes`, `prep_recipe_ingredients`, `recipe_prep_items`,
  `catalog_ingredients` ALL still apply — no RLS gap risk.
- The auth-gate pre-flight inside the function uses
  `auth_can_see_store()` (same as reports trilogy).
- No indexes needed for v1 — every joined column already has the
  composite index it needs (eod_submissions vendor_id idx from spec
  020, `idx_purchase_orders_store_reference_date` for the v2 swap,
  `idx_waste_log_store_logged_at` from variance, the per-store FK
  indexes on `inventory_items.store_id` etc.).

### 13. RLS impact

No new tables. No existing-table RLS edits.

The RPC reads from 13 tables (full list in §12 rollout safety).
Every one of them already has a per-store policy under
`auth_can_see_store()` (post-`20260504173035_per_store_rls_hardening.sql`)
or a brand-shared policy for catalog tables
(`20260504073942_brand_catalog_p5_rls.sql`). The RPC's
`security invoker` semantics mean every SELECT inside the function
runs as the calling user, so RLS gates each read.

The auth-gate pre-flight at the top of the function provides a
clean `42501` rejection for the "user is on the wrong store"
case, instead of a silent empty-payload (which would mask the
auth issue and confuse the frontend).

### 14. Risks and tradeoffs

| Risk | Mitigation |
|---|---|
| `purchase_orders.status` lifecycle is fictional in v1 (§1). `pending_po_qty` always 0. | Documented; contract preserved for v2. UI breakdown's "inbound: 0" is honest, not deceptive. |
| Usage forecast is sparse in stores with no recent POS imports. | `max(par_replacement, usage_forecasted)` degrades to par-only when forecast is 0. The 'no_usage_rate' / 'no_recent_pos' flags surface the cause. |
| Server tz vs store tz on `as_of_date` default. | Caller-supplies `as_of_date`. Same caveat as variance / cogs runners. |
| Recipe-graph depth cap (5). | Same precedence-and-flag treatment as variance ('truncated' suffix). |
| New stores with no EOD history → blank screen. | Frontend renders an "EOD not submitted yet" empty state. Hard dependency on spec 020 (per-vendor EOD) is acknowledged in the spec's risk register. |
| Realtime debounce (400ms) means the reorder list lags an inserted EOD by ~half a second. | Acceptable for read-mostly UI. |
| RPC payload could be large for huge stores. | The largest seed store has ~tens of vendors × tens of items. JSONB serialisation cost is negligible at this scale. v2 can add pagination if needed. |
| The "as_of_date" lookup with EOD has a subtle dependency on `eod_submissions.status = 'submitted'` — draft submissions are excluded (matching variance line 158-159). | Documented in §5 step 3. |

### Open questions for PM (no blockers — surfaces only)

**Q1 — "Create PO" action.** §10 outlines two options for v2 (new
`createPurchaseOrderWithItems` helper vs. `upsertPoDraft`). PM decides
the v2 spec's scope. v1 ships a disabled button.

**Q2 — `purchase_orders.status` lifecycle cleanup.** §1 found the
schema comment doesn't match reality. The reports trilogy and the
PoS section both work around it differently. A separate spec could
either (a) add a CHECK constraint enforcing one canonical enumeration,
(b) refactor the live PO flow to write `'sent'` instead of
`'submitted'`, or (c) leave the comment and document the
`received_at IS NULL` substitute as the canonical "in flight" gate.
PM call.

**Q3 — App.json slug.** Per CLAUDE.md, not touching. No reorder
implication.

### Files the developer will touch

**Backend:**
- NEW: `supabase/migrations/20260514130000_report_reorder_list.sql`

**Frontend:**
- NEW: `src/screens/cmd/sections/ReorderSection.tsx`
- MODIFIED: `src/lib/db.ts` — add `fetchReorderSuggestions` +
  Reorder* types
- MODIFIED: `src/store/useStore.ts` — add reorder slice (state +
  `loadReorderSuggestions`)
- MODIFIED: `src/lib/cmdSelectors.ts` — add `Reorder` to
  `SCREEN_ENTRIES` (line 159-174) and the Planning group (line
  1047-1057)
- MODIFIED: `src/screens/cmd/InventoryDesktopLayout.tsx` — bind
  `section === 'Reorder'` (line 164-166)
- MODIFIED: `src/hooks/useRealtimeSync.ts` — add
  `purchase_orders` subscription on the `store-{id}` channel
  (line 34-42)
- NEW (optional): a `types/index.ts` export bump for the new
  Reorder* types so the section can import them from one place

## Handoff

next_agent: backend-developer, frontend-developer
prompt: Implement against the design in this spec. Backend dev:
  author the migration `supabase/migrations/20260514130000_report_reorder_list.sql`
  per §5 (RPC structure), §6 (schedule math), §12 (rollout). Honour
  the v1-vs-v2 split — pending_po_qty is a payload column but its
  value is 0 in v1; usage forecast is included but degrades to 0 when
  inputs are sparse. After implementation, set Status: READY_FOR_REVIEW
  and list files changed under ## Files changed.
  Frontend dev: build `ReorderSection.tsx` per §11; add the
  `fetchReorderSuggestions` helper in `src/lib/db.ts` per §8; add
  the lazy-loaded slice in `src/store/useStore.ts` per §9; register
  the sidebar entry per §11; add the realtime `purchase_orders`
  subscription per §7. The "Create PO" button is DISABLED with a
  tooltip per §10 — do not wire it.
payload_paths:
  - specs/021-reorder-delivery-list/spec.md

## Files changed

Frontend (this implementation):
- NEW: `src/screens/cmd/sections/ReorderSection.tsx` — vendor-grouped
  reorder list. Per-vendor card with `next delivery / source / schedule`
  badges, an inline `on hand | inbound | par → order` breakdown per
  item, a per-vendor totals strip in the footer, and a DISABLED
  "Create PO" button with a tooltip (deferred to spec 022 per
  architect §10). Lazy-loads via `loadReorderSuggestions` on mount;
  empty state / load-error pane / per-warning callouts wired.
- MODIFIED: `src/lib/cmdSelectors.ts` — registered `Reorder` in
  `SCREEN_ENTRIES` (palette index) and in the Planning sidebar group
  immediately after `Restock` (architect §11).
- MODIFIED: `src/screens/cmd/InventoryDesktopLayout.tsx` — imported
  `ReorderSection` and added the `section === 'Reorder'` dispatch arm.
- MODIFIED: `src/hooks/useRealtimeSync.ts` — added a
  `purchase_orders` postgres_changes subscription on `store-{id}` so
  the section refreshes when PO state changes (v2 dependency; v1 is a
  no-op signal since `pending_po_qty` is always 0).
- MODIFIED: `src/lib/db.ts` — added `fetchReorderSuggestions(storeId,
  asOfDate?)` calling the `report_reorder_list` RPC; private
  `mapReorderVendor` does snake_case → camelCase per the local
  `mapItem`-style convention.
- MODIFIED: `src/store/useStore.ts` — added `reorderPayload` /
  `reorderLoading` / `reorderError` state slots and the
  `loadReorderSuggestions(asOfDate?)` action. Errors surface to
  `reorderError` (rendered in-section), not toast — matches the
  reports detail-frame pattern.
- MODIFIED: `src/types/index.ts` — exported `OnHandSource`,
  `ReorderItem`, `ReorderVendor`, `ReorderPayload` (architect §8).
  Extended `AppState` with the three reorder slots.

Backend (this implementation, backend-developer):
- NEW: `supabase/migrations/20260514130000_report_reorder_list.sql`
  — `report_reorder_list(p_store_id uuid, p_params jsonb) returns
  jsonb`. `security invoker`, `set search_path = public`, language
  plpgsql. First gate is `auth_can_see_store(p_store_id)` raising
  `42501`. Builds the architect-§3 envelope:
  `{ as_of_date, vendors[items, on_hand_source,
    schedule_known, next_delivery_date, days_until_next_delivery,
    eod_submitted_at, vendor_total_cost], kpis{vendor_count, item_count,
    total_estimated_cost, eod_sourced_vendor_count,
    stock_fallback_vendor_count}, _warnings[] }`.
  `pending_po_qty` is in every item but always `0` in v1 (see header
  comment + architect §1). Per-vendor next-delivery math computes the
  MIN days_offset across `order_schedule.delivery_day` rows; vendors
  with no schedule fall back to `as_of_date + 7` with a
  `schedule_unknown` warning. Today-is-delivery + cutoff-passed math
  pushes `days_offset` to 7 per architect §6 case 1. `grant execute …
  to authenticated; revoke … from public, anon;` mirror the foundation
  pattern. Header comment documents the `purchase_orders.status`
  lifecycle uncertainty, the v1-vs-v2 PO-subtraction swap, and the
  disabled-in-v1 "Create PO" UI.

Verification notes:
- `npx tsc --noEmit` introduces zero new errors against the changed
  files. The pre-existing repo-wide count (121 errors as of this
  implementation) is unchanged.
- Local migration applied via `docker exec -i supabase_db_imr-inventory
  psql -U postgres -d postgres < <migration>` — `CREATE FUNCTION /
  REVOKE / GRANT` clean.
- Direct RPC smoke test under impersonation against local Supabase:
  - As admin (`admin@local.test`), Towson store: returns 10 vendors,
    139 items, $13,037.12 estimated total, 10 `schedule_unknown`
    warnings (Towson seed has no order_schedule rows). `as_of_date`
    echoes `2026-05-13`. All items show `on_hand_source = 'stock'`,
    `pending_po_qty = 0`.
  - As manager (`manager@local.test`) requesting Charles (store
    they're NOT in `user_stores`): raises `Not authorized for store
    1ea549bb-…` (errcode `42501`). Same call against Towson (which
    they DO have) returns identical payload to admin.
  - With one `eod_submissions` row inserted for US FOOD today + one
    `eod_entries` row at `actual_remaining = 0.5`: US FOOD vendor's
    `on_hand_source` flips to `'eod'`, the populated item shows
    `on_hand = 0.500` (the EOD value), unpopulated items in the same
    vendor show `on_hand = current_stock` with flag
    `["no_usage_rate","eod_missing_for_item"]`.
  - With an `order_schedule` row added for US FOOD (delivery_day =
    Friday): `next_delivery_date = 2026-05-15`, `days_until = 2`,
    `schedule_known = true`. Setting `delivery_day = Wednesday` with
    `vendors.order_cutoff_time = '09:00'` (before now UTC) keeps
    `days_until = 0`. Pushing cutoff to `'03:00'` (past now UTC)
    forces `days_until = 7`, `next_delivery_date = 2026-05-20`.
  - `as_of_date` override via `p_params`: `'{"as_of_date":"2026-05-15"}'`
    returns `as_of_date: '2026-05-15'` in the envelope, vendor list
    shifts to deliveries relative to the new anchor.
- Browser-preview verification was NOT possible in this session
  because the `preview_*` / `claude-in-chrome` MCP tools weren't
  exposed to the agent. Code paths were exercised via direct PostgREST
  calls and a Metro bundle sanity check (12 MB bundle includes the
  new symbols; no `BUNDLING FAILED` / `TransformError` strings). A
  reviewer should open the section in the browser and confirm the
  vendor cards render as designed (one badge per vendor, breakdown
  line per item, disabled Create PO button with hover tooltip).

### Round-2 fixes (post-review, addressing FIXES_NEEDED)

Reviewers flagged 1 Critical (multi-delivery-day `MIN(DOW)` bug) and
3 Should-fix items. All four addressed in this round:

- MODIFIED: `supabase/migrations/20260514130000_report_reorder_list.sql`
  — two changes:
  1. **P0 — `vendor_delivery_offsets` MIN-DOW fix.** Rewrote the
     lateral subquery so the per-delivery-day distance
     `((dow - today_dow + 7) % 7)` is computed for every distinct
     delivery DOW first, the cutoff-on-day push-to-7 is applied per
     row (where `distance = 0` AND cutoff passed), THEN `MIN` is
     taken over the resulting distances. Previous shape ran
     `MIN(dow_number)` first, which for a Wed (3) + Fri (5) vendor
     on Thursday (4) picked Wed → computed `(3-4+7)%7 = 6` instead
     of the correct Fri → `(5-4+7)%7 = 1`. Added a multi-line
     comment block above the CTE explaining the intent so it won't
     be re-broken. Verified via direct RPC call: Wed+Fri vendor
     called on Thursday 2026-05-14 returns `days_until=1` (was 6).
     Single-day on the same day: before cutoff → 0, after cutoff →
     7. Multi-day where today is one of the days: before cutoff →
     0, after cutoff → 2 (Fri wins, Wed pushed to 7).
  2. **P1 — warnings scope.** Restructured the warnings CTE to join
     against `surfaced_vendor_ids` extracted from the already-built
     `v_vendors` jsonb envelope. A vendor whose items are all at par
     and is filtered out of the payload no longer generates a
     `schedule_unknown` warning. Verified: setting US FOOD's
     `current_stock = par_level` for all items dropped it from
     vendors AND from warnings simultaneously; SYSCO (below par, no
     schedule) still appears in both.

- MODIFIED: `src/store/useStore.ts` — **P1: store-switch clear.**
  Added `reorderPayload: null, reorderLoading: false, reorderError:
  null` to the `set(...)` in `loadFromSupabase` where `orderSchedule`
  is reset. `setCurrentStore` calls `loadFromSupabase(store.id)` on
  every switch, so this is the canonical clear point. Updated the
  comment on the initial-state slot (line 416-422) to describe the
  actual clearing behaviour instead of the prior aspirational version.

- MODIFIED: `src/screens/cmd/sections/ReorderSection.tsx` — **P1:
  badge masking.** Replaced the precedence ladder (`SCHEDULE UNKNOWN`
  vs `EOD` vs `STOCK FALLBACK`) with two orthogonal badges rendered
  side-by-side: `sourceBadgeEl` (always `EOD` or `STOCK FALLBACK`)
  plus `scheduleBadgeEl` (only `SCHEDULE UNKNOWN`, only when
  `scheduleKnown=false`). The `7-DAY DEFAULT` chip continues to
  render as its own independent badge. A vendor with fresh EOD today
  AND no order_schedule now shows EOD + SCHEDULE UNKNOWN + 7-DAY
  DEFAULT in a single horizontal flex row.

Verification this round:
- TypeScript: `npx tsc --noEmit` introduces ZERO new errors against
  the touched files (`src/store/useStore.ts`,
  `src/screens/cmd/sections/ReorderSection.tsx`). Pre-existing
  repo-wide error count is unchanged.
- Migration: re-applied cleanly via `docker exec -i
  supabase_db_imr-inventory psql -U postgres -d postgres <
  <migration>` → `CREATE FUNCTION / REVOKE / GRANT`.
- RPC smoke (under impersonated `authenticated` role with
  `app_metadata.role=admin`):
  - Baseline Towson call unchanged: 10 vendors, 139 items, 10
    warnings, `as_of_date=2026-05-13`.
  - Manager-on-Charles still 42501.
  - Wed+Fri vendor on Thursday → `days_until=1`, `next_delivery=
    2026-05-15`. Was 6/2026-05-20 pre-fix.
  - Wed-only vendor on Wednesday with cutoff 23:59 → `days_until=0`;
    with cutoff 00:01 → `days_until=7`.
  - Wed+Fri vendor on Wednesday with cutoff 23:59 → `days_until=0`
    (today's Wed delivery wins); with cutoff 00:01 → `days_until=2`
    (Wed pushed to 7, Fri at 2 wins).
  - US FOOD with `current_stock=par_level` for all items: 0
    occurrences in vendors[], 0 occurrences in `_warnings`. SYSCO
    (below par, no schedule) still 1 in each.
