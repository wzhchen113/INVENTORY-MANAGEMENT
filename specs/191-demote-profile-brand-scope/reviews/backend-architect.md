# Spec 191: backend-architect post-implementation drift review

Reviewer: backend-architect (post-impl mode), 2026-11-09.

Scope:
- `supabase/migrations/20261109191000_demote_profile_brand_scope.sql`
- `supabase/tests/demote_profile_brand_scope.test.sql`
- the spec 191 edits in `supabase/tests/profiles_insert_hardening.test.sql`
- Arm 7b in `scripts/smoke-edge-roles.sh`

Compared against: `## Backend design` in `specs/191-demote-profile-brand-scope.md`.

Limits: I read the files and did not run anything. That means no pgTAP run, no smoke run, no catalog queries and no `git diff`. Results the developer reports (54/54, 79/79, 102/102 files, the mutation table, P1-P3) are taken from the Implementation notes. I did not re-run them.

**Verdict:** no Critical findings. The build matches the design's contract. That covers the check order, every refusal string and SQLSTATE, the two-layer locks in rows-then-advisory order, the wrapper's translation, the trigger branch, the three policies and the fail-closed block. Five Should-fix items:
- two about prod-apply safety: `lock_timeout`, and the rollback SQL
- one coverage gap in the step-4 re-read
- one set of acceptance criteria not yet run: F3 smoke, C4 e2e
- one correction to my own design: the P1 probe

---

## Critical

None.

---

## Should-fix

### S1. The migration has no `lock_timeout`, but it takes AccessExclusiveLock on `public.profiles`
- **Where:** migration L123 (`begin;`), followed by `drop policy` / `create policy` on `profiles` (L441-447) and `invitations` (L457-508).
- **Why it matters:**
  - `DROP POLICY` and `CREATE POLICY` take AccessExclusiveLock on the table and hold it until `commit`.
  - `profiles` is the busiest table in the RLS graph: `auth_is_super_admin()`, `auth_can_see_brand()` and `auth_can_see_store()` read it on nearly every request.
  - If a long-running reader holds AccessShare when the prod apply runs, the DROP queues behind it, and every later `profiles` read app-wide queues behind the DROP.
- **Precedent:** the other migrations dated 2026-11-05 to 2026-11-09 all set it: `20261105000000`, `20261108130000`, `20261109120000`, `20261109140000`, `20261109170000`, `20261109195000` and `20261109200000`. 195's comment gives the reason (L65-68). This file is the odd one out.
- **Fix:** add `set local lock_timeout = '5s';` straight after `begin;`.
  - This changes no `prosrc`, so none of the recorded md5s move.
  - The local apply already happened and does not need repeating. The drift gate compares versions, not file bytes.

