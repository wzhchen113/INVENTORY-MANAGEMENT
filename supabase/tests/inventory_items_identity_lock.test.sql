-- supabase/tests/inventory_items_identity_lock.test.sql
--
-- Spec 179 — pgTAP coverage for the inventory-item identity lock and the
-- delete-then-reinsert tombstone guard shipped in
-- supabase/migrations/20261026100000_inventory_items_identity_lock.sql:
--
--   (R-1)  public.inventory_items_lock_identity()    — inventory_items_identity_lock_trg
--   (R-2b) public.inventory_items_record_tombstone() — inventory_items_tombstone_record_trg
--   (R-2c) public.inventory_items_check_tombstone()  — inventory_items_tombstone_check_trg
--          public.inventory_item_tombstones (RLS on, no policies, no TRUNCATE)
--
-- Plan: the design §9 table, T01–T80 (owner decision D-1 = Option A, so the
-- TRUNCATE arms T62/T63 are included; fix round 1 added T74–T80). Every
-- throws_ok asserts BOTH the SQLSTATE and the EXACT message, so a different
-- guard raising the same
-- errcode cannot pass an arm silently. Every acceptance arm re-reads the row
-- (anti-vacuity).
--
-- Fixtures: store A = Charles, store B = Frederick (same brand). The seed
-- master 3333 sees both (R-1 caller); the seed admin 1111 is privileged and
-- sees both (approvals, store delete, brand-apply RPCs); the seed manager 2222
-- ('user', Frederick + Towson) is the one-store caller and the AC-8 store
-- member. T01–T03 prove those visibilities, so no cross-store arm passes
-- because RLS hid the row. Every item gets its own catalog row (except the
-- deliberately shared cS), so no (store_id, catalog_id) unique collision can
-- mask a refusal when the triggers are disabled (negative control).
--
-- anon arms (T56/T58/T60): asserted through the CATALOG, not `set role anon`
-- — `set role anon` segfaults the CI Postgres image (spec 067; see
-- reports_anon_revoke.test.sql). anon's runtime path is the same RLS
-- default-deny the authenticated arms T55/T57/T59 exercise: RLS on, no
-- policy admits any role, and anon neither bypasses RLS nor owns the table.
--
-- Fix round 1 (security M1 / L1, code-reviewer SF-1 / SF-2): the R-2 check is
-- AFTER INSERT. T74–T77 pin the single-statement writable-CTE delete +
-- reinsert (as postgres and as an authenticated master); T78/T79 pin the
-- NULL-store reinsert branch (postgres only — for authenticated, RLS WITH
-- CHECK refuses a NULL store first); T80 pins that a zero-store caller gets
-- the RLS message, never the R-2 message. The T54 snapshot is taken BEFORE
-- the admin write attempts on the tombstone table (T57/T59), and T61 asserts
-- the exact count.
--
-- Arms are grouped by caller, so labels follow the design §9 table, not file
-- order (TAP's running index and the T-number differ).
--
-- Hermetic: begin; … rollback;. All fixtures created inside the transaction.
-- JWT impersonation via `set local role authenticated` + request.jwt.claims.

begin;
create extension if not exists pgtap;

select plan(80);

-- ─── fixtures (as postgres) ────────────────────────────────────
do $$
declare
  v_store_a uuid;
  v_store_b uuid;
  v_brand   uuid;
begin
  select id           into v_store_a from public.stores where name = 'Charles'   limit 1;
  select id, brand_id into v_store_b, v_brand
    from public.stores where name = 'Frederick' limit 1;

  perform set_config('test.master_id',  '33333333-3333-3333-3333-333333333333', true);
  perform set_config('test.admin_id',   '11111111-1111-1111-1111-111111111111', true);
  perform set_config('test.manager_id', '22222222-2222-2222-2222-222222222222', true);
  perform set_config('test.store_a', v_store_a::text, true);
  perform set_config('test.store_b', v_store_b::text, true);
  perform set_config('test.brand',   v_brand::text,   true);

  -- Fixed literal ids (c179 prefix).
  perform set_config('test.iA1', 'c1790001-0000-0000-0000-000000000001', true);
  perform set_config('test.iA2', 'c1790001-0000-0000-0000-000000000002', true);
  perform set_config('test.iA3', 'c1790001-0000-0000-0000-000000000003', true);
  perform set_config('test.iA4', 'c1790001-0000-0000-0000-000000000004', true);
  perform set_config('test.iA5', 'c1790001-0000-0000-0000-000000000005', true);
  perform set_config('test.iB1', 'c1790001-0000-0000-0000-000000000011', true);
  perform set_config('test.iB2', 'c1790001-0000-0000-0000-000000000012', true);
  perform set_config('test.iB3', 'c1790001-0000-0000-0000-000000000013', true);
  perform set_config('test.iB4', 'c1790001-0000-0000-0000-000000000014', true);
  perform set_config('test.iB5', 'c1790001-0000-0000-0000-000000000015', true);
  perform set_config('test.iB6', 'c1790001-0000-0000-0000-000000000016', true);
  perform set_config('test.iB7', 'c1790001-0000-0000-0000-000000000017', true);
  perform set_config('test.iB8', 'c1790001-0000-0000-0000-000000000018', true);
  perform set_config('test.cB1', 'c1790000-0000-0000-0000-000000000011', true);
  perform set_config('test.zero_store_id', 'c1790009-0000-0000-0000-000000000001', true);
  perform set_config('test.iN',  'c1790001-0000-0000-0000-000000000020', true);
  perform set_config('test.iC1', 'c1790001-0000-0000-0000-000000000031', true);
  perform set_config('test.iC2', 'c1790001-0000-0000-0000-000000000032', true);
  perform set_config('test.iZ1', 'c1790001-0000-0000-0000-000000000041', true);
  perform set_config('test.iZ2', 'c1790001-0000-0000-0000-000000000042', true);

  perform set_config('test.cA3', 'c1790000-0000-0000-0000-000000000003', true);
  perform set_config('test.cB2', 'c1790000-0000-0000-0000-000000000012', true);
  perform set_config('test.cB3', 'c1790000-0000-0000-0000-000000000013', true);
  perform set_config('test.cS',  'c1790000-0000-0000-0000-000000000050', true);

  perform set_config('test.vendor',  'c1790002-0000-0000-0000-000000000001', true);
  perform set_config('test.po_a',    'c1790003-0000-0000-0000-000000000001', true);
  perform set_config('test.po_a2',   'c1790003-0000-0000-0000-000000000002', true);
  perform set_config('test.po_c',    'c1790003-0000-0000-0000-000000000003', true);
  perform set_config('test.line_a',  'c1790004-0000-0000-0000-000000000001', true);
  perform set_config('test.line_a2', 'c1790004-0000-0000-0000-000000000002', true);
  perform set_config('test.store_c', 'c1790005-0000-0000-0000-000000000001', true);
  perform set_config('test.store_z', 'c1790005-0000-0000-0000-000000000002', true);
  perform set_config('test.brand_z', 'c1790006-0000-0000-0000-000000000001', true);
  perform set_config('test.new_id',  'c1790007-0000-0000-0000-000000000001', true);
  perform set_config('test.new_id2', 'c1790007-0000-0000-0000-000000000002', true);
  perform set_config('test.eod_client', 'c1790008-0000-0000-0000-000000000001', true);
  -- Spec 193: T22's staff_submit_eod date is anchor-relative (A - 16, with
  -- A = (now() at time zone 'America/New_York')::date) because spec 193
  -- bounds store-member dates. Its vendor is created in this transaction, so
  -- no leftover row can pre-exist and no pre-delete is needed.
  perform set_config('test.d_eod',
    ((now() at time zone 'America/New_York')::date - 16)::text, true);
