# Spec 198 release proposal (invitations hardening)

Release-coordinator, 2026-11-10. Sources: the spec, `prod-prechecks.md`, and all four reviewer files in this folder
(code-reviewer, security-auditor, test-engineer, backend-architect). I spot-checked the migration
(`20261110120000_invitations_hardening.sql` :176-193 trigger, :315-362 UPDATE policy, :672-739 DO block),
`profiles_insert_hardening.test.sql` (header :1-30, K-13..K-17 :327-386), `auth_is_super_admin()`
(`20260509000000_multi_brand_schema_rls.sql:187-195`, profiles-backed) and every `from('invitations')` /
`update ... invitations` site in `src/`, `e2e/`, `scripts/`, `supabase/functions/` and the 2026-11 migrations.
This proposal is advisory. Status is unchanged.

Labels used on every item:
- **[code]**: a code or test change that goes into 198's commit.
- **[text]**: comment or spec text only, with no behaviour change.
- **[verify]**: run something and record the result. No code change.
- **[owner]**: the owner decides.

## Verdict
verdict: FIXES_NEEDED
rationale: The security auditor ran a High (H1): any in-scope admin can revive a used invitation, so its code claims a second time. That reopens 191-M1 through D3 and breaks B3's "used invitation refuses" guarantee, both of which this spec exists to deliver. Separately, neither e2e spec has run yet, and that run is the only test of real GoTrue sign-up.

## Findings summary

- **code-reviewer: 0 Critical, 3 Should-fix, 13 Nits.**
  - CR-1: `InviteUserDrawer.tsx:166` comment still names the dropped `get_pending_invitation`.
  - CR-2: `expiresAt` is returned by `inviteUser` and then dropped. `InviteLinkPanel.tsx:119` hard-codes "48 hours" instead.
  - CR-3: the `profiles_insert_hardening.test.sql` header (:8, :17) and the Section C banner (:597) still name the zero-argument `register_invited_profile()`.
  - All convention checks were clean: carve-outs, `callEdgeFunction`, `escapeHtml`, tokens, ASCII, `lock_timeout`, and the fail-closed DO block.

- **security-auditor: 0 Critical, 1 High, 0 Medium, 4 Low.**
  - **H1:** a used invitation can be revived through the client UPDATE policy, and the old code then claims again. In probe C, a demoted insider came back as a brand-A admin. In probe B, a staff invitation was upgraded to admin and claimed.
  - L1: the code travels in the URL query string.
  - L2: the trigger function keeps PUBLIC/anon/authenticated EXECUTE. It can't be called outside a trigger.
  - L3: in-scope admins can read `code_hash`, and the dead `resendInvite` does `select('*')`.
  - L4: `send-invite-email` doesn't bind `inviteCode` to an invitation. This is pre-existing.
  - Every headline probe now fails as intended: 195-H1, the direct 191-M1 replay, 164-M1, cross-brand creation, the grants, and the existence oracle. The DEFINER posture is clean.

- **test-engineer: 0 Critical, 7 Should-fix, 6 Nits.**
  - Acceptance criteria: 36 PASS, 0 FAIL. F1 and F2 (e2e) were NOT RUN, by instruction. B11's smoke half is unverified.
  - The blank-code divergence is a real disagreement between `check_invitation_code` and `register_invited_profile` (probe confirmed).
  - IH::C3 runs an inline copy of the clamp, not the migration's clamp.
  - B8-srv calls `create_invitation` twice with identical arguments, so the replacement row's contents are never checked.
  - The smokes were not run. Arm 5 is vacuous. E-1 has a double cause.
  - The anon checks are catalog-only.
  - jest 307/307, `typecheck:test` clean, all six named pgTAP files green.
  - The one red `test:db` file is `staff_role_eod_rls`, from another session's spec 193 work, not 198.

- **backend-architect (post-impl): 0 Critical, 5 Should-fix, 8 Nits.**
  - The build matches the contract. SCOPE is byte-for-byte 191's P_INV. All recorded deviations were accepted.
  - S1: put E-1's `code_hash` in now.
  - S2: `invite-claim.spec.ts` isn't safe on a retry.
  - S3: the first e2e run must be green before prod.
  - S4: run the smokes.
  - S5: no from-scratch apply proof yet, plus index hygiene. Other specs' files are staged: `specs/188-*`, `specs/196-*`, `20261109200000_po_number_server_assigned.sql`.
  - N8 (pre-existing): spec 029's "only master/super_admin may invite role=admin" rule isn't enforced in RLS.

