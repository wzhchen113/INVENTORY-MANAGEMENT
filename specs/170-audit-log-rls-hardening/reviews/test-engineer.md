## Test report for spec 170

Scope: local stack only (no prod, no Supabase MCP). No implementation edits made. Scratch probes ran in rolled-back transactions against the local DB; scratch files live under the session scratchpad, not the repo.

### Acceptance criteria status
Test file abbreviations: NEW = `supabase/tests/audit_log_rls_hardening.test.sql`, PAR = `supabase/tests/super_admin_policy_parity.test.sql`.

- AC-1 (one migration; policy set; SELECT/INSERT byte-unchanged; no UPDATE policy; one DELETE policy; RESTRICTIVE kinds; lint clean) -> PASS. NEW::S-1 (exact six name/cmd/kind rows), S-2 (0 UPDATE policies), S-3 / S-4 (pinned pre-migration qual / with_check literals), S-5 (DELETE predicate shape, no with_check). `permissive_policy_lint.test.sql` 5/5 passes with no allowlist change. `git status` shows exactly one new migration (`20261022000000_audit_log_rls_hardening.sql`). Caveat: S-5 is a text pin only (see Finding 1).
- AC-2 (every new/changed policy has a spec 170 comment) -> PASS. NEW::S-6 (4 policies with `spec 170: ` description).
- AC-3 (staff on S1 reads 0 store-user rows) -> PASS. NEW::F-1 (fixture exists), R-1.
- AC-4 (staff still reads other S1 rows) -> PASS. NEW::R-2.
- AC-5 (admin and super_admin read both store-user actions) -> PASS. NEW::R-3 (admin), R-4 (super_admin).
- AC-6 (staff insert with user_id != uid or NULL -> 42501) -> PASS. NEW::I-1 (other profile), I-2 (NULL).
- AC-7 (staff insert, self-attributed ordinary action succeeds) -> PASS. NEW::I-3.
- AC-8 (staff/admin/super_admin x four server-only actions -> 42501) -> PASS. NEW::I-4..I-7 (staff), I-8..I-11 (admin), I-12..I-15 (super_admin). Arms use store_id=S1 and user_id=caller, so only policy (b) can be the refuser.
- AC-9 (admin inserts ordinary action on behalf of a staff profile) -> PASS. NEW::I-16.
- AC-10 (writers still write; row counts asserted) -> PASS. NEW::W-1 staff_submit_eod, W-2 staff_log_waste, W-3 record_missed_orders_for_day, W-4 copy_catalog_rows, W-5 service_role insert of 'Store user created', W-6 receive_purchase_order as staff (INVOKER). W-2/W-3 are called from an RLS-subject role via an in-txn grant, so they would fail if owner bypass broke. S-7 additionally pins RLS on / FORCE off / DEFINER owner = table owner.
- AC-11 (admin and super_admin UPDATE affects 0 rows; no UPDATE policy) -> PASS. NEW::U-1 (admin), U-2 (super_admin), S-2. PAR::AL-5 / AL-9 flipped to 0-row.
- AC-12 (fresh S1 row not deletable by admin or super_admin) -> PASS. NEW::D-1, D-2. Mutation-verified (see Finding 1).
- AC-13 (admin deletes 91-day S1 row) -> PASS. NEW::D-3. PAR::AL-6 (super_admin) and AL-10 (master) keep the aged-row parity.
- AC-14 (admin cannot delete a 91-day brand-B row) -> PASS as worded, but the arm does NOT prove the new DELETE store/brand scope. See Finding 1 (Medium coverage gap). NEW::D-4.
- AC-15 (store-less 91-day row: admin 0 rows, super_admin removes) -> PASS. NEW::D-5 (admin), D-6 (super_admin, a different row). Mutation-verified.
- AC-16 (staff cannot delete 91-day S1 row) -> PASS. NEW::D-7. Mutation-verified: dropping the `auth_is_privileged()` clause fails D-7.
- AC-17 (store delete cascades every audit row, fresh included) -> PASS. NEW::D-8 (superuser, test-only store S_tmp1) and D-9 (admin JWT through `privileged_delete_stores`, fresh row gone). Uses a test-only store rather than seed Towson, per the spec's section 10a interpretation note.
- AC-18 (audit_log delete line removed from `deleteStore`; other deletes and order unchanged; `cleanupOldRecords` unchanged) -> PASS (diff review). `git diff src/lib/db.ts` is a single hunk replacing the one `audit_log` delete line with a comment. The other six awaits are untouched and in the same order. No jest test references it.
- AC-19 (full pgTAP suite incl. updated super_admin_policy_parity) -> PASS. `88/88 DB test file(s) passed`. PAR 20/20, NEW 45/45.
- AC-20 (full jest + typecheck + typecheck:test) -> PASS.
- AC-21 (four smokes) -> PASS. All four exit 0.

