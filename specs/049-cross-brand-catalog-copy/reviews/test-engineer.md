## Test report for spec 049 (re-review)

Re-review after FIXES_NEEDED: 5 items closed (2 prior Criticals + 3 Should-fixes).

### Acceptance criteria status

#### Backend — RPC contract

- AC-B1: New SECURITY DEFINER RPC accepts `(p_source_brand_id uuid, p_target_brand_id uuid, p_table text, p_source_ids uuid[])` where `p_table` is `'catalog_ingredients'` or `'vendors'`; any other value raises a structured error. → PASS — `supabase/migrations/20260518000000_spec049_cross_brand_copy.sql` defines the function with the exact signature; `p_table not in ('catalog_ingredients', 'vendors')` raises `'invalid table: %'`. Covered by pgTAP arm (8).

- AC-B2: RPC inserts selected rows into target brand using `ON CONFLICT (brand_id, lower(name)) DO NOTHING`. → PASS — `catalog_ingredients` branch uses the existing per-brand unique index; `vendors` branch is backed by the new `vendors_brand_name_lower_unique` index created in the same migration. Skip semantics confirmed by pgTAP arms (6a)/(6b).

- AC-B3: RPC returns `{copied: int, skipped: int, skipped_names: text[]}` bounded to first 20 skipped names. → PASS — composite type `public.copy_catalog_result` with the correct fields; `skipped_names` array is computed with `LIMIT 20` in both dispatch branches.

- AC-B4: RPC rejects callers who fail `auth_is_super_admin()`. Admin and master MUST be rejected. → PASS — prior Critical #1 is now CLOSED. pgTAP arm (1a) exercises `profiles.role='master'` (id=33…) with a mismatching JWT; arm (1b) exercises a promoted `profiles.role='admin'` fixture (id=22…); arm (2) exercises `profiles.role='master'` with a matching JWT. All three arms assert `throws_ok(..., 'super_admin only', ...)`. A user with `profiles.role='admin'` is now independently verified at the DB layer. `supabase/tests/cross_brand_copy.test.sql` lines 43-54, 132-160.

- AC-B5: RPC rejects calls where the super-admin cannot see either brand via `auth_can_see_brand`. → NOT TESTED — the defense-in-depth brand-visibility rejection paths remain unexercised by any pgTAP arm. The guard code exists in the migration; `auth_is_super_admin()` today implies `auth_can_see_brand()` so the practical risk is low. No change from prior review. This is explicitly absent from the spec's §M plan, so it was never a BLOCK finding — flagged again for completeness.

- AC-B6: On success, exactly ONE `audit_log` row in the target brand per RPC call with the expected shape. No audit row in source brand. → PASS — pgTAP arm (9a) asserts `count = 4` (exactly four rows, one per successful call from arms 4, 5, 6a, 6b — tightened from `>= 3` to `= 4`). Arms (9b) and (9c) verify `item_ref='catalog_ingredients'` and `value::jsonb ->> 'source_brand_id'` shape. Arm (9d) asserts zero audit rows pointing at the source brand. `supabase/tests/cross_brand_copy.test.sql` lines 393-455.

- AC-B7: RPC executes inserts and audit row in a single transaction; partial failure rolls back both. → NOT TESTED — no dedicated pgTAP arm injects a mid-copy failure. Transactional behavior is inherent to plpgsql; the entire pgTAP file runs in `BEGIN/ROLLBACK`. No change from prior review; accepted as implicit given language semantics.

#### Frontend — Cmd UI affordances

- AC-F1: Inventory > Ingredients section gains (a) per-row overflow "Copy to brand…" and (b) multi-select checkbox + top-bar "Copy N items to brand…". → PASS (automated positive-control) — jest test `InventoryCatalogMode.test.tsx` arm "DOES render the per-row checkbox and per-row COPY pill" (super-admin=true) and arm "DOES render the top-bar bulk pill once the user picks a row" confirm the affordances render when `useIsSuperAdmin=true`. Browser verification was not performed by the implementer but the positive-control arms provide automated assurance. `src/screens/cmd/sections/__tests__/InventoryCatalogMode.test.tsx`.

- AC-F2: Inventory > Vendors section gains the same two affordances. → PASS (automated positive-control) — `VendorsSection.test.tsx` mirrors the same 2 positive-control arms confirming per-row checkbox, COPY pill, and top-bar bulk pill appear when `useIsSuperAdmin=true`. `src/screens/cmd/sections/__tests__/VendorsSection.test.tsx`.

