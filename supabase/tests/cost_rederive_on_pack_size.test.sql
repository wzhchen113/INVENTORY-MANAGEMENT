-- supabase/tests/cost_rederive_on_pack_size.test.sql
--
-- Spec 207 — pgTAP coverage for
-- supabase/migrations/20261123130000_recompute_costs_on_pack_size_change.sql
-- (design D-9): the pieces_per_case / per_each_cost helpers, the R3
-- derive-on-write triggers on inventory_items and item_vendors, the R1
-- re-derive trigger on catalog_ingredients, and the receive_purchase_order
-- one-line hunk. AC-10 (list_cost_drift) lives in list_cost_drift.test.sql.
--
-- Fixtures are created as postgres inside the transaction; actions run as the
-- seed brand admin (11111111-…, role admin, brand 2AM) through
-- `set local role authenticated` + request.jwt.claims. No `set role anon`
-- (segfaults CI per spec 067). Hermetic: begin; … rollback;.
--
-- DETECTING WRITES. now() is frozen for the whole transaction, so updated_at
-- cannot show a write, and a row inserted and updated in the SAME transaction
-- keeps the same xmin. Every action under test therefore runs inside its own
-- SAVEPOINT: a row written there gets the subtransaction's xid as its xmin.
-- pg_temp.ver() reads xmin together with ctid (any UPDATE makes a new tuple
-- version, so ctid moves too). "Unchanged ver" = the row was not written.
--
-- Store indexes used by the id helpers: 1 = Towson (A), 2 = Charles (B),
-- 3 = a fresh brand-2 store (Z), 4 = Frederick, 5 = Reisters.
--
-- Catalog rows (all brand 2AM unless noted):
--   C1 (1×1)  AC-1 / AC-3 / AC-6 / AC-11  case_qty 1 → 2
--   C2 (1×1)  AC-2                        sub_unit_size 1 → 35 (+ reorder)
--   C4 (1×1)  AC-4 end-to-end             case_qty 1 → 0 → NULL → 2 → 0
--   C5 (2×3)  AC-5 no-op edits
--   C7 (1×1)  AC-7 unpriced scaling       sub_unit_size 1 → 35 → 1
--   C8 (2×3)  AC-8 derive on write        pieces 6
--   C9 (3×1)  AC-9 receiving              pieces 3
--   C10 (0×1) AC-9 receiving, case_qty 0  pieces 1
--   C11 (1×35) R1 brand scope: a planted brand-2 row cannot block the edit
--   C20 (12×1, brand 2) R3 INVOKER no-leak probe

begin;
create extension if not exists pgtap;

select plan(65);

-- ─── helpers ────────────────────────────────────────────────────────────────
create function pg_temp.cid(n int) returns uuid language sql immutable as
  $$ select ('20700000-0000-0000-0001-' || lpad(n::text, 12, '0'))::uuid $$;
create function pg_temp.iid(c int, s int) returns uuid language sql immutable as
  $$ select ('20700000-0000-0000-0002-' || lpad((c * 10 + s)::text, 12, '0'))::uuid $$;
create function pg_temp.lid(c int, s int, v int) returns uuid language sql immutable as
  $$ select ('20700000-0000-0000-0003-' || lpad((c * 100 + s * 10 + v)::text, 12, '0'))::uuid $$;
create function pg_temp.vid(v int) returns uuid language sql immutable as
  $$ select ('20700000-0000-0000-0004-' || lpad(v::text, 12, '0'))::uuid $$;
create function pg_temp.sid(s int) returns uuid language sql stable as
  $$ select current_setting('t.store' || s)::uuid $$;

create function pg_temp.claims(p_sub text, p_role text) returns text
language sql as $$
  select set_config('request.jwt.claims', jsonb_build_object(
           'sub', p_sub, 'role', 'authenticated',
           'app_metadata', jsonb_build_object('role', p_role))::text, true)
$$;

-- Row version: xmin + ctid. Read as postgres (no RLS).
create function pg_temp.ver(p_table text, p_id uuid) returns text
language plpgsql as $$
declare r text;
begin
  execute format('select xmin::text || ''@'' || ctid::text from public.%I where id = $1', p_table)
     into r using p_id;
  return r;
end $$;

create function pg_temp.cost(p_table text, p_id uuid) returns numeric
language plpgsql as $$
declare r numeric;
begin
  execute format('select cost_per_unit from public.%I where id = $1', p_table)
     into r using p_id;
  return r;
end $$;

-- Snapshot table: (tag, table, id) → version, cost, updated_at.
create temp table _snap (tag text, tbl text, id uuid, ver text, cost numeric, upd timestamptz);
create function pg_temp.snap(p_tag text, p_ids uuid[]) returns void
language plpgsql as $$
begin
  insert into _snap
  select p_tag, 'inventory_items', ii.id, pg_temp.ver('inventory_items', ii.id), ii.cost_per_unit, ii.updated_at
    from public.inventory_items ii where ii.id = any (p_ids)
  union all
  select p_tag, 'item_vendors', iv.id, pg_temp.ver('item_vendors', iv.id), iv.cost_per_unit, iv.updated_at
    from public.item_vendors iv where iv.id = any (p_ids);
end $$;
-- How many snapshotted rows of p_tag differ now (version, cost or updated_at).
create function pg_temp.changed(p_tag text) returns int
language sql as $$
  select count(*)::int from _snap s
   where s.tag = p_tag
     and (s.ver  is distinct from pg_temp.ver(s.tbl, s.id)
       or s.cost is distinct from pg_temp.cost(s.tbl, s.id)
       or s.upd  is distinct from (select coalesce(
              (select updated_at from public.inventory_items where id = s.id),
              (select updated_at from public.item_vendors   where id = s.id))))
$$;

-- ─── fixtures (postgres) ────────────────────────────────────────────────────
do $$
begin
  perform set_config('t.brand1', '2a000000-0000-0000-0000-000000000001', true);
  perform set_config('t.brand2', '20700000-0000-0000-0000-00000000b002', true);
  perform set_config('t.store1', (select id::text from public.stores where name = 'Towson'    limit 1), true);
  perform set_config('t.store2', (select id::text from public.stores where name = 'Charles'   limit 1), true);
  perform set_config('t.store3', '20700000-0000-0000-0000-00000000c003', true);
  perform set_config('t.store4', (select id::text from public.stores where name = 'Frederick' limit 1), true);
  perform set_config('t.store5', (select id::text from public.stores where name = 'Reisters'  limit 1), true);
  perform set_config('t.admin',  '11111111-1111-1111-1111-111111111111', true);
