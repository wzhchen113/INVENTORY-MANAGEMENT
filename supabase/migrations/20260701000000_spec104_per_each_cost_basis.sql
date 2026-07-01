-- supabase/migrations/20260701000000_spec104_per_each_cost_basis.sql
--
-- Spec 104 — Per-each (smallest-unit) cost basis rework (column widening +
-- data re-derivation + the report_reorder_list re-CREATE and the staff
-- staff_log_waste re-CREATE that compensate for it).
--
-- This is a DELIBERATE, owner-decided reversal of part of spec 093. It moves
-- the stored cost from "per COUNTED/tracking unit" (case_price / case_qty) to
-- the TRUE per-EACH (smallest-unit) cost:
--
--     cost_old (per counted unit) = case_price / case_qty
--     cost_new (per each)         = case_price / (case_qty × sub_unit_size)
--   ⇒ cost_old = cost_new × sub_unit_size                          ... (★)
--
-- Three stored columns are re-derived to the per-each basis:
--   • public.inventory_items.cost_per_unit      (per-store)
--   • public.item_vendors.cost_per_unit         (per-vendor link, spec 102)
--   • public.catalog_ingredients.default_cost   (brand-shared, OQ-4)
--
-- Every consumer-visible dollar figure (recipe/BOM cost, stock value, reorder
-- totals) must stay numerically UNCHANGED; only the stored BASIS and the
-- per-each DISPLAY label change. On the consumer side, exactly one
-- × sub_unit_size restores cost_old per (★): the FE recipe/stock bridges
-- supply it, and the report_reorder_list re-CREATE at the foot of this file
-- supplies it for the server-authoritative reorder totals (OQ-1).
--
-- ── REVISION (post-build, two blockers resolved IN SCOPE) ──────────────────
-- B1 — COLUMN TRUNCATION. inventory_items.cost_per_unit (init_schema:58) and
--   item_vendors.cost_per_unit (item_vendors:65) are numeric(10,2). The
--   per-each basis is genuinely sub-cent for high-sub_unit_size items
--   (e.g. 2oz Cup: 33.00 / 2000 = 0.016500), so it TRUNCATES at write time
--   under (10,2) and breaks the OQ-1 "totals numerically identical" contract
--   (the +$7/case break the prior apply reported). RESOLUTION: WIDEN both
--   columns to numeric(12,6) via ALTER TABLE as the FIRST statements in the
--   transaction, BEFORE the re-derivation, so the UPDATEs write sub-cent
--   values losslessly. 6 fractional digits bounds the (★)-bridge
--   reconstruction error at 0.5e-6 × max_sub_unit_size(~2000) = $0.001 — one
--   tenth of a cent, inside the cent tolerance for every catalog row.
--   catalog_ingredients.default_cost is ALREADY unconstrained numeric
--   (p1_additive:43) — no widening needed there.
-- B2 — MIXED BASIS / option (b). The original derivation read case_price; but
--   8 inventory_items rows have case_price <= 0 yet sub_unit_size > 1, which
--   stranded them on the OLD basis while every consumer applies × sub_unit_size
--   (a latent sub_unit_size× inflation). RESOLUTION: derive EVERY priced row
--   directly off its OWN stored cost — cost_new = cost_old / sub_unit_size —
--   the exact (★)-inverse. This needs NO case_price, converts those rows too,
--   and leaves cost_per_unit UNIFORMLY per-each on every row, so every consumer
--   bridges × sub_unit_size UNCONDITIONALLY. The population that stays un-flipped
--   shrinks to ONLY rows whose stored cost is 0/null (for them 0 / s = 0 is
--   already per-each and the bridge is a no-op).
--
-- WHY THE PIECES LIVE IN ONE FILE: keeping the basis flip and the two RPCs that
-- have to compensate for it ATOMIC. A half-applied state (values flipped, RPC
-- stale) makes every reorder total / new staff-waste snapshot sub_unit_size×
-- off. The re-CREATEs are the LAST statements in the transaction so they land
-- on top of the spec-102 / phase-13d bodies.
--
-- Owner-resolved decisions honored here (spec 104 OQ-1..OQ-6 + R1):
--   • OQ-1: reorder stays CASE-ACCURATE — report_reorder_list is re-derived so
--           totals are numerically identical to today (foot of this file).
--   • OQ-2 (REVISED, option (b)): the re-derivation no longer reads case_price;
--           the only un-derivable rows are those with cost_old <= 0/null. Those
--           keep their (zero) cost untouched and are snapshotted to the audit
--           table for hand-review as "priced at zero" (population 'X').
--   • OQ-4: catalog_ingredients.default_cost migrates too.
--   • R1 (option (a)): the staff staff_log_waste RPC is re-CREATEd so its
--           server-side snapshot stays per-COUNTED-unit (cost_per_unit ×
--           sub_unit_size) after the live column becomes per-each.
--
-- Structure mirrors 20260602120000_spec093_case_qty_backfill.sql
-- (begin/commit, create-table-if-not-exists `…_audit`, RLS-on-no-policy +
-- explicit `revoke all from anon, authenticated`, `on conflict do nothing`
-- snapshots, a `raise notice` count, a foot `-- BACKOUT` block).
--
-- IDEMPOTENCY (differs from spec 093): the per-each predicate does NOT
-- self-extinguish — under option (b) a flipped row still has cost_old > 0, so
-- re-running the bare division would double-divide it (shrink it
-- sub_unit_size× again). The audit-table guard is the ONLY thing preventing a
-- double-divide; there is no self-extinguishing fallback. Each UPDATE is
-- guarded on the AUDIT TABLE: `where not exists (select 1 from
-- spec104_per_each_cost_audit a where a.source_table = '<t>' and a.row_id =
-- <row>.<pk>)`. First run snapshots + flips; a re-run finds the audit row and
-- skips. Re-running this file is a no-op after the first apply. The snapshot
-- INSERT and the UPDATE share the SAME predicate window so they cannot drift.
--
-- LOCAL-vs-PROD IDEMPOTENCY CAVEAT: the guard makes a SECOND apply against the
-- SAME populated tables a no-op (the prod path — applied ONCE via MCP against
-- prod's OLD-basis rows, the audit is then populated, any accidental re-apply
-- skips). On a fresh local `db reset`, however, this migration runs BEFORE
-- seed.sql loads any rows, so it derives 0 rows and the audit stays EMPTY;
-- the seed then loads values ALREADY on the per-each basis. Do NOT then
-- hand-re-apply this file on top of a seeded local db — the empty audit would
-- not guard the seed rows and they would be divided a SECOND time. The
-- supported local path is `db reset` alone (validated: reorder totals
-- round-trip to the cent). This is inherent to the migrations-before-seed
-- ordering, same as spec 093's backfill.
--
-- PRIOR-BASIS SNAPSHOT (prod only): the 2026-06-26 cost-basis correction left a
-- prod-only table `public.inventory_items_cpu_backup_20260626` (NOT in any repo
-- migration). It is the PRIOR correction's snapshot and is explicitly NOT
-- dropped or read here. The spec-104 backout source is the new audit table
-- below; the 0626 table stays untouched.
--
-- This migration is prod-touching and is run by the owner via the project's
-- prod-apply path (MCP execute_sql against ebwnovzzkwhsdxkpyjka, then an
-- explicit insert into supabase_migrations.schema_migrations — db push lacks
-- the prod password; see MEMORY). The leave-as-is ('X') count is RAISEd so the
-- owner sees "N rows left as-is" in the apply output. POST-APPLY, verify
-- information_schema.columns shows numeric_precision=12, numeric_scale=6 on
-- both widened columns (a column-type change is invisible to the migration-list
-- drift gate — manual check).
--
-- NO publication membership change (no `alter publication … add table`): all
-- target tables are already in supabase_realtime, so the realtime publication
-- gotcha does NOT apply and NO docker restart step is needed.

