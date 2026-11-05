-- supabase/tests/cross_store_item_rejection.test.sql
--
-- Spec 177 — pgTAP coverage for the three store-consistency triggers shipped in
-- supabase/migrations/20261025000000_cross_store_item_rejection.sql:
--
--   (R-1) public.po_items_check_store()            — po_items_check_store_trg
--   (R-2) public.order_approvals_lines_check_store() — order_approvals_lines_check_store_trg
--   (R-3) public.purchase_orders_lock_store_id()   — purchase_orders_lock_store_id_trg
--
-- Plan: the design §9 table, T01–T54. Every throws_ok asserts BOTH the SQLSTATE
-- and the EXACT message (inventory_count_entries_check_store.test.sql
-- precedent), so a different trigger raising the same errcode cannot pass an
-- arm silently. Every acceptance arm re-reads the row (anti-vacuity).
--
-- Fixtures: store A = Charles, store B = Frederick (same brand). The seed
-- master 3333 sees both (R-1 / R-3 caller); the seed admin 1111 is privileged
-- and sees both (R-2 caller); the seed manager 2222 ('user', Frederick +
-- Towson) is the one-store caller. T01/T02 prove the two-store callers really
-- see both stores, so no cross-store arm passes because RLS hid the row.
--
-- Hermetic: begin; … rollback;. All fixtures created inside the transaction.
-- JWT impersonation via `set local role authenticated` + request.jwt.claims.
-- No `set role anon` (segfaults CI per spec 067).

begin;
create extension if not exists pgtap;

select plan(54);

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

  -- Fixed literal ids (c177 prefix).
  perform set_config('test.item_a',  'c1770001-0000-0000-0000-000000000001', true);
  perform set_config('test.item_b',  'c1770001-0000-0000-0000-000000000002', true);
  perform set_config('test.item_b2', 'c1770001-0000-0000-0000-000000000003', true);
  perform set_config('test.vendor',  'c1770002-0000-0000-0000-000000000001', true);
  perform set_config('test.po_a',    'c1770003-0000-0000-0000-000000000001', true);
  perform set_config('test.po_b',    'c1770003-0000-0000-0000-000000000002', true);
  perform set_config('test.po_b2',   'c1770003-0000-0000-0000-000000000003', true);
  perform set_config('test.po_e',    'c1770003-0000-0000-0000-000000000004', true);
  perform set_config('test.po_n',    'c1770003-0000-0000-0000-000000000005', true);
  perform set_config('test.line_a',  'c1770004-0000-0000-0000-000000000001', true);
  perform set_config('test.line_b',  'c1770004-0000-0000-0000-000000000002', true);
  perform set_config('test.line_b2', 'c1770004-0000-0000-0000-000000000003', true);
  perform set_config('test.line_new','c1770004-0000-0000-0000-000000000009', true);
end $$;

insert into public.catalog_ingredients (id, brand_id, name, unit)
values
  ('c1770000-0000-0000-0000-000000000001', current_setting('test.brand', true)::uuid, '__s177_cat_a__',  'each'),
  ('c1770000-0000-0000-0000-000000000002', current_setting('test.brand', true)::uuid, '__s177_cat_b__',  'each'),
  ('c1770000-0000-0000-0000-000000000003', current_setting('test.brand', true)::uuid, '__s177_cat_b2__', 'each');

insert into public.inventory_items (id, store_id, catalog_id, current_stock)
values
  (current_setting('test.item_a',  true)::uuid, current_setting('test.store_a', true)::uuid,
   'c1770000-0000-0000-0000-000000000001', 0),
  (current_setting('test.item_b',  true)::uuid, current_setting('test.store_b', true)::uuid,
   'c1770000-0000-0000-0000-000000000002', 0),
  (current_setting('test.item_b2', true)::uuid, current_setting('test.store_b', true)::uuid,
   'c1770000-0000-0000-0000-000000000003', 0);