Totals: 21 PASS, 0 FAIL, 0 NOT TESTED (AC-14 passes as worded but carries a Medium gap, below).

### Test run
- Preflight: `docker inspect supabase_edge_runtime_imr-inventory` mount source = `/host_mnt/Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/supabase/functions` (repo root, not a worktree). Restarted `supabase_edge_runtime_imr-inventory` before the smokes. Local DB already had the migration applied (six policies present in `pg_policies`).
- `bash scripts/test-db.sh` -> `✓ 88/88 DB test file(s) passed`, exit 0. Relevant files: `audit_log_rls_hardening.test.sql` (45 assertion(s) passed), `super_admin_policy_parity.test.sql` (20 passed), `permissive_policy_lint.test.sql` (5 passed), `actor_fk_cascade_audit.test.sql` (13 passed).
- `npx jest` -> `Test Suites: 234 passed, 234 total`, `Tests: 2846 passed, 2846 total`, `Snapshots: 2 passed, 2 total`, exit 0.
- `npm run typecheck` -> exit 0. `npm run typecheck:test` -> exit 0.
- `bash scripts/smoke-store-user.sh` -> exit 0 ("ALL ARMS PASSED", 97 PASS lines, no FAIL marks; grep "FAIL" hits are arm titles only).
- `bash scripts/smoke-edge-roles.sh` -> exit 0 (26 PASS, 0 fail).
- `bash scripts/smoke-staff-eod.sh` -> exit 0 (19 PASS, 0 fail).
- `bash scripts/smoke-rpc.sh` -> exit 0 ("✓ all checks passed", 4 PASS).
- N4 check: none of smoke-staff-eod / smoke-edge-roles / smoke-rpc touch `audit_log` through PostgREST (grep empty); smoke-store-user mutates it via psql as postgres only.

### Findings

**Finding 1 (Medium, test gap, does not change observable behavior today): D-4 does not prove the new DELETE store/brand scope.**
The developer's claim is correct, and I verified it empirically. A DELETE with a `WHERE` that references columns also applies the table's SELECT policies. `store_member_read_audit_log` already hides brand-B rows from a brand-A admin, so the `where id = <SB row>` delete finds 0 candidate rows whatever `admin_delete_audit_log` says.

Evidence (rolled-back probes, admin brand-A JWT, 91-day brand-B row f3):
- `where id = f3`, old spec-157 `using (auth_is_privileged())` policy: f3 survives. Same result under the new policy. D-4 cannot tell them apart.
- `where id = f3` with the new policy but the scope clause replaced by `store_id is not null` (mutant M1): f3 survives.
- Mutant M6, scope clause neutralised but its text kept (`auth_can_see_store(store_id) or true`) with the spec 170 comment kept: **all 45 NEW arms pass** (`ok` count = 45, no `not ok`). So the `auth_can_see_store(store_id)` clause in `admin_delete_audit_log` is behaviorally unproven. S-5 pins it only as text, and S-5 would catch a plain deletion of the clause (M1 fails S-5) but not a logically dead one.
- Mutation results for the other predicate parts, all caught behaviorally:
  - age gate removed: D-1 and D-2 fail
  - `auth_is_privileged()` removed: D-7 fails
  - store-less arm opened to admin: D-5 fails
  - full revert to the spec-157 policy: D-1, D-2 and D-5 fail

So three of four predicate clauses are proven. The store/brand scope clause is the only one that is not. It is currently redundant with the SELECT policy for any DELETE that has a column-referencing WHERE (including `cleanupOldRecords`), so there is no live exposure. It is the spec's stated closure of spec 157 FUTURE-1, though, and it is the only defence if a wide permissive SELECT policy is ever added or the DELETE has no column-referencing WHERE.

What is missing: one arm where the SELECT policy cannot mask the DELETE policy. Both variants below were verified to distinguish the real policy from mutants M1 and the old policy.
- Option A (preferred, keeps fixture isolation): after the S1/brand-A arms, as postgres inside the admin section, `create policy probe_wide_select on public.audit_log for select using (true);` (rolled back with the txn). Then as admin brand-A, `delete from public.audit_log where id = <91-day brand-B fixture>`. Read back as postgres: row survives. Use a fresh brand-B fixture, not D-4's. Result observed: old policy deletes it, new policy keeps it, M1 deletes it.
- Option B: as admin, an unconditional `delete from public.audit_log;`. With no column reference in the query, Postgres applies no SELECT policy. Observed: new policy deletes only the aged in-scope S1 row, and the aged brand-B row survives; M1 deletes it. Caveat: it also removes other aged in-scope fixtures such as the D-7 row, so it must run after, or on a fixture set separate from, the D-7 read-back. Option A avoids this.

