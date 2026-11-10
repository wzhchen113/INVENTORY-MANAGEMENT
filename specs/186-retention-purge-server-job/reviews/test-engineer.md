## Test report for spec 186

Run 2026-11-08 against the shared local stack (db container `supabase_db_imr-inventory`). Migration `20261108120000` is applied locally: the version row exists, the cron row reads `prune-audit-log-and-invitations | 47 8 * * * | select * from public.prune_audit_log_and_invitations();`, and both functions exist.

### Acceptance criteria status
File = `supabase/tests/retention_prune_job.test.sql`. Arm names are the `ok N - <name>` labels.

- AC-1: one active `prune-*` job, once a day, running the prune -> PASS. `J-1` (exact name, active, count 1), `J-2` (`47 8 * * *`), `J-3` (command text). `cron.job` is readable on the `psql -U postgres` test path. CI runs CLI 2.106.0, so the first CI run is the real proof there.
- AC-2: tests run the job's own command -> PASS. The DO block does `select command into strict ... from cron.job` and then `execute v_cmd into ...`. Nothing names the function for the run.
- AC-3: fixture precondition -> PASS. `F-1` counts every prune fixture (audit 5, invites 5, plus the kept rows and the approval) before the run. The AC-17, AC-19 and AC-22 fixtures are not in F-1. They are covered by their own preconditions or by the fact that the inserts succeed in the same transaction (see weak spots).
- AC-4: deletion control -> PASS. `A4-1` to `A4-4`. Each counts by fixture id as postgres, and `count(*)` is never NULL. Mutant check below: a no-op prune fails all four.
- AC-5: boundaries -> PASS. `A5-1` to `A5-6`: 89-day, NULL `created_at`, future-unused, used-expired, NULL `expires_at` and NULL `used` rows all stay.
- AC-6: kept records -> PASS. `A6-1` to `A6-9`, each asserted separately, read as postgres, with a 200-day fixture date confirmed in `F-1`.
- AC-7: approval link -> PASS. `A7`. If the approval row were gone the scalar would be NULL, and `is(NULL, uuid)` fails, so this direction is safe.
- AC-8: no DELETE/ALL policy on `eod_*` -> PASS. `P-4`. Mutant check below: adding a DELETE policy on `eod_submissions` fails `P-4` and `A16-4`.
- AC-9: reported counts equal the row-count drop; second run is 0 -> PASS. `A9-1`, `A9-2` (drop measured from `count(*)` before and after, not the fixture count), `A9-3` (`0,0`). See weak spot 1.
- AC-10: no execute for anon/authenticated -> PASS. `P-5` (anon, authenticated and service_role false, postgres true), `P-6` (trigger function). Catalog assertions, no `set role anon`.
- AC-11: no `cleanupOldRecords` under `src/` -> PASS, by evidence. `grep -rn cleanupOldRecords src` returns 0 lines. It is also absent from `supabase/functions`, `scripts` and `e2e`. No jest test pins the absence. That is a grep check only, which is how the spec words it.
- AC-12: 16 mock entries removed -> PASS, by evidence. The grep above returns nothing, and `git status` shows all 15 `useStore.*` test files plus `PhoneOrdering.reorderReload.spec175.test.tsx` modified. The full jest run is green with the mocks gone.
- AC-13: `expectNoTails` line removed; jest and typechecks pass -> PASS. `expectNoTails` (L501) has no `cleanupOldRecords` assertion. Jest, `typecheck:test` and the fixed `typecheck` are green (see Test run).
- AC-14: caller can SELECT the 200-day rows -> PASS. `A14-1` (admin), `A14-2` (super_admin), `A14-3` (staff), asserting `po=2 poi=1 voa=1 waste=1 pos=1 posi=1` as that caller. The count-based string cannot be NULL. `A19-0` is the same precondition for the store-delete run.
- AC-15: old purge leaves the kept rows for admin, super_admin and staff -> PASS. `A15-1` to `A15-3`. The state is read as postgres straight after each caller's attempt and asserted in the final block.
- AC-16: refusal is 0 rows and no error -> PASS. `A16-1` to `A16-3` (`ok:0|ok:0|ok:0` for each caller), `A16-4` (the `eod_submissions` statement).
- AC-17: skew margin -> PASS. `A17-1` to `A17-6` (1 day + 1 minute refused, 1 day - 1 minute deleted, on all three tables), `A17-7` (88 days fast cannot reach 3-day rows), `A17-8` to `A17-10` (120 days fast deletes the 23-hour rows, raises no error, and rows over 1 day still stay refused).
- AC-18: PO rollback -> PASS. `A18` (`ok:1 left=0`).
- AC-19: `db.deleteStore` statements in order -> PASS. `A19-0` to `A19-7`: L185 gives 23503, L186 gives 42703, L187 gives `ok:0`, L188 removes the fresh row and leaves the aged one (read as postgres), L190 and L191 succeed, and the final read shows store, waste, PO, POS and POS lines all gone. Each statement runs through `try_sql`, so one error does not stop the next. The waste rows name the store's item, so the arm exercises the hazard.
- AC-20: `hard_delete_brand` -> PASS. `A20`.
- AC-21: delete a `po_items` line on a 200-day draft -> PASS. `A21` (`ok:1 line=0 po=1`).
- AC-22: rows under the margin stay deletable -> PASS. `A22-1` to `A22-3` (admin, super_admin and staff, 12-hour rows, all three tables).
- AC-23: audit properties still hold -> PASS. The existing `audit_log_rls_hardening` and `super_admin_policy_parity` arms pass in the full run. Caveat: `audit_log_rls_hardening.test.sql` in the working tree also carries spec 187 edits (plan 54 to 61, new `UD-*` arms). The pre-existing D, S, U, C, R, I and W arms are untouched in that diff, so AC-23 does not depend on those edits. This file's own `A25` also still passes.
- AC-24: `admin_delete_audit_log` stays, comment rewritten -> PASS. `P-7` (keeps the `spec 170: ` prefix, names spec 186, no longer names `cleanupOldRecords`). `ok(NULL)` fails in pgTAP, so a missing policy or comment cannot pass.
- AC-25: stale audit_log delete raises no error -> PASS. `A25` (`ok:1 store=0 storeless=1`). Its fixtures are inserted after the prune ran, so it depends on the earlier prune having cleared any old seed audit rows. If it did not, `ok:1` would fail loudly, not pass vacuously.
- AC-26: mutants tried by hand -> PASS (independently re-verified for four of the five rows plus an extra). See the mutant table below. The developer's record in the spec's implementation notes is also present.
- AC-27: all pgTAP files pass, including `permissive_policy_lint` and `generate_po_number_malformed_guard` -> PASS. 97 of 97 files (see Test run).
- AC-28: first-run prod checks -> PENDING (prod step, not attempted).
- AC-29: migration applied to prod and verified -> PENDING (prod step, not attempted).
- AC-30: client removal live before 2026-11-20 -> PENDING (prod step, not attempted).
- AC-31: 2026-08-22 PO still present on or after 2026-11-21 -> PENDING (prod step, not attempted).

