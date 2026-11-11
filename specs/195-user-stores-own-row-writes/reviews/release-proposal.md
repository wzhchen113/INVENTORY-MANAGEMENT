## Verdict
verdict: FIXES_NEEDED
rationale: No reviewer flagged a Critical and the change is a strict security reduction, but the spec's prod runbook still names the wrong migration version (`20261109160000`). Pasting it as written would turn the drift gate red and leave a misleading row in prod's `schema_migrations`. That needs a text fix and one small pre-prod edit to the migration body before the owner applies.

Release-coordinator, 2026-11-09. Sources read: the spec (all 576 lines), `code-reviewer.md`, `security-auditor.md`, `test-engineer.md`, `backend-architect.md`, `prod-prechecks.md`, and the built migration `supabase/migrations/20261109195000_user_stores_drop_own_row_writes.sql`.

Gate state: CI on `main` is green on all three gates at `15aefc4`. Nothing for 195 is committed, staged or applied to prod.

## Findings summary
- **code-reviewer:** 0 Critical, 4 Should-fix, 9 Nits.
  - Stale `…160000` in spec D-1/D-8.
  - Two migration header comments won't hold up over time: "Renumbered from spec 190" and "(spec 064 gate, project MEMORY)".
  - The `comment on policy` text lists every writer, so it will go stale.
  - The T3 md5 comment is ambiguous, and T3 needs a "re-capture after a PG major bump" note.
  - Nits: the repeated caller-impersonation block, the implicit role in the T14 setup, and `exception when others` in T11 being too broad.
- **security-auditor:** 0 Critical, 1 High, 1 Medium, 3 Low. It confirmed the spec's own claim by running it: after 195, no owning-user API route writes `user_stores`. That covers PostgREST INSERT, upsert, UPDATE and DELETE, plus pg_graphql. Registration and the admin arm still work.
  - **H1, older than this spec, outside the diff, and stated not to block 195:** invitation SELECT/DELETE is not brand-scoped. Together with open sign-up and no email confirmation, any privileged claim can list and squat another brand's pending invitations.
  - **M1:** a demoted admin who keeps a brand can use a stale claim to self-link to every store in that brand, and those links outlast the token.
  - **L1:** the DO block's admin-arm check is a substring match.
  - **L2:** `anon` and `authenticated` hold TRUNCATE.
  - **L3:** concurrent first links for a NULL-brand user are not serialized.
- **test-engineer:** 0 Critical, 0 FAIL, 5 Should-fix.
  - AC-1 to AC-16 pass. AC-2 passes in substance and AC-3 is partial. AC-R1 to AC-R3 are deploy-time gates, not tested.
  - It re-ran the new file (23/23), the legacy file (13/13), `npm run test:db` (101/101), `npx jest` (301 suites, 3835 tests) and `typecheck:test`. All green.
  - Gaps:
    - stale version in the runbook
    - AC-3's "trigger, grants, publication unchanged" is not pinned by a test
    - the DO block is not exercised in CI (inherent to pgTAP)
    - a missing read policy fails at the COMMENT, not with a `195:` message
    - `authGate.ts` has no jest suite
- **backend-architect (post-impl):** no contract drift. 0 Critical, 2 Should-fix, 4 Nits.
  - S-1: correct `…160000` to `…195000` at spec L285, L287, L443, L463, L467, L488. It blocks AC-R2.
  - S-2: shortening the comment also changes D-8 step 3's `obj_description` check.
  - N-1: move the COMMENT after the DO block if the body is edited anyway.
  - N-2: rollback text should null the read-policy comment and retire or invert the new test file.
  - Independence from 186, 187, 189, 190-po, 191 and 194 is confirmed. It also gave explicit-path landing guidance.

## Recommended next steps (ordered)

Every item below happens before the prod apply. None needs a fresh round of reviewers. Re-running the tests named in step 2 is enough.