end $$;

-- Fixture store S_C (brand A) and fixture brand Z with store S_Z.
insert into public.stores (id, name, brand_id, address)
values (current_setting('test.store_c', true)::uuid, '__s179_store_c__',
        current_setting('test.brand', true)::uuid, '1 Spec 179 Way');

insert into public.brands (id, name)
values (current_setting('test.brand_z', true)::uuid, '__s179_brand_z__');

insert into public.stores (id, name, brand_id, address)
values (current_setting('test.store_z', true)::uuid, '__s179_store_z__',
        current_setting('test.brand_z', true)::uuid, '2 Spec 179 Way');

-- One catalog row per item (cS shared on purpose by iA5 / iB4).
insert into public.catalog_ingredients (id, brand_id, name, unit)
select ('c1790000-0000-0000-0000-0000000000' || n)::uuid,
       case when n in ('41', '42') then current_setting('test.brand_z', true)::uuid
            else current_setting('test.brand', true)::uuid end,
       '__s179_cat_' || n || '__', 'each'
  from unnest(array['01','02','03','04','11','12','13','15','16','17','18','20',
                    '31','32','41','42','50']) as n;

insert into public.inventory_items (id, store_id, catalog_id, current_stock, par_level, vendor_id)
values
  (current_setting('test.iA1', true)::uuid, current_setting('test.store_a', true)::uuid, 'c1790000-0000-0000-0000-000000000001', 0,  1, null),
  (current_setting('test.iA2', true)::uuid, current_setting('test.store_a', true)::uuid, 'c1790000-0000-0000-0000-000000000002', 0,  1, null),
  (current_setting('test.iA3', true)::uuid, current_setting('test.store_a', true)::uuid, 'c1790000-0000-0000-0000-000000000003', 0,  1, null),
  (current_setting('test.iA4', true)::uuid, current_setting('test.store_a', true)::uuid, 'c1790000-0000-0000-0000-000000000004', 10, 1, null),
  (current_setting('test.iA5', true)::uuid, current_setting('test.store_a', true)::uuid, 'c1790000-0000-0000-0000-000000000050', 0,  1, null),
  (current_setting('test.iB1', true)::uuid, current_setting('test.store_b', true)::uuid, 'c1790000-0000-0000-0000-000000000011', 0,  1, null),
  (current_setting('test.iB2', true)::uuid, current_setting('test.store_b', true)::uuid, 'c1790000-0000-0000-0000-000000000012', 0,  1, null),
  (current_setting('test.iB3', true)::uuid, current_setting('test.store_b', true)::uuid, 'c1790000-0000-0000-0000-000000000013', 0,  1, null),
  (current_setting('test.iB4', true)::uuid, current_setting('test.store_b', true)::uuid, 'c1790000-0000-0000-0000-000000000050', 0,  1, null),
  (current_setting('test.iB5', true)::uuid, current_setting('test.store_b', true)::uuid, 'c1790000-0000-0000-0000-000000000015', 0,  1, null),
  (current_setting('test.iB6', true)::uuid, current_setting('test.store_b', true)::uuid, 'c1790000-0000-0000-0000-000000000016', 0,  1, null),
  (current_setting('test.iB7', true)::uuid, current_setting('test.store_b', true)::uuid, 'c1790000-0000-0000-0000-000000000017', 0,  1, null),
  (current_setting('test.iB8', true)::uuid, current_setting('test.store_b', true)::uuid, 'c1790000-0000-0000-0000-000000000018', 0,  1, null),
  (current_setting('test.iN',  true)::uuid, null,                                         'c1790000-0000-0000-0000-000000000020', 0,  1, null),
  (current_setting('test.iC1', true)::uuid, current_setting('test.store_c', true)::uuid, 'c1790000-0000-0000-0000-000000000031', 0,  1, null),
  (current_setting('test.iC2', true)::uuid, current_setting('test.store_c', true)::uuid, 'c1790000-0000-0000-0000-000000000032', 0,  1, null),
  (current_setting('test.iZ1', true)::uuid, current_setting('test.store_z', true)::uuid, 'c1790000-0000-0000-0000-000000000041', 0,  1, null),
  (current_setting('test.iZ2', true)::uuid, current_setting('test.store_z', true)::uuid, 'c1790000-0000-0000-0000-000000000042', 0,  1, null);

-- Brand-A vendor with null order_channel and no extension flag.
insert into public.vendors (id, name, brand_id, order_channel, extension_ordering)
values (current_setting('test.vendor', true)::uuid, '__s179_vendor__',
        current_setting('test.brand', true)::uuid, null, false);

-- item_vendors: iB6 (staff_submit_eod writes on-hand only for linked items)
-- and iC1 (exercises the item_vendors cascade inside the store delete).
-- iA2 / iB2 deliberately have NO item_vendors row (approval-only references).
insert into public.item_vendors (item_id, vendor_id, is_primary)
values
  (current_setting('test.iB6', true)::uuid, current_setting('test.vendor', true)::uuid, true),
  (current_setting('test.iC1', true)::uuid, current_setting('test.vendor', true)::uuid, true);

insert into public.purchase_orders (id, store_id, vendor_id, status)
values
  (current_setting('test.po_a',  true)::uuid, current_setting('test.store_a', true)::uuid,
   current_setting('test.vendor', true)::uuid, 'draft'),
  (current_setting('test.po_a2', true)::uuid, current_setting('test.store_a', true)::uuid,
   current_setting('test.vendor', true)::uuid, 'sent'),
  (current_setting('test.po_c',  true)::uuid, current_setting('test.store_c', true)::uuid,
   current_setting('test.vendor', true)::uuid, 'draft');

insert into public.po_items (id, po_id, item_id, ordered_qty, received_qty, cost_per_unit)
values
  (current_setting('test.line_a',  true)::uuid, current_setting('test.po_a',  true)::uuid,
   current_setting('test.iA1', true)::uuid, 5, null, 2.00),
  (current_setting('test.line_a2', true)::uuid, current_setting('test.po_a2', true)::uuid,
   current_setting('test.iA4', true)::uuid, 4, null, 2.00);
