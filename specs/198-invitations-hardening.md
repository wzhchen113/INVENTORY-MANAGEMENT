# Spec 198: Invitations hardening (brand-scoped read/delete, claim needs an invite code, bounded expiry)

Status: READY_FOR_REVIEW

Origin: follow-up **X1** in `specs/191-demote-profile-brand-scope/reviews/release-proposal.md`
(L229-248). It merges:
- 195-H1 (a)(b)(c): `specs/195-user-stores-own-row-writes/reviews/security-auditor.md` L61-82
- 164-M1, invitation squatting plus the anon `get_pending_invitation` oracle: `specs/164-profiles-insert-hardening/reviews/security-auditor.md` L49-55
- 191-M1 (a)(b), the expiry bound plus provenance and the claim-time inviter re-check: `specs/191-demote-profile-brand-scope/reviews/security-auditor.md` L44-60
- 191-L3, the anon EXECUTE on `assert_not_last_of_role`. On prod this only aligns the repo (see Decisions D-5).

The PM wrote this on 2026-11-09. The owner answered the decisions the same day. Prod pre-checks are in
`specs/198-invitations-hardening/reviews/prod-prechecks.md` (read-only, 2026-11-09). Line numbers are pointers, not
contracts.

## Problem

Security probes on the local stack (2026-11-09; 195 audit H1, 191 audit P17/P18) confirmed four things.

1. **Any brand admin can list and delete every brand's pending invitations.**
   `"Admins can read invitations"` and `"Admins can delete invitations"` are bare
   `using (public.auth_is_privileged())` (`supabase/migrations/20260514150000_invitations_super_admin_rls.sql:33-35, 46-48`).
   That has no brand or store scope, and it trusts the JWT claim, so a stale admin token passes too.
   **Prod is the same:** both policies are `auth_is_privileged()` only, with roles `public` (pre-checks P-8).
   Spec 164 tightened INSERT/UPDATE to the P_INV predicate (`20261007000000_profiles_insert_hardening.sql:276-322`).
   Spec 191 swaps P_INV's privilege leaf to `auth_profile_is_privileged()` (`20261109191000_demote_profile_brand_scope.sql:457-508`).
   Both left SELECT/DELETE alone on purpose. 191's pgTAP K-13 pins them (`supabase/tests/profiles_insert_hardening.test.sql:318-325`).
2. **Whoever signs up with an invited email can claim the invitation.** Sign-up is open and email confirmation is off
   (`supabase/config.toml:182, 227, 232`). Prod looks the same: 0 unconfirmed accounts, and a 0.08 s maximum
   confirmation lag over recent sign-ups (P-11). The dashboard is authoritative. With autoconfirm on, GoTrue sets
   `email_confirmed_at` at sign-up, so nothing about the account proves the email. `register_invited_profile()` binds
   the claim to `auth.users.email` and nothing else (`20261007000000:158-189`).
3. **Put together, this is cross-tenant and needs no stale token.** In the auditor's run, a brand-A admin listed
   brand B's invitations and claimed both:
   - the staff invitation produced a brand-B profile with a brand-B `user_stores` link and `auth_can_see_store(B) = true`
   - the admin invitation produced a lasting brand-B admin, with `raw_app_meta_data.role = 'admin'` synced

   After 191 and 195, this is the one remaining route by which an outside account gets another brand's store or an
   admin role there. The `get_pending_invitation(text)` lookup (`20260607120000_profiles_username.sql:111-160`)
   returns `id, role, brand_id, store_ids, username` for any email. It is executable by anon, and on prod by PUBLIC
   as well (P-9). So an attacker who guesses an email doesn't even need an admin to list it.
4. **191-M1: a demoted admin can plant a never-expiring admin invitation before the demotion.**
   - Nothing bounds `expires_at`. The column default is `now() + 48h` (`20260502071736_remote_schema.sql:91`), but a client can send `NULL` or `2099-01-01`.
   - `register_invited_profile` treats NULL as "never expires".
   - No column records who created an invitation.
   - Nothing re-checks the inviter at claim time.

   Auditor P18: an admin invitation planted by `1111`, then `1111` demoted through the 191 RPC, then a fresh account
   claimed it as a brand-A admin.

**Prod exposure today: none.** Prod has 4 invitations, all used, and 0 pending (P-1 to P-6). The hole needs a pending
invitation to steal, so it becomes live the next time an admin sends an invite. **This fix should land before invites
resume.**

### Mail reality (why D-1 chose an invite code)

- Prod Resend has **no verified domain**. Every function sends from `onboarding@resend.dev`, which delivers only to the
  Resend account owner (project memory, 2026-10-23). So invite emails almost certainly don't reach invitees today.
  They learn out-of-band to go to the site and register.
- `auth-email-hook` (spec 166) is deployed but **disabled**. Enabling it with an unverified From address would take
  down all prod auth mail.
- Without custom SMTP, Supabase's built-in mailer delivers only to the project's team-member addresses and is heavily
  rate-limited.
- **Result:** every way of proving an email (Confirm email, magic link, OTP, GoTrue `inviteUserByEmail`) needs mail
  delivery to arbitrary addresses, and prod can't do that yet.
- Locally (and in CI e2e) there is no `RESEND_API_KEY`, so `send-invite-email` falls back to
  `auth.admin.inviteUserByEmail` (`supabase/functions/send-invite-email/index.ts:94-99`). That **creates an
  `auth.users` row for the invitee**. See Risks.

## Decisions (owner, 2026-11-09)

**D-1. A claim needs a one-time invite code. (OQ-1, owner chose the recommendation.)**
- Each invitation gets a high-entropy code. Only its hash is stored.
- The inviting admin sees the code once, as a link in the invite drawer. The same link goes into the invite email.
- `register_invited_profile` requires the code and selects the invitation by code.
- This proves the claimant holds the invite, not that they own the inbox. It closes the probed threat, which is a third
  party who learns or guesses the email.
- **Alternatives not taken:**
  - Confirm email: blocked until mail works. Don't flip the prod toggle before then.
  - OTP or magic link: same blocker.
  - A server-side claim function with open sign-up turned off: a possible follow-up.
  - Admin-approved claims: needs new state and UI.

**D-2. Record `invited_by` and re-check the inviter at claim. Void-on-demote stays in X3. (OQ-2, owner chose the recommendation.)**
- The claim refuses when the inviter is no longer privileged in the invitation's brand. That closes 191-M1, which the
  code alone doesn't, because the demoted admin holds the code.
- **Not taken:**
  - Deferring all of X3.
  - Voiding the invitations in `demote_profile_to_user` and `delete-user`, which would mean a new migration over 191's frozen RPC plus an edge-function change.

**D-3. Expiry is at most 7 days. (OQ-3, owner chose the recommendation.)**
- Every client INSERT and UPDATE must leave `expires_at` non-NULL and at most `now() + 7 days`.
- The default stays `now() + 48h`, which the email copy promises (`send-invite-email/index.ts:71`).
- NULL counts as expired at claim.
- **Not taken:** a hard 48-hour cap; 14 days.

**D-4. Legacy pending rows get clamped. (OQ-4, not asked: moot on 2026-11-09.)**
- Prod had 0 pending invitations and 0 NULL expiries (P-1 to P-3), so there was nothing to clamp or re-invite.
- The migration still clamps any pending row whose `expires_at` is NULL or later than `now() + 7 days` to `now() + 48h`. Rows pending at apply have no code and so can't be claimed. The nightly prune removes them.
- **Re-run P-1 to P-3 at apply.** If rows are pending then, the owner re-invites those people.

**D-5. Revoke anon and PUBLIC on `assert_not_last_of_role(uuid,text)` (191-L3). (OQ-5, not asked: drift only.)**
- Prod's ACL is already `postgres`, `authenticated`, `service_role`, with no anon and no PUBLIC entry (P-9). Only the
  local stack and repo grant anon.
