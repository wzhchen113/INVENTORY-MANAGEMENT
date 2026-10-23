-- ============================================================
-- Spec 171 — Per-ingredient EOD count mode (cases + units / cases only /
-- units only).
--
-- What (design §1, §3):
--
--   (a) catalog_ingredients.eod_count_mode — text NOT NULL DEFAULT
--       'cases_and_units'. Brand-level, next to case_qty. On PG 17 a constant
--       default is metadata-only: no row rewrite, every pre-existing row reads
--       'cases_and_units' the moment this commits (AC-3). No UPDATE backfill.
--
--   (b) CHECK catalog_ingredients_eod_count_mode_check admitting exactly
--       'cases_and_units' | 'cases_only' | 'units_only'. Bad values raise
--       23514, NULL raises 23502 (AC-2).
--
--   (c) create_inventory_item_with_catalog gains a 13th parameter,
--       p_eod_count_mode text default 'cases_and_units', added LAST. The
--       12-arg overload (20260517000000_user_data_i18n_names.sql) is DROPPED
--       first in this same transaction — if both overloads survived, every
--       legacy call that omits p_eod_count_mode would get PGRST203
--       (ambiguous). Body is verbatim from 20260517000000 with three edits:
--         1. eod_count_mode in the catalog INSERT column list
--            (coalesce(p_eod_count_mode, 'cases_and_units'));
--         2. the find-existing / `on conflict do update set updated_at = now()`
--            branch is UNTOUCHED — mode is NOT overwritten on find-existing,
--            exactly like case_qty / i18n_names;
--         3. 'eod_count_mode' added to the returned `catalog` jsonb so mapItem
--            hydrates the created row without a refetch.
--
-- RLS: NO policy change. The column rides the existing brand-scoped policies
-- on catalog_ingredients (20260509000000_multi_brand_schema_rls.sql):
-- brand_member_read_catalog_ingredients (staff read it through the
-- item_vendors → inventory_items → catalog_ingredients embed) and
-- privileged_update_catalog_ingredients (auth_is_privileged() AND
-- auth_can_see_brand(brand_id)) for writes. The table-level grants from spec
-- 097 (20260618000000_public_grants_explicit.sql) cover the new column; no
-- column-level grant is needed.
--
-- RPC grants: `revoke all … from public, anon` + `grant execute … to
-- authenticated` on the new 13-arg signature. A freshly created function
-- picks up Postgres' implicit PUBLIC EXECUTE plus spec 097's ALTER DEFAULT
-- PRIVILEGES grant to anon, so both must be revoked (same idiom as
-- 20261008000000_get_profile_emails.sql). This is a deliberate slight
-- TIGHTENING vs. the 12-arg version (anon could EXECUTE via PUBLIC, though
-- RLS blocked any write). service_role keeps EXECUTE via default privileges.
-- SECURITY INVOKER is preserved.
--
-- Realtime: NONE. catalog_ingredients is already in supabase_realtime
-- (20260514140000_realtime_publication_tighten.sql) with no column list, so
-- ADD COLUMN needs no ALTER PUBLICATION and the realtime-restart gotcha does
-- not apply.
--
-- Triggers: the only UPDATE trigger (trg_catalog_image_changed_at) stamps on
-- image_path IS DISTINCT FROM only, so a mode change does NOT raise the
-- spec-128 "Updated" badge.
--
-- Idempotent for the local + prod (MCP) double-apply: `add column if not
-- exists`, `drop constraint if exists` + `add constraint`, the 12-arg
-- `drop function if exists` is a no-op on re-run, and `create or replace`
-- reconciles the 13-arg body.
-- ============================================================

begin;

-- (a) Column ---------------------------------------------------------------
alter table public.catalog_ingredients
  add column if not exists eod_count_mode text not null default 'cases_and_units';

-- (b) CHECK (drop-then-add keeps the definition deterministic on re-run) ----
alter table public.catalog_ingredients
  drop constraint if exists catalog_ingredients_eod_count_mode_check;
alter table public.catalog_ingredients
  add constraint catalog_ingredients_eod_count_mode_check
  check (eod_count_mode in ('cases_and_units', 'cases_only', 'units_only'));

comment on column public.catalog_ingredients.eod_count_mode is
  'Spec 171: EOD count input mode — cases_and_units (default; total = '
  'cases*case_qty + units), cases_only, or units_only. Brand-level. INERT when '
  'case_qty <= 1: clients resolve the effective mode to units_only regardless '
  'of the stored value. The stored value is never normalized on save, so '
  'raising case_qty back above 1 resurfaces the prior choice. UI-input '
  'restriction only: staff_submit_eod / eod_entries do not enforce it.';

-- (c) RPC: drop the 12-arg overload, recreate with p_eod_count_mode last ----
drop function if exists public.create_inventory_item_with_catalog(
  uuid, uuid, text, text, text, numeric, numeric, text, numeric, numeric, jsonb, jsonb
);

