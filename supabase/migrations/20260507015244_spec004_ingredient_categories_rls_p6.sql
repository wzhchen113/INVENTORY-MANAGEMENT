-- ============================================================
-- Spec 004 — Phase 6: tighten RLS on `ingredient_categories`.
--
-- Background: the `recover_undeclared_tables` migration (2026-04-24)
-- created an admin-gated split (auth read / admin write/update/delete),
-- but `20260502071736_remote_schema.sql:300-305` overwrote that with
-- a single permissive `auth_manage_ingredient_categories` policy
-- (`for all to public using (auth.uid() is not null)`). The brand-
-- catalog Phase 5 hardening (`20260504073942_brand_catalog_p5_rls.sql`)
-- re-tightened sibling tables (ingredient_conversions, vendors,
-- catalog_ingredients) but did not touch ingredient_categories.
--
-- Spec 004 introduces an admin-facing CategoriesSection in the Cmd
-- UI that writes through these policies, exposing the gap to the
-- product surface. Re-tighten now using the same shape Phase 5
-- applied to ingredient_conversions: authenticated SELECT, admin-
-- gated INSERT/UPDATE/DELETE via `auth_is_admin()`.
--
-- Idempotent: every policy creation is preceded by a `drop policy
-- if exists` so re-running is safe.
-- ============================================================

drop policy if exists "auth_manage_ingredient_categories" on public.ingredient_categories;

-- Some pre-P5 environments may still carry the legacy split-policy
-- names from `recover_undeclared_tables`; drop those too so the
-- final state is deterministic.
drop policy if exists "Authenticated can read ingredient categories" on public.ingredient_categories;
drop policy if exists "Admins can write ingredient categories" on public.ingredient_categories;
drop policy if exists "Admins can update ingredient categories" on public.ingredient_categories;
drop policy if exists "Admins can delete ingredient categories" on public.ingredient_categories;

create policy "Authenticated can read ingredient categories"
  on public.ingredient_categories for select
  using (auth.uid() is not null);

create policy "Admins can write ingredient categories"
  on public.ingredient_categories for insert
  with check (public.auth_is_admin());

create policy "Admins can update ingredient categories"
  on public.ingredient_categories for update
  using (public.auth_is_admin())
  with check (public.auth_is_admin());

create policy "Admins can delete ingredient categories"
  on public.ingredient_categories for delete
  using (public.auth_is_admin());
