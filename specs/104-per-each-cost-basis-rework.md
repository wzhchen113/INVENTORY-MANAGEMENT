# Spec 104: Per-each (smallest-unit) cost basis rework

Status: READY_FOR_REVIEW

> This spec is a **deliberate, owner-decided reversal of part of spec 093**. It
> moves the stored `cost_per_unit` from "per COUNTED/tracking unit"
> (`case_price / case_qty`) to the **true per-EACH (smallest-unit)** cost
> (`case_price / (case_qty × sub_unit_size)` = `casePrice / piecesPerCase`),
> end-to-end and as the REAL stored basis — not just a display.
>
> It has **prod-data impact** (94 of 143 catalog ingredients have
> `sub_unit_size > 1`, so the new basis differs from today by 500×–2000× on the
> majority of items). All six open questions have been **resolved by the owner**
> (see "Open questions resolved" below) — the decisions are now final scope. The
> governing constraint across them: every **consumer-visible dollar figure**
> (recipe/BOM cost, stock value, reorder totals) stays numerically UNCHANGED;
> only the stored BASIS and the per-each DISPLAY label change.

## User story
As a store manager pricing recipes and reading inventory value, I want
`COST / UNIT` to be the true per-each (smallest-unit) cost — `case price ÷
(units-per-case × sub-units-per-unit)` — stored as the real basis everywhere, so
that the cost I see on an ingredient, the cost rolled into a recipe/BOM, the
stock value, and the per-vendor cost all reflect the actual cost of one smallest
unit, with no hidden second division at recipe time.

## Background — what is being reversed (verified against code today)

- **The spec-093 invariant being reversed.** `inventory_items.cost_per_unit` is
  currently stored/derived as `case_price / case_qty` (per counted unit), with
  `sub_unit_size` deliberately excluded. Single sources:
  - `calcUnitCost(casePrice, caseQty, subUnitSize)` ignores `subUnitSize` and
    returns `casePrice / caseQty` — [src/utils/unitConversion.ts:292](../src/utils/unitConversion.ts).
  - The `mapItem` fallback when `cost_per_unit` is 0 computes `cp / caseQty` —
    [src/lib/db.ts:4182-4192](../src/lib/db.ts).
  - The CI test that PINS this basis (and calls `case_qty × sub_unit_size` "the
    documented 12×-class error") — the `calcUnitCost (spec 093 Q3a …)` and
    `derivedUnitCost` describes in [src/components/cmd/IngredientForm.test.ts:279-342](../src/components/cmd/IngredientForm.test.ts).
- **Recipe/BOM costing compensates with a SECOND sub-unit divide.**
  `getIngredientLineCost` converts a recipe's sub-unit quantity to counted units
  via `qtyInCountedUnit = qtyInSubUnit / subUnitSize`, then `× costPerUnit` —
  [src/store/useStore.ts:2665-2698](../src/store/useStore.ts). If `cost_per_unit`
  becomes per-each, this path divides by sub-unit a SECOND time, so recipe costs
  come out `sub_unit_size×` too low **unless this function is also changed**.
- **The per-each formula already exists** (additive, spec 096):
  `piecesPerCase(caseQty, subUnitSize) = caseQty × subUnitSize` and
  `perEachCost({...}) = casePrice / piecesPerCase` (with a `costPerUnit ÷
  subUnitSize` fallback) — [src/utils/perEachCost.ts](../src/utils/perEachCost.ts).
  Today these only feed a DISPLAY (`InventoryCatalogMode` per-each segment). This
  spec makes that value the STORED basis.
- **Reorder cost is server-authoritative** and multiplies `cost_per_unit ×
  case_qty` to get whole-case cost — [supabase/migrations/20260630000100_report_reorder_list_multi_vendor.sql:486-491](../supabase/migrations/20260630000100_report_reorder_list_multi_vendor.sql):
  ```
  case when case_qty > 1
       then ceil(suggested_qty / case_qty) * case_qty * cost_per_unit
       else suggested_qty * cost_per_unit end as estimated_cost
  ```
  `suggested_qty` is in COUNTED units. Under spec 093 this is correct; under a
  per-each `cost_per_unit` BOTH branches go `sub_unit_size×` too low **unless the
  RPC is also changed**. The FE does NO cost math (spec 088/089) — it renders the
  server `estimated_cost` — so this is a backend change, not a frontend one.
  (Resolved OQ-1: reorder stays case-accurate; the RPC is re-derived so totals
  are numerically identical to today.)
- **The editor UX is already built (uncommitted working tree).**
  [src/components/cmd/IngredientForm.tsx](../src/components/cmd/IngredientForm.tsx)
  + [IngredientFormDrawer.tsx](../src/components/cmd/IngredientFormDrawer.tsx)
  make `cost / unit` a READ-ONLY, system-derived field (top-level + per-vendor
  cards) that recomputes from case price on input and on load via
  `derivedUnitCost(casePrice, caseQty)` ([IngredientForm.tsx:261-264](../src/components/cmd/IngredientForm.tsx)).
  The ONLY thing wrong is the divisor: it divides by `caseQty`, must divide by
  `caseQty × sub_unit_size`. This spec FOLDS THAT WORK IN (keep the read-only /
  derived UX, fix the formula) — it does not restart it.

## Acceptance criteria

Cost math (pure helpers):
- [ ] `calcUnitCost(casePrice, caseQty, subUnitSize)` returns
      `casePrice / (caseQty × subUnitSize)` (per-each), with each of `caseQty`
      and `subUnitSize` defaulting to `1` when absent/zero/non-finite (mirroring
      `piecesPerCase`). e.g. `calcUnitCost(50, 1, 500) === 0.1`;
      `calcUnitCost(20, 20, 1) === 1.0`; `calcUnitCost(20, 0, 5) === 0` (guard).
- [ ] `calcUnitCost` is single-sourced with `piecesPerCase`: for all inputs,
      `calcUnitCost(p, q, s) === (p > 0 && piecesPerCase(q, s) > 0 ? p / piecesPerCase(q, s) : 0)`.
- [ ] `derivedUnitCost(casePrice, caseQty)` is changed to take `subUnitSize` (or
      reads it from form values) so the editor's read-only `cost / unit` shows the
      per-each value: editing a `case_price=50` item with `units/case=1`,
      `sub-unit/unit=500` displays `0.1`, not `50`.

Recipe / BOM costing (the second-divide removal):
- [ ] `getIngredientLineCost` no longer divides the recipe sub-unit quantity by
      `subUnitSize` a second time when consuming `costPerUnit` — i.e. for a recipe
      line whose unit converts to the item's sub-unit, the returned cost equals
      `(recipe qty in sub-units) × perEachCost`, NOT `(… / subUnitSize) ×
      perCountedUnitCost`. The line cost for a fixed recipe is numerically
      UNCHANGED from today (the per-each cost × sub_unit_size more units exactly
      cancels the removed divide).
- [ ] The `ing.unit === item.unit` short-circuit
      ([useStore.ts:2677](../src/store/useStore.ts)) and the
      `ingredient_conversions` abstract-unit fallback
      ([useStore.ts:2687-2696](../src/store/useStore.ts)) are reviewed and
      adjusted so each remains numerically correct under the per-each basis
      (a recipe that says "1 each" of an item tracked in `each` must still cost
      one per-each unit).
- [ ] `getPrepRecipeCost` / `getPrepRecipeCostPerUnit` and the menu-item recipe
      cost roll-up ([RecipesSection.tsx:678](../src/screens/cmd/sections/RecipesSection.tsx))
      produce the SAME dollar figure for a given recipe as before this spec
      (regression-pinned).

Stock value / waste / reconciliation / dashboard displays (OQ-5 — reconcile at consumer, keep stock counted):
- [ ] `getInventoryValue` ([useStore.ts:2559-2564](../src/store/useStore.ts)) and
      every LIVE-`costPerUnit` `currentStock × costPerUnit` / `quantity ×
      costPerUnit` consumer (DashboardSection inv value, ReconciliationSection,
      InventoryCatalogMode `weightedCost`, plus the revision-sweep additions
      RestockSection/POsSection/ReceivingSection/EODCountSection — see §7) is
      reconciled so that stock value = `current_stock × sub_unit_size ×
      perEachCost`. The bridge is UNCONDITIONAL (every live row is per-each under
      option (b)). The on-screen inventory value (and reconciliation dollar figures)
      for a fixed stock level is numerically UNCHANGED from today. Stored
      `current_stock` is NOT re-denominated — it stays in counted/tracking units.
- [ ] **Waste snapshot (R1 resolved, option (a)) — write-side, NOT a read-side
      bridge.** `waste_log.cost_per_unit` stays per-counted-unit on both sides of
      the flip: the FE `logWasteEntry`/WasteLogSection path AND the staff `log_waste`
      RPC ([20260504000002](../supabase/migrations/20260504000002_staff_log_waste_rpc.sql))
      snapshot `cost_old` (= per-each `costPerUnit × sub_unit_size`), not the raw
      per-each cost. `getWasteThisWeek` and DashboardSection waste reads stay
      UNBRIDGED. Historical and new waste dollars both reconcile; the snapshot fits
      `numeric(10,2)` losslessly (no waste-column widening).
- [ ] The detail-panel and inventory-list "Cost / unit" / "cost / u" cells
      ([ItemDetailScreen.tsx:103,112](../src/screens/cmd/ItemDetailScreen.tsx),
      [InventoryDesktopLayout.tsx:455,464](../src/screens/cmd/InventoryDesktopLayout.tsx),
      [InventoryCatalogMode.tsx:831](../src/screens/cmd/sections/InventoryCatalogMode.tsx),
      [VendorsSection.tsx:386](../src/screens/cmd/sections/VendorsSection.tsx))
      show the per-each cost and remain self-consistent with the per-each value
      stored. The label reads as per-each / smallest-unit (OQ-3).
- [ ] `InventoryCatalogMode`'s existing per-each display
      ([InventoryCatalogMode.tsx:399-428](../src/screens/cmd/sections/InventoryCatalogMode.tsx))
      does not double-divide once `costPerUnit` is already per-each (the
      `perEachCost` casePrice primary path stays correct; its `costPerUnit /
      subUnitSize` FALLBACK must be revisited so it doesn't divide an
      already-per-each cost again).

Display label (OQ-3 — clarify the label to per-each / smallest-unit):
- [ ] The "Cost / unit" / "cost / u" label in the detail panel
      ([ItemDetailScreen.tsx](../src/screens/cmd/ItemDetailScreen.tsx)), the
      inventory list ([InventoryDesktopLayout.tsx](../src/screens/cmd/InventoryDesktopLayout.tsx),
      [InventoryCatalogMode.tsx](../src/screens/cmd/sections/InventoryCatalogMode.tsx)),
      and the editor ([IngredientForm.tsx](../src/components/cmd/IngredientForm.tsx)
      top-level + per-vendor cards) is updated to read as per-each /
      smallest-unit (e.g. "cost / each" or a per-each suffix) so that a
      `case_qty=1`, `sub_unit_size=500` item showing `$0.10` reads sensibly as
      the cost of one of 500 pieces. The exact wording is the FE slice's call;
      the label must no longer imply per-counted-unit.

Per-vendor cost (spec 102):
- [ ] `item_vendors.cost_per_unit` (multi-vendor) uses the SAME per-each basis.
      The editor's per-vendor `handleVendorCasePriceChange`
      ([IngredientForm.tsx:832-837](../src/components/cmd/IngredientForm.tsx))
      derives each link's `cost_per_unit` via the per-each formula; the create /
      update reconcile in [db.ts](../src/lib/db.ts) persists the per-each value.
- [ ] The reorder RPC's per-vendor cost coalesce
      (`coalesce(nullif(iv.cost_per_unit,0), ii.cost_per_unit, 0)`) consumes the
      per-each value consistently with the OQ-1 reorder decision (totals
      unchanged).

Reorder cost (server) — OQ-1: KEEP REORDER CASE-ACCURATE:
- [ ] Reorder `estimated_cost`, `vendor_total_cost`, and
      `kpis.total_estimated_cost` for a fixed store/day are numerically EQUAL to
      today's values after this spec. Order quantities, `suggested_cases`,
      `suggested_units`, and the cases/units display are unchanged; only the cost
      derivation in the RPC adapts to the new per-each `cost_per_unit` basis. The
      exact server expression (e.g. `× case_qty × sub_unit_size`, or cost
      directly off `case_price`) is the architect's call; this AC pins **totals
      unchanged** as the contract. Reorder is NOT moved to a per-each order
      basis — ordering whole cases is correct vendor behavior.

Data migration (prod + seed) — OQ-2 (leave-as-is + audit, REVISED) and OQ-4 (migrate catalog too):
- [ ] The migration WIDENS `inventory_items.cost_per_unit` and
      `item_vendors.cost_per_unit` from `numeric(10,2)` to `numeric(12,6)` (B1)
      BEFORE the re-derivation, inside the same transaction.
      `catalog_ingredients.default_cost` is already unconstrained `numeric` — not
      widened. `information_schema.columns` reports `precision=12, scale=6` on both
      widened columns post-apply.
- [ ] A reversible, idempotent migration re-derives `inventory_items.cost_per_unit`,
      `item_vendors.cost_per_unit`, and `catalog_ingredients.default_cost` to the
      per-each basis via **`cost_new = cost_old / sub_unit_size`** (option (b), the
      exact (★)-inverse — NOT from `case_price`), for every row with a positive
      stored cost, reading `sub_unit_size` from the row's `catalog_ingredients`
      join. This converts population-X-by-old-rule rows (`case_price ≤ 0` but
      `sub_unit_size > 1`) too, eliminating the mixed basis (B2).
- [ ] (★) round-trip holds within tolerance: for every derived row,
      `cost_new × sub_unit_size` reconstructs the pre-flip `cost_old` to within
      $0.001 (the `numeric(12,6)` bound), pinned by pgTAP on a high-`sub_unit_size`
      fixture row against the audit `old_cost`.
- [ ] Rows that cannot be re-derived (stored `cost_per_unit` / `default_cost` ≤ 0
      or null) keep their (zero) cost untouched and are snapshotted to the
      audit/backout table for hand-review as "priced at zero" (mirrors the spec 093
      audit pattern, `revoke all from anon, authenticated`, not in any realtime
      publication). Idempotency is guarded on the audit table (the predicate does
      not self-extinguish under option (b)).
- [ ] A documented `-- BACKOUT` block restores prior `cost_per_unit` /
      `default_cost` from the audit snapshot **while the columns are still
      `numeric(12,6)`**, then (optionally) re-narrows the type to `numeric(10,2)` —
      restoring VALUES from the snapshot, not narrowing the type alone (narrowing
      first would re-truncate). `inventory_items_cpu_backup_20260626` is referenced /
      preserved, not dropped.
- [ ] [supabase/seed.sql](../supabase/seed.sql) `inventory_items.cost_per_unit`,
      `item_vendors.cost_per_unit`, and `catalog_ingredients.default_cost`
      (OQ-4) values are regenerated to the per-each basis so a fresh local stack
      and CI start consistent with prod.
- [ ] The migration is reflected in prod's `schema_migrations` (db-migrations
      gate stays green) and applied via the project's prod-apply path
      (`ebwnovzzkwhsdxkpyjka`, MCP execute_sql — `db push` lacks the prod
      password; see MEMORY).