begin;

-- ─── Step 0: WIDEN the two live cost columns FIRST (B1) ────────────────────
-- These run BEFORE any UPDATE so the option-(b) re-derivation can write
-- sub-cent per-each values without numeric(10,2) truncation. A numeric
-- precision/scale change is a table REWRITE (Postgres re-scans + re-stores
-- every row) under a brief ACCESS EXCLUSIVE lock — sub-second on these small
-- tables (≤~560 rows each), but run the prod apply off-peak (spec 104 §8 R9).
-- catalog_ingredients.default_cost is ALREADY unconstrained numeric — NOT
-- widened. None of the case_price columns are read by the option-(b)
-- derivation (it divides the stored cost), so none need widening.
alter table public.inventory_items alter column cost_per_unit type numeric(12,6);
alter table public.item_vendors    alter column cost_per_unit type numeric(12,6);

-- ─── Step 1: audit / backout table ─────────────────────────────────────────
-- Survives the transaction so it is BOTH the population-'D' backout source AND
-- the population-'X' (un-derivable) hand-review list — single artifact, two
-- readers. A back-office migration artifact: never read by the app, never
-- reached over PostgREST. RLS-enabled-no-policy = deny-all to anon/
-- authenticated; the explicit revoke makes the intent unmistakable. NOT added
-- to any realtime publication (spec 104 §2/§6, same posture as the spec 093
-- audit table).
-- NOTE on the columns under option (b): `old_cost` is now LOAD-BEARING for the
-- derivation itself — it is the DIVIDEND (cost_new = old_cost / sub_unit_size),
-- not merely a backout snapshot. `sub_unit_size` is the DIVISOR. `case_qty` and
-- `case_price` are kept for PROVENANCE / hand-review only; the UPDATE no longer
-- reads them. Keeping every column means the BACKOUT block is unchanged and the
-- population-'X' review still shows why each row was skipped.
create table if not exists public.spec104_per_each_cost_audit (
  source_table   text,     -- 'inventory_items' | 'item_vendors' | 'catalog_ingredients'
  row_id         uuid,     -- the row's pk (item id / item_vendors id / catalog id)
  catalog_id     uuid,     -- for the sub_unit_size join provenance
  old_cost       numeric,  -- pre-flip cost_per_unit / default_cost (the DIVIDEND under option (b))
  new_cost       numeric,  -- post-flip value (old_cost / sub_unit_size), OR NULL for population 'X'
  case_qty       numeric,  -- provenance only (NOT used by the option-(b) derivation)
  sub_unit_size  numeric,  -- the DIVISOR
  case_price     numeric,  -- provenance only — the row's case_price/default_case_price (or 0/null)
  population     char(1),  -- 'D' = derived, 'X' = left-as-is (cost_old <= 0)
  migrated_at    timestamptz default now(),
  primary key (source_table, row_id)
);

alter table public.spec104_per_each_cost_audit enable row level security;
revoke all on public.spec104_per_each_cost_audit from anon, authenticated;

-- ===========================================================================
-- inventory_items.cost_per_unit  (per-store) — OPTION (b): cost_old / sub_unit_size
-- Derive iff coalesce(ii.cost_per_unit,0) > 0 (the DIVIDEND), reading
-- sub_unit_size (the DIVISOR) from the row's catalog_ingredients join. NO
-- case_price dependency, so the 8 population-X-by-old-rule rows
-- (case_price <= 0, sub_unit_size > 1) convert correctly the moment they carry
-- a real stored cost (closing B2). A row with sub_unit_size = 1 is still
-- "derived" but new = old / 1 is a numeric no-op — harmless, keeps the rule
-- uniform (every priced row is per-each afterward). Idempotency guard: skip any
-- row already in the audit table for source_table='inventory_items'.
-- ===========================================================================

-- Snapshot population 'D' (to-be-derived) — old_cost captured (it IS the
-- dividend AND the backout value); new_cost = the per-each value the UPDATE
-- below writes = cost_old / sub_unit_size.
insert into public.spec104_per_each_cost_audit (
  source_table, row_id, catalog_id, old_cost, new_cost,
  case_qty, sub_unit_size, case_price, population
)
select
  'inventory_items', ii.id, ii.catalog_id, ii.cost_per_unit,
  ii.cost_per_unit / coalesce(ci.sub_unit_size, 1),
  ci.case_qty, ci.sub_unit_size, ii.case_price, 'D'
from public.inventory_items ii
join public.catalog_ingredients ci on ci.id = ii.catalog_id
where coalesce(ii.cost_per_unit, 0) > 0
  and not exists (
    select 1 from public.spec104_per_each_cost_audit a
     where a.source_table = 'inventory_items' and a.row_id = ii.id
  )
on conflict (source_table, row_id) do nothing;

-- Snapshot population 'X' (leave-as-is) — cost_old <= 0/null ("priced at zero",
-- usually an unfinished row that still needs a price). new_cost = NULL: 0 / s = 0
-- is already per-each, so there is nothing to convert and the column is left
-- alone. This is a STRICT SUBSET of the old population X — rows that used to be
-- skipped solely because case_price was absent (but carried a real stored cost)
-- are now correctly DERIVED above.
insert into public.spec104_per_each_cost_audit (
  source_table, row_id, catalog_id, old_cost, new_cost,
  case_qty, sub_unit_size, case_price, population
)
select
  'inventory_items', ii.id, ii.catalog_id, ii.cost_per_unit, null,
  ci.case_qty, ci.sub_unit_size, ii.case_price, 'X'
from public.inventory_items ii
join public.catalog_ingredients ci on ci.id = ii.catalog_id
where coalesce(ii.cost_per_unit, 0) <= 0
  and not exists (
    select 1 from public.spec104_per_each_cost_audit a
     where a.source_table = 'inventory_items' and a.row_id = ii.id
  )
on conflict (source_table, row_id) do nothing;

-- UPDATE population 'D' only. Guarded on the audit population so an already
-- left-as-is ('X') row is never flipped, and a re-run is a no-op. updated_at
-- bumped so realtime (store-{id}) replays the change for any admin with the
-- inventory open during the apply.
update public.inventory_items ii
   set cost_per_unit = a.new_cost,
       updated_at    = now()
  from public.spec104_per_each_cost_audit a
 where a.source_table = 'inventory_items'
   and a.row_id       = ii.id
   and a.population    = 'D'
   and a.new_cost is not null;

-- ===========================================================================
-- item_vendors.cost_per_unit  (per-vendor link, spec 102) — OPTION (b)
-- The DIVIDEND is the link's OWN iv.cost_per_unit (each vendor link converts
-- independently), not the item's. Join through inventory_items →
-- catalog_ingredients for sub_unit_size (the DIVISOR) only. item_vendors has no
-- updated_at bump here: its realtime change rides the parent inventory_items
-- reload (whose updated_at IS bumped above), per spec 104 §1/§6.
-- ===========================================================================

-- Snapshot population 'D'.
insert into public.spec104_per_each_cost_audit (
  source_table, row_id, catalog_id, old_cost, new_cost,
  case_qty, sub_unit_size, case_price, population
)
select
  'item_vendors', iv.id, ii.catalog_id, iv.cost_per_unit,
  iv.cost_per_unit / coalesce(ci.sub_unit_size, 1),
  ci.case_qty, ci.sub_unit_size, iv.case_price, 'D'
from public.item_vendors iv
join public.inventory_items ii    on ii.id = iv.item_id
join public.catalog_ingredients ci on ci.id = ii.catalog_id
where coalesce(iv.cost_per_unit, 0) > 0
  and not exists (
    select 1 from public.spec104_per_each_cost_audit a
     where a.source_table = 'item_vendors' and a.row_id = iv.id
  )
