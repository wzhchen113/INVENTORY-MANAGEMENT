-- supabase/tests/eod_no_need.test.sql
--
-- Spec 172 — EOD "NO NEED" mark. pgTAP coverage for
-- supabase/migrations/20261024000000_eod_entries_no_need.sql:
--
--   • eod_entries.no_need column + eod_entries_no_need_no_quantity_check
--     (AC-1, AC-2, design §10 (vi)).
--   • staff_submit_eod NO NEED hunks S1-S5 (AC-3, AC-4, AC-5).
--   • admin direct-PostgREST insert under existing RLS (AC-6).
--   • report_reorder_list NO NEED override hunks R1-R4 (AC-8 .. AC-13,
--     design §10 (iv) both V2 variants, (v) OQ-2 precedence, D7).
--   • report_run_variance treats a NO NEED entry as absent (AC-15).
--   • posture pins: one pg_proc row each (no overload), prosecdef, and
--     anon/authenticated EXECUTE on both recreated functions (§10 i-iii).
--
-- AC-7 / AC-14 (regression) are proven by the rest of the suite passing
-- unmodified (every report_reorder_list_* file, reorder_list_has_po,
-- po_loop, eod_count_mode, staff_submit_eod_cases_each, staff_role_eod_rls,
-- eod_submissions_multi_vendor, permissive_policy_lint).
--
-- Fixture posture: every vendor / catalog row / item / link the reorder
-- assertions read is created INSIDE the transaction (three FRESH vendors in
-- Frederick's brand), so the assertions are independent of the seed's
-- vendor/item graph and of any scripts/smoke-staff-eod.sh residue for
-- today. All dates are synthetic (2001-*, 1999-12-2x) — no collision with
-- other suites or the smoke. No order_schedule rows are needed: a vendor
-- with no schedule falls back to days_until = 7 (A5) and every fixture item
-- has usage_per_portion = 0, so usage_forecasted is 0 and suggested_qty is
-- the pure par term.
--
--   V1 — reorder vendor: X (case_qty 4), S (shared), P (shared).
--   V2 — reorder vendor: S, P (shared with V1).
--   V3 — staff-RPC vendor: T (NO NEED), N (numeric), plus the AC-15
--        variance probe Y. Kept off V1/V2 so neither the staff writes nor
--        the variance fixture reach the reorder cards under test.
--   Every item: par 10, usage 0, cost 1. X/S/P current_stock 2; T/N 7.
--
-- No `set role anon` (segfaults CI per spec 067). Manager principal
-- (2222…, role=user, Towson + Frederick) mirrors
-- staff_role_eod_rls.test.sql; master principal (3333…) mirrors the
-- report_reorder_list_* suites. Hermetic: begin; … rollback;.

begin;
create extension if not exists pgtap;

select plan(54);

-- ─── fixtures (as postgres) ─────────────────────────────────────
do $$
declare
  v_frederick uuid;
  v_charles   uuid;
  v_brand     uuid;
  v_v1        uuid;
  v_v2        uuid;
  v_v3        uuid;
  v_tag       text := substr(gen_random_uuid()::text, 1, 8);
begin
  select id, brand_id into v_frederick, v_brand from public.stores where name = 'Frederick' limit 1;
  select id into v_charles from public.stores where name = 'Charles' limit 1;

  insert into public.vendors (name, brand_id) values ('SPEC172-V1-' || v_tag, v_brand) returning id into v_v1;
  insert into public.vendors (name, brand_id) values ('SPEC172-V2-' || v_tag, v_brand) returning id into v_v2;
  insert into public.vendors (name, brand_id) values ('SPEC172-V3-' || v_tag, v_brand) returning id into v_v3;

  perform set_config('test.manager_id',   '22222222-2222-2222-2222-222222222222', true);
  perform set_config('test.master_id',    '33333333-3333-3333-3333-333333333333', true);
  perform set_config('test.frederick_id', v_frederick::text, true);
  perform set_config('test.charles_id',   v_charles::text,   true);
  perform set_config('test.brand_id',     v_brand::text,     true);
  perform set_config('test.v1',           v_v1::text,        true);
  perform set_config('test.v2',           v_v2::text,        true);
  perform set_config('test.v3',           v_v3::text,        true);
  perform set_config('test.tag',          v_tag,             true);
end $$;

create temp table _cat on commit drop as
with ins as (
  insert into public.catalog_ingredients (brand_id, name, unit, case_qty)
  select current_setting('test.brand_id', true)::uuid,
         'SPEC172-' || k || '-' || current_setting('test.tag', true),
         'lbs',
         case when k = 'X' then 4 else 1 end
    from unnest(array['X','S','P','T','N','Y']) as k
  returning id, name
)
select id, name, split_part(name, '-', 2) as kind from ins;

-- Y is the AC-15 variance probe (V3-linked, so it never reaches the V1/V2
-- reorder cards under test).
create temp table _items on commit drop as
with ins as (
  insert into public.inventory_items
    (store_id, catalog_id, vendor_id, cost_per_unit, current_stock, eod_remaining,
     par_level, usage_per_portion, updated_at)
  select current_setting('test.frederick_id', true)::uuid,
         c.id,
         case when c.kind in ('T','N','Y') then current_setting('test.v3', true)::uuid
              else current_setting('test.v1', true)::uuid end,
         1,
         case when c.kind in ('T','N') then 7 else 2 end,
         case when c.kind in ('T','N') then 7 else 2 end,
         10,
         0,
         '2000-01-01 00:00:00+00'::timestamptz
    from _cat c
  returning id, catalog_id
)
select i.id, c.kind, c.name from ins i join _cat c on c.id = i.catalog_id;

do $$
declare r record;
begin
  for r in select kind, id, name from _items loop
    perform set_config('test.item_' || lower(r.kind), r.id::text, true);
    perform set_config('test.name_' || lower(r.kind), r.name, true);
  end loop;
  perform set_config('test.charles_item',
    (select id::text from public.inventory_items
      where store_id = current_setting('test.charles_id', true)::uuid limit 1), true);
end $$;

insert into public.item_vendors (item_id, vendor_id, cost_per_unit, case_price, is_primary)
values
  (current_setting('test.item_x', true)::uuid, current_setting('test.v1', true)::uuid, 1, 0, true),
  (current_setting('test.item_s', true)::uuid, current_setting('test.v1', true)::uuid, 1, 0, true),
  (current_setting('test.item_s', true)::uuid, current_setting('test.v2', true)::uuid, 1, 0, false),
  (current_setting('test.item_p', true)::uuid, current_setting('test.v1', true)::uuid, 1, 0, true),
  (current_setting('test.item_p', true)::uuid, current_setting('test.v2', true)::uuid, 1, 0, false),
  (current_setting('test.item_y', true)::uuid, current_setting('test.v3', true)::uuid, 1, 0, true),
  (current_setting('test.item_t', true)::uuid, current_setting('test.v3', true)::uuid, 1, 0, true),
  (current_setting('test.item_n', true)::uuid, current_setting('test.v3', true)::uuid, 1, 0, true)
on conflict (item_id, vendor_id) do nothing;

-- A draft scratch submission for the raw CHECK probes (AC-1/AC-2).
create temp table _scratch on commit drop as
with ins as (
  insert into public.eod_submissions (store_id, date, vendor_id, status, client_uuid)
  values (current_setting('test.frederick_id', true)::uuid, '2001-01-01'::date,
          current_setting('test.v3', true)::uuid, 'draft', gen_random_uuid())
  returning id
)
select id from ins;

-- Charles submission for the AC-6 non-member probe (created as postgres;
-- the manager has no Charles membership).
create temp table _charles_sub on commit drop as
with ins as (
  insert into public.eod_submissions (store_id, date, vendor_id, status, client_uuid)
  values (current_setting('test.charles_id', true)::uuid, '2001-01-02'::date,
          current_setting('test.v3', true)::uuid, 'submitted', gen_random_uuid())
  returning id
)
select id from ins;

-- Frederick submission for the AC-6 member probe.
create temp table _fred_sub on commit drop as
with ins as (
  insert into public.eod_submissions (store_id, date, vendor_id, status, client_uuid)
  values (current_setting('test.frederick_id', true)::uuid, '2001-01-02'::date,
          current_setting('test.v3', true)::uuid, 'submitted', gen_random_uuid())
  returning id
)
select id from ins;

do $$
begin
  perform set_config('test.scratch_sub', (select id::text from _scratch), true);
  perform set_config('test.charles_sub', (select id::text from _charles_sub), true);
  perform set_config('test.fred_sub',    (select id::text from _fred_sub), true);
end $$;

-- ═══ AC-1 / AC-2 — column + CHECK ═════════════════════════════════
select has_column('public', 'eod_entries', 'no_need', '(1) AC-1: eod_entries.no_need exists');
select col_type_is('public', 'eod_entries', 'no_need', 'boolean', '(2) AC-1: no_need is boolean');
select col_not_null('public', 'eod_entries', 'no_need', '(3) AC-1: no_need is NOT NULL');
select col_default_is('public', 'eod_entries', 'no_need', 'false', '(4) AC-1: no_need defaults to false');

-- (5) retired in spec 172 review-fix round 1 (backend-architect M-1): the
-- old "pre-existing quantity-bearing rows read no_need = false" probe could
-- never fail — eod_entries_no_need_no_quantity_check makes its predicate
-- unsatisfiable — so it was not real AC-1 evidence. AC-1 is pinned by (3)
-- NOT NULL, (4) DEFAULT false (PG fills every pre-existing row from the
-- constant default on ADD COLUMN) and (10) omitted-column-reads-false.
-- The remaining labels keep their numbers so spec/review cross-references
-- such as (10) and (42) stay valid.

select throws_ok(
  format($q$insert into public.eod_entries (submission_id, item_id, actual_remaining, no_need)
            values (%L::uuid, %L::uuid, 3, true)$q$,
         current_setting('test.scratch_sub', true), current_setting('test.item_t', true)),
  '23514', null,
  '(6) AC-2: no_need = true with actual_remaining raises 23514'
);

select throws_ok(
  format($q$insert into public.eod_entries (submission_id, item_id, actual_remaining_cases, no_need)
            values (%L::uuid, %L::uuid, 1, true)$q$,
         current_setting('test.scratch_sub', true), current_setting('test.item_t', true)),
  '23514', null,
  '(7) AC-2: no_need = true with actual_remaining_cases raises 23514'
);

select throws_ok(
  format($q$insert into public.eod_entries (submission_id, item_id, actual_remaining_each, no_need)
            values (%L::uuid, %L::uuid, 1, true)$q$,
         current_setting('test.scratch_sub', true), current_setting('test.item_t', true)),
  '23514', null,
  '(8) AC-2: no_need = true with actual_remaining_each raises 23514'
);

-- (vi) a legacy null-total row (no_need omitted → false) stays valid.
select lives_ok(
  format($q$insert into public.eod_entries (submission_id, item_id, notes)
            values (%L::uuid, %L::uuid, 'spec172-legacy-null')$q$,
         current_setting('test.scratch_sub', true), current_setting('test.item_t', true)),
  '(9) AC-2/(vi): a no_need = false row with all numerics NULL is still admitted'
);

select is(
  (select no_need from public.eod_entries
    where submission_id = current_setting('test.scratch_sub', true)::uuid
      and notes = 'spec172-legacy-null'),
  false,
  '(10) AC-1: an insert omitting no_need reads false'
);

-- ═══ §10 (i)-(iii) posture pins ═══════════════════════════════════
select is(
  (select count(*)::bigint from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'staff_submit_eod'),
  1::bigint,
  '(11) exactly one public.staff_submit_eod (no overload)'
);
select is(
  (select count(*)::bigint from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'report_reorder_list'),
  1::bigint,
  '(12) exactly one public.report_reorder_list (no overload)'
);
select ok(
  (select prosecdef from pg_proc
    where oid = 'public.staff_submit_eod(uuid,uuid,date,text,text,jsonb,uuid)'::regprocedure),
  '(13) staff_submit_eod stays SECURITY DEFINER'
);
select ok(
  not (select prosecdef from pg_proc
        where oid = 'public.report_reorder_list(uuid,jsonb)'::regprocedure),
  '(14) report_reorder_list stays SECURITY INVOKER'
);
select ok(
  not has_function_privilege('anon', 'public.staff_submit_eod(uuid,uuid,date,text,text,jsonb,uuid)', 'EXECUTE'),
  '(15) anon lacks EXECUTE on staff_submit_eod'
);
select ok(
  has_function_privilege('authenticated', 'public.staff_submit_eod(uuid,uuid,date,text,text,jsonb,uuid)', 'EXECUTE'),
  '(16) authenticated keeps EXECUTE on staff_submit_eod'
);
select ok(
  not has_function_privilege('anon', 'public.report_reorder_list(uuid,jsonb)', 'EXECUTE'),
  '(17) anon lacks EXECUTE on report_reorder_list'
);
select ok(
  has_function_privilege('authenticated', 'public.report_reorder_list(uuid,jsonb)', 'EXECUTE'),
  '(18) authenticated keeps EXECUTE on report_reorder_list'
);

-- ═══ AC-3 / AC-4 / AC-5 / AC-6 — staff RPC + admin insert (manager) ═
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

-- Mixed payload: T is NO NEED (numerics absent), N is a legacy numeric
-- element WITHOUT a no_need key (AC-4 byte-identical path).
create temp table _staff_call on commit drop as
select public.staff_submit_eod(
  gen_random_uuid(),
  current_setting('test.frederick_id', true)::uuid,
  '1999-12-27'::date,
  null,
  'submitted',
  jsonb_build_array(
    jsonb_build_object('ingredient_id', current_setting('test.item_t', true)::uuid,
                       'no_need', true),
    jsonb_build_object('ingredient_id', current_setting('test.item_n', true)::uuid,
                       'actual_remaining', 5,
                       'unit', 'lbs')
  ),
  current_setting('test.v3', true)::uuid
) as result;

-- AC-5: NO NEED + a quantity → 23514, whole call rolls back.
select throws_ok(
  format($q$select public.staff_submit_eod(
      gen_random_uuid(), %L::uuid, '1999-12-26'::date, null, 'submitted',
      jsonb_build_array(jsonb_build_object(
        'ingredient_id', %L::uuid, 'no_need', true, 'actual_remaining', 3)),
      %L::uuid)$q$,
    current_setting('test.frederick_id', true),
    current_setting('test.item_t', true),
    current_setting('test.v3', true)),
  '23514', null,
  '(19) AC-5: a NO NEED element carrying actual_remaining is refused (23514)'
);

-- AC-6: store member inserts a NO NEED row directly (admin PostgREST path).
select lives_ok(
  format($q$insert into public.eod_entries (submission_id, item_id, no_need)
            values (%L::uuid, %L::uuid, true)$q$,
         current_setting('test.fred_sub', true), current_setting('test.item_t', true)),
  '(20) AC-6: a store member can INSERT a no_need = true eod_entries row in a visible store'
);

-- AC-6: non-member refused (RLS WITH CHECK or the cross-store trigger —
-- SQLSTATE deliberately not pinned, design §10).
select throws_ok(
  format($q$insert into public.eod_entries (submission_id, item_id, no_need)
            values (%L::uuid, %L::uuid, true)$q$,
         current_setting('test.charles_sub', true), current_setting('test.charles_item', true)),
  null, null,
  '(21) AC-6: a non-member is refused a no_need eod_entries insert (as today)'
);

reset role;

-- ─── AC-3 assertions (as postgres) ──────────────────────────────
select is(
  (select row(e.no_need, e.actual_remaining, e.actual_remaining_cases, e.actual_remaining_each)::text
     from public.eod_entries e
    where e.submission_id = (select (result->>'submission_id')::uuid from _staff_call)
      and e.item_id = current_setting('test.item_t', true)::uuid),
  row(true, null::numeric, null::numeric, null::numeric)::text,
  '(22) AC-3a: NO NEED element inserts no_need = true with all three numerics NULL'
);

select is(
  (select array[current_stock, eod_remaining]::numeric[] from public.inventory_items
    where id = current_setting('test.item_t', true)::uuid),
  array[7, 7]::numeric[],
  '(23) AC-3b: current_stock / eod_remaining unchanged (7, not 0, not NULL)'
);

select is(
  (select updated_at from public.inventory_items
    where id = current_setting('test.item_t', true)::uuid),
  '2000-01-01 00:00:00+00'::timestamptz,
  '(24) AC-3c: inventory_items.updated_at not bumped by the NO NEED entry'
);

select is(
  (select value from public.audit_log
    where store_id = current_setting('test.frederick_id', true)::uuid
      and action = 'EOD entry'
      and item_ref = current_setting('test.name_t', true)),
  'NO NEED',
  '(25) AC-3d: audit_log value for the NO NEED entry is ''NO NEED'''
);

select ok(
  not exists (
    select 1 from _staff_call, jsonb_array_elements(result->'stock_updates') su
     where su->>'ingredient_id' = current_setting('test.item_t', true)),
  '(26) AC-3e: stock_updates omits the NO NEED item'
);

select ok(
  (select e.no_need = false and e.actual_remaining = 5
     from public.eod_entries e
    where e.submission_id = (select (result->>'submission_id')::uuid from _staff_call)
      and e.item_id = current_setting('test.item_n', true)::uuid),
  '(27) AC-4: element without no_need key inserts no_need = false with its number'
);

select is(
  (select array[current_stock, eod_remaining]::numeric[] from public.inventory_items
    where id = current_setting('test.item_n', true)::uuid),
  array[5, 5]::numeric[],
  '(28) AC-4: numeric element still writes the on-hand'
);

select is(
  (select value from public.audit_log
    where store_id = current_setting('test.frederick_id', true)::uuid
      and action = 'EOD entry'
      and item_ref = current_setting('test.name_n', true)),
  '5 lbs',
  '(29) AC-4: numeric audit value unchanged (''<total> <unit>'')'
);

select is(
  (select (su->>'new_stock')::numeric
     from _staff_call, jsonb_array_elements(result->'stock_updates') su
    where su->>'ingredient_id' = current_setting('test.item_n', true)),
  5::numeric,
  '(30) AC-4: numeric element still appears in stock_updates'
);

select is(
  (select count(*)::bigint from public.eod_submissions
    where store_id = current_setting('test.frederick_id', true)::uuid
      and date = '1999-12-26'::date
      and vendor_id = current_setting('test.v3', true)::uuid),
  0::bigint,
  '(31) AC-5: the refused call left no parent eod_submissions row (whole call rolled back)'
);

select is(
  (select no_need from public.eod_entries
    where submission_id = current_setting('test.fred_sub', true)::uuid
      and item_id = current_setting('test.item_t', true)::uuid),
  true,
  '(32) AC-6: the member-inserted row persisted with no_need = true'
);

-- ═══ Reorder (master) ════════════════════════════════════════════
-- D = 2001-03-15. AC-9 baseline: X/S/P temporarily par 0 → nothing to
-- order → they contribute nothing to the below-par payload. A NO NEED row
-- must contribute exactly the same (nothing).
update public.inventory_items set par_level = 0
 where id in (current_setting('test.item_x', true)::uuid,
              current_setting('test.item_s', true)::uuid,
              current_setting('test.item_p', true)::uuid);

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

create temp table _env_base on commit drop as
select public.report_reorder_list(current_setting('test.frederick_id', true)::uuid,
                                  '{"as_of_date":"2001-03-15"}'::jsonb) as env;

reset role;

update public.inventory_items set par_level = 10
 where id in (current_setting('test.item_x', true)::uuid,
              current_setting('test.item_s', true)::uuid,
              current_setting('test.item_p', true)::uuid);

-- V1 submitted on D: X, S, P all NO NEED. V2 has NOT submitted.
create temp table _v1_sub on commit drop as
with ins as (
  insert into public.eod_submissions (store_id, date, vendor_id, status, client_uuid)
  values (current_setting('test.frederick_id', true)::uuid, '2001-03-15'::date,
          current_setting('test.v1', true)::uuid, 'submitted', gen_random_uuid())
  returning id
)
select id from ins;

insert into public.eod_entries (submission_id, item_id, no_need)
select (select id from _v1_sub), i.id, true
  from _items i where i.kind in ('X','S','P');

set local role authenticated;

create temp table _env_a on commit drop as
select public.report_reorder_list(current_setting('test.frederick_id', true)::uuid,
                                  '{"as_of_date":"2001-03-15","include_stocked":true}'::jsonb) as env;
create temp table _env_b on commit drop as
select public.report_reorder_list(current_setting('test.frederick_id', true)::uuid,
                                  '{"as_of_date":"2001-03-15"}'::jsonb) as env;

reset role;

create temp table _rows_a on commit drop as
select v->>'vendor_id' as vendor_id, v->>'on_hand_source' as vsrc, i->>'item_id' as item_id, i as item
  from _env_a, jsonb_array_elements(env->'vendors') v, jsonb_array_elements(v->'items') i;

-- ─── AC-8 (X on V1) ────────────────────────────────────────────
select is(
  (select array[(item->>'suggested_qty')::numeric, (item->>'par_replacement')::numeric,
                (item->>'usage_forecasted')::numeric, (item->>'suggested_units')::numeric,
                (item->>'estimated_cost')::numeric]
     from _rows_a where vendor_id = current_setting('test.v1', true)
                    and item_id = current_setting('test.item_x', true)),
  array[0, 0, 0, 0, 0]::numeric[],
  '(33) AC-8: NO NEED row has suggested_qty / par_replacement / usage_forecasted / suggested_units / estimated_cost = 0'
);
select is(
  (select (item->>'suggested_cases')::numeric
     from _rows_a where vendor_id = current_setting('test.v1', true)
                    and item_id = current_setting('test.item_x', true)),
  0::numeric,
  '(34) AC-8: suggested_cases = 0 when case_qty > 1'
);
select is(
  (select jsonb_typeof(item->'suggested_cases')
     from _rows_a where vendor_id = current_setting('test.v1', true)
                    and item_id = current_setting('test.item_s', true)),
  'null',
  '(35) AC-8: suggested_cases is JSON null when case_qty <= 1'
);
select is(
  (select (item->>'needs_order')::boolean
     from _rows_a where vendor_id = current_setting('test.v1', true)
                    and item_id = current_setting('test.item_x', true)),
  false,
  '(36) AC-8: needs_order = false'
);
select ok(
  (select item->'flags' ? 'no_need'
     from _rows_a where vendor_id = current_setting('test.v1', true)
                    and item_id = current_setting('test.item_x', true)),
  '(37) AC-8: flags contain ''no_need'''
);
select ok(
  (select not (item->'flags' ? 'eod_missing_for_item')
     from _rows_a where vendor_id = current_setting('test.v1', true)
                    and item_id = current_setting('test.item_x', true)),
  '(38) AC-8: flags do NOT contain ''eod_missing_for_item'''
);
select is(
  (select (item->>'on_hand')::numeric
     from _rows_a where vendor_id = current_setting('test.v1', true)
                    and item_id = current_setting('test.item_x', true)),
  2::numeric,
  '(39) AC-8: on_hand surfaces current_stock as-is (2), never fabricated as 0'
);

-- ─── AC-10 / AC-12 (V2 not submitted) / D7 ─────────────────────
select is(
  (select distinct vsrc from _rows_a where vendor_id = current_setting('test.v1', true)),
  'eod',
  '(40) AC-10: a vendor whose submitted items are all NO NEED rolls up on_hand_source = ''eod'''
);
select ok(
  (select item->'flags' ? 'no_need'
          and (item->>'suggested_qty')::numeric = 0
          and (item->>'needs_order')::boolean = false
     from _rows_a where vendor_id = current_setting('test.v2', true)
                    and item_id = current_setting('test.item_s', true)),
  '(41) AC-12: V1''s NO NEED is item-wide — S on not-submitted V2''s card is NO NEED (suggest 0)'
);
select is(
  (select distinct vsrc from _rows_a where vendor_id = current_setting('test.v2', true)),
  'stock',
  '(42) D7: a cross-vendor override on a vendor that has NOT submitted keeps on_hand_source = ''stock'''
);

-- ─── AC-9 (include_stocked absent) ─────────────────────────────
select ok(
  not exists (
    select 1 from _env_b, jsonb_array_elements(env->'vendors') v, jsonb_array_elements(v->'items') i
     where i->>'item_id' = current_setting('test.item_x', true)),
  '(43) AC-9: with include_stocked absent the NO NEED item is absent'
);
select ok(
  not exists (
    select 1 from _env_b, jsonb_array_elements(env->'vendors') v
     where v->>'vendor_id' in (current_setting('test.v1', true), current_setting('test.v2', true))),
  '(44) AC-9: a vendor whose only rows are NO NEED is hidden'
);
select is(
  (select row((env->'kpis'->>'item_count')::bigint,
              (env->'kpis'->>'total_estimated_cost')::numeric)::text from _env_b),
  (select row((env->'kpis'->>'item_count')::bigint,
              (env->'kpis'->>'total_estimated_cost')::numeric)::text from _env_base),
  '(45) AC-9: NO NEED rows contribute nothing to kpis.item_count / total_estimated_cost'
);

-- ─── AC-12 (V2 submitted without X) ────────────────────────────
-- V2 submits on D with ZERO entries → S and P on V2 were case B.
insert into public.eod_submissions (store_id, date, vendor_id, status, client_uuid)
values (current_setting('test.frederick_id', true)::uuid, '2001-03-15'::date,
        current_setting('test.v2', true)::uuid, 'submitted', gen_random_uuid());

set local role authenticated;
create temp table _env_c on commit drop as
select public.report_reorder_list(current_setting('test.frederick_id', true)::uuid,
                                  '{"as_of_date":"2001-03-15","include_stocked":true}'::jsonb) as env;
reset role;

create temp table _rows_c on commit drop as
select v->>'vendor_id' as vendor_id, v->>'on_hand_source' as vsrc, i->>'item_id' as item_id, i as item
  from _env_c, jsonb_array_elements(env->'vendors') v, jsonb_array_elements(v->'items') i;

select ok(
  (select item->'flags' ? 'no_need'
          and not (item->'flags' ? 'eod_missing_for_item')
          and (item->>'suggested_qty')::numeric = 0
     from _rows_c where vendor_id = current_setting('test.v2', true)
                    and item_id = current_setting('test.item_s', true)),
  '(46) AC-12: S on submitted-without-S V2 is NO NEED (suggest 0, no EOD MISS)'
);
select is(
  (select distinct vsrc from _rows_c where vendor_id = current_setting('test.v2', true)),
  'eod',
  '(47) AC-10/(iv): override rows on a vendor that DID submit are EOD-sourced (vendor rolls up ''eod'')'
);

-- ─── OQ-2 precedence (V2's own numeric entry for P) ────────────
insert into public.eod_entries (submission_id, item_id, actual_remaining)
select s.id, current_setting('test.item_p', true)::uuid, 3
  from public.eod_submissions s
 where s.store_id = current_setting('test.frederick_id', true)::uuid
   and s.date = '2001-03-15'::date
   and s.vendor_id = current_setting('test.v2', true)::uuid;

set local role authenticated;
create temp table _env_d on commit drop as
select public.report_reorder_list(current_setting('test.frederick_id', true)::uuid,
                                  '{"as_of_date":"2001-03-15","include_stocked":true}'::jsonb) as env;
reset role;

create temp table _rows_d on commit drop as
select v->>'vendor_id' as vendor_id, i->>'item_id' as item_id, i as item
  from _env_d, jsonb_array_elements(env->'vendors') v, jsonb_array_elements(v->'items') i;

select ok(
  (select (item->>'on_hand')::numeric = 3
          and (item->>'suggested_qty')::numeric = 7
          and (item->>'needs_order')::boolean
     from _rows_d where vendor_id = current_setting('test.v2', true)
                    and item_id = current_setting('test.item_p', true)),
  '(48) OQ-2/(v): a vendor row with its own numeric entry keeps case A (on_hand 3, suggest 7)'
);
select ok(
  (select not (item->'flags' ? 'no_need')
     from _rows_d where vendor_id = current_setting('test.v2', true)
                    and item_id = current_setting('test.item_p', true)),
  '(49) OQ-2/(v): the case-A row carries no ''no_need'' flag'
);
select ok(
  (select item->'flags' ? 'no_need' and (item->>'suggested_qty')::numeric = 0
     from _rows_d where vendor_id = current_setting('test.v1', true)
                    and item_id = current_setting('test.item_p', true)),
  '(50) OQ-2: V1''s own NO NEED row for P is still suggest 0'
);

-- ─── AC-11 (as_of_date + 1, no submission that day) ────────────
-- ─── AC-13 (a DRAFT carrying NO NEED on D + 2) ─────────────────
insert into public.eod_submissions (store_id, date, vendor_id, status, client_uuid)
values (current_setting('test.frederick_id', true)::uuid, '2001-03-17'::date,
        current_setting('test.v1', true)::uuid, 'draft', gen_random_uuid());
insert into public.eod_entries (submission_id, item_id, no_need)
select s.id, current_setting('test.item_x', true)::uuid, true
  from public.eod_submissions s
 where s.store_id = current_setting('test.frederick_id', true)::uuid
   and s.date = '2001-03-17'::date
   and s.vendor_id = current_setting('test.v1', true)::uuid;

set local role authenticated;
create temp table _env_e on commit drop as
select public.report_reorder_list(current_setting('test.frederick_id', true)::uuid,
                                  '{"as_of_date":"2001-03-16","include_stocked":true}'::jsonb) as env;
create temp table _env_f on commit drop as
select public.report_reorder_list(current_setting('test.frederick_id', true)::uuid,
                                  '{"as_of_date":"2001-03-17","include_stocked":true}'::jsonb) as env;
reset role;

select ok(
  (select (i->>'suggested_qty')::numeric = 8 and (i->>'needs_order')::boolean
     from _env_e, jsonb_array_elements(env->'vendors') v, jsonb_array_elements(v->'items') i
    where v->>'vendor_id' = current_setting('test.v1', true)
      and i->>'item_id' = current_setting('test.item_x', true)),
  '(51) AC-11: on as_of_date + 1 X gets normal case-C math (suggest 8, needs_order)'
);
select ok(
  (select not (i->'flags' ? 'no_need')
     from _env_e, jsonb_array_elements(env->'vendors') v, jsonb_array_elements(v->'items') i
    where v->>'vendor_id' = current_setting('test.v1', true)
      and i->>'item_id' = current_setting('test.item_x', true)),
  '(52) AC-11: NO NEED never carries over to the next cycle (no ''no_need'' flag)'
);
select ok(
  (select (i->>'suggested_qty')::numeric = 8 and not (i->'flags' ? 'no_need')
     from _env_f, jsonb_array_elements(env->'vendors') v, jsonb_array_elements(v->'items') i
    where v->>'vendor_id' = current_setting('test.v1', true)
      and i->>'item_id' = current_setting('test.item_x', true)),
  '(53) AC-13: a DRAFT carrying NO NEED does not affect reorder'
);

-- ═══ AC-15 — report_run_variance treats NO NEED as absent ═════════
-- V3 submissions on 2001-06-01 (from) and 2001-06-02 (to). N counted on
-- both; Y counted only on `from`. Run once without, then with, a NO NEED
-- entry for Y on `to`. Output must be identical.
create temp table _var_subs on commit drop as
with ins as (
  insert into public.eod_submissions (store_id, date, vendor_id, status, client_uuid)
  values
    (current_setting('test.frederick_id', true)::uuid, '2001-06-01'::date,
     current_setting('test.v3', true)::uuid, 'submitted', gen_random_uuid()),
    (current_setting('test.frederick_id', true)::uuid, '2001-06-02'::date,
     current_setting('test.v3', true)::uuid, 'submitted', gen_random_uuid())
  returning id, date
)
select id, date from ins;

insert into public.eod_entries (submission_id, item_id, actual_remaining)
values
  ((select id from _var_subs where date = '2001-06-01'), current_setting('test.item_n', true)::uuid, 10),
  ((select id from _var_subs where date = '2001-06-02'), current_setting('test.item_n', true)::uuid, 4),
  ((select id from _var_subs where date = '2001-06-01'), current_setting('test.item_y', true)::uuid, 10);

set local role authenticated;
create temp table _var_without on commit drop as
select public.report_run_variance(current_setting('test.frederick_id', true)::uuid,
                                  '{"from":"2001-06-01","to":"2001-06-02"}'::jsonb) as env;
reset role;

insert into public.eod_entries (submission_id, item_id, no_need)
values ((select id from _var_subs where date = '2001-06-02'), current_setting('test.item_y', true)::uuid, true);

set local role authenticated;
create temp table _var_with on commit drop as
select public.report_run_variance(current_setting('test.frederick_id', true)::uuid,
                                  '{"from":"2001-06-01","to":"2001-06-02"}'::jsonb) as env;
reset role;

select ok(
  (select count(*) from _var_with) = 1 and (select env from _var_with) is not null,
  '(54) AC-15: report_run_variance runs with a NO NEED entry in the window'
);
select is(
  (select env from _var_with),
  (select env from _var_without),
  '(55) AC-15: report_run_variance output is identical with and without the NO NEED entry'
);

select * from finish();
rollback;
