-- ============================================================
-- Towson Inventory — Supabase Database Schema
-- Run this entire file in: Supabase Dashboard → SQL Editor → New query
-- ============================================================

-- Enable UUID generation
create extension if not exists "uuid-ossp";

-- ─── STORES ──────────────────────────────────────────────
create table if not exists stores (
  id          uuid primary key default uuid_generate_v4(),
  name        text not null,
  address     text,
  status      text default 'active',  -- 'active' | 'inactive'
  created_at  timestamptz default now()
);

-- ─── USERS (extends Supabase auth.users) ─────────────────
create table if not exists profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  name        text not null,
  role        text not null default 'user',  -- 'admin' | 'user'
  initials    text,
  color       text default '#378ADD',
  status      text default 'active',         -- 'active' | 'pending'
  created_at  timestamptz default now()
);

-- Junction: which stores a user can access
create table if not exists user_stores (
  user_id   uuid references profiles(id) on delete cascade,
  store_id  uuid references stores(id) on delete cascade,
  primary key (user_id, store_id)
);

-- ─── VENDORS ─────────────────────────────────────────────
create table if not exists vendors (
  id              uuid primary key default uuid_generate_v4(),
  name            text not null,
  contact_name    text,
  phone           text,
  email           text,
  account_number  text,
  lead_time_days  int default 2,
  categories      text[],
  last_order_date date,
  created_at      timestamptz default now()
);

-- ─── INVENTORY ITEMS ─────────────────────────────────────
create table if not exists inventory_items (
  id                  uuid primary key default uuid_generate_v4(),
  store_id            uuid references stores(id),
  name                text not null,
  category            text,
  unit                text,
  cost_per_unit       numeric(10,2) default 0,
  current_stock       numeric(10,3) default 0,
  par_level           numeric(10,3) default 0,
  vendor_id           uuid references vendors(id),
  usage_per_portion   numeric(10,4) default 0,
  expiry_date         date,
  last_updated_by     uuid references profiles(id),
  eod_remaining       numeric(10,3) default 0,
  created_at          timestamptz default now(),
  updated_at          timestamptz default now()
);

-- ─── RECIPES / BILL OF MATERIALS ─────────────────────────
create table if not exists recipes (
  id          uuid primary key default uuid_generate_v4(),
  store_id    uuid references stores(id),
  menu_item   text not null,
  category    text,
  sell_price  numeric(10,2) default 0,
  created_at  timestamptz default now()
);

create table if not exists recipe_ingredients (
  id          uuid primary key default uuid_generate_v4(),
  recipe_id   uuid references recipes(id) on delete cascade,
  item_id     uuid references inventory_items(id),
  quantity    numeric(10,4),
  unit        text
);

-- ─── PREP RECIPES ────────────────────────────────────────
create table if not exists prep_recipes (
  id              uuid primary key default uuid_generate_v4(),
  store_id        uuid references stores(id),
  name            text not null,
  category        text,
  yield_quantity  numeric(10,3) not null,
  yield_unit      text not null,
  notes           text,
  created_by      uuid references profiles(id),
  created_at      timestamptz default now()
);

create table if not exists prep_recipe_ingredients (
  id              uuid primary key default uuid_generate_v4(),
  prep_recipe_id  uuid references prep_recipes(id) on delete cascade,
  item_id         uuid references inventory_items(id),
  quantity        numeric(10,4),
  unit            text
);

-- ─── RECIPE PREP ITEMS (menu recipe → prep recipe) ──────
create table if not exists recipe_prep_items (
  id              uuid primary key default uuid_generate_v4(),
  recipe_id       uuid references recipes(id) on delete cascade,
  prep_recipe_id  uuid references prep_recipes(id),
  quantity        numeric(10,4),
  unit            text
);

-- ─── EOD SUBMISSIONS ─────────────────────────────────────
create table if not exists eod_submissions (
  id                    uuid primary key default uuid_generate_v4(),
  store_id              uuid references stores(id),
  date                  date not null,
  submitted_by          uuid references profiles(id),
  submitted_at          timestamptz default now(),
  status                text default 'submitted'  -- 'draft' | 'submitted'
);

create table if not exists eod_entries (
  id              uuid primary key default uuid_generate_v4(),
  submission_id   uuid references eod_submissions(id) on delete cascade,
  item_id         uuid references inventory_items(id),
  actual_remaining numeric(10,3),
  notes           text,
  created_at      timestamptz default now()
);

-- ─── WASTE LOG ───────────────────────────────────────────
create table if not exists waste_log (
  id              uuid primary key default uuid_generate_v4(),
  store_id        uuid references stores(id),
  item_id         uuid references inventory_items(id),
  quantity        numeric(10,3),
  unit            text,
  cost_per_unit   numeric(10,2),
  reason          text,  -- 'Expired' | 'Dropped/spilled' | 'Over-prepped' | 'Quality issue' | 'Theft' | 'Other'
  logged_by       uuid references profiles(id),
  notes           text,
  logged_at       timestamptz default now()
);