-- Brand vendor with null order_channel and no extension flag ⇒ resolves 'manual'.
insert into public.vendors (id, name, brand_id, order_channel, extension_ordering)
values (current_setting('test.vendor', true)::uuid, '__s177_vendor__',
        current_setting('test.brand', true)::uuid, null, false);

insert into public.purchase_orders (id, store_id, vendor_id, status)
values
  (current_setting('test.po_a',  true)::uuid, current_setting('test.store_a', true)::uuid,
   current_setting('test.vendor', true)::uuid, 'draft'),
  (current_setting('test.po_b',  true)::uuid, current_setting('test.store_b', true)::uuid,
   current_setting('test.vendor', true)::uuid, 'draft'),
  (current_setting('test.po_b2', true)::uuid, current_setting('test.store_b', true)::uuid,
   current_setting('test.vendor', true)::uuid, 'sent'),
  (current_setting('test.po_e',  true)::uuid, current_setting('test.store_b', true)::uuid,
   current_setting('test.vendor', true)::uuid, 'draft'),
  (current_setting('test.po_n',  true)::uuid, null,
   current_setting('test.vendor', true)::uuid, 'draft');

insert into public.po_items (id, po_id, item_id, ordered_qty, received_qty, cost_per_unit)
values
  (current_setting('test.line_a',  true)::uuid, current_setting('test.po_a',  true)::uuid,
   current_setting('test.item_a', true)::uuid, 5, null, 2.00),
  (current_setting('test.line_b',  true)::uuid, current_setting('test.po_b',  true)::uuid,
   current_setting('test.item_b', true)::uuid, 5, null, 2.00),
  (current_setting('test.line_b2', true)::uuid, current_setting('test.po_b2', true)::uuid,
   current_setting('test.item_b', true)::uuid, 4, null, 2.00);

-- Approval line payload builder: one well-formed RPC line per item id.
create function pg_temp.l177(variadic p_items uuid[]) returns jsonb
language sql immutable as $$
  select jsonb_agg(jsonb_build_object(
           'item_id', i, 'item_name', '__s177_line__', 'qty_base', 2,
           'case_qty', 1, 'unit', 'each', 'cost_per_counted_unit', 1.5)
         order by o)
    from unnest(p_items) with ordinality as u(i, o)
$$;


-- ═══════════════════════════════════════════════════════════════════════════
-- (R-1) po_items — as MASTER (sees both stores)
-- ═══════════════════════════════════════════════════════════════════════════
set local role authenticated;
select set_config('request.jwt.claims', jsonb_build_object(
  'sub', current_setting('test.master_id', true),
  'role', 'authenticated',
  'app_metadata', jsonb_build_object('role', 'master')
)::text, true);

-- T01
select ok(
  public.auth_can_see_store(current_setting('test.store_a', true)::uuid)
    and public.auth_can_see_store(current_setting('test.store_b', true)::uuid),
  'T01 master sees store A and store B (cross-store arms are not RLS-hidden)'
);

-- T03 (AC-1)
select throws_ok(
  format($q$insert into public.po_items (po_id, item_id, ordered_qty) values (%L::uuid, %L::uuid, 1)$q$,
         current_setting('test.po_b', true), current_setting('test.item_a', true)),
  '42501',
  'po_items: item store mismatch with parent purchase order',
  'T03 AC-1 INSERT of a store-A item on store B''s PO is rejected'
);

-- T04 (AC-1)
select is(
  (select count(*)::int from public.po_items
    where po_id = current_setting('test.po_b', true)::uuid
      and item_id = current_setting('test.item_a', true)::uuid),
  0,
  'T04 AC-1 no cross-store line was written'
);

-- T05 (AC-5)
select lives_ok(
  format($q$insert into public.po_items (id, po_id, item_id, ordered_qty) values (%L::uuid, %L::uuid, %L::uuid, 3)$q$,
         current_setting('test.line_new', true), current_setting('test.po_b', true),
         current_setting('test.item_b', true)),
  'T05 AC-5 same-store INSERT (B''s PO, B''s item) is accepted (the revoke does not block firing)'
);