- AC-F3: Both affordances visible ONLY to `super_admin`; admin and master callers see neither. Gate uses existing role hook, NOT hardcoded literal. → PASS — prior Critical #2 is now CLOSED. jest arms (negative gates, `useIsSuperAdmin=false`) in both `InventoryCatalogMode.test.tsx` and `VendorsSection.test.tsx` assert: `queryByLabelText('dialog.copyToBrand.selectRowAria')` returns null, `queryByText('COPY')` returns null, `queryByLabelText('dialog.copyToBrand.rowActionLabel')` returns null, and the bulk pill text pattern is absent. Gate is via `useIsSuperAdmin()` from `src/hooks/useRole.ts`, not a hardcoded literal.

- AC-F4: Brand picker lists only brands the caller can see via `auth_can_see_brand`, excluding the current source brand. → PARTIAL PASS — `CopyToBrandDialog.test.tsx` arm (render) confirms `Source Brand` (same id='src') and `Deleted` (soft-deleted) are filtered from the picker chips; `auth_can_see_brand` server-side filtering is not exercised in jest (mock store). No change from prior review.

- AC-F5: Picker dialog shows "Existing items in the target brand will be skipped." → PASS — jest arm (render) in `CopyToBrandDialog.test.tsx` asserts `dialog.copyToBrand.skipNotice` is present. `en.json` renders `"Existing items in the target brand will be skipped."` for that key.

