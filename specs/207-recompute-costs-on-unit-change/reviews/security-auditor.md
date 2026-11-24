## Security audit for spec 207

Scope: `supabase/migrations/20261123130000_recompute_costs_on_pack_size_change.sql`, `supabase/tests/cost_rederive_on_pack_size.test.sql`, `supabase/tests/list_cost_drift.test.sql`, the AC-12 fixture diffs (mainly `supabase/tests/item_vendors_rls.test.sql`), and `specs/207-recompute-costs-on-unit-change/prod-cost-repair-undo-2026-11-23.json`. I left out the unrelated uncommitted changes (CLAUDE.md, app.json, .claude/agents/*, spec 181 files), as asked.

Facts checked against the local stack with read-only `SELECT`s only (no writes, no begin/rollback probes):
- `relforcerowsecurity = false` on all three tables, and `postgres` owns them.
- `catalog_ingredients_rederive_item_costs` is the only `prosecdef` object.
- Every new function has `proconfig = search_path=""`.
- EXECUTE: the three trigger functions are false for anon, authenticated and PUBLIC. The two helpers are true for anon and authenticated, false for PUBLIC. `list_cost_drift` is false for anon and PUBLIC, true for authenticated and service_role. `receive_purchase_order` is still false for anon and true for authenticated, so its ACL survived the `create or replace`.
- The trigger definitions match D-3 / D-4.
- Column types: `inventory_items.case_price` is unbounded `numeric`, `item_vendors.case_price` is `numeric(10,2)`, both `cost_per_unit` are `numeric(12,6)`.
- Assigning a value of 10^6 or more to `numeric(12,6)` raises 22003 (checked with a pure `SELECT` cast).

### Critical (BLOCKS merge)
- None.

### High (must fix before deploy)
- None.

### Medium
- `supabase/migrations/20261123130000_recompute_costs_on_pack_size_change.sql:240-251` and `:256-270`: the R1 DEFINER fan-out crosses the brand boundary, so another brand can block this brand's pack-size edits.
  - **What it does.** R1 rewrites every `inventory_items` row with `catalog_id = new.id`, whatever brand its store belongs to. The test pins this on purpose (`supabase/tests/cost_rederive_on_pack_size.test.sql:359-370`, AC-6 "row at brand-2 store Z is re-derived too").
  - **Why another brand can reach it.** The insert policy checks only store visibility (`supabase/migrations/20260504173035_per_store_rls_hardening.sql:51-53`, `with check (auth_can_see_store(store_id))`; this is the FU-3 gap). So any store member of brand 2, including staff, can insert a row at their own store pointing at a brand-1 catalog id. They can also make it unpriced (`case_price = 0`) with `cost_per_unit = 999999.999999`; R3 does not fire for unpriced rows, so that cost is kept.
  - **Effect.** When a brand-1 admin later lowers that item's pieces (say 35 → 1), R1's OQ-2 scaling `round(cost × old/new, 6)` overflows `numeric(12,6)` and raises 22003. That aborts the admin's catalog PATCH. A priced plant gives the same result whenever new pieces drop below `case_price / 999999.999999`.
  - **Why recovery is hard.** The brand-1 admin cannot see the blocking row (RLS), and the toast only says "numeric field overflow". Recovery needs a super_admin or psql.
  - **Secondary effect.** After a brand-1 pack change, the planted row's `cost_per_unit` tells the brand-2 member the foreign catalog's `case_qty × sub_unit_size`. This is the probe D-3 avoided by making R3 INVOKER; R1 re-opens it. It adds little: the service-role join in `supabase/functions/pwa-catalog/index.ts:115` already returns `case_qty` / `sub_unit_size` for any catalog row a store's `inventory_items` point at.
  - **Preconditions.** The attacker must be an authenticated store member of another brand and must know a foreign `catalog_ingredients.id` (UUIDs, not guessable; known sources are pwa-catalog payloads, `recipe_ingredients.catalog_id` and shared exports). That is why this is Medium and not High.
  - **Same-brand variant.** A same-brand staff member can plant the same row at their own store. Their admin can see that row and fix it, so it only adds a confusing error (Low on its own).
  - **Fix (cheap, recommended before or alongside deploy).** Limit both R1 UPDATEs to the catalog's brand, for example `and exists (select 1 from public.stores s where s.id = ii.store_id and s.brand_id = new.brand_id)` in (a) and (b). R1's DEFINER write would then never touch a row the actor couldn't write directly, since a privileged brand admin sees every store of their brand. Rewrite AC-6 to assert the brand-2 row is not touched, and keep the "every brand-1 store" half. FU-3, a store-brand = catalog-brand check on insert, remains the root-cause fix and would close both this and the pwa-catalog exposure.
  - **If the owner keeps cross-brand reach.** Document the overflow failure mode in D-12 and in the `db.updateInventoryItem` toast path, so a 22003 on a pack-size edit is traced to an invisible row instead of the item being edited.

### Low
- None separate from the same-brand variant folded into the Medium finding.

### Verified, no finding
- **receive_purchase_order kept every prior guard.**
  - Compared against `20260707000000_staff_receiving_price_gate.sql:114-393`, the only difference is line 519, the `per_each_cost` call. No later migration re-creates the function.
  - Still present: the auth gate (`auth_can_see_store`, 42501), idempotency replay before any cost write, the `pit.po_id = p_po_id` cross-PO guard, the store pin on both inventory writes, and the spec 113 `auth_is_privileged()` price gate with the pinned string `'forbidden: price change requires admin'`, before the `< 0` check and any cost write.
  - Also still present: the negative-price abort (P0001), `auth.uid()` audit attribution, and SECURITY INVOKER with `search_path = public` (unchanged).
  - The ACL was kept (confirmed in the DB).
- **search_path pinning.** Every new function uses `search_path = ''`. Every relation and function reference in the DEFINER R1 body is schema-qualified (`public.pieces_per_case`, `public.per_each_cost`, `public.inventory_items`, `public.item_vendors`). `now()`, `round` and operators resolve from pg_catalog, which is always searched first. Nothing can be hijacked.
- **Grants and the spec 097 explicit-grant convention.**
  - The trigger functions revoke from public, anon and authenticated, and the DB confirms it.
  - The helpers grant to anon on purpose. They are pure arithmetic with no data access, and the grant keeps RLS errors winning on an anon INSERT.
  - `list_cost_drift` revokes from public and anon. That overrides the default-privilege grant, and the DB confirms it.
  - service_role keeps default EXECUTE on the trigger functions. That is harmless: Postgres refuses to call a `returns trigger` function directly.
- **R1 entry point.** UPDATE on `catalog_ingredients` is gated only by `privileged_update_catalog_ingredients` (`auth_is_privileged() and auth_can_see_brand(brand_id)`, `20260509000000_multi_brand_schema_rls.sql:458-467`). No other permissive UPDATE policy exists on the table.
  - No SECURITY DEFINER RPC writes `case_qty` / `sub_unit_size`; the only writers were the one-shot spec 093 and spec 104 backfills.
  - No edge function writes `catalog_ingredients`.
  - The non-privileged refusal is pinned in `cost_rederive_on_pack_size.test.sql:786-801`.
  - R1 writes only `cost_per_unit` (plus `item_vendors.updated_at`). It never sets `id` / `store_id` (spec 179) and never references `po_items`, `waste_log` or POS rows (R5). The other triggers it sets off do nothing harmful; the only DEFINER ones are the tombstone triggers, which fire on INSERT / DELETE, not UPDATE.
- **R3 INVOKER.** The catalog and item lookups run under the caller's RLS, so a cross-brand catalog row reads as "not found" (pieces 1) and RETURNING cannot be used as an oracle. This is pinned at `cost_rederive_on_pack_size.test.sql:733-762`.
  - R3 never raises, so RLS still wins on INSERT (`:718-730`).
  - The column-limited `UPDATE OF` keeps it off the staff EOD and stock paths.
  - R3 only rewrites `NEW.cost_per_unit` on a row the caller is already allowed to write, so it grants no new privilege.
  - The DEFINER callers in whose context R3 runs as `postgres` (`apply_item_scalars_to_brand`, `apply_item_vendors_to_brand`, `stock_store_from_store`) all check the catalog / store brand before writing.
- **list_cost_drift.**
  - Anon has no EXECUTE.
  - A non-privileged authenticated caller gets 42501 `'privileged only'`, and the error text leaks nothing.
  - Store scoping comes through the spec 205 read policies because the function is INVOKER. Brand-1 admins see no brand-2 rows; super_admin and postgres see all (`list_cost_drift.test.sql` (12)-(15)).
  - It is STABLE, so it cannot write.
  - The `current_user in ('anon','authenticated')` clause admits service_role and postgres only, which are already trusted, RLS-bypassing roles. It is safe while no DEFINER wrapper calls this function. Any future wrapper must re-check `auth_is_privileged()`.
- **RLS once-per-query rule (CLAUDE.md).** No policy is added or changed. R3 and `list_cost_drift` read through the existing spec 205 InitPlan-form SELECT policies. Neither the spec 053 lint nor the spec 205 lint is affected.
- **Fixture changes do not weaken RLS probes.** In `supabase/tests/item_vendors_rls.test.sql:112-119`, the link changes to `case_price = 0`, which keeps the "non-member `set cost_per_unit = 1` did not land" probe meaningful. A priced link would have made the probe vacuous, because R3 would rewrite the cost anyway. The change is correct, not a weakening.
- **Undo JSON** (`specs/207-recompute-costs-on-unit-change/prod-cost-repair-undo-2026-11-23.json`). It holds row ids, item names, store names and prices, plus the project ref (already public in the client bundle URL). There are no secrets, tokens or personal data in it.
- **Edge functions, secrets, client.** None touched. No `EXPO_PUBLIC_*` change, no `config.toml` change, no `useRole()` use.

### Dependencies
No package.json changes, so I did not run `npm audit`.

## Delta re-review (2026-11-24, release-proposal R-2)

Scope: the R1 fix in `supabase/migrations/20261123130000_recompute_costs_on_pack_size_change.sql` (`catalog_ingredients_rederive_item_costs`), the added NOTE comment in `receive_purchase_order`, and the flipped AC-6 test plus the new C11 test in `supabase/tests/cost_rederive_on_pack_size.test.sql`.

**The Medium is closed.**
- **Both UPDATEs are now limited to the catalog's brand.** UPDATE (a) on `inventory_items` and UPDATE (b) on `item_vendors`, which reaches its rows through `inventory_items ii`, both carry `exists (select 1 from public.stores s where s.id = ii.store_id and s.brand_id = new.brand_id)`. A row at another brand's store that points at this catalog is no longer read or written by the security-definer function. That closes the blocking attack (22003 on a planted row), the cross-brand write, and the pieces-count leak through that row.
- **The check fails closed.** `stores.brand_id` and `catalog_ingredients.brand_id` are both `NOT NULL` (checked on the local DB), so no NULL comparison can widen the filter. The subquery runs as the definer, so RLS cannot hide a same-brand store from it, and every store the editing admin is entitled to is still reached.
- **The tests pin the fix.**
  - AC-6 (`cost_rederive_on_pack_size.test.sql:370-386`) now asserts that the brand-2 store Z item and its link keep 33.95 and were not written.
  - C11 (fixture at `:160-164`, test at `:802-827`) plants a brand-2 unpriced row with cost 999999.999999 on a brand-1 catalog row. The brand-1 admin's 35 → 1 decrease still succeeds (`lives_ok`), the brand-1 row is re-derived, and the planted row is untouched. Without the scope this test would fail with 22003, so it is not vacuous.
- **The local DB has the new body:** `prosrc` contains `s.brand_id = new.brand_id`.

**Nothing new introduced.**
- **`receive_purchase_order`:** re-diffed against `20260707000000:114-393`. The only differences are the `per_each_cost` line and one added comment line (`-- NOTE (spec 207): superseded; per_each_cost guards <= 0 and rounds.`, migration line 517). No logic change, and every guard listed in "Verified, no finding" above is still intact.
- **Function attributes and grants:** R1 is still SECURITY DEFINER with `search_path = ''`, and the new subquery uses the schema-qualified `public.stores`. The grant and revoke block is unchanged.
- **Same-brand variant:** a staff member's planted row at their own brand's store still feeds the scaling. Their admin can see and fix that row, and staff can already write arbitrary costs there, so this was not a finding before and isn't now.

Updated totals: 0 Critical, 0 High, 0 Medium, 0 Low.

## Handoff
next_agent: NONE
prompt: Security audit complete (delta re-review 2026-11-24: the Medium is closed). 0 Critical, 0 High, 0 Medium, 0 Low.
payload_paths:
  - specs/207-recompute-costs-on-unit-change/reviews/security-auditor.md
