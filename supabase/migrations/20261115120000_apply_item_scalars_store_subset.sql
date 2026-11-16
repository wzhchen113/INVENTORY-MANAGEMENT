-- ============================================================
-- Ingredient Save store scope — let the spec 122 scalar fan-out target a
-- CHOSEN SUBSET of the brand's stores, not only "every store".
--
-- The ingredient editor gains a store-scope picker on Save:
--   This store / All stores / Pick stores…
-- "All stores" keeps calling this RPC with p_store_ids = NULL (exactly the
-- spec 122 behavior). "Pick stores…" passes the picked store ids, and only
-- those stores' rows for the catalog ingredient are overwritten.
--
-- Signature change: adds `p_store_ids uuid[] default null` as a 5th param.
-- The old 4-arg function is DROPPED first (a create-or-replace with an extra
-- param would add an overload, and 4-arg calls would then be ambiguous).
-- Existing 4-arg callers keep working through the default.
--
-- Semantics with p_store_ids:
--   • NULL          → every caller-visible store of the brand (unchanged).
--   • empty array   → rejected ('no stores selected') so a picker with
--                     nothing ticked can't silently no-op.
--   • non-empty     → only rows whose store_id is in the list AND that the
--                     caller can see. Ids outside the catalog's brand never
--                     match (the UPDATE is keyed on catalog_id, which is
--                     brand-scoped), so the list cannot reach across brands.
--   • skipped_store_ids = picked stores of this brand the caller can see
--                     that have NO row for this catalog ingredient.
--
-- Auth gates are unchanged: auth_is_privileged + auth_can_see_brand +
-- per-row auth_can_see_store. current_stock and count-like fields are still
-- never parameters (spec 122 AC-5/AC-6).
--
-- Reversible: re-running 20260717000000_apply_item_scalars_to_brand.sql
-- after dropping the 5-arg function restores the prior shape.
-- ============================================================

drop function if exists public.apply_item_scalars_to_brand(uuid, numeric, numeric, numeric);

create or replace function public.apply_item_scalars_to_brand(
  p_catalog_id    uuid,
  p_par_level     numeric,
  p_cost_per_unit numeric,
  p_case_price    numeric,
  p_store_ids     uuid[] default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_brand_id    uuid;
  v_updated     int := 0;
  v_skipped_ids uuid[] := '{}';
begin
  if not public.auth_is_privileged() then
    raise exception 'privileged only';
  end if;

  if p_store_ids is not null and coalesce(array_length(p_store_ids, 1), 0) = 0 then
    raise exception 'no stores selected';
  end if;

  select brand_id into v_brand_id
    from public.catalog_ingredients
   where id = p_catalog_id;
  if v_brand_id is null then
    raise exception 'catalog ingredient not found';
  end if;

  if not public.auth_can_see_brand(v_brand_id) then
    raise exception 'brand not accessible';
  end if;

  update public.inventory_items ii
     set par_level     = coalesce(p_par_level,     ii.par_level),
         cost_per_unit = coalesce(p_cost_per_unit, ii.cost_per_unit),
         case_price    = coalesce(p_case_price,    ii.case_price),
         updated_at    = now()
   where ii.catalog_id = p_catalog_id
     and public.auth_can_see_store(ii.store_id)
     and (p_store_ids is null or ii.store_id = any(p_store_ids));
  get diagnostics v_updated = row_count;

  select coalesce(array_agg(s.id), '{}')
    into v_skipped_ids
    from public.stores s
   where s.brand_id = v_brand_id
     and public.auth_can_see_store(s.id)
     and (p_store_ids is null or s.id = any(p_store_ids))
     and not exists (
       select 1 from public.inventory_items ii
        where ii.catalog_id = p_catalog_id
          and ii.store_id = s.id
     );

  return jsonb_build_object(
    'updated_count',     v_updated,
    'skipped_count',     coalesce(array_length(v_skipped_ids, 1), 0),
    'skipped_store_ids', to_jsonb(v_skipped_ids)
  );
end
$$;

revoke execute on function public.apply_item_scalars_to_brand(uuid, numeric, numeric, numeric, uuid[]) from public, anon;
grant  execute on function public.apply_item_scalars_to_brand(uuid, numeric, numeric, numeric, uuid[]) to authenticated;

comment on function public.apply_item_scalars_to_brand(uuid, numeric, numeric, numeric, uuid[]) is
  'spec 122 + store-scope picker: OVERWRITE fan-out of an ingredient''s per-store CONFIG scalars (par_level, cost_per_unit, case_price) across the catalog''s inventory_items rows. p_store_ids NULL ⇒ every caller-visible store of the catalog''s brand (spec 122 behavior); non-empty ⇒ only those stores (still visibility-gated, never cross-brand); empty ⇒ rejected ''no stores selected''. NULL scalar param ⇒ skip that field. current_stock and count-like fields are never parameters. Stores without a row are reported in skipped_count/skipped_store_ids, never created.';