-- PO_C is deliberately UNLINED. Pre-existing schema behaviour (reproduced with
-- the spec 179 triggers disabled): a store whose item has a po_items line
-- cannot be deleted today — the po_items.item_id NO ACTION check fires at the
-- end of the stores→inventory_items cascade sub-statement, before the
-- stores→purchase_orders→po_items cascade has removed the line (23503). AC-9
-- pins "succeeds exactly as it does today", so S_C carries what a store delete
-- can cascade through today: items, an item_vendors link and an unlined PO.

-- Approval line payload builder (spec 177 l177 shape).
create function pg_temp.l179(variadic p_items uuid[]) returns jsonb
language sql immutable as $$
  select jsonb_agg(jsonb_build_object(
           'item_id', i, 'item_name', '__s179_line__', 'qty_base', 2,
           'case_qty', 1, 'unit', 'each', 'cost_per_counted_unit', 1.5)
         order by o)
    from unnest(p_items) with ordinality as u(i, o)
$$;

-- JWT claims helper.
create function pg_temp.claims(p_sub text, p_role text) returns text
language sql as $$
  select set_config('request.jwt.claims', jsonb_build_object(
           'sub', p_sub, 'role', 'authenticated',
           'app_metadata', jsonb_build_object('role', p_role))::text, true)
$$;


-- ═══════════════════════════════════════════════════════════════════════════
-- Anti-vacuity: who sees what
-- ═══════════════════════════════════════════════════════════════════════════
set local role authenticated;

select pg_temp.claims(current_setting('test.master_id', true), 'master');
-- T01
select ok(
  public.auth_can_see_store(current_setting('test.store_a', true)::uuid)
    and public.auth_can_see_store(current_setting('test.store_b', true)::uuid),
  'T01 master sees store A and store B (cross-store arms are not RLS-hidden)'
);

select pg_temp.claims(current_setting('test.admin_id', true), 'admin');
-- T02
select ok(
  public.auth_can_see_store(current_setting('test.store_a', true)::uuid)
    and public.auth_can_see_store(current_setting('test.store_b', true)::uuid),
  'T02 admin sees store A and store B'
);

select pg_temp.claims(current_setting('test.manager_id', true), 'user');
-- T03
select ok(
  public.auth_can_see_store(current_setting('test.store_b', true)::uuid)
    and not public.auth_can_see_store(current_setting('test.store_a', true)::uuid),
  'T03 manager sees store B but not store A (the one-store caller)'
);

-- Approval fixtures through the real RPC, as ADMIN: d1 at Charles names only
-- iA2; d2 at Frederick names only iB2.
select pg_temp.claims(current_setting('test.admin_id', true), 'admin');
do $$
begin
  perform public.create_order_approval(
    current_setting('test.store_a', true)::uuid,
    current_setting('test.vendor', true)::uuid,
    date '2026-10-11',
    pg_temp.l179(current_setting('test.iA2', true)::uuid),
    null);
  perform public.create_order_approval(
    current_setting('test.store_b', true)::uuid,
    current_setting('test.vendor', true)::uuid,
    date '2026-10-12',
    pg_temp.l179(current_setting('test.iB2', true)::uuid),
    null);
  perform set_config('test.appr_d2', (
    select id::text from public.order_approvals
     where store_id = current_setting('test.store_b', true)::uuid
       and vendor_id = current_setting('test.vendor', true)::uuid
       and business_date = date '2026-10-12'), true);
end $$;


-- ═══════════════════════════════════════════════════════════════════════════
-- (R-1) identity lock — as MASTER (sees both stores)
-- ═══════════════════════════════════════════════════════════════════════════
select pg_temp.claims(current_setting('test.master_id', true), 'master');

-- T04 (AC-1)
select throws_ok(
  format($q$update public.inventory_items set store_id = %L::uuid where id = %L::uuid$q$,
         current_setting('test.store_b', true), current_setting('test.iA1', true)),
  '42501',
  'inventory_items: id and store_id are immutable',
  'T04 AC-1 a two-store caller moving item A1 from store A to store B is refused'
);

-- T05 (AC-1)
select is(
  (select format('%s|%s', ii.store_id, li.store_id)
     from public.inventory_items ii,
          (select i2.store_id
             from public.po_items poi
             join public.inventory_items i2 on i2.id = poi.item_id
            where poi.id = current_setting('test.line_a', true)::uuid) li
    where ii.id = current_setting('test.iA1', true)::uuid),
  format('%s|%s', current_setting('test.store_a', true), current_setting('test.store_a', true)),
  'T05 AC-1 item A1 is still in store A and the store-A PO line still resolves to a store-A item'
);

-- T07 (AC-2) — iA2 is referenced ONLY by the pending Charles approval (no FK).
select throws_ok(
  format($q$update public.inventory_items set id = %L::uuid where id = %L::uuid$q$,
         current_setting('test.new_id', true), current_setting('test.iA2', true)),
  '42501',
  'inventory_items: id and store_id are immutable',
  'T07 AC-2 re-keying an approval-only item (L1(b)) is refused'
);

-- T08 (AC-2)
select ok(
  (select count(*) = 1 from public.inventory_items
    where id = current_setting('test.iA2', true)::uuid
      and store_id = current_setting('test.store_a', true)::uuid)
  and (select count(*) = 0 from public.inventory_items
        where id = current_setting('test.new_id', true)::uuid),
  'T08 AC-2 item A2 is unchanged under its original id; nothing exists at the new id'
);

-- T09 (AC-3) — never-deleted item, so the conflict arm reports the R-1 message.
select throws_ok(
  format($q$insert into public.inventory_items (id, store_id, catalog_id)
            values (%L::uuid, %L::uuid, %L::uuid)
            on conflict (id) do update set store_id = excluded.store_id$q$,
         current_setting('test.iA3', true), current_setting('test.store_b', true),
         current_setting('test.cA3', true)),
  '42501',
  'inventory_items: id and store_id are immutable',
  'T09 AC-3 an upsert whose conflict arm moves item A3 to store B is refused (R-1 message)'
);

-- T10 (AC-3)
select is(
  (select store_id::text from public.inventory_items where id = current_setting('test.iA3', true)::uuid),
  current_setting('test.store_a', true),
  'T10 AC-3 item A3 still has store A'
);

-- T11 (AC-4)
select lives_ok(
  format($q$update public.inventory_items set id = id, store_id = store_id, par_level = 7 where id = %L::uuid$q$,
         current_setting('test.iA3', true)),
  'T11 AC-4 a pass-through SET of id/store_id with a par_level change is accepted'
);

-- T12 (AC-4)
select is(
  (select par_level from public.inventory_items where id = current_setting('test.iA3', true)::uuid),
  7::numeric,
  'T12 AC-4 par_level changed to 7'
);

-- T13 (AC-4)
select lives_ok(
  format($q$insert into public.inventory_items (id, store_id, catalog_id, par_level)
            values (%L::uuid, %L::uuid, %L::uuid, 9)
            on conflict (id) do update set store_id = excluded.store_id, par_level = excluded.par_level$q$,
         current_setting('test.iA3', true), current_setting('test.store_a', true),
         current_setting('test.cA3', true)),
  'T13 AC-4 an upsert that resends the SAME store is accepted'
);

