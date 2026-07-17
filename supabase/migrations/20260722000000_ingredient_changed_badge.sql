-- ============================================================
-- Spec 128 — "Updated" badge for changed ingredients on staff count screens.
--
-- Records a "product effectively changed" timestamp on two write paths and
-- exposes a per-(store, item) "changed since that store last counted it"
-- signal for the staff EOD + Weekly count screens. Backend design §1/§3.
--
--   (a) catalog_ingredients.image_changed_at  — brand-level (one row shared by
--       all stores). Stamped by a BEFORE UPDATE trigger when image_path changes.
--   (b) inventory_items.vendor_changed_at     — per-store. Stamped by a BEFORE
--       UPDATE trigger when vendor_id (the primary vendor scalar) changes.
--   (c) An insurance index on eod_entries(item_id) for the RPC's per-item
--       last-counted aggregate (inventory_count_entries already has an
--       (item_id, created_at) index from spec 019; eod_entries had none).
--   (d) staff_items_updated(p_store_id) — SECURITY INVOKER set-returning RPC,
--       the single source of truth for the badge. Rides existing per-store /
--       per-brand RLS (no new policy needed).
--
-- Hard ordering dependency: references catalog_ingredients.image_path, added by
-- spec 127's 20260721000000_ingredient_photos.sql. The 20260722… timestamp
-- guarantees this runs after 127 both locally and in prod. Do NOT apply 128 to
-- prod before 127.
--
-- Additive + non-destructive: nullable columns (NULL = never changed, no
-- backfill → nothing renders "updated" retroactively). BEFORE triggers only set
-- a NEW column on the row being written; INSERT is NOT covered (creation is not
-- a "change"). Realtime: NO publication change — image_changed_at /
-- vendor_changed_at land on catalog_ingredients / inventory_items, already in
-- supabase_realtime (FOR ALL TABLES); the docker-restart gotcha does NOT apply.
--
-- Idempotent for the local + prod (MCP) double-apply: `add column if not
-- exists`, `create index if not exists`, `create or replace function`, and
-- `drop trigger if exists` before each `create trigger`.
-- ============================================================

-- (a)+(b) Columns — additive, nullable, no default, no backfill.
alter table public.catalog_ingredients
  add column if not exists image_changed_at timestamptz;
alter table public.inventory_items
  add column if not exists vendor_changed_at timestamptz;

-- (c) Insurance index for the RPC's per-item last-counted aggregate.
create index if not exists eod_entries_item_id_idx
  on public.eod_entries(item_id);

-- ─── Trigger: stamp catalog_ingredients.image_changed_at on photo change ───
create or replace function public.stamp_catalog_image_changed_at()
returns trigger
language plpgsql
set search_path = pg_catalog
as $$
begin
  if new.image_path is distinct from old.image_path then
    new.image_changed_at := now();
  end if;
  return new;
end $$;

drop trigger if exists trg_catalog_image_changed_at on public.catalog_ingredients;
create trigger trg_catalog_image_changed_at
  before update on public.catalog_ingredients
  for each row execute function public.stamp_catalog_image_changed_at();

-- ─── Trigger: stamp inventory_items.vendor_changed_at on primary-vendor change ───
-- Only fires when the SCALAR vendor_id actually changes (IS DISTINCT FROM). Does
-- NOT touch item_vendors — the SD-1 "one writer owns both" invariant governs the
-- item_vendors.is_primary mirror, which this trigger never reads or writes. A
-- cost-only / vendors-only edit that leaves vendor_id unchanged does NOT stamp.
create or replace function public.stamp_item_vendor_changed_at()
returns trigger
language plpgsql
set search_path = pg_catalog
as $$
begin
  if new.vendor_id is distinct from old.vendor_id then
    new.vendor_changed_at := now();
  end if;
  return new;
end $$;

drop trigger if exists trg_item_vendor_changed_at on public.inventory_items;
create trigger trg_item_vendor_changed_at
  before update on public.inventory_items
  for each row execute function public.stamp_item_vendor_changed_at();

-- ─── RPC: staff_items_updated(p_store_id) ───────────────────────────────────
-- SECURITY INVOKER → reads under the caller's existing RLS. A manager only sees
-- their own store's inventory_items / count rows and brand-visible catalog rows;
-- an RLS-invisible store returns an empty set (no explicit 42501 gate needed).
--
-- For each of the store's inventory_items:
--   changed_at      = greatest(catalog.image_changed_at, item.vendor_changed_at)
--                     — greatest() ignores NULLs, returns NULL only when BOTH are
--                       NULL (photo-only / vendor-only / both / neither semantics).
--   last_counted_at = max(submitted_at) over the UNION of SUBMITTED eod counts
--                     (eod_submissions ⨝ eod_entries) and SUBMITTED weekly/any
--                     counts (inventory_counts ⨝ inventory_count_entries) for
--                     that (store, item). Draft/unsubmitted counts excluded.
--   updated         = changed_at IS NOT NULL
--                       AND (last_counted_at IS NULL OR changed_at > last_counted_at)
create or replace function public.staff_items_updated(p_store_id uuid)
returns table(item_id uuid, changed_at timestamptz, last_counted_at timestamptz, updated boolean)
language sql
stable
security invoker
set search_path = public
as $$
  select
    ii.id,
    ge.changed_at,
    lc.last_counted_at,
    (ge.changed_at is not null
       and (lc.last_counted_at is null or ge.changed_at > lc.last_counted_at)) as updated
  from public.inventory_items ii
  join public.catalog_ingredients ci on ci.id = ii.catalog_id
  cross join lateral (
    select greatest(ci.image_changed_at, ii.vendor_changed_at) as changed_at
  ) ge
  left join lateral (
    select max(t.submitted_at) as last_counted_at
    from (
      select es.submitted_at
        from public.eod_submissions es
        join public.eod_entries ee on ee.submission_id = es.id
       where es.store_id = p_store_id and ee.item_id = ii.id and es.status = 'submitted'
      union all
      select ic.submitted_at
        from public.inventory_counts ic
        join public.inventory_count_entries ice on ice.count_id = ic.id
       where ic.store_id = p_store_id and ice.item_id = ii.id and ic.status = 'submitted'
    ) t
  ) lc on true
  where ii.store_id = p_store_id;
$$;

revoke execute on function public.staff_items_updated(uuid) from public, anon;
grant  execute on function public.staff_items_updated(uuid) to authenticated;