-- T06 (AC-5)
select is(
  (select count(*)::int from public.po_items
    where id = current_setting('test.line_new', true)::uuid
      and po_id = current_setting('test.po_b', true)::uuid
      and item_id = current_setting('test.item_b', true)::uuid),
  1,
  'T06 AC-5 the same-store line exists'
);

-- T07 (AC-2)
select throws_ok(
  format($q$update public.po_items set item_id = %L::uuid where id = %L::uuid$q$,
         current_setting('test.item_a', true), current_setting('test.line_b', true)),
  '42501',
  'po_items: item store mismatch with parent purchase order',
  'T07 AC-2 UPDATE of item_id to a store-A item on B''s PO is rejected'
);

-- T08 (AC-2)
select is(
  (select item_id::text from public.po_items where id = current_setting('test.line_b', true)::uuid),
  current_setting('test.item_b', true),
  'T08 AC-2 the line''s item_id is unchanged'
);

-- T09 (AC-3)
select throws_ok(
  format($q$update public.po_items set po_id = %L::uuid where id = %L::uuid$q$,
         current_setting('test.po_b', true), current_setting('test.line_a', true)),
  '42501',
  'po_items: item store mismatch with parent purchase order',
  'T09 AC-3 moving a store-A line onto B''s PO is rejected'
);

-- T10 (AC-3)
select is(
  (select po_id::text from public.po_items where id = current_setting('test.line_a', true)::uuid),
  current_setting('test.po_a', true),
  'T10 AC-3 the line''s po_id is unchanged'
);

-- T11 (AC-4)
select throws_ok(
  format($q$insert into public.po_items (po_id, item_id, ordered_qty) values (%L::uuid, null, 1)$q$,
         current_setting('test.po_b', true)),
  '42501',
  'po_items: item store mismatch with parent purchase order',
  'T11 AC-4 INSERT with a null item_id fails closed'
);

-- T12 (AC-4)
select throws_ok(
  format($q$insert into public.po_items (po_id, item_id, ordered_qty) values (gen_random_uuid(), %L::uuid, 1)$q$,
         current_setting('test.item_b', true)),
  '42501',
  'po_items: parent purchase order not found, not visible, or has no store',
  'T12 AC-4 INSERT under a missing parent PO fails closed'
);

-- T13 (AC-4) — the null-store branch, with the parent VISIBLE (postgres).
reset role;
select throws_ok(
  format($q$insert into public.po_items (po_id, item_id, ordered_qty) values (%L::uuid, %L::uuid, 1)$q$,
         current_setting('test.po_n', true), current_setting('test.item_b', true)),
  '42501',
  'po_items: parent purchase order not found, not visible, or has no store',
  'T13 AC-4 INSERT under a null-store parent PO fails closed (parent visible)'
);

-- T14 / T15 (AC-4) — the one-store MANAGER (Frederick + Towson, NOT Charles).
set local role authenticated;
select set_config('request.jwt.claims', jsonb_build_object(
  'sub', current_setting('test.manager_id', true),
  'role', 'authenticated',
  'app_metadata', jsonb_build_object('role', 'user')
)::text, true);

-- T14: the trigger runs BEFORE the RLS WITH CHECK, so the trigger's message wins.
select throws_ok(
  format($q$insert into public.po_items (po_id, item_id, ordered_qty) values (%L::uuid, %L::uuid, 1)$q$,
         current_setting('test.po_a', true), current_setting('test.item_a', true)),
  '42501',
  'po_items: parent purchase order not found, not visible, or has no store',
  'T14 AC-4 INSERT under an invisible parent PO fails closed with the trigger''s message'
);