Nobody flagged a Critical. H1 is the auditor's "must fix before deploy". Because it defeats AC B3 and the purpose of D3, I treat it as blocking ship. The fixes are all inside this spec, and none needs a new spec.

## Recommended next steps (ordered)

Order: H1 first. Then the other migration-body edits, batched so the md5 references are recomputed once. Then the test
and e2e hardening that the CI push proves. Then text, local verification, owner decisions, and the go-ahead gated steps.

### 1. H1: close invitation revival. [code] + [text]. High, blocks ship.

**My finding:** there is no client UPDATE path in the app.
- Every client `invitations` access is a read: `src/lib/db.ts:239`, `src/lib/db.ts:5597`, and `src/lib/auth.ts:549` (`resendInvite`, no callers).
- `delete-user` deletes with service_role (`index.ts:513`). The e2e tests read with service_role.
- `inviteUser` goes through `create_invitation`, which does a delete and then an insert, never an UPDATE.
- The only `update ... invitations` statements are the migration's clamp (:214, runs as postgres) and the DEFINER claim (:483).
- Re-invite (B8) already rotates the code. So restricting UPDATE costs the app nothing.

**Recommended fix:** make the UPDATE policy super_admin-only and add `used = false`, in the 198 migration.
- In both USING and WITH CHECK of `"Admins can update invitations"` (migration :315-356), add:
  - `and public.auth_is_super_admin()`, which reads `profiles.role`, not the JWT
  - `and invitations.used = false`
- Keep the existing `auth_profile_is_privileged()`, SCOPE, D7 and EXPIRY text as it is.
- Effect:
  - No admin or master can UPDATE at all. That removes the insider class in both probes.
  - Even a super_admin can't target a used row, or set `used` from a client.
  - The only writer of `used = true` is still the DEFINER claim, which runs as postgres and isn't subject to RLS.
- Reword the policy comment (:358) and keep the literal `spec 191` in it. K-17 needs that substring.
- Optional, cheap: in the provenance trigger's UPDATE branch (:186-189), also freeze `email` and `role` for authenticated/anon. With UPDATE restricted to super_admins this is extra protection only. Skip it if you want the smallest diff.

**Why this shape and not dropping the policy:** the policy counts and text pins.

