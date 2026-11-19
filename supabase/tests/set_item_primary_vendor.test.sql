-- supabase/tests/set_item_primary_vendor.test.sql
--
-- Spec 201 R7 — public.set_item_primary_vendor(uuid, uuid, date), the admin
-- "switch" on a reorder row (supabase/migrations/
-- 20261118120100_set_item_primary_vendor.sql, design §5).
--
-- Pins:
--   • posture — SECURITY INVOKER, search_path = public, anon has no EXECUTE,
--     authenticated has it;
--   • happy path — exactly one primary (the new vendor), this store's
--     inventory_items.vendor_id = the new vendor, the same catalog's row in
--     another store unchanged, vendor_changed_at stamped (spec 128);
--   • no-op — already primary → changed = false with no writes (no
--     updated_at bump on either table);
--   • 3c — item on a non-cancelled PO for (store, current primary, as-of
--     date) → P0001 with the exact stable string, nothing written;
--   • 3c does NOT block for a cancelled PO, a PO on D − 1, a PO for the new
--     vendor, or a PO for the current primary that lacks the item;
--   • refusals — vendor not linked (P0001), item not found (P0001),
--     role = user store member (42501, no write), null arguments (22023);
--   • authorization breadth (security-auditor follow-up) — a cross-brand
--     admin is refused as 'item not found' (RLS hides the row at step 3) with
--     no write; a super_admin (role from profiles.role, not the JWT)
--     succeeds. The cross-brand arm moves the seed admin (1111…) to a
--     test-only brand and drops its user_stores rows; the super_admin arm
--     promotes the seed master (3333…) — both rolled back with the test, same
--     pattern as auth_can_see_store_brand_scope.test.sql.
--
-- Fixture: fresh vendors A, B, Z (Z never linked); items at Frederick, all
-- vendor_id = A, linked A (primary) + B; a Charles row for F's catalog with
-- the same links. Timestamps are seeded at 2000-01-01 so a write (now()) is
-- distinguishable. D = 2001-08-06 (synthetic). Manager principal (2222…,
-- role = user, Frederick member) mirrors eod_no_need.test.sql; master
-- principal (3333…) mirrors the report suites. No `set role anon`.
-- Hermetic: begin; … rollback;.

begin;
create extension if not exists pgtap;

select plan(34);

-- ─── fixtures (as postgres) ─────────────────────────────────────
do $$
declare
  v_store   uuid;
  v_charles uuid;
  v_brand   uuid;
  v_a uuid; v_b uuid; v_z uuid;
  v_tag text := substr(gen_random_uuid()::text, 1, 8);
begin
  select id, brand_id into v_store, v_brand from public.stores where name = 'Frederick' limit 1;
  select id into v_charles from public.stores where name = 'Charles' limit 1;

  insert into public.vendors (name, brand_id) values ('SPEC201-SW-A-' || v_tag, v_brand) returning id into v_a;
  insert into public.vendors (name, brand_id) values ('SPEC201-SW-B-' || v_tag, v_brand) returning id into v_b;
  insert into public.vendors (name, brand_id) values ('SPEC201-SW-Z-' || v_tag, v_brand) returning id into v_z;

  perform set_config('test.master_id',  '33333333-3333-3333-3333-333333333333', true);
  perform set_config('test.manager_id', '22222222-2222-2222-2222-222222222222', true);
  perform set_config('test.store',   v_store::text, true);
  perform set_config('test.charles', v_charles::text, true);
  perform set_config('test.brand',   v_brand::text, true);
  perform set_config('test.tag',     v_tag, true);
  perform set_config('test.a', v_a::text, true);
  perform set_config('test.b', v_b::text, true);
  perform set_config('test.z', v_z::text, true);
  perform set_config('test.d', '2001-08-06', true);
end $$;

create temp table _cat on commit drop as
with ins as (
  insert into public.catalog_ingredients (brand_id, name, unit)
  select current_setting('test.brand', true)::uuid,
         'SPEC201SW-' || k || '-' || current_setting('test.tag', true),
         'each'
    from unnest(array['F','K','P','L1','L2','L3','L4']) as k
  returning id, name
)
select id, name, split_part(name, '-', 2) as kind from ins;

