## Security audit for spec 163

Scope: `supabase/migrations/20261008000000_get_profile_emails.sql`, `supabase/tests/get_profile_emails.test.sql`, `src/lib/db.ts` (`fetchProfileEmails`, `fetchBrandAdmins`), `src/lib/auth.ts` (`fetchAllUsers`), staged `src/screens/cmd/sections/UsersSection.tsx`.
Method: read every file, checked the live local catalog (`pg_policies`, `pg_proc`, `pg_trigger`, ACLs, default ACLs), ran the pgTAP file (18/18 pass), and probed under JWT impersonation inside `begin; … rollback;`. Nothing was persisted locally. Prod was not touched.

**Verdict on the spec-163 diff itself: correct.** The RPC's predicate, grants, `search_path`, and input handling all hold up (see "Verified" below). The one Critical is a **pre-existing** hole in `public.profiles` that this audit found. It makes the RPC's gate forgeable by any authenticated principal that has no profile row. No line in the spec-163 diff needs to change to fix it.

### Critical (BLOCKS merge)

- `supabase/migrations/20260502071736_remote_schema.sql:399-404` (live as `"Anyone can insert own profile or admin can insert any"`) plus `:515` (`profiles_sync_role_to_jwt`). **Pre-existing, not introduced by spec 163. Lets any authenticated user self-promote to super_admin and mint admin/master JWT claims.**
  - **The flaw:** the INSERT `WITH CHECK` is `(id = auth.uid()) OR (jwt role in admin,master) OR (auth.uid() IS NOT NULL)`. The OR-tail admits every authenticated caller, for **any** `id`, **any** `role`, and **any** `brand_id`. Nothing guards role or brand at INSERT time:
    - `profiles_self_brand_lock` (`20260517040000_auth_can_see_store_brand_scope.sql:196`) is `BEFORE UPDATE` only.
    - `profiles_self_delete_lock` only closes the DELETE+INSERT path for users who *already have* a profile.
    - The `AFTER INSERT` trigger `sync_role_to_app_metadata()` (SECURITY DEFINER) then copies `NEW.role` into `auth.users.raw_app_meta_data`.
  - **Reproduced locally (rolled back):**
    1. Authenticated as orphan auth user `ba07f977-…`, which has no profile and an empty `app_metadata`. `get_profile_emails([admin, manager, master])` returned 0 rows.
    2. `insert into public.profiles (id, role, brand_id, name) values (<own uid>, 'super_admin', null, 'attacker')` succeeded.
    3. `auth_is_super_admin()` immediately returned `t`, and the same RPC call returned all 3 emails (`admin@local.test`, `manager@local.test`, `master@local.test`).
    4. Second probe: the same caller inserted `role='admin', brand_id=<brand A>` for a **different** orphan id (`12a7542a-…`). The trigger wrote `raw_app_meta_data.role = 'admin'` on that victim's auth row, so `auth_is_admin()` becomes true at that user's next token refresh.
  - **Who can reach it in prod:**
    - Anyone holding the public anon key can create an auth account. `registerInvitedUser` calls client-side `supabase.auth.signUp` (`src/lib/auth.ts:502`), so signups must be enabled on the project. `supabase/config.toml:182` is `enable_signup = true` locally.
    - Every invited-but-unregistered user. `send-invite-email` runs `inviteUserByEmail`, which creates the auth row before any profile exists. `registerInvitedUser` then inserts the profile with a **client-supplied** `role` (`src/lib/auth.ts:527-536`), so an invitee can send `'super_admin'` instead.
    - Any customer-PWA auth user on the same project who has no profile row.
  - **Impact:** full cross-tenant compromise. super_admin passes every `auth_can_see_brand` / `auth_can_see_store` gate and the super_admin edge functions. Spec 163 adds one more sink behind this gate: `auth.users` emails for every profile in every brand. The marginal gain is small, because `preview_brand_cascade` (`20260510010000_brand_delete_cascade.sql:503`) already returns emails to super_admin. But shipping a new PII reader whose only trust anchor (`profiles.role`) can be forged with one INSERT is exactly the "exfiltrates rows over an under-policied API path" class.
  - **Why CI missed it:** see High H1.
  - **Fix (separate hotfix spec, should land before or with the 163 prod rollout):**
    1. Replace the INSERT policy so `WITH CHECK` is `(id = auth.uid() and role = 'user' and brand_id is null)` OR `(auth_is_privileged() and auth_can_see_brand(brand_id))`, with no `auth.uid() IS NOT NULL` tail.
    2. Move invited-registration profile creation into a SECURITY DEFINER RPC (or extend `consume_invitation`) that takes `role`, `brand_id`, and `username` from the invitation row server-side, keyed on `auth.email()`.
    3. Add a `BEFORE INSERT` trigger that rejects any non-`super_admin`, non-`postgres`/`service_role` insert where `role <> 'user'` (defense in depth, mirroring `assert_brand_id_immutable_for_self`'s `current_user in ('authenticated','anon')` gate).
  - **Urgent, read-only, for the owner to run against prod:**
    - `select id, role, brand_id, created_at from profiles where role in ('super_admin','admin','master') order by created_at;` Check for unexpected rows.
    - Compare `auth.users.raw_app_meta_data->>'role'` against `profiles.role` for drift.
    - Confirm the live policy text with `select with_check from pg_policies where tablename='profiles' and cmd='INSERT';`.
  - **This finding BLOCKS — spec cannot move to READY_FOR_DEPLOY until resolved.** If the owner decides to deploy 163 first anyway, record that as a risk acceptance in the release proposal. The 163 code itself is not at fault.

### High (must fix before deploy)

- **H1** `supabase/tests/permissive_policy_lint.test.sql:121-122, 166-167, 248-249, 314-315` (pre-existing, spec 053). **The OR-tail detector arms are dead code.**
  - **The bug:** in PostgreSQL ARE regex syntax, `\b` means *backspace*, not word boundary. Word boundary is `\y` (or `\m` / `\M`). So `'\bor\s+…'` and `'(?!\s+and\b)'` can never match normal policy text.
  - **Verified:** `select ' or x' ~ '\bor'` returns `f`, and `' or x' ~ '\yor'` returns `t`. Against the live catalog, the shipped regex does not flag the profiles INSERT policy above. With `\b` changed to `\y`, it flags exactly one policy: `profiles / "Anyone can insert own profile or admin can insert any" / INSERT`.
  - **Why the self-tests pass:** arm 3's fixture is head-position (`using (auth.uid() is not null)`), and arm 4 only asserts a non-match, which passes trivially when the regex can never match.
  - **Impact:** the CI gate CLAUDE.md relies on to catch wide OR-tails has never caught one. That is why the Critical above survived specs 043, 051, and 053.
  - **Fix:** replace `\b` with `\y` in all 8 regex literals. Add a positive OR-tail fixture arm (e.g. `using ((id = auth.uid()) or (auth.uid() is not null))` must be flagged). Then either allowlist or (preferably) fix the profiles INSERT policy in the same PR, or the corrected lint goes red. `supabase/tests/order_approvals.test.sql` also uses `\b` in a regex. Worth a check, though it is not security-gating.

### Medium

- None in the spec-163 diff.

### Low

- **L1** `supabase/migrations/20261008000000_get_profile_emails.sql:47-53` vs `20260517060000_profiles_rls_sweep.sql:96-101`. **Lockstep drift risk (R1).**
  - **Parity holds today.** The effective non-self `profiles` SELECT visibility is the OR of three live permissive policies: `"Admins can read all profiles"` (privileged arm + self-arm), `"Users can read own profile"` (self), and `super_admin_read_all_profiles` (`auth_is_super_admin()`). With the self-arms removed, that is `(auth_is_privileged() and auth_can_see_brand(brand_id)) or auth_is_super_admin()`. Since `auth_is_super_admin()` implies both `auth_is_privileged()` and `auth_can_see_brand(x)` for every `x` (including NULL), this collapses to exactly the RPC's predicate.
  - **The risk:** if a future spec tightens the policy, the definer function silently becomes the wider PII path.
  - **Recommendation:** add the parity arm the architect deferred. Under each JWT in arms 8-16, assert `get_profile_emails(ids)` equals `select id from profiles where id = any(ids) and id <> auth.uid()` (run as `authenticated`).
- **L2** `supabase/tests/get_profile_emails.test.sql:171-180`. **Missing anchor test.** Arm 8 gives the super_admin principal both a `profiles.role='super_admin'` row **and** a JWT `app_metadata.role='super_admin'`, so it cannot tell which one grants cross-brand visibility.
  - Add an arm where a `role='user'` profile carries a JWT `app_metadata.role='super_admin'` and gets 0 rows. That pins that super_admin is anchored on `profiles.role` (`auth_is_admin()` only accepts `admin`/`master` from the JWT).
  - Low, because `app_metadata` is not client-writable except through the Critical above.

### Verified (no finding)

- **Visibility predicate:** `public.auth_is_privileged() and public.auth_can_see_brand(p.brand_id)` (migration `:51-52`) is byte-identical to the privileged arm of the live `"Admins can read all profiles"` qual. The self-arm is deliberately omitted. The truth table holds:
  - super_admin: all rows, NULL-brand included.
  - admin/master: own brand only. `NULL = A` is false.
  - `user`: 0 rows, own id included.
  - pgTAP arms 8-16 pass locally.
- **Inner join** to `auth.users` (`:49`): orphan auth users never appear (arm 10). `coalesce(u.email,'') <> ''` only narrows.
- **`p_user_ids`:** ANDed in as `p.id = any(p_user_ids)`, so it can only narrow. NULL and `'{}'` return 0 rows (arms 17-18). It is bound as a typed `uuid[]`, with no dynamic SQL or `EXECUTE`, so there is no SQLi surface. A non-uuid element fails the call with 22P02 before any row is read.
- **Size:** unbounded array size is not a meaningful DoS. 200k random ids as admin took about 107 ms, and the function is reachable only by `authenticated`.
- **Enumeration:** no existence oracle. An out-of-scope id and a nonexistent id both return nothing, which matches what the profiles SELECT policy already reveals.
- **`search_path`:** `proconfig = {"search_path=public, auth"}` (`:46`). Every relation and function is schema-qualified. `pg_temp` cannot shadow qualified relations, and `pg_temp` functions/operators are never searched. `authenticated` and `anon` have no `CREATE` on `public` or `auth`, so there is no operator or function hijack path.
- **Grants:** live `proacl = {postgres=X, authenticated=X, service_role=X}`. PUBLIC and anon are both gone.
  - The explicit `revoke all … from public, anon` (`:71`) is needed and sufficient against both the implicit `CREATE FUNCTION` PUBLIC grant and the `postgres`/`supabase_admin` default ACLs on `public` functions (spec 097). The local `pg_default_acl` shows both grant anon `X`.
  - The revoke runs as the owner, so it removes the owner-granted entries whichever of those roles creates the function in prod. The rollout step `has_function_privilege('anon', …) = false` is the right prod check, so keep it mandatory.
  - service_role EXECUTE is harmless: it carries no `sub`, so `auth.uid()` is NULL and the call returns 0 rows.
- **Language/volatility:** `language sql stable security definer`. The owner is `postgres`. There is no plpgsql OUT-param shadowing.
- **Client `fetchProfileEmails`** (`src/lib/db.ts:247-260`): the single `.rpc('get_profile_emails')` call site. It is threaded through `track()` and `.abortSignal()`, and it dedupes and drops falsy ids.
- **`fetchBrandAdmins`:** passes only `profilesRes` ids (`userIds` is computed from `profiles`), never `invitation:<id>`.
- **Fallback paths** (`src/lib/auth.ts:618-626`, `src/lib/db.ts` `fetchBrandAdmins` `safeProfileEmails`): `console.warn` logs only `e?.message` (PostgREST error text). No emails, tokens, or row data are logged, and there is no toast. A failing RPC degrades to invitation emails and never blanks the list.
- **Display:** emails render only in RN `<Text>`, so there is no HTML/XSS sink. They are not persisted to localStorage/AsyncStorage (`useStore.ts` persists only dark mode, active brand, and session store).
- **Staged `UsersSection.tsx` diff** (identity line, a11y labels): presentation only. No new trust decisions, and `useRole()` is not used as a boundary.
- **No edge functions, `config.toml`, publication, RLS policy, or `EXPO_PUBLIC_*` changes.**
- **Stale-JWT window (R3):** an existing accepted property of every `auth_is_privileged()` policy. Not new.

### Dependencies
No `package.json` changes — skipped.
