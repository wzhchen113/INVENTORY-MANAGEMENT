-- ============================================================
-- DB Inspector probe + admin dedup RPCs
--
-- Three SECURITY DEFINER functions that the new admin "DB Inspector"
-- screen calls to (a) see exactly what's in the DB vs cache, and
-- (b) merge real duplicate recipes / prep_recipes by repointing FKs.
--
-- Why now: an external app querying the prod endpoint saw multiple
-- "2AM Sauce" rows; the admin app showed only one. Investigation
-- found the duplicates are mostly intentional version history
-- (prep_recipes flips is_current=false on edit) but the brand-catalog
-- refactor's fire-and-forget Zustand pattern can ALSO produce hard
-- duplicates that nothing in the UI surfaces today. These RPCs are
-- the visibility + cleanup tools.
--
-- See plan: i-feel-like-our-floating-rocket.md.
-- ============================================================

-- ─── 1. Inspector probe ─────────────────────────────────────
-- Returns schema state, current auth claims, table totals, and any
-- (brand_id, lower(name)) groups with > 1 row. The frontend classifies
-- each group as hard-duplicate / version-history / orphan-current.
-- Authenticated read; the data is all admin-screen diagnostics.
create or replace function public.admin_db_inspector_probe()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare result jsonb;
begin
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

grant execute on function public.admin_db_inspector_probe() to authenticated;

-- ─── 2. Admin dedupe — recipes ──────────────────────────────
-- Repoint dependents from dupe_ids to canonical_id, then delete dupes.
-- Order matters: most FKs to recipes are ON DELETE CASCADE, so we MUST
-- repoint first or the cascade nukes the rows we wanted to keep.
--
-- Collision handling:
--  - pos_recipe_aliases has unique (pos_name, store_id); if both
--    canonical and a dupe have aliases for the same key, drop the
--    dupe's alias before repointing to avoid a unique violation.
--  - recipe_ingredients and recipe_prep_items have no DB constraints
--    but we don't want duplicate natural keys post-repoint, so fold
--    by ctid > peer.
create or replace function public.admin_dedupe_recipes(
  canonical_id uuid,
  dupe_ids uuid[]
) returns int
language plpgsql
security definer
set search_path = public
as $$
declare affected int;
begin
  if not public.auth_is_admin() then
    raise exception 'admin only';
  end if;
  if canonical_id = any(dupe_ids) then
    raise exception 'canonical_id cannot appear in dupe_ids';
  end if;
  if array_length(dupe_ids, 1) is null then
    raise exception 'dupe_ids must be non-empty';
  end if;

  -- Drop dupe aliases that would collide with canonical's on (pos_name, store_id).
  delete from pos_recipe_aliases d
  using pos_recipe_aliases c
  where d.recipe_id = any(dupe_ids)
    and c.recipe_id = canonical_id
    and d.pos_name = c.pos_name
    and d.store_id = c.store_id;

  -- Repoint dependents.
  update recipe_ingredients   set recipe_id = canonical_id where recipe_id = any(dupe_ids);
  update recipe_prep_items    set recipe_id = canonical_id where recipe_id = any(dupe_ids);
  update pos_import_items     set recipe_id = canonical_id where recipe_id = any(dupe_ids);
  update pos_recipe_aliases   set recipe_id = canonical_id where recipe_id = any(dupe_ids);

  -- Post-repoint: dedupe by natural key on the canonical side.
  delete from recipe_ingredients a
  using recipe_ingredients b
  where a.recipe_id = canonical_id
    and b.recipe_id = canonical_id
    and a.catalog_id = b.catalog_id
    and a.ctid > b.ctid;
  delete from recipe_prep_items a
  using recipe_prep_items b
  where a.recipe_id = canonical_id
    and b.recipe_id = canonical_id
    and a.prep_recipe_id = b.prep_recipe_id
    and a.ctid > b.ctid;

  -- Drop the dupes themselves.
  delete from recipes where id = any(dupe_ids);
  get diagnostics affected = row_count;
  return affected;
end
$$;

grant execute on function public.admin_dedupe_recipes(uuid, uuid[]) to authenticated;

-- ─── 3. Admin dedupe — prep_recipes ─────────────────────────
-- Same pattern. Versioning preserved: only the explicit dupe_ids
-- (which the admin selects, typically is_current=true rows) are
-- deleted. Their parent_id-linked historical rows are NOT touched.
create or replace function public.admin_dedupe_prep_recipes(
  canonical_id uuid,
  dupe_ids uuid[]
) returns int
language plpgsql
security definer
set search_path = public
as $$
declare affected int;
begin
  if not public.auth_is_admin() then
    raise exception 'admin only';
  end if;
  if canonical_id = any(dupe_ids) then
    raise exception 'canonical_id cannot appear in dupe_ids';
  end if;
  if array_length(dupe_ids, 1) is null then
    raise exception 'dupe_ids must be non-empty';
  end if;

  -- Repoint downstream FKs.
  update recipe_prep_items
    set prep_recipe_id = canonical_id
    where prep_recipe_id = any(dupe_ids);
  update prep_recipe_ingredients
    set sub_recipe_id = canonical_id
    where sub_recipe_id = any(dupe_ids);

  -- Post-repoint: dedupe natural keys to avoid double-counting.
  delete from recipe_prep_items a
  using recipe_prep_items b
  where a.prep_recipe_id = canonical_id
    and b.prep_recipe_id = canonical_id
    and a.recipe_id = b.recipe_id
    and a.ctid > b.ctid;
  delete from prep_recipe_ingredients a
  using prep_recipe_ingredients b
  where a.sub_recipe_id = canonical_id
    and b.sub_recipe_id = canonical_id
    and a.prep_recipe_id = b.prep_recipe_id
    and a.ctid > b.ctid;

  -- Drop dupes' own ingredients explicitly. (CASCADE on the FK below
  -- would also remove them, but being explicit avoids surprising a
  -- future reader.)
  delete from prep_recipe_ingredients where prep_recipe_id = any(dupe_ids);

  delete from prep_recipes where id = any(dupe_ids);
  get diagnostics affected = row_count;
  return affected;
end
$$;

grant execute on function public.admin_dedupe_prep_recipes(uuid, uuid[]) to authenticated;