end $$;

insert into public.brands (id, name) values (current_setting('t.brand2')::uuid, '__s207_brand2__');
insert into public.stores (id, brand_id, name, address)
values (pg_temp.sid(3), current_setting('t.brand2')::uuid, '__s207_store_z__', '207 Fixture Way');

insert into public.vendors (id, brand_id, name) values
  (pg_temp.vid(1), current_setting('t.brand1')::uuid, '__s207_v1__'),
  (pg_temp.vid(2), current_setting('t.brand1')::uuid, '__s207_v2__'),
  (pg_temp.vid(3), current_setting('t.brand2')::uuid, '__s207_v3_brand2__');

insert into public.catalog_ingredients (id, brand_id, name, unit, case_qty, sub_unit_size) values
  (pg_temp.cid(1),  current_setting('t.brand1')::uuid, '__s207_c1__',  'each', 1, 1),
  (pg_temp.cid(2),  current_setting('t.brand1')::uuid, '__s207_c2__',  'each', 1, 1),
  (pg_temp.cid(4),  current_setting('t.brand1')::uuid, '__s207_c4__',  'each', 1, 1),
  (pg_temp.cid(5),  current_setting('t.brand1')::uuid, '__s207_c5__',  'each', 2, 3),
  (pg_temp.cid(7),  current_setting('t.brand1')::uuid, '__s207_c7__',  'each', 1, 1),
  (pg_temp.cid(8),  current_setting('t.brand1')::uuid, '__s207_c8__',  'each', 2, 3),
  (pg_temp.cid(9),  current_setting('t.brand1')::uuid, '__s207_c9__',  'each', 3, 1),
  (pg_temp.cid(10), current_setting('t.brand1')::uuid, '__s207_c10__', 'each', 0, 1),
  (pg_temp.cid(11), current_setting('t.brand1')::uuid, '__s207_c11__', 'each', 1, 35);

-- Items (case_price, cost_per_unit as SENT; R3 derives priced rows on insert).
insert into public.inventory_items
  (id, store_id, catalog_id, vendor_id, case_price, cost_per_unit, current_stock, par_level)
values
  -- C1: A, B, Z (brand-2 store) all priced 33.95 at pieces 1.
  (pg_temp.iid(1,1), pg_temp.sid(1), pg_temp.cid(1), pg_temp.vid(1), 33.95, 33.95, 0, 0),
  (pg_temp.iid(1,2), pg_temp.sid(2), pg_temp.cid(1), pg_temp.vid(1), 33.95, 33.95, 0, 0),
  (pg_temp.iid(1,3), pg_temp.sid(3), pg_temp.cid(1), null,           33.95, 33.95, 0, 0),
  -- C2: A, B priced 33.95; B has par 3 / stock 0 for the reorder check.
  (pg_temp.iid(2,1), pg_temp.sid(1), pg_temp.cid(2), pg_temp.vid(1), 33.95, 33.95, 0, 0),
  (pg_temp.iid(2,2), pg_temp.sid(2), pg_temp.cid(2), pg_temp.vid(1), 33.95, 33.95, 0, 3),
  -- C4: A priced 30; B unpriced 0.5.
  (pg_temp.iid(4,1), pg_temp.sid(1), pg_temp.cid(4), null, 30, 30, 0, 0),
  (pg_temp.iid(4,2), pg_temp.sid(2), pg_temp.cid(4), null, 0, 0.5, 0, 0),
  -- C5 (pieces 6): A priced 30 (→ 5); B unpriced 0.5.
  (pg_temp.iid(5,1), pg_temp.sid(1), pg_temp.cid(5), pg_temp.vid(1), 30, 30, 0, 0),
  (pg_temp.iid(5,2), pg_temp.sid(2), pg_temp.cid(5), pg_temp.vid(1), 0, 0.5, 0, 0),
  -- C7: A unpriced 0.5; B unpriced 0.
  (pg_temp.iid(7,1), pg_temp.sid(1), pg_temp.cid(7), pg_temp.vid(1), 0, 0.5, 0, 0),
  (pg_temp.iid(7,2), pg_temp.sid(2), pg_temp.cid(7), pg_temp.vid(1), 0, 0,   0, 0),
  -- C9 (pieces 3) and C10 (case_qty 0): A priced 20, stock 10.
  (pg_temp.iid(9,1),  pg_temp.sid(1), pg_temp.cid(9),  pg_temp.vid(1), 20, 20, 10, 0),
  (pg_temp.iid(10,1), pg_temp.sid(1), pg_temp.cid(10), pg_temp.vid(1), 20, 20, 10, 0),
  -- C11 (pieces 35): A priced 30 (→ 0.857143); a PLANTED brand-2 row at store
  -- Z pointing at the brand-1 catalog row (the FU-3 insert gap), unpriced with
  -- the largest numeric(12,6) cost. Scaling it by 35 / 1 would overflow.
  (pg_temp.iid(11,1), pg_temp.sid(1), pg_temp.cid(11), pg_temp.vid(1), 30, 30, 0, 0),
  (pg_temp.iid(11,3), pg_temp.sid(3), pg_temp.cid(11), null, 0, 999999.999999, 0, 0);

insert into public.item_vendors (id, item_id, vendor_id, case_price, cost_per_unit, is_primary) values
  (pg_temp.lid(1,1,1), pg_temp.iid(1,1), pg_temp.vid(1), 33.95, 33.95, true),
  (pg_temp.lid(1,1,2), pg_temp.iid(1,1), pg_temp.vid(2), 40,    40,    false),   -- AC-3
  (pg_temp.lid(1,2,1), pg_temp.iid(1,2), pg_temp.vid(1), 33.95, 33.95, true),
  (pg_temp.lid(1,3,3), pg_temp.iid(1,3), pg_temp.vid(3), 33.95, 33.95, true),    -- AC-6 (brand-2 link)
  (pg_temp.lid(2,1,1), pg_temp.iid(2,1), pg_temp.vid(1), 33.95, 33.95, true),
  (pg_temp.lid(2,2,1), pg_temp.iid(2,2), pg_temp.vid(1), 33.95, 33.95, true),
  (pg_temp.lid(5,1,1), pg_temp.iid(5,1), pg_temp.vid(1), 30,    30,    true),
  (pg_temp.lid(5,2,1), pg_temp.iid(5,2), pg_temp.vid(1), 0,     0.5,   true),
  (pg_temp.lid(7,1,1), pg_temp.iid(7,1), pg_temp.vid(1), 0,     0.5,   true),
  (pg_temp.lid(7,2,1), pg_temp.iid(7,2), pg_temp.vid(1), 0,     0,     true),
  (pg_temp.lid(9,1,1),  pg_temp.iid(9,1),  pg_temp.vid(1), 20, 20, true),
  (pg_temp.lid(10,1,1), pg_temp.iid(10,1), pg_temp.vid(1), 20, 20, true);

