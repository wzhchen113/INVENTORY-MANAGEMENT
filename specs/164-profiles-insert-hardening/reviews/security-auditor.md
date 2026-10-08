## Security audit for spec 164

Scope: `supabase/migrations/20261007000000_profiles_insert_hardening.sql`, `supabase/tests/profiles_insert_hardening.test.sql`, `supabase/tests/permissive_policy_lint.test.sql`, `supabase/tests/order_approvals.test.sql`, `supabase/tests/invitations_super_admin_rls.test.sql`, `src/lib/auth.ts` (`registerInvitedUser`, lines 471-535), `src/lib/registerInvitedUser.test.ts`.

Method: I read the code and probed the live local stack (`supabase_db_imr-inventory`). Every write probe ran inside `begin ... rollback`, and I confirmed afterwards that no `Probe%` brands and no `@probe.test` auth users were left behind. I did not touch prod. I ran the four changed pgTAP files with `scripts/test-db.sh`: 71 + 5 + 24 + 4 assertions, all passing.

**Verdict on the spec 163 Critical: CLOSED.** The `profiles` INSERT OR-tail is gone. A profile-less caller, a staff caller, or a caller with a forged JWT can no longer create a profile or mint an `app_metadata.role`. The lint OR-tail branch now fires. No new Critical was found. The two High findings below are **pre-existing** and are **not** made worse by this diff (this diff narrows both). Neither should hold the 164 prod apply.

### Critical (BLOCKS merge)
None.

### High (must fix before deploy)

- **H1 (pre-existing; P_INV is incomplete as a trust anchor): a NULL-brand staff user can self-grant any store in any brand.**
  - **Where:**
    - `supabase/migrations/20261007000000_profiles_insert_hardening.sql:283`: P_INV admits `invitations.brand_id is null`.
    - Same file, lines 201-211: the RPC writes `brand_id = NULL` for a zero-store `user` invite.
    - `"Users can manage own store links"` (`FOR ALL ... user_id = auth.uid()`) on `user_stores`.
    - `user_stores_brand_match()`: when the profile brand is NULL, the first grant has nothing to conflict with, so it passes.
  - **Confirmed live, all in one rolled-back transaction, with a synthetic brand B and store B:**
    1. Brand-A admin `1111...` INSERTs an invitation `(role='user', brand_id=NULL, store_ids='{}')`. P_INV admits it. This is also the normal UI path for a zero-store staff invite (`src/lib/auth.ts:363-368, 424-432`).
    2. The invitee calls `register_invited_profile()` and gets profile `role=user, brand_id=NULL`.
    3. The invitee runs `insert into user_stores (user_id, store_id) values (auth.uid(), <store B>)`, which succeeds.
    4. `auth_can_see_store(store B)` is now true. The invitee can **read and UPDATE** brand-B `inventory_items` (1 row read, 1 row updated). The same policies grant SELECT/UPDATE/DELETE on `purchase_orders`, `waste_log`, `pos_imports`, `report_*`, `eod_*`, and so on.
  - **Impact:**
    - The spec says the invitation is now the trust anchor ("a caller may only write an invitation it could legitimately grant"). But a brand-A admin can still reach brand B's store data by inviting an account they control.
    - Any zero-store staff invitee can do the same, including someone who squats on that invite (see M1).
    - The spec's out-of-scope note (line 159) says the own-row arm only allows self-grants "within their own brand". That is wrong for NULL-brand users: they can self-grant across brands.
    - Profile-less accounts cannot do this. `user_stores_user_id_fkey` references `profiles` (probed: 23503). So 164 does shrink the reachable population from "anyone with the anon key" to "NULL-brand staff".
    - With a single live brand, the impact is horizontal (store to store), which is out of scope. Once a second brand exists, it is cross-tenant.
  - **Fix, cheapest first:**
    - (a) Drop the write arm of `"Users can manage own store links"`. Keep the separate `"Users can read own store links"` SELECT policy. With registration now server-side, nothing in `src/` writes `user_stores` as the owning user. Every write is admin-side through `"Admins can manage all store links"`. The spec already recommends this follow-up.
    - (b) Additionally, or instead, make `user_stores_brand_match()` refuse NULL-brand rows when `current_user in ('authenticated','anon')` and the caller is the row's own user.
  - **Release:** do not hold the 164 apply for this, because 164 strictly reduces exposure. Either fold fix (a) into 164 (one `drop policy` / `create policy ... for select`) or open the follow-up spec immediately.

