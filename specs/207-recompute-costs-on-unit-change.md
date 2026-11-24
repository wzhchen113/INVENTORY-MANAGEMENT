# Spec 207: Recompute every store's cost when an item's pack size changes

Status: READY_FOR_REVIEW

Origin: a prod cost bug found and repaired by hand on 2026-11-23 (see "Prod repair already done" below). The owner approved writing this spec and, on 2026-11-23, accepted the recommended answer to all three open questions (relayed by the coordinator: "Accept recommendations"). Line numbers are pointers, not contracts. The folder [specs/207-recompute-costs-on-unit-change/](207-recompute-costs-on-unit-change/) holds the repair's undo file and must be kept.

## User story

As a brand admin, I want every store's stored cost per unit to follow an item's pack size when I change units/case or sub-units, whichever stores I pick under "Save to", so that reorder totals, food cost, inventory value and dashboard KPIs stay correct at every store.

## The problem (verified in the tree, 2026-11-23)

- **The cost rule (spec 104).** `cost_per_unit` is the per-each cost: `case_price / (case_qty × sub_unit_size)`. Each factor counts as 1 when it is null or <= 0 ([src/utils/perEachCost.ts](../src/utils/perEachCost.ts) `piecesPerCase` L29-33; [src/utils/unitConversion.ts](../src/utils/unitConversion.ts) `calcUnitCost` L309-313). Consumers multiply back by `sub_unit_size`. For example, `report_reorder_list` estimated cost is `qty × cost_per_unit × sub_unit_size` ([supabase/migrations/20261118120000_reorder_primary_wins_borrowed_count.sql](../supabase/migrations/20261118120000_reorder_primary_wins_borrowed_count.sql) L705-706).
- **Cost is stored per store, in two places.**
  - `public.inventory_items.cost_per_unit` (with `case_price`).
  - `public.item_vendors.cost_per_unit` (with its own `case_price`, one per vendor link).
  - The reorder RPC reads `coalesce(nullif(iv.cost_per_unit, 0), ii.cost_per_unit, 0)` (same file, L306).
- **Pack size is brand-wide, but cost is only re-derived in the editor, and only for some stores.**
  - `case_qty` and `sub_unit_size` live on `catalog_ingredients`. The editor help text says "Name, category, unit and pack size always update every store" ([src/i18n/en.json](../src/i18n/en.json) L519).
  - The editor re-derives cost client-side when units/case or sub-units change ([src/components/cmd/IngredientForm.tsx](../src/components/cmd/IngredientForm.tsx) L926-950, `derivedUnitCost` L314-317).
  - Save ([src/components/cmd/IngredientFormDrawer.tsx](../src/components/cmd/IngredientFormDrawer.tsx) L289-373) writes the edited store's row, then fans out `par_level` / `cost_per_unit` / `case_price` to the other stores picked under "Save to", through `apply_item_scalars_to_brand`.
  - So "This store" leaves every other store's `inventory_items.cost_per_unit` on the old pack size.
  - Even "All stores" never touches other stores' `item_vendors.cost_per_unit`. The scalar fan-out only writes `inventory_items` ([supabase/migrations/20261115120000_apply_item_scalars_store_subset.sql](../supabase/migrations/20261115120000_apply_item_scalars_store_subset.sql) L72-79). The reorder list reads `item_vendors` first, so it stays wrong.
- **Other causes of bad rows.** Some rows had cost 0, or the full case price stored as the cost, probably from older imports and saves before spec 104. Two current write paths can still create such rows (see the write-path inventory, items 3 and 10).

## Prod repair already done (record only; not part of the build)

- **When / who.** 2026-11-23, done by main Claude with the owner's approval, on prod `ebwnovzzkwhsdxkpyjka`.
- **Impact before the repair.**
  - 86 of 887 priced `inventory_items` rows did not match `case_price ÷ (units/case × sub-units)`.
  - 85 of 888 priced `item_vendors` rows did not match either.
  - About 26 items were affected.
  - Example: Fry Oil Canola (each, 1/case, 35 lbs) at Towson, Frederick and Reisterstown stored 33.95 (the jug price) as the cost per lb. A 3-jug reorder showed $3,564.75 instead of $101.85.
- **Rule applied.** `cost_per_unit := round(case_price / (units_per_case × sub_units), 6)`, each factor taken as 1 when <= 0. It was applied only to rows where `|old − new| > max(0.01, 2% of new)`. Both tables were repaired in one transaction. Mismatches above that tolerance are now 0.
- **Undo file.** [specs/207-recompute-costs-on-unit-change/prod-cost-repair-undo-2026-11-23.json](207-recompute-costs-on-unit-change/prod-cost-repair-undo-2026-11-23.json). It has 171 rows (86 `inventory_items` + 85 `item_vendors`), each with id, item name, store, case_price, old cost and new cost. To undo a row: `update public.<table> set cost_per_unit = <old> where id = <id> and cost_per_unit = <new>`.
- **What stays on prod.** Rows within the tolerance were left alone, so small rounding-level differences can remain. They settle on their next priced write (R3). This spec adds no backfill (see Out of scope).

## Write-path inventory (investigated 2026-11-23)

### A. Paths that change `case_qty` / `sub_unit_size` on an existing catalog row

| # | Path | Re-derives other stores' cost today? |
|---|------|--------------------------------------|
| 1 | `db.updateInventoryItem` catalog PATCH ([src/lib/db.ts](../src/lib/db.ts) L511-557), a plain PostgREST `update` on `catalog_ingredients`. Callers: `useStore.updateItem` ([src/store/useStore.ts](../src/store/useStore.ts) L2542-2594), which serves (a) the editor Save and (b) CSV import `commitImport` ([src/lib/csvImport.ts](../src/lib/csvImport.ts) L481; the `pack_size` column maps to `caseQty` only, L251-252). | Editor: the edited row, plus `inventory_items` in the picked stores. Never other stores' `item_vendors`. CSV import: no re-derivation at all. |
| 2 | Direct SQL (dashboard SQL editor / MCP). | No. |

No RPC changes pack size on an existing catalog row:
- `create_inventory_item_with_catalog` deliberately keeps the existing row's values when it reuses a catalog row.
- `copy_brand_catalog` / `copy_catalog_rows` only insert new catalog rows in another brand.

### B. Paths that write `case_price` / `cost_per_unit`

| # | Path | Keeps cost = case_price ÷ pieces? |
|---|------|-----------------------------------|
| 3 | `create_inventory_item_with_catalog` ([supabase/migrations/20261023000000_catalog_eod_count_mode.sql](../supabase/migrations/20261023000000_catalog_eod_count_mode.sql) L89-183), plus the `item_vendors` upsert in `db.createInventoryItem` (db.ts L454-477). | Yes for a new catalog row. **No when it reuses an existing catalog row.** The editor derived the cost from the form's units/case and sub-units, but the RPC keeps the catalog's stored values, so the new store's row can be wrong from the start. |
| 4 | `db.updateInventoryItem` per-store PATCH (db.ts L559-579) and `item_vendors` upsert (L624-639). | Yes when called from the editor (cost is derived from the form). Not from CSV import (see 10). |
| 5 | `apply_item_scalars_to_brand` (20261115120000 L72-79): Save-to fan-out of the editor's (cost, case_price) pair. | Yes, since it writes a consistent pair. It only covers `inventory_items`. |
| 6 | `apply_item_vendors_to_brand` ([supabase/migrations/20260724000000_apply_item_vendors_product_page_url.sql](../supabase/migrations/20260724000000_apply_item_vendors_product_page_url.sql)): a new link takes the submitted cost/case price; an existing link's cost is left alone. | Yes for new links. Existing links keep whatever they had. |
| 7 | `receive_purchase_order` with `new_case_price` ([supabase/migrations/20260707000000_staff_receiving_price_gate.sql](../supabase/migrations/20260707000000_staff_receiving_price_gate.sql) L264-289) updates the `item_vendors` link and the item row. | Yes. It computes `new_case_price / (coalesce(case_qty,1) × coalesce(sub_unit_size,1))`. That divisor does not apply the `<= 0 → 1` guard and does not round. |
| 8 | `auto_receive_due_purchase_orders` ([supabase/migrations/20260719000000_auto_receive_due_purchase_orders.sql](../supabase/migrations/20260719000000_auto_receive_due_purchase_orders.sql)). | Not a cost writer (stock only). |
| 9 | `stock_store_from_store` ([supabase/migrations/20261105000000_stock_store_from_store.sql](../supabase/migrations/20261105000000_stock_store_from_store.sql) L211-269) copies the source store's (cost, case_price) pairs. | Only if the source rows are consistent. It copies drift as-is. |
| 10 | CSV import `commitImport` (csvImport.ts L445-481). The `last_cost` column maps to `costPerUnit`. Create sends `casePrice: 0`; update sends the cost without touching `case_price`. | **No.** On a priced row, an imported cost breaks the pair. |
| 11 | `set_item_primary_vendor` ([supabase/migrations/20261118120100_set_item_primary_vendor.sql](../supabase/migrations/20261118120100_set_item_primary_vendor.sql)). | Not a cost writer (`is_primary` / `vendor_id` only). |
| — | Edge functions. | None write these columns. `breadbot-nightly-sync` writes `current_stock` only. |

R3 (derive on write) brings paths 3, 9, 10, direct SQL and any future writer onto the rule for priced rows. R1 covers paths 1 and 2.

### Can a correct cost legitimately differ from case_price ÷ pieces?