-- AC-11 history rows for C1 at A, and the AC-9 POs.
insert into public.purchase_orders (id, store_id, vendor_id, created_by, status) values
  ('20700000-0000-0000-0005-000000000011', pg_temp.sid(1), pg_temp.vid(1), current_setting('t.admin')::uuid, 'sent'),
  ('20700000-0000-0000-0005-000000000091', pg_temp.sid(1), pg_temp.vid(1), current_setting('t.admin')::uuid, 'sent'),
  ('20700000-0000-0000-0005-000000000101', pg_temp.sid(1), pg_temp.vid(1), current_setting('t.admin')::uuid, 'sent');
insert into public.po_items (id, po_id, item_id, ordered_qty, received_qty, cost_per_unit) values
  ('20700000-0000-0000-0006-000000000011', '20700000-0000-0000-0005-000000000011', pg_temp.iid(1,1), 3, null, 33.95),
  ('20700000-0000-0000-0006-000000000091', '20700000-0000-0000-0005-000000000091', pg_temp.iid(9,1), 1, null, 20),
  ('20700000-0000-0000-0006-000000000101', '20700000-0000-0000-0005-000000000101', pg_temp.iid(10,1), 1, null, 20);
insert into public.waste_log (id, store_id, item_id, quantity, unit, cost_per_unit, reason) values
  ('20700000-0000-0000-0007-000000000011', pg_temp.sid(1), pg_temp.iid(1,1), 1, 'each', 33.95, '__s207__');

create temp table _hist as
select 'po_items'::text as tbl, id, xmin::text || '@' || ctid::text as ver, cost_per_unit
  from public.po_items where id = '20700000-0000-0000-0006-000000000011'
union all
select 'waste_log', id, xmin::text || '@' || ctid::text, cost_per_unit
  from public.waste_log where id = '20700000-0000-0000-0007-000000000011';


-- ═══════════════════════════════════════════════════════════════════════════
-- Structure (D-9 "Structure" row, D-7 pre-checks)
-- ═══════════════════════════════════════════════════════════════════════════

-- S1 helpers: IMMUTABLE, search_path '' (both).
select is(
  (select count(*)::int from pg_proc
    where oid in ('public.pieces_per_case(numeric,numeric)'::regprocedure,
                  'public.per_each_cost(numeric,numeric,numeric)'::regprocedure)
      and provolatile = 'i' and not prosecdef
      and 'search_path=""' = any (proconfig)),
  2,
  'S1 both helpers exist, IMMUTABLE, SECURITY INVOKER, search_path pinned to empty'
);

-- S2 R3 inventory_items trigger.
select ok(
  (select tgenabled = 'O' and tgtype = 23
          and tgfoid = 'public.inventory_items_derive_cost()'::regprocedure
          and pg_get_triggerdef(oid) like '%BEFORE INSERT OR UPDATE OF case_price, cost_per_unit, catalog_id ON public.inventory_items FOR EACH ROW WHEN ((new.case_price > (0)::numeric))%'
          and tgqual is not null
     from pg_trigger
    where tgrelid = 'public.inventory_items'::regclass and tgname = 'zz_derive_cost_per_unit_trg'),
  'S2 R3 trigger on inventory_items: enabled, BEFORE ROW INSERT/UPDATE OF case_price, cost_per_unit, catalog_id, WHEN case_price > 0'
);

-- S3 R3 item_vendors trigger.
select ok(
  (select tgenabled = 'O' and tgtype = 23
          and tgfoid = 'public.item_vendors_derive_cost()'::regprocedure
          and pg_get_triggerdef(oid) like '%BEFORE INSERT OR UPDATE OF case_price, cost_per_unit, item_id ON public.item_vendors FOR EACH ROW WHEN ((new.case_price > (0)::numeric))%'
     from pg_trigger
    where tgrelid = 'public.item_vendors'::regclass and tgname = 'zz_derive_cost_per_unit_trg'),
  'S3 R3 trigger on item_vendors: enabled, BEFORE ROW INSERT/UPDATE OF case_price, cost_per_unit, item_id, WHEN case_price > 0'
);

-- S4 R1 trigger: AFTER ROW UPDATE OF case_qty, sub_unit_size, no WHEN.
select ok(
  (select tgenabled = 'O' and tgtype = 17 and tgqual is null
          and tgfoid = 'public.catalog_ingredients_rederive_item_costs()'::regprocedure
          and pg_get_triggerdef(oid) like '%AFTER UPDATE OF case_qty, sub_unit_size ON public.catalog_ingredients FOR EACH ROW EXECUTE FUNCTION%'
     from pg_trigger
    where tgrelid = 'public.catalog_ingredients'::regclass
      and tgname = 'catalog_ingredients_rederive_item_costs_trg'),
  'S4 R1 trigger on catalog_ingredients: enabled, AFTER ROW UPDATE OF case_qty, sub_unit_size, no WHEN clause'
);

-- S5 DEFINER only on R1; search_path '' on all three trigger functions.
select is(
  (select string_agg(proname || ':' || prosecdef::text, ',' order by proname)
     from pg_proc
    where oid in ('public.inventory_items_derive_cost()'::regprocedure,
                  'public.item_vendors_derive_cost()'::regprocedure,
                  'public.catalog_ingredients_rederive_item_costs()'::regprocedure)
      and 'search_path=""' = any (proconfig)),
  'catalog_ingredients_rederive_item_costs:true,inventory_items_derive_cost:false,item_vendors_derive_cost:false',
  'S5 R1 function is SECURITY DEFINER, the R3 functions are INVOKER; all three pin search_path to empty'
);

-- S6 trigger functions: no EXECUTE for anon, authenticated or PUBLIC.
select is(
  (select count(*)::int
     from unnest(array['public.inventory_items_derive_cost()',
                       'public.item_vendors_derive_cost()',
                       'public.catalog_ingredients_rederive_item_costs()']) f,
          unnest(array['anon', 'authenticated', 'public']) r
    where has_function_privilege(r, f, 'EXECUTE')),
  0,
  'S6 no trigger function is executable by anon, authenticated or PUBLIC'
);