-- Frederick rows for every kind + a Charles row for F.
create temp table _items on commit drop as
with ins as (
  insert into public.inventory_items
    (store_id, catalog_id, vendor_id, cost_per_unit, current_stock, par_level,
     usage_per_portion, updated_at, vendor_changed_at)
  select s.store_id, c.id, current_setting('test.a', true)::uuid, 1, 2, 10, 0,
         '2000-01-01 00:00:00+00', '2000-01-01 00:00:00+00'
    from _cat c
    cross join lateral (
      select current_setting('test.store', true)::uuid as store_id
      union all
      select current_setting('test.charles', true)::uuid where c.kind = 'F'
    ) s
  returning id, catalog_id, store_id
)
select i.id, i.store_id, c.kind from ins i join _cat c on c.id = i.catalog_id;

do $$
declare r record;
begin
  for r in select id, kind from _items where store_id = current_setting('test.store', true)::uuid loop
    perform set_config('test.item_' || lower(r.kind), r.id::text, true);
  end loop;
  perform set_config('test.item_f_charles',
    (select id::text from _items where kind = 'F' and store_id = current_setting('test.charles', true)::uuid), true);
end $$;

insert into public.item_vendors (item_id, vendor_id, cost_per_unit, case_price, is_primary, updated_at)
select i.id, v.vendor_id, 1, 0, v.is_primary, '2000-01-01 00:00:00+00'
  from _items i
  cross join (values (current_setting('test.a', true)::uuid, true),
                     (current_setting('test.b', true)::uuid, false)) as v(vendor_id, is_primary);

-- Purchase orders (direct inserts; po_number is server-assigned).
--   PO1 (A, D, draft)      : P  + L4's sibling — the 3c blocker for P; also
--                            "a PO for A that lacks L4".
--   PO2 (A, D, cancelled)  : L1
--   PO3 (A, D − 1, sent)   : L2
--   PO4 (B, D, draft)      : L3
create temp table _pos on commit drop as
with ins as (
  insert into public.purchase_orders (store_id, vendor_id, status, reference_date)
  values
    (current_setting('test.store', true)::uuid, current_setting('test.a', true)::uuid, 'draft',     current_setting('test.d', true)::date),
    (current_setting('test.store', true)::uuid, current_setting('test.a', true)::uuid, 'cancelled', current_setting('test.d', true)::date),
    (current_setting('test.store', true)::uuid, current_setting('test.a', true)::uuid, 'sent',      current_setting('test.d', true)::date - 1),
    (current_setting('test.store', true)::uuid, current_setting('test.b', true)::uuid, 'draft',     current_setting('test.d', true)::date)
  returning id, vendor_id, status, reference_date
)
select * from ins;

insert into public.po_items (po_id, item_id, ordered_qty, cost_per_unit)
select (select id from _pos where status = 'draft' and vendor_id = current_setting('test.a', true)::uuid),
       current_setting('test.item_p', true)::uuid, 1, 1
union all
select (select id from _pos where status = 'cancelled'),
       current_setting('test.item_l1', true)::uuid, 1, 1
union all
select (select id from _pos where status = 'sent'),
       current_setting('test.item_l2', true)::uuid, 1, 1
union all
select (select id from _pos where status = 'draft' and vendor_id = current_setting('test.b', true)::uuid),
       current_setting('test.item_l3', true)::uuid, 1, 1;

-- ═══ posture ════════════════════════════════════════════════════
select is(
  (select count(*)::bigint from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'set_item_primary_vendor'),
  1::bigint,
  '(1) exactly one public.set_item_primary_vendor'
);
select ok(
  not (select prosecdef from pg_proc where oid = 'public.set_item_primary_vendor(uuid,uuid,date)'::regprocedure),
  '(2) set_item_primary_vendor is SECURITY INVOKER'
);
select is(
  (select proconfig from pg_proc where oid = 'public.set_item_primary_vendor(uuid,uuid,date)'::regprocedure),
  array['search_path=public']::text[],
  '(3) proconfig is {search_path=public}'
);
select ok(
  not has_function_privilege('anon', 'public.set_item_primary_vendor(uuid,uuid,date)', 'EXECUTE'),
  '(4) anon lacks EXECUTE'
);
select ok(
  has_function_privilege('authenticated', 'public.set_item_primary_vendor(uuid,uuid,date)', 'EXECUTE'),
  '(5) authenticated has EXECUTE'
);