Checked; no.
- There is no stored average-cost or moving-average logic. No migration matches `avg_cost` / `average_cost` / `weighted`.
- The "Avg cost / unit" in [src/screens/cmd/sections/InventoryCatalogMode.tsx](../src/screens/cmd/sections/InventoryCatalogMode.tsx) (L145-156, L486-488) is a stock-weighted mean across stores, computed on screen, and never stored.
- Receiving (path 7) writes a consistent pair.
- `inventory_items` and its `item_vendors` links can carry different case prices for the same store, which is legitimate (different vendors). The rule therefore holds per row, each row using its own `case_price`.

The only writers that leave a priced row (`case_price > 0`) off the rule are:
- a pack-size change (this bug);
- CSV `last_cost` (path 10);
- the create-reuse branch (path 3);
- direct SQL.

So "for `case_price > 0`, `cost_per_unit = round(case_price / pieces, 6)`" is safe to enforce. The one visible effect is that CSV `last_cost` is ignored for priced rows. The owner accepted this (OQ-1).

## Requirements

- **R1. Re-derive on a pack-size change.**
  - When an UPDATE to `public.catalog_ingredients` changes the effective `case_qty` or `sub_unit_size`, the same transaction re-derives cost for the rows below. "Effective" means after the null / <= 0 → 1 rule.
    - every `public.inventory_items` row with that `catalog_id` at a store of the catalog's brand (`stores.brand_id = catalog_ingredients.brand_id`); rows at another brand's store that point at this catalog row are never touched. (Amended 2026-11-24 per the release proposal, fix 1 — security review Medium.)
    - every `public.item_vendors` row whose `item_id` belongs to one of those `inventory_items` rows.
  - It runs for every writer: the PostgREST PATCH in `db.updateInventoryItem`, CSV import, direct SQL, and any future RPC. So it must live in the database, not in the client or one RPC. The architect chooses the mechanism (a trigger is the natural fit).
  - It reaches every store of the catalog's brand, whatever the caller's own store visibility. The catalog row is brand-wide and the editor already says pack size "always updates every store".
- **R2. The rule.**
  - **Priced rows (`case_price > 0`):** `cost_per_unit := round(case_price / pieces, 6)`, using that row's own `case_price`.
  - **Unpriced rows (`case_price <= 0` or null), on a pack-size change only (OQ-2):** `cost_per_unit := round(cost_old × old_pieces / new_pieces, 6)`. This keeps the implied case price the same. A cost of 0 (or null) stays as it is.
  - `pieces = q × s`, where `q = case_qty` and `s = sub_unit_size`, each taken as 1 when null or <= 0. This matches `piecesPerCase`. `old_pieces` uses the catalog row's values before the UPDATE; `new_pieces` uses the values after it.
  - 6 dp matches the `numeric(12,6)` column scale (spec 104) and the editor's `toFixed(6)`.
  - The architect decides whether to put the formula in one SQL helper reused by R1, R3 and R4. Recommended: yes, so the SQL rule cannot drift from `piecesPerCase`.
- **R3. Derive on write (OQ-1).**
  - On INSERT into `inventory_items` / `item_vendors`, or an UPDATE that sets `case_price` or `cost_per_unit`, a row with `case_price > 0` stores the R2 priced value, using its catalog row's current pack size. Whatever cost the writer sent is replaced.
  - An unpriced row keeps the cost written to it.
  - An UPDATE that touches neither column (stock, par, EOD fields, `vendor_id`, `is_primary`, `order_code`, `product_page_url`) must not run the derivation. Otherwise every EOD submission pays a catalog lookup per row.
  - Paths 3 (create-reuse), 9 (stock-store copy), 10 (CSV `last_cost`), direct SQL and future writers are covered by this rule. No per-path code change is required for them.
- **R4. Drift listing (OQ-3).**
  - A read-only database function lists every priced row whose stored cost differs from the R2 value by more than `max(0.01, 2% of derived)`, the repair's tolerance. It covers both tables.
  - Columns: table, row id, store, catalog item name, case_price, case_qty, sub_unit_size, stored cost, derived cost.
  - Unpriced rows that carry a cost > 0 are listed separately (or flagged) as "cost with no case price", for information only.
  - Access: callable only by privileged roles (`auth_is_privileged()`); anon and non-privileged callers are refused. It returns only stores the caller can see, and super_admin sees all.
  - Its job is running on prod on demand (MCP / SQL editor). CI checks it only against pgTAP fixtures, not seed data. There is no Cmd UI surface.
- **R5. No change to frozen history.** `po_items.cost_per_unit`, `waste_log.cost_per_unit` and POS import rows are never touched (specs 104 R1, 186, 194).
- **R6. No client change is required.**
  - The client already reloads on `catalog_ingredients` changes over `brand-{id}` ([src/hooks/useRealtimeSync.ts](../src/hooks/useRealtimeSync.ts) L67), so the acting client picks up the re-derived costs. Other stores' clients reload on their own `store-{id}` channels.
  - The editor's client-side derivation and the Save-to fan-out stay as they are. They write values the server would derive anyway.
  - If the architect finds a client change necessary, it stays the minimum needed and gets a jest test.

## Acceptance criteria

- [ ] **AC-1 (units/case).** Fixture: catalog item with `case_qty = 1`, `sub_unit_size = 1`; store A and store B rows with `case_price = 33.95`; each store has one `item_vendors` link with `case_price = 33.95`. A privileged caller updates `catalog_ingredients.case_qty` to 2 through PostgREST-equivalent SQL. Afterwards:
  - all four rows read `cost_per_unit = 16.975000`;
  - store B's rows were updated, even though only the catalog row was written.