Totals: AC-1 to AC-27 all PASS. 0 FAIL, 0 NOT TESTED. AC-28 to AC-31 PENDING.

### Mutants I ran
Each was a scratch copy of the test file, with the change inserted inside the test's own transaction (`BEGIN ... ROLLBACK`). Nothing was committed to the shared database, and the scratch files are deleted. Afterwards no `test 186` store or `__test_spec186__` audit row remains, and the three policies still read back.

| Temporary change | Result |
|---|---|
| Prune body is a no-op | FAIL as required: `A4-1`, `A4-2`, `A4-3`, `A4-4`, plus `A25` (arm 69). AC-5 and AC-6 arms still pass, as they should. |
| Prune also deletes old `po_items` and `purchase_orders` | FAIL as required: `A6-3` to `A6-6`, plus `A14-*`, `A15-*`, `A19-0`, `A21`. |
| All three restrictive policies dropped | FAIL as required: `P-1`, `A14-2/3` (rows already deleted by the admin attempt), `A19-0`, and the `A15`, `A16` and `A17` arms. |
| `create policy ... for delete using (true)` on `eod_submissions` | FAIL as required: `P-4` and `A16-4`. |

I did not re-run the 60-day and 120-day audit-cutoff mutants. The developer's table in the spec records both. They are covered by `A5-1` (89-day row) and `A4-1` to `A4-3` (91-day rows) as pinned above.

