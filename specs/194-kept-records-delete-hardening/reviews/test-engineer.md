## Test report for spec 194

### Acceptance criteria status
pgTAP file: `supabase/tests/kept_records_delete_hardening.test.sql` (103 assertions, all pass). Arm ids below are the file's own labels and comment headers.

- AC-1 (staff re-date, 200-day, 3 columns, 42501 + read-back) -> PASS, AC-1 arms (throws_ok with exact message) + final-block read-back
- AC-2 (1-hour rows and NULL) -> PASS, AC-2 arms
- AC-3 (M1 replay two-step) -> PASS, AC-3 arms (update raises, delete gives ok:0, dates read back)
- AC-4 (admin, master, super_admin may change dates) -> PASS, AC4 arms
- AC-5 (accepted residual, admin re-date then delete) -> PASS, AC5-1/AC5-2
- AC-6 (pass-through SET, staff and admin) -> PASS, AC6 arms
- AC-7 (status, total_cost, receive/cancel RPC, quantity, filename still work) -> PASS, AC7 arms
- AC-8 (postgres, service_role, postgres-with-staff-claims, SD wrapper) -> PASS, AC8 (a)-(d)
- AC-9 (explicit-date INSERT) -> PASS, AC9 arms (staff and postgres)
- AC-10 (non-draft PO line deletes refused, 4 roles x 4 statuses) -> PASS, AC10 arms
- AC-11 (draft line deletable, 200-day and 1-hour) -> PASS, AC11 arms
- AC-12 (upsertVendorDraftOrder sequence) -> PASS, AC12 arms
- AC-13 (cross-store / cross-brand scope) -> PASS, AC13 arms
- AC-14 (1-hour draft PO delete cascades) -> PASS, AC14 arms
- AC-15 (200-day POS line refused) -> PASS, AC15-AC16 arms
- AC-16 (1-hour POS line refused) -> PASS, AC15-AC16 arms
- AC-17 (1-hour import delete cascades) -> PASS, AC17 arms
- AC-18 (recipe_id/recipe_mapped update) -> PASS, AC18 arms
- AC-19 (service-role Breadbot insert) -> PASS, AC19 arms
- AC-20 (status into draft refused, 4 roles + postgres) -> PASS, AC20 arms + AC20-readback
- AC-21 (draft -> draft) -> PASS, AC21 arm
- AC-22 (po_id move refused) -> PASS, AC22 arms
- AC-23 (import_id move refused) -> PASS, AC23 arms
- AC-24 (pass-through po_id/import_id) -> PASS, AC24 arm
- AC-25 (refusal strings byte-for-byte) -> PASS, throws_ok with exact message on every raising arm; silent delete shapes pinned with ok:0 + read-back; postgres ok:N arms
- AC-26 (deletePoItem throws on 0 rows; removePoLine restores + notifies) -> PASS, `src/lib/db.deletePoItem.test.ts`, `src/store/useStore.removePoLine.test.ts`, `src/lib/db.upsertVendorDraftOrder.test.ts` (count:0 arm returns null, no total update). Note: `notifyBackendError` is module-local, so the store test asserts its effects (console.warn + Toast.show 'Remove PO line failed'), not a spy on the function. Acceptable.
- AC-27 (existing pins found; full jest, typecheck, typecheck:test) -> PASS with a pre-existing caveat. Full jest and `typecheck:test` pass. `npm run typecheck` fails with 24 TS2688 errors, confirmed pre-existing and unrelated (see Test run).
- AC-28 (no new PERMISSIVE policy; spec 186 policies unchanged) -> PASS, C-1a / C-1b; `retention_prune_job` passes in the full suite
- AC-29 (spec 186 comments rewritten) -> PASS, C-5
- AC-30 (no SELECT policy added/renamed) -> PASS, C-1a; `report_last_order_context` passes in the full suite
- AC-31 (no DELETE/ALL policy on eod tables) -> PASS, C-6
- AC-32 (every existing pgTAP file passes) -> PASS, 100/100 files, no existing file edited
- AC-33 (proof tests can fail) -> PASS on the developer's record, not re-run by me. The implementation notes tabulate each mutation and the arms that went red, and they match the spec's table. I did not repeat the mutations.
- AC-34 (read-only prod pre-check) -> PENDING (needs owner go-ahead; not failing)
- AC-35 (prod apply via MCP, schema_migrations insert, md5 verification) -> PENDING (needs owner go-ahead; not failing)
- AC-36 (post-push test.yml / db-migrations-applied.yml green, e2e by hand) -> PENDING (no push yet; not failing)

Totals: 33 PASS (AC-1 to AC-33), 0 FAIL, 0 NOT TESTED, 3 PENDING (AC-34 to AC-36, prod steps).

### Test run
- `bash scripts/test-db.sh supabase/tests/kept_records_delete_hardening.test.sql`: PASS, 103 assertions.
- `bash scripts/test-db.sh` (full pgTAP): 100/100 files pass. Local stack used as-is, with no reset or stop.
- `npx jest src/lib/db.deletePoItem.test.ts src/store/useStore.removePoLine.test.ts src/lib/db.upsertVendorDraftOrder.test.ts`: 3 suites, 15 tests, all pass. The console.warn in the output is the expected "insert boom" arm.
- `npx jest` (full): 301 suites, 3835 tests, all pass.
- `npm run typecheck:test`: pass (exit 0).
- `npm run typecheck`: 24 errors, all TS2688 "Cannot find type definition file for '<name> 2'". I confirmed 24 `node_modules/@types/* 2` duplicate folders on disk and 0 non-TS2688 errors. Pre-existing and unrelated to this spec, so not counted against it.

### Notes
- No tests were modified. No new framework introduced. Nothing committed.
- The tests hit the real local Postgres, with no DB mocks, in a begin/rollback transaction. The seed is untouched.
- Coverage gaps (non-blocking):
  - The spec 138 replace-lines RPC follow-up (Fill cart race) is not built and not tested. The spec defers it.
  - The Fill-cart race (PO turns `sent` mid-sequence) is covered only at the jest level, with the delete count mocked as 0. No live concurrency test exists, which is accepted by the design.
- Environment: the base `typecheck` stays red until the owner removes the Finder-style `node_modules/@types/* 2` folders (or CI, which won't have them, is consulted). That is independent of spec 194.
- Prod steps AC-34 to AC-36 remain for the owner's go-ahead. The migration version to insert is `20261109170000`.