-- S7 helpers: executable by anon and authenticated.
select ok(
  has_function_privilege('anon', 'public.pieces_per_case(numeric,numeric)', 'EXECUTE')
  and has_function_privilege('anon', 'public.per_each_cost(numeric,numeric,numeric)', 'EXECUTE')
  and has_function_privilege('authenticated', 'public.pieces_per_case(numeric,numeric)', 'EXECUTE')
  and has_function_privilege('authenticated', 'public.per_each_cost(numeric,numeric,numeric)', 'EXECUTE'),
  'S7 both helpers are executable by anon and authenticated'
);

-- S8 D-7: no FORCE RLS, and the R1 function owner owns all three tables.
select ok(
  (select bool_and(not c.relforcerowsecurity)
          and bool_and(c.relowner = (select proowner from pg_proc
                                      where oid = 'public.catalog_ingredients_rederive_item_costs()'::regprocedure))
          and count(*) = 3
     from pg_class c
    where c.oid in ('public.inventory_items'::regclass, 'public.item_vendors'::regclass,
                    'public.catalog_ingredients'::regclass)),
  'S8 D-7 relforcerowsecurity is false on all three tables and the R1 definer owns them'
);


-- ═══════════════════════════════════════════════════════════════════════════
-- AC-4 helper matrix (mirrors src/utils/perEachCost.spec207.test.ts)
-- ═══════════════════════════════════════════════════════════════════════════
create temp table _m (q numeric, s numeric, pieces numeric, cost30 numeric);
insert into _m values
  (null, null, 1,  30.000000), (null, 0, 1,  30.000000), (null, 35, 35, 0.857143),
  (0,    null, 1,  30.000000), (0,    0, 1,  30.000000), (0,    35, 35, 0.857143),
  (-1,   null, 1,  30.000000), (-1,   0, 1,  30.000000), (-1,   35, 35, 0.857143),
  (2,    null, 2,  15.000000), (2,    0, 2,  15.000000), (2,    35, 70, 0.428571);

select is(
  (select count(*)::int from _m where public.pieces_per_case(q, s) is distinct from pieces),
  0,
  'AC-4 pieces_per_case matches piecesPerCase for q in {NULL,0,-1,2} x s in {NULL,0,35}'
);
select is(
  (select count(*)::int from _m where public.per_each_cost(30, q, s) is distinct from cost30),
  0,
  'AC-4 per_each_cost(30, q, s) = round(30 / pieces, 6) for the same 12 inputs'
);
select is(
  array[public.pieces_per_case('Infinity', 2), public.pieces_per_case('NaN', 2),
        public.pieces_per_case(2, '-Infinity')],
  array[2, 2, 2]::numeric[],
  'AC-4 non-finite factors count as 1 (Number.isFinite mirror)'
);
select ok(
  public.per_each_cost(0, 2, 3) is null and public.per_each_cost(null, 2, 3) is null
  and public.per_each_cost(-5, 2, 3) is null,
  'AC-4 per_each_cost is NULL for an unpriced input (0, NULL, negative)'
);


-- ═══════════════════════════════════════════════════════════════════════════
-- AC-1 / AC-3 / AC-6 / AC-11 — C1 case_qty 1 → 2 by the brand admin
-- ═══════════════════════════════════════════════════════════════════════════
select pg_temp.snap('c1', array[pg_temp.iid(1,2)]);
select pg_temp.snap('z',  array[pg_temp.iid(1,3), pg_temp.lid(1,3,3)]);

set local role authenticated;
select pg_temp.claims(current_setting('t.admin'), 'admin');

-- AC-6 anti-vacuity: the admin cannot see store Z, can see store B.
select ok(
  not public.auth_can_see_store(pg_temp.sid(3)) and public.auth_can_see_store(pg_temp.sid(2)),
  'AC-6 anti-vacuity: the brand-1 admin cannot see the brand-2 store Z but can see store B'
);

savepoint c1;
update public.catalog_ingredients set case_qty = 2 where id = pg_temp.cid(1);
release savepoint c1;
reset role;

select is(
  (select case_qty from public.catalog_ingredients where id = pg_temp.cid(1)),
  2::numeric,
  'AC-1 anti-vacuity: the admin''s catalog UPDATE landed'
);
select is(
  array[pg_temp.cost('inventory_items', pg_temp.iid(1,1)),
        pg_temp.cost('inventory_items', pg_temp.iid(1,2)),
        pg_temp.cost('item_vendors',    pg_temp.lid(1,1,1)),
        pg_temp.cost('item_vendors',    pg_temp.lid(1,2,1))],
  array[16.975000, 16.975000, 16.975000, 16.975000]::numeric[],
  'AC-1 store A and B items and links all read 16.975000 after case_qty 1 → 2'
);
select isnt(
  (select ver from _snap where tag = 'c1' and id = pg_temp.iid(1,2)),
  pg_temp.ver('inventory_items', pg_temp.iid(1,2)),
  'AC-1 store B''s row was written although only the catalog row was updated'
);
select is(
  pg_temp.cost('item_vendors', pg_temp.lid(1,1,2)),
  20.000000::numeric,
  'AC-3 the V2 link re-derives from its OWN case_price: round(40 / 2, 6) = 20, not 33.95 / 2'
);

-- AC-6: the D-4 finding. Under the current role model no privileged caller who
-- can UPDATE a catalog row is unable to see a SAME-brand store:
-- auth_is_privileged() is admin (JWT) OR super_admin; the update policy also
-- requires auth_can_see_brand(catalog.brand_id), so the caller's profile brand
-- is the catalog's brand; auth_can_see_store arm (ii) then admits every store
-- of that brand, and super_admin sees everything. So "every store of the brand"
-- is checked with the brand-1 stores A and B above (AC-1). The CROSS-brand row
-- at store Z (brand 2, carrying brand 1's catalog_id through the FU-3 insert
-- gap, plus its brand-2 link) pins that the DEFINER fan-out stays INSIDE the
-- catalog's brand: R1 never touches it (spec 207 security review, Medium).
select is(
  array[pg_temp.cost('inventory_items', pg_temp.iid(1,3)), pg_temp.cost('item_vendors', pg_temp.lid(1,3,3))],
  array[33.950000, 33.950000]::numeric[],
  'AC-6 the brand-2 store Z item and link keep 33.95: R1 does not cross the brand boundary'
);
select is(pg_temp.changed('z'), 0,
  'AC-6 the brand-2 store Z item and link were not written (xmin, cost, updated_at unchanged)');