-- T14 (AC-4)
select is(
  (select par_level from public.inventory_items where id = current_setting('test.iA3', true)::uuid),
  9::numeric,
  'T14 AC-4 par_level changed to 9 through the conflict arm'
);

-- T20 (AC-6) — the real receiving RPC on a same-store sent PO.
select lives_ok(
  format($q$select public.receive_purchase_order(%L::uuid,
              jsonb_build_array(jsonb_build_object('po_item_id', %L::uuid, 'received_qty', 4)),
              gen_random_uuid())$q$,
         current_setting('test.po_a2', true), current_setting('test.line_a2', true)),
  'T20 AC-6 receive_purchase_order on a same-store PO is accepted'
);

-- T28 (AC-6) setup — create_inventory_item_with_catalog mints a fresh id.
do $$
begin
  perform set_config('test.fresh_id',
    (public.create_inventory_item_with_catalog(
       current_setting('test.brand', true)::uuid,
       current_setting('test.store_a', true)::uuid,
       '__s179 fresh item__') ->> 'id'), true);
end $$;

-- T45 (AC-13)
select lives_ok(
  format($q$delete from public.inventory_items where id = %L::uuid$q$, current_setting('test.iB3', true)),
  'T45 AC-13 deleting item B3 is accepted'
);

-- T46 (AC-13)
select lives_ok(
  format($q$insert into public.inventory_items (id, store_id, catalog_id) values (%L::uuid, %L::uuid, %L::uuid)$q$,
         current_setting('test.iB3', true), current_setting('test.store_b', true),
         current_setting('test.cB3', true)),
  'T46 AC-13 re-inserting the same id under the SAME store (B) is accepted'
);

-- T47 (AC-13) — read as master (B is visible) before the second delete.
select is(
  (select store_id::text from public.inventory_items where id = current_setting('test.iB3', true)::uuid),
  current_setting('test.store_b', true),
  'T47 AC-13 item B3 exists again, in store B'
);

-- T48 (AC-14)
select lives_ok(
  format($q$delete from public.inventory_items where id = %L::uuid$q$, current_setting('test.iB3', true)),
  'T48 AC-14 deleting item B3 a second time is accepted (idempotent tombstone write)'
);

-- T50 (AC-15) — FK unchanged: a po_items-referenced item cannot be deleted.
select throws_ok(
  format($q$delete from public.inventory_items where id = %L::uuid$q$, current_setting('test.iA1', true)),
  '23503',
  'update or delete on table "inventory_items" violates foreign key constraint "po_items_item_id_fkey" on table "po_items"',
  'T50 AC-15 deleting a po_items-referenced item is still refused by the FK'
);

-- T76 (M1, AC-11) — single-statement writable CTE: delete store-B item B8 and
-- re-insert its id under store A in ONE statement, as an authenticated
-- two-store caller. The DELETE's tombstone event is queued before the
-- INSERT's AFTER check, so the check sees (B8, B) and refuses.
select throws_ok(
  format($q$with d as (delete from public.inventory_items where id = %L::uuid returning id, catalog_id)
            insert into public.inventory_items (id, store_id, catalog_id)
            select d.id, %L::uuid, d.catalog_id from d$q$,
         current_setting('test.iB8', true), current_setting('test.store_a', true)),
  '42501',
  'inventory_items: id was previously used by another store',
  'T76 M1 a single-statement delete + reinsert under another store is refused for an authenticated master'
);


-- ═══════════════════════════════════════════════════════════════════════════
-- One-store MANAGER (Frederick + Towson): R-1 before WITH CHECK, AC-6, AC-8
-- ═══════════════════════════════════════════════════════════════════════════
select pg_temp.claims(current_setting('test.manager_id', true), 'user');

-- T06 (AC-1) — the trigger runs BEFORE the RLS WITH CHECK, so its message wins.
select throws_ok(
  format($q$update public.inventory_items set store_id = %L::uuid where id = %L::uuid$q$,
         current_setting('test.store_a', true), current_setting('test.iB5', true)),
  '42501',
  'inventory_items: id and store_id are immutable',
  'T06 AC-1 a one-store caller moving item B5 to store A gets the lock''s message'
);

-- T18 (AC-6) — the updateInventoryItem perStore key set + submitEODCount's eod_remaining.
select lives_ok(
  format($q$update public.inventory_items
               set cost_per_unit = 2.5, current_stock = 11, par_level = 6,
                   vendor_id = %L::uuid, case_price = 30, eod_remaining = 11
             where id = %L::uuid$q$,
         current_setting('test.vendor', true), current_setting('test.iB5', true)),
  'T18 AC-6 a perStore PATCH (cost, stock, par, vendor, case_price, eod_remaining) is accepted'
);

-- T22 (AC-6) — the real staff EOD RPC.
select lives_ok(
  format($q$select public.staff_submit_eod(%L::uuid, %L::uuid, %L::date, null, 'submitted',
              jsonb_build_array(jsonb_build_object('ingredient_id', %L::uuid, 'actual_remaining', 17)),
              %L::uuid)$q$,
         current_setting('test.eod_client', true), current_setting('test.store_b', true),
         current_setting('test.d_eod', true),
         current_setting('test.iB6', true), current_setting('test.vendor', true)),
  'T22 AC-6 staff_submit_eod for a same-store linked item is accepted'
);

-- T29 (AC-8)
select lives_ok(
  format($q$delete from public.inventory_items where id = %L::uuid$q$, current_setting('test.iB1', true)),
  'T29 AC-8 a store member deletes item B1 directly'
);

-- T31 (AC-8) — the member cannot read the tombstone that was just written.
select is(
  (select count(*)::int from public.inventory_item_tombstones),
  0,
  'T31 AC-8 the store member reads 0 tombstone rows (RLS, no policy)'
);


-- ═══════════════════════════════════════════════════════════════════════════
-- ADMIN: brand-apply RPCs, store cascade, cross-store reinsert, lockdown
-- ═══════════════════════════════════════════════════════════════════════════
select pg_temp.claims(current_setting('test.admin_id', true), 'admin');

-- T24 (AC-6)
select is(
  ((public.apply_item_scalars_to_brand(current_setting('test.cS', true)::uuid, 8, 1.25, 15))
     ->> 'updated_count')::int,
  2,
  'T24 AC-6 apply_item_scalars_to_brand updates both cS items'
);

-- T26 (AC-6)
select lives_ok(
  format($q$select public.apply_item_vendors_to_brand(%L::uuid,
              jsonb_build_array(jsonb_build_object('vendor_id', %L::uuid)), %L::uuid)$q$,
         current_setting('test.cS', true), current_setting('test.vendor', true),
         current_setting('test.vendor', true)),
  'T26 AC-6 apply_item_vendors_to_brand is accepted'
);

