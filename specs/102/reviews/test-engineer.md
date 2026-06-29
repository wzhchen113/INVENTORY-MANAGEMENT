## Test report for spec 102 — Multi-vendor ingredients (shared on-hand, per-vendor cost)

### Test run

**jest** — `npx jest --no-coverage`
```
Test Suites: 67 passed, 67 total
Tests:       721 passed, 721 total   (was 694/66 before spec 102; +27 tests, +1 suite)
```
Matches developer's claimed 721/721. There is one pre-existing console.error warning in `EODCount.test.tsx` about a React state update not wrapped in `act(...)` (at `EODCount.tsx:429, setPendingFocusId`). This is a test-environment-only noise warning from a focus-restore timer; it does not fail any test, the test was PASS before spec 102, and it is pre-existing.

**tsc** — `npx tsc --noEmit` — clean (no output).  
**typecheck:test** — `npm run typecheck:test` — clean (no output).

**pgTAP** — `bash scripts/test-db.sh` — run TWICE:
- Under the SEEDED state (564 `item_vendors` links from the backfill + seed): **51/51 PASS**.
- Under the CI-FRESH state (`truncate public.item_vendors` to simulate `supabase db reset` where the in-migration backfill sees 0 rows): **51/51 PASS**.

This directly verifies the local-green/CI-red asymmetry concern raised in the task. The six updated reorder pgTAP files each insert their own `item_vendors` links inside the transaction, so they are green under both states. The permissive-policy lint (`supabase/tests/permissive_policy_lint.test.sql`) passes green — no new trivially-wide permissive policy landed.

The 564-link seed was restored after the CI-fresh run (backfill re-run: `INSERT 0 564`, confirms idempotency).

---

### Acceptance criteria status

**AC-A — Data model & migration (idempotency + count/cost preservation)**