-- AC-11: history untouched.
select is(
  (select count(*)::int from _hist h
    where h.ver is distinct from (select xmin::text || '@' || ctid::text from public.po_items  where id = h.id)
                            and h.tbl = 'po_items'
       or h.ver is distinct from (select xmin::text || '@' || ctid::text from public.waste_log where id = h.id)
                            and h.tbl = 'waste_log'),
  0,
  'AC-11 po_items and waste_log rows for the item were not written'
);
select is(
  array[(select cost_per_unit from public.po_items  where id = '20700000-0000-0000-0006-000000000011'),
        (select cost_per_unit from public.waste_log where id = '20700000-0000-0000-0007-000000000011')],
  array[33.95, 33.95]::numeric[],
  'AC-11 po_items.cost_per_unit and waste_log.cost_per_unit keep 33.95'
);


-- ═══════════════════════════════════════════════════════════════════════════
-- AC-2 — C2 sub_unit_size 1 → 35 (the Fry Oil case) + reorder at store B
-- ═══════════════════════════════════════════════════════════════════════════
set local role authenticated;
select pg_temp.claims(current_setting('t.admin'), 'admin');
savepoint c2;
update public.catalog_ingredients set sub_unit_size = 35 where id = pg_temp.cid(2);
release savepoint c2;
reset role;

select is(
  array[pg_temp.cost('inventory_items', pg_temp.iid(2,1)),
        pg_temp.cost('inventory_items', pg_temp.iid(2,2)),
        pg_temp.cost('item_vendors',    pg_temp.lid(2,1,1)),
        pg_temp.cost('item_vendors',    pg_temp.lid(2,2,1))],
  array[0.970000, 0.970000, 0.970000, 0.970000]::numeric[],
  'AC-2 all four rows read round(33.95 / 35, 6) = 0.970000'
);

set local role authenticated;
select pg_temp.claims(current_setting('t.admin'), 'admin');
create temp table _reorder as
select i as item
  from jsonb_array_elements(public.report_reorder_list(pg_temp.sid(2), '{}'::jsonb) -> 'vendors') v,
       jsonb_array_elements(v -> 'items') i
 where v ->> 'vendor_id' = pg_temp.vid(1)::text
   and i ->> 'item_id' = pg_temp.iid(2,2)::text;
reset role;

select is(
  (select (item ->> 'suggested_qty')::numeric from _reorder),
  3::numeric,
  'AC-2 anti-vacuity: store B''s reorder suggests 3 (par 3, stock 0) on V1''s card'
);
select ok(
  (select abs((item ->> 'estimated_cost')::numeric - 101.85) < 0.01 from _reorder),
  'AC-2 a 3-case suggestion costs 101.85 (3 x 33.95), not 3,564.75'
);


-- ═══════════════════════════════════════════════════════════════════════════
-- AC-4 end-to-end — C4: case_qty 1 → 0 → NULL (no-ops), → 2, → 0 (as if 1)
-- ═══════════════════════════════════════════════════════════════════════════
select pg_temp.snap('c4', array[pg_temp.iid(4,1), pg_temp.iid(4,2)]);
set local role authenticated;
select pg_temp.claims(current_setting('t.admin'), 'admin');
savepoint c4a;
update public.catalog_ingredients set case_qty = 0    where id = pg_temp.cid(4);
update public.catalog_ingredients set case_qty = null where id = pg_temp.cid(4);
release savepoint c4a;
reset role;

select is(pg_temp.changed('c4'), 0,
  'AC-4 case_qty 1 → 0 → NULL keeps pieces at 1: no child row is written');

set local role authenticated;
select pg_temp.claims(current_setting('t.admin'), 'admin');
savepoint c4b;
update public.catalog_ingredients set case_qty = 2 where id = pg_temp.cid(4);
release savepoint c4b;
reset role;
select is(
  array[pg_temp.cost('inventory_items', pg_temp.iid(4,1)), pg_temp.cost('inventory_items', pg_temp.iid(4,2))],
  array[15.000000, 0.250000]::numeric[],
  'AC-4 NULL → 2 re-derives: priced 30 / 2 = 15; unpriced 0.5 x 1 / 2 = 0.25'
);

set local role authenticated;
select pg_temp.claims(current_setting('t.admin'), 'admin');
savepoint c4c;
update public.catalog_ingredients set case_qty = 0 where id = pg_temp.cid(4);
release savepoint c4c;
reset role;
select is(
  array[pg_temp.cost('inventory_items', pg_temp.iid(4,1)), pg_temp.cost('inventory_items', pg_temp.iid(4,2))],
  array[30.000000, 0.500000]::numeric[],
  'AC-4 2 → 0 re-derives as if case_qty = 1: priced 30; unpriced 0.25 x 2 / 1 = 0.5'
);


-- ═══════════════════════════════════════════════════════════════════════════
-- AC-5 — C5 (2×3): edits that leave effective pieces unchanged write nothing
-- ═══════════════════════════════════════════════════════════════════════════
select is(
  array[pg_temp.cost('inventory_items', pg_temp.iid(5,1)), pg_temp.cost('item_vendors', pg_temp.lid(5,1,1)),
        pg_temp.cost('inventory_items', pg_temp.iid(5,2)), pg_temp.cost('item_vendors', pg_temp.lid(5,2,1))],
  array[5.000000, 5.000000, 0.500000, 0.500000]::numeric[],
  'AC-5 fixture: priced rows derived to 30 / 6 = 5 on insert; unpriced rows keep 0.5'
);
select pg_temp.snap('c5', array[pg_temp.iid(5,1), pg_temp.iid(5,2), pg_temp.lid(5,1,1), pg_temp.lid(5,2,1)]);

set local role authenticated;
select pg_temp.claims(current_setting('t.admin'), 'admin');
savepoint c5a;
update public.catalog_ingredients set name = '__s207_c5_renamed__'     where id = pg_temp.cid(5);
update public.catalog_ingredients set i18n_names = '{"es":"Cinco"}'     where id = pg_temp.cid(5);
update public.catalog_ingredients set image_path = 'spec207/c5.png'    where id = pg_temp.cid(5);
update public.catalog_ingredients set eod_count_mode = 'cases_only'    where id = pg_temp.cid(5);
release savepoint c5a;
reset role;

select is(
  (select name || '|' || (i18n_names ->> 'es') || '|' || image_path || '|' || eod_count_mode
     from public.catalog_ingredients where id = pg_temp.cid(5)),
  '__s207_c5_renamed__|Cinco|spec207/c5.png|cases_only',
  'AC-5 anti-vacuity: rename, i18n_names, image_path and eod_count_mode all landed'
);
select is(pg_temp.changed('c5'), 0,
  'AC-5 rename / i18n_names / image_path / eod_count_mode: every child row keeps xmin, cost and updated_at');