-- T15: the precedent's case — the item is invisible to the caller.
select throws_ok(
  format($q$insert into public.po_items (po_id, item_id, ordered_qty) values (%L::uuid, %L::uuid, 1)$q$,
         current_setting('test.po_b', true), current_setting('test.item_a', true)),
  '42501',
  'po_items: item store mismatch with parent purchase order',
  'T15 AC-4 INSERT naming an invisible (other-store) item fails closed'
);

-- Back to MASTER.
select set_config('request.jwt.claims', jsonb_build_object(
  'sub', current_setting('test.master_id', true),
  'role', 'authenticated',
  'app_metadata', jsonb_build_object('role', 'master')
)::text, true);

-- T16 (N1 / D-4) — a pass-through SET of item_id / po_id.
select lives_ok(
  format($q$update public.po_items set item_id = item_id, po_id = po_id where id = %L::uuid$q$,
         current_setting('test.line_b', true)),
  'T16 N1 a pass-through SET of item_id/po_id is accepted (short-circuit)'
);

-- T17 (AC-6)
select lives_ok(
  format($q$update public.po_items set received_qty = 1, cost_per_unit = 3.5, ordered_qty = 6 where id = %L::uuid$q$,
         current_setting('test.line_b', true)),
  'T17 AC-6 a receiving-style UPDATE (received_qty, cost_per_unit, ordered_qty) is accepted'
);

-- T18 (AC-6)
select ok(
  (select received_qty = 1 and cost_per_unit = 3.5 and ordered_qty = 6
     from public.po_items where id = current_setting('test.line_b', true)::uuid),
  'T18 AC-6 the three receiving values changed'
);

-- T19 (AC-6) — the real receiving RPC (po_loop.test.sql arm-A call shape).
select lives_ok(
  format($q$select public.receive_purchase_order(%L::uuid,
              jsonb_build_array(jsonb_build_object('po_item_id', %L::uuid, 'received_qty', 4)),
              gen_random_uuid())$q$,
         current_setting('test.po_b2', true), current_setting('test.line_b2', true)),
  'T19 AC-6 receive_purchase_order on a same-store PO is accepted'
);

-- T20 (AC-6)
select is(
  (select received_qty from public.po_items where id = current_setting('test.line_b2', true)::uuid),
  4::numeric,
  'T20 AC-6 the RPC wrote received_qty'
);


-- ═══════════════════════════════════════════════════════════════════════════
-- (R-2) order_approvals — as ADMIN (privileged, sees both stores)
-- ═══════════════════════════════════════════════════════════════════════════
select set_config('request.jwt.claims', jsonb_build_object(
  'sub', current_setting('test.admin_id', true),
  'role', 'authenticated',
  'app_metadata', jsonb_build_object('role', 'admin')
)::text, true);

-- T02
select ok(
  public.auth_can_see_store(current_setting('test.store_a', true)::uuid)
    and public.auth_can_see_store(current_setting('test.store_b', true)::uuid)
    and public.auth_is_privileged(),
  'T02 admin is privileged and sees store A and store B'
);

-- T21 (AC-8)
select throws_ok(
  format($q$select public.create_order_approval(%L::uuid, %L::uuid, date '2026-10-01', %L::jsonb, null)$q$,
         current_setting('test.store_b', true), current_setting('test.vendor', true),
         pg_temp.l177(current_setting('test.item_a', true)::uuid)),
  '42501',
  'order_approvals: line item store mismatch with approval store',
  'T21 AC-8 create_order_approval for store B with a store-A item is rejected'
);

-- T22 (AC-8)
select is(
  (select count(*)::int from public.order_approvals
    where store_id = current_setting('test.store_b', true)::uuid
      and vendor_id = current_setting('test.vendor', true)::uuid
      and business_date = date '2026-10-01'),
  0,
  'T22 AC-8 no approval row was written'
);

