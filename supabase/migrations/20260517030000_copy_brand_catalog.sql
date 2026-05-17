-- copy_brand_catalog(source_brand, target_brand) — clones all rows of
-- catalog_ingredients from the source brand into the target brand.
--
-- Use case: when a super_admin creates a new brand and wants to seed
-- its catalog from an existing brand rather than build from scratch.
-- After the copy, the two brands stay independent — editing an
-- ingredient in one does NOT propagate.
--
-- Conflict handling: ON CONFLICT (brand_id, lower(name)) DO NOTHING.
-- Re-running the helper on a partially-seeded target brand is safe and
-- only inserts the missing rows.
--
-- Authorization: privileged (admin / master / super_admin) AND caller
-- must be able to see both brands per `auth_can_see_brand`. Mirrors the
-- Spec 013 / Spec 040 RPC gate pattern.

create or replace function public.copy_brand_catalog(
  p_source_brand_id uuid,
  p_target_brand_id uuid
) returns int
language plpgsql
security definer
set search_path = public
as $$
declare copied int;
begin
  if not public.auth_is_privileged() then
    raise exception 'privileged only';
  end if;
  if not public.auth_can_see_brand(p_source_brand_id) then
    raise exception 'source brand not accessible';
  end if;
  if not public.auth_can_see_brand(p_target_brand_id) then
    raise exception 'target brand not accessible';
  end if;
  if p_source_brand_id = p_target_brand_id then
    raise exception 'source and target brands must differ';
  end if;

  insert into public.catalog_ingredients (
    brand_id, name, unit, category, case_qty, sub_unit_size, sub_unit_unit,
    default_cost, default_case_price, i18n_names
  )
  select
    p_target_brand_id, name, unit, category, case_qty, sub_unit_size, sub_unit_unit,
    default_cost, default_case_price, coalesce(i18n_names, '{}'::jsonb)
  from public.catalog_ingredients
  where brand_id = p_source_brand_id
  on conflict (brand_id, lower(name)) do nothing;

  get diagnostics copied = row_count;
  return copied;
end
$$;

revoke execute on function public.copy_brand_catalog(uuid, uuid) from public, anon;
grant  execute on function public.copy_brand_catalog(uuid, uuid) to authenticated;