on conflict (source_table, row_id) do nothing;

-- Snapshot population 'X' — cost_old <= 0/null.
insert into public.spec104_per_each_cost_audit (
  source_table, row_id, catalog_id, old_cost, new_cost,
  case_qty, sub_unit_size, case_price, population
)
select
  'item_vendors', iv.id, ii.catalog_id, iv.cost_per_unit, null,
  ci.case_qty, ci.sub_unit_size, iv.case_price, 'X'
from public.item_vendors iv
join public.inventory_items ii    on ii.id = iv.item_id
join public.catalog_ingredients ci on ci.id = ii.catalog_id
where coalesce(iv.cost_per_unit, 0) <= 0
  and not exists (
    select 1 from public.spec104_per_each_cost_audit a
     where a.source_table = 'item_vendors' and a.row_id = iv.id
  )
on conflict (source_table, row_id) do nothing;

-- UPDATE population 'D' only.
update public.item_vendors iv
   set cost_per_unit = a.new_cost
  from public.spec104_per_each_cost_audit a
 where a.source_table = 'item_vendors'
   and a.row_id       = iv.id
   and a.population    = 'D'
   and a.new_cost is not null;

-- ===========================================================================
-- catalog_ingredients.default_cost  (brand-shared, OQ-4) — OPTION (b)
-- The DIVIDEND is the row's OWN default_cost; the DIVISOR is its sub_unit_size.
-- Derive iff coalesce(default_cost,0) > 0. So newly created store items seed
-- the correct per-each basis via the create-item RPC. catalog_id IS the row id
-- here (self). default_cost is unconstrained numeric → no widening / no
-- truncation; it stores the per-each value losslessly.
-- ===========================================================================

-- Snapshot population 'D'.
insert into public.spec104_per_each_cost_audit (
  source_table, row_id, catalog_id, old_cost, new_cost,
  case_qty, sub_unit_size, case_price, population
)
select
  'catalog_ingredients', ci.id, ci.id, ci.default_cost,
  ci.default_cost / coalesce(ci.sub_unit_size, 1),
  ci.case_qty, ci.sub_unit_size, ci.default_case_price, 'D'
from public.catalog_ingredients ci
where coalesce(ci.default_cost, 0) > 0
  and not exists (
    select 1 from public.spec104_per_each_cost_audit a
     where a.source_table = 'catalog_ingredients' and a.row_id = ci.id
  )
on conflict (source_table, row_id) do nothing;

-- Snapshot population 'X' — default_cost <= 0/null.
insert into public.spec104_per_each_cost_audit (
  source_table, row_id, catalog_id, old_cost, new_cost,
  case_qty, sub_unit_size, case_price, population
)
select
  'catalog_ingredients', ci.id, ci.id, ci.default_cost, null,
  ci.case_qty, ci.sub_unit_size, ci.default_case_price, 'X'
from public.catalog_ingredients ci
where coalesce(ci.default_cost, 0) <= 0
  and not exists (
    select 1 from public.spec104_per_each_cost_audit a
     where a.source_table = 'catalog_ingredients' and a.row_id = ci.id
  )
on conflict (source_table, row_id) do nothing;

-- UPDATE population 'D' only. updated_at bumped so realtime (brand-{id})
-- replays for any admin with the catalog open during the apply.
update public.catalog_ingredients ci
   set default_cost = a.new_cost,
       updated_at   = now()
  from public.spec104_per_each_cost_audit a
 where a.source_table = 'catalog_ingredients'
   and a.row_id       = ci.id
   and a.population    = 'D'
   and a.new_cost is not null;

-- ─── Report the leave-as-is ('X') count for the apply output ───────────────
do $$
declare
  v_x_count integer;
  v_d_count integer;
begin
  select count(*) into v_x_count from public.spec104_per_each_cost_audit where population = 'X';
  select count(*) into v_d_count from public.spec104_per_each_cost_audit where population = 'D';
  raise notice 'spec104 per-each cost basis (option b: cost_old / sub_unit_size): % rows re-derived (population D), % rows left as-is because cost_old <= 0 / "priced at zero" (population X). Hand-review the X rows (unfinished rows that still need a price): select * from public.spec104_per_each_cost_audit where population = ''X''.', v_d_count, v_x_count;
end $$;

-- ===========================================================================
-- report_reorder_list(uuid, jsonb) re-CREATE (OQ-1).
--
-- The body is copied VERBATIM from the CURRENT on-disk LATEST definition
-- (20260630000100_report_reorder_list_multi_vendor.sql — which carries specs
-- 087/088/100/102). Per the function-header rule both prior reorder migrations
-- state, this copies the LATEST body, NOT a stale revision; copying a stale
-- body would silently revert specs 088/100/102 and turn their pgTAP suites red.
--
-- Exactly TWO additive hunks versus that body — everything else byte-identical:
--
--   Hunk 1 — CTE `per_item`: surface the catalog sub_unit_size from the
--     EXISTING `ci` join (the same join that already yields ci.case_qty). One
--     new select item `coalesce(ci.sub_unit_size, 1)::numeric as sub_unit_size`.
--     No new join, no new scan. It threads downstream through per_item_suggested
--     (pi.*) and per_item_filtered (pis.*) with no further edit.
--
--   Hunk 2 — CTE `per_item_filtered`, the `estimated_cost` CASE: multiply BOTH
--     branches by pis.sub_unit_size, UNCONDITIONALLY. Per (★), cost_old =
--     cost_per_unit × sub_unit_size, so this restores the pre-spec figure
--     EXACTLY:
--       new_estimated_cost = old_factor × (cost_old / sub_unit_size) ×
--                            sub_unit_size = old_factor × cost_old =
--                            old_estimated_cost.
--     Under option (b) this holds for 100% of rows BY CONSTRUCTION — there is no
--     mixed-basis exception:
--       • sub_unit_size > 1 priced row → cost_per_unit is per-each; × sub_unit_size
--         reconstructs cost_old to the widened column's 6-dp precision (~$0.001).
--       • sub_unit_size = 1 row        → the flip was a numeric no-op (cost/1), so
--         cost_per_unit == cost_old and × 1 leaves it unchanged.
--       • cost_old = 0 (population 'X') → cost is 0 on both bases, product is 0.
--     The old "left-as-is rows keep the old basis, so × 1 happens to be correct"
--     reasoning no longer applies: NO row is left on the old basis with
--     sub_unit_size > 1, so the unconditional × pis.sub_unit_size is
--     unconditionally correct (the direct payoff of the B2 resolution).
--
-- vendor_total_cost (the sum(pif.estimated_cost) rollup) and
-- kpis.total_estimated_cost inherit Hunk 2 with NO further edit — estimated_cost
-- is the single cost source the header comment already calls out. suggested_qty,
-- suggested_cases, case_qty, the cases/units display, the par/forecast math, and
-- the per-vendor coalesce coalesce(nullif(iv.cost_per_unit,0), ii.cost_per_unit,
-- 0) are ALL unchanged; the coalesce is basis-consistent post-migration (both
-- operands per-each).
--
-- ACL / GRANT: the function signature is byte-identical, so `create or replace`
-- PRESERVES the existing `revoke … from public, anon` + `grant … to
-- authenticated`. NO grant/revoke statements here. security invoker + the
-- auth_can_see_store gate unchanged. No RLS / publication change.
-- ===========================================================================

create or replace function public.report_reorder_list(
  p_store_id uuid,
  p_params   jsonb default '{}'::jsonb
) returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_as_of_date              date;
  v_today_dow_num           int;
  v_today_time              time;
  v_vendors                 jsonb;
  v_kpis                    jsonb;
  v_warnings                jsonb;
  v_truncated_recipe_count  bigint;