-- T23 (AC-9)
select throws_ok(
  format($q$select public.create_order_approval(%L::uuid, %L::uuid, date '2026-10-02', %L::jsonb, null)$q$,
         current_setting('test.store_b', true), current_setting('test.vendor', true),
         pg_temp.l177(current_setting('test.item_b', true)::uuid,
                      current_setting('test.item_a', true)::uuid)),
  '42501',
  'order_approvals: line item store mismatch with approval store',
  'T23 AC-9 a mixed-lines RPC call (B item + A item) is rejected'
);

-- T24 (AC-9)
select is(
  (select count(*)::int from public.order_approvals
    where store_id = current_setting('test.store_b', true)::uuid
      and vendor_id = current_setting('test.vendor', true)::uuid
      and business_date = date '2026-10-02'),
  0,
  'T24 AC-9 no approval row was written'
);

-- T25 (AC-10)
select throws_ok(
  format($q$insert into public.order_approvals
              (store_id, vendor_id, business_date, approved_by, channel, lines, line_count)
            values (%L::uuid, %L::uuid, date '2026-10-03', auth.uid(), 'manual', %L::jsonb, 1)$q$,
         current_setting('test.store_b', true), current_setting('test.vendor', true),
         pg_temp.l177(current_setting('test.item_a', true)::uuid)),
  '42501',
  'order_approvals: line item store mismatch with approval store',
  'T25 AC-10 a direct INSERT for store B with a store-A item is rejected'
);

-- T26 (AC-10)
select is(
  (select count(*)::int from public.order_approvals
    where store_id = current_setting('test.store_b', true)::uuid
      and vendor_id = current_setting('test.vendor', true)::uuid
      and business_date = date '2026-10-03'),
  0,
  'T26 AC-10 no approval row was written'
);

-- T27 (R-2 fail closed on a missing item)
select throws_ok(
  format($q$insert into public.order_approvals
              (store_id, vendor_id, business_date, approved_by, channel, lines, line_count)
            values (%L::uuid, %L::uuid, date '2026-10-04', auth.uid(), 'manual', %L::jsonb, 1)$q$,
         current_setting('test.store_b', true), current_setting('test.vendor', true),
         pg_temp.l177('c177ffff-0000-0000-0000-000000000001'::uuid)),
  '42501',
  'order_approvals: line item store mismatch with approval store',
  'T27 R-2 a direct INSERT naming a nonexistent item fails closed'
);

-- T28 (AC-13) — same-store approval through the RPC.
do $$
begin
  perform public.create_order_approval(
    current_setting('test.store_b', true)::uuid,
    current_setting('test.vendor', true)::uuid,
    date '2026-10-05',
    pg_temp.l177(current_setting('test.item_b', true)::uuid),
    null);
end $$;

select is(
  (select format('%s|%s', status, line_count) from public.order_approvals
    where store_id = current_setting('test.store_b', true)::uuid
      and vendor_id = current_setting('test.vendor', true)::uuid
      and business_date = date '2026-10-05'),
  'pending|1',
  'T28 AC-13 a same-store RPC approval lands as pending with 1 line'
);

-- T29 (AC-13) — same-store pending retry with changed B lines.
do $$
begin
  perform public.create_order_approval(
    current_setting('test.store_b', true)::uuid,
    current_setting('test.vendor', true)::uuid,
    date '2026-10-05',
    pg_temp.l177(current_setting('test.item_b', true)::uuid,
                 current_setting('test.item_b2', true)::uuid),
    null);
  perform set_config('test.d5_id', (
    select id::text from public.order_approvals
     where store_id = current_setting('test.store_b', true)::uuid
       and vendor_id = current_setting('test.vendor', true)::uuid
       and business_date = date '2026-10-05'), true);
  perform set_config('test.d5_lines', (
    select lines::text from public.order_approvals
     where id = current_setting('test.d5_id', true)::uuid), true);
end $$;

