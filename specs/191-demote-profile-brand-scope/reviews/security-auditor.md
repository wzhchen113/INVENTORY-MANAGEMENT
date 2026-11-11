## Security audit for spec 191

Auditor: security-auditor, 2026-11-09. Scope: `supabase/migrations/20261109191000_demote_profile_brand_scope.sql`, `supabase/tests/demote_profile_brand_scope.test.sql` (new), the edits to `supabase/tests/profiles_insert_hardening.test.sql`, and Arm 7b in `scripts/smoke-edge-roles.sh`. Background read: 164 audit (H2, M2), 187 audit (H2), 195 audit (H1, M1).

### What I ran, read and simulated

**Ran** on `supabase_db_imr-inventory` (191 and 195 already applied locally):
- **One probe script (P1 to P19)** in a single transaction ending in `ROLLBACK`. Each arm used a savepoint plus `set local role authenticated|anon|service_role` and `request.jwt.claims`. Afterwards there were 0 probe brands, auth users and invitations, and the seed `1111/2222/3333` rows were unchanged.
- **Seven two-session races (R1 to R7)** in a throwaway database `sec191probe`. It was a schema-only `pg_dump` of `public`, `auth` and `extensions` on the same server. I checked that the six relevant function md5s and the four `profiles` triggers matched the shared DB. A third session read `pg_stat_activity` while the second session was blocked. The database was **dropped** afterwards.
- **Catalog queries:** function posture and ACLs, `profiles`/`invitations` policies, triggers and constraints, every advisory-lock user in the DB, schema CREATE privileges, and role timeouts.
- **pgTAP, run directly with psql (each file is begin/rollback):**
  - `demote_profile_brand_scope` 54/54
  - `profiles_insert_hardening` 79/79
  - `demote_self_guard` 6/6
  - `delete_last_privileged_guard` 4/4
- **Live md5s** match the developer's figures: RPC `ceda99fa`, trigger fn `1ce30998`, helper `7b8fd913`, wrapper `2cea0747`, and `assert_not_last_of_role` still `0638c51b`.

**Read only:**
- `delete-user` and `manage-store-user`, plus the role gates of the other edge functions
- `register_invited_profile`
- the smoke arm

**Not run:**
- `scripts/smoke-edge-roles.sh`, as instructed. So the 42501 to HTTP 403 mapping (F3) is still unverified.
- No real HTTP, GoTrue or pg_graphql call.
- No prod.

**Simulated:**
- GoTrue sign-up, as an `auth.users` INSERT with `''` token columns.
- PostgREST callers, as `set local role` plus claims.

---

### Critical (BLOCKS merge)

None.

### High (must fix before deploy)

None in 191's diff. The pre-existing 195-H1 is unchanged by 191 (see "195 H1 / M1" below). It stays High in its own track and does not block 191.

### Medium

**M1. A demoted admin can come back as a durable brand admin through an admin invitation they set up before the demotion. The invitation can be set never to expire, and it records no inviter. Pre-existing, outside the diff, but it limits what 191's user story actually gives. [ran P18]**
- **Where:**
  - P_INV in `supabase/migrations/20261109191000_demote_profile_brand_scope.sql:462-473` and `:485-508` constrains role, brand and stores, but not `expires_at` or `used`.
  - `public.invitations` has no inviter column. `profile_id` is a placeholder until consume (`src/lib/auth.ts:441`).
  - `register_invited_profile()` treats `expires_at is null` as "never expires" and does not re-check who created the invitation.
- **What I ran:**
  1. Brand-A admin `1111` inserted `(role='admin', brand_id=A, expires_at=NULL)` and then UPDATEd it to `expires_at='2099-01-01'`. Both were admitted.
  2. A super_admin demoted `1111` through the new RPC, which succeeded.
  3. A fresh account with the invitation's email called `register_invited_profile()`. It got `role=admin, brand_id=A`, with `raw_app_meta_data.role='admin'` synced.
- **Why it matters here:** 191 delivers "a demoted admin's still-valid **token** can't mint a new admin" (confirmed, P17). It does not deliver "a demotion takes away the ability to mint admins". The super_admin also can't find which pending invitations the demoted admin created.
  - Combined with 164-M1 (open sign-up without confirmation), the email doesn't even need to be the admin's own. It only needs to be one they can sign up with.
