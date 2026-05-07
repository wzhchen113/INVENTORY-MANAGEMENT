-- ============================================================
-- Spec 004 — Ingredient form lookups: backfill ingredient_categories
-- from distinct existing free-text on inventory_items.category and
-- catalog_ingredients.category. Collapses casing/whitespace via
-- lower(trim(...)). Logs what it did via RAISE NOTICE.
--
-- Idempotent: re-running is a no-op via the `not exists` predicate.
-- Additive only: never touches existing inventory_items or
-- catalog_ingredients rows. Existing free-text values are preserved
-- as-is on those rows; the dropdown just gets a matching lookup row
-- added.
--
-- Probe-confirmed on local DB 2026-05-07:
--   - inventory_items has no `category` column post P3 lockdown
--     (the brand-catalog refactor moved category to catalog_ingredients).
--     The do-block guards on column existence so the migration is safe
--     to apply on prod regardless of which side the column lives on.
--   - catalog_ingredients distinct lower(trim(category)) = 13 values.
--   - ingredient_categories already has 11 rows. Backfill on local
--     would insert 2 rows (Produce, Dairy).
-- ============================================================

do $$
declare
  v_inserted int := 0;
  v_has_inv_category boolean;
begin
  -- Some environments may still carry the legacy inventory_items.category
  -- column; others have already dropped it. Detect at runtime.
  select exists (
    select 1 from information_schema.columns
     where table_schema = 'public'
       and table_name = 'inventory_items'
       and column_name = 'category'
  ) into v_has_inv_category;

  if v_has_inv_category then
    with sources as (
      select trim(category) as raw from catalog_ingredients
       where category is not null and trim(category) <> ''
      union all
      -- Cast through text() in case the legacy column is a different type;
      -- inventory_items.category was always text in the migrations we ship.
      select trim(category)::text from inventory_items
       where category is not null and trim(category) <> ''
    ),
    canonical as (
      select distinct on (lower(raw)) raw
        from sources
       order by lower(raw), raw  -- prefer the first casing seen alphabetically
    ),
    inserted as (
      insert into ingredient_categories (name)
      select c.raw from canonical c
       where not exists (
         select 1 from ingredient_categories ic
          where lower(ic.name) = lower(c.raw)
       )
      returning name
    )
    select count(*) into v_inserted from inserted;
  else
    -- Post-P3 path: only catalog_ingredients carries category.
    with sources as (
      select trim(category) as raw from catalog_ingredients
       where category is not null and trim(category) <> ''
    ),
    canonical as (
      select distinct on (lower(raw)) raw
        from sources
       order by lower(raw), raw
    ),
    inserted as (
      insert into ingredient_categories (name)
      select c.raw from canonical c
       where not exists (
         select 1 from ingredient_categories ic
          where lower(ic.name) = lower(c.raw)
       )
      returning name
    )
    select count(*) into v_inserted from inserted;
  end if;

  raise notice 'spec004 backfill: inserted % ingredient_categories rows', v_inserted;
end $$;