select ok(
  (select line_count = 2
          and lines @> jsonb_build_array(jsonb_build_object('item_id', current_setting('test.item_b2', true)))
     from public.order_approvals where id = current_setting('test.d5_id', true)::uuid),
  'T29 AC-13 a same-store pending retry updated the lines (2 lines, includes item_B2)'
);

-- T30 (AC-11)
select throws_ok(
  format($q$update public.order_approvals set lines = %L::jsonb where id = %L::uuid$q$,
         pg_temp.l177(current_setting('test.item_a', true)::uuid),
         current_setting('test.d5_id', true)),
  '42501',
  'order_approvals: line item store mismatch with approval store',
  'T30 AC-11 a direct PATCH of a pending row''s lines to a store-A item is rejected'
);

-- T31 (AC-11)
select is(
  (select lines from public.order_approvals where id = current_setting('test.d5_id', true)::uuid),
  current_setting('test.d5_lines', true)::jsonb,
  'T31 AC-11 the pending row''s lines are unchanged'
);

-- T32 (AC-12)
select throws_ok(
  format($q$select public.create_order_approval(%L::uuid, %L::uuid, date '2026-10-05', %L::jsonb, null)$q$,
         current_setting('test.store_b', true), current_setting('test.vendor', true),
         pg_temp.l177(current_setting('test.item_a', true)::uuid)),
  '42501',
  'order_approvals: line item store mismatch with approval store',
  'T32 AC-12 an RPC pending-retry with a store-A item is rejected'
);

-- T33 (AC-12)
select is(
  (select lines from public.order_approvals where id = current_setting('test.d5_id', true)::uuid),
  current_setting('test.d5_lines', true)::jsonb,
  'T33 AC-12 the original lines are unchanged'
);

-- T34 (N1 / D-4)
select lives_ok(
  format($q$update public.order_approvals set lines = lines where id = %L::uuid$q$,
         current_setting('test.d5_id', true)),
  'T34 N1 a pass-through SET of lines is accepted (short-circuit)'
);

-- T35 (AC-14)
select lives_ok(
  format($q$update public.order_approvals
              set status = 'approved', external_ref = 'https://example.test/s177'
            where id = %L::uuid$q$,
         current_setting('test.d5_id', true)),
  'T35 AC-14 a status advance with an external_ref write is accepted'
);

-- T36 (AC-14)
select is(
  (select format('%s|%s', status, external_ref) from public.order_approvals
    where id = current_setting('test.d5_id', true)::uuid),
  'approved|https://example.test/s177',
  'T36 AC-14 status and external_ref changed'
);

-- T37 (N3 / D-6) — the guard fires first on a non-pending row.
select throws_ok(
  format($q$update public.order_approvals set lines = %L::jsonb where id = %L::uuid$q$,
         pg_temp.l177(current_setting('test.item_a', true)::uuid),
         current_setting('test.d5_id', true)),
  'P0001',
  'order approval snapshot is immutable once approved',
  'T37 D-6 a lines PATCH on an approved row reports the guard''s error (guard runs first)'
);

-- T38–T41 (AC-15) — malformed lines through a direct INSERT.
select throws_ok(
  format($q$insert into public.order_approvals
              (store_id, vendor_id, business_date, approved_by, channel, lines, line_count)
            values (%L::uuid, %L::uuid, date '2026-10-06', auth.uid(), 'manual', %L::jsonb, 1)$q$,
         current_setting('test.store_b', true), current_setting('test.vendor', true),
         jsonb_build_object('item_id', current_setting('test.item_b', true))),
  '22023',
  'order_approvals: lines must be an array of objects with a uuid item_id',
  'T38 AC-15 lines as an object (not an array) is rejected with the shape error'
);

select throws_ok(
  format($q$insert into public.order_approvals
              (store_id, vendor_id, business_date, approved_by, channel, lines, line_count)
            values (%L::uuid, %L::uuid, date '2026-10-07', auth.uid(), 'manual', '[{"item_name":"x"}]'::jsonb, 1)$q$,
         current_setting('test.store_b', true), current_setting('test.vendor', true)),
  '22023',
  'order_approvals: lines must be an array of objects with a uuid item_id',
  'T39 AC-15 an element without item_id is rejected with the shape error'
);