- **Fix (follow-up spec):**
  - (a) Add `expires_at is not null and expires_at <= now() + interval '7 days'` (or similar) to the P_INV WITH CHECK.
  - (b) Add `invited_by uuid not null default auth.uid()`.
  - (c) Then pick one:
    - `demote_profile_to_user` (and `delete-user`) void the target's pending invitations, or
    - `register_invited_profile` refuses when `invited_by`'s current `profiles.role` is no longer privileged in that brand.

### Low

**L1. Any authenticated caller can run `assert_demote_not_last_of_role` directly. It takes the role advisory lock and answers a last-of-role oracle. [ran P14, P15]**
- **Where:** migration `:167-209` (SECURITY INVOKER, EXECUTE to `authenticated`).
- **What I ran:** the seed staff user `2222` (profile `user`, so `auth_profile_is_privileged()` = false) called the wrapper:
  - With a random uuid: it held the `last_of_role:master` advisory lock (`pg_locks` count 1).
  - With `3333`: it got `cannot demote the last master`.
- This contradicts design 1.3(d), "Unprivileged callers never take locks". That claim holds only for the RPC.
- **Why it is only Low:**
  - The lock lives for one PostgREST transaction.
  - `authenticator` has `lock_timeout=8s` and `statement_timeout=8s`, so a waiting demotion fails closed instead of hanging.
  - The oracle already exists through `assert_not_last_of_role` (L3).
- **Fix (cheap):** start the wrapper with `if not public.auth_profile_is_privileged() then raise exception using errcode='42501', message='forbidden'; end if;`. Both legitimate callers pass it: the RPC's `auth.uid()` is the privileged caller, and the trigger branch runs only for super_admins. Add a pgTAP arm for a staff caller expecting 42501 and no advisory lock.

**L2. Existence and role oracle in the RPC, as the spec accepted. [ran P1, P2, P19]**
- A brand admin can tell these apart:
  - P0002 `target profile not found`
  - `forbidden: only a super_admin can demote a super_admin`, which identifies **the owner's uuid** as a super_admin
  - `forbidden: target is in a different brand`
- Step 4 also row-locks the foreign target (`for no key update`) before steps 6 and 7 refuse. That lock lasts microseconds, so it is only a curiosity.
- UUIDs come from store-scoped rows such as `audit_log.user_id` and approvals, so harvesting is possible but low value.
- Accept as designed, or move step 6 after step 7 and fold a missing target into the brand refusal for admin/master callers. That would change A2/A6, so it is a spec decision.

