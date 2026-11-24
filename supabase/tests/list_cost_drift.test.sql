-- supabase/tests/list_cost_drift.test.sql
--
-- Spec 207 AC-10 — pgTAP coverage for public.list_cost_drift() in
-- supabase/migrations/20261123130000_recompute_costs_on_pack_size_change.sql
-- (design D-5, D-9).
--
-- Fixtures are seeded as postgres with the R3 derive-on-write trigger DISABLED
-- per table inside this transaction (`alter table … disable trigger
-- zz_derive_cost_per_unit_trg`, then enable), so rows can be planted off the
-- rule. session_replication_role is NOT used: it would also suspend the FK
-- triggers. The seed itself may carry drift locally (it is a pre-repair prod
-- pull), so every set assertion is restricted to this file's fixture ids.
--
-- Tolerance under test: a priced row is drift when
--   abs(stored - derived) > greatest(0.01, 0.02 * derived).
--
-- Fixture rows (D = catalog, all brand 2AM except D3):
--   D1 pieces 1 · D2 pieces 35 (1×35) · D3 pieces 1 (brand 2) · D4, D5 pieces 1
--   items                                        expected
--   I-A  Towson    D2  case 33.95 cost 33.95     drift (derived 0.970000)
--   I-B  Charles   D1  case 0.40  cost 0.409     within (off 0.009 < 0.01)
--   I-C  Frederick D1  case 10    cost 10        on rule
--   I-D  Reisters  D1  case 0     cost 2.5       cost_without_case_price
--   I-E  Towson    D1  case 0     cost 0         not listed
--   I-F  Towson    D4  case 100   cost 101.5     within (off 1.5 < 2% of 100)
--   I-G  Towson    D5  case 100   cost 103       drift (off 3 > 2)
--   I-Z  store Z   D3  case 50    cost 5         drift (brand 2)
--   links
--   L-A  on I-A  V1  case 40    cost 40          drift (derived 1.142857)
--   L-B  on I-B  V1  case 0.40  cost 0.395       within
--   L-D  on I-D  V1  case 0     cost 1.25        cost_without_case_price
--   L-Z  on I-Z  V9  case 50    cost 6           drift (brand 2)
--
-- anon is checked with has_function_privilege only: `set role anon` segfaults
-- CI (spec 067), so no anon throws_ok here. Hermetic: begin; … rollback;.

begin;
create extension if not exists pgtap;

select plan(17);

-- ─── helpers ────────────────────────────────────────────────────────────────
create function pg_temp.fid(k text) returns uuid language sql immutable as $$
  select ('20700000-0000-0000-00a0-' || lpad(
    case k
      when 'D1' then '11' when 'D2' then '12' when 'D3' then '13' when 'D4' then '14' when 'D5' then '15'
      when 'I-A' then '21' when 'I-B' then '22' when 'I-C' then '23' when 'I-D' then '24'
      when 'I-E' then '25' when 'I-F' then '26' when 'I-G' then '27' when 'I-Z' then '28'
      when 'L-A' then '31' when 'L-B' then '32' when 'L-D' then '34' when 'L-Z' then '38'
      when 'V1' then '41' when 'V9' then '49'
      when 'brand2' then '51' when 'storeZ' then '52' when 'SA' then '61'
    end, 12, '0'))::uuid
$$;
create function pg_temp.store(n text) returns uuid language sql stable as $$
  select id from public.stores where name = n limit 1
$$;
create function pg_temp.claims(p_sub text, p_role text) returns text
language sql as $$
  select set_config('request.jwt.claims', jsonb_build_object(
           'sub', p_sub, 'role', 'authenticated',
           'app_metadata', jsonb_build_object('role', p_role))::text, true)
$$;
-- Fixture row label for a listed row id ('?' for a non-fixture row).
create function pg_temp.label(p_id uuid) returns text language sql immutable as $$
  select coalesce((select k from unnest(array['I-A','I-B','I-C','I-D','I-E','I-F','I-G','I-Z',
                                              'L-A','L-B','L-D','L-Z']) k
                    where pg_temp.fid(k) = p_id), '?')
$$;

-- ─── fixtures (postgres) ────────────────────────────────────────────────────
insert into public.brands (id, name) values (pg_temp.fid('brand2'), '__s207_drift_brand2__');
insert into public.stores (id, brand_id, name, address)
values (pg_temp.fid('storeZ'), pg_temp.fid('brand2'), '__s207_drift_store_z__', '207 Drift Way');

insert into public.vendors (id, brand_id, name) values
  (pg_temp.fid('V1'), '2a000000-0000-0000-0000-000000000001', '__s207_drift_v1__'),
  (pg_temp.fid('V9'), pg_temp.fid('brand2'),                  '__s207_drift_v9__');