set local role authenticated;
select pg_temp.claims(current_setting('t.admin'), 'admin');
savepoint c5b;
update public.catalog_ingredients set case_qty = 2                    where id = pg_temp.cid(5);
update public.catalog_ingredients set case_qty = 3, sub_unit_size = 2 where id = pg_temp.cid(5);
release savepoint c5b;
reset role;

select is(
  (select case_qty::text || 'x' || sub_unit_size::text from public.catalog_ingredients where id = pg_temp.cid(5)),
  '3x2',
  'AC-5 anti-vacuity: the (2,3) → (3,2) swap landed'
);
select is(pg_temp.changed('c5'), 0,
  'AC-5 resending case_qty and swapping (2,3) → (3,2): every child row keeps xmin, cost and updated_at');


-- ═══════════════════════════════════════════════════════════════════════════
-- AC-7 — C7 unpriced rows scale by old / new pieces (OQ-2)
-- ═══════════════════════════════════════════════════════════════════════════
select pg_temp.snap('c7', array[pg_temp.iid(7,2), pg_temp.lid(7,2,1)]);
set local role authenticated;
select pg_temp.claims(current_setting('t.admin'), 'admin');
savepoint c7a;
update public.catalog_ingredients set sub_unit_size = 35 where id = pg_temp.cid(7);
release savepoint c7a;
reset role;

select is(
  array[pg_temp.cost('inventory_items', pg_temp.iid(7,1)), pg_temp.cost('item_vendors', pg_temp.lid(7,1,1))],
  array[0.014286, 0.014286]::numeric[],
  'AC-7 unpriced item and link at cost 0.5 read round(0.5 x 1 / 35, 6) = 0.014286'
);
select is(
  array[pg_temp.cost('inventory_items', pg_temp.iid(7,2)), pg_temp.cost('item_vendors', pg_temp.lid(7,2,1))],
  array[0, 0]::numeric[],
  'AC-7 unpriced item and link at cost 0 stay 0'
);
select is(pg_temp.changed('c7'), 0,
  'AC-7 the cost-0 rows were not written at all (xmin, cost, updated_at unchanged)');

set local role authenticated;
select pg_temp.claims(current_setting('t.admin'), 'admin');
savepoint c7b;
update public.catalog_ingredients set sub_unit_size = 1 where id = pg_temp.cid(7);
release savepoint c7b;
reset role;

select is(
  array[pg_temp.cost('inventory_items', pg_temp.iid(7,1)), pg_temp.cost('item_vendors', pg_temp.lid(7,1,1))],
  array[0.500010, 0.500010]::numeric[],
  'AC-7 35 → 1 gives round(0.014286 x 35 / 1, 6) = 0.500010 (pinned 6 dp round trip)'
);


-- ═══════════════════════════════════════════════════════════════════════════
-- AC-8 — C8 (pieces 6): derive on write
-- ═══════════════════════════════════════════════════════════════════════════
set local role authenticated;
select pg_temp.claims(current_setting('t.admin'), 'admin');

insert into public.inventory_items (id, store_id, catalog_id, vendor_id, case_price, cost_per_unit)
values (pg_temp.iid(8,1), pg_temp.sid(1), pg_temp.cid(8), pg_temp.vid(1), 30, 30);
insert into public.item_vendors (id, item_id, vendor_id, case_price, cost_per_unit, is_primary)
values (pg_temp.lid(8,1,1), pg_temp.iid(8,1), pg_temp.vid(1), 30, 30, true);

select is(
  array[pg_temp.cost('inventory_items', pg_temp.iid(8,1)), pg_temp.cost('item_vendors', pg_temp.lid(8,1,1))],
  array[5.000000, 5.000000]::numeric[],
  'AC-8 INSERT of a priced item and link (case 30, cost sent 30) stores 30 / 6 = 5'
);

update public.inventory_items set case_price = 30, cost_per_unit = 30 where id = pg_temp.iid(8,1);
update public.item_vendors    set case_price = 30, cost_per_unit = 30 where id = pg_temp.lid(8,1,1);
select is(
  array[pg_temp.cost('inventory_items', pg_temp.iid(8,1)), pg_temp.cost('item_vendors', pg_temp.lid(8,1,1))],
  array[5.000000, 5.000000]::numeric[],
  'AC-8 UPDATE sending (case 30, cost 30) stores 5 on both tables'
);

update public.inventory_items set cost_per_unit = 9 where id = pg_temp.iid(8,1);
update public.item_vendors    set cost_per_unit = 9 where id = pg_temp.lid(8,1,1);
select is(
  array[pg_temp.cost('inventory_items', pg_temp.iid(8,1)), pg_temp.cost('item_vendors', pg_temp.lid(8,1,1))],
  array[5.000000, 5.000000]::numeric[],
  'AC-8 a CSV-style cost-only update (cost 9) on a priced row stores 5'
);

insert into public.inventory_items (id, store_id, catalog_id, vendor_id, case_price, cost_per_unit)
values (pg_temp.iid(8,2), pg_temp.sid(2), pg_temp.cid(8), pg_temp.vid(1), 0, 9);
insert into public.item_vendors (id, item_id, vendor_id, case_price, cost_per_unit, is_primary)
values (pg_temp.lid(8,2,1), pg_temp.iid(8,2), pg_temp.vid(1), 0, 9, true);
update public.inventory_items set cost_per_unit = 9 where id = pg_temp.iid(8,2);
select is(
  array[pg_temp.cost('inventory_items', pg_temp.iid(8,2)), pg_temp.cost('item_vendors', pg_temp.lid(8,2,1))],
  array[9.000000, 9.000000]::numeric[],
  'AC-8 an unpriced row (case 0) written with cost 9 keeps 9'
);

-- create_inventory_item_with_catalog reusing C8 (pieces 6) with p_case_qty 1.
create temp table _created as
select public.create_inventory_item_with_catalog(
  current_setting('t.brand1')::uuid, pg_temp.sid(4), '__s207_c8__',
  'each', null, 1, 1, '', 0, 0,
  jsonb_build_object('case_price', 30, 'cost_per_unit', 30)) as r;
reset role;

select is(
  (select (r -> 'catalog' ->> 'id')::uuid from _created),
  pg_temp.cid(8),
  'AC-8 anti-vacuity: the create RPC reused the existing C8 catalog row'
);
select is(
  (select array[(r ->> 'cost_per_unit')::numeric,
                (select cost_per_unit from public.inventory_items where id = (r ->> 'id')::uuid)]
     from _created),
  array[5.000000, 5.000000]::numeric[],
  'AC-8 create-reuse with p_case_qty 1 and case 30 stores AND returns 5 (the catalog''s pieces 6)'
);

