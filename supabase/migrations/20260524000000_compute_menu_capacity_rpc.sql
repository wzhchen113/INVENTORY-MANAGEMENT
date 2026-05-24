-- ============================================================
-- Spec 060 — `compute_menu_capacity` RPC.
--
-- Returns one row per recipe in the brand for a given store, with
-- `makeable_qty` (how many of each menu item can be produced right
-- now) and the leaf binding catalog ingredient (the one that limits
-- capacity). Capacity math is FULLY TRANSITIVE — a menu recipe
-- whose BOM references a prep recipe contributes the prep's
-- leaf-ingredient quantities to the per-recipe capacity quotient.
--
-- Mirrors the canonical recursive-CTE pattern from
-- `report_run_variance_multivendor.sql` lines 253-298 — `visited
-- UUID[]` cycle guard + `depth < 5` cap. Diverging from the
-- Postgres-native `CYCLE` syntax keeps the recursive-CTE idiom
-- consistent across all transitive-recipe RPCs in this repo.
--
-- ─── Unit posture (spec §2 resolution) ───────────────────────
--
-- The capacity quotient is `floor(inventory.current_stock /
-- recipe_line.quantity)` with NO server-side unit normalization.
-- Same posture as `report_run_variance_multivendor` /
-- `report_reorder_list`: assume `recipe_ingredients.unit` matches
-- `catalog_ingredients.unit` per row.
--
-- When the units differ on a row, the numeric result is wrong, so
-- the RPC emits a per-line `unit_mismatch` flag (detected by
-- comparing the recipe-line unit to the catalog ingredient's unit
-- in `all_ri_with_meta`) and rolls it up into a per-recipe
-- `has_unit_mismatch` column. Frontend qualifies the badge with
-- `~` so the user knows the number is suspect.
--
-- A future spec can introduce a server-side `to_base_unit()` helper
-- applied uniformly to variance + cogs + capacity; this RPC
-- adopts the existing math debt rather than inventing its own.
--
-- ─── Binding-ingredient leaf semantics (spec §3 resolution) ──
--
-- `binding_catalog_id` always points at a LEAF catalog ingredient
-- (the actual purchased item the manager would order more of),
-- even when the constraint surfaces through a prep recipe.
-- `binding_shortfall` is the quantity of that catalog ingredient
-- needed to make ONE MORE of the menu item, in the catalog's
-- unit (clamped to >= 0).
--
-- ─── Realtime / publication impact ───────────────────────────
--
-- NONE. The RPC reads existing tables only. The publication
-- (supabase_realtime) is unchanged. The Zustand caller re-runs
-- the RPC on every `loadFromSupabase` debounce-coalesce, which
-- fires off `inventory_items` / `recipes` / `prep_recipes` /
-- `catalog_ingredients` mutations (already in publication).
--
-- Recipe-ingredient-only edits do NOT fire `onSync` because
-- `recipe_ingredients` / `prep_recipe_ingredients` /
-- `recipe_prep_items` are not in `supabase_realtime` — same gap
-- that already affects recipe-cost recalc. Out of scope here.
--
-- ─── Auth ────────────────────────────────────────────────────
--
-- `security invoker` — every SELECT inside runs as the calling
-- user, so RLS gates each read. `auth_can_see_store(p_store_id)`
-- pre-flight provides defence-in-depth + a clean SQLSTATE 42501
-- rejection for the foreign-store case. Matches
-- `report_reorder_list` line 119.
-- ============================================================