Either way `plan(45)` becomes `plan(46)`, and the header arm map should note D-4's limit (D-4 stays as the AC-14 behavioral arm). Optionally harden S-5 or add an arm for the store-less path with the same wide-SELECT trick. Store-less admin deletion (D-5) is already behaviorally proven because the SELECT policy admits store-less rows to privileged callers.

I mark this Medium rather than Critical: AC-14's observable contract holds and is verified, and no behavior regresses. Whether to hold the release for the extra arm is the coordinator's and owner's call. I would add it before ship, since it is a single in-txn arm and the spec presents the scope as a main deliverable.

**Finding 2 (Info): S-7 and D-8/D-9 notes.**
D-8 deletes as superuser, so on its own it proves only the FK action. D-9 covers the RLS bypass on the admin path, as designed.

**Finding 3 (Info, process): the db-migrations-applied gate.**
The migration is untracked and unapplied to prod, as the spec states (out of scope). `db-migrations-applied.yml` goes red on push until the owner applies it. Per CLAUDE.md the release-coordinator cannot recommend SHIP_READY while a gate is red. I did not check CI or prod (local only).

### Notes
- No new test framework introduced. All new tests are pgTAP (existing track).
- Native/UI: no UI change, nothing to test there.
- Not run: `smoke-edge.sh`, `smoke-send-email-hook.sh` (not in the requested set).

## Delta re-review (fix pass) — 2026-10-22

Scope: local stack only (no prod, no Supabase MCP). Reviewed the UNSTAGED diff on the migration, `audit_log_rls_hardening.test.sql`, `super_admin_policy_parity.test.sql`, `src/lib/db.ts` and the spec. No implementation or test edits made. Mutation probes ran as scratch copies of the test file (mutation SQL injected after the file's `begin;`, discarded by the file's own `rollback;`) under the session scratchpad; nothing persisted in the local DB (post-probe `pg_policies` shows the 7 expected policies, `admin_delete_audit_log` and `audit_log_restrict_insert_created_at_now` with their real predicates).

### Prior Finding 1 (AC-14 store/brand scope unproven) -> CLOSED
D-10 (plan 54, arm 54) is the clause-isolating arm: as postgres it adds `probe_wide_select ... for select using (true)`, records as the brand-A admin that the 91-day brand-B row is visible (`test.d10_visible = '1'`, so the arm cannot pass vacuously), attempts the DELETE, drops the probe, then asserts the row survives and the probe policy is gone. Verified by mutation (each mutant = full arm-map run of the NEW file, `not ok` lines only; S-6 also fails in every mutant because my recreated policies carry no `spec 170:` comment, which is expected noise):
- M6 `auth_can_see_store(store_id) or true` (my original mutant): only S-6 and **D-10 fail** (previously all 45 passed). Note S-5 still passes for M6, so D-10 is the sole behavioural catcher.
- M1 scope clause replaced by `store_id is not null`: S-5 and **D-10 fail**.
- Old spec 157 policy `using (auth_is_privileged())`: S-5, D-1, D-2, D-5, **D-10** fail.
- Control (no mutation): all pass. Restoration: the scratch txns rolled back; live policy set re-queried and correct; a clean `bash scripts/test-db.sh` run before the probes was already green.
D-10's probe is dropped before the super_admin block, so it does not mask later arms (control run is clean). AC-14 is now PASS with real proof of the DELETE scope clause. (D-4 stays as the SELECT-masked PostgREST-shaped arm, now honestly labelled.)

### New/changed acceptance criteria
- AC-14 (admin cannot delete a 91-day brand-B row) -> PASS. NEW::D-4 (PostgREST-shaped) and NEW::D-10 (scope clause isolated; mutation-verified).
- AC-22 (staff on S1 and admin brand A rejected 42501 for explicit future / NULL / past `created_at`) -> PASS. NEW::C-1 (staff future), C-2 (staff NULL), C-3 (staff past), C-5 (admin future), C-6 (admin NULL), C-7 (admin past). Each arm uses store S1, `user_id` = caller, ordinary action, so permissive policy, (b) and (c) all admit and only `audit_log_restrict_insert_created_at_now` can refuse. Mutation-verified:
  - policy dropped: S-1, C-1, C-2, C-3, C-5, C-6, C-7 fail
  - `created_at is null or created_at = now()`: C-2, C-6 fail
  - `created_at <= now()`: C-3, C-7 fail
  - `created_at >= now() - 1 day`: C-1, C-5 fail
  - `= now()` (real): clean