1. **Correct the stale migration version in the spec.** Text-only fix, in this spec. Should-fix, but it blocks AC-R2, so it goes first.
   - Replace `20261109160000` with `20261109195000` at L285 (D-1 heading), L287 (D-1 version bullet; use the architect's as-built wording), L443 (D-7), L463 (D-8 apply step 2), L467 (D-8 verify) and L488 (D-10).
   - The L505 override note can stay as history.
   - AC-R2 itself says only "its exact version". It points at D-8, so fixing D-8 fixes it.
   - Why first: the D-8 snippet is what gets pasted into `execute_sql`. Inserting `…160000` would make `db-migrations-applied.yml` hard-fail on push. It would also claim a now-unreserved slot in prod's `schema_migrations`, so a future migration given that version would be skipped silently.
   - Leave spec 194's stale reservation note (`specs/194-kept-records-delete-hardening.md:579`) alone. Just don't treat `…160000` as reserved.

2. **Make one pre-prod edit to the migration body, then update the matching spec text.** Code fix in this spec, plus a paired text fix. Should-fix (code-reviewer, architect S-2 and N-1, test-engineer #4).
   - Allowed only because prod doesn't have the body yet. Once it is applied, the body is frozen.
   - Do all of these in a single edit:
     - (a) Shorten the `comment on policy "Users can read own store links"` text to the durable fact, for example `'spec 195: own-row READ only; no own-row write policy by design.'` The list of writers stays in the header, which is dated.
     - (b) Move that `comment on policy` statement to after `end $$;`. A missing read policy then raises `195: expected exactly one permissive SELECT policy … found 0 () qual <null>`, and AC-2 is met literally with no rewording. The DO block doesn't depend on the comment.
     - (c) Header: remove "Renumbered from spec 190". Replace "(spec 064 gate, project MEMORY)" with a plain description: apply via `execute_sql`, insert the exact version into `supabase_migrations.schema_migrations`, gate is `db-migrations-applied.yml`.
     - (d) Header rollback block (architect N-2): add `comment on policy "Users can read own store links" on public.user_stores is null;`. Also say that the forward re-create migration must retire or invert `supabase/tests/user_stores_own_row_writes.test.sql`, not just revert legacy arm (9).
   - Paired text fixes in the spec:
     - D-8 apply step 3: quote the exact new comment string as the expected `obj_description` value.
     - D-8 rollback steps 1 and 3: the same N-2 additions as (d).
   - Re-verify locally:
     - `psql -v ON_ERROR_STOP=1 -f` the edited file. It is re-runnable, and the comment is overwritten.
     - `bash scripts/test-db.sh` on the new file and the legacy file, then `npm run test:db`.
     - Optional: re-run FC3 (read policy dropped) once to confirm it now raises a `195:` message.
     - No `db reset` on the shared stack.

3. **Security L1 (md5 check inside the DO block).** Owner decision. Recommendation: decline the in-migration md5 and add a text-only pre-apply stop instead.
   - Why not put the md5 in the migration: it replays on every fresh CI build and every local reset, for good. The admin-policy text is Postgres' own pretty-printed rendering (139 bytes, with fixed newlines and indentation). If a future Postgres version renders it differently, the migration chain itself would break, not just a test. And once prod has the body, the file can't be edited. T3 has the same sensitivity, but a test literal can be re-captured, and code-reviewer already asks for a re-capture note on T3.
   - What to do instead (text-only, AC-R1/D-8): make "P-1 admin `md5(qual)` and `md5(with_check)` both equal `b05a4d4429e322a9cf194d6072b5f6d3`" an explicit **stop** condition in the pre-check run right before the paste. The post-apply compare already exists. That covers the realistic risk: someone changes the policy through the dashboard on prod before the apply. The seconds between pre-check and paste are not a realistic drift window.
   - If the owner prefers the atomic guard anyway, it is fail-closed: a mismatch aborts with nothing changed. Accept the replay hazard knowingly.

4. **Test-engineer coverage gaps for AC-3 and the DO block.** Accept, with a text-only note. Optional small code additions in this spec.
   - **DO block not run in CI:** pgTAP can't execute a migration body, so this can't be closed there. The evidence is the developer's FC1 to FC4 transcripts plus the security auditor's own fail-closed probe, which ran the block against a widened admin arm. That probe also showed the substring weakness, so the block does execute as written. T4 pins the post-state. Accept.
   - **AC-3 not pinned:** the migration has only a drop, a comment and the DO block (confirmed by reading it). Assertions on grants, trigger and publication would guard against *later* migrations, not this one. T8 already shows the trigger fires, and T20/T22 show the grant is still there. Accept. Under AC-3, note that it is evidenced by file review plus the developer's double `psql -f` run.
   - **Optional cheap arms, if the owner wants them while the test file is open for step 2's re-run:**
     - `ok(test.mgr_n > 0)`, so T14, T15 and T18 can't pass vacuously
     - `has_table_privilege('authenticated','public.user_stores','INSERT')`
     - trigger present
     - `user_stores` absent from `pg_publication_tables`
   - Bump `plan()` to match. Not blocking.

5. **Optional test and comment nits.** Code fix in this spec, optional, not blocking.
   - T14: set `set local role authenticated` explicitly, or add a comment that the role carries over.
   - T11: narrow `exception when others` to `sqlstate 'P0001' or sqlstate '42501'`. This still holds under M1/M4, because d1 hits the trigger's P0001.
   - T3: say the single md5 covers both identical strings, and add the "re-capture after a PG major bump" line.
   - Legacy file wording at L109-111, L480 and L541-542.

6. **Land.** Owner go-ahead needed for each of the following. This is the process, not a fix.
   1. Run `git diff -- supabase/tests/legacy_permissive_policy_dropout.test.sql specs/164-profiles-insert-hardening.md`. Both show ` M` in a working tree other sessions share. Confirm the only hunks are 195's.
   2. Prod (MCP `execute_sql`, project `ebwnovzzkwhsdxkpyjka`):
      - Re-run P-1 to P-7 per AC-R1, including the md5 stop from step 3.
      - Paste the **final** file body.
      - `insert … values ('20261109195000', 'user_stores_drop_own_row_writes')`.
      - Verify per D-8.
   3. Commit by explicit paths only. The index holds spec 190's staged `20261109140000_po_number_sequence.sql` and its tests, plus other sessions' files. A bare `git commit` would carry `…140000`, and if that isn't on prod, `db-migrations-applied.yml` goes red. Use `git add <195 paths>`, then `git commit -m "…" -- <same paths>`. The paths are the migration, the two test files, `specs/164-profiles-insert-hardening.md`, `specs/195-user-stores-own-row-writes.md` and `specs/195-user-stores-own-row-writes/`. Check `git show --stat HEAD` and that 190's entries are still staged. The user runs the commit.
   4. Push. Prod must already have the migration. Then confirm the latest `main` runs of `test.yml` and `db-migrations-applied.yml` are green, and check `e2e.yml` by hand (AC-R3).

## Out of scope for this review

- **Security H1: invitation listing across brands, plus open sign-up without email confirmation.** Separate spec. Does **not** block 195. **Urgency: high. Write it next, ahead of non-security work.**
  - Why it doesn't block: it is older than 195, outside the diff, and 195 neither creates nor widens it. 195 strictly reduces exposure: it closes 164-H1 and the cross-brand self-link step of 187-H2. Holding 195 would keep those open too.
  - Why it is urgent:
    - With 195 applied, it is the one remaining route by which an attacker-controlled profile gets linked to another brand's store, or becomes a lasting admin of another brand.
    - It needs no stale token. Any brand admin can use it, and so can a stale-claim caller.
    - Prod has two live brands, so it is cross-tenant.
    - The auditor reproduced it locally. Sign-up was simulated.
  - Preconditions not yet confirmed on prod:
    - a pending invitation whose email hasn't signed up (prod held 4 invitations at the 2026-11-09 pre-check)
    - prod Auth actually allowing sign-up without email confirmation (the auditor checked only local `config.toml`)
  - **Interim owner action (read-only, no spec needed):**
    - Check prod Auth's sign-up and "confirm email" settings.
    - Look over the pending invitations and revoke any that are stale.
    - Keep new invitations short-lived until the fix lands.
  - **Spec shape:**
    - (a) Give `invitations` SELECT and DELETE the same brand-in-scope and stores-in-scope predicate as INSERT/UPDATE. This doesn't need 191. Swap in 191's profiles-backed check once it exists.
    - (b) Turn on email confirmation, or claim the invitation on first verified sign-in (164-M1). Before choosing, find out which mail path Auth confirmation emails would use on prod.
    - (c) Re-run the 164 P-6 pending-invitation check.
  - Coordination: spec 191's K-13 pins the invitations `qual = 'auth_is_privileged()'`, so the H1 spec must update that pin.

- **Security M1: a demoted admin who keeps a brand can self-link across that brand using a stale claim.** Recommendation: **separate follow-up spec after 191 lands. Do not ask the owner to widen 191.** Medium.
  - Why not widen 191:
    - It is mid-build, and its design deliberately leaves the `user_stores` admin policy alone. Changing it now is scope creep in another session's spec.
    - It would couple 191 and 195. 191's version `20261109191000` sorts *before* 195's `…195000`. If 191 rewrote the admin policy, then on a fresh replay and on prod (if 191 applies first), 195's T3 byte-pin and the D-8 P-1 md5 comparison would no longer match. Both specs would have to be reworked together.
  - Why not just accept it: it turns a one-token window into durable staff access to every store in a brand. It is cheap to fix once 191's `auth_profile_is_privileged()` exists.
  - Today's reach is narrow, so it can wait for 191:
    - Only a super_admin changing `role` alone through `super_admin_manage_profiles`, or some future demote that keeps the brand.
    - `demote_profile_to_user` currently NULLs the brand.
    - The impact stays within one brand.
  - Follow-up shape:
    - Swap `auth_is_privileged()` for `auth_profile_is_privileged()` in the USING and WITH CHECK of `"Admins can manage all store links"`.
    - Re-capture 195's T3 literal and md5 in the same PR.
    - Add the auditor's probe as an arm expecting `42501`.
  - Optionally bundle it with the H1 spec if 191 has landed by then. Don't hold H1(a) for it.

- **Security L2:** `anon` and `authenticated` hold TRUNCATE, TRIGGER and REFERENCES on `public.*`. Not reachable today. Separate, project-wide spec, optional.
- **Security L3:** the brand-match trigger has a race on concurrent first links. It needs two privileged writers, and 195 left no unprivileged path. The trigger change is out of scope by design. Optional separate spec.
- **`src/lib/authGate.ts` has no jest suite** (test-engineer #5). AC-13 holds only through `sessionRestore`. Separate test-coverage follow-up.
- **Local `npm run typecheck` is red** because of empty `node_modules/@types/* 2` folders. This is the local environment; CI is green. Clean it up locally; it is not a 195 issue.
- **Accepted owner risks already recorded in the spec:**
  - Sibling apps outside this repo that write `user_stores` with a user JWT will get 403s.
  - Three prod store-user accounts have no `Store user created` audit row. That is an owner check.
  - A demoted target keeps its pre-demotion links. That belongs to spec B / 191.
- **Specs 187 (FIXES_NEEDED re-proposal) and 191 (being built)** are related but independent of 195, as confirmed by the architect. Either order of landing works. The only ordering rule is that 195 reaches prod before the push that carries it.

---

# Final verdict (2026-11-10)

Release-coordinator, 2026-11-10. Covers the spec's "Post-review fixes (2026-11-09)" section, which applied steps 1 to 5 above after the owner's "Apply all three (Recommended)". The proposal above is left as it was. Sources: the spec (Acceptance criteria, Open questions resolved, D-1, D-8, Implementation notes, Post-review fixes, Files changed), the migration file in full, and a grep of the new test file. I ran nothing. No new review round ran, and as step 1 above said, none was owed for these items.

## Verdict
verdict: SHIP_READY
rationale: Every fix in the plan is in the files as described, none of them touched a reviewer's finding beyond what the reviewer asked for, no Critical is open, and what is left is the gated landing sequence below. This depends on `test.yml` and `db-migrations-applied.yml` still being green on `main` when main Claude re-checks before the push.

## Findings summary
- **code-reviewer, security-auditor, test-engineer, backend-architect:** no new round. The findings above stand, apart from those closed by the fix pass:
  - Stale version (code-reviewer, architect S-1, test-engineer): fixed. D-1, D-7, D-8, D-10 and AC-R2 say `20261109195000`.
  - Comment text and position (code-reviewer, architect S-2 and N-1, test-engineer #4): fixed. AC-2 now holds literally (FC3 raises the `195:` R message).
  - Header wording and rollback additions (code-reviewer, architect N-2): fixed.
  - Security L1: declined by the owner, replaced by the AC-R1 md5 stop.
  - AC-3 and DO-block coverage (test-engineer): accepted with a note, plus T24 to T27.
  - Nits (T14 role, T11 filter, T3 note, legacy wording): fixed.
- **Still open, outside this spec:** security H1 (invitations, now spec 198), M1 (follow-up X2), L2, L3, and the `authGate.ts` jest gap. See Out of scope.

### What I checked by reading
- **Migration** `20261109195000_user_stores_drop_own_row_writes.sql`:
  - The read-policy comment is the short string and runs after the DO block's `end $$;` (L139-142).
  - The header has no "Renumbered" or project-memory wording. The PROD-APPLY block names the AC-R1 md5 stop, the exact `schema_migrations` insert and the gate (L43-51).
  - The rollback block nulls the read-policy comment and says to retire or invert the new test file (L53-64).
  - The DO block is unchanged in substance: W, R and A checks, all raising with a `195:` prefix.
- **Test file:** `plan(27)`, T24 to T27 present, and T11's handler narrowed to `sqlstate 'P0001' or sqlstate '42501'` (L376).
- **Spec:** AC-R1 has the md5 stop (L156). D-8 verify quotes the exact `obj_description` string. AC-2 and AC-3 carry the coverage notes.
- **Relayed, not reproduced:** FC0 to FC4 re-run against the edited file, the M1/M4/M7/REVOKE spot-checks, the `obj_description` md5 `3461e1fd…` matching across live, file and D-8, and the runs (`test:db` 104/104, jest 301 suites and 3,836 tests, `typecheck:test` exit 0).

### Is a focused re-review needed?
**No.** The developer's evidence is enough:
- No function body exists in this migration. The edits are a comment string, the order of one statement, header comments and test arms.
- The one behaviour change, the comment moving after the DO block, is the architect's own N-1, and FC3 shows the intended result.
- T24 to T27 only pin post-state. The REVOKE spot-check shows T25 can fail.
- A reviewer would re-read the same transcripts. The pushed test branch (Landing step C) gives the independent check that is still missing: this migration has never run on a fresh `supabase start`.

## Recommended next steps (ordered)

### Spec 195, before its prod apply
1. **Include it in the test-branch run** (Landing step C). It isn't a 195 AC, but it costs nothing and is 195's first fresh build.
2. **AC-R1 pre-checks, read-only, right before the paste.** P-1 to P-7, with D-8's hardened P-6 cast and its companion count, and P-7's registration check. Stop on any AC-R1 condition, including P-1's admin `md5(qual)` or `md5(with_check)` not equal to `b05a4d4429e322a9cf194d6072b5f6d3`. Compare with `prod-prechecks.md`.
3. **AC-R2 apply.** Paste the committed body, insert `('20261109195000', 'user_stores_drop_own_row_writes')`, re-run P-1 (two policies, admin text byte-equal to the T3 literal), check the `obj_description` string, and check the version row.
4. **AC-R3** after the push.

### Landing order for 187, 191 and 195
This section is the same in all three proposals. Every step needs the owner's go-ahead. Main Claude re-checks `test.yml` and `db-migrations-applied.yml` on `main` before every push. Relayed: both were green at `a66dd81`, which carries specs 190 and 194, so `20261109140000` and `20261109170000` are on prod.

**A. Before committing**
1. **Tell the spec 198 session** (migration `20261110120000`, being built now) not to edit 191's or 195's files until those commits exist. That means especially `supabase/tests/profiles_insert_hardening.test.sql` (198 must update its K-13 pin) and `specs/164-profiles-insert-hardening.md`. A path-limited commit takes the whole working copy of each path, so it would take 198's hunks too.
2. **Ask the other sessions to hold pushes to `main`** from step B until step E. Once these commits are on local `main`, any push carries three migrations prod doesn't have yet, and `db-migrations-applied.yml` goes red.
3. **Run `git diff` on each tracked file the commits take**, and confirm only that spec's hunks are present:
   - 187: `package.json` (the only change should be the `smoke-delete-user.sh` append), `supabase/tests/profiles_rls_sweep.test.sql`, `supabase/tests/auth_can_see_store_brand_scope.test.sql`, `specs/043-profiles-rls-sweep.md`, `specs/178-order-approvals-fk-set-null.md`
   - 191: `supabase/tests/profiles_insert_hardening.test.sql`, `scripts/smoke-edge-roles.sh`
   - 195: `supabase/tests/legacy_permissive_policy_dropout.test.sql`, `specs/164-profiles-insert-hardening.md`

**B. Three commits, one per spec, in migration-version order.** For each: `git add <paths>`, then `git commit -m "…" -- <paths>`. The index holds other sessions' staged work (specs 188, 189, 196 and 197, `README.md`, hunks in `src/lib/db.ts` and more), so a bare `git commit` would take it. After each commit, `git show --stat HEAD` must list exactly one migration.
1. **187** (`20261108130000`): the migration, `supabase/tests/order_approvals_approver_snapshot.test.sql`, `audit_log_rls_hardening.test.sql`, `profiles_rls_sweep.test.sql`, `auth_can_see_store_brand_scope.test.sql`, `supabase/functions/delete-user/index.ts`, `scripts/smoke-delete-user.sh`, `package.json`, `src/lib/placeholderEmail.ts`, `src/lib/placeholderEmail.parity.test.ts`, `specs/187-order-approval-approver-snapshot.md` and its directory, `specs/178-…md`, `specs/043-…md`, and `CLAUDE.md` with the accepted bullet (see spec 187's proposal). Leave out `src/lib/db.ts`: the change there is comment-only and the file holds other sessions' hunks.
2. **191** (`20261109191000`): the migration, `supabase/tests/demote_profile_brand_scope.test.sql`, `supabase/tests/profiles_insert_hardening.test.sql`, `scripts/smoke-edge-roles.sh`, `specs/191-demote-profile-brand-scope.md` and its directory (reviews and `rollback.sql`). Leave out `README.md`.
3. **195** (`20261109195000`): the migration, `supabase/tests/user_stores_own_row_writes.test.sql`, `supabase/tests/legacy_permissive_policy_dropout.test.sql`, `specs/164-profiles-insert-hardening.md`, `specs/195-user-stores-own-row-writes.md` and its directory.
- Leave out everything else, including `20261109200000` (spec 196) and `20261109230000` (spec 197). I grepped both: neither touches an object of these three specs.

**C. One test branch, before anything touches prod.**
- `git push origin HEAD:refs/heads/test/ship-187-191-195`. This needs no checkout, so the shared working tree is untouched. Don't open a PR: a PR runs `db-migrations-applied.yml`, which would be red by design. A plain branch push runs only `test.yml` and `e2e.yml`.
- Both run on a fresh `supabase start` (CLI 2.106.0), and `e2e.yml` also runs `db reset`. Required: both green, and the Playwright report shows `e2e/invite.spec.ts` passed (191 C4). A pass that needed a retry counts as a flake, so note it.
- This is the first fresh build of 191 and 195, and the first of all three together. 187's A7 built 187 alone on `c630c7f`.
- If either is red: stop. Nothing is on prod, so the migrations can still be edited in place. Fix, amend the commit, and re-push the branch.
- Delete the branch once step E is green.

**D. Prod, through MCP `execute_sql`, project `ebwnovzzkwhsdxkpyjka`.**
1. **All read-only pre-checks first, for all three, before any apply:** 187 steps 0 and 1, 191 H1, and 195 AC-R1 (P-1 to P-7). Resolve any stop before applying anything. That avoids applying 187 and then finding 191 blocked with its commit in the middle of the push.
   - Expected, not a stop: 191's H1 query (a) still lists `Admins can delete profiles` on prod, because 187 hasn't applied yet.
   - Read once and record: prod Auth's email-confirmation setting (187 A8, also a 198 pre-read) and `jwt_expiry` (191 H1).
2. **187:** steps 2 to 5 (body, version `'20261108130000'`, function checks against references recaptured that day, post-apply checks).
3. **187: deploy `delete-user`** (spec 187 step 6). Only after step 2. See spec 187's proposal.
4. **191:** H2 (body, version `'20261109191000'`, function, policy and grant checks).
5. **195:** AC-R2 (body, version `'20261109195000'`, P-1 and comment checks).
- Version order matches the order CI just replayed on the branch. The objects don't overlap, so this is a preference, not a dependency.
- If an apply fails part-way, don't push until the set of commits equals the set of versions on prod. Removing 191's commit, the middle one, needs a rebase. That is the owner's call.

**E. Push `main`**, only after all three versions are in prod's `schema_migrations`. `git log origin/main..HEAD` must show only the three commits. Then confirm `test.yml` and `db-migrations-applied.yml` are green on `main`, and check `e2e.yml` by hand. If any is red or still running, surface the run URL and stop.

**F. Spec 198 afterwards.** Its `20261110120000` sorts after all three. It needs 191 on prod (it uses `auth_profile_is_privileged()`), and its commit comes after these three. If it changes `"Admins can manage all store links"` (follow-up X2), it also needs 195 on prod and must re-capture 195's T3 literal and the P-1 md5. Once 198 depends on the helper, 191's `rollback.sql` must roll 198 back first. Its header's `pg_depend` check covers that.

### CLAUDE.md
None proposed by spec 195 and none needed. The permissive-OR bullet's account of `public.user_stores` (spec 051) stays accurate.

## Out of scope for this review
- **Security H1:** being specced as spec 198 (invitations hardening), which depends on 191. The interim owner actions above still apply until it lands.
- **Security M1:** follow-up X2 in spec 191's proposal. It needs 191 and 195 on prod and can ride with spec 198.
- **Security L2:** spec 197 (`20261109230000_revoke_client_truncate.sql`, on disk, not reviewed here) looks like it takes the TRUNCATE part. T25 checks only SELECT, INSERT, UPDATE and DELETE, so it survives that change.
- **Security L3** and **the `authGate.ts` jest suite:** as above.
- **`app.json` slug:** not touched.

## Handoff
next_agent: NONE
prompt: SHIP_READY (2026-11-10 final). Post-review fixes verified by reading and no re-review needed. Before prod: test-branch run, AC-R1 pre-checks with the md5 stop, and AC-R2 apply as the last of 187 → 191 → 195. The push comes after all three versions are on prod.
payload_paths:
  - specs/195-user-stores-own-row-writes/reviews/release-proposal.md