Tests (track named per spec 022):
- [ ] **jest** — the spec-093 `calcUnitCost` describe and `derivedUnitCost`
      describe in [IngredientForm.test.ts](../src/components/cmd/IngredientForm.test.ts)
      are REPLACED to assert the per-each basis (the old asserts that pin
      `case_price / case_qty` and call `× sub_unit_size` the "12×-class error" are
      removed/inverted — they directly contradict this spec). A
      `getIngredientLineCost` regression test pins that a representative recipe
      line's dollar cost is unchanged across the basis flip.
- [ ] **pgTAP** — a DB test pins reorder `estimated_cost` / `vendor_total_cost`
      for a seeded fixture equals the pre-spec figure under the new basis (guards
      the server reorder-math change).
- [ ] **shell smoke** — optional; only if the architect adds a prod-derivation
      verification script (parallel to the 2026-06-26 cost-basis correction).

## In scope
- Fix `calcUnitCost` to the per-each formula; single-source it with `piecesPerCase`.
- Fix `derivedUnitCost` + the editor's top-level and per-vendor case-price
  handlers and the `fromItem` load path to derive/display per-each cost
  (KEEPING the already-built read-only/derived UX — fix the divisor only, to
  `case_qty × sub_unit_size`).
- Fix the `mapItem` fallback in `db.ts` so the no-stored-cost fallback is per-each.
- Remove the second sub-unit divide in `getIngredientLineCost`; verify the
  short-circuit and abstract-conversion branches stay correct.
- Reconcile all `× costPerUnit` consumers (stock value, waste, reconciliation,
  dashboard, recipe roll-up, catalog weightedCost) to the per-each basis with the
  `× sub_unit_size` bridge at the consumer (OQ-5) so on-screen dollar figures are
  unchanged; counted-unit stock is NOT re-denominated.
- Clarify the "cost / unit" label to per-each / smallest-unit across detail
  panel, inventory list, and editor (OQ-3).
- Per-vendor `item_vendors.cost_per_unit` on the per-each basis (editor + db.ts
  reconcile).
- Server reorder cost math re-derived so reorder totals are numerically
  unchanged (OQ-1).
- **WIDEN `inventory_items.cost_per_unit` + `item_vendors.cost_per_unit` to
  `numeric(12,6)` (B1)** in the migration before re-derivation, reversibly.
- Reversible, idempotent, audited data migration re-deriving every stored
  `cost_per_unit` plus `item_vendors.cost_per_unit` plus
  `catalog_ingredients.default_cost` (OQ-4) **via `cost_old / sub_unit_size`
  (option (b), the (★)-inverse — NOT from `case_price`)** (prod + seed), with
  backout-restores-values-then-renarrows, preserving the existing
  `inventory_items_cpu_backup_20260626`; only `cost_old ≤ 0` rows left as-is and
  audited (OQ-2 revised). This converts the population-X rows with `sub_unit_size >
  1` and eliminates the mixed basis (B2).
- **Keep the waste snapshot per-counted-unit (R1, option (a)):** the FE
  `logWasteEntry` path AND the staff `log_waste` RPC snapshot `costPerUnit ×
  sub_unit_size`. The staff-RPC edit is a backend deliverable (re-CREATE
  `log_waste` to bridge the snapshot).
- Replace/repair the spec-093 cost tests; add regression + pgTAP coverage
  (reorder dollar with cent tolerance + the (★)-inverse round-trip check).

## Out of scope (explicitly)
- **Changing what `current_stock` / counted-unit semantics mean.** This spec does
  NOT re-denominate inventory counts into "each" (OQ-5: keep stock counted). The
  architect supplies the `× sub_unit_size` conversion at the consumer so stock
  value is unchanged; stored stock stays in counted units. Rationale: that is a
  separate, larger data change.
- **`calcCasePrice`'s `× subUnitSize` factor / cost→price→cost round-trips.**
  Spec 093 R4 left `calcCasePrice = unitCost × caseQty × subUnitSize`; with a
  per-each `unitCost` this round-trip now reads more sensibly, but auditing every
  `calcCasePrice` caller is out of scope unless the architect finds a live break.
  Rationale: keep the blast radius on the COST→ direction the owner asked for.
- **EOD / count-screen quantity entry and the cases/units order DISPLAY.** Order
  quantities, `suggested_cases`, `suggested_units`, and the cases·units strings
  are unchanged. Rationale: the owner asked to change the cost BASIS, not the
  ordering UX.
- **Reorder moving to a per-each ORDER basis.** OQ-1 resolved to KEEP reorder
  case-accurate. Rationale: ordering whole cases is correct vendor behavior.
- **A compat shim / announcement for external `cost_per_unit` readers.** OQ-6
  resolved: there are NO out-of-repo consumers reading
  `inventory_items.cost_per_unit` expecting per-counted-unit, so no shim is
  needed. Rationale: confirmed by the owner; safe to migrate in place.
- **The `app.json` slug**, identity drift, and the repo-root spreadsheet —
  untouched (CLAUDE.md load-bearing / DO-NOT-AUTO-FIX).
- **Customer PWA / staff app cost surfaces** beyond what the shared
  `reorderExport.ts` / staff Reorder already consume from the (server-computed)
  reorder payload. Rationale: this repo is admin-only; staff reorder rides the
  same server `estimated_cost` (which OQ-1 keeps unchanged).

## Open questions resolved
- **Q (OQ-1): When `cost_per_unit` becomes per-each, does reorder cost move to a
  per-each basis, or stay case-accurate?** → **A: KEEP REORDER COST
  CASE-ACCURATE.** Reorder still costs whole cases. Re-derive the server RPC math
  so reorder dollar totals (`estimated_cost`, `vendor_total_cost`,
  `kpis.total_estimated_cost`) stay numerically IDENTICAL to today; order
  quantities and cases/units display are unchanged. "Totals unchanged" is pinned
  in the AC; the exact server expression is the architect's call.
- **Q (OQ-2): How are rows with missing/zero `case_price` handled in the
  re-derivation?** → **A (ORIGINAL): LEAVE AS-IS + AUDIT** rows without a positive
  `case_price`. **A (REVISED post-build, see §0/§1 option (b)): the re-derivation no
  longer reads `case_price` at all** — it derives every priced row as `cost_old /
  sub_unit_size`. So the un-derivable population shrinks to rows whose STORED COST is
  zero/null (`cost_old <= 0`); those keep their (zero) cost untouched and are
  snapshotted for hand-review as "priced at zero." Rows that previously fell to
  leave-as-is solely because `case_price` was absent — but which carried a real
  stored `cost_per_unit` — are now correctly converted. This is what closes the B2
  mixed-basis hazard (8 `inventory_items` rows had `case_price ≤ 0` yet
  `sub_unit_size > 1`). The audit/backout table and hand-review posture are
  unchanged; only the membership predicate of population 'X' changes. The catalog
  rule changes identically (`default_cost <= 0` is the only leave-as-is case).
