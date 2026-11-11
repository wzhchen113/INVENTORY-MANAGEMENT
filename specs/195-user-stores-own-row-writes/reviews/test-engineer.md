## Test report for spec 195

Reviewed 2026-11-09 against the local shared stack. No code or tests were changed. No `db reset`, `stop`, or `smoke-edge-roles.sh`.

### Acceptance criteria status
Arm numbers (T1-T23) are from `supabase/tests/user_stores_own_row_writes.test.sql` ("new file"). "Legacy" is `supabase/tests/legacy_permissive_policy_dropout.test.sql`.

- AC-1 (policy shape: exactly the read policy and the admin policy, admin text byte-identical, own-row ALL gone) → PASS. New file T1 (`policies_are`), T2 (read policy `PERMISSIVE|SELECT|(user_id = auth.uid())`), T3 (admin permissive/cmd/qual/with_check pinned as an `E''` literal). Live `pg_policies` shows exactly `Users can read own store links|SELECT` and `Admins can manage all store links|ALL`.
- AC-2 (fail-closed migration) → PASS in substance. See "Judgment on AC-2" below. The DO block exists (migration L76-133) and the post-state is pinned by T4. The DO block itself is not exercised by pgTAP, only by the developer's manual FC1-FC4 transcripts, which I did not re-run.
- AC-3 (re-runnable; no change to trigger, functions, grants or publication) → PARTIAL. `drop policy if exists` is present. The developer's manual second `psql -f` run is recorded in the spec. I read the migration: it contains only the drop, one comment and the DO block. No test pins "trigger, grants and publication unchanged". T8 (trigger still fires) and T20/T22 (admin INSERT is still granted) cover trigger and grants indirectly. Nothing covers the publication or functions. Rated Should-fix 2, not Critical, because the file contents show no such change.
- AC-4 (store-less invitee INSERT → 42501, 0 rows) → PASS. T5 (`throws_ok`, SQLSTATE and RLS message text), T6 (count = 0). The trigger admits a first link, so RLS is the only gate.
- AC-5(a) (as split into a1/a2 by D-0) → PASS.
  - a1: T8 pins `P0001` plus the trigger's exact message. This passes with or without spec 195 by design, and it is labelled that way.
  - a2: T12 pins `42501` plus the RLS message after postgres removes the caller's links. This is the arm that is sensitive to the policy.
