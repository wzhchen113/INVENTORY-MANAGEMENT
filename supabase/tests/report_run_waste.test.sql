-- supabase/tests/report_run_waste.test.sql
--
-- Spec 034 — coverage for `public.report_run_waste(uuid, jsonb)` from
-- `supabase/migrations/20260514170000_report_run_waste.sql`. Asserts:
--
--   • Auth gate raises 42501 for a non-member store (mirrors
--     `report_run_cogs.test.sql` (1)).
--   • Empty-range short-circuit returns populated columns + empty
--     kpis/rows/series.
--   • Per-row formula on a single fixture insert: qty × cost_per_unit
--     snapshot from waste_log (NO inventory_items join — historical
--     cost only; see migration design notes).
--   • Missing-cost zero-out (cost_per_unit IS NULL → $0 contribution,
--     row still surfaces). No ⚠ suffix per Q5 resolution.
--   • Multi-row ordering by dollar_impact DESC.
--   • Envelope shape: sorted-key list = [columns, kpis, rows, series].
--   • by='category' AND by='item' smoke — column[0].key flips correctly.
--
-- Fixture pattern mirrors `report_run_variance_formula.test.sql`:
-- Frederick store named lookup, manager JWT 22222222-..., hermetic
-- `begin; ... rollback;`.

begin;
create extension if not exists pgtap;

select plan(11);

-- ─── fixtures ──────────────────────────────────────────────────
do $$
declare
  v_manager_id uuid := '22222222-2222-2222-2222-222222222222';
  v_frederick  uuid;
  v_charles    uuid;
  v_item_id    uuid;
  v_item_id_2  uuid;
begin
  select id into v_frederick from public.stores where name = 'Frederick' limit 1;
  select id into v_charles   from public.stores where name = 'Charles'   limit 1;

  -- Pick a Frederick inventory_item with cost > 0 (stable across seed
  -- refreshes — the seed has 100+ such items). Picks a second item id
  -- so multi-row tests can vary on item_id without colliding.
  select id into v_item_id
    from public.inventory_items
   where store_id = v_frederick
     and coalesce(cost_per_unit, 0) > 0
   order by id asc
   limit 1;

  select id into v_item_id_2
    from public.inventory_items
   where store_id = v_frederick
     and coalesce(cost_per_unit, 0) > 0
     and id <> v_item_id
   order by id asc
   limit 1;

  perform set_config('test.manager_id',   v_manager_id::text, true);
  perform set_config('test.frederick_id', v_frederick::text,  true);
  perform set_config('test.charles_id',   v_charles::text,    true);
  perform set_config('test.item_id',      v_item_id::text,    true);
  perform set_config('test.item_id_2',    v_item_id_2::text,  true);
end $$;

-- (1) Fixture sanity: Frederick store id resolves from seed.
select isnt(current_setting('test.frederick_id', true), '',
  'fixture: Frederick store id resolves from seed');

-- (2) Fixture sanity: A Frederick inventory_item with cost > 0 resolves.
select isnt(current_setting('test.item_id', true), '',
  'fixture: Frederick inventory_item with cost > 0 resolves from seed');

-- ─── Impersonate manager (member of Towson + Frederick) ──────
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

-- (3) Auth gate: manager calling Charles (non-member store) raises 42501.
select throws_ok(
  format(
    $q$select public.report_run_waste(%L::uuid, '{}'::jsonb)$q$,
    current_setting('test.charles_id', true)
  ),
  '42501',
  null,
  'report_run_waste raises 42501 for a non-member store (manager calling Charles)'
);

-- (4) Empty range — call with from = to = '2000-01-01' (no waste rows
-- in seed for that date). Envelope must have populated columns AND
-- empty kpis/rows/series.
create temp table _empty_env on commit drop as
select public.report_run_waste(
  current_setting('test.frederick_id', true)::uuid,
  jsonb_build_object('from', '2000-01-01', 'to', '2000-01-01', 'by', 'reason')
) as env;

select is(
  jsonb_build_object(
    'kpis_len',    jsonb_array_length(env->'kpis'),
    'rows_len',    jsonb_array_length(env->'rows'),
    'series_len',  jsonb_array_length(env->'series'),
    'cols_typeof', jsonb_typeof(env->'columns'),
    'cols_first',  env->'columns'->0->>'key'
  ),
  jsonb_build_object(
    'kpis_len',    0,
    'rows_len',    0,
    'series_len',  0,
    'cols_typeof', 'array',
    'cols_first',  'reason'
  ),
  'empty range: kpis/rows/series all empty arrays; columns populated for by=reason'
) from _empty_env;