select throws_ok(
  format($q$insert into public.order_approvals
              (store_id, vendor_id, business_date, approved_by, channel, lines, line_count)
            values (%L::uuid, %L::uuid, date '2026-10-08', auth.uid(), 'manual', '[{"item_id":"wings"}]'::jsonb, 1)$q$,
         current_setting('test.store_b', true), current_setting('test.vendor', true)),
  '22023',
  'order_approvals: lines must be an array of objects with a uuid item_id',
  'T40 AC-15 a non-uuid item_id is rejected with the shape error (no 22P02 escape)'
);

select throws_ok(
  format($q$insert into public.order_approvals
              (store_id, vendor_id, business_date, approved_by, channel, lines, line_count)
            values (%L::uuid, %L::uuid, date '2026-10-09', auth.uid(), 'manual', '["x"]'::jsonb, 1)$q$,
         current_setting('test.store_b', true), current_setting('test.vendor', true)),
  '22023',
  'order_approvals: lines must be an array of objects with a uuid item_id',
  'T41 AC-15 a non-object element is rejected with the shape error'
);

-- T42 (AC-15)
select is(
  (select count(*)::int from public.order_approvals
    where store_id = current_setting('test.store_b', true)::uuid
      and vendor_id = current_setting('test.vendor', true)::uuid
      and business_date between date '2026-10-06' and date '2026-10-09'),
  0,
  'T42 AC-15 no malformed approval row was written'
);


-- ═══════════════════════════════════════════════════════════════════════════
-- (R-3) purchase_orders.store_id — as MASTER
-- ═══════════════════════════════════════════════════════════════════════════
select set_config('request.jwt.claims', jsonb_build_object(
  'sub', current_setting('test.master_id', true),
  'role', 'authenticated',
  'app_metadata', jsonb_build_object('role', 'master')
)::text, true);

-- T43 (AC-17)
select throws_ok(
  format($q$update public.purchase_orders set store_id = %L::uuid where id = %L::uuid$q$,
         current_setting('test.store_b', true), current_setting('test.po_a', true)),
  '42501',
  'purchase_orders: store_id is immutable',
  'T43 AC-17 moving a lined PO from store A to store B is rejected'
);

-- T44 (AC-17)
select is(
  (select format('%s|%s', po.store_id, pi.po_id)
     from public.purchase_orders po
     join public.po_items pi on pi.id = current_setting('test.line_a', true)::uuid
    where po.id = current_setting('test.po_a', true)::uuid),
  format('%s|%s', current_setting('test.store_a', true), current_setting('test.po_a', true)),
  'T44 AC-17 the PO and its line are unchanged'
);

-- T45 (AC-18)
select lives_ok(
  format($q$update public.purchase_orders set total_cost = 123.45, status = 'sent' where id = %L::uuid$q$,
         current_setting('test.po_b', true)),
  'T45 AC-18 a total_cost + status UPDATE on a lined PO is accepted'
);

-- T46 (AC-18)
select ok(
  (select total_cost = 123.45 and status = 'sent'
     from public.purchase_orders where id = current_setting('test.po_b', true)::uuid),
  'T46 AC-18 total_cost and status changed'
);

-- T47 (AC-19, D-3 always-immutable)
select throws_ok(
  format($q$update public.purchase_orders set store_id = %L::uuid where id = %L::uuid$q$,
         current_setting('test.store_a', true), current_setting('test.po_e', true)),
  '42501',
  'purchase_orders: store_id is immutable',
  'T47 AC-19 moving an UNLINED PO is rejected too (always immutable, D-3)'
);

-- T48 (N1)
select lives_ok(
  format($q$update public.purchase_orders set store_id = store_id where id = %L::uuid$q$,
         current_setting('test.po_e', true)),
  'T48 N1 a pass-through SET of store_id is accepted'
);


