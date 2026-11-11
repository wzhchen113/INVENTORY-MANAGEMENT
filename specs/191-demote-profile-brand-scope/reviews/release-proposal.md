# Release proposal: spec 191

Release-coordinator, 2026-11-09. Sources read:
- the spec (all 940 lines)
- the four reviews: `code-reviewer.md`, `security-auditor.md`, `test-engineer.md` and `backend-architect.md`
- the built migration `supabase/migrations/20261109191000_demote_profile_brand_scope.sql`, L100-400
- `.github/workflows/e2e.yml`
- `README.md` L224-232
- the release proposals for 187 (the Re-proposal section) and 195

I ran nothing. I had read and search tools only.

## Verdict
verdict: FIXES_NEEDED
rationale: No reviewer flagged a Critical, and every acceptance criterion that pgTAP can reach passes. Four things still need doing, and all of them are cheap now because nothing is applied:
- the migration has no `lock_timeout`
- no rollback SQL has been written or dry-run
- nothing in CI protects the step-4 caller re-read, which the brand check depends on
- C4's `e2e/invite.spec.ts` regression run hasn't happened

### Gates and hard rules
- **CI:** `test.yml`, `db-migrations-applied.yml` and `e2e.yml` are green on `main` at `15aefc4` (2026-11-09), according to the main session. I can't run `gh`, so this is relayed, not checked. None of spec 191 is committed, so those runs don't cover it.
- **Critical:** none from any reviewer.
  - The test-engineer notes that a strict reading of the process would count the NOT TESTED criteria E2 and F3 (the script) as Critical. It rates them "accepted-with-record" instead.
  - My reading: they are open criteria, not broken ones. I would not recommend SHIP_READY while they are open. The owner can close each one by running it or by a waiver recorded in the spec (step 7).
- **Nothing is committed or applied.** Commit, prod apply, push, and any script that disturbs the shared `admin@local.test` login need the owner's go-ahead.

## Findings summary
- **code-reviewer:** 0 Critical, 8 Should-fix bullets, 13 Nits, plus one out-of-scope note about the README. (The dispatch said 7 Should-fix. The reviewer lists the wrapper's role list and step 4's role list as two separate bullets.) It ran nothing. Top issues:
  - The header says K-6 pins the wrapper's coupling to the helper's message. It doesn't: B1a, B1b and D2a do.
  - "byte-identical" is false at L82 and L351.
  - Comments cite spec section numbers that will drift ("spec A" collides with "separate spec A" = 195).
  - The rollback pointer at L115 points at SQL that doesn't exist.
  - Role lists are duplicated: the wrapper's L178-181 and step 4's L279-280.
  - Two tests depend on earlier state without saying so: A5c relies on S1's claims surviving several role resets, and E-2 relies on section D's invitation still existing.
  - The smoke cleanup SQL is written out three times.
- **security-auditor:** 0 Critical, 0 High, 1 Medium, 5 Low.
  - It ran P1-P19 in one rolled-back transaction, and seven two-session races (R1-R7) in a throwaway database. Every route refused what it should: cross-brand, super_admin target, last-of-role and self, through the RPC, PATCH and upsert. The invariant "at least 1 super_admin and at least 1 master" held in every race.
  - **M1** (older than 191): an admin invitation set up before a demotion survives it, can be made never to expire, and records no inviter.
  - **L1:** any authenticated caller can call the wrapper directly. That takes the role lock and answers a last-of-role question.
  - **L2:** the existence and role oracle, accepted by the spec.
  - **L3** (older): `assert_not_last_of_role` is EXECUTE to anon and PUBLIC.
  - **L4:** `delete-user` races the new locks (already a recorded follow-up).
  - **L5:** the last-of-role count is global, not per brand (accepted).