### S2. The rollback SQL does not exist yet
- **Where:** migration header L115-116 says "SQL in specs/191-… section 10 ('Rollback')". But section 10 contains only my four-step recipe, not SQL, and the Implementation notes add none. Design §10 said the rollback SQL would be "kept in the review notes".
- **Fix:** before H2, write it out in full, for example as `specs/191-demote-profile-brand-scope/rollback.sql` (194's `prod-verify.sql` is the precedent), and dry-run it locally inside `begin … rollback`.
- **What the rollback must get right:**
  - **Step 2 restores `assert_brand_id_immutable_for_self()` from `20260517050000` L196-248 byte for byte, including the em dash, arrow and section sign.** Only then does the normalized md5 return to the H1 baseline `c7318dd8…`. A rollback built from the ASCII copy in this migration would leave a function that matches neither the repo nor the baseline. This is a side effect of deviation 2.
  - Step 1 recreates the three policies verbatim from `20261007000000` L56-61 and L276-322, with the spec 164 profiles INSERT comment. The two invitations policies had no comment before 191, and drop-and-recreate clears 191's comments automatically. Then re-run 164's DO block.
  - Step 4's `drop function`s come last. Note for the future: once the M1 follow-up (below) makes `"Admins can manage all store links"` depend on `auth_profile_is_privileged()`, step 4 fails on that dependency until the follow-up is rolled back first.

### S3. The step-4 caller re-read has no check that runs in CI
- **Background:** the developer's deviation 4 is correct. Step 2 runs first, so in any single-session test a step-4 mutation is invisible, and removing the re-read entirely also leaves all 54 arms green. The only coverage is P2, and P2 was run once against the **unmutated** code. The developer did not run a P2 mutant, so "only the P2 probe catches it" is an inference, not an observation.
- **Why the re-read is security-relevant, not just tidiness:**
  - Step 7's brand check fires only when `v_caller_role in ('admin','master')`.
  - Suppose the re-read check is removed and a caller is demoted while their call waits on the row lock. Their re-read role is then `'user'`, step 7 is **skipped**, and step 8 is a no-op for an `admin`/`user` target.
  - So the in-flight call demotes the target in any brand. In P2's master-on-master shape this is hidden, because last-of-role refuses instead. An admin-on-admin race shows it.
- **Fix (either one, (a) preferred):**
  - (a) Add a catalog arm to `demote_profile_brand_scope.test.sql`. Strip comments first with `regexp_replace(prosrc, '--[^\n]*', '', 'g')`, then assert:
    - the RPC body still has the post-lock check: `v_caller_role is null` … `not in ('admin', 'master', 'super_admin')` … `'forbidden'`, after `for no key update`
    - it matches none of `auth_is_privileged|auth_is_admin|jwt|app_metadata`

    Comment stripping matters because the RPC's own step-2 comment says "Not auth_is_privileged()". Bump `plan()`.
  - (b) Also, optionally: write step 7's condition fail-closed as `v_caller_role is distinct from 'super_admin'`, so that any non-super_admin role reaching step 7 gets the brand check. My §1.3 pseudocode used `in ('admin','master')`, so this changes the design, not drift. Behaviour is identical while step 4 holds.

### S4. F3 smoke and C4 e2e have not been run
- My §3 status table depends on PostgREST mapping 42501 to HTTP 403 for an authenticated caller. Arm 7b is the only check of that mapping, and it has not run. `bash -n` and a rolled-back fixture dry run are not the arm.
- `e2e/invite.spec.ts` (C4) has not run either. This matters because the invitations INSERT/UPDATE policies changed under it.
- Both are acceptance criteria, not drift, but they must pass before SHIP_READY.
- The shared-login concern is real but bounded. Arm 4's `restore_admin` trap and Arm 7b's own snapshot restore cover it. Run the smoke once in a quiet window and record the result.

### S5. The design's P1 probe should change (my error)
See deviation 5 below. The design text in §6.5 still describes the wrong P1, and its "mutation for P1" step would wrongly pass against it. The developer's notes record the fix, but the design section is what the next person rerunning the probe reads. Amend §6.5 as described in deviation 5 when the spec is next edited (I was told not to edit it in this pass).

---

## Nits

- **N1. The header's prod-apply recipe is shorter than design §10 H2 step 3.** Header L107-113 lists the md5s, policy text and anon EXECUTE. It omits `prosecdef` (expected t/f/t/f for RPC / trigger fn / helper / wrapper, which matches the file), `proconfig`, owner and `proacl`. The headers of 187 (L45-47) and 194 (L43-44) include them. Add one line, or a pointer to §10 H2.
- **N2. `LIKE` treats `_` as a wildcard.**
  - Affected: the DO block's 4th check (L561-568) and K-2/K-16 (`profiles_insert_hardening.test.sql` L241-242, L348-349) use `like '%auth_is_privileged()%'`.
  - It is harmless today. I checked that no policy text produces a false match: `auth_profile_…` and `auth_can_…` cannot match `auth?is?privileged()`.
  - `position(… in …)`, or escaping `\_`, would be exact. This is the same class of issue as 195's L1.
- **N3. The trigger path does not re-read the caller after its wait.**
  - Scenario: a super_admin is being demoted while their own PATCH is running. That PATCH has already passed RLS and `auth_is_super_admin()`, so it completes one more role change. That includes a promotion, which takes no lock.
  - This is ordinary READ COMMITTED behaviour for any RLS check, and P3 shows the last-of-role invariant still holds.
  - Don't add a caller row lock inside the trigger. It would take target then caller, which is the reverse of the RPC's id order, and could deadlock. Record it as accepted.
- **N4. E-2 asserts only `count = 0`.** Design §3 also said "and the row unchanged". Zero rows affected is enough on its own, so adding the row check is optional.
- **N5. Design property 1.3(d), "unprivileged callers never take locks", is not tested.**
  - The "step 2 reverted" mutation is caught only by A2d's brand-string difference.
  - A lock-held probe inside `throws_ok` cannot work, because the subtransaction releases the lock.
  - This is acceptable.
- **N6. Out-of-order version.**
  - `20261109191000` sorts before `20261109195000` (195) and `20261109200000` (`po_number_server_assigned`, which is also on disk but was not in the dispatch list).
  - If either of those reaches prod first:
    - The MCP apply path and the set-based `db-migrations-applied` gate are fine.
    - A fresh `supabase db reset` replays in filename order and is fine.
    - A `supabase db push` or `migration up` against a stack that has 195 but not 191 will want `--include-all`.
  - This is informational only.
- **N7. Arm 7b edge case.**
  - Case: the caller's pre-arm state is neither `admin` nor Arm 4's `super_admin` (so `PROMOTED=0`), and the snapshot restore at L608 fails.
  - Then `restore_admin` does not fire, and the caller stays `(admin, A)`, which is the canonical seed state anyway.
  - This is acceptable.
- **N8. Cross-path race not probed.** RPC and PATCH racing on the same role key, for example a super_admin PATCHing M1 while an admin's RPC demotes M2, was not probed. Both paths go through the same wrapper and key, so P1b and P3 cover it indirectly. A probe is optional.
- **N9. G2 needs no edit.** `README.md:229`'s "self- and last-of-role guards" becomes true when this ships. Adding "brand-scoped" is optional.

---

## The five recorded deviations

1. **Arm 7b instead of Arm 8: accepted.**
   - The existing Arm 8 (spec 167) must run last, because it is the arm that could delete its own caller if it regressed.
   - Putting the new arm between 7 and 8, with `XB_CREATED` cleanup in the EXIT trap and a pre-clean, is better than my design. The design did not know Arm 8 existed.
2. **ASCII-fied comments in the trigger: accepted.**
   - I compared L360-398 with `20260517050000` L203-243. The control flow, conditions and all three message strings are identical. Only three comment glyphs changed.
   - My "BYTE-IDENTICAL" was meant to protect behaviour and the string contract. Pure ASCII for the file was the higher-priority rule (spec 163 M1).
   - Consequences:
     - the new normalized md5 baseline is `1ce30998…`
     - the rollback must restore the original non-ASCII bytes (S2)
3. **L-scope probes four keys: accepted, and it fixes my design.** My L-scope arm probed only the `master` and `super_admin` keys. A wrapper that locked before its role filter would take `last_of_role:admin` or `last_of_role:user`, which my arm never looks at, so it could not have killed the mutation it claimed to kill.
4. **Corrections to the "mutation it kills" column: accepted.**
   - I re-derived A2d. A brand-A `admin` profile with a `super_admin` claim gives `auth_is_admin()` = false (claim not admin/master) and `auth_is_super_admin()` = false (profile), so `auth_is_privileged()` = false. That yields `forbidden` instead of the brand string. Correct.
   - The E-2 analysis is also right: reverting USING alone leaves the profiles-backed WITH CHECK in force, which raises.
   - These corrections are what expose the S3 gap.
5. **P1 with one caller in both sessions: yes, the design's P1 should change.**
   - The developer is right. With A1 as the caller in both sessions, both sets of row locks include A1's row. S2 blocks on layer 1 (`Lock/transactionid`) before it reaches the advisory lock. P1 as written therefore tests layer 1, and the §6.5 mutation (dropping `pg_advisory_xact_lock`) leaves it unchanged.
   - This confirms design claim 1.3(c), that layer 1 serializes any two demotions sharing a caller. It does not undermine the lock design.
   - Amend §6.5 to:
     - **P1a, layer 1 (same caller):** today's P1. Expected: S2 waits on `transactionid`, then `cannot demote the last master`. No mutation step.
     - **P1b, layer 2 (third party):** the developer's P1′. Two different same-brand callers (A1 and X) and two different master targets, so the `{caller, target}` sets do not overlap. Expected: S2 waits on `Lock/advisory` (master key), then `cannot demote the last master`, and 1 master remains.
     - The §6.5 mutation step runs against **P1b**. Expected under the mutant: S2 does not block, and both demotions succeed. The developer observed exactly that.

## Is the throwaway clone database adequate evidence for B4?

**Yes.** It is in fact better than the alternative, because the probes needed S1 to commit fixtures, which the shared database must not get. Reasons:
- The behaviour under test runs entirely inside the Postgres server: row locks, the EvalPlanQual re-fetch under `for no key update`, `pg_advisory_xact_lock`, and READ COMMITTED snapshots. The clone was on the same server (same PG 17 build and settings), and `hashtext` keys are identical.
- The objects under test were checked identical by normalized md5: the five functions, the `profiles` triggers and the `profiles` policies.
- The result values are only meaningful because of the data. The clone's four-profile fixture makes "exactly 1 master left" an exact count.
- One snapshot interaction is subtle and the probes are the only empirical evidence for it. `assert_not_last_of_role` is declared **STABLE** (`20260514160000` L45), so it uses its caller's snapshot. The fresh snapshot after the lock comes from the VOLATILE wrapper's `PERFORM`. P1b (RPC path) and P3 (trigger path) both observed the post-commit count, which is what proves this. The semantics come from the engine, not from anything database-specific.
- B4 asked for a probe "on the local stack". A database on the same local server meets that.

Caveats, none blocking:
- `pg_dump --no-owner` means the owner and `proacl` were not compared. The results show the DEFINER functions saw every row, so ownership was effectively equivalent. Next time, compare `proowner` and `proacl` too.
- The probes did not go through PostgREST. psql with `begin; set local role authenticated; set_config(claims)` reproduces PostgREST's per-request transaction faithfully. The HTTP mapping is S4's concern, not B4's.

## Prod apply and rollback, checked against the built file

| Item | Built file | Status |
|---|---|---|
| Version / name | `20261109191000` / `demote_profile_brand_scope` (header L105-106), same as the filename and the `(version, name)` column set used by 164/187/195 | matches |
| Functions to md5 | header lists the four new or replaced functions, plus `assert_not_last_of_role` unchanged | matches §10 |
| `prosecdef` | RPC `security definer`, trigger fn `security invoker`, helper `security definer`, wrapper `security invoker`, giving t/f/t/f | matches §10. Header omits the check (N1) |
| `proconfig` | all four `set search_path = public, auth` | matches |
| Owner / `proacl` | `create or replace` **keeps** the owner and ACL of the two replaced functions. The RPC's grants are restated (L341-342), and the trigger fn needs none. The two new functions are owned by whichever role runs the MCP apply, so §10's owner check (`postgres`) is the guard. Their `proacl` will include `service_role` from Supabase's default privileges, so compare against local rather than a hard-coded value | correct as designed |
| Policy text | three policies, verbatim from `20261007000000` apart from the helper swap (I compared every clause). The DO block re-asserts the 164 counts plus the helper text | matches |
| Grants | anon EXECUTE revoked explicitly on the RPC and both new functions (L153, L208, L341). K-2/K-4/K-5/K-18 pin it | matches |
| Lock safety | no `lock_timeout` | **S1** |
| Rollback | recipe only, no SQL | **S2** |

## Fresh build, ordering and independence

Filename order of the unapplied migrations on disk:
1. `20261108130000` (187)
2. `20261109120000` (189)
3. `20261109140000` (190)
4. `20261109170000` (194)
5. **`20261109191000` (191)**
6. `20261109195000` (195)
7. `20261109200000` (po_number_server_assigned, not in the dispatch list)

- **What 191 depends on, all earlier:**
  - `assert_not_last_of_role` (`20260514160000`)
  - `auth_is_super_admin` / `auth_can_see_brand` (`20260509000000`)
  - `assert_brand_id_immutable_for_self` and `profiles_self_brand_lock` (`20260517050000`)
  - the three policies (`20261007000000`)
- **Overlap:** none of the other six migrations creates, replaces or drops any object 191 touches. I grepped every one for `profiles`, `invitations`, `demote_profile_to_user`, `assert_brand_id_immutable_for_self`, `assert_not_last_of_role`, `auth_profile_is_privileged` and `brands`. 189, 190, 194 and `…200000` have no hits. They work on EOD functions, `purchase_orders`/`po_items`/`pos_*`, sequences and PO triggers.
- **187:**
  - It drops `"Admins can delete profiles"`, which is `FOR DELETE` (`20260517060000` L127-128). 191's C5 counts only INSERT/ALL on `profiles` and INSERT/ALL and UPDATE/ALL on `invitations`, so they give the same result whether 187 has been applied or not.
  - 187's `tg_order_approvals_guard` reads `profiles.role` inline as the owner, unaffected by any policy. 191 deliberately did not refactor it to the new helper (design §1.1).
  - 187 also touches `audit_log` and `order_approvals`. 191 does not.
  - Either can apply first.
- **195:**
  - It changes only `user_stores` policies, and its DO block counts only `user_stores`.
  - It does not reference `auth_profile_is_privileged()`, as §8 required.
  - 191 does not touch `user_stores`.
  - 191 sorting before 195 causes no problem on a fresh replay or in either prod order (see N6 for the CLI `--include-all` note).
- **Tests:** every `profiles`/`invitations` fixture insert in the other in-flight test files (195, 194, 190, `…200000`) runs as postgres, so the policy swap cannot break them.

## Spec 195 security M1: is `auth_profile_is_privileged()` suitable for the `user_stores` admin policy?

**Yes, on the conditions below.**

Why it fits:
- Its role set (`admin`, `master`, `super_admin`) is exactly `auth_is_privileged()`'s, with the source moved from the JWT to `profiles`. Legitimate callers are unaffected. The super_admin arm already read `profiles`, so super_admins see no change.
- It is SECURITY DEFINER with a pinned search path, never reads the JWT (pinned by K-3), and costs one primary-key lookup.
- It closes M1 directly. A demoted admin who keeps a brand has `profiles.role = 'user'`, so the helper returns false and USING / WITH CHECK refuse the self-link.

Conditions the follow-up must meet:
1. **Change the policy's role from `to public` to `to authenticated` in the same migration.**
   - `"Admins can manage all store links"` is `for all to public` (`20260520010000` L115-119).
   - Spec 097 grants anon SELECT on every public table, and 191 deliberately revokes anon EXECUTE on the helper (design §1.1).
   - So an anon read of `user_stores` would evaluate the policy and raise `permission denied for function auth_profile_is_privileged`. That is the signature from the session-loss incident (spec 152), and it would replace today's silent empty result.
   - Do **not** solve this by granting anon EXECUTE. Narrowing the role is the right fix, because anon has no legitimate admin-arm access.
   - Re-check 195's DO block and permissive-policy lint after the change.
2. Re-capture 195's T3 policy literal and P-1 md5 in the same PR, as 195's release proposal already says.
3. Update the helper's `comment on function`, which today lists only the demote RPC, invitations INSERT/UPDATE and profiles INSERT, to include `user_stores`.
4. Update 191's rollback (S2, step 4). The new dependency means the follow-up must be rolled back first.
5. Optional: write the call as `(select public.auth_profile_is_privileged())` so it is evaluated once per query rather than once per row. Admins list `user_stores` in bulk, while 191's three policies are write-only. Today's `auth_is_privileged()` has the same per-row cost, so this is not a regression either way.

---

## Handoff
next_agent: NONE
prompt: Architectural drift review complete. 0 Critical, 5 Should-fix, 9 Nits.
payload_paths:
  - specs/191-demote-profile-brand-scope/reviews/backend-architect.md