create or replace function public.create_inventory_item_with_catalog(
  p_brand_id           uuid,
  p_store_id           uuid,
  p_name               text,
  p_unit               text default '',
  p_category           text default null,
  p_case_qty           numeric default 1,
  p_sub_unit_size      numeric default 1,
  p_sub_unit_unit      text default '',
  p_default_cost       numeric default 0,
  p_default_case_price numeric default 0,
  p_per_store          jsonb default '{}'::jsonb,
  p_i18n_names         jsonb default '{}'::jsonb,
  p_eod_count_mode     text default 'cases_and_units'
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_catalog_id uuid;
  v_inventory_id uuid;
  v_result jsonb;
begin
  if p_brand_id is null then
    raise exception 'p_brand_id is required';
  end if;
  if p_store_id is null then
    raise exception 'p_store_id is required';
  end if;
  if p_name is null or length(trim(p_name)) = 0 then
    raise exception 'p_name is required';
  end if;

  -- 1. Find or create catalog_ingredients row by (brand_id, lower(name)).
  --    The (brand_id, lower(name)) unique index lets us upsert idempotently.
  select id into v_catalog_id
    from public.catalog_ingredients
   where brand_id = p_brand_id
     and lower(name) = lower(p_name)
   limit 1;

  if v_catalog_id is null then
    insert into public.catalog_ingredients (
      brand_id, name, unit, category,
      case_qty, sub_unit_size, sub_unit_unit,
      default_cost, default_case_price,
      i18n_names,
      eod_count_mode
    )
    values (
      p_brand_id, p_name, coalesce(p_unit, ''), p_category,
      coalesce(p_case_qty, 1), coalesce(p_sub_unit_size, 1), coalesce(p_sub_unit_unit, ''),
      coalesce(p_default_cost, 0), coalesce(p_default_case_price, 0),
      coalesce(p_i18n_names, '{}'::jsonb),
      -- Spec 171: an invalid value fails the CHECK (23514 → HTTP 400).
      coalesce(p_eod_count_mode, 'cases_and_units')
    )
    -- Defensive: a concurrent insert from another session could win the
    -- race; pick up its id rather than fail. The `on conflict` branch
    -- intentionally does NOT overwrite i18n_names — translations on a row
    -- that already exists belong to that row's edit lifecycle, not the
    -- inventory-create flow that re-uses it. Spec 171: same for
    -- eod_count_mode (brand-wide setting; a per-store create must not
    -- clobber it).
    on conflict (brand_id, lower(name)) do update set updated_at = now()
    returning id into v_catalog_id;
  end if;

  -- 2. Insert the per-store inventory_items row. ON CONFLICT on the new
  --    (store_id, catalog_id) unique makes this idempotent — repeated
  --    calls return the same row instead of erroring.
  insert into public.inventory_items (
    store_id, catalog_id, vendor_id,
    cost_per_unit, current_stock, par_level,
    average_daily_usage, safety_stock,
    usage_per_portion, expiry_date,
    eod_remaining, case_price
  )
  values (
    p_store_id,
    v_catalog_id,
    nullif((p_per_store->>'vendor_id')::text, '')::uuid,
    coalesce((p_per_store->>'cost_per_unit')::numeric, 0),
    coalesce((p_per_store->>'current_stock')::numeric, 0),
    coalesce((p_per_store->>'par_level')::numeric, 0),
    coalesce((p_per_store->>'average_daily_usage')::numeric, 0),
    coalesce((p_per_store->>'safety_stock')::numeric, 0),
    coalesce((p_per_store->>'usage_per_portion')::numeric, 0),
    nullif((p_per_store->>'expiry_date')::text, '')::date,
    coalesce((p_per_store->>'current_stock')::numeric, 0),
    coalesce((p_per_store->>'case_price')::numeric, 0)
  )
  on conflict (store_id, catalog_id) do nothing
  returning id into v_inventory_id;

  -- If the conflict path skipped the insert, look up the existing row.
  if v_inventory_id is null then
    select id into v_inventory_id
      from public.inventory_items
     where store_id = p_store_id
       and catalog_id = v_catalog_id;
  end if;

  -- 3. Return the row joined with its catalog. Matches the shape the
  --    JS-side mapItem already consumes from PostgREST embed responses.
  --    Spec 040: include catalog.i18n_names so the client hydrates
  --    translations on the freshly-created row without a second fetch.
  --    Spec 171: same for catalog.eod_count_mode.
  select jsonb_build_object(
    'id', i.id,
    'store_id', i.store_id,
    'catalog_id', i.catalog_id,
    'vendor_id', i.vendor_id,
    'cost_per_unit', i.cost_per_unit,
    'current_stock', i.current_stock,
    'par_level', i.par_level,
    'average_daily_usage', i.average_daily_usage,
    'safety_stock', i.safety_stock,
    'usage_per_portion', i.usage_per_portion,
    'expiry_date', i.expiry_date,
    'eod_remaining', i.eod_remaining,
    'case_price', i.case_price,
    'updated_at', i.updated_at,
    'created_at', i.created_at,
    'last_updated_by', i.last_updated_by,
    'catalog', jsonb_build_object(
      'id', c.id,
      'name', c.name,
      'unit', c.unit,
      'category', c.category,
      'case_qty', c.case_qty,
      'sub_unit_size', c.sub_unit_size,
      'sub_unit_unit', c.sub_unit_unit,
      'i18n_names', c.i18n_names,
      'eod_count_mode', c.eod_count_mode
    )
  )
  into v_result
  from public.inventory_items i
  join public.catalog_ingredients c on c.id = i.catalog_id
  where i.id = v_inventory_id;

  return v_result;
end;
$$;

-- REVOKE FROM `public` IS LOAD-BEARING: CREATE FUNCTION grants EXECUTE to
-- PUBLIC (anon inherits it), and spec 097's ALTER DEFAULT PRIVILEGES gives
-- anon an EXPLICIT grant on new public functions — so both must be revoked.
-- SECURITY INVOKER: RLS still applies to the catalog + inventory writes.
revoke all on function public.create_inventory_item_with_catalog(
  uuid, uuid, text, text, text, numeric, numeric, text, numeric, numeric, jsonb, jsonb, text
) from public, anon;
grant execute on function public.create_inventory_item_with_catalog(
  uuid, uuid, text, text, text, numeric, numeric, text, numeric, numeric, jsonb, jsonb, text
) to authenticated;

commit;