- **test-engineer:** 0 Critical, 5 Should-fix, 6 Nits.
  - Criteria: 24 PASS, 2 PARTIAL (B4 and C4), 0 FAIL. Not tested: E2, F3 (the script), F4 and H1-H3. G2 not done.
  - Re-ran: `npm run test:db` 103/103 (the extra file is 195's), `npx jest` 301 suites and 3,836 tests, `typecheck:test` exit 0.
  - **It verified the 42501 → HTTP 403 mapping directly** against the live REST endpoint, using a self-minted JWT for a uid with no profile. Result: `{"code":"42501","message":"forbidden"}`, HTTP 403. The cross-brand and super_admin refusals use the same errcode.
  - Should-fix: C4 e2e not run; E2 not run; §6.5 P1 is wrong; nothing in CI protects the step-4 re-read; G2.
- **backend-architect (post-impl):** 0 Critical, 5 Should-fix, 9 Nits. No contract drift, and all five of the developer's deviations are accepted.
  - S1: no `lock_timeout`.
  - S2: no rollback SQL. It must restore the trigger function byte for byte, non-ASCII characters included.
  - S3: nothing in CI protects the step-4 re-read, and this matters for security.
  - S4: F3 smoke and C4 e2e haven't run.
  - S5: §6.5 P1 should become P1a/P1b.
  - It found the throwaway-database B4 probes adequate.
  - It confirms there is no object overlap with 187, 189, 190, 194, 195 or `…200000`.

**B4 evidence is two-sourced.** The test-engineer says the two-session probes were "self-reported, not reproduced". But the security-auditor's R1-R7 are an independent second set of races on its own throwaway clone, and they cover the cross-path cases (RPC against PATCH). I treat B4 as met.

## Recommended next steps (ordered)

Each item is tagged **[code, this spec]**, **[text only]**, **[owner decision]** or **[separate spec]**.

### Before any prod step or commit

**1. Edit the migration file in one pass. [code, this spec]**

*Why first:* items 1b and 1c change the stored function bodies (`prosrc`) of the RPC and the wrapper. Everything downstream depends on the final bodies: the md5 references, the mutation results and the rollback dry run. The helper (`7b8fd913`) and the trigger function (`1ce30998`) are not touched.

- **1a. S1: add `lock_timeout`.** Should-fix (prod-apply safety).
  - Put `set local lock_timeout = '5s';` straight after `begin;` (L123).
  - It is outside every function body, so no md5 changes.
  - It matches `20261105000000`, `…108130000`, `…109120000`, `…109140000`, `…109170000`, `…109195000` and `…109200000`.
- **1b. Security L1: add a privilege check to the wrapper.** Low. Recommended: do it in this spec (owner decision 3).
  - Make the first statement of `assert_demote_not_last_of_role`: `if not public.auth_profile_is_privileged() then raise exception using errcode='42501', message='forbidden'; end if;`. It must come before both the role filter and `pg_advisory_xact_lock`.
  - Both legitimate callers pass it. The RPC has already passed steps 2 and 4 for the same `auth.uid()`. The trigger branch runs only for super_admins (`auth_is_super_admin()` reads `profiles`).
  - The `postgres` and `service_role` paths never reach the wrapper (D4).
  - Cost: one new pgTAP arm and one new mutation row. It makes design claim 1.3(d), "unprivileged callers never take locks", true for every path, not just the RPC.
  - Doing it later needs a new migration, because the body is frozen once applied.
  - In the same edit, reword the L178 comment (code-reviewer): "role list deliberately mirrors `assert_not_last_of_role`'s guarded roles; change both together".
  - If the owner declines: a [text only] fix that says "RPC path only" in design 1.3(d), plus an Out-of-scope note.
- **1c. S3(b): make step 7 fail closed.** Recommended, optional. Owner decision 4: it changes the design, and the architect proposed it.
  - Change step 7's condition from `v_caller_role in ('admin','master')` to `v_caller_role is distinct from 'super_admin'`.
  - Behaviour is identical while step 4 holds.
  - If a future refactor drops the step-4 re-read, a caller demoted mid-call gets the brand refusal instead of reaching any brand (architect S3).
  - In the same edit, add to the L278 comment that this list must equal `auth_profile_is_privileged()`'s set (code-reviewer #5).
  - Optional while the body is open: rename `v_found` to `v_target_found` (code-reviewer nit).
- **1d. Header and section-banner comments. [text only]** They sit outside the function bodies, so no md5 changes.
  - L73: "pinned by pgTAP K-6" becomes "pinned by B1a/B1b/D2a (K-6 checks structure only)".
  - L82 and L351: "byte-identical" becomes "logic and message strings identical; three comment glyphs (em dash, arrow, section sign) ASCII-fied". Leave L301 ("byte-identical to delete-user's brand gate"), which is true.
  - Spec coordinates (L6, 44, 50, 55, 68, 75, 92, 115, 118 and the section banners): use labels that explain themselves, and cite only the spec file name.
  - L115: point the rollback line at `specs/191-demote-profile-brand-scope/rollback.sql` (step 4).
  - Architect N1: add `prosecdef` (t/f/t/f for RPC / trigger fn / helper / wrapper), `proconfig`, owner and `proacl` to the prod-apply list at L107-113.
  - Optional nits: spell out the "spec 163 M1 lesson" (L97); reword the isolation-level claim (L63-64); fix the profiles INSERT policy comment's lowercase "spec 164:"; use `position()` instead of `LIKE` in the DO block's fourth check (architect N2).
- **Local re-apply.** The file is safe to re-run (`create or replace`, `drop policy if exists`). Re-run it with `psql -v ON_ERROR_STOP=1 -f` on the shared stack.
  - Do **not** run `supabase db reset`.
  - Do **not** insert the `schema_migrations` row again.
  - Confirm the live `prosrc` of all four functions matches the file.

**2. Test edits. [code, this spec: test files only]**
- **S3(a): add a catalog arm for the step-4 re-read.** Should-fix, security-relevant. Add it to `demote_profile_brand_scope.test.sql`.
  - Strip comments first with `regexp_replace(prosrc, '--[^\n]*', '', 'g')`.
  - Assert that the RPC body still has the post-lock check (`v_caller_role is null` … `not in ('admin', 'master', 'super_admin')` … `'forbidden'`) after `for no key update`.
  - Assert that it matches none of `auth_is_privileged|auth_is_admin|jwt|app_metadata`.
  - This is the only CI protection for the guard that keeps a demoted-while-waiting caller from crossing brands.
- **L1 arm (if 1b is taken):** the staff user `2222` calls the wrapper directly and gets 42501 `forbidden`.
  - Lock absence can't be checked after a `throws_ok`, because the subtransaction releases the lock (architect N5).
  - So check the order in the comment-stripped `prosrc` instead: the `auth_profile_is_privileged()` check comes before `pg_advisory_xact_lock`.
- **Code-reviewer test items:**
  - A5c: re-assert S1's claims (`pg_temp.as191(current_setting('test.s1', true), 'super_admin')`) before the call.
  - E-2: add an `ok(exists …)` precondition for `d1-164@local.test`. `profiles_insert_hardening` goes from `plan(79)` to `plan(80)`.
- **Test-engineer nits:** add a post-state check after D2b, D4a and D4b. Today they are bare `lives_ok`, which an UPDATE that matches 0 rows would pass.
- **Optional:** strengthen K-7 by matching `auth_is_privileged` and `jwt_expiry`. Make K-6's `count\s*\(` check ignore comments.
- Set `plan()` exactly in both files.

**3. Re-verify locally. [run, this spec]**
- pgTAP:
  - `demote_profile_brand_scope`, `profiles_insert_hardening`, `demote_self_guard` (still unmodified) and `delete_last_privileged_guard`
  - then the full `npm run test:db`
- `npx jest` (full suite, per project memory), `npm run typecheck:test`, and the `npx tsc --noEmit --types node,jest` workaround (the local `npm run typecheck` is red for environment reasons).
- Mutation rows, each run in `begin … rollback` as before:
  - Wrapper privilege check removed: the new L1 arm must go red.
  - **Step-4 re-read removed: the new S3 arm must go red.** This is the observation S3 said was missing.
  - Step 7 put back to `in ('admin','master')`: expect it to stay green, since behaviour is identical. Record that.
- Recapture the normalized md5s of the RPC and the wrapper in the Implementation notes. These become the H2 references. The helper and the trigger function keep `7b8fd913` and `1ce30998`.

**4. S2: write and dry-run the rollback SQL. [code, this spec: new file `specs/191-demote-profile-brand-scope/rollback.sql`]**

Should-fix. It comes after step 3 so the dry run runs against the final local state. Precedent: 194's `prod-verify.sql`.

- One transaction, with `set local lock_timeout` as in 1a, in the design §10 order:
  1. Recreate the three policies verbatim from `20261007000000` (L56-61 and L276-322), with spec 164's profiles INSERT comment, then re-run 164's DO block.
  2. Restore `assert_brand_id_immutable_for_self()` from `20260517050000` L196-248, comment included.
  3. Restore `demote_profile_to_user` from `20260520000000` verbatim, with its grants.
  4. Drop `assert_demote_not_last_of_role(uuid,text)` and `auth_profile_is_privileged()`, last.
- **Copy the trigger function's bytes from the old migration. Don't retype them.** Its em dash, arrow and section sign must survive, or the normalized md5 won't return to the H1 baseline `c7318dd8…`.
- Inside the dry run (`begin; \i rollback.sql; <checks>; rollback;`), assert:
  - trigger fn md5 = `c7318dd8…`
  - RPC md5 = `f77056fb…`
  - `assert_not_last_of_role` md5 = `0638c51b…`
  - the 164 counts are 1/1/1
  - both new functions are gone
- Also run the dry run's md5 check through the same channel the prod rollback would use (MCP `execute_sql`) at least once, so you know the non-ASCII bytes survive that path. If that isn't possible before apply, record that the post-rollback md5 check is the proof.
- Header notes to include:
  - the version-row rule: not yet pushed, delete the row; already pushed, ship a forward migration instead
  - "if the `user_stores` follow-up (X2 below) has landed, roll it back first, because its policy depends on `auth_profile_is_privileged()`"

**5. Spec text. [text only]**
- **S5:** in §6.5, change P1 to **P1a** (same caller, layer 1: S2 waits on `transactionid`, no mutation step) and **P1b** (the developer's P1′: callers A1 and X with different master targets; S2 waits on `Lock/advisory`). Run the advisory-lock mutation step against P1b.
- §1.2 and §11: correct the "K-6 pins the coupling" sentence. §1.4: change "BYTE-IDENTICAL" to "logic and message strings identical".
- If 1b is declined, narrow 1.3(d) to the RPC path.
- Implementation notes:
  - add the auditor's R1-R7 as B4 evidence
  - record the step 3 results and the new md5s
  - record which of E2 and F3 were run or waived (step 7)
- `## Files changed`: add `rollback.sql` and the smoke edits.

**6. Smoke script. [code, this spec: `scripts/smoke-edge-roles.sh`]**
- Define `XB_CLEANUP_SQL` once next to `XB_BRAND` / `XB_TARGET`, and use it at L131-133, L550-552 and L614-616 and in the header recovery note (code-reviewer).
- Code-reviewer nit, worth taking while the file is open: L570-578. If the `XB_PRE` snapshot comes back empty or the role swap fails, fail the arm early instead of sending the request as a super_admin.
- Optional: replace `&& pass || fail` with an `if` block.
- Run `bash -n` after editing.

**7. What must run before ship, and what the owner can waive. [owner decision + run]**

| Item | Must run before prod apply? | Why |
|---|---|---|
| Steps 3 and 4 (local suites, mutations, rollback dry run) | **Yes** | They prove the edited bodies and the rollback. They don't touch the shared login |
| **C4: `e2e/invite.spec.ts`** | **Yes, recommended.** The owner picks how (decision 1) | The invitations INSERT/UPDATE policies changed under it, and invites are a live prod flow. PIH sections A and D cover the same shape in SQL, so risk is low, but C4 names this run explicitly. Two ways to run it: (a) locally in a quiet window (serial; uses `admin@local.test`; Metro on :8081), or (b) push a **non-`main` branch** carrying the explicit-path commit. `e2e.yml` runs on every push with a fresh `supabase start` + `db reset`, so it doesn't disturb the shared stack. `db-migrations-applied` will fail on that branch, which is expected. Both need the owner's go-ahead. Waiving it means accepting the first post-push `e2e.yml` run on `main` as the check, after prod already has the policies. I don't recommend that |
| **F3: Arm 7b of `smoke-edge-roles.sh`** | **The owner can waive it, with a record** | The contract the arm protects is proven: the test-engineer's minted-JWT request got 42501 → HTTP 403, and every 191 refusal of that kind shares the errcode. What is unproven is the script itself (fixture, role swap, trap cleanup), which isn't in CI. Recommendation: waive for ship and run it once in the next quiet window. Arm 4 promotes `admin@local.test`, so it needs the owner's go-ahead |
| **E2: manual UI toast** | **The owner can waive it, with a record** | B1b pins the exact string `'cannot demote the last master'` for a super_admin caller through the same RPC. The revert-plus-toast path was traced by reading (`useStore.ts:2064`, `db.ts:5564`), and no `src/` code changed. Running it needs `admin@local.test` promoted to super_admin and a browser. Waive with a record, or run it if the owner is at a browser anyway |
| B4 two-session probes | Done | Developer P1′/P2/P3 plus the auditor's R1-R7. Don't repeat them unless 1b or 1c changes lock order (they don't) |
| H1 prod read-only pre-checks | **Yes** | Step 8 |
| F4: post-push gates | Yes, after the push | Step 11 |

### Prod and landing (each needs the owner's go-ahead)

**8. H1: read-only pre-checks** (MCP `execute_sql`, project `ebwnovzzkwhsdxkpyjka`). Run design §10 H1 as written: queries 9(a)-(e), the role counts, the NULL-brand admin/master count, and `schema_migrations` from `20261108000000` on. Read `jwt_expiry` from the dashboard. It is the length of the stale-claim window that remains (decision 7).
- **Stop if:** there are 0 super_admins, any admin or master has a NULL brand, any C5 count ≠ 1, (d) returns rows, an md5 drifts, or `profiles` has extra triggers.

**9. H2: apply.**
- Run the **final** file body. Insert exactly `('20261109191000', 'demote_profile_brand_scope')`.
- Verify the four functions against the step 3 references (md5, `prosecdef` t/f/t/f, `proconfig`, owner `postgres`, `proacl` compared with local), and check that `assert_not_last_of_role` is unchanged.
- Verify the policy text, the C5 counts, and anon EXECUTE = false on the RPC and both new functions.
- The optional rolled-back self-demote probe as the owner (design §10 H2 step 5) is worth running.

**10. Commit by explicit paths. [owner go-ahead; the user runs the commit]**
- **Spec 191's paths:**
  - `supabase/migrations/20261109191000_demote_profile_brand_scope.sql`
  - `supabase/tests/demote_profile_brand_scope.test.sql`
  - `supabase/tests/profiles_insert_hardening.test.sql`
  - `scripts/smoke-edge-roles.sh`
  - `specs/191-demote-profile-brand-scope.md`
  - `specs/191-demote-profile-brand-scope/` (reviews plus `rollback.sql`)
- **Run `git diff` first** on `profiles_insert_hardening.test.sql` and `smoke-edge-roles.sh`. Both are tracked, show ` M` in a shared tree, and no reviewer had a per-file diff. Confirm the only hunks are 191's.
- **How:** `git add` the untracked 191 files, then immediately `git commit -m "…" -- <the 191 paths>`.
  - The index holds another session's staged spec 190 work, including `20261109140000_po_number_sequence.sql` and its tests. A bare `git commit` would carry it, and `db-migrations-applied.yml` would hard-fail if that version isn't on prod.
  - `git commit -- <paths>` commits only those paths, from the working tree, and leaves 190's entries staged.
- **Leave out:** `README.md` (other sessions' edits; see Out of scope), `package.json`, everything from 186/187/188/189/190/194/195/196, and `20261109195000` and `20261109200000`.
- **Before pushing:**
  - `git show --stat HEAD` must list `20261109191000` as its only migration.
  - `git log origin/main..HEAD` must contain only commits whose migration versions are already on prod.
- **Version order (architect N6):** `…191000` sorts before 195's `…195000` and the other session's `…200000`. Applying through MCP and the set-based drift gate are both fine in any order, and so is a fresh replay. A later `supabase db push` against a stack that has 195 but not 191 would want `--include-all`. That is informational only.

**11. Push, then F4.** Prod must already have `20261109191000`. Confirm that the latest `main` runs of `test.yml` and `db-migrations-applied.yml` are green, and check `e2e.yml` by hand (project memory). If any is red or still running, surface the run URL and stop.

### Owner decisions
1. **How C4 runs:** a local quiet-window run, or a CI run on a non-`main` branch (recommended, because it doesn't disturb the shared login). Waiving it to rely on the post-push run is not recommended.
2. **F3 and E2:** waive with a record (recommended) or run once. Either way, record it in the spec.
3. **Security L1 in this spec:** recommended yes (1b). Declining means a text-only fix plus an Out-of-scope line.
4. **S3(b), the fail-closed step 7:** recommended yes (1c). It is the architect's own suggestion.
5. **Security L3 (anon EXECUTE on `assert_not_last_of_role`): recommended as a separate spec, not 191.**
   - The design and B3 explicitly fix the helper's grants as "not changed".
   - `delete-user` calls the helper as `service_role`. Before anyone revokes from PUBLIC, someone must confirm that `service_role` has its own explicit grant, and re-run `smoke-delete-user.sh`. That pulls an edge-function check into a spec that otherwise touches no edge function.
   - It is a one-line fix. Put it in X1 below, which already deals with anon oracles (164-M1's `get_pending_invitation`).
   - Folding it into 191 is possible. The extra cost is the `service_role` grant check, the delete-user smoke, and a K-arm.
6. **Security L2 (existence/role oracle):** already accepted in the spec. Acknowledge that A3's string identifies the owner's uuid as a super_admin to a brand admin who has it.
7. **What stays open after 191:**
   - A stale admin claim still passes `auth_is_privileged()` across the rest of RLS for up to `jwt_expiry`. That covers 107 policies and 22 functions locally, including invitations SELECT/DELETE, the `user_stores` admin arm and "Admins can update any profile".
   - 195 is still needed to close the cross-brand self-link.
   - The fixed end of the stale-claim window is X4.
8. **D2d consequence:** the last master can't be promoted straight to super_admin (`cannot demote the last master`). Workaround: promote someone else to master first.
9. **G3, CLAUDE.md:** approve or decline the proposed sentence on the spec 031 last-of-role bullet. The code-reviewer also suggests a line telling policy authors that role-changing writes use `auth_profile_is_privileged()`, so they don't pick `auth_is_privileged()` by habit. This spec doesn't edit CLAUDE.md.
10. **Go-ahead** for the branch push (if decision 1 takes that route), the H2 apply, the commit and the push.

### Follow-up specs: 187, 195 and 191, de-duplicated

| # | Follow-up | Sources it merges | Shape | Depends on |
|---|---|---|---|---|
| **X1** | **Invitations hardening: brand scope, sign-up confirmation, bounded expiry** | 195-H1 (a)(b)(c); 164-M1 (squatting and the anon `get_pending_invitation` oracle, out of scope in 191); 191-M1(a), the expiry bound; 191-L3 if decision 5 says so | (a) Invitations SELECT/DELETE get the INSERT/UPDATE brand- and store-scope predicate, using `auth_profile_is_privileged()`. (b) Email confirmation, or claim the invitation on first verified sign-in. (c) Add `expires_at is not null and expires_at <= now() + interval '7 days'` (or similar) to the P_INV WITH CHECK. (d) Re-run 164's P-6 pending-invitation check. Update the K-13 pin in `profiles_insert_hardening.test.sql` (`qual = 'auth_is_privileged()'`) | 191 on prod (helper). Owner pre-reads: prod Auth sign-up and confirm-email settings, and which mail path confirmation emails would use. Project notes say Resend has no verified domain and the auth email hook is disabled, which may favour claim-on-verified-sign-in over confirmation emails |
| **X2** | **`user_stores` admin policy reads `profiles`** | 195-M1 | Swap `auth_is_privileged()` for `auth_profile_is_privileged()` in USING and WITH CHECK of `"Admins can manage all store links"`. **Change it from `to public` to `to authenticated`** in the same migration, otherwise anon reads raise `permission denied for function auth_profile_is_privileged` (the spec 152 signature); don't fix it with an anon grant. Re-capture 195's T3 literal and P-1 md5. Update the helper's `comment on function`. Add a 42501 arm. Note the new rollback dependency in 191's `rollback.sql`. Optionally write the call as `(select …)` | 191 **and** 195 on prod. Small enough to ride with X1 if both have landed when X1 is built |
| **X3** | **Invitation provenance and void-on-demote** | 191-M1 (b)(c) | `invited_by uuid not null default auth.uid()`. Then **either** `demote_profile_to_user` and `delete-user` void the target's pending invitations, **or** `register_invited_profile` refuses when the inviter is no longer privileged in that brand. Touches 191's RPC (a new migration, because 191's body is frozen once applied), `delete-user` and `register_invited_profile`. Could be bundled with "audit rows for demotions" (191 follow-up, 187 follow-up D), since both touch the demote path | X1(c) bounds the window in the meantime |
| **X4** | **Converge `auth_is_admin()` / `auth_is_privileged()` on `profiles`** | 187-SF-R1; 191 OQ-3 / out-of-scope bullet 1; the rest of 164-M2 | Make the JWT leaf read `profiles`. Live counts first (local: 107 policies, 22 functions; about 84 pgTAP files set `app_metadata` claims). Plan the per-row lookup cost (the `(select …)` initplan pattern). This is the only fix that ends the stale-claim window across all of RLS. It **subsumes X2**, the stale-claim rename through "Admins can update any profile", and the remaining exposure 187 accepted under AC-37. After it lands, `auth_profile_is_privileged()` can be retired or become the implementation | Best after X1/X2. File it now if the owner wants a fixed end date for 187's accepted exposure |

Smaller items to keep in the backlog, not new specs yet:
- `delete-user` last-of-role race (191 L4 and the spec's follow-up)
- audit rows for demotions, together with 187-D (privileged renames and email changes)
- the rest of 187's list (C, E, F, `ordered_at`, blank names, and so on), which stays as its re-proposal records it

**Which to write first: X1.**
- It is the only High.
- It is cross-tenant and needs no stale token: any brand admin can use it.
- With 191 and 195 both landed, it is the remaining route by which an outside profile gets another brand's store or a lasting admin role there.
- The 195 proposal already ranked it "write it next, ahead of non-security work".
- Add X2 to it if 195 and 191 are both on prod by then. Otherwise write X2 right after.
- X3 comes next; X1's expiry bound makes it less urgent.
- X4 is the largest, so write it last, unless the owner wants it filed now to put an end date on 187's accepted exposure (decision 7).

**Interim owner action, read-only, no spec needed (from 195's proposal, still current):**
- Check prod Auth's sign-up and confirm-email settings.
- Review prod's pending invitations (4 at 195's pre-check) and revoke stale ones, especially any created by an admin who has since been demoted (191-M1).
- Keep new invitations short-lived until X1 lands.

## Out of scope for this review
- **`README.md` (G2).**
  - In the working copy, the row is now at L230, not L229, because other sessions' unstaged edits shifted it.
  - "Role demotion with self- and last-of-role guards" becomes true when 191 ships, so G2 is met without an edit (architect N9).
  - Adding "brand-scoped" is optional. Do it in a later README pass once the other sessions' README hunks are committed, or stage that one hunk by hand. Keep `README.md` out of 191's path-list commit, because `git commit -- README.md` would take the other sessions' edits with it.
- **Security L3:** goes to X1 unless decision 5 folds it into 191.
- **Security L2 and L5:** accepted as designed. **L4:** backlog.
- **Architect nits not adopted above:** N3 (the trigger path doesn't re-read the caller; record it as accepted, and don't add a caller row lock, because it could deadlock), N4, N5, N7 and N8 (optional probe).
- **Code-reviewer nits not adopted above:** the redundant `tg_op` in the `elsif`, arm-label consistency, "state after this section" comments in the linear test file, and the K-2 label wording. All optional.
- **Environment:** the local `npm run typecheck` is red because of empty `node_modules/@types/* 2` folders. CI is the real gate.
- **Spec 187's and spec 195's own open items** stay in their proposals. No object overlap with 191 (architect).
- **`app.json` slug:** not touched.

## Handoff
next_agent: NONE
prompt: FIXES_NEEDED, 7 items before prod/commit, top: one migration edit pass (S1 lock_timeout + L1 wrapper privilege check + S3(b) fail-closed step 7), then the S3(a) re-read catalog arm, rollback.sql with byte-exact trigger restore, and C4 e2e run
payload_paths:
  - specs/191-demote-profile-brand-scope/reviews/release-proposal.md

---

# Final verdict (2026-11-10)

Release-coordinator, 2026-11-10. Covers the spec's "Fix pass (backend-developer, 2026-11-10)", which applied items 1 to 6 above after the owner's "Apply all three (Recommended)", and the new `rollback.sql`. No new review round ran. The proposal above is left as it was. Sources: the spec (ACs A to H, Open questions resolved, design §8 and §10, Implementation notes, Fix pass, Files changed), `rollback.sql` in full, the migration's wrapper and RPC (L144-374), and the three workflow files' triggers. I ran nothing.

## Verdict
verdict: SHIP_READY
rationale: Every Should-fix from the four reviews is fixed or recorded as the owner decided, no Critical is open, and the changed function bodies are exactly the text the reviewers proposed, each backed by a mutation that turns a new arm red. Two things must hold before the prod apply: C4 must pass on the pushed test branch (if it is red, this becomes FIXES_NEEDED), and `test.yml` and `db-migrations-applied.yml` must still be green on `main` at the pre-push re-check.

## Findings summary
- **code-reviewer:** no re-review. The fix pass took the Should-fix items: the K-6 claim, the "byte-identical" wording, self-describing labels, the rollback pointer, the role-list comments, A5c and E-2-pre, and the single `XB_CLEANUP_SQL`. Several nits were taken too. Nothing is open beyond optional nits.
- **security-auditor:** no re-audit. L1 is fixed in this spec (wrapper privilege check, plus W-1 and K-10). L3 and M1 moved to spec 198 and follow-up X3. L2 and L5 are accepted, and L4 is backlog.
- **test-engineer:** no re-review. S3 now has CI protection (K-9). §6.5 P1 is split into P1a and P1b. The D2b, D4a and D4b post-state checks were added. E2 and F3 (the script) are waived by the owner with a record. C4 is still to run (see below). G2 is met without an edit once 191 ships.
- **backend-architect:** no re-review. S1 (`lock_timeout`), S2 (`rollback.sql`), S3(a) and (b), and S5 are done. N1 (`prosecdef` and the related lines in the prod-apply list) and N2 (`position()`) are done.

### What I checked by reading
- **Migration:**
  - `set local lock_timeout = '5s';` sits straight after `begin;` (L144, L150).
  - The wrapper's first statement is the `auth_profile_is_privileged()` check, raising 42501 `forbidden` (L209-213). It comes before the role filter (L217) and `pg_advisory_xact_lock` (L221).
  - Step 7 is `v_caller_role is distinct from 'super_admin'` (L347).
  - The step-4 re-read is unchanged and commented as pinned by K-9 (L318-327).
  - `v_target_found` replaces `v_found`.
  - The wrapper's comment says it refuses before any lock.
- **`rollback.sql`:**
  - One transaction with `lock_timeout`, in the design order: policies with spec 164's comment and DO blocks, then the trigger function, then the RPC with `comment … is null` and its grants, then the two drops.
  - The header has the version-row rule (not pushed: delete the row; pushed: ship a forward migration) and the expected md5s.
  - It warns against retyping the file (the non-ASCII bytes) and carries a `pg_depend` check for later dependants, including X2 or spec 198.
- **Spec text:** the owner's decisions on 1b, 1c, C4, F3 and E2, L3 and M1 are recorded under Open questions resolved (L239-245), with the waiver evidence. The Fix pass records the waivers again (L1010).
- **Relayed, not reproduced:**
  - The fix-pass runs: 60/60, 80/80, 6/6, 4/4 and 4/4 on the named files; `test:db` 104/104; jest 301 suites and 3,836 tests; `typecheck:test` exit 0.
  - The mutation table, including "step-4 re-read removed" turning K-9 red where it passed 54/54 before.
  - The rollback dry run returning `c7318dd8…`, `f77056fb…` and `0638c51b…`.
  - The live-equals-file md5s.
- **One correction to my 2026-11-09 proposal above:** a non-`main` branch push does **not** run `db-migrations-applied.yml`. It runs only on pushes to `main` and on PRs. So the test branch shows no red migrations gate, as long as no PR is opened.

### Is a focused re-review needed?
**No. The developer's evidence is enough.**
- The fix pass changed two function bodies (RPC `bcfcc470…`, wrapper `19495402…`), but only with the statements the architect and auditor wrote out: the wrapper's privilege check, and step 7's fail-closed condition. I read both in place.
- Each change has an arm that a mutation turns red: K-10 and W-1 for the wrapper, K-9 for the step-4 re-read. The one change meant to be behaviour-neutral (step 7) stays green when reverted, as predicted.
- Lock order is unchanged, so the B4 races (the developer's P1′/P2/P3 and the auditor's independent R1-R7) still apply.
- A re-review would mostly re-run the developer's mutations. The test engineer flagged the same gap ("self-reported") in the first round, and the auditor's independent races closed it.
- What isn't independently checked yet: 191 has never built from scratch. The test branch (Landing step C) closes that.

## Recommended next steps (ordered)

### Spec 191, before its prod apply
1. **C4: `e2e/invite.spec.ts` on the pushed test branch** (Landing step C). Required by the owner's decision. Read the Playwright report, not just the job colour. If it is red, stop. The migration can still be edited, because prod doesn't have it.
2. **F3 and E2: waived with a record** (owner, 2026-11-09). If the owner runs `smoke-edge-roles.sh` for spec 187 before the `delete-user` deploy, Arm 7b runs in the same pass. Record that result in spec 191 in place of the waiver. Arm 4 promotes `admin@local.test`, so it needs a quiet window and the owner's go-ahead.
3. **H1, read-only**, in the shared pre-check pass (Landing step D1): queries 9(a)-(e), role counts, NULL-brand admins and masters, `schema_migrations` from `20261108000000`, and `jwt_expiry`. Stop on the §10 conditions.
   - If H1 runs before 187 applies, query (a) still lists `Admins can delete profiles`. That is expected.
   - `assert_not_last_of_role`'s `proacl` differs between local (anon and PUBLIC granted) and prod (neither, per the spec). H2 compares only that function's md5, so the difference is expected. Its grants belong to spec 198.
4. **H2 apply:** the committed body, then `('20261109191000', 'demote_profile_brand_scope')`. Check against the fix-pass table, using this spec's normalized md5 (`md5(regexp_replace(prosrc, '\s+', ' ', 'g'))`, which is not spec 187's formula):
   - RPC `bcfcc47094be06d97000053bb396fc51`
   - trigger function `1ce30998e0d1264f116c0beb8b4cc76c`
   - helper `7b8fd9139961526f16dbd177e371e337`
   - wrapper `19495402c5dacfa14d5b67b048192fd1`
   - `assert_not_last_of_role` `0638c51b…`, unchanged
   - `prosecdef` t/f/t/f, plus `proconfig`, owner and `proacl`
   - policy md5s `54fa3c18…`, `5b13ae0e…` and `5939fcd6…`
   - C5 counts 1/1/1, and anon EXECUTE false on the RPC and both new functions
   - The rolled-back self-demote probe as the owner is still worth running.
5. **Rollback readiness:** `rollback.sql` was never run through MCP, because that channel is prod. Its post-rollback md5 check is the proof that the non-ASCII bytes survive. It applies only before the push. After the push, its body ships as a forward migration.

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

### CLAUDE.md: the owner must confirm (not yet accepted)
- **G3** (OQ-4, a PM recommendation the owner was never asked about). Append to the spec 031 last-of-role bullet: "Role demotions through `public.demote_profile_to_user` and super_admin direct role edits on `profiles` call the same helper, with refusal strings `'cannot demote the last super_admin'` / `'cannot demote the last master'` (spec 191)."
- **Optional (code-reviewer):** one line saying role-changing writes (the demote RPC, invitations INSERT/UPDATE, profiles INSERT) check privilege with `auth_profile_is_privileged()`, which reads `profiles`, not `auth_is_privileged()`, which trusts the JWT claim.
- **Optional (mine):** the self-guard bullet cites `20260520000000_demote_profile_to_user_rpc.sql` as the reference shape for `'cannot demote self'`. From 191 on, the live body is in `20261109191000_demote_profile_brand_scope.sql`. Point at both, or at the newer one.
- If confirmed, add these in 191's commit. If `rollback.sql` is ever used, remove them in the same change.

## Out of scope for this review
- **Spec 198** (invitations hardening, X1, plus L3 and M1(a)): being designed now. It depends on 191 and must update K-13 in `profiles_insert_hardening.test.sql` after 191's commit exists.
- **X2, X3 and X4** as listed above. X4 still has no spec file. It is the only end to the stale-claim window, including 187's AC-37b.
- **`README.md` (G2):** stays out of this commit, as the owner decided.
- **`app.json` slug:** not touched.

## Handoff
next_agent: NONE
prompt: SHIP_READY (2026-11-10 final), conditional on C4 (`e2e/invite.spec.ts`) passing on the pushed test branch. No re-review needed. Fix-pass bodies verified by reading. H1 pre-checks, then H2 apply second in the 187 → 191 → 195 order. The owner must confirm the CLAUDE.md G3 sentence.
payload_paths:
  - specs/191-demote-profile-brand-scope/reviews/release-proposal.md
