-- supabase/tests/extension_ordering.test.sql
--
-- Spec 131 — pgTAP coverage for the browser-extension pending-order backend
-- (supabase/migrations/20260723000000_extension_ordering.sql). Covers D-12:
--
--   COLUMN: item_vendors.product_page_url exists + nullable + inherits the
--     store_member_*_item_vendors RLS (a non-member cannot write it).
--
--   get_pending_extension_orders (RPC 1, AC-3):
--     (P1) a draft PO whose vendor has extension_ordering=true IS in the set;
--     (P2) a draft PO whose vendor is opted-OUT is NOT in the set;
--     (P3) a NON-draft (sent) PO of an opted-in vendor is NOT in the set;
--     (P4) p_vendor_id filters to that vendor;
--     (P5) a non-member does NOT see another store's pending PO (INVOKER RLS).
--
--   get_extension_order_payload (RPC 2, AC-4):
--     (Q1) returns the PO's structured lines incl. the order_code join + the
--          unmapped (order_code null) line surfaced with orderCode:null;
--     (Q2) a non-member is refused (P0002 not-found under INVOKER RLS);
--     (Q3) a not-found po id raises P0002.
--
--   mark-ordered write-back (AC-6, D-4 — the guarded draft→sent UPDATE):
--     (M1) the guarded UPDATE flips draft → sent (drops out of the pending set);
--     (M2) it is idempotent / cannot resurrect a non-draft PO (0-row no-op);
--     (M3) a non-member cannot flip another store's PO (0-row under RLS).
--
-- Fixtures created INSIDE the transaction (hermetic under seed AND CI-fresh).
-- Master-JWT for privileged fixture writes; the 2222 manager is a Frederick
-- member (NOT Charles). Mirrors po_loop.test.sql. No `set role anon` (segfaults
-- CI per spec 067). Hermetic: begin; … rollback;.

begin;
create extension if not exists pgtap;

select plan(19);

-- ─── fixtures ──────────────────────────────────────────────────
do $$
declare
  v_master_id  uuid := '33333333-3333-3333-3333-333333333333';
  v_manager_id uuid := '22222222-2222-2222-2222-222222222222';
  v_frederick  uuid;
  v_charles    uuid;
  v_brand_id   uuid;
begin
  select id into v_frederick from public.stores where name = 'Frederick' limit 1;
  select id into v_charles   from public.stores where name = 'Charles'   limit 1;
  select id into v_brand_id  from public.brands  limit 1;
  perform set_config('test.master_id',    v_master_id::text,  true);
  perform set_config('test.manager_id',   v_manager_id::text, true);
  perform set_config('test.frederick_id', v_frederick::text,  true);
  perform set_config('test.charles_id',   v_charles::text,    true);
  perform set_config('test.brand_id',     v_brand_id::text,   true);
end $$;

-- ─── product_page_url column shape (metadata, RLS-free) ────────
select has_column('item_vendors', 'product_page_url', 'item_vendors.product_page_url column exists');
select col_is_null('item_vendors', 'product_page_url', 'item_vendors.product_page_url is nullable');
select col_type_is('item_vendors', 'product_page_url', 'text', 'item_vendors.product_page_url is text');

-- ─── seed two opted-in / opted-out vendors + a Frederick item + links ──────
-- Seeded as the default (superuser) role → bypasses RLS, exists before the
-- impersonated reads run.
insert into public.vendors (id, name, brand_id, extension_ordering, order_page_url)
values
  ('99999999-9999-9999-9999-9999999931a1', '__ext_vendor_on__',  current_setting('test.brand_id', true)::uuid, true,  'https://www.samsclub.com/orders'),
  ('99999999-9999-9999-9999-9999999931b2', '__ext_vendor_off__', current_setting('test.brand_id', true)::uuid, false, null);

-- A Frederick catalog ingredient + inventory item + item_vendors link (with an
-- order_code) to the opted-in vendor; a SECOND item with NO code (unmapped).
do $$
declare
  v_cat1 uuid; v_cat2 uuid; v_item1 uuid; v_item2 uuid;
begin
  insert into public.catalog_ingredients (brand_id, name, unit, case_qty, sub_unit_size, default_cost)
  values (current_setting('test.brand_id', true)::uuid, 'SPEC131-A-'||gen_random_uuid()::text, 'each', 24, 1, 2.00)
  returning id into v_cat1;
  insert into public.catalog_ingredients (brand_id, name, unit, case_qty, sub_unit_size, default_cost)
  values (current_setting('test.brand_id', true)::uuid, 'SPEC131-B-'||gen_random_uuid()::text, 'each', 1, 1, 3.00)
  returning id into v_cat2;

  insert into public.inventory_items (store_id, catalog_id, vendor_id, cost_per_unit, current_stock, par_level)
  values (current_setting('test.frederick_id', true)::uuid, v_cat1,
          '99999999-9999-9999-9999-9999999931a1', 2.00, 10, 0)
  returning id into v_item1;
  insert into public.inventory_items (store_id, catalog_id, vendor_id, cost_per_unit, current_stock, par_level)
  values (current_setting('test.frederick_id', true)::uuid, v_cat2,
          '99999999-9999-9999-9999-9999999931a1', 3.00, 5, 0)
  returning id into v_item2;

  perform set_config('test.item1', v_item1::text, true);
  perform set_config('test.item2', v_item2::text, true);

  -- item1 → opted-in vendor WITH an order code; item2 → same vendor NO code.
  insert into public.item_vendors (item_id, vendor_id, cost_per_unit, case_price, is_primary, order_code, product_page_url)
  values (v_item1, '99999999-9999-9999-9999-9999999931a1', 2.00, 48.00, true, 'SAMS-1001', 'https://www.samsclub.com/p/item1'),
         (v_item2, '99999999-9999-9999-9999-9999999931a1', 3.00, 3.00,  true, null, null);
