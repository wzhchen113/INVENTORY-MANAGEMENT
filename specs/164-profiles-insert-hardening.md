# Spec 164: Close the `profiles` INSERT privilege-escalation hole (and fix the dead OR-tail lint)

Status: READY_FOR_REVIEW

Priority: security hotfix. **This spec must be applied to prod BEFORE spec 163's prod rollout** (spec 163 adds a new PII reader whose only trust anchor is `profiles.role`).

## User story
As the owner of the 2AM PROJECT platform, I want a signed-in account to be unable to create its own `profiles` row with a role, brand, or id it picks, and I want invited users to get exactly the role, brand, and stores the inviting admin chose. That way nobody can make themselves `super_admin` (or an admin of another brand) with one INSERT, and the CI lint that is supposed to catch this kind of policy actually works.

## Background
Sources: [specs/163-admin-user-emails/reviews/security-auditor.md](163-admin-user-emails/reviews/security-auditor.md) (Critical + High H1), [specs/163-admin-user-emails/reviews/release-proposal.md](163-admin-user-emails/reviews/release-proposal.md) (fix list step 2).

- **The hole.** The `public.profiles` INSERT policy `"Anyone can insert own profile or admin can insert any"` ([supabase/migrations/20260502071736_remote_schema.sql:399-404](../supabase/migrations/20260502071736_remote_schema.sql)) has `WITH CHECK (id = auth.uid()) OR (jwt app_metadata role in ('admin','master')) OR (auth.uid() IS NOT NULL)`. The OR-tail admits every authenticated caller, for any `id`, `role`, and `brand_id`. It is live locally and in prod (confirmed read-only via MCP on 2026-10-08).
- **Nothing guards role/brand at INSERT time.** `profiles_self_brand_lock` ([20260517050000_rls_hardening_followups.sql:196](../supabase/migrations/20260517050000_rls_hardening_followups.sql)) is UPDATE-only. The `AFTER INSERT` trigger `profiles_sync_role_to_jwt` (`sync_role_to_app_metadata()`, SECURITY DEFINER) then copies `NEW.role` into `auth.users.raw_app_meta_data`, so a forged row also mints an admin/master JWT claim.
- **The client registration path supplies the role.** `registerInvitedUser` ([src/lib/auth.ts:472-570](../src/lib/auth.ts)) calls `supabase.auth.signUp`, then inserts the profile with `role`, `brand_id`, and `username` read on the client from `get_pending_invitation`, then inserts `user_stores` rows, then calls `consume_invitation`. An invitee can send `'super_admin'` instead.
- **Who can reach it.** Anyone with the public anon key (signups are enabled; `registerInvitedUser` depends on it), every invited-but-unregistered user, and any auth user on the project with no profile row.
- **Prod triage (read-only, 2026-10-08): no evidence of exploitation.** Only 2 privileged profiles exist: super_admin "Super Admin (Owner)" (2026-04-08) and admin "Bobby" (2026-04-09). `profiles.role` matches `app_metadata.role` for every user, and every auth user has a profile.
- **Why CI never caught it (High H1).** [supabase/tests/permissive_policy_lint.test.sql](../supabase/tests/permissive_policy_lint.test.sql) (spec 053) uses `\b` in its OR-tail regexes (lines ~121-122, 166-167, 248-249, 314-315). In Postgres ARE syntax `\b` is *backspace*; word boundary is `\y`. So the OR-tail arm has never matched anything. With `\y`, the lint flags exactly one live policy: this one. [supabase/tests/order_approvals.test.sql:416,418](../supabase/tests/order_approvals.test.sql) has the same `\b` bug in its own OR-tail probe.
- **Second-order issue the fix creates.** Once registration derives role/brand from the invitation row, the invitation becomes the trust anchor. Today the `invitations` INSERT/UPDATE policies ([20260514150000_invitations_super_admin_rls.sql:37-44](../supabase/migrations/20260514150000_invitations_super_admin_rls.sql)) are `WITH CHECK (auth_is_privileged())` only. Any brand-A admin can write an invitation with `role='super_admin'`, or `role='admin'` with brand B, or stores from brand B. That is moot today, because the profiles hole is worse. After this fix it would become the escalation path, so this spec also closes it.

## Inventory: every INSERT path into `public.profiles`
The new contract must keep every legitimate path working.

| # | Path | Runs as | Effect of this spec |
|---|------|---------|---------------------|
| 1 | `registerInvitedUser` direct `.from('profiles').insert` ([src/lib/auth.ts:527](../src/lib/auth.ts)) | `authenticated` (fresh signUp session) | **Replaced** by the new server-side registration RPC. The client no longer inserts into `profiles` or `user_stores`, and no longer calls `consume_invitation`. |
| 2 | Super-admin bootstrap insert in [20260509000000_multi_brand_schema_rls.sql:314-318](../supabase/migrations/20260509000000_multi_brand_schema_rls.sql) | `postgres` (migration) | Unaffected. RLS and the new guard both skip `postgres`. |
| 3 | [supabase/seed.sql](../supabase/seed.sql) | `postgres` | Unaffected. |
| 4 | pgTAP fixtures under `supabase/tests/` (`insert into public.profiles ...`) | `postgres` after `reset role` | Expected unaffected. The architect confirms that no fixture inserts a profile while impersonating `authenticated`. |
| 5 | Edge functions | n/a | **None insert into `profiles`.** `delete-user` only deletes. `send-invite-email`'s fallback `inviteUserByEmail` creates an auth user, not a profile. |
| 6 | Triggers on `auth.users` (e.g. a `handle_new_user`) | n/a | None in the repo. **Not captured by `db pull` of `public`**, so the rollout re-checks prod (AC-R1). |
| 7 | `consume_invitation` RPC | SECURITY DEFINER | Updates `invitations` only. Not a profile-insert path. |
| 8 | Staff app [src/screens/staff/](../src/screens/staff/) | `authenticated` | No profile inserts. It only does `update({ locale })` on its own row. Sign-in is untouched. |
| 9 | Customer PWA (sibling repo) | unknown | Not verifiable from this repo. The default assumption is that it does not insert `profiles`. The rollout verifies this against prod data (AC-R1). |

## Acceptance criteria

### A. `profiles` INSERT policy (migration)
- [ ] A new migration drops `"Anyone can insert own profile or admin can insert any"` on `public.profiles` and replaces it with **one** permissive INSERT policy whose `WITH CHECK` is exactly the privileged, brand-scoped arm: `public.auth_is_privileged() and public.auth_can_see_brand(brand_id)`. It has **no** self-arm and no `auth.uid() IS NOT NULL` or other trivially-wide tail.
- [ ] After the migration, `select count(*) from pg_policies where schemaname='public' and tablename='profiles' and cmd='INSERT'` = 1 (or `cmd='ALL'` policies are confirmed absent), so no other permissive policy ORs the check back open.
- [ ] Under JWT impersonation as `authenticated` (each inside `begin … rollback`):
  - [ ] An auth user with **no** profile inserting `(id=<own uid>, role='super_admin', brand_id=null)` fails with SQLSTATE `42501` (RLS). `auth.users.raw_app_meta_data` for that uid is unchanged afterwards.
  - [ ] The same caller inserting `(id=<own uid>, role='user', brand_id=null)` fails with `42501`.
  - [ ] The same caller inserting a row for a **different** orphan auth id (any role) fails with `42501`. The victim's `raw_app_meta_data` is unchanged.
  - [ ] A `role='user'` profile (staff) inserting any profile row fails with `42501`.
  - [ ] A brand-A `admin` (and `master`) inserting `role='user', brand_id=<A>` for an orphan auth id **succeeds**.
  - [ ] A brand-A `admin` inserting `role='user', brand_id=<B>` or `brand_id=null` fails with `42501`.
  - [ ] A brand-A `admin` inserting `role='admin'` (brand A), `role='master'`, or `role='super_admin'` is rejected by the guard trigger (section B).
  - [ ] A `super_admin` inserting `role='admin', brand_id=<B>` succeeds.

### B. INSERT-time role guard trigger (defense in depth)
- [ ] A new `BEFORE INSERT` trigger on `public.profiles` rejects any insert where `NEW.role <> 'user'` when `current_user in ('authenticated','anon')` and the caller is not super_admin (`public.auth_is_super_admin()`). The refusal uses a stable, byte-for-byte message chosen by the architect, following the existing `'role ... requires super_admin'` phrasing. It raises SQLSTATE `P0001` (or another stable code the architect documents).
- [ ] The trigger function is `SECURITY INVOKER`, so `current_user` reflects the real caller. This is the spec 042 round-4 lesson; a SECURITY DEFINER body collapses `current_user` to the owner and makes the guard unreachable. `search_path` is pinned.
- [ ] pgTAP proves the trigger fires for `authenticated` (even when RLS would admit the row, e.g. a brand-A admin inserting `role='admin', brand_id=<A>`). It also proves the trigger skips `postgres` (migration and fixtures), `service_role`, and the SECURITY DEFINER registration RPC (section C).
- [ ] The existing `profiles_role_brand_consistent` CHECK, `profiles_self_brand_lock`, `profiles_self_delete_lock`, and `profiles_sync_role_to_jwt` are unchanged.

