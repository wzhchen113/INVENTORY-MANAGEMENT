-- ============================================================
-- Hotfix: admin RPCs were callable by `anon`.
--
-- The previous migration (20260505054049) granted EXECUTE to the
-- `authenticated` role but didn't revoke the Postgres default of
-- PUBLIC EXECUTE on functions. That left the three admin RPCs
-- callable by anyone with the project's anon key.
--
-- The two dedupe RPCs are safe in practice — they raise immediately
-- if `auth_is_admin()` returns false — but the probe does NOT, so
-- it would leak recipe IDs, prep IDs, and dependency counts to anon.
--
-- Fix here:
--   1. REVOKE EXECUTE FROM PUBLIC, anon on all three so they're not
--      reachable without a signed-in session.
--   2. Add an admin gate at the top of admin_db_inspector_probe so
--      a non-admin authenticated user (e.g. a regular store user
--      whose JWT lacks the admin claim) gets `admin only` instead
--      of the full diagnostic payload. The dedupe RPCs already do
--      this; we mirror the pattern.
-- ============================================================

-- 1. Lock down EXECUTE.
revoke execute on function public.admin_db_inspector_probe()       from public, anon;
revoke execute on function public.admin_dedupe_recipes(uuid, uuid[])      from public, anon;
revoke execute on function public.admin_dedupe_prep_recipes(uuid, uuid[]) from public, anon;

-- 2. Add admin gate to the probe.
create or replace function public.admin_db_inspector_probe()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare result jsonb;
begin
  if not public.auth_is_admin() then
    raise exception 'admin only';
  end if;

  select jsonb_build_object(
    'auth', jsonb_build_object(
      'is_admin', public.auth_is_admin(),
      'app_metadata', coalesce(auth.jwt() -> 'app_metadata', '{}'::jsonb),
      'user_id', auth.uid()
    ),
    'schema', jsonb_build_object(
      'recipes_has_store_id', exists (
        select 1 from information_schema.columns
        where table_schema = 'public' and table_name = 'recipes' and column_name = 'store_id'
      ),
      'recipes_has_brand_id', exists (
        select 1 from information_schema.columns
        where table_schema = 'public' and table_name = 'recipes' and column_name = 'brand_id'
      ),
      'prep_has_store_id', exists (
        select 1 from information_schema.columns
        where table_schema = 'public' and table_name = 'prep_recipes' and column_name = 'store_id'
      ),
      'prep_has_brand_id', exists (
        select 1 from information_schema.columns
        where table_schema = 'public' and table_name = 'prep_recipes' and column_name = 'brand_id'
      ),
      'has_p3_unique', exists (
        select 1 from pg_indexes
        where schemaname = 'public' and indexname = 'recipes_brand_menu_item_unique'
      ),
      'has_legacy_unique', exists (
        select 1 from pg_indexes
        where schemaname = 'public' and indexname = 'recipes_menu_item_store_id_unique'
      ),
      'has_prep_partial_unique', exists (
        select 1 from pg_indexes
        where schemaname = 'public' and indexname = 'prep_recipes_brand_name_current_unique'
      )
    ),
    'counts', jsonb_build_object(
      'recipes_total', (select count(*) from recipes),
      'prep_total', (select count(*) from prep_recipes),
      'prep_current', (select count(*) from prep_recipes where is_current)
    ),
    'recipe_groups', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'brand_id', brand_id,
          'lname', lname,
          'display_name', display_name,
          'total', total,
          'rows', rows
        )
      )
      from (
        select
          r.brand_id,
          lower(r.menu_item) as lname,
          (array_agg(r.menu_item order by r.created_at))[1] as display_name,
          count(*) as total,
          jsonb_agg(jsonb_build_object(
            'id', r.id,
            'menu_item', r.menu_item,
            'created_at', r.created_at,
            'recipe_ingredients_count', (select count(*) from recipe_ingredients ri where ri.recipe_id = r.id),
            'recipe_prep_items_count',  (select count(*) from recipe_prep_items rpi where rpi.recipe_id = r.id),
            'pos_import_items_count',   (select count(*) from pos_import_items pii where pii.recipe_id = r.id),
            'pos_recipe_aliases_count', (select count(*) from pos_recipe_aliases pra where pra.recipe_id = r.id)
          ) order by r.created_at) as rows
        from recipes r
        group by r.brand_id, lower(r.menu_item)
        having count(*) > 1
      ) g
    ), '[]'::jsonb),
    'prep_groups', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'brand_id', brand_id,
          'lname', lname,
          'display_name', display_name,
          'total', total,
          'current_count', current_count,
          'rows', rows
        )
      )
      from (
        select
          p.brand_id,
          lower(p.name) as lname,
          (array_agg(p.name order by p.created_at desc))[1] as display_name,
          count(*) as total,
          count(*) filter (where p.is_current) as current_count,
          jsonb_agg(jsonb_build_object(
            'id', p.id,
            'name', p.name,
            'version', p.version,
            'is_current', p.is_current,
            'parent_id', p.parent_id,
            'created_at', p.created_at,
            'prep_recipe_ingredients_count', (select count(*) from prep_recipe_ingredients pri where pri.prep_recipe_id = p.id),
            'recipe_prep_items_count',       (select count(*) from recipe_prep_items rpi where rpi.prep_recipe_id = p.id),
            'sub_recipe_refs_count',         (select count(*) from prep_recipe_ingredients pri where pri.sub_recipe_id = p.id)
          ) order by p.created_at desc) as rows
        from prep_recipes p
        group by p.brand_id, lower(p.name)
        having count(*) > 1
      ) g
    ), '[]'::jsonb)
  )
  into result;
  return result;
end
$$;

-- Re-grant to authenticated only (REVOKE above strips it); CREATE OR REPLACE
-- preserves the prior grant but the explicit GRANT is harmless and makes the
-- file reproducible if someone re-runs it on a stripped DB.
grant execute on function public.admin_db_inspector_probe() to authenticated;