- AC-5(b) (INSERT on an unlinked same-brand store → 42501) → PASS. T7.
- AC-5(c) (own-row DELETE affects 0 rows, links remain) → PASS. T9 (row_count '0'), T10 (Towson link count = 1).
- AC-5(d) (own-row UPDATE affects 0 rows) → PASS. T11 (cross-brand and no-op UPDATE → '0,0'; an exception is mapped to -1, so a mutation fails the arm instead of aborting the file).
- AC-5(e) (`auth_can_see_store(<brand-B store>)` false) → PASS. T13.
- AC-6 (reversed arm 9; plan unchanged; comments reworded) → PASS. Legacy arm (9) is now `throws_ok(..., '42501', 'new row violates row-level security policy for table "user_stores"', ...)`. `plan(13)` is unchanged, and the run shows 13 assertions. Diff confirms the header, arm (8), arm (11)(i), `v_target_a` and "(claims cleared)" comments were reworded.
- AC-7 (manager own-row DELETE affects 0 rows, links unchanged) → PASS. T14, T15.
- AC-8 (upsert on a new store → 42501) → PASS. T16 (`do nothing`), T17 (`do update`).
- AC-9 (own-row read unchanged, 0 other users' rows) → PASS. T18 (count equals the postgres-side count), T19.
- AC-10 (admin arm; legacy arms 10/11 unchanged) → PASS. T20, T21; legacy arms (10) and (11) pass (13/13).
- AC-11 (super_admin INSERT and DELETE) → PASS. T22, T23 (synthetic NULL-brand super_admin).
- AC-12 (`profiles_insert_hardening` passes unchanged; C-3 shows registration still writes links) → PASS. Full `npm run test:db` is green, and that file is not modified in the working tree.
- AC-13 (authGate/sessionRestore unchanged, jest passes) → PASS, with a gap. Neither file is modified. `src/lib/sessionRestore.test.ts` passes. `src/lib/authGate.ts` has no jest suite on disk, so "their jest suites pass" is vacuous for authGate.
- AC-14 (full suites green) → PASS for pgTAP, jest and `typecheck:test`. `npm run typecheck` was not run, per instruction (known red, 24 empty `node_modules/@types/* 2` folders). The developer's note that it is red only for that cause, and that `tsc --noEmit --types node,jest` is exit 0, is unverified by me.
- AC-15 (no change under `src/`, `supabase/functions/`, `e2e/`, `app.json`) → PASS for the files spec 195 added. Its files are limited to the migration, the new test file, the legacy test, and spec text (spec 164 L160 and the spec 195 folder). The shared tree does show `M` entries under `src/`, `e2e/` and `supabase/functions/delete-user`, all untracked or modified by other specs (186/187/189/etc.). None are attributable to 195. A path-scoped stage by the owner is needed to keep it clean (design D-7).
- AC-16 (dated correction below spec 164 L159) → PASS. `specs/164-profiles-insert-hardening.md:160` carries "Correction (2026-11-09, spec 195)". The original line is untouched.
- AC-R1 (prod pre-checks re-run before apply) → NOT TESTED. Deploy-time, cannot be tested in review.
- AC-R2 (prod apply with owner go-ahead) → NOT TESTED. Deploy-time. See Should-fix 1 about the stale version.
- AC-R3 (CI gates green after push) → NOT TESTED. Deploy-time.

Tally: 16 PASS-class (AC-1 to AC-16, with AC-3 PARTIAL and AC-2 PASS-in-substance), 0 FAIL, 3 NOT TESTED (AC-R1 to AC-R3, rollout items the spec itself says cannot be tested in review). The release-coordinator should treat R1 to R3 as release-process gates, not review failures.

### Judgment on AC-2
AC-2 is still met in substance, and not literally in one corner.

- **The core requirement holds.** The apply aborts with nothing changed unless the post-state is exactly one permissive write policy (the admin arm) and one permissive SELECT policy (the own-row read). The DO block and the drop are in one `begin; ... commit;`, so a raise rolls the drop back.
- **Missing read policy.** The `comment on policy "Users can read own store links"` (migration L72) runs before the DO block. If that policy is absent, the COMMENT errors with `policy ... does not exist` and the transaction aborts there. This is still fail-closed (nothing committed, same as a `195:` raise). It does not carry the `195:` prefix AC-2 literally asks for.
- **The DO block would catch it anyway.** Branch R counts 0 SELECT policies and would raise `195:` if the COMMENT were not first.
- **Judgment.** The AC's stated outcome, "the whole apply aborts with nothing changed", is met. The wording "raises with a `195:`-prefixed message" is not met for exactly one scenario, an absent read policy.
- **Fix, optional.** Move the COMMENT after the DO block. Or reword AC-2 to "aborts, with a `195:` message for every post-state mismatch other than a missing read policy". I'd call it a Should-fix, not a block.

### Test run
Real output, run in this session.

- `bash scripts/test-db.sh supabase/tests/user_stores_own_row_writes.test.sql` → `PASS supabase/tests/user_stores_own_row_writes.test.sql (23 assertion(s) passed)`; `1/1 DB test file(s) passed`.
- `bash scripts/test-db.sh supabase/tests/legacy_permissive_policy_dropout.test.sql` → `PASS ... (13 assertion(s) passed)`; `1/1 DB test file(s) passed`.
- `npm run test:db` → exit 0, `101/101 DB test file(s) passed`. This includes `profiles_insert_hardening`, `demote_self_guard`-family files if present, `user_stores_brand_match_null_brand`, `permissive_policy_lint`, `retention_prune_job`, `order_approvals_approver_snapshot`, `stock_store_from_store`. No spec 191 failures appeared. No 191 demote test file or migration was on disk at run time (the newest migration is 195's `20261109195000`).
- `npx jest` → `Test Suites: 301 passed, 301 total`, `Tests: 3835 passed, 3835 total`, `Snapshots: 17 passed`.
- `npm run typecheck:test` → exit 0, no output.
- `npm run typecheck` → not run (known red, per instruction).

Live DB check: `pg_policies` for `user_stores` shows the two expected policies. The seed manager has 2 links, so T14/T15/T18 are not vacuous.

### Gaps

**Critical**
- None.

**Should-fix**
1. **Stale migration version in the spec's rollout text.** D-8 and AC-R2 step 2 still say `20261109160000`. The file on disk is `20261109195000` (the developer noted this in Implementation notes but the D-8 body and the AC-R2 insert line were not edited). A prod `schema_migrations` insert of the old version would make `db-migrations-applied.yml` hard-fail. The migration header carries the right version. Edit the spec text before the prod apply.
2. **AC-3 is not pinned by a test.** Nothing asserts that the trigger, `user_stores_brand_match()`, grants and the `supabase_realtime` publication are unchanged. Nothing runs the migration twice in CI. A pgTAP arm could assert `has_table_privilege('authenticated','public.user_stores','INSERT')`, the trigger's presence, and that `user_stores` is not in `pg_publication_tables`. Re-run is only evidenced by the developer's note.
3. **AC-2's DO block is not exercised in CI.** T4 re-states the W and R predicate as a string and pins the post-state, but a typo or regression in the DO block's branches, in the A branch (`auth_can_see_brand` position check) in particular, would not turn any arm red. Evidence is the developer's manual FC1 to FC4 only. pgTAP cannot run a migration body, so this is inherent, but the manual transcript is unverified here.
4. **Fail-closed corner (see "Judgment on AC-2").** Reorder the COMMENT after the DO block, or reword AC-2.
5. **AC-13 has no authGate suite.** "Their jest suites pass unchanged" holds only for `sessionRestore`. No test pins authGate's zero-links sign-out.

**Nits**
- Assertions that pass whatever the policy was (regression guards, not hole-closure proof): T2, T18, T19 (read policy unchanged, so they pass before and after), T20 to T23 (admin and super_admin arms are unchanged), T8 (passes with or without spec 195 by design and labelled so in the arm), T13 (only meaningful as a follow-on to T12). T4 would fail on a re-added permissive write policy and so is sensitive. A reader should not count T2/T18-T23 as evidence the hole is closed. The closure evidence is T5-T7, T9-T12, T14-T17.
- T18's expected count comes from the `test.mgr_n` capture. If the seed manager ever had 0 links, T14, T15 and T18 would pass vacuously. Add a `ok(mgr_n > 0)` guard.
- T10 asserts only the Towson link (count = 1). AC-5(c) says "all still present"; the demoted user has exactly one link, so these are equivalent today.
- M8 (widen `auth_can_see_brand` / `auth_is_privileged`) was not run by the developer. T7/T12 are described as sensitive to it but that is unverified.
- The arm-name comments in the new file's header say "Twenty-three arms" and `plan(23)`; consistent.
- I did not re-run the developer's mutation runs M1-M7 or FC1-FC4 (they take AccessExclusiveLock on a shared stack). Their results are taken from the spec's Implementation notes, unverified.

### Notes
- Track: pgTAP only, as the spec states. No new framework, no jest or smoke additions.
- Callers are simulated as PostgREST presents them (`set local role authenticated` plus `request.jwt.claims`). The tests hit a real local Postgres. No mocks.
- Refusals pin the RLS message text, so a "fix by REVOKE" would show as a failure.
- Native and web: not applicable (DB-only).
- The shared tree contains many other specs' uncommitted changes. Spec 191's migration and tests were not on disk during this run.