begin
  -- (1) AUTH GATE — first statement. Mirrors variance / cogs lines.
  if not public.auth_can_see_store(p_store_id) then
    raise exception 'Not authorized for store %', p_store_id
      using errcode = '42501';
  end if;

  -- (2) AS-OF DATE RESOLUTION. Frontend passes the store-local "today"
  -- as YYYY-MM-DD via p_params. When omitted, fall back to the server's
  -- current_date (UTC). Same caveat as variance / cogs runners — caller
  -- supplies for correctness across time zones.
  v_as_of_date := coalesce(
    nullif(p_params->>'as_of_date', '')::date,
    current_date
  );
  v_today_dow_num := extract(dow from v_as_of_date)::int; -- 0=Sun..6=Sat
  v_today_time    := (now() at time zone 'utc')::time;

  -- (3) DEPTH-CAP PRE-WALK — recipe-graph depth cap is 5, same as
  -- variance / cogs. The 'truncated' flag propagates to per-item rows.
  -- Independent of the main aggregation so the count is computed once.
  with recursive _walk as (
    select rpi.recipe_id, rpi.prep_recipe_id, pri.sub_recipe_id,
           array[rpi.prep_recipe_id] as visited, 1 as depth
      from public.recipe_prep_items rpi
      join public.prep_recipe_ingredients pri
        on pri.prep_recipe_id = rpi.prep_recipe_id
     where pri.sub_recipe_id is not null
    union all
    select w.recipe_id, w.prep_recipe_id, pri.sub_recipe_id,
           w.visited || w.sub_recipe_id, w.depth + 1
      from _walk w
      join public.prep_recipe_ingredients pri
        on pri.prep_recipe_id = w.sub_recipe_id
     where w.sub_recipe_id is not null
       and not (w.sub_recipe_id = any (w.visited))
       and w.depth < 5
  )
  select count(distinct recipe_id) into v_truncated_recipe_count
    from _walk
   where depth = 5
     and sub_recipe_id is not null
     and not (sub_recipe_id = any (visited));

  if v_truncated_recipe_count > 0 then
    raise notice 'Reorder report: prep-recipe chain exceeds depth 5 (% recipe(s) truncated)',
      v_truncated_recipe_count;
  end if;

  -- (4) MAIN AGGREGATION. One CTE chain emits the per-vendor payload
  -- and the warnings array. Structure mirrors the variance runner.
  with recursive
  -- (4a) Direct (non-prep) ingredients per recipe, reduced to
  -- (recipe, catalog, qty). Same shape as variance lines 321-325.
  direct_ri as (
    select ri.recipe_id, ri.catalog_id, ri.quantity::numeric as qty
      from public.recipe_ingredients ri
     where ri.catalog_id is not null
  ),
  -- (4b) Recursive flatten with depth cap + cycle detection.
  recursive_prep as (
    select
      rpi.recipe_id, pri.catalog_id, pri.sub_recipe_id,
      (rpi.quantity * pri.quantity)::numeric as qty,
      array[rpi.prep_recipe_id]              as visited,
      1                                       as depth
    from public.recipe_prep_items rpi
    join public.prep_recipe_ingredients pri
      on pri.prep_recipe_id = rpi.prep_recipe_id
    union all
    select rp.recipe_id, pri.catalog_id, pri.sub_recipe_id,
           (rp.qty * pri.quantity)::numeric,
           rp.visited || rp.sub_recipe_id, rp.depth + 1
      from recursive_prep rp
      join public.prep_recipe_ingredients pri
        on pri.prep_recipe_id = rp.sub_recipe_id
     where rp.sub_recipe_id is not null
       and not (rp.sub_recipe_id = any (rp.visited))
       and rp.depth < 5
  ),
  truncated_recipes as (
    select distinct recipe_id
      from recursive_prep
     where depth = 5
       and sub_recipe_id is not null
       and not (sub_recipe_id = any (visited))
  ),
  prep_leaves as (
    select recipe_id, catalog_id, qty
      from recursive_prep
     where catalog_id is not null
  ),
  -- (4c) Combined per-recipe ingredient quantities (direct + prep
  -- flattened). Joined to inventory_items via catalog_id below.
  all_ri as (
    select recipe_id, catalog_id, sum(qty)::numeric as qty
      from (
        select * from direct_ri
        union all
        select recipe_id, catalog_id, qty from prep_leaves
      ) u
     group by recipe_id, catalog_id
  ),
  -- (4d) Per-recipe truncation flag (rolls up to sales_depletion).
  recipe_meta as (
    select ari.recipe_id,
           bool_or(tr.recipe_id is not null) as truncated
      from all_ri ari
      left join truncated_recipes tr on tr.recipe_id = ari.recipe_id
     group by ari.recipe_id
  ),
  -- (4e) PER-VENDOR EOD LOOKUP. Post-spec-020, (store, date, vendor)
  -- is unique with at most one row. Filter 'submitted' status only.
  -- A vendor with a submission today is 'eod'-sourced; otherwise
  -- 'stock' fallback. eod_submitted_at is surfaced for the UI badge.
  latest_eod_per_vendor as (
    select s.vendor_id,
           s.id          as submission_id,
           s.submitted_at
      from public.eod_submissions s
     where s.store_id = p_store_id
       and s.date = v_as_of_date
       and s.status = 'submitted'
  ),
  -- (4f) Per-item on_hand — SPEC 102: now item × LINKED-VENDOR (was item
  -- 1:1 inventory_items.vendor_id). The item→vendor source is a JOIN on
  -- public.item_vendors, so a shared item produces ONE ROW PER LINKED
  -- vendor. The three on_hand cases are unchanged:
  --   case A: vendor has EOD today AND this item has a non-null
  --           actual_remaining → on_hand = actual_remaining, source=eod.
  --   case B: vendor has EOD today but THIS item's entry is missing/null
  --           → on_hand = inventory_items.current_stock, source=eod
  --           (vendor-level), 'eod_missing_for_item' flag attached.
  --   case C: vendor has no EOD today → on_hand = current_stock,
  --           source=stock.
  --
  -- SPEC 102 changes (and ONLY these):
  --   • vendor_id is iv.vendor_id (from the junction), not ii.vendor_id.
  --   • cost_per_unit is the PER-VENDOR cost from the junction, FALLING
  --     BACK to the item cost when null/0 (OQ-5):
  --       coalesce(nullif(iv.cost_per_unit, 0), ii.cost_per_unit, 0).
  --   • the source table gains `join public.item_vendors iv on
  --     iv.item_id = ii.id`, and latest_eod_per_vendor / eod_entries join
  --     on iv.vendor_id.
  --   • the `ii.vendor_id IS NOT NULL` filter is DROPPED — membership is
  --     now expressed by the inner JOIN to item_vendors (an item with no
  --     link produces no row, exactly as a null vendor_id did before).
  -- par_level / usage_per_portion / current_stock stay PER-ITEM (OQ-3).
  item_on_hand as (
    select
      ii.id                                              as item_id,
      ii.store_id,
      iv.vendor_id,                                      -- from junction, not ii.vendor_id
      ii.catalog_id,
      ii.par_level::numeric                              as par_level,       -- OQ-3: per-item, shared
      coalesce(ii.usage_per_portion, 0)::numeric         as usage_per_portion,
      -- OQ-5: per-vendor cost from the junction, fallback to item cost.
      coalesce(nullif(iv.cost_per_unit, 0), ii.cost_per_unit, 0)::numeric as cost_per_unit,
      coalesce(ii.current_stock, 0)::numeric             as current_stock,
      lev.submission_id,
      lev.submitted_at,
      e.actual_remaining,
      case
        when lev.submission_id is not null
         and e.actual_remaining is not null
        then e.actual_remaining::numeric
        else coalesce(ii.current_stock, 0)::numeric
      end                                                as on_hand,
      case
        when lev.submission_id is not null
         and e.actual_remaining is not null
        then 'eod'::text
        else 'stock'::text
      end                                                as item_on_hand_source,
      (lev.submission_id is not null
        and (e.id is null or e.actual_remaining is null))
                                                         as eod_missing_for_item
      from public.inventory_items ii
      join public.item_vendors iv
        on iv.item_id = ii.id                            -- explode by link
      left join latest_eod_per_vendor lev
        on lev.vendor_id = iv.vendor_id
      left join public.eod_entries e
        on e.submission_id = lev.submission_id
       and e.item_id = ii.id
     where ii.store_id = p_store_id
  ),
  -- (4f2) SPEC 102: per item, the full set of linked vendors (id + name)
  -- + the count. Feeds the OQ-1 coincident-schedule "also from N" hint
  -- (Hunk 3). Keyed by item; store-scoped via the inventory_items join.
  item_vendor_set as (
    select iv.item_id,
           jsonb_agg(jsonb_build_object('vendor_id', iv.vendor_id,
                                        'vendor_name', v.name)
                     order by v.name) as vendor_links,
           count(*)                   as vendor_link_count
      from public.item_vendors iv
      join public.vendors v          on v.id = iv.vendor_id
      join public.inventory_items ii on ii.id = iv.item_id
     where ii.store_id = p_store_id
     group by iv.item_id
  ),
  -- (4g) Pending PO quantity. v1: ALWAYS 0. Structure preserved so
  -- v2 can swap in a real CTE here filtering on
  -- `purchase_orders.status IN (...) AND received_at IS NULL` joined
  -- through `po_items`. See spec §1 / §5 step 6.
  --
  -- SPEC 102: `item_on_hand` is now per-(item, vendor) (exploded by the
  -- junction), so it carries DUPLICATE item_ids for a shared item. This
  -- CTE keys on item_id only and is left-joined back into per_item ON
  -- item_id, so without DISTINCT a shared item would fan its per_item row
  -- out by its vendor-link count (the "Flour appears twice in the BJs
  -- card" bug). `select distinct` collapses to ONE row per item — correct
  -- because pending_po_qty is per-ITEM (one shared inbound quantity), and
  -- v2's real PO aggregation will likewise be grouped per item. The value
  -- is 0 in v1 so distinct changes nothing but the row count.
  pending_po_qty as (
    select distinct ioh.item_id,
           0::numeric as pending_po_qty
      from item_on_hand ioh
  ),
  -- (4h) Sales depletion average (per-day). For each item, flatten
  -- recipes-touching-this-item × qty_sold in the trailing 7d window
  -- and divide by 7 to get the per-day rate. Structurally identical
  -- to variance's sales_depletion CTE but with a different window
  -- and divided to per-day. Items not in any recipe yield no row.
  pos_daily_per_item as (
    select
      ii.id                                                  as item_id,
      sum(pii.qty_sold::numeric * ari.qty)::numeric / 7.0    as qty_per_day,
      bool_or(coalesce(rm.truncated, false))                 as truncated
      from public.pos_imports pi
      join public.pos_import_items pii on pii.import_id = pi.id
      join all_ri ari                  on ari.recipe_id = pii.recipe_id
      join public.inventory_items ii   on ii.catalog_id = ari.catalog_id
                                      and ii.store_id   = p_store_id
      left join recipe_meta rm         on rm.recipe_id   = pii.recipe_id
     where pi.store_id    = p_store_id
       and pi.import_date >  (v_as_of_date - 7)
       and pi.import_date <= v_as_of_date
       and pii.recipe_id is not null
       and pii.recipe_mapped = true
     group by ii.id
  ),
  -- (4i) NEXT-DELIVERY computation. For each vendor in this store
  -- with inventory items, compute days_offset to the next delivery_day.
  --
  -- CORRECTNESS NOTE: MIN must operate on the OFFSET DISTANCE
  -- ((dow - today_dow + 7) % 7), NOT on the raw DOW number. The
  -- previous shape ran MIN over the raw DOW which picked the
  -- numerically-smallest day-of-week — wrong for multi-delivery-day
  -- vendors. Example bug: a vendor delivering Wednesday (DOW=3) and
  -- Friday (DOW=5), called on Thursday (DOW=4): MIN(3,5)=3 →
  -- offset = (3-4+7)%7 = 6 days. Correct: per-day offsets are
  -- Wed=(3-4+7)%7=6 and Fri=(5-4+7)%7=1, MIN(6,1)=1. We compute the
  -- per-row distance first inside the lateral, push to next-week
  -- (+7) on the same row when today-is-delivery-and-cutoff-passed,
  -- then MIN over those distances.
  --
  -- Edge cases handled inline:
  --   • No order_schedule rows for vendor → COALESCE to 7 (A5 default).
  --   • Multiple delivery_days → MIN of per-day distances.
  --   • Today is a delivery day AND vendor's order_cutoff_time has
  --     already passed → force that day's offset to 7 (next cycle).
  --   • order_cutoff_time IS NULL → treat as "no cutoff", today's
  --     delivery counts (offset = 0).
  vendor_delivery_offsets as (
    select
      v.id            as vendor_id,
      v.name          as vendor_name,
      v.order_cutoff_time,
      os.days_offset  as days_offset
      from public.vendors v
      cross join lateral (
        -- Per delivery-day row: compute the naive distance from today,
        -- then push to +7 when this row is today-the-delivery-day AND
        -- the cutoff has already passed. Finally MIN over the
        -- resulting per-row distances.
        select min(per_day.distance) as days_offset
          from (
            select
              case
                when per_dow.dow is null then null
                when per_dow.dow = v_today_dow_num then
                  case
                    when v.order_cutoff_time is not null
                     and v_today_time > v.order_cutoff_time::time
                    then 7
                    else 0
                  end
                else
                  ((per_dow.dow - v_today_dow_num + 7) % 7)
              end as distance
              from (
                select distinct
                  case lower(os2.delivery_day)
                    when 'sunday'    then 0
                    when 'monday'    then 1
                    when 'tuesday'   then 2
                    when 'wednesday' then 3
                    when 'thursday'  then 4
                    when 'friday'    then 5
                    when 'saturday'  then 6
                    else null
                  end as dow
                  from public.order_schedule os2
                 where os2.store_id  = p_store_id
                   and os2.vendor_id = v.id
                   and os2.delivery_day is not null
              ) per_dow
             where per_dow.dow is not null
          ) per_day
      ) os
     where exists (
       select 1
         from public.inventory_items ii
         join public.item_vendors iv on iv.item_id = ii.id
        where ii.store_id  = p_store_id
          and iv.vendor_id = v.id
     )
  ),
  -- (4j) Resolve next-delivery metadata per vendor (handle the
  -- A5 fallback explicitly). Always pick a numeric days_offset so
  -- the downstream forecast multiplication is total.
  vendor_delivery as (
    select
      vdo.vendor_id,
      vdo.vendor_name,
      coalesce(vdo.days_offset, 7)                       as days_until,
      (vdo.days_offset is not null)                       as schedule_known,
      v_as_of_date + coalesce(vdo.days_offset, 7)         as next_delivery_date
      from vendor_delivery_offsets vdo
  ),
  -- (4k) PER-ITEM MATH. Compute par_replacement / usage_forecasted /
  -- suggested_qty per the hybrid formula. Join through
  -- catalog_ingredients for the item name (since inventory_items.name
  -- was dropped in P3). Filter rows with suggested_qty < 0.001 — the
  -- "nothing to order" case at the item grain.
  --
  -- Spec 088 hunk (1): surface the catalog's units-per-case from the
  -- EXISTING `ci` join. coalesce(…, 1) so a NULL case_qty reads as 1
  -- (= "no case size") downstream; the `> 1` predicate then treats it
  -- as base-unit. No ::int cast — keep `numeric` so a fractional
  -- case_qty isn't silently truncated.
  --
  -- Spec 100 hunk (1): surface ci.i18n_names from the SAME `ci` join so
  -- the staff reorder screen can render localized item names via
  -- getLocalizedName the way EOD/Weekly already do. JSONB; NULL → JSON
  -- null → mapper coalesces to {} → silent English fallback. No new
  -- join, no new scan.
  --
  -- Spec 104 hunk (1): surface the catalog's sub_unit_size from the SAME
  -- `ci` join (no new join, no new scan). coalesce(…, 1) so a NULL reads
  -- as 1 (= "tracking unit IS the smallest unit") downstream. It threads
  -- through per_item_suggested (pi.*) and per_item_filtered (pis.*) with
  -- no further edit, and feeds the estimated_cost × sub_unit_size bridge
  -- in per_item_filtered (OQ-1: keeps reorder totals numerically identical
  -- now that cost_per_unit is per-each).
  per_item as (
    select
      ioh.vendor_id,
      ioh.item_id,
      ci.name                                                       as item_name,
      ci.i18n_names                                                 as i18n_names,
      coalesce(ci.unit, '')                                         as unit,
      coalesce(ci.case_qty, 1)::numeric                             as case_qty,
      coalesce(ci.sub_unit_size, 1)::numeric                        as sub_unit_size,
      ioh.on_hand,
      ioh.item_on_hand_source,
      ioh.eod_missing_for_item,
      coalesce(ppq.pending_po_qty, 0)                                as pending_po_qty,
      ioh.par_level,
      case when ioh.usage_per_portion > 0 then ioh.usage_per_portion else null end
                                                                     as usage_per_portion,
      coalesce(pos.qty_per_day, 0)::numeric                          as qty_per_day,
      coalesce(pos.truncated, false)                                 as truncated,
      vd.days_until,
      ioh.cost_per_unit,
      greatest(0,
        coalesce(ioh.par_level, 0) - ioh.on_hand - coalesce(ppq.pending_po_qty, 0)
      )::numeric                                                     as par_replacement,
      greatest(0,
        coalesce(ioh.usage_per_portion, 0)
        * coalesce(pos.qty_per_day, 0)
        * vd.days_until
        - ioh.on_hand
        - coalesce(ppq.pending_po_qty, 0)
      )::numeric                                                     as usage_forecasted
      from item_on_hand ioh
      join public.catalog_ingredients ci on ci.id = ioh.catalog_id
      join vendor_delivery vd            on vd.vendor_id = ioh.vendor_id
      left join pending_po_qty ppq       on ppq.item_id = ioh.item_id
      left join pos_daily_per_item pos   on pos.item_id = ioh.item_id
  ),
  per_item_suggested as (
    select
      pi.*,
      greatest(pi.par_replacement, pi.usage_forecasted)              as suggested_qty
      from per_item pi
  ),
  -- Spec 088 hunk (2): derive the case-aware values. "Has a case size"
  -- ⇔ case_qty > 1 (null/0/1 are normalized to 1 above, so the strict
  -- `> 1` test correctly excludes them).
  --   • suggested_cases = ceil(suggested_qty / case_qty) when case-size,
  --     else NULL.
  --   • estimated_cost is case-rounded: whole-case cost for case-size
  --     items, unchanged (suggested_qty * cost_per_unit) otherwise.
  -- This is the SINGLE cost source — vendor_total_cost (sum below) and
  -- kpis.total_estimated_cost inherit the rounding with no other edit.
  --
  -- Spec 104 hunk (2): cost_per_unit is now per-EACH (smallest unit), but
  -- suggested_qty / suggested_cases are in COUNTED units. Multiply BOTH
  -- branches by pis.sub_unit_size UNCONDITIONALLY so the dollar total stays
  -- numerically IDENTICAL to the pre-spec figure (per ★: cost_old =
  -- cost_per_unit × sub_unit_size). Under option (b) cost_per_unit is uniformly
  -- per-each on every row, so the bridge needs no discriminator: a sub_unit_size
  -- = 1 row had its flip be a no-op (× 1), and a cost_old = 0 row is 0 on both
  -- bases. Reorder remains case-accurate (OQ-1) — the cases/units display below
  -- is unchanged; only the cost derivation adapts to the new basis.
  per_item_filtered as (
    select
      pis.*,
      case when pis.case_qty > 1
           then ceil(pis.suggested_qty / pis.case_qty)
           else null end                                            as suggested_cases,
      case when pis.case_qty > 1
           then (ceil(pis.suggested_qty / pis.case_qty) * pis.case_qty * pis.cost_per_unit * pis.sub_unit_size)
           else (pis.suggested_qty * pis.cost_per_unit * pis.sub_unit_size) end
                                                                     as estimated_cost,
      -- Per-item flag list (jsonb array of lowercase tokens).
      (
        case when coalesce(pis.par_level, 0) <= 0 then jsonb_build_array('no_par')
             else '[]'::jsonb end
        ||
        case when pis.usage_per_portion is null or coalesce(pis.qty_per_day, 0) = 0
                  then jsonb_build_array('no_usage_rate')
             else '[]'::jsonb end
        ||
        case when pis.eod_missing_for_item then jsonb_build_array('eod_missing_for_item')
             else '[]'::jsonb end
        ||
        case when pis.truncated then jsonb_build_array('truncated')
             else '[]'::jsonb end
      )                                                              as flags
      from per_item_suggested pis
     where pis.suggested_qty >= 0.001
  ),
  -- (4l) VENDOR ROLLUP. Vendors with zero rows are filtered OUT here
  -- (matches AC line 62 — "If a vendor has zero suggested items, the
  -- card is hidden"). on_hand_source rolls up to 'eod' iff any item
  -- under the vendor came from EOD; else 'stock'.
  vendors_with_items as (
    select
      vd.vendor_id,
      vd.vendor_name,
      vd.schedule_known,
      vd.next_delivery_date,
      vd.days_until,
      -- vendor-level source: 'eod' if any item drew from EOD.
      case when bool_or(pif.item_on_hand_source = 'eod') then 'eod'
           else 'stock' end                                          as on_hand_source,
      -- earliest submitted_at across this vendor's items (one
      -- submission per vendor per day post-spec-020, so this collapses).
      max(ioh_lev.submitted_at)                                      as eod_submitted_at,
      sum(pif.estimated_cost)::numeric                               as vendor_total_cost,
      jsonb_agg(
        jsonb_build_object(
          'item_id',          pif.item_id,
          'item_name',        pif.item_name,
          -- Spec 100 hunk (2): additive per-item localized-name key.
          -- JSONB object (e.g. {"zh-CN":"虾仁去头"}) or JSON null when the
          -- catalog row has no overrides; the staff mapper coalesces
          -- null/absent to {} so getLocalizedName falls through to the
          -- English item_name. The admin mapper ignores this key.
          'i18n_names',       pif.i18n_names,
          'unit',             pif.unit,
          'on_hand',          pif.on_hand,
          'pending_po_qty',   pif.pending_po_qty,
          'par_level',        pif.par_level,
          'usage_forecasted', pif.usage_forecasted,
          'par_replacement',  pif.par_replacement,
          'suggested_qty',    pif.suggested_qty,
          -- Spec 088 hunk (3): three additive case keys. case_qty is
          -- always present (1 when no case size); suggested_cases is the
          -- ceil (JSON null when case_qty ≤ 1); suggested_units is the
          -- ordered base-unit total M (= cases * case_qty for case
          -- items, else the raw suggested_qty). One server-authoritative
          -- M so the FE display / CSV / PDF never re-derive cases×qty.
          'case_qty',         pif.case_qty,
          'suggested_cases',  pif.suggested_cases,
          'suggested_units',  case when pif.suggested_cases is not null
                                   then pif.suggested_cases * pif.case_qty
                                   else pif.suggested_qty end,
          'cost_per_unit',    pif.cost_per_unit,
          'estimated_cost',   pif.estimated_cost,
          'flags',            pif.flags,
          -- Spec 102 hunk (3): OQ-1 coincident-schedule "also from N"
          -- hint. ADVISORY ONLY — does not change which card the item
          -- appears on. other_vendor_count is 0 for a single-vendor item
          -- (existing rendering unaffected). also_from_vendors is the set
          -- of the item's OTHER linked vendors (excluding THIS card's
          -- vendor) for the UI to name. The mapper ignores both keys
          -- until taught; envelope shape is unchanged.
          'other_vendor_count', greatest(0, coalesce(ivs.vendor_link_count, 1) - 1),
          'also_from_vendors',  coalesce(
             (select jsonb_agg(l)
                from jsonb_array_elements(coalesce(ivs.vendor_links, '[]'::jsonb)) l
               where (l->>'vendor_id')::uuid <> pif.vendor_id),
             '[]'::jsonb)
        )
        order by pif.suggested_qty desc, pif.item_name asc
      )                                                              as items
      from per_item_filtered pif
      join vendor_delivery vd on vd.vendor_id = pif.vendor_id
      left join item_on_hand ioh_lev on ioh_lev.item_id = pif.item_id
                                    and ioh_lev.vendor_id = pif.vendor_id
      left join item_vendor_set ivs  on ivs.item_id = pif.item_id
     group by vd.vendor_id, vd.vendor_name, vd.schedule_known,
              vd.next_delivery_date, vd.days_until
  ),
  -- (4m) VENDOR ROW JSON. Sorted by next_delivery_date ASC then
  -- vendor_name ASC so the manager sees imminent deliveries first.
  vendor_rows as (
    select coalesce(jsonb_agg(
      jsonb_build_object(
        'vendor_id',                vwi.vendor_id,
        'vendor_name',              vwi.vendor_name,
        'schedule_known',           vwi.schedule_known,
        'next_delivery_date',       to_char(vwi.next_delivery_date, 'YYYY-MM-DD'),
        'days_until_next_delivery', vwi.days_until,
        'on_hand_source',           vwi.on_hand_source,
        'eod_submitted_at',         vwi.eod_submitted_at,
        'items',                    vwi.items,
        'vendor_total_cost',        vwi.vendor_total_cost
      )
      order by vwi.next_delivery_date asc, vwi.vendor_name asc
    ), '[]'::jsonb)                                                  as rows
      from vendors_with_items vwi
  ),
  -- (4n) KPI rollup. Reads off vendors_with_items (post-vendor-filter)
  -- so empty-vendor cards don't inflate counts.
  kpi_calc as (
    select
      count(*)::bigint                                               as vendor_count,
      coalesce(sum(jsonb_array_length(vwi.items)), 0)::bigint        as item_count,
      coalesce(sum(vwi.vendor_total_cost), 0)::numeric               as total_estimated_cost,
      count(*) filter (where vwi.on_hand_source = 'eod')::bigint     as eod_sourced_vendor_count,
      count(*) filter (where vwi.on_hand_source = 'stock')::bigint   as stock_fallback_vendor_count
      from vendors_with_items vwi
  )
  select vr.rows,
         jsonb_build_object(
           'vendor_count',                k.vendor_count,
           'item_count',                  k.item_count,
           'total_estimated_cost',        k.total_estimated_cost,
           'eod_sourced_vendor_count',    k.eod_sourced_vendor_count,
           'stock_fallback_vendor_count', k.stock_fallback_vendor_count
         )
    into v_vendors, v_kpis
    from vendor_rows vr
    cross join kpi_calc k;

  -- (5) WARNINGS — vendors that surfaced suggestions but have no
  -- order_schedule row (A5 fallback applied). Scoped to vendors that
  -- ACTUALLY appear in the final `v_vendors` payload so the warnings
  -- the user sees match the cards on screen. A vendor whose items
  -- are all at par (filtered out at per_item_filtered) won't generate
  -- a `schedule_unknown` warning even if it has no order_schedule row,
  -- because there's no card to attach the warning to.
  with surfaced_vendor_ids as (
    -- Extract vendor_ids from the already-built v_vendors envelope.
    -- jsonb_array_elements is a no-op when v_vendors is [].
    select (elem->>'vendor_id')::uuid as vendor_id
      from jsonb_array_elements(coalesce(v_vendors, '[]'::jsonb)) elem
  ),
  vendors_no_schedule as (
    select v.id as vendor_id, v.name as vendor_name
      from public.vendors v
      join surfaced_vendor_ids svi on svi.vendor_id = v.id
     where not exists (
         select 1
           from public.order_schedule os
          where os.store_id  = p_store_id
            and os.vendor_id = v.id
            and os.delivery_day is not null
       )
  )
  select coalesce(jsonb_agg(
    jsonb_build_object(
      'code',    'schedule_unknown',
      'message', 'Vendor "' || vns.vendor_name
                  || '" has no order schedule — using 7-day buffer.'
    )
  ), '[]'::jsonb) into v_warnings
    from vendors_no_schedule vns;

  -- (6) FINAL ENVELOPE.
  return jsonb_build_object(
    'as_of_date', to_char(v_as_of_date, 'YYYY-MM-DD'),
    'vendors',    coalesce(v_vendors, '[]'::jsonb),
    'kpis',       v_kpis,
    '_warnings',  coalesce(v_warnings, '[]'::jsonb)
  );
