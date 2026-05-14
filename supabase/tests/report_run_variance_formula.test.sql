-- supabase/tests/report_run_variance_formula.test.sql
--
-- Spec 023 / A2 — retroactive coverage for spec 018's strict
-- reconciliation math. Pins the per-item variance formula from
-- `supabase/migrations/20260512120000_report_run_variance.sql:462-468`:
--
--   expected = prior + receiving − sales_depletion − waste
--   delta    = counted − expected
--   dollar_impact = delta × cost_per_unit  (zeroed when missing_cost)
--
-- Picks a Frederick item NOT in any recipe so the sales_depletion path
-- reduces to 0 (the variance runner inner-joins through
-- recipe_ingredients). With sales=0 the formula simplifies to
-- `expected = prior + receiving − waste`. Reference fixture values:
--   prior = 10, receiving = 3, waste = 1, counted = 4
--   expected = 10 + 3 − 0 − 1 = 12
--   delta    = 4 − 12 = -8
--   dollar_impact = -8 × cost_per_unit
--
-- Fixture sequence per architect §1 / A2:
--   (1) Resolve Frederick id; pick a seeded inventory_item from
--       Frederick with cost_per_unit > 0 AND not in any recipe (so
--       sales_depletion = 0).
--   (2) Insert two eod_submissions (prior, current) with the same
--       vendor_id under manager JWT.
--   (3) Insert two eod_entries (prior=10, current=4) on the item.
--   (4) Insert one purchase_orders + po_items: received_qty = 3,
--       reference_date = 2026-05-02 (between anchors).
--   (5) Insert one waste_log entry: quantity = 1, logged_at on
--       2026-05-02.
--
-- All input values are integers; the runner emits `to_char(...,
-- 'FM999,990.000')`. Cast back to numeric for exact-equality
-- assertions (no epsilon needed).

begin;
create extension if not exists pgtap;

select plan(7);

-- ─── fixtures ──────────────────────────────────────────────────
do $$
declare
  v_manager_id uuid := '22222222-2222-2222-2222-222222222222';
  v_frederick  uuid;
  v_vendor_id  uuid;
  v_item_id    uuid;
  v_item_name  text;
  v_cost       numeric;
begin
  select id into v_frederick from public.stores where name = 'Frederick' limit 1;
  select id into v_vendor_id from public.vendors limit 1;

  -- Pick a Frederick item whose catalog_id is NOT in any recipe AND
  -- whose cost > 0 (so the runner's missing-cost zero-out doesn't fire).
  -- Stable across seed refreshes — the seed has 100+ such items.
  -- Also capture the item NAME so the assertions can filter the rows
  -- array by the fixture row (defends against seed contamination — the
  -- variance window may contain other items with non-zero deltas).
  select ii.id, ii.cost_per_unit, ci.name
    into v_item_id, v_cost, v_item_name
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
  perform set_config('test.vendor_id',    v_vendor_id::text,  true);
  perform set_config('test.item_id',      v_item_id::text,    true);
  perform set_config('test.item_name',    v_item_name,        true);
  perform set_config('test.cost',         v_cost::text,       true);
  -- Pre-compute the expected dollar string (delta × cost). delta = -8.
  -- The runner formats as '-$' || to_char(abs(d), 'FM999,990.00').
  perform set_config('test.expected_dollar',
    '-$' || to_char(abs(-8 * v_cost), 'FM999,990.00'),
    true);
end $$;

select isnt(current_setting('test.item_id', true), '',
  'fixture: Frederick item with cost>0 and not-in-any-recipe resolves from seed');

-- ─── Impersonate manager + INSERT fixture rows ────────────────
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

-- Two eod_submissions: prior anchor 2026-05-01, current anchor 2026-05-02.
create temp table _subs on commit drop as
with prior_sub as (
  insert into public.eod_submissions (store_id, date, vendor_id, status, client_uuid)
  values (current_setting('test.frederick_id', true)::uuid,
          '2026-05-01'::date,
          current_setting('test.vendor_id', true)::uuid,
          'submitted',
          gen_random_uuid())
  returning id, 'prior' as kind
),
current_sub as (
  insert into public.eod_submissions (store_id, date, vendor_id, status, client_uuid)
  values (current_setting('test.frederick_id', true)::uuid,
          '2026-05-02'::date,
          current_setting('test.vendor_id', true)::uuid,
          'submitted',
          gen_random_uuid())
  returning id, 'current' as kind
)
select * from prior_sub union all select * from current_sub;

do $$
declare
  v_prior   uuid;
  v_current uuid;
begin
  select id into v_prior from _subs where kind = 'prior' limit 1;
  select id into v_current from _subs where kind = 'current' limit 1;
  perform set_config('test.prior_sub', v_prior::text, true);
  perform set_config('test.current_sub', v_current::text, true);
end $$;