-- ─── Insert fixture waste rows ────────────────────────────────
-- Row A: qty=2.5, cost=4.00, reason='Spoilage', logged_at=2026-06-01.
-- Row B: qty=1.0, cost=NULL, reason='Quality issue', logged_at=2026-06-01
--        (missing-cost row — contributes $0 to dollar).
-- Row C: qty=1.0, cost=20.00, reason='Theft', logged_at=2026-06-01
--        ($20.00 dominates; row C comes first under desc sort).
--
-- All three on the SAME logged_at::date so the < 2 distinct dates
-- series gate triggers and series stays '[]'. The single-row formula
-- assertion (5/6/7) and the missing-cost (8) and ordering (9) checks
-- use the same fixture set.
insert into public.waste_log (store_id, item_id, quantity, cost_per_unit, reason, logged_at)
values
  (current_setting('test.frederick_id', true)::uuid,
   current_setting('test.item_id',      true)::uuid,
   2.5, 4.00, 'Spoilage',     '2026-06-01 12:00:00+00'::timestamptz),
  (current_setting('test.frederick_id', true)::uuid,
   current_setting('test.item_id_2',    true)::uuid,
   1.0, NULL, 'Quality issue', '2026-06-01 13:00:00+00'::timestamptz),
  (current_setting('test.frederick_id', true)::uuid,
   current_setting('test.item_id_2',    true)::uuid,
   1.0, 20.00, 'Theft',        '2026-06-01 14:00:00+00'::timestamptz);

-- ─── Call the runner: closed window 2026-06-01 .. 2026-06-01 ──
create temp table _env on commit drop as
select public.report_run_waste(
  current_setting('test.frederick_id', true)::uuid,
  jsonb_build_object('from', '2026-06-01', 'to', '2026-06-01', 'by', 'reason')
) as env;

-- (5) Total waste $ KPI = $10 (Spoilage) + $0 (missing cost) + $20 (Theft) = $30.00.
select is(
  (
    select (k->>'value')::text
      from _env, jsonb_array_elements(env->'kpis') k
     where k->>'label' = 'Total waste $'
     limit 1
  ),
  '$30.00',
  'Total waste $ KPI sums to $30.00 (Spoilage $10 + missing-cost $0 + Theft $20)'
);

-- (6) Spoilage row has qty = '2.500'.
select is(
  (
    select (r->>'qty')::text
      from _env, jsonb_array_elements(env->'rows') r
     where r->>'reason' = 'Spoilage'
     limit 1
  ),
  '2.500',
  'rows[reason=Spoilage].qty = ''2.500'' (FM999,990.000 mask)'
);

-- (7) Spoilage row dollar_impact = '$10.00' (2.5 × 4.00).
select is(
  (
    select (r->>'dollar_impact')::text
      from _env, jsonb_array_elements(env->'rows') r
     where r->>'reason' = 'Spoilage'
     limit 1
  ),
  '$10.00',
  'rows[reason=Spoilage].dollar_impact = ''$10.00'' (qty × snapshot cost)'
);

-- (8) Missing-cost zero-out: Quality issue row has dollar_impact = '$0.00'
-- (cost_per_unit IS NULL → $0 contribution). No ⚠ suffix per Q5.
select is(
  (
    select (r->>'dollar_impact')::text
      from _env, jsonb_array_elements(env->'rows') r
     where r->>'reason' = 'Quality issue'
     limit 1
  ),
  '$0.00',
  'rows[reason=Quality issue].dollar_impact = ''$0.00'' (NULL cost → $0; row still surfaces)'
);

-- (9) Multi-row ordering by dollar_impact DESC: Theft ($20) → Spoilage
-- ($10) → Quality issue ($0). Compare the ordered reason list.
select is(
  (
    select array_agg(r->>'reason' order by ord)
      from (
        select r, ord
          from _env, jsonb_array_elements(env->'rows') with ordinality as t(r, ord)
      ) ordered_rows
  ),
  array['Theft', 'Spoilage', 'Quality issue']::text[],
  'rows ordered by dollar_impact DESC: Theft ($20) > Spoilage ($10) > Quality issue ($0)'
);

-- (10) Envelope shape sanity: sorted-key list matches the spec 016
-- uniform envelope. Mirrors variance line 248-256, COGS line 105-113.
select is(
  (
    select array_agg(k order by k)
      from _env, jsonb_object_keys(env) k
     where k in ('kpis', 'columns', 'rows', 'series')
  ),
  array['columns', 'kpis', 'rows', 'series']::text[],
  'envelope retains the four standard keys (kpis, columns, rows, series)'
);

-- (11) by-mode smoke: by='category' AND by='item' produce columns whose
-- first column key matches the active mode. Single is() over a 2-row
-- array_agg keeps it one assertion arm.
create temp table _env_cat on commit drop as
select public.report_run_waste(
  current_setting('test.frederick_id', true)::uuid,
  jsonb_build_object('from', '2026-06-01', 'to', '2026-06-01', 'by', 'category')
) as env;

create temp table _env_item on commit drop as
select public.report_run_waste(
  current_setting('test.frederick_id', true)::uuid,
  jsonb_build_object('from', '2026-06-01', 'to', '2026-06-01', 'by', 'item')
) as env;

select is(
  array[
    (select env->'columns'->0->>'key' from _env_cat),
    (select env->'columns'->0->>'key' from _env_item)
  ]::text[],
  array['category', 'item']::text[],
  'by-mode column key flips correctly (by=category → ''category''; by=item → ''item'')'
);

select * from finish();
rollback;