### C. Server-side invited-user registration RPC
- [ ] A new `SECURITY DEFINER` function in `public` (working name `register_invited_profile`; the final name is the architect's call, shown below as `<reg_rpc>`) completes registration for the **calling** user. It takes **no** role, brand, username, store, or id parameters from the client. Everything is derived server-side.
- [ ] Identity binding: the caller is `auth.uid()`. The invitation is the single pending invitation where `lower(invitations.email) = lower(auth.email())`, `used = false`, and it is not expired. These are the same predicates as `get_pending_invitation` / `consume_invitation`.
- [ ] On success, in **one transaction**, it:
  - inserts `public.profiles` with `id = auth.uid()`, `name = invitation.name`, `role = invitation.role`, `username = invitation.username`, `status = 'active'`, `color = '#378ADD'`, and `initials` derived from `invitation.name` exactly as the current client does (first letter of each word, max 2, uppercased)
  - sets `brand_id` with the current client's rule: for `role='user'`, `coalesce(invitation.brand_id, brand of store_ids[1])` (the spec 069 `resolved_brand_id`); for `role='admin'`, `invitation.brand_id`
  - inserts one `public.user_stores` row per `invitation.store_ids` element
  - marks the invitation `used = true, profile_id = auth.uid()`, the same as `consume_invitation`
- [ ] The RPC refuses with a stable error and **no side effects** (no profile, no `user_stores`, invitation still `used=false`, `raw_app_meta_data` unchanged) when:
  - [ ] `auth.uid()` is null
  - [ ] the caller already has a `profiles` row. A second call does not create a second row or modify the first.
  - [ ] there is no matching pending invitation (none, used, expired, or a different email)
  - [ ] `invitation.role` is not in `('user','admin')`. This includes `super_admin` and `master` invitations that were written directly as `postgres`.
  - [ ] `invitation.role = 'admin'` and `invitation.brand_id is null` (keeps today's client-side pre-check as a server-side guarantee)
- [ ] Email matching is case-insensitive. For example, an invitation for `Staff@X.com` is claimed by an auth user whose email is `staff@x.com`.
- [ ] After a successful call, `auth.users.raw_app_meta_data->>'role'` equals the invitation's role, through the existing sync trigger.
- [ ] Grants follow the spec 097 pattern: `revoke execute ... from public, anon;` and `grant execute ... to authenticated;`. `has_function_privilege('anon', '<reg_rpc signature>', 'EXECUTE') = false`.
- [ ] `search_path` is pinned and every relation is schema-qualified.
- [ ] `consume_invitation` and `get_pending_invitation` keep their current signatures, grants, and behavior. `get_pending_invitation` is still used by the client for the pre-signUp "is there an invitation?" check. Whether `consume_invitation` is later dropped is out of scope.

### D. `invitations` write-policy tightening (the invitation is now the trust anchor)
- [ ] The `invitations` INSERT and UPDATE `WITH CHECK` are tightened so a caller can only write an invitation that the caller could legitimately grant:
  - `public.auth_is_privileged()`, **and**
  - `role in ('user','admin')`, **and**
  - `brand_id is null or public.auth_can_see_brand(brand_id)`, **and**
  - every store in `store_ids` belongs to a brand the caller can see (`auth_can_see_brand(stores.brand_id)`).
- [ ] The `invitations` SELECT and DELETE policies are unchanged.
- [ ] Under JWT impersonation:
  - [ ] A brand-A admin can insert a `user` invite with brand-A stores and an `admin` invite with `brand_id=<A>`.
  - [ ] A brand-A admin **cannot** insert or update an invitation to `role='super_admin'`, `role='master'`, `brand_id=<B>`, or `store_ids` containing a brand-B store. Each fails with `42501`.
  - [ ] A super_admin can insert `user`/`admin` invitations for any brand, but cannot insert `role='super_admin'` or `role='master'`.
  - [ ] A `user`-role caller cannot insert any invitation (unchanged).
- [ ] The existing admin invite flow (`inviteUser` in [src/lib/auth.ts:385](../src/lib/auth.ts) via the Cmd UI Users section invite drawer) still works for both `admin` and `user` invites in the caller's own brand.

### E. Client registration change (`src/lib/auth.ts`)
- [ ] `registerInvitedUser` keeps its exported signature and `AuthResult` return shape, so [src/screens/RegisterScreen.tsx](../src/screens/RegisterScreen.tsx) needs no change.
- [ ] After a successful `signUp`, it calls `<reg_rpc>` exactly once. It makes **no** `.from('profiles').insert`, **no** `.from('user_stores').insert`, and **no** `consume_invitation` call.
- [ ] The `signUp` call no longer sends `role` in `options.data`, so the client sends no role anywhere in registration. Nothing reads `user_metadata.role` today; this was verified by repo grep.
- [ ] The pre-signUp `get_pending_invitation` lookup and its two existing user-facing errors ("No invitation found…", "Invitation is missing a brand assignment…") are unchanged.
- [ ] If `<reg_rpc>` fails, `registerInvitedUser` returns a non-null `error` string. It does not send the welcome email and does not report success. This matches today's "Account created but profile setup failed: …" behavior, so the wording can stay.
- [ ] The welcome email (`callEdgeFunction('send-welcome-email', …)`) still fires on success.
- [ ] The `<reg_rpc>` call lives in `src/lib/auth.ts`, which is a documented `supabase.rpc` carve-out. No new `db.ts` helper is required.

### F. Lint fix (must land in the same PR as A–D)
- [ ] In [supabase/tests/permissive_policy_lint.test.sql](../supabase/tests/permissive_policy_lint.test.sql), every regex word boundary written as `\b` is changed to `\y`: all 8 regex literals (`\bor`, `and\b`, `or\b`) at ~121-122, 166-167, 248-249, 314-315. The header comment at ~41 and the arm-4 message at ~331 are updated to match.
- [ ] A new **positive OR-tail** arm creates a synthetic permissive policy whose predicate is the exact former profiles shape, `((id = auth.uid()) or (auth.uid() is not null))`. It asserts the detector flags it (count = 1). `plan(N)` is updated.
- [ ] The existing AND-guard negative arm still passes. Now that the regex can match, the pass is meaningful: `... or (auth.uid() is not null and <x>)` is NOT flagged.
- [ ] With A–D applied, arm (1)'s violation count is 0 **with no new allowlist rows**. The profiles INSERT policy is fixed, not allowlisted.
- [ ] [supabase/tests/order_approvals.test.sql:416,418](../supabase/tests/order_approvals.test.sql): `\b` is changed to `\y`. The arm still passes (order_approvals has no OR-tail policy).
- [ ] A repo grep of `supabase/tests/` for `\\b` inside regex literals returns no remaining word-boundary uses.

### G. Tests
- [ ] **pgTAP** (new file under `supabase/tests/`, run by `scripts/test-db.sh`) covers every arm in sections A, B, C, and D above. It also includes a grant/definer probe for `<reg_rpc>` (`prosecdef = true`, `search_path` pinned, anon has no EXECUTE) and a policy-text probe asserting that the profiles INSERT `with_check` contains no `auth.uid() IS NOT NULL`.
- [ ] **pgTAP** `permissive_policy_lint.test.sql` and `order_approvals.test.sql` changes per section F.
- [ ] Full `scripts/test-db.sh` passes, including every pre-existing pgTAP file (e.g. `profiles_rls_sweep`, `rls_hardening_followups`, `profiles_username`, `staff_brand_id_backfill`, `invitations_brand_id_backfill`, `user_stores_brand_match_null_brand`, and spec 163's `get_profile_emails`).
- [ ] **jest:** [src/lib/registerInvitedUser.test.ts](../src/lib/registerInvitedUser.test.ts) is rewritten to the new contract:
  - signUp is followed by exactly one `<reg_rpc>` call
  - no `profiles` / `user_stores` insert and no `consume_invitation` call
  - signUp `options.data` has no `role`
  - an RPC error yields a non-null `error` and no welcome email
  - the success path yields `error: null`

  The spec 069 brand-stamp assertions move to pgTAP (section C brand rule), because brand derivation is now server-side.
- [ ] Any other jest test pinning the old registration behavior (grep `registerInvitedUser`, `consume_invitation`, `from('profiles').insert`) is updated. Full `npx jest`, `npm run typecheck`, and `npm run typecheck:test` pass.

### H. Local end-to-end verification
- [ ] On the local stack (`npm run dev:db`), in the browser, as `admin@local.test`:
  - invite a `user` (staff) with one store and an `admin` with the admin's brand
  - register each via the Register screen
  - confirm each signs in to the correct surface (staff to the StaffStack EOD app; admin to the Cmd UI)
  - confirm the staff user has the right `brand_id` and `user_stores`
- [ ] An existing staff account signs in to the staff EOD app and can change language (profile UPDATE path) unchanged.

### Rollout (prod `ebwnovzzkwhsdxkpyjka`, via Supabase MCP per project convention)
- [ ] **AC-R1, pre-apply read-only checks**, recorded in the spec's review notes:
  - (a) re-run the three triage queries from the security audit (privileged profiles; `profiles.role` vs `app_metadata.role` drift; live profiles INSERT `with_check`)
  - (b) `select tgname from pg_trigger where tgrelid = 'auth.users'::regclass and not tgisinternal` shows no profile-creating trigger
  - (c) list pending (`used=false`, unexpired) invitations with role/brand, to confirm none has a role outside `('user','admin')` or a cross-brand store set that the new rules would strand
  - (d) count profiles created after 2026-05-31 that have no `invitations.profile_id` link, to detect any unknown INSERT path such as the customer PWA

  If (d) or (b) shows an unexpected path, stop and surface it to the user before applying.
- [ ] **AC-R2, apply:**
  - run the migration via MCP `execute_sql`
  - insert its exact version into `supabase_migrations.schema_migrations`
  - verify each new or changed function with the normalized-md5 check
  - verify the live `pg_policies` text for `profiles` INSERT and `invitations` INSERT/UPDATE matches the repo
  - confirm `has_function_privilege('anon', <reg_rpc>, 'EXECUTE') = false` and `proowner` is `postgres`
  - run `notify pgrst, 'reload schema';` if the first client call returns `PGRST202`
- [ ] **AC-R3:** after the user pushes to `main`, the latest runs of `.github/workflows/test.yml` and `.github/workflows/db-migrations-applied.yml` on `main` are green (and `e2e.yml`, checked manually per project memory).
- [ ] **AC-R4, ordering:** this spec's migration is in prod and its client is deployed before spec 163's migration is applied to prod.

## In scope
- Replacing the `profiles` INSERT policy with a privileged, brand-scoped policy (no self-arm, no wide tail)
- A `BEFORE INSERT` role-guard trigger on `profiles` (SECURITY INVOKER)
- A new SECURITY DEFINER registration RPC that creates the profile, `user_stores`, and the invitation link atomically from the invitation row
- Tightening the `invitations` INSERT/UPDATE `WITH CHECK` (role whitelist plus brand and store scope)
- Rewiring `registerInvitedUser` to call the RPC and stop sending a client-chosen role
- Fixing `\b` → `\y` in `permissive_policy_lint.test.sql` and `order_approvals.test.sql`, plus a positive OR-tail fixture
- pgTAP and jest coverage above; prod apply via MCP; CI-gate check

## Out of scope (explicitly)
- **Invitation squatting / email-ownership proof.** Email confirmation is off (registration needs an immediate session). So whoever first signs up with a pending invitee's email claims that invitation's role. This is pre-existing and needs knowledge of a pending invite email. Fixing it means enabling confirmations and moving the claim to first sign-in, which changes the registration UX. **Recommended follow-up spec.**
- **`user_stores` own-row policy** (`"Users can manage own store links"`, `for all using/with check (user_id = auth.uid())`, [20260520010000_legacy_permissive_policy_dropout.sql:104-110](../supabase/migrations/20260520010000_legacy_permissive_policy_dropout.sql)). An existing staff user can still self-grant other stores within their own brand. This is pre-existing horizontal access, not a role escalation. With registration server-side, this self-write arm may have no remaining legitimate caller. **Recommended follow-up spec.**
- **`invitations` SELECT/DELETE brand scope.** An admin can still read or delete other brands' invitations (`auth_is_privileged()` only). This is pre-existing and not an escalation path.
- **`get_pending_invitation` anon enumeration** (returns name/role for any email). Pre-existing, unchanged.
- **Disabling public signups or moving signUp into an edge function.** Not needed once a profile-less auth user has no privileges.
- **Orphan auth users from failed registrations** (signUp succeeds, profile step fails). Pre-existing, unchanged.
- **Dropping `consume_invitation`.** It is left in place; removal is a later cleanup once no client calls it.
- **Changing `sync_role_to_app_metadata`** or the stale-JWT window for `auth_is_privileged()` policies. This is an accepted existing property.
- **The `send-invite-email` Supabase-auth fallback** (`inviteUserByEmail`). No change.
- **Spec 163's diff and its pre-rollout touch-ups.** Tracked under spec 163.
- **`app.json` slug.** Not touched.

## Open questions resolved
The request came pre-approved with direction from the user, via the spec 163 release proposal. The PM resolved the questions below using conventional or least-privilege defaults. Items marked **(user may override)** are product calls the user should confirm, but none blocks the design.
- Q: Keep a self-insert arm `(id = auth.uid() and role='user' and brand_id is null)` as the auditor sketched? → A: **No.** Its only legitimate caller (`registerInvitedUser`) moves to the RPC. Keeping it would still let any anon-key signup create a NULL-brand staff profile and then self-grant a store via the `user_stores` own-row policy, which gives it `auth_can_see_store()` read access to another tenant's store data.
- Q: Keep the privileged arm even though no client uses it today? → A: Yes. Keep it brand-scoped, with the guard trigger limiting non-super_admins to `role='user'`. It matches the release-proposal direction and the spec 042/046 profiles policy shapes. **(user may override: drop it entirely)**
- Q: Should registration be able to mint `super_admin` / `master` from an invitation? → A: No. Only `user` and `admin`, which are the only roles the invite UI offers (`InviteUserOptions.role: 'admin' | 'user'`). Super_admin and master stay provisioned by migration or psql. **(user may override)**
- Q: Should the RPC also create `user_stores` and consume the invitation? → A: Yes, atomically. Otherwise the client still chooses store ids, and a partial failure leaves a half-registered user.
- Q: Tighten `invitations` writes in this spec? → A: Yes. It is required for soundness, because the invitation becomes the trust anchor.
- Q: Old native (EAS) builds and cached web bundles still run the old `registerInvitedUser`. After the migration, their direct profile INSERT fails, so registration from an old build returns "profile setup failed" and leaves an orphan auth user. → A: Accepted. The hole cannot stay open for old clients, and invites are rare. Web picks up the fix on the next Vercel deploy. Native invitees must use web or an updated build. **(user may override, e.g. hold invites until deploy)**
- Q: Does the customer PWA create `profiles` rows on this project? → A: Assumed no. It is verified by AC-R1(d) before apply rather than assumed.
- Q: Email confirmation / invitation squatting? → A: Out of scope, follow-up spec. **(user may override)**
- Q: Prod data remediation? → A: None. The 2026-10-08 triage found no exploitation. AC-R1 re-checks immediately before apply.

## Dependencies
- Existing helpers: `public.auth_is_privileged()`, `public.auth_can_see_brand(uuid)`, `public.auth_is_super_admin()`, `auth.uid()`, `auth.email()`.
- Existing objects referenced or unchanged: `public.invitations`, `get_pending_invitation(text)` ([20260607120000_profiles_username.sql:111](../supabase/migrations/20260607120000_profiles_username.sql), carrying the spec 069 `resolved_brand_id` rule), `consume_invitation(uuid,text)` ([20260531000000_consume_invitation_sets_profile_id.sql:76](../supabase/migrations/20260531000000_consume_invitation_sets_profile_id.sql)), `user_stores_brand_match_trg`, `profiles_role_brand_consistent`, `profiles_username_lower_key`.
- Spec 053 lint ([supabase/tests/permissive_policy_lint.test.sql](../supabase/tests/permissive_policy_lint.test.sql)); spec 097 explicit-grant pattern; spec 042 round-4 SECURITY INVOKER trigger pattern ([20260517050000_rls_hardening_followups.sql:196](../supabase/migrations/20260517050000_rls_hardening_followups.sql)).
- **Migration version ordering.** Spec 163's uncommitted migration is `20261008000000_get_profile_emails.sql`, and the latest applied repo migration is `20260829000100`. Because 164 lands in prod first, the architect should pick a version that sorts **between** them (e.g. `20261007000000_…`), so repo order matches prod apply order.
- **Working-tree coordination.** Spec 163's uncommitted edits touch `src/lib/auth.ts` (`fetchAllUsers`, ~596-690). This spec edits `registerInvitedUser` (~472-570). The regions don't overlap. The user may want to commit 163 locally (no push) before the build starts, so the two commits stay separate.

## Project-specific notes
- Cmd UI section / legacy: no Cmd UI section changes. The invite drawer in the Users section and `RegisterScreen` keep their current UI; only `src/lib/auth.ts` `registerInvitedUser` changes. Staff app (`src/screens/staff/`) is untouched, and its sign-in must keep working (AC-H).
- Per-store or admin-global: security-global. The new policies are brand-scoped via `auth_can_see_brand`, and registration derives store links from the invitation. Per-store RLS (`auth_can_see_store`) is unchanged.
- Realtime channels touched: none. No publication change, so the realtime restart gotcha does not apply.
- Migrations needed: yes. One migration covering:
  - the profiles INSERT policy swap
  - the BEFORE INSERT guard trigger and its function
  - the registration RPC and its grants
  - the invitations INSERT/UPDATE policy rewrite

  It is applied to prod via MCP before spec 163's migration.
- Edge functions touched: none.
- Web/native scope: both. `src/lib/auth.ts` is shared. Web ships via Vercel; native needs a new EAS build for in-app registration (see the old-builds item under Open questions resolved).
- Test tracks: pgTAP (primary), jest (`registerInvitedUser`), plus a manual local browser e2e. No shell smoke.
- `app.json` slug: not touched.

## Backend design

### 0. Summary of decisions

| # | Decision | Where |
|---|----------|-------|
| D1 | One migration: `supabase/migrations/20261007000000_profiles_insert_hardening.sql`. It sorts after `20260829000100` and before spec 163's `20261008000000`. | §1 |
| D2 | The profiles INSERT policy is replaced by `"Admins can insert profiles in own brand"`, `to authenticated`, `WITH CHECK (public.auth_is_privileged() and public.auth_can_see_brand(brand_id))`. There is no self-arm. An in-migration assertion fails the apply if any other permissive INSERT/ALL policy remains on `profiles`. | §1.1, §2 |
| D3 | Guard trigger `profiles_insert_role_guard` (BEFORE INSERT) runs function `public.assert_profile_insert_role_allowed()`. The function is SECURITY INVOKER with `search_path = public, auth` pinned. Refusal string (byte-for-byte): **`non-user role inserts require super_admin`**, SQLSTATE `P0001`. | §1.2 |
| D4 | New RPC `public.register_invited_profile() returns uuid`, plpgsql, SECURITY DEFINER, `search_path = public` pinned, every relation schema-qualified. EXECUTE is revoked from `public, anon` and granted to `authenticated`. | §1.3, §3 |
| D5 | The `invitations` INSERT and UPDATE policies (names kept) share one predicate: privileged, role in `('user','admin')`, brand in scope, every store in scope. **UPDATE `USING` is tightened to the same predicate** (architect addition, see §2.3). SELECT and DELETE are untouched. | §1.4, §2 |
| D6 | **Spec correction, testing contract only:** Postgres evaluates RLS `WITH CHECK` *after* BEFORE ROW triggers. Any non-`user`-role INSERT by a non-super_admin `authenticated` caller is therefore refused by the guard with `P0001` before RLS runs. The AC-A arms that expect `42501` for `role='super_admin'` / "any role" get `P0001`. A separate "trigger disabled" arm proves that RLS alone also refuses them with `42501`. | §8 |
| D7 | The RPC binds identity through `auth.users.email WHERE id = auth.uid()` instead of the `auth.email()` JWT claim. The two are semantically equivalent (GoTrue mints the claim from that column). The column read does not depend on the claim being present, which makes pgTAP fixtures simpler. | §3 |
| D8 | The RPC refuses when **more than one** pending invitation matches the caller's email (`multiple pending invitations`). Today `get_pending_invitation` picks one with a nondeterministic `limit 1`. The RPC would be granting a role, so it must fail closed instead of picking arbitrarily. | §3 |
| D9 | Client: `registerInvitedUser` (`src/lib/auth.ts` ~472-570 only) drops `role` from `signUp` `options.data`. It replaces the profile insert, the `user_stores` loop, and the `consume_invitation` call with one `supabase.rpc('register_invited_profile')`. No `db.ts` change. | §5 |
| D10 | Lint: `\b` → `\y` in all 8 regex literals in `permissive_policy_lint.test.sql` (24 occurrences) and both literals in `order_approvals.test.sql`. Add a positive OR-tail arm (5) shaped like the old profiles policy. `plan(4)` → `plan(5)`. | §8.2 |
| D11 | **Existing pgTAP file must change:** `supabase/tests/invitations_super_admin_rls.test.sql` arms (i) and (ii) insert `role='manager'` invitations as admin/super_admin. Under D5 those become `42501`. Change the literal to `'user'`. `'manager'` was never an app-produced invite role (`InviteUserOptions.role: 'admin' \| 'user'`). | §8.3 |

### 1. Data model changes

One additive-plus-policy-swap migration, **`supabase/migrations/20261007000000_profiles_insert_hardening.sql`**, wrapped in `begin; … commit;` (same as `20261008000000_get_profile_emails.sql`). It adds no tables or columns. It drops and recreates one policy on `profiles` and two policies on `invitations`, and creates one trigger function, one trigger, and one RPC.

- **Destructive?** Only the policy drop. Dropping `"Anyone can insert own profile or admin can insert any"` is the fix itself. Its one legitimate caller (client `registerInvitedUser`) moves to the RPC in the same PR. Old cached clients lose registration (accepted, see the Open questions and R1).
- **Encoding:** every `$$ … $$` body must be **pure ASCII**: no `…`, `—`, `─`, or `→` inside function bodies. Spec 163 M1 lesson: the prod normalized-md5 check hashes `pg_get_functiondef`, and non-ASCII bytes risk false mismatches over MCP. Keeping the whole file ASCII is recommended.
- **Header comment** should follow the 163 header shape: purpose, PROD-APPLY note (MCP + `schema_migrations` + md5), realtime note (no publication change), design-authority pointer to this spec.

#### 1.1 Profiles INSERT policy swap

```
drop policy if exists "Anyone can insert own profile or admin can insert any" on public.profiles;
drop policy if exists "Admins can insert profiles in own brand" on public.profiles;   -- idempotency
create policy "Admins can insert profiles in own brand"
  on public.profiles as permissive for insert to authenticated
  with check (public.auth_is_privileged() and public.auth_can_see_brand(brand_id));
comment on policy ... is 'spec 164: privileged + brand-scoped only; no self-arm. Non-super_admin callers are further limited to role=user by profiles_insert_role_guard. Registration goes through register_invited_profile().';
```

**Post-swap assertion** (DO block inside the same transaction, fail-closed). Count `pg_policies where schemaname='public' and tablename='profiles' and permissive='PERMISSIVE' and cmd in ('INSERT','ALL')`. If the count is not 1, `raise exception '164: expected exactly one permissive INSERT/ALL policy on public.profiles, found %'`. This catches dashboard drift in prod (an unknown extra policy would OR the hole back open) at apply time instead of after.

Truth table, derived from existing helper semantics (`auth_can_see_brand(NULL)` is false for a branded admin and true for super_admin):

| Caller | Admitted by RLS |
|--------|-----------------|
| anon / profile-less authenticated / `user` | never |
| admin / master, brand A | rows with `brand_id = A` only (NULL-brand and B refused) |
| super_admin | any row |

#### 1.2 Guard trigger

```
create or replace function public.assert_profile_insert_role_allowed()
returns trigger language plpgsql security invoker set search_path = public, auth as $$
begin
  if current_user in ('authenticated', 'anon')
     and new.role is distinct from 'user'
     and not public.auth_is_super_admin() then
    raise exception 'non-user role inserts require super_admin';
  end if;
  return new;
end $$;

drop trigger if exists profiles_insert_role_guard on public.profiles;
create trigger profiles_insert_role_guard
  before insert on public.profiles
  for each row execute function public.assert_profile_insert_role_allowed();
```

- **SECURITY INVOKER is load-bearing.** It follows the spec 042 round-4 pattern ([20260517050000_rls_hardening_followups.sql:196-245](../supabase/migrations/20260517050000_rls_hardening_followups.sql)). `current_user` resolves as follows:
  - `authenticated` under PostgREST: fires
  - `postgres` in migrations, seed, and pgTAP after `reset role`: skips
  - `service_role`: skips
  - the owner (`postgres`) inside the SECURITY DEFINER RPC: skips. This is how the RPC can write `role='admin'`.
- `auth_is_super_admin()` stays SECURITY DEFINER and reads `profiles.role`, not the JWT, so it cannot be forged.
- **Do not change grants on the trigger function.** No existing trigger function in the repo touches grants, and trigger functions cannot be invoked directly.
- It is the only BEFORE INSERT trigger on `profiles`. The existing `profiles_self_brand_lock` (BEFORE UPDATE), `profiles_self_delete_lock` (BEFORE DELETE), `profiles_sync_role_to_jwt` (AFTER INSERT/UPDATE OF role), and the `profiles_role_brand_consistent` CHECK are untouched.
- **Firing order (drives D6):** BEFORE ROW triggers run first, then RLS `WITH CHECK`, then CHECK/FK/unique constraints, then AFTER triggers. A refused insert never reaches `profiles_sync_role_to_jwt`, so `raw_app_meta_data` cannot change.

#### 1.3 Registration RPC

See §3 for the contract. Implementation notes for the developer:

- `language plpgsql`, `security definer`, `set search_path = public`, `returns uuid`. Do not use `returns table(...)`; plpgsql OUT-param names like `role` and `brand_id` would shadow columns, the same hazard noted in the 163 migration.
- `revoke all on function public.register_invited_profile() from public, anon;` then `grant execute on function public.register_invited_profile() to authenticated;`. Revoking from `public` is load-bearing per the spec 097 default-ACL note in `20261008000000_get_profile_emails.sql:64-71`. service_role keeps its default grant. That is harmless: it has no `auth.uid()`, so it hits refusal R1.
- `comment on function` should state the contract and point at this spec.
- **The owner must be `postgres`** (the table owner of `profiles`, `user_stores`, and `invitations`). Ownership is what lets the function body bypass RLS. If the function were owned by a role that is subject to RLS, the new INSERT policy from §1.1 would refuse the RPC's own profile insert, because the registering caller is not privileged. pgTAP §8.1 arm C-1 proves this locally, and rollout step P-6 confirms it in prod.

#### 1.4 Invitations write policies

Shared predicate **P_INV**. Column references must be qualified with `invitations.` because the inner subquery joins `stores`. An unqualified `brand_id` inside that subquery would bind to `stores.brand_id`, which is a silent logic bug.

```
public.auth_is_privileged()
and invitations.role in ('user', 'admin')
and (invitations.brand_id is null or public.auth_can_see_brand(invitations.brand_id))
and not exists (
  select 1
    from unnest(coalesce(invitations.store_ids, '{}'::text[])) as sid(store_id)
    left join public.stores s on s.id::text = lower(sid.store_id)
   where s.id is null
      or not public.auth_can_see_brand(s.brand_id)
)
```

```
drop policy if exists "Admins can insert invitations" on public.invitations;
create policy "Admins can insert invitations" on public.invitations
  for insert to authenticated with check (P_INV);

drop policy if exists "Admins can update invitations" on public.invitations;
create policy "Admins can update invitations" on public.invitations
  for update to authenticated using (P_INV) with check (P_INV);
```

- **Text comparison (`s.id::text = lower(sid.store_id)`), not `sid::uuid`.** A malformed or unknown store id then fails closed as `42501` instead of throwing `22P02` from inside a policy. `stores` is tiny, so losing the PK index here costs nothing.
- **NULL store element or nonexistent store id: refused.** **Store hidden by `stores` RLS: also refused.** A brand-A admin cannot SELECT brand-B stores (`auth_can_see_store`), so those rows left-join to NULL. Both the explicit `auth_can_see_brand(s.brand_id)` and stores RLS fail closed, so the predicate stays correct if stores SELECT is ever widened.
- `"Admins can read invitations"` and `"Admins can delete invitations"` are **not touched**.
- Brand/store *consistency* (invitation `brand_id = A` with brand-A stores) is **not** added to P_INV. For a branded admin, P_INV already forces both into the caller's brand. For a super_admin, an inconsistent invite fails atomically at registration through `user_stores_brand_match_trg`. Adding it would be a scope expansion.

### 2. RLS impact

| Table | Policy | Change | Helpers |
|-------|--------|--------|---------|
| `profiles` | `"Anyone can insert own profile or admin can insert any"` | **dropped** | n/a |
| `profiles` | `"Admins can insert profiles in own brand"` (INSERT, `to authenticated`) | **new** | `auth_is_privileged()`, `auth_can_see_brand(brand_id)` |
| `profiles` | SELECT / UPDATE / DELETE policies | unchanged | n/a |
| `invitations` | `"Admins can insert invitations"` | WITH CHECK → P_INV | `auth_is_privileged()`, `auth_can_see_brand()` |
| `invitations` | `"Admins can update invitations"` | USING and WITH CHECK → P_INV | same |
| `invitations` | `"Admins can read invitations"`, `"Admins can delete invitations"` | unchanged | `auth_is_privileged()` |
| `user_stores` | all | unchanged (own-row self-write arm is out of scope, see the Out of scope list) | n/a |

2.1 **Permissive-OR check (CLAUDE.md rule).** After the migration, `profiles` has exactly one permissive INSERT policy (asserted in the migration, §1.1). `invitations` has exactly one permissive policy per command, and the recreated policies keep their existing names. Nothing ORs P_INV back open.

2.2 **Lint.** None of the new predicates is trivially wide. Lint arm (1) goes to 0 **without** allowlist rows because the only offender (the old profiles policy) is dropped.

2.3 **Why UPDATE `USING` is also tightened (architect addition).** The spec mandates WITH CHECK only. With USING left at `auth_is_privileged()`, a brand-A admin could still rewrite a brand-B pending invitation *into* brand A. That is not an escalation, but it is a cross-tenant write that costs nothing to close.
- There are **zero** client UPDATE callers. A grep of `src/` and `supabase/functions/` finds only insert, select, and delete on `invitations`.
- The only updaters are the SECURITY DEFINER functions `consume_invitation` and the new RPC, which bypass RLS.
- This mirrors the spec 042 "WITH CHECK mirrors USING" shape on `profiles`. If the user objects, revert USING to `public.auth_is_privileged()`. Nothing else depends on it.

2.4 **`auth_can_see_store()` / per-store RLS** is unaffected.

### 3. API contract

**RPC:** `public.register_invited_profile() returns uuid`. It is called through PostgREST `POST /rest/v1/rpc/register_invited_profile` with body `{}`. The caller must be `authenticated` (the fresh signUp session).

Request: no parameters. Role, brand, username, stores, and id are all derived server-side.

Response: the new profile id (`= auth.uid()`) as a JSON string. The client ignores it; pgTAP asserts it.

**Algorithm (pseudocode, in this order):**
1. `v_uid := auth.uid()`. If null → **R1**.
2. If `exists (select 1 from public.profiles where id = v_uid)` → **R2**. This check comes before the invitation lookup, so a repeat call reports R2 even though its invitation is now `used`.
3. `v_email := lower((select u.email from auth.users u where u.id = v_uid))`. A NULL or empty email leads to R3 in the next step.
4. Pending-set predicate `PEND`: `lower(i.email) = v_email and i.used = false and (i.expires_at is null or i.expires_at > now())`. These are the same predicates as `get_pending_invitation` / `consume_invitation`, except that the stored email is lowercased too, for case-insensitivity on both sides.
   - Count the rows matching `PEND`. If 0 → **R3**. If more than 1 → **R4**.
   - `select … into v_inv from public.invitations i where PEND for update;`. If `not found` (lost a race) → **R3**.
5. If `v_inv.role not in ('user','admin')` → **R5**.
6. If `v_inv.role = 'admin' and v_inv.brand_id is null` → **R6**.
7. Brand: for `role='user'`, `coalesce(v_inv.brand_id, (select s.brand_id from public.stores s where v_inv.store_ids is not null and array_length(v_inv.store_ids,1) >= 1 and s.id = (v_inv.store_ids[1])::uuid))`. This is verbatim the spec 069 `resolved_brand_id` expression from [20260607120000_profiles_username.sql:134-143](../supabase/migrations/20260607120000_profiles_username.sql). For `role='admin'`: `v_inv.brand_id`.
8. Initials, matching the JS `name.split(' ').map(w => w[0]).join('').slice(0,2).toUpperCase()`: `upper(left(coalesce((select string_agg(left(w,1), '' order by ord) from unnest(string_to_array(v_inv.name, ' ')) with ordinality as t(w, ord)), ''), 2))`. `string_to_array(x, ' ')` splits on single spaces exactly as JS `split(' ')` does. Empty words contribute `''`, which matches JS `undefined` inside `join`.
9. `insert into public.profiles (id, name, role, brand_id, username, status, color, initials) values (v_uid, v_inv.name, v_inv.role, v_brand, v_inv.username, 'active', '#378ADD', v_initials);`. The guard trigger skips (`current_user = postgres`). `profiles_sync_role_to_jwt` writes `raw_app_meta_data.role`.
10. `insert into public.user_stores (user_id, store_id) select distinct v_uid, sid::uuid from unnest(coalesce(v_inv.store_ids, '{}'::text[])) as sid where sid is not null;`. `distinct` avoids a PK `(user_id, store_id)` 23505 on duplicate ids. `user_stores_brand_match_trg` still enforces the brand.
11. `update public.invitations set used = true, profile_id = v_uid where id = v_inv.id;`
12. `return v_uid;`

**Refusals.** All use `raise exception '<text>'` → SQLSTATE `P0001` → PostgREST HTTP 400. Strings are byte-for-byte. Every refusal happens before any write, or aborts the whole function, so no refusal leaves a profile, `user_stores` rows, `used=true`, or an `app_metadata` change.

| Code | Condition | Message |
|------|-----------|---------|
| R1 | `auth.uid()` is null | `not authenticated` |
| R2 | caller already has a profile | `profile already exists` |
| R3 | no matching pending invitation (none, used, expired, other email, or lost race) | `no pending invitation` |
| R4 | more than one matching pending invitation | `multiple pending invitations` |
| R5 | `invitation.role not in ('user','admin')` | `invitation role not allowed` |
| R6 | admin invitation with NULL `brand_id` | `admin invitation requires a brand` |

**Downstream failures** propagate unchanged, and the whole function rolls back atomically:
- `user_stores_brand_match` P0001 `cross-brand user_stores assignment rejected…`
- `profiles_username_lower_key` 23505 (username taken since the invite)
- `profiles_role_brand_consistent` 23514
- FK 23503 or cast 22P02 on a bad store id

**Concurrency.** Two simultaneous calls by the same user both pass step 2, and one blocks on `FOR UPDATE`. After the first commits, Postgres re-checks the locked row, sees `used = true`, and the second call gets R3. The profiles PK is the backstop.

`get_pending_invitation(text)` and `consume_invitation(uuid,text)` are **not modified** (signatures, grants, bodies).

### 4. Edge function changes

None. `send-welcome-email` checks that a profile row exists for the caller. That still holds, because the RPC commits before the client fires the email. `supabase/config.toml` is unchanged.

### 5. `src/lib/db.ts` surface and the `src/lib/auth.ts` change

**No `db.ts` change.** The call lives in `src/lib/auth.ts`, a documented `supabase.rpc` carve-out (CLAUDE.md "DB access centralized"). `db.ts:5485` has a comment mentioning `consume_invitation` that is now slightly stale. **Leave it.** `db.ts` carries uncommitted spec 163 edits.

**`registerInvitedUser(email, password, name): Promise<AuthResult>`.** The signature and return shape are unchanged. Edit **only** the function body, roughly lines 471-570. Lines 596-690 (`fetchAllUsers`, spec 163) must not be touched.
1. The `get_pending_invitation` pre-check and its two error strings stay byte-identical.
2. `signUp({ email, password, options: { data: { name: invitation.name } } })`. **`role` is removed.**
3. The `signUpError` and `!authData.user` branches are unchanged.
4. **Replace** the `profiles` insert, the `user_stores` loop, and the `consume_invitation` call with:
   `const { error: regError } = await supabase.rpc('register_invited_profile');`
   `if (regError) return { user: null, error: \`Account created but profile setup failed: ${regError.message}\` };`
5. The welcome email `callEdgeFunction('send-welcome-email', { email, name: invitation.name })` stays, then `return { user: null, error: null }`.
6. Rewrite the in-function comments: drop the spec 012b/069/095 client-side brand and username narrative, and point at the RPC and this spec. The spec 012b pre-check comment stays.

There is no snake_case → camelCase mapping, because the return value is unused. If confirmations are ever enabled and `signUp` returns no session, the RPC runs as anon and fails with `permission denied for function` (anon has no EXECUTE). The user gets the "profile setup failed" string, which fails closed. No extra guard is needed.

### 6. Realtime impact

None. No `supabase_realtime` publication membership changes, so **the `docker restart supabase_realtime_imr-inventory` step does NOT apply.** Profile and `user_stores` inserts made by the RPC replay on whatever channels already carry those tables, the same as the old client inserts.

### 7. Frontend store impact

None. `src/store/useStore.ts` is not touched. Registration runs before any store or slice is initialized, and the optimistic-then-revert / `notifyBackendError` pattern does not apply. `RegisterScreen.tsx` already renders `result.error`, so it needs no change.

### 8. Tests

#### 8.1 New pgTAP file: `supabase/tests/profiles_insert_hardening.test.sql`

Shape: `begin; … rollback;`. Fixture idioms come from [get_profile_emails.test.sql:55-120](../supabase/tests/get_profile_emails.test.sql): `set_config('test.*')` constants, synthetic `auth.users` rows with all token columns `''`, seed admin `1111…` (admin A), manager `2222…` (user A), master `3333…` (master A), and brand A `2a000000-…-0001`.

Additional fixtures:
- synthetic brand B
- one synthetic store per brand (inserts must carry a non-blank `address`, because `stores_address_present` is enforced on INSERT since spec 162)
- one synthetic super_admin (profile `super_admin`, brand NULL)
- **one distinct orphan auth user per arm that inserts or registers** (successful inserts persist within the transaction)
- invitations seeded as `postgres` for the RPC arms

JWT idiom: `set local role authenticated` plus `request.jwt.claims` (`sub`, `role`, `app_metadata`), with `reset role` and cleared claims between principals. **No `set role anon`**, which segfaults CI (spec 067). Anon is covered by catalog checks.

Arms (the developer sets `plan(N)` to the final count; `scripts/test-db.sh` catches mismatches):

**Catalog (as postgres)**
- K-1: exactly 1 permissive `profiles` policy with `cmd in ('INSERT','ALL')`.
- K-2: the normalized `with_check` of that policy does **not** match `auth\.uid\(\) is not null`, and contains both `auth_is_privileged` and `auth_can_see_brand`.
- K-3: trigger `profiles_insert_role_guard` exists on `public.profiles`, is BEFORE INSERT, and is enabled (`tgenabled = 'O'`).
- K-4: `assert_profile_insert_role_allowed` has `prosecdef = false`.
- K-5: its `proconfig` contains `search_path=public, auth`.
- K-6: `has_function('public','register_invited_profile', array[]::text[])`.
- K-7: the RPC has `prosecdef = true`.
- K-8: the RPC's `proconfig` contains `search_path=public`.
- K-9: authenticated has EXECUTE.
- K-10: anon has **no** EXECUTE.
- K-11: PUBLIC has **no** EXECUTE.
- K-12: `profiles_self_brand_lock`, `profiles_self_delete_lock`, and `profiles_sync_role_to_jwt` are all still present, and `profiles_role_brand_consistent` still exists.
- K-13: the `invitations` SELECT and DELETE `qual` is still exactly the normalized `auth_is_privileged()`.

**Section A, profiles INSERT under JWT**

For every arm below, the profile-less caller has JWT `app_metadata = {}`.

| Arm | Caller | Insert | Expected |
|-----|--------|--------|----------|
| A-1 | orphan O1 | own id, `role='user'`, brand NULL | `42501` (RLS) |
| A-2 | O1 | own id, `role='super_admin'`, brand NULL | `P0001` `non-user role inserts require super_admin`. **Spec correction D6:** the guard fires before RLS. |
| A-3 | layered proof. As postgres: `alter table public.profiles disable trigger profiles_insert_role_guard`. Then as O1 | A-2 again | `42501`. Then as postgres: `enable trigger`. Proves RLS alone closes the hole. |
| A-4 | as postgres | n/a | O1's `raw_app_meta_data` unchanged: no `role` key, equal to its fixture value. |
| A-5 | O1 | row for victim O2, `role='user'`, brand A | `42501` |
| A-6 | O1 | row for victim O2, `role='admin'`, brand A | `P0001` (guard) |
| A-7 | as postgres | n/a | O2's `raw_app_meta_data` unchanged. |
| A-8 | manager (`user`, brand A) | orphan, `role='user'`, brand A | `42501` |
| A-9 | admin A | orphan O3, `role='user'`, brand A | lives_ok |
| A-10 | master A | orphan O4, `role='user'`, brand A | lives_ok |
| A-11 | admin A | orphan, `role='user'`, brand B | `42501` |
| A-12 | admin A | orphan, `role='user'`, brand NULL | `42501` |
| A-13 | admin A | orphan, `role='admin'`, brand A | `P0001` (RLS would admit; the guard refuses) |
| A-14 | admin A | `role='master'`, brand A | `P0001` |
| A-15 | admin A | `role='super_admin'`, brand NULL | `P0001` |
| A-16 | super_admin | orphan O5, `role='admin'`, brand B | lives_ok |
| A-17 | as postgres | n/a | O5's `raw_app_meta_data->>'role' = 'admin'` (sync trigger still works). |

**Section B, guard skips**
- B-1: as `postgres` (`reset role`), insert orphan, `role='admin'`, brand A → lives_ok.
- B-2: `set local role service_role` with claims cleared, insert orphan, `role='admin'`, brand A → lives_ok. **Fallback:** if `set role service_role` proves unstable on the CI image (spec 067 class), replace B-2 with a text probe asserting that `pg_get_functiondef` of the guard contains `current_user in ('authenticated', 'anon')`, and record that in the test header.
- B-3: the SECURITY DEFINER RPC skip is proven by C-5 (admin invitation registers with `role='admin'`).

**Section C, RPC.** The caller is the orphan whose `auth.users.email` matches the invitation. Invitations are seeded as postgres.

Success cases:
- C-1: user invitation (brand NULL, `store_ids=[store_A]`, username `reg164u`, name `'mary jane watson'`) → the RPC returns the caller's uid.
- C-2: the profile row equals (role `user`, brand A resolved from the store, name, username `reg164u`, status `active`, color `#378ADD`, initials `MJ`). Use one `is()` over a row-to-text or `results_eq`.
- C-3: `user_stores` for the caller is exactly `{store_A}`.
- C-4: the invitation has `used = true` and `profile_id = caller`, and `raw_app_meta_data->>'role' = 'user'`.
- C-5: admin invitation (brand A, `[store_A]`) → success. The profile has role `admin`, brand A, and `app_metadata.role = 'admin'`.
- C-6: user invitation with explicit brand A → `brand_id = A` (the coalesce first arm).
- C-7: invitation email `Mixed.164@Example.test`, auth email `mixed.164@example.test` → success.

Refusal cases (`throws_ok P0001 <exact message>`):
- C-8: the C-1 caller calls again → `profile already exists`. As postgres: still exactly 1 profile, role `user`, `user_stores` count unchanged.
- C-9: an invitation exists only for a different email → `no pending invitation`.
- C-10: invitation is used → `no pending invitation`.
- C-11: invitation is expired → `no pending invitation`.
- C-12: `role='super_admin'` invitation → `invitation role not allowed`.
- C-13: `role='master'` invitation → `invitation role not allowed`.
- C-14: admin invitation with NULL brand → `admin invitation requires a brand`.
- C-15: two pending invitations for the same email → `multiple pending invitations`.
- C-16: as authenticated with claims cleared → `not authenticated`.

Atomicity and side effects:
- C-17: user invitation with brand A and `store_ids = [store_B]` → `throws_ok` P0001 (message `null` or `throws_like 'cross-brand user_stores assignment rejected%'`).
- C-18 (as postgres, one composite `is()`): for the C-9..C-15 and C-17 orphans, there are 0 profiles and 0 `user_stores` rows; every one of their invitations still has `used = false`; and none of their `raw_app_meta_data` has a `role` key. **C-17 is the proof that the function is a single transaction**: the profile insert in step 9 must be rolled back.

**Section D, invitations under JWT**

| Arm | Caller | Write | Expected |
|-----|--------|-------|----------|
| D-1 | admin A | INSERT user invite, brand A, `[store_A]` | lives_ok |
| D-2 | admin A | INSERT admin invite, brand A | lives_ok |
| D-3 | admin A | INSERT `role='super_admin'` | `42501` |
| D-4 | admin A | INSERT `role='master'`, brand A | `42501` |
| D-5 | admin A | INSERT user, brand B | `42501` |
| D-6 | admin A | INSERT user, brand A, `[store_B]` | `42501` |
| D-7 | admin A | INSERT user, brand NULL, `[store_B]` | `42501` (store arm alone) |
| D-8 | admin A | INSERT user, `['not-a-uuid']` | `42501` (text comparison, not 22P02) |
| D-9 | admin A | UPDATE the D-1 row `set role='super_admin'` | `42501` |
| D-10 | admin A | UPDATE the D-1 row `set store_ids = array[store_B]` | `42501` |
| D-11 | admin A | UPDATE the D-1 row `set brand_id = B` | `42501` |
| D-12 | admin A | UPDATE a brand-B invitation seeded by postgres | 0 rows affected (USING hides it; §2.3) |
| D-13 | super_admin | INSERT user, brand B, `[store_B]` | lives_ok |
| D-14 | super_admin | INSERT admin, brand B | lives_ok |
| D-15 | super_admin | INSERT `role='super_admin'` | `42501` |
| D-16 | super_admin | INSERT `role='master'`, brand B | `42501` |
| D-17 | master A | INSERT user, brand A | lives_ok |
| D-18 | manager (`user`) | INSERT user invite | `42501` |

#### 8.2 `supabase/tests/permissive_policy_lint.test.sql`
- `\b` → `\y` in all 8 regex literals (lines 121-122, 166-167, 248-249, 314-315; three occurrences each: `\bor`, `and\b`, `or\b`). Also update the comments at :41 and :283 and the arm (4) message at :331 (`(?!\\s+and\\y)`).
- New **arm (5), positive OR-tail.** Synthetic table `public.__lint_probe_positive_or_tail` with a permissive **INSERT** policy `with check ((id = auth.uid()) or (auth.uid() is not null))`. Using the WITH CHECK side mirrors the old profiles policy and exercises the `nc` branch, which arms (3)/(4) never touch. Use the same detect → `set_config` → drop → `is(…, 1)` pattern as arm (3). The head-position regex cannot match this predicate (it starts `((id = `), so arm (5) isolates the OR-tail branch. `plan(4)` → `plan(5)`. Update the header "Plan" block.
- **Note for the reviewer:** with `\y` working, arm (4) passes because of the trailing `\s*($|\s+or\y)` anchor. Postgres deparses `auth.uid() is not null and x` as `((auth.uid() IS NOT NULL) AND x)`, so the lookahead `(?!\s+and\y)` sees `)` and never fires. The pass is now meaningful, but the anchor is what does the work. Say so in the arm (4) comment.
- Allowlist: **no new rows.** Arm (1) must be 0 with the migration applied.

#### 8.3 Other pgTAP files
- `supabase/tests/order_approvals.test.sql:416,418`: `\b` → `\y`. The arm still passes; the migration only mentions `auth.uid() IS NOT NULL` in a comment.
- **`supabase/tests/invitations_super_admin_rls.test.sql:74,101`:** `'manager'` → `'user'` in arms (i) and (ii). Arm (iii) is unchanged (still `42501`). Add a header line citing spec 164 P_INV.
- Confirmed unaffected: every other fixture that inserts `profiles` / `invitations` does so as `postgres` before `set local role` or after `reset role`. Checked:
  - `consume_invitation_sets_profile_id`, `staff_brand_id_backfill`, `invitations_brand_id_backfill`, `profiles_username`, `profiles_rls_sweep`, `rls_hardening_followups`, `legacy_permissive_policy_dropout`, `user_stores_brand_match_null_brand`, `get_profile_emails`
  - `seed.sql` (runs as postgres)
- Final grep: `rg '\\b' supabase/tests` must return no regex word-boundary uses.

#### 8.4 jest: rewrite `src/lib/registerInvitedUser.test.ts`
- Mock surface:
  - `rpc` dispatches on the function name: `get_pending_invitation` returns `mockInvitationRow`; `register_invited_profile` returns a per-test `{ data, error }`.
  - `auth.signUp` captures its argument.
  - `auth.getSession` returns no session.
  - `from` is a spy that records the table name and returns permissive builders.
- Cases:
  1. Success: `signUp` is called once with `options.data` deep-equal to `{ name }` (no `role` key). `rpc('register_invited_profile')` is called exactly once, with no args object or `undefined`. `from` is never called with `'profiles'` or `'user_stores'`. `rpc` is never called with `'consume_invitation'`. `result.error === null`.
  2. RPC error `{ message: 'no pending invitation' }` → `result.error === 'Account created but profile setup failed: no pending invitation'`. The welcome email is not sent (`getSession` not called, or spy on `callEdgeFunction` through the module).
  3. Admin invitation with NULL brand → the existing pre-check error. `signUp` and the RPC are **not** called.
  4. No invitation → the existing "No invitation found…" error, and `signUp` is not called.
  5. `signUp` error → its message is returned, and the RPC is not called.
- Delete the spec 069 brand-stamp cases. They move to pgTAP C-2 and C-6. Leave a header note saying so.
- Grep `consume_invitation`, `registerInvitedUser`, and `from('profiles').insert` across `src/` for other pins. `inviteUser.test.ts` only mentions them in comments (verified), so leave it.
- Run the full `npx jest`, `npm run typecheck`, and `npm run typecheck:test` (memory: "Run full jest before commit").

#### 8.5 e2e
`e2e/invite.spec.ts` (master invites a default `user` with no stores) still passes. Brand is NULL or the master's brand, store set is empty, so P_INV admits it. No change.

### 9. Rollout

#### 9.1 Local
- The local `schema_migrations` has drift (163 release proposal: 20260819…, 20260829…, and 20261008… were applied with `psql -f`). `20261007000000` also sorts before the already-applied `20261008000000`. **Apply with `psql -f supabase/migrations/20261007000000_profiles_insert_hardening.sql`**, not `migration up`.
- Then run `scripts/test-db.sh` (all files), the full jest suite, and both typechecks.
- Then the AC-H browser run (`admin@local.test`): invite a user with one store and an admin in the admin's brand, register both, sign in to the correct surfaces, and check `brand_id` / `user_stores`. Also have an existing staff user change language.
- No realtime restart is needed.

#### 9.2 Prod pre-checks (read-only, MCP `execute_sql`, project `ebwnovzzkwhsdxkpyjka`)

Record the results in this spec's review notes.

- **P-1 (AC-R1a):** the three triage queries. They are: privileged profiles; `profiles.role` vs `auth.users.raw_app_meta_data->>'role'` drift; and `select policyname, cmd, permissive, roles, with_check from pg_policies where schemaname='public' and tablename='profiles'`. The last one must show only the expected policies, with exactly one permissive INSERT/ALL.
- **P-2 (AC-R1b):** `select tgname, tgenabled, pg_get_triggerdef(oid) from pg_trigger where tgrelid = 'auth.users'::regclass and not tgisinternal;`. **Stop** if any trigger inserts into `public.profiles`. Such a trigger would make the RPC hit R2 on every registration.
- **P-3 (AC-R1c):**
  - `select role, used, count(*) from public.invitations group by 1,2;`
  - pending, unexpired rows: `id, lower(email), role, brand_id, store_ids`, plus the brand of every store id (`unnest` + left join `stores`)
  - flag any role outside `('user','admin')`, any admin with NULL brand, any store whose brand differs from `coalesce(brand_id, brand of store_ids[1])`, any unknown store id, and any email with more than one pending row (R4)
  - also `select count(*) from public.brands where deleted_at is null`. With one live brand, no legacy cross-brand forgery is possible. With more, the owner eyeballs each pending invite, because invitations carry no creator column and legacy rows cannot be machine-verified.
  - Any flagged row must be deleted or re-issued by the owner **before** apply, or that invitee will be stranded.
- **P-4 (AC-R1d):** `select p.id, p.role, p.created_at from public.profiles p where p.created_at > '2026-05-31' and not exists (select 1 from public.invitations i where i.profile_id = p.id) order by 3;`. **Stop** and surface if any row cannot be explained (unknown insert path, e.g. the customer PWA).
- **P-5:** `select tablename, policyname, cmd, qual, with_check from pg_policies where schemaname='public' and tablename='invitations';` must match the repo's 20260514150000 shape (no dashboard drift).
- **P-6:** `select current_user;` must be `postgres`. `select tablename, tableowner from pg_tables where schemaname='public' and tablename in ('profiles','user_stores','invitations');` must all be owned by `postgres`. `select to_regprocedure('public.register_invited_profile()')` must be NULL (not already present).

#### 9.3 Prod apply (AC-R2), in order, only after P-1..P-6 are clean and the user approves
1. `execute_sql` with the exact migration file body (it contains `begin`/`commit`).
2. `insert into supabase_migrations.schema_migrations (version, name) values ('20261007000000', 'profiles_insert_hardening');`. Use the column set the established MCP runbook uses (memory: "Prod migration via MCP").
3. Normalized-md5 of `pg_get_functiondef` for `public.register_invited_profile()` and `public.assert_profile_insert_role_allowed()` must equal the local values (run the same query locally).
4. The `pg_policies` text for the `profiles` INSERT and the `invitations` INSERT/UPDATE (qual and with_check) must equal the local output byte-for-byte.
5. `has_function_privilege('anon','public.register_invited_profile()','EXECUTE') = false`, the same for `public`, and `= true` for `authenticated`. `proowner::regrole = postgres`. `prosecdef = true`. Trigger `profiles_insert_role_guard` is present with `tgenabled = 'O'`.
6. Re-run P-1 and confirm nothing changed.
7. *Optional, needs user OK (rolled-back write attempt):*
   ```
   begin;
   set local role authenticated;
   select set_config('request.jwt.claims', '{"sub":"<an existing staff uid>","role":"authenticated"}', true);
   insert into public.profiles (id, name, role) values (gen_random_uuid(), 'probe', 'user');
   rollback;
   ```
   Expect `42501` (RLS fires before the FK check). Repeat with `role = 'super_admin'` and expect `P0001`.
8. `notify pgrst, 'reload schema';` only if the first client call returns `PGRST202`.

#### 9.4 Push and deploy (AC-R3/R4)

The user commits and pushes, then Vercel deploys the new `registerInvitedUser`. After the push, check the latest `test.yml` **and** `db-migrations-applied.yml` runs on `main` (plus `e2e.yml`, manually). Recommended post-deploy check (user's call, because it creates a real auth user): invite a throwaway email in prod, register it on web, confirm the profile, `brand_id`, and `user_stores`, then delete it via Users & access.

#### 9.5 Commit topology vs spec 163 (decision for the user, raise at release)

The working tree holds uncommitted 163 changes in `src/lib/auth.ts` and `db.ts`, and 164 edits `auth.ts` too.
- **(a)** If 163 is committed locally first and 164 on top, one push ships both migrations. Both `20261007000000` **and** `20261008000000` must then be in prod before the push, applied in that order, or `db-migrations-applied` goes red.
  - That satisfies the security half of AC-R4 (164's migration is in prod before 163's).
  - The client half ("164 client deployed before 163 migration applied") would not hold. It is **not security-load-bearing**: the fix is entirely server-side, and the client change only keeps registration working.
- **(b)** Commit 164 alone first using `git add -p` hunks on `auth.ts`, push, then do 163 later. This satisfies AC-R4 literally.

Either is acceptable from an architecture standpoint.

### 10. Risks and tradeoffs

- **R1: old clients break registration (accepted by the PM).**
  - From apply until Vercel deploy (and indefinitely on old native builds), the old client's direct insert gets `42501`. The user sees "Account created but profile setup failed", leaving an orphan auth user.
  - **That invitee is stuck.** On a retry the new client's `signUp` fails with "User already registered", and nothing else calls the RPC.
  - **Runbook:** an admin deletes the auth-only user via Users & access (`delete-user` supports auth-only users). The invitation survives, because it is still `used = false` with the sentinel `profile_id`. The invitee then re-registers on an updated client.
  - Keep the apply-to-deploy window short. P-3 lists who could be hit.
  - *Possible follow-up (not in scope):* on "User already registered", `registerInvitedUser` could `signInWithPassword` and then call the RPC. The RPC is already idempotent-safe (R2).
- **R2: error-code precedence (D6).** For non-`user` roles the guard's `P0001` shows up instead of `42501`. Both are refusals. The tests pin the actual order, and arm A-3 separately proves RLS alone suffices. Message strings are contract; do not reword them.
- **R3: legacy pending invitations are trusted as-is.** Invitations written before this migration under the loose policy have no creator column, so they cannot be re-validated. R5/R6 still refuse bad roles and brandless admins at redeem time. Cross-brand legacy rows are covered by P-3 (brand count plus owner review).
- **R4: RPC owner and RLS.** If the RPC were owned by a non-owner, non-BYPASSRLS role, the new INSERT policy would refuse the RPC itself and break all registration. Mitigated by C-1 locally and by P-6 and step 5 in prod.
- **R5: `stores` RLS inside P_INV.** Fails closed in both directions (hidden store → refused). A future widening of stores SELECT is still covered by the explicit `auth_can_see_brand(s.brand_id)`.
- **R6: the lint becomes live.** Any future OR-tail-wide policy turns CI red, which is the intent. The auditor saw exactly one live offender locally (the policy being dropped). The developer must confirm arm (1) = 0 after the migration, with no allowlist growth.
- **R7: migration ordering.** `20261007000000` sorts before the uncommitted `20261008000000`. Neither depends on the other. On a fresh CI database they apply in filename order. Locally, use `psql -f` (§9.1).
- **R8: stale JWT after registration.** The signUp session's JWT has no `app_metadata.role` until refresh, so a newly registered admin has no `auth_is_admin()` until the next sign-in or refresh. This is identical to today, and `RegisterScreen` routes to Login, which mints a fresh token.
- **R9: performance.** Negligible. The RPC does a handful of PK lookups and one small `invitations` scan (`lower(email)` cannot use `idx_invitations_email_used`, but the table has tens of rows). P_INV runs only on admin invite writes. There is no effect on the 286 KB seed or on hot read paths.
- **R10: edge cold start.** Not applicable (no edge function).
- **R11: `auth.users.email` vs the `auth.email()` claim (D7).** Equivalent for a GoTrue-issued session. If a future spec allows email changes, both move together after refresh. Noted so reviewers do not read it as drift from AC-C.
- **R12: duplicate pending invitations (D8).** A legitimate invitee with two pending rows is refused until an admin deletes one. `inviteUser` already blocks duplicates client-side, so this should be rare. P-3 checks prod.

### 11. Expected files changed

- `supabase/migrations/20261007000000_profiles_insert_hardening.sql` (new)
- `supabase/tests/profiles_insert_hardening.test.sql` (new)
- `supabase/tests/permissive_policy_lint.test.sql` (`\y` fix, arm 5, `plan(5)`)
- `supabase/tests/order_approvals.test.sql` (`\y` fix, lines 416 and 418)
- `supabase/tests/invitations_super_admin_rls.test.sql` (`'manager'` → `'user'`)
- `src/lib/auth.ts` (`registerInvitedUser` body only, ~471-570)
- `src/lib/registerInvitedUser.test.ts` (rewrite)
- **Not changed:**
  - `src/lib/db.ts`, `src/store/useStore.ts`, `src/screens/RegisterScreen.tsx`
  - every edge function, `supabase/config.toml`
  - `get_pending_invitation`, `consume_invitation`, `sync_role_to_app_metadata`
  - `app.json`
  - the spec 163 regions of `auth.ts` (596-690) and `db.ts`

## Implementation notes (backend-developer)

Implemented per the Backend design §0–§11. No design deviations. Small points for reviewers:

- **Migration** `20261007000000_profiles_insert_hardening.sql` is ASCII-only (checked with `LC_ALL=C grep '[^ -~]'`). Applied locally with `psql` (stdin of the file, `ON_ERROR_STOP=1`), not `migration up`. The in-migration assertion found exactly 1 permissive INSERT/ALL policy on `profiles`.
- **RPC, two fail-closed details inside the design's wording:**
  - Step 3 ("NULL or empty email leads to R3"): implemented as an explicit `if coalesce(v_email,'') = '' then raise 'no pending invitation'`, so an empty auth email can never match a blank-email invitation row.
  - Step 5: `v_inv.role is null or v_inv.role not in ('user','admin')`. `invitations.role` is NOT NULL, so the extra `is null` check never fires; it only keeps the check correct if that ever changes.
- **Policy roles:** the recreated `invitations` INSERT/UPDATE policies are `to authenticated`, as in the §1.4 SQL. The old ones were `to public`. Anon could never pass `auth_is_privileged()`, so behavior doesn't change.
- **pgTAP** `profiles_insert_hardening.test.sql` had `plan(71)` at first review; it is now `plan(73)` after the pre-apply fixes below added K-14/K-15. It covers every arm in §8.1:
  - K-1..K-13 (plus K-14/K-15, pre-apply fix 1)
  - A-1..A-17
  - B-1, B-2. B-2 uses the primary `set local role service_role` option; it is stable locally, so the fallback was not needed. B-3 is proven by C-5.
  - C-1..C-18. C-5, C-6 and C-8 each carry two assertions.
  - D-1..D-18
  - K-7 also asserts `proowner = postgres` (R4).
- **C-17 caveat:** pgTAP's `throws_*` runs the statement inside an exception subtransaction, so the rollback C-18 observes is statement-level. The function has no exception handler that could swallow the error. In production the same error aborts the whole PostgREST request transaction.
- **Lint:** all 24 regex `\b` occurrences, plus the 3 comment/message mentions, are now `\y`. New prose that talks about the old bug says "backslash-b", so `grep '\\b' supabase/tests` returns nothing. Arm (5) was added and plan is now 5. Sanity check: inside a rolled-back transaction I recreated the old profiles policy, and the fixed OR-tail regex flagged exactly that one policy. With the migration applied, arm (1) = 0 and the allowlist has no new rows.
- **Local REST smoke (curl against local GoTrue + PostgREST, cleaned up afterwards):**
  - The old client's direct self-insert now gets `P0001 non-user role inserts require super_admin` for `role=super_admin`, and `42501` for `role=user`.
  - anon calling the RPC gets `42501 permission denied for function register_invited_profile`.
  - The RPC with no invitation gets `no pending invitation`.
  - With a seeded staff invite (one store, brand NULL) the RPC returns the uid. The result was: profile `user` / brand A (resolved from the store) / username / initials `SS`; `app_metadata.role=user`; `user_stores = {Towson}`; invitation `used=true` with `profile_id` linked.
  - A repeat call gets `profile already exists`.
- **Verification run:**
  - `scripts/test-db.sh`: 87/87 files pass (baseline before the change: 86/86).
  - `npx jest`: 219 suites / 2524 tests pass.
  - `npx tsc --noEmit -p .`: exit 0.
  - `npm run typecheck:test`: exit 0.
- **Follow-up (originally out of scope):** some comments outside `registerInvitedUser` in `src/lib/auth.ts` still described the old client-side stamping (lines ~357, ~379, ~441-450). These are fixed now, in pre-apply fix 4 below. The `db.ts:5485` `consume_invitation` comment is still untouched, because `db.ts` carries spec 163 edits.

### Pre-apply fixes (backend-developer, 2026-10-08, per `reviews/release-proposal.md` section (a))

1. **Architect S1, invitations policy-count assertion.**
   - Added a fail-closed DO block to `20261007000000_profiles_insert_hardening.sql`, placed after the two `invitations` `create policy` statements and before `commit`.
   - It requires `count(*) = 1` of permissive `invitations` policies with `cmd in ('INSERT','ALL')`, and the same for `cmd in ('UPDATE','ALL')`. Otherwise it raises `164: expected exactly one permissive INSERT/ALL|UPDATE/ALL policy on public.invitations, found %`.
   - The header step 4 now mentions it. No function body or policy text changed. The file is still pure ASCII (`LC_ALL=C grep` count 0).
   - pgTAP K-14/K-15 mirror the two counts, and `plan(71)` became `plan(73)`.
   - Re-applied locally with `docker exec -i ... psql -v ON_ERROR_STOP=1 < <file>`. The file is re-runnable: all drops use `if exists`, functions use `create or replace`, and the trigger is dropped and recreated. It ran clean to COMMIT. `migration up` was not used.
   - Negative probe, rolled back: I added an extra permissive INSERT, UPDATE, or ALL policy on `invitations` and ran the new block against each. INSERT raised the INSERT/ALL message, UPDATE raised the UPDATE/ALL message, and ALL raised on the first (INSERT/ALL) check. Afterwards `invitations` still had its 4 original policies.
2. **`invitations_super_admin_rls.test.sql` arm (iii):** `'manager'` became `'user'`, so its 42501 now comes only from the caller not being privileged. The header note was updated to match.
3. **`order_approvals.test.sql:416,418`:** the OR-tail regex is now the canonical one from `permissive_policy_lint.test.sql:132-133`, which has the `(?!\s+and\y)` lookahead and the trailing `\s*($|\s+or\y)` anchor.
4. **Stale comments, comment-only.**
   - `src/lib/auth.ts`: the `InviteUserOptions` JSDoc header (~357), the `username` field doc (~379), the `brand_id` and `username` insert comments in `inviteUser` (~441-452), and the spec 012b pre-check in `registerInvitedUser` (now "refused server-side (register_invited_profile() R6, spec 164) after signUp, leaving an orphan auth user").
   - `src/lib/inviteUser.test.ts:23` now points at pgTAP `profiles_insert_hardening.test.sql` C-2/C-6.
   - Not touched: `auth.ts` from `fetchAllUsers` on (the spec 163 region), the line-5 import hunk, and `db.ts`.
   - Left as is: the `inviteUser` pre-flight comment at ~390 ("would fail the profiles_role_brand_consistent CHECK at registration time"). It is not a "client writes profiles" comment and was not in the fix list. The server-side refusal is now R6 rather than the CHECK, but the client-side guard it describes is still correct.
   - `src/lib/auth.signIn.test.ts` belongs to spec 163, not 164, and is not listed below.
5. **Invite-drawer gap (AC-D):** `npx playwright test e2e/invite.spec.ts` against the migrated local stack passed 4/4 (3 auth setup steps plus the invite spec). It reused the running Expo web server on :8081, which points at `127.0.0.1:54321`.
   - The drawer, run as `master@local.test`, wrote `role=user, brand_id=NULL, store_ids={}` through P_INV, and the row rendered in the Users list.
   - **Still not exercised through the real client:** an `admin`-role invite, or a store-scoped one. The e2e spec only drives the default `user` chip with no stores. pgTAP D-1..D-18 covers those P_INV branches.
   - The e2e leaves its uniquified invitation row behind (`e2e-invite+<runId>@local.test`, unused). That is the existing behavior of the spec.
6. **Re-verification, against the full working tree including the uncommitted spec 163 hunks; not a staged-only tree:**
   - `scripts/test-db.sh`: 87/87 files. `profiles_insert_hardening` 73/73, `invitations_super_admin_rls` 4/4, `order_approvals` 24/24, `permissive_policy_lint` 5/5.
   - `npx jest`: 219 suites / 2524 tests.
   - `npx tsc --noEmit -p .`: exit 0.
   - `npm run typecheck:test`: exit 0.
7. **Post-S1 local reference values for §9.3 steps 3-4.** These were captured after the re-apply and are unchanged in substance, because no function body or policy text moved.
   - Normalized md5, using `md5(lower(regexp_replace(regexp_replace(pg_get_functiondef(oid), '--[^\n]*','','g'),'\s+',' ','g')))`:
     - `assert_profile_insert_role_allowed()` = `971068c69bff76c5a1bfaf098562a49a`
     - `register_invited_profile()` = `24b000aeb6b81f81ef8b1cde71b52946`
   - `pg_policies` raw-text md5 (`md5(coalesce(qual,''))` / `md5(coalesce(with_check,''))`):
     - profiles INSERT `Admins can insert profiles in own brand`: qual empty / with_check `16d876800d95eee62382b132c539855f`
     - invitations INSERT `Admins can insert invitations`: qual empty / with_check `3268a0d69b6f17404d09cdba09ec492b`
     - invitations UPDATE `Admins can update invitations`: qual and with_check both `3268a0d69b6f17404d09cdba09ec492b`

### AC-H browser check: PASS (main Claude, 2026-10-08, local stack)

Result, run against the local stack with the 164 migration applied:
- Seeded the staff invite (Towson, NULL brand, username `achstaff`) and the admin invite (brand A) via SQL. Registered both through the web Register screen; both showed "Registration successful!".
- The verify query matched expectations exactly. Staff: `user` / brand A / `achstaff` / jwt_role `user` / stores `{0000...0001}` / used. Admin: `admin` / brand A / no stores / jwt_role `admin` / used.
- Signed in as staff by email: landed in the StaffStack EOD app (Towson). Signed in as admin: landed in the admin StoreGate (2AM PROJECT).
- Existing staff `manager@local.test` changed language EN -> ES: `profiles.locale` = `es`. Set back to `en` afterwards.
- Cleanup SQL run; 0 orphan profiles left.
- Not covered: signing in by username (`achstaff`) failed locally because `username-resolve` returned 401 "invalid service token". The local edge runtime's service token doesn't match the app env. Spec 164 doesn't touch username-resolve or the login path, so this is a local environment issue and not a 164 regression.
- Not covered: the invite drawer UI path (invites were seeded via SQL); the P_INV policy is covered by pgTAP D-1..D-18.

- Invite drawer (after pre-apply fixes), signed in as `master@local.test` (brand A): a store-user invite with Towson + Charles was saved as `user` / brand A / both stores, and an Admin invite was saved as `admin` / brand A / no stores. Both showed "Invitation sent". Test rows deleted afterwards. Together with `e2e/invite.spec.ts` (4/4, run by the developer) this closes the invite-drawer gap from the release proposal.

#### Original recipe

Not run by the backend developer (no browser tools). Recipe for the local stack (`npm run dev:db`, admin `admin@local.test` / `password`):

1. Either use the Cmd UI invite drawer (Users & access → Invite) as `admin@local.test`, or seed invites directly as postgres:
   ```
   docker exec -i supabase_db_imr-inventory psql -U postgres -c "
     insert into public.invitations (email, name, role, store_ids, brand_id, username, profile_id) values
       ('ach-staff@local.test', 'ACH Staff', 'user',  array['00000000-0000-0000-0000-000000000001'], null, 'achstaff', '00000000-0000-0000-0000-000000000000'),
       ('ach-admin@local.test', 'ACH Admin', 'admin', array[]::text[], '2a000000-0000-0000-0000-000000000001', null, '00000000-0000-0000-0000-000000000000');"
   ```
   (Store `00000000-…-0001` is Towson, brand A `2a000000-…-0001`.) Using the UI drawer also exercises the new `invitations` INSERT policy (P_INV).
2. Register each via the Register screen (any password ≥ the screen's minimum), then sign in. Staff should land in the StaffStack EOD app; admin in the Cmd UI.
3. Verify:
   ```
   docker exec -i supabase_db_imr-inventory psql -U postgres -c "
     select u.email, p.role, p.brand_id, p.username, u.raw_app_meta_data->>'role' as jwt_role,
            (select array_agg(store_id) from public.user_stores us where us.user_id = p.id) as stores,
            (select used from public.invitations i where lower(i.email) = u.email) as inv_used
       from auth.users u join public.profiles p on p.id = u.id
      where u.email like 'ach-%@local.test';"
   ```
   Expected: staff = `user` / brand A / `achstaff` / stores `{0000…0001}` / used; admin = `admin` / brand A / no stores / used.
4. Existing staff: sign in as `manager@local.test` / `password` and change language (profile UPDATE path).
5. Cleanup: `delete from public.invitations where email like 'ach-%@local.test'; delete from auth.users where email like 'ach-%@local.test';` (as postgres).

## Files changed

**Migrations**
- `supabase/migrations/20261007000000_profiles_insert_hardening.sql` (new): profiles INSERT policy swap plus fail-closed assertion, `assert_profile_insert_role_allowed()` with the `profiles_insert_role_guard` trigger, the `register_invited_profile()` RPC with grants, the `invitations` INSERT/UPDATE P_INV policies, and (pre-apply fix 1) the fail-closed `invitations` INSERT/ALL + UPDATE/ALL policy-count assertion

**pgTAP tests**
- `supabase/tests/profiles_insert_hardening.test.sql` (new, plan 73; K-14/K-15 added in pre-apply fix 1)
- `supabase/tests/permissive_policy_lint.test.sql` (`\b` → `\y`, arm 5 positive OR-tail, plan 5, header/arm-4 comments)
- `supabase/tests/order_approvals.test.sql` (`\b` → `\y`, lines 416/418; pre-apply fix 3: OR-tail regex now the canonical lookahead + trailing-anchor form)
- `supabase/tests/invitations_super_admin_rls.test.sql` (`'manager'` → `'user'` in arms i/ii/iii, header note; arm iii in pre-apply fix 2)

**Client (`src/lib/auth.ts`)**
- `src/lib/auth.ts`: `registerInvitedUser` body (signUp without `role`; one `rpc('register_invited_profile')` replaces the profile insert, the user_stores loop, and `consume_invitation`), plus comment-only rewording in `InviteUserOptions` / `inviteUser` / the `registerInvitedUser` 012b pre-check (pre-apply fix 4). Spec 163's hunks (line-5 import, `fetchAllUsers` region) are not part of 164.

**jest**
- `src/lib/registerInvitedUser.test.ts` (rewritten to the spec 164 contract; spec 069 brand-stamp cases moved to pgTAP C-2/C-6)
- `src/lib/inviteUser.test.ts` (comment-only, header now points at pgTAP C-2/C-6; pre-apply fix 4)

**Spec**
- `specs/164-profiles-insert-hardening.md` (this file)

**Not changed:** `src/lib/db.ts`, `src/store/useStore.ts`, `src/screens/RegisterScreen.tsx`, edge functions, `supabase/config.toml`, `get_pending_invitation`, `consume_invitation`, `sync_role_to_app_metadata`, `app.json`, and spec 163's regions of `auth.ts` / `db.ts`.