-- ═══ role = user store member → 42501, no write ═════════════════
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
select throws_ok(
  format('select public.set_item_primary_vendor(%L::uuid, %L::uuid, %L::date)',
         current_setting('test.item_k', true), current_setting('test.b', true), current_setting('test.d', true)),
  '42501',
  'set_item_primary_vendor: privileged only',
  '(6) a role = user store member is refused (42501, privileged only)'
);
reset role;
select is(
  (select vendor_id::text from public.inventory_items where id = current_setting('test.item_k', true)::uuid),
  current_setting('test.a', true),
  '(7) … and nothing was written (K''s vendor_id is still A)'
);

-- ═══ master ═════════════════════════════════════════════════════
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

-- null arguments → 22023
select throws_ok(
  format('select public.set_item_primary_vendor(null, %L::uuid, %L::date)',
         current_setting('test.b', true), current_setting('test.d', true)),
  '22023',
  'set_item_primary_vendor: item_id, vendor_id and as_of_date are required',
  '(8) null item_id → 22023'
);
select throws_ok(
  format('select public.set_item_primary_vendor(%L::uuid, null, %L::date)',
         current_setting('test.item_k', true), current_setting('test.d', true)),
  '22023',
  'set_item_primary_vendor: item_id, vendor_id and as_of_date are required',
  '(9) null vendor_id → 22023'
);
select throws_ok(
  format('select public.set_item_primary_vendor(%L::uuid, %L::uuid, null)',
         current_setting('test.item_k', true), current_setting('test.b', true)),
  '22023',
  'set_item_primary_vendor: item_id, vendor_id and as_of_date are required',
  '(10) null as_of_date → 22023'
);

-- not found / not linked → P0001
select throws_ok(
  format('select public.set_item_primary_vendor(%L::uuid, %L::uuid, %L::date)',
         gen_random_uuid(), current_setting('test.b', true), current_setting('test.d', true)),
  'P0001',
  'set_item_primary_vendor: item not found',
  '(11) unknown item → P0001 item not found'
);
select throws_ok(
  format('select public.set_item_primary_vendor(%L::uuid, %L::uuid, %L::date)',
         current_setting('test.item_k', true), current_setting('test.z', true), current_setting('test.d', true)),
  'P0001',
  'set_item_primary_vendor: vendor is not linked to this item',
  '(12) vendor not linked → P0001'
);

-- happy path: F → B
create temp table _happy on commit drop as
select public.set_item_primary_vendor(current_setting('test.item_f', true)::uuid,
                                      current_setting('test.b', true)::uuid,
                                      current_setting('test.d', true)::date) as res;
reset role;

select is(
  (select res from _happy),
  jsonb_build_object('item_id', current_setting('test.item_f', true),
                     'store_id', current_setting('test.store', true),
                     'previous_vendor_id', current_setting('test.a', true),
                     'vendor_id', current_setting('test.b', true),
                     'changed', true),
  '(13) happy path returns {item_id, store_id, previous_vendor_id: A, vendor_id: B, changed: true}'
);
select is(
  (select array_agg(vendor_id::text) from public.item_vendors
    where item_id = current_setting('test.item_f', true)::uuid and is_primary),
  array[current_setting('test.b', true)],
  '(14) exactly one is_primary link for F, and it is B'
);
select is(
  (select vendor_id::text from public.inventory_items where id = current_setting('test.item_f', true)::uuid),
  current_setting('test.b', true),
  '(15) this store''s inventory_items.vendor_id is B'
);
select is(
  (select vendor_changed_at from public.inventory_items where id = current_setting('test.item_f', true)::uuid),
  now(),
  '(16) vendor_changed_at is stamped (spec 128)'
);
select is(
  (select jsonb_build_object('vendor_id', ii.vendor_id::text,
                             'primary', (select array_agg(iv.vendor_id::text) from public.item_vendors iv
                                          where iv.item_id = ii.id and iv.is_primary),
                             'updated_at', ii.updated_at)
     from public.inventory_items ii where ii.id = current_setting('test.item_f_charles', true)::uuid),
  jsonb_build_object('vendor_id', current_setting('test.a', true),
                     'primary', jsonb_build_array(current_setting('test.a', true)),
                     'updated_at', '2000-01-01 00:00:00+00'::timestamptz),
  '(17) the same catalog''s Charles row is untouched (vendor_id A, primary A)'
);

