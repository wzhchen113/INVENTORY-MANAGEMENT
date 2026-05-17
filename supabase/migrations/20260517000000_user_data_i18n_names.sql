-- supabase/migrations/20260517000000_user_data_i18n_names.sql
--
-- Spec 040 P3 — user-entered data translations.
--
-- Adds a per-row JSONB column `i18n_names` to five "name-bearing" tables:
--   - public.catalog_ingredients      (brand-scoped; canonical column = name)
--   - public.recipes                  (brand-scoped; canonical column = menu_item)
--   - public.prep_recipes             (brand-scoped; canonical column = name)
--   - public.recipe_categories        (global;       canonical column = name)
--   - public.ingredient_categories    (global;       canonical column = name)
--
-- Shape: { "es"?: string, "zh-CN"?: string }. English canonical lives in the
-- existing column on each table and is NEVER written into i18n_names — that
-- column is the source of truth. Missing keys fall through to the canonical
-- English via the client-side `getLocalizedName(row, locale)` helper.
--
-- Why JSONB and not a sidecar table:
--   - Read path is "fetch row, render localized name." A JSONB column rides
--     on the existing PostgREST select projections (wildcard or otherwise)
--     and on the existing RLS row policies. A sidecar table would require
--     a join per render site AND parallel RLS policies on the sidecar.
--   - A 4th locale (e.g. pt-BR) can be added with zero migration cost —
--     the JSONB column accepts any new key.
--
-- Why no CHECK constraint on the JSONB shape:
--   - A "known-locale-keys-only" CHECK would lock in the three-locale set
--     and turn adding a 4th locale into a constraint-recreate migration —
--     defeating the value of the JSONB column. Write-time validation is
--     enforced by the edge function (translate-on-save) and the form layer.
--
-- Why no GIN index:
--   - Search is client-side over the already-hydrated Zustand slice
--     (matchesQuery from src/i18n/matchesQuery.ts). There is no server-side
--     query that filters on `i18n_names @> ...` or `i18n_names->>'es' ilike
--     ...` today, and adding the index proactively costs WAL bloat on every
--     write for zero current query benefit. A future server-side localized
--     search spec can add the GIN index in the same migration that adds the
--     query.
--
-- RLS impact: NONE. All five tables' existing FOR ALL row policies cover
-- the new column automatically — Postgres has no column-level RLS by default,
-- so a reader who can see the row sees every column. Verified against:
--   - 20260509000000_multi_brand_schema_rls.sql §catalog_ingredients/recipes/
--     prep_recipes (brand-scoped read + privileged write).
--   - 20260510030000_recipe_categories_super_admin_rls.sql ("Admins can
--     write categories" + "Authenticated can read categories").
--   - 20260507015244_spec004_ingredient_categories_rls_p6.sql (split read +
--     four admin-gated write policies).
--
-- Realtime impact: NONE. catalog_ingredients, recipes, and prep_recipes are
-- already members of supabase_realtime (per 20260514140000_realtime_publication_tighten.sql);
-- the new column rides on the existing per-table publication automatically.
-- recipe_categories and ingredient_categories are NOT in the publication and
-- this migration deliberately does NOT add them — out of scope per spec 040 §8.
-- No docker restart supabase_realtime_imr-inventory step needed on apply.
--
-- RPC change: drops-and-recreates create_inventory_item_with_catalog(...) to
-- thread a new `p_i18n_names jsonb default '{}'` parameter. Without this, the
-- inventory-form create path silently drops translations even when the form
-- payload carries them — the failure mode flagged by the architect's §11
-- "load-bearing RPC-parameter-threading risk." pgTAP covers this with a
-- round-trip assertion.
--
-- Posture: single transaction, additive only, idempotent via
-- `add column if not exists` + `drop function if exists` + `create function`.

begin;

-- ─── 1. Add i18n_names to the five name-bearing tables ─────────────────────
-- `add column ... not null default '{}'` is a metadata-only ALTER in PG 17
-- — the default literal is stored once, no row rewrite, brief AccessExclusive
-- only. Existing rows are observable as `{}` the instant the migration
-- commits; no separate UPDATE needed for backfill.

alter table public.catalog_ingredients
  add column if not exists i18n_names jsonb not null default '{}'::jsonb;

comment on column public.catalog_ingredients.i18n_names is
  'Spec 040 P3: per-locale name overrides. Shape {"es"?: string, "zh-CN"?: string}. Canonical English lives in catalog_ingredients.name and is never written here.';

alter table public.recipes
  add column if not exists i18n_names jsonb not null default '{}'::jsonb;

comment on column public.recipes.i18n_names is
  'Spec 040 P3: per-locale name overrides. Shape {"es"?: string, "zh-CN"?: string}. Canonical English lives in recipes.menu_item (NOT recipes.name) and is never written here.';

alter table public.prep_recipes
  add column if not exists i18n_names jsonb not null default '{}'::jsonb;

comment on column public.prep_recipes.i18n_names is
  'Spec 040 P3: per-locale name overrides. Shape {"es"?: string, "zh-CN"?: string}. Canonical English lives in prep_recipes.name and is never written here.';

alter table public.recipe_categories
  add column if not exists i18n_names jsonb not null default '{}'::jsonb;

comment on column public.recipe_categories.i18n_names is
  'Spec 040 P3: per-locale name overrides. Shape {"es"?: string, "zh-CN"?: string}. Canonical English lives in recipe_categories.name and is never written here.';

alter table public.ingredient_categories
  add column if not exists i18n_names jsonb not null default '{}'::jsonb;

comment on column public.ingredient_categories.i18n_names is
  'Spec 040 P3: per-locale name overrides. Shape {"es"?: string, "zh-CN"?: string}. Canonical English lives in ingredient_categories.name and is never written here.';

-- ─── 2. Re-create create_inventory_item_with_catalog to thread p_i18n_names ─
-- The existing function (20260504173843) consolidates the brand-level catalog
-- ensure + per-store inventory insert into one transaction. To carry
-- translations all the way from the form to catalog_ingredients.i18n_names on
-- the first save (not a separate UPDATE round-trip), the function gains one
-- new optional parameter `p_i18n_names jsonb default '{}'::jsonb` threaded
-- into the inner `insert into catalog_ingredients` statement.
--
-- The drop/create dance is required because Postgres function signatures are
-- positional and changing the parameter list mid-stream while preserving the
-- existing one would create two overloads — the older one would silently win
-- for any caller that didn't pass the new param. Drop-and-recreate ensures
-- exactly one signature exists.
--
-- Idempotency: `drop function if exists` matches the prior signature exactly
-- (11 typed args). Running this migration twice is a no-op on the second pass
-- because `create or replace function` reconciles the body with the same
-- signature recorded by the first pass.
--
-- Existing-row semantics: if a caller passes a catalog row that already exists
-- (matched by lower(name)), the function takes the `on conflict do update set
-- updated_at = now()` branch and does NOT overwrite i18n_names. That branch
-- is intentional — saving an existing item via the form should not clobber
-- previously-saved translations on the catalog row. The form's edit path
-- writes i18n_names directly via PostgREST on the catalog row instead.

drop function if exists public.create_inventory_item_with_catalog(
  uuid, uuid, text, text, text, numeric, numeric, text, numeric, numeric, jsonb
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
  p_i18n_names         jsonb default '{}'::jsonb
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
      i18n_names
    )
    values (
      p_brand_id, p_name, coalesce(p_unit, ''), p_category,
      coalesce(p_case_qty, 1), coalesce(p_sub_unit_size, 1), coalesce(p_sub_unit_unit, ''),
      coalesce(p_default_cost, 0), coalesce(p_default_case_price, 0),
      coalesce(p_i18n_names, '{}'::jsonb)
    )
    -- Defensive: a concurrent insert from another session could win the
    -- race; pick up its id rather than fail. The `on conflict` branch
    -- intentionally does NOT overwrite i18n_names — translations on a row
    -- that already exists belong to that row's edit lifecycle, not the
    -- inventory-create flow that re-uses it.
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
      'i18n_names', c.i18n_names
    )
  )
  into v_result
  from public.inventory_items i
  join public.catalog_ingredients c on c.id = i.catalog_id
  where i.id = v_inventory_id;

  return v_result;
end;
$$;

-- Allow authenticated callers to invoke the new signature. The function uses
-- SECURITY INVOKER (default) so RLS still applies when reading/writing rows;
-- non-store-members will fail the inventory_items WITH CHECK and the function
-- will throw, which is the right behavior.
grant execute on function public.create_inventory_item_with_catalog(
  uuid, uuid, text, text, text, numeric, numeric, text, numeric, numeric, jsonb, jsonb
) to authenticated;

commit;