- AC-23 (same inserts with `created_at` omitted succeed; every AC-10 writer still writes) -> PASS. NEW::C-4 (staff), C-8 (admin), W-1..W-6 (unchanged, all still pass with the new restrictive policy). Positive-arm mutation checks: `with check (false)` fails I-3 and C-4 (the script then aborts at the W-4 direct call, so later arms did not run, which is why I also ran the next probe); `created_at = now() and not auth_is_privileged()` fails exactly I-16 and C-8 (admin only), with C-5..C-7 unchanged.
- AC-1 (policy set) -> PASS, updated expectation: S-1 now asserts seven policies (adds `audit_log_restrict_insert_created_at_now/INSERT/RESTRICTIVE`), S-6 asserts five carry a `spec 170:` comment. `permissive_policy_lint.test.sql` 5/5, no allowlist change (the new policy is RESTRICTIVE).
- AC-2, AC-3..AC-13, AC-15..AC-21 -> PASS, unchanged (re-run green; see counts). AL-8 re-age: PAR::AL-8's fixture is now `now() - 91 days` and in the plain user's own store, so the age gate and `auth_can_see_store` both admit it and only `auth_is_privileged()` can refuse. Mutation-verified: dropping the `auth_is_privileged()` clause from `admin_delete_audit_log` now fails PAR::AL-8 (it did not with the old fresh-row fixture, per the fix-pass rationale) and NEW::D-7. AL-7 is correctly relabelled as default-deny (no UPDATE policy).
- AC-18 (db.ts) -> PASS. Fix-pass diff to `src/lib/db.ts` is a comment-only change on the `deleteStore` header; no behaviour change.

Totals after fix pass: 23 PASS, 0 FAIL, 0 NOT TESTED (AC-1..AC-23).

### Test run (fix pass)
- Preflight: edge runtime bind mount = `/host_mnt/Users/will/Documents/GitHub/INVENTORY-MANAGEMENT/supabase/functions` (repo root, not a worktree). Restarted `supabase_edge_runtime_imr-inventory` before the smokes. Local DB already carried the updated migration (7 `audit_log` policies including `audit_log_restrict_insert_created_at_now`).
- `bash scripts/test-db.sh` -> `✓ 88/88 DB test file(s) passed`, exit 0. `audit_log_rls_hardening.test.sql` (54 assertion(s) passed), `super_admin_policy_parity.test.sql` (20 passed), `permissive_policy_lint.test.sql` (5 passed), `actor_fk_cascade_audit.test.sql` (13 passed).
- `npx jest` -> `Test Suites: 234 passed, 234 total`, `Tests: 2849 passed, 2849 total`, `Snapshots: 2 passed, 2 total`, exit 0. I ran it 5 times in total; all 5 exited 0 with identical counts. The developer's one-in-three jest worker crash did **not** reproduce, so I cannot name the suite. No `FAIL`, "crash" or "worker" lines in any run. The prior report's count was 2846 tests; the +3 is not from this fix pass (no jest-tracked file is in the unstaged diff), so I attribute it to other staged work (e.g. spec 167/169 jest files) that landed between reviews. Not verified further.
- `npm run typecheck` -> exit 0. `npm run typecheck:test` -> exit 0.
- `bash scripts/smoke-store-user.sh` -> exit 0 ("ALL ARMS PASSED", 97 PASS lines).
- `bash scripts/smoke-edge-roles.sh` -> exit 0.
- `bash scripts/smoke-staff-eod.sh` -> exit 0 ("all checks passed").
- `bash scripts/smoke-rpc.sh` -> exit 0 ("all checks passed").

### Notes (fix pass)
- No new test framework. All new coverage is pgTAP.
- Residual, Info only: `created_at = now()` is `now()` of the transaction. A multi-statement staff txn with a long run still passes, which is intended. C-4/C-8 prove the omitted-default path via direct INSERT; the real client path (`addAuditEvent`) omits `created_at` per the migration comment, and I did not additionally drive it through PostgREST.
- Residual, Info: the `with check (false)` mutant aborts the file at W-4, so positive-arm checks for admin were done via the privileged-only mutant instead. Both positive arms (C-4, C-8) are shown to fail under a mutant.
- Process (unchanged): the migration is unapplied to prod by design, so `db-migrations-applied.yml` will go red after push until the owner applies it. CI state not checked (local only).
