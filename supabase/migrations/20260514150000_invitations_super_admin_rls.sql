-- ============================================================
-- Fix: invitations RLS rejected super-admin writes.
--
-- Background: 20260424211733_security_fixes.sql:42-57 gated all four
-- invitations policies (SELECT / INSERT / UPDATE / DELETE) on a raw JWT
-- app_metadata.role check against ['admin','master']. 012a
-- (20260509000000_multi_brand_schema_rls.sql) introduced the super_admin
-- role plus auth_is_super_admin() / auth_is_privileged() helpers. The
-- profiles_sync_role trigger mirrors profiles.role verbatim into JWT
-- app_metadata.role, so a super-admin's JWT carries 'super_admin' — which
-- is NOT in ['admin','master']. Spec 025 §2.G.1 broadened the UI
-- `isMaster` predicate to include `super_admin`, surfacing the gap: the
-- Cmd UI "Invite User" button now visible to super-admins yields a server
-- RLS rejection on INSERT.
--
-- Fix: drop and recreate all four policies to use auth_is_privileged(),
-- matching the shape every other admin-only table uses post-012a (and
-- specifically the prior-art fixes at:
--   • 20260510020000_order_schedule_super_admin_rls.sql
--   • 20260510030000_recipe_categories_super_admin_rls.sql ).
-- Strict superset — admin/master JWTs continue to pass; super_admin newly
-- passes via the profiles.role path inside auth_is_super_admin().
-- Policy names preserved byte-for-byte so the end-state diff is a clean
-- replacement, not parallel policies.
-- Idempotent + re-runnable; DDL only, no data changes.
-- ============================================================

drop policy if exists "Admins can read invitations"   on public.invitations;
drop policy if exists "Admins can insert invitations" on public.invitations;
drop policy if exists "Admins can update invitations" on public.invitations;
drop policy if exists "Admins can delete invitations" on public.invitations;

create policy "Admins can read invitations"
  on public.invitations for select
  using (public.auth_is_privileged());

create policy "Admins can insert invitations"
  on public.invitations for insert
  with check (public.auth_is_privileged());

create policy "Admins can update invitations"
  on public.invitations for update
  using      (public.auth_is_privileged())
  with check (public.auth_is_privileged());

create policy "Admins can delete invitations"
  on public.invitations for delete
  using (public.auth_is_privileged());
