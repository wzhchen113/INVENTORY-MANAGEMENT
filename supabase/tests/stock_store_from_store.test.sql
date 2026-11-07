-- supabase/tests/stock_store_from_store.test.sql
--
-- Spec 184 — pgTAP coverage for public.stock_store_from_store(uuid, uuid, uuid[])
-- and public.stock_store_preview(uuid, uuid) in
-- supabase/migrations/20261105000000_stock_store_from_store.sql.
--
-- Plan: the design §8 table, T-1 to T-35, plus:
--   T-5b  executes the design's riskiest claim (F-3): a single-statement
--         writable-CTE copy really is refused under `authenticated`, while the
--         same two inserts as separate statements are accepted.
--   T-36  a seed-scale run: a real 2AM store as the source, the seed admin as
--         the caller, preview and write agreeing on about 140 real rows.
--
-- Fixtures are hermetic (begin; … rollback;). Fresh brands rather than the seed
-- 2AM brand, because several assertions are brand-wide counts (carried by no
-- store, carried elsewhere) that the seed's 143-row stores would make unstable.
-- T-36 is the one case that deliberately uses the seed.
--
-- Roles: every RPC call runs under `set local role authenticated` with a
-- request.jwt.claims blob, so RLS and the function gates are both really in
-- effect. Rows are asserted afterward as postgres, so RLS cannot make a
-- "nothing was written" assertion pass by hiding the row. Every refusal case has
-- an anti-vacuity probe of auth_can_see_store first. No `set role anon`
-- (segfaults CI per spec 067); anon is checked with has_function_privilege.

begin;
create extension if not exists pgtap;

select plan(196);