- **H2 (pre-existing, spec 050, outside this diff): `demote_profile_to_user` has no brand scope and no last-of-role guard.**
  - **Where:** `supabase/migrations/20260520000000_demote_profile_to_user_rpc.sql` (the live body: `auth_is_privileged()` gate, self-guard, then a bare `update public.profiles set role='user', brand_id=null where id = target_user_id`).
  - **Confirmed live (rolled back):** brand-A admin `1111...` called `demote_profile_to_user(<the only super_admin>)`. It succeeded, and the super_admin became `role=user, brand_id=NULL`.
  - **Impact:**
    - Any brand admin or master can demote any other brand's admins, or the sole super_admin. Recovery is psql-only.
    - The demoted target becomes a NULL-brand user, which then feeds H1.
  - **Fix (separate spec):**
    - Add `auth_can_see_brand(target.brand_id)`, or a super_admin requirement when the target's role is `super_admin`/`master`.
    - Add the `assert_not_last_of_role` call that CLAUDE.md requires for destructive role changes.
  - This does not block 164. I am reporting it because the task asked me to confirm that no other path into `profiles` escalates or breaks containment.

### Medium

- **M1 (pre-existing, now the top anon-to-admin path): invitation squatting plus the `get_pending_invitation` oracle.**
  - `supabase/config.toml:227,232` (`enable_signup = true`, `enable_confirmations = false`).
  - `get_pending_invitation(text)` is anon-executable and returns `id, role, brand_id, store_ids, username` for any email.
  - With the profiles hole closed, the shortest anon path to `admin` is: guess or learn a pending admin invite email, confirm it with the anon oracle, `signUp` with that email (no confirmation required), then call `register_invited_profile()`.
  - The RPC binds identity correctly to `auth.users.email` (migration:158). The weakness is that the email is unproven.
  - This is already listed as out of scope (spec line 158). I agree, and recommend prioritizing the follow-up: confirmations plus claim-on-first-sign-in, and shrinking the anon oracle to a boolean.
  - Prod auth settings may differ from `config.toml`. Verify them in the dashboard.

- **M2: P_INV and the new profiles INSERT policy trust a JWT-derived role.**
  - Migration lines 60, 281, 299, 311: `auth_is_privileged()`, which in turn calls `auth_is_admin()` and reads `jwt.app_metadata.role`.
  - An admin demoted to `user` while keeping a brand (via `super_admin_manage_profiles`) keeps a valid admin claim until the token expires. During that window they can write a `role='admin'` invitation for their brand and register it to an account they control. The result is a durable admin that survives the demotion.
  - The spec accepts the stale-JWT window for read policies. Here it now feeds a write that mints a durable role.
  - Fix: in P_INV (and optionally the profiles INSERT policy), replace `auth_is_privileged()` with a check against `profiles`, for example `exists (select 1 from public.profiles where id = auth.uid() and role in ('admin','master','super_admin'))`. `auth_can_see_brand` already reads `profiles`.

- **M3: the lint still has a dead token (same class as spec 163 H1).**
  - `supabase/tests/permissive_policy_lint.test.sql:129-133, 174-178, 256-260, 335-339, 389-393`.
  - Postgres deparses `auth.role() = 'authenticated'` as `(auth.role() = 'authenticated'::text)`. Neither the head regex nor the OR-tail regex allows `::text` before the closing anchor, so this token can never match.
  - Probed with synthetic policies (rolled back): `using (auth.role() = 'authenticated')` and `with check ((id = auth.uid()) or (auth.role() = 'authenticated'))` were both **not flagged**.
  - The Supabase-recommended initplan form `(select auth.uid()) is not null` is also not flagged. It deparses to `(( select auth.uid() as uid) is not null)`. So is `(auth.jwt() is not null)`.
  - No live policy currently has these shapes (checked `pg_policies`).
  - Fix:
    - Allow an optional cast: `auth\.role\(\) = 'authenticated'(::text)?`.
    - Add `\(\s*select auth\.uid\(\) as uid\)\s*is not null` as a token.
    - Add a positive arm for each, like arm (5).

### Low

