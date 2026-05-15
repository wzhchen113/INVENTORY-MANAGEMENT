-- supabase/migrations/20260514160000_assert_not_last_of_role.sql
--
-- Spec 031 — last-super-admin / master deletion guard. Single source
-- of truth for the "would this delete leave zero super_admins / masters"
-- invariant. Called by:
--   1. supabase/functions/delete-user/index.ts (via RPC) before
--      auth.admin.deleteUser() and the user_stores / profiles /
--      invitations cleanup.
--   2. supabase/tests/delete_last_privileged_guard.test.sql (direct
--      SELECT) — regression test.
--
-- Foot-gun being closed: with zero super_admins (or zero masters), the
-- Cmd UI Tenancy / Brands sidebar group disappears and there is no
-- in-app path to promote anyone back. Recovery would require direct
-- psql access — which violates the project's no-prod-dashboard-SQL
-- convention. This guard refuses the delete at the DB layer.
--
-- Strictly additive. No tables/policies touched. No publication change
-- (no docker restart supabase_realtime_imr-inventory needed).
-- Idempotent (CREATE OR REPLACE).
--
-- security definer + set search_path: the helper must count
-- public.profiles rows globally, not filtered through the caller's RLS
-- view. auth_can_see_store() / brand RLS would otherwise return a
-- brand-scoped count for a brand-admin caller, which is the wrong
-- predicate ("last super_admin in my brand" is meaningless —
-- super_admin has brand_id IS NULL by the profiles_role_brand_consistent
-- CHECK). security definer runs with the function owner's rights and
-- bypasses RLS for the count. set search_path locks resolution to
-- public, auth — same shape as auth_is_super_admin() /
-- auth_can_see_brand() in 20260509000000_multi_brand_schema_rls.sql.
--
-- errcode = 'P0001': the standard PostgreSQL "raise_exception" SQLSTATE
-- for plpgsql `raise exception` without an explicit code. pgTAP's
-- throws_ok() matches this by default. This is a caller-error class —
-- the caller asked for an op that would break the system state — not
-- an authz failure (42501).

create or replace function public.assert_not_last_of_role(
  target_user_id uuid,
  target_role    text
)
returns void
language plpgsql
stable
security definer
set search_path = public, auth
as $$
declare
  v_count   bigint;
  v_message text;
begin
  -- No-op for roles we don't guard. 'admin' and 'user' deletes are
  -- not foot-guns; only the two privileged singleton roles are.
  if target_role is null or target_role not in ('super_admin', 'master') then
    return;
  end if;

  select count(*)::bigint
    into v_count
    from public.profiles
   where role = target_role
     and id <> target_user_id;

  -- If no OTHER rows of this role exist, deleting the target would
  -- leave zero. Refuse.
  if v_count = 0 then
    v_message := case target_role
      when 'super_admin' then 'cannot delete the last super_admin'
      when 'master'      then 'cannot delete the last master'
      else format('cannot delete the last %s', target_role)
    end;
    raise exception using
      errcode = 'P0001',
      message = v_message;
  end if;
end;
$$;

grant execute on function public.assert_not_last_of_role(uuid, text) to authenticated, service_role;
