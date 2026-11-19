-- supabase/tests/report_reorder_list_primary_wins.test.sql
--
-- Spec 201 Part 1 — "primary vendor wins" on coincident order-out days.
-- pgTAP coverage for supabase/migrations/
-- 20261118120000_reorder_primary_wins_borrowed_count.sql hunks P1/P2/V
-- (AC-1 .. AC-12) plus the AC-20 posture pins.
--
-- Rule under test (design §3 P1/P2): for each item, its COINCIDENT set is
-- its linked vendors with an order_schedule row at the store whose
-- lower(btrim(day_of_week)) is the as-of weekday AND schedule_known = true.
-- When that set has >= 2 members and contains the item's primary
-- (inventory_items.vendor_id — design D1), the item's row is dropped from
-- every coincident vendor except the primary, and the primary row's new
-- yielded_from_vendors key names the vendors that gave it up.
--
-- Fixture (Frederick, created in-transaction; fresh vendor names satisfy
-- order_schedule's unique (store, day, vendor_name)):
--   A, B, C — fresh vendors. X — fresh vendor never linked (dangling probe).
--   F — par 10, current_stock 2, usage 0; linked A (primary, $2) + B ($3);
--       C ($5) is linked only for AC-7 / AC-8.
--   G — par 10, current_stock 2, usage 0; linked B only ($1).
--   D — synthetic as-of date 2001-03-05; every order_schedule day name is
--       derived with to_char(D, 'FMDay') so nothing depends on the weekday
--       CI runs on. WD = D's weekday, WD1 = the next weekday.
--   EOD on D (submitted): A {F=4}; B {F=4, G=1}; C {F=4} (C's only matters
--   once linked). So F suggests 6 on every card (A $12, B $18, C $30) and
--   G suggests 9 ($9).
--   D7 = D + 7 (same weekday): only B submitted {F=4, G=1} — the AC-10
--   (OQ-6) date.
--
-- Each scenario mutates the fixture as postgres, snapshots the envelope as
-- the master principal into _envs, then restores. Assertions read the
-- snapshots at the end. No `set role anon` (segfaults CI per spec 067).
-- Hermetic: begin; … rollback;.

begin;
create extension if not exists pgtap;

select plan(60);

-- ─── fixtures (as postgres) ─────────────────────────────────────
do $$
declare
  v_store uuid;
  v_brand uuid;
  v_a uuid; v_b uuid; v_c uuid; v_x uuid;
  v_tag text := substr(gen_random_uuid()::text, 1, 8);
  v_d   date := '2001-03-05'::date;
begin
  select id, brand_id into v_store, v_brand from public.stores where name = 'Frederick' limit 1;

  insert into public.vendors (name, brand_id) values ('SPEC201-PW-A-' || v_tag, v_brand) returning id into v_a;
  insert into public.vendors (name, brand_id) values ('SPEC201-PW-B-' || v_tag, v_brand) returning id into v_b;
  insert into public.vendors (name, brand_id) values ('SPEC201-PW-C-' || v_tag, v_brand) returning id into v_c;
  insert into public.vendors (name, brand_id) values ('SPEC201-PW-X-' || v_tag, v_brand) returning id into v_x;

  perform set_config('test.master_id', '33333333-3333-3333-3333-333333333333', true);
  perform set_config('test.store', v_store::text, true);
  perform set_config('test.brand', v_brand::text, true);
  perform set_config('test.tag',   v_tag, true);
  perform set_config('test.a', v_a::text, true);
  perform set_config('test.b', v_b::text, true);
  perform set_config('test.c', v_c::text, true);
  perform set_config('test.x', v_x::text, true);
  perform set_config('test.a_name', 'SPEC201-PW-A-' || v_tag, true);
  perform set_config('test.b_name', 'SPEC201-PW-B-' || v_tag, true);
  perform set_config('test.c_name', 'SPEC201-PW-C-' || v_tag, true);
  perform set_config('test.d',   v_d::text, true);
  perform set_config('test.d7',  (v_d + 7)::text, true);
  perform set_config('test.wd',  to_char(v_d, 'FMDay'), true);       -- e.g. 'Monday'
  perform set_config('test.wd1', to_char(v_d + 1, 'FMDay'), true);   -- e.g. 'Tuesday'
end $$;

create temp table _cat on commit drop as
with ins as (
  insert into public.catalog_ingredients (brand_id, name, unit)
  select current_setting('test.brand', true)::uuid,
         'SPEC201PW-' || k || '-' || current_setting('test.tag', true),
         'each'
    from unnest(array['F','G']) as k
  returning id, name
)
select id, name, split_part(name, '-', 2) as kind from ins;

create temp table _items on commit drop as
with ins as (
  insert into public.inventory_items
    (store_id, catalog_id, vendor_id, cost_per_unit, current_stock, par_level, usage_per_portion)
  select current_setting('test.store', true)::uuid,
         c.id,
         case when c.kind = 'F' then current_setting('test.a', true)::uuid
              else current_setting('test.b', true)::uuid end,
         1, 2, 10, 0
    from _cat c
  returning id, catalog_id
)
select i.id, c.kind from ins i join _cat c on c.id = i.catalog_id;

do $$
begin
  perform set_config('test.f', (select id::text from _items where kind = 'F'), true);
  perform set_config('test.g', (select id::text from _items where kind = 'G'), true);
end $$;

insert into public.item_vendors (item_id, vendor_id, cost_per_unit, case_price, is_primary)
values
  (current_setting('test.f', true)::uuid, current_setting('test.a', true)::uuid, 2, 0, true),
  (current_setting('test.f', true)::uuid, current_setting('test.b', true)::uuid, 3, 0, false),
  (current_setting('test.g', true)::uuid, current_setting('test.b', true)::uuid, 1, 0, true);

-- A and B order out on WD (capitalized, as the column holds today) and
-- deliver on WD (lower-case — the RPC's delivery_day parse) → schedule_known.
insert into public.order_schedule (store_id, day_of_week, vendor_id, vendor_name, delivery_day)
select current_setting('test.store', true)::uuid,
       current_setting('test.wd', true),
       v.id, v.name,
       lower(current_setting('test.wd', true))
  from public.vendors v
 where v.id in (current_setting('test.a', true)::uuid, current_setting('test.b', true)::uuid);

-- EOD submissions on D (A, B, C) and D7 (B only).
create temp table _subs on commit drop as
with ins as (
  insert into public.eod_submissions (store_id, date, vendor_id, status, submitted_at, client_uuid)
  values
    (current_setting('test.store', true)::uuid, current_setting('test.d', true)::date,
     current_setting('test.a', true)::uuid, 'submitted', '2001-03-05 20:00:00+00', gen_random_uuid()),
    (current_setting('test.store', true)::uuid, current_setting('test.d', true)::date,
     current_setting('test.b', true)::uuid, 'submitted', '2001-03-05 20:05:00+00', gen_random_uuid()),
    (current_setting('test.store', true)::uuid, current_setting('test.d', true)::date,
     current_setting('test.c', true)::uuid, 'submitted', '2001-03-05 20:10:00+00', gen_random_uuid()),
    (current_setting('test.store', true)::uuid, current_setting('test.d7', true)::date,
     current_setting('test.b', true)::uuid, 'submitted', '2001-03-12 20:05:00+00', gen_random_uuid())
  returning id, vendor_id, date
)
select * from ins;

insert into public.eod_entries (submission_id, item_id, actual_remaining)
select s.id, current_setting('test.f', true)::uuid, 4 from _subs s
union all
select s.id, current_setting('test.g', true)::uuid, 1 from _subs s
 where s.vendor_id = current_setting('test.b', true)::uuid;

-- ─── master JWT + snapshot table ────────────────────────────────
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
create temp table _envs (scn text primary key, env jsonb) on commit drop;

-- ═══ base: A + B coincident (AC-1 / AC-2 / AC-3) ═════════════════
insert into _envs select 'base', public.report_reorder_list(
  current_setting('test.store', true)::uuid,
  jsonb_build_object('as_of_date', current_setting('test.d', true)));
-- AC-5 (a): include_stocked = true.
insert into _envs select 'base_stocked', public.report_reorder_list(
  current_setting('test.store', true)::uuid,
  jsonb_build_object('as_of_date', current_setting('test.d', true), 'include_stocked', true));
reset role;

-- ═══ AC-5 (b): F at par (par 4 = A's count 4) ════════════════════
update public.inventory_items set par_level = 4 where id = current_setting('test.f', true)::uuid;
set local role authenticated;
insert into _envs select 'atpar_stocked', public.report_reorder_list(
  current_setting('test.store', true)::uuid,
  jsonb_build_object('as_of_date', current_setting('test.d', true), 'include_stocked', true));
insert into _envs select 'atpar', public.report_reorder_list(
  current_setting('test.store', true)::uuid,
  jsonb_build_object('as_of_date', current_setting('test.d', true)));
reset role;
update public.inventory_items set par_level = 10 where id = current_setting('test.f', true)::uuid;

-- ═══ AC-4: G gone → B left empty ═════════════════════════════════
-- G's only link is removed (equivalent for the RPC to deleting G: the item
-- produces no row), then restored.
delete from public.item_vendors where item_id = current_setting('test.g', true)::uuid;
set local role authenticated;
insert into _envs select 'no_g', public.report_reorder_list(
  current_setting('test.store', true)::uuid,
  jsonb_build_object('as_of_date', current_setting('test.d', true)));
reset role;
insert into public.item_vendors (item_id, vendor_id, cost_per_unit, case_price, is_primary)
values (current_setting('test.g', true)::uuid, current_setting('test.b', true)::uuid, 1, 0, true);

-- ═══ AC-6: B moved to WD1 → not coincident ═══════════════════════
update public.order_schedule set day_of_week = current_setting('test.wd1', true)
 where store_id = current_setting('test.store', true)::uuid
   and vendor_id = current_setting('test.b', true)::uuid;
set local role authenticated;
insert into _envs select 'noco', public.report_reorder_list(
  current_setting('test.store', true)::uuid,
  jsonb_build_object('as_of_date', current_setting('test.d', true)));
reset role;
update public.order_schedule set day_of_week = current_setting('test.wd', true)
 where store_id = current_setting('test.store', true)::uuid
   and vendor_id = current_setting('test.b', true)::uuid;

-- ═══ AC-7: three vendors ═════════════════════════════════════════
insert into public.item_vendors (item_id, vendor_id, cost_per_unit, case_price, is_primary)
values (current_setting('test.f', true)::uuid, current_setting('test.c', true)::uuid, 5, 0, false);
insert into public.order_schedule (store_id, day_of_week, vendor_id, vendor_name, delivery_day)
select current_setting('test.store', true)::uuid, current_setting('test.wd', true),
       v.id, v.name, lower(current_setting('test.wd', true))
  from public.vendors v where v.id = current_setting('test.c', true)::uuid;
set local role authenticated;
insert into _envs select 'three_all', public.report_reorder_list(
  current_setting('test.store', true)::uuid,
  jsonb_build_object('as_of_date', current_setting('test.d', true)));
reset role;

update public.order_schedule set day_of_week = current_setting('test.wd1', true)
 where store_id = current_setting('test.store', true)::uuid
   and vendor_id = current_setting('test.c', true)::uuid;
set local role authenticated;
insert into _envs select 'three_ab', public.report_reorder_list(
  current_setting('test.store', true)::uuid,
  jsonb_build_object('as_of_date', current_setting('test.d', true)));
reset role;

-- ═══ AC-8 (OQ-4): A not coincident, B + C coincident ═════════════
update public.order_schedule set day_of_week = current_setting('test.wd', true)
 where store_id = current_setting('test.store', true)::uuid
   and vendor_id = current_setting('test.c', true)::uuid;
update public.order_schedule set day_of_week = current_setting('test.wd1', true)
 where store_id = current_setting('test.store', true)::uuid
   and vendor_id = current_setting('test.a', true)::uuid;
set local role authenticated;
insert into _envs select 'oq4', public.report_reorder_list(
  current_setting('test.store', true)::uuid,
  jsonb_build_object('as_of_date', current_setting('test.d', true)));
reset role;
-- … and the same when F has no primary at all.
update public.item_vendors set is_primary = false where item_id = current_setting('test.f', true)::uuid;
update public.inventory_items set vendor_id = null where id = current_setting('test.f', true)::uuid;
set local role authenticated;
insert into _envs select 'oq4_noprim', public.report_reorder_list(
  current_setting('test.store', true)::uuid,
  jsonb_build_object('as_of_date', current_setting('test.d', true)));
reset role;

-- Restore: A primary again, A back on WD, C unlinked + unscheduled.
update public.inventory_items set vendor_id = current_setting('test.a', true)::uuid
 where id = current_setting('test.f', true)::uuid;
update public.item_vendors set is_primary = true
 where item_id = current_setting('test.f', true)::uuid
   and vendor_id = current_setting('test.a', true)::uuid;
update public.order_schedule set day_of_week = current_setting('test.wd', true)
 where store_id = current_setting('test.store', true)::uuid
   and vendor_id = current_setting('test.a', true)::uuid;
delete from public.order_schedule
 where store_id = current_setting('test.store', true)::uuid
   and vendor_id = current_setting('test.c', true)::uuid;
delete from public.item_vendors
 where item_id = current_setting('test.f', true)::uuid
   and vendor_id = current_setting('test.c', true)::uuid;

-- ═══ AC-9: B has no order_schedule row ═══════════════════════════
delete from public.order_schedule
 where store_id = current_setting('test.store', true)::uuid
   and vendor_id = current_setting('test.b', true)::uuid;
set local role authenticated;
insert into _envs select 'nosched', public.report_reorder_list(
  current_setting('test.store', true)::uuid,
  jsonb_build_object('as_of_date', current_setting('test.d', true)));
reset role;

-- ═══ C3: B orders out on WD but its delivery_day is unparseable ═══
-- (schedule_known = false → never coincident, matching the client's
-- no-schedule group). delivery_day is NOT NULL, so "null" is modelled as an
-- unparseable value.
insert into public.order_schedule (store_id, day_of_week, vendor_id, vendor_name, delivery_day)
select current_setting('test.store', true)::uuid, current_setting('test.wd', true),
       v.id, v.name, 'n/a'
  from public.vendors v where v.id = current_setting('test.b', true)::uuid;
set local role authenticated;
insert into _envs select 'c3', public.report_reorder_list(
  current_setting('test.store', true)::uuid,
  jsonb_build_object('as_of_date', current_setting('test.d', true)));
reset role;

-- ═══ AC-11: day-name case / whitespace ═══════════════════════════
update public.order_schedule
   set day_of_week  = lower(current_setting('test.wd', true)),
       delivery_day = lower(current_setting('test.wd', true))
 where store_id = current_setting('test.store', true)::uuid
   and vendor_id = current_setting('test.b', true)::uuid;
set local role authenticated;
insert into _envs select 'lower', public.report_reorder_list(
  current_setting('test.store', true)::uuid,
  jsonb_build_object('as_of_date', current_setting('test.d', true)));
reset role;
update public.order_schedule
   set day_of_week = '  ' || upper(current_setting('test.wd', true)) || ' '
 where store_id = current_setting('test.store', true)::uuid
   and vendor_id = current_setting('test.b', true)::uuid;
set local role authenticated;
insert into _envs select 'spaced', public.report_reorder_list(
  current_setting('test.store', true)::uuid,
  jsonb_build_object('as_of_date', current_setting('test.d', true)));
reset role;
update public.order_schedule set day_of_week = current_setting('test.wd', true)
 where store_id = current_setting('test.store', true)::uuid
   and vendor_id = current_setting('test.b', true)::uuid;

-- ═══ AC-12 (D1): vendor_id vs is_primary drift ═══════════════════
-- vendor_id = A (authoritative), is_primary on B.
update public.item_vendors set is_primary = false
 where item_id = current_setting('test.f', true)::uuid;
update public.item_vendors set is_primary = true
 where item_id = current_setting('test.f', true)::uuid
   and vendor_id = current_setting('test.b', true)::uuid;
set local role authenticated;
insert into _envs select 'drift', public.report_reorder_list(
  current_setting('test.store', true)::uuid,
  jsonb_build_object('as_of_date', current_setting('test.d', true)));
reset role;
-- Dangling vendor_id (X, never linked) → OQ-4 (both rows, key []).
update public.inventory_items set vendor_id = current_setting('test.x', true)::uuid
 where id = current_setting('test.f', true)::uuid;
set local role authenticated;
insert into _envs select 'dangling', public.report_reorder_list(
  current_setting('test.store', true)::uuid,
  jsonb_build_object('as_of_date', current_setting('test.d', true)));
reset role;
-- Null vendor_id → OQ-4.
update public.inventory_items set vendor_id = null
 where id = current_setting('test.f', true)::uuid;
set local role authenticated;
insert into _envs select 'nullprim', public.report_reorder_list(
  current_setting('test.store', true)::uuid,
  jsonb_build_object('as_of_date', current_setting('test.d', true)));
reset role;
update public.inventory_items set vendor_id = current_setting('test.a', true)::uuid
 where id = current_setting('test.f', true)::uuid;
update public.item_vendors set is_primary = false
 where item_id = current_setting('test.f', true)::uuid;
update public.item_vendors set is_primary = true
 where item_id = current_setting('test.f', true)::uuid
   and vendor_id = current_setting('test.a', true)::uuid;

-- ═══ AC-10 (OQ-6): D7 — A has no submitted EOD, B does ═══════════
set local role authenticated;
insert into _envs select 'oq6', public.report_reorder_list(
  current_setting('test.store', true)::uuid,
  jsonb_build_object('as_of_date', current_setting('test.d7', true)));
reset role;

-- ─── flatten ────────────────────────────────────────────────────
create temp view _v as
select e.scn, v->>'vendor_id' as vendor_id, v as vendor
  from _envs e, jsonb_array_elements(e.env->'vendors') v;
create temp view _r as
select e.scn, v->>'vendor_id' as vendor_id, i->>'item_id' as item_id, i as item
  from _envs e, jsonb_array_elements(e.env->'vendors') v, jsonb_array_elements(v->'items') i;

-- ═══ posture (AC-20) ═════════════════════════════════════════════
select is(
  (select count(*)::bigint from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'report_reorder_list'),
  1::bigint,
  '(1) AC-20: exactly one public.report_reorder_list (signature unchanged, no overload)'
);
select ok(
  not (select prosecdef from pg_proc where oid = 'public.report_reorder_list(uuid,jsonb)'::regprocedure),
  '(2) AC-20: report_reorder_list stays SECURITY INVOKER'
);
select is(
  (select proconfig from pg_proc where oid = 'public.report_reorder_list(uuid,jsonb)'::regprocedure),
  array['search_path=public']::text[],
  '(3) AC-20: proconfig is {search_path=public}'
);
select ok(
  not has_function_privilege('anon', 'public.report_reorder_list(uuid,jsonb)', 'EXECUTE'),
  '(4) AC-20: anon still lacks EXECUTE'
);
select ok(
  has_function_privilege('authenticated', 'public.report_reorder_list(uuid,jsonb)', 'EXECUTE'),
  '(5) AC-20: authenticated keeps EXECUTE'
);

-- ═══ AC-1 ═══════════════════════════════════════════════════════
select is(
  (select count(*)::bigint from _r where scn = 'base'
      and vendor_id = current_setting('test.a', true) and item_id = current_setting('test.f', true)),
  1::bigint,
  '(6) AC-1: coincident day — F is on the primary A''s card'
);
select is(
  (select count(*)::bigint from _r where scn = 'base'
      and vendor_id = current_setting('test.b', true) and item_id = current_setting('test.f', true)),
  0::bigint,
  '(7) AC-1: coincident day — F is absent from B''s card'
);
select is(
  (select jsonb_build_object('suggested_qty',   (item->>'suggested_qty')::numeric,
                             'suggested_units', (item->>'suggested_units')::numeric,
                             'suggested_cases', item->'suggested_cases',
                             'estimated_cost',  (item->>'estimated_cost')::numeric)
     from _r where scn = 'base'
      and vendor_id = current_setting('test.a', true) and item_id = current_setting('test.f', true)),
  jsonb_build_object('suggested_qty', 6, 'suggested_units', 6,
                     'suggested_cases', null, 'estimated_cost', 12),
  '(8) AC-1: F on A suggests 6 units / no cases / $12 (as before)'
);

-- ═══ AC-2 ═══════════════════════════════════════════════════════
select is(
  (select item->'yielded_from_vendors' from _r where scn = 'base'
      and vendor_id = current_setting('test.a', true) and item_id = current_setting('test.f', true)),
  jsonb_build_array(jsonb_build_object('vendor_id', current_setting('test.b', true),
                                       'vendor_name', current_setting('test.b_name', true))),
  '(9) AC-2: A''s F row yielded_from_vendors names exactly B'
);
select is(
  (select (item->>'other_vendor_count')::int from _r where scn = 'base'
      and vendor_id = current_setting('test.a', true) and item_id = current_setting('test.f', true)),
  1,
  '(10) AC-2: A''s F row other_vendor_count is 1 (as before)'
);
select is(
  (select item->'also_from_vendors' from _r where scn = 'base'
      and vendor_id = current_setting('test.a', true) and item_id = current_setting('test.f', true)),
  jsonb_build_array(jsonb_build_object('vendor_id', current_setting('test.b', true),
                                       'vendor_name', current_setting('test.b_name', true))),
  '(11) AC-2: A''s F row also_from_vendors still names B (as before)'
);
select is(
  (select item->'yielded_from_vendors' from _r where scn = 'base'
      and vendor_id = current_setting('test.b', true) and item_id = current_setting('test.g', true)),
  '[]'::jsonb,
  '(12) AC-2: G''s row yielded_from_vendors is []'
);

-- ═══ AC-3 ═══════════════════════════════════════════════════════
select is(
  (select (vendor->>'vendor_total_cost')::numeric from _v where scn = 'base'
      and vendor_id = current_setting('test.b', true)),
  (select sum((item->>'estimated_cost')::numeric) from _r where scn = 'base'
      and vendor_id = current_setting('test.b', true)),
  '(13) AC-3: B''s vendor_total_cost = sum of its remaining rows'' estimated_cost'
);
select is(
  (select (vendor->>'vendor_total_cost')::numeric from _v where scn = 'base'
      and vendor_id = current_setting('test.b', true)),
  9::numeric,
  '(14) AC-3: B''s vendor_total_cost is G''s $9 only (F''s $18 dropped)'
);
select is(
  (select (env->'kpis'->>'item_count')::bigint from _envs where scn = 'base'),
  (select count(*)::bigint from _r where scn = 'base'),
  '(15) AC-3: kpis.item_count = number of returned vendors[].items'
);
select is(
  (select (env->'kpis'->>'total_estimated_cost')::numeric from _envs where scn = 'base'),
  (select sum((item->>'estimated_cost')::numeric) from _r where scn = 'base'),
  '(16) AC-3: kpis.total_estimated_cost = sum over returned vendors[].items'
);

-- ═══ AC-4 ═══════════════════════════════════════════════════════
select is(
  (select count(*)::bigint from _v where scn = 'no_g' and vendor_id = current_setting('test.b', true)),
  0::bigint,
  '(17) AC-4: with G gone, B is absent from vendors'
);
select is(
  (select (env->'kpis'->>'vendor_count')::int from _envs where scn = 'no_g'),
  (select (env->'kpis'->>'vendor_count')::int - 1 from _envs where scn = 'base'),
  '(18) AC-4: kpis.vendor_count drops by 1'
);
select ok(
  not exists (
    select 1 from _envs e, jsonb_array_elements(e.env->'_warnings') w
     where e.scn = 'no_g' and w->>'message' like '%' || current_setting('test.b_name', true) || '%'),
  '(19) AC-4: _warnings has no entry for B'
);

-- ═══ AC-5 ═══════════════════════════════════════════════════════
select is(
  (select count(*)::bigint from _r where scn = 'base_stocked'
      and vendor_id = current_setting('test.b', true) and item_id = current_setting('test.f', true)),
  0::bigint,
  '(20) AC-5: include_stocked — B has no F row (below par)'
);
select is(
  (select (item->>'needs_order')::boolean from _r where scn = 'base_stocked'
      and vendor_id = current_setting('test.a', true) and item_id = current_setting('test.f', true)),
  true,
  '(21) AC-5: include_stocked — F stays on A with needs_order = true'
);
select is(
  (select count(*)::bigint from _r where scn = 'atpar_stocked'
      and vendor_id = current_setting('test.b', true) and item_id = current_setting('test.f', true)),
  0::bigint,
  '(22) AC-5: include_stocked, F at par — B has no F row'
);
select is(
  (select (item->>'needs_order')::boolean from _r where scn = 'atpar_stocked'
      and vendor_id = current_setting('test.a', true) and item_id = current_setting('test.f', true)),
  false,
  '(23) AC-5: include_stocked, F at par — F is on A with needs_order = false'
);
select is(
  (select count(*)::bigint from _r where scn = 'atpar' and item_id = current_setting('test.f', true)),
  0::bigint,
  '(24) AC-5: F at par without include_stocked — on no card (as before)'
);

-- ═══ AC-6 ═══════════════════════════════════════════════════════
select is(
  (select count(distinct vendor_id)::bigint from _r where scn = 'noco'
      and item_id = current_setting('test.f', true)
      and vendor_id in (current_setting('test.a', true), current_setting('test.b', true))),
  2::bigint,
  '(25) AC-6: not coincident — F appears under both A and B'
);
select is(
  (select item - 'yielded_from_vendors' from _r where scn = 'noco'
      and vendor_id = current_setting('test.a', true) and item_id = current_setting('test.f', true)),
  (select item - 'yielded_from_vendors' from _r where scn = 'base'
      and vendor_id = current_setting('test.a', true) and item_id = current_setting('test.f', true)),
  '(26) AC-6/AC-1: A''s F row is identical on coincident and non-coincident days (besides the new key)'
);
select is(
  (select jsonb_build_object('on_hand',          (item->>'on_hand')::numeric,
                             'suggested_qty',    (item->>'suggested_qty')::numeric,
                             'estimated_cost',   (item->>'estimated_cost')::numeric,
                             'flags',            item->'flags',
                             'other_vendor_count', (item->>'other_vendor_count')::int,
                             'also_from_vendors', item->'also_from_vendors')
     from _r where scn = 'noco'
      and vendor_id = current_setting('test.b', true) and item_id = current_setting('test.f', true)),
  jsonb_build_object('on_hand', 4, 'suggested_qty', 6, 'estimated_cost', 18,
                     'flags', '["no_usage_rate"]'::jsonb,
                     'other_vendor_count', 1,
                     'also_from_vendors', jsonb_build_array(jsonb_build_object(
                        'vendor_id', current_setting('test.a', true),
                        'vendor_name', current_setting('test.a_name', true)))),
  '(27) AC-6: B''s F row keeps every pre-existing value (on_hand 4, $18, hint names A)'
);
select is(
  (select array_agg(item->'yielded_from_vendors' order by vendor_id) from _r where scn = 'noco'
      and item_id = current_setting('test.f', true)),
  array['[]'::jsonb, '[]'::jsonb],
  '(28) AC-6: yielded_from_vendors is [] on both F rows'
);

-- ═══ AC-7 ═══════════════════════════════════════════════════════
select is(
  (select array_agg(vendor_id) from _r where scn = 'three_all'
      and item_id = current_setting('test.f', true)),
  array[current_setting('test.a', true)],
  '(29) AC-7: A, B, C all coincident — F is on A only'
);
select is(
  (select item->'yielded_from_vendors' from _r where scn = 'three_all'
      and vendor_id = current_setting('test.a', true) and item_id = current_setting('test.f', true)),
  jsonb_build_array(
    jsonb_build_object('vendor_id', current_setting('test.b', true), 'vendor_name', current_setting('test.b_name', true)),
    jsonb_build_object('vendor_id', current_setting('test.c', true), 'vendor_name', current_setting('test.c_name', true))),
  '(30) AC-7: A''s F row yields B then C (sorted by name)'
);
select is(
  (select count(*)::bigint from _r where scn = 'three_ab'
      and vendor_id = current_setting('test.a', true) and item_id = current_setting('test.f', true)),
  1::bigint,
  '(31) AC-7: A + B coincident, C not — F is on A'
);
select is(
  (select count(*)::bigint from _r where scn = 'three_ab'
      and vendor_id = current_setting('test.b', true) and item_id = current_setting('test.f', true)),
  0::bigint,
  '(32) AC-7: A + B coincident, C not — F is absent from B'
);
select is(
  (select jsonb_build_object('on_hand',        (item->>'on_hand')::numeric,
                             'suggested_qty',  (item->>'suggested_qty')::numeric,
                             'estimated_cost', (item->>'estimated_cost')::numeric,
                             'other_vendor_count', (item->>'other_vendor_count')::int,
                             'yielded',        item->'yielded_from_vendors')
     from _r where scn = 'three_ab'
      and vendor_id = current_setting('test.c', true) and item_id = current_setting('test.f', true)),
  jsonb_build_object('on_hand', 4, 'suggested_qty', 6, 'estimated_cost', 30,
                     'other_vendor_count', 2, 'yielded', '[]'::jsonb),
  '(33) AC-7: C''s F row is as before (on_hand 4, $30, key [])'
);
select is(
  (select item->'yielded_from_vendors' from _r where scn = 'three_ab'
      and vendor_id = current_setting('test.a', true) and item_id = current_setting('test.f', true)),
  jsonb_build_array(jsonb_build_object('vendor_id', current_setting('test.b', true),
                                       'vendor_name', current_setting('test.b_name', true))),
  '(34) AC-7: A''s F row yields only B (C is not coincident)'
);

-- ═══ AC-8 (OQ-4) ════════════════════════════════════════════════
select is(
  (select array_agg(vendor_id order by vendor_id) from _r where scn = 'oq4'
      and item_id = current_setting('test.f', true)
      and vendor_id in (current_setting('test.b', true), current_setting('test.c', true))),
  (select array_agg(x order by x) from unnest(array[current_setting('test.b', true),
                                                    current_setting('test.c', true)]) x),
  '(35) AC-8: primary A not coincident — F is on both coincident vendors B and C'
);
select ok(
  (select bool_and(item->'yielded_from_vendors' = '[]'::jsonb) from _r where scn = 'oq4'
      and item_id = current_setting('test.f', true)),
  '(36) AC-8: every F row has yielded_from_vendors []'
);
select is(
  (select count(distinct vendor_id)::bigint from _r where scn = 'oq4_noprim'
      and item_id = current_setting('test.f', true)),
  3::bigint,
  '(37) AC-8: F with no primary at all — on A, B and C'
);
select ok(
  (select bool_and(item->'yielded_from_vendors' = '[]'::jsonb) from _r where scn = 'oq4_noprim'
      and item_id = current_setting('test.f', true)),
  '(38) AC-8: no primary — every F row has yielded_from_vendors []'
);

-- ═══ AC-9 / C3 ══════════════════════════════════════════════════
select is(
  (select count(*)::bigint from _r where scn = 'nosched'
      and vendor_id = current_setting('test.b', true) and item_id = current_setting('test.f', true)),
  1::bigint,
  '(39) AC-9: B with no order_schedule row keeps its F row'
);
select is(
  (select jsonb_build_object('on_hand', (item->>'on_hand')::numeric,
                             'estimated_cost', (item->>'estimated_cost')::numeric,
                             'yielded', item->'yielded_from_vendors')
     from _r where scn = 'nosched'
      and vendor_id = current_setting('test.b', true) and item_id = current_setting('test.f', true)),
  jsonb_build_object('on_hand', 4, 'estimated_cost', 18, 'yielded', '[]'::jsonb),
  '(40) AC-9: B''s F row is as before (on_hand 4, $18, key [])'
);
select is(
  (select item->'yielded_from_vendors' from _r where scn = 'nosched'
      and vendor_id = current_setting('test.a', true) and item_id = current_setting('test.f', true)),
  '[]'::jsonb,
  '(41) AC-9: A''s F row has key [] (a no-schedule vendor is never coincident)'
);
select is(
  (select (vendor->>'schedule_known')::boolean from _v where scn = 'c3'
      and vendor_id = current_setting('test.b', true)),
  false,
  '(42) C3: B with an unparseable delivery_day is schedule_known = false'
);
select is(
  (select count(*)::bigint from _r where scn = 'c3'
      and vendor_id = current_setting('test.b', true) and item_id = current_setting('test.f', true)),
  1::bigint,
  '(43) C3: … so it is not coincident and keeps its F row'
);

-- ═══ AC-10 (OQ-6) ═══════════════════════════════════════════════
select is(
  (select count(*)::bigint from _r where scn = 'oq6'
      and vendor_id = current_setting('test.b', true) and item_id = current_setting('test.f', true)),
  0::bigint,
  '(44) AC-10: A has no EOD, B does — F is still absent from B'
);
select is(
  (select count(*)::bigint from _r where scn = 'oq6'
      and vendor_id = current_setting('test.a', true) and item_id = current_setting('test.f', true)),
  1::bigint,
  '(45) AC-10: … and present on A'
);
select ok(
  (select vendor->'eod_submitted_at' = 'null'::jsonb from _v where scn = 'oq6'
      and vendor_id = current_setting('test.a', true)),
  '(46) AC-10: A''s eod_submitted_at is null (count-not-submitted card)'
);
select is(
  (select (item->>'suggested_qty')::numeric from _r where scn = 'oq6'
      and vendor_id = current_setting('test.a', true) and item_id = current_setting('test.f', true)),
  6::numeric,
  '(47) AC-10/R12: A''s F row reads B''s count (4) → suggests 6'
);

-- ═══ AC-11 ══════════════════════════════════════════════════════
select is(
  (select count(*)::bigint from _r where scn = 'lower'
      and vendor_id = current_setting('test.b', true) and item_id = current_setting('test.f', true)),
  0::bigint,
  '(48) AC-11: lower-case day_of_week is coincident (F dropped from B)'
);
select is(
  (select item->'yielded_from_vendors' from _r where scn = 'lower'
      and vendor_id = current_setting('test.a', true) and item_id = current_setting('test.f', true)),
  jsonb_build_array(jsonb_build_object('vendor_id', current_setting('test.b', true),
                                       'vendor_name', current_setting('test.b_name', true))),
  '(49) AC-11: lower-case — A''s F row yields B'
);
select is(
  (select count(*)::bigint from _r where scn = 'spaced'
      and vendor_id = current_setting('test.b', true) and item_id = current_setting('test.f', true)),
  0::bigint,
  '(50) AC-11: upper-case day_of_week with surrounding whitespace is coincident too'
);

-- ═══ AC-12 (D1) ═════════════════════════════════════════════════
select is(
  (select count(*)::bigint from _r where scn = 'drift'
      and vendor_id = current_setting('test.a', true) and item_id = current_setting('test.f', true)),
  1::bigint,
  '(51) AC-12: vendor_id = A, is_primary on B — F stays on A (vendor_id wins)'
);
select is(
  (select count(*)::bigint from _r where scn = 'drift'
      and vendor_id = current_setting('test.b', true) and item_id = current_setting('test.f', true)),
  0::bigint,
  '(52) AC-12: … and is dropped from B'
);
select is(
  (select count(distinct vendor_id)::bigint from _r where scn = 'dangling'
      and item_id = current_setting('test.f', true)),
  2::bigint,
  '(53) AC-12: dangling vendor_id (not linked) — F on both A and B (OQ-4)'
);
select ok(
  (select bool_and(item->'yielded_from_vendors' = '[]'::jsonb) from _r where scn = 'dangling'
      and item_id = current_setting('test.f', true)),
  '(54) AC-12: dangling vendor_id — key [] on both rows'
);
select is(
  (select count(distinct vendor_id)::bigint from _r where scn = 'nullprim'
      and item_id = current_setting('test.f', true)),
  2::bigint,
  '(55) AC-12: null vendor_id — F on both A and B (OQ-4)'
);
select ok(
  (select bool_and(item->'yielded_from_vendors' = '[]'::jsonb) from _r where scn = 'nullprim'
      and item_id = current_setting('test.f', true)),
  '(56) AC-12: null vendor_id — key [] on both rows'
);

-- ═══ additive-key presence (design §4) ══════════════════════════
select ok(
  (select bool_and(item ? 'yielded_from_vendors' and item ? 'item_on_hand_source'
                   and item ? 'on_hand_borrowed_from')
     from _r where scn = 'base'),
  '(57) §4: every returned item carries the three additive keys'
);
select ok(
  (select bool_and(jsonb_typeof(item->'yielded_from_vendors') = 'array') from _r),
  '(58) §4: yielded_from_vendors is always an array'
);
select ok(
  (select bool_and(item->'yielded_from_vendors' = '[]'::jsonb) from _r
    where not (item_id = current_setting('test.f', true) and vendor_id = current_setting('test.a', true))),
  '(59) R5: no row other than the primary''s F row ever carries a non-empty key'
);
select is(
  (select env->'kpis' ?& array['vendor_count','item_count','total_estimated_cost',
                               'eod_sourced_vendor_count','stock_fallback_vendor_count']
     from _envs where scn = 'base'),
  true,
  '(60) envelope kpis keys are byte-stable'
);

select * from finish();
rollback;
