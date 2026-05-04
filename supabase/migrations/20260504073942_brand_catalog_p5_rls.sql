-- ============================================================
-- Brand catalog refactor — Phase 5: RLS policies
--
-- Locks down writes to brand-shared tables (catalog ingredients,
-- recipes, prep recipes, vendors, conversions, categories) to admins
-- and masters only. Reads remain open to any authed user — the brand
-- catalog is shared across everyone in the chain so anyone in the org
-- needs to see it (line cooks read recipes, store managers read par
-- levels and prep specs, admins edit them).
--
-- Per-store state tables (inventory_items, eod_submissions, waste_log,
-- audit_log, purchase_orders, pos_imports, flags, order_schedule) are
-- left as-is in this migration. They currently use a permissive
-- `auth.uid() IS NOT NULL` policy with client-side filtering by
-- user_stores membership; tightening that to a server-side
-- user_stores-scoped read policy is a separate hardening task that
-- needs an inventory of every read site to be safe.
--
-- See plan: 2-brand-catalog-refactor.md.
-- ============================================================

-- Reusable check: is the caller's role admin or master?
create or replace function public.auth_is_admin() returns boolean
language sql stable security definer set search_path = public, auth as $$
  select coalesce((auth.jwt() -> 'app_metadata' ->> 'role'), '')
    = any (array['admin', 'master']);
$$;

-- ─── recipes ────────────────────────────────────────────────
drop policy if exists "auth_manage_recipes" on public.recipes;

drop policy if exists "auth_read_recipes" on public.recipes;
create policy "auth_read_recipes"
  on public.recipes for select
  using (auth.uid() is not null);

drop policy if exists "admin_write_recipes" on public.recipes;
create policy "admin_write_recipes"
  on public.recipes for insert
  with check (public.auth_is_admin());

drop policy if exists "admin_update_recipes" on public.recipes;
create policy "admin_update_recipes"
  on public.recipes for update
  using (public.auth_is_admin())
  with check (public.auth_is_admin());

drop policy if exists "admin_delete_recipes" on public.recipes;
create policy "admin_delete_recipes"
  on public.recipes for delete
  using (public.auth_is_admin());

-- ─── prep_recipes ───────────────────────────────────────────
drop policy if exists "auth_manage_prep_recipes" on public.prep_recipes;

drop policy if exists "auth_read_prep_recipes" on public.prep_recipes;
create policy "auth_read_prep_recipes"
  on public.prep_recipes for select
  using (auth.uid() is not null);

drop policy if exists "admin_write_prep_recipes" on public.prep_recipes;
create policy "admin_write_prep_recipes"
  on public.prep_recipes for insert
  with check (public.auth_is_admin());

drop policy if exists "admin_update_prep_recipes" on public.prep_recipes;
create policy "admin_update_prep_recipes"
  on public.prep_recipes for update
  using (public.auth_is_admin())
  with check (public.auth_is_admin());

drop policy if exists "admin_delete_prep_recipes" on public.prep_recipes;
create policy "admin_delete_prep_recipes"
  on public.prep_recipes for delete
  using (public.auth_is_admin());

-- ─── recipe_ingredients ─────────────────────────────────────
drop policy if exists "auth_manage_recipe_ingredients" on public.recipe_ingredients;

drop policy if exists "auth_read_recipe_ingredients" on public.recipe_ingredients;
create policy "auth_read_recipe_ingredients"
  on public.recipe_ingredients for select
  using (auth.uid() is not null);

drop policy if exists "admin_write_recipe_ingredients" on public.recipe_ingredients;
create policy "admin_write_recipe_ingredients"
  on public.recipe_ingredients for insert
  with check (public.auth_is_admin());

drop policy if exists "admin_update_recipe_ingredients" on public.recipe_ingredients;
create policy "admin_update_recipe_ingredients"
  on public.recipe_ingredients for update
  using (public.auth_is_admin())
  with check (public.auth_is_admin());

drop policy if exists "admin_delete_recipe_ingredients" on public.recipe_ingredients;
create policy "admin_delete_recipe_ingredients"
  on public.recipe_ingredients for delete
  using (public.auth_is_admin());

-- ─── prep_recipe_ingredients ────────────────────────────────
drop policy if exists "auth_manage_prep_recipe_ingredients" on public.prep_recipe_ingredients;

drop policy if exists "auth_read_prep_recipe_ingredients" on public.prep_recipe_ingredients;
create policy "auth_read_prep_recipe_ingredients"
  on public.prep_recipe_ingredients for select
  using (auth.uid() is not null);

drop policy if exists "admin_write_prep_recipe_ingredients" on public.prep_recipe_ingredients;
create policy "admin_write_prep_recipe_ingredients"
  on public.prep_recipe_ingredients for insert
  with check (public.auth_is_admin());

drop policy if exists "admin_update_prep_recipe_ingredients" on public.prep_recipe_ingredients;
create policy "admin_update_prep_recipe_ingredients"
  on public.prep_recipe_ingredients for update
  using (public.auth_is_admin())
  with check (public.auth_is_admin());