- AC-A.1 Many-to-many `item_vendors` table with per-(item, vendor) `cost_per_unit` + `case_price` — PASS. Migration `20260630000000_item_vendors.sql` implements the table with composite unique `(item_id, vendor_id)`, two lookup indexes, and the SD-1 partial-unique index for `is_primary`.
- AC-A.2 Backfill: vendor-bearing items produce exactly one link row with current cost, idempotent via `ON CONFLICT (item_id, vendor_id) DO NOTHING` — PASS. Verified: 564 rows backfilled, re-run = `INSERT 0 0`, 0 cost mismatches (developer's local verification); the idempotent pattern is confirmed by code inspection.
- AC-A.3 Items with `vendor_id IS NULL` produce zero link rows — PASS by code inspection (WHERE excludes them).
- AC-A.4 `inventory_items.vendor_id` kept as primary pointer (SD-1), migration is reversible-by-design — PASS.
- AC-A.5 Re-running the backfill does not duplicate rows — PASS (`ON CONFLICT … DO NOTHING`).

**Coverage gap — AC-A:** There is NO dedicated pgTAP test that exercises backfill idempotency or count/cost preservation at the DB layer. The spec (AC-I) and architect both require "the backfill idempotency + count/cost-preservation (AC-A) … covered" in pgTAP. The reorder tests seed their own `item_vendors` rows (and prove the junction path), but no test file asserts: (a) that a re-run INSERT produces 0 new rows, (b) that a vendor-bearing item's link carries its exact cost, or (c) that a null-vendor item produces 0 links. The developer's verification was manual (`supabase migration up --local` + psql queries). This means there is no regression guard for the backfill contract in pgTAP.

Rating: **NOT TESTED** in pgTAP (AC-I explicitly requires pgTAP for AC-A). Developer verification exists but is not captured as a repeatable test.

---

**AC-B — RLS on `item_vendors` (non-member denied; spec-053 lint stays green)**

- AC-B.1 RLS policies mirror `inventory_items`; store-scoped via `auth_can_see_store(ii.store_id)` EXISTS join — PASS by code inspection. All four commands (SELECT, INSERT, UPDATE, DELETE) present in the migration.
- AC-B.2 Spec-053 permissive-policy lint stays green — PASS. `permissive_policy_lint.test.sql` PASS (4 assertions); none of the four policies is trivially-wide.
- AC-B.3 Grants: explicit `grant select, insert, update, delete … to anon, authenticated` + `grant all to service_role` in the migration — PASS by code inspection. Defense-in-depth against the spec-097 silent-grant-revocation class.

**Coverage gap — AC-B:** There is NO pgTAP test asserting that a user who cannot see a store gets 0 rows from a SELECT on `item_vendors` for that store's items, and that INSERT/UPDATE/DELETE on a foreign store's links is denied (42501 or RLS block). The spec (AC-I) and the test-engineer mandate ("A user who cannot see a store cannot read or write that store's item↔vendor links — is there pgTAP for this?") require this coverage. The policies look correct by inspection, but without a test, a future `create or replace` that misnames the function or drops the WHERE could regress silently.

Rating: **NOT TESTED** in pgTAP (AC-I requires pgTAP for AC-B RLS).

---

**AC-C — Item editor (multi-vendor add/remove/dup-guard mapping)**

- AC-C.1 `IngredientForm` replaces single vendor picker with multi-vendor affordance — PASS by code inspection (`IngredientForm.tsx` exports `vendorAlreadyLinked`, `addVendorLink`, `removeVendorLink`, `updateVendorLinkField`, `vendorRowsToLinkPayload`, `VendorLinkRow`).
- AC-C.2 Saving with V1+V2 persists two link rows; removing a vendor removes its row; editing a cost updates only that link — PASS. Covered by jest tests in `IngredientForm.test.ts` (describe block `'multi-vendor editor helpers (spec 102 AC-C)'`, lines 318–439).
- AC-C.3 Dup-guard: the form prevents attaching the same vendor twice — PASS. `vendorAlreadyLinked` tested (3 cases); `addVendorLink` returns the same reference on re-attach (tested). DB-side backstop via composite unique.
- AC-C.4 Backward compatible: single-vendor item opens with that vendor's cost, saves without drift — PASS by code inspection (`IngredientFormDrawer.tsx` synthesizes one row from scalar `vendorId` + cost when `item_vendors` embed is empty). No explicit jest test for this case. Acceptable risk (no regression path because the db.ts upsert is idempotent on the existing row).

Rating: **PASS** — `IngredientForm.test.ts` covers AC-I's "item-editor multi-vendor add/remove/dup-guard mapping (AC-C)".

---

**AC-D — Admin EOD count (shared item under both tabs; counted-once-globally)**

- AC-D.1 Shared item appears under both vendor tabs — PASS. `EODCountSection.tsx` reads `vendorIds` (junction membership) for tab counts and `vendorItems` filter (line 332: `.includes(selectedVendorId)`).
- AC-D.2 Counting under either tab updates the single shared on-hand — PASS. The admin `submitEODCount` uses the membership prefetch (`item_vendors WHERE vendor_id = …`) to gate the `inventory_items` update. No vendor-equality predicate on the item table.
- AC-D.3 Counted-once-globally: an item counted in one tab is NOT a gap in another — PASS. `deriveCountedItemIds` is exported and tested in `EODCountSection.countedOnce.test.tsx` (8 cases, 71 total jest assertions in the three spec-102 files). THE KEY CASE ("a shared item counted under vendor A reads as counted from vendor B's perspective") is explicitly named and asserted at line 86–99.

Rating: **PASS** — `EODCountSection.countedOnce.test.tsx` (new, 8 tests) covers AC-I's "shared-on-hand counted in every tab gate logic (AC-D)".

---

**AC-E — Staff EOD count (junction fetch; appears under each scheduled vendor)**

- AC-E.1 Staff `fetchItemsForVendor` queries `item_vendors` with embedded `item:inventory_items!inner(...)` instead of the old `.eq('vendor_id', vendorId)` filter — PASS by code inspection (`EODCount.tsx:138`, `.from('item_vendors')`).
- AC-E.2 Staff EODCount.test.tsx updated: the `itemVendorRow()` helper builds the new junction row shape; all 24+ existing tests pass with the new query structure — PASS (jest 721/721).

**Gap — AC-E:** The staff jest test in `EODCount.test.tsx` verifies the _shape_ of data coming from the mock (it uses the `itemVendorRow` helper for all fixture data) and tests that the screen renders correctly with that shape, but no test explicitly asserts that the screen queries `item_vendors` (not `inventory_items`) as the source table. `mockFromCalls` is tracked in the test but never asserted. This means a regression that silently reverted `from('item_vendors')` back to `from('inventory_items')` would not be caught by jest (the mock intercepts both identically). The AC-E criterion "the staff fetch returns a shared item for each of its assigned vendors" is not directly verified — it relies on the mock accepting any table name.

Rating: **PASS** (the behavior the spec describes — shared item returned for each vendor — is implemented and the jest tests pass with the junction shape). But a regression in the table name would not be caught by jest. Flag as minor gap: no assertion on which table is queried.

---

**AC-F — EOD submission consistency (shared on-hand, single consistent value)**

- AC-F.1 Staff RPC `staff_submit_eod` predicate changed from `AND ii.vendor_id = p_vendor_id` to `EXISTS (item_vendors …)` — PASS by code inspection (`20260630000200_staff_submit_eod_multi_vendor.sql:208-210`).
- AC-F.2 Admin `submitEODCount` uses membership prefetch, drops the vendor-equality predicate — PASS.
- AC-F.3 `eod_submissions (store_id, date, vendor_id)` uniqueness unchanged — PASS.

**Gap — AC-F:** There is NO pgTAP test asserting the "shared item counted under a non-primary vendor actually writes the on-hand." The spec requires: "when a shared item is referenced by more than one vendor submission on the same day, the resulting shared on-hand is a single consistent value." The `staff_submit_eod_cases_each.test.sql` was NOT updated to add a test for junction-membership write — it still only tests the cases/each split-key behavior and the per-store gate. The `eod_submissions_consistency.test.sql` and `eod_submissions_edit_flow.test.sql` do not reference `item_vendors` at all.

The architect flagged (FG-1 and §12) that this is a behavior change to two persist paths (admin `db.ts` + staff RPC) and said "the `eod_submissions_consistency` / `_edit_flow` pgTAP and the EOD jest suites must be updated (not deleted) to the new behavior (AC-I)." The staff RPC was changed (✓) and the pgTAP was not deleted (✓), but it was also not updated to assert the new junction-membership write behavior.

Rating: **NOT TESTED** for the junction-membership write path in pgTAP. This is a gap against the AC-I requirement ("EOD submission consistency for shared items across multiple same-day vendor submissions" covered in pgTAP, per the architect's explicit note).

---

**AC-G — Reorder RPC + screens (per-vendor explosion + per-vendor cost + OQ-1 hint)**

- AC-G.1 `report_reorder_list` joins `item_vendors` to explode shared items per linked vendor — PASS. Migration `20260630000100_report_reorder_list_multi_vendor.sql` rewrites CTE `(4f) item_on_hand`.
- AC-G.2 Per-vendor cost from `item_vendors` with OQ-5 fallback to item cost — PASS by code inspection. `coalesce(nullif(iv.cost_per_unit, 0), ii.cost_per_unit, 0)`.
- AC-G.3 Existing case-math (spec-088), i18n names (spec-100), hybrid formula (spec-023), min-DOW (spec-023), on-hand-source tests — all PASS (6 pgTAP files, each updated with `item_vendors` seed). No prior behavior deleted.
- AC-G.4 Envelope shape `{vendors[], kpis, _warnings, as_of_date}` unchanged — PASS by code inspection.
- AC-G.5 OQ-1 hint: `other_vendor_count` / `also_from_vendors` keys added to per-item JSON — PASS by code inspection (sub-CTE `item_vendor_set` + additive keys in `(4l)`). Admin and staff reorder screens render the hint. i18n keys present in all three locales.
- AC-G.6 No double-ordering on non-overlapping days — PASS (each (item, vendor) row placed under its own vendor's delivery cadence; no schedule change).

**Gap — AC-G (per-vendor cost + two-vendor explosion):** None of the six reorder pgTAP files directly tests: (a) that a DIFFERENT junction cost produces a different `estimated_cost` than the item's fallback cost (OQ-5 branch with non-zero junction cost), (b) that a shared item linked to TWO vendors appears under BOTH vendor cards in the RPC output, or (c) that `other_vendor_count` > 0 / `also_from_vendors` is populated for a multi-linked item. The existing tests seed exactly one `item_vendors` link per item (mirroring the primary link), so they never exercise the multi-vendor explosion path. All assertions use `cost_per_unit = 1` on both the item and the junction row, so the OQ-5 fallback branch (junction cost 0 → fall back to item cost) and the branch where junction cost != item cost are not tested.

Rating: **PASS** for the preserved behaviors (cases, i18n, formula, on-hand-source), **NOT TESTED** for the core new AC-G behaviors: multi-vendor explosion and per-vendor cost distinguishability.

---

**AC-H — Weekly count low-stock warning (`report_weekly_lowstock`)**

- AC-H.1 New RPC `report_weekly_lowstock` created — PASS by code inspection (`20260630000300_report_weekly_lowstock.sql`).
- AC-H.2 Security posture: `security invoker`, `auth_can_see_store` pre-flight, `revoke execute from public, anon; grant execute to authenticated` — PASS by code inspection.
- AC-H.3 `WeeklyCount.tsx` calls `fetchLowStock` (direct `supabase.rpc`), renders "LOW" badge + localized detail — PASS by code inspection.
- AC-H.4 Advisory only: no ordering, PO, or suggestion affordance — PASS by code inspection.
- AC-H.5 `low_stock` boolean logic: `projected_on_hand < 0` branch + `usage_per_day = 0 → on_hand <= 0` fallback — present in the migration body.

**Gap — AC-H:** There is NO pgTAP test for `report_weekly_lowstock`. The spec (AC-I) says "the reorder explosion + per-vendor cost (AC-G) are covered" in pgTAP, but does NOT explicitly list AC-H in the pgTAP requirement. However, the architect's SD-2 note describes this as a "new tiny RPC" that "reuses the pattern" of the reports trilogy — every other report RPC in the project has at least one pgTAP (the `reports_anon_revoke.test.sql` covers the `report_run_*` family's anon-EXECUTE denial). `report_weekly_lowstock` has no corresponding anon-denial test, no test of the `low_stock = true` branch, no test of the `usage_per_day = 0` fallback branch, and no test of the nearest-delivery-date computation. The `WeeklyCount.tsx` implementation is not jest-tested (it is a complex screen component and the spec does not require it, consistent with project convention).

Rating: **NOT TESTED** — the RPC has no pgTAP coverage of any kind (auth gate, low_stock branch, usage=0 fallback, nearest-delivery). This is a gap against the project's established pattern for new RPCs.

---

**AC-I — Tests (across three tracks; existing suites updated not deleted)**

- AC-I.1 pgTAP for AC-A (backfill idempotency + count/cost) — **NOT TESTED** (no dedicated test; see AC-A gap above).
- AC-I.2 pgTAP for AC-B (new `item_vendors` RLS) — **NOT TESTED** (no non-member denial test; see AC-B gap above).
- AC-I.3 pgTAP for AC-G (reorder explosion + per-vendor cost) — **PARTIAL** (6 reorder tests pass and are updated; multi-vendor explosion and per-vendor cost distinguishability not exercised).
- AC-I.4 jest for AC-C (item-editor multi-vendor helpers) — **PASS** (`IngredientForm.test.ts`, 21 new assertions in the `multi-vendor editor helpers` describe block).
- AC-I.5 jest for AC-D (counted-once-globally gate) — **PASS** (`EODCountSection.countedOnce.test.tsx`, 8 tests including THE KEY CASE).
- AC-I.6 Existing reorder pgTAP updated (not deleted) — **PASS** (6 files updated; each seeds `item_vendors` for its test items; pinned behaviors remain).
- AC-I.7 Existing EOD jest suites updated (not deleted) — **PASS** (`EODCount.test.tsx` updated to use `itemVendorRow` fixture shape; all 24+ prior tests pass; no test deleted).
- AC-I.8 No suite pinning old single-vendor shape — **PASS**. Confirmed no reorder pgTAP still uses `inventory_items.vendor_id` as the sole join key; no EOD jest test expects `from('inventory_items')` with a vendor filter.

---

### Summary of gaps by severity

**Critical (zero coverage on required AC-I items):**

1. **AC-A + AC-I.1 — No pgTAP for backfill idempotency.** The spec and architect both require pgTAP for AC-A. A re-run of the backfill that somehow duplicated rows would not be caught. No test counts links before/after a second backfill run.

2. **AC-B + AC-I.2 — No pgTAP for `item_vendors` RLS denial.** A non-member can't read/write a store's links is an AC-B binding requirement and AC-I lists pgTAP for AC-B. The `supabase/tests/rls_hardening_followups.test.sql` covers other child-table policies but not `item_vendors`. RLS policies look correct, but without a test, a future edit that breaks the EXISTS join would not be caught.

3. **AC-F + AC-I — No pgTAP for junction-membership EOD write.** The architect explicitly said `eod_submissions_consistency` / `_edit_flow` pgTAP must be updated. They were not. A shared item counted under a non-primary vendor must write the on-hand — this is the core spec-102 on-hand reconciliation behavior and it has no automated DB-layer test.

**Significant (new RPC with no test, AC-G multi-vendor explosion untested):**

4. **AC-H — `report_weekly_lowstock` has zero pgTAP coverage.** Anon-denial, `low_stock = true`, `usage_per_day = 0` fallback, nearest-delivery computation — none tested. Breaks the project pattern for all other report RPCs.

5. **AC-G (partial) — Per-vendor cost distinguishability and two-vendor explosion not tested.** All six reorder pgTAP files test with one item_vendors link per item, cost = 1 on both the junction and the item. The OQ-5 fallback (junction cost 0 → item cost) and the scenario where junction cost != item cost produce a different `estimated_cost` are not pinned. A shared item appearing under TWO vendor cards in the reorder output is not verified by any pgTAP.

**Minor (no functional impact on the test-tracked contract):**

6. **AC-E — Staff `EODCount.test.tsx` does not assert `from('item_vendors')` is called.** The mock intercepts any table name. A reversal of the query change would not be caught by jest.

---

### Test run (commands and counts)

```
npx jest --no-coverage
  → Test Suites: 67 passed, 67 total
  → Tests:       721 passed, 721 total

npx tsc --noEmit
  → (clean — no output)

npm run typecheck:test
  → (clean — no output)

bash scripts/test-db.sh (seeded state: 564 item_vendors rows)
  → 51/51 DB test file(s) passed

bash scripts/test-db.sh (CI-fresh state: item_vendors truncated)
  → 51/51 DB test file(s) passed
```

Both suites are green. The CI-fresh / seeded asymmetry is confirmed resolved for the six reorder pgTAP files. The three Critical gaps above (AC-A backfill idempotency, AC-B RLS denial, AC-F junction-membership EOD write) are missing from the green count — they are absent tests, not red tests.
