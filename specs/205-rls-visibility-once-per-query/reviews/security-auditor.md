## Security audit for spec 205

Scope: `supabase/migrations/20261123120000_rls_visibility_once_per_query.sql` (new), `supabase/tests/rls_visibility_once_per_query.test.sql` (new), `supabase/tests/rls_per_row_helper_lint.test.sql` (new), and the text-pin edits in `audit_log_rls_hardening`, `invitations_hardening`, `report_last_order_context` and `user_stores_own_row_writes`. I checked these against the prod export of the pre-205 policy text and helper bodies dated 2026-11-23.

Verdict: **no Critical, no High.** The rewrite admits the same rows as before. I checked that myself and did not take the spec's word for it. Details are under "Independent verification" below.

### Critical (BLOCKS merge)
- None.

### High (must fix before deploy)
- None.

### Medium
- `supabase/migrations/20261123120000_rls_visibility_once_per_query.sql:295-326` — **Two copies of the visibility rule can drift apart.**
  - `auth_visible_store_ids()` copies arms (ii) and (iii) of `auth_can_see_store()`. `auth_profile_brand_id()` copies the non-super_admin arm of `auth_can_see_brand()`.
  - After this spec, the read side uses the new helpers. The write side, the RPC gates and the edge functions still use the old ones.
  - **Impact:** a later security fix applied to only one side becomes a partial fix. Example: a follow-up to spec 195 that gates arm (ii) on `profiles.role` instead of the JWT claim. If it changes only `auth_can_see_store`, reads keep the looser rule with no error.
  - **Current guard:** AC-5b (`rls_visibility_once_per_query.test.sql` around lines 136-204) runs in CI and compares the two sides. It only covers the 12 principal shapes in the fixture. A fix keyed on a shape outside that set, such as `profiles.status`, a new role, or a store status, would pass CI with the two sides already split.
  - **Fix (follow-up spec; R7 keeps it out of this one):** redefine the old helpers on top of the new ones so there is one source of truth:
    - `auth_can_see_store(x) := auth_is_super_admin() or coalesce(x = any(auth_visible_store_ids()), false)`
    - `auth_can_see_brand(b) := auth_is_super_admin() or coalesce(b = auth_profile_brand_id(), false)`

    My 300-combination grid (below) shows these are exactly equivalent. They would also speed up write-side checks. Until then, the "CHANGE BOTH TOGETHER" comments (migration lines 59-65 and 333-337) are the only thing guarding this. The proposed CLAUDE.md bullet (spec D-9 risk 2) should land with this spec.

### Low
- `supabase/tests/rls_per_row_helper_lint.test.sql:42-95` — **The lint can't catch a policy that drops the super_admin arm.**
  - The lint only looks for per-row `auth_can_see_store(` / `auth_can_see_brand(` calls. Its fix-it message points authors to the new form.
  - By design (`auth_visible_store_ids` comment, migration line 334), the new helpers never include super_admin.
  - So a future policy written as `store_id = any ((select public.auth_visible_store_ids())::uuid[])` with no `(select public.auth_is_super_admin()) or` arm passes this lint. Super_admins would then be silently denied, the same pattern as specs 026/027.
  - Today all 36 policies that reference the new helpers also reference `auth_is_super_admin()` (checked in `pg_policies`: 36 total, 0 missing), so nothing is broken now.
  - **Fix:** add a lint arm that fails when any `public.*` policy qual or with_check mentions `auth_visible_store_ids()` or `auth_profile_brand_id()` but not `auth_is_super_admin()`. Seed it with an empty allowlist.