-- ═══════════════════════════════════════════════════════════════════════════
-- Privileges + structure (as postgres)
-- ═══════════════════════════════════════════════════════════════════════════
reset role;
select set_config('request.jwt.claims', null, true);

-- T49–T51 (AC-20) — no EXECUTE for anon, authenticated, or PUBLIC. A NULL
-- proacl means PUBLIC still holds the default grant, so it must be non-null.
select ok(
  not has_function_privilege('anon',          'public.po_items_check_store()', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.po_items_check_store()', 'EXECUTE')
  and (select p.proacl is not null
              and not exists (select 1 from aclexplode(p.proacl) a
                               where a.grantee = 0 and a.privilege_type = 'EXECUTE')
         from pg_proc p where p.oid = 'public.po_items_check_store()'::regprocedure),
  'T49 AC-20 po_items_check_store: no EXECUTE for anon, authenticated or PUBLIC'
);

select ok(
  not has_function_privilege('anon',          'public.order_approvals_lines_check_store()', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.order_approvals_lines_check_store()', 'EXECUTE')
  and (select p.proacl is not null
              and not exists (select 1 from aclexplode(p.proacl) a
                               where a.grantee = 0 and a.privilege_type = 'EXECUTE')
         from pg_proc p where p.oid = 'public.order_approvals_lines_check_store()'::regprocedure),
  'T50 AC-20 order_approvals_lines_check_store: no EXECUTE for anon, authenticated or PUBLIC'
);

select ok(
  not has_function_privilege('anon',          'public.purchase_orders_lock_store_id()', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.purchase_orders_lock_store_id()', 'EXECUTE')
  and (select p.proacl is not null
              and not exists (select 1 from aclexplode(p.proacl) a
                               where a.grantee = 0 and a.privilege_type = 'EXECUTE')
         from pg_proc p where p.oid = 'public.purchase_orders_lock_store_id()'::regprocedure),
  'T51 AC-20 purchase_orders_lock_store_id: no EXECUTE for anon, authenticated or PUBLIC'
);

-- T52 (D-5)
select ok(
  (select count(*) = 3 and bool_and(not prosecdef)
     from pg_proc
    where pronamespace = 'public'::regnamespace
      and proname in ('po_items_check_store',
                      'order_approvals_lines_check_store',
                      'purchase_orders_lock_store_id')),
  'T52 D-5 all three trigger functions are SECURITY INVOKER'
);

-- T53
select is(
  (select count(*)::int from pg_trigger
    where not tgisinternal and tgenabled = 'O'
      and ((tgrelid = 'public.po_items'::regclass        and tgname = 'po_items_check_store_trg'
            and tgfoid = 'public.po_items_check_store()'::regprocedure)
        or (tgrelid = 'public.order_approvals'::regclass and tgname = 'order_approvals_lines_check_store_trg'
            and tgfoid = 'public.order_approvals_lines_check_store()'::regprocedure)
        or (tgrelid = 'public.purchase_orders'::regclass and tgname = 'purchase_orders_lock_store_id_trg'
            and tgfoid = 'public.purchase_orders_lock_store_id()'::regprocedure))),
  3,
  'T53 the three triggers exist, are enabled, and sit on the right tables'
);

-- T54 (D-6) — BEFORE (tgtype bit 2) + UPDATE (tgtype bit 16) triggers, name order.
select is(
  (select array_agg(tgname::text order by tgname)
     from pg_trigger
    where tgrelid = 'public.order_approvals'::regclass
      and not tgisinternal
      and (tgtype & 2)  <> 0
      and (tgtype & 16) <> 0),
  array['order_approvals_guard', 'order_approvals_lines_check_store_trg'],
  'T54 D-6 order_approvals BEFORE UPDATE triggers fire guard first, then the store check'
);

select * from finish();
rollback;
