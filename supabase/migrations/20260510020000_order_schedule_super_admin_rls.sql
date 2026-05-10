-- ============================================================
-- Fix: order_schedule RLS rejected super-admin writes.
--
-- Background: 20260424211733_security_fixes.sql gated order_schedule
-- writes on a raw JWT app_metadata.role check against ['admin','master'].
-- 012a (20260509000000_multi_brand_schema_rls.sql) introduced the
-- super_admin role plus auth_is_super_admin() / auth_is_privileged() /
-- auth_can_see_store() helpers, but the audit comment at line 1009
-- mistakenly assumed order_schedule routed through auth_can_see_store().
-- It does not — its policies still hit the raw JWT, so super-admins
-- (whose JWT app_metadata.role mirror via the profiles_sync_role
-- trigger is 'super_admin') can read existing rows via user_stores
-- membership but cannot INSERT / UPDATE / DELETE.
--
-- Fix: drop and recreate both policies to use the helpers, matching
-- the shape every other per-store table uses post-012a. Strict
-- superset — admin/master JWT and per-store membership still pass.
-- Idempotent + re-runnable; no data changes.
-- ============================================================

drop policy if exists "Store members can read order_schedule" on public.order_schedule;
drop policy if exists "Admins can write order_schedule"        on public.order_schedule;

create policy "Store members can read order_schedule"
  on public.order_schedule for select
  using (public.auth_can_see_store(store_id));

create policy "Admins can write order_schedule"
  on public.order_schedule for all
  using      (public.auth_is_privileged())
  with check (public.auth_is_privileged());
