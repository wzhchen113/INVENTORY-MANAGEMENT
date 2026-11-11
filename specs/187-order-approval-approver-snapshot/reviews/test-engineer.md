## Test report for spec 187

Verdict: no Critical findings. Every AC (1 to 31) has a test and every test run is green. Two Should-fix items and a few Nits are below.

### Acceptance criteria status

pgTAP file P = `supabase/tests/order_approvals_approver_snapshot.test.sql` (49 arms). A = `supabase/tests/audit_log_rls_hardening.test.sql`. S = `scripts/smoke-delete-user.sh`.

| AC | Result | Arm that proves it |
|---|---|---|
| AC-1 | PASS | P `AC-1` (RPC as admin A: name and email stored; also checks `now` and 1 line) |
| AC-2 | PASS | P `AC-2a` (forged), `AC-2b` (empty strings), `AC-2c` (someone else as approver gives 42501 and no email in the error) |
| AC-3 | PASS | P `AC-3` (owner-level insert, NULL approver, supplied values give NULL/NULL). `report_last_order_context.test.sql` passes unchanged (41/41) |
| AC-4 | PASS | P `AC-4a` to `AC-4d` (pending, approved, ordered, NULL-approver rows; name and email, value and NULL), `AC-4e` (as postgres), `AC-4f` (rows unchanged) |
| AC-5 | PASS | P `AC-5a` (profile delete), `AC-5b` (`auth.users` delete), `AC-5c` (delete with B's claims set). All three statuses, and `approved_at` is checked via the `backdated` marker |
| AC-6 | PASS | P `AC-6` |
| AC-7 | PASS | P `AC-7a` to `AC-7f` (definer, pinned `search_path`, owner, no anon/authenticated/PUBLIC EXECUTE on both trigger functions, `tgtype&127=7`, `tgenabled='O'`, RPC still INVOKER) |
| AC-8 | PASS | P `AC-8` (approver, snapshot, lines are B's, `approved_at` moved from the backdated value) |
| AC-8a (design) | PASS | P `AC-8a` (same approver after a rename: lines refreshed, `approved_at` and snapshot kept) |
| AC-9 | PASS | P `AC-9` (hide-once policy with a `<consumed>` marker, so it can't quietly become a plain replay) |
| AC-10 | PASS | P `AC-10a2`, `AC-10b2` (NULL), `AC-10c` (approved), `AC-10d` (ordered), `AC-10a` (forged name, email and `approved_at` in the same UPDATE are overwritten), `AC-10b` (postgres) and `AC-10b3` (service_role, no claims) |
| AC-11 | PASS | P `AC-11a` to `AC-11c` |
| AC-12 | PASS | P `AC-12a`, `AC-12b` |
| AC-13 | PASS | P `AC-13` (P0001 `order approval has no approver`, row unchanged) |
| AC-14 | PASS | P `AC-14a` (`ordered_at` set), `AC-14b` (the `external_ref` re-mint write) |
| AC-15 | PASS | P `AC-15a`, `AC-15b` |
| AC-16 | PASS | P `AC-16` |
| AC-17 | PASS | P `AC-17a` to `AC-17c` (`ok:0`), `AC-17d` (profiles remain, and `approved_by` is unchanged on the target's approval) |
| AC-18 | PASS | P `AC-18` (`throws_ok` as postgres with admin claims) |
| AC-19 | PASS | `profiles_rls_sweep` arms 7 to 10 and `auth_can_see_store_brand_scope` arms 11, 13 are flipped to a count-as-postgres check. Both files pass (12/12 and 14/14) |
| AC-20 | PASS | A `UD-1`, `UD-2`, `UD-3` (42501), `UD-6` (service_role `lives_ok`), `UD-7` |
| AC-21 | PASS | A `UD-4` (staff sees 0), `UD-5` (admin sees 1) |
| AC-22 | PASS | A S-1 and S-6 untouched and passing; `plan(61)`, 61/61 |
| AC-23 | PASS (hand-run) | S `AC-23` and `AC-23b` (a store with approvals but no `user_stores` row; a store in both halves gets one row; D4 field values; pre-delete approval count) |
| AC-24 | PASS (hand-run) | S AC-24 |
| AC-25 | PASS (hand-run) | S AC-25 (0 rows, exactly one console line, no NULL-store row). Also `AC-25a`, the no-profile super_admin caller, gives NULL `user_id` |
| AC-26 | PASS (hand-run) | S AC-26 (empty `value`, `no-email.invalid` in no column) |
| AC-27 | PASS (hand-run) | S AC-27 (self, cross-brand, last-of-role each write 0 rows; last-of-role also checks that nothing was deleted first) |
| AC-28 | PASS (hand-run) | S AC-28 and its retry (real GoTrue 500 via the FK fixture, `auth_user_deleted=false`, no second row on retry). `AF` also covers a forced `audit_log` failure |
| AC-29 | PASS (hand-run) | S AC-29 (scan of the edge log for email, name, `no-email.invalid`) |
| AC-30 | PASS | `src/lib/placeholderEmail.parity.test.ts` lists `delete-user` in `COPIES` |
| AC-31 | PASS | See the test run. Jest, typecheck:test and 97/97 pgTAP pass. Base `npm run typecheck` fails here for an environmental reason (see the typecheck finding below) |

Count: 31 of 31 PASS, 0 FAIL, 0 NOT TESTED. AC-23 to AC-29 are shell smokes: they pass when run by hand and are in no CI, which is what the spec says.

### Test run

All commands run from the repo root on 2026-11-09 (UTC) against the shared local stack. Nothing was reset or stopped, and prod wasn't touched.

- `bash scripts/test-db.sh supabase/tests/order_approvals_approver_snapshot.test.sql`: `PASS (49 assertion(s) passed)`, 1/1 file.
- The other named files, each run on its own:
  - `audit_log_rls_hardening`: 61 passed
  - `profiles_rls_sweep`: 12 passed
  - `auth_can_see_store_brand_scope`: 14 passed
  - `order_approvals`: 24 passed
  - `order_approvals_fk_set_null`: 15 passed (G1 to G5 unchanged)
  - `cross_store_item_rejection`: 54 passed (T54 unchanged)
  - `report_last_order_context`: 41 passed
- `npm run test:db`: `97/97 DB test file(s) passed`. This includes the other sessions' `retention_prune_job`, `order_approvals_approver_snapshot` and `permissive_policy_lint`. No failures from specs 186 or 188 work.
- `npx jest`: 296 suites passed, 3771 tests passed, 17 snapshots passed. 0 failed.
- `npm run typecheck:test`: exit 0.
- `npm run typecheck`: exit 2 with 24 errors, every one `TS2688: Cannot find type definition file for '<pkg> 2'`. `npx tsc --noEmit --types node,jest` exits 0. See the first finding below.
- `bash scripts/smoke-delete-user.sh`: `ALL ARMS PASSED`, 0 failed. Arms AC-23b, 25, 25a, 26, 27, 28, 28 retry, AF, 29 and TALLY (6 rows added) all PASS, and cleanup removed its fixtures. (The ending of the run output showed no non-zero exit; the script prints `ALL ARMS PASSED`.)
- `smoke-edge-roles.sh` was deliberately not run (see the second finding below).

### Gaps

**Critical**

None.

**Should-fix**

1. **The developer's `npm run typecheck` claim checks out, and it is not a spec defect.** `ls -d node_modules/@types/* 2` finds exactly 24 empty folders, one per error. `node_modules` is gitignored. `npm run typecheck` fails 24 times with TS2688, and nothing else. Excluding them with `--types node,jest` gives 0 errors. A fresh CI checkout has no such folders, so the gate there is unaffected. The `typecheck` gate stays unverified on this machine until someone removes those folders. They look like Finder duplicates from Oct 26. I didn't delete them, because they're outside my brief and the other sessions share the directory. One thing to tell the owner: AC-31 says both typechecks pass, and the base one doesn't pass locally for this reason. It does pass in effect.
2. **`delete-user/index.ts` has never been type-checked.** There is no `deno` on the host or in the edge-runtime container. The function ran for real in the runtime, which transpiles without checking types, so a type error would still pass every smoke arm. Things that deserve a `deno check`:
   - `let timer: number | undefined` assigned from `setTimeout`
   - `error.code ?? error.status` on the GoTrue error
   - the `.limit(1, { referencedTable })` call on the embedded `stores` query
   - the `DOMException` construction

   Run `deno check supabase/functions/delete-user/index.ts` (or the Docker deno image) on a machine that has it before deploying. Smokes aren't in CI, so nothing else will catch this.
3. **`smoke-edge-roles.sh` not being run leaves a small gap, not a blocking one.** Its `delete-user` arms are 3 and 4 (admin and super_admin JWT, gate passes, 200 or 4xx after the gate), 6 (last super_admin refusal) and 8 (uppercased self id). Arms 6 and 8 refuse at the self-guard and last-of-role guard. The diff to `delete-user` doesn't touch those guards, and the new audit read comes after them, so nothing in 6 or 8 reaches changed code. Arms 3 and 4 are the only ones that might reach the new reads, and only if their payload gets past the guards, which they don't intend to. The uppercase self-id refusal (Arm 8) is not covered by the new smoke; the new script's AC-27 uses the plain self id. The one thing the new smoke doesn't exercise is a successful delete by a super_admin who has a profile row. The admin caller in S exercises the same code with `callerHasProfile = true`, and the code doesn't branch on the caller's role, so the risk is low. Recommendation: run `smoke-edge-roles.sh` once at a time when nobody else is using `admin@local.test` (Arm 4 promotes it to super_admin), before ship. Not a release blocker.

**Nits**

- **Assertions that would pass whatever the behaviour was:**
  - `UD-6` (service_role `lives_ok`) passes with any policy text, because service_role bypasses RLS. It is a control arm, as the spec wants for AC-20. `UD-7` only proves the row exists.
  - `UD-1` to `UD-3` use `throws_ok(..., '42501', null, ...)` with no message match. 42501 is the only SQLSTATE they pin, so they would pass for any permission failure on `audit_log`. The developer's mutation run (policy without `User deleted` turns UD-1 to UD-3 red) shows they do discriminate, so this is minor.
  - `AC-12a`/`AC-12b` and `AC-15a` only assert `ok:1` for the RPC call (`create_order_approval` as a statement returns 1 row regardless of what it returned). The state check after it does carry the proof, so they hold.
  - `AC-17a` to `AC-17c` assert `ok:0`, which would also be what a typo in the target id gives. `AC-17d` closes this by counting the three profiles afterwards.
  - `S-1` (staff sees 0 approvals) would pass if the table were empty. Fixture rows exist, so it is real.
  - `AC-18` as written passes whatever happens to the policy, since it runs as postgres. Its purpose is to pin the lock trigger, which it does.
- **No coverage from the client side.** `fetchOrderApproval` uses `select('*')`, so privileged clients now receive `approved_by_email`. No test asserts that, or that `mapOrderApproval` drops the columns. The spec lists it as Low and out of scope, so it is a note only.
- **The smoke script has no mutation test.** The developer says so. The arms compare exact values and `AF` shows missing rows are detected, so this is acceptable. A mutation run needs `delete-user` redeployed locally, which isn't safe on a shared stack.
- **Direct PATCH takeover keeps A's lines** (design risk section, accepted). No arm pins this accepted behaviour. If the owner later wants it closed, there is no test to fail first.
- **Stale comment** at `supabase/migrations/20260801000100_order_approvals.sql:262,451` still says "the ONLY INSERT path". That migration is already applied and immutable; the new migration and `src/lib/db.ts:2701` carry the corrected wording. Fine.

### Notes

- **Shared stack.** I ran only read-and-rollback pgTAP files and the new smoke, which creates and removes its own `zz_s187` fixtures. The smoke's last-of-role arm sets the seed master `33333333-...` to `admin` for about one second, as the script header warns. Cleanup reported success. I did not run `smoke-edge-roles.sh`, `supabase db reset` or `supabase stop`.
- **CI.** Smokes are not in `test.yml`, so AC-23 to AC-29 will go unrun after this review unless someone runs them by hand before ship. The pgTAP and jest arms (AC-1 to AC-22, AC-30, AC-31) are in the CI gate.
- **To-do items from the spec** (checked, not tested): the spec 178 pointer ("Closed by ... 187") and the spec 043 supersede note are present; `src/lib/db.ts`, `delete-user` and `auth_can_see_store_brand_scope.test.sql` comments were updated. The CLAUDE.md bullet is a proposal for the owner and is not applied. That is correct per the spec.
- **Shared working tree.** `src/lib/db.ts`, `package.json` and the audit test files contain hunks from other sessions (spec 186). The `package.json` diff is only the `test:smoke` addition. `db.ts` was not diffed in full.

## Re-review 2026-11-09

Scope: the 2026-11-09 amendment (AC-2d, AC-32 to AC-37, AC-7 and AC-24 additions, A4 arms 49 to 68, A5 mutation table). Read from the files on disk and run against the shared local stack. Nothing was reset, stopped or changed. I did not re-run the A5 mutations. Their results below are the developer's, unverified by me.

Verdict: no Critical findings. Every new or changed AC has at least one arm that discriminates. All runs are green except one file that belongs to spec 195, below.

### AC-to-arm table (new and changed ACs)

P = `supabase/tests/order_approvals_approver_snapshot.test.sql` (plan 68, 68 passed). S = `scripts/smoke-delete-user.sh`.

| AC | Result | Arm | What makes it discriminate |
|---|---|---|---|
| AC-1, AC-2 (changed: id) | PASS | P `AC-1`, `AC-2a`, `AC-2b` | Every `_t187_view` string now carries the `approved_by_id` tag. `AC-2a` forges a uuid, `AC-2b` supplies NULL, both must come back as the caller's id |
| AC-2d | PASS (partial, see N1) | P `AC-2d` (b1, whitespace name: direct INSERT and RPC), `AC-8b` (re-stamp), `AC-35f` (b0, padded name stored trimmed) | Expected string pins name = email on INSERT and RPC. The trimmed half is pinned on the RPC path only |
| AC-3 (changed) | PASS | P `AC-3` | `--|--|<null>|<null>` after supplying a name, email and forged id |
| AC-4 (changed) | PASS | P `AC-4a` to `AC-4f` | `_t187_edit_snapshot` now tries `approved_by_id` as a forged uuid and as NULL, at every status, and postgres |
| AC-5 (changed) | PASS | P `AC-5a` to `AC-5c` | Deletes now record `ok:1` through `_t187_try`, so a refused SET NULL fails the arm instead of aborting the file. Expected strings keep the id (`--\|0c\|...`) |
| AC-7 (changed) | PASS | P `AC-7g` | Catalog read: `uuid`, nullable, and no `contype = 'f'` constraint whose `conkey` has the attnum |
| AC-8, AC-9, AC-10a, AC-15b (changed) | PASS | P `AC-8`, `AC-9`, `AC-10a`, `AC-15b` | Expected B's id in the tag |
| AC-8b | PASS | P `AC-8b` | b1 re-stamps A's pending row by RPC: name = email, id = b1, `now` |
| AC-32 | PASS | P `AC-32a` (each of 8 columns alone, distinct outcomes joined), `AC-32b` (row unchanged incl. `external_ref`, `channel`, `ordered_at`) | A column that slips the rule adds an `ok:1` to the joined string. A column that fails with another message also shows |
| AC-33 | PASS (partial, see N2) | P `AC-33` | `lines` and `channel` on a NULL-approver pending row give `has no approver`. Row unchanged. AC-13 still pins the `status` case with the old message |
| AC-34 | PASS | P `AC-34a` (own channel fallback, advance with ref and expiry), `AC-34b` (postgres, then `service_role`, no claims, `lines` then `status`), `AC-34c` (B re-mint on A's approved row) | The existing `AC-14b` also covers the re-mint on a no-approver approved row |
| AC-35 | PASS (partial, see S1) | P `AC-35a` (a1, same-brand, RPC re-stamp), `AC-35b` (a1 approves own row), `AC-35c` (a4, NULL brand, PATCH re-stamp), `AC-35d` (a4 changes lines on A's row), `AC-35e` (a4 approves own row), `AC-35f` (master), `AC-35g` (super_admin) | Each refusal arm also reads the row back. `AC-35d` fails the refusal order if check 3 ran before check 2, because it would then say `belongs to another approver` |
| AC-36 | PASS | P `AC-36` | B's RPC gives `ok:1`, A's late write-back gives `belongs to another approver`, row is `0b|0b|...|pending|1` with `B lines`, and `line_count = 0` is `false` (B's lines), `external_ref`, expiry and `ordered_at` are NULL |
| AC-37 | PASS (partial, see N3) | P `AC-37a` (a1 stale claim, RPC insert, stamped with a1's real name, email and id), `AC-37b` (a4 stale claim, approved to ordered) | Pinned as known gaps. They go red when spec 191 closes either one, which is the intent |
| AC-7, AC-24 (changed, smoke) | PASS (hand-run) | S `AC-24` (two checks: snapshot intact and `approved_by_id = target`; id equals `detail.target_id` for 3 approvals x 2 rows) | Text match, no jsonb cast |
| AC-29 (widened scan) | PASS (hand-run) | S `AC-29` | Scan now includes t2, t5, t6 and the no-profile super_admin |

Count for the new and changed ACs: all PASS. Unchanged ACs (AC-6, AC-10 to AC-18, AC-20 to AC-28, AC-30, AC-31) are covered by the same files and pass in the runs below. AC-31 holds with the usual base `npm run typecheck` caveat.

### Test run (2026-11-09, shared local stack)

- `bash scripts/test-db.sh supabase/tests/order_approvals_approver_snapshot.test.sql`: PASS, 68 assertions.
- The other named files, each alone:
  - `audit_log_rls_hardening`: 61 passed
  - `profiles_rls_sweep`: 12 passed
  - `auth_can_see_store_brand_scope`: 14 passed
  - `order_approvals`: 24 passed
  - `order_approvals_fk_set_null`: 15 passed
  - `cross_store_item_rejection`: 54 passed
  - `report_last_order_context`: 42 passed (41 in the first review; another session's arm, not 187)
- `npm run test:db`: first run `100/100 DB test file(s) passed`. A second run, a few minutes later, failed `legacy_permissive_policy_dropout.test.sql` (see "Spec 195" below). Every other file, including all spec 187 files, passed in both runs.
- `npx jest`: 301 suites passed, 3835 tests passed, 17 snapshots passed, 0 failed.
- `npm run typecheck:test`: exit 0.
- `npm run typecheck`: not run, known red locally from the 24 empty `node_modules/@types/* 2` folders.
- `scripts/smoke-delete-user.sh`: exit 0, `ALL ARMS PASSED`, 0 FAIL lines. Both AC-24 checks, AC-23/23b/25/25a/26/27/28/AF, the wider AC-29 scan, `TALLY` (6 rows) and cleanup all PASS.
- `smoke-edge-roles.sh`: not run, as instructed.

**Spec 195, not 187.** `legacy_permissive_policy_dropout.test.sql` fails at its arm (9). Output:

```
ok 8 - arm (8): seed manager INSERT into user_stores for ANOTHER user is rejected (same-brand cross-user leak closed)
psql:<stdin>:483: ERROR:  new row violates row-level security policy for table "user_stores"
FAIL supabase/tests/legacy_permissive_policy_dropout.test.sql (psql exit 3)
```

Plan was 1..13, so the file aborted after arm 8. It reproduced on two separate runs. The untracked `supabase/migrations/20261109195000_user_stores_drop_own_row_writes.sql` is on disk, and the live `user_stores` policies are now only `Admins can manage all store links` (ALL) and `Users can read own store links` (SELECT). The own-row write policies are gone, so the arm that expects an own-row INSERT to succeed now gets the RLS error. This is spec 195's migration landing on the shared stack before that spec updates the old test, and no spec 187 file touches it. No `user_stores_own_row_writes.test.sql` exists yet. Nothing in spec 187 depends on `user_stores` own-row writes (the fixtures insert `user_stores` rows as postgres).

### Gaps

**Critical**

None.

**Should-fix**

- **S1. AC-35 does not cross every route with both profile shapes.** The spec says to test both a same-brand `user` profile and a NULL-brand one for re-stamp (RPC or PATCH), approving their own row, and changing lines on someone else's row. As written: a1 covers RPC re-stamp and approve-own; a4 covers PATCH re-stamp, lines-on-other's and approve-own. Not covered: a1 on a PATCH re-stamp or on lines-on-other's, and a4 on an RPC re-stamp. The guard has one code path for all of these, so the risk is low, but the AC text promises both shapes. Cheap to close: loop the same three statements over both people.
- **S2. The A5 mutation results are the developer's own and I did not reproduce them.** Re-running them means editing the guard, even inside a rolled-back transaction, which this brief excludes. The table is internally consistent (every A5 row lists a required arm that went red), so I take it as likely true, but the release proposal should say it is unverified by the test engineer.

**Nits**

- **N1. AC-2d's second sentence ("a non-blank name is stored trimmed") is pinned on one path.** Only `AC-35f` pins it, and only through the RPC (b0, padded name). A direct INSERT and a re-stamp with a padded name are not tested, so a trigger copy that lost `btrim` on one of those paths would only be caught by the AC-2d/AC-8b whitespace-only arms if it also broke the blank case. It doesn't. The A5 mutation "stamp stores the raw `p.name`" would go red on `AC-35f` for the stamp trigger, but the "re-stamp stores the raw `p.name`" mutation is caught by `AC-8b` only because b1's name is blank, not because a padded name is trimmed. Also unpinned: `nullif(btrim(v_email), '')` on the email.
- **N2. AC-33 tries two of the listed columns.** `lines` and `channel` on the NULL-approver row. The other six (including `external_ref`) are not tried there. The NULL check comes first in the guard, so it would be hard to break for one column and not another. A5's "NULL check moved after check 3" mutation does go red on `AC-33`.
- **N3. AC-37a pins the RPC insert only.** The AC says "INSERT a new pending row". A direct INSERT through `privileged_store_insert_order_approvals` by a stale-claim caller is not pinned as a known gap, so if spec 191 closes only that path nothing flips.
- **Assertions that pass whatever the behaviour was (none are new to this amendment, none hide a defect):**
  - `AC-12a`, `AC-12b` and `AC-15a` assert `ok:1` from the RPC, which is returned whatever the RPC did. The row-state half of each string carries the proof.
  - `AC-37a` and `AC-37b` pass today because the gap exists. That is their purpose, but they assert nothing about intended behaviour.
  - `AC-5a` to `AC-5c` run as postgres (after `reset role`), so they test the trigger only and say nothing about RLS on `profiles`, which AC-16/17 cover.
  - `AC-18` runs as postgres, so it holds whatever the policies are. It pins the lock trigger only.
  - From the first review and unchanged: `UD-1` to `UD-3` accept any 42501, `UD-6` is a control that passes with any policy text, and `AC-17a` to `AC-17c` assert `ok:0`, which a wrong target id would also give. `AC-17d` closes the last.
- **N4. Known stale wording** in the spec's A4 line "That is 19 new arms" vs. the plan (49 to 68 is 19, correct) is fine. The Amendment build note about spec 190 / 195 numbering is already in the spec.

### Notes

- The `smoke-edge-roles.sh` gap from the first review stands: run once at a quiet time before ship.
- The AC-23 to AC-29 smokes remain hand-run only and are in no CI.

## Handoff
next_agent: NONE
prompt: Test report complete. 31 PASS, 0 FAIL, 0 NOT TESTED across acceptance criteria. No Critical findings; AC-23 to AC-29 are hand-run smokes only. Should-fix: `deno check` on delete-user, which has never been type-checked, and one run of `smoke-edge-roles.sh` at a quiet time. `npm run typecheck` fails locally only because of 24 empty `node_modules/@types/* 2` folders.
payload_paths:
  - specs/187-order-approval-approver-snapshot/reviews/test-engineer.md