-- Stock-only: rows made off-rule with the trigger disabled, then re-enabled.
alter table public.inventory_items disable trigger zz_derive_cost_per_unit_trg;
alter table public.item_vendors    disable trigger zz_derive_cost_per_unit_trg;
insert into public.inventory_items (id, store_id, catalog_id, vendor_id, case_price, cost_per_unit, current_stock)
values (pg_temp.iid(8,5), pg_temp.sid(5), pg_temp.cid(8), pg_temp.vid(1), 30, 7, 1);
insert into public.item_vendors (id, item_id, vendor_id, case_price, cost_per_unit, is_primary)
values (pg_temp.lid(8,5,1), pg_temp.iid(8,5), pg_temp.vid(1), 30, 7, true);
alter table public.inventory_items enable trigger zz_derive_cost_per_unit_trg;
alter table public.item_vendors    enable trigger zz_derive_cost_per_unit_trg;

set local role authenticated;
select pg_temp.claims(current_setting('t.admin'), 'admin');
update public.inventory_items
   set current_stock = 4, par_level = 2, eod_remaining = 4, vendor_id = pg_temp.vid(2)
 where id = pg_temp.iid(8,5);
update public.item_vendors
   set order_code = '__s207__', product_page_url = 'https://example.test/s207', is_primary = false
 where id = pg_temp.lid(8,5,1);
reset role;

select is(
  (select (current_stock = 4 and par_level = 2 and eod_remaining = 4 and vendor_id = pg_temp.vid(2))::text
          || '|' || cost_per_unit::text
     from public.inventory_items where id = pg_temp.iid(8,5)),
  'true|7.000000',
  'AC-8 a stock / par / EOD / vendor_id update on a priced off-rule item does not run the derivation (cost stays 7)'
);
select is(
  (select order_code || '|' || cost_per_unit::text from public.item_vendors where id = pg_temp.lid(8,5,1)),
  '__s207__|7.000000',
  'AC-8 an order_code / url / is_primary update on a priced off-rule link does not run the derivation (cost stays 7)'
);


-- ═══════════════════════════════════════════════════════════════════════════
-- AC-9 — receive_purchase_order agrees with the stored value
-- ═══════════════════════════════════════════════════════════════════════════
select is(
  array[pg_temp.cost('inventory_items', pg_temp.iid(9,1)), pg_temp.cost('item_vendors', pg_temp.lid(9,1,1))],
  array[6.666667, 6.666667]::numeric[],
  'AC-9 fixture: C9 rows derived to round(20 / 3, 6) on insert'
);

set local role authenticated;
select pg_temp.claims(current_setting('t.admin'), 'admin');
create temp table _recv as
select public.receive_purchase_order(
  '20700000-0000-0000-0005-000000000091',
  jsonb_build_array(jsonb_build_object(
    'po_item_id', '20700000-0000-0000-0006-000000000091', 'received_qty', 1, 'new_case_price', 40)),
  gen_random_uuid()) as env;
reset role;

select is(
  (select (env -> 'price_changes' -> 0 ->> 'new_cost_per_unit')::numeric from _recv),
  13.333333::numeric,
  'AC-9 the envelope''s new_cost_per_unit is round(40 / 3, 6) = 13.333333'
);
select is(
  array[pg_temp.cost('inventory_items', pg_temp.iid(9,1)), pg_temp.cost('item_vendors', pg_temp.lid(9,1,1))],
  (select array[(env -> 'price_changes' -> 0 ->> 'new_cost_per_unit')::numeric,
                (env -> 'price_changes' -> 0 ->> 'new_cost_per_unit')::numeric] from _recv),
  'AC-9 both stored values equal the envelope''s new_cost_per_unit'
);
select is(
  (select value from public.audit_log
    where action = 'PO price change' and detail like 'PO 20700000%' and item_ref = '__s207_c9__'),
  'each 6.666667 → 13.333333',
  'AC-9 the audit value carries the same 6 dp per-each cost'
);
select is(
  array[(select case_price from public.inventory_items where id = pg_temp.iid(9,1)),
        (select case_price from public.item_vendors    where id = pg_temp.lid(9,1,1)),
        (select current_stock from public.inventory_items where id = pg_temp.iid(9,1))],
  array[40, 40, 11]::numeric[],
  'AC-9 receiving still updates the link and the item case price, and the stock (10 + 1)'
);

-- case_qty = 0 catalog row: the old body divided by zero here.
set local role authenticated;
select pg_temp.claims(current_setting('t.admin'), 'admin');
select lives_ok(
  $$select public.receive_purchase_order(
      '20700000-0000-0000-0005-000000000101',
      jsonb_build_array(jsonb_build_object(
        'po_item_id', '20700000-0000-0000-0006-000000000101', 'received_qty', 1, 'new_case_price', 40)),
      gen_random_uuid())$$,
  'AC-9 a receive against a case_qty = 0 catalog row no longer divides by zero'
);
reset role;
select is(
  array[pg_temp.cost('inventory_items', pg_temp.iid(10,1)), pg_temp.cost('item_vendors', pg_temp.lid(10,1,1))],
  array[40.000000, 40.000000]::numeric[],
  'AC-9 case_qty 0 counts as 1: both rows store 40'
);


-- ═══════════════════════════════════════════════════════════════════════════
-- R3 never raises: an RLS refusal still wins on INSERT (spec 179 T72 intent)
-- ═══════════════════════════════════════════════════════════════════════════
set local role authenticated;
select pg_temp.claims('22222222-2222-2222-2222-222222222222', 'user');
select throws_ok(
  format($q$insert into public.inventory_items (store_id, catalog_id, case_price, cost_per_unit)
            values (%L::uuid, %L::uuid, 30, 30)$q$, pg_temp.sid(3), pg_temp.cid(8)),
  '42501',
  'new row violates row-level security policy for table "inventory_items"',
  'R3: a priced INSERT into an invisible store still fails with the RLS message'
);
reset role;