end $$;

-- Draft PO for the opted-in vendor (2 lines) + a draft PO for the opted-out
-- vendor + a SENT PO for the opted-in vendor (must NOT appear in pending).
do $$
declare v_po_on uuid; v_po_off uuid; v_po_sent uuid;
begin
  insert into public.purchase_orders (store_id, vendor_id, created_by, status, total_cost)
  values (current_setting('test.frederick_id', true)::uuid, '99999999-9999-9999-9999-9999999931a1',
          current_setting('test.master_id', true)::uuid, 'draft', 99.00)
  returning id into v_po_on;
  insert into public.po_items (po_id, item_id, ordered_qty, cost_per_unit)
  values (v_po_on, current_setting('test.item1', true)::uuid, 48, 2.00),
         (v_po_on, current_setting('test.item2', true)::uuid, 5,  3.00);

  insert into public.purchase_orders (store_id, vendor_id, created_by, status, total_cost)
  values (current_setting('test.frederick_id', true)::uuid, '99999999-9999-9999-9999-9999999931b2',
          current_setting('test.master_id', true)::uuid, 'draft', 10.00)
  returning id into v_po_off;

  insert into public.purchase_orders (store_id, vendor_id, created_by, status, total_cost)
  values (current_setting('test.frederick_id', true)::uuid, '99999999-9999-9999-9999-9999999931a1',
          current_setting('test.master_id', true)::uuid, 'sent', 50.00)
  returning id into v_po_sent;

  perform set_config('test.po_on',   v_po_on::text,   true);
  perform set_config('test.po_off',  v_po_off::text,  true);
  perform set_config('test.po_sent', v_po_sent::text, true);
end $$;

-- ─── impersonate the Frederick member (2222) for the RPC reads ─────────────
set local role authenticated;
select set_config('request.jwt.claims',
  jsonb_build_object('sub', current_setting('test.manager_id', true), 'role', 'authenticated',
                     'app_metadata', jsonb_build_object('role', 'user'))::text, true);

-- (P1) the draft opted-in PO IS in the pending set.
select is(
  (select count(*)::int
     from jsonb_array_elements(public.get_pending_extension_orders(null)) e
    where e->>'poId' = current_setting('test.po_on', true)),
  1,
  '(P1) draft PO of an extension_ordering vendor IS in the pending set'
);

-- (P2) the opted-OUT vendor's draft PO is NOT in the set.
select is(
  (select count(*)::int
     from jsonb_array_elements(public.get_pending_extension_orders(null)) e
    where e->>'poId' = current_setting('test.po_off', true)),
  0,
  '(P2) draft PO of an opted-OUT vendor is NOT pending'
);

-- (P3) the SENT PO of the opted-in vendor is NOT in the set (status != draft).
select is(
  (select count(*)::int
     from jsonb_array_elements(public.get_pending_extension_orders(null)) e
    where e->>'poId' = current_setting('test.po_sent', true)),
  0,
  '(P3) a non-draft (sent) PO is NOT pending'
);

-- (P4) p_vendor_id filters to that vendor (the opted-in one → the draft PO).
select is(
  (select count(*)::int
     from jsonb_array_elements(
            public.get_pending_extension_orders('99999999-9999-9999-9999-9999999931a1'::uuid)) e
    where e->>'poId' = current_setting('test.po_on', true)),
  1,
  '(P4) p_vendor_id filters the pending set to that vendor'
);

-- (P4b) the pending row reports the unmapped line count (item2 has no code).
select is(
  (select (e->>'unmappedCount')::int
     from jsonb_array_elements(public.get_pending_extension_orders(null)) e
    where e->>'poId' = current_setting('test.po_on', true)),
  1,
  '(P4b) pending row reports unmappedCount = 1 (item2 has no order_code)'
);

-- (Q1) get_extension_order_payload returns the structured lines + the order_code
-- join; the unmapped line is surfaced with orderCode null (never dropped).
create temp table _pl on commit drop as
select public.get_extension_order_payload(current_setting('test.po_on', true)::uuid) as env;

