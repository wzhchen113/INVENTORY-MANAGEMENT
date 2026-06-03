-- supabase/tests/spec093_case_qty_backfill.test.sql
--
-- Spec 093 — Ingredient case-size canonical fix (data backfill).
--
-- Pins the data backfill in
-- supabase/migrations/20260602120000_spec093_case_qty_backfill.sql and the
-- reorder (088) round-trip against a fixed (case_qty in the canonical column)
-- row. Two parts:
--
--   (A) Backfill correctness — one fixture per population (§1a):
--         B  1/500  → auto-migrate to 500/1
--         C  4/5    → DO NOT mutate; snapshot into the audit table (pop 'C')
--         A  450/1  → leave untouched (canonical)
--         D  1/1    → leave untouched (degenerate)
--       After running the backfill body inside the txn, assert:
--         (1) count of mis-encoded rows (coalesce(case_qty,1)<=1 and
--             coalesce(sub_unit_size,1)>1) across the fixtures = 0
--         (2) C fixture unchanged in catalog_ingredients (still 4/5)
--         (3) C fixture present in the audit table with population='C'
--         (4) B fixture now 500/1
--         (5) A fixture untouched (450/1)
--         (6) D fixture untouched (1/1)
--         (7) B fixture present in the audit table with population='B' and the
--             old_* snapshot captured (backout source)
--
--   (B) Reorder round-trip — a catalog row with case_qty=20 + an
--       inventory_items row → report_reorder_list → suggested_cases =
--       ceil(suggested_qty / 20). par_level=50 drives suggested_qty=50, so
--       ceil(50/20) = 3.
--
-- The backfill *body* is replicated inline here (audit-table create + the three
-- inserts + the Population-B UPDATE) rather than invoked via the migration,
-- because the migration owns its own begin/commit and this test must run
-- entirely inside one rolled-back transaction. The SQL mirrors the migration
-- verbatim; the migration's apply-order is covered by the Track-3 shell smoke.
--
-- Fixtures are inserted inside the transaction with their own
-- catalog_ingredients + inventory_items; the rollback discards everything so
-- the seed is untouched. No `set role anon` (segfaults CI per spec 067).
-- Master-JWT pattern mirrors report_reorder_list_cases.test.sql.

begin;
create extension if not exists pgtap;

select plan(8);

-- ─── fixtures: resolve brand + Frederick + a vendor-with-items ─────────────
do $$
declare
  v_master_id  uuid := '33333333-3333-3333-3333-333333333333';
  v_frederick  uuid;
  v_brand_id   uuid;
  v_vendor_id  uuid;
begin
  select id into v_frederick from public.stores where name = 'Frederick' limit 1;
  select id into v_brand_id  from public.brands  limit 1;

  select v.id into v_vendor_id
    from public.vendors v
   where exists (
     select 1 from public.inventory_items ii
      where ii.store_id = v_frederick and ii.vendor_id = v.id
   )
   order by v.id asc
   limit 1;

  perform set_config('test.master_id',    v_master_id::text,  true);
  perform set_config('test.frederick_id', v_frederick::text,  true);
  perform set_config('test.brand_id',     v_brand_id::text,   true);
  perform set_config('test.vendor_id',    v_vendor_id::text,  true);
end $$;

-- ─── Audit table — created as the session superuser (postgres), mirroring the
-- migration role that runs `db push`. DDL in `public` is not granted to the
-- `authenticated` role, so this MUST happen before the role switch below.
-- `if not exists` keeps it harmless if a prior real apply already created it;
-- the txn rollback discards any rows this test snapshots into it. ───────────
create table if not exists public.spec093_case_qty_backfill_audit (
  catalog_id         uuid primary key,
  name               text,
  brand_id           uuid,
  old_case_qty       numeric,
  old_sub_unit_size  numeric,
  old_sub_unit_unit  text,
  new_case_qty       numeric,
  new_sub_unit_size  numeric,
  population         char(1),
  migrated_at        timestamptz default now()
);
alter table public.spec093_case_qty_backfill_audit enable row level security;
revoke all on public.spec093_case_qty_backfill_audit from anon, authenticated;

-- ─── master JWT — privileged for catalog + inventory mutations ─────────────
set local role authenticated;
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub',           current_setting('test.master_id', true),
    'role',          'authenticated',
    'app_metadata',  jsonb_build_object('role', 'master')
  )::text,
  true
);

