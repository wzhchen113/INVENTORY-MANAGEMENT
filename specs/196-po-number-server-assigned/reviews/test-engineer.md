## Test report for spec 196

> Saved by the main session from the test-engineer's hand-back. The agent couldn't write report files itself.

### Acceptance criteria status
The new file is `supabase/tests/po_number_server_assigned.test.sql` (plan 68), written `PNSA` below. Arm numbers are this report's labels for assertions inside that file.

- AC-1 (INSERT with explicit number, staff, admin and super_admin) → PASS. `PNSA` blocks C, D and E each have a `throws_ok(…, 'P0001', 'po_number is server-assigned')` arm. The block I read-back finds no row by fixture id and none by the attempted numbers.
- AC-2 (bulk INSERT) → PASS. `PNSA` block C has two arms: three explicit rows, and a mixed statement with the explicit row last. Block I reads back zero rows across all six fixture ids.
- AC-3 (UPDATE changes the number) → PASS. Staff arms for a changed value and for `set po_number = null`, plus an admin arm. The block I read-back finds the original numbers unchanged.
- AC-4 (bulk UPDATE) → PASS. Block C has one `CASE` UPDATE renumbering two POs. Block I shows both rows keep their original numbers.
- AC-5 (generated INSERT: omitted and explicit NULL, staff and admin) → PASS. Four `lives_ok` arms in blocks C and D. Each stashes `format_po_number(seq_next())` as postgres just before the insert. Block I `is()`-compares each row to its stashed value and checks the `^PO-[0-9]{3,}$` pattern.
- AC-6 (status and total updates keep working) → PASS. Three `try_sql = 'ok:1'` arms: draft→sent, the extension shape with `where status='draft'`, and a `total_cost` update. Block I confirms the new values and an unchanged `po_number`.
- AC-7 (same-value echo) → PASS. Two `ok:1` arms: `set po_number = po_number`, and a literal echo combined with `status='sent'`. Block I confirms the number is unchanged.
- AC-8 (receive RPC) → PASS. `receive_purchase_order` is SECURITY INVOKER, so it goes through the client branch. It returns `ok:1`, and the read-back shows `received` with the original number.
- AC-9 (owner INSERT, postgres and service_role) → PASS. Blocks F and G; block I shows the explicit values kept.
- AC-10 (owner UPDATE, postgres and service_role) → PASS. Blocks F and G use `ok:1`; block I shows the new values.
- AC-11 (postgres with stale staff claims) → PASS. Block H has anti-vacuity arms for `current_user = postgres` and the staff `sub` claim, then a `lives_ok` and a read-back.
- AC-12 (`anon` covered) → PASS via the catalog/body route the AC allows (no `set role anon`, per the spec 067 segfault). The `prosrc` regex pins `current_user not in ('anon','authenticated')`. Two more arms assert the body contains neither `jwt` nor `auth.`. The "anon removed" mutation was not re-run by test-engineer.
- AC-13 (guard function catalog) → PASS. Six arms: `prosecdef = false`, `proconfig = {search_path=public}`, owner `postgres`, and no EXECUTE for `public`, `anon` or `authenticated`.
- AC-14 (trigger wiring and order) → PASS. Seven arms in block A:
  - enabled (`tgenabled = 'O'`)
  - `tgtype = 23`
  - empty `tgattr`
  - no `WHEN`
  - `tgfoid` matches
  - the name sorts before `set_po_number` in C collation
  - the guard is the first BEFORE ROW INSERT trigger
- AC-15 (spec 190 objects unchanged) → PASS. `generate_po_number()` keeps `prosecdef = true` and `search_path=public`. `set_po_number` keeps `WHEN (new.po_number IS NULL)`.
- AC-16 (variance fixture) → PASS. `po_number` is gone from the column list and the value list, and the comment is rewritten. `plan(7)` is unchanged and the file passes in the full run.
- AC-17 (spec 190 tests unchanged) → PASS. `generate_po_number_sequence` and `generate_po_number_malformed_guard` are untouched and pass.
- AC-18 (whole suite) → PASS for pgTAP, re-run by test-engineer (103/103). jest and typecheck:test were not re-run; the developer reported 301 suites / 3836 tests green and typecheck:test clean.
- AC-19 (mutations) → PASS.
  - Spot-checked: trigger dropped (20 failures, matches the developer). Guard body replaced with a no-op (15 failures, including the refusal arms).
  - The other four (SECURITY DEFINER, renamed to sort after `set_po_number`, SET-list variant, `anon` removed) come from the developer's implementation notes and were not re-run.
  - A clean run gives 0 failures. After the rollback-wrapped mutations the live guard is still correct (`tgtype 23`, `prosecdef f`).
- AC-20 (prod apply) → NOT TESTED. Owner-gated, and spec 190 must be applied first.
- AC-21 (prod verification) → NOT TESTED. Same gate.
- AC-22 (CI after push) → NOT TESTED. Needs a push.

Counts: 19 PASS, 0 FAIL, 3 NOT TESTED (AC-20, AC-21 and AC-22, all prod/CI and owner-gated).

### Test run
- `bash scripts/test-db.sh`: exit 0, "103/103 DB test file(s) passed". It includes `po_number_server_assigned`, `report_run_variance_formula`, `permissive_policy_lint`, `retention_prune_job` and `po_loop`.
- Manual mutation spot-checks through `docker exec supabase_db_imr-inventory psql`, each wrapped so the test file's own rollback undid it:
  - clean: 0 failures
  - trigger dropped: 20 failures
  - no-op guard body: 15 failures
- jest and typecheck:test were not run by test-engineer.

### Notes
- The migration `20261109200000_po_number_server_assigned.sql` is the newest on disk and matches the design. Nothing was staged or committed.
- `report_run_variance_formula.test.sql` shows `MM`. The unstaged spec 196 change sits on top of spec 190's staged comment edit.
- AC-5 reads the sequence value as postgres immediately before each insert. Explicit numbers sit 10000 or more ahead, so the skip loop can't interfere.
- Gaps (non-blocking):
  - no runtime `anon` arm, by design;
  - no dedicated arm for the `bad trigger wiring` branch (no AC requires one).
- No test-side BLOCK. Only the owner-gated prod and CI criteria remain open.
