-- supabase/tests/report_run_vendor.test.sql
--
-- Spec 035 — coverage for `public.report_run_vendor(uuid, jsonb)` from
-- `supabase/migrations/20260514180000_report_run_vendor.sql`. Asserts:
--
--   • Auth gate raises 42501 for a non-member store (mirrors
--     `report_run_waste.test.sql` (3)).
--   • Empty-range short-circuit returns populated columns + empty
--     kpis/rows/series.
--   • Per-row formula on a single fixture insert: received_qty ×
--     cost_per_unit snapshot from po_items (NO inventory_items join —
--     historical cost only; see migration design notes).
--   • Missing-cost zero-out (cost_per_unit IS NULL → $0 contribution,
--     row still surfaces). No ⚠ suffix per Q5 / waste precedent.
--   • Multi-vendor ordering by dollar_impact DESC.
--   • Status filter regression (unique to vendor: draft/no-received_at
--     rows must NOT contribute spend or surface in rows).
--   • by='category' AND by='item' smoke — column[0].key flips correctly
--     and 'unit' surfaces for by='item'.
--   • Envelope shape: sorted-key list = [columns, kpis, rows, series].
--
-- Fixture pattern mirrors `report_run_waste.test.sql`: Frederick store
-- named lookup, manager JWT 22222222-..., hermetic `begin; ... rollback;`.
-- Fixture biz_date '2026-06-01' is AFTER the seed pull date (2026-05-02)
-- so seed-collision regressions surface immediately if a future seed
-- back-dates PO history into the test's window.

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
  v_vendor_a   uuid;
  v_vendor_b   uuid;
begin
  select id into v_frederick from public.stores where name = 'Frederick' limit 1;
  select id into v_charles   from public.stores where name = 'Charles'   limit 1;

  -- Pick a Frederick inventory_item with cost > 0 (stable across seed
  -- refreshes — the seed has 100+ such items). The runner uses the
  -- po_items.cost_per_unit SNAPSHOT not inventory_items.cost_per_unit,
  -- so cost on inventory_items is only used as a fixture-resolution
  -- heuristic to pick a real item id.
  select id into v_item_id
    from public.inventory_items
   where store_id = v_frederick
     and coalesce(cost_per_unit, 0) > 0
   order by id asc
   limit 1;

  -- Pick two distinct vendors from the seed (SYSCO + RESTAURANT DEPOT,
  -- ordered by name). Stable across seed refreshes — they're hardcoded
  -- by id in supabase/seed.sql:204-215.
  select id into v_vendor_a
    from public.vendors
   where name = 'SYSCO'
   limit 1;

  select id into v_vendor_b
    from public.vendors
   where name = 'RESTAURANT DEPOT'
   limit 1;

  perform set_config('test.manager_id',   v_manager_id::text, true);
  perform set_config('test.frederick_id', v_frederick::text,  true);
  perform set_config('test.charles_id',   v_charles::text,    true);
  perform set_config('test.item_id',      v_item_id::text,    true);
  perform set_config('test.vendor_a',     v_vendor_a::text,   true);
  perform set_config('test.vendor_b',     v_vendor_b::text,   true);
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
    $q$select public.report_run_vendor(%L::uuid, '{}'::jsonb)$q$,
    current_setting('test.charles_id', true)
  ),
  '42501',
  null,
  'report_run_vendor raises 42501 for a non-member store (manager calling Charles)'
);

-- (4) Empty range — call with from = to = '2000-01-01' (no PO rows
-- in seed for that date). Envelope must have populated columns AND
-- empty kpis/rows/series.
create temp table _empty_env on commit drop as
select public.report_run_vendor(
  current_setting('test.frederick_id', true)::uuid,
  jsonb_build_object('from', '2000-01-01', 'to', '2000-01-01', 'by', 'vendor')
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
    'cols_first',  'vendor'
  ),
  'empty range: kpis/rows/series all empty arrays; columns populated for by=vendor'
) from _empty_env;

-- ─── Insert fixture PO rows ──────────────────────────────────
-- PO A — vendor A (SYSCO), status='received', reference_date=2026-06-01.
--   Line: received_qty=10, cost_per_unit=2.50 → $25.00 spend.
-- PO B — vendor B (RESTAURANT DEPOT), status='received',
--   reference_date=2026-06-01.
--   Line: received_qty=5, cost_per_unit=1.00 → $5.00 spend
--   (under SYSCO, so SYSCO dominates the ordering).
-- PO C — vendor A (SYSCO), status='draft', received_at IS NULL,
--   reference_date=2026-06-01. Line mirrors PO A's qty/cost. This row
--   MUST NOT contribute to the headline or surface in rows.
-- PO D (added in arm 6 after the first re-call) — second po_items line
--   on PO A with cost_per_unit=NULL, received_qty=1 → $0 contribution.
do $$
declare
  v_po_a uuid := gen_random_uuid();
  v_po_b uuid := gen_random_uuid();
  v_po_c uuid := gen_random_uuid();