create or replace function public.compute_menu_capacity(
  p_store_id uuid
) returns table (
  recipe_id            uuid,
  store_id             uuid,
  has_recipe           boolean,
  makeable_qty         numeric,
  binding_catalog_id   uuid,
  binding_catalog_name text,
  binding_shortfall    numeric,
  low_ingredient_count int,
  has_unit_mismatch    boolean,
  truncated            boolean
)
language plpgsql
security invoker
set search_path = public
as $$
-- Variables declared via RETURNS TABLE (recipe_id, store_id, etc.)
-- otherwise SHADOW table-column references inside the body — a SELECT
-- that names `recipe_id` raises "column reference is ambiguous". The
-- pragma below tells PL/pgSQL to bind unqualified identifiers as
-- column refs first, falling back to variables on miss. Standard
-- workaround per the Postgres docs §43.11.1.
#variable_conflict use_column
begin
  -- (1) AUTH GATE — first statement; mirrors variance / reorder lines.
  if not public.auth_can_see_store(p_store_id) then
    raise exception 'Not authorized for store %', p_store_id
      using errcode = '42501';
  end if;

  -- (2) MAIN AGGREGATION. One CTE chain emits one row per recipe in
  -- the brand. Structure mirrors variance / reorder. Two passes:
  --   - direct_ri: direct (non-prep) ingredients per recipe.
  --   - recursive_prep: walk recipe_prep_items → prep_recipe_ingredients
  --     recursively (depth-cap 5, visited-array cycle guard); leaf
  --     rows (catalog_id IS NOT NULL) feed back into the per-recipe
  --     ingredient aggregation.
  -- Final per-recipe min() over (stock / qty) picks the binding leaf.
  return query
  with recursive
  -- (2a) Direct ingredients per recipe. Skip rows with quantity <= 0
  -- — they don't constrain capacity (division-by-zero guard).
  -- `line_unit` is the recipe-line's declared unit (lowercased,
  -- empty→empty so a NULL/blank unit doesn't trigger a mismatch).
  direct_ri as (
    select
      ri.recipe_id,
      ri.catalog_id,
      ri.quantity::numeric                     as qty,
      coalesce(lower(nullif(ri.unit, '')), '') as line_unit
    from public.recipe_ingredients ri
    where ri.catalog_id is not null
      and ri.quantity is not null
      and ri.quantity > 0
  ),
  -- (2b) Recursive flatten with depth cap + cycle detection.
  -- `qty` accumulates the multiplicative factor down the prep DAG:
  -- at depth N, qty is the product of the recipe_prep_items quantity
  -- and every prep_recipe_ingredients.quantity hit on the way to the
  -- leaf, so the final leaf's contribution to the recipe is correct.
  recursive_prep as (
    select
      rpi.recipe_id,
      pri.catalog_id,
      pri.sub_recipe_id,
      (coalesce(rpi.quantity, 0) * coalesce(pri.quantity, 0))::numeric as qty,
      array[rpi.prep_recipe_id]                                       as visited,
      1                                                               as depth,
      coalesce(lower(nullif(pri.unit, '')), '')                       as line_unit
    from public.recipe_prep_items rpi
    join public.prep_recipe_ingredients pri
      on pri.prep_recipe_id = rpi.prep_recipe_id
    union all
    select
      rp.recipe_id,
      pri.catalog_id,
      pri.sub_recipe_id,
      (rp.qty * coalesce(pri.quantity, 0))::numeric,
      rp.visited || rp.sub_recipe_id,
      rp.depth + 1,
      coalesce(lower(nullif(pri.unit, '')), '')
    from recursive_prep rp
    join public.prep_recipe_ingredients pri
      on pri.prep_recipe_id = rp.sub_recipe_id
    where rp.sub_recipe_id is not null
      and not (rp.sub_recipe_id = any (rp.visited))
      and rp.depth < 5
  ),
  -- (2c) Recipes whose recursion hit the depth cap with more graph to
  -- explore. Surfaced as `truncated=true` so the UI can render `?`.
  truncated_recipes as (
    select distinct recipe_id
    from recursive_prep
    where depth = 5
      and sub_recipe_id is not null
      and not (sub_recipe_id = any (visited))
  ),
  -- (2d) Leaf rows: only catalog_id-bearing rows contribute to per-
  -- recipe ingredient totals. sub_recipe pointers (type='prep') are
  -- traversal hooks, not capacity contributions. Also skip rows
  -- whose accumulated qty ends up <= 0 (e.g. a prep_recipe row with
  -- a zero quantity) — division-by-zero guard.
  prep_leaves as (
    select recipe_id, catalog_id, qty, line_unit
    from recursive_prep
    where catalog_id is not null
      and qty > 0
  ),
  -- (2e) Per-(recipe, catalog) line: sum demand across multiple
  -- recipe lines targeting the same catalog within one recipe
  -- (matches variance line 292), and capture a per-line "did any
  -- line declare a non-blank unit different from catalog's" flag.
  -- We CANNOT roll up the unit-mismatch decision yet because we
  -- haven't joined catalog_ingredients — so we ship `line_unit`
  -- across in the array form and resolve the mismatch in (2f).
  all_ri as (
    select recipe_id, catalog_id, qty, line_unit
    from (
      select recipe_id, catalog_id, qty, line_unit from direct_ri
      union all
      select recipe_id, catalog_id, qty, line_unit from prep_leaves
    ) u
  ),
  -- (2f) Aggregate per (recipe, catalog): sum the qty demand, and
  -- compute a per-(recipe, catalog) unit_mismatch — TRUE iff ANY
  -- contributing line's non-blank `line_unit` differs from the
  -- catalog's unit. Catalog/inventory joined in the SAME CTE so
  -- mismatch detection has access to `catalog_unit`. Conservative
  -- when catalog_unit is blank: skip the mismatch claim.
  recipe_lines as (
    select
      a.recipe_id,
      a.catalog_id,
      sum(a.qty)::numeric                            as needed_qty,
      coalesce(ii.current_stock, 0)::numeric         as current_stock,
      ii.par_level                                   as par_level_raw,
      ci.name                                        as catalog_name,
      coalesce(lower(nullif(ci.unit, '')), '')       as catalog_unit,
      bool_or(
        a.line_unit <> ''
        and coalesce(lower(nullif(ci.unit, '')), '') <> ''
        and a.line_unit <> coalesce(lower(nullif(ci.unit, '')), '')
      )                                              as unit_mismatch
    from all_ri a
    left join public.inventory_items ii
      on ii.catalog_id = a.catalog_id
     and ii.store_id   = p_store_id
    left join public.catalog_ingredients ci
      on ci.id = a.catalog_id
    group by a.recipe_id, a.catalog_id,
             ii.current_stock, ii.par_level,
             ci.name, ci.unit
  ),
  -- (2g) Capacity quotient + shortfall per (recipe, catalog). Also
  -- per-line "low" flag for downstream low_ingredient_count rollup.
  -- `is_low` matches `getItemStatus` semantics:
  --   par_level NOT NULL AND par_level > 0 AND current_stock < par_level
  -- (par_level <= 0 / NULL skips per spec edge case).
  recipe_lines_computed as (
    select
      rl.*,
      floor(rl.current_stock / rl.needed_qty)::numeric  as line_capacity,
      greatest(rl.needed_qty - rl.current_stock, 0)::numeric
                                                       as line_shortfall,
      (rl.par_level_raw is not null
        and rl.par_level_raw > 0
        and rl.current_stock < rl.par_level_raw)        as is_low
    from recipe_lines rl
  ),
  -- (2h) Per-recipe rollup: pick the binding leaf (minimum
  -- line_capacity). Tie-break: catalog_id asc (deterministic).
  binding_per_recipe as (
    select distinct on (rl.recipe_id)
      rl.recipe_id,
      rl.catalog_id        as binding_catalog_id,
      rl.catalog_name      as binding_catalog_name,
      rl.line_capacity     as makeable_qty,
      rl.line_shortfall    as binding_shortfall
    from recipe_lines_computed rl
    order by rl.recipe_id, rl.line_capacity asc, rl.catalog_id asc
  ),
  -- (2i) Per-recipe meta rollup: unit-mismatch flag (any line) and
  -- count of distinct low catalog_ids contributing to this recipe.
  recipe_rollup as (
    select
      rl.recipe_id,
      bool_or(rl.unit_mismatch)                                       as has_unit_mismatch,
      count(distinct rl.catalog_id) filter (where rl.is_low)::int     as low_ingredient_count
    from recipe_lines_computed rl
    group by rl.recipe_id
  ),
  -- (2j) Every recipe in the brand visible to this caller. We do NOT
  -- filter to recipes with BOM rows — AC §E requires the no-BOM case
  -- to appear with `has_recipe=false`. Brand resolved from p_store_id
  -- so cross-brand recipes don't leak even if RLS broadens later.
  all_recipes as (
    select r.id as recipe_id
    from public.recipes r
    where r.brand_id = (
      select s.brand_id from public.stores s
      where s.id = p_store_id
      limit 1
    )
  )
  select
    ar.recipe_id                                            as recipe_id,
    p_store_id                                              as store_id,
    -- has_recipe = ANY BOM row exists (direct ingredient OR
    -- prep-item linkage). Defining "BOM" as "at least one source of
    -- transitive ingredient demand" — matches AC §E and edge case
    -- "Recipe with only prep items".
    (
      exists (
        select 1 from public.recipe_ingredients ri
        where ri.recipe_id = ar.recipe_id and ri.catalog_id is not null
      )
      or exists (
        select 1 from public.recipe_prep_items rpi
        where rpi.recipe_id = ar.recipe_id
      )
    )                                                       as has_recipe,
    -- makeable_qty is NULL when no constraint binds the recipe:
    --   - no BOM at all (no_recipe sentinel — UI renders "no recipe
    --     defined"), OR
    --   - BOM exists but the prep chain has zero leaf ingredients
    --     (edge case: "Prep recipe with no ingredients → infinite
    --     capacity, won't bind"). Frontend treats NULL identically
    --     in both cases (renders nothing in the badge case; the
    --     no-recipe label is gated by hasRecipe).
    bpr.makeable_qty                                        as makeable_qty,
    bpr.binding_catalog_id                                  as binding_catalog_id,
    bpr.binding_catalog_name                                as binding_catalog_name,
    bpr.binding_shortfall                                   as binding_shortfall,
    coalesce(rr.low_ingredient_count, 0)::int               as low_ingredient_count,
    coalesce(rr.has_unit_mismatch, false)                   as has_unit_mismatch,
    (tr.recipe_id is not null)                              as truncated
  from all_recipes ar
  left join binding_per_recipe bpr on bpr.recipe_id = ar.recipe_id
  left join recipe_rollup     rr   on rr.recipe_id  = ar.recipe_id
  left join truncated_recipes tr   on tr.recipe_id  = ar.recipe_id;
end;
$$;

-- Grants — mirror the reports trilogy. `revoke … from public` is
-- required because authenticated/anon inherit from PUBLIC; a bare
-- `revoke from anon` leaves the function callable via PUBLIC.
revoke execute on function public.compute_menu_capacity(uuid)
  from public, anon;
grant  execute on function public.compute_menu_capacity(uuid)
  to authenticated;