-- T32 (AC-9)
select lives_ok(
  format($q$delete from public.stores where id = %L::uuid$q$, current_setting('test.store_c', true)),
  'T32 AC-9 deleting a store that owns items, an item_vendors link and an unlined PO succeeds'
);

-- T38 (AC-11) — anti-vacuity: the pending Frederick approval names iB2.
select is(
  (select format('%s|%s', status, lines->0->>'item_id') from public.order_approvals
    where id = current_setting('test.appr_d2', true)::uuid),
  format('pending|%s', current_setting('test.iB2', true)),
  'T38 AC-11 the store-B approval is pending and its line names item B2'
);

-- T39 (AC-11)
select lives_ok(
  format($q$delete from public.inventory_items where id = %L::uuid$q$, current_setting('test.iB2', true)),
  'T39 AC-11 deleting approval-only item B2 is accepted'
);

-- T41 (AC-11) — L1(a): re-create the deleted store-B id under store A.
select throws_ok(
  format($q$insert into public.inventory_items (id, store_id, catalog_id) values (%L::uuid, %L::uuid, %L::uuid)$q$,
         current_setting('test.iB2', true), current_setting('test.store_a', true),
         current_setting('test.cB2', true)),
  '42501',
  'inventory_items: id was previously used by another store',
  'T41 AC-11 re-inserting a deleted store-B id under store A is refused'
);

-- T80 (L1) — a ZERO-store authenticated caller (fresh sub, role 'user', no
-- profile, no user_stores) inserting the tombstoned id under store A gets the
-- RLS message, never the R-2 message: the AFTER INSERT check runs after RLS
-- WITH CHECK, so it is not a deleted-id oracle for callers who can't insert.
select pg_temp.claims(current_setting('test.zero_store_id', true), 'user');
do $$
begin
  if public.auth_can_see_store(current_setting('test.store_a', true)::uuid)
     or public.auth_can_see_store(current_setting('test.store_b', true)::uuid) then
    raise exception 'T80 guard: the zero-store caller can see store A or B';
  end if;
end $$;

select throws_ok(
  format($q$insert into public.inventory_items (id, store_id, catalog_id) values (%L::uuid, %L::uuid, %L::uuid)$q$,
         current_setting('test.iB2', true), current_setting('test.store_a', true),
         current_setting('test.cB2', true)),
  '42501',
  'new row violates row-level security policy for table "inventory_items"',
  'T80 L1 a zero-store caller re-inserting a tombstoned id gets the RLS message, not R-2'
);

-- T54 (AC-16) — snapshot BEFORE the admin write attempts on the tombstone
-- table (T57 INSERT, T59 UPDATE/DELETE), so T61 really proves "unchanged".
-- Taken as postgres (RLS bypassed); anti-vacuity for the lockdown arms.
-- Two snapshots: the WHOLE table (a delta, robust on a long-lived local stack
-- that already holds real tombstones) and the FIXTURE rows only (ids under
-- the c1790001- prefix), which T61 also pins to an exact count.
reset role;
select set_config('request.jwt.claims', null, true);
select set_config('test.tomb_count',
  (select count(*)::text from public.inventory_item_tombstones), true);
select set_config('test.tomb_fixture_count',
  (select count(*)::text from public.inventory_item_tombstones
    where id::text like 'c1790001-%'), true);
select ok(
  current_setting('test.tomb_fixture_count', true)::int > 0,
  'T54 AC-16 tombstone rows exist before the admin write attempts (the lockdown arms are not vacuous)'
);

set local role authenticated;
select pg_temp.claims(current_setting('test.admin_id', true), 'admin');

-- T55 (AC-16)
select is(
  (select count(*)::int from public.inventory_item_tombstones),
  0,
  'T55 AC-16 authenticated (admin) SELECT on the tombstone table returns 0 rows'
);

-- T57 (AC-16)
select throws_ok(
  format($q$insert into public.inventory_item_tombstones (id, store_id) values (gen_random_uuid(), %L::uuid)$q$,
         current_setting('test.store_a', true)),
  '42501',
  'new row violates row-level security policy for table "inventory_item_tombstones"',
  'T57 AC-16 authenticated (admin) INSERT into the tombstone table is refused by RLS'
);

-- T59 (AC-16) — UPDATE and DELETE run but affect 0 rows (count proven in T61).
select lives_ok(
  format($q$do $d$ begin
              update public.inventory_item_tombstones set store_id = %L::uuid;
              delete from public.inventory_item_tombstones;
            end $d$$q$,
         current_setting('test.store_a', true)),
  'T59 AC-16 authenticated (admin) UPDATE/DELETE on the tombstone table affect no row'
);


-- ═══════════════════════════════════════════════════════════════════════════
-- POSTGRES (RLS bypassed): AC-5, AC-12, read-backs, structure
-- ═══════════════════════════════════════════════════════════════════════════
reset role;
select set_config('request.jwt.claims', null, true);

-- T15 (AC-5)
select throws_ok(
  format($q$update public.inventory_items set store_id = %L::uuid where id = %L::uuid$q$,
         current_setting('test.store_b', true), current_setting('test.iA1', true)),
  '42501',
  'inventory_items: id and store_id are immutable',
  'T15 AC-5 the store_id move is refused for postgres too (not an RLS rule)'
);

-- T16 (AC-5)
select throws_ok(
  format($q$update public.inventory_items set id = %L::uuid where id = %L::uuid$q$,
         current_setting('test.new_id2', true), current_setting('test.iA2', true)),
  '42501',
  'inventory_items: id and store_id are immutable',
  'T16 AC-5 the id re-key is refused for postgres too'
);

-- T17 (AC-5)
select ok(
  (select store_id = current_setting('test.store_a', true)::uuid
     from public.inventory_items where id = current_setting('test.iA1', true)::uuid)
  and (select count(*) = 1 from public.inventory_items
        where id = current_setting('test.iA2', true)::uuid
          and store_id = current_setting('test.store_a', true)::uuid)
  and (select count(*) = 0 from public.inventory_items
        where id in (current_setting('test.new_id', true)::uuid,
                     current_setting('test.new_id2', true)::uuid)),
  'T17 AC-5 item A1 is still store A; item A2 is still under its original id'
);

-- T19 (AC-6)
select ok(
  (select cost_per_unit = 2.5 and current_stock = 11 and par_level = 6
          and vendor_id = current_setting('test.vendor', true)::uuid
          and case_price = 30 and eod_remaining = 11
     from public.inventory_items where id = current_setting('test.iB5', true)::uuid),
  'T19 AC-6 the six perStore values landed on item B5'
);

-- T21 (AC-6)
select is(
  (select current_stock from public.inventory_items where id = current_setting('test.iA4', true)::uuid),
  14::numeric,
  'T21 AC-6 receiving raised item A4''s current_stock by the received qty (10 + 4)'
);

-- T23 (AC-6)
select is(
  (select current_stock from public.inventory_items where id = current_setting('test.iB6', true)::uuid),
  17::numeric,
  'T23 AC-6 staff_submit_eod wrote item B6''s current_stock'
);