insert into public.catalog_ingredients (id, brand_id, name, unit, case_qty, sub_unit_size) values
  (pg_temp.fid('D1'), '2a000000-0000-0000-0000-000000000001', '__s207_drift_d1__', 'each', 1, 1),
  (pg_temp.fid('D2'), '2a000000-0000-0000-0000-000000000001', '__s207_drift_d2__', 'each', 1, 35),
  (pg_temp.fid('D3'), pg_temp.fid('brand2'),                  '__s207_drift_d3__', 'each', 1, 1),
  (pg_temp.fid('D4'), '2a000000-0000-0000-0000-000000000001', '__s207_drift_d4__', 'each', 1, 1),
  (pg_temp.fid('D5'), '2a000000-0000-0000-0000-000000000001', '__s207_drift_d5__', 'each', 1, 1);

alter table public.inventory_items disable trigger zz_derive_cost_per_unit_trg;
alter table public.item_vendors    disable trigger zz_derive_cost_per_unit_trg;

insert into public.inventory_items (id, store_id, catalog_id, case_price, cost_per_unit) values
  (pg_temp.fid('I-A'), pg_temp.store('Towson'),    pg_temp.fid('D2'), 33.95, 33.95),
  (pg_temp.fid('I-B'), pg_temp.store('Charles'),   pg_temp.fid('D1'), 0.40,  0.409),
  (pg_temp.fid('I-C'), pg_temp.store('Frederick'), pg_temp.fid('D1'), 10,    10),
  (pg_temp.fid('I-D'), pg_temp.store('Reisters'),  pg_temp.fid('D1'), 0,     2.5),
  (pg_temp.fid('I-E'), pg_temp.store('Towson'),    pg_temp.fid('D1'), 0,     0),
  (pg_temp.fid('I-F'), pg_temp.store('Towson'),    pg_temp.fid('D4'), 100,   101.5),
  (pg_temp.fid('I-G'), pg_temp.store('Towson'),    pg_temp.fid('D5'), 100,   103),
  (pg_temp.fid('I-Z'), pg_temp.fid('storeZ'),      pg_temp.fid('D3'), 50,    5);

insert into public.item_vendors (id, item_id, vendor_id, case_price, cost_per_unit, is_primary) values
  (pg_temp.fid('L-A'), pg_temp.fid('I-A'), pg_temp.fid('V1'), 40,   40,    true),
  (pg_temp.fid('L-B'), pg_temp.fid('I-B'), pg_temp.fid('V1'), 0.40, 0.395, true),
  (pg_temp.fid('L-D'), pg_temp.fid('I-D'), pg_temp.fid('V1'), 0,    1.25,  true),
  (pg_temp.fid('L-Z'), pg_temp.fid('I-Z'), pg_temp.fid('V9'), 50,   6,     true);

alter table public.inventory_items enable trigger zz_derive_cost_per_unit_trg;
alter table public.item_vendors    enable trigger zz_derive_cost_per_unit_trg;

-- A super_admin principal (auth.users token columns '' per project memory).
insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password,
  email_confirmed_at, created_at, updated_at,
  raw_app_meta_data, raw_user_meta_data, is_super_admin, is_anonymous,
  confirmation_token, recovery_token, email_change_token_new, email_change,
  email_change_token_current, phone_change, phone_change_token, reauthentication_token
) values (
  pg_temp.fid('SA'), '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
  'spec207-sa@local.test', '', now(), now(), now(),
  jsonb_build_object('provider', 'email', 'providers', array['email'], 'role', 'super_admin'),
  '{}'::jsonb, false, false, '', '', '', '', '', '', '', ''
);
insert into public.profiles (id, name, role, initials, color, status, brand_id)
values (pg_temp.fid('SA'), 'Spec207 SA', 'super_admin', 'SA', '#888888', 'active', null);

-- Row versions of every fixture row (xmin + ctid), before any call.
create temp table _ver as
select id, xmin::text || '@' || ctid::text as ver from public.inventory_items
 where id::text like '20700000-0000-0000-00a0-%'
union all
select id, xmin::text || '@' || ctid::text from public.item_vendors
 where id::text like '20700000-0000-0000-00a0-%';

create temp table _out (caller text, r jsonb);
grant insert, select on _out to authenticated;
create temp view _lab as
select caller, pg_temp.label((r ->> 'row_id')::uuid) collate "C" as lbl, r from _out;
grant select on _lab to authenticated;


-- ═══ structure ══════════════════════════════════════════════════════════════
select ok(
  (select provolatile = 's' and not prosecdef and 'search_path=""' = any (proconfig)
     from pg_proc where oid = 'public.list_cost_drift()'::regprocedure),
  '(1) list_cost_drift is STABLE, SECURITY INVOKER, search_path pinned to empty'
);
select ok(
  not has_function_privilege('anon', 'public.list_cost_drift()', 'EXECUTE')
  and not has_function_privilege('public', 'public.list_cost_drift()', 'EXECUTE')
  and has_function_privilege('authenticated', 'public.list_cost_drift()', 'EXECUTE'),
  '(2) anon and PUBLIC have no EXECUTE (anon gets 42501 at the grant); authenticated does'
);


-- ═══ calls ══════════════════════════════════════════════════════════════════
-- postgres (the MCP / SQL editor path: no JWT).
savepoint pg_call;
select lives_ok(
  $$insert into _out select 'postgres', to_jsonb(d) from public.list_cost_drift() d$$,
  '(3) a JWT-less postgres session can call it (the prod MCP path)'
);
release savepoint pg_call;

