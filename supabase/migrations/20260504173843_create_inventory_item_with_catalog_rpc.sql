-- ============================================================
-- Atomic catalog-ensure + inventory-insert RPC
--
-- Closes follow-up issue #5 from PR #3 review. The TypeScript
-- createInventoryItem currently does two sequential round-trips
-- (catalog ensure, then inventory insert) with no transaction
-- wrapping them. If the inventory insert fails — e.g. the new
-- (store_id, catalog_id) unique violates because the row already
-- exists — the freshly-inserted catalog row leaks. And the duplicate
-- case throws a 23505 instead of returning the existing row.
--
-- This RPC consolidates both writes into one transaction (PG
-- functions are transactional by default) and turns the duplicate
-- case into idempotent "find or create" semantics.
--
-- Usage from client:
--   supabase.rpc('create_inventory_item_with_catalog', {
--     p_brand_id:           uuid,
--     p_store_id:           uuid,
--     p_name:               text,        -- catalog field (looked up case-insensitively)
--     p_unit:               text,
--     p_category:           text,
--     p_case_qty:           numeric,     -- catalog
--     p_sub_unit_size:      numeric,     -- catalog
--     p_sub_unit_unit:      text,        -- catalog
--     p_default_cost:       numeric,     -- catalog defaults; per-store cost lives below
--     p_default_case_price: numeric,
--     p_per_store:          jsonb        -- per-store fields:
--       -- {
--       --   "vendor_id": uuid|null,
--       --   "cost_per_unit": numeric,
--       --   "case_price": numeric,
--       --   "par_level": numeric,
--       --   "current_stock": numeric,
--       --   "average_daily_usage": numeric,
--       --   "safety_stock": numeric,
--       --   "usage_per_portion": numeric,
--       --   "expiry_date": date|null
--       -- }
--   })
--
-- Returns the inventory_items row joined with its catalog row, in
-- the same shape the JS-side mapItem expects.
-- ============================================================

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
  p_per_store          jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_catalog_id uuid;
  v_inventory_id uuid;
  v_existing_id uuid;
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
      default_cost, default_case_price
    )
    values (
      p_brand_id, p_name, coalesce(p_unit, ''), p_category,
      coalesce(p_case_qty, 1), coalesce(p_sub_unit_size, 1), coalesce(p_sub_unit_unit, ''),
      coalesce(p_default_cost, 0), coalesce(p_default_case_price, 0)
    )
    -- Defensive: a concurrent insert from another session could win the
    -- race; pick up its id rather than fail.
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
      'sub_unit_unit', c.sub_unit_unit
    )
  )
  into v_result
  from public.inventory_items i
  join public.catalog_ingredients c on c.id = i.catalog_id
  where i.id = v_inventory_id;

  return v_result;
end;
$$;

-- Allow authenticated callers to invoke. The function uses SECURITY
-- INVOKER (default) so RLS still applies when reading/writing rows;
-- non-store-members will fail the inventory_items WITH CHECK and the
-- function will throw, which is the right behavior.
grant execute on function public.create_inventory_item_with_catalog(
  uuid, uuid, text, text, text, numeric, numeric, text, numeric, numeric, jsonb
) to authenticated;