begin
  insert into public.purchase_orders (id, store_id, vendor_id, status, received_at, reference_date, created_at)
  values
    (v_po_a, current_setting('test.frederick_id', true)::uuid,
            current_setting('test.vendor_a',     true)::uuid,
            'received', '2026-06-01 12:00:00+00'::timestamptz,
            '2026-06-01'::date, now()),
    (v_po_b, current_setting('test.frederick_id', true)::uuid,
            current_setting('test.vendor_b',     true)::uuid,
            'received', '2026-06-01 13:00:00+00'::timestamptz,
            '2026-06-01'::date, now()),
    (v_po_c, current_setting('test.frederick_id', true)::uuid,
            current_setting('test.vendor_a',     true)::uuid,
            'draft', null::timestamptz,
            '2026-06-01'::date, now());

  insert into public.po_items (po_id, item_id, ordered_qty, received_qty, cost_per_unit)
  values
    (v_po_a, current_setting('test.item_id', true)::uuid, 10, 10, 2.50),
    (v_po_b, current_setting('test.item_id', true)::uuid,  5,  5, 1.00),
    (v_po_c, current_setting('test.item_id', true)::uuid, 10, 10, 2.50);

  perform set_config('test.po_a', v_po_a::text, true);
  perform set_config('test.po_b', v_po_b::text, true);
  perform set_config('test.po_c', v_po_c::text, true);
end $$;

-- ─── Call the runner: closed window 2026-06-01 .. 2026-06-01 ──
create temp table _env on commit drop as
select public.report_run_vendor(
  current_setting('test.frederick_id', true)::uuid,
  jsonb_build_object('from', '2026-06-01', 'to', '2026-06-01', 'by', 'vendor')
) as env;

-- (5) Single-row formula assertion (deliberate deviation from spec AC's
-- single-vendor $25.00 case — code-reviewer spec 035 S2 acknowledged).
-- The fixture is multi-vendor (SYSCO $25 + Restaurant Depot $5 = $30)
-- to also exercise arm 6's ordering assertion without re-seeding; that
-- shape was approved at design time as a plan(11) consolidation but the
-- design-doc note was never added. Asserts (a) the SYSCO row's exact
-- per-row shape — vendor='SYSCO', total_qty='10.000',
-- dollar_impact='$25.00', po_count=1 (the SINGLE-row formula the AC
-- targets) — plus (b) the multi-row Total spend KPI = $30.00 as a
-- bundled sanity check. The "single-row" name refers to the formula
-- correctness of the SYSCO row, not the total fixture size.
select is(
  (
    select jsonb_build_object(
      'total_spend',    (select k->>'value' from jsonb_array_elements(env->'kpis') k
                          where k->>'label' = 'Total spend $' limit 1),
      'sysco_vendor',   (select r->>'vendor' from jsonb_array_elements(env->'rows') r
                          where r->>'vendor' = 'SYSCO' limit 1),
      'sysco_qty',      (select r->>'total_qty' from jsonb_array_elements(env->'rows') r
                          where r->>'vendor' = 'SYSCO' limit 1),
      'sysco_dollar',   (select r->>'dollar_impact' from jsonb_array_elements(env->'rows') r
                          where r->>'vendor' = 'SYSCO' limit 1),
      'sysco_pos',      (select (r->>'po_count')::int from jsonb_array_elements(env->'rows') r
                          where r->>'vendor' = 'SYSCO' limit 1)
    ) from _env
  ),
  jsonb_build_object(
    'total_spend',    '$30.00',
    'sysco_vendor',   'SYSCO',
    'sysco_qty',      '10.000',
    'sysco_dollar',   '$25.00',
    'sysco_pos',      1
  ),
  'single-row formula: SYSCO row = $25.00 (10 × $2.50), Total spend $ = $30.00'
);

-- (6) Multi-vendor ordering: SYSCO ($25.00) > RESTAURANT DEPOT ($5.00).
-- Assert ordered vendor names from array_agg with ordinality.
select is(
  (
    select array_agg(r->>'vendor' order by ord)
      from (
        select r, ord
          from _env, jsonb_array_elements(env->'rows') with ordinality as t(r, ord)
      ) ordered_rows
  ),
  array['SYSCO', 'RESTAURANT DEPOT']::text[],
  'rows ordered by dollar_impact DESC: SYSCO ($25) > RESTAURANT DEPOT ($5)'
);