- AC-F6: On RPC completion, toast renders "N copied, M skipped"; on failure, error toast fires. → PASS — `CopyToBrandDialog.test.tsx` arms (success path) and (error path) verify toast type and text keys. Note: implementation uses `Toast.show` directly on error (matching `BrandFormDrawer.tsx` pattern and architect's §I rationale) rather than `notifyBackendError`; deviation is documented and justified.

- AC-F7: No new sidebar entry. → PASS — no changes to `CmdNavigator.tsx`; no new sidebar section.

#### Negative tests

- AC-N1: UI-layer gate — admin/master do NOT see the affordances. → PASS — prior Critical #2 is now CLOSED. jest negative-gate arms for both `InventoryCatalogMode` (`useIsSuperAdmin=false`) and `VendorsSection` (`useIsSuperAdmin=false`) assert all three affordances (checkbox, per-row COPY pill, top-bar bulk pill) are absent from the render tree. 4 arms total across the two files: 2 negative-gate + 2 positive-control per section.

- AC-N2: RPC-layer gate — admin/master calling the RPC directly receive permission denied, no rows inserted, no audit row. → PASS — pgTAP arms (1a), (1b), (2) confirm rejection with message `'super_admin only'`. SQLSTATE is P0001 (plain `raise exception`), not `42501`; architect documented this deviation from the AC text in §K item 8 / §L as consistent with existing `copy_brand_catalog` precedent. No rows inserted (gates trip before any INSERT). No audit rows for rejected calls (confirmed by arm 9a counting exactly 4 rows from the 4 successful arms only).

- AC-N3: Calling with `p_table = 'recipes'` raises structured error and writes no rows. → PASS — pgTAP arm (8) asserts `throws_ok(..., 'invalid table: recipes', ...)`.

- AC-N4: Calling with `p_source_brand_id = p_target_brand_id` is rejected without writing rows. → PASS — pgTAP arm (7) asserts `throws_ok(..., 'source and target brands must differ', ...)`.

#### Tests / infra

- AC-T1: New migration at correct path. → PASS — `supabase/migrations/20260518000000_spec049_cross_brand_copy.sql` exists and applies cleanly.

- AC-T2: New pgTAP file covers the required arms (a) through (f). → PASS — bumped to `plan(14)` with the split 1a/1b admin-profile rejection arm. All 14 arms pass. Prior Critical #1 regarding missing admin-profile fixture is resolved.

- AC-T3: All existing pgTAP tests continue to pass. → PASS — 29/29 pgTAP files pass. No regressions.

- AC-T4: No `app.json` changes; slug stays `towson-inventory`. → PASS — confirmed, slug unchanged.

- AC-T5: No realtime publication membership changes. → PASS — migration contains no `ALTER PUBLICATION` statements.

- AC-T6: Client calls the new RPC via `supabase.rpc(...)` through `src/lib/db.ts`. No edge function added. → PASS — `copyCatalogRows()` in `src/lib/db.ts` calls `supabase.rpc('copy_catalog_rows', {...})`. No new files under `supabase/functions/`.

---

### Test run

#### pgTAP — `cross_brand_copy.test.sql` (targeted)

```
bash scripts/test-db.sh supabase/tests/cross_brand_copy.test.sql

== supabase/tests/cross_brand_copy.test.sql ==
  PASS supabase/tests/cross_brand_copy.test.sql (14 assertion(s) passed)

✓ 1/1 DB test file(s) passed
```

14/14 arms pass (was 13 in prior review). The split arm 1a/1b is confirmed green.

#### pgTAP — full suite (`npm run test:db`)

```
✓ 29/29 DB test file(s) passed
```

All existing suites pass. No regressions.

#### jest — targeted (new section tests)

```
npm test -- --ci --testPathPattern="InventoryCatalogMode|VendorsSection"

PASS component src/screens/cmd/sections/__tests__/InventoryCatalogMode.test.tsx
PASS component src/screens/cmd/sections/__tests__/VendorsSection.test.tsx

Tests: 8 passed, 8 total
```

4 arms per section (2 negative-gate + 2 positive-control) all pass.

#### jest — full suite (`npm test -- --ci`)

```
Tests: 182 passed, 182 total   (was 174 after backend slice; +8 from the two new section tests)
```

Count matches the developer's claim.

#### i18n catalog parity

```
npm test -- --ci --testPathPattern="i18n"

PASS unit src/i18n/i18n.test.ts
PASS unit src/i18n/localizedName.test.ts

Tests: 38 passed, 38 total
```

`selectAllAria` key is absent from all three catalogs (en, es, zh-CN). `selectRowAria`, `rowActionLabel`, `bulkPillIngredients`, `bulkPillVendors` are present in all three and in sync. Parity test passes.

#### Typecheck

```
npm run typecheck
(clean — no errors)
```

---

### Prior Critical findings — resolution status

**Critical #1 (admin-profile rejection at DB layer untested):** CLOSED. pgTAP arm (1b) promotes `id=22222222-…` from `profiles.role='user'` to `profiles.role='admin'` within the transaction, then exercises `copy_catalog_rows` as that caller. `auth_is_super_admin()` reads `profiles.role`, finds `'admin'`, returns FALSE, and `throws_ok` asserts `'super_admin only'`. A user with `profiles.role='admin'` is now independently verified to be rejected at the DB layer, distinct from the `profiles.role='master'` arms (1a) and (2).

**Critical #2 (UI negative-gate untested):** CLOSED. `src/screens/cmd/sections/__tests__/InventoryCatalogMode.test.tsx` and `src/screens/cmd/sections/__tests__/VendorsSection.test.tsx` each provide 2 negative-gate jest arms (`useIsSuperAdmin=false`) asserting the checkbox, per-row COPY pill, and top-bar bulk pill are all absent. 4 negative-gate arms total across the two sections.

### Remaining non-critical observations (unchanged from prior review)

1. **AC-B5 (`auth_can_see_brand` rejection paths):** Not covered by any pgTAP arm. Defense-in-depth guard only; not in the spec's §M plan. Low practical risk since `auth_is_super_admin()` today implies `auth_can_see_brand()`. Accepted.

2. **AC-B7 (transactional rollback under failure):** No dedicated arm. Accepted as implicit from plpgsql semantics and the `BEGIN/ROLLBACK` harness.

3. **SQLSTATE P0001 vs AC's `42501`:** Architect documented the deviation (§K item 8 / §L). Consistent with `copy_brand_catalog` precedent. Not a block.

4. **`notifyBackendError` vs direct `Toast.show` on error path:** Implementation matches `BrandFormDrawer.tsx` and architect §I rationale. Observable behavior (error toast fires) is correct. Not a block.

5. **Browser exercise not performed:** AC-F1, AC-F2, AC-F4, and the brand picker's `auth_can_see_brand` server-side filtering remain unexercised by a live browser. The automated jest positive-control arms cover the render-tree gating. Manual walkthrough as described in the implementer's "Browser verification — NOT performed" checklist is still recommended before production deploy but is not a BLOCK for SHIP_READY given the positive-control jest coverage now in place.