-- ═══════════════════════════════════════════════════════════════════════════
-- R3 lookup is INVOKER: an invisible catalog row reads as "not found"
-- ═══════════════════════════════════════════════════════════════════════════
-- A brand-2 catalog row with pieces 12. The brand-1 admin inserts a priced row
-- in its own store pointing at it (FU-3 gap): the INVOKER lookup cannot see the
-- brand-2 catalog, so pieces count as 1 and the cost equals case_price. The
-- pieces count of another brand's catalog row does not leak through RETURNING.
insert into public.catalog_ingredients (id, brand_id, name, unit, case_qty, sub_unit_size)
values (pg_temp.cid(20), current_setting('t.brand2')::uuid, '__s207_c20__', 'each', 12, 1);
set local role authenticated;
select pg_temp.claims(current_setting('t.admin'), 'admin');
do $$
declare v numeric;
begin
  insert into public.inventory_items (id, store_id, catalog_id, case_price, cost_per_unit)
  values (pg_temp.iid(20,1), pg_temp.sid(1), pg_temp.cid(20), 24, 1)
  returning cost_per_unit into v;
  perform set_config('t.returned', v::text, true);
end $$;
reset role;
select is(
  current_setting('t.returned')::numeric,
  24.000000::numeric,
  'R3 INVOKER: a cross-brand catalog row is invisible to the lookup (pieces 1), so RETURNING does not leak its pieces count'
);
select is(
  (select cost_per_unit from public.inventory_items where id = pg_temp.iid(20,1)),
  24.000000::numeric,
  'R3 INVOKER: the stored value matches what RETURNING showed'
);


-- ═══════════════════════════════════════════════════════════════════════════
-- R1 reaches links of every store, and only the edited catalog row's rows
-- ═══════════════════════════════════════════════════════════════════════════
select pg_temp.snap('other', array[pg_temp.iid(9,1), pg_temp.lid(9,1,1), pg_temp.iid(4,1)]);
set local role authenticated;
select pg_temp.claims(current_setting('t.admin'), 'admin');
savepoint r1;
update public.catalog_ingredients set sub_unit_size = 2 where id = pg_temp.cid(1);
release savepoint r1;
reset role;
select is(pg_temp.changed('other'), 0,
  'R1 only writes rows of the edited catalog row (C9 / C4 rows untouched)');
select is(
  array[pg_temp.cost('inventory_items', pg_temp.iid(1,1)), pg_temp.cost('item_vendors', pg_temp.lid(1,1,2)),
        pg_temp.cost('item_vendors',    pg_temp.lid(1,2,1)), pg_temp.cost('inventory_items', pg_temp.iid(1,2))],
  array[8.487500, 10.000000, 8.487500, 8.487500]::numeric[],
  'R1 a second change (pieces 2 → 4) re-derives every brand store''s item and link from its own case_price'
);
select is(pg_temp.changed('z'), 0,
  'R1 the second change still leaves the brand-2 store Z item and link untouched');


-- ═══════════════════════════════════════════════════════════════════════════
-- R1 brand scope: a planted brand-2 row cannot block a brand-1 pack-size edit
-- ═══════════════════════════════════════════════════════════════════════════
-- C11 goes 1×35 → 1×1. Unscoped, the OQ-2 scaling of the planted brand-2 row
-- (999999.999999 × 35 / 1) would overflow numeric(12,6) (22003) and abort the
-- admin's PATCH, and the admin cannot see that row to fix it.
select pg_temp.snap('plant', array[pg_temp.iid(11,3)]);
set local role authenticated;
select pg_temp.claims(current_setting('t.admin'), 'admin');
select lives_ok(
  format($q$update public.catalog_ingredients set sub_unit_size = 1 where id = %L::uuid$q$, pg_temp.cid(11)),
  'R1 brand scope: the brand-1 admin lowers C11''s pieces 35 → 1 despite the planted brand-2 row'
);
reset role;
select is(
  (select sub_unit_size from public.catalog_ingredients where id = pg_temp.cid(11)),
  1::numeric,
  'R1 brand scope: the pack-size edit landed'
);
select is(
  pg_temp.cost('inventory_items', pg_temp.iid(11,1)),
  30.000000::numeric,
  'R1 brand scope: the brand-1 row is re-derived (30 / 1)'
);
select is(pg_temp.changed('plant'), 0,
  'R1 brand scope: the planted brand-2 row is untouched (still 999999.999999, not written)');


-- ═══════════════════════════════════════════════════════════════════════════
-- Non-privileged caller: the catalog UPDATE is refused by RLS, nothing moves
-- ═══════════════════════════════════════════════════════════════════════════
select pg_temp.snap('user', array[pg_temp.iid(2,1), pg_temp.lid(2,1,1)]);
set local role authenticated;
select pg_temp.claims('22222222-2222-2222-2222-222222222222', 'user');
savepoint u1;
update public.catalog_ingredients set sub_unit_size = 70 where id = pg_temp.cid(2);
release savepoint u1;
reset role;
select is(
  (select sub_unit_size from public.catalog_ingredients where id = pg_temp.cid(2)),
  35::numeric,
  'R1 gate: a non-privileged caller cannot change pack size (RLS, 0 rows)'
);
select is(pg_temp.changed('user'), 0,
  'R1 gate: so no child row is re-derived');


-- ═══════════════════════════════════════════════════════════════════════════
-- R1 and R3 agree on priced rows; R3 keeps R1's scaled value on unpriced rows
-- ═══════════════════════════════════════════════════════════════════════════
select is(
  (select count(*)::int from public.inventory_items ii
     join public.catalog_ingredients ci on ci.id = ii.catalog_id
    where ii.id::text like '20700000-0000-0000-0002-%'
      and ii.case_price > 0
      and ii.id <> pg_temp.iid(8,5)        -- the deliberate off-rule AC-8 row
      and ii.id <> pg_temp.iid(20,1)       -- the cross-brand catalog pointer
      and ii.id <> pg_temp.iid(1,3)        -- brand-2 store Z row, outside R1's brand scope
      and ii.cost_per_unit is distinct from public.per_each_cost(ii.case_price, ci.case_qty, ci.sub_unit_size)),
  0,
  'every priced fixture item ends on the rule (R1 + R3 agree)'
);
select is(
  (select count(*)::int from public.item_vendors iv
     join public.inventory_items ii on ii.id = iv.item_id
     join public.catalog_ingredients ci on ci.id = ii.catalog_id
    where iv.id::text like '20700000-0000-0000-0003-%'
      and iv.case_price > 0
      and iv.id <> pg_temp.lid(8,5,1)
      and iv.id <> pg_temp.lid(1,3,3)      -- brand-2 store Z link, outside R1's brand scope
      and iv.cost_per_unit is distinct from public.per_each_cost(iv.case_price, ci.case_qty, ci.sub_unit_size)),
  0,
  'every priced fixture link ends on the rule (R1 + R3 agree)'
);

select * from finish();
rollback;