**L3 (pre-existing, not 191's): `assert_not_last_of_role(uuid,text)` is EXECUTE to `anon` and PUBLIC. [ran P16]**
- ACL is `{=X/postgres, anon=X/postgres, …}`.
- anon got `cannot delete the last master` for `3333`, and no error for `1111`. That is an unauthenticated "is this uuid the sole master or super_admin" oracle over `/rest/v1/rpc`.
- **Fix:** `revoke execute … from public, anon`. `delete-user` calls it as `service_role`, and the 191 wrapper (INVOKER) needs only `authenticated`.

**L4 (recorded follow-up): `delete-user` races the new locks. [read]**
- `supabase/functions/delete-user/index.ts:492` calls `assert_not_last_of_role` in its own transaction, without the role advisory lock, and then deletes in later requests.
- So a `delete-user` of master M1, run at the same moment as an RPC or PATCH demotion of master M2, can still leave 0 masters. It needs two privileged operators acting together.
- The spec already lists this as a follow-up. It is the one remaining route to "0 of a role" outside `postgres`/`service_role`.

**L5 (design note): the last-of-role count is global, not per brand. [read]**
- A same-brand admin may demote their brand's only master as long as another brand has one (A4, out-of-scope "role hierarchy").
- The brand is left without a master, but a super_admin can recover it with a PATCH promotion. Accepted, and it matches `delete-user`.

---

### Try-to-break results

**Cross-brand, super_admin targets, last-of-role and self, on every route. All refused unless the action is legitimate:**

| Route | Probe | Result |
|---|---|---|
| RPC | brand-B admin demotes brand-A admin (P1) | 42501 `forbidden: target is in a different brand` [ran] |
| RPC | admin with a forged `super_admin` claim demotes a super_admin (P2) | 42501 `only a super_admin can demote a super_admin` [ran] |
| RPC | staff with a stale `admin` claim (P3); a demoted super_admin with a `super_admin` claim (P13) | 42501 `forbidden` [ran] |
| RPC | null target (P19) | P0002 [ran] |
| RPC | `service_role` (P19) | `cannot demote self`; anon gets permission denied (P16) [ran] |
| PATCH `profiles` | admin sets a super_admin's role (P4) | 0 rows (RLS) [ran] |
| PATCH `profiles` | admin sets a same-brand master's role (P5) | `role changes require super_admin` [ran] |
| PATCH `profiles` | super_admin on own row (P8) | `cannot demote self` [ran] |
| PATCH `profiles` | super_admin on the last master (P10, P11) | `cannot demote the last master` [ran] |
| Upsert `on conflict do update` | admin on a super_admin (P6) | RLS USING error [ran] |
| Upsert `on conflict do update` | admin on a master (P7) | `role changes require super_admin` [ran] |
| Upsert `on conflict do update` | super_admin on self (P9) | `cannot demote self` [ran] |
| Upsert `on conflict do update` | super_admin on the last master (P10) | `cannot demote the last master` [ran] |
| Invitations | role whitelist `user`/`admin`, so no invitation can mint a super_admin or master | [read, live policy text] |
| Invitations | stale claim INSERT (P17) | 42501 [ran] |
| `register_invited_profile` | needs no caller privilege; authority is the invitation | see M1 [ran P18] |
| `manage-store-user` | role is the literal `'user'` (`:427-431`); caller gate is `auth.getUser()` (DB-fresh) | [read] |
| `delete-user` | brand gate refuses an admin targeting a NULL-brand super_admin; self guard and last-of-role run before deletes (`:426`, `:446`, `:492` → `:509`) | race in L4 [read] |
| Promotion | user→master, user→admin and user→super_admin by a super_admin are unguarded by design; non-super_admin promotion is refused by the trigger and by `profiles_insert_role_guard` | promotion works (P12) [ran] |

**Stale claims. Role-creating and role-removing writes, and what each now trusts:**
- **Reads `profiles` (or the DB-fresh `auth.users` mirror):**
  - the demote RPC
  - `profiles` INSERT policy and `profiles_insert_role_guard`
  - the `profiles` role-UPDATE trigger (`auth_is_super_admin`)
  - invitations INSERT/UPDATE
  - `delete-user` and `manage-store-user`: `auth.getUser()` returns `auth.users.raw_app_meta_data`, which `profiles_sync_role_to_jwt` updates at once. The same holds for `send-invite-email`, `send-po-email`, `translate-on-save` and `instacart-cart-link`. [read]
- **Still trusts the JWT claim.** These all go through `auth_is_admin()` → `auth_is_privileged()`: 107 policies and 22 functions (developer's 9(f), confirmed by catalog). The role-adjacent ones:
  - `invitations` **SELECT and DELETE** (`auth_is_privileged()`, not brand-scoped). A stale brand-retaining caller read and deleted a brand-B invitation (P17) [ran]. This is the 195-H1 surface, and DELETE also lets any admin cancel other brands' onboarding.
  - `user_stores` "Admins can manage all store links" (195-M1). A stale caller self-linked to a brand-A store (P17) [ran].
  - `profiles` "Admins can update any profile". A stale caller renamed a same-brand profile (P17) [ran]. Role changes stay blocked by the trigger. This is 187 follow-up D.
  - Every other privileged policy and the store-scoped admin arm of `auth_can_see_store`, within the caller's profile brand. This is the deferred `auth_is_admin()` follow-up.
- **No caller privilege at all:** `consume_invitation` (164 Low) and `register_invited_profile` (M1).

**New helper `auth_profile_is_privileged()` [ran]:**
- SECURITY DEFINER, `search_path=public, auth`, owner `postgres`.
- ACL is `{postgres, authenticated, service_role}`: no PUBLIC, no anon. anon gets `permission denied` (P16).
- The body schema-qualifies `public.profiles` and `auth.uid()`. anon and authenticated have no CREATE on `public` or `auth`, so nothing can shadow it.
- It never reads `app_metadata`.
- Staff calling it learn only their own status (`false`, P14). Nothing useful.

**Locks:**
- **Mixed races [ran]:** R1 to R7 (RPC vs PATCH, both orders, third-party and same-role) all ended with at least 1 super_admin and at least 1 master.
  - S2 waited on `Lock/transactionid` for mutual demotions (R1, R2) and on `Lock/advisory` for third-party ones (R3 to R6).
  - The refusal strings were `role changes require super_admin` (R1: the trigger's fresh `auth_is_super_admin()` sees the caller already demoted), `forbidden` (R2) and `cannot demote the last master` (R3 to R6).
  - These complement the developer's P1', P2 and P3 [read], which I agree with, including deviation 5: P1 as written exercises the row lock, not the advisory lock.
- **Deadlock:** I found no cycle for single-row paths. After the advisory lock, a holder only UPDATEs a row it already locked. R7, a multi-row PATCH, refused itself rather than deadlocking. A 40P01 is still possible as designed and fails closed.
- **Starvation:** PostgREST runs one transaction per request, so no caller can hold a row or advisory lock across requests. Waits are bounded at 8s by `lock_timeout`/`statement_timeout` on `authenticator`, and a blocked demotion then fails closed. [ran pg_roles]
- **Key collision:** only three functions take advisory locks. The other two keys come from the caller's own brand (`stock_store_from_store`) or from a store id that must already be visible (`save_store_count_layout`, which locks after its auth gates). So there is no attacker-chosen key. A collision could only add serialization, never remove it. [ran catalog]

**Recovery and wedging [ran P11, P12, P13]:**
- A super_admin can still undo mistakes without psql. An accidentally demoted user is re-promoted with one PATCH (`role` plus `brand_id`), which is unguarded.
- The last master can't go straight to super_admin, or to admin or user (`cannot demote the last master`). The workaround works: promote another user to master first (P12, where the RPC then demoted `3333`).
- A sole super_admin can't leave the role by either path. The handover order is: promote a new super_admin, then let them demote the old one.
- Only `xact` advisory locks are used, so an aborted client can't leave a stale lock.
- I found no state that only psql can repair, other than losing the owner account itself (spec Risks).

**Existence oracle and error strings:** see L2. All strings are static. None contains SQL, a row value or a path. The brand string is byte-identical to `delete-user/index.ts:156` (read). [ran]

### 195 H1 / M1: does 191 change them?

- **195-H1 (cross-brand invitation listing plus open sign-up): unchanged.**
  - `"Admins can read invitations"` and `"Admins can delete invitations"` are still `auth_is_privileged()` with no brand scope. The P17 stale caller read and deleted a brand-B invitation [ran].
  - 191 adds nothing an open-sign-up account can use: the helper returns false and the wrapper's oracle already exists (L1, L3).
  - 191 does close the H1-adjacent item 6 of the 195 audit (stale NULL-brand callers creating store-less invitations): P17 INSERT gave 42501 [ran].
  - The fix in 195-H1(a) can now reuse `auth_profile_is_privileged()`.
- **195-M1 (demoted admin keeps a brand, then self-links with a stale claim): unchanged.**
  - The RPC can't produce that state, because it NULLs `brand_id` (P18 post-state, P12).
  - A super_admin PATCH of `{role:'user'}` still keeps the brand. 191's new trigger branch checks only self and last-of-role.
  - The user_stores admin arm still trusts the claim (P17 self-link admitted) [ran].
  - **Fix is now a one-line policy swap:** use `auth_profile_is_privileged()` in that policy's USING and WITH CHECK, with a pgTAP arm expecting 42501. That should go in the `auth_is_admin()` follow-up or in its own spec, not into 191 after review.

### Tests and smoke, security view

- The pgTAP arms cover every refusal with row-unchanged checks, and the developer's mutation table shows each guard is load-bearing [read; files re-run green].
- E-2 is not vacuous: `d1-164@local.test` is created at `profiles_insert_hardening.test.sql:829` and survives to `:1012`.
- **Arm 7b [read]:**
  - It aborts on a non-local `SUPABASE_URL` (`:58-70`).
  - Its fixture has `encrypted_password=''`, so it can't log in.
  - It swaps the caller's role through postgres, and the EXIT trap removes the fixture. If killed in the middle, the caller swap is restored only by the existing `restore_admin`, which the header documents.
  - Not run (F3 still open). This is not a security gap: refusals fire before the UPDATE whatever the HTTP status.

### Dependencies

`package.json` differs from HEAD only in the `test:smoke` script (another spec adds `smoke-delete-user.sh`). Spec 191 makes no dependency change, so I skipped `npm audit`.
