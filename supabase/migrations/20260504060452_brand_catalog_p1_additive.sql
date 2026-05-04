-- ============================================================
-- Brand catalog refactor — Phase 1: additive schema (non-breaking)
--
-- Adds the brand model alongside the existing per-store schema:
--   - new `brands` table (single tenant: "2AM PROJECT")
--   - new `catalog_ingredients` table (brand-level ingredient master)
--   - nullable `brand_id` columns on stores/vendors/recipes/prep_recipes
--   - nullable `catalog_id` columns on inventory_items, recipe_ingredients,
--     prep_recipe_ingredients, ingredient_conversions
--
-- Nothing reads these columns yet. The running app keeps working unchanged.
-- Phase 2 backfills the data; Phase 3 adds NOT NULL + drops redundant
-- per-store columns. See plan: 2-brand-catalog-refactor.md.
-- ============================================================

-- ─── BRANDS ─────────────────────────────────────────────
create table if not exists public.brands (
  id          uuid primary key default uuid_generate_v4(),
  name        text not null unique,
  created_at  timestamptz default now()
);

-- Sentinel id for "2AM PROJECT" so seed.sql can be idempotent and
-- migrations referencing the brand have a stable target. Pattern matches
-- the Towson sentinel store id (00000000-...001).
insert into public.brands (id, name)
values ('2a000000-0000-0000-0000-000000000001', '2AM PROJECT')
on conflict (id) do nothing;

-- ─── CATALOG_INGREDIENTS ────────────────────────────────
-- Brand-level ingredient master. Each row defines an ingredient as a
-- thing the brand uses (name, unit, packaging). Per-store rows in
-- inventory_items will FK to this in Phase 2.
create table if not exists public.catalog_ingredients (
  id                  uuid primary key default uuid_generate_v4(),
  brand_id            uuid not null references public.brands(id) on delete cascade,
  name                text not null,
  unit                text not null,
  category            text,
  case_qty            numeric default 1,
  sub_unit_size       numeric default 1,
  sub_unit_unit       text default '',
  default_cost        numeric default 0,
  default_case_price  numeric default 0,
  created_at          timestamptz default now(),
  updated_at          timestamptz default now()
);

-- Case-insensitive uniqueness on (brand_id, name) — prevents accidental
-- "Mac n Cheese" / "mac n cheese" duplicates within a brand.
create unique index if not exists catalog_ingredients_brand_name_lower_unique
  on public.catalog_ingredients (brand_id, lower(name));

-- ─── ADD brand_id TO EXISTING TABLES (nullable; backfill in Phase 2) ──
alter table public.stores       add column if not exists brand_id uuid references public.brands(id);
alter table public.vendors      add column if not exists brand_id uuid references public.brands(id);
alter table public.recipes      add column if not exists brand_id uuid references public.brands(id);
alter table public.prep_recipes add column if not exists brand_id uuid references public.brands(id);

-- ─── ADD catalog_id LINKS (nullable; backfill in Phase 2) ─────────────
alter table public.inventory_items
  add column if not exists catalog_id uuid references public.catalog_ingredients(id);

alter table public.recipe_ingredients
  add column if not exists catalog_id uuid references public.catalog_ingredients(id);

alter table public.prep_recipe_ingredients
  add column if not exists catalog_id uuid references public.catalog_ingredients(id);

alter table public.ingredient_conversions
  add column if not exists catalog_id uuid references public.catalog_ingredients(id);

-- ─── RLS for new tables ──────────────────────────────────
-- brands + catalog_ingredients are readable by any authed user (catalog
-- is shared across the brand) and writable by admin/master roles only.
alter table public.brands              enable row level security;
alter table public.catalog_ingredients enable row level security;

drop policy if exists "auth_read_brands" on public.brands;
create policy "auth_read_brands"
  on public.brands for select
  using (auth.uid() is not null);

drop policy if exists "admin_manage_brands" on public.brands;
create policy "admin_manage_brands"
  on public.brands for all
  using (
    coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '') in ('admin', 'master')
  )
  with check (
    coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '') in ('admin', 'master')
  );

drop policy if exists "auth_read_catalog_ingredients" on public.catalog_ingredients;
create policy "auth_read_catalog_ingredients"
  on public.catalog_ingredients for select
  using (auth.uid() is not null);

drop policy if exists "admin_manage_catalog_ingredients" on public.catalog_ingredients;
create policy "admin_manage_catalog_ingredients"
  on public.catalog_ingredients for all
  using (
    coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '') in ('admin', 'master')
  )
  with check (
    coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '') in ('admin', 'master')
  );
