## Test report for spec 177

### Acceptance criteria status
New file: `supabase/tests/cross_store_item_rejection.test.sql` (pgTAP, plan 54, T01-T54 all present and in the design's table order). Every `throws_ok` asserts SQLSTATE and exact message. Every acceptance arm re-reads the row.

- AC-1 (cross-store po_items INSERT rejected, no row) -> PASS - `cross_store_item_rejection.test.sql` T03, T04
- AC-2 (UPDATE item_id to other-store item rejected, row unchanged) -> PASS - T07, T08
- AC-3 (UPDATE po_id moving A line to B's PO rejected) -> PASS - T09, T10
- AC-4 (null item_id and missing/invisible parent fail closed) -> PASS - T11, T12, T13 (null-store parent), T14 (one-store manager, invisible parent), T15 (invisible item)
- AC-5 (same-store INSERT accepted, row exists) -> PASS - T05, T06
- AC-6 (receiving-style UPDATE accepted, values changed; real RPC) -> PASS - T16 (pass-through short-circuit), T17, T18, T19 (`receive_purchase_order`), T20
- AC-7 (po_loop, auto_receive_due_purchase_orders and other po_items writers pass unmodified) -> PASS - `git diff` shows only the two AC-16 files modified. `po_loop` (30), `auto_receive_due_purchase_orders` (24), `cost_on_receipt` (55) and `staff_receiving_gate` (45) pass. No cross-store fixture finding.
- AC-8 (RPC with other-store item rejected, no row) -> PASS - T21, T22
- AC-9 (mixed lines rejected) -> PASS - T23, T24
- AC-10 (direct INSERT under RLS rejected) -> PASS - T25, T26 (plus T27, nonexistent item fails closed)
- AC-11 (direct UPDATE of pending lines rejected, lines unchanged) -> PASS - T30, T31
- AC-12 (RPC pending-retry with other-store item rejected, original lines unchanged) -> PASS - T32, T33
- AC-13 (same-store RPC accepted as pending; same-store retry updates lines) -> PASS - T28, T29
- AC-14 (status advance and external_ref write accepted) -> PASS - T34 (lines pass-through), T35, T36. T37 pins that the guard still wins on a lines PATCH of an approved row.
- AC-15 (malformed lines rejected with stable error) -> PASS - T38 (object), T39 (no item_id), T40 (non-uuid "wings"), T41 (non-object element), T42 (0 rows written). All 22023 with the exact message and no 22P02 escape.
- AC-16 (two existing files pass with fixture-only edits) -> PASS - verified by diff. `order_approvals.test.sql` has +17 added lines only: two `catalog_ingredients` rows (brand A, ids `49921000-...`) and two `inventory_items` rows with the existing literal ids `49920000-...0001/0002` in `test.store_a`. `report_last_order_context.test.sql` has +10 added lines only: a comment, plus disable/enable `order_approvals_lines_check_store_trg` around the existing fixture INSERT. No assertion, expected value or `plan()` line is touched in either file. Results: order_approvals 24 assertions pass, report_last_order_context 41 pass.
- AC-17 (store_id change on lined PO rejected, PO and lines unchanged) -> PASS - T43, T44
- AC-18 (total_cost/status update accepted) -> PASS - T45, T46
- AC-19 (unlined PO store_id) -> PASS - pins the architect's "always immutable" choice (D-3): T47 rejects, T48 shows a pass-through SET is accepted
- AC-20 (no EXECUTE for public/anon/authenticated; lints unmodified) -> PASS - T49-T51 (`has_function_privilege` plus a non-null `proacl` with no PUBLIC EXECUTE entry), T52 (SECURITY INVOKER), T53 (triggers present, enabled, on the right tables), T54 (guard fires before the new trigger). `public_grants_explicit` (13) and `permissive_policy_lint` (5) pass unmodified.
- AC-21 (all gates) -> PASS - see Test run.
- AC-22 (scope fence) -> PASS - spec 177's changes are one new migration, one new pgTAP file, the two AC-16 fixture edits and the spec file. `src/**` and `supabase/functions/**` are not touched by 177, and `app.json` has no diff. The staged `src/**` changes belong to spec 176 and were ignored as instructed.
- AC-23 (design contains prod apply runbook) -> PASS - spec §10 has pre-check, `execute_sql`, exact `schema_migrations` insert, normalized-md5 and `pg_trigger` verification, and a rolled-back negative probe. The local md5s are recorded under "Files changed".
- AC-24 (prod apply after owner go-ahead and before the push, then confirm CI gates) -> PENDING (owner-gated, run by main Claude). Not a coverage gap.

Summary: 23 PASS (AC-1 to AC-23), 0 FAIL, 0 NOT TESTED, 1 PENDING (AC-24, the owner-gated prod apply).

### Test run
- `scripts/test-db.sh`: exit 0, **91/91 files passed, 1301 assertions**, no FAIL lines. Relevant files:
  - cross_store_item_rejection 54
  - order_approvals 24
  - report_last_order_context 41
  - po_loop 30
  - auto_receive_due_purchase_orders 24
  - cost_on_receipt 55
  - staff_receiving_gate 45
  - public_grants_explicit 13
  - permissive_policy_lint 5
- `npx jest` (full): **266/266 suites passed, 3334/3334 tests passed**, 17 snapshots passed.
- `npm run typecheck`: exit 0.
- `npm run typecheck:test`: exit 0.
- Hits the real local Postgres through the pgTAP runner. No mocks.
- Independent checks on the new test file: it contains 54 distinct `T##` labels and 54 assertion statements, matching `plan(54)` and the design's T01-T54 table. The migration body matches the design's pseudocode. The one documented deviation is the CASE guard around `jsonb_array_elements`, which is behaviour-preserving and pinned by T38 and T41.
- I did not re-run the developer's negative control (triggers disabled, 32/54 arms fail). I verified by reading that the rejection and anti-vacuity arms depend on the triggers.

### Notes
- No framework gap and no new framework. All tests are pgTAP and jest.
- T14 (trigger message wins over the RLS WITH CHECK message for an invisible parent) passes, so the design's ordering assumption holds.
- R-2 depends on `pg_input_is_valid` (PG16+). Local is PG17. The runbook pre-check already asserts prod is 17.x.
- Residual risks the design already records, not test gaps:
  - `inventory_items.store_id` can still be PATCHed, which is out of scope.
  - An always-immutable `purchase_orders.store_id` means a mis-filed PO must be cancelled and re-created.
  - Orphan-header cleanup ignores a failed DELETE (the design's R-4 finding).
- Concurrency (the insert-vs-move race the design cites for D-3) is argued in the design but not exercised by pgTAP, which is single-session. This is acceptable, because always-immutable `store_id` is pinned by T43 and T47.
- AC-24 stays open until the owner approves the prod apply. Per project memory, `e2e.yml` must be checked by hand after the push.