-- T25 (AC-6)
select ok(
  (select count(*) = 2 and bool_and(par_level = 8 and cost_per_unit = 1.25 and case_price = 15)
     from public.inventory_items
    where id in (current_setting('test.iA5', true)::uuid, current_setting('test.iB4', true)::uuid)),
  'T25 AC-6 the brand scalars landed on items A5 and B4'
);

-- T27 (AC-6)
select ok(
  (select count(*) = 2 and bool_and(vendor_id = current_setting('test.vendor', true)::uuid)
     from public.inventory_items
    where id in (current_setting('test.iA5', true)::uuid, current_setting('test.iB4', true)::uuid)),
  'T27 AC-6 the brand vendor landed on items A5 and B4'
);

-- T28 (AC-6, R-2 untombstoned id unaffected)
select ok(
  current_setting('test.fresh_id', true) is not null
  and (select count(*) = 1 from public.inventory_items
        where id = current_setting('test.fresh_id', true)::uuid
          and store_id = current_setting('test.store_a', true)::uuid)
  and (select count(*) = 0 from public.inventory_item_tombstones
        where id = current_setting('test.fresh_id', true)::uuid),
  'T28 AC-6 create_inventory_item_with_catalog created a store-A item with a fresh, untombstoned id'
);

-- T30 (AC-8)
select ok(
  (select count(*) = 0 from public.inventory_items where id = current_setting('test.iB1', true)::uuid)
  and (select count(*) = 1 and bool_and(store_id = current_setting('test.store_b', true)::uuid)
         from public.inventory_item_tombstones where id = current_setting('test.iB1', true)::uuid),
  'T30 AC-8 item B1 is gone and exactly one tombstone (B1, store B) exists'
);

-- T33 (AC-9)
select ok(
  (select count(*) = 0 from public.stores where id = current_setting('test.store_c', true)::uuid)
  and (select count(*) = 0 from public.inventory_items
        where id in (current_setting('test.iC1', true)::uuid, current_setting('test.iC2', true)::uuid))
  and (select count(*) = 0 from public.purchase_orders where id = current_setting('test.po_c', true)::uuid)
  and (select count(*) = 0 from public.item_vendors where item_id = current_setting('test.iC1', true)::uuid),
  'T33 AC-9 the store, its two items, its PO and the item_vendors link are gone'
);

-- T34 (AC-9)
select is(
  (select count(*)::int from public.inventory_item_tombstones
    where store_id = current_setting('test.store_c', true)::uuid
      and id in (current_setting('test.iC1', true)::uuid, current_setting('test.iC2', true)::uuid)),
  2,
  'T34 AC-9 the store cascade wrote a tombstone for each item, with that store''s id'
);

-- T35–T37 (AC-10) — the ACTUAL brand cascade path, pinned as it is today.
-- FLIP when the brand cascade (hard_delete_brand) is fixed: T35 → lives_ok,
-- T36 → brand/store/items gone, T37 → 2 tombstones (iZ1, iZ2 under S_Z).
-- brands has two CASCADE children that matter here: catalog_ingredients and
-- stores (→ inventory_items). The brands→catalog_ingredients RI action fires
-- FIRST, and inventory_items.catalog_id (NO ACTION) is checked at the end of
-- that cascade sub-statement, while the brand's items still exist. So a bare
-- `delete from brands` (the statement hard_delete_brand() runs) of a brand
-- whose stores own items raises 23503 today — reproduced with the spec 179
-- triggers disabled, i.e. pre-existing and unrelated to this spec (the 012c
-- header's "NO ACTION defers to end-of-statement" note does not hold for
-- cascaded sub-statements). AC-10 says "the AC pins whatever is true": the
-- delete still fails exactly as before, nothing is removed, and the aborted
-- cascade leaves no tombstone behind.
select throws_ok(
  format($q$delete from public.brands where id = %L::uuid$q$, current_setting('test.brand_z', true)),
  '23503',
  'update or delete on table "catalog_ingredients" violates foreign key constraint "inventory_items_catalog_id_fkey" on table "inventory_items"',
  'T35 AC-10 deleting a brand whose store owns items fails with the pre-existing catalog FK error (unchanged)'
);

-- T36 (AC-10)
select ok(
  (select count(*) = 1 from public.brands where id = current_setting('test.brand_z', true)::uuid)
  and (select count(*) = 1 from public.stores where id = current_setting('test.store_z', true)::uuid)
  and (select count(*) = 2 from public.inventory_items
        where id in (current_setting('test.iZ1', true)::uuid, current_setting('test.iZ2', true)::uuid)),
  'T36 AC-10 the refused brand delete removed nothing (brand, store and both items remain)'
);

-- T37 (AC-10)
select is(
  (select count(*)::int from public.inventory_item_tombstones
    where store_id = current_setting('test.store_z', true)::uuid
       or id in (current_setting('test.iZ1', true)::uuid, current_setting('test.iZ2', true)::uuid)),
  0,
  'T37 AC-10 the aborted brand cascade left no tombstone'
);

-- T40 (AC-11)
select is(
  (select count(*)::int from public.inventory_item_tombstones
    where id = current_setting('test.iB2', true)::uuid
      and store_id = current_setting('test.store_b', true)::uuid),
  1,
  'T40 AC-11 the tombstone (B2, store B) exists'
);

-- T42 (AC-11)
select ok(
  (select count(*) = 0 from public.inventory_items where id = current_setting('test.iB2', true)::uuid)
  and (select count(*) = 0
         from public.order_approvals oa
         join public.inventory_items ii on ii.id = (oa.lines->0->>'item_id')::uuid
        where oa.id = current_setting('test.appr_d2', true)::uuid
          and ii.store_id = current_setting('test.store_a', true)::uuid),
  'T42 AC-11 no row has id B2, and the approval line resolves to no store-A item'
);

-- T43 (AC-12)
select throws_ok(
  format($q$insert into public.inventory_items (id, store_id, catalog_id) values (%L::uuid, %L::uuid, %L::uuid)$q$,
         current_setting('test.iB2', true), current_setting('test.store_a', true),
         current_setting('test.cB2', true)),
  '42501',
  'inventory_items: id was previously used by another store',
  'T43 AC-12 the cross-store reinsert is refused for postgres too'
);

-- T44 (AC-12)
select is(
  (select count(*)::int from public.inventory_items where id = current_setting('test.iB2', true)::uuid),
  0,
  'T44 AC-12 no row has id B2'
);

-- T49 (AC-14)
select ok(
  (select count(*) = 1 and bool_and(store_id = current_setting('test.store_b', true)::uuid)
     from public.inventory_item_tombstones where id = current_setting('test.iB3', true)::uuid)
  and (select count(*) = 0 from public.inventory_items where id = current_setting('test.iB3', true)::uuid),
  'T49 AC-14 after delete/reinsert/delete, the tombstones map B3 to store B only (1 row)'
);