-- ─── PURCHASE ORDERS ─────────────────────────────────────
create table if not exists purchase_orders (
  id                uuid primary key default uuid_generate_v4(),
  store_id          uuid references stores(id),
  po_number         text unique,
  vendor_id         uuid references vendors(id),
  created_by        uuid references profiles(id),
  expected_delivery date,
  total_cost        numeric(10,2),
  status            text default 'draft',  -- 'draft' | 'sent' | 'received' | 'partial'
  received_at       timestamptz,
  received_by       uuid references profiles(id),
  created_at        timestamptz default now()
);

create table if not exists po_items (
  id            uuid primary key default uuid_generate_v4(),
  po_id         uuid references purchase_orders(id) on delete cascade,
  item_id       uuid references inventory_items(id),
  ordered_qty   numeric(10,3),
  received_qty  numeric(10,3),
  cost_per_unit numeric(10,2)
);

-- ─── POS IMPORTS ─────────────────────────────────────────
create table if not exists pos_imports (
  id           uuid primary key default uuid_generate_v4(),
  store_id     uuid references stores(id),
  filename     text,
  imported_by  uuid references profiles(id),
  import_date  date,
  imported_at  timestamptz default now()
);

create table if not exists pos_import_items (
  id              uuid primary key default uuid_generate_v4(),
  import_id       uuid references pos_imports(id) on delete cascade,
  menu_item       text,
  qty_sold        numeric(10,2),
  revenue         numeric(10,2),
  recipe_id       uuid references recipes(id),
  recipe_mapped   boolean default false
);

-- ─── AUDIT LOG ───────────────────────────────────────────
create table if not exists audit_log (
  id          uuid primary key default uuid_generate_v4(),
  store_id    uuid references stores(id),
  user_id     uuid references profiles(id),
  action      text not null,
  detail      text,
  item_ref    text,
  value       text,
  created_at  timestamptz default now()
);

-- ─── AUTO-UPDATE timestamp trigger ───────────────────────
create or replace function update_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger inventory_items_updated_at
  before update on inventory_items
  for each row execute function update_updated_at();

-- ─── AUTO-GENERATE PO number ─────────────────────────────
create or replace function generate_po_number()
returns trigger as $$
declare
  next_num int;
begin
  select coalesce(max(cast(substring(po_number from 4) as int)), 0) + 1
  into next_num
  from purchase_orders;
  new.po_number = 'PO-' || lpad(next_num::text, 3, '0');
  return new;
end;
$$ language plpgsql;

create trigger set_po_number
  before insert on purchase_orders
  for each row
  when (new.po_number is null)
  execute function generate_po_number();

-- ─── ROW LEVEL SECURITY ──────────────────────────────────
alter table stores             enable row level security;
alter table profiles           enable row level security;
alter table user_stores        enable row level security;
alter table inventory_items    enable row level security;
alter table recipes            enable row level security;
alter table recipe_ingredients enable row level security;
alter table eod_submissions    enable row level security;
alter table eod_entries        enable row level security;
alter table waste_log          enable row level security;
alter table purchase_orders    enable row level security;
alter table po_items           enable row level security;
alter table pos_imports        enable row level security;
alter table pos_import_items   enable row level security;
alter table audit_log          enable row level security;
alter table prep_recipes        enable row level security;
alter table prep_recipe_ingredients enable row level security;
alter table recipe_prep_items   enable row level security;
alter table vendors            enable row level security;

-- Users can only see their own profile
create policy "Own profile" on profiles
  for all using (auth.uid() = id);

-- Users only see stores they are assigned to
create policy "Store access" on inventory_items
  for all using (
    store_id in (
      select store_id from user_stores where user_id = auth.uid()
    )
  );

-- Same store-scoped policy for all other tables
create policy "Store access" on eod_submissions for all using (store_id in (select store_id from user_stores where user_id = auth.uid()));
create policy "Store access" on eod_entries for all using (submission_id in (select id from eod_submissions where store_id in (select store_id from user_stores where user_id = auth.uid())));
create policy "Store access" on waste_log for all using (store_id in (select store_id from user_stores where user_id = auth.uid()));
create policy "Store access" on purchase_orders for all using (store_id in (select store_id from user_stores where user_id = auth.uid()));
create policy "Store access" on pos_imports for all using (store_id in (select store_id from user_stores where user_id = auth.uid()));
create policy "Store access" on audit_log for all using (store_id in (select store_id from user_stores where user_id = auth.uid()));
create policy "Store access" on recipes for all using (store_id in (select store_id from user_stores where user_id = auth.uid()));
create policy "Store access" on prep_recipes for all using (store_id in (select store_id from user_stores where user_id = auth.uid()));
create policy "Store access" on prep_recipe_ingredients for all using (prep_recipe_id in (select id from prep_recipes where store_id in (select store_id from user_stores where user_id = auth.uid())));
create policy "Store access" on recipe_prep_items for all using (recipe_id in (select id from recipes where store_id in (select store_id from user_stores where user_id = auth.uid())));
create policy "Vendors visible to all" on vendors for select using (true);
create policy "Vendors admin only" on vendors for insert with check ((select role from profiles where id = auth.uid()) = 'admin');

-- ─── SEED STORES ─────────────────────────────────────────
insert into stores (id, name, address) values
  ('00000000-0000-0000-0000-000000000001', 'Towson',    '1234 York Rd, Towson MD 21204'),
  ('00000000-0000-0000-0000-000000000002', 'Baltimore', '456 Inner Harbor Blvd, Baltimore MD 21201')
on conflict do nothing;