-- ─── helpers ────────────────────────────────────────────────────────────────
create function pg_temp.sid(n int) returns uuid language sql immutable as
  $$ select ('b1840001-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid $$;
create function pg_temp.cid(n int) returns uuid language sql immutable as
  $$ select ('b1840002-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid $$;
create function pg_temp.vid(n int) returns uuid language sql immutable as
  $$ select ('b1840003-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid $$;
create function pg_temp.uid(n int) returns uuid language sql immutable as
  $$ select ('b1840004-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid $$;
create function pg_temp.bid(n int) returns uuid language sql immutable as
  $$ select ('b1840005-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid $$;

create function pg_temp.login(p_uid uuid, p_app_role text) returns void
language plpgsql as $$
begin
  perform set_config('request.jwt.claims', jsonb_build_object(
    'sub', p_uid, 'role', 'authenticated',
    'app_metadata', jsonb_build_object('role', p_app_role))::text, true);
end $$;

create temp table r184 (tag text primary key, res jsonb);
grant all on r184 to authenticated;

-- Calls the RPC, records the result under a tag. Plain invoker: role and claims
-- are whatever the caller set.
create function pg_temp.run(p_tag text, p_t uuid, p_s uuid, p_x uuid[] default null)
returns jsonb language plpgsql as $$
declare r jsonb;
begin
  r := public.stock_store_from_store(p_t, p_s, p_x);
  insert into pg_temp.r184 values (p_tag, r);
  return r;
end $$;

create function pg_temp.preview(p_tag text, p_b uuid, p_t uuid default null)
returns jsonb language plpgsql as $$
declare r jsonb;
begin
  r := public.stock_store_preview(p_b, p_t);
  insert into pg_temp.r184 values (p_tag, r);
  return r;
end $$;

create function pg_temp.res(p_tag text) returns jsonb language sql stable as
  $$ select res from pg_temp.r184 where tag = p_tag $$;
create function pg_temp.n(p_tag text, p_key text) returns int language sql stable as
  $$ select (res ->> p_key)::int from pg_temp.r184 where tag = p_tag $$;
-- One `sources` element of a recorded preview, by store id.
create function pg_temp.src(p_tag text, p_store uuid) returns jsonb language sql stable as $$
  select e from pg_temp.r184 r, jsonb_array_elements(r.res -> 'sources') e
   where r.tag = p_tag and (e ->> 'store_id')::uuid = p_store
$$;
-- A target row, by store and catalog.
create function pg_temp.item(p_store uuid, p_cat uuid)
returns public.inventory_items language sql stable as $$
  select i from public.inventory_items i where i.store_id = p_store and i.catalog_id = p_cat
$$;
create function pg_temp.row_count(p_store uuid) returns int language sql stable as
  $$ select count(*)::int from public.inventory_items where store_id = p_store $$;
create function pg_temp.link_count(p_store uuid) returns int language sql stable as $$
  select count(*)::int from public.item_vendors iv
    join public.inventory_items i on i.id = iv.item_id where i.store_id = p_store
$$;
-- Row-level fingerprint of a store's items and links, for "unchanged" assertions.
create function pg_temp.fingerprint(p_store uuid) returns text language sql stable as $$
  select md5(
    coalesce((select string_agg(row_to_json(i)::text, '|' order by i.id)
                from public.inventory_items i where i.store_id = p_store), '')
    || '##' ||
    coalesce((select string_agg(row_to_json(iv)::text, '|' order by iv.id)
                from public.item_vendors iv
                join public.inventory_items i on i.id = iv.item_id
               where i.store_id = p_store), '')
  )
$$;

-- ─── fixtures (as postgres) ─────────────────────────────────────────────────
insert into public.brands (id, name) values
  (pg_temp.bid(1), '__s184_brand_a__'),
  (pg_temp.bid(2), '__s184_brand_b__'),
  (pg_temp.bid(3), '__s184_brand_c__');

insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password,
  email_confirmed_at, created_at, updated_at,
  raw_app_meta_data, raw_user_meta_data, is_super_admin, is_anonymous,
  confirmation_token, recovery_token, email_change_token_new, email_change,
  email_change_token_current, phone_change, phone_change_token, reauthentication_token
)
select pg_temp.uid(v.n), '00000000-0000-0000-0000-000000000000',
       'authenticated', 'authenticated', 's184-' || v.n || '@local.test', '',
       now(), now(), now(),
       jsonb_build_object('provider', 'email', 'role', v.r), '{}'::jsonb, false, false,
       '', '', '', '', '', '', '', ''
  from (values (1, 'admin'), (2, 'admin'), (3, 'user'), (4, 'super_admin'), (5, 'user')) as v(n, r);

insert into public.profiles (id, name, role, initials, color, status, brand_id) values
  (pg_temp.uid(1), 's184 brand admin',       'admin',       'BA', '#888888', 'active', pg_temp.bid(1)),
  (pg_temp.uid(2), 's184 other-brand admin', 'admin',       'OA', '#888888', 'active', pg_temp.bid(2)),
  (pg_temp.uid(3), 's184 user both stores',  'user',        'US', '#888888', 'active', pg_temp.bid(1)),
  (pg_temp.uid(4), 's184 super admin',       'super_admin', 'SA', '#888888', 'active', null),
  (pg_temp.uid(5), 's184 stale jwt',         'user',        'SJ', '#888888', 'active', null)
on conflict (id) do update
  set role = excluded.role, brand_id = excluded.brand_id, name = excluded.name;

insert into public.stores (id, brand_id, name, address, status)
select pg_temp.sid(v.n), pg_temp.bid(v.b), v.name, '1 Spec Way', v.st
  from (values
    ( 1, 1, 's184 main source',        'active'),
    ( 2, 1, 's184 main target',        'active'),
    ( 3, 1, 's184 partly stocked',     'active'),
    ( 4, 1, 's184 empty source',       'active'),
    ( 5, 1, 's184 t15 target',         'active'),
    ( 6, 1, 's184 t14 target',         'active'),
    ( 7, 1, 's184 t16 target',         'active'),
    ( 8, 1, 's184 t30 super target',   'active'),
    (10, 1, 's184 t12 source a',       'active'),
    (11, 1, 's184 t12 source b',       'active'),
    (12, 1, 's184 t12 target',         'active'),
    (13, 1, 's184 t17 target',         'active'),
    (14, 1, 's184 tick source',        'active'),
    (15, 1, 's184 inactive carrier',   'inactive'),
    (16, 1, 's184 active carrier',     'active'),
    (17, 1, 's184 t18 target',         'active'),
    (18, 1, 's184 t20 null ticks',     'active'),
    (19, 1, 's184 t20 empty ticks',    'active'),
    (20, 1, 's184 t20 dup ticks',      'active'),
    (22, 1, 's184 refusal target',     'active'),
    (23, 1, 's184 f3 target',          'active'),
    (30, 2, 's184 brand b store',      'active'),
    (31, 2, 's184 brand b store 2',    'active'),
    (40, 3, 'C-X',                     'active'),
    (41, 3, 'C-Y',                     'active'),
    (42, 3, 'C-target',                'active'),
    (43, 3, 'C-empty',                 'active'),
    (44, 3, 'C-Inactive',              'inactive')
  ) as v(n, b, name, st);

insert into public.vendors (id, brand_id, name) values
  (pg_temp.vid(1),  pg_temp.bid(1), '__s184_v1__'),
  (pg_temp.vid(2),  pg_temp.bid(1), '__s184_v2__'),
  (pg_temp.vid(3),  pg_temp.bid(1), '__s184_v3__'),
  (pg_temp.vid(50), pg_temp.bid(2), '__s184_vb__'),
  (pg_temp.vid(60), pg_temp.bid(3), '__s184_vc__');

insert into public.catalog_ingredients (id, brand_id, name, unit, category, default_cost, default_case_price, i18n_names)
select pg_temp.cid(v.n), pg_temp.bid(v.b), '__s184_c' || v.n || '__', 'each', 'test',
       case when v.n = 31 then 77.5 else 0 end,
       case when v.n = 31 then 88.5 else 0 end,
       case when v.n = 64 then '{"es":"Ese"}'::jsonb else '{}'::jsonb end
  from (values
    (1,1),(2,1),(3,1),(4,1),(5,1),(6,1),(7,1),(8,1),
    (21,1),(22,1),(23,1),(24,1),
    (31,1),(32,1),(33,1),(34,1),(35,1),(36,1),
    (50,2),(51,2),
    (60,3),(61,3),(62,3),(63,3),(64,3),(65,3)
  ) as v(n, b);

-- Main source: eight eligible rows covering each link shape, plus one row whose
-- catalog row belongs to another brand (not eligible, T-13).
insert into public.inventory_items
  (store_id, catalog_id, vendor_id, cost_per_unit, case_price, par_level, safety_stock,
   usage_per_portion, current_stock, eod_remaining, average_daily_usage,
   expiry_date, last_updated_by, vendor_changed_at)
values
  -- c1: two links, V1 primary and equal to the scalar. Non-zero everything.
  (pg_temp.sid(1), pg_temp.cid(1), pg_temp.vid(1), 1.234567, 12.50, 10, 2, 0.5, 7, 6, 3.5,
   '2030-01-01', pg_temp.uid(1), '2026-01-01T00:00:00Z'),
  -- c2: one link.
  (pg_temp.sid(1), pg_temp.cid(2), pg_temp.vid(2), 2, 20, 20, 0, 0, 3, 3, 1, null, null, null),
  -- c3: no links, null scalar (AC-5).
  (pg_temp.sid(1), pg_temp.cid(3), null, 3, 30, 30, 0, 0, 3, 3, 1, null, null, null),
  -- c4: scalar with no link (F-6): null at the target.
  (pg_temp.sid(1), pg_temp.cid(4), pg_temp.vid(1), 4, 40, 40, 0, 0, 3, 3, 1, null, null, null),
  -- c5: drift. Scalar V1, primary flagged on V2 (D-4: the scalar wins).
  (pg_temp.sid(1), pg_temp.cid(5), pg_temp.vid(1), 5, 50, 50, 0, 0, 3, 3, 1, null, null, null),
  -- c6: links, no primary, null scalar: no primary is invented.
  (pg_temp.sid(1), pg_temp.cid(6), null, 6, 60, 60, 0, 0, 3, 3, 1, null, null, null),
  -- c7: the only link is cross-brand.
  (pg_temp.sid(1), pg_temp.cid(7), pg_temp.vid(50), 7, 70, 70, 0, 0, 3, 3, 1, null, null, null),
  -- c8: one same-brand link, one cross-brand link.
  (pg_temp.sid(1), pg_temp.cid(8), pg_temp.vid(1), 8, 80, 80, 0, 0, 3, 3, 1, null, null, null),
  -- Foreign catalog row.
  (pg_temp.sid(1), pg_temp.cid(50), null, 9, 90, 90, 0, 0, 3, 3, 1, null, null, null);

insert into public.item_vendors
  (item_id, vendor_id, cost_per_unit, case_price, is_primary, order_code, product_page_url)
select (pg_temp.item(pg_temp.sid(1), pg_temp.cid(v.c))).id, pg_temp.vid(v.v), v.cost, v.cp, v.pri, v.code, v.url
  from (values
    (1, 1, 1.234567, 12.50, true,  'A1',      'https://example.test/a'),
    (1, 2, 2.500000, 30.00, false, 'B2',      null),
    (2, 2, 2.000000, 20.00, true,  null,      null),
    (5, 1, 5.000000, 50.00, false, null,      null),
    (5, 2, 5.500000, 55.00, true,  null,      null),
    (6, 1, 6.000000, 60.00, false, null,      null),
    (6, 2, 6.500000, 65.00, false, null,      null),
    (7, 50, 7.000000, 70.00, true, null,      null),
    (8, 1, 8.000000, 80.00, true,  'MARK184', null),
    (8, 50, 8.500000, 85.00, false, null,     null)
  ) as v(c, v, cost, cp, pri, code, url);

-- T-9: a partly stocked target with a differing link set on c1.
insert into public.inventory_items (store_id, catalog_id, vendor_id, cost_per_unit, case_price, par_level, current_stock)
values (pg_temp.sid(3), pg_temp.cid(1), pg_temp.vid(3), 9.9, 9, 99, 5);
insert into public.item_vendors (item_id, vendor_id, cost_per_unit, case_price, is_primary)
values ((pg_temp.item(pg_temp.sid(3), pg_temp.cid(1))).id, pg_temp.vid(3), 9.9, 9, true);

-- T-12: A carries {21, 22}, B carries {22, 23}, with different pars.
insert into public.inventory_items (store_id, catalog_id, par_level) values
  (pg_temp.sid(10), pg_temp.cid(21), 1),
  (pg_temp.sid(10), pg_temp.cid(22), 2),
  (pg_temp.sid(11), pg_temp.cid(22), 200),
  (pg_temp.sid(11), pg_temp.cid(23), 3);

-- T-17/18/20: the tick source, and carriers for the ticks that are not uncarried.
insert into public.inventory_items (store_id, catalog_id, vendor_id) values
  (pg_temp.sid(14), pg_temp.cid(24), pg_temp.vid(1)),
  (pg_temp.sid(15), pg_temp.cid(32), null),
  (pg_temp.sid(16), pg_temp.cid(33), null),
  (pg_temp.sid(17), pg_temp.cid(34), null);
insert into public.item_vendors (item_id, vendor_id, is_primary)
values ((pg_temp.item(pg_temp.sid(14), pg_temp.cid(24))).id, pg_temp.vid(1), true);

-- Brand B stock.
insert into public.inventory_items (store_id, catalog_id) values (pg_temp.sid(30), pg_temp.cid(51));

-- T-34: X {60, 61, 62}, Y {61, 63}, target {60}, inactive {65}; 64 is uncarried.
insert into public.inventory_items (store_id, catalog_id, vendor_id) values
  (pg_temp.sid(40), pg_temp.cid(60), pg_temp.vid(60)),
  (pg_temp.sid(40), pg_temp.cid(61), pg_temp.vid(60)),
  (pg_temp.sid(40), pg_temp.cid(62), null),
  (pg_temp.sid(41), pg_temp.cid(61), pg_temp.vid(60)),
  (pg_temp.sid(41), pg_temp.cid(63), null),
  (pg_temp.sid(42), pg_temp.cid(60), null),
  (pg_temp.sid(44), pg_temp.cid(65), null);
insert into public.item_vendors (item_id, vendor_id, is_primary) values
  ((pg_temp.item(pg_temp.sid(40), pg_temp.cid(60))).id, pg_temp.vid(60), true),
  ((pg_temp.item(pg_temp.sid(40), pg_temp.cid(61))).id, pg_temp.vid(60), true),
  ((pg_temp.item(pg_temp.sid(41), pg_temp.cid(61))).id, pg_temp.vid(60), true);

-- user_stores for the non-privileged caller and the stale-JWT caller.
insert into public.user_stores (user_id, store_id)
select u, s from unnest(array[pg_temp.uid(3), pg_temp.uid(5)]) as u,
                 unnest(array[pg_temp.sid(1), pg_temp.sid(22)]) as s;
insert into public.user_stores (user_id, store_id) values (pg_temp.uid(3), pg_temp.sid(2));

-- T-20: a store WITH a schedule, for the true arm of target_has_order_schedule.
insert into public.order_schedule (store_id, day_of_week, vendor_id, vendor_name, delivery_day)
values (pg_temp.sid(19), 'Monday', pg_temp.vid(1), '__s184_v1__', 'Tuesday');

create temp table snap184 (k text primary key, v text);
grant all on snap184 to authenticated;
insert into snap184 values
  ('source', pg_temp.fingerprint(pg_temp.sid(1))),
  ('partly_c1', (select row_to_json(i)::text from public.inventory_items i
                  where i.store_id = pg_temp.sid(3) and i.catalog_id = pg_temp.cid(1))),
  ('partly_links', (select count(*)::text from public.item_vendors iv
                     where iv.item_id = (pg_temp.item(pg_temp.sid(3), pg_temp.cid(1))).id)),
  ('schedule_count', (select count(*)::text from public.order_schedule));


-- ═══════════════════════════════════════════════════════════════════════════
-- T-1 column pins: a future column forces a copy-or-reset decision.
-- ═══════════════════════════════════════════════════════════════════════════
select columns_are('public', 'inventory_items', array[
  'id', 'store_id', 'cost_per_unit', 'current_stock', 'par_level', 'vendor_id',
  'usage_per_portion', 'expiry_date', 'last_updated_by', 'eod_remaining',
  'created_at', 'updated_at', 'average_daily_usage', 'case_price', 'safety_stock',
  'catalog_id', 'vendor_changed_at'
], 'T-1a inventory_items has exactly the 17 columns the copy dispositions');

select columns_are('public', 'item_vendors', array[
  'id', 'item_id', 'vendor_id', 'cost_per_unit', 'case_price', 'is_primary',
  'created_at', 'updated_at', 'order_code', 'product_page_url'
], 'T-1b item_vendors has exactly the 10 columns the copy dispositions');


-- ═══════════════════════════════════════════════════════════════════════════
-- T-5b F-3: is a separate statement really required? Executed, not assumed.
-- ═══════════════════════════════════════════════════════════════════════════
set local role authenticated;
select pg_temp.login(pg_temp.uid(1), 'admin');

select is(current_user::text, 'authenticated',
  'T-5b anti-vacuity: the F-3 cases really run as authenticated');

select ok(public.auth_can_see_store(pg_temp.sid(23)),
  'T-5b anti-vacuity: the caller can see the store, so only the parent-row check can refuse');

select throws_ok(
  format($q$
    with ni as (
      insert into public.inventory_items (store_id, catalog_id)
      values (%L::uuid, %L::uuid) returning id
    )
    insert into public.item_vendors (item_id, vendor_id)
    select id, %L::uuid from ni
  $q$, pg_temp.sid(23), pg_temp.cid(1), pg_temp.vid(1)),
  '42501',
  'new row violates row-level security policy for table "item_vendors"',
  'T-5b F-3: a single-statement item + link insert is refused under authenticated'
);

select lives_ok(
  format($q$insert into public.inventory_items (store_id, catalog_id) values (%L::uuid, %L::uuid)$q$,
         pg_temp.sid(23), pg_temp.cid(1)),
  'T-5b F-3 control: the item as its own statement is accepted'
);

select lives_ok(
  format($q$insert into public.item_vendors (item_id, vendor_id)
            select id, %L::uuid from public.inventory_items
             where store_id = %L::uuid and catalog_id = %L::uuid$q$,
         pg_temp.vid(1), pg_temp.sid(23), pg_temp.cid(1)),
  'T-5b F-3 control: the link as a second statement is accepted'
);


-- ═══════════════════════════════════════════════════════════════════════════
-- T-2 to T-8: an empty target, stocked by a brand admin under `authenticated`.
-- ═══════════════════════════════════════════════════════════════════════════
select lives_ok(
  format($q$select pg_temp.run('t2', %L::uuid, %L::uuid)$q$, pg_temp.sid(2), pg_temp.sid(1)),
  'T-2 AC-1 brand admin stocks an empty target under authenticated'
);
reset role;

-- T-2
select is(pg_temp.row_count(pg_temp.sid(2)), 8, 'T-2 AC-1 eight eligible rows landed');
select is(
  pg_temp.res('t2'),
  jsonb_build_object(
    'items_copied', 8, 'items_skipped', 0, 'links_added', 8,
    'links_skipped_cross_brand', 2, 'extras_added', 0, 'extras_skipped', 0,
    'items_no_vendor_link', 3, 'target_has_order_schedule', false,
    'uncarried_remaining', 3),
  'T-2 AC-1 exact result keys and values'
);

-- T-3: every R-2 field on the copied c1, from a source with non-zero everything.
select is((pg_temp.item(pg_temp.sid(2), pg_temp.cid(1))).store_id, pg_temp.sid(2), 'T-3 store_id is the target');
select is((pg_temp.item(pg_temp.sid(2), pg_temp.cid(1))).catalog_id, pg_temp.cid(1), 'T-3 catalog_id from source');
select is((pg_temp.item(pg_temp.sid(2), pg_temp.cid(1))).par_level, 10::numeric, 'T-3 par_level copied');
select is((pg_temp.item(pg_temp.sid(2), pg_temp.cid(1))).safety_stock, 2::numeric, 'T-3 safety_stock copied');
select is((pg_temp.item(pg_temp.sid(2), pg_temp.cid(1))).usage_per_portion, 0.5::numeric, 'T-3 usage_per_portion copied');
select is((pg_temp.item(pg_temp.sid(2), pg_temp.cid(1))).cost_per_unit, 1.234567::numeric, 'T-3 cost_per_unit verbatim, six decimals');
select is((pg_temp.item(pg_temp.sid(2), pg_temp.cid(1))).case_price, 12.50::numeric, 'T-3 case_price verbatim');
select is((pg_temp.item(pg_temp.sid(2), pg_temp.cid(1))).vendor_id, pg_temp.vid(1), 'T-3 vendor_id is the primary link');
select is((pg_temp.item(pg_temp.sid(2), pg_temp.cid(1))).current_stock, 0::numeric, 'T-3 current_stock reset (source 7)');
select is((pg_temp.item(pg_temp.sid(2), pg_temp.cid(1))).eod_remaining, 0::numeric, 'T-3 eod_remaining reset (source 6)');
select is((pg_temp.item(pg_temp.sid(2), pg_temp.cid(1))).average_daily_usage, 0::numeric, 'T-3 average_daily_usage reset (source 3.5)');
select is((pg_temp.item(pg_temp.sid(2), pg_temp.cid(1))).expiry_date, null::date, 'T-3 expiry_date null (source set)');
select is((pg_temp.item(pg_temp.sid(2), pg_temp.cid(1))).last_updated_by, null::uuid, 'T-3 last_updated_by null (source set)');
select is((pg_temp.item(pg_temp.sid(2), pg_temp.cid(1))).vendor_changed_at, null::timestamptz, 'T-3 vendor_changed_at null (source set)');

-- T-4
select is(
  (select count(*)::int from public.inventory_items t
    join public.inventory_items s on s.id = t.id
   where t.store_id = pg_temp.sid(2) and s.store_id = pg_temp.sid(1)),
  0, 'T-4 AC-3 no target row reuses a source id');
select isnt(
  (pg_temp.item(pg_temp.sid(2), pg_temp.cid(1))).id,
  (pg_temp.item(pg_temp.sid(1), pg_temp.cid(1))).id,
  'T-4 AC-3 c1 has a fresh id');

-- T-5: the two-link item. The call above ran under `authenticated` (T-2).
select is(
  (select count(*)::int from public.item_vendors
    where item_id = (pg_temp.item(pg_temp.sid(2), pg_temp.cid(1))).id),
  2, 'T-5 AC-4 the two-link item has two links at the target');
select is(
  (select row(iv.cost_per_unit, iv.case_price, iv.order_code, iv.product_page_url, iv.is_primary)::text
     from public.item_vendors iv
    where iv.item_id = (pg_temp.item(pg_temp.sid(2), pg_temp.cid(1))).id and iv.vendor_id = pg_temp.vid(1)),
  '(1.234567,12.50,A1,https://example.test/a,t)',
  'T-5 AC-4 V1 link: cost, case price, order code, url, primary');
select is(
  (select row(iv.cost_per_unit, iv.case_price, iv.order_code, iv.product_page_url, iv.is_primary)::text
     from public.item_vendors iv
    where iv.item_id = (pg_temp.item(pg_temp.sid(2), pg_temp.cid(1))).id and iv.vendor_id = pg_temp.vid(2)),
  '(2.500000,30.00,B2,,f)',
  'T-5 AC-4 V2 link: cost, case price, order code, null url, not primary');
select is(
  (select array_agg(iv.vendor_id) from public.item_vendors iv
    where iv.item_id = (pg_temp.item(pg_temp.sid(2), pg_temp.cid(1))).id and iv.is_primary),
  array[(pg_temp.item(pg_temp.sid(2), pg_temp.cid(1))).vendor_id],
  'T-5 AC-4 exactly one primary, equal to the row''s vendor_id');
select is(
  (select count(*)::int from public.item_vendors t
    join public.inventory_items ti on ti.id = t.item_id
    join public.item_vendors s on s.id = t.id
    join public.inventory_items si on si.id = s.item_id
   where ti.store_id = pg_temp.sid(2) and si.store_id = pg_temp.sid(1)),
  0, 'T-5 no target link reuses a source link''s id');

-- T-6
select is(
  (select count(*)::int from public.item_vendors
    where item_id = (pg_temp.item(pg_temp.sid(2), pg_temp.cid(3))).id),
  0, 'T-6 AC-5 a no-link item is copied with no links');
select is((pg_temp.item(pg_temp.sid(2), pg_temp.cid(3))).vendor_id, null::uuid, 'T-6 AC-5 and a null vendor_id');
select is((pg_temp.item(pg_temp.sid(2), pg_temp.cid(4))).vendor_id, null::uuid, 'T-6 F-6 a scalar with no link becomes null at the target');
select is(
  (select count(*)::int from public.item_vendors
    where item_id = (pg_temp.item(pg_temp.sid(2), pg_temp.cid(4))).id),
  0, 'T-6 F-6 and no link is invented');

-- T-7: the staff EOD read shape, as a `user` with user_stores on the target.
set local role authenticated;
select pg_temp.login(pg_temp.uid(3), 'user');
select is(
  (select array_agg(distinct ii.catalog_id order by ii.catalog_id)
     from public.item_vendors iv
     join public.inventory_items ii on ii.id = iv.item_id
    where ii.store_id = pg_temp.sid(2) and iv.vendor_id = pg_temp.vid(2)),
  array[pg_temp.cid(1), pg_temp.cid(2), pg_temp.cid(5), pg_temp.cid(6)],
  'T-7 AC-6 staff read shape returns the copied items for a source vendor');
select is(
  (select count(*)::int
     from public.item_vendors iv
     join public.inventory_items ii on ii.id = iv.item_id
    where ii.store_id = pg_temp.sid(2) and ii.catalog_id = pg_temp.cid(3)),
  0, 'T-7 AC-5 the no-link item is absent from the staff read shape');
reset role;

-- T-8
select is(pg_temp.fingerprint(pg_temp.sid(1)),
  (select v from snap184 where k = 'source'),
  'T-8 AC-7 source items and links are unchanged');

-- T-11: D-4 drift.
select is((pg_temp.item(pg_temp.sid(2), pg_temp.cid(5))).vendor_id, pg_temp.vid(1),
  'T-11 F-6 scalar V1 with primary flagged on V2 gives vendor_id V1');
select is(
  (select array_agg(iv.vendor_id) from public.item_vendors iv
    where iv.item_id = (pg_temp.item(pg_temp.sid(2), pg_temp.cid(5))).id and iv.is_primary),
  array[pg_temp.vid(1)],
  'T-11 F-6 and V1 is the only primary link');
select is((pg_temp.item(pg_temp.sid(2), pg_temp.cid(6))).vendor_id, null::uuid,
  'T-11 links with no primary and a null scalar keep a null vendor_id');
select is(
  (select count(*)::int from public.item_vendors iv
    where iv.item_id = (pg_temp.item(pg_temp.sid(2), pg_temp.cid(6))).id and iv.is_primary),
  0, 'T-11 and no primary is invented');
select is(
  (select count(*)::int from public.item_vendors iv
    where iv.item_id = (pg_temp.item(pg_temp.sid(2), pg_temp.cid(6))).id),
  2, 'T-11 but both links are copied');

-- T-30: AC-18 skip and report.
select is((pg_temp.item(pg_temp.sid(2), pg_temp.cid(7))).vendor_id, null::uuid,
  'T-30 AC-18 a cross-brand-only item has a null vendor_id at the target');
select is(
  (select count(*)::int from public.item_vendors iv
    where iv.item_id = (pg_temp.item(pg_temp.sid(2), pg_temp.cid(7))).id),
  0, 'T-30 AC-18 and its cross-brand link is not copied');
select is(
  (select array_agg(iv.vendor_id) from public.item_vendors iv
    where iv.item_id = (pg_temp.item(pg_temp.sid(2), pg_temp.cid(8))).id),
  array[pg_temp.vid(1)],
  'T-30 AC-18 a mixed item keeps only its same-brand link');
select is(
  (select count(*)::int from public.item_vendors iv
     join public.inventory_items i on i.id = iv.item_id
     join public.vendors v on v.id = iv.vendor_id
    where i.store_id = pg_temp.sid(2) and v.brand_id <> pg_temp.bid(1)),
  0, 'T-30 AC-18 the target has no cross-brand link at all');

-- T-30b: the same source as a SUPER-ADMIN. RLS hides a foreign vendor from a
-- brand admin, so T-30 above can't tell the explicit brand predicate from RLS. A
-- super-admin sees every vendor, so only the predicate can exclude it here.
set local role authenticated;
select pg_temp.login(pg_temp.uid(4), 'super_admin');
select ok(
  exists (select 1 from public.vendors where id = pg_temp.vid(50)),
  'T-30b anti-vacuity: the super-admin can see the cross-brand vendor');
select lives_ok(
  format($q$select pg_temp.run('t30s', %L::uuid, %L::uuid)$q$, pg_temp.sid(8), pg_temp.sid(1)),
  'T-30b a super-admin stocks from the same source');
select lives_ok(
  format($q$select pg_temp.preview('p30s', %L::uuid, %L::uuid)$q$, pg_temp.bid(1), pg_temp.sid(22)),
  'T-30b a super-admin previews the same source');
reset role;

select is(pg_temp.res('t30s') - 'uncarried_remaining', pg_temp.res('t2') - 'uncarried_remaining',
  'T-30b super-admin and brand admin get the same result from the same source');
select is(
  (select count(*)::int from public.item_vendors iv
     join public.inventory_items i on i.id = iv.item_id
     join public.vendors v on v.id = iv.vendor_id
    where i.store_id = pg_temp.sid(8) and v.brand_id <> pg_temp.bid(1)),
  0, 'T-30b AC-18 no cross-brand link reaches the target, RLS or not');
select is((pg_temp.src('p30s', pg_temp.sid(1)) ->> 'items_no_vendor_link')::int, 3,
  'T-30b the preview applies the same predicate for a super-admin');
select is((pg_temp.src('p30s', pg_temp.sid(1)) ->> 'item_count')::int, 8,
  'T-30b D-3 and a super-admin''s preview excludes the foreign-catalog row too');
select is((pg_temp.item(pg_temp.sid(8), pg_temp.cid(50))).id, null::uuid,
  'T-30b D-3 and a super-admin''s write doesn''t copy it');

-- T-13
select is((pg_temp.item(pg_temp.sid(2), pg_temp.cid(50))).id, null::uuid,
  'T-13 D-3 a foreign-catalog source row is not copied');

-- T-33 (first half): one audit row naming the source and the counts.
select is(
  (select count(*)::int from public.audit_log where store_id = pg_temp.sid(2)),
  1, 'T-33 AC-21 exactly one audit row, not one per item');
select is(
  (select row(a.user_id, a.action, a.item_ref, a.detail, a.value)::text
     from public.audit_log a where a.store_id = pg_temp.sid(2)),
  row(pg_temp.uid(1), 'Store stocked', 's184 main source',
      'Copied 8 items and 8 vendor links, skipped 0; added 0 catalog rows, skipped 0', '8')::text,
  'T-33 AC-21 the row names the actor, the source and the counts');


-- ═══════════════════════════════════════════════════════════════════════════
-- T-10: an identical second run adds nothing and changes nothing.
-- ═══════════════════════════════════════════════════════════════════════════
insert into snap184 values ('target_after_first', pg_temp.fingerprint(pg_temp.sid(2)));

set local role authenticated;
select pg_temp.login(pg_temp.uid(1), 'admin');
select lives_ok(
  format($q$select pg_temp.run('t10', %L::uuid, %L::uuid)$q$, pg_temp.sid(2), pg_temp.sid(1)),
  'T-10 AC-9 an identical second run is not an error');
reset role;

select is(pg_temp.n('t10', 'items_copied'), 0, 'T-10 AC-9 adds 0 items');
select is(pg_temp.n('t10', 'links_added'), 0, 'T-10 AC-9 adds 0 links');
select is(pg_temp.n('t10', 'items_skipped'), 8, 'T-10 AC-9 reports 8 skipped');
select is(pg_temp.n('t10', 'links_skipped_cross_brand'), 0, 'T-10 no foreign link is counted for rows it did not add');
select is(pg_temp.fingerprint(pg_temp.sid(2)),
  (select v from snap184 where k = 'target_after_first'),
  'T-10 AC-9 the target is byte-identical');
select is(
  (select count(*)::int from public.audit_log where store_id = pg_temp.sid(2)),
  1, 'T-33 AC-21 a call that adds nothing writes no audit row');


-- ═══════════════════════════════════════════════════════════════════════════
-- T-9: a partly stocked target.
-- ═══════════════════════════════════════════════════════════════════════════
set local role authenticated;
select pg_temp.login(pg_temp.uid(1), 'admin');
select lives_ok(
  format($q$select pg_temp.run('t9', %L::uuid, %L::uuid)$q$, pg_temp.sid(3), pg_temp.sid(1)),
  'T-9 AC-8 stocking a partly stocked target is accepted');
reset role;

select is(
  (select row_to_json(i)::text from public.inventory_items i
    where i.store_id = pg_temp.sid(3) and i.catalog_id = pg_temp.cid(1)),
  (select v from snap184 where k = 'partly_c1'),
  'T-9 AC-8 the existing row is byte-identical (par, cost, price, stock, vendor)');
select is(
  (select array_agg(iv.vendor_id) from public.item_vendors iv
    where iv.item_id = (pg_temp.item(pg_temp.sid(3), pg_temp.cid(1))).id),
  array[pg_temp.vid(3)],
  'T-9 AC-8 its differing link set is kept');
select is(pg_temp.n('t9', 'items_copied'), 7, 'T-9 AC-8 seven rows added');
select is(pg_temp.n('t9', 'items_skipped'), 1, 'T-9 AC-8 one skipped');
select is(pg_temp.n('t9', 'links_added'), 6, 'T-9 AC-8 links only for rows added');
select is(pg_temp.row_count(pg_temp.sid(3)), 8, 'T-9 AC-8 the target now has eight rows');


-- ═══════════════════════════════════════════════════════════════════════════
-- T-12: A then B.
-- ═══════════════════════════════════════════════════════════════════════════
set local role authenticated;
select pg_temp.login(pg_temp.uid(1), 'admin');
select lives_ok(
  format($q$select pg_temp.run('t12a', %L::uuid, %L::uuid)$q$, pg_temp.sid(12), pg_temp.sid(10)),
  'T-12 AC-10 run from A');
select lives_ok(
  format($q$select pg_temp.run('t12b', %L::uuid, %L::uuid)$q$, pg_temp.sid(12), pg_temp.sid(11)),
  'T-12 AC-10 run from B');
reset role;

select is(
  (select array_agg(catalog_id order by catalog_id) from public.inventory_items where store_id = pg_temp.sid(12)),
  array[pg_temp.cid(21), pg_temp.cid(22), pg_temp.cid(23)],
  'T-12 AC-10 the target holds {1,2,3}');
select is((pg_temp.item(pg_temp.sid(12), pg_temp.cid(22))).par_level, 2::numeric,
  'T-12 AC-10 item 2 keeps A''s values');
select is(pg_temp.n('t12b', 'items_copied'), 1, 'T-12 AC-10 the second run copies 1');
select is(pg_temp.n('t12b', 'items_skipped'), 1, 'T-12 AC-10 and skips 1');


-- ═══════════════════════════════════════════════════════════════════════════
-- T-14: all-or-nothing, with a real mid-call failure under `authenticated`.
-- ═══════════════════════════════════════════════════════════════════════════
create function public.__t184_boom() returns trigger language plpgsql as $$
begin
  if new.order_code = 'MARK184' then
    raise exception 'T14 forced failure' using errcode = 'P0001';
  end if;
  return new;
end $$;
create trigger __t184_boom_trg before insert on public.item_vendors
  for each row execute function public.__t184_boom();

set local role authenticated;
select pg_temp.login(pg_temp.uid(1), 'admin');
select throws_ok(
  format($q$select public.stock_store_from_store(%L::uuid, %L::uuid)$q$, pg_temp.sid(6), pg_temp.sid(1)),
  'P0001', 'T14 forced failure',
  'T-14 AC-11 a failure in the link statement raises');
reset role;

drop trigger __t184_boom_trg on public.item_vendors;

select is(pg_temp.row_count(pg_temp.sid(6)), 0, 'T-14 AC-11 0 new items after the forced failure');
select is(pg_temp.link_count(pg_temp.sid(6)), 0, 'T-14 AC-11 0 new links after the forced failure');
select is(
  (select count(*)::int from public.audit_log where store_id = pg_temp.sid(6)),
  0, 'T-14 AC-21 0 audit rows after the forced failure');


-- ═══════════════════════════════════════════════════════════════════════════
-- T-15: an empty source.
-- ═══════════════════════════════════════════════════════════════════════════
set local role authenticated;
select pg_temp.login(pg_temp.uid(1), 'admin');
select lives_ok(
  format($q$select pg_temp.run('t15', %L::uuid, %L::uuid)$q$, pg_temp.sid(5), pg_temp.sid(4)),
  'T-15 AC-12 an empty source is not an error');
reset role;

select is(pg_temp.n('t15', 'items_copied') + pg_temp.n('t15', 'items_skipped')
        + pg_temp.n('t15', 'links_added') + pg_temp.n('t15', 'extras_added')
        + pg_temp.n('t15', 'extras_skipped') + pg_temp.n('t15', 'items_no_vendor_link'),
  0, 'T-15 AC-12 every count is 0');
select is(pg_temp.row_count(pg_temp.sid(5)), 0, 'T-15 AC-12 nothing written');
select is(
  (select count(*)::int from public.audit_log where store_id = pg_temp.sid(5)),
  0, 'T-33 AC-21 an empty source writes no audit row');


-- ═══════════════════════════════════════════════════════════════════════════
-- T-16: the ON CONFLICT arm. A trigger plays a concurrent writer that takes
-- (target, c1) between the plan and the insert. No links for that row.
-- ═══════════════════════════════════════════════════════════════════════════
create function public.__t184_race() returns trigger language plpgsql as $$
begin
  if pg_trigger_depth() = 1
     and new.store_id = 'b1840001-0000-0000-0000-000000000007'
     and new.catalog_id = 'b1840002-0000-0000-0000-000000000001' then
    insert into public.inventory_items (store_id, catalog_id, par_level)
    values (new.store_id, new.catalog_id, 999);
  end if;
  return new;
end $$;
create trigger __t184_race_trg before insert on public.inventory_items
  for each row execute function public.__t184_race();

set local role authenticated;
select pg_temp.login(pg_temp.uid(1), 'admin');
select lives_ok(
  format($q$select pg_temp.run('t16', %L::uuid, %L::uuid)$q$, pg_temp.sid(7), pg_temp.sid(1)),
  'T-16 N3 a row taken mid-call does not fail the run');
reset role;

drop trigger __t184_race_trg on public.inventory_items;

select is((pg_temp.item(pg_temp.sid(7), pg_temp.cid(1))).par_level, 999::numeric,
  'T-16 N3 the concurrent writer''s row stands');
select is(
  (select count(*)::int from public.item_vendors
    where item_id = (pg_temp.item(pg_temp.sid(7), pg_temp.cid(1))).id),
  0, 'T-16 N3 and it gets NO links from this call');
select is(pg_temp.n('t16', 'items_copied'), 7, 'T-16 N3 seven copied');
select is(pg_temp.n('t16', 'items_skipped'), 1, 'T-16 N3 the raced row is counted as skipped');
select is(pg_temp.n('t16', 'links_added'), 6, 'T-16 N3 links only for rows this call inserted');


-- ═══════════════════════════════════════════════════════════════════════════
-- T-17, T-18, T-19, T-20: ticks.
-- ═══════════════════════════════════════════════════════════════════════════
set local role authenticated;
select pg_temp.login(pg_temp.uid(1), 'admin');
select lives_ok(
  format($q$select pg_temp.run('t17', %L::uuid, %L::uuid, array[%L::uuid])$q$,
         pg_temp.sid(13), pg_temp.sid(14), pg_temp.cid(31)),
  'T-17 AC-13 a ticked uncarried row is accepted');
reset role;

select is(
  (select row(i.par_level, i.cost_per_unit, i.case_price, i.safety_stock, i.usage_per_portion,
              i.current_stock, i.eod_remaining, i.average_daily_usage)::text
     from public.inventory_items i
    where i.store_id = pg_temp.sid(13) and i.catalog_id = pg_temp.cid(31)),
  '(0.000,0.000000,0,0,0.0000,0.000,0.000,0)',
  'T-17 AC-13 R-3 zeros, though the catalog row has default_cost 77.5');
select is((pg_temp.item(pg_temp.sid(13), pg_temp.cid(31))).vendor_id, null::uuid, 'T-17 AC-13 null vendor_id');
select is(
  (select count(*)::int from public.item_vendors
    where item_id = (pg_temp.item(pg_temp.sid(13), pg_temp.cid(31))).id),
  0, 'T-17 AC-13 no links');
select is(pg_temp.n('t17', 'extras_added'), 1, 'T-17 AC-13 counted as added');
select is(pg_temp.n('t17', 'items_copied'), 1, 'T-17 the source''s item is copied alongside it');
select is(pg_temp.n('t17', 'items_no_vendor_link'), 1, 'T-17 the ticked row counts as no vendor link');
select is(pg_temp.n('t17', 'uncarried_remaining'), 2, 'T-17 AC-39 uncarried_remaining falls');

set local role authenticated;
select pg_temp.login(pg_temp.uid(1), 'admin');
select lives_ok(
  format($q$select pg_temp.run('t18', %L::uuid, %L::uuid, array[%L, %L, %L, %L, %L]::uuid[])$q$,
         pg_temp.sid(17), pg_temp.sid(14),
         pg_temp.cid(32), pg_temp.cid(33), pg_temp.cid(34), pg_temp.cid(35), pg_temp.cid(24)),
  'T-18 AC-14 ticks already carried do not fail the call');
reset role;

select is((pg_temp.item(pg_temp.sid(17), pg_temp.cid(32))).id, null::uuid,
  'T-18 AC-14 a tick carried at an INACTIVE store adds nothing');
select is((pg_temp.item(pg_temp.sid(17), pg_temp.cid(33))).id, null::uuid,
  'T-18 AC-14 a tick carried at another store adds nothing');
select is(pg_temp.n('t18', 'extras_added'), 1, 'T-18 AC-14 the uncarried tick is still added');
select is(pg_temp.n('t18', 'extras_skipped'), 4,
  'T-18 AC-14 inactive, other store, target, and source-carried ticks are counted as skipped');
select is(pg_temp.n('t18', 'items_copied'), 1, 'T-18 D-7 a tick the source carries is copied, not added blank');
select is(
  (select count(*)::int from public.item_vendors
    where item_id = (pg_temp.item(pg_temp.sid(17), pg_temp.cid(24))).id),
  1, 'T-18 D-7 and keeps its link');
select is(pg_temp.row_count(pg_temp.sid(17)), 3, 'T-18 the target holds its own, the copied, and the added row');

-- T-19
set local role authenticated;
select pg_temp.login(pg_temp.uid(1), 'admin');
select throws_ok(
  format($q$select public.stock_store_from_store(%L::uuid, %L::uuid, array[%L]::uuid[])$q$,
         pg_temp.sid(22), pg_temp.sid(14), pg_temp.cid(51)),
  '22023', 'stock_store: catalog id not in this brand',
  'T-19 AC-15 a tick from another brand refuses the call');
select throws_ok(
  format($q$select public.stock_store_from_store(%L::uuid, %L::uuid, array[%L]::uuid[])$q$,
         pg_temp.sid(22), pg_temp.sid(14), pg_temp.cid(9999)),
  '22023', 'stock_store: catalog id not in this brand',
  'T-19 AC-15 a nonexistent tick refuses the call');
select throws_ok(
  format($q$select public.stock_store_from_store(%L::uuid, %L::uuid, array[null, %L]::uuid[])$q$,
         pg_temp.sid(22), pg_temp.sid(14), pg_temp.cid(36)),
  '22023', 'stock_store: catalog id not in this brand',
  'T-19 AC-15 a null element refuses the call');
reset role;

-- T-20
set local role authenticated;
select pg_temp.login(pg_temp.uid(1), 'admin');
select lives_ok(
  format($q$select pg_temp.run('t20null', %L::uuid, %L::uuid, null)$q$, pg_temp.sid(18), pg_temp.sid(14)),
  'T-20 AC-16 null ticks');
select lives_ok(
  format($q$select pg_temp.run('t20empty', %L::uuid, %L::uuid, '{}'::uuid[])$q$, pg_temp.sid(19), pg_temp.sid(14)),
  'T-20 AC-16 empty ticks');
select lives_ok(
  format($q$select pg_temp.run('t20dup', %L::uuid, %L::uuid, array[%L, %L]::uuid[])$q$,
         pg_temp.sid(20), pg_temp.sid(14), pg_temp.cid(36), pg_temp.cid(36)),
  'T-20 duplicate ticks');
reset role;

select is(
  pg_temp.res('t20null') - 'target_has_order_schedule',
  pg_temp.res('t20empty') - 'target_has_order_schedule',
  'T-20 AC-16 null and empty ticks give the same result');
select is(pg_temp.n('t20null', 'extras_added'), 0, 'T-20 AC-16 null ticks behave as no ticks');
select is(pg_temp.n('t20dup', 'extras_added'), 1, 'T-20 duplicate ticks add one row');
select is(pg_temp.n('t20dup', 'extras_skipped'), 0, 'T-20 and aren''t counted as skipped');
select is(pg_temp.res('t20null') -> 'target_has_order_schedule', 'false'::jsonb, 'T-20 AC-34 no schedule reports false');
select is(pg_temp.res('t20empty') -> 'target_has_order_schedule', 'true'::jsonb, 'T-20 AC-34 a store with a schedule reports true');


-- ═══════════════════════════════════════════════════════════════════════════
-- T-21 to T-28: refusals, every one under `authenticated`, with a probe.
-- ═══════════════════════════════════════════════════════════════════════════
-- T-21: `user` with user_stores on both stores.
set local role authenticated;
select pg_temp.login(pg_temp.uid(3), 'user');
select ok(
  public.auth_can_see_store(pg_temp.sid(22)) and public.auth_can_see_store(pg_temp.sid(1))
    and not public.auth_is_privileged(),
  'T-21 anti-vacuity: the user sees both stores and is not privileged');
select throws_ok(
  format($q$select public.stock_store_from_store(%L::uuid, %L::uuid)$q$, pg_temp.sid(22), pg_temp.sid(1)),
  '42501', 'stock_store: privileged only',
  'T-21 AC-17 a non-privileged user with both stores is refused');
-- ...even though RLS would let them insert one item by hand (the R-7 point).
select throws_ok(
  format($q$do $x$ begin
      insert into public.inventory_items (store_id, catalog_id) values (%L::uuid, %L::uuid);
      raise exception 'T21 control reached' using errcode = 'P0001';
    end $x$$q$, pg_temp.sid(22), pg_temp.cid(1)),
  'P0001', 'T21 control reached',
  'T-21 R-7 control: RLS alone would admit the same user''s single-item insert (raised after it, so it rolls back)');
reset role;

-- T-22: an admin of another brand.
set local role authenticated;
select pg_temp.login(pg_temp.uid(2), 'admin');
select ok(
  public.auth_is_privileged()
    and not public.auth_can_see_store(pg_temp.sid(22)) and not public.auth_can_see_store(pg_temp.sid(1)),
  'T-22 anti-vacuity: privileged, and sees neither store');
select throws_ok(
  format($q$select public.stock_store_from_store(%L::uuid, %L::uuid)$q$, pg_temp.sid(22), pg_temp.sid(1)),
  '42501', 'stock_store: target store not accessible',
  'T-22 AC-17 an admin of another brand is refused');
reset role;

-- T-23: a missing store. 42501 for a brand admin, so no existence oracle.
set local role authenticated;
select pg_temp.login(pg_temp.uid(1), 'admin');
select throws_ok(
  format($q$select public.stock_store_from_store(%L::uuid, %L::uuid)$q$, pg_temp.sid(9999), pg_temp.sid(1)),
  '42501', 'stock_store: target store not accessible',
  'T-23 AC-17 brand admin, missing target: 42501');
select throws_ok(
  format($q$select public.stock_store_from_store(%L::uuid, %L::uuid)$q$, pg_temp.sid(22), pg_temp.sid(9999)),
  '42501', 'stock_store: source store not accessible',
  'T-23 AC-17 brand admin, missing source: 42501');
reset role;

set local role authenticated;
select pg_temp.login(pg_temp.uid(4), 'super_admin');
select ok(public.auth_can_see_store(pg_temp.sid(9999)),
  'T-23 anti-vacuity: visibility is always true for a super-admin');
select throws_ok(
  format($q$select public.stock_store_from_store(%L::uuid, %L::uuid)$q$, pg_temp.sid(9999), pg_temp.sid(1)),
  '22023', 'stock_store: store not found',
  'T-23 AC-17 super-admin, missing target: G-5');
select throws_ok(
  format($q$select public.stock_store_from_store(%L::uuid, %L::uuid)$q$, pg_temp.sid(22), pg_temp.sid(9999)),
  '22023', 'stock_store: store not found',
  'T-23 AC-17 super-admin, missing source: G-5');
-- T-27: different brands as super-admin, so visibility can't be what stops it.
select ok(
  public.auth_can_see_store(pg_temp.sid(22)) and public.auth_can_see_store(pg_temp.sid(30)),
  'T-27 anti-vacuity: the super-admin sees both brands'' stores');
select throws_ok(
  format($q$select public.stock_store_from_store(%L::uuid, %L::uuid)$q$, pg_temp.sid(22), pg_temp.sid(30)),
  '22023', 'stock_store: stores must be in the same brand',
  'T-27 AC-17 different brands as super-admin: G-6');
reset role;

-- T-24, T-25: sees target not source, and the reverse.
set local role authenticated;
select pg_temp.login(pg_temp.uid(1), 'admin');
select ok(
  public.auth_can_see_store(pg_temp.sid(22)) and not public.auth_can_see_store(pg_temp.sid(30)),
  'T-24 anti-vacuity: the brand admin sees the A store, not the B store');
select throws_ok(
  format($q$select public.stock_store_from_store(%L::uuid, %L::uuid)$q$, pg_temp.sid(22), pg_temp.sid(30)),
  '42501', 'stock_store: source store not accessible',
  'T-24 AC-17 sees the target, not the source: G-4b');
select throws_ok(
  format($q$select public.stock_store_from_store(%L::uuid, %L::uuid)$q$, pg_temp.sid(30), pg_temp.sid(22)),
  '42501', 'stock_store: target store not accessible',
  'T-25 AC-17 sees the source, not the target: G-4');
-- T-28
select throws_ok(
  format($q$select public.stock_store_from_store(%L::uuid, %L::uuid)$q$, pg_temp.sid(22), pg_temp.sid(22)),
  '22023', 'stock_store: source and target must differ',
  'T-28 AC-17 same id: G-3');
select throws_ok(
  format($q$select public.stock_store_from_store(%L::uuid, null, array[%L]::uuid[])$q$, pg_temp.sid(22), pg_temp.cid(36)),
  '22023', 'stock_store: target and source store are required',
  'T-28 AC-17 null source with ticks: G-2');
select throws_ok(
  format($q$select public.stock_store_from_store(null, %L::uuid)$q$, pg_temp.sid(1)),
  '22023', 'stock_store: target and source store are required',
  'T-28 AC-17 null target: G-2');
reset role;

-- T-26: stale admin JWT on a demoted, null-brand profile with both stores.
set local role authenticated;
select pg_temp.login(pg_temp.uid(5), 'admin');
select ok(
  public.auth_is_privileged()
    and public.auth_can_see_store(pg_temp.sid(22)) and public.auth_can_see_store(pg_temp.sid(1))
    and not public.auth_can_see_brand(pg_temp.bid(1)),
  'T-26 F-4 anti-vacuity: passes G-1 and G-4 through user_stores, cannot see the brand');
select throws_ok(
  format($q$select public.stock_store_from_store(%L::uuid, %L::uuid)$q$, pg_temp.sid(22), pg_temp.sid(1)),
  '42501', 'stock_store: brand not accessible',
  'T-26 F-4 stale JWT is refused at G-7');
reset role;

-- Every refusal above aimed at store 22: nothing landed, nothing was audited.
select is(pg_temp.row_count(pg_temp.sid(22)), 0, 'T-21..28 AC-17 no refused call wrote an item');
select is(pg_temp.link_count(pg_temp.sid(22)), 0, 'T-21..28 AC-17 no refused call wrote a link');
select is(
  (select count(*)::int from public.audit_log where store_id = pg_temp.sid(22)),
  0, 'T-33 AC-21 no refused call wrote an audit row');

-- T-29
select col_not_null('public', 'stores', 'brand_id', 'T-29 F-5 stores.brand_id is NOT NULL, so AC-17''s null-brand store is unreachable');


-- ═══════════════════════════════════════════════════════════════════════════
-- T-31: privileges and shape.
-- ═══════════════════════════════════════════════════════════════════════════
select ok(not has_function_privilege('anon', 'public.stock_store_from_store(uuid, uuid, uuid[])', 'EXECUTE'), 'T-31 AC-19 anon lacks EXECUTE on the write');
select ok(has_function_privilege('authenticated', 'public.stock_store_from_store(uuid, uuid, uuid[])', 'EXECUTE'), 'T-31 AC-19 authenticated has EXECUTE on the write');
select ok(not has_function_privilege('anon', 'public.stock_store_preview(uuid, uuid)', 'EXECUTE'), 'T-31 AC-19 anon lacks EXECUTE on the preview');
select ok(has_function_privilege('authenticated', 'public.stock_store_preview(uuid, uuid)', 'EXECUTE'), 'T-31 AC-19 authenticated has EXECUTE on the preview');
select is(
  (select count(*)::int from pg_proc p, aclexplode(p.proacl) a
    where p.pronamespace = 'public'::regnamespace
      and p.proname in ('stock_store_from_store', 'stock_store_preview')
      and a.grantee = 0 and a.privilege_type = 'EXECUTE'),
  0, 'T-31 AC-19 PUBLIC has no EXECUTE on either');
select is(
  (select count(*)::int from pg_proc where pronamespace = 'public'::regnamespace and proname = 'stock_store_from_store'),
  1, 'T-31 AC-19 exactly one overload of the write');
select is(
  (select count(*)::int from pg_proc where pronamespace = 'public'::regnamespace and proname = 'stock_store_preview'),
  1, 'T-31 AC-19 exactly one overload of the preview');
select is(
  (select array_agg(distinct p.proconfig::text) from pg_proc p
    where p.pronamespace = 'public'::regnamespace and p.proname in ('stock_store_from_store', 'stock_store_preview')),
  array['{search_path=public}'],
  'T-31 AC-19 search_path pinned on both');
select is(
  (select bool_or(p.prosecdef) from pg_proc p
    where p.pronamespace = 'public'::regnamespace and p.proname in ('stock_store_from_store', 'stock_store_preview')),
  false, 'T-31 AC-19 prosecdef false on both (SECURITY INVOKER)');
select is(
  (select p.provolatile::text from pg_proc p
    where p.pronamespace = 'public'::regnamespace and p.proname = 'stock_store_preview'),
  's', 'T-31 preview is STABLE');
select is(
  (select count(*)::text from public.order_schedule),
  (select v from snap184 where k = 'schedule_count'),
  'T-31 AC-19 no call wrote an order_schedule row');


-- ═══════════════════════════════════════════════════════════════════════════
-- T-32: spec 179 and spec 177 coexist.
-- ═══════════════════════════════════════════════════════════════════════════
insert into snap184 values ('t32_old_id', (pg_temp.item(pg_temp.sid(2), pg_temp.cid(2))).id::text);

set local role authenticated;
select pg_temp.login(pg_temp.uid(1), 'admin');
select lives_ok(
  format($q$delete from public.inventory_items where store_id = %L::uuid and catalog_id = %L::uuid$q$,
         pg_temp.sid(2), pg_temp.cid(2)),
  'T-32 AC-20 delete a stocked item at the target');
select lives_ok(
  format($q$select pg_temp.run('t32', %L::uuid, %L::uuid)$q$, pg_temp.sid(2), pg_temp.sid(1)),
  'T-32 AC-20 re-run after the delete: no 42501 from the tombstone check');
reset role;

select is(pg_temp.n('t32', 'items_copied'), 1, 'T-32 AC-20 the item returns');
select isnt(
  (pg_temp.item(pg_temp.sid(2), pg_temp.cid(2))).id::text,
  (select v from snap184 where k = 't32_old_id'),
  'T-32 AC-20 under a new id');

insert into public.purchase_orders (id, store_id, vendor_id, status)
values ('b1840006-0000-0000-0000-000000000001', pg_temp.sid(2), pg_temp.vid(1), 'draft');

set local role authenticated;
select pg_temp.login(pg_temp.uid(1), 'admin');
select lives_ok(
  format($q$insert into public.po_items (po_id, item_id, ordered_qty) values ('b1840006-0000-0000-0000-000000000001', %L::uuid, 1)$q$,
         (pg_temp.item(pg_temp.sid(2), pg_temp.cid(1))).id),
  'T-32 AC-20 a PO at the target accepts the copied row');
select throws_ok(
  format($q$insert into public.po_items (po_id, item_id, ordered_qty) values ('b1840006-0000-0000-0000-000000000001', %L::uuid, 1)$q$,
         (pg_temp.item(pg_temp.sid(1), pg_temp.cid(1))).id),
  '42501', 'po_items: item store mismatch with parent purchase order',
  'T-32 AC-20 and refuses the source''s row');
reset role;


-- ═══════════════════════════════════════════════════════════════════════════
-- T-34, T-35: the preview. Three-store fixture in brand C, as a super-admin.
-- ═══════════════════════════════════════════════════════════════════════════
set local role authenticated;
select pg_temp.login(pg_temp.uid(4), 'super_admin');
select lives_ok(
  format($q$select pg_temp.preview('p34', %L::uuid, %L::uuid)$q$, pg_temp.bid(3), pg_temp.sid(42)),
  'T-34 preview with a target');
reset role;

select is(pg_temp.n('p34', 'target_item_count'), 1, 'T-34 target_item_count');
select is(pg_temp.res('p34') -> 'target_has_order_schedule', 'false'::jsonb, 'T-34 target_has_order_schedule');
select is(
  (select array_agg(e ->> 'name' order by o)
     from jsonb_array_elements(pg_temp.res('p34') -> 'sources') with ordinality as t(e, o)),
  array['C-Inactive', 'C-X', 'C-Y'],
  'T-35 AC-28 sources by name; excludes the target and the 0-item store; includes the inactive store');
select is(pg_temp.src('p34', pg_temp.sid(44)) ->> 'status', 'inactive', 'T-35 the inactive store carries its status');
select is(
  pg_temp.src('p34', pg_temp.sid(40)),
  jsonb_build_object(
    'store_id', pg_temp.sid(40), 'name', 'C-X', 'status', 'active',
    'item_count', 3, 'items_to_add', 2, 'items_already_at_target', 1,
    'items_no_vendor_link', 1, 'carried_elsewhere_count', 2),
  'T-34 N4 source X: exact numbers (elsewhere = 63 and 65)');
select is(
  pg_temp.src('p34', pg_temp.sid(41)),
  jsonb_build_object(
    'store_id', pg_temp.sid(41), 'name', 'C-Y', 'status', 'active',
    'item_count', 2, 'items_to_add', 2, 'items_already_at_target', 0,
    'items_no_vendor_link', 1, 'carried_elsewhere_count', 2),
  'T-34 N4 source Y: exact numbers (elsewhere = 62 and 65)');
select is(
  pg_temp.res('p34') -> 'uncarried',
  jsonb_build_array(jsonb_build_object(
    'catalog_id', pg_temp.cid(64), 'name', '__s184_c64__', 'unit', 'each',
    'category', 'test', 'i18n_names', '{"es":"Ese"}'::jsonb)),
  'T-34 T-35 uncarried holds only c64, not c65 (carried at an inactive store)');

-- Parity: the write reports exactly what the preview promised.
set local role authenticated;
select pg_temp.login(pg_temp.uid(4), 'super_admin');
select lives_ok(
  format($q$select pg_temp.run('w34', %L::uuid, %L::uuid)$q$, pg_temp.sid(42), pg_temp.sid(40)),
  'T-34 write from source X');
reset role;

select is(pg_temp.n('w34', 'items_copied'), (pg_temp.src('p34', pg_temp.sid(40)) ->> 'items_to_add')::int,
  'T-34 parity: items_copied = items_to_add');
select is(pg_temp.n('w34', 'items_skipped'), (pg_temp.src('p34', pg_temp.sid(40)) ->> 'items_already_at_target')::int,
  'T-34 parity: items_skipped = items_already_at_target');
select is(pg_temp.n('w34', 'items_no_vendor_link'), (pg_temp.src('p34', pg_temp.sid(40)) ->> 'items_no_vendor_link')::int,
  'T-34 parity: items_no_vendor_link agrees');
select is(pg_temp.n('w34', 'uncarried_remaining'), jsonb_array_length(pg_temp.res('p34') -> 'uncarried'),
  'T-34 parity: uncarried_remaining = uncarried length');
select is(pg_temp.res('w34') -> 'target_has_order_schedule', pg_temp.res('p34') -> 'target_has_order_schedule',
  'T-34 parity: target_has_order_schedule agrees');
select is(
  (pg_temp.n('w34', 'items_copied') + (pg_temp.src('p34', pg_temp.sid(40)) ->> 'items_already_at_target')::int),
  (pg_temp.src('p34', pg_temp.sid(40)) ->> 'item_count')::int,
  'T-34 parity: to_add + already = item_count');

-- T-13 (second half): the preview ignores the foreign-catalog row too.
set local role authenticated;
select pg_temp.login(pg_temp.uid(1), 'admin');
select lives_ok(
  format($q$select pg_temp.preview('p13', %L::uuid, %L::uuid)$q$, pg_temp.bid(1), pg_temp.sid(22)),
  'T-13 preview as a brand admin');
reset role;
select is((pg_temp.src('p13', pg_temp.sid(1)) ->> 'item_count')::int, 8,
  'T-13 D-3 the preview counts 8 eligible rows, not the 9th foreign-catalog row');
select is((pg_temp.src('p13', pg_temp.sid(1)) ->> 'items_no_vendor_link')::int, 3,
  'T-34 parity under a brand admin: a cross-brand-only item counts as no link, as the write does');

-- T-35: no target, and the gates.
set local role authenticated;
select pg_temp.login(pg_temp.uid(4), 'super_admin');
select lives_ok(
  format($q$select pg_temp.preview('p35', %L::uuid)$q$, pg_temp.bid(3)),
  'T-35 AC-38 preview with no target');
select throws_ok(
  'select public.stock_store_preview(null)',
  '22023', 'stock_store: brand is required',
  'T-35 null brand: 22023');
select throws_ok(
  format($q$select public.stock_store_preview(%L::uuid, %L::uuid)$q$, pg_temp.bid(3), pg_temp.sid(22)),
  '22023', 'stock_store: target not in this brand',
  'T-35 target in another brand, as a super-admin: 22023');
reset role;

select ok(
  pg_temp.res('p35') -> 'target_item_count' = 'null'::jsonb
    and pg_temp.res('p35') -> 'target_has_order_schedule' = 'null'::jsonb,
  'T-35 no target gives null target fields');
select is((pg_temp.src('p35', pg_temp.sid(40)) ->> 'items_to_add')::int, 3,
  'T-35 no target: everything is to be added');
select is((pg_temp.src('p35', pg_temp.sid(40)) ->> 'items_already_at_target')::int, 0,
  'T-35 no target: nothing is already there');
select is(pg_temp.src('p35', pg_temp.sid(43)), null::jsonb, 'T-35 AC-28 a 0-item store is never a source');

set local role authenticated;
select pg_temp.login(pg_temp.uid(3), 'user');
select throws_ok(
  format($q$select public.stock_store_preview(%L::uuid)$q$, pg_temp.bid(1)),
  '42501', 'stock_store: privileged only',
  'T-35 the preview refuses a non-privileged user');
select pg_temp.login(pg_temp.uid(2), 'admin');
select throws_ok(
  format($q$select public.stock_store_preview(%L::uuid)$q$, pg_temp.bid(1)),
  '42501', 'stock_store: brand not accessible',
  'T-35 the preview refuses an admin of another brand');
select pg_temp.login(pg_temp.uid(1), 'admin');
select throws_ok(
  format($q$select public.stock_store_preview(%L::uuid, %L::uuid)$q$, pg_temp.bid(1), pg_temp.sid(30)),
  '42501', 'stock_store: target store not accessible',
  'T-35 the preview refuses a target the caller can''t see');
reset role;


-- ═══════════════════════════════════════════════════════════════════════════
-- T-36: seed scale. A real 2AM store as the source, the seed admin as caller.
-- ═══════════════════════════════════════════════════════════════════════════
insert into public.stores (id, brand_id, name, address)
values (pg_temp.sid(90), '2a000000-0000-0000-0000-000000000001', 's184 seed scale target', '1 Spec Way');

set local role authenticated;
select pg_temp.login('11111111-1111-1111-1111-111111111111', 'admin');
select lives_ok(
  format($q$select pg_temp.preview('p36', '2a000000-0000-0000-0000-000000000001'::uuid, %L::uuid)$q$, pg_temp.sid(90)),
  'T-36 preview at seed scale');
select lives_ok(
  format($q$select pg_temp.run('w36', %L::uuid, '00000000-0000-0000-0000-000000000001'::uuid)$q$, pg_temp.sid(90)),
  'T-36 write at seed scale from Towson');
reset role;

select cmp_ok(pg_temp.n('w36', 'items_copied'), '>=', 100, 'T-36 a real store''s worth of rows was copied');
select is(pg_temp.n('w36', 'items_copied'),
  (pg_temp.src('p36', '00000000-0000-0000-0000-000000000001') ->> 'items_to_add')::int,
  'T-36 parity on real rows: items_copied');
select is(pg_temp.n('w36', 'items_no_vendor_link'),
  (pg_temp.src('p36', '00000000-0000-0000-0000-000000000001') ->> 'items_no_vendor_link')::int,
  'T-36 parity on real rows: items_no_vendor_link');
select is(pg_temp.n('w36', 'links_added'),
  (select count(*)::int from public.item_vendors iv
     join public.inventory_items i on i.id = iv.item_id
     join public.vendors v on v.id = iv.vendor_id
    where i.store_id = '00000000-0000-0000-0000-000000000001'
      and v.brand_id = '2a000000-0000-0000-0000-000000000001'),
  'T-36 every same-brand link at the source was copied');
select is(
  (select count(*)::int from public.inventory_items t
    where t.store_id = pg_temp.sid(90)
      and (t.current_stock <> 0 or t.eod_remaining <> 0 or t.average_daily_usage <> 0
           or t.expiry_date is not null or t.last_updated_by is not null
           or (t.vendor_id is not null and not exists (
                 select 1 from public.item_vendors iv
                  where iv.item_id = t.id and iv.vendor_id = t.vendor_id and iv.is_primary)))),
  0, 'T-36 R-2 no copied row breaks the reset or the primary-link rule');

select * from finish();

rollback;