select is(
  (select jsonb_array_length(env->'lines') from _pl),
  2,
  '(Q1a) payload returns both PO lines (unmapped line NOT dropped)'
);
select is(
  (select l->>'orderCode' from _pl, jsonb_array_elements(env->'lines') l
    where l->>'itemId' = current_setting('test.item1', true)),
  'SAMS-1001',
  '(Q1b) mapped line carries the item_vendors.order_code (SAMS-1001)'
);
select ok(
  (select (l->'orderCode') = 'null'::jsonb from _pl, jsonb_array_elements(env->'lines') l
    where l->>'itemId' = current_setting('test.item2', true)),
  '(Q1c) unmapped line surfaces orderCode:null (never dropped, AC-4)'
);
select is(
  (select env->>'orderPageUrl' from _pl),
  'https://www.samsclub.com/orders',
  '(Q1d) payload carries the vendor order_page_url'
);

-- (Q2) a non-member (still the manager) reading a Charles PO is refused.
-- Create a Charles draft PO as master, then re-check as the manager.
select set_config('request.jwt.claims',
  jsonb_build_object('sub', current_setting('test.master_id', true), 'role', 'authenticated',
                     'app_metadata', jsonb_build_object('role', 'master'))::text, true);
do $$
declare v_po_ch uuid;
begin
  insert into public.purchase_orders (store_id, vendor_id, created_by, status, total_cost)
  values (current_setting('test.charles_id', true)::uuid, '99999999-9999-9999-9999-9999999931a1',
          current_setting('test.master_id', true)::uuid, 'draft', 20.00)
  returning id into v_po_ch;
  perform set_config('test.po_charles', v_po_ch::text, true);
end $$;
select set_config('request.jwt.claims',
  jsonb_build_object('sub', current_setting('test.manager_id', true), 'role', 'authenticated',
                     'app_metadata', jsonb_build_object('role', 'user'))::text, true);

-- (P5) the Charles pending PO is NOT visible to the Frederick member.
select is(
  (select count(*)::int
     from jsonb_array_elements(public.get_pending_extension_orders(null)) e
    where e->>'poId' = current_setting('test.po_charles', true)),
  0,
  '(P5) a non-member does NOT see another store''s pending PO (INVOKER RLS)'
);

-- (Q2) reading the Charles payload as a non-member → P0002 (INVOKER RLS hides
-- the row so the store gate never resolves; a hard refusal that also hides
-- existence — same posture as po_loop receive_purchase_order (F)).
select throws_ok(
  format($q$select public.get_extension_order_payload(%L::uuid)$q$, current_setting('test.po_charles', true)),
  'P0002',
  null,
  '(Q2) non-member reading another store''s payload is refused (P0002 under INVOKER RLS)'
);

-- (Q3) a bogus po id → P0002.
select throws_ok(
  $q$select public.get_extension_order_payload('00000000-0000-0000-0000-000000000000'::uuid)$q$,
  'P0002',
  null,
  '(Q3) a not-found po id raises P0002'
);

-- ─── mark-ordered write-back (the guarded draft→sent UPDATE, D-4) ──────────
-- (M1) the Frederick member flips their own draft PO to sent (drops out of
-- pending). Guarded on status='draft' (idempotent + no resurrection).
update public.purchase_orders set status = 'sent'
  where id = current_setting('test.po_on', true)::uuid and status = 'draft';

select is(
  (select status from public.purchase_orders where id = current_setting('test.po_on', true)::uuid),
  'sent',
  '(M1) the guarded draft→sent UPDATE marked the PO ordered'
);
select is(
  (select count(*)::int
     from jsonb_array_elements(public.get_pending_extension_orders(null)) e
    where e->>'poId' = current_setting('test.po_on', true)),
  0,
  '(M1b) the marked PO dropped out of the pending set'
);

-- (M2) re-running the guarded UPDATE is a 0-row no-op (idempotent) — the PO is
-- already sent, so `and status='draft'` matches nothing and it stays sent.
update public.purchase_orders set status = 'sent'
  where id = current_setting('test.po_on', true)::uuid and status = 'draft';
select is(
  (select status from public.purchase_orders where id = current_setting('test.po_on', true)::uuid),
  'sent',
  '(M2) re-marking an already-sent PO is a 0-row no-op (idempotent)'
);

-- (M3) a non-member (still the Frederick manager 2222) attempting the guarded
-- draft→sent UPDATE against the Charles PO is denied by RLS
-- (store_member_update_purchase_orders' USING clause filters the row → 0-row
-- update, RAISES NOTHING) → status unchanged (stays draft). This is the WRITE
-- side of the exact store gate the READ side got at (P5)/(Q2), and the property
-- AC-6 names: "a caller cannot mark a PO ordered in a store they can't see."
update public.purchase_orders set status = 'sent'
  where id = current_setting('test.po_charles', true)::uuid and status = 'draft';

-- Verify as master — RLS hides the Charles row from the Frederick manager, so
-- the value-unchanged check must run as a store-visible (privileged) caller.
select set_config('request.jwt.claims',
  jsonb_build_object('sub', current_setting('test.master_id', true), 'role', 'authenticated',
                     'app_metadata', jsonb_build_object('role', 'master'))::text, true);
select is(
  (select status from public.purchase_orders where id = current_setting('test.po_charles', true)::uuid),
  'draft',
  '(M3) a non-member CANNOT flip another store''s PO — RLS 0-row update left status draft'
);

select * from finish();
rollback;