- **Q (OQ-3): Does the "cost / unit" display label change for a `case_qty=1`,
  `sub=500` item now reading $0.10?** → **A: CLARIFY THE LABEL** to per-each /
  smallest-unit in the detail panel + inventory list + editor so the number reads
  sensibly. Exact wording is the FE slice's call; the label must no longer imply
  per-counted-unit.
- **Q (OQ-4): Does `catalog_ingredients.default_cost` migrate too, or only
  per-store `inventory_items`?** → **A: MIGRATE THE CATALOG TOO** — re-derive
  `catalog_ingredients.default_cost` to per-each so newly-created items seed the
  correct basis.
- **Q (OQ-5): How is stock value reconciled when `current_stock` is counted units
  and `cost_per_unit` becomes per-each?** → **A: RECONCILE AT THE CONSUMER, KEEP
  STOCK COUNTED** — stock value = `current_stock × sub_unit_size × perEachCost`
  (≡ today's value); on-screen inventory/waste/reconciliation value is UNCHANGED;
  stored counts are NOT re-denominated.
- **Q (OQ-6): Are there external readers of `inventory_items.cost_per_unit` that
  expect per-counted-unit and would silently shift basis?** → **A: NONE.**
  Confirmed by the owner — no out-of-repo consumer reads
  `inventory_items.cost_per_unit` expecting per-counted-unit. Safe to migrate in
  place; no compat shim or announcement needed.

## Dependencies
- Spec 093 (the invariant being reversed) — `calcUnitCost`, the `db.ts` fallback,
  and the `IngredientForm.test.ts` pins.
- Spec 096 — `piecesPerCase` / `perEachCost` (the per-each formula reused as the
  stored basis) and the `InventoryCatalogMode` per-each display.
- Spec 102 — `item_vendors` multi-vendor cost (`item_vendors.cost_per_unit`) and
  the multi-vendor reorder RPC [20260630000100_report_reorder_list_multi_vendor.sql](../supabase/migrations/20260630000100_report_reorder_list_multi_vendor.sql).
- Spec 088 — reorder cases/units + server-authoritative `estimated_cost`.
- The uncommitted editor work in
  [IngredientForm.tsx](../src/components/cmd/IngredientForm.tsx) +
  [IngredientFormDrawer.tsx](../src/components/cmd/IngredientFormDrawer.tsx)
  (read-only derived cost) — folded in, divisor fixed to `case_qty × sub_unit_size`.
- New prod-touching migration + seed regen; prod apply via MCP execute_sql
  against `ebwnovzzkwhsdxkpyjka` + insert into `schema_migrations` (db-migrations
  gate). The existing `inventory_items_cpu_backup_20260626` table is preserved.

## Project-specific notes
- **Cmd UI section / legacy:** admin Cmd UI — `IngredientForm` /
  `IngredientFormDrawer`, `InventoryCatalogMode`, `ItemDetailScreen` /
  `InventoryDesktopLayout`, `RecipesSection`, `WasteLogSection`,
  `ReconciliationSection`, `DashboardSection`, `VendorsSection`. No legacy surface.
- **Per-store or admin-global:** per-store data (`inventory_items.cost_per_unit`,
  `item_vendors.cost_per_unit`) is store-scoped via `auth_can_see_store()`;
  `catalog_ingredients.default_cost` is brand-shared (OQ-4 migrates it). Migration
  touches all stores' rows.
- **Realtime channels touched:** `brand-{id}` (catalog `default_cost`, now
  migrated per OQ-4) and `store-{id}` (inventory_items cost). The migration should
  bump `updated_at` so an admin with the catalog/inventory open replays the change
  — and note the **realtime publication gotcha** (mid-session publication changes
  need `docker restart supabase_realtime_imr-inventory` to re-snapshot the slot)
  as a risk if any table's publication membership is touched (it should not be).
- **Migrations needed:** YES — one reversible, idempotent, audited migration that
  (1) WIDENS `inventory_items.cost_per_unit` + `item_vendors.cost_per_unit` to
  `numeric(12,6)` (B1), (2) re-derives those two + `catalog_ingredients.default_cost`
  (OQ-4) via `cost_old / sub_unit_size` (option (b)), (3) re-CREATEs
  `report_reorder_list` with the adapted cost expression (OQ-1, totals unchanged),
  and (4) re-CREATEs the staff `log_waste` RPC to keep the waste snapshot
  per-counted-unit (R1 option (a)). Seed regen accompanies it. All in ONE file,
  atomic.
- **Edge functions touched:** none expected (reorder is a Postgres RPC, not an
  edge function; cost math lives in SQL + FE).
- **Web/native scope:** web + native (the cost math and editor are shared; the
  staff Reorder screen consumes the same server `estimated_cost`). No web-only
  surface.

## Backend design

> **REVISION (post-build, owner-decided).** The backend developer implemented §4
> faithfully on the LOCAL stack and surfaced two blockers that invalidate the
> original storage premise. Both are now resolved IN SCOPE and the sections below
> are revised:
> - **B1 — column truncation.** `inventory_items.cost_per_unit` and
>   `item_vendors.cost_per_unit` are `numeric(10,2)` (init_schema:58,
>   item_vendors:65), NOT unconstrained numeric. The per-each basis is genuinely
>   sub-cent for high-`sub_unit_size` items, so it truncates at write time and
>   breaks OQ-1 "totals numerically identical." **Owner decision: WIDEN both
>   columns** (to `numeric(12,6)` — justified in §1) via `ALTER TABLE` in the
>   migration. `catalog_ingredients.default_cost` is ALREADY unconstrained
>   `numeric` (p1_additive:43) — no widening needed there. Now in scope.
> - **B2 — mixed basis.** The original §0 premise "un-derivable rows always have
>   `sub_unit_size = 1`" is FALSE: 8 `inventory_items` rows are population X
>   (`case_price ≤ 0`) yet have `sub_unit_size > 1`. The reorder RPC Hunk 2 `×
>   sub_unit_size` would inflate them once they get a non-zero cost. **Resolved by
>   switching the derivation to `cost_new = old_cost / sub_unit_size`** (option
>   (b)) — the exact (★) inverse, which needs no `case_price`, converts population
>   X too, and eliminates the mixed basis entirely so every consumer can `×
>   sub_unit_size` unconditionally. OQ-2's resolution is updated below.

### 0. The algebraic invariant this whole spec rests on

Let `pieces = piecesPerCase(case_qty, sub_unit_size) = case_qty × sub_unit_size`
(each factor `|| 1`). The flip is a single change of variable:

```
cost_old (per counted/tracking unit) = case_price / case_qty
cost_new (per each / smallest unit)  = case_price / (case_qty × sub_unit_size)
⇒  cost_old = cost_new × sub_unit_size                      ... (★)
```

Every "value unchanged" AC is satisfied by inserting exactly one `× sub_unit_size`
on the consumer side of (★) — at recipe time the removed second divide supplies
it; at stock/waste/reorder time an explicit `× sub_unit_size` supplies it. There
is no other factor. I use (★) as the proof obligation for each surface below.

**How the re-derivation is done (REVISED — option (b)).** Rather than recompute
`cost_new` from `case_price` (which is undefined for the 8 population-X rows that
have `case_price ≤ 0` but `sub_unit_size > 1`), the migration derives **every**
row directly off its own stored cost:

```
cost_new = cost_old / sub_unit_size                         ... (★ inverse)
```

This is algebraically identical to `case_price / (case_qty × sub_unit_size)` for
the rows where both exist (since `cost_old = case_price / case_qty`), but it has
three decisive properties the case_price route lacks:

1. **No `case_price` dependency.** It works on any row that has a stored cost,
   including the 8 population-X rows (`case_price ≤ 0`, `sub_unit_size > 1`). Those
   convert correctly to the per-each basis instead of being stranded on the old
   basis with `sub_unit_size > 1` — which was the latent `sub_unit_size×` inflation
   bug B2 flagged.
2. **Totals exact by construction.** Every consumer bridge multiplies `cost_new ×
   sub_unit_size`, which reconstructs `cost_old` exactly (to the widened column's
   precision — see the precision bound in §1). There is no second source of
   rounding.
3. **No mixed basis.** After the flip, `cost_per_unit` is **uniformly per-each on
   every row** (the only rows left un-flipped are those whose `cost_old = 0`, where
   `0 / s = 0` is already per-each and the bridge is a no-op). Consumers therefore
   apply `× sub_unit_size` **unconditionally** — they do NOT need a discriminator,
   and they do NOT need to special-case `pieces <= 1` (for those rows
   `sub_unit_size = 1` so the bridge is a self-evident no-op).

**The mixed-basis hazard B2 raised is thereby eliminated, not merely flagged.**
The original §0 caveat ("rows left on the old basis must NOT get the bridge") no
longer applies because no row is left on the old basis with `sub_unit_size > 1`.
This is the single most important change in this revision: it converts the design
from "bridge only the migrated rows, beware the un-migrated ones" to "every row is
per-each; bridge them all." The reorder RPC's unconditional `× pis.sub_unit_size`
(§4 Hunk 2) is now correct for 100% of rows by construction.

### 1. Data model changes

**Two column widenings (B1 — owner-decided, now in scope).** The per-each basis
is sub-cent for the 94 high-`sub_unit_size` items; the two live cost columns are
`numeric(10,2)` (2 dp) and would truncate the value at write time. The migration
widens both BEFORE the re-derivation:

```sql
alter table public.inventory_items alter column cost_per_unit type numeric(12,6);
alter table public.item_vendors     alter column cost_per_unit type numeric(12,6);
```

- `catalog_ingredients.default_cost` is ALREADY unconstrained `numeric`
  (p1_additive:43) — it stores the per-each value losslessly with no DDL. Left
  untouched. `inventory_items.case_price` (unconstrained `numeric`,
  remote_schema:81), `item_vendors.case_price` (`numeric(10,2)`), and
  `catalog_ingredients.default_case_price` (unconstrained `numeric`) are
  **dividends**, not the truncating quotient, and are NOT read by the option-(b)
  derivation at all (it divides the stored `cost_old`, see below) — so none of the
  `case_price` columns need widening.

**Why `numeric(12,6)` (precision justification, satisfies (★) round-trip within AC
tolerance).** The proof obligation is: the consumer bridge `cost_new ×
sub_unit_size` must reconstruct the original 2-dp `cost_old` to the cent.
`cost_old` has at most 2 fractional digits; `sub_unit_size` is an integer (max
~2000 in the catalog, e.g. the 2oz Cup). Storing `cost_new = cost_old /
sub_unit_size` at `d` fractional digits bounds the reconstruction error by
`0.5 × 10^-d × sub_unit_size`:
- at `d = 2` (today): `0.5e-2 × 2000 = 5.00` — dollars wrong. (This is B1.)
- at `d = 4`: `0.5e-4 × 2000 = 0.10` — ten cents, can flip the rounded cent. Too
  coarse.
- at `d = 6`: `0.5e-6 × 2000 = 0.001` — one tenth of one cent, safely inside the
  "totals numerically identical" cent tolerance for every catalog row.
6 fractional digits is the floor; `numeric(12,6)` adds 6 integer digits (max
$999,999.999999) which comfortably holds any whole-dollar `cost_old` that lands
back in the column for a `pieces<=1` row. Worked example for the worst cited row
(2oz Cup, `cost_old = $33.00`, `sub_unit_size = 2000`): `cost_new = 33/2000 =
0.016500` stored exactly at 6 dp; bridge `0.016500 × 2000 = 33.000000` → `$33.00`,
exact (vs. the `numeric(10,2)` path which stored `0.02` → bridged `$40.00`, the
+$7/case break B1 reported). A non-terminating example (`cost_old = $2.33`,
`sub_unit_size = 2000`): `cost_new = 0.001165` at 6 dp; bridge `× 2000 = 2.330000`
→ `$2.33`, exact.

**No new indexes on live tables.** The widening is a metadata-only type change for
the `(10,2)→(12,6)` direction in Postgres? — NO: a `numeric` precision/scale
change requires a table rewrite (it re-scans and re-stores every row). On the seed
(≤544 inventory_items + ≤536 item_vendors) this is single-digit-ms; on prod it is
a brief `ACCESS EXCLUSIVE` lock on two small tables. Acceptable; flagged in §8 R9.

**One new migration (column widening + data re-derivation + audit table +
reorder RPC re-CREATE):**

`supabase/migrations/20260701000000_spec104_per_each_cost_basis.sql`

**This is the SAME on-disk file the dev already wrote** (the prior faithful-but-
flawed version). REVISE it in place — do not add a second migration. The local
stack is currently reverted clean, so re-applying the revised file from scratch is
the supported path. Keep it ONE reversible / idempotent / audited file.

This single migration now covers, in order: (1) the two `ALTER TABLE` widenings,
(2) the data re-derivation + audit snapshot, (3) the `report_reorder_list`
re-CREATE (OQ-1). Keep them in one file so the basis flip and the RPC that has to
compensate for it land atomically — a half-applied state (values flipped, RPC
stale) makes every reorder total `sub_unit_size×` low. The widenings go FIRST,
inside the same transaction, so the UPDATEs that follow can write sub-cent values
without truncation. Structure otherwise mirrors
`20260602120000_spec093_case_qty_backfill.sql` (begin/commit, `create table if not
exists … _audit`, RLS-on-no-policy + explicit `revoke all from anon,
authenticated`, `on conflict do nothing` snapshots, a `raise notice` count, a foot
`-- BACKOUT` block).

New audit table: `public.spec104_per_each_cost_audit`
```
source_table   text,     -- 'inventory_items' | 'item_vendors' | 'catalog_ingredients'
row_id         uuid,     -- the row's pk (item id / item_vendors id / catalog id)
catalog_id     uuid,     -- for the sub_unit_size join provenance
old_cost       numeric,  -- pre-flip cost_per_unit / default_cost (the DIVIDEND under option (b))
new_cost       numeric,  -- post-flip value (old_cost / sub_unit_size), OR NULL for population 'X'
case_qty       numeric,  -- provenance only (NOT used by the option-(b) derivation)
sub_unit_size  numeric,  -- the DIVISOR
case_price     numeric,  -- provenance only — the row's case_price/default_case_price (or 0/null)
population     char(1),  -- 'D' = derived, 'X' = left-as-is (cost_old <= 0)
migrated_at    timestamptz default now(),
primary key (source_table, row_id)
```
- Audit table is `enable row level security` + `revoke all on … from anon,
  authenticated`, NOT added to `supabase_realtime`. Same posture as the spec 093
  audit table. It is BOTH the backout source (population D) and the hand-review
  list (population X), one artifact two readers.
- `old_cost` is now load-bearing for the derivation itself (it is the dividend, not
  just a backout snapshot). `case_qty` / `case_price` are kept for provenance /
  hand-review but the UPDATE no longer reads them. Keeping all columns means the
  backout block is unchanged and the X-row review still shows why a row was skipped.
- **Destructive vs additive:** the two `ALTER TABLE`s are reversible type widenings
  (the BACKOUT narrows back — see note). The audit table is additive. The three
  UPDATEs are destructive to the column values but fully reversible from the audit
  snapshot (population D rows carry `old_cost`). Additive-safe to re-run: each
  UPDATE is guarded so an already-flipped row is not flipped twice — see
  idempotency below.

**Re-derivation rule (REVISED to option (b) — divide the stored cost, per the
three targets):**
- `inventory_items`: join to `catalog_ingredients` on `catalog_id` for
  `sub_unit_size` only. Derive iff `coalesce(ii.cost_per_unit,0) > 0`. New value =
  `ii.cost_per_unit / coalesce(ci.sub_unit_size, 1)`.
- `item_vendors`: join through `inventory_items` → `catalog_ingredients` for
  `sub_unit_size`. Derive iff `coalesce(iv.cost_per_unit,0) > 0`. New value =
  `iv.cost_per_unit / coalesce(ci.sub_unit_size, 1)`. (The DIVIDEND is the link's
  OWN `iv.cost_per_unit`, not the item's — each vendor link converts independently.)
- `catalog_ingredients.default_cost` (OQ-4): derive iff
  `coalesce(default_cost,0) > 0`. New value = `default_cost / coalesce(sub_unit_size, 1)`.

Note the predicate flipped from `case_price > 0 AND pieces > 1` to **`cost_old >
0`** alone. A row with `sub_unit_size = 1` is still "derived" but its new value
equals its old value (`cost / 1`), so the UPDATE is a numeric no-op for it —
harmless, and it keeps the rule uniform (every priced row is per-each afterward).
The 8 population-X-by-old-rule rows (`case_price ≤ 0`, `sub_unit_size > 1`) are now
DERIVED iff they have a non-zero stored cost — which converts them correctly
instead of stranding them on a mixed basis. (Today their cost is 0 so they fall to
population 'X' regardless; the point is the rule is now CORRECT the moment such a
row gets a real cost, closing B2's latent bug.)

**Idempotency.** The per-each predicate does NOT self-extinguish (dividing a row
that's already per-each by `sub_unit_size` again would shrink it `sub_unit_size×`).
Guard on the audit table: `WHERE NOT EXISTS (select 1 from
spec104_per_each_cost_audit a where a.source_table = '<t>' and a.row_id =
<row>.<pk>)`. First run snapshots + flips; a re-run finds the audit row and skips.
Re-running the file is a no-op after the first apply. (Do the snapshot INSERT and
the UPDATE in the same predicate window so they can't drift.) This is doubly
important under option (b): because the predicate is now `cost_old > 0` and a
flipped row still has `cost_old > 0`, the audit-table guard is the ONLY thing
preventing a double-divide — there is no self-extinguishing fallback. Reviewers
must confirm the guard is present on all three UPDATEs.

**Leave-as-is population (OQ-2, population 'X' — REVISED).** Under option (b) the
only un-derivable rows are those with `cost_old <= 0` (or null) — for them `0 / s =
0`, so there is nothing to convert; the column already holds the correct per-each
value (zero). They are snapshotted with `new_cost = NULL` and NOT mutated, for
hand-review (a zero cost usually means an unfinished catalog row that still needs a
price). This is a STRICT SUBSET of the old population X: rows that used to be left
as-is solely because `case_price` was absent (but had a real stored `cost_old`) are
now correctly DERIVED. **OQ-2's resolution is updated accordingly** — see the
"Open questions resolved" amendment below.

**`updated_at` bump.** The three UPDATEs set `updated_at = now()` on
`inventory_items` and `catalog_ingredients` so an admin with the catalog/inventory
open replays via realtime (`store-{id}` / `brand-{id}`). `item_vendors` has no
`updated_at` in the realtime payload the FE reloads on — its change rides the
parent item reload. No publication membership change (see §6), so the realtime
publication gotcha does NOT apply to this migration.

**`inventory_items_cpu_backup_20260626`** (prod-only table from the 2026-06-26
cost-basis correction; not in any repo migration) is REFERENCED in the migration
header comment as a pre-existing prior-basis snapshot and explicitly NOT dropped.
The new audit table is the spec-104 backout source; the 0626 table is the prior
correction's and stays untouched.

**BACKOUT must restore VALUES from the snapshot, not just narrow the type.** The
`-- BACKOUT` block must (1) restore `cost_per_unit` / `default_cost` from
`spec104_per_each_cost_audit.old_cost` for population 'D' rows FIRST, THEN (2)
optionally narrow the two columns back to `numeric(10,2)`. Order matters and is
non-negotiable: narrowing the type BEFORE restoring values would re-truncate the
restored 2-dp `cost_old` (a round-trip back through `(10,2)` is lossless for the
old values since they were 2-dp originally, but only if the VALUES are written
first while the column is still wide). Equivalently — and this is the safer framing
to put in the file — restore values while the column is still `numeric(12,6)`, then
`alter … type numeric(12,6)`→`numeric(10,2)` is a clean re-narrow because every
restored value is an exact 2-dp number again. The block is documented / not
auto-applied (the project has no down-migration convention), same as the dev's
prior version. Drop the audit table LAST (export the X-rows first if still needed).

### 2. RLS impact

No new policies on live tables (no new columns, no new tables read over PostgREST).
The audit table `spec104_per_each_cost_audit` is RLS-enabled-no-policy +
`revoke all from anon, authenticated` = deny-all to every app caller (same as the
spec 093 audit table). The reorder RPC re-CREATE preserves its existing ACL — see
§4. Existing policies needing review: none; the three target tables keep their
current `auth_can_see_store()` / brand-scoped policies and no policy reads
`cost_per_unit`.

### 3. API contract

No new PostgREST endpoint, no new RPC. Three existing surfaces change BEHAVIOR
(same shape, same signature, re-derived numbers):

1. **`report_reorder_list(uuid, jsonb)` RPC** — see §4. Request shape, response
   envelope `{vendors[], kpis, _warnings, as_of_date}`, and all per-item keys are
   byte-for-byte unchanged. Only the `estimated_cost` / `vendor_total_cost` /
   `kpis.total_estimated_cost` derivation adapts. Error cases unchanged (42501 on
   auth gate fail).
2. **`log_waste(...)` RPC (staff path)** — RE-CREATEd (R1 option (a)). Same
   signature, same return. The ONLY change: it snapshots `v_item.cost_per_unit ×
   sub_unit_size` (joining `catalog_ingredients` for `sub_unit_size`) instead of the
   raw `cost_per_unit`, so the `waste_log.cost_per_unit` snapshot stays
   per-counted-unit after the live column becomes per-each. Without this, every
   staff-logged waste row post-flip is `sub_unit_size×` low. Belongs in the same
   spec-104 migration (atomic with the flip). Preserves its existing ACL /
   security-definer posture (byte-identical signature).
3. **`create_inventory_item_with_catalog(...)` RPC** — NOT re-CREATEd. It already
   passes `p_per_store->>'cost_per_unit'` straight through and seeds
   `catalog_ingredients.default_cost` from `p_default_cost`. Because the FE now
   computes `cost_per_unit` / `default_cost` on the per-each basis (via the fixed
   `derivedUnitCost`/`calcUnitCost`), new items seed the correct basis with no SQL
   change. Confirmed: the RPC is basis-agnostic — it stores whatever scalar the
   client sends. No edit needed.

### 4. Reorder RPC re-derivation (OQ-1) — the exact expression

Re-CREATE `public.report_reorder_list(uuid, jsonb)` via `create or replace` in the
SAME migration file. Copy the LATEST on-disk body VERBATIM from
`20260630000100_report_reorder_list_multi_vendor.sql` (carries specs
087/088/100/102) — per the function-header rule both prior reorder migrations
state, copy the latest body, not a stale revision, or specs 088/100/102 silently
revert and their pgTAP suites go red.

**Exactly TWO additive hunks vs that body; everything else byte-identical:**

Hunk 1 — CTE `per_item` (currently ~line 433-467): surface the catalog
`sub_unit_size` from the EXISTING `ci` join (same join that already yields
`ci.case_qty` at line 440). Add one select item:
```
coalesce(ci.sub_unit_size, 1)::numeric  as sub_unit_size
```
No new join, no new scan — `ci` is `catalog_ingredients` joined on `ci.id =
ioh.catalog_id`. It threads downstream through `per_item_suggested` (`pi.*`) and
`per_item_filtered` (`pis.*`) with no extra edits.

Hunk 2 — CTE `per_item_filtered`, the `estimated_cost` CASE (currently lines
489-491): multiply BOTH branches by `pis.sub_unit_size`. Per (★),
`cost_old = cost_per_unit × sub_unit_size`, so this restores the pre-spec figure
exactly:
```
case when pis.case_qty > 1
     then (ceil(pis.suggested_qty / pis.case_qty) * pis.case_qty
            * pis.cost_per_unit * pis.sub_unit_size)
     else (pis.suggested_qty * pis.cost_per_unit * pis.sub_unit_size)
end as estimated_cost
```
`vendor_total_cost` (the `sum(pif.estimated_cost)` rollup) and
`kpis.total_estimated_cost` inherit this with NO further edit — `estimated_cost`
is the single cost source the header comment already calls out (line 481-482).

**Why this is numerically identical, not approximately:** `suggested_qty`,
`suggested_cases`, `case_qty`, the cases/units display, the par/forecast math, and
the per-vendor coalesce `coalesce(nullif(iv.cost_per_unit,0), ii.cost_per_unit,
0)` are ALL unchanged. The coalesce is basis-consistent post-migration (both
`iv.cost_per_unit` and `ii.cost_per_unit` are per-each). For every row,
`new_estimated_cost = old_factor × (cost_old / sub_unit_size) × sub_unit_size =
old_factor × cost_old = old_estimated_cost`. **Under option (b) this holds for
100% of rows by construction** — there is no longer a mixed-basis exception:
- For a `sub_unit_size > 1` priced row, `cost_per_unit` is per-each and
  `× sub_unit_size` reconstructs `cost_old` to the widened column's precision
  (6 dp — §1 bounds the error at $0.001/unit, inside cent tolerance).
- For a `sub_unit_size = 1` row, `cost_per_unit` was a numeric no-op in the flip
  (`cost/1`), so it equals `cost_old` and `× 1` leaves it unchanged.
- For a `cost_old = 0` (population 'X') row, the cost is 0 on both bases and the
  product is 0 either way.
The original "left-as-is rows keep the old basis, so × 1 happens to be correct"
reasoning is REPLACED: no row is left on the old basis with `sub_unit_size > 1`, so
the unconditional `× pis.sub_unit_size` is unconditionally correct. This is the
direct payoff of the B2 resolution. **Precision caveat for the pgTAP test (§8 R7):**
because the widened column stores 6 dp and the bridge multiplies by up to
`sub_unit_size`, assert the reorder dollar equality with a cent-level tolerance
(e.g. `abs(new - old) < 0.01` per vendor_total_cost), not byte-exact `numeric`
equality — the reconstruction is exact to ~$0.001, not to the full `numeric`
mantissa.

**ACL / grant:** the function signature is byte-identical, so `create or replace`
PRESERVES the existing `revoke … from public, anon` + `grant … to authenticated`.
NO grant/revoke statements in the migration. security invoker + the
`auth_can_see_store` gate unchanged.

### 5. `src/lib/db.ts` surface

No new helper functions. Three EDITS to existing surfaces (all camelCase mapping
already in place — no snake_case→camelCase changes):

1. **`mapItem` cost fallback (db.ts:4182-4192).** When `cost_per_unit` is 0, the
   fallback must compute per-each. Change `caseQty > 0 && cp > 0 ? cp / caseQty`
   to divide by `caseQty × subUnitSize` (both already in scope at 4150-4151).
   Single-source it through the same formula `calcUnitCost` will use, i.e.
   `cp / piecesPerCase(caseQty, subUnitSize)` (import `piecesPerCase` from
   `src/utils/perEachCost.ts` — it's a pure util, allowed in db.ts). Update the
   stale spec-093 "must NOT divide by sub_unit_size" comment to the per-each
   rationale. This keeps the no-stored-cost fallback consistent with `calcUnitCost`
   and the migration (AC: mapItem fallback per-each).
   - **Reconciliation with option (b):** a `cost_per_unit = 0` row is exactly the
     migration's population 'X' (it was NOT flipped). So the live value the FE sees
     for such a row comes from THIS fallback, not from the stored column. The
     fallback's per-each formula `case_price / (caseQty × subUnitSize)` is
     algebraically the SAME value the migration's `cost_old / sub_unit_size` would
     have produced had the row carried a stored `cost_old` (`case_price/case_qty`).
     So the fallback and the migration agree on the per-each basis — a population-X
     row with a `case_price` but no stored cost still renders a correct per-each
     number, and the consumer `× subUnitSize` bridge reconstructs `case_price /
     case_qty = cost_old` for it. No special-casing needed; the fallback is just
     the case_price-route per-each formula, used only when the stored column is 0.
2. **`createInventoryItem` / `updateInventoryItem` (db.ts ~316/433/487).** No
   formula change — they persist whatever `costPerUnit` / per-vendor `costPerUnit`
   the editor computed. Because the editor now derives per-each, the persisted
   value is per-each. Confirm `p_default_cost` is sent the same per-each
   `costPerUnit` so a brand-new catalog row seeds per-each `default_cost`
   (db.ts:316 sends `item.costPerUnit`). No code change beyond confirming the
   editor feeds per-each values in — covered by the FE slice.
3. **`logWasteEntry` write-side change (R1 option (a), now in scope).** The READ
   mapping (`fetchWasteLog`) is unchanged — `waste_log.cost_per_unit` stays a
   per-counted-unit snapshot and `getWasteThisWeek` stays unbridged. The WRITE
   (`logWasteEntry` in db.ts) must persist `costPerUnit × subUnitSize` (= `cost_old`)
   into the snapshot instead of the raw per-each `costPerUnit`, so the column stays
   per-counted-unit across the flip. This keeps the snapshot an exact 2-dp value
   that fits `numeric(10,2)` losslessly (no waste-column widening). The staff
   `log_waste` RPC gets the mirror server-side fix (§3.2). Both are required or the
   two write paths diverge.

### 6. Realtime impact

- `inventory_items.cost_per_unit` change → `store-{id}` channel (the migration's
  `updated_at` bump triggers the debounced 400ms reload). Admin viewing inventory
  re-reads the per-each value.
- `catalog_ingredients.default_cost` change → `brand-{id}` channel (catalog
  `updated_at` bump). Admin viewing the catalog re-reads.
- `item_vendors.cost_per_unit` change → rides the parent `inventory_items` reload
  (the `vendors[]` embed re-fetches with the item). No separate channel needed.
- **Publication gotcha — does NOT apply.** This migration does NOT touch
  `supabase_realtime` publication membership (no `alter publication … add table`).
  All three target tables are already in the publication. No
  `docker restart supabase_realtime_imr-inventory` step is required for this spec.
  (Stated explicitly so the dev/release does not add a phantom restart step, and
  so a reviewer confirms no publication line crept into the migration.)

### 7. Frontend store impact (`src/store/useStore.ts`)

The optimistic-then-revert pattern does NOT apply — this is a read-model
re-derivation, not a user mutation. The store edits are pure-compute changes to
derived getters.

**REVISED — bridges are now UNCONDITIONAL.** Because option (b) makes the LIVE
`cost_per_unit` uniformly per-each on every row (§0), every consumer that reads a
LIVE `item.costPerUnit` applies `× subUnitSize` **unconditionally** — there is no
`pieces`/`sub_unit_size`-keyed branch and no discriminator. For a row with
`subUnitSize = 1` the bridge is a self-evident no-op; for a population-X (`cost = 0`)
row the product is 0. The original §0 worry ("don't bridge un-migrated rows") is
gone. The ONE exception is the WASTE SNAPSHOT (`waste_log.cost_per_unit`), which is
a FROZEN value spanning the flip boundary and is handled separately below + in §8
R1. Slices touched:

- **`getIngredientLineCost` (2665-2698)** — remove the second sub-unit divide.
  - Short-circuit (2677) `ing.unit === item.unit`: `costPerUnit × ing.quantity`.
    Under per-each this is now correct WITHOUT change when the recipe quantity is
    in the SAME unit the per-each cost is denominated in. CAVEAT (AC line 97-103):
    the short-circuit fires when `ing.unit === item.unit` where `item.unit` is the
    COUNTED/tracking unit, but `costPerUnit` is now per-EACH (smallest unit). If
    counted unit ≠ smallest unit (e.g. item tracked in "case", sub_unit "each"),
    "1 case" would now cost one EACH, not one case — a `sub_unit_size×` UNDERcount.
    The fix: the short-circuit must apply the `× sub_unit_size` bridge too, i.e.
    `costPerUnit × ing.quantity × subUnitSize` so "1 counted unit" still costs
    `cost_old`. This restores parity (per ★) AND makes "1 each of an each-tracked
    item" cost one per-each unit (where `sub_unit_size = 1`, bridge is a no-op).
    The frontend dev must verify both readings against the regression test.
  - Standard-conversion branch (2681-2685): DELETE the
    `qtyInCountedUnit = qtyInSubUnit / subUnitSize` divide. Return
    `costPerUnit × qtyInSubUnit` (the recipe qty already converted to sub-units ×
    the per-each cost). Per (★) this equals the old
    `costPerUnit_old × (qtyInSubUnit / subUnitSize)`, so the line dollar is
    unchanged.
  - Abstract-conversion fallback (2687-2696): `costPerBase = costPerUnit /
    conv.conversionFactor` where `conversionFactor` is sub-units-per-abstract-unit
    (e.g. 1 each = 400g). `costPerUnit` was per-counted-unit; now it's per-each
    (per-gram here). Dividing a per-each cost by `conversionFactor` then `×
    base.quantity` double-counts the sub-unit axis. This branch needs the SAME
    bridge: `costPerBase = (costPerUnit × subUnitSize) / conv.conversionFactor`,
    OR equivalently drop the divide if `conversionFactor` already expresses
    sub-units. The frontend dev must pin this branch with a regression case (a
    representative abstract-unit item) and confirm the dollar is unchanged.
- **`getInventoryValue` (2559-2564)** — `currentStock × costPerUnit` →
  `currentStock × subUnitSize × costPerUnit` (the OQ-5 bridge). `subUnitSize` is on
  the InventoryItem (mapped at db.ts:4207). Stock stays counted.
- **`getWasteThisWeek` (2568-2573)** — `quantity × costPerUnit` over `wasteLog`
  rows. This reads the FROZEN snapshot `w.costPerUnit`, NOT live `item.costPerUnit`.
  **Option (b) does NOT resolve this** — it fixes the LIVE columns' mixed basis, but
  the `waste_log` snapshot freezes whatever basis was live at log time, so it spans
  the flip boundary (a TEMPORAL mixed basis, not a per-row one). `getWasteThisWeek`
  must therefore stay **UNBRIDGED** — do NOT add `× subUnitSize` here. The fix lives
  at the WRITE side (R1, now resolved to option (a)): both the FE
  `WasteLogSection`/`logWasteEntry` path AND the staff `log_waste` RPC must snapshot
  `cost_old` (= per-each `costPerUnit × subUnitSize`) so the column STAYS
  per-counted-unit on both sides of the flip. With that write-side fix,
  `quantity(counted) × snapshot(per-counted-unit)` is correct for every row,
  historical and new, with no read-side bridge. See §8 R1 for the resolved decision
  and the staff-RPC + truncation details.
- **`getPrepRecipeCost` / `getPrepRecipeCostPerUnit` / `getRecipeCost`** — no
  direct edit; they call `getIngredientLineCost`, so they inherit the fix and stay
  dollar-unchanged. Pin with a regression test (AC line 104-107).

Consumer surfaces OUTSIDE the store (FE slice, not store):
- `DashboardSection.tsx:241,792` inv value, `ReconciliationSection.tsx:84,269,353`
  delta cost, `InventoryCatalogMode.tsx:133` `weightedCost` — all are LIVE
  `currentStock/quantity × costPerUnit` reads → add `× subUnitSize` bridge.
- **Additional live-`costPerUnit` consumers NOT in the original enumeration (found
  in the revision sweep — the FE dev MUST bridge or consciously exclude each, or
  they read `sub_unit_size×` low after the flip):**
  - `DashboardSection.tsx:251` waste dollar (`w.quantity × w.costPerUnit`) — this is
    the SNAPSHOT path, same as `getWasteThisWeek`. Leave UNBRIDGED (R1 write-side
    fix keeps the snapshot per-counted-unit). Do NOT bridge.
  - `RestockSection.tsx:71` (`suggested × costPerUnit`), `POsSection.tsx:75`
    (`qty × costPerUnit`), `ReceivingSection.tsx:100` (`orderedQty × costPerUnit`) —
    these cost ORDER quantities in COUNTED units. They are NOT named in the spec's
    AC list, but they read the now-per-each `costPerUnit` and will under-cost by
    `sub_unit_size×`. Add the `× subUnitSize` bridge so their dollar is unchanged.
    Flagged to the FE dev: these are an in-scope consequence of the basis flip
    (every counted-unit × cost site must bridge), not a scope expansion — the spec's
    governing constraint is "every consumer-visible dollar stays unchanged."
  - `EODCountSection.tsx:583` (stock-value total `itemTotal(i) × costPerUnit`) and
    `:1788` (`item.costPerUnit` line cost) — `itemTotal`/the count line are in
    COUNTED units → bridge with `× subUnitSize`. Confirm against the EOD value
    display so the count screen's dollar total is unchanged.
  - `PrepRecipesSection.tsx` / `RecipesSection.tsx:678` recipe roll-ups — these go
    THROUGH `getIngredientLineCost` (or the same conversion), so they inherit the
    store fix and must NOT also get an outer bridge (double-bridge). RecipesSection's
    inline `ing.quantity × item.costPerUnit` at :678 is the short-circuit case — it
    needs the SAME `× subUnitSize` treatment as the `getIngredientLineCost`
    short-circuit (it's a parallel inline copy of that path). Verify it matches the
    store helper's behavior or, better, route it through `getIngredientLineCost`.
- `InventoryCatalogMode` per-each display (399-428): `perEachCost`'s PRIMARY path
  (`casePrice / pieces`) stays correct. Its FALLBACK (`costPerUnit / subUnitSize`)
  now double-divides because `costPerUnit` is ALREADY per-each. Fix: the fallback
  must return `costPerUnit` directly (no `/ subUnitSize`) once the basis is
  per-each. Equivalently `perEachCost` is taught its `costPerUnit` arg is now
  per-each and the fallback becomes identity. The FE dev edits
  `src/utils/perEachCost.ts` fallback + its spec-096 tests.
- Detail / list "Cost / unit" cells (ItemDetailScreen 103/112,
  InventoryDesktopLayout 455/464, InventoryCatalogMode 831, VendorsSection 386):
  display the per-each `costPerUnit` as-is (already self-consistent). The
  `inventoryValue = currentStock × costPerUnit` lines at ItemDetailScreen:96 and
  InventoryDesktopLayout:448 need the `× subUnitSize` bridge.
- Label change (OQ-3): "Cost / unit" / "cost / u" → per-each / smallest-unit
  wording. Exact string is the FE slice's call (e.g. "cost / each" or a per-each
  suffix). Applies to ItemDetailScreen, InventoryDesktopLayout, InventoryCatalogMode,
  IngredientForm (top-level + per-vendor card help text "auto · case price ÷
  units/case" at IngredientForm.tsx:1130 must become "… ÷ (units/case × sub-units)").

Editor (fold-in the uncommitted work, fix the divisor):
- `derivedUnitCost(casePrice, caseQty)` (IngredientForm.tsx:261) gains
  `subUnitSize` and divides by `caseQty × subUnitSize` via `calcUnitCost`. Because
  `calcUnitCost` itself is fixed to per-each (below), `derivedUnitCost` can call
  `calcUnitCost(casePrice, caseQty, subUnitSize)` and drop its own divide. Signature
  becomes `derivedUnitCost(casePrice: string, caseQty: string, subUnitSize: string)`.
- All `derivedUnitCost(...)` call sites get the third arg:
  `handleCasePriceChange` (843), `handleVendorCasePriceChange` (835),
  `handleCaseQtyChange` (850-851), and the load path `fromItem`
  (IngredientFormDrawer.tsx:37,67,73). Each passes `values.subUnitSize` /
  `String(it.subUnitSize || 1)`. A `sub_unit_size` change should ALSO recompute
  cost — add a `handleSubUnitSizeChange` (or fold into the existing handler) so the
  read-only cost stays live when the user edits sub-unit size, mirroring how
  `handleCaseQtyChange` already recomputes on units/case change. (The current
  uncommitted code only recomputes on case-price/units-case — a sub-unit edit would
  leave a stale derived cost.)

### 8. Risks and tradeoffs (explicit)

**R1 — RESOLVED (option (a)): keep the waste snapshot per-counted-unit on both
sides of the flip.** `waste_log.cost_per_unit` is a FROZEN `numeric(10,2)` snapshot
captured at log time (WasteLogSection.tsx:97; staff `log_waste` RPC at
`20260504000002_staff_log_waste_rpc.sql:42,61`). The migration correctly does NOT
touch `waste_log` (historical rows must keep their log-time dollar). **Option (b)
does NOT eliminate this** — option (b) makes the LIVE columns uniformly per-each,
but the snapshot freezes whatever basis was live at WRITE time, so it straddles the
flip boundary regardless of how the live columns are derived. Without a fix:
  - Pre-flip waste rows hold a per-COUNTED-unit snapshot. `quantity(counted) ×
    snapshot` already gives the historical dollar — NO read-side bridge.
  - Post-flip waste rows would hold a per-EACH snapshot (the write reads the
    now-per-each live `costPerUnit`). `quantity(counted) × per-each-snapshot` is
    `sub_unit_size×` TOO LOW.
  Compounding it: `numeric(10,2)` truncates a sub-cent per-each cost to $0.01/$0.00,
  so a per-each snapshot is ALSO lossy.
  **Resolution — option (a), write-side, both paths:** snapshot `cost_old` (the
  per-counted-unit value) so the column STAYS per-counted-unit on both sides of the
  flip; then `getWasteThisWeek` / DashboardSection waste stay UNBRIDGED and every
  era reconciles. Concretely:
  - **FE path** (`logWasteEntry` in db.ts / WasteLogSection): write
    `pickedItem.costPerUnit × pickedItem.subUnitSize` into `cost_per_unit` (the
    per-each cost re-bridged to per-counted-unit), NOT the raw per-each
    `costPerUnit`.
  - **Staff RPC path** (`log_waste`, `20260504000002`): the RPC snapshots
    `v_item.cost_per_unit` server-side. After the flip that column is per-each, so
    the RPC must multiply by the catalog `sub_unit_size` (join
    `inventory_items → catalog_ingredients`) before inserting, mirroring the FE.
    This is a SECOND migration-touch the original design missed — without it, every
    staff-logged waste row post-flip is `sub_unit_size×` low. **The backend dev owns
    this RPC edit** (re-CREATE `log_waste` to bridge the snapshot); it belongs in
    the same spec-104 migration or a sibling, the architect's call — recommend the
    SAME file to keep the basis flip atomic.
  - **Truncation note:** `cost_old` re-bridged is an exact 2-dp value again (it
    equals the original `case_price/case_qty`), so it fits `numeric(10,2)` losslessly
    — option (a) also dodges the truncation that a per-each snapshot would suffer. No
    `waste_log` column widening needed.
  The reconciliation delta (ReconciliationSection:269,353) reads LIVE
  `item.costPerUnit`, so it takes the straightforward unconditional `× subUnitSize`
  bridge (§7) — only the WASTE SNAPSHOT needs the write-side treatment. This is no
  longer a PM-blocking open question; option (a) is the resolved approach and is
  reflected in the §7 `getWasteThisWeek` note and the handoff.

**R2 — Migration ordering / prod-apply (UPDATED for the widening).** The file dates
`20260701000000`, after all spec-102 reorder migrations (`20260630*`). It MUST sort
after them so the `report_reorder_list` `create or replace` lands on top of the
spec-102 body. The two `ALTER TABLE … type numeric(12,6)` widenings are the FIRST
statements inside the transaction (before any UPDATE) so the re-derivation can
write sub-cent values. Prod apply is via Supabase MCP `execute_sql` against project
`ebwnovzzkwhsdxkpyjka` (db push lacks the prod password — MEMORY), THEN `insert
into supabase_migrations.schema_migrations (version) values ('20260701000000')`
with the EXACT repo filename version, or the db-migrations-applied gate hard-fails
on repo-vs-prod drift. Verify post-apply: (1) the re-CREATEd function with a
normalized-md5 check (MEMORY pattern), AND (2) `information_schema.columns` shows
`numeric_precision = 12, numeric_scale = 6` on both `inventory_items.cost_per_unit`
and `item_vendors.cost_per_unit` (the widening is part of the prod schema drift the
gate could otherwise miss — column-type changes are invisible to the migration-list
gate, so this is a manual verification step). Prod apply remains USER-GATED (not
the dev's job).

**R3 — Seed regen.** `supabase/seed.sql` (286 KB, pulled 2026-05-02) carries the
PRE-flip `cost_per_unit` / per-vendor cost / `default_cost`. After the migration
runs against prod, re-pull / regenerate the three columns in seed.sql to the
per-each basis so a fresh local stack + CI start consistent. If seed is NOT
regenerated, local `getIngredientLineCost`/reorder pgTAP fixtures would compute on
the old basis while the migration logic expects the new — the new reorder pgTAP
test (below) would pass locally for the wrong reason. Regen is part of THIS slice,
not a follow-up.

**R4 — `calcUnitCost` single-source proof obligation.** AC pins
`calcUnitCost(p, q, s) === (p > 0 && piecesPerCase(q, s) > 0 ? p / piecesPerCase(q, s) : 0)`.
The dev must implement `calcUnitCost` BY CALLING `piecesPerCase` (not by inlining
`q × s`), so the two can never drift — this is the same single-source contract
spec 096 §Q-A set for the display path. `perEachCost`'s `costPerUnit / subUnitSize`
fallback (perEachCost.ts:74-76) must be revisited in the SAME PR: once
`costPerUnit` is per-each, that fallback double-divides. The dev confirms the
fallback becomes identity (`return costPerUnit`) or the primary path always wins
post-migration. The AC for `calcUnitCost(20, 20, 1) === 1.0` and
`calcUnitCost(50, 1, 500) === 0.1` both hold under `p / (q × s)`.

**R5 — `calcCasePrice` round-trip (out of scope, but watch).** Spec 093 R4 left
`calcCasePrice = unitCost × caseQty × subUnitSize`. With a per-each `unitCost` this
round-trip (`cost → price → cost`) now reads correctly (`perEach × pieces =
casePrice`). Out of scope to audit every caller, but if the FE dev finds a LIVE
`calcCasePrice` caller that feeds back into a stored cost, surface it — do not
silently fix.

**R6 — Performance on the 286 KB seed / catalog rows.** The migration's three
UPDATEs join `inventory_items → catalog_ingredients` (FK-indexed, for
`sub_unit_size` only under option (b)) and touch ≤544 inventory_items / ≤536
item_vendors / ≤143 catalog rows. Trivial — single-digit-ms. The reorder RPC adds
one `coalesce(ci.sub_unit_size,1)` select from an EXISTING join — zero extra scan,
no plan change. No edge-function cold-start impact (no edge function touched). The
ONLY new cost is the two table-rewrite widenings — see R9.

**R7 — Test pins that contradict this spec (must be replaced, not skipped).**
`IngredientForm.test.ts:286-309` (`calcUnitCost (spec 093 Q3a — divide by case_qty
alone)`) and `:318-342` (`derivedUnitCost`) PIN the old basis and call
`× sub_unit_size` "the 12×-class error". These directly contradict spec 104 and
MUST be replaced (not deleted-and-forgotten): the new `calcUnitCost` describe
asserts `calcUnitCost(50,1,500)===0.1`, `calcUnitCost(20,20,1)===1.0`,
`calcUnitCost(20,0,5)===0`, and the single-source identity with `piecesPerCase`;
the new `derivedUnitCost` describe asserts the 3-arg per-each results
(`derivedUnitCost('50','1','500')==='0.1'`). Run the FULL `npx jest` after — a
stale cost test elsewhere (e.g. any recipe-cost snapshot) will catch an
unintended dollar shift (MEMORY: a stale EOD test turned main red). Add: a
`getIngredientLineCost` regression test (representative recipe line, dollar
unchanged across the flip) covering the short-circuit AND abstract-conversion
branches; a pgTAP test pinning reorder `estimated_cost` / `vendor_total_cost` on a
seeded fixture equals the pre-spec figure (mirror
`supabase/tests/report_reorder_list_cases.test.sql`'s fixture + assert the same
dollar after the basis flip — this is the guard for the OQ-1 server change).
**pgTAP tolerance (revision):** assert the reorder dollar with a cent-level epsilon
(`abs(got - expected) < 0.01`), not byte-exact `numeric` equality — the per-each
basis stored at 6 dp reconstructs the old total to ~$0.001, not to the full
`numeric` mantissa (§1, §4). A byte-exact assert would flake on fine-grained items.
Add a pgTAP assertion that the post-migration `cost_new × sub_unit_size`
round-trips to the audit `old_cost` within the same epsilon for a high-`sub_unit_size`
fixture row (the direct (★)-inverse check the owner asked for).

**R8 — `getIngredientLineCost` is the highest-risk single function.** Three
branches, each needing a different reasoning step to preserve (★): short-circuit
(bridge added), standard conversion (divide removed), abstract conversion (bridge
into `costPerBase`). A miss in any branch silently shifts recipe costs by
`sub_unit_size×`. The regression test MUST exercise all three. This is the function
most likely to be implemented wrong; call it out in the dev handoff. (Note:
`RecipesSection.tsx:678` is a SEPARATE inline copy of the short-circuit path — see
§7's consumer audit — and must get the same bridge or be routed through this
helper, or its menu-recipe roll-up drifts from the prep path.)

**R9 — Column widening table rewrite + lock (new, from B1).** `alter table … alter
column … type numeric(12,6)` on the two `(10,2)` columns is a table REWRITE
(Postgres re-scans + re-stores every row for a precision/scale change), taking a
brief `ACCESS EXCLUSIVE` lock on `inventory_items` and `item_vendors`. On these
small tables (≤544 / ≤536 rows) it is sub-second, but it DOES block concurrent
reads/writes on those two tables for the rewrite's duration. Acceptable for a
user-gated prod apply during low traffic; flag it so the owner runs the apply off
peak. The widenings are inside the migration's single transaction, so a failure
rolls back the type change with the data flip — no half-widened state. Reversal
(BACKOUT) restores values first, then re-narrows (R1/§1 BACKOUT note) — the
re-narrow is itself a second rewrite. No new index, no FK change, no view depends
on the column type (the reorder RPC casts to `::numeric` explicitly, so a wider
source type is transparent to it).

**R10 — OQ-2 reframe must propagate to the audit/hand-review consumer (from B2).**
Because option (b) shrinks population 'X' to ONLY `cost_old <= 0` rows, the
"un-derivable" hand-review list is now strictly "rows with no cost yet" — a
genuinely actionable list (unfinished catalog/store rows that need a price), not a
grab-bag of "missing case_price." The `raise notice` X-count and the audit-table
comment should describe population X as `cost_old <= 0`, not `case_price <= 0 OR
pieces <= 1`. Anyone reading the X-rows post-apply should understand them as
"priced at zero," not "couldn't compute." Minor doc-correctness risk if the
migration's inline comments still say the old predicate — reviewers should confirm
the comments match the option-(b) rule.

## Files changed (backend slice — Status stays READY_FOR_BUILD; frontend slice runs next and flips to READY_FOR_REVIEW)

Prod apply is PENDING (user-gated via MCP against `ebwnovzzkwhsdxkpyjka`, then
insert version `20260701000000` into `supabase_migrations.schema_migrations`, then
verify `information_schema.columns` shows `numeric_precision=12, numeric_scale=6`
on both widened columns + normalized-md5 on the two re-CREATEd functions). NOT
applied to prod by this slice.

### migrations
- `supabase/migrations/20260701000000_spec104_per_each_cost_basis.sql` — REVISED
  IN PLACE (single atomic file):
  - **Widen FIRST:** `ALTER TABLE inventory_items.cost_per_unit` +
    `item_vendors.cost_per_unit` → `numeric(12,6)` before any UPDATE (B1).
    `catalog_ingredients.default_cost` left as unconstrained `numeric`.
  - **Option (b) re-derivation:** all three cost columns via
    `cost_new = cost_old / sub_unit_size` (the ★-inverse; predicate `cost_old > 0`
    for population D, `cost_old <= 0` for population X). No `case_price`
    dependency — converts the population-X-by-old-rule rows and eliminates the
    mixed basis (B2). Audit-table-keyed idempotency guard on all three UPDATEs.
  - **`report_reorder_list` re-CREATE:** the two additive hunks (surface
    `coalesce(ci.sub_unit_size,1)`; `× sub_unit_size` UNCONDITIONALLY on both
    `estimated_cost` branches). Comments updated from the old "left-as-is × 1"
    rationale to the option-(b) "unconditional" rationale.
  - **`staff_log_waste` re-CREATE (R1 option a):** snapshot
    `cost_per_unit × sub_unit_size` (= cost_old) so `waste_log.cost_per_unit`
    stays per-counted-unit. **DEVIATION FROM "copy verbatim" — see handoff:** the
    phase-13d body read `inventory_items.name/unit`, which P3 dropped; the
    re-CREATE reads `ci.name/ci.unit` from the catalog join it already adds, so
    the copied body compiles against today's schema (staff_log_waste is
    dormant/service_role-only since spec 061, so the P3 break was latent).
  - **BACKOUT:** restores VALUES from the audit snapshot FIRST (while columns are
    still `numeric(12,6)`), THEN re-narrows to `numeric(10,2)`. Preserves
    `inventory_items_cpu_backup_20260626`.

### src/lib/db.ts
- `mapItem` cost fallback (~4188) — no-stored-cost fallback now per-each:
  `cp / piecesPerCase(caseQty, subUnitSize)` (imports `piecesPerCase` from
  `../utils/perEachCost`); stale spec-093 comment replaced.
- `logWasteEntry` (~671) — write-side R1 fix: looks up the item's catalog
  `sub_unit_size` and persists `entry.costPerUnit × subUnitSize` (= cost_old) so
  the snapshot stays per-counted-unit regardless of caller shape.

### supabase/seed.sql
- Regenerated `catalog_ingredients.default_cost` (92 rows) and
  `inventory_items.cost_per_unit` (368 rows) to the per-each basis (in-place
  value substitution from the migrated local DB; row order / masking / all other
  columns untouched). `item_vendors` is not in the seed (backfilled by migration).

### supabase/tests
- `supabase/tests/report_reorder_list_per_each_cost.test.sql` — NEW. Pins
  reorder `estimated_cost`/`vendor_total_cost` unchanged across the flip (cent
  tolerance) for a case-size + a high-`sub_unit_size` fixture, plus the explicit
  (★)-inverse round-trip. Self-seeds its `item_vendors` links (CI-safe on an
  empty junction). 6 assertions.
- `supabase/tests/public_grants_explicit.test.sql` — added
  `spec104_per_each_cost_audit` (anon + authenticated) to both allowlists and a
  new negative arm (7); plan 10 → 13. (The new audit table's deny-all posture
  tripped this spec-097 lint, same as the spec-093 audit table.)

### Local validation (AC proof — per-store reorder `kpis.total_estimated_cost`)
Pre-flip baseline vs post-flip (fresh reset + per-each seed), same as-of date:

| Store     | Pre-flip     | Post-flip (per-each) | Δ         |
|-----------|--------------|----------------------|-----------|
| Charles   | 15298.02400  | 15298.02377          | −$0.00023 |
| Frederick | 15362.27000  | 15362.26978          | −$0.00022 |
| Reisters  | 15362.27000  | 15362.26978          | −$0.00022 |
| Towson    | 15362.27000  | 15362.26978          | −$0.00022 |

Every store round-trips to the cent (Δ < $0.001; max per-row reconstruction error
$0.000050 on the `numeric(12,6)` columns). The prior attempt's Frederick +$68.54
truncation drift is GONE. `staff_log_waste` verified: high-`sub_unit_size` item
(per-each 0.0245, sub 2000) snapshots `49.00` = cost_old (`matches=t`). Full pgTAP
(58/58) + jest (775/775) + typecheck all green on a pristine reset.

## Files changed (frontend slice — Status: READY_FOR_REVIEW)

### Pure cost helpers
- `src/utils/unitConversion.ts` — `calcUnitCost` reversed to per-EACH
  (`casePrice / piecesPerCase(caseQty, subUnitSize)`), SINGLE-SOURCED through
  `piecesPerCase` (§8 R4). Imports `piecesPerCase` from `./perEachCost`. Explicit
  `caseQty <= 0` guard kept BEFORE the divisor to satisfy the AC-pinned
  `calcUnitCost(20,0,5) === 0` (see "Open issues surfaced" below — the guard AC
  and the single-source-identity AC are mutually inconsistent over the dead
  `caseQty=0` domain; guard wins, identity asserted over the positive domain).
- `src/utils/perEachCost.ts` — the `costPerUnit / subUnitSize` fallback is now
  IDENTITY (`return costPerUnit`), since `costPerUnit` is per-each end-to-end;
  the pre-104 divide would double-divide (§7, §8 R4).

### Store (`src/store/useStore.ts`)
- `getIngredientLineCost` — all THREE branches per §7/§8 R8: short-circuit gets
  `× subUnitSize`; standard-conversion drops the 2nd `/ subUnitSize` divide;
  abstract-conversion bridges `(costPerUnit × subUnitSize) / conversionFactor`.
- `getInventoryValue` — `× subUnitSize` bridge (OQ-5).

### Consumer `× subUnitSize` bridges (LIVE costPerUnit × counted quantity)
- `src/screens/cmd/sections/DashboardSection.tsx` — `totalInvValue` (~243),
  per-store `invValue` (~798). Waste read (~251) LEFT UNBRIDGED (R1) with a guard
  comment.
- `src/screens/cmd/sections/ReconciliationSection.tsx` — inventoryValue (~84),
  by-category `deltaCost` (~270), timeline delta (~354).
- `src/screens/cmd/sections/RestockSection.tsx` — `estCost` (~72).
- `src/screens/cmd/sections/POsSection.tsx` — `lineCost` (~77).
- `src/screens/cmd/sections/ReceivingSection.tsx` — `cost` (~101).
- `src/screens/cmd/sections/EODCountSection.tsx` — `estValue` (~583), variance
  `cost` (~1789).
- `src/screens/cmd/sections/RecipesSection.tsx` — inline short-circuit copy
  `recipeCost` (~678), same `× subUnitSize` as the store short-circuit (§8 R8).
- `src/screens/cmd/sections/InventoryCatalogMode.tsx` — `perEachCost` fallback
  now identity (via perEachCost.ts). **`weightedCost` (~133) intentionally NOT
  bridged** — it is a stock-weighted-average-COST numerator (→ `avgCost` /
  `selAvgCost` / the perEachCost fallback), NOT a stock-value total; bridging it
  collides with the OQ-3 per-each avg-cost display AND the fallback-identity
  instruction (see "Open issues surfaced").
- `src/screens/cmd/ItemDetailScreen.tsx` — `inventoryValue` (~96).
- `src/screens/cmd/InventoryDesktopLayout.tsx` — `inventoryValue` (~448).
- `src/components/cmd/ExportCsvDrawer.tsx` — CSV `value` column (~26). NOT in the
  spec enumeration but a genuine stock-value export that would otherwise drift.

### OQ-3 per-each labels
- `src/screens/cmd/ItemDetailScreen.tsx` / `InventoryDesktopLayout.tsx` — "Cost /
  unit" → `Cost / ${subUnitUnit || 'each'}`, sub "per-each".
- `src/components/cmd/IngredientForm.tsx` — top-level + per-vendor "cost / unit" →
  "cost / each"; help → "auto · case price ÷ (units/case × sub-units)"; "avg cost
  (30d)" → "avg cost / each".
- `src/screens/cmd/sections/WasteLogSection.tsx` — picker cost cell labeled with
  `subUnitUnit || 'each'` (~300).
- `src/i18n/{en,es,zh-CN}.json` — `avgCostPerUnit` → per-each wording.

### Editor fold-in + divisor fix
- `src/components/cmd/IngredientForm.tsx` — `derivedUnitCost` gains a 3rd
  `subUnitSize` arg and forwards all three to `calcUnitCost` (drops its own
  divide). `handleCasePriceChange` / `handleVendorCasePriceChange` /
  `handleCaseQtyChange` thread `values.subUnitSize`. NEW `handleSubUnitSizeChange`
  recomputes headline + all vendor costs on sub-unit edits; wired to the
  sub-unit input. Read-only/derived UX preserved.
- `src/components/cmd/IngredientFormDrawer.tsx` — `fromItem` load path threads
  `String(it.subUnitSize || 1)` into all three `derivedUnitCost` calls.

### Tests
- `src/components/cmd/IngredientForm.test.ts` — REPLACED the spec-093
  `calcUnitCost` describe + the `derivedUnitCost` describe with per-each
  equivalents (`calcUnitCost(50,1,500)===0.1`, single-source identity over the
  positive domain, `derivedUnitCost('50','1','500')==='0.1'`, deep-sub-cent, the
  guard cases). Imports `piecesPerCase`.
- `src/store/useStore.test.ts` — NEW `getIngredientLineCost` per-each regression
  describe: seeds the store with per-each costs and pins the line dollar equals
  the hand-computed PRE-flip dollar across ALL THREE branches (+ a synthetic
  abstract sub>1 case, + the no-item-resolved 0 case).
- `src/utils/perEachCost.test.ts` — updated the 3 fallback tests to the identity
  fallback (§8 R4).
- `src/components/cmd/IngredientForm.spec093.test.tsx` — narrowed an over-broad
  `queryByText(/×/)` catch-all (it banned the "×" glyph form-wide) to the actual
  old case-size "× … per order" arithmetic sentence, so the spec-104-mandated
  "units/case × sub-units" help wording doesn't false-positive it.

### Frontend verification (browser tooling unavailable — see handoff caveat)
The `preview_*` / browser-MCP tools are not in this agent's toolset, so no live
click-through or screenshot was captured. Instead:
- **Compile/graph:** the web bundle (`App.bundle?platform=web`) builds clean
  (14.8 MB real JS, zero `UnableToResolve`/`TransformError`); the per-each labels
  + `case price ÷ (units/case × sub-units)` help string ship in the bundle.
- **Feature math vs the LIVE per-each local DB (after `db reset`):**
  - (a) EDITOR — 2oz Cup w/ Lid: `derivedUnitCost` = 33 ÷ (1 × 2000) = `0.0165`,
    exactly the stored `cost_per_unit` (`matches=t`); shows `$0.02` at 2dp.
  - (b) STOCK VALUE — Mac n Cheese: bridged `current_stock × per_each × sub` =
    `$64.2460` == pre-flip `current_stock × case_price/case_qty` = `$64.2460`.
  - (c) RECIPE COST — House Special Seasoning Mix / Lemon Pepper (5 lbs,
    standard-conversion branch): new `costPerUnit × qtyInSubUnit` = `16.97857` ==
    old `(case_price/case_qty) × (qty / sub_unit_size)` = `16.97857`.
- Full `npx jest` 783/783 green; base `tsc --noEmit` + `typecheck:test` green.

### Open issues surfaced (spec-internal inconsistencies — resolved in-code, flagged for review)
1. **`calcUnitCost` guard vs single-source identity.** AC line 81 pins
   `calcUnitCost(20,0,5) === 0` (guard); AC line 83's identity
   `p / piecesPerCase(q,s)` yields `20/5 = 4` for the same input (piecesPerCase
   floors `caseQty=0` to 1). Contradictory over `caseQty=0`. Implemented the
   explicit guard (owner-pinned concrete value + matches the preserved spec-093
   guard); the identity holds for every positive `caseQty` (the live domain —
   `case_qty` defaults to 1). Dead edge case; documented in `unitConversion.ts`.
2. **`InventoryCatalogMode.weightedCost` bridge.** §7's consumer list names it as
   a `× subUnitSize` bridge target, but §7 ALSO requires the `perEachCost`
   fallback (fed by `avgCost = weightedCost/totalStock`) be identity-over-per-each
   AND requires the "Avg cost / unit" display be per-each (OQ-3). Those three are
   mutually exclusive: bridging `weightedCost` makes `avgCost` per-counted-unit,
   breaking both. Left `weightedCost` UNBRIDGED (it's a cost-average numerator,
   not a stock value); documented at the call site. Reviewers: confirm the
   InventoryCatalogMode "Avg cost / each" StatCard + per-each row segment read
   correctly against a sub>1 item.
3. **Minor display mismatch (POs/Receiving).** The per-unit cost cell shown next
   to the bridged line total in POsSection (~290) / ReceivingSection is the raw
   per-each figure, so `unitCost × qty ≠ lineCost` visually for sub>1 items. Not
   a dollar-total drift (totals bridged correctly); reconciling the per-unit
   display to per-counted-unit is out of the spec's scope. Flagged as a possible
   follow-up.

## Handoff
next_agent: backend-developer, frontend-developer
prompt: REVISE the existing implementation against the updated ## Backend design
  (two blockers resolved — see the REVISION banner at the top of the design).
  Backend owns the SINGLE revised migration
  `20260701000000_spec104_per_each_cost_basis.sql` (REVISE in place, do not add a
  second file): (1) WIDEN `inventory_items.cost_per_unit` + `item_vendors.cost_per_unit`
  to `numeric(12,6)` FIRST (B1, §1); (2) re-derive all three columns via
  `cost_old / sub_unit_size` — option (b), NOT from `case_price` (§0/§1) — which
  eliminates the mixed basis (B2) and converts the population-X rows; audit-table
  idempotency guard; BACKOUT restores VALUES then re-narrows (§1); (3) re-CREATE
  `report_reorder_list` with the two additive hunks already in the file (§4 — these
  were correct, only the rationale changed: the `× sub_unit_size` is now
  unconditional); (4) re-CREATE the staff `log_waste` RPC to snapshot
  `cost_per_unit × sub_unit_size` (R1 option (a), §3.2). Plus the `db.ts` mapItem
  fallback (§5.1), `logWasteEntry` write-side fix (§5.3), seed.sql regen (§8 R3),
  the reorder pgTAP test WITH cent tolerance + the (★)-inverse round-trip check
  (§8 R7). Frontend owns `calcUnitCost` + `perEachCost` fallback (§8 R4),
  `getIngredientLineCost` all three branches (§7/§8 R8), the now-UNCONDITIONAL
  consumer `× sub_unit_size` bridges INCLUDING the revision-sweep additions
  (Restock/POs/Receiving/EODCount/RecipesSection:678 — §7), the editor fold-in +
  divisor fix + new `subUnitSize` arg (§7), the OQ-3 label change, and the replaced
  `IngredientForm.test.ts` cost describes + `getIngredientLineCost` regression test
  (§8 R7). R1 is RESOLVED (option (a)) — no PM ratification needed; implement the
  write-side waste snapshot fix directly. Prod apply stays USER-GATED via MCP (not
  the dev's job). After implementation, set Status: READY_FOR_REVIEW and list files
  changed under ## Files changed.
payload_paths:
  - specs/104-per-each-cost-basis-rework.md