- [ ] **AC-2 (sub-units, the Fry Oil case).** Same fixture, `sub_unit_size` changed 1 → 35. All four rows read `round(33.95 / 35, 6) = 0.970000`. For store B, `report_reorder_list` reports `estimated_cost` within $0.01 of `cases × 33.95` for this item. A 3-case suggestion gives 101.85, not 3,564.75.
- [ ] **AC-3 (each link's own case price).** An `item_vendors` link with `case_price = 40` next to an item row with `case_price = 33.95` re-derives to `round(40 / pieces, 6)`, not to the item row's price.
- [ ] **AC-4 (guard on zero or null).** `case_qty` set to 0 or NULL is treated as 1. The same applies to `sub_unit_size`. Derived costs match `calcUnitCost` / `piecesPerCase` for the same inputs.
- [ ] **AC-5 (no-op updates write nothing).** A `catalog_ingredients` UPDATE that leaves effective pieces unchanged leaves `updated_at` and `cost_per_unit` unchanged on every `inventory_items` / `item_vendors` row for that item. Examples: resending the same `case_qty`, renaming, changing `i18n_names`, `image_path` or `eod_count_mode`.
- [ ] **AC-6 (every store of the brand, and only the brand).** A privileged caller who cannot see store B under `auth_can_see_store()` changes pack size, and store B's rows are re-derived. If the architect finds no such caller can exist under the current role model, the pgTAP test states that and checks the all-stores case instead. A row at **another brand's** store that carries this catalog row's `catalog_id` (possible through the FU-3 insert gap), and its links, are **not** re-derived and not written. A planted brand-2 unpriced row whose OQ-2 scaling would overflow `numeric(12,6)` does not block a brand-1 pack-size edit. (Amended 2026-11-24 per the release proposal, fix 1 — security review Medium.)
- [ ] **AC-7 (unpriced rows scale, OQ-2).**
  - A row with `case_price = 0` and `cost_per_unit = 0.5` at pieces 1 reads `round(0.5 × 1 / 35, 6) = 0.014286` after `sub_unit_size` changes 1 → 35.
  - Changing it back 35 → 1 gives `round(0.014286 × 35 / 1, 6) = 0.500010`. The test asserts that value, so the round trip is pinned to a known 6 dp result rather than treated as exact.
  - A row with `case_price = 0` and `cost_per_unit = 0` stays 0.
  - The same holds for an unpriced `item_vendors` link.
- [ ] **AC-8 (derive on write, OQ-1).**
  - Inserting or updating an `inventory_items` / `item_vendors` row with `case_price = 30` on a catalog item with pieces 6, while sending `cost_per_unit = 30`, stores `5.000000`.
  - `create_inventory_item_with_catalog` reusing an existing catalog row (pieces 6) with `p_case_qty = 1` and `case_price = 30` produces a row with `cost_per_unit = 5.000000`.
  - A CSV-style update that sends only `cost_per_unit = 9` to a row with `case_price = 30` at pieces 6 stores `5.000000`.
  - An unpriced row (`case_price = 0`) written with `cost_per_unit = 9` stores `9.000000`.
  - An update of only `current_stock` on a priced row does not run the derivation. Check this either way:
    - a row whose stored cost was deliberately left off the rule (fixture inserted with the derivation trigger disabled) keeps that cost;
    - or show that the column-limited trigger does not fire.
- [ ] **AC-9 (receiving unchanged).** `receive_purchase_order` with a changed `new_case_price` still updates the link and the item row. Its returned `price_changes[].new_cost_per_unit` equals the stored value. The existing [supabase/tests/cost_on_receipt.test.sql](../supabase/tests/cost_on_receipt.test.sql) and `staff_receiving_gate.test.sql` stay green.
- [ ] **AC-10 (drift listing, OQ-3).**
  - The drift function returns exactly the fixture rows seeded off the rule beyond the tolerance, and returns no row within the tolerance.
  - It lists an unpriced row with cost > 0 in the separate "cost with no case price" set, not as drift.
  - It refuses a non-privileged authenticated caller and anon.
  - A privileged caller sees only stores visible to them; super_admin sees all.
  - It writes nothing. A call leaves every row's `updated_at` unchanged.
- [ ] **AC-11 (history untouched).** A pack-size change leaves `po_items.cost_per_unit` and `waste_log.cost_per_unit` unchanged for that item.
- [ ] **AC-12 (gates green).**
  - The new pgTAP file(s) under `supabase/tests/` cover AC-1 to AC-11.
  - The full pgTAP suite (`scripts/test-db.sh`), full `npx jest`, `typecheck` and `typecheck:test` pass.
  - Existing fixtures that insert inconsistent (cost, case_price) pairs (about 37 test files mention `case_price`) are audited. Where R3 now rewrites their cost, they are updated to assert the derived value. They are not weakened.
- [x] **AC-13 (prod check after apply).** After the migration is applied to prod, the drift function returns 0 priced rows above the tolerance. The repair already brought these to 0, and the result is recorded in the spec's rollout notes.

## In scope

- One migration: R1, R2, R3 and R4.
- pgTAP tests for all of the above.
- Updating existing pgTAP fixtures that R3 changes (AC-12).
- Recording the prod rollout check (AC-13).

## Out of scope (explicitly)

- **Re-running or extending the prod repair, or any backfill migration.** Prod was repaired on 2026-11-23. Rows left within the repair tolerance settle on their next priced write (R3).
- **Changing the per-each formula, the `× sub_unit_size` consumer bridge, or the reorder `coalesce(nullif(iv.cost_per_unit,0), ii.cost_per_unit, 0)` fallback.** These are correct; only stale stored values were wrong.
- **CSV import semantics** (what `last_cost` and `pack_size` mean, adding a `case_price` / `sub_unit_size` column, or making the preview hide a `last_cost` change the server will ignore). Follow-up. After this spec, the preview still lists a `last_cost` change for a priced item that R3 then replaces.
- **`catalog_ingredients.default_cost` / `default_case_price`.** They are seeded on catalog create and no live cost path reads them. Not re-derived.
- **Recomputing frozen history** (`po_items`, `waste_log`, POS rows). Business records are kept as written (specs 186, 194).
- **Audit rows per re-derived store.** The editor's `Item edit` audit event already records the pack-size change. A per-store cost audit trail is a follow-up if wanted.
- **A Cmd UI drift indicator.** OQ-3 chose the DB function only. A follow-up spec can add one.
- **Editor copy changes.** The help text "pack size always update every store" stays true.
- **`seed.sql` cleanup.** The drift check asserts on pgTAP fixtures only, not seed data.
- **`app.json` identity.** Not touched.

## Open questions resolved

- Q: Is the prod data repair part of the build? → A: No. Done by hand on 2026-11-23 with the owner's approval and recorded above (task brief).
- Q: Should the fix live in the client or the server? → A: Server, so every write path is covered (task brief). The exact mechanism is the architect's call.
- Q (OQ-1): How far should the server enforce the rule: only on a pack-size change, plus a fix to the create-reuse branch, or derive cost on every priced write? → A: **(b)**. Re-derive on pack-size change (R1), and derive cost on every INSERT, or every UPDATE that sets `case_price` / `cost_per_unit`, on `inventory_items` / `item_vendors` where `case_price > 0` (R3). The owner accepted that CSV `last_cost` is ignored for priced rows. (Owner, 2026-11-23, relayed by the coordinator: "Accept recommendations".)
- Q (OQ-2): What happens to a row with no case price when pack size changes? → A: **(a)**. Scale its cost by `old_pieces / new_pieces`, rounded to 6 dp; a cost of 0 stays 0 (R2, AC-7). (Owner, 2026-11-23, same reply.)
- Q (OQ-3): How should drift be visible? → A: **(b)**. pgTAP tests plus a read-only, privileged-only database function that lists drifted rows and can be run on prod on demand (R4, AC-10). No Cmd UI indicator. (Owner, 2026-11-23, same reply.)

## Dependencies

- Spec 104: per-each cost basis, `numeric(12,6)` columns, `piecesPerCase` / `calcUnitCost`.
- Spec 102: `item_vendors` per-link cost.
- Spec 122 and the store-scope picker migration `20261115120000`: Save-to fan-out of scalars.
- Specs 109 / 113: cost on receipt, `receive_purchase_order`.
- Specs 119 / 124: `apply_item_vendors_to_brand`.
- Spec 205: RLS read-visibility pattern. Relevant if the drift function reads through RLS.
- Spec 206: single-flight realtime reload. It absorbs the burst of row events a pack-size change now causes.
- Spec 179: `inventory_items` identity-lock trigger. The new logic must not write `id` / `store_id`. The order of BEFORE UPDATE triggers by name is a design note for the architect.

## Project-specific notes

- **Cmd UI section / legacy.** None. This is backend-only work.
- **Per-store or admin-global.** Triggered by a brand-wide catalog change and fanned out to every store of the brand, whatever the caller's store visibility (R1). The drift function is per-store scoped to caller visibility (R4).
- **Realtime channels touched.**
  - No publication change. `catalog_ingredients`, `inventory_items` and `item_vendors` are already in `supabase_realtime`, so the docker-restart gotcha does not apply.
  - Behavior change: one pack-size edit now emits `inventory_items` events on every store's `store-{id}` channel and unfiltered `item_vendors` events.
  - Connected clients reload once each, debounced and single-flight per spec 206. Treat this as a load risk for brands with many stores.
- **Migrations needed.** Yes, one. Prod apply goes through the MCP path (execute_sql plus inserting the exact version into `schema_migrations`). After pushing to `main`, both CI gates (`test.yml`, `db-migrations-applied.yml`) must be green.
- **Edge functions touched.** None.
- **Web/native scope.** Both, through the shared backend. No platform-specific code.
- **Tests.**
  - pgTAP track (primary).
  - jest only if a client change turns out to be needed (R6).
  - No shell smoke.
- **Risk: R3 and existing fixtures.** Tests that insert a priced row with a hand-picked cost will see it rewritten. Audit them in the same PR (AC-12).
- **Risk: R1 and R3 stacking.** If R1 re-derives by UPDATE-ing the child rows, R3 fires on those same writes. For priced rows both give the same value. For unpriced rows, R3 leaves the cost alone, so R1's scaled value has to survive the R3 pass. The architect designs the order so neither undoes the other.
- **Risk: the receiving divisor.** `receive_purchase_order` divides by `coalesce(q,1) × coalesce(s,1)` without the `<= 0` guard. Under R3 the stored value follows R2 anyway. The architect decides whether to point the RPC at the shared helper so its returned `new_cost_per_unit` matches the stored value exactly (AC-9).

## Backend design

Architect, 2026-11-23. Line numbers are pointers, not contracts. Pseudocode below is a shape for the developer, not committed SQL.

### D-0. Summary

One additive migration: **`supabase/migrations/20261123130000_recompute_costs_on_pack_size_change.sql`** (after `20261123120000_rls_visibility_once_per_query.sql`, the latest on disk). It adds:

| # | Object | Kind | Covers |
|---|--------|------|--------|
| 1 | `public.pieces_per_case(numeric, numeric)` | pure SQL helper | R2, the `piecesPerCase` mirror |
| 2 | `public.per_each_cost(numeric, numeric, numeric)` | pure SQL helper | R2 priced rule (R1, R3, R4, receiving) |
| 3 | `public.inventory_items_derive_cost()` + trigger `zz_derive_cost_per_unit_trg` on `inventory_items` | BEFORE INSERT/UPDATE OF, SECURITY INVOKER | R3 |
| 4 | `public.item_vendors_derive_cost()` + trigger `zz_derive_cost_per_unit_trg` on `item_vendors` | BEFORE INSERT/UPDATE OF, SECURITY INVOKER | R3 |
| 5 | `public.catalog_ingredients_rederive_item_costs()` + trigger `catalog_ingredients_rederive_item_costs_trg` | AFTER UPDATE OF, SECURITY DEFINER | R1, R2 (OQ-2) |
| 6 | `public.list_cost_drift()` | read-only, SECURITY INVOKER, STABLE | R4 (OQ-3) |
| 7 | `public.receive_purchase_order(uuid, jsonb, uuid)` re-CREATE | one-line hunk | AC-9 |

There are no table, column, index, policy or publication changes, no backfill, and no client, `db.ts` or edge-function change.

### D-1. Data model changes

None. All objects are functions and triggers. The change is **additive and non-destructive**. Creating the triggers rewrites no existing row. Rows change only on their next write (see D-11 for what that means for the 2026-11-23 repair).

No new index. R1 filters `inventory_items` by `catalog_id`, and the only covering index is the unique `(store_id, catalog_id)`, which leads with `store_id`. That means a seq scan of about 900 prod rows, and only when pack size actually changes. This is not worth an index in this spec. If R1 ever shows up in a slow-query log, add `inventory_items (catalog_id)` then.

### D-2. The shared helpers (R2)

**`public.pieces_per_case(p_case_qty numeric, p_sub_unit_size numeric) returns numeric`**
- `language sql immutable parallel safe`, `set search_path = ''`.
- Body: `q × s`, where each factor is replaced by `1` unless it is `> 0 and < 'Infinity'::numeric`.
  - The `< 'Infinity'` bound mirrors `Number.isFinite` in [src/utils/perEachCost.ts](../src/utils/perEachCost.ts) L30-31. Postgres sorts both `Infinity` and `NaN` above every finite value, so one bound rejects both.
  - NULL fails `> 0`, so it falls to 1.
- This is the single SQL source of `piecesPerCase`. No other SQL in this migration may write its own `coalesce(case_qty,1) * coalesce(sub_unit_size,1)`.

**`public.per_each_cost(p_case_price numeric, p_case_qty numeric, p_sub_unit_size numeric) returns numeric`**
- Same attributes.
- Body: `case when p_case_price > 0 then round(p_case_price / public.pieces_per_case(p_case_qty, p_sub_unit_size), 6) end`. It returns NULL for an unpriced input, and callers decide what an unpriced row gets.
- It calls `public.pieces_per_case` schema-qualified, because `search_path` is empty.

**Grants for both:** `revoke all … from public;` then `grant execute … to anon, authenticated, service_role;`. Granting to anon is deliberate:
- Both functions are pure arithmetic and read no data, so EXECUTE leaks nothing.
- The R3 trigger (INVOKER) calls them as the writing role, and a BEFORE INSERT trigger runs before RLS WITH CHECK. If anon lacked EXECUTE, an anon INSERT of a priced row would fail with "permission denied for function per_each_cost" instead of the RLS error it gets today. Tests that pin RLS messages would break, and the error would be misleading.
- `authenticated` needs EXECUTE for `list_cost_drift()` and `receive_purchase_order` (both INVOKER).

**Interpretation note on AC-4 (non-blocking).** `calcUnitCost` ([src/utils/unitConversion.ts](../src/utils/unitConversion.ts) L309-313) returns `0` when `caseQty <= 0`. That is spec 104's narrow guard against dead input. R2 and `piecesPerCase` instead treat a non-positive factor as 1. The SQL follows R2, so `per_each_cost(30, 0, 5) = 6.000000` where `calcUnitCost(30, 0, 5) = 0`. Parity with `calcUnitCost` is asserted only for `caseQty > 0`; parity with `piecesPerCase` is asserted for every input. The editor never stores `case_qty <= 0`: `toUpdates` sends `parseFloat(...) || 1`, and `fromItem` reads `caseQty || 1`. So the gap is unreachable from the UI and only reachable by direct SQL.

### D-3. R3: derive on write (triggers on `inventory_items` and `item_vendors`)

**Trigger definitions:**

```
-- inventory_items
create trigger zz_derive_cost_per_unit_trg
  before insert or update of case_price, cost_per_unit, catalog_id
  on public.inventory_items
  for each row when (new.case_price > 0)
  execute function public.inventory_items_derive_cost();

-- item_vendors
create trigger zz_derive_cost_per_unit_trg
  before insert or update of case_price, cost_per_unit, item_id
  on public.item_vendors
  for each row when (new.case_price > 0)
  execute function public.item_vendors_derive_cost();
```

**Function bodies (shape):**
- `inventory_items_derive_cost()` reads `ci.case_qty, ci.sub_unit_size` from `public.catalog_ingredients ci where ci.id = new.catalog_id`. It sets `new.cost_per_unit := public.per_each_cost(new.case_price, q, s)` and returns `new`.
- `item_vendors_derive_cost()` does the same, reaching the catalog through `public.inventory_items ii join public.catalog_ingredients ci on ci.id = ii.catalog_id where ii.id = new.item_id`.
- If the lookup finds no row, `q` and `s` stay NULL. The pieces then count as 1 and the cost equals `case_price`.
- **Neither function may raise.** This preserves spec 179's guarantee that RLS and FK errors win on INSERT (see D-9 on T72).

**Design choices:**
- **The column list keeps R3 off the EOD hot path.** `UPDATE OF` matches on the statement's SET list, so `current_stock`, `par_level`, `eod_remaining`, `vendor_id`, `is_primary`, `order_code` and `product_page_url` updates never fire the trigger. This covers every EOD writer, receiving's stock-only branch, `set_item_primary_vendor` and the demote step in `db.updateInventoryItem`.
  - `catalog_id` (on `inventory_items`) and `item_id` (on `item_vendors`) are in the list because re-pointing either one changes which pack size applies. No current writer re-points them, so the cost is nil.
- **`WHEN (new.case_price > 0)` keeps R3 off unpriced rows entirely.** The function is never invoked for a row with `case_price` NULL or `<= 0`. That row keeps whatever cost was written, which is R3's "unpriced row keeps the cost written to it". It is also the key to D-4.
- **SECURITY INVOKER, `set search_path = ''`.** The lookup runs under the caller's RLS. A DEFINER lookup keyed on a caller-supplied `catalog_id` would let any store member learn the pieces count of another brand's catalog row. They would insert a priced row with that `catalog_id` into their own store and read `cost_per_unit` back through `RETURNING`, because the `inventory_items` insert policy only checks `auth_can_see_store(store_id)`. Under INVOKER, an invisible catalog row reads as "not found".
  - Every legitimate writer can see its catalog row. Store members see their brand's catalog, and `user_stores_brand_match` pins membership to the profile's brand. Super admins see everything.
  - DEFINER RPCs (`apply_item_scalars_to_brand`, `stock_store_from_store`) and the R1 trigger run as the owner (`postgres`), which bypasses RLS because none of these tables has FORCE RLS.
  - The RLS read on `catalog_ingredients` is already the spec 205 once-per-query form, so the per-row lookup costs one PK probe.
- **Name sorts last.** BEFORE triggers fire in name order. On `inventory_items` the order becomes `inventory_items_identity_lock_trg < inventory_items_updated_at < trg_item_vendor_changed_at < zz_derive_cost_per_unit_trg`, in both the default and `"C"` collation. That gives two properties:
  - The spec 179 identity lock still fires first.
  - Derivation sees the final `NEW` after every other BEFORE trigger. Today none of them writes `case_price`; the order protects any future one that does.
  - `item_vendors` has no other trigger.
- **Execute grants on the trigger functions:** `revoke all … from public, anon, authenticated` (house pattern, as in spec 179 and spec 190). Postgres checks EXECUTE on a trigger function only at CREATE TRIGGER time.

**How R3 covers each write path** (spec write-path inventory items 3 to 10):

| Path | Effect under R3 |
|------|-----------------|
| 3 `create_inventory_item_with_catalog`, reuse branch | The INSERT fires R3 with the stored catalog pack size. The RPC's returned jsonb reads `i.cost_per_unit` after the trigger, so `mapItem` receives the derived value. The follow-up `item_vendors` upsert in `db.createInventoryItem` (db.ts L454-477) is also derived. |
| 4 editor per-store PATCH + link upsert | Same value the editor sent (already derived from form values that match the catalog). Benign. |
| 5 `apply_item_scalars_to_brand` | The SET list includes `cost_per_unit` and `case_price`, so R3 fires and agrees with the editor's pair. When `p_case_price` is NULL the SET still writes `case_price = ii.case_price`, so R3 derives from the stored price and ignores a mismatched `p_cost_per_unit`. That matches R3. |
| 6 `apply_item_vendors_to_brand` | New links are derived. Existing links are derived only if the RPC's SET touches a cost column. Either way the result matches R3. |
| 7 `receive_purchase_order` | Agrees exactly after the D-6 hunk. |
| 9 `stock_store_from_store` | Copied pairs are re-derived, so source drift is no longer copied. |
| 10 CSV `last_cost` | Ignored for priced rows (owner-accepted OQ-1). |
| Direct SQL / future writers | Covered. |

### D-4. R1: re-derive on pack-size change, and the trigger order

**Trigger definition:**

```
create trigger catalog_ingredients_rederive_item_costs_trg
  after update of case_qty, sub_unit_size on public.catalog_ingredients
  for each row
  execute function public.catalog_ingredients_rederive_item_costs();
```

**Function** (`plpgsql`, **SECURITY DEFINER**, `set search_path = ''`, every relation schema-qualified; shape):

```
v_old := public.pieces_per_case(old.case_qty, old.sub_unit_size);
v_new := public.pieces_per_case(new.case_qty, new.sub_unit_size);
if v_old = v_new then return null; end if;          -- AC-5: no write at all

-- (a) inventory_items, every store of the catalog's brand
update public.inventory_items ii
   set cost_per_unit = <X(ii.case_price, ii.cost_per_unit)>
 where ii.catalog_id = new.id
   and exists (select 1 from public.stores s
                where s.id = ii.store_id and s.brand_id = new.brand_id)   -- brand scope (fix 1)
   and ii.cost_per_unit is distinct from <X(...)>;  -- updated_at bumped by inventory_items_updated_at

-- (b) item_vendors, every link of those rows
update public.item_vendors iv
   set cost_per_unit = <X(iv.case_price, iv.cost_per_unit)>,
       updated_at    = now()                       -- no updated_at trigger on item_vendors; mirrors receiving
  from public.inventory_items ii
 where iv.item_id = ii.id and ii.catalog_id = new.id
   and exists (select 1 from public.stores s
                where s.id = ii.store_id and s.brand_id = new.brand_id)   -- brand scope (fix 1)
   and iv.cost_per_unit is distinct from <X(...)>;
return null;

where X(price, cost) =
  case when price > 0
       then public.per_each_cost(price, new.case_qty, new.sub_unit_size)   -- R2 priced
       else round(cost * v_old / v_new, 6)                                -- R2 unpriced (OQ-2)
  end
```

- A NULL or 0 unpriced cost stays NULL or 0. `is distinct from` then excludes the row, so it gets no write and no realtime event.
- The early return is inside the body rather than in a trigger `WHEN` clause. That keeps the helper calls out of the triggering statement's privilege context.

**Why AFTER and not BEFORE.** R3 runs inside R1's child UPDATEs and reads the catalog row. In an AFTER ROW trigger, the catalog UPDATE is already visible, so R3 reads the **new** `case_qty` / `sub_unit_size`. In a BEFORE trigger, R3 would read the old pack size and write the old cost back over R1's value.

**Why DEFINER.** R1 must reach every store's rows, whatever the caller's visibility. The function writes only rows keyed to `new.id`, a catalog row the caller has already passed `privileged_update_catalog_ingredients` for (`auth_is_privileged() AND auth_can_see_brand(brand_id)`). Running as the table owner also means the child UPDATEs run as `postgres`, so R3's INVOKER lookup inside them is not RLS-filtered.

**How R1 and R3 interact (the stacking risk in the spec):**
- **Priced rows (`case_price > 0`).** R1 sets `cost_per_unit` to `per_each_cost(price, new q, new s)`. Because `cost_per_unit` is in the SET list, R3's BEFORE trigger fires on the same row. It computes `per_each_cost(price, q, s)` from the catalog row it reads, which holds the same new values. The two results are byte-identical, so the order between them does not matter, and R3, which runs last, is authoritative.
- **Unpriced rows (`case_price <= 0` or NULL).** R1 writes the OQ-2 scaled value. R3's `WHEN (new.case_price > 0)` is false, so **R3 is never invoked for that row** and the scaled value survives. The guarantee is structural: no ordering assumption and no session flag.
- **The editor's own Save, in sequence:**
  1. The catalog PATCH fires R1, which re-derives every store from each row's stored `case_price`.
  2. The per-store PATCH and the link upsert carry the form's new pair, and R3 derives them against the new pack size.
  3. The `apply_item_scalars_to_brand` fan-out does the same for the picked stores.
  - All three agree.
  - **Known interaction (non-blocking, pre-existing).** For an unpriced row, the editor's cost is derived, never hand-entered. `fromItem` shows `''` and `toUpdates` sends `0` (IngredientFormDrawer.tsx L48, L150). So an editor Save writes cost `0` to the **edited** store's unpriced row, overwriting R1's OQ-2 value there. Other stores keep the scaled value. This is spec 104 editor behavior and R6 keeps the editor unchanged. Listed as follow-up FU-1.

**Side effects:**
- R1 never sets `id` or `store_id`, so `inventory_items_identity_lock_trg` does not fire (spec 179).
- `vendor_id` is unchanged, so `trg_item_vendor_changed_at` does not stamp, and the spec 128 "Updated" badge is not raised.
- No path leads back to `catalog_ingredients`, so there is no recursion.
- `po_items`, `waste_log` and POS rows are never referenced (R5, AC-11).
- R1 re-derives every `inventory_items` row with this `catalog_id` **at a store of the catalog's brand**, and their links. A row at a store of another brand that points at this catalog (reachable today because the insert policy checks only store visibility, FU-3) is never touched. Without that scope, a brand-2 store member could plant an unpriced row with `cost_per_unit = 999999.999999` on a brand-1 catalog id. The OQ-2 scaling would then overflow (22003) and abort the brand-1 admin's pack-size PATCH, on a row the admin cannot see. AC-6's test pins the scope (D-9). (Amended 2026-11-24 per the release proposal, fix 1 — security review Medium.)

**AC-6 finding.** Under the current role model, no privileged caller who can UPDATE a catalog row is unable to see a **same-brand** store:
- `auth_is_privileged()` is `auth_is_admin()` (JWT) OR super_admin.
- The update policy also requires `auth_can_see_brand(catalog.brand_id)`, so the profile's brand is the catalog's brand.
- Arm (ii) of `auth_can_see_store` then admits every store of that brand ([20260517040000](../supabase/migrations/20260517040000_auth_can_see_store_brand_scope.sql) L88-108). Super admins see everything.

The pgTAP test states this and checks every brand-1 store. It also pins, with a **cross-brand** store row the admin cannot see, that the DEFINER fan-out stays inside the catalog's brand (D-9, AC-6). (Amended 2026-11-24 per the release proposal, fix 1 — security review Medium.)

### D-5. R4: `public.list_cost_drift()`

**Signature:**

```
public.list_cost_drift()
returns table (
  kind          text,     -- 'drift' | 'cost_without_case_price'
  source_table  text,     -- 'inventory_items' | 'item_vendors'
  row_id        uuid,
  store_id      uuid,
  store_name    text,
  item_name     text,     -- catalog_ingredients.name
  case_price    numeric,
  case_qty      numeric,  -- raw catalog values (not coalesced), so NULL/0 inputs are visible
  sub_unit_size numeric,
  stored_cost   numeric,
  derived_cost  numeric   -- per_each_cost(...); NULL for kind = 'cost_without_case_price'
)
language plpgsql stable security invoker set search_path = ''
```

- **No parameters.** The tolerance is fixed at the repair's rule, so there are no knobs to misuse.
- **`kind = 'drift'`:** `case_price > 0` and `abs(coalesce(stored,0) − derived) > greatest(0.01, 0.02 × derived)`.
- **`kind = 'cost_without_case_price'`:** `coalesce(case_price,0) <= 0` and `coalesce(cost_per_unit,0) > 0`. Informational only; never counted as drift.
- **Joins:**
  - `inventory_items ii → catalog_ingredients ci`, and `left join stores s` for the name.
  - `item_vendors iv → inventory_items ii → catalog_ingredients ci`, same store join.
  - `union all` of the two tables, ordered by `kind, store_name, item_name, source_table`.
- **Gate:** the first statement is `if current_user in ('anon', 'authenticated') and not public.auth_is_privileged() then raise exception 'privileged only' using errcode = '42501'; end if;`.
  - The refusal string matches `apply_item_scalars_to_brand`.
  - The `current_user` clause exists because the function's stated job is to run **on prod via MCP or the SQL editor**. Those sessions run as `postgres` with no JWT, so a bare `auth_is_privileged()` gate would refuse the main caller.
  - PostgREST can only ever be `anon`, `authenticated` or `service_role` here. `service_role` already bypasses RLS, so admitting it adds nothing.
- **Store scoping goes through RLS, not through the function.** As INVOKER, the reads go through `store_member_read_inventory_items` and `store_member_read_item_vendors`, which are already in the spec 205 once-per-query form with the super_admin arm.
  - An admin sees their brand's stores, and super_admin sees all.
  - `postgres` (owner, no FORCE RLS) sees all, which is what AC-13 needs.
  - The function must **not** add its own `auth_visible_store_ids()` filter. That filter returns `{}` for a JWT-less `postgres` session and would hide everything from the MCP caller.
  - No new policy, so the spec 053 and spec 205 lints are unaffected.
- **Read-only by construction.** It is a STABLE plpgsql function, and Postgres raises "UPDATE is not allowed in a non-volatile function" for any write.
- **Implementation note.** The RETURNS TABLE column names (`store_id`, `case_price`, …) become plpgsql variables. Use `#variable_conflict use_column` or qualify every column reference.
- **Grants:** `revoke all … from public, anon; grant execute … to authenticated, service_role;`. The revoke from public matters: spec 097's ALTER DEFAULT PRIVILEGES gives anon an explicit grant on new public functions (same idiom as `create_inventory_item_with_catalog`).
- **API contract:**
  - It is an RPC (`/rpc/list_cost_drift`), but there is no app caller and no `db.ts` wrapper (OQ-3: no Cmd UI).
  - Errors: anon gets 42501 permission denied (grant). A non-privileged authenticated caller gets 42501 `privileged only`.
  - Cost is about 1,800 rows through two RLS-filtered scans. Trivial.

### D-6. `receive_purchase_order`: one-line hunk (AC-9)

The current body ([20260707000000](../supabase/migrations/20260707000000_staff_receiving_price_gate.sql) L114-396, the latest; no later re-CREATE) computes `v_new_cost_per_unit := v_line.new_case_price / (v_case_qty * v_sub_unit_size)` (L267). That value is unrounded and its divisor has no `<= 0` guard. Today a `case_qty = 0` catalog row makes it divide by zero, because `coalesce(0, 1)` is 0.

Under R3 the stored value is `round(…, 6)`, so for any quotient with more than 6 decimals the returned `price_changes[].new_cost_per_unit` and the audit text would differ from the stored value. AC-9 forbids that.

- **Hunk:** replace L267 with `v_new_cost_per_unit := public.per_each_cost(v_line.new_case_price, v_case_qty, v_sub_unit_size);`. The branch guarantees `new_case_price > 0`, so the result is non-NULL.
- **Everything else is byte-identical:** the coalesced locals at L245, both cost writes, the audit row, the envelope, the spec 113 gate and the pinned refusal string.
- Copy the body **verbatim** from 20260707000000 and diff to show the one-line delta. That is the same source discipline the 20260707 header documents.
- The signature is unchanged, so `create or replace` keeps the ACL and the `comment on function`. No grant or revoke lines.
- Result: the envelope, `audit_log.value` and both stored columns carry the identical 6 dp value. It also removes the divide-by-zero for `case_qty = 0`.

### D-7. RLS impact

- **No new table, so no new policies.** No existing policy changes. No permissive policy is added (the spec 053 lint is unaffected) and no SELECT policy is added (the spec 205 lint is unaffected).
- **Write paths keep their existing policies:**
  - `privileged_update_catalog_ingredients` still gates the R1 entry point.
  - `store_member_*_inventory_items` and `store_member_*_item_vendors` still gate R3 writes.
  - R3 only rewrites `NEW.cost_per_unit` on a row the caller is already allowed to write.
- **The only RLS bypass is R1 (DEFINER).** It is scoped to `catalog_id = new.id` at stores of the catalog's brand, and only reachable after the caller has updated that catalog row. It writes `cost_per_unit` (plus `item_vendors.updated_at`) and nothing else.
- **Pre-check for prod and local:** `relforcerowsecurity = false` on `inventory_items`, `item_vendors` and `catalog_ingredients`, and all three are owned by the function owner (`postgres`). If FORCE RLS were ever set, R1's DEFINER reach would silently shrink. The pgTAP file pins both facts, the same way spec 190 DP-1 does.

### D-8. Client, `db.ts`, edge functions, realtime, store

- **`src/lib/db.ts`: no change and no new helper.** `updateInventoryItem`'s catalog PATCH (L547-556) stays a plain PostgREST update, and R1 rides on it.
  - The 0-row check (`.select('id')`) still works: an AFTER trigger does not change the returned row set.
  - An R1 failure (only numeric overflow, see Risks) aborts the PATCH, and the existing throw, revert and `notifyBackendError` path surfaces it.
  - `list_cost_drift` is operator-only, so it has no wrapper.
- **The editor still sends a cost. Keep it.**
  - Priced rows: R3 replaces it with the identical value (or the correct one when the form's pack size was stale).
  - Unpriced rows: the client write is still the only way to set a cost without a case price, and R3 deliberately keeps it.
  - Removing the field would need a jest-covered client change for no gain. Holds R6.
- **`src/store/useStore.ts`: no change.** Optimistic-then-revert is unchanged.
  - The edited row's optimistic values already equal what the server stores, because the form derived them from the same formula.
  - Other stores' rows, and any link whose cost R3 corrected (create-reuse, CSV), refresh on the realtime reload below.
  - CSV import's optimistic `last_cost` for a priced row is briefly shown and then replaced on reload. This is the accepted OQ-1 effect; the preview change is out of scope.
- **Edge functions: none touched.** No `verify_jwt` changes.
- **Realtime: no publication change.**
  - `catalog_ingredients`, `inventory_items` and `item_vendors` are already in `supabase_realtime`, so the `docker restart supabase_realtime_imr-inventory` step does **not** apply.
  - Behavior change: one pack-size edit now emits an `inventory_items` UPDATE on every affected store's `store-{id}` channel (filtered `store_id=eq.X`, [src/hooks/useRealtimeSync.ts](../src/hooks/useRealtimeSync.ts) L34). It also emits one `item_vendors` UPDATE per changed link, which every connected admin receives because that subscription is unfiltered (L46).
  - Each client collapses the burst into one reload (400 ms debounce, spec 206 single-flight).
  - Rows whose cost did not change (unpriced 0/NULL) emit nothing, thanks to the `is distinct from` filter.
- **Staff app: no change and no realtime** (spec 062).

### D-9. Test plan

**New pgTAP files**, plus the existing tests that must change. Write all fixtures as `postgres`, then act as callers using the existing `set local role authenticated` plus `request.jwt.claims` pattern.

**Detecting writes inside one test transaction.** `now()` is frozen for the whole transaction, so `updated_at = now()` cannot show a write. AC-5, AC-10 and AC-11 should assert that the row's **`xmin` is unchanged** (any UPDATE gives the row a new xmin), together with the cost and `updated_at` values.

`supabase/tests/cost_rederive_on_pack_size.test.sql`:

| AC | Assertions |
|----|-----------|
| Structure | Both helpers exist and are IMMUTABLE with `search_path=''`. The three triggers exist and are enabled (`tgenabled='O'`), with the designed `tgtype`, `tgattr` column list and `WHEN` (R3 `tgqual` references `case_price`; R1 has none). R1's function is `prosecdef`; the R3 functions are not. The trigger functions have no EXECUTE for anon, authenticated or PUBLIC (use `has_function_privilege`, not a proacl string match; see spec 190). Helpers are executable by anon and authenticated. `relforcerowsecurity = false` and the owner facts from D-7 hold. |
| AC-1 | Brand admin updates `case_qty` 1→2. Store A and B `inventory_items` and links all read `16.975000`. Store B's xmin changed. |
| AC-2 | `sub_unit_size` 1→35: all four rows read `0.970000`. As the admin, `report_reorder_list(store B)` with par 3, stock 0 and one linked vendor gives this item `estimated_cost` within 0.01 of `101.85`. |
| AC-3 | A link with `case_price 40` next to an item row at 33.95 reads `round(40/pieces, 6)`. |
| AC-4 | Helper matrix: `q ∈ {NULL, 0, -1, 2}` × `s ∈ {NULL, 0, 35}` → pieces equal `piecesPerCase`, and `per_each_cost(30, q, s)` equals `round(30/pieces, 6)`. One end-to-end case: catalog `case_qty` set to 0 and to NULL from 1 is a no-op (pieces unchanged); from 2, it re-derives as if q = 1. |
| AC-5 | Rename; `i18n_names`; `image_path`; `eod_count_mode`; resend the same `case_qty`; swap (2,3)→(3,2) (pieces equal). After each, every child row's xmin, cost and `updated_at` are unchanged. |
| AC-6 | A comment states the D-4 finding. Then: an admin of brand 1 changes pack size, and every brand-1 store is re-derived. The row and link at a **brand-2 store** carrying brand 1's `catalog_id` (fixture-inserted as postgres; the admin cannot see that store, so assert `auth_can_see_store` is false for it) keep their cost, xmin and `updated_at`. A planted brand-2 unpriced row with cost `999999.999999` does not block a brand-1 pack-size decrease (`lives_ok`), and stays untouched. (Amended per fix 1.) |
| AC-7 | Unpriced `inventory_items` and `item_vendors` rows with cost 0.5: `s` 1→35 gives `0.014286`; 35→1 gives `0.500010`. A cost-0 row stays 0 with xmin unchanged. |
| AC-8 | INSERT and UPDATE of a priced row (price 30, pieces 6, cost sent 30) gives `5.000000` on both tables. `create_inventory_item_with_catalog` reusing a pieces-6 catalog row with `p_case_qty 1`, `case_price 30` stores 5 and returns 5 in its jsonb. A cost-only PATCH of 9 gives 5. An unpriced row written with 9 keeps 9. **Stock-only:** a row made off-rule with `alter table … disable trigger zz_derive_cost_per_unit_trg`, then re-enabled, keeps its off-rule cost after a `current_stock`-only UPDATE. |
| AC-9 | `receive_purchase_order` as admin with `new_case_price = 40` on a pieces-3 item. The envelope's `new_cost_per_unit` equals both stored values and equals `13.333333`; this fails on the old body. A `case_qty = 0` catalog row no longer divides by zero. |
| AC-11 | Pre-existing `po_items` and `waste_log` rows for the item keep their xmin and `cost_per_unit` after a pack-size change. |

`supabase/tests/list_cost_drift.test.sql` (AC-10):
- Fixtures are seeded with the R3 trigger **disabled per table inside the test transaction** (`alter table … disable trigger zz_derive_cost_per_unit_trg`, then enable). Do not use `session_replication_role`: it also suspends the FK triggers.
- The fixtures include:
  - one row beyond the tolerance per table;
  - one row just inside the tolerance (e.g. off by 0.009 where the derived value is under 0.50);
  - one unpriced row with cost > 0;
  - a second brand.
- Assertions:
  - **Exact sets:** the drift rows equal exactly the beyond-tolerance fixtures, and the within-tolerance row is absent. The unpriced row appears only with `kind = 'cost_without_case_price'`.
  - **Refusals:** anon gets `throws_ok` 42501 and `has_function_privilege('anon', …) = false`. An authenticated `user`/staff role gets 42501 `privileged only`.
  - **Visibility:** an admin of brand 1 sees no brand-2 rows. A super_admin sees both.
  - **As `postgres`** (the MCP path): the call succeeds and sees both brands.
  - **No writes:** xmin is unchanged on every fixture row after each call. The function is `provolatile = 's'`.

**Existing pgTAP that must change (AC-12):**
- [supabase/tests/inventory_items_identity_lock.test.sql](../supabase/tests/inventory_items_identity_lock.test.sql):
  - **T72** pins "no non-internal BEFORE INSERT trigger" (`'3|0'`). Update it to allow exactly `zz_derive_cost_per_unit_trg`, keeping the original intent: the tombstone check is AFTER INSERT, so the RLS message wins. R3 never raises, so it cannot pre-empt that message.
  - **T73** pins the BEFORE UPDATE list. Append `'zz_derive_cost_per_unit_trg'`; the identity lock is still first.
  - This updates a pin. It does not weaken it.
- **The ~37 files that mention `case_price`.** Run the full suite and fix every fixture whose priced row R3 rewrites. In order of preference:
  1. Make the fixture consistent: set `cost = case_price / pieces` of its catalog row.
  2. If the test is about a hand-picked `cost_per_unit` and `case_price` is incidental, set `case_price = 0`. The row stays unpriced and R3 keeps the cost. Note this in a comment; it doesn't weaken the assertion.
  3. Only where the test asserts the cost itself, assert the derived value.
  - **Never** disable the trigger to keep an old fixture passing. Only the AC-8 stock-only case and the drift fixtures disable it.
  - Likely hot spots: `report_reorder_list_*`, `cost_on_receipt`, `staff_receiving_gate`, `apply_item_scalars_to_brand`, `apply_item_vendors_to_brand`, `stock_store_from_store`, `item_vendors_backfill`, `report_run_*`.

**jest (no client change):** one small parity file, `src/utils/perEachCost.spec207.test.ts`. It pins the same AC-4 input matrix (literal values, with a comment pointing at the pgTAP file) through `piecesPerCase`, and through `calcUnitCost` for `caseQty > 0` only. This is the TS side of the AC-4 parity; reviewers check the two matrices match. No existing jest test changes.

**Seed and e2e.** `seed.sql` loads `inventory_items` and `item_vendors` with triggers on (no `session_replication_role`), so R3 rewrites seeded priced rows that drift (the seed is the 2026-05-02 prod pull, before the repair). That is the intended outcome, and it means local `list_cost_drift()` returns 0 drift. Before marking READY_FOR_REVIEW, the developer must grep `e2e/` (and any Playwright spec) for hard-coded dollar amounts derived from seed costs, then run the e2e suite locally. `e2e.yml` is checked by hand after a push (project memory).

**Gates:** `scripts/test-db.sh` (full pgTAP), full `npx jest`, `npm run typecheck`, `npm run typecheck:test`.

### D-10. Migration file shape

- Header comment in the house style:
  - what and why;
  - the R1/R3 ordering argument (D-4);
  - "no publication change, so no docker restart";
  - the prod-apply runbook pointer (D-11);
  - a BACKOUT block (below).
- `begin;` … `commit;` with `set local lock_timeout = '5s';`. CREATE TRIGGER takes SHARE ROW EXCLUSIVE briefly on three tables.
- Order inside the transaction:
  1. helpers;
  2. R3 functions and triggers;
  3. R1 function and trigger;
  4. `list_cost_drift`;
  5. `receive_purchase_order` re-CREATE;
  6. grants and revokes;
  7. `comment on function` for each new function.
  - Helpers come first because every later object calls them.
- Idempotent for the local-plus-prod double apply: `create or replace function` and `drop trigger if exists` before each `create trigger`.
- BACKOUT (documented, not auto-applied):
  1. Drop the three triggers.
  2. Re-run the 20260707000000 `receive_purchase_order` body.
  3. Drop `list_cost_drift`, the three trigger functions, then the two helpers, last.
  - No data to restore; the migration writes none.

### D-11. Prod rollout (owner-gated; MCP path, then push)

1. **Read-only pre-checks** on `ebwnovzzkwhsdxkpyjka`:
   - `current_user = postgres`.
   - Version `20261123130000` is absent from `supabase_migrations.schema_migrations`.
   - `to_regprocedure` is NULL for all six new functions.
   - The D-7 owner and `relforcerowsecurity` facts hold.
   - The normalized md5 of prod `receive_purchase_order` matches local `20260707000000`, so the verbatim base is the deployed one.
   - Baseline, run inline because the function doesn't exist yet: count priced rows beyond the tolerance in both tables using the D-5 predicate. It should be 0 after the 2026-11-23 repair. **If it is not 0, stop and report to the owner.** Something wrote drift since the repair, and this spec deliberately has no backfill.
2. `execute_sql` the migration file **verbatim** (line 1 to the final `commit;`). Put the `insert into supabase_migrations.schema_migrations` for the exact version `20261123130000` just before `commit;` in the text sent, so body and version commit together (spec 190 runbook). Use `execute_sql`, never `apply_migration`, which writes its own version.
3. **Verify:**
   - normalized md5 of all six new functions and the new `receive_purchase_order` against local;
   - `prosecdef`, `proconfig` and owner as designed;
   - the three triggers present with `tgenabled = 'O'` and the expected `tgtype` / `tgattr`;
   - `has_function_privilege` false for anon, authenticated and PUBLIC on the trigger functions, and false for anon and PUBLIC on `list_cost_drift`.
4. **AC-13:** `select kind, count(*) from public.list_cost_drift() group by kind;`. Expect `drift` = 0. Record both counts, including the informational `cost_without_case_price` count, in a `## Rollout notes` section of this spec.
5. Optional, owner's call: a write-free behavioral check. Inside `begin; … rollback;` in one `execute_sql`, change one item's `sub_unit_size`, select its rows' costs, then roll back. Skip it if the owner prefers no prod writes, even rolled-back ones.
6. Push to `main`. Confirm the latest runs of **both** `test.yml` and `db-migrations-applied.yml` are green (CLAUDE.md rule), and check `e2e.yml` by hand.

**Does the 2026-11-23 repair still hold under the new triggers? Yes.**
- The migration writes no rows, so nothing the repair set is touched at apply time. Step 1's baseline and step 4's check both confirm 0 rows beyond the tolerance.
- Rows left inside the tolerance settle to the exact value on their next priced write. R1 fires only on a real pack-size change; R3 fires on any write that sets a cost column.
- That convergence only ever moves a row toward the rule the repair used. The repair's `round(case_price / (q×s), 6)` with `<= 0 → 1` is exactly `per_each_cost`.
- **Undo-file caveat.** After this migration, the undo recipe in "Prod repair already done" (`update … set cost_per_unit = <old> where id = … and cost_per_unit = <new>`) is **silently overridden by R3** on every priced row, because the UPDATE sets `cost_per_unit` and `case_price > 0`. Any future undo must run inside a transaction that does `alter table public.<table> disable trigger zz_derive_cost_per_unit_trg;` … `enable trigger …;` (a brief ACCESS EXCLUSIVE lock, so off-peak). The undo would then re-create drift, which `list_cost_drift()` would report. The undo JSON file stays as-is.

### D-12. Risks and tradeoffs

- **Migration ordering.** Single file, and it must land after `20261123120000` (spec 205). It does not depend on spec 205 objects, but D-5 relies on the spec 205 read-policy shape for visibility. The `receive_purchase_order` copy must be taken from 20260707000000; a stale body would revert spec 113.
- **R3 overrides writers silently.** CSV `last_cost`, a hand-typed SQL cost, and any future client that writes a non-derived cost for a priced row are all ignored, with no error. Owner accepted (OQ-1). Writers that want a cost without a price must use `case_price = 0`.
- **Numeric overflow.** `cost_per_unit` is `numeric(12,6)` (max 999,999.999999).
  - R1's OQ-2 scaling (`cost × old/new`) or R3 on an extreme `case_price` with pieces 1 could exceed it and raise 22003. The catalog PATCH then fails and the client reverts and toasts.
  - Not reachable with real data. It is safer than silently truncating. Accepted.
- **Locking and deadlock.** R1 row-locks every store's row for one item. A concurrent EOD submit locking many items at one store in a different order can deadlock. Postgres aborts one side with 40P01, and the staff `eodQueue` retries.
  - Low probability: pack-size edits are rare, and R1 locks about one row per store.
  - Accepted, not mitigated (an advisory lock would add more risk than it removes).
- **Realtime fan-out** (spec note). Each pack edit sends about one event per store plus one per link to every connected admin, absorbed by spec 206 single-flight. Load scales with stores × connected clients and stays small at the current brand size.
- **Performance on the seed and prod data.**
  - R3 adds one PK lookup per priced write. The EOD hot path is excluded by the column list.
  - The seed load adds about 1,100 lookups on `db reset`.
  - R1 is a seq scan of about 900 `inventory_items` rows per real pack change.
  - `list_cost_drift` is two scans of about 900 rows. All negligible.
- **Cold start.** No edge function is involved, so not applicable.
- **Cross-brand rows.** R1 does **not** re-derive an `inventory_items` row (or its links) at another brand's store that points at this catalog. Both DEFINER UPDATEs carry `exists (… stores s where s.id = ii.store_id and s.brand_id = new.brand_id)`. The DEFINER write therefore stays inside the actor's brand, and another brand cannot block this brand's pack-size edits through an overflowing planted row. Such rows can still exist, and `list_cost_drift()` run as `postgres` may list them as `drift` (post-impl M-2). Check `stores.brand_id <> catalog_ingredients.brand_id` before treating a non-zero D-11 count as new drift. The real fix is a store-brand = catalog-brand check on insert, follow-up FU-3, out of scope. A same-brand staff member can still plant an extreme unpriced cost that makes a later pack-size edit fail with 22003, but the admin can see and fix that row (Low). (Amended 2026-11-24 per the release proposal, fix 1 — security review Medium.)
- **Fixture churn (AC-12).** Expect several existing pgTAP files to need fixture edits. The D-9 preference order keeps them from being weakened.

### D-13. Follow-ups (not in this build)

- **FU-1.** The editor zeroes an unpriced row's cost at the edited store on Save, so the OQ-2 scaling survives only at other stores for editor saves. Decide whether the editor should preserve an unpriced cost or show it as entered.
- **FU-2.** CSV import preview: hide or flag a `last_cost` change for a priced item that R3 will ignore (already listed in Out of scope).
- **FU-3.** Enforce `stores.brand_id = catalog_ingredients.brand_id` on `inventory_items` insert. Pre-existing gap; RLS checks only store visibility.

## Handoff
next_agent: backend-developer
prompt: Implement against the "## Backend design" section in this spec:
  one migration 20261123130000_recompute_costs_on_pack_size_change.sql
  (helpers, R3 triggers, R1 trigger, list_cost_drift, the one-line
  receive_purchase_order hunk), the two new pgTAP files, the T72/T73 pin
  updates and the fixture audit (AC-12), and the jest parity file. No
  client, db.ts or edge-function change. Do not apply to prod; flag the
  D-11 runbook in the handoff. After implementation, set Status:
  READY_FOR_REVIEW and list files changed under ## Files changed.
payload_paths:
  - specs/207-recompute-costs-on-unit-change.md
  - specs/207-recompute-costs-on-unit-change/prod-cost-repair-undo-2026-11-23.json

## Rollout notes (main Claude, 2026-11-24)

Applied to prod (`ebwnovzzkwhsdxkpyjka`) through MCP `execute_sql` on owner approval ("Yes, ship it"), per D-11. The code commit is 082ba17.

**Pre-checks (read-only):**
- The caller was `postgres`, and version `20261123130000` was absent.
- None of the six new functions existed.
- Drift baseline was 0 rows in both `inventory_items` and `item_vendors`.
- No `inventory_items` row pointed at another brand's catalog row.
- Prod's `receive_purchase_order` normalized md5 (`3ddb7b32…`) matched the local body with the spec 207 line reverted. The verbatim base is therefore the deployed one.

**Apply:** lines 133-736 of the migration were sent in one call, with the `schema_migrations` insert just before `commit;`.

**Verify:**
- The normalized md5 matches local for all seven functions: `pieces_per_case`, `per_each_cost`, `inventory_items_derive_cost`, `item_vendors_derive_cost`, `catalog_ingredients_rederive_item_costs`, `list_cost_drift` and `receive_purchase_order`.
- Security definer is on for R1 only. Every new function sets `search_path=""`, and the owner is `postgres`.
- Triggers: `zz_derive_cost_per_unit_trg` is on `inventory_items` and `item_vendors`, and `catalog_ingredients_rederive_item_costs_trg` is on `catalog_ingredients`. All three are enabled (`O`) with the designed definitions.
- Privileges:
  - The trigger functions are not executable by anon or authenticated.
  - `list_cost_drift` is denied to anon and allowed to authenticated.
  - `per_each_cost` is allowed to anon.
  - `receive_purchase_order` is unchanged: anon denied, authenticated allowed.
- Version `20261123130000` is recorded.

**AC-13:** `select kind, count(*) from public.list_cost_drift() group by kind;` returned no rows. That means `drift` = 0 and `cost_without_case_price` = 0.

**Skipped:** the optional D-11 step 5 rolled-back behavior check, so prod took no writes beyond the migration itself.

## Implementation notes (backend-developer, 2026-11-24)

- **Migration.** Built as designed (D-0 to D-10). The `receive_purchase_order` body is 20260707000000 L114-393 verbatim with the one D-6 line changed; `diff` shows exactly that line. The verbatim body keeps its old comment "Both coalesce to ≥ 1, so the divisor is ≥ 1 and never zero" above the catalog select. That comment is now inaccurate (a `case_qty = 0` stays 0 after `coalesce`; `per_each_cost` is what guards it), but it was left byte-identical per D-6.
- **Local DB.** The migration was applied to the local stack and recorded in `supabase_migrations.schema_migrations` (`supabase migration up`). It was not applied to prod. The D-11 runbook is still owner-gated, and `db-migrations-applied.yml` will be red after a push until it runs.
- **Write detection in pgTAP (D-9).** A row inserted and updated in the same transaction keeps the same `xmin`. Every action under test therefore runs inside its own `SAVEPOINT`, so a written row takes the subtransaction xid. The tests compare `xmin` and `ctid` together.
- **anon refusal (AC-10).** Checked with `has_function_privilege('anon', …) = false` (and PUBLIC) only. There is no `throws_ok` under `set role anon`, which segfaults CI (spec 067); every existing anon check in the suite uses the same form. Non-privileged authenticated callers get `throws_ok` 42501 `privileged only`.
- **Fixture audit (AC-12).** The full suite run after the migration failed in 7 files, all fixed by the D-9 preference order:
  - Option 1, a consistent fixture via a catalog `case_qty` that puts the existing pairs on the rule: `apply_item_scalars_store_subset`, `apply_item_scalars_to_brand`, `apply_item_vendors_to_brand`, `inventory_items_identity_lock` (12), `item_vendors_backfill` (4; cost 7.25 → 8.35), `stock_store_from_store` (12 on c1; cost 1.234567 → 1.041667).
  - Option 2, `case_price = 0`: `item_vendors_rls`. A priced link would make its "non-member `set cost_per_unit = 1` did not land" probe vacuous, because R3 would rewrite the cost anyway.
  - No trigger was disabled to keep an old fixture passing.
  - T72 now allows exactly `zz_derive_cost_per_unit_trg` as a BEFORE INSERT trigger. T73 appends it last.
  - `apply_item_scalars_to_brand` (15), the NULL-means-skip cost check, still passes. For a priced row it now pins that the derived cost stays, because R3 makes a priced cost a function of `case_price`. A comment says so.
- **CI-seed fidelity.** CI loads the seed with R3 active, so seeded priced rows that drift are rewritten. Locally, 240 of 564 priced `inventory_items` rows and 232 of 556 priced links differ from the rule, 24 of them beyond the tolerance. To match CI, the suite was also run after rewriting those rows in place (`update … set case_price = case_price where case_price > 0`, which gives the same R3 result as the seed load). It was green, and `list_cost_drift()` then returned 0 rows. Afterwards the local `cost_per_unit` / `updated_at` values were restored from a backup with the triggers disabled; the restore was checked byte-identical.
- **e2e (D-9).** `e2e/` has no hard-coded dollar amounts; `dashboard.spec.ts` asserts structure only. The e2e suite was **not** run: another session's Expo dev server holds port 8081, and Playwright's `reuseExistingServer` would run against it and write fixtures into the shared local DB. Check `e2e.yml` by hand after the push (project memory).
- **typecheck.** `npm run typecheck` fails locally only with TS2688 on duplicate `node_modules/@types/<name> 2` folders (copies left by Finder). That is an environment artifact, not part of this change. With those folders excluded (`tsc --noEmit --types <the real @types>`), it exits 0. `npm run typecheck:test` exits 0.

### Review fixes (2026-11-24, owner-approved "Yes, apply fixes"; release-proposal fixes 1-3, nits skipped)

- **Fix 1: R1 brand scope (security Medium).**
  - Both DEFINER UPDATEs in `catalog_ingredients_rederive_item_costs()` now also require `exists (select 1 from public.stores s where s.id = ii.store_id and s.brand_id = new.brand_id)`. The header, the (a) comment and the `comment on function` were updated to match.
  - The AC-6 test is flipped. The brand-2 store Z item and a new brand-2 link (`lid(1,3,3)`) keep 33.95 with xmin, cost and `updated_at` unchanged, after both C1 pack-size changes.
  - The final "every priced fixture on the rule" checks exclude those two rows.
  - New C11 block: a planted brand-2 unpriced row with cost `999999.999999` on a brand-1 catalog row no longer blocks the brand-1 admin's 35 → 1 decrease. The edit passes `lives_ok` and lands, the brand-1 row is re-derived, and the planted row is not written.
  - `plan(59)` → `plan(65)`.
  - Mutation check: with the brand predicate removed, 6 of 65 fail, including the `lives_ok` (22003 overflow).
  - The spec's R1, D-4 (pseudocode, side-effects bullet, AC-6 finding), D-7, D-9 AC-6 row, D-12 "Cross-brand rows" and AC-6 text now say "at a store of the catalog's brand".
- **Fix 2: stale `receive_purchase_order` comment.**
  - The copied body stays verbatim, plus one added line `-- NOTE (spec 207): superseded; per_each_cost guards <= 0 and rounds.` above the catalog select.
  - The SOURCE DISCIPLINE header now says "one changed line plus one NOTE comment" and explains why the old in-body comments are kept.
  - A `diff` against 20260707000000:114-393 shows exactly the NOTE line (added) and the per-each line (changed).
  - This is inside the function body, so the D-11 md5 check must use this final text.
- **Fix 3 (S-1): `apply_item_scalars_to_brand.test.sql`.**
  - New fresh catalog row W with one unpriced Towson row (case 0, cost 3.33), and its own `(…, 7, null, null)` call.
  - (15a): par fans out to 7. (15b): cost 3.33 and case 0 survive.
  - (15) is retitled as the priced-row pin. `plan(18)` → `plan(20)`.
  - The updated/skipped counts in (3)-(5) are unchanged.
- **Local DB.** The edited migration was re-applied to the local stack with `psql` (it is idempotent). No reset was needed, and the `schema_migrations` row was already there. `prosrc` was checked for the brand predicate and the NOTE line.
- **Gates after the fixes.**
  - pgTAP: 116/116 files, 2,743 assertions.
  - jest: 323 suites, 4,160 tests.
  - `typecheck:test`: exit 0.
  - The CI-seed-fidelity pass (seed rewritten through R3) was not repeated. The fixes touch only R1's scope and test-local fixtures.

## Files changed

**Migrations**
- `supabase/migrations/20261123130000_recompute_costs_on_pack_size_change.sql` (new): `pieces_per_case`, `per_each_cost`, the R3 triggers and functions on `inventory_items` / `item_vendors`, the brand-scoped R1 trigger and function on `catalog_ingredients`, `list_cost_drift()`, and the `receive_purchase_order` re-CREATE (one changed line plus one NOTE comment).

**pgTAP (new)**
- `supabase/tests/cost_rederive_on_pack_size.test.sql`: 65 assertions covering structure, AC-1 to AC-9 and AC-11, R3 INVOKER and RLS-wins, the R1 gate and scope, and the R1 brand scope (AC-6 flip plus the planted-overflow case).
- `supabase/tests/list_cost_drift.test.sql`: 17 assertions covering AC-10.

**pgTAP (fixture / pin updates, AC-12)**
- `supabase/tests/inventory_items_identity_lock.test.sql`: T72 / T73 pins, plus the catalog `case_qty` 12.
- `supabase/tests/apply_item_scalars_store_subset.test.sql`
- `supabase/tests/apply_item_scalars_to_brand.test.sql`: also the S-1 unpriced NULL-skip pin, (15a)/(15b).
- `supabase/tests/apply_item_vendors_to_brand.test.sql`
- `supabase/tests/item_vendors_backfill.test.sql`
- `supabase/tests/item_vendors_rls.test.sql`
- `supabase/tests/stock_store_from_store.test.sql`

**jest (new)**
- `src/utils/perEachCost.spec207.test.ts`: the AC-4 parity matrix for `piecesPerCase`, and for `calcUnitCost` with `caseQty > 0`.

**Spec**
- `specs/207-recompute-costs-on-unit-change.md`: Status, these notes, this list.

No change to `src/lib/db.ts`, `src/store/`, any screen, any edge function, `supabase/config.toml`, `seed.sql` or `app.json`.