-- (7) Status filter regression — load-bearing for the vendor runner
-- (unique to this RPC; waste has no status column). The draft PO C
-- (status='draft', received_at IS NULL) MUST NOT contribute its
-- $25.00 to Total spend $, and MUST NOT add a third row.
-- The earlier (5)/(6) assertions already exercised this implicitly
-- (Total spend = $30, not $55; rows length = 2 via ordered names),
-- but we re-assert it explicitly so a future refactor that loosens
-- the WHERE clause surfaces here with a precise error message.
select is(
  (
    select jsonb_build_object(
      'rows_len',    jsonb_array_length(env->'rows'),
      'total_spend', (select k->>'value' from jsonb_array_elements(env->'kpis') k
                        where k->>'label' = 'Total spend $' limit 1),
      'pos_count',   (select (k->>'value')::int from jsonb_array_elements(env->'kpis') k
                        where k->>'label' = 'POs in period' limit 1)
    ) from _env
  ),
  jsonb_build_object(
    'rows_len',    2,
    'total_spend', '$30.00',
    'pos_count',   2
  ),
  'status filter: draft PO with received_at IS NULL is excluded (rows=2, total=$30.00, POs=2)'
);

-- ─── Add missing-cost line to PO A ────────────────────────────
-- Adds a second po_items row to PO A with cost_per_unit=NULL. The
-- runner should treat NULL cost as $0 contribution but still surface
-- the qty in total_qty. After this insert, SYSCO's qty becomes
-- 10 + 1 = 11; SYSCO dollar stays at $25.00.
insert into public.po_items (po_id, item_id, ordered_qty, received_qty, cost_per_unit)
values (
  current_setting('test.po_a', true)::uuid,
  current_setting('test.item_id', true)::uuid,
  1, 1, NULL
);

-- Re-call after the NULL-cost insert.
create temp table _env2 on commit drop as
select public.report_run_vendor(
  current_setting('test.frederick_id', true)::uuid,
  jsonb_build_object('from', '2026-06-01', 'to', '2026-06-01', 'by', 'vendor')
) as env;

-- (8) Missing-cost zero-out: SYSCO row dollar stays $25.00 (NULL cost
-- line adds $0); SYSCO qty grows from 10.000 → 11.000 (NULL cost
-- line still contributes qty). No ⚠ suffix per waste precedent.
select is(
  (
    select jsonb_build_object(
      'sysco_qty',    (select r->>'total_qty' from _env2, jsonb_array_elements(env->'rows') r
                        where r->>'vendor' = 'SYSCO' limit 1),
      'sysco_dollar', (select r->>'dollar_impact' from _env2, jsonb_array_elements(env->'rows') r
                        where r->>'vendor' = 'SYSCO' limit 1),
      'total_spend',  (select k->>'value' from _env2, jsonb_array_elements(env->'kpis') k
                        where k->>'label' = 'Total spend $' limit 1)
    )
  ),
  jsonb_build_object(
    'sysco_qty',    '11.000',
    'sysco_dollar', '$25.00',
    'total_spend',  '$30.00'
  ),
  'missing-cost zero-out: NULL cost contributes $0 dollar (qty still surfaces; headline unchanged)'
);

-- (9) by='category' smoke — column[0].key = 'category' and rows[0]
-- has a 'category' key.
create temp table _env_cat on commit drop as
select public.report_run_vendor(
  current_setting('test.frederick_id', true)::uuid,
  jsonb_build_object('from', '2026-06-01', 'to', '2026-06-01', 'by', 'category')
) as env;

select is(
  (
    select jsonb_build_object(
      'cols_first',  env->'columns'->0->>'key',
      'rows_first_has_category', case when env->'rows'->0->'category' is not null then true else false end
    ) from _env_cat
  ),
  jsonb_build_object(
    'cols_first',              'category',
    'rows_first_has_category', true
  ),
  'by=category smoke: columns[0].key = ''category'' and rows[0] has a ''category'' key'
);

-- (10) by='item' smoke — column[0].key = 'item', rows[0] has an
-- 'item' key, AND the 'unit' column is present (per-mode shape
-- divergence — only the item mode advertises a unit column).
create temp table _env_item on commit drop as
select public.report_run_vendor(
  current_setting('test.frederick_id', true)::uuid,
  jsonb_build_object('from', '2026-06-01', 'to', '2026-06-01', 'by', 'item')
) as env;

select is(
  (
    select jsonb_build_object(
      'cols_first',         env->'columns'->0->>'key',
      'rows_first_has_item', case when env->'rows'->0->'item' is not null then true else false end,
      'has_unit_col',        exists(
                              select 1 from jsonb_array_elements(env->'columns') c
                              where c->>'key' = 'unit'
                            )
    ) from _env_item
  ),
  jsonb_build_object(
    'cols_first',         'item',
    'rows_first_has_item', true,
    'has_unit_col',        true
  ),
  'by=item smoke: columns[0].key = ''item'', rows[0] has ''item'', and ''unit'' column is present'
);

-- (11) Envelope shape sanity: sorted-key list matches the spec 016
-- uniform envelope. Mirrors waste arm (10).
select is(
  (
    select array_agg(k order by k)
      from _env, jsonb_object_keys(env) k
     where k in ('kpis', 'columns', 'rows', 'series')
  ),
  array['columns', 'kpis', 'rows', 'series']::text[],
  'envelope retains the four standard keys (kpis, columns, rows, series)'
);

select * from finish();
rollback;