- `supabase/tests/rls_visibility_once_per_query.test.sql:546-628` — **AC-2 compares whole tables, so a redundant arm can hide a broken one.**
  - AC-2 compares what each principal can see in each table under all of the table's policies together. On tables with more than one permissive SELECT policy, other policies cover some arms of the rewritten one:
    - `profiles`: "Users can read own profile" covers the `id = (select auth.uid())` arm, and `super_admin_read_all_profiles` covers the super_admin arm.
    - `user_stores`: "Users can read own store links" overlaps the ALL policy.
    - `order_schedule`: the SELECT policy overlaps the ALL policy.
  - A broken rewrite of one of those arms would not fail AC-2.
  - The fragments themselves are fully covered: AC-5b does it in the suite, and my grid confirms it. I read the masked arms in the migration and they are correct. So this weakens the proof but leaks nothing.
  - **Fix (optional):** add a per-policy check that evaluates `select pk from t where <old_using>` against `<new_using>` under each principal's claims, as a role that bypasses RLS. That isolates each policy from its neighbours.

- `supabase/migrations/20261123120000_rls_visibility_once_per_query.sql:165-249, 295-331` — **The pre-flight matches policy names, not policy text, and `create or replace` keeps an existing function's owner and grants.**
  - Two things depend on the manual AC-13 / AC-14 prod checks:
    - If prod has drifted (someone edited a policy's qual in the dashboard), `ALTER POLICY` silently replaces it.
    - If a function named `auth_visible_store_ids` or `auth_profile_brand_id` already exists on prod with another owner or extra grantees, `create or replace` keeps both. `revoke ... from public` doesn't remove named grantees.
  - The prod export dated 2026-11-23 matches the repo text for all 36 policies. AC-14 / D-7 step 4 compare `proowner` and `proacl`.
  - **Fix:** treat AC-13 and AC-14 as hard gates, not paperwork. If wanted, add a pre-flight line that raises when `to_regprocedure('public.auth_visible_store_ids()')` or `to_regprocedure('public.auth_profile_brand_id()')` is not null.

- **Informational, not a finding: the new helpers can be called directly as RPCs.**
  - Anon: `POST /rest/v1/rpc/auth_visible_store_ids` returns `[]` and `/rpc/auth_profile_brand_id` returns `null` (checked against local PostgREST).
  - Local brand admin: the RPC returned exactly the 4 store ids that `GET /rest/v1/stores?select=id` returns.
  - **Why nothing new leaks:** each element of V is a `stores.id` the caller already passes `store_member_read_stores` for. `user_stores.store_id` is NOT NULL and a foreign key. The brand id is the caller's own `profiles.brand_id`, which the own-row profile policy already returns.
  - This is narrower than the existing `auth_can_see_store(uuid)` boolean, which has always been callable as an RPC. Nobody can list store ids they couldn't already read.

### Independent verification (what I checked, not taken from the spec)

1. **Equivalence of the predicate across a grid of 300 caller shapes** (local, rolled back; my own script, not the suite's).
   - Profile shapes (7): none, super_admin/NULL, admin/A, admin/B, master/A, user/A, user/NULL.
   - Links (4): none, A1, B1, A1+B1. The cross-brand links were planted with the trigger disabled.
   - JWT `app_metadata.role` (6): admin, master, super_admin, user, absent, `ADMIN`.
   - `sub` present or absent (2). Absent gives `auth.uid()` = NULL.
   - For each combination I compared `auth_can_see_store(x)` with `coalesce(<new store fragment>, false)` over every store, NULL and a random uuid, and did the same for brands.
   - **Result: 0 mismatches.**
   - This covers the shapes the brief named: super_admin; admin/master with a brand; a JWT admin whose profile role or brand differs or is NULL; a stale-token admin with and without links (spec 195); linked staff; an unlinked user; a NULL uid. Anon is covered by the suite's AC-3 and by the PostgREST probe.

2. **NULL semantics.** For a non-super_admin, the new form gives NULL where the old one gave false, in two cases: a NULL id, or `auth_profile_brand_id()` = NULL. Both deny in USING.
   - **Only one rewritten call sits under NOT:** the store-list arm in `invitations`, migration line 480. It is wrapped in `coalesce(..., false)`, which is correct. That path can't be reached today anyway: the `profiles_role_brand_consistent` CHECK forces a non-NULL brand on admin and master, and super_admin short-circuits.
   - **NULL elements in V can't occur:** `stores.id` is the primary key and `user_stores.store_id` is NOT NULL.
   - **Everything else is in positive AND/OR positions,** including the `audit_log` OR and the `profiles` `OR id = uid`, so NULL and false give the same outcome.

3. **The `::uuid[]` cast.** It casts to the type the helper already returns, so it changes no value. It is what makes Postgres treat the operand as a scalar subquery (one InitPlan) instead of the subquery form of ANY. The return type is pinned by the AC-5 `prorettype` check, so a later return-type change can't silently coerce.

4. **WITH CHECK on the two ALL policies is unchanged.**
   - Both carry an explicit with_check equal to the pre-205 qual: order_schedule `14541bb1...`, user_stores `b05a4d44...`. The pre-flight requires it and the post-flight re-asserts it.
   - `ALTER POLICY ... USING` leaves WITH CHECK alone.
   - Behaviour check: with INSERT ... RETURNING into `stores` and `waste_log` as the local brand admin, the old and new policy text behave identically. The `stores` insert fails RLS in both (the snapshot can't see the new row, which is existing behaviour), and the `waste_log` insert succeeds in both.

5. **SECURITY DEFINER hygiene.**
   - Both helpers: `prosecdef = t`, `provolatile = s`, `proconfig = {search_path=public, auth}`, owner `postgres`. Every relation and function they use is schema-qualified, so a temp table can't shadow one.
   - `anon`, `authenticated` and `service_role` lack CREATE on `public`.
   - `profiles`, `stores` and `user_stores` don't FORCE RLS, and `postgres` has BYPASSRLS, so the helpers' reads are unfiltered and can't recurse.
   - The ACL is `postgres, anon, authenticated, service_role`, with no PUBLIC entry. That is stricter than the sibling `auth_*` helpers, which do grant PUBLIC.
   - **The PUBLIC revoke breaks no role.** The only non-BYPASSRLS roles with SELECT on the R4 tables are `anon` and `authenticated`, and both have EXECUTE. `pg_read_all_data`'s members (`supabase_read_only_user`, `supabase_etl_admin`) are BYPASSRLS locally. Re-check on prod during AC-14 that those two still bypass RLS.

6. **Realtime.**
   - Locally, `realtime.apply_rls` runs, for each subscriber: `set_config('role')`, then `set_config('request.jwt.claims')`, then `execute 'execute walrus_rls_stmt'`. Every execution is a fresh run of the query, so the InitPlan is recomputed with that subscriber's claims.
   - When a cached plan is reused across subscribers with the same role, only the InitPlan parameters change, and they are reset on every run.
   - The developer's two-principal check (AC-10) matches this: ADM-A got 2 events and ADM-B got 0, in all three DB states.

7. **The equivalence suite's fixtures and trigger disabling.**
   - `disable trigger user` is transactional DDL inside the file's `begin ... rollback`. Foreign-key triggers are not "user" triggers, so they stay enforced.
   - Disabling the triggers lets the suite plant shapes the triggers would otherwise refuse: the cross-brand B1 link (the only fixture that proves arm (iii) survives for admins), NULL-store rows and NULL-FK children. All of them are rolled back.
   - Fixtures cover all 35 tables, and the non-vacuity guards prove they are reached (ADM-A sees brand-A rows in all 35 tables; ADM-A+L sees B1 in every store-scoped table).
   - Gaps: the AC-2 masking noted under Low, and the invitations NULL-brand privileged caller, which the CHECK constraint makes impossible to plant.

8. **The full pgTAP suite passes:** `bash scripts/test-db.sh` gave 114/114 files on the local stack.

9. **The pin edits keep their intent.**
   - S-3 and T3 re-pin the new qual, and T3 still pins with_check against the pre-195 literal byte for byte.
   - K-b still requires the brand scope, the super_admin arm and the bare `invited_by = auth.uid()`.
   - P1b still rejects an unscoped qual.
   - No behavioural test was edited.

10. **Nothing else in scope.** No edge function, config.toml entry, `EXPO_PUBLIC_*` variable, secret or client code is touched. No new table, so the rule that new tables need RLS doesn't apply. No dynamic SQL in the migration. The `audit_log` index has no security impact.

### Dependencies
No `package.json` / `package-lock.json` changes, so `npm audit` was skipped.

## Follow-up: B-1 pre-flight guard (2026-11-23)

**Verdict: OK. No new finding. The helper-owner/ACL half of Low 3 is closed. The policy-text-drift half stays with AC-13 as before.**

Scope: `supabase/migrations/20261123120000_rls_visibility_once_per_query.sql` lines 219-224 (the guard), plus a skim of the fix-pass edits.

1. **Ordering and fail-closed: OK.**
   - Before the guard there is only `begin;` and `set local lock_timeout`. The guard is the first statement in the pre-flight `do` block (L221). It runs before the `lock table` (L307), both `create or replace function` statements (L350, L373), the grants and every `alter policy`.
   - It uses `raise exception`, so the error aborts the transaction and the later `commit;` becomes a rollback. Nothing is left half-applied.
2. **The owner/ACL residual is closed.**
   - The guard only passes when no zero-argument `public.auth_visible_store_ids()` / `public.auth_profile_brand_id()` exists. So the `create or replace` below always creates a new function. Its owner is the applying role (postgres) and its ACL comes only from the revoke/grant at L383-386 plus schema default privileges. No inherited owner or named grantee survives.
   - **Overload gap (theoretical, fails closed):** `to_regprocedure` checks the exact zero-argument signature. An overload such as `public.auth_visible_store_ids(x uuid default null)` would get past the guard, as confirmed locally (`to_regprocedure('public.zz_probe()')` is NULL when only the defaulted-argument overload exists).
     - In that case the zero-argument `create` still makes a new function.
     - Every policy text and the post-flight call `public.auth_visible_store_ids()` would then be ambiguous: local probe gave `ERROR: function ... is not unique` (42725). ALTER POLICY parses its expression immediately, so the transaction rolls back.
     - A non-defaulted overload is never chosen by a zero-argument call. No path leads to a policy bound to an attacker-owned function.
   - **Other schemas: no gap.** The `to_regprocedure` strings, both `create` statements, the grants, all 36 policy texts and the helper bodies are schema-qualified with `public.`, and the helpers pin `search_path = public, auth`. A same-named function in another schema on the search_path is never resolved.
   - A procedure (prokind `p`) with the same name is also caught, because `to_regprocedure` covers all of `pg_proc`.
   - **Residual, unchanged:** the guard does not check policy text. A dashboard edit to one of the 36 quals would still be silently replaced, so AC-13 remains a hard manual gate.
3. **Message and fresh apply: OK.**
   - The message names two public function identifiers and says "do not re-run". It contains no row data, ids, roles, secrets or SQL beyond the names.
   - No other migration or `seed.sql` mentions either name (grep), so a fresh CI replay finds both NULL and goes on unchanged.
   - Re-running after a successful apply now fails at this guard, which matches the header's NOT REPLAYABLE note.
   - Optional nit, not required: with the guard in place, `create or replace` could be plain `create`. That would be a second fail-closed check at no cost.
4. **Other fix-pass edits: no change to access control.**
   - The NOT REPLAYABLE header note (L22-28) is a comment.
   - The R9 rollback `lock table` (L109-144) sits inside the commented-out rollback block.
   - `string_agg(... order by tablename, policyname)` at L273/L275 only sorts the text of a pre-flight error message. The L284 and L559 aggregates have no order by and also only build error text.
   - None of these touch a policy expression, helper body, grant or WITH CHECK.

The local check ran in a rolled-back transaction on the local stack only. Prod was not touched.