-- Two eod_entries: prior=10, current=4 on the same item.
insert into public.eod_entries (submission_id, item_id, actual_remaining)
values
  (current_setting('test.prior_sub',   true)::uuid,
   current_setting('test.item_id',     true)::uuid, 10),
  (current_setting('test.current_sub', true)::uuid,
   current_setting('test.item_id',     true)::uuid, 4);

-- Purchase order receiving (reference_date 2026-05-02, between anchors
-- per the > v_from AND <= v_to half-open rule).
--
-- po_number is explicitly set to bypass the generate_po_number()
-- BEFORE-INSERT trigger (it only fires WHEN po_number IS NULL). The
-- trigger reads the max po_number across the table and substrings
-- positions 4+ to cast as int — non-PO-NNN values (legacy dev data)
-- break the cast. Setting po_number side-steps the trigger entirely.
-- The substr-cast issue is pre-existing and unrelated to this test.
create temp table _po on commit drop as
with ins as (
  insert into public.purchase_orders
    (store_id, vendor_id, status, received_at, reference_date, po_number)
  values
    (current_setting('test.frederick_id', true)::uuid,
     current_setting('test.vendor_id',    true)::uuid,
     'received',
     '2026-05-01 23:59:00+00'::timestamptz,
     '2026-05-02'::date,
     'SPEC023-A2-' || gen_random_uuid()::text)
  returning id
)
select id from ins;

do $$
declare v_po uuid;
begin
  select id into v_po from _po limit 1;
  perform set_config('test.po_id', v_po::text, true);
end $$;

insert into public.po_items (po_id, item_id, ordered_qty, received_qty)
values (
  current_setting('test.po_id',   true)::uuid,
  current_setting('test.item_id', true)::uuid,
  3,
  3
);

-- Waste log entry — quantity = 1 on 2026-05-02.
insert into public.waste_log
  (store_id, item_id, quantity, logged_at)
values
  (current_setting('test.frederick_id', true)::uuid,
   current_setting('test.item_id',      true)::uuid,
   1,
   '2026-05-02 12:00:00+00'::timestamptz);

-- ─── Call the runner ──────────────────────────────────────────
create temp table _env on commit drop as
select public.report_run_variance(
  current_setting('test.frederick_id', true)::uuid,
  jsonb_build_object('from', '2026-05-01', 'to', '2026-05-02')
) as env;

-- ─── Assertions on the per-item formula ───────────────────────
-- The seed pulled on 2026-05-02 may contain unrelated Frederick items
-- with non-zero variance in the 2026-05-01..05-02 window, inflating the
-- rows array. Filter by the fixture's item name (captured in
-- test.item_name) rather than relying on `->0` indexing. The runner's
-- `item` field may suffix ' ⚠' / ' ⚠ (truncated)' — strip the suffix
-- when matching by using LIKE 'name%'.
-- Temp view; rolled back at end-of-transaction along with everything else.
create temp view _fixture_row as
  select r from _env, jsonb_array_elements(env->'rows') r
   where r->>'item' like current_setting('test.item_name', true) || '%';

-- (1) The fixture item appears in the rows table at least once.
select ok(
  (select count(*) from _fixture_row) >= 1,
  'fixture item appears in the rows table'
);

-- (2) Expected = prior + receiving − sales − waste = 10 + 3 − 0 − 1 = 12.
select is(
  ((select r from _fixture_row limit 1)->>'expected')::numeric,
  12.000::numeric,
  'expected = prior(10) + receiving(3) − sales(0) − waste(1) = 12'
);

-- (3) Counted = 4 from the current EOD entry.
select is(
  ((select r from _fixture_row limit 1)->>'counted')::numeric,
  4.000::numeric,
  'counted = current EOD actual_remaining (4)'
);

-- (4) Delta = counted − expected = 4 − 12 = -8.
-- Strip the runner's thousands-separator commas before casting.
select is(
  replace(((select r from _fixture_row limit 1)->>'delta'), ',', '')::numeric,
  -8.000::numeric,
  'delta = counted(4) − expected(12) = -8'
);

-- (5) Dollar impact = delta × cost_per_unit. The runner formats with
-- to_char(abs(d), 'FM999,990.00') and prepends '-$' for negative values.
select is(
  ((select r from _fixture_row limit 1)->>'dollar_impact'),
  current_setting('test.expected_dollar', true),
  format('dollar_impact = delta(-8) × cost(%s) (formatted)', current_setting('test.cost', true))
);

-- (6) Envelope shape sanity: rows/columns/kpis/series all present.
select is(
  (
    select array_agg(k order by k)
      from _env, jsonb_object_keys(env) k
     where k in ('kpis', 'columns', 'rows', 'series')
  ),
  array['columns', 'kpis', 'rows', 'series']::text[],
  'envelope retains the four standard keys'
);

select * from finish();
rollback;
