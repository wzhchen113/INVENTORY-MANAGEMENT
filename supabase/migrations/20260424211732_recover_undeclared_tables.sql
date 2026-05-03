-- ============================================================
-- Recover tables / functions / extensions that were created in prod
-- via the SQL editor (or enabled at the platform level) but never
-- captured in a migration file. Reconstructed from app code
-- (src/lib/db.ts, supabase/functions/) so `supabase db reset` produces
-- the same schema the prod DB has.
--
-- All `create ... if not exists` so this is safe to apply to prod —
-- existing objects remain untouched.
--
-- RLS for order_schedule, invitations, recipe_categories is set in the
-- next migration (20260424211733_security_fixes.sql); we don't duplicate
-- it here.
-- ============================================================

-- ─── extensions ──────────────────────────────────────────
-- pg_cron + pg_net are enabled at the platform level in Supabase prod
-- but not in local Supabase Docker. Enable here so security_fixes can
-- clean up stale cron jobs and the scripts/ cron schedule will run.
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- ─── recipe_categories ───────────────────────────────────
create table if not exists public.recipe_categories (
  id          uuid primary key default uuid_generate_v4(),
  name        text not null unique,
  created_at  timestamptz default now()
);

-- ─── ingredient_categories ───────────────────────────────
create table if not exists public.ingredient_categories (
  id          uuid primary key default uuid_generate_v4(),
  name        text not null unique,
  created_at  timestamptz default now()
);

alter table public.ingredient_categories enable row level security;

drop policy if exists "Authenticated can read ingredient categories" on public.ingredient_categories;
create policy "Authenticated can read ingredient categories"
  on public.ingredient_categories for select
  using (auth.uid() is not null);

drop policy if exists "Admins can write ingredient categories" on public.ingredient_categories;
create policy "Admins can write ingredient categories"
  on public.ingredient_categories for all
  using (((auth.jwt() -> 'app_metadata' ->> 'role') = any (array['admin','master'])))
  with check (((auth.jwt() -> 'app_metadata' ->> 'role') = any (array['admin','master'])));

-- ─── ingredient_conversions ──────────────────────────────
-- Maps purchase_unit (e.g. "case") → base_unit (e.g. "g") with conversion_factor.
-- net_yield_pct discounts for processing/waste loss (0–100).
-- Upserts in db.ts conflict on (inventory_item_id, purchase_unit).
create table if not exists public.ingredient_conversions (
  id                  uuid primary key default uuid_generate_v4(),
  inventory_item_id   uuid not null references public.inventory_items(id) on delete cascade,
  purchase_unit       text not null,
  base_unit           text not null,
  conversion_factor   numeric(12,4) not null,
  net_yield_pct       numeric(5,2) default 100,
  created_at          timestamptz default now(),
  updated_at          timestamptz default now(),
  unique (inventory_item_id, purchase_unit)
);

create index if not exists idx_ingredient_conversions_item
  on public.ingredient_conversions(inventory_item_id);

alter table public.ingredient_conversions enable row level security;

drop policy if exists "Authenticated can read ingredient conversions" on public.ingredient_conversions;
create policy "Authenticated can read ingredient conversions"
  on public.ingredient_conversions for select
  using (auth.uid() is not null);

drop policy if exists "Admins can write ingredient conversions" on public.ingredient_conversions;
create policy "Admins can write ingredient conversions"
  on public.ingredient_conversions for all
  using (((auth.jwt() -> 'app_metadata' ->> 'role') = any (array['admin','master'])))
  with check (((auth.jwt() -> 'app_metadata' ->> 'role') = any (array['admin','master'])));

-- ─── order_schedule ──────────────────────────────────────
-- Recurring vendor-order calendar per store, keyed by day_of_week.
-- saveOrderSchedule deletes-then-inserts per (store_id, day_of_week),
-- so no unique constraint on (store_id, day_of_week, vendor_id).
create table if not exists public.order_schedule (
  id            uuid primary key default uuid_generate_v4(),
  store_id      uuid not null references public.stores(id) on delete cascade,
  day_of_week   text not null,
  vendor_id     uuid references public.vendors(id) on delete set null,
  vendor_name   text,
  delivery_day  text,
  created_at    timestamptz default now()
);

create index if not exists idx_order_schedule_store_day
  on public.order_schedule(store_id, day_of_week);

-- ─── invitations ─────────────────────────────────────────
create table if not exists public.invitations (
  id          uuid primary key default uuid_generate_v4(),
  email       text not null,
  name        text not null,
  role        text not null,
  store_ids   text[] default '{}',
  profile_id  uuid,
  used        boolean default false,
  expires_at  timestamptz,
  created_at  timestamptz default now()
);

create index if not exists idx_invitations_email_used
  on public.invitations(email, used);

-- ─── sync_role_to_app_metadata() ─────────────────────────
-- Mirrors public.profiles.role into auth.users.raw_app_meta_data->'role',
-- so admin RLS checks via `auth.jwt() -> 'app_metadata' ->> 'role'` work.
-- The function existed in prod (security_fixes hardens its search_path)
-- but was never captured in a migration. Reconstructed here.
create or replace function public.sync_role_to_app_metadata()
returns trigger
language plpgsql
security definer
as $$
begin
  update auth.users
     set raw_app_meta_data = coalesce(raw_app_meta_data, '{}'::jsonb)
                             || jsonb_build_object('role', new.role)
   where id = new.id;
  return new;
end;
$$;

drop trigger if exists profiles_sync_role on public.profiles;
create trigger profiles_sync_role
  after insert or update of role on public.profiles
  for each row execute function public.sync_role_to_app_metadata();