-- ─── Four catalog fixtures, one per population. Random names side-step the
-- (brand, lower(name)) UNIQUE on re-run without rollback. ──────────────────
--   B → 1/500   (mis-filed; auto-migrate)
--   C → 4/5     (split; hand-review, never mutated)
--   A → 450/1   (canonical; untouched)
--   D → 1/1     (degenerate; untouched)
create temp table _catalog on commit drop as
with ins as (
  insert into public.catalog_ingredients (brand_id, name, unit, case_qty, sub_unit_size, sub_unit_unit)
  values
    (current_setting('test.brand_id', true)::uuid,
     'SPEC093-B-'||gen_random_uuid()::text, 'each',   1, 500, 'each'),
    (current_setting('test.brand_id', true)::uuid,
     'SPEC093-C-'||gen_random_uuid()::text, 'lbs',    4,   5, 'lbs'),
    (current_setting('test.brand_id', true)::uuid,
     'SPEC093-A-'||gen_random_uuid()::text, 'each', 450,   1, 'each'),
    (current_setting('test.brand_id', true)::uuid,
     'SPEC093-D-'||gen_random_uuid()::text, 'each',   1,   1, 'each')
  returning id, name
)
select id, name,
       case
         when name like 'SPEC093-B%' then 'B'
         when name like 'SPEC093-C%' then 'C'
         when name like 'SPEC093-A%' then 'A'
         else 'D'
       end as pop
  from ins;

do $$
declare
  v_b uuid;
  v_c uuid;
  v_a uuid;
  v_d uuid;
begin
  select id into v_b from _catalog where pop = 'B' limit 1;
  select id into v_c from _catalog where pop = 'C' limit 1;
  select id into v_a from _catalog where pop = 'A' limit 1;
  select id into v_d from _catalog where pop = 'D' limit 1;
  perform set_config('test.cat_b', v_b::text, true);
  perform set_config('test.cat_c', v_c::text, true);
  perform set_config('test.cat_a', v_a::text, true);
  perform set_config('test.cat_d', v_d::text, true);
end $$;

-- ─── Run the backfill BODY inline (mirrors the migration) ──────────────────
-- Back to the session superuser (postgres) for the backfill itself: the real
-- migration runs as the RLS-bypassing migration role, and the inserts below
-- target the audit table (no `authenticated` grant). The `request.jwt.claims`
-- local setting persists across the role change; it is re-asserted for the
-- reorder call at the foot.
reset role;

-- Step 2: snapshot Population B.
insert into public.spec093_case_qty_backfill_audit (
  catalog_id, name, brand_id,
  old_case_qty, old_sub_unit_size, old_sub_unit_unit,
  new_case_qty, new_sub_unit_size, population
)
select
  c.id, c.name, c.brand_id,
  c.case_qty, c.sub_unit_size, c.sub_unit_unit,
  c.sub_unit_size, 1, 'B'
from public.catalog_ingredients c
where coalesce(c.case_qty, 1) <= 1
  and coalesce(c.sub_unit_size, 1) > 1
on conflict (catalog_id) do nothing;

-- Step 3: snapshot Population C.
insert into public.spec093_case_qty_backfill_audit (
  catalog_id, name, brand_id,
  old_case_qty, old_sub_unit_size, old_sub_unit_unit,
  new_case_qty, new_sub_unit_size, population
)
select
  c.id, c.name, c.brand_id,
  c.case_qty, c.sub_unit_size, c.sub_unit_unit,
  null, null, 'C'
from public.catalog_ingredients c
where coalesce(c.case_qty, 1) > 1
  and coalesce(c.sub_unit_size, 1) > 1
on conflict (catalog_id) do nothing;

-- Step 4: UPDATE Population B only.
update public.catalog_ingredients c
   set case_qty      = c.sub_unit_size,
       sub_unit_size = 1,
       updated_at    = now()
 where coalesce(c.case_qty, 1) <= 1
   and coalesce(c.sub_unit_size, 1) > 1;

-- ─── (1) No mis-encoded rows remain across the four fixtures ───────────────
select is(
  (select count(*) from public.catalog_ingredients
    where id in (
      current_setting('test.cat_b', true)::uuid,
      current_setting('test.cat_c', true)::uuid,
      current_setting('test.cat_a', true)::uuid,
      current_setting('test.cat_d', true)::uuid)
      and coalesce(case_qty, 1) <= 1
      and coalesce(sub_unit_size, 1) > 1),
  0::bigint,
  'no mis-encoded rows (case_qty<=1 AND sub_unit_size>1) remain across fixtures'
);

