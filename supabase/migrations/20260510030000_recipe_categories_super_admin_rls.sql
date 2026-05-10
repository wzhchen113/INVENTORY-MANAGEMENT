-- ============================================================
-- Fix: recipe_categories RLS rejected super-admin writes.
--
-- Background: 20260424211733_security_fixes.sql gated recipe_categories
-- writes on a raw JWT app_metadata.role check against ['admin','master'].
-- 012a (20260509000000_multi_brand_schema_rls.sql) introduced the
-- super_admin role plus auth_is_super_admin() / auth_is_privileged() /
-- auth_can_see_store() helpers. The profiles_sync_role trigger mirrors
-- profiles.role verbatim into JWT app_metadata.role, so a super-admin's
-- JWT carries 'super_admin' — which is NOT in ['admin','master']. Result:
-- super-admins were silently rejected on INSERT / UPDATE / DELETE.
--
-- Fix: drop and recreate the WRITE policy to use auth_is_privileged(),
-- matching the shape every other admin-only table uses post-012a. Strict
-- superset — admin/master JWTs continue to pass; super_admin newly passes.
-- The SELECT policy "Authenticated can read categories" is intentionally
-- left untouched — its auth.uid() is not null predicate already passes
-- for super-admins.
-- Idempotent + re-runnable; no data changes.
-- ============================================================

drop policy if exists "Admins can write categories" on public.recipe_categories;

create policy "Admins can write categories"
  on public.recipe_categories for all
  using      (public.auth_is_privileged())
  with check (public.auth_is_privileged());