-- T51 (AC-15)
select ok(
  (select count(*) = 1 from public.inventory_items where id = current_setting('test.iA1', true)::uuid)
  and (select count(*) = 0 from public.inventory_item_tombstones where id = current_setting('test.iA1', true)::uuid),
  'T51 AC-15 item A1 still exists and the refused delete left no tombstone'
);

-- T52 (D-4)
select lives_ok(
  format($q$delete from public.inventory_items where id = %L::uuid$q$, current_setting('test.iN', true)),
  'T52 D-4 deleting a storeless item is accepted'
);

-- T53 (D-4)
select ok(
  (select count(*) = 0 from public.inventory_items where id = current_setting('test.iN', true)::uuid)
  and (select count(*) = 0 from public.inventory_item_tombstones where id = current_setting('test.iN', true)::uuid),
  'T53 D-4 the storeless item is gone and recorded no tombstone'
);

-- T56 / T58 / T60 (AC-16, anon) — catalog form (no `set role anon`, spec 067).
-- anon is subject to RLS (no BYPASSRLS, not superuser, not the owner or a
-- member of it), RLS is on, and NO policy for the command applies to anon or
-- PUBLIC, so the runtime result is default-deny exactly as for admin above.
select ok(
  (select not r.rolbypassrls and not r.rolsuper
     from pg_roles r where r.rolname = 'anon')
  and not pg_has_role('anon',
        (select relowner from pg_class where oid = 'public.inventory_item_tombstones'::regclass), 'MEMBER')
  and (select relrowsecurity from pg_class where oid = 'public.inventory_item_tombstones'::regclass)
  and not exists (select 1 from pg_policies
                   where schemaname = 'public' and tablename = 'inventory_item_tombstones'
                     and cmd in ('SELECT', 'ALL')
                     and ('anon' = any(roles) or 'public' = any(roles))),
  'T56 AC-16 anon SELECT on the tombstone table sees no row (subject to RLS, no SELECT policy)'
);

select ok(
  (select not r.rolbypassrls and not r.rolsuper
     from pg_roles r where r.rolname = 'anon')
  and not pg_has_role('anon',
        (select relowner from pg_class where oid = 'public.inventory_item_tombstones'::regclass), 'MEMBER')
  and (select relrowsecurity from pg_class where oid = 'public.inventory_item_tombstones'::regclass)
  and not exists (select 1 from pg_policies
                   where schemaname = 'public' and tablename = 'inventory_item_tombstones'
                     and cmd in ('INSERT', 'ALL')
                     and ('anon' = any(roles) or 'public' = any(roles))),
  'T58 AC-16 anon INSERT into the tombstone table is refused (subject to RLS, no INSERT policy)'
);

select ok(
  (select not r.rolbypassrls and not r.rolsuper
     from pg_roles r where r.rolname = 'anon')
  and not pg_has_role('anon',
        (select relowner from pg_class where oid = 'public.inventory_item_tombstones'::regclass), 'MEMBER')
  and (select relrowsecurity from pg_class where oid = 'public.inventory_item_tombstones'::regclass)
  and not exists (select 1 from pg_policies
                   where schemaname = 'public' and tablename = 'inventory_item_tombstones'
                     and cmd in ('UPDATE', 'DELETE', 'ALL')
                     and ('anon' = any(roles) or 'public' = any(roles))),
  'T60 AC-16 anon UPDATE/DELETE on the tombstone table reach no row (subject to RLS, no policy)'
);

-- T74 (M1, AC-12) — the single-statement CTE as postgres (RLS bypassed).
select throws_ok(
  format($q$with d as (delete from public.inventory_items where id = %L::uuid returning id, catalog_id)
            insert into public.inventory_items (id, store_id, catalog_id)
            select d.id, %L::uuid, d.catalog_id from d$q$,
         current_setting('test.iB7', true), current_setting('test.store_a', true)),
  '42501',
  'inventory_items: id was previously used by another store',
  'T74 M1 a single-statement delete + reinsert under another store is refused for postgres'
);

-- T75 (M1)
select ok(
  (select count(*) = 1 from public.inventory_items
    where id = current_setting('test.iB7', true)::uuid
      and store_id = current_setting('test.store_b', true)::uuid)
  and (select count(*) = 0 from public.inventory_items
        where id = current_setting('test.iB7', true)::uuid
          and store_id = current_setting('test.store_a', true)::uuid)
  and (select count(*) = 0 from public.inventory_item_tombstones
        where id = current_setting('test.iB7', true)::uuid),
  'T75 M1 item B7 is still in store B, not in A, and the aborted statement left no tombstone'
);

-- T77 (M1) — read-back for T76 (run earlier as master).
select ok(
  (select count(*) = 1 from public.inventory_items
    where id = current_setting('test.iB8', true)::uuid
      and store_id = current_setting('test.store_b', true)::uuid)
  and (select count(*) = 0 from public.inventory_items
        where id = current_setting('test.iB8', true)::uuid
          and store_id = current_setting('test.store_a', true)::uuid)
  and (select count(*) = 0 from public.inventory_item_tombstones
        where id = current_setting('test.iB8', true)::uuid),
  'T77 M1 item B8 is still in store B, not in A, and the aborted statement left no tombstone'
);

-- T78 (SF-2 / D-4) — iB1 was tombstoned at B by T29; re-inserting it with a
-- NULL store_id is refused (B is distinct from NULL). postgres only: for
-- authenticated, RLS WITH CHECK (auth_can_see_store(NULL)) refuses first.
select throws_ok(
  format($q$insert into public.inventory_items (id, store_id, catalog_id) values (%L::uuid, null, %L::uuid)$q$,
         current_setting('test.iB1', true), current_setting('test.cB1', true)),
  '42501',
  'inventory_items: id was previously used by another store',
  'T78 SF-2 re-inserting a tombstoned id with a NULL store_id is refused'
);

-- T79 (SF-2)
select is(
  (select count(*)::int from public.inventory_items where id = current_setting('test.iB1', true)::uuid),
  0,
  'T79 SF-2 no row has id B1'
);

