# Release proposal: spec 164 (profiles INSERT hardening)

Inputs read: the spec (including Backend design §0-§11, Implementation notes, and "AC-H browser check: PASS"), plus `reviews/code-reviewer.md`, `reviews/security-auditor.md`, `reviews/test-engineer.md`, and `reviews/backend-architect.md`. For the H1 decision I also checked the `user_stores` call sites in `src/` and `supabase/tests/legacy_permissive_policy_dropout.test.sql`.

CI context: main Claude reports that the latest `test.yml`, `db-migrations-applied.yml`, and `e2e.yml` runs on `main` (e8fdad7) are green. I did not check them myself. Those runs come before 164, so the gates must be checked again after the 164 push.

## Verdict
verdict: FIXES_NEEDED
rationale: No reviewer flagged a Critical, the spec 163 Critical is confirmed closed, and nothing has drifted from the design. One cheap fail-closed migration assertion (architect S1) has to go into the migration file before the prod apply, because adding it afterwards would take a second migration. Three test/comment-only should-fixes should go into the same commit.

## Findings summary
- **code-reviewer:** 0 Critical, 3 Should-fix, 7 Nits (2 of the Nits are out of scope).
  - Stale "registerInvitedUser writes profiles" comments in `src/lib/auth.ts` `inviteUser` / `InviteUserOptions` (~357, 379, 441-443, 450).
  - `invitations_super_admin_rls.test.sql:139` arm (iii) still uses `'manager'`, so its 42501 has two causes and the arm no longer tests the privilege check on its own.
  - The `order_approvals.test.sql:416,418` OR-tail regex is now live. It lacks the canonical `(?!\s+and\y)` lookahead and the trailing anchor, so it would flag a legitimate AND-guarded arm.
  - Nits: P_INV is pasted three times; the PEND predicate is duplicated; the lint header documents the regex wrongly and says "two copies" when there are five; the jest `getSession` proxy for the welcome email; dead `from` builders in the jest mock.
- **security-auditor:** 0 Critical, 2 High (both pre-existing; this diff narrows both), 3 Medium, 3 Low. The verdict on the spec 163 Critical is **CLOSED**.
  - H1: a NULL-brand staff user can give themselves any store in any brand through the own-row write arm of `"Users can manage own store links"`. The auditor confirmed this live. The spec's out-of-scope note at line 159 ("within their own brand") is wrong for NULL-brand users.
  - H2: `demote_profile_to_user` has no brand scope and no last-of-role guard. A brand-A admin demoted the only super_admin in a rolled-back probe.
  - M1: invitation squatting combined with the anon `get_pending_invitation` oracle is now the shortest path from anon to admin.
  - M2: P_INV and the profiles INSERT policy trust a JWT-derived role, so a demoted admin's stale token can mint a durable admin.
  - M3: lint blind spots (`auth.role() = 'authenticated'::text`, `(select auth.uid()) is not null`, `auth.jwt() is not null`).
  - Lows: the R4 count-then-select race; `consume_invitation` is still EXECUTE to `authenticated`, so anyone can burn an invitation (DoS); raw `regError.message` is shown to the user.
  - The auditor's explicit position: neither High should hold the 164 apply.
- **test-engineer:** 31 criteria groups PASS, 0 FAIL.
  - Tests: pgTAP 87/87 files (new file 71/71), jest 219 suites / 2524 tests, `tsc` and `typecheck:test` both clean.
  - AC-H was PENDING at review time and main Claude has since marked it PASS (staff and admin register, land on the right surface, and get the correct `brand_id` / `user_stores` / jwt_role; the existing staff language change still works).
  - Still open: the AC-D sub-item "the Cmd UI invite drawer still works against the new P_INV policy" is only PARTIAL. AC-H seeded invites through SQL and did not exercise the drawer, and `e2e/invite.spec.ts` was not run locally against the migrated stack.
  - Username sign-in was not verified locally because of a service-token mismatch in the local `username-resolve` setup. 164 does not touch that path, so I treat it as unrelated.
  - Rollout AC-R1..R4 cannot be tested in review.