-- no-op: K is already on A
set local role authenticated;
create temp table _noop on commit drop as
select public.set_item_primary_vendor(current_setting('test.item_k', true)::uuid,
                                      current_setting('test.a', true)::uuid,
                                      current_setting('test.d', true)::date) as res;
reset role;
select is(
  (select (res->>'changed')::boolean from _noop),
  false,
  '(18) no-op: already primary → changed = false'
);
select is(
  (select updated_at from public.inventory_items where id = current_setting('test.item_k', true)::uuid),
  '2000-01-01 00:00:00+00'::timestamptz,
  '(19) no-op: inventory_items.updated_at not bumped'
);
select is(
  (select max(updated_at) from public.item_vendors where item_id = current_setting('test.item_k', true)::uuid),
  '2000-01-01 00:00:00+00'::timestamptz,
  '(20) no-op: item_vendors.updated_at not bumped'
);

-- 3c refused: P is on PO1 (A, D, draft)
set local role authenticated;
select throws_ok(
  format('select public.set_item_primary_vendor(%L::uuid, %L::uuid, %L::date)',
         current_setting('test.item_p', true), current_setting('test.b', true), current_setting('test.d', true)),
  'P0001',
  'set_item_primary_vendor: item is on an open order for the current primary vendor',
  '(21) 3c: item on a non-cancelled PO for (store, A, D) → P0001 with the exact string'
);
reset role;
select is(
  (select jsonb_build_object('vendor_id', ii.vendor_id::text,
                             'primary', (select array_agg(iv.vendor_id::text) from public.item_vendors iv
                                          where iv.item_id = ii.id and iv.is_primary))
     from public.inventory_items ii where ii.id = current_setting('test.item_p', true)::uuid),
  jsonb_build_object('vendor_id', current_setting('test.a', true),
                     'primary', jsonb_build_array(current_setting('test.a', true))),
  '(22) 3c: nothing written — P''s primary and vendor_id are both still A'
);