-- ─── (2) C fixture UNCHANGED in catalog_ingredients (still 4/5) ────────────
select is(
  (select case_qty::numeric || '/' || sub_unit_size::numeric
     from public.catalog_ingredients
    where id = current_setting('test.cat_c', true)::uuid),
  '4/5',
  'Population C fixture is NOT mutated — still case_qty=4, sub_unit_size=5'
);

-- ─── (3) C fixture present in the audit table with population='C' ──────────
select is(
  (select population::text from public.spec093_case_qty_backfill_audit
    where catalog_id = current_setting('test.cat_c', true)::uuid),
  'C',
  'Population C fixture is flagged in the audit table with population=C'
);

-- ─── (4) B fixture now 500/1 ───────────────────────────────────────────────
select is(
  (select case_qty::numeric || '/' || sub_unit_size::numeric
     from public.catalog_ingredients
    where id = current_setting('test.cat_b', true)::uuid),
  '500/1',
  'Population B fixture migrated — case_qty=500, sub_unit_size=1'
);

-- ─── (5) A fixture untouched (450/1) ───────────────────────────────────────
select is(
  (select case_qty::numeric || '/' || sub_unit_size::numeric
     from public.catalog_ingredients
    where id = current_setting('test.cat_a', true)::uuid),
  '450/1',
  'Population A fixture untouched — case_qty=450, sub_unit_size=1'
);

-- ─── (6) D fixture untouched (1/1) ─────────────────────────────────────────
select is(
  (select case_qty::numeric || '/' || sub_unit_size::numeric
     from public.catalog_ingredients
    where id = current_setting('test.cat_d', true)::uuid),
  '1/1',
  'Population D fixture untouched — case_qty=1, sub_unit_size=1'
);

-- ─── (7) B fixture in audit table with population='B' + old_* snapshot ─────
select is(
  (select population::text || ' ' || old_case_qty::numeric || '/' || old_sub_unit_size::numeric
     from public.spec093_case_qty_backfill_audit
    where catalog_id = current_setting('test.cat_b', true)::uuid),
  'B 1/500',
  'Population B fixture recorded in audit table with population=B and old 1/500 snapshot (backout source)'
);

-- ─── (B) Reorder round-trip against a fixed (case_qty=20) row ──────────────
-- A fresh catalog row with case_qty=20 + an inventory_items row in Frederick.
-- par_level=50, current_stock=0, usage_per_portion=0 → suggested_qty=50,
-- so suggested_cases = ceil(50/20) = 3.
--
-- Re-assert the master JWT: `report_reorder_list` is security-invoker and
-- gates on auth_can_see_store(p_store_id), so it must run under the master
-- role (not the postgres superuser the backfill body ran as). The claims
-- were set above and persist; this restores the `authenticated` role.
set local role authenticated;

create temp table _reorder_cat on commit drop as
with ins as (
  insert into public.catalog_ingredients (brand_id, name, unit, case_qty)
  values (current_setting('test.brand_id', true)::uuid,
          'SPEC093-REORDER-'||gen_random_uuid()::text, 'each', 20)
  returning id
)
select id from ins;

create temp table _reorder_item on commit drop as
with ins as (
  insert into public.inventory_items (store_id, catalog_id, vendor_id, cost_per_unit, current_stock, par_level, usage_per_portion)
  values (current_setting('test.frederick_id', true)::uuid,
          (select id from _reorder_cat),
          current_setting('test.vendor_id', true)::uuid,
          1, 0, 50, 0)
  returning id
)
select id from ins;

-- Lock the schedule to "no rows" → days_until_next_delivery = 7 (irrelevant
-- here because usage_forecasted is 0 regardless).
delete from public.order_schedule
 where store_id  = current_setting('test.frederick_id', true)::uuid
   and vendor_id = current_setting('test.vendor_id',    true)::uuid;

create temp table _env on commit drop as
select public.report_reorder_list(
  current_setting('test.frederick_id', true)::uuid,
  jsonb_build_object('as_of_date', to_char(current_date, 'YYYY-MM-DD'))
) as env;

select is(
  ((select i
      from _env, jsonb_array_elements(env->'vendors') v
                , jsonb_array_elements(v->'items') i
     where v->>'vendor_id' = current_setting('test.vendor_id', true)
       and i->>'item_id'  = (select id::text from _reorder_item)
   )->>'suggested_cases')::numeric,
  3::numeric,
  'reorder round-trip: fixed case_qty=20 row → suggested_cases = ceil(50/20) = 3'
);

select * from finish();
rollback;
