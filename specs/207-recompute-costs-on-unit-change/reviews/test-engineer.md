## Test report for spec 207

### Acceptance criteria status
- AC-1 (units/case 1->2, all four rows 16.975, store B written) -> PASS. `supabase/tests/cost_rederive_on_pack_size.test.sql` "AC-1" assertions (value, xmin change on store B, anti-vacuity).
- AC-2 (sub-units 1->35, 0.970000; reorder estimated_cost 101.85) -> PASS. Same file, "AC-2" (3 assertions, includes `report_reorder_list` for store B).
- AC-3 (link's own case_price) -> PASS. Same file, "AC-3" (V2 link price 40 -> 20).
- AC-4 (0/NULL guard, parity with piecesPerCase/calcUnitCost) -> PASS. pgTAP "AC-4" helper matrix (12 inputs), non-finite and unpriced checks, end-to-end 1->0->NULL->2->0. jest `src/utils/perEachCost.spec207.test.ts` pins the same matrix. calcUnitCost parity is asserted only for caseQty > 0, as D-2 documents.
- AC-5 (no-op updates write nothing) -> PASS. Same file, "AC-5": rename / i18n_names / image_path / eod_count_mode / resent case_qty / (2,3)->(3,2) swap. Asserts xmin, cost and updated_at unchanged, plus anti-vacuity that the edits landed.
- AC-6 (every store of the brand) -> PASS. Same file, "AC-6": anti-vacuity that the admin cannot see brand-2 store Z, then Z's row (brand 1 catalog_id) is re-derived. The D-4 finding is stated in a comment.
- AC-7 (unpriced rows scale) -> PASS. Same file, "AC-7": 0.014286, 35->1 gives 0.500010, cost-0 row unchanged with xmin unchanged, item and link both covered.
- AC-8 (derive on write) -> PASS. Same file, "AC-8": INSERT and UPDATE give 5.000000 on both tables, the create-reuse RPC stores and returns 5, a cost-only 9 gives 5, an unpriced 9 stays 9. The stock-only and order_code/url/is_primary cases use a row made off-rule with the trigger disabled, and its cost is kept.
- AC-9 (receiving unchanged) -> PASS. Same file, "AC-9": envelope `new_cost_per_unit` = 13.333333 = both stored values. The case_qty = 0 case no longer divides by zero. `cost_on_receipt.test.sql` and `staff_receiving_gate.test.sql` pass in the full run.
- AC-10 (drift listing) -> PASS. `supabase/tests/list_cost_drift.test.sql` (17 assertions): exact beyond-tolerance set, within-tolerance row absent, `cost_without_case_price` kind, non-privileged authenticated gets 42501, anon checked via `has_function_privilege` (no `throws_ok` under anon, per spec 067), brand scoping, super_admin sees all, `postgres` path, xmin/ctid unchanged, STABLE.
- AC-11 (history untouched) -> PASS. `cost_rederive_on_pack_size.test.sql` "AC-11": po_items and waste_log xmin and cost unchanged.
- AC-12 (gates green; fixtures audited, not weakened) -> PASS. See Test run and Notes.
- AC-13 (prod check after apply) -> NOT TESTED. A prod-rollout record, expected open. The D-11 runbook is owner-gated and the migration has not been applied to prod.

Totals: 12 PASS, 0 FAIL, 1 NOT TESTED (AC-13, expected).

### Test run
- `bash scripts/test-db.sh`: 116/116 DB test files passed. New files: cost_rederive_on_pack_size 59 assertions, list_cost_drift 17 assertions.
- `npx jest`: 323 suites, 4160 tests passed, 17 snapshots passed.
- `npm run typecheck:test`: exit 0.
- `npm run typecheck`: fails with 24 errors. All are TS2688 ("Cannot find type definition file for '<name> 2'"). I filtered out TS2688 and no other error remains. `node_modules/@types/` contains `<name> 2` duplicate folders (babel__core 2, jest 2, and others). The developer's claim is CONFIRMED. Nothing was deleted. The cause is environmental (Finder copies), and a clean checkout and CI are unaffected.
- Playwright e2e was NOT run, as instructed (port 8081 and shared DB).

### Notes
- Fixture audit (git diff of the 7 modified pgTAP files). No assertion was weakened and no trigger was disabled in existing tests.
  - `apply_item_scalars_store_subset`, `apply_item_scalars_to_brand`, `apply_item_vendors_to_brand`, `inventory_items_identity_lock`: catalog `case_qty` = 12 puts the existing pairs on the rule. Asserted values are unchanged. In `apply_item_vendors_to_brand` the submitted V1 pair (99, 999) is deliberately off-rule, so the "existing link not overwritten" probes are still non-vacuous.
  - `item_vendors_backfill`: cost 7.25 -> 8.35 with case_qty 4 (33.40/4). The cost-preservation assertion is kept and still distinctive.
  - `stock_store_from_store`: c1 case_qty 12 and cost 1.234567 -> 1.041667 (round(12.5/12, 6)). It still pins "verbatim, six decimals" copying of a non-round value.
  - `item_vendors_rls`: the link is unpriced (case_price 0) so the "cost = 1 did not land" probe is not made vacuous by R3. This is the D-9 option-2 route, and the comment explains it. It slightly shifts that file's fixture, not the RLS assertion.
  - `inventory_items_identity_lock` T72/T73: the pins now allow exactly `zz_derive_cost_per_unit_trg` as the only BEFORE INSERT trigger and as the last BEFORE UPDATE trigger. The identity-lock-first ordering is kept. The change tightens the check from a count to a named list.
  - `apply_item_scalars_to_brand` (15), the NULL-means-skip cost check: for a priced row it now pins the derived cost (20.00), which still equals the old expected value. A comment says so.
- Gaps and observations (non-blocking).
  - The anon refusal on `list_cost_drift` is checked by privilege inspection only, because `throws_ok` under `set role anon` segfaults CI (spec 067). This is accepted project practice.
  - The pgTAP tests ran against the local seed, where R3 rewrites priced seeded rows at load. The developer reports they also ran a CI-seed-fidelity pass. I ran the suite as-is, and it is green.
  - The `db-migrations-applied.yml` gate will be red after a push until the D-11 prod apply is done. Per CLAUDE.md this blocks SHIP_READY until then. It is an expected sequencing item, not a test defect.
  - `e2e.yml` needs a manual check after the push.
- No new test framework was introduced.

## Delta re-review (2026-11-24, release-proposal R-2)

Scope: fixes 1-3 (brand-scoped R1 with flipped AC-6 plus new C11 overflow test; S-1 unpriced NULL-skip pin; NOTE comment in receive_purchase_order).

### Run
- `scripts/test-db.sh`: 116/116 files pass. Assertions sum to 2,743 (matches the reported count). `cost_rederive_on_pack_size` is now 65 (was 59), `apply_item_scalars_to_brand` is 20 (was 18).
- `npx jest`: 323 suites, 4,160 tests pass (unchanged).
- `npm run typecheck:test`: exit 0.
- Playwright not run.

### AC status changes
- AC-6: still PASS, but the assertion is flipped. The brand-2 store Z item and link now keep 33.95 with xmin and updated_at unchanged, and R1 no longer crosses the brand boundary (the migration scopes by `s.brand_id = new.brand_id` at its L264 and L285). The anti-vacuity check that the admin cannot see store Z is kept. This is a deliberate change from the spec's D-4 "reaches a cross-brand row" test. It follows the brand scoping the coordinator asked for, so the spec text for AC-6/D-4 should be reconciled to say so.
- All other ACs: unchanged, PASS. AC-13 is still open (expected).

### Do the new assertions discriminate?
- C11 overflow: a brand-2 row planted at 999999.999999 with pieces going 35 -> 1. Unscoped, the OQ-2 scaling (x35) would raise 22003 and abort the admin's catalog PATCH. `lives_ok` on the edit, the landed `sub_unit_size`, the brand-1 row re-derived to 30, and the planted row's xmin unchanged would each fail against the unscoped version. This is a real regression guard. I did not mutate the migration to prove it, so this rests on reading the fixture and the scope clause.
- 15a/15b: an unpriced row (case_price 0, cost 3.33) goes through an RPC call with `p_cost_per_unit => null`. R3 does not fire on unpriced rows, so 3.33 survives only if the RPC skips cost. An RPC that wrote NULL or any other value would fail. The old (15) now honestly says it only pins the derived priced cost. S-1 is closed.
- NOTE comment in receive_purchase_order: comment only. The receiving assertions (AC-9) and `cost_on_receipt` / `staff_receiving_gate` still pass.

### Notes
- No new Critical. The blocker that remains is the owner-gated D-11 prod apply. `db-migrations-applied.yml` stays red until then.