### Test run
- `bash scripts/test-db.sh supabase/tests/retention_prune_job.test.sql` -> PASS, 72 of 72 assertions. Re-checked with raw `psql`: 72 `ok` lines, no `not ok`.
- `bash scripts/test-db.sh` (whole pgTAP suite) -> 97 of 97 files pass, exit 0. The developer reported 96, and the extra file is spec 187's `order_approvals_approver_snapshot.test.sql`, which is another session's.
- `npx jest` (full, run alone) -> 296 of 296 suites, 3,771 of 3,771 tests, exit 0. The developer reported 3,770, and the extra test is from another session's in-progress work.
  - First attempt: one suite, `src/utils/minutesAfterDeadline.test.ts`, failed because its jest worker was killed (`SIGSEGV`). 295 of 296 suites and all 3,765 tests that ran passed. I had started the full jest run in parallel with the full pgTAP run, so that is load on a shared machine. The file passes alone (6 of 6), and the full run passes cleanly when run alone. It is not from this change: that file does not import anything from spec 186.
- `npm run typecheck:test` -> exit 0, no errors.
- `npm run typecheck` -> exit 2. The developer's report is accurate.
  - 24 errors, every one `TS2688 Cannot find type definition file for '<pkg> 2'`, and 0 errors of any other kind.
  - The cause is 24 empty `node_modules/@types/* 2` folders (e.g. `babel__core 2`, `react 2`, `yargs-parser 2`). `tsc` auto-includes every `@types` folder, so these stop it before it can report semantic errors. That means the plain run proves nothing about the code either way.
  - To rule out a hidden error without touching `node_modules`: `npx tsc -p tsconfig.json --noEmit --types <the 24 real @types packages, excluding the " 2" folders>` -> exit 0, 0 errors. So the change adds no type error. Spec 186's `db.ts` and `useStore.ts` edits are included in that run.
  - `typecheck:test` passes because `tsconfig.test.json` evidently names its types.
  - CI should not hit this, because a clean `npm ci` does not create `" 2"` folders. I did not confirm this, and I did not run `npm ci`.

Whose change caused what: no failure in this run traces to spec 186. The one jest failure was a load-induced worker crash and is not reproducible. The working tree also holds specs 187 to 189 edits (`audit_log_rls_hardening`, `profiles_rls_sweep`, `auth_can_see_store_brand_scope`, `delete-user`, `placeholderEmail`, the 187 migration and its test, plus `scripts/smoke-delete-user.sh`). All of them pass in the full pgTAP and jest runs.

### Notes: weak spots (none turn an AC to FAIL)
1. `A9-1` and `A9-2` compare reported against dropped, which would pass `0 = 0` on a no-op prune. `A4-1` to `A4-4` carry the "something was deleted" requirement. The no-op mutant fails A4 and A25 but not A9. Cheap hardening: assert the reported audit count is at least 3 and the reported invitation count at least 1.
2. `A17-8` and `A19-7` assert `count = 0` for rows whose existence the file only establishes by "the insert succeeded in this transaction". `A19-0` shows the AC-19 rows exist before the delete, so `A19-7` is sound. `A17-8` has no precondition for the 23-hour fixtures, and it does not check that the delete actually reported removing them (it deliberately skips `ok:N` because the statement reaches seed rows too). The inserts are in the same file, so the risk is low. A `count = 1` read just before the wrong-clock attempt would close it.
3. `F-1` does not cover the AC-17, AC-19, AC-20 and AC-22 fixtures. `A14-*`, `A19-0` and the `ok:1` row counts cover most of them. `A20` has no pre-state arm for the 200-day brand rows, and its `ok:1` comes from `select hard_delete_brand(...)`, which reports one row whatever it did. Its brand, store, PO, waste, POS and POS-line counts of zero are the real proof, and they cannot be NULL.
4. The `A14-2` and `A14-3` preconditions run after the admin block has attempted the old purge. If the protection were missing, those arms would fail for the "wrong" reason (rows already deleted) and still fail, so this does not hide a regression. It does make them an unreliable precondition when the protection is absent. The `A15-*` and `P-1` arms report that case accurately.
5. AC-11 and AC-12 are grep and diff evidence only. No automated test fails if `cleanupOldRecords` returns, other than the type error if a caller reappears. That matches the spec's own wording, so it is not a defect.
6. CI differences: CLI 2.106.0 in CI against the local 2.95.4 / 3.0.0 mix. `J-1` to `J-3` are the arms to watch on the first CI run. A failure there would be a loud count of 0 or `42501`, not a silent pass.

## Handoff
next_agent: NONE
prompt: Test report complete. 27 PASS, 0 FAIL, 0 NOT TESTED across AC-1 to AC-27; AC-28 to AC-31 PENDING (prod steps).
payload_paths:
  - specs/186-retention-purge-server-job/reviews/test-engineer.md