-- T61 (AC-16) — the whole table is unchanged since the T54 snapshot (a delta,
-- so pre-existing real tombstones on a long-lived stack don't matter), and the
-- FIXTURE tombstones (ids under c1790001-) are unchanged AND exactly 5:
-- (iB3,B) T45/T48, (iB1,B) T29, (iC1,S_C) + (iC2,S_C) T32, (iB2,B) T39.
-- T74–T80 add none (each is refused and rolled back); T52's storeless delete
-- records none; T35's aborted brand cascade records none.
select ok(
  (select count(*) = current_setting('test.tomb_count', true)::int
     from public.inventory_item_tombstones)
  and (select count(*) = current_setting('test.tomb_fixture_count', true)::int
              and count(*) = 5
         from public.inventory_item_tombstones
        where id::text like 'c1790001-%')
  and exists (select 1 from public.inventory_item_tombstones
               where id = current_setting('test.iB1', true)::uuid
                 and store_id = current_setting('test.store_b', true)::uuid),
  'T61 AC-16 tombstones unchanged since T54 (fixture rows exactly 5) and the (B1, store B) row is intact'
);

-- T62 / T63 (AC-16, D-1 Option A)
select ok(
  not has_table_privilege('authenticated', 'public.inventory_item_tombstones', 'TRUNCATE'),
  'T62 AC-16 authenticated has no TRUNCATE on the tombstone table'
);

select ok(
  not has_table_privilege('anon', 'public.inventory_item_tombstones', 'TRUNCATE'),
  'T63 AC-16 anon has no TRUNCATE on the tombstone table'
);

-- T64 (AC-16)
select ok(
  (select relrowsecurity and not relforcerowsecurity
     from pg_class where oid = 'public.inventory_item_tombstones'::regclass)
  and (select count(*) = 0 from pg_policies
        where schemaname = 'public' and tablename = 'inventory_item_tombstones'),
  'T64 AC-16 the tombstone table has RLS on, not forced, and no policies'
);

-- T65 (AC-16)
select ok(
  not exists (select 1 from pg_publication_tables
               where pubname = 'supabase_realtime'
                 and schemaname = 'public' and tablename = 'inventory_item_tombstones'),
  'T65 AC-16 the tombstone table is not in the supabase_realtime publication'
);

-- T66–T68 (AC-17) — no EXECUTE for anon, authenticated, or PUBLIC. A NULL
-- proacl means PUBLIC still holds the default grant, so it must be non-null.
select ok(
  not has_function_privilege('anon',          'public.inventory_items_lock_identity()', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.inventory_items_lock_identity()', 'EXECUTE')
  and (select p.proacl is not null
              and not exists (select 1 from aclexplode(p.proacl) a
                               where a.grantee = 0 and a.privilege_type = 'EXECUTE')
         from pg_proc p where p.oid = 'public.inventory_items_lock_identity()'::regprocedure),
  'T66 AC-17 inventory_items_lock_identity: no EXECUTE for anon, authenticated or PUBLIC'
);

select ok(
  not has_function_privilege('anon',          'public.inventory_items_check_tombstone()', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.inventory_items_check_tombstone()', 'EXECUTE')
  and (select p.proacl is not null
              and not exists (select 1 from aclexplode(p.proacl) a
                               where a.grantee = 0 and a.privilege_type = 'EXECUTE')
         from pg_proc p where p.oid = 'public.inventory_items_check_tombstone()'::regprocedure),
  'T67 AC-17 inventory_items_check_tombstone: no EXECUTE for anon, authenticated or PUBLIC'
);

select ok(
  not has_function_privilege('anon',          'public.inventory_items_record_tombstone()', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.inventory_items_record_tombstone()', 'EXECUTE')
  and (select p.proacl is not null
              and not exists (select 1 from aclexplode(p.proacl) a
                               where a.grantee = 0 and a.privilege_type = 'EXECUTE')
         from pg_proc p where p.oid = 'public.inventory_items_record_tombstone()'::regprocedure),
  'T68 AC-17 inventory_items_record_tombstone: no EXECUTE for anon, authenticated or PUBLIC'
);

-- T69 (AC-17 / D-6)
select ok(
  (select not prosecdef from pg_proc where oid = 'public.inventory_items_lock_identity()'::regprocedure)
  and (select prosecdef from pg_proc where oid = 'public.inventory_items_check_tombstone()'::regprocedure)
  and (select prosecdef from pg_proc where oid = 'public.inventory_items_record_tombstone()'::regprocedure),
  'T69 D-6 lock is SECURITY INVOKER; check and writer are SECURITY DEFINER'
);

-- T70 (AC-17 / D-6)
select ok(
  (select proconfig = array['search_path=public']
     from pg_proc where oid = 'public.inventory_items_lock_identity()'::regprocedure)
  and (select 'search_path=""' = any(proconfig)
         from pg_proc where oid = 'public.inventory_items_check_tombstone()'::regprocedure)
  and (select 'search_path=""' = any(proconfig)
         from pg_proc where oid = 'public.inventory_items_record_tombstone()'::regprocedure),
  'T70 D-6 search_path pinned: lock = public; check and writer = empty'
);

-- T71 (D-6) — the definer owner is the owner of both tables (RLS owner bypass).
select ok(
  (select count(distinct o) = 1 from (
     select proowner as o from pg_proc
      where oid in ('public.inventory_items_check_tombstone()'::regprocedure,
                    'public.inventory_items_record_tombstone()'::regprocedure)
     union all
     select relowner from pg_class
      where oid in ('public.inventory_item_tombstones'::regclass,
                    'public.inventory_items'::regclass)) x),
  'T71 D-6 both definer functions are owned by the owner of the tombstone table and of inventory_items'
);

-- T72 (AC-18)
select is(
  format('%s|%s',
  (select count(*)::int from pg_trigger
    where tgrelid = 'public.inventory_items'::regclass
      and not tgisinternal and tgenabled = 'O'
      and ((tgname = 'inventory_items_identity_lock_trg'
            and tgfoid = 'public.inventory_items_lock_identity()'::regprocedure
            and pg_get_triggerdef(oid) like '%BEFORE UPDATE OF id, store_id ON public.inventory_items FOR EACH ROW%')
        or (tgname = 'inventory_items_tombstone_check_trg'
            and tgfoid = 'public.inventory_items_check_tombstone()'::regprocedure
            and pg_get_triggerdef(oid) like '%AFTER INSERT ON public.inventory_items FOR EACH ROW%')
        or (tgname = 'inventory_items_tombstone_record_trg'
            and tgfoid = 'public.inventory_items_record_tombstone()'::regprocedure
            and pg_get_triggerdef(oid) like '%AFTER DELETE ON public.inventory_items FOR EACH ROW%'))),
  -- fix round 1: no non-internal BEFORE INSERT trigger remains (tgtype bits 2 = BEFORE, 4 = INSERT)
  (select count(*)::int from pg_trigger
    where tgrelid = 'public.inventory_items'::regclass
      and not tgisinternal
      and (tgtype & 2) <> 0
      and (tgtype & 4) <> 0)),
  '3|0',
  'T72 AC-18 the three triggers exist, are enabled, carry the designed event lists (check = AFTER INSERT), and no BEFORE INSERT trigger remains'
);

-- T73 (D-8) — BEFORE (tgtype bit 2) + UPDATE (tgtype bit 16) triggers, name order.
select is(
  (select array_agg(tgname::text order by tgname)
     from pg_trigger
    where tgrelid = 'public.inventory_items'::regclass
      and not tgisinternal
      and (tgtype & 2)  <> 0
      and (tgtype & 16) <> 0),
  array['inventory_items_identity_lock_trg', 'inventory_items_updated_at', 'trg_item_vendor_changed_at'],
  'T73 D-8 inventory_items BEFORE UPDATE triggers fire the identity lock first'
);

select * from finish();
rollback;