end;
$$;

-- NOTE: NO grant/revoke statements here. The function signature is
-- byte-identical to the prior definition, so `create or replace`
-- PRESERVES the existing ACL (`revoke … from public, anon` + `grant …
-- to authenticated`). Re-stating it would be redundant churn.

-- ===========================================================================
-- staff_log_waste(...) re-CREATE (R1 option (a) — waste snapshot stays
-- per-COUNTED-unit on both sides of the flip).
--
-- The body is copied from 20260504000002_staff_log_waste_rpc.sql (phase 13d —
-- the only prior definition) with the R1 snapshot change: the
-- waste_log.cost_per_unit snapshot is `v_item.cost_per_unit ×
-- coalesce(ci.sub_unit_size, 1)` (= cost_old, per ★) instead of the raw
-- per-each cost. After this spec the live inventory_items.cost_per_unit column
-- is per-each, so a raw snapshot would be sub_unit_size× too low (and would
-- ALSO truncate to $0.00/$0.01 in the numeric(10,2) waste column). Re-bridging
-- to cost_old keeps the snapshot per-counted-unit and an exact 2-dp value that
-- fits numeric(10,2) losslessly — so getWasteThisWeek / DashboardSection waste
-- reads stay UNBRIDGED and every era (pre- and post-flip) reconciles.
--
-- SCHEMA-DRIFT FIX (beyond the R1 snapshot change — see the spec-104 handoff):
-- the phase-13d body selected `id, name, unit, current_stock, cost_per_unit`
-- from inventory_items as BARE columns. The brand-catalog refactor (P3) later
-- DROPPED inventory_items.name and inventory_items.unit — they now live on
-- catalog_ingredients — so a byte-verbatim copy of the old body would raise
-- `column ii.name does not exist` against today's schema. staff_log_waste has
-- had NO live caller since spec 061 retired it (edge fn staff-waste-log returns
-- HTTP 410; the RPC is service_role-only), so this break was latent-and-dormant,
-- not observed. Because this spec must re-CREATE the function anyway (for the R1
-- snapshot), the re-CREATE reads name/unit from the SAME catalog_ingredients
-- join it adds for sub_unit_size (ci.name / ci.unit) — exactly how the reorder
-- RPC copy in this file already reads ci.name. This makes the copied body VALID
-- against the post-P3 schema; it is NOT a contract redesign (signature, SECURITY
-- DEFINER, search_path, idempotency on client_uuid, stock decrement, audit row,
-- return envelope all identical). A future spec that re-enables staff waste-log
-- inherits a correct, compiling function on the per-each basis.
--
-- The lookup gains `left join public.catalog_ingredients ci on ci.id =
-- ii.catalog_id` to surface sub_unit_size AND name/unit. The whole result row
-- (item fields + catalog name/unit/sub_unit_size) lands in the single `v_item`
-- record so the original `SELECT … INTO v_item` shape is preserved.
-- `create or replace` PRESERVES the existing `revoke … from public, anon,
-- authenticated` + `grant execute … to service_role` ACL (NO grant/revoke
-- restated here). Belongs in THIS migration so the basis flip and the snapshot
-- bridge land atomically (a half-applied state would mint sub_unit_size×-low
-- staff-waste rows if the function were re-enabled between apply steps).
-- ===========================================================================
create or replace function public.staff_log_waste(
  p_client_uuid uuid,
  p_store_id uuid,
  p_ingredient_id uuid,
  p_quantity numeric,
  p_unit text,
  p_reason text,
  p_notes text,
  p_submitted_by text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_existing_id uuid;
  v_waste_id uuid;
  v_item record;
  v_new_stock numeric;
begin
  -- Idempotency check
  if p_client_uuid is not null then
    select id into v_existing_id
      from public.waste_log
      where client_uuid = p_client_uuid;
    if v_existing_id is not null then
      return jsonb_build_object(
        'waste_id', v_existing_id,
        'conflict', true,
        'reason', 'client_uuid already processed'
      );
    end if;
  end if;

  -- Lookup the item to capture cost_per_unit + current stock (from
  -- inventory_items) + name + unit + sub_unit_size (from catalog_ingredients —
  -- name/unit moved there in P3; sub_unit_size is the R1 bridge divisor). The
  -- whole result row lands in the single `v_item` record so the original
  -- SELECT … INTO v_item shape is preserved. Field names (name/unit/
  -- sub_unit_size) are aliased so the downstream v_item.<field> references are
  -- unchanged from the phase-13d body.
  select ii.id, ci.name as name, ci.unit as unit, ii.current_stock, ii.cost_per_unit,
         coalesce(ci.sub_unit_size, 1) as sub_unit_size
    into v_item
    from public.inventory_items ii
    left join public.catalog_ingredients ci on ci.id = ii.catalog_id
    where ii.id = p_ingredient_id and ii.store_id = p_store_id;

  if v_item.id is null then
    raise exception 'ingredient % not found at store %', p_ingredient_id, p_store_id
      using errcode = 'P0002';
  end if;

  -- Insert waste row. cost_per_unit captured at log-time so historical waste
  -- cost stays meaningful even if the item's cost is later edited. Spec 104
  -- (R1 option a): snapshot cost_old = per-each cost_per_unit × sub_unit_size
  -- so the waste_log.cost_per_unit column stays per-COUNTED-unit across the
  -- per-each basis flip (the read side, getWasteThisWeek, stays unbridged).
  insert into public.waste_log (
    store_id, item_id, quantity, unit, cost_per_unit, reason, notes, client_uuid
  ) values (
    p_store_id,
    p_ingredient_id,
    p_quantity,
    coalesce(p_unit, v_item.unit),
    v_item.cost_per_unit * v_item.sub_unit_size,
    p_reason,
    coalesce(p_notes, ''),
    p_client_uuid
  ) returning id into v_waste_id;

  -- Decrement stock (clamped at 0 — negative stock isn't meaningful).
  v_new_stock := greatest(0, coalesce(v_item.current_stock, 0) - p_quantity);
  update public.inventory_items
    set current_stock = v_new_stock,
        updated_at = now()
    where id = p_ingredient_id;

  -- Audit row.
  insert into public.audit_log (store_id, user_id, action, detail, item_ref, value)
  values (
    p_store_id,
    null,
    'Waste log',
    coalesce(p_submitted_by, 'staff:unknown'),
    v_item.name,
    p_quantity::text || ' ' || coalesce(p_unit, v_item.unit) || ' · ' || p_reason
  );

  return jsonb_build_object(
    'waste_id', v_waste_id,
    'conflict', false,
    'stock_after', v_new_stock
  );
end;
$$;

-- NOTE: NO grant/revoke statements here either. The staff_log_waste signature
-- is byte-identical to 20260504000002, so `create or replace` PRESERVES the
-- existing `revoke … from public, anon, authenticated` + `grant execute … to
-- service_role` ACL.

commit;

-- ───────────────────────────────────────────────────────────────────────────
-- BACKOUT (documented, NOT auto-applied)
--
-- The project has no down-migration convention; this is the "documented
-- backout" the owner asked for. Run by hand only if the apply needs reverting.
--
-- ORDER IS NON-NEGOTIABLE: restore the VALUES from the audit snapshot
-- (population 'D' rows carry old_cost) FIRST — WHILE the two widened columns are
-- still numeric(12,6) — THEN re-narrow the columns back to numeric(10,2). The
-- restored old_cost values are all exact 2-dp numbers (they were 2-dp
-- originally), so writing them while the column is wide and re-narrowing
-- afterward is lossless. Narrowing the type FIRST would re-truncate the 2-dp
-- values during the rewrite — exactly the B1 truncation this spec widened to
-- avoid. catalog_ingredients.default_cost is unconstrained numeric (never
-- widened), so it only needs the value restore, no re-narrow.
--
-- This does NOT restore report_reorder_list or staff_log_waste — re-apply the
-- prior migrations 20260630000100_report_reorder_list_multi_vendor.sql and
-- 20260504000002_staff_log_waste_rpc.sql respectively to revert those RPC
-- bodies to their pre-spec-104 form.
--
-- Drop the audit table LAST (it also discards the population-'X' hand-review
-- list — export that list first if it is still needed).
--
-- The prod-only inventory_items_cpu_backup_20260626 table (the 2026-06-26
-- correction's snapshot) is NOT referenced or dropped here — it is a separate
-- prior-basis artifact and stays untouched.
--
--   begin;
--   -- (1) restore VALUES first, while the columns are still numeric(12,6).
--   update public.inventory_items ii
--      set cost_per_unit = a.old_cost,
--          updated_at    = now()
--     from public.spec104_per_each_cost_audit a
--    where a.source_table = 'inventory_items'
--      and a.row_id       = ii.id
--      and a.population    = 'D';
--   update public.item_vendors iv
--      set cost_per_unit = a.old_cost
--     from public.spec104_per_each_cost_audit a
--    where a.source_table = 'item_vendors'
--      and a.row_id       = iv.id
--      and a.population    = 'D';
--   update public.catalog_ingredients ci
--      set default_cost = a.old_cost,
--          updated_at   = now()
--     from public.spec104_per_each_cost_audit a
--    where a.source_table = 'catalog_ingredients'
--      and a.row_id       = ci.id
--      and a.population    = 'D';
--   -- (2) THEN re-narrow the two widened columns (the values are exact 2-dp
--   --     again, so the rewrite is lossless). default_cost is left as
--   --     unconstrained numeric (it was never widened).
--   alter table public.inventory_items alter column cost_per_unit type numeric(10,2);
--   alter table public.item_vendors    alter column cost_per_unit type numeric(10,2);
--   -- (3) drop the audit table last.
--   drop table public.spec104_per_each_cost_audit;
--   commit;
-- ───────────────────────────────────────────────────────────────────────────
