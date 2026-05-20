-- supabase/migrations/20260520000000_demote_profile_to_user_rpc.sql
--
-- Spec 050 — server-side self-protection for the demote path. Wraps the
-- previous direct PostgREST UPDATE at `src/lib/db.ts:2757-2766` as a
-- SECURITY DEFINER RPC so `caller.id != target.id` is enforced server-
-- side. Sibling invariant to spec 031's last-of-role guard; both protect
-- against recover-by-psql-only states.
--
-- Foot-gun being closed: before this spec, a super_admin clicking DEMOTE
-- on their own profile row (or curling the PostgREST endpoint directly)
-- successfully self-demoted because the `super_admin_manage_profiles`
-- UPDATE policy admits the row for any super_admin caller (including
-- their own), and `assert_brand_id_immutable_for_self` explicitly bypasses
-- super_admins. The admin/master path was already closed by the trigger
-- ('role is read-only for self-edits') but the super_admin path was the
-- live hole — exactly the recover-by-psql-only state spec 031 set out to
-- avoid. The new RPC closes the surface uniformly across all roles.
--
-- Strictly additive. No tables/policies touched. Idempotent (CREATE OR
-- REPLACE). No publication change — `docker restart
-- supabase_realtime_imr-inventory` is NOT required.
--
-- Function ordering (cheapest-fail-first, mirrors delete-user's
-- ordering):
--   1. Null-caller check (defense-in-depth) → P0001 'cannot demote self'
--   2. auth_is_privileged() role gate         → 42501 'forbidden'
--   3. Self-check (caller.id == target.id)    → P0001 'cannot demote self'
--   4. UPDATE profiles SET role='user', brand_id=null
--   5. Not-found check on UPDATE              → P0002 'target profile not found'
--   6. Return the demoted profile's id (preserves Promise<string> contract)
--
-- security definer + set search_path: the function MUST bypass RLS so
-- the inline `auth_is_privileged()` gate is the authorization source of
-- truth. Without SECURITY DEFINER, the existing
-- `super_admin_manage_profiles` policy would still admit super_admin
-- self-writes, and the trigger 'role is read-only for self-edits' would
-- pre-empt the new stable refusal string for admin/master callers.
-- search_path is locked to public, auth — same shape as
-- auth_is_super_admin() / auth_is_privileged() in
-- 20260509000000_multi_brand_schema_rls.sql.
--
-- errcode choices:
--   P0001 — standard plpgsql `raise exception` SQLSTATE; PostgREST maps
--           to HTTP 400. pgTAP throws_ok() matches by default.
--   42501 — insufficient_privilege; PostgREST maps to HTTP 403.
--   P0002 — no_data_found; PostgREST maps to HTTP 404.
--
-- Refusal-string convention: lowercase, no punctuation, `'cannot <verb>
-- self'`. Parallel to `'cannot delete self'` at
-- supabase/functions/delete-user/index.ts:168-173 — the sibling self-
-- action guard on the edge-function side. Both refuse `caller.id ==
-- target.id`; the SQL guard here uses SQLSTATE for PostgREST mapping,
-- the TS guard there returns the status directly.

create or replace function public.demote_profile_to_user(
  target_user_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_caller_id uuid := auth.uid();
  v_demoted   uuid;
begin
  -- (1) Defense-in-depth: refuse when auth.uid() is null. The RPC is
  -- only reachable from authenticated PostgREST sessions in practice
  -- (GRANT EXECUTE is to authenticated only — see below), but
  -- service_role bearers and unset JWT claims can both produce
  -- auth.uid() = null. A null caller can never satisfy the
  -- "caller != target" predicate safely, so refuse fail-closed.
  --
  -- Refusal string is intentionally unified with the self-check below
  -- (`'cannot demote self'`). A distinct `'caller is null'` string would
  -- leak that the auth was missing to a probing caller; the unified
  -- string is the safer surface. pgTAP arm (iv) verifies this contract.
  if v_caller_id is null then
    raise exception using
      errcode = 'P0001',
      message = 'cannot demote self';
  end if;

  -- (2) Role gate. SECURITY DEFINER bypasses RLS, so the inline
  -- `auth_is_privileged()` check is the authorization source of truth.
  -- Mirrors the edge-function `ADMIN_ROLES` set
  -- (admin / master / super_admin) — CLAUDE.md "Edge function role
  -- gates mirror auth_is_privileged()" convention.
  if not public.auth_is_privileged() then
    raise exception using
      errcode = '42501',
      message = 'forbidden';
  end if;

  -- (3) THE GUARD. Stable refusal string parallel to spec 012c's
  -- 'cannot delete self' (delete-user/index.ts:168-173) and spec 031's
  -- 'cannot delete the last super_admin'. Spec 050 AC A.
  if target_user_id = v_caller_id then
    raise exception using
      errcode = 'P0001',
      message = 'cannot demote self';
  end if;

  -- (4) Destructive op. Mirrors the body the previous
  -- demoteProfileToUser helper performed via direct PostgREST
  -- (src/lib/db.ts:2757-2766 pre-spec-050). Both columns must change in
  -- a single UPDATE so (a) profiles_role_brand_consistent CHECK passes
  -- (role='user' allows any brand_id including NULL) and (b) the H5
  -- pre-flight in hard_delete_brand stops counting this row toward the
  -- blocking total. RLS is bypassed by SECURITY DEFINER — this is by
  -- design: the RPC is the new authoritative gate and the surrounding
  -- policies (`super_admin_manage_profiles`,
  -- `assert_brand_id_immutable_for_self`) are now defense-in-depth only.
  update public.profiles
     set role = 'user', brand_id = null
   where id = target_user_id
  returning id into v_demoted;

  -- (5) Target didn't exist. Raise so the client gets a structured
  -- error instead of a silent no-op.
  if not found then
    raise exception using
      errcode = 'P0002',
      message = 'target profile not found';
  end if;

  -- (6) Return the demoted profile's id. Preserves the
  -- `demoteProfileToUser(profileId: string): Promise<string>` contract
  -- at src/lib/db.ts post-wrap.
  return v_demoted;
end;
$$;

-- Grant execute to authenticated only. NOT to anon (no realistic caller
-- path). NOT to service_role (service-role callers go through their own
-- ad-hoc paths and `auth.uid()` is null for them anyway — explicitly
-- excluding them prevents accidental cross-tenant calls from edge
-- functions that shouldn't be reaching this path). Tighter than
-- `assert_not_last_of_role` which is granted to both — that helper is
-- read-only; this RPC is destructive.
revoke execute on function public.demote_profile_to_user(uuid) from public, anon;
grant  execute on function public.demote_profile_to_user(uuid) to authenticated;