- `supabase/migrations/20261007000000_profiles_insert_hardening.sql:165-184`: the RPC runs a count check and then a separate non-`STRICT` `select ... into ... for update`. If a second pending invitation is committed between the two, plpgsql silently takes the first row instead of raising R4. Both rows would be admin-authored for the same email, so the impact is negligible. To close it, use one `select ... into strict ... for update` and map `TOO_MANY_ROWS` to `'multiple pending invitations'`.
- `consume_invitation(uuid,text)` no longer has any legitimate caller, but it is still EXECUTE to `authenticated`. `get_pending_invitation` hands the invitation `id` to anon. So any signed-up account can burn a pending invitation by calling `consume_invitation(id, email)` (denial of service against the invitee). This is pre-existing. Revoke or drop it in the cleanup the spec already defers (line 164).
- `src/lib/auth.ts:524-526` shows `regError.message` to the registering user verbatim. Downstream errors include internal detail, for example `cross-brand user_stores assignment rejected: user brand=<uuid>, store brand=<uuid>` and `profiles_username_lower_key` constraint names. This is only reachable through a malformed invitation, and it only exposes UUIDs and constraint names, not row data. Consider mapping known P0001/23505 messages to friendly strings.

### Verified (no finding)

- **Policy swap.** `profiles` has exactly one permissive INSERT/ALL policy, `"Admins can insert profiles in own brand"`, `to authenticated`, `WITH CHECK (auth_is_privileged() AND auth_can_see_brand(brand_id))`. The fail-closed DO-block assertion (migration:69-82) guards against prod drift.
  - A profile-less caller presenting a forged `app_metadata.role='master'` claim is refused (42501), because `auth_can_see_brand` reads `profiles`.
  - Anon has no INSERT policy.
- **Guard trigger.**
  - `assert_profile_insert_role_allowed` is `prosecdef=false` with `search_path=public, auth`.
  - It is the only BEFORE INSERT trigger, so it fires before RLS `WITH CHECK`. pgTAP A-2/A-3 proves both layers independently.
  - It reads super_admin status from `profiles`, which the caller cannot forge.
  - The roles reachable via `authenticator` are only `anon`, `authenticated`, and `service_role`, so the `current_user in ('authenticated','anon')` allowlist is complete.
- **Upsert and UPDATE escalation paths.** `INSERT ... ON CONFLICT (id) DO UPDATE SET role=...` by an admin (cross-user and self) and by staff (self), plus a direct self `UPDATE role`, are all refused by `profiles_self_brand_lock` or RLS (probed).
- **`register_invited_profile()`.**
  - SECURITY DEFINER, owner `postgres`, `search_path=public` pinned.
  - Every relation is schema-qualified, including `public.invitations%rowtype` and `auth.users`.
  - ACL is `{postgres, authenticated, service_role}`: PUBLIC and anon are revoked.
  - `relforcerowsecurity=false` on all three tables, so the owner bypass works as designed.
  - No caller-supplied parameters. Identity is `auth.uid()` plus `auth.users.email`, matched case-insensitively.
  - Role is whitelisted to `user`/`admin` (R5). An admin invite with no brand is refused (R6). R2 runs first, so the RPC cannot overwrite an existing profile (probed).
  - The whole body is one statement, so it is atomic. C-17/C-18 prove the rollback.
  - Concurrency is handled by `FOR UPDATE`, which re-checks `used`, with the profiles PK as a backstop.
  - Refusal strings match the spec byte-for-byte.
- **Other writers.** The only SECURITY DEFINER functions in `public` that write `profiles`, `user_stores`, or `invitations` are this RPC, `consume_invitation`, and `demote_profile_to_user` (H2). No public view depends on these tables.
- **P_INV.**
  - Columns are qualified as `invitations.`.
  - Store ids are compared as text, so they fail closed. pgTAP D-8 confirms 42501, not 22P02.
  - A hidden or unknown store is refused.
  - UPDATE `USING` is tightened as well.
  - Super_admin cannot write `super_admin`/`master` invitations.
- **Client.** `registerInvitedUser` sends no role (`options.data = { name }`) and makes exactly one RPC call. It no longer writes `profiles`/`user_stores` and no longer calls `consume_invitation`. jest pins all of this.
- **Lint fix.** All `\b` occurrences are now `\y`. Arm (5) proves the OR-tail branch fires. `grep '\\b' supabase/tests` returns nothing. Arm (1) is 0 with no new allowlist rows.
- **Secrets and logging.** None introduced. No edge-function or `config.toml` change.

### Dependencies
No `package.json` / `package-lock.json` changes. Skipped `npm audit`.