drop policy if exists "admin_delete_prep_recipe_ingredients" on public.prep_recipe_ingredients;
create policy "admin_delete_prep_recipe_ingredients"
  on public.prep_recipe_ingredients for delete
  using (public.auth_is_admin());

-- ─── recipe_prep_items (menu→prep portion table) ────────────
-- Same pattern: brand-shared, admin-only writes.
alter table public.recipe_prep_items enable row level security;

drop policy if exists "auth_manage_recipe_prep_items" on public.recipe_prep_items;

drop policy if exists "auth_read_recipe_prep_items" on public.recipe_prep_items;
create policy "auth_read_recipe_prep_items"
  on public.recipe_prep_items for select
  using (auth.uid() is not null);

drop policy if exists "admin_write_recipe_prep_items" on public.recipe_prep_items;
create policy "admin_write_recipe_prep_items"
  on public.recipe_prep_items for insert
  with check (public.auth_is_admin());

drop policy if exists "admin_update_recipe_prep_items" on public.recipe_prep_items;
create policy "admin_update_recipe_prep_items"
  on public.recipe_prep_items for update
  using (public.auth_is_admin())
  with check (public.auth_is_admin());

drop policy if exists "admin_delete_recipe_prep_items" on public.recipe_prep_items;
create policy "admin_delete_recipe_prep_items"
  on public.recipe_prep_items for delete
  using (public.auth_is_admin());

-- ─── vendors ────────────────────────────────────────────────
drop policy if exists "auth_manage_vendors" on public.vendors;

drop policy if exists "auth_read_vendors" on public.vendors;
create policy "auth_read_vendors"
  on public.vendors for select
  using (auth.uid() is not null);

drop policy if exists "admin_write_vendors" on public.vendors;
create policy "admin_write_vendors"
  on public.vendors for insert
  with check (public.auth_is_admin());

drop policy if exists "admin_update_vendors" on public.vendors;
create policy "admin_update_vendors"
  on public.vendors for update
  using (public.auth_is_admin())
  with check (public.auth_is_admin());

drop policy if exists "admin_delete_vendors" on public.vendors;
create policy "admin_delete_vendors"
  on public.vendors for delete
  using (public.auth_is_admin());

-- ─── ingredient_conversions ─────────────────────────────────
drop policy if exists "auth_manage_ingredient_conversions" on public.ingredient_conversions;

drop policy if exists "auth_read_ingredient_conversions" on public.ingredient_conversions;
create policy "auth_read_ingredient_conversions"
  on public.ingredient_conversions for select
  using (auth.uid() is not null);

drop policy if exists "admin_write_ingredient_conversions" on public.ingredient_conversions;
create policy "admin_write_ingredient_conversions"
  on public.ingredient_conversions for insert
  with check (public.auth_is_admin());

drop policy if exists "admin_update_ingredient_conversions" on public.ingredient_conversions;
create policy "admin_update_ingredient_conversions"
  on public.ingredient_conversions for update
  using (public.auth_is_admin())
  with check (public.auth_is_admin());

drop policy if exists "admin_delete_ingredient_conversions" on public.ingredient_conversions;
create policy "admin_delete_ingredient_conversions"
  on public.ingredient_conversions for delete
  using (public.auth_is_admin());

-- ─── catalog_ingredients ────────────────────────────────────
-- Phase 1 created admin_manage_catalog_ingredients (FOR ALL). Replace
-- with the granular SELECT/INSERT/UPDATE/DELETE pattern so the read
-- side is a plain auth check (anyone in the org can see the catalog).
drop policy if exists "admin_manage_catalog_ingredients" on public.catalog_ingredients;
-- (auth_read_catalog_ingredients from Phase 1 stays.)

drop policy if exists "admin_write_catalog_ingredients" on public.catalog_ingredients;
create policy "admin_write_catalog_ingredients"
  on public.catalog_ingredients for insert
  with check (public.auth_is_admin());

drop policy if exists "admin_update_catalog_ingredients" on public.catalog_ingredients;
create policy "admin_update_catalog_ingredients"
  on public.catalog_ingredients for update
  using (public.auth_is_admin())
  with check (public.auth_is_admin());

drop policy if exists "admin_delete_catalog_ingredients" on public.catalog_ingredients;
create policy "admin_delete_catalog_ingredients"
  on public.catalog_ingredients for delete
  using (public.auth_is_admin());

-- ─── brands ─────────────────────────────────────────────────
-- Same granular pattern as catalog_ingredients — replaces the FOR ALL
-- admin_manage_brands from Phase 1.
drop policy if exists "admin_manage_brands" on public.brands;

drop policy if exists "admin_write_brands" on public.brands;
create policy "admin_write_brands"
  on public.brands for insert
  with check (public.auth_is_admin());

drop policy if exists "admin_update_brands" on public.brands;
create policy "admin_update_brands"
  on public.brands for update
  using (public.auth_is_admin())
  with check (public.auth_is_admin());

drop policy if exists "admin_delete_brands" on public.brands;
create policy "admin_delete_brands"
  on public.brands for delete
  using (public.auth_is_admin());