- **backend-architect (post-impl):** no contract drift (D1-D11 all match). 0 Critical, 1 Should-fix, 5 Minor.
  - S1 (a gap in the architect's own design): there is no fail-closed in-migration assertion that `invitations` has exactly one permissive INSERT/ALL policy and one UPDATE/ALL policy. A dashboard-drift policy in prod could OR P_INV back open. Then any anon signup could write its own `role='admin'` invitation for any brand and redeem it.
  - Minors: M1 arm (iii) `'manager'` (same as the code-reviewer item); M2 `order_approvals` regex variant (same); M3 stale comments, which adds `auth.ts:488-493` (the "CHECK would fail" clause is now R6) and `inviteUser.test.ts:23`; M4 the lint header "not yet landed" text is stale; M5 the stuck-invitee runbook needs to be in the release notes (included below).

## Recommended next steps (ordered)

### (a) Pre-apply / pre-commit fixes

**Must land before the prod apply (it changes the migration file):**

1. **Architect S1, invitations policy-count assertion (should-fix; first because it is the only item that changes the migration).**
   - In `supabase/migrations/20261007000000_profiles_insert_hardening.sql`, after the two `invitations` `create policy` statements, add a DO block shaped like the profiles one at :69-82.
   - It asserts `count(*) = 1` for `pg_policies where schemaname='public' and tablename='invitations' and permissive='PERMISSIVE' and cmd in ('INSERT','ALL')`, and again for `cmd in ('UPDATE','ALL')`. It raises with a `164:`-prefixed message.
   - Add matching K-arms to `profiles_insert_hardening.test.sql` and bump `plan(71)`.
   - Keep the file ASCII-only.
   - This changes no function body, so the §9.3 step 3 normalized-md5 references stay valid. Still, re-apply locally with `psql -f` (the file is re-runnable) and recapture the §9.3 step 4 `pg_policies` reference text after the change.
   - Why it is mandatory now: after 164 the invitation row is the trust anchor, and prod check P-5 is only a manual eyeball. With the assertion, the apply transaction aborts with nothing applied if prod has drifted.

**Must land in the 164 commit (test/comment-only; no effect on the prod DB, so they can be done in parallel with step 1):**

2. **`invitations_super_admin_rls.test.sql:139` arm (iii): change `'manager'` to `'user'` (should-fix).** One token. It makes the 42501 depend only on the caller's privilege again.
3. **`order_approvals.test.sql:416,418` (should-fix).** Preferred: copy the canonical OR-tail regex (the lookahead plus the trailing `\s*($|\s+or\y)` anchor) from `permissive_policy_lint.test.sql:132-133`. Acceptable alternative: delete the OR-tail halves, since the global lint already covers `public.order_approvals`.
4. **Stale comments (should-fix, comment-only).**
   - `src/lib/auth.ts` ~357, 379-380, 441-443, 450: reword to "the invitation row is the authority; `register_invited_profile()` (spec 164) copies role/brand/username/stores server-side".
   - `auth.ts:488-493`: change the CHECK clause to "refused server-side (R6) after signUp, leaving an orphan auth user".
   - `src/lib/inviteUser.test.ts:23`: point at pgTAP C-2/C-6.
   - These sit in `registerInvitedUser` / `inviteUser`, not in spec 163's `fetchAllUsers` region.
   - Leave `db.ts:5485` alone; `db.ts` carries spec 163 edits.
5. **Close the AC-D invite-drawer gap (verification only, no code).** On the migrated local stack, run `e2e/invite.spec.ts` (§8.5), or invite one `user` and one `admin` through the Users & access drawer as `admin@local.test`. That exercises P_INV through the real client before prod.
6. **Re-run the full verification:** `scripts/test-db.sh` (all files), `npx jest`, `npm run typecheck`, `npm run typecheck:test`. If you use the hunk-split commit (step (c)-3), run them against the staged-only tree, for example with `git stash --keep-index` or a scratch worktree, so the 164 commit is proven green without the 163 hunks.
7. *(Optional)* A quick backend-architect confirmation that S1 matches its recommendation. The change is small enough that main Claude can verify it directly.

**H1 decision: do not fold it into 164. Open it as an immediate follow-up spec, the next spec after 164.** Reasons:
- **It is pre-existing, and 164 strictly shrinks it.** The population that can exploit it goes from "anyone with the anon key" to "NULL-brand staff", because `user_stores_user_id_fkey` needs a profile. The auditor explicitly says it should not hold the apply.
- **The fix is not a one-liner in this repo.** Dropping the own-row write arm reverses `legacy_permissive_policy_dropout.test.sql` arm (9), which spec 051 pinned as "the legitimate self-onboarding path". That is a product decision the user should make on purpose ("do staff ever self-assign stores?"). It also needs a sweep of the 17 pgTAP files that touch `user_stores`, plus re-review. Folding it in delays a security hotfix whose Critical is already closed.
- **The data supports self-onboarding having no legitimate caller.** `src/` has no `user_stores` insert/upsert from the owning user (only selects, plus the admin-side `deleteStore` delete). So the follow-up should be quick: drop `"Users can manage own store links"` and keep `"Users can read own store links"`. Optionally add the auditor's fix (b), which makes `user_stores_brand_match()` refuse a self-insert by a NULL-brand user.
- **Exposure is bounded until the follow-up ships.**
  - Add the read-only H1 exposure checks to the prod pre-checks (step (c)-1).
  - While prod has one live brand, the impact is horizontal (store to store). If P-3 shows more than one live brand, or the H1 check finds NULL-brand staff holding stores in more than one brand, escalate the follow-up to "apply together with 164" and tell the user.
  - Until it ships, avoid creating zero-store staff invites (they produce NULL-brand profiles).
- **H1 does not gate spec 163.** 163's email reader is gated on a privileged `profiles.role`, which H1 cannot grant.
- **This is the user's call.** If you would rather fold H1 in, do it now, before the apply, while the migration is still unapplied. Expect a re-review of the `user_stores` change and the arm (9) rewrite.

### (b) Follow-up specs (not blocking 164)

In priority order:

1. **H1 (High): `user_stores` own-row write arm.** Immediate, see above. Also correct spec 164's out-of-scope note at line 159.
2. **H2 (High): `demote_profile_to_user` scope plus last-of-role guard.**
   - Add `auth_can_see_brand(target.brand_id)`, require super_admin when the target is `super_admin`/`master`, and add the `assert_not_last_of_role` RPC call that CLAUDE.md already requires for destructive role changes. The missing call is a convention gap, and losing the only super_admin can only be recovered with psql.
   - **Pair M2 with this spec** (replace `auth_is_privileged()` in P_INV, and optionally in the profiles INSERT policy, with a check backed by `profiles`). Both are "who is the role authority for writes that mint or remove roles". In prod, M2 needs an admin who was demoted but kept a brand, and today there is 1 non-owner admin.
3. **M1 (Medium): invitation squatting / email confirmation.**
   - Enable confirmations, claim the invitation on first sign-in, and shrink `get_pending_invitation` to a boolean for anon.
   - Bundle the related invitation-flow Lows here: revoke or drop `consume_invitation` (closes the burn-an-invitation DoS); map RPC refusal and constraint messages to friendly strings in `registerInvitedUser`; and the architect's R1 idea of "on 'User already registered', sign in and call the RPC", which would remove the stuck-invitee runbook.
   - Read-only now: check in the prod dashboard that the auth settings (`enable_signup`, `enable_confirmations`) match `config.toml`.
4. **M3 (Medium, test-only): lint v2.**
   - Allow `(::text)?` after the `auth.role() = 'authenticated'` token, and add tokens for `(select auth.uid() as uid) is not null` and `auth.jwt() is not null`, each with a positive arm.
   - Fold in the code-reviewer lint nits (header regex documentation, the "five copies" warning or a shared view) and architect M4 (stale "not yet landed" header text).
5. **Lows and nits (cleanup backlog):**
   - The R4 count-then-select race: use one `select ... into strict ... for update` and map `TOO_MANY_ROWS`. The impact is negligible. It changes the RPC body, so do it in whichever spec next touches the RPC (M1 is the natural home), not as a post-apply patch on its own.
   - A P_INV helper function to remove the three-way paste, and de-duplicating PEND.
   - jest hygiene: the `getSession` proxy for the welcome email, and dead `from` builders.
   - The unused `name` param in `registerInvitedUser` and the `db.ts:5485` comment.
   - The local `username-resolve` service-token mismatch is a dev-environment issue unrelated to 164. Fix it separately so username sign-in can be checked locally.

### (c) Prod rollout order (164, then 163)

Nothing has been applied to prod or committed yet. Every write step below needs explicit user approval. The user runs `git commit` / `git push`.

**Commit topology: I recommend architect §9.5 option (b).** Commit 164 on its own, staging the `auth.ts` hunks with `git add -p`, push it, then do 163. This meets AC-R4 literally and keeps each `db-migrations-applied` run tied to one migration.
- 164 files: the migration `20261007000000_*`, `profiles_insert_hardening.test.sql`, `permissive_policy_lint.test.sql`, `order_approvals.test.sql`, `invitations_super_admin_rls.test.sql`, `registerInvitedUser.test.ts`, the 164 hunks of `auth.ts` (plus `inviteUser.test.ts` if step 4 touches it), and `specs/164-*`.
- Before staging, confirm which spec owns `auth.signIn.test.ts`. It is modified but is listed under neither spec's Files changed.
- Option (a), one push for both specs, is acceptable from an architecture standpoint. In that case both `20261007000000` and then `20261008000000` must be in prod before the push.

**Steps:**

1. **AC-R1 / §9.2 read-only pre-checks (MCP `execute_sql`, project `ebwnovzzkwhsdxkpyjka`).** Run P-1..P-6 as written and record the results in the spec's review notes. Add:
   - **H1 exposure:** `select p.id, p.name, (select array_agg(distinct s.brand_id) from public.user_stores us join public.stores s on s.id = us.store_id where us.user_id = p.id) as store_brands from public.profiles p where p.role = 'user' and p.brand_id is null;`. Any row with stores in more than one brand means escalate H1 (see (a)).
   - Note the live-brand count from P-3 for the H1 decision.
   - **Stop and report to the user** if P-2 shows a trigger on `auth.users` that creates profiles, if P-4 has rows nobody can explain, or if P-3 flags pending invitations (role outside user/admin, admin with NULL brand, cross-brand or unknown stores, or duplicate emails, which would hit R4). The owner deletes or re-issues flagged invitations before the apply.
   - Use P-3's pending list to see which invitees could be caught in the apply-to-deploy window.
2. **Get user approval, then AC-R2 / §9.3 apply 164.**
   - Run `execute_sql` with the exact body of the updated (S1) migration. If either S1 assertion or the profiles assertion fires, the transaction aborts with nothing applied. Report the drifted policy to the user.
   - Then: insert `('20261007000000','profiles_insert_hardening')` into `supabase_migrations.schema_migrations`; check normalized-md5 for `register_invited_profile()` and `assert_profile_insert_role_allowed()`; compare the `pg_policies` text for the profiles INSERT and invitations INSERT/UPDATE byte-for-byte with the post-S1 local reference; check grants, owner, `prosecdef`, and the trigger with `tgenabled='O'`; re-run P-1.
   - Optional: the rolled-back write probe (step 7), which needs user OK.
   - Run `notify pgrst, 'reload schema'` only if the first call returns PGRST202.
   - **Pause invitations during this window.** Don't send new invites, and ask pending invitees from P-3 not to register until the deploy is live.
3. **Straight after the apply: the user commits 164 and pushes. Vercel deploys the new `registerInvitedUser`.** Keep the gap between apply and deploy as short as possible. Old clients get 42501 on the direct insert and leave a stuck orphan auth user.
4. **AC-R3: confirm the latest runs on `main` of `test.yml`, `db-migrations-applied.yml`, and `e2e.yml` (manually, per project memory) are all green** for the 164 commit. If any is red or still running, report the run URL and wait.
5. *(Optional, user's call; it creates a real auth user)* Post-deploy smoke in prod: invite a throwaway email, register it on web, check the profile, `brand_id`, and `user_stores`, then delete it through Users & access. Also sign in once with an existing username to cover the username path that couldn't be checked locally.
6. **Stuck-invitee cleanup (architect M5 / §10 R1). Run after the deploy, and again whenever an invitee reports it.**
   - Symptom: the invitee saw "Account created but profile setup failed: ...". A retry fails with "User already registered", and nothing else calls the RPC.
   - Affected: anyone who registered between the step-2 apply and the step-3 deploy, any web user on a cached old bundle, and **every native (EAS) user until a new EAS build ships**.
   - Detect (read-only): `select u.id, u.email, u.created_at from auth.users u left join public.profiles p on p.id = u.id where p.id is null and u.created_at >= '<step-2 apply timestamp>' order by u.created_at;`
   - Fix: an admin deletes each auth-only user through Users & access (`delete-user` supports auth-only users). Their invitation survives (`used = false`). The invitee then registers again on the updated web client.
   - Native invitees should register on web until a new EAS build ships. Plan that build as part of 164's rollout.
7. **Only after steps 2-4 are green: roll out spec 163.**
   - First land 163's own pre-rollout touch-ups (tracked in `specs/163-admin-user-emails/reviews/release-proposal.md`, not here).
   - Apply `20261008000000_get_profile_emails.sql` through MCP with the same runbook (schema_migrations insert, normalized-md5, grants check).
   - The user commits and pushes 163, then all three gates are checked again on `main`.
   - The H1 follow-up does not have to come before 163. H2 and M1 don't either.

## Out of scope for this review
- Everything in (b): H1, which is the immediate next spec unless the user chooses to fold it in now; H2 plus M2; M1 and the invitation-flow Lows; M3 lint v2; the cleanup nits.
- Pre-existing items the spec already scoped out: `invitations` SELECT/DELETE brand scope, orphan auth users from failed registrations (beyond the 164 runbook above), dropping `consume_invitation` (now tracked under M1), and the `sync_role_to_app_metadata` stale-JWT window for read policies.
- Spec 163's diff and its pre-rollout touch-ups (tracked under spec 163).
- The local `username-resolve` service-token mismatch (a dev-environment issue, not a 164 regression).
- `app.json` slug: not touched, and must not be.