-- brand-1 admin.
set local role authenticated;
select pg_temp.claims('11111111-1111-1111-1111-111111111111', 'admin');
savepoint admin_call;
insert into _out select 'admin', to_jsonb(d) from public.list_cost_drift() d;
release savepoint admin_call;

-- super_admin.
select pg_temp.claims(pg_temp.fid('SA')::text, 'super_admin');
savepoint sa_call;
insert into _out select 'sa', to_jsonb(d) from public.list_cost_drift() d;
release savepoint sa_call;

-- non-privileged authenticated (role user).
select pg_temp.claims('22222222-2222-2222-2222-222222222222', 'user');
select throws_ok(
  'select * from public.list_cost_drift()',
  '42501',
  'privileged only',
  '(4) a non-privileged authenticated caller is refused with 42501 privileged only'
);
reset role;


-- ═══ exact sets (postgres sees both brands) ═════════════════════════════════
select is(
  (select array_agg(lbl order by lbl)
     from _lab where caller = 'postgres' and r ->> 'kind' = 'drift'
      and lbl <> '?'),
  array['I-A', 'I-G', 'I-Z', 'L-A', 'L-Z'],
  '(5) drift = exactly the fixture rows planted beyond the tolerance, both tables and both brands'
);
select is(
  (select array_agg(lbl order by lbl)
     from _lab where caller = 'postgres' and r ->> 'kind' = 'cost_without_case_price'
      and lbl <> '?'),
  array['I-D', 'L-D'],
  '(6) the unpriced rows with a cost > 0 are listed only as cost_without_case_price'
);
select is(
  (select count(*)::int from _lab where lbl in ('I-B', 'L-B', 'I-C', 'I-E', 'I-F')),
  0,
  '(7) within-tolerance (0.009 off, 1.5% off), on-rule and cost-0 unpriced rows are never listed, for any caller'
);
select is(
  (select r - 'store_id' from _out where caller = 'postgres' and (r ->> 'row_id')::uuid = pg_temp.fid('I-A')),
  jsonb_build_object(
    'kind', 'drift', 'source_table', 'inventory_items', 'row_id', pg_temp.fid('I-A'),
    'store_name', 'Towson', 'item_name', '__s207_drift_d2__',
    'case_price', 33.95, 'case_qty', 1, 'sub_unit_size', 35,
    'stored_cost', 33.950000, 'derived_cost', 0.970000),
  '(8) a drift row carries table, id, store, item name, case price, pack size, stored and derived cost'
);
select is(
  (select (r ->> 'store_id')::uuid from _out where caller = 'postgres' and (r ->> 'row_id')::uuid = pg_temp.fid('L-A')),
  pg_temp.store('Towson'),
  '(9) an item_vendors drift row reports its item''s store'
);
select is(
  (select array[r ->> 'source_table', r ->> 'derived_cost', r ->> 'stored_cost']
     from _out where caller = 'postgres' and (r ->> 'row_id')::uuid = pg_temp.fid('L-D')),
  array['item_vendors', null, '1.250000'],
  '(10) a cost_without_case_price row has a NULL derived_cost'
);
select is(
  (select (r ->> 'derived_cost')::numeric from _out
    where caller = 'postgres' and (r ->> 'row_id')::uuid = pg_temp.fid('L-A')),
  1.142857::numeric,
  '(11) a link''s derived cost uses its own case_price: round(40 / 35, 6)'
);


-- ═══ visibility ═════════════════════════════════════════════════════════════
select is(
  (select array_agg(lbl order by lbl)
     from _lab where caller = 'admin' and lbl <> '?'),
  array['I-A', 'I-D', 'I-G', 'L-A', 'L-D'],
  '(12) the brand-1 admin sees its own brand''s fixture rows'
);
select is(
  (select count(*)::int from _out
    where caller = 'admin'
      and ((r ->> 'store_id')::uuid not in (select id from public.stores
                                             where brand_id = '2a000000-0000-0000-0000-000000000001')
           or r ->> 'store_id' is null)),
  0,
  '(13) the brand-1 admin sees no row of another brand''s store'
);
select is(
  (select array_agg(lbl order by lbl)
     from _lab where caller = 'sa' and lbl <> '?'),
  array['I-A', 'I-D', 'I-G', 'I-Z', 'L-A', 'L-D', 'L-Z'],
  '(14) a super_admin sees both brands'
);
select is(
  (select count(*)::int from _out where caller = 'sa'),
  (select count(*)::int from _out where caller = 'postgres'),
  '(15) a super_admin sees the same rows as postgres'
);


-- ═══ read-only ══════════════════════════════════════════════════════════════
select is(
  (select count(*)::int from _ver v
    where v.ver is distinct from coalesce(
            (select xmin::text || '@' || ctid::text from public.inventory_items where id = v.id),
            (select xmin::text || '@' || ctid::text from public.item_vendors   where id = v.id))),
  0,
  '(16) no fixture row was written by any call (xmin and ctid unchanged)'
);
select is((select count(*)::int from _ver), 12, '(17) anti-vacuity: all 12 fixture rows were versioned');

select * from finish();
rollback;