| Pin | What it counts | Super_admin-only + `used=false` | Drop the UPDATE policy |
|---|---|---|---|
| K-13 (198's rewrite, :327-340) | SELECT + DELETE `{authenticated}` with the 198 text, = 2 | unaffected | unaffected |
| K-14 (191's, :344-350) | permissive INSERT/ALL = 1 | unaffected | unaffected |
| K-15 (191's, :352-358) | permissive UPDATE/ALL = 1 | unaffected (still 1) | **breaks (0)** |
| K-16 (191's, :361-375) | `count = 3`: INSERT `with_check`, UPDATE `qual`, UPDATE `with_check`, all containing `auth_profile_is_privileged()` | unaffected | **breaks (1)** |
| K-17 (191's, :377-386) | `count = 3` policies with a `spec 191` comment | unaffected if the comment keeps `spec 191` | **breaks (2)** |
| 198 DO block 8.1 / 8.2 (:678-702) | 1/1/1/1 per command; the 4 named policies are `{authenticated}` | unaffected | **breaks** |
| IH::K-a, AC A8 ("INSERT/UPDATE counts that 164 and 191 pin are unchanged") | 1 UPDATE policy | unaffected | needs a code change plus an AC amendment |
| `rollback.sql` 1/1/1/1 DO block | | unaffected | asymmetric |

- Both shapes are secure.
- Dropping leaves the smaller attack surface, but it means rewriting three 191 assertions (K-15..K-17), the DO block, IH::K-a and the A8/C2/D2 AC text.
- The super_admin-only shape keeps AD-11's promise ("K-14..K-18 stay unchanged") literally true.
- If the developer still prefers to drop the policy, that's acceptable. Since 191 is committed, editing K-15..K-17 is an ordinary diff in 198's commit. Annotate each with `-- spec 198 H1: UPDATE policy dropped`.

**How this interacts with spec 191 (committed on `test/ship-187-191-195`):**
- 191's migration `20261109191000` created the UPDATE policy with `auth_profile_is_privileged()` plus P_INV. 198's migration already drops and recreates all four policies on top of it. So the H1 fix lives only in 198's (unapplied, uncommitted) migration. **191's committed migration and commit don't change**, and 191 stays SHIP_READY.
- During the prod window between 191's apply and 198's, 191's UPDATE policy is live. That is harmless:
  - there are no code hashes yet
  - the pre-198 claim is still email-based, which is the larger hole 198 closes
  - prod has 0 pending invitations
- Keep the two applies back to back with invites on hold, as section 10 already says.
- `rollback.sql` restores 191's UPDATE policy verbatim, so it reopens H1 along with 195-H1, 164-M1 and 191-M1. **[text]:** add H1 to the rollback header's "reopens" list.

**pgTAP arms to add** in `invitations_hardening.test.sql`, each with a mutation that turns it red:
- (a) In-scope admin `1111`: `update ... set used = false, email = ..., expires_at = now() + 6 days` on a consumed row → 0 rows, and `used` is still true. Mutation: remove `auth_is_super_admin()` from USING.
- (b) The SA does the same → 0 rows. Mutation: remove `used = false` from USING.
- (c) The consumed code still refuses at the claim, and the pre-check returns 0.
- (d) The full probe-C sequence ends in `no pending invitation`: master invites, X claims, X tries to revive, SA demotes X, a burner claims.
- (e) **Re-point C2 and D2** to the SA as the caller. They currently run as `1111`, who would now get 0 rows. Add a `1111` UPDATE → 0 rows arm.
- Extend the DO block's 8.3 text checks to require `used = false` in the UPDATE `qual` and `with_check`.

**[text] spec edits:**
- C2: "needs a currently privileged in-scope caller" becomes "needs a super_admin caller".
- AD-12: note that it now protects only the super_admin path.
- Add an AC line: "No client role can revive a used invitation (pgTAP H1 arms)."
- `InviteLinkPanel`'s "It works once" copy becomes true and needs no change.

### 2. Test-engineer Should-fix 1: blank-code divergence. [code]. Should-fix, but it's a real CP/claim disagreement.
- The case: an invitation whose `code_hash = sha256('')`. Any privileged in-scope caller can plant one, because INSERT checks only the 64-hex format. For it, `check_invitation_code(email, '')` returns 1 row while the claim refuses at R3b.
- Fix: add the R3b guard to CP, e.g. `nullif(btrim(p_code), '') is not null`.
- Add a `sha256('')` fixture to B6-agree, plus a blank-code claim arm, both asserting 0 rows / P0001.
- Batch this with item 1: both change DEFINER or policy text. After both, **recompute and replace** the function and policy md5 references in `## Files changed`. The prod-apply step 3/4 checks compare against them.
- Optional ride-along in the same batch: Security **L2** [code]. Add `revoke all on function public.assert_invitation_provenance() from public, anon, authenticated;`.
  - My understanding is that Postgres checks trigger-function EXECUTE only at CREATE TRIGGER time, not when the trigger fires.
  - IH::B1/C1/D1 run inserts as `authenticated` and will go red at once if that is wrong. Drop the line if they do.
  - Also wrap the 150-character clamp line (:214), the code-reviewer nit, **before** item 3, so the probe pins the final text.

### 3. Test-engineer Should-fix 2: C3 tests an inline clamp copy. [code]. Should-fix.
- Add a jest source probe (the `sendInviteEmail.source.test.ts` pattern) that reads the migration and asserts it contains, after whitespace normalisation, the exact clamp UPDATE that IH::C3 runs.
- Normalise whitespace so the item 2 line-wrap doesn't make the probe brittle.

### 4. Test hardening in 198's own suites. [code]. Should-fix, no dependencies between them.
- **Test-engineer 3, B8-srv:** make the second `create_invitation` call use a different `role`, stores, username and (where in scope) brand. Assert the surviving row carries the second call's values and a fresh `expires_at`.
- **Test-engineer 6 / Architect S1, E-1 `code_hash`:** in `profiles_insert_hardening.test.sql:1036`, add `, code_hash` / `encode(sha256(convert_to('e1','UTF8')),'hex')`.
  - The deferral reason has gone. 191 is now committed, so this is an ordinary diff in 198's commit.
  - E-1 then isolates the privilege leaf again.
- **Test-engineer 5 / Architect N2, smoke Arm 5:** in `scripts/smoke-edge-roles.sh:337-372`, send a valid 32-hex `inviteCode` so the arm reaches the post-validation path again.
  - Its existing `delete from auth.users` cleanup covers the fallback's side effect.
  - Fix the stale "line 49" comment at :214.
  - Arm 5 sits outside 191's committed hunks (-43/-80/-113/-488), so this is a new 198 hunk.
- **Test-engineer 7, anon behaviour:** add arms to `scripts/smoke-rpc.sh` (the file exists) mirroring the auditor's and test-engineer's curls:
  - anon `GET` and `DELETE` on `/invitations` → `[]`
  - `check_invitation_code` with a wrong code → `[]`
  - `get_pending_invitation` → 404 PGRST202
  - `register_invited_profile` and `create_invitation` → 401/42501
  - This turns A7/B6's catalog-only pgTAP into behavioural coverage. pgTAP can't `set role anon` (spec 067).

### 5. Architect S2: F2 retry safety. [code]. Should-fix, needed before the push because the push is the proof.
- `claimEmail` and `wrongCodeEmail` are module constants keyed on `RUN_ID` (`e2e/invite-claim.spec.ts:59-60`), which is the same across `retries: 2`. A late flake in the happy path becomes a hard red on retry.
- Fix: build the emails inside the test with a `test.info().retry` suffix, or key the durable check at :186 on `profile_id = userId` instead of `toHaveLength(1)`.
- Cheap ride-alongs [code], optional:
  - N5: add `Access-Control-Allow-Origin` to the stub's `route.fulfill`
  - N6: match `request().method() === 'POST'` in `invite.spec.ts:101`

### 6. Code-reviewer Should-fix 1 to 3. [text] / [code]. Should-fix.
- **CR-1 [text]:** `InviteUserDrawer.tsx:165-166`. Point the comment at `create_invitation` step 5, as `auth.ts:420` does. Same as architect N1.
- **CR-2 [code]:** carry `expiresAt` into `IssuedInvite` in both drawers and render it in `InviteLinkPanel` (e.g. "expires <local date/time>") instead of hard-coding "48 hours" at :119. Add a jest pin.
  - Acceptable alternative: delete `expiresAt` from `InviteUserResult` and its `inviteUser.test.ts` pins.
  - Either way, the dead-data / second-constant drift goes away.
  - The email's "expires in 48 hours" copy stays. D-3 keeps it, and the edge function is out of scope for this.
- **CR-3 [text]:** change `register_invited_profile()` to `register_invited_profile(text)` at `profiles_insert_hardening.test.sql` lines 8, 17 and 597.
  - Lines 8 and 17 sit in spec 191's hunks (`@@ -8,8`, `@@ -17,6`). 191 is now committed, so 198's commit updates them as ordinary diffs and no hunk splitting is needed.
  - Line 597 is already in 198's range.
  - Line 13's "Catalog K-1..K-18" is still accurate under item 1's recommended shape.

### 7. Spec bookkeeping. [text].
- Record the item 1 to 6 changes in `## Files changed`, with the new md5 references, the new plan counts, and the H1 arms.
- Update the backend "Where the build differs" list. Item 6 (E-1 deferral) is now resolved; item 7 (Arm 5) is now resolved.

### 8. Local re-verification. [verify]. Do it before asking for the commit.
- `bash scripts/test-db.sh` on `invitations_hardening`, `profiles_insert_hardening`, `invitations_super_admin_rls`, `profiles_username`, `staff_brand_id_backfill` and `consume_invitation_sets_profile_id`.
- Then the full `npm run test:db`. The only expected local red is `staff_role_eod_rls` (spec 193, another session); anything else is 198's.
- Full `npx jest`, `npm run typecheck:test`, and `npx tsc -p e2e/tsconfig.json`.
- Re-run the migration dry run and the `rollback.sql` dry run (`commit;` → `rollback;`), since the migration body changed.
- **Test-engineer 4 / Architect S4: run the smokes.**
  - `scripts/smoke-edge-roles.sh`: Arm 3b is the only B11 smoke evidence, and the same request is the prod step-7 check.
  - `scripts/smoke-delete-user.sh`: the only end-to-end proof that `delete-user` can still call `assert_not_last_of_role` as service_role after D-5.
  - Both mutate the shared local stack, so coordinate with the other session (spec 193) before running.

### 9. Owner decisions. [owner]. Before the prod apply, none before the commit.
- **AD-4** (zero-store staff invite from an admin/master gets the inviter's brand): confirm or flip **before the prod apply**.
  - Before the apply, flipping is an edit to the unapplied migration, covering R7 in `register_invited_profile(text)`, CP in `check_invitation_code` and the `create_invitation` stamp, plus the B2-zero(b) pin and new md5s.
  - After the apply, it becomes a new migration.
  - Recommendation: keep the default. The auditor judged it a security reduction versus NULL brand.
- **L1** (code in the query string vs a `#fragment`): recommend **defer to a follow-up**.
  - Exposure is bounded: the code is useless without the matching email, single-use (with item 1), 48h by default, and the logs are owner-controlled Vercel logs.
  - A fragment ripples into `inviteLink.ts`, `send-invite-email`'s link, `LoginScreen`'s parsing, the source probe, both e2e regexes, and a `detectSessionInUrl`/`recoveryUrl` re-check.
  - Trade-off: prod has 0 pending invitations, so switching **now** avoids supporting two link formats later. Switching after ship means `LoginScreen` must accept both.
  - Optional cheap partial [code]: strip `invite` from the query on boot even when a session exists (auditor's second suggestion).
- **L3** (`code_hash` readable by in-scope admins): recommend **defer**, together with deleting `resendInvite`.
  - Caveat for whoever picks it up: `revoke select (code_hash) ... from authenticated` is a **no-op** while `authenticated` holds table-level SELECT (spec 097's explicit grants). Column privileges only narrow access if you revoke the table SELECT and grant the other columns one by one. That's more invasive than the auditor's one-liner suggests.
  - The value isn't invertible or replayable, so the risk is low.
- **L4:** no change. It's the pre-existing "admins can mail anyone" surface, and arbitrary codes are inert at claim.
- **N8** (spec 029's admin-invite rule isn't enforced server-side): pre-existing, and needs a follow-up spec (see Out of scope).
- **`RESEND_API_KEY` presence (dashboard):** record it at apply time (architect S4). It decides whether real invitees go through Resend or the `inviteUserByEmail` fallback. The fallback pre-creates the auth user and sends a code-less link.

### 10. Commit, push, CI proof. [owner] go-ahead required.
- **Commit hygiene (architect S5).** Make 198 the **fourth commit** on `test/ship-187-191-195`, staged hunk by hunk.
  - The index currently holds other specs' staged additions: `specs/188-*`, `specs/196-*` and `supabase/migrations/20261109200000_po_number_server_assigned.sql`. Unstage them or leave them out. A stray `20261109200000` on the branch would also widen what prod must hold before main.
  - Keep `src/lib/db.ts` out of 198's commit entirely.
  - Keep other sessions' hunks out of the shared files: `src/lib/auth.ts` (also touched by `placeholderEmail` work), the two drawers, `RegisterScreen.tsx`, `LoginScreen.tsx`, `e2e/invite.spec.ts`, `scripts/smoke-edge-roles.sh`, and `supabase/functions/delete-user/index.ts` (198 must not touch it).
  - Keep `supabase/tests/staff_role_eod_rls.test.sql` (spec 193) out, so the branch's CI doesn't inherit the local red.
- **Push and read CI (architect S3/S5).** The push re-runs `test.yml` and `e2e.yml` on the branch.
  - Both must be green before the prod apply. Treat `e2e.yml` as required for this spec even though it's not yet in CLAUDE.md's gate list (memory: e2e gate promotion pending).
  - `test.yml`'s pgTAP job is the first **from-scratch** apply of 198. The developer applied it with psql on an incrementally migrated DB.
  - If F1 goes red only at the `functions/v1/send-invite-email` wait (`invite.spec.ts:101-103`), check CI edge-runtime health first. It's the first e2e assertion in the repo that depends on a served function.
  - If `register-success` never appears in F2, suspect V-5 (session watch after `signUp`) before blaming 198.
- `db-migrations-applied` on the branch will be red until prod holds `20261108130000` (187), `20261109191000`, `20261109195000` and `20261110120000`. That is expected on a pre-apply branch and doesn't count against 198.
- I couldn't check `main`'s latest `test.yml` and `db-migrations-applied.yml` runs (I have no shell). Check both with `gh run list --branch main --workflow <file> --limit 1` before any push to `main`, per CLAUDE.md.

### 11. Prod apply and deploy. [owner] go-ahead required. After step 10 is green.
- **Order:**
  1. Spec 191's apply first. The prerequisite DO block aborts 198 otherwise. 195 and 197 per their own plans, one at a time.
  2. 198's migration via MCP `execute_sql`, with the exact `schema_migrations` insert before `commit;`.
  3. `notify pgrst`.
  4. Steps 3 to 6 verification against the **recomputed** md5s from item 2.
  5. `send-invite-email` deploy (pinned CLI 2.108.0, or MCP).
  6. Push to main (Vercel).
  7. All three gates on main green.
- **Before the apply:**
  - Re-run P-1 to P-3, P-8, P-9 and P-12 (it must show `20261109191000`), plus Q-1, Q-2, Q-4, Q-6 and Q-7.
  - Do the owner dashboard checks.
  - Save the rollback inputs.
  - Hold invites.
- If P-1 shows pending rows at apply, those people need re-inviting afterwards (D-4).

## Out of scope for this review
- **Spec 029 rule parity (architect N8):** neither RLS nor `create_invitation` stops a brand admin creating `role='admin'` invitations; only the drawer's role picker does. 198 doesn't widen this. It needs INSERT/UPDATE policy parity in its own spec.
- **Disabling open sign-up plus a server-side claim function:** closes the residual email-squatting DoS (spec §12, accepted residual).
- **Turning on "Confirm email", verifying a Resend domain, enabling `auth-email-hook`:** these are blocked on mail.
- **`send-invite-email`'s `inviteUserByEmail` fallback sends a code-less link** (code-reviewer out-of-scope nit, spec Risks). Revisit when mail is verified.
- **Binding `send-invite-email` to an `invitation_id`** (Security L4 future hardening) and its `requireAdminCaller` stale-JWT trust.
- **Deleting `resendInvite`** (`src/lib/auth.ts:546-561`; no callers; `select('*')` now returns `code_hash`/`invited_by` and its `.single()` semantics changed). Pair it with L3 if L3 is taken up.
- **Friendly copy for "Account created but profile setup failed: ..."** (code-reviewer nit at `auth.ts:533`), and the recovery path for that orphaned-signUp state.
- **X2** (the `user_stores` admin policy swap, 195-M1), **X3 void-on-demote** and **X4** (`auth_is_admin()` / `auth_is_privileged()` convergence): already recorded as out of scope in the spec.
- **Remaining nits** (all optional; none blocks ship): the A6 inviter-DELETE arm, a B1 CSPRNG/uniqueness arm, collapsing B3-4/B3-9, a `buildInviteEmailHtml()` extraction for a behavioural test, and `MASTER_USER_ID` into `e2e/fixtures/constants.ts`. Also a `codeOf(link)` helper, the `Promise.all` for `waitForRequest`, `InviteLinkPanel` toast nouns (N3), clearing `issued` on close (N4), the drawer ternary reindent, the migration header step numbering, and the retired-arm header bullets in `staff_brand_id_backfill`/`profiles_username`.
- **Local `staff_role_eod_rls` red:** spec 193's in-flight work in another session. It's not 198's, and must not ride in 198's commit.

## Handoff
next_agent: NONE
prompt: FIXES_NEEDED, 6 fix groups. Top: H1, make the invitations UPDATE policy super_admin-only and add used = false. This keeps 191's K-15..K-17 pins and the 1/1/1/1 DO block intact. Then the blank-code CP guard with md5 recompute, the C3 clamp probe, B8-srv/E-1/Arm 5/smoke-rpc anon arms, F2 retry safety, and CR-1..3. Owner decides AD-4 (keep recommended), L1 (defer recommended) and L3 (defer; note the column-revoke no-op caveat). The owner's go-ahead is needed for the 4th commit on test/ship-187-191-195, the push (CI test + e2e must be green, including the first fresh-reset apply), and the prod apply after 191.
payload_paths:
  - specs/198-invitations-hardening/reviews/release-proposal.md