- The revoke is a no-op on prod and aligns the repo and local state.
- `authenticated` (191's INVOKER wrapper) and `service_role` (`delete-user/index.ts:492`) keep EXECUTE.

**D-6. Revoke `consume_invitation(uuid,text)` from `authenticated`; keep the function. (OQ-6, owner chose the recommendation.)**
- It has had no caller since 164, and any account can use it to burn an invitation.
- On prod its ACL is `postgres`, `authenticated`, `service_role` (P-9).

**D-7. Brand-less, store-less invitations are visible only to the super_admin and the inviter. (OQ-7, not asked: follows D-2.)**
- These are rows with NULL `brand_id` and no stores. Legacy rows with NULL `invited_by` are visible to the super_admin only.
- Prod has none today (P-6).
- **Not taken:** making them visible to every privileged caller, the plain P_INV shape.

**Recorded, not decided here:** X2, the `user_stores` admin policy swap (195-M1), stays out (see Out of scope).

## Prod facts (2026-11-09)

The full results are in `specs/198-invitations-hardening/reviews/prod-prechecks.md`. Points the design depends on:

- **Pending rows (P-1 to P-6):** 0 pending invitations. 4 rows in total, all used. 0 NULL expiries. 0 duplicates. 0 brand-less, store-less rows. 0 accounts without a profile (P-10).
- **Columns (P-7):**
  - `email` and `profile_id` are both not null; `profile_id` has no FK (the client writes a zero-uuid placeholder, `src/lib/auth.ts:441`).
  - `expires_at` is nullable, default `now() + 48h`.
  - `brand_id` is an FK to `brands`, on delete cascade.
  - `username` is present.
- **Constraints and indexes (P-7):** constraints are the pkey, `invitations_brand_id_fkey` and `invitations_username_format`. Indexes are the pkey and a partial `invitations_brand_id_idx`.
  - **There is no unique constraint or index on email.** The `invitations_email_key` string quoted in `InviteUserDrawer.test.tsx:358` is test fixture text, not a real constraint. Nothing in the schema stops two pending invitations for one email, which is why B5 matters.
- **Policies (P-8):** four permissive policies.
  - INSERT and UPDATE are the spec 164 shape (`auth_is_privileged()`, because 191 isn't applied).
  - SELECT and DELETE are `auth_is_privileged()` with roles `public`.
- **Function ACLs (P-9):**
  - `get_pending_invitation(text)`: PUBLIC, `anon`, `authenticated`, `service_role`. **B6 must revoke from PUBLIC too, not just anon.**
  - `register_invited_profile()`: `postgres`, `authenticated`, `service_role`.
  - `consume_invitation` and `assert_not_last_of_role`: see D-5 and D-6.
- **Autoconfirm (P-11):** confirmation looks off.
- **Migrations (P-12):** prod has `20261109120000` and `20261109170000`. **Specs 187, 191 and 195 are not on prod.**

**Re-run at apply** (same queries, read-only, MCP `execute_sql`, project `ebwnovzzkwhsdxkpyjka`):
- **P-1 Pending invitations by brand:** `select coalesce(brand_id::text,'NULL') as brand, role, count(*) as n, count(*) filter (where coalesce(cardinality(store_ids),0) > 0) as with_stores from public.invitations where used = false group by 1, 2 order by 1, 2;`
- **P-2 Expiry spread of pending rows:** `select case when expires_at is null then 'null' when expires_at < now() then 'expired' when expires_at <= now() + interval '48 hours' then '<=48h' when expires_at <= now() + interval '7 days' then '48h-7d' else '>7d' end as bucket, count(*) from public.invitations where used = false group by 1;`
- **P-3 NULL `expires_at`:** `select count(*) filter (where expires_at is null) as null_all, count(*) filter (where expires_at is null and used = false) as null_pending from public.invitations;`
- **P-8 Live policies:** `select policyname, cmd, permissive, roles, qual, with_check from pg_policies where schemaname = 'public' and tablename = 'invitations';`
- **P-9 Function ACLs:** `select p.proname, pg_get_function_identity_arguments(p.oid), p.proacl from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname in ('get_pending_invitation','consume_invitation','register_invited_profile','assert_not_last_of_role');`
- **P-12 Migrations on prod:** `select version from supabase_migrations.schema_migrations where version >= '20261109000000' order by 1;`. This must include `20261109191000`.

**Owner dashboard checks** (SQL can't read these; do them once before the apply):
- **Sign-up and Confirm email:** Authentication → Sign In / Providers. Read "Allow new users to sign up" and, under the Email provider, "Confirm email". Read only; this spec changes neither.
- **SMTP:** Authentication → Emails → SMTP Settings.
- **Send Email hook:** Authentication → Hooks. It should still be disabled.
- **`RESEND_API_KEY`:** Edge Functions → Secrets. Present or not decides whether prod `send-invite-email` uses Resend or the `inviteUserByEmail` fallback.
- **API alternative:** `curl -s -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" https://api.supabase.com/v1/projects/ebwnovzzkwhsdxkpyjka/config/auth | jq '{disable_signup, mailer_autoconfirm, jwt_exp, smtp_host, hook_send_email_enabled}'`.

## User story

- As a **brand admin or master**, I want to see and cancel only my own brand's invitations, and I want an invitation I
  send to be claimable only by the person I hand the invite link to, **so that** another brand's admin, or a stranger
  who learns the email, can't take over my brand's onboarding or become an admin of my brand.
- As the **super_admin**, I want an admin who has been demoted to lose the power of any invitation they created,
  **so that** a demotion actually ends their ability to mint admins.

## Acceptance criteria

All SQL criteria are pgTAP (simulated callers: `set local role authenticated|anon` plus `request.jwt.claims`), unless
marked jest, e2e or smoke.

### A. Brand-scoped SELECT and DELETE (195-H1a)
- [ ] **A1.** `"Admins can read invitations"` (SELECT) and `"Admins can delete invitations"` (DELETE) are `to authenticated`. Today they are roles `public` on prod.
  - Their USING is `auth_profile_is_privileged()` AND the P_INV brand/store predicate, copied from 191's INSERT policy
    (`20261109191000:463-472`), AND the D-7 rule for brand-less, store-less rows.
  - Neither policy's `qual` contains `auth_is_privileged()`.
- [ ] **A2.** Fixtures: brand-A admin `1111` (profiles `role='admin'`, `brand_id=A`) and three invitations outside `1111`'s scope: (i) `brand_id = B`; (ii) `brand_id = NULL` with a brand-B store; (iii) `brand_id = A` with a brand-B store.
  - `select` as `1111` returns 0 of them.
  - `delete` as `1111` affects 0 rows, and all three still exist afterwards.
- [ ] **A3.** A caller with `profiles.role = 'user'` and a JWT `app_metadata.role = 'admin'` (stale claim): SELECT returns 0 rows of any brand, and DELETE affects 0 rows.
- [ ] **A4.** Super_admin SELECT returns every fixture row (brands A and B, brand-less included). DELETE of a brand-B row affects 1 row.
- [ ] **A5.** `1111` still SELECTs and DELETEs brand-A invitations: `brand_id = A`, and `brand_id = NULL` with only brand-A stores.
- [ ] **A6 (D-7).** A brand-less, store-less invitation created by admin `1111`:
  - visible to `1111` and to the super_admin
  - not visible to another brand-A admin, and not deletable by them
  - a legacy brand-less, store-less row with NULL `invited_by` is visible only to the super_admin
- [ ] **A7.** anon SELECT and DELETE on `invitations` return 0 rows or are refused. No anon policy exists.
- [ ] **A8.** The migration's fail-closed DO block, also as pgTAP:
  - exactly 1 permissive SELECT/ALL policy and 1 permissive DELETE/ALL policy on `public.invitations`
  - the INSERT/UPDATE counts that 164 and 191 pin are unchanged
  - the policy text checks `auth_profile_is_privileged()` is present and `auth_is_privileged()` absent in all four
- [ ] **A9.** `profiles_insert_hardening.test.sql` K-13 now asserts the new SELECT/DELETE text (or delegates to A8 with a comment naming this spec). `npm run test:db` passes with no other K-arm changes.

### B. A claim needs the invite code (D-1)
- [ ] **B1.** Every invitation created through the app gets a claim code: at least 128 bits from a CSPRNG, URL-safe.
  - The plaintext goes back to the inviting caller only.
  - The database stores only a one-way hash.
  - pgTAP: after an app-path insert, no text column of `public.invitations` equals the plaintext code.
- [ ] **B2.** Registering with the right code and an auth email equal to the invitation email (case-insensitive) creates the profile exactly as today:
  - role, brand (the spec 069 store-resolved brand for staff), username and initials
  - the `user_stores` links
  - `used = true` and `profile_id = auth.uid()` on the invitation
  - `raw_app_meta_data.role` synced
- [ ] **B3.** Each of the following refuses with P0001 `'no pending invitation'` (one string for all, so it is no oracle) and leaves no profile, no `user_stores` row and the invitation unchanged:
  - missing code
  - wrong code
  - another invitation's code
  - the right code with a different auth email
  - a used invitation
  - an expired invitation
  - an invitation with NULL `expires_at`
  - a legacy invitation with no code
- [ ] **B4.** No callable path claims an invitation without the code. The zero-argument `register_invited_profile()` is dropped or refuses unconditionally. pgTAP lists every `public` function that writes `profiles` and is SECURITY DEFINER, and pins the expected set.
- [ ] **B5.** The claim selects its invitation by code, not by email. Prod has no unique constraint on email (P-7), so two pending invitations for one email can exist, including in different brands. Each code claims only its own invitation. The `'multiple pending invitations'` refusal no longer fires for this case.
- [ ] **B6.** `get_pending_invitation(text)` is no longer executable by `PUBLIC`, `anon` or `authenticated` (or is dropped). Prod grants PUBLIC today (P-9), so revoking from anon alone is not enough.
  - The register screen's pre-check uses a code-gated function.
  - For a wrong code, a missing invitation, an expired one or a used one, that function returns the same response.
  - Without the right code, anon learns nothing about an email: no id, role, brand, stores or username.
- [ ] **B7 (jest + UI).** After a successful invite, `InviteUserDrawer` shows the invite link.
  - The link is the app's public web URL with `register=true` and the code. The architect picks the exact shape.
  - testIDs: `invite-link` (the text, selectable) and `invite-link-copy` (the copy button, web only, `navigator.clipboard`).
  - Closing the drawer returns to Users. No new native dependency: on native the link is selectable text.
- [ ] **B8 (jest).** Re-inviting an email that has a pending invitation the caller can see replaces it:
  - new code, new expiry, and the role, stores and username from the form
  - a new link is shown
  - the old code then fails as in B3
  - `"An invitation for this email already exists"` no longer blocks this case
- [ ] **B9 (jest).** `RegisterScreen` has an invite-code field (testID `register-code`), prefilled on web from the `code` URL parameter. Submitting without a code shows a client error and does not call `signUp`.
- [ ] **B10 (jest).** `registerInvitedUser(email, password, code)`:
  - runs the code-gated pre-check, then `signUp` (still no `role` in `options.data`), then exactly one claim RPC carrying the code
  - makes no direct table writes and does not call `get_pending_invitation`
  - when the pre-check fails, `signUp` is not called
- [ ] **B11 (smoke + jest).** The `send-invite-email` HTML body contains the invite link with the code.
  - The link is passed through the function's inline `escapeHtml()` (CLAUDE.md HTML-email rule).
  - The client sends it in the payload.
  - The function's role gate and response shape are unchanged.
  - `scripts/smoke-edge-roles.sh` arms still pass.

### C. Bounded expiry (191-M1a, D-3, D-4)
- [ ] **C1.** Client INSERT:
  - `expires_at` NULL → 42501
  - `expires_at` = `now() + 8 days` → 42501
  - `expires_at` omitted → admitted, stored ≈ `now() + 48h`
  - `expires_at` = `now() + 6 days` → admitted
- [ ] **C2.** Client UPDATE: setting `expires_at` to NULL or past `now() + 7 days` → 42501. Within the bound → admitted. This also needs a super_admin caller (review H1, owner 2026-11-10): a brand admin's or master's UPDATE matches 0 rows.
- [ ] **C3.** After the migration, every pending row (`used = false`) has `expires_at` non-NULL and at most `now() + 7 days`. Rows that broke this before the migration are now ≈ `apply time + 48h`. Rows already inside the bound are untouched. The pgTAP fixture covers NULL, `2099-01-01` and an in-bound row. On prod on 2026-11-09 the clamp matched 0 rows (D-4).
- [ ] **C4.** `retention_prune_job.test.sql` still passes, unchanged.

### D. Provenance and inviter re-check (D-2)
- [ ] **D1.** `invitations.invited_by` (uuid) is set to `auth.uid()` on every client INSERT. A payload carrying a different uuid gets the caller's uid stored (overwritten) or is refused; the architect picks which, and pgTAP pins it.
- [ ] **D2.** A client UPDATE cannot change `invited_by`. It is refused, or the column is left unchanged; pinned.
- [ ] **D3.** The claim refuses with `'no pending invitation'` when any of these hold:
  - the inviter's profile is gone
  - the inviter's current `profiles.role` is not admin, master or super_admin
  - the inviter is admin or master and their `profiles.brand_id` differs from the invitation's resolved brand

  The 191-M1 replay must refuse with the right code: `1111` creates an admin invitation, the super_admin demotes `1111`
  through `demote_profile_to_user`, then a claim arrives.
- [ ] **D4.** A claim by a still-privileged inviter's invitee succeeds (the B2 path). The claim reads `profiles` for the inviter, not the JWT.
- [ ] **D5 (review H1).** No client role can revive a used invitation (pgTAP H1 arms). The UPDATE policy is super_admin-only and admits only `used = false` rows in USING and WITH CHECK, so neither an in-scope admin nor the super_admin can set `used` back to false, re-point a consumed row, or set `used = true`; the SECURITY DEFINER claim stays the only writer of `used = true`. The auditor's probe C (master invites X, X claims, X tries to revive and re-point the row, the super_admin demotes X, a burner claims X's code) ends in `no pending invitation`.

### E. Grant ride-alongs (D-5, D-6)
- [ ] **E1.** `assert_not_last_of_role(uuid,text)`: `has_function_privilege` returns false for `anon`; no PUBLIC entry in `proacl`; true for `authenticated` and `service_role`.
  - On prod this already holds (P-9), so the statement is a no-op there. Post-apply, the prod ACL is unchanged.
  - Locally it removes the anon grant.
  - `scripts/smoke-delete-user.sh` passes: delete-user still refuses the last super_admin and last master with the same strings.
- [ ] **E2.** `consume_invitation(uuid,text)`: EXECUTE false for `anon` and `authenticated`. `consume_invitation_sets_profile_id.test.sql` is updated: the grant arm is flipped, and arm A runs as postgres or is retired with a comment.

### F. Regression and end-to-end
- [ ] **F1 (e2e).** `e2e/invite.spec.ts` passes after its update: master invites, sees `invite-link`, and the drawer closes.
- [ ] **F2 (e2e, new).** `e2e/invite-claim.spec.ts`:
  - master invites a run-unique email as staff with one store and reads the link from `invite-link`
  - a fresh browser context (no storageState) opens the link, registers with that email and a password, sees the success screen, and signs in
  - it lands on the staff surface with the invited store visible
  - **negative arm:** a second run-unique invitation, registered with the right email and a wrong code, shows the error, and a service-role check finds no profile for that email
  - it accounts for the local `inviteUserByEmail` fallback (see Risks)
- [ ] **F3.** Full `npx jest`, `npm run typecheck:test` and `npm run test:db` pass. Existing pgTAP files that call `get_pending_invitation` or the zero-argument `register_invited_profile()` are updated to the new contract:
  - `profiles_insert_hardening` (section C)
  - `profiles_username` arm 16
  - `staff_brand_id_backfill` arms 8, 9 and 13
  - `consume_invitation_sets_profile_id`
- [ ] **F4 (jest).** The Users list (`fetchAllUsers`) and Brands members tab (`fetchBrandAdmins`) still render emails for existing users: `get_profile_emails` is primary, and invitation inference is the fallback within the new scope. Existing jest suites pass. Any pin that assumes cross-brand invitation reads is updated, with a comment naming this spec.
- [ ] **F5.** The migration is pure ASCII, has `set local lock_timeout`, and has a fail-closed DO block. A rollback SQL file is written and dry-run in `begin … rollback`. These are 191's lessons.

## In scope

- Recreate the invitations SELECT and DELETE policies: brand and store scope, `auth_profile_is_privileged()`, `to authenticated`, and the D-7 rule. Fail-closed DO block. Update 191's K-13 pin.
- An invite code on every new invitation: hash storage, plaintext returned once to the inviter, the claim requiring the code, selection by code.
- Replace `register_invited_profile` for the code and the inviter re-check, and treat NULL expiry as expired.
- Remove PUBLIC, anon and authenticated EXECUTE on `get_pending_invitation`, or drop it. A code-gated pre-check replaces it.
- `invited_by` column, set server-side; the claim-time inviter re-check.
- Bound `expires_at` in INSERT and UPDATE WITH CHECK. Clamp legacy pending rows.
- Client:
  - `inviteUser`: obtain the code, replace on re-invite, pass the link to `send-invite-email`
  - `registerInvitedUser`: take the code
  - `InviteUserDrawer`: show the link
  - `RegisterScreen`: code field, URL prefill on web
- `send-invite-email`: include the escaped link in the HTML body.
- Revoke `assert_not_last_of_role` from anon and PUBLIC (D-5; a no-op on prod). Revoke `consume_invitation` from authenticated (D-6).
- Tests on all four tracks (see Project-specific notes).

## Out of scope (explicitly)

- **Turning on "Confirm email" on prod, or any prod Auth setting change.** It is blocked until a Resend domain is verified and the auth-email-hook is enabled. It becomes a follow-up once mail works.
- **Disabling open sign-up and a server-side claim function.** A stronger follow-up; it adds an anon edge function.
- **Void-on-demote in `demote_profile_to_user` or `delete-user` (rest of X3, per D-2).** The claim-time re-check makes those invitations inert.
- **X2, the `user_stores` admin policy swap (195-M1).** A different table and a different dependency (195 on prod). The owner can pull it in if 191 and 195 are both on prod when this is built.
- **X4, converging `auth_is_admin()` / `auth_is_privileged()` on `profiles`.** Far larger.
- **A pending-invitations management screen** (list, cancel, resend for non-super_admins). Re-invite (B8) covers the lost-link case. `resendInvite` in `src/lib/auth.ts` stays as is (it has no callers).
- **The `send-invite-email` `inviteUserByEmail` fallback.** Not changed. Recorded in Risks.
- **Mapping `register_invited_profile` error text to friendly copy (164 audit, Low #3).** The new single refusal string mostly makes it moot.
- **Rate-limiting the code-gated pre-check.** 128-bit codes make guessing infeasible. GoTrue's own sign-up rate limit still applies to `signUp`.
- **Correcting the `invitations_email_key` fixture string in `InviteUserDrawer.test.tsx:358`.** It is harmless test text. Leave it, unless the builder touches that test anyway.
- **Verifying a Resend domain, DNS, and the `app.json` slug.** None of these is touched.

## Open questions resolved

- Q (OQ-1): How does a claim prove it is the invited person? → A (owner, 2026-11-09): "One-time invite code (Recommended)." See D-1.
- Q (OQ-2): Do `invited_by` and X3 belong here? → A (owner, 2026-11-09): "Yes, record and re-check (Recommended)." Add `invited_by` and re-check the inviter at claim; void-on-demote stays in X3. See D-2.
- Q (OQ-3): What is the expiry bound? → A (owner, 2026-11-09): "At most 7 days (Recommended)." See D-3.
- Q (OQ-4): What happens to invitations pending at apply? → Not asked. Moot: prod had 0 pending invitations and 0 NULL expiries on 2026-11-09. Keep the clamp and re-check at apply. See D-4.
- Q (OQ-5): Does 191-L3 ride along? → Not asked. Prod already has no anon or PUBLIC entry, so the revoke stays as repo and local alignment and is a no-op on prod. See D-5.
- Q (OQ-6): Does the `consume_invitation` revoke ride along? → A (owner, 2026-11-09): "Revoke it (Recommended)", from `authenticated`. See D-6.
- Q (OQ-7): Who sees brand-less invitations? → Not asked. It follows D-2, so the recommendation stands: super_admin and the inviter only. See D-7.
- Q (AD-4): Should a zero-store staff invitation from an admin or master carry the inviter's brand? → A (owner, 2026-11-10): **keep the default.** `create_invitation` stamps the calling admin's or master's own `profiles.brand_id`, so the invitee registers as a brand user with no stores. A super_admin's zero-store invitation stays brand-less. (The alternative not taken: relax D3 so it skips the brand comparison when the resolved brand is NULL and the role is `user`.)
- Q (review H1): How is a consumed invitation kept from being revived through the client UPDATE policy? → A (owner, 2026-11-10): "Super_admin-only update (Recommended)." Add `and public.auth_is_super_admin() and invitations.used = false` to the invitations UPDATE policy's USING and WITH CHECK, keep the literal `spec 191` in the policy comment (K-17), and keep the 1/1/1/1 policy shape. See AC D5.
- Q (review L1): Should the invite code move from the URL query string to a `#fragment`? → A (owner, 2026-11-10): "Keep query string (Recommended)." **Recorded as a follow-up:** moving it later means `LoginScreen` must accept both link formats; the fragment change ripples into `inviteLink.ts`, `send-invite-email`'s link, `LoginScreen`'s parsing, the source probe, both e2e regexes and a `detectSessionInUrl` / `recoveryUrl` re-check.
- Q (review L3): Should in-scope admins lose read access to `code_hash`? → A (owner, 2026-11-10): **deferred**, together with deleting the dead `resendInvite`. Caveat for whoever picks it up: `revoke select (code_hash) ... from authenticated` is a no-op while `authenticated` holds table-level SELECT (spec 097's explicit grants); it needs the table SELECT revoked and the other columns granted one by one.
- Q (review L4): Should `send-invite-email` bind `inviteCode` to an invitation? → A (owner, 2026-11-10): **no change.** It is the pre-existing "admins can mail anyone" surface, and an arbitrary code is inert at claim.

## Dependencies

- **Spec 191 applied to prod** (`20261109191000`): `auth_profile_is_privileged()`, plus the P_INV text this spec copies.
  - 191 is not on prod (P-12) and is FIXES_NEEDED and uncommitted as of 2026-11-09.
  - This spec's prod apply must come after 191's.
  - If 191's migration body changes, this spec re-copies the final P_INV text.
- **Spec 195 on prod (strongly preferred, not required):** not on prod yet (P-12). With 195, a squatted brand-less staff profile can't self-link stores. The B3/D3 refusals make this belt-and-braces.
- **Spec 186's prune job** (`20261108120000`), which removes the clamped legacy rows. It is not modified.
- **Spec 164's `register_invited_profile` contract** (R1-R6 strings and atomicity), carried forward except where B3/B5/D3 change it.
- **Spec 197 (revoke client TRUNCATE):** table grants only. No overlap with this spec's function grants, but both write `public` grants; order the prod applies one at a time.
- **`get_profile_emails` (spec 163)**, which keeps Users-list emails working once invitation reads narrow (F4).
- **Timing:** prod has no pending invitations now, so there is no live exposure. Admins should hold off on new invites until this ships, or keep them few and short-lived.
- **Before the prod apply:** re-run the pre-check queries (P-1 to P-3, P-8, P-9, P-12) and do the owner dashboard checks.

## Risks

- **Local and CI `inviteUserByEmail` fallback.** Without `RESEND_API_KEY`, inviting creates an `auth.users` row for the invitee (`send-invite-email/index.ts:94-99`). The app's later `signUp` for that email may then fail, so the F2 e2e could fail for a reason that has nothing to do with this spec. The architect decides how F2 handles it, for example by verifying the current behaviour first, or by removing that row in the e2e fixture. Prod behaviour depends on the `RESEND_API_KEY` dashboard check.
- **Lost links.** The code is stored hashed, so an admin who closes the drawer without copying has to re-invite (B8). That is acceptable because re-invite is one action, but the drawer copy must say so.
- **Invitations pending at apply stop working (D-4).** None existed on 2026-11-09. If any appear before the apply, those people need re-inviting right after it.
- **Narrower invitation reads (F4).** Brand admins lose cross-brand and brand-less invitation rows as an email-inference fallback. `get_profile_emails` is primary since spec 163, and prod has no brand-less, store-less rows (P-6), so the impact should be nil.
- **Confirm email turned on before mail works.** P-11 shows confirmation off today. If anyone turns it on while mail can't deliver, `signUp` returns no session and every registration, including this spec's flow, stalls. Leave it off until the mail follow-up.
- **Realtime publication gotcha.** Not triggered: no table is added to `supabase_realtime`. If the architect adds one, the local realtime container needs a restart.

## Project-specific notes

- **Cmd UI section / legacy:** Cmd UI `src/screens/cmd/sections/UsersSection.tsx` via `src/components/cmd/InviteUserDrawer.tsx` (invite link). Also the pre-auth `src/screens/RegisterScreen.tsx` (and `LoginScreen.tsx`'s `?register=true` hand-off). There is no legacy surface. The staff app is a consumer only: the invitee lands there after registering. No change under `src/screens/staff/`.
- **Per-store or admin-global:** brand- and store-scoped by `auth_can_see_brand()` / P_INV. Super_admin is global. Brand-less, store-less rows are scoped by inviter (D-7).
- **Realtime channels touched:** none. Invitations are not published on `store-{id}` or `brand-{id}`.
- **Migrations needed:** yes. One migration covering:
  - the SELECT/DELETE policies
  - the code storage and the `invited_by` column
  - the INSERT/UPDATE expiry bound (re-copying 191's P_INV with the bound added)
  - replacing `register_invited_profile` and `get_pending_invitation`, and the new code-gated pre-check
  - the legacy clamp
  - the grants (D-5, D-6)
  - the fail-closed DO block

  Plus a rollback SQL file. Prod apply goes through MCP `execute_sql` with the exact `schema_migrations` version and a normalized-md5 check of every replaced function. It comes after 191's prod apply.
- **Edge functions touched:** `send-invite-email` (link in the HTML body, escaped). `delete-user` is not modified; its smoke is re-run for D-5. No new function.
- **Web/native scope:** both. The copy button is web only; on native the link is selectable text and the code is typed or pasted into `register-code`. URL prefill is web only. No new native dependency.
- **Test tracks:**
  - **pgTAP:** new `supabase/tests/invitations_hardening.test.sql` for A, B1-B6, C, D and E, plus edits to `profiles_insert_hardening`, `profiles_username`, `staff_brand_id_backfill` and `consume_invitation_sets_profile_id`
  - **jest:** `inviteUser`, `registerInvitedUser`, `InviteUserDrawer`, `RegisterScreen`, `fetchAllUsers` / `fetchBrandAdmins` pins
  - **e2e (Playwright, `e2e.yml`):** updated `invite.spec.ts` plus the new `invite-claim.spec.ts`. This is the only track that exercises real GoTrue sign-up, so it matters most here.
  - **Shell smokes:** `smoke-edge-roles.sh` (send-invite-email) and `smoke-delete-user.sh` (D-5)
- **`app.json` slug:** not touched.

## Backend design

Architect: backend-architect, 2026-11-10. This section is the design authority for the migration header, the
client contract and the tests. Line numbers are pointers.

### 0. Architect decisions (read these first)

- **AD-1 Code and hash.**
  - The code is 16 bytes from `extensions.gen_random_bytes(16)` (pgcrypto, a CSPRNG), encoded as 32 lowercase hex
    characters, so exactly 128 bits. pgcrypto already runs from `extensions` (`20260424211733_security_fixes.sql:147`).
  - Stored value: `code_hash = encode(sha256(convert_to(<code>, 'UTF8')), 'hex')`. `sha256(bytea)` is core Postgres
    (11+), so the hash needs no extension.
  - No salt and no pepper. Salting protects low-entropy secrets such as passwords against precomputation. A uniform
    128-bit secret can't be precomputed, and a per-row salt would rule out an indexed lookup.
  - **Why constant-time comparison isn't needed:** the plaintext is never compared. The server hashes the input and
    does a B-tree equality probe on `code_hash`. At most, timing could hint at where the guess's digest falls in index
    order. That says nothing about any stored code's preimage, and SHA-256 preimage resistance stops anyone turning
    "digest near X" into "input near the code". Network jitter dwarfs the signal anyway.
- **AD-2 Create path: a new SECURITY INVOKER RPC `create_invitation(...)` returns the plaintext once.**
  - **Why INVOKER:** RLS stays the single authority. The INSERT/UPDATE/DELETE policies decide who may write what, and
    the RPC can do nothing a direct PostgREST write could not. A DEFINER RPC would need its own copy of P_INV, which is
    a second place to drift.
  - The INSERT policy now requires `code_hash is not null`. A direct client insert with no code (an old cached
    bundle's `inviteUser`) therefore fails loudly with 42501, instead of creating an invitation nobody can claim.
  - A privileged in-scope caller could still insert directly with a `code_hash` it picked itself. That gives no new
    power: such a caller can already mint invitations in the same scope, and the D-2 re-check still applies to them.
    It is accepted and recorded.
- **AD-3 Provenance: overwrite on INSERT, unchanged on UPDATE.**
  - A BEFORE INSERT OR UPDATE trigger stamps `invited_by := auth.uid()` on every client INSERT. A different uuid in
    the payload is overwritten, not refused (D1).
  - On client UPDATE, the same trigger forces `invited_by := old.invited_by` and `code_hash := old.code_hash` (D2).
  - As a belt-and-braces check, the INSERT WITH CHECK also requires `invited_by = auth.uid()`. With the trigger in
    place it can never fail. It fails closed if the trigger is ever dropped.
- **AD-4 (behaviour change, owner-visible).** For a `role = 'user'` invitation with no brand and no stores, created by
  an admin or master, `create_invitation` stamps the caller's own `profiles.brand_id`.
  - **Why:** D3 refuses a claim when the inviter is admin/master and their brand differs from the resolved brand. A
    NULL resolved brand always differs, so without this every zero-store staff invitation from an admin/master would
    be unclaimable. `InviteUserDrawer` lets you send one today (`InviteUserDrawer.tsx:169-174`, "No stores visible
    yet" copy at :523-528).
  - **Effect:** such an invitee registers as a brand-A user with no stores, instead of a NULL-brand user. That matches
    what a staff invite with a store already produces (spec 069).
  - A super_admin's zero-store invitation stays brand-less, which is the D-7 row shape. The super_admin passes D3
    because super_admins have no brand check.
  - **Alternative not taken:** relax D3 to skip the brand comparison when the resolved brand is NULL and the role is
    `user`. Either option is secure. The stamp keeps D3 literal and shrinks the D-7 population. **PM/owner: confirm or
    flip; this doesn't block the build.**
- **AD-5 (push-back on B7/B9 wording): the URL parameter is `invite`, not `code`.**
  - `?code=` is already taken in two places. The spec 085 recovery boot gate treats any `code` param as a PKCE
    recovery link (`src/lib/recoveryUrl.ts:102-105`). supabase-js also treats `code` as its PKCE callback on web
    (`detectSessionInUrl: true`, `flowType: 'pkce'`, `src/lib/supabase.ts:18,36`).
  - Link shape: `<web origin>/?register=true&invite=<32 hex>`.
- **AD-6 Hand-off from LoginScreen to RegisterScreen goes through a route param.**
  - `LoginScreen.tsx:51-59` calls `window.history.replaceState(...)` straight after `nav.navigate('Register')`, so
    the query string is gone before RegisterScreen mounts.
  - LoginScreen reads `invite` and passes it as `nav.navigate('Register', { invite })`. Side benefit: the code leaves
    the address bar and the history entry at once.
- **AD-7 (refines B11 "the client sends it"): the client sends the code, not a URL.**
  - `send-invite-email` takes `inviteCode`, checks it against `^[0-9a-f]{32}$`, and builds the link from its fixed
    `APP_URL`. A caller-supplied href would let any admin put an arbitrary link into mail from the app's sender.
  - The drawer's link (web: `window.location.origin`) and the email's link (`APP_URL`) can differ in host. Both serve
    the same app and both work.
- **AD-8 Both legacy RPCs are dropped:** `get_pending_invitation(text)` (B6 allows dropping) and the zero-argument
  `register_invited_profile()` (B4). Dropping beats revoking because nothing is left to re-grant by accident.
- **AD-9 Pre-check: `check_invitation_code(p_email text, p_code text) returns table (name text)`.**
  - It returns 0 rows for every case the claim would refuse. That covers wrong code, missing code, used, expired,
    NULL expiry, email mismatch, legacy no-code rows, bad role or brand, and an inviter who fails D3.
  - When the claim would succeed, it returns 1 row holding only the invitation's display name.
  - anon may EXECUTE it, because RegisterScreen runs before sign-in.
- **AD-10 (missing from the spec): `InviteAdminDrawer` is a second invite surface.**
  - `src/components/cmd/InviteAdminDrawer.tsx:92` (BrandsSection members tab, super_admin) also calls `inviteUser`. If
    it doesn't show the link, the invitations it creates can never be claimed.
  - Both drawers will use one new shared component, `InviteLinkPanel`.
- **AD-11 (push-back on A9, "no other K-arm changes"): more pins have to move.**
  - `profiles_insert_hardening.test.sql` K-6..K-11 pin `'public.register_invited_profile()'::regprocedure`. Once the
    zero-argument function is dropped, that cast throws, so K-6..K-11 must be retargeted to
    `register_invited_profile(text)`.
  - Because of AD-2, every client-role INSERT in that file's Sections D/E, and arms (i)-(iii) of
    `invitations_super_admin_rls.test.sql`, must add a `code_hash` value. These are mechanical edits, listed in 8.2.
  - K-14..K-18 stay unchanged.
- **AD-12 The D-7 clause also goes into UPDATE USING and WITH CHECK, not only SELECT/DELETE.** Otherwise an admin could
  PATCH a brand-less, store-less row they can't see, or turn another inviter's row into one.
  - **Since review H1 (owner, 2026-11-10)** the UPDATE policy is super_admin-only and limited to `used = false` rows, so
    AD-12 now protects only the super_admin path. D7 already admits every row to the super_admin, so the clause is
    belt-and-braces there; it is kept so the four policies keep one shape and the text pins (K-16, the DO block) hold.

### 1. Data model

**Migration:** `supabase/migrations/20261110120000_invitations_hardening.sql`.
- The newest file on disk is `20261109230000_revoke_client_truncate.sql`, checked 2026-11-10.
- Before committing, run `ls supabase/migrations | sort | tail -3`. If anything sorts at or after `20261110120000`,
  bump to the next free hour on 2026-11-10 and update every reference: this spec, the header, the rollback file and
  the `schema_migrations` insert.
- **Rollback file:** `specs/198-invitations-hardening/rollback.sql`. It is not under `supabase/migrations/`, so the CLI
  never applies it.

**Shape:**
- Pure ASCII (spec 163 M1).
- One `begin; ... commit;`, with `set local lock_timeout = '5s'` as the first statement. ALTER TABLE and the policy
  DDL take AccessExclusive on `invitations`.
- Header comment modelled on 191's: what, check orders, prod-apply, rollback pointer, tests. Policy comments on
  INSERT/UPDATE must still contain the text `spec 191` so K-17 stays green, e.g.
  `'spec 198 (on top of spec 191 / 164-M2): ...'`.

**Statement order:**
0. `set local lock_timeout = '5s';`
1. **Prerequisite DO block**, which raises `'198: ...'`:
   - `to_regprocedure('public.auth_profile_is_privileged()') is null` → `'198: requires spec 191 (20261109191000) applied first'`.
   - `not has_function_privilege('authenticated', 'extensions.gen_random_bytes(integer)', 'EXECUTE')` or
     `not has_schema_privilege('authenticated', 'extensions', 'USAGE')` → `'198: authenticated cannot call extensions.gen_random_bytes'`.
     `create_invitation` is INVOKER, so the caller needs both privileges.
2. **Columns (additive, nullable, no default):**
   - `alter table public.invitations add column invited_by uuid, add column code_hash text;`
   - **No FK on `invited_by`:** an FK would add a referential action to every `profiles` delete (`delete-user`,
     cascades) for no gain. The claim already treats "inviter row missing" as a refusal.
   - `add constraint invitations_code_hash_format check (code_hash is null or code_hash ~ '^[0-9a-f]{64}$')`
   - `create unique index invitations_code_hash_key on public.invitations (code_hash) where code_hash is not null;`
     This is what makes the B5 "select by code" lookup single-row.
   - **No NOT NULL on `expires_at`:** `retention_prune_job.test.sql` A5-5 seeds a NULL-expiry row as postgres, and C4
     requires that file unchanged. The bound lives in the policies (C1/C2) and the claim (B3).
3. **Trigger function `public.assert_invitation_provenance()`:**
   - `returns trigger`, `language plpgsql`, SECURITY INVOKER (spec 042 round-4: `current_user` must be the real
     caller), `set search_path = public, auth`.
   - Body (pseudocode):
     `if current_user in ('authenticated','anon') then if tg_op='INSERT' then new.invited_by := auth.uid(); else new.invited_by := old.invited_by; new.code_hash := old.code_hash; end if; end if; return new;`
   - Skips postgres (migrations, pgTAP fixtures, MCP, the DEFINER claim's own UPDATE) and service_role.
   - Trigger: `create trigger invitations_provenance_guard before insert or update on public.invitations for each row execute function public.assert_invitation_provenance();`
   - A trigger function can't be called outside a trigger, so no grant is needed. Review L2 (hygiene):
     `revoke all on function public.assert_invitation_provenance() from public, anon, authenticated;`. Postgres checks
     EXECUTE on a trigger function at CREATE TRIGGER time, not when it fires, so client writes still run it
     (IH B1/C1/D1/A6 insert as `authenticated` and stay green).
4. **Clamp (D-4), runs as postgres so the trigger skips it:**
   `update public.invitations set expires_at = now() + interval '48 hours' where used = false and (expires_at is null or expires_at > now() + interval '7 days');`
   Then `raise notice '198: clamped % pending invitation(s)', <row_count>;`. Expected 0 on prod.
5. **Policies:** drop and recreate all four (section 2).
6. **Functions** (section 3), in this order:
   - `drop function if exists public.get_pending_invitation(text);`
   - `drop function if exists public.register_invited_profile();`
   - `create function public.register_invited_profile(text)`
   - `create function public.check_invitation_code(text, text)`
   - `create function public.create_invitation(text, text, text, text[], uuid, text)`
   - Grants follow each one.
7. **Ride-along grants (E):**
   - `revoke execute on function public.assert_not_last_of_role(uuid, text) from public, anon;`
     then `grant execute on function public.assert_not_last_of_role(uuid, text) to authenticated, service_role;`
     This is a no-op on prod (P-9) and removes the local anon grant.
   - `revoke execute on function public.consume_invitation(uuid, text) from public, anon, authenticated;`
     service_role keeps its grant. The function body is not changed.
8. **Fail-closed DO block** (section 2.4).
9. **Prod only:** the `schema_migrations` insert goes immediately before `commit;` (section 10). After commit, run
   `notify pgrst, 'reload schema';` so PostgREST sees the dropped and new functions straight away.

**Destructive vs additive:** columns, index, constraint and trigger are additive. The two function drops break any
client still calling them. That is intended, and section 11 covers it. No data is deleted; the clamp only shortens
expiries.

**Realtime:** no publication change, so no `docker restart supabase_realtime_imr-inventory` is needed.

### 2. RLS

`public.invitations` keeps exactly four PERMISSIVE policies. **All four are `to authenticated`** (SELECT and DELETE
are `public` today), and all four use `public.auth_profile_is_privileged()`, never `auth_is_privileged()`.

Shorthand used below. Write these out in full in the SQL, not as helper functions, so the policy text checks (A8,
K-16) can see them.

- **SCOPE** is 191's P_INV body with its privilege leaf removed, verbatim from `20261109191000:464-472`:
  ```
  invitations.role in ('user', 'admin')
  and (invitations.brand_id is null or public.auth_can_see_brand(invitations.brand_id))
  and not exists (
    select 1
      from unnest(coalesce(invitations.store_ids, '{}'::text[])) as sid(store_id)
      left join public.stores s on s.id::text = lower(sid.store_id)
     where s.id is null
        or not public.auth_can_see_brand(s.brand_id)
  )
  ```
- **D7**, the D-7 visibility rule for rows with no brand and no stores:
  ```
  (
    invitations.brand_id is not null
    or cardinality(coalesce(invitations.store_ids, '{}'::text[])) > 0
    or public.auth_is_super_admin()
    or invitations.invited_by = auth.uid()
  )
  ```
  A legacy row with NULL `invited_by` gives `NULL` on the last arm, so only the super_admin sees it (A6). Do not add a
  `true` or `auth.uid() is not null` arm here: the spec 053 lint would flag it, and it would reopen the hole.
- **EXPIRY**: `invitations.expires_at is not null and invitations.expires_at <= now() + interval '7 days'`

#### 2.1 Policies

| Policy (name unchanged) | Cmd | Predicate |
|---|---|---|
| `"Admins can read invitations"` | SELECT | `using (auth_profile_is_privileged() and SCOPE and D7)` |
| `"Admins can delete invitations"` | DELETE | `using (auth_profile_is_privileged() and SCOPE and D7)` |
| `"Admins can insert invitations"` | INSERT | `with check (auth_profile_is_privileged() and SCOPE and EXPIRY and invitations.code_hash is not null and invitations.invited_by = auth.uid())` |
| `"Admins can update invitations"` | UPDATE | `using (auth_profile_is_privileged() and auth_is_super_admin() and used = false and SCOPE and D7)` `with check (auth_profile_is_privileged() and auth_is_super_admin() and used = false and SCOPE and D7 and EXPIRY)` (review H1: super_admin-only, unused rows only) |

Notes:
- BEFORE ROW triggers run before WITH CHECK. On INSERT, `invited_by` has already been stamped when the policy reads it.
- With PostgREST, `INSERT ... RETURNING` also needs the SELECT policy. The new row passes it: it's in scope, and D7
  holds because `invited_by = auth.uid()`. `create_invitation` doesn't use RETURNING anyway (3.1).
- Rows whose role is `master` or `super_admin` (only writable as postgres) are invisible to every client, the
  super_admin included. That's unchanged in effect and accepted; the nightly prune removes them once expired.
- A2-A7 follow directly from the predicates. Stale claim (A3): `auth_profile_is_privileged()` reads `profiles.role`.
  anon (A7): no policy names anon or public, so RLS returns 0 rows.

#### 2.2 Helpers

- `auth_profile_is_privileged()` (191, DEFINER, `authenticated` only).
- `auth_can_see_brand(uuid)` and `auth_is_super_admin()` (012a, DEFINER).
- `auth_can_see_store()` is not used: invitations are brand- or store-list scoped, not single-store, as in P_INV.

#### 2.3 Lint and pins

- **Spec 053 lint** (`permissive_policy_lint.test.sql`): none of the four predicates contains a trivially wide token
  (`auth.uid() is not null`, `true`, `auth.role() = 'authenticated'`). `invited_by = auth.uid()` doesn't match the
  lint regex. No allowlist row is needed.
- **`profiles_insert_hardening.test.sql`:**
  - K-14 and K-15: counts unchanged.
  - K-16: INSERT/UPDATE text still uses `auth_profile_is_privileged()` → unchanged.
  - K-17: needs the comments to contain `spec 191` → unchanged.
  - K-13: rewritten (8.2).

#### 2.4 Fail-closed DO block

Every message starts with `'198:'`. The block checks:
1. Exactly 1 permissive policy for each of `cmd in ('SELECT','ALL')`, `('INSERT','ALL')`, `('UPDATE','ALL')` and
   `('DELETE','ALL')` on `public.invitations`.
2. All four policies have `roles = '{authenticated}'`, and no `invitations` policy's roles contain `anon` or `public`.
3. Text checks, on `lower(regexp_replace(x, '\s+', ' ', 'g'))`:
   - Every non-null `qual`/`with_check` of the four policies contains `auth_profile_is_privileged()` and does not
     contain `auth_is_privileged()`.
   - SELECT and DELETE `qual`: contains `auth_can_see_brand`, `auth_is_super_admin()` and `invited_by = auth.uid()`.
   - INSERT `with_check`: contains `code_hash is not null`, `invited_by = auth.uid()` and `7 days`.
   - UPDATE `qual`: contains `invited_by = auth.uid()`.
   - UPDATE `with_check`: contains `7 days`.
   - UPDATE `qual` and `with_check` (review H1): contain `used = false`, and `auth_is_super_admin()` at least twice
     (D7's arm plus the super_admin-only leaf).
4. Functions:
   - `to_regprocedure('public.get_pending_invitation(text)') is null`
   - `to_regprocedure('public.register_invited_profile()') is null`
   - `public.register_invited_profile(text)` is `prosecdef` and owned by `postgres`
   - `public.create_invitation(text,text,text,text[],uuid,text)` is not `prosecdef`
5. Grants:
   - `not has_function_privilege('anon', 'public.assert_not_last_of_role(uuid,text)', 'EXECUTE')`
   - `not has_function_privilege('authenticated', 'public.consume_invitation(uuid,text)', 'EXECUTE')`
   - `not has_function_privilege('anon', 'public.create_invitation(text,text,text,text[],uuid,text)', 'EXECUTE')`
   - `not has_function_privilege('anon', 'public.register_invited_profile(text)', 'EXECUTE')`
   - review L2: neither `anon` nor `authenticated` can execute `public.assert_invitation_provenance()`
6. Invariant: `0 = count(*) where used = false and (expires_at is null or expires_at > now() + interval '7 days')`.

### 3. API contract (RPC, not PostgREST tables)

#### 3.1 `public.create_invitation`

```
create_invitation(
  p_email     text,
  p_name      text,
  p_role      text,      -- 'user' | 'admin'
  p_store_ids text[],    -- may be empty
  p_brand_id  uuid,      -- required for 'admin'; may be null for 'user'
  p_username  text       -- may be null or blank
) returns jsonb          -- {"invitation_id": uuid, "code": text(32 hex), "expires_at": timestamptz}
language plpgsql volatile security invoker set search_path = public
```

- **Why jsonb and not `returns table`:** plpgsql OUT names such as `expires_at` would shadow the columns. The 164
  header warns about the same thing.
- **Grants:** `revoke all ... from public, anon; grant execute ... to authenticated;`. The anon revoke is load-bearing
  (spec 097 default privileges).

**Check order** (an INVOKER function, so every write below is also subject to RLS):
1. `auth.uid()` is null, or `not public.auth_profile_is_privileged()` → `42501 'forbidden'`.
2. `v_email := lower(btrim(p_email))`. Empty → `22023 'email required'`.
3. `p_role` null or not in `('user','admin')` → `22023 'invalid role'`.
4. `v_stores := coalesce(p_store_ids, '{}')`.
5. Brand:
   - `admin`: `v_brand := p_brand_id`. Null → `P0001 'admin invitation requires a brand'` (the same string as claim R6).
   - `user`: `v_brand := p_brand_id`. If null and `cardinality(v_stores) > 0`, use
     `(select s.brand_id from public.stores s where s.id::text = lower(v_stores[1]))`. This is a text comparison, so a
     malformed id gives NULL rather than 22P02, and RLS then refuses the store.
     If still null and `cardinality(v_stores) = 0`, use `(select p.brand_id from public.profiles p where p.id = auth.uid())`
     (AD-4; an own-row read; NULL for a super_admin).
6. `v_username := nullif(lower(btrim(p_username)), '')`.
7. Generate the values:
   - `v_code := encode(extensions.gen_random_bytes(16), 'hex')`
   - `v_hash := encode(sha256(convert_to(v_code, 'UTF8')), 'hex')`
   - `v_id := gen_random_uuid()`
   - `v_exp := now() + interval '48 hours'`
8. Replace (B8): `delete from public.invitations where lower(email) = v_email and used = false;`. RLS limits this to
   rows the caller can see. An out-of-scope pending row for the same email stays, which is the B5 shape.
9. `insert into public.invitations (id, email, profile_id, name, role, store_ids, brand_id, username, expires_at, code_hash)`
   `values (v_id, v_email, '00000000-0000-0000-0000-000000000000', p_name, p_role, v_stores, v_brand, v_username, v_exp, v_hash);`
   No RETURNING. The trigger stamps `invited_by`, and the INSERT policy enforces SCOPE, EXPIRY and the code.
10. `return jsonb_build_object('invitation_id', v_id, 'code', v_code, 'expires_at', v_exp);`

**Never** `raise notice` the code, and never write it to any table or log.

**Errors the client will see** (as PostgREST error `message`):
- `forbidden`
- `email required`
- `invalid role`
- `admin invitation requires a brand`
- `new row violates row-level security policy for table "invitations"` (out-of-scope brand or store)
- a `23514` naming `invitations_username_format`
- anything else is passed through

#### 3.2 `public.check_invitation_code` (replaces `get_pending_invitation`)

```
check_invitation_code(p_email text, p_code text) returns table (name text)
language sql stable security definer set search_path = public
```

- **Grants:** `revoke all ... from public; grant execute ... to anon, authenticated;`. service_role keeps its default
  grant.
- **Body:** select `i.name` (qualify every column) from `public.invitations i`, `limit 1`, where all of the following
  hold. This is **predicate CP**:
  - `nullif(btrim(p_code), '') is not null`: R3b's blank-code guard (review, test-engineer Should-fix 1). Without it,
    a row whose `code_hash = sha256('')` (plantable by any privileged in-scope caller, because the INSERT policy checks
    only the 64-hex format) made CP return 1 row for a blank code while the claim refused at R3b.
  - `i.code_hash = encode(sha256(convert_to(lower(btrim(p_code)), 'UTF8')), 'hex')` (a null `p_code` gives a null
    hash, which matches nothing)
  - `lower(i.email) = lower(btrim(p_email))`
  - `i.used = false and i.expires_at is not null and i.expires_at > now()`
  - `i.role in ('user','admin') and (i.role <> 'admin' or i.brand_id is not null)`
  - `exists (select 1 from public.profiles p where p.id = i.invited_by and p.role in ('admin','master','super_admin') and (p.role = 'super_admin' or p.brand_id = RB))`
  - where **RB** is `coalesce(i.brand_id, (select s.brand_id from public.stores s where s.id::text = lower(i.store_ids[1])))`
- **Response:** 0 rows for every refusal case (B6 "same response"), 1 row `{ name }` when the claim would succeed.
- **Brute force:** 2^128 codes, one index probe per call. At 10^4 calls/s, finding one live code takes about 10^30
  years. No rate limit is added (spec Out of scope). Spamming this endpoint is the same DoS surface as any anon
  PostgREST call.

#### 3.3 `public.register_invited_profile(p_code text) returns uuid` (replaces the zero-argument version)

- plpgsql, SECURITY DEFINER, `set search_path = public` (K-8's pin is unchanged), owned by `postgres`.
- **Grants:** `revoke all ... from public, anon; grant execute ... to authenticated;`.

**Check order.** Every refusal is P0001. Behaviour that isn't listed is unchanged from `20261007000000:133-245`.

| # | Condition | Message |
|---|---|---|
| R1 | `auth.uid()` null | `not authenticated` |
| R2 | a profile already exists for `auth.uid()` | `profile already exists` |
| R3a | `v_email := lower(auth.users.email)` is empty | `no pending invitation` |
| R3b | `p_code` is null or blank | `no pending invitation` |
| R3c | `select * into v_inv from public.invitations where code_hash = <hash of lower(btrim(p_code))> for update`; not found | `no pending invitation` |
| R3d | `lower(v_inv.email) <> v_email`, or `v_inv.used`, or `v_inv.expires_at is null`, or `v_inv.expires_at <= now()` | `no pending invitation` |
| R5 | role not in `('user','admin')` | `invitation role not allowed` (kept) |
| R6 | admin with NULL brand | `admin invitation requires a brand` (kept) |
| - | resolve `v_brand`: staff use RB (now a **text** comparison, replacing `(store_ids[1])::uuid`); admin use `brand_id` | |
| R7 (D3) | `select p.role, p.brand_id ... from public.profiles p where p.id = v_inv.invited_by for share`: not found (this covers NULL `invited_by` and a deleted inviter), or role not admin/master/super_admin, or role is admin/master and `p.brand_id is distinct from v_brand` | `no pending invitation` |
| W1-W3 | insert `profiles`, insert `user_stores`, mark the invitation `used = true, profile_id = v_uid` | as 164 |

- R4 (`'multiple pending invitations'`) is removed: the unique index makes R3c single-row (B5).
- **Why R7 takes `for share`:** it conflicts with the `for no key update` that `demote_profile_to_user` takes on its
  target (191 step 4), and with the row lock a `profiles` DELETE takes.
  - A claim racing a demotion or a deletion of its inviter waits. Under READ COMMITTED it then re-reads the committed
    row and refuses.
  - Lock order is invitation row, then inviter row. Demote locks only `profiles` rows, so no cycle exists.
- **CP vs R3-R7:** the pre-check and the claim apply the same conditions (R5/R6 are folded into CP as plain filters).
  The pgTAP agreement matrix in 8.1 pins this, so the two copies can't drift unnoticed.

### 4. Edge function: `send-invite-email`

- `verify_jwt` stays at the default (true). There's no `config.toml` change, and the role gate (`ADMIN_ROLES`,
  `requireAdminCaller`) is unchanged.
- **Body:** `{ email, name, role, storeNames, inviteCode }`.
- **Order** (the smoke's `{}` arm must still hit the existing email/name 400 first):
  1. The existing `email and name required` check (unchanged).
  2. New: `typeof inviteCode !== 'string' || !/^[0-9a-f]{32}$/.test(inviteCode)` → 400 `{ error: "inviteCode required" }`.
     Same envelope shape.
  3. `const inviteUrl = \`${APP_URL}/?register=true&invite=${inviteCode}\`;`
  4. Resend HTML:
     - The button `href` is `${escapeHtml(inviteUrl)}`.
     - Add one fallback line under the button: "If the button does not work, open this link: ${escapeHtml(inviteUrl)}".
     - "expires in 48 hours" stays.
  5. **The fallback branch** (`inviteUserByEmail`) **stays byte-for-byte unchanged.** Keep its `redirectTo` as the
     legacy `${APP_URL}?register=true` through a separate constant (spec Out of scope).
- The response shape is unchanged: `{ success, method }`.
- The client remains fire-and-forget through `callEdgeFunction` (unchanged pattern).
- **Known, out of scope:** `requireAdminCaller` trusts `app_metadata.role` first, which can be a stale claim. A demoted
  admin could still trigger an email, but any code they hold is inert under R7.

### 5. Client contract (`src/lib/auth.ts`, a new pure helper, and no `db.ts` change)

**Why `auth.ts` and not `db.ts`:**
- `inviteUser` and `registerInvitedUser` already live in `auth.ts`, a documented CLAUDE.md carve-out.
- `registerInvitedUser` runs before sign-in and before the store and the `tracked()` chain exist, for the same reason
  `authGate.ts` and `sessionRestore.ts` are carve-outs.
- No new `supabase.*` call appears outside `auth.ts`. `src/lib/db.ts` is **not changed**:
  - `fetchInvitationsForUserLookup` and `fetchBrandAdmins` keep their selects. RLS narrows what they return (F4).
  - Neither selects `code_hash`.

#### 5.1 New `src/lib/inviteLink.ts`

It's pure: no supabase and no react-native imports, so jest needs no mocks.

```ts
export const INVITE_URL_PARAM = 'invite';
export const INVITE_CODE_RE = /^[0-9a-f]{32}$/;           // parity with send-invite-email (8.3)
export function normalizeInviteCode(raw: string | null | undefined): string;
  // trim; if the input contains "invite=", take that query value (a pasted full link); lowercase; '' if nothing
export function isInviteCode(value: string): boolean;      // INVITE_CODE_RE.test(value)
export function buildInviteLink(base: string, code: string): string;
  // `${base.replace(/\/+$/, '')}/?register=true&invite=${code}`
export function inviteLinkBase(
  platformOS: string,
  webOrigin: string | null | undefined,
  configuredWebUrl: string | null | undefined,
): string | null;
  // web: webOrigin ?? null
  // native: the scheme+host of configuredWebUrl via /^(https?:\/\/[^/?#]+)/ (do not use `new URL().origin`,
  //   RN's URL polyfill is partial), else null
```

#### 5.2 `src/lib/auth.ts`

```ts
export const INVITE_CODE_REQUIRED_ERROR = 'Enter the invite code from your invitation link.';
export const NO_PENDING_INVITATION_ERROR =
  'No pending invitation matches this email and invite code. Check the link, or ask your admin to invite you again.';

export type InviteUserResult =
  | { error: null; inviteCode: string; expiresAt: string }
  | { error: string; inviteCode?: undefined; expiresAt?: undefined };

export async function inviteUser(opts: InviteUserOptions): Promise<InviteUserResult>;
export async function registerInvitedUser(email: string, password: string, inviteCode: string): Promise<AuthResult>;
```

**`inviteUser`:**
1. Keep the admin-without-brand early return. Keep the spec 090 store-derived brand (the `stores` read).
2. **Remove** the expired-row `delete`, the `existing` check (B8) and the direct `invitations.insert`.
3. Call `supabase.rpc('create_invitation', { p_email: opts.email.trim().toLowerCase(), p_name: opts.name, p_role: opts.role, p_store_ids: opts.storeIds, p_brand_id: resolvedBrandId, p_username: opts.username ? opts.username.trim().toLowerCase() : null })`.
4. An RPC error → `{ error: error.message }`, with no email call.
5. Mapping: `inviteCode = data.code`, `expiresAt = data.expires_at` (snake to camel). If `!isInviteCode(inviteCode)`
   → `{ error: 'Unexpected response from server' }`.
6. Fire-and-forget `callEdgeFunction('send-invite-email', { email, name, role, storeNames, inviteCode })`.
7. Return `{ error: null, inviteCode, expiresAt }`.

**`registerInvitedUser`** (B10). The third argument changes from the unused `name` to `inviteCode`:
1. `const code = normalizeInviteCode(inviteCode)`. If `!isInviteCode(code)`, return `INVITE_CODE_REQUIRED_ERROR`
   with no network call.
2. Call `supabase.rpc('check_invitation_code', { p_email: email.trim().toLowerCase(), p_code: code })`. An error or
   zero rows → `NO_PENDING_INVITATION_ERROR`, and `signUp` is **not** called.
3. Call `supabase.auth.signUp({ email, password, options: { data: { name: row.name ?? '' } } })`. Still no `role`.
4. Call `supabase.rpc('register_invited_profile', { p_code: code })` exactly once. On error, return
   `` `Account created but profile setup failed: ${regError.message}` `` (the existing pattern).
5. Welcome email: unchanged, using `row.name`.
6. No `from(...)` writes. `get_pending_invitation` is never called.

**`resendInvite`:** unchanged (no callers; spec Out of scope).

### 6. Screens (frontend)

| File | Change |
|---|---|
| **new** `src/components/cmd/InviteLinkPanel.tsx` | Props `{ email: string; code: string; link: string \| null; onDone: () => void }`. See the details below the table. |
| `src/components/cmd/InviteUserDrawer.tsx` | See the details below the table. |
| `src/components/cmd/InviteAdminDrawer.tsx` (AD-10) | The same "issued" behaviour and `InviteLinkPanel` reuse as `InviteUserDrawer`. |
| `src/screens/RegisterScreen.tsx` | See the details below the table. |
| `src/screens/LoginScreen.tsx` (AD-6) | In the `register=true` effect, read `params.get('invite')`, then `nav.navigate('Register', invite ? { invite } : undefined)`. Keep the existing `replaceState`. |
| `src/screens/cmd/sections/UsersSection.tsx`, `BrandsSection.tsx` | No change. The drawer props contract (`onClose` / `onInvited`) is the same. |
| `src/screens/staff/**` | No change. |

**`InviteLinkPanel`:**
- **Link text:** `testID="invite-link"`, a `<Text selectable>` showing `link ?? code`.
- **Copy:**
  - "Send this link to {email}. It works once and expires in 48 hours."
  - "This link is shown only now. If it is lost, invite the same email again: that makes a new link and the old one
    stops working."
  - When `link` is null (native with no `EXPO_PUBLIC_WEB_RECOVERY_URL`): label it "Invite code", with "Ask them to
    open Register in the app and enter this code."
- **Copy button:** web only, `testID="invite-link-copy"`. It calls `navigator.clipboard?.writeText(link ?? code)`:
  success toast "Link copied", failure or missing API toast "Copy failed. Select the link and copy it."
- **DONE button:** `testID="invite-done"` calls `onDone`.
- No new dependency.

**`InviteUserDrawer`:**
- New local state `issued: { email; code; link } | null`. Set `link = buildInviteLink(base, code)` with
  `base = inviteLinkBase(Platform.OS, typeof window !== 'undefined' ? window.location?.origin : null, process.env.EXPO_PUBLIC_WEB_RECOVERY_URL)`;
  when `base` is null, `link` is null.
- **On success:**
  - success toast: text1 "Invitation created", text2 the email
  - `onInvited?.()`
  - set `issued`
  - do **not** call `onClose`
- **While `issued` is set:**
  - The body renders `InviteLinkPanel` instead of the form, and the footer shows only DONE.
  - `handleSave` returns early, so Cmd+Enter can't resubmit. Esc still closes.
  - `issued` resets in the existing `visible` effect.
- The username-collision toast mapping is unchanged.

**`RegisterScreen`:**
- `useRoute()`; initial `code` state `normalizeInviteCode(route.params?.invite)`.
- **New field** "Invite code": `testID="register-code"`, `autoCapitalize="none"`, `autoCorrect={false}`. A pasted full
  link is fine, because `normalizeInviteCode` extracts the code.
- **Validation order:** email → code (`!isInviteCode(normalizeInviteCode(code))` → `INVITE_CODE_REQUIRED_ERROR`, and
  `registerInvitedUser` is not called) → password rules → confirm.
- Call `registerInvitedUser(email.trim(), password, normalizeInviteCode(code))`.
- **New testIDs** for e2e: `register-email`, `register-submit`, `register-error` (the error text), `register-success`
  (the success title), `register-go-signin`.
- Update the `formSub` copy to mention the invite code.

**Frontend store impact:** none. No `useStore.ts` slice changes. The drawers call `auth.ts` directly (as today) and
keep their non-optimistic await-then-toast pattern, so optimistic-then-revert with `notifyBackendError` does not
apply.

**Realtime impact:** none. `invitations` is not in `supabase_realtime` and not replayed on `store-{id}` or
`brand-{id}`.

### 7. Ordering and dependencies

- **Prod apply order:**
  - 191 (`20261109191000`) must be on prod first. The prerequisite DO block makes an out-of-order apply abort cleanly.
  - 195 (`20261109195000`) is preferred, not required: the tables and functions don't overlap. The claim writes
    `user_stores` as postgres, so it isn't affected by 195.
  - 197 (`20261109230000`) only touches table grants. Apply it one at a time, as the spec says.
- **The `db-migrations-applied` gate:** before pushing, **every** repo migration with a lower version must already be
  on prod, in version order. That includes any of 187/191/195/197 still pending. Otherwise the gate goes red.
- **If 191's migration body changes before it ships:** re-copy SCOPE from its final INSERT policy (spec Dependencies).

### 8. Tests

#### 8.1 New `supabase/tests/invitations_hardening.test.sql`

Hermetic `begin; ... rollback;`. **No `set role anon`**: it segfaults the CI image (spec 067). anon is covered by
catalog checks only. The developer computes the plan count.

**Fixtures:**
- **Users** (seed): admin `1111` (brand A), manager `2222` (role user), master `3333` (brand A).
- **Synthetic, inserted as postgres:**
  - brand B; store A1 and store A2 (brand A, non-blank address); store B1 (brand B)
  - super_admin SA (brand NULL)
  - a second brand-A admin `A2ADM`
  - a disposable brand-A admin `DEMOTEE` (for D3)
  - orphan registrants (auth users with no profile; token columns `''`, per memory)
- **Invitation fixtures with a known code:** compute the hash in the test as
  `encode(sha256(convert_to('<32hex>','UTF8')),'hex')`. Each refusal fixture differs from a claimable baseline in
  **exactly one** attribute, so each mutation turns exactly its own arm red.

**Arms.** Every arm has a mutation that must turn it red. The developer runs each mutation once and records the
result in the review.

| Arm | AC | Assertion | Mutation that must turn it red |
|---|---|---|---|
| K-a | A1/A8 | 1 permissive policy each for SELECT/INSERT/UPDATE/DELETE (incl. ALL); all `{authenticated}`; none name anon or public | recreate SELECT without `to authenticated` |
| K-b | A1/A8 | the 2.4 text checks hold on all four | swap SELECT back to `auth_is_privileged()` |
| K-c | B1 | columns `invited_by uuid` and `code_hash text`; partial unique index `invitations_code_hash_key`; check `invitations_code_hash_format` | drop the index |
| K-d | D1/D2 | trigger `invitations_provenance_guard` is BEFORE INSERT OR UPDATE, ROW, enabled; function is INVOKER and pins search_path | make the function DEFINER |
| K-e | B4/B6 | `register_invited_profile()` and `get_pending_invitation(text)` absent; `register_invited_profile(text)` DEFINER, owner postgres, `search_path=public`; `create_invitation` INVOKER; `check_invitation_code` DEFINER | restore the zero-argument function |
| K-f | B4 | the set of `public` SECURITY DEFINER functions whose `prosrc ~* 'insert\s+into\s+(public\.)?profiles\y'` is exactly `{register_invited_profile(text)}`; also pin the full Q-4 writer list (insert/update/delete) found locally | add a DEFINER function that inserts into profiles |
| K-g | B6/E | EXECUTE matrix (below) | grant `check_invitation_code` to nobody (or regrant `consume_invitation` to authenticated) |
| K-h | D3 | `pg_get_functiondef('public.register_invited_profile(text)'::regprocedure) ~* 'for share'` | remove `for share` |
| A2 | A2 | as `1111`: SELECT of fixtures (i)/(ii)/(iii) = 0; DELETE of them `returning` = 0; as postgres afterwards, all 3 still exist | drop SCOPE's store arm from SELECT |
| A3 | A3 | as `2222` with JWT `app_metadata.role = 'admin'`: SELECT 0 of all; DELETE 0 | revert to `auth_is_privileged()` |
| A4 | A4 | SA: SELECT returns every fixture row; DELETE of a brand-B row = 1 | remove `auth_can_see_brand` from the D7 arm list |
| A5 | A5 | `1111` SELECTs and DELETEs (=1) brand-A rows: brand A, and brand NULL with only brand-A stores | invert SCOPE's brand test |
| A6 | A6 | a brand-less, store-less row inserted **directly as `1111`** (with a `code_hash`; `create_invitation` would stamp the brand, AD-4): `1111` sees it, SA sees it, `A2ADM` sees 0 and deletes 0; a legacy row (postgres, `invited_by` NULL) is seen by SA only | drop `invited_by = auth.uid()` from D7, or drop D7 |
| A7 | A7 | `relrowsecurity` on; no policy roles include anon or public (catalog) | add a `to anon` SELECT policy |
| B1 | B1 | `create_invitation` as `1111` returns `code` matching `^[0-9a-f]{32}$`; as postgres, `code_hash` = sha256(code), `invited_by = 1111`, `expires_at = now() + 48h` (exact: `now()` is constant inside the txn); `not exists (select 1 from jsonb_each_text(to_jsonb(i)) where value ilike '%' \|\| code \|\| '%')` | store the plaintext |
| B2-staff | B2 | registrant (auth email in **upper case**) claims a staff invite (brand NULL, store A1) → profile (user, brand A, name, username, `#378ADD`, initials), `user_stores = {A1}`, `used`, `profile_id`, `app_metadata.role = 'user'` | resolve the brand with `::uuid` and a malformed fixture, or drop the store resolution |
| B2-admin | B2 | master `3333` creates an admin invite (brand A); claim → admin, brand A, `app_metadata.role = 'admin'` | drop the brand passthrough |
| B2-zero | B2/AD-4 | (a) SA's zero-store invite → profile brand NULL; (b) `1111`'s zero-store invite → stored `brand_id = A` and the claim succeeds | remove the AD-4 stamp (b turns red) |
| B3-1..9 | B3 | each refuses `P0001 'no pending invitation'`: NULL code; `''`; a wrong valid-format code; another invitation's code; right code + different auth email; used; expired; NULL `expires_at`; legacy row with no `code_hash` | remove the specific predicate |
| B3-side | B3 | none of the B3 registrants has a profile, a `user_stores` row or an app_metadata role; their invitations are unchanged (`used = false`, sentinel `profile_id`) | drop the `raise`, so it falls through |
| B5 | B5 | the same email is pending in brand A (`1111`) and brand B (SA); the registrant uses the **brand-B** code → profile brand B; the brand-A row is still `used = false` | select by email |
| B6-agree | B6 | for every B2/B3/D3 fixture, `count(*) from check_invitation_code(email, code)` is 1 where the claim succeeds and 0 where it refuses | drop the inviter `exists` from CP |
| B8-srv | B8 | `create_invitation` twice for one email as `1111` → exactly one pending row; the first code fails the claim and the pre-check; the second passes | remove the step-8 delete |
| B8-scope | B8/B5 | `1111` re-inviting an email that also has a brand-B pending row leaves the brand-B row in place | do the delete as DEFINER |
| CI-1..3 | (create) | `create_invitation` as `2222` → `42501 'forbidden'`; with a stale claim → 42501; with a brand-B store as `1111` → 42501 (RLS) | make `create_invitation` DEFINER |
| C1 | C1 | direct INSERT as `1111` (with `code_hash`): `expires_at` NULL → 42501; `now()+8d` → 42501; omitted → admitted with `now()+48h`; `now()+6d` → admitted | remove EXPIRY from INSERT |
| C2 | C2 | UPDATE as `1111`: NULL → 42501; `+8d` → 42501; `+6d` → 1 row; `2222` with a stale claim → 0 rows | remove EXPIRY from UPDATE |
| C3 | C3 | before any fixture: 0 pending rows breaking the bound; then postgres seeds NULL / `2099-01-01` / in-bound rows, runs an **inline byte-identical copy** of the migration's clamp UPDATE (the `consume_invitation` arm C pattern), and asserts the first two are now `now()+48h` and the third is untouched | change 7 days to 8 in the clamp copy and the migration |
| D1 | D1 | INSERT as `1111` with `invited_by = SA` → lives, stored `invited_by = 1111` | remove the trigger's INSERT branch (the policy then refuses, so `lives_ok` goes red) |
| D2 | D2 | UPDATE as `1111` setting `invited_by = SA` and a new `code_hash` → 1 row, both columns unchanged | remove the trigger's UPDATE branch |
| D3-a | D3 | `invited_by` = a uuid with no profile → refuse | drop the not-found check |
| D3-b | D3 | **191-M1 replay:** `DEMOTEE` creates an admin invite (brand A); SA calls `demote_profile_to_user(DEMOTEE)` as authenticated; the claim with the right code → refuse; the pre-check → 0 rows | check the inviter via the JWT |
| D3-c | D3 | postgres seeds `invited_by = 1111` with resolved brand B → refuse; same for a master inviter | drop the brand comparison |
| D4 | D4 | B2-staff passes with inviter `1111` (a profile admin) while the **registrant's** JWT has no role | replace R7 with `auth_is_privileged()` |
| E1 | E1 | `assert_not_last_of_role(uuid,text)`: anon false; no PUBLIC entry (`not exists (select 1 from aclexplode(proacl) a where a.grantee = 0)`); authenticated and service_role true | regrant to anon |
| E2 | E2 | `consume_invitation(uuid,text)`: anon false, authenticated false, no PUBLIC entry, service_role true | regrant to authenticated |

**K-g matrix** (`has_function_privilege`, EXECUTE):

| Function | anon | authenticated | service_role | PUBLIC entry |
|---|---|---|---|---|
| `create_invitation(text,text,text,text[],uuid,text)` | f | t | t | none |
| `check_invitation_code(text,text)` | t | t | t | none |
| `register_invited_profile(text)` | f | t | t | none |

#### 8.2 Existing pgTAP files to update

These satisfy F3, plus the AD-11 additions.

1. **`profiles_insert_hardening.test.sql`**
   - K-6..K-11: retarget to `register_invited_profile(text)` (`has_function(..., array['text'])` and
     `'public.register_invited_profile(text)'`).
   - K-13: rewrite to "SELECT and DELETE are `{authenticated}`; qual uses `auth_profile_is_privileged()`, not
     `auth_is_privileged()`, and contains `invited_by = auth.uid()`". Add a comment naming spec 198.
   - K-14..K-18: no change.
   - Section C:
     - Every seeded invitation gets a per-arm `code_hash`, `invited_by = 1111`, and `expires_at = now() + 1 day`
       (C-11 stays expired).
     - **C-7** (brand NULL, no stores) must use `invited_by = SA`, or D3 refuses it.
     - Calls become `register_invited_profile('<code>')`.
     - C-9 becomes "the right code of someone-else's invitation, with a mismatched email".
     - **C-15 is retired**, with a comment pointing to `invitations_hardening` B5.
     - C-12/13/14/17 keep their strings. Update C-18's lists.
   - Sections D/E: add a **distinct** `code_hash` to every INSERT (the unique index), e.g.
     `encode(sha256(convert_to('d1','UTF8')),'hex')`, so each refusal still tests its own predicate.
   - Update the arm-map header and `plan(...)`.
2. **`invitations_super_admin_rls.test.sql`:** arms (i)-(iii) add a distinct `code_hash`. The count reads in (i) and
   (ii) still pass: D7 admits the inviter, and SA.
3. **`profiles_username.test.sql` arm 16:** retire it, with a comment that the function is dropped (spec 198) and
   `invitations_hardening` B2-staff asserts `profiles.username`. Adjust the plan.
4. **`staff_brand_id_backfill.test.sql` arms 8, 9, 13:** retire them, with a comment pointing to `invitations_hardening`
   B2-staff, B2-admin and B2-zero(a). Their fixture inserts may stay. Adjust the plan.
5. **`consume_invitation_sets_profile_id.test.sql`:**
   - Arms A/B run as postgres with `request.jwt.claims` set (remove `set local role authenticated`; `auth.uid()`
     reads the claims GUC).
   - Arm E flips to "anon false and authenticated false, service_role true".
6. **No change:** `permissive_policy_lint`, `retention_prune_job` (C4), `demote_profile_brand_scope`,
   `delete_last_privileged_guard`. Run them all.

#### 8.3 jest

- **new `src/lib/inviteLink.test.ts`:**
  - `normalizeInviteCode`: trim, upper→lower, a full link, a link with extra params, junk → `''`
  - `isInviteCode`
  - `buildInviteLink`: trailing slash
  - `inviteLinkBase`: web; native with config; native with config and a path; native unset → null
- **new `src/lib/sendInviteEmail.source.test.ts`.** Like the `authEmailHook.verify.test.ts` source probe, it reads
  `supabase/functions/send-invite-email/index.ts` and asserts:
  - the href interpolation is `escapeHtml(inviteUrl)`
  - `inviteUrl` is built with `register=true&invite=`
  - the source contains the literal `^[0-9a-f]{32}$`, the same as `INVITE_CODE_RE` (parity)
  - the fallback `redirectTo` doesn't use `inviteUrl`
- **rewrite `src/lib/inviteUser.test.ts`:**
  - exactly one `rpc('create_invitation', <exact args>)`
  - **zero** `from('invitations')` calls (`from('stores')` is allowed)
  - the `send-invite-email` payload carries `inviteCode`
  - returns `{ error: null, inviteCode, expiresAt }`
  - an RPC error → `{ error }` and no edge call
  - a malformed `data.code` → error
  - admin without a brand → no RPC
  - the spec 090 derivation is retained
- **rewrite `src/lib/registerInvitedUser.test.ts`** (B10):
  - an invalid code → no RPC and no `signUp`
  - pre-check arguments are normalized
  - empty rows or an error → `NO_PENDING_INVITATION_ERROR` and no `signUp`
  - the success order is `check_invitation_code` → `signUp` (no `role`, name from the pre-check) →
    `register_invited_profile({ p_code })` exactly once
  - never calls `get_pending_invitation`; no `from()` writes
  - a claim error → the "Account created but profile setup failed: ..." string
- **update `src/components/cmd/InviteUserDrawer.test.tsx`** (B7/B8):
  - success shows `invite-link` with `?register=true&invite=<code>`, and the drawer stays open
  - `invite-done` calls `onClose` once
  - the web `invite-link-copy` calls `navigator.clipboard.writeText(link)`
  - with `Platform.OS` mocked to `ios`: no copy button, and the text is the code when no web URL is configured
  - a second invite shows the new code
  - the old "already exists" case goes. It no longer exists client-side; the `invitations_email_key` fixture string
    can go with it.
- **new `src/components/cmd/InviteAdminDrawer.test.tsx`** (AD-10): the link panel appears after success.
- **update `src/screens/RegisterScreen.test.tsx`** (B9):
  - extend the `@react-navigation/native` mock with `useRoute`
  - `register-code` prefilled from `route.params.invite`
  - an empty or invalid code → `INVITE_CODE_REQUIRED_ERROR` and `registerInvitedUser` not called
  - a valid code → called with `(email, password, normalizedCode)`
- **new `src/screens/LoginScreen.registerHandoff.test.tsx`:** with `?register=true&invite=X` on web,
  `navigate('Register', { invite: 'X' })` is called and `replaceState` is called.
- **`auth.fetchAllUsers.test.ts` and `db.fetchBrandAdmins.test.ts` (F4):**
  - These mock supabase, so RLS narrowing doesn't reach them. Expect no edits.
  - grep both files for fixtures that claim cross-brand invitation rows. Comment any you keep with "spec 198".
- **Gate:** run full `npx jest` and `npm run typecheck:test` (project memory).

#### 8.4 e2e

**F1, `e2e/invite.spec.ts` (updated):**
1. Wait on `page.waitForResponse('**/functions/v1/send-invite-email')` around the submit and assert 200. The local
   fallback returns `{ success: true, method: 'supabase-auth' }`. This proves the new function accepts the
   `inviteCode` payload.
2. Assert `invite-link` is visible and matches `/\?register=true&invite=[0-9a-f]{32}$/`.
3. Click `invite-done`, then assert the drawer has closed and `users-root` is visible.
4. **Replace** the `getByText(email)` assertion with a service-role read: one `invitations` row for the email with
   `used = false`, `code_hash` not null and `invited_by` = the master's id. The old assertion actually matched the
   success toast, not a Users row.

**F2, new `e2e/invite-claim.spec.ts`:**
- **Fallback handling:** in the master context, before submitting, call
  `page.route('**/functions/v1/send-invite-email', r => r.fulfill({ status: 200, contentType: 'application/json', body: '{"success":true,"method":"e2e-stub"}' }))`
  and capture the request body. Assert it has `inviteCode` equal to the link's code.
  - **Why:** the stub stops the local `inviteUserByEmail` fallback from creating the invitee's `auth.users` row early.
    F1 still exercises the real function.
- **Guard:** using `serviceRoleClient().auth.admin.listUsers({ perPage: 1000 })`, assert that no auth user exists yet
  for the run-unique email. The test fails fast with a clear message if the stub ever stops working.
- **Happy path:**
  1. Master invites `e2e-claim+<runId>@local.test` as staff with one brand store (`invite-store-<id>`) and reads
     `invite-link`.
  2. `browser.newContext({ storageState: { cookies: [], origins: [] } })` opens the link.
  3. Assert that `register-code` has the code (this proves AD-6).
  4. Fill `register-email`, `register-password` and `register-confirm`, then click `register-submit`.
  5. Assert `register-success`. Then `register-go-signin` → log in (the testIDs from `auth.spec.ts`) → the staff
     surface with the invited store visible (reuse the `staff-reorder.spec.ts` landing assertions).
- **Negative arm:**
  1. A second run-unique invitation; flip the link's last hex character, so it is still valid format.
  2. Register with the right email → `register-error` shows `NO_PENDING_INVITATION_ERROR`.
  3. Service role: **no auth user and no profile** for that email. The pre-check blocked `signUp`, so no orphan
     exists.
- **Cleanup:** best-effort `auth.admin.deleteUser` for the created user in `afterAll`. CI resets the DB anyway.
- **Verify first (V-5):** after `signUp` the client holds a session (autoconfirm). Confirm that RegisterScreen's
  success state still renders and RoleRouter doesn't route away first. If it does, assert the staff surface directly
  and record that in the review.

#### 8.5 Smokes

- **`scripts/smoke-edge-roles.sh`:** existing arms unchanged; `{}` still returns 400 from the email/name check.
  Add one admin arm: `{"email":"x@example.invalid","name":"x"}` → 400 `inviteCode required`. No mail is sent.
- **`scripts/smoke-delete-user.sh`:** re-run unchanged (D-5).
- **Review additions (2026-11-10):**
  - `smoke-edge-roles.sh` Arm 5 sends a valid-format `inviteCode`, so it reaches the post-validation path (and the
    local `inviteUserByEmail` fallback, which its existing cleanup covers) instead of passing vacuously on the new 400.
  - `scripts/smoke-rpc.sh` section 2: anon `GET` and (local stack only) `DELETE` on `/invitations` → `[]`,
    `check_invitation_code` with a wrong code → `[]`, `get_pending_invitation` → 404 PGRST202, `register_invited_profile`
    and `create_invitation` → 401/403 42501. This is the behavioural half of A7/B6, which pgTAP can only check in the
    catalog (spec 067).

### 9. Queries to run locally before building (developer)

Run against the local DB after `npm run dev:db`. Q-1/Q-2/Q-4/Q-6/Q-7 are re-run on prod in section 10.

- **Q-1 pgcrypto and privileges:**
  ```
  select e.extname, n.nspname
    from pg_extension e
    join pg_namespace n on n.oid = e.extnamespace
   where e.extname = 'pgcrypto';

  select has_schema_privilege('authenticated', 'extensions', 'USAGE'),
         has_function_privilege('authenticated', 'extensions.gen_random_bytes(integer)', 'EXECUTE');
  ```
  Expect `extensions`, t, t. **If either is false, stop and return to the architect.** Do not grant on `extensions`
  ad hoc.
- **Q-2 core sha256:**
  `select encode(sha256(convert_to('x','UTF8')),'hex');` returns 64 hex characters.
- **Q-3 191 present:**
  `select to_regprocedure('public.auth_profile_is_privileged()');` is not null.
- **Q-4 the profiles writer list (pin it in K-f):**
  ```
  select p.oid::regprocedure, p.prosecdef
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.prosrc ~* '(insert\s+into|update|delete\s+from)\s+(public\.)?profiles\y'
   order by 1::text;
  ```
- **Q-5 existing triggers on `invitations`:** expect none.
  `select tgname, tgfoid::regprocedure from pg_trigger where tgrelid = 'public.invitations'::regclass and not tgisinternal;`
- **Q-6 FKs referencing `invitations`:** expect none. Otherwise the delete-then-insert re-invite needs a rethink.
  `select conname, conrelid::regclass from pg_constraint where confrelid = 'public.invitations'::regclass;`
- **Q-7 table grants the INVOKER RPC needs:** expect SELECT, INSERT, UPDATE and DELETE for authenticated.
  ```
  select grantee, privilege_type
    from information_schema.role_table_grants
   where table_schema = 'public' and table_name = 'invitations'
     and grantee in ('anon', 'authenticated');
  ```
- **Q-8 own-row profile read (AD-4 step 5):** at least one permissive arm admits `id = auth.uid()`. If none does,
  AD-4's stamp reads NULL and B2-zero(b) goes red; stop and report.
  `select policyname, qual from pg_policies where schemaname = 'public' and tablename = 'profiles' and cmd in ('SELECT','ALL');`
- **Q-9 GoTrue behaviour, recorded for Risks:** invite a throwaway email through the local fallback, then call
  `signUp` for it, and record the result in the review. This is informational; F2 doesn't depend on it.

### 10. Prod apply, verification and rollback

These go into the migration header and the review. Project `ebwnovzzkwhsdxkpyjka`. Owner go-ahead is required.

**Before the apply (read-only, MCP `execute_sql`):**
- the spec's P-1, P-2, P-3, P-8, P-9 and P-12 (P-12 **must** show `20261109191000`)
- Q-1, Q-2, Q-4, Q-6 and Q-7 from section 9 (Q-4's prod list must equal the local list)
- the owner dashboard checks (spec "Prod facts")
- **Save the rollback inputs:**
  - `pg_get_functiondef` of `get_pending_invitation(text)` and `register_invited_profile()`
  - P-8 policy text
  - P-9 `proacl`
- **Ask admins to hold invites** until step 7.

**Apply:**
1. **Migration.** `execute_sql` with the exact migration body. Immediately before its final `commit;`, add:
   `insert into supabase_migrations.schema_migrations (version, name) values ('20261110120000', 'invitations_hardening');`
   - Do **not** use MCP `apply_migration`, which writes its own version.
   - A `'198:'` raise rolls back everything, including the version row.
2. **Schema reload:** `notify pgrst, 'reload schema';`
3. **Verify the functions:**
   ```
   select p.oid::regprocedure as fn,
          md5(regexp_replace(p.prosrc, '\s+', ' ', 'g')) as body_md5,
          p.prosecdef, p.proconfig, pg_get_userbyid(p.proowner) as owner, p.proacl
     from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('create_invitation', 'check_invitation_code', 'register_invited_profile',
                        'assert_invitation_provenance', 'get_pending_invitation',
                        'consume_invitation', 'assert_not_last_of_role')
    order by 1::text;
   ```
   - `body_md5`, `prosecdef`, `proconfig` and `owner` must equal local for the four new or replaced functions.
   - There must be no `get_pending_invitation` row and no zero-argument `register_invited_profile` row.
   - `consume_invitation` and `assert_not_last_of_role` bodies are unchanged versus the pre-apply output.
4. **Verify the policies:**
   `select policyname, cmd, permissive, roles, md5(qual), md5(with_check) from pg_policies where schemaname = 'public' and tablename = 'invitations' order by cmd;`
   Expect 4 rows, all `{authenticated}`, with the md5s equal to local.
5. **Verify the privileges** (the K-g matrix plus E1/E2):
   ```
   select r.rolname, f.sig, has_function_privilege(r.rolname, f.sig, 'EXECUTE')
     from (values ('anon'), ('authenticated'), ('service_role')) r(rolname)
    cross join (values ('public.create_invitation(text,text,text,text[],uuid,text)'),
                       ('public.check_invitation_code(text,text)'),
                       ('public.register_invited_profile(text)'),
                       ('public.assert_not_last_of_role(uuid,text)'),
                       ('public.consume_invitation(uuid,text)'),
                       ('public.assert_invitation_provenance()')) f(sig);
   ```
   (Added 2026-11-10, fix-pass architect SF-2: `assert_invitation_provenance()` must be anon f, authenticated f, service_role t.)
   Then confirm with `aclexplode(proacl)` that there is no PUBLIC (grantee 0) entry on any of them.
   `assert_not_last_of_role`'s ACL must equal its pre-apply value (D-5 is a no-op on prod).
6. **Verify the schema objects:**
   - the `invited_by` and `code_hash` columns (`information_schema.columns`)
   - `invitations_code_hash_key` (`pg_indexes`)
   - `invitations_code_hash_format` (`pg_constraint`)
   - the `invitations_provenance_guard` trigger enabled (`pg_trigger`)
   - P-2 and P-3 show 0 pending rows outside the bound
7. **Deploy the edge function:**
   - Use the MCP `deploy_edge_function` (`send-invite-email`, `verify_jwt: true`, file `index.ts`), or from the repo
     root `npx supabase@2.108.0 functions deploy send-invite-email --project-ref ebwnovzzkwhsdxkpyjka` (the pinned
     CLI, per memory).
   - **Verify:** POST `{"email":"x@example.invalid","name":"x"}` with an admin bearer → 400 `{"error":"inviteCode required"}`
     (no mail is sent). Without a bearer → 401.
8. **Push:** `git push`, which triggers the Vercel deploy. Then confirm the latest runs of `test.yml`,
   `db-migrations-applied.yml` and `e2e.yml` on `main` are green (CLAUDE.md and memory).
9. **Optional owner check:** one real invite to an address the owner controls, register, then delete via Users.

**Rollback** (`specs/198-invitations-hardening/rollback.sql`): forward-only in spirit, emergency use only.
- **Dry-run first:** run it locally with its final `commit;` swapped for `rollback;`, and record the result.
- **It reopens** 195-H1, 164-M1, 191-M1 and the spec 198 review H1 (191's UPDATE policy, restored verbatim, lets any
  in-scope admin revive a consumed invitation).
- **Contents**, in one transaction with `set local lock_timeout = '5s'`:
  1. Drop `create_invitation`, `check_invitation_code` and `register_invited_profile(text)`.
  2. Recreate `register_invited_profile()` verbatim from `20261007000000:133-262`, including its revoke/grant.
  3. Recreate `get_pending_invitation(text)` verbatim from `20260607120000:111-160`, with `grant ... to anon, authenticated`.
  4. Drop the trigger and `assert_invitation_provenance()`.
  5. Recreate INSERT/UPDATE verbatim from 191 (with 191's comments), and SELECT/DELETE verbatim from
     `20260514150000:33-35, 46-48`.
  6. `grant execute on function public.consume_invitation(uuid, text) to authenticated;`
  7. **Keep** the anon revoke on `assert_not_last_of_role`, matching prod's prior state.
  8. **Keep** the `invited_by`/`code_hash` columns, the index and the constraint. They're inert, and dropping them
     loses provenance.
  9. A DO block asserting 1/1/1/1 permissive policies.
- Leave the `schema_migrations` row in place. Revert the frontend and `send-invite-email` in the same window: the old
  client must come back, or invites will fail on the dropped RPC.

### 11. Rollout: old bundles and native

- **Web, old cached bundle:**
  - There is no caching service worker (`public/sw.js` never calls `respondWith`), and Vercel serves a fresh
    `index.html`. An old bundle survives only in a tab, or an installed PWA window, opened before the deploy and not
    reloaded since.
  - **Register:** the old `registerInvitedUser` calls the dropped `get_pending_invitation`, gets PGRST202 (404), and
    shows "No invitation found for this email. Please ask an admin to invite you." This happens **before** `signUp`,
    so no orphan auth user is created. Fix: reload the page.
  - **Invite** (old admin tab): the direct insert has no `code_hash`, so it gets 42501 and the drawer toasts "Invite
    failed: new row violates row-level security policy for table "invitations"". This is loud, not silent. Fix:
    reload.
  - Put both strings in the release note to admins.
- **Window between the DB apply and the Vercel deploy:** both failures above apply to everyone, so keep steps 1-8
  back to back, with invites on hold.
- **Native:** not shipped. Per project memory (spec 181), there's an internal build only and no distributed user
  base. Any build compiled before this change behaves like an old web bundle (the same two loud failures). The next
  native build picks up the new code.
  - On native, the drawer shows a full link only when `EXPO_PUBLIC_WEB_RECOVERY_URL` is set; otherwise it shows the
    bare code.
  - There's no native URL prefill. The invitee pastes the link or the code into `register-code`.

### 12. Risks and tradeoffs

- **Residual email-squatting DoS (not closed by this spec).** Sign-up is open, so someone who knows the invitee's
  email can `signUp` with it first. They can't claim without the code, but the real invitee then gets "User already
  registered".
  - **Detection:** P-10, accounts without a profile.
  - **Recovery:** the super_admin deletes the stray auth user (dashboard), or re-invites with a different email.
  - The real fix is the spec's "disable open sign-up + server-side claim" follow-up.
- **Orphan auth user on a race.** If the pre-check passes but the claim then fails (the code expired, or the inviter
  was demoted in between), `signUp` has already run. This is pre-existing behaviour, narrowed by the pre-check, and
  the error string says so.
- **Local `inviteUserByEmail` fallback.** F2 stubs it (8.4), and Q-9 records the real behaviour.
  - **Prod:** whether prod uses Resend or the fallback depends on the `RESEND_API_KEY` dashboard check. If prod had no
    key, every invite would pre-create the invitee's auth user and break their `signUp`. That would be a pre-existing
    issue, made visible by the e2e rather than introduced here.
- **AD-4 behaviour change** (zero-store staff invitee gets the admin's brand). Owner to confirm (section 0).
- **Two copies of the claim predicate** (CP and R3-R7). Mitigated by the B6-agree matrix with mutations.
- **Lock timeout.** The migration takes AccessExclusive on `invitations` only. That table is tiny and off the hot
  path, and `lock_timeout` of 5s fails fast; retry if it trips.
- **Performance:** none of concern. Prod has 4 rows, and the 286 KB seed has no invitations. Policy helpers run per
  row on a tiny table, and the code lookup is a unique-index probe.
- **Cold start:** `send-invite-email` grows by a few lines; nothing material.
- **RLS gap check:**
  - anon has no policy.
  - `check_invitation_code` is the only anon-executable function touching invitations, and it returns a name only
    for a caller who already holds the code and the matching email.
  - `create_invitation` can't widen anything, because it is INVOKER.
- **Spec 191 not yet committed.** If its migration body changes, re-copy SCOPE (section 7).

### 13. Files expected to change

- **Backend (backend-developer):**
  - `supabase/migrations/20261110120000_invitations_hardening.sql` (new)
  - `specs/198-invitations-hardening/rollback.sql` (new)
  - `supabase/functions/send-invite-email/index.ts`
  - `supabase/tests/invitations_hardening.test.sql` (new)
  - `supabase/tests/profiles_insert_hardening.test.sql`
  - `supabase/tests/invitations_super_admin_rls.test.sql`
  - `supabase/tests/profiles_username.test.sql`
  - `supabase/tests/staff_brand_id_backfill.test.sql`
  - `supabase/tests/consume_invitation_sets_profile_id.test.sql`
  - `scripts/smoke-edge-roles.sh`
  - `src/lib/sendInviteEmail.source.test.ts` (new)
- **Frontend (frontend-developer):**
  - `src/lib/inviteLink.ts` (new) and `src/lib/inviteLink.test.ts` (new)
  - `src/lib/auth.ts`, `src/lib/inviteUser.test.ts`, `src/lib/registerInvitedUser.test.ts`
  - `src/components/cmd/InviteLinkPanel.tsx` (new)
  - `src/components/cmd/InviteUserDrawer.tsx` and `InviteUserDrawer.test.tsx`
  - `src/components/cmd/InviteAdminDrawer.tsx` and `InviteAdminDrawer.test.tsx` (new)
  - `src/screens/RegisterScreen.tsx` and `RegisterScreen.test.tsx`
  - `src/screens/LoginScreen.tsx` and `LoginScreen.registerHandoff.test.tsx` (new)
  - `e2e/invite.spec.ts`, `e2e/invite-claim.spec.ts` (new)
- **Shared contract between the two developers:**
  - RPC names and argument names: `create_invitation`, `check_invitation_code`, `register_invited_profile(p_code)`
  - the jsonb keys `invitation_id`, `code`, `expires_at`
  - the `inviteCode` payload key
  - the `^[0-9a-f]{32}$` code format
  - the `invite` URL param
  - the testIDs listed in section 6
  - Either developer can start in parallel against this section. The frontend's jest suite mocks the RPCs, and e2e
    needs both halves.

## Handoff
next_agent: backend-developer, frontend-developer
prompt: Implement against the "## Backend design" section of this spec. backend-developer owns section 1-4, 8.1, 8.2,
  8.5, 9-10 and the backend files in section 13 (run the section 9 queries first and stop on Q-1/Q-8 failures);
  frontend-developer owns sections 5-6, 8.3 (except sendInviteEmail.source.test.ts), 8.4 and the frontend files in
  section 13. The shared contract is at the end of section 13. After implementation, set Status: READY_FOR_REVIEW and
  list files changed under ## Files changed.
payload_paths:
  - specs/198-invitations-hardening.md
  - specs/198-invitations-hardening/reviews/prod-prechecks.md

## Files changed

### Frontend (frontend-developer, 2026-11-10)

- `src/lib/inviteLink.ts` (new): `INVITE_URL_PARAM`, `INVITE_CODE_RE`, `normalizeInviteCode`, `isInviteCode`, `buildInviteLink`, `inviteLinkBase` (§5.1)
- `src/lib/inviteLink.test.ts` (new)
- `src/lib/auth.ts`: `inviteUser` calls `create_invitation` and returns `InviteUserResult`, sending `inviteCode` to `send-invite-email`. `registerInvitedUser(email, password, inviteCode)` runs `check_invitation_code`, then `signUp`, then `register_invited_profile({ p_code })`. Adds `INVITE_CODE_REQUIRED_ERROR` and `NO_PENDING_INVITATION_ERROR` (§5.2).
- `src/lib/inviteUser.test.ts` (rewritten)
- `src/lib/registerInvitedUser.test.ts` (rewritten)
- `src/components/cmd/InviteLinkPanel.tsx` (new): the shared link panel, plus `buildIssuedInviteLink` and the `IssuedInvite` type
- `src/components/cmd/InviteUserDrawer.tsx`: `issued` state; link panel on success; no re-submit while issued
- `src/components/cmd/InviteUserDrawer.test.tsx`: spec 198 block added; the `invitations_email_key` fixture string was renamed
- `src/components/cmd/InviteAdminDrawer.tsx` (AD-10): same behaviour as `InviteUserDrawer`
- `src/components/cmd/InviteAdminDrawer.test.tsx` (new)
- `src/screens/RegisterScreen.tsx`: `register-code` field prefilled from `route.params.invite`; validation order email → code → password → confirm; new testIDs
- `src/screens/RegisterScreen.test.tsx`
- `src/screens/LoginScreen.tsx` (AD-6): `navigate('Register', { invite })` before the existing `replaceState`
- `src/screens/LoginScreen.registerHandoff.test.tsx` (new)
- `src/lib/auth.fetchAllUsers.test.ts`, `src/lib/db.fetchBrandAdmins.test.ts` (F4): comments only, naming spec 198 on the kept NULL-brand invitation pins. No assertion changes.
- `e2e/invite.spec.ts` (F1, updated)
- `e2e/invite-claim.spec.ts` (F2, new)

**Implementation notes for reviewers:**
- **DONE button placement.** `InviteLinkPanel` owns the DONE button (`invite-done`), per its `onDone` prop. While the link is showing, the drawer hides its CANCEL/SEND footer instead of rendering a second DONE, which avoids a duplicate testID. The DONE button sits at the bottom of the panel body, not in the sticky footer.
- **Admin drawer reset.** In `InviteAdminDrawer`, `issued` resets in its own `[visible]` effect. The existing form-reset effect also re-runs whenever the `stores` array changes, and would wipe a link the admin hasn't copied yet. jest pins this.
- **Code-only copy.** When `link` is null (native with no web URL), the panel copy reads "code" instead of "link".
- **e2e not run** (per brief). `npx tsc -p e2e/tsconfig.json` is clean.

### Backend (backend-developer, 2026-11-10)

**Migrations**
- `supabase/migrations/20261110120000_invitations_hardening.sql` (new). The version was re-checked right before writing: the newest file on disk was `20261109230000`, so no bump was needed. Pure ASCII.
- `specs/198-invitations-hardening/rollback.sql` (new). Not a migration. Its bodies are verbatim slices of `20261007000000:133-262`, `20260607120000:111-160` and `20261109191000:504-560`.

**Edge functions**
- `supabase/functions/send-invite-email/index.ts`:
  - takes `inviteCode` and validates it against `^[0-9a-f]{32}$`, returning 400 `inviteCode required` after the existing email/name check
  - builds `inviteUrl` from the fixed `APP_URL`
  - uses `escapeHtml(inviteUrl)` in the button href and in a new plain-text fallback line
  - leaves the `inviteUserByEmail` fallback byte-for-byte unchanged (it still uses the legacy `registerUrl`)
  - no `config.toml` change

**pgTAP**
- `supabase/tests/invitations_hardening.test.sql` (new, `plan(88)`)
- `supabase/tests/profiles_insert_hardening.test.sql`: K-6..K-11 retargeted to `(text)`, K-13 rewritten, Section C codes and inviters, C-15 rewritten (see notes), Section D `code_hash`. `plan(80)` unchanged.
- `supabase/tests/invitations_super_admin_rls.test.sql`: arms (i)-(iii) each add a distinct `code_hash`. `plan(4)` unchanged.
- `supabase/tests/profiles_username.test.sql`: arm 16 retired. `plan(16)` → `plan(15)`.
- `supabase/tests/staff_brand_id_backfill.test.sql`: arms 8, 9 and 13 retired; their fixture inserts stay. `plan(14)` → `plan(11)`.
- `supabase/tests/consume_invitation_sets_profile_id.test.sql`: arms A/B run as postgres with the claims set; arm E flipped. `plan(9)` unchanged.

**Smokes**
- `scripts/smoke-edge-roles.sh`: new Arm 3b posts `{"email":"x@example.invalid","name":"x"}` with the admin bearer and expects 400 `inviteCode required`. Checked with `bash -n` only, per the brief.

**jest**
- `src/lib/sendInviteEmail.source.test.ts` (new). A source probe that checks:
  - the shape of the `inviteUrl` template
  - every interpolation goes through `escapeHtml`, and there are exactly 2
  - regex parity with `INVITE_CODE_RE`
  - the email/name check comes before the `inviteCode` check
  - the fallback `redirectTo` is still `registerUrl`

**Implementation notes for reviewers (backend):**

- **Section 9 pre-build queries (local, before any change):**

  | Query | Result |
  |---|---|
  | Q-1 | pgcrypto is in `extensions`; USAGE and `gen_random_bytes` EXECUTE for authenticated are t/t |
  | Q-2 | `sha256('x')` gives 64 hex characters |
  | Q-3 | `auth_profile_is_privileged()` is present |
  | Q-4 | `demote_profile_to_user(uuid)` and `register_invited_profile()`, both DEFINER |
  | Q-5 | no triggers |
  | Q-6 | no FKs to `invitations` |
  | Q-7 | anon and authenticated both hold SELECT/INSERT/UPDATE/DELETE |
  | Q-8 | `"Users can read own profile"`, `(id = auth.uid())` |

  - Local `schema_migrations` held 191 (`20261109191000`), 195 and 197.
  - Before the policy swap, local SELECT/DELETE were `{public}` with `auth_is_privileged()`, the same as prod's P-8.
  - Q-9 was **not run.** Inviting through the local fallback and then calling `signUp` creates `auth.users` rows on the shared stack outside any rolled-back transaction, which the brief forbids. It is informational only, and F2 stubs the fallback.

- **Local apply:**
  - Dry run with `commit;` swapped for `rollback;`: clean.
  - Then applied with psql in one transaction, with `insert into supabase_migrations.schema_migrations (version, name) values ('20261110120000', 'invitations_hardening')` before `commit;`, then `notify pgrst, 'reload schema'`.
  - The notice read `198: clamped 0 pending invitation(s)`.
  - No `db reset` or `stop`. No realtime change.

> **Superseded 2026-11-10 (fix-pass architect SF-2).** The function and policy md5 tables just below are from the first build. The fix pass changed `check_invitation_code`, the UPDATE policy's `qual` and `with_check`, and the trigger function's proacl. For the prod check use the fix-pass table further down, not these.

- **Function md5 references, first build (superseded)** (local, live `prosrc` equal to the file's `$$` bodies byte for byte; the file was hashed independently):

  | function | raw md5(prosrc) | normalized md5 (`\s+`→' ') | secdef | proconfig | owner | proacl |
  |---|---|---|---|---|---|---|
  | `assert_invitation_provenance()` | `2782c431c6866fe1e5f40486f6ce6f4c` | `613b45f5ad2a760fdde4db89792ffc62` | f | `search_path=public, auth` | postgres | default (a trigger function; not callable outside a trigger) |
  | `register_invited_profile(text)` | `59635720ef0b840b2261aca8d3811a65` | `86ade3dbed8d7fae4b99ed67b2eb4d37` | t | `search_path=public` | postgres | postgres, authenticated, service_role |
  | `check_invitation_code(text,text)` | `75cc5f8b2a0d06b780f97975befebe90` | `79ceccc11171cab91979e5f70ab35751` | t | `search_path=public` | postgres | postgres, anon, authenticated, service_role |
  | `create_invitation(text,text,text,text[],uuid,text)` | `1249dd3e4f6235313b49d9bd3098b76d` | `5b47cb610dbe150d51dcc23ba0271759` | f | `search_path=public` | postgres | postgres, authenticated, service_role |
  | `consume_invitation(uuid,text)` (body unchanged) | `9cea026d248586e6fd69b097d2a2ccc6` | `13ee616699b637b6d46ebe5fc4bdfa94` | t | `search_path=public` | postgres | postgres, service_role |
  | `assert_not_last_of_role(uuid,text)` (body unchanged) | `3dbaa0dba469991bc3a00690aca15ae0` | `0638c51b89305a6c109a146f2feb7f9a` | t | `search_path=public, auth` | postgres | postgres, authenticated, service_role |

- **Policy md5 references:**
  - ~~SELECT, DELETE and UPDATE `qual`: `864eb7d8c16c4222eecc2078e65c73f4` (the same text in all three)~~ Superseded: after the fix pass only SELECT and DELETE keep `864eb7d8…`; UPDATE `qual` is `bfe1da65…` and UPDATE `with_check` is `8dc14413…`.
  - INSERT `with_check`: `648ee06326c02a6932f517806e68a15c`
  - ~~UPDATE `with_check`: `a2c6959397c452352549061313643123`~~ Superseded by the fix pass (`8dc14413…`).
  - All four policies are `{authenticated}`.
  - The section 10 step-5 privilege matrix matches K-g, E1 and E2 exactly.

- **Rollback dry run.** Run locally with `commit;` swapped for `rollback;`:
  - every statement succeeded and its 1/1/1/1 DO block passed
  - afterwards `create_invitation` and `check_invitation_code` were still present, so the applied state is intact

- **`deno check`** (`denoland/deno:2.1.4`, repo mounted read-only):
  - `send-invite-email/index.ts` exited 0. `delete-user` was run as a control and also exited 0.
  - It needed `-e DENO_NO_PACKAGE_JSON=1`. Without it, Deno picks up the repo's `package.json` and fails resolving `npm:openai` types from `edge-runtime.d.ts`, which has nothing to do with this change.
  - The edge runtime mount was confirmed at the repo root. No local edge call was made.

- **Mutation runs.** Each ran as `begin; <mutation>; <test file>`, so the file's own `rollback;` undid it. Afterwards the catalog was checked unchanged: no `zz_mut_*` objects, and the `register_invited_profile(text)` md5 was unchanged. Red under every mutation, by arm:
  - **Catalog:** K-a, K-b, K-c, K-d (plus A6/B1, because the DEFINER trigger stops stamping), K-e, K-f1/K-f2, K-g, K-h
  - **A arms:** A2, A3 (plus K-b/A4/A5), A4 (plus A6), A5, A6, A7 (plus K-a/K-b)
  - **B arms:**
    - B1 (plaintext in `name`)
    - B2-staff, B2-admin and B2-zero went red by aborting the file. The claim raised outside `throws_ok`, and `test-db.sh` runs with `ON_ERROR_STOP=1`, so the file failed. This was verified separately for D4.
    - B3-4/5 (email check removed), B3-6, B3-7, B3-8 and B3-side
    - B5 (select by email; also reddens B3-3, B3-4, B3-9 and B8)
    - B6-agree (drop the inviter `exists` from CP; also reddens the B8 and D3-b pre-check arms)
    - B8-srv (step-8 delete removed)
    - B8-scope/CI (`create_invitation` made DEFINER: the trigger stops stamping, so the file aborts)
  - **C/D/E arms:**
    - C1, C2, D1 (aborts) and D2
    - D3-a, D3-b and D3-c
    - D4 (R7 gated on `auth_is_privileged()`; aborts)
    - E1 and E2
    - C3: 7 to 8 days in the inline clamp copy turns C3 red
  - **Stayed green (layered, recorded):**
    - B3-1/B3-2 when only R3b is removed: a NULL or blank code hashes to a value that matches nothing, so R3c still refuses.
    - B3-3 when only R3c's `if not found` is removed: an all-NULL row fails R3d's `expires_at is null`.
    - In both cases the refusal string and the end state are unchanged.
    - B3-9 has no predicate of its own; the B5 select-by-email mutation turns it red.

- **Where the build differs from the design text (none changes the contract):**
  1. **C3 fixture.** Added a pending row at `now() + 7 days 12 hours`. With only NULL, 2099 and an in-bound row, the design's own mutation ("7 to 8 days") could not turn C3 red.
  2. **AD-4 stamp scope.** The read is limited to `p.role in ('admin','master')`, matching the AD-4 text ("created by an admin or master") and step 5's "NULL for a super_admin". `profiles_role_brand_consistent` forces super_admins to brand NULL, so behaviour is identical to the unfiltered read.
  3. **R7 and CP agree.** R7 uses `brand_id is distinct from v_brand`; CP uses `p.brand_id = RB`. These differ only for an admin/master with a NULL brand, which `profiles_role_brand_consistent` forbids. B6-agree pins the reachable cases.
  4. **Mutation stand-ins:**
     - A4's listed mutation ("remove `auth_can_see_brand` from the D7 arm list") doesn't fit D7, which has no such arm. I removed `auth_is_super_admin()` from D7 instead.
     - D3-b's "check the inviter via the JWT" can't be built, because the claim never sees the inviter's JWT. I removed R7's role test instead.
     - K-g used `revoke ... from anon` on `check_invitation_code`.
  5. **`profiles_insert_hardening` C-15 rewritten, not retired.**
     - It now asserts that the second pending invitation's own code claims it, which is the new B5 behaviour.
     - **Why:** the `plan(80)` line is already a spec 191 change against HEAD (`plan(73)` → `plan(80)`). Renumbering it would fuse 198's and 191's hunks.
     - C-18's lists drop c15 (the invitation count goes from 8 to 6).
     - Section C brand-less fixtures (C-7, C-9's someone-else row, C-10, C-11, C-12, C-14, C-15, d12) use `invited_by = SA`, not only C-7, so each refusal has a single cause.
  6. **RESOLVED 2026-11-10 (review pass, see below).** ~~`profiles_insert_hardening` E-1 is not yet given a `code_hash` (follow-up).~~
     - E-1 sits inside spec 191's added Section E hunk, so editing it now would fold a 198 change into 191's commit, and the column doesn't exist at that commit.
     - E-1 still passes (42501), but it is now refused by both the privilege leaf and the missing `code_hash`. The privilege leaf is covered on its own by `invitations_hardening` CI-2, A3 and C2, and by E-2.
     - **Follow-up after 191's commit:** add `, code_hash` / `encode(sha256(convert_to('e1', 'UTF8')), 'hex')` to E-1's insert.
  7. **RESOLVED 2026-11-10 (review pass, see below): Arm 5 now sends a valid-format `inviteCode`.** ~~`smoke-edge-roles.sh` Arm 5 (existing, unchanged)~~ posted without `inviteCode`, so it now gets the 400 instead of reaching the `inviteUserByEmail` fallback. Its assertion (any 4xx with no `<script>` echo) still holds, and it no longer creates an `auth.users` row. Sending a valid-format code there would restore the old reach; I left it, per "existing arms unchanged".
  8. **`scripts/smoke-delete-user.sh` (D-5) was not re-run.** It mutates the shared stack outside a rolled-back transaction, and it's another session's uncommitted file. The D-5 ACL is covered by the migration DO block, by E1 and by the step-5 matrix. Re-run it before the prod apply.

- **Verification results:**
  - `invitations_hardening.test.sql`: 88/88.
  - `npm run test:db`: 106/106 files passed.
  - `npx jest` (frontend half present): 306/307 suites, 3947/3948 tests.
    - The one failure is `src/screens/cmd/sections/eod/__tests__/EODCountSection.dateScoped.spec192.test.tsx` (AC-9 SAVE DRAFT).
    - That file is another session's untracked spec 192 work and has nothing to do with invitations. It passed 30/30 twice in isolation, so it looks timing-flaky under full-suite load.
  - `npm run typecheck:test`: exit 0.
  - `npx tsc --noEmit --types node,jest`: exit 0.
  - e2e was not run (per brief).

#### Shared-file hunks

Specs 187, 191 and 195 are committed before 198, so the shared files have to be staged hunk by hunk. Hunks are shown as `git diff -U3` against HEAD, taken 2026-11-10.

- **`supabase/tests/profiles_insert_hardening.test.sql`**
  - **Spec 191's hunks:** `@@ -8,8` (arm-map header), `@@ -17,6` (Section E header lines), `@@ -48,7` (`plan(73)` → `plan(80)`), `@@ -84,6` (`test.e1`), `@@ -143,7` (e1 auth user), `@@ -231,13` (K-2), `@@ -334,6` (K-16..K-18) and `@@ -942,5` (Section E).
  - **Spec 198's hunks (all the others):**
    - `@@ -158,63` (Section C fixtures)
    - `@@ -265,34` (K-6..K-11)
    - `@@ -307,13` (K-13)
    - `@@ -538,6` (Section C note)
    - every hunk from `@@ -546` through `@@ -931,8` (Section C calls, C-15, C-18 and the Section D note and inserts)
  - No line inside 191's hunks was edited, and `plan(80)` was not renumbered.
- **`scripts/smoke-edge-roles.sh`**
  - **Spec 191's hunks:** `@@ -43,6`, `@@ -80,6`, `@@ -113,6` and `@@ -488,6` (Arm 7b).
  - **Spec 198's hunk:** `@@ -209,6 +233,33` (Arm 3b only).
- **Not shared** (no uncommitted changes from other specs before 198): `invitations_super_admin_rls.test.sql`, `profiles_username.test.sql`, `staff_brand_id_backfill.test.sql`, `consume_invitation_sets_profile_id.test.sql` and `send-invite-email/index.ts`. Everything else 198's backend touched is new.
- `specs/164-*`: not touched by spec 198's backend.

### Review fix pass (backend-developer, 2026-11-10)

Applies `specs/198-invitations-hardening/reviews/release-proposal.md` items 1-8 after the owner's decisions of
2026-11-10 (recorded under "Open questions resolved": H1 super_admin-only update, L1 keep the query string as a
follow-up, L3 deferred, L4 no change, AD-4 keep the default). One developer covered backend and frontend for this pass.
The migration is still unapplied on prod, so it was edited in place.

**Migrations**
- `supabase/migrations/20261110120000_invitations_hardening.sql` (edited in place):
  - **H1:** `"Admins can update invitations"` USING and WITH CHECK both gain
    `and public.auth_is_super_admin() and invitations.used = false`. The SCOPE, D7 and EXPIRY text is unchanged. The
    policy comment is reworded and still contains `spec 191` (K-17). The shape is still 1/1/1/1.
  - **Blank-code guard:** `check_invitation_code` (CP) gains `nullif(btrim(p_code), '') is not null`, which is R3b's
    guard.
  - **L2:** `revoke all on function public.assert_invitation_provenance() from public, anon, authenticated;`. This is
    safe: Postgres checks EXECUTE on a trigger function only at CREATE TRIGGER time, and IH B1/C1/D1/A6 (client inserts
    as `authenticated`) stay green with the revoke in place.
  - The clamp UPDATE is wrapped over four lines.
  - **Fail-closed DO block additions:**
    - 8.3 requires `used = false` in the UPDATE `qual` and `with_check`, plus at least two `auth_is_super_admin()`
      (D7's arm and the H1 leaf).
    - 8.5 refuses if `anon` or `authenticated` can execute `assert_invitation_provenance()`.
  - The header lines for steps 3 and 5 and the CP note are updated. Still pure ASCII, with `lock_timeout` in place.
- `specs/198-invitations-hardening/rollback.sql`: the header's RE-OPENS list now names H1. No SQL change.

**pgTAP**
- `supabase/tests/invitations_hardening.test.sql`: `plan(88)` → `plan(102)`.
  - **K-b** also checks the H1 text: `used = false` in both expressions, and `regexp_count(auth_is_super_admin()) >= 2`.
  - **K-d** also checks L2: no anon/authenticated EXECUTE and no PUBLIC entry.
  - **C3:** the clamp copy is wrapped the same way as the migration. Its comment points at the jest probe.
  - **New `bblank-198` fixture** with `code_hash = sha256('')`. It is otherwise the claimable baseline.
    - B6-agree adds `''`, `'   '` and NULL against it, all 0 rows.
    - New arm **B3-2b**: the claim with `''` → P0001. B3-side now includes it.
  - **B8-srv:** the second call differs in role (`user` → `admin`), stores (`{A1}` → `{}`), username, name and email
    case. Between the calls, postgres ages the first row's expiry. A new arm asserts the surviving row is the second
    call's: id, role, stores, brand, username, name, code hash and a fresh `now()+48h`. It also asserts the first id is
    gone. The brand can't differ, because a brand-A admin's scope is brand A only.
  - **C2** runs its three admitted/refused UPDATEs as the super_admin. A new arm checks that `1111` (the row's own
    inviter) UPDATE → 0 rows. **D2** runs as the super_admin.
  - **New H1 arms (11):**
    - H1-a: `1111` revives consumed b1 → 0 rows; as postgres the row is unchanged.
    - H1-b: the super_admin revives → 0 rows; the super_admin `set used = true` on an unused row → 42501.
    - H1-c: a burner claim with the consumed code → P0001; the pre-check is 0 for both emails.
    - H1-d: the full probe C (master invites X → X claims → X's revival → 0 rows → the super_admin demotes X → the
      burner claim → P0001 → the pre-check is 0).
- `supabase/tests/profiles_insert_hardening.test.sql` (`plan(80)` unchanged):
  - **CR-3:** lines 8, 17 and 597 now say `register_invited_profile(text)`.
  - **E-1 (architect S1):** the insert carries `code_hash`, so E-1 isolates the privilege leaf again.
  - **D-9..D-11 (H1 consequence, missing from the proposal's pin table):** the pre-pass file goes red on these three
    arms under the H1 policy. A brand admin's UPDATE now matches 0 rows, so `throws_ok(42501)` fails.
    - D-9 (role → `super_admin`) and D-10 (store → `'not-a-uuid'`) now run as the super_admin. It is the only caller
      whose UPDATE reaches WITH CHECK, so these still pin its role and store arms.
    - D-11 pins the brand admin's 0-row result.

**jest**
- `src/lib/invitationsClamp.source.test.ts` (new, 3 tests). It reads the migration and `invitations_hardening.test.sql`,
  drops `--` comments, collapses whitespace, and asserts each file has the exact clamp statement exactly once. It also
  asserts the migration's copy sits in section 4.
- `src/lib/inviteLink.ts`: new pure `formatInviteExpiry(iso)`. It parses the ISO by hand (Hermes-safe for microseconds
  and offsets) into a local `"Nov 12, 2026, 15:04"`, or returns null. `src/lib/inviteLink.test.ts` adds 3 tests.

**Frontend (CR-1, CR-2)**
- `src/components/cmd/InviteLinkPanel.tsx`: `IssuedInvite.expiresAt` and a new `expiresAt` prop. The copy reads "It
  works once and expires <local date/time>." It falls back to "It works once." if the value is unparseable. There is
  no second copy of the 48-hour constant, and the text has the new testID `invite-link-expiry`.
- `src/components/cmd/InviteUserDrawer.tsx`:
  - CR-1: the comment points at `create_invitation` step 5. Its zero-store sentence now says AD-4 stamps the inviter's
    brand.
  - Passes `expiresAt`.
- `src/components/cmd/InviteAdminDrawer.tsx`: passes `expiresAt`.
- `src/components/cmd/InviteUserDrawer.test.tsx` (+1 test, inside the spec 198 block) and
  `src/components/cmd/InviteAdminDrawer.test.tsx` (+2 tests: the rendered expiry, and the unparseable fallback).
- The email's "expires in 48 hours" copy stays (D-3; the edge function is not changed).

**Smokes**
- `scripts/smoke-edge-roles.sh`:
  - Arm 5 sends `inviteCode: "5e1ec7ed0000000000000000000000a5"`, so it reaches the post-validation path again. Its
    existing `auth.users` cleanup covers the fallback.
  - The stale "line 49" comment in Arm 3 is fixed.
- `scripts/smoke-rpc.sh`: new section 2 with the anon invitation arms.
  - The `DELETE` arm runs only when `SUPABASE_URL` is a local stack; against a remote URL it SKIPs.
  - The header line is updated.

**e2e**
- `e2e/invite-claim.spec.ts` (architect S2): emails are built per attempt as `<prefix>+<RUN_ID>-r<test.info().retry>`
  through `attemptEmail()`. `afterAll` cleans up every email it created. A late flake in attempt 1 can no longer trip
  the retry's guard or its single-row check.
- N5 and N6 (the optional ride-alongs) were not done.

**Updated md5 references** (these replace the backend table above for the prod-apply step 3/4 checks). The live
`prosrc` equals the file's `$$` bodies byte for byte; the file was hashed independently.

| function | raw md5(prosrc) | normalized md5 | secdef | proconfig | owner | proacl |
|---|---|---|---|---|---|---|
| `assert_invitation_provenance()` | `2782c431c6866fe1e5f40486f6ce6f4c` | `613b45f5ad2a760fdde4db89792ffc62` | f | `search_path=public, auth` | postgres | **postgres, service_role** (L2) |
| `register_invited_profile(text)` | `59635720ef0b840b2261aca8d3811a65` | `86ade3dbed8d7fae4b99ed67b2eb4d37` | t | `search_path=public` | postgres | postgres, authenticated, service_role |
| `check_invitation_code(text,text)` | **`00656f3144aa2274fa05592a64a43d42`** | **`57d0f31f5133bfc47c9461fa1fd67865`** | t | `search_path=public` | postgres | postgres, anon, authenticated, service_role |
| `create_invitation(text,text,text,text[],uuid,text)` | `1249dd3e4f6235313b49d9bd3098b76d` | `5b47cb610dbe150d51dcc23ba0271759` | f | `search_path=public` | postgres | postgres, authenticated, service_role |
| `consume_invitation(uuid,text)` | unchanged (see above) | | | | | |
| `assert_not_last_of_role(uuid,text)` | unchanged (see above) | | | | | |

**Policies** (`md5(qual)` / `md5(with_check)`):
- SELECT and DELETE `qual`: `864eb7d8c16c4222eecc2078e65c73f4` (unchanged)
- INSERT `with_check`: `648ee06326c02a6932f517806e68a15c` (unchanged)
- **UPDATE `qual`: `bfe1da6594ae840101c423961fdcc211`**
- **UPDATE `with_check`: `8dc14413955c8e29198ebbfe50465450`**

All four policies are `{authenticated}`. Step 5's privilege matrix also gains `assert_invitation_provenance()`: anon f,
authenticated f, service_role t.

**Local re-apply** (shared stack; no `db reset` or `stop`):
- **What ran:** one psql transaction. It held:
  - `set local lock_timeout`
  - drop and recreate the UPDATE policy, plus its comment
  - `create or replace` of `check_invitation_code` (the body extracted from the file by line range), plus its
    revoke/grant
  - the L2 revoke
  - the full new fail-closed DO block
  - `commit`
- First as a dry run ending in `rollback` (exit 0), then committed (exit 0), then `notify pgrst, 'reload schema'`.
- The `schema_migrations` row was already present.

**Dry runs (both ending in `rollback;`):**
- **Migration, from a simulated pre-198 state** (one transaction): `rollback.sql`'s body, then
  `alter table ... drop column invited_by, code_hash`, then the full migration body without its `begin`/`commit`.
  - Exit 0, `NOTICE: 198: clamped 0 pending invitation(s)`.
  - Every DO block passed.
  - The resulting policy md5s and function `prosrc` md5s equal the table above.
- **`rollback.sql`:** exit 0, and its 1/1/1/1 DO block passed. Inside the transaction the policies were
  DELETE:public / INSERT:authenticated / SELECT:public / UPDATE:authenticated, and the functions were
  `get_pending_invitation(text)` and `register_invited_profile()`.
  - Afterwards the live catalog still held `assert_invitation_provenance()`, `check_invitation_code`,
    `create_invitation` and `register_invited_profile(text)`.

**Mutation runs.** Each ran as `begin; <mutation>; <test file>`, so the file's `rollback;` undid it. Afterwards the four
function md5s matched the file again, the policy md5s were unchanged, and the trigger function's ACL was still
postgres, service_role.

| Mutation | Result |
|---|---|
| UPDATE USING without the super_admin leaf | K-b red; the file aborts at the C2 `1111` arm (WITH CHECK still refuses it) |
| UPDATE USING without `used = false` | K-b, H1-b (super_admin revival), H1-c ×2 red |
| UPDATE WITH CHECK without `used = false` | K-b, H1-b (`set used = true`) red |
| Neither H1 leaf (191's shape) | IH: K-b, C2-1111, H1-a ×2, H1-b `set used`, H1-c ×2, H1-d revival, H1-d burner claim red. PIH: aborts at D-11 (K-17 also red because the mutation drops the comment) |
| CP without the blank guard | B6-agree red |
| Claim without R3b | B3-2b and B3-side red |
| `create_invitation` ignoring `p_username` | B8-srv content arm red |
| Re-grant the trigger function to authenticated | K-d red |
| INSERT policy on `auth_is_privileged()` (JWT leaf) | PIH E-1 red (with K-16, and K-17 because of the dropped comment) |
| The pre-pass PIH file under the H1 policy | D-9, D-10 and D-11 red (why they were changed) |
| Jest probe: migration clamp `'7 days'` → `'8 days'` (temporary edit, restored byte-exact, md5 `eee58ba55d805d136e06a9be9ed79422` before and after) | 2 of 3 probe tests red |

**Layered (recorded):**
- H1-a stays green when only one H1 leaf is removed, because both leaves refuse it. The C2 `1111` arm pins the
  super_admin leaf on its own; H1-b pins `used = false` on its own.
- H1-d's revival is likewise held by the super_admin leaf when only `used = false` is removed.
- E-2 (spec 191) now has two causes: `auth_profile_is_privileged()` and the super_admin leaf. This is inherent to H1,
  since `auth_is_super_admin()` implies privileged. K-16 still pins the privilege leaf's text.

**Verification results (this pass):**
- **The six named pgTAP files:**
  - `invitations_hardening` 102/102
  - `profiles_insert_hardening` 80/80
  - `invitations_super_admin_rls` 4/4
  - `profiles_username` 15/15
  - `staff_brand_id_backfill` 11/11
  - `consume_invitation_sets_profile_id` 9/9
- **`npm run test:db`:** `✓ 106/106 DB test file(s) passed`, exit 0. `staff_role_eod_rls` was green on this run.
- **`npx jest`:** 308/308 suites, 3972/3972 tests, 17/17 snapshots, exit 0.
- **Typechecks:** `npm run typecheck:test` exit 0, `npx tsc --noEmit --types node,jest` exit 0, and
  `npx tsc -p e2e/tsconfig.json --noEmit` exit 0.
- **`scripts/smoke-rpc.sh` section 2 only** (run as an extracted copy, with no admin login): 6/6 PASS.
  - GET → 200 `[]`; DELETE → 200 `[]`; `check_invitation_code` with a wrong code → 200 `[]`; `get_pending_invitation`
    → 404 PGRST202; `register_invited_profile` → 401 42501; `create_invitation` → 401 42501.
  - **Caveat:** the local `public.invitations` table held **0 rows** at the time, so the GET and DELETE arms were
    vacuous on this run. The four RPC arms were not.
- **Not run (by instruction):** `smoke-edge-roles.sh`, `smoke-delete-user.sh` and e2e. Main Claude schedules them.

#### Shared-file hunks (this pass)

- **`supabase/tests/profiles_insert_hardening.test.sql`**
  - **Against `test/ship-187-191-195`, where 191 is committed: every hunk is 198's.**
    - This pass's hunks there:
      - `@@ -5,7 +5,7` (line 8, CR-3)
      - `@@ -14,7 +14,7` (line 17, CR-3)
      - line 597 (CR-3), which falls inside the existing `@@ -581,8 +594,15` Section C hunk
      - D-9..D-11, which fall inside the existing `@@ -875,39 +899,56` Section D hunk
      - `@@ -1008,8 +1049,8` (E-1)
  - **Against HEAD in this checkout (191 still uncommitted):**
    - Lines 8 and 17 are context lines of 191's header hunks, so they merge into `@@ -5,18 +5,24`. Context lines separate
      198's two lines from 191's, so `git add -p` → `s` splits them.
    - E-1 merges into 191's Section E hunk `@@ -942,5 +1028,57`. It can only be staged separately on top of 191's commit.
- **`scripts/smoke-edge-roles.sh`:**
  - Against `test/ship-187-191-195`: `@@ -211,7 +211,8` (the Arm 3 comment), `@@ -233,6 +234,33` (Arm 3b, from the
    earlier pass) and `@@ -306,13 +334,19` (Arm 5).
  - Against HEAD: `@@ -187,7 +211,8`, `@@ -209,6 +234,33` and `@@ -282,13 +334,19`.
  - All of these are separate from 191's `-43`, `-80`, `-113` and `-488`.
- **`scripts/smoke-rpc.sh`:** not modified by any other spec. 198's hunks are `@@ -2,8 +2,8` (header) and
  `@@ -126,6 +126,98` (section 2).
- **198-only files touched this pass:**
  - the migration and `rollback.sql`
  - `invitations_hardening.test.sql`
  - `e2e/invite-claim.spec.ts`
  - `src/lib/inviteLink.ts` and `inviteLink.test.ts`
  - `src/lib/invitationsClamp.source.test.ts`
  - `InviteLinkPanel.tsx` and `InviteAdminDrawer.test.tsx`
  - the two drawers' 198 hunks
  - the spec 198 block of `InviteUserDrawer.test.tsx`
- **Not touched:** `src/lib/auth.ts`, `src/lib/db.ts`, `supabase/functions/*`, `CLAUDE.md`, `app.json`.