-- 3c does NOT block: L1 (cancelled), L2 (D − 1), L3 (PO for B), L4 (A's PO lacks it)
set local role authenticated;
select lives_ok(
  format('select public.set_item_primary_vendor(%L::uuid, %L::uuid, %L::date)',
         current_setting('test.item_l1', true), current_setting('test.b', true), current_setting('test.d', true)),
  '(23) 3c does not block for a CANCELLED PO'
);
select lives_ok(
  format('select public.set_item_primary_vendor(%L::uuid, %L::uuid, %L::date)',
         current_setting('test.item_l2', true), current_setting('test.b', true), current_setting('test.d', true)),
  '(24) 3c does not block for a PO on D − 1'
);
select lives_ok(
  format('select public.set_item_primary_vendor(%L::uuid, %L::uuid, %L::date)',
         current_setting('test.item_l3', true), current_setting('test.b', true), current_setting('test.d', true)),
  '(25) 3c does not block for a PO for the NEW vendor (B)'
);
select lives_ok(
  format('select public.set_item_primary_vendor(%L::uuid, %L::uuid, %L::date)',
         current_setting('test.item_l4', true), current_setting('test.b', true), current_setting('test.d', true)),
  '(26) 3c does not block for a PO for A that lacks the item'
);
reset role;
select is(
  (select count(*)::bigint from public.inventory_items
    where id in (current_setting('test.item_l1', true)::uuid, current_setting('test.item_l2', true)::uuid,
                 current_setting('test.item_l3', true)::uuid, current_setting('test.item_l4', true)::uuid)
      and vendor_id = current_setting('test.b', true)::uuid),
  4::bigint,
  '(27) all four non-blocked switches wrote vendor_id = B'
);
select is(
  (select count(*)::bigint from public.item_vendors
    where item_id in (current_setting('test.item_l1', true)::uuid, current_setting('test.item_l2', true)::uuid,
                      current_setting('test.item_l3', true)::uuid, current_setting('test.item_l4', true)::uuid)
      and is_primary and vendor_id = current_setting('test.b', true)::uuid),
  4::bigint,
  '(28) … and exactly B is primary on each'
);
select is(
  (select count(*)::bigint from public.item_vendors
    where item_id in (current_setting('test.item_l1', true)::uuid, current_setting('test.item_l2', true)::uuid,
                      current_setting('test.item_l3', true)::uuid, current_setting('test.item_l4', true)::uuid)
      and is_primary),
  4::bigint,
  '(29) … with no second primary left behind (demote-first)'
);

-- Switching back is symmetric (B → A on F) and leaves one primary.
set local role authenticated;
select is(
  (select (public.set_item_primary_vendor(current_setting('test.item_f', true)::uuid,
                                          current_setting('test.a', true)::uuid,
                                          current_setting('test.d', true)::date)->>'previous_vendor_id')),
  current_setting('test.b', true),
  '(30) switching back reports previous_vendor_id = B'
);
reset role;

-- ═══ cross-brand admin → 'item not found', no write ═════════════
insert into public.brands (id, name)
values ('b2010000-0000-4000-8000-000000000201', 'Foreign Brand (test 201)')
on conflict (id) do nothing;
delete from public.user_stores where user_id = '11111111-1111-1111-1111-111111111111';
update public.profiles
   set brand_id = 'b2010000-0000-4000-8000-000000000201'
 where id = '11111111-1111-1111-1111-111111111111';

set local role authenticated;
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub',           '11111111-1111-1111-1111-111111111111',
    'role',          'authenticated',
    'app_metadata',  jsonb_build_object('role', 'admin')
  )::text,
  true
);
select throws_ok(
  format('select public.set_item_primary_vendor(%L::uuid, %L::uuid, %L::date)',
         current_setting('test.item_f', true), current_setting('test.b', true), current_setting('test.d', true)),
  'P0001',
  'set_item_primary_vendor: item not found',
  '(31) a cross-brand admin is refused (P0001 item not found — RLS hides the row)'
);
reset role;
select is(
  (select jsonb_build_object('vendor_id', ii.vendor_id::text,
                             'primary', (select array_agg(iv.vendor_id::text) from public.item_vendors iv
                                          where iv.item_id = ii.id and iv.is_primary))
     from public.inventory_items ii where ii.id = current_setting('test.item_f', true)::uuid),
  jsonb_build_object('vendor_id', current_setting('test.a', true),
                     'primary', jsonb_build_array(current_setting('test.a', true))),
  '(32) … and nothing was written (F''s vendor_id and primary are still A)'
);

-- ═══ super_admin (profiles.role) → succeeds ═════════════════════
update public.profiles
   set role = 'super_admin', brand_id = null
 where id = current_setting('test.master_id', true)::uuid;

set local role authenticated;
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub',           current_setting('test.master_id', true),
    'role',          'authenticated',
    'app_metadata',  jsonb_build_object('role', 'super_admin')
  )::text,
  true
);
select lives_ok(
  format('select public.set_item_primary_vendor(%L::uuid, %L::uuid, %L::date)',
         current_setting('test.item_k', true), current_setting('test.b', true), current_setting('test.d', true)),
  '(33) a super_admin (role from profiles.role, JWT role not admin/master) can switch'
);
reset role;
select is(
  (select jsonb_build_object('vendor_id', ii.vendor_id::text,
                             'primary', (select array_agg(iv.vendor_id::text) from public.item_vendors iv
                                          where iv.item_id = ii.id and iv.is_primary))
     from public.inventory_items ii where ii.id = current_setting('test.item_k', true)::uuid),
  jsonb_build_object('vendor_id', current_setting('test.b', true),
                     'primary', jsonb_build_array(current_setting('test.b', true))),
  '(34) … K''s vendor_id and single primary are now B'
);

select * from finish();
rollback;
