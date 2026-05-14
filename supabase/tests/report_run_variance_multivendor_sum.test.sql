-- supabase/tests/report_run_variance_multivendor_sum.test.sql
--
-- Spec 023 / A7 — retroactive coverage for spec 020's multi-vendor
-- refactor of variance:
-- `supabase/migrations/20260514120020_report_run_variance_multivendor.sql`.
--
-- Contract pinned: when the SAME item appears under TWO vendors on the
-- SAME anchor date, the variance runner SUMS both vendors'
-- `actual_remaining` values before computing the delta. Pre-spec-020
-- (when the unique was only (store_id, date)), the same shape would
-- have raised "more than one row returned" or silently picked one.
--
-- Fixture: one Frederick item, two vendors. Each anchor date carries
-- two eod_submissions (one per vendor) with one entry each:
--   prior  vendor-A entry: actual_remaining = 5  -- summed → 10
--   prior  vendor-B entry: actual_remaining = 5
--   current vendor-A entry: actual_remaining = 3 -- summed → 5
--   current vendor-B entry: actual_remaining = 2
-- delta = counted(5) − expected(10 + 0 − 0 − 0) = -5.
--
-- Pick a no-recipe item so sales_depletion = 0; no PO / no waste so
-- receiving = 0 and waste = 0. Reduces formula to delta = counted −
-- prior_summed.

begin;
create extension if not exists pgtap;

select plan(4);

-- ─── fixtures ──────────────────────────────────────────────────
do $$
declare
  v_manager_id uuid := '22222222-2222-2222-2222-222222222222';
  v_frederick  uuid;
  v_vendor_a   uuid;
  v_vendor_b   uuid;
  v_item_id    uuid;
  v_item_name  text;
begin
  select id into v_frederick from public.stores where name = 'Frederick' limit 1;

  -- Two distinct seed vendors. Stable lex-order pick by id (the seed
  -- has 11 vendors, more than enough). Vendors are brand-scoped so any
  -- two will work for this test (we INSERT new submissions, no
  -- inventory_items.vendor_id requirement).
  select id into v_vendor_a from public.vendors order by id asc  limit 1;
  select id into v_vendor_b from public.vendors order by id desc limit 1;

  -- Item not in any recipe → sales_depletion = 0.
  -- Capture the item NAME too so the assertions can filter the rows
  -- array by the fixture row (defends against seed contamination).
  select ii.id, ci.name
    into v_item_id, v_item_name
    from public.inventory_items ii
    join public.catalog_ingredients ci on ci.id = ii.catalog_id
   where ii.store_id = v_frederick
     and coalesce(ii.cost_per_unit, 0) > 0
     and not exists (
       select 1 from public.recipe_ingredients ri where ri.catalog_id = ii.catalog_id
     )
     and not exists (
       select 1 from public.prep_recipe_ingredients pri where pri.catalog_id = ii.catalog_id
     )
   order by ii.id asc
   limit 1;

  perform set_config('test.manager_id',   v_manager_id::text, true);
  perform set_config('test.frederick_id', v_frederick::text,  true);
  perform set_config('test.vendor_a',     v_vendor_a::text,   true);
  perform set_config('test.vendor_b',     v_vendor_b::text,   true);
  perform set_config('test.item_id',      v_item_id::text,    true);
  perform set_config('test.item_name',    v_item_name,        true);
end $$;

select isnt(current_setting('test.item_id', true), '',
  'fixture: Frederick non-recipe item with cost>0 resolves from seed');

-- ─── Impersonate manager ──────────────────────────────────────
set local role authenticated;
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub',           current_setting('test.manager_id', true),
    'role',          'authenticated',
    'app_metadata',  jsonb_build_object('role', 'user')
  )::text,
  true
);

-- Four eod_submissions: (prior, current) × (vendor_a, vendor_b).
create temp table _subs on commit drop as
with ins as (
  insert into public.eod_submissions (store_id, date, vendor_id, status, client_uuid)
  values
    (current_setting('test.frederick_id', true)::uuid, '2026-05-01'::date,
     current_setting('test.vendor_a', true)::uuid, 'submitted', gen_random_uuid()),
    (current_setting('test.frederick_id', true)::uuid, '2026-05-01'::date,
     current_setting('test.vendor_b', true)::uuid, 'submitted', gen_random_uuid()),
    (current_setting('test.frederick_id', true)::uuid, '2026-05-02'::date,
     current_setting('test.vendor_a', true)::uuid, 'submitted', gen_random_uuid()),
    (current_setting('test.frederick_id', true)::uuid, '2026-05-02'::date,
     current_setting('test.vendor_b', true)::uuid, 'submitted', gen_random_uuid())
  returning id, date, vendor_id
)
select * from ins;

-- Insert four entries: prior A=5, prior B=5, current A=3, current B=2.
insert into public.eod_entries (submission_id, item_id, actual_remaining)
select s.id,
       current_setting('test.item_id', true)::uuid,
       case
         when s.date = '2026-05-01' and s.vendor_id = current_setting('test.vendor_a', true)::uuid then 5
         when s.date = '2026-05-01' and s.vendor_id = current_setting('test.vendor_b', true)::uuid then 5
         when s.date = '2026-05-02' and s.vendor_id = current_setting('test.vendor_a', true)::uuid then 3
         when s.date = '2026-05-02' and s.vendor_id = current_setting('test.vendor_b', true)::uuid then 2
       end::numeric(10,3)
  from _subs s;

-- ─── Call the runner ──────────────────────────────────────────
create temp table _env on commit drop as
select public.report_run_variance(
  current_setting('test.frederick_id', true)::uuid,
  '{"from":"2026-05-01","to":"2026-05-02"}'::jsonb
) as env;

-- Filter the rows array by the fixture's item name. The runner's `item`
-- field may suffix ' ⚠' / ' ⚠ (truncated)' — match with LIKE 'name%'.
-- Defends against seed contamination where unrelated Frederick items
-- have non-zero variance in the 2026-05-01..05-02 window.
-- Temp view; rolled back at end-of-transaction along with everything else.
create temp view _fixture_row as
  select r from _env, jsonb_array_elements(env->'rows') r
   where r->>'item' like current_setting('test.item_name', true) || '%';

-- ─── (1) Expected = SUM of prior across vendors = 5+5 = 10 ────
-- This is the load-bearing assertion: the contract is SUM, not pick-
-- one. With receiving=0 and waste=0 (no PO, no waste row), expected
-- collapses to prior. Pre-spec-020 the duplicate would have errored.
select is(
  ((select r from _fixture_row limit 1)->>'expected')::numeric,
  10.000::numeric,
  'expected = sum(prior across vendors) = 5+5 = 10 (multi-vendor SUM contract)'
);

-- ─── (2) Counted = SUM of current across vendors = 3+2 = 5 ───
select is(
  ((select r from _fixture_row limit 1)->>'counted')::numeric,
  5.000::numeric,
  'counted = sum(current across vendors) = 3+2 = 5'
);

-- ─── (3) Delta = counted(5) − expected(10) = -5 ──────────────
select is(
  replace(((select r from _fixture_row limit 1)->>'delta'), ',', '')::numeric,
  -5.000::numeric,
  'delta = counted − expected = 5 − 10 = -5'
);

select * from finish();
rollback;
