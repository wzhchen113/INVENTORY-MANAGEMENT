-- supabase/tests/submission_notifications.test.sql
--
-- Spec 120 — pgTAP coverage for the brand-scoped submission notification bell
-- shipped in supabase/migrations/20260715000000_submission_notifications.sql.
--
-- Twelve arms (plan(12)):
--   RLS scoping (arms 1-4):
--     (1) brand-A admin SEES a brand-A notification.
--     (2) brand-A admin gets ZERO rows for a brand-B notification (RLS denies,
--         not a client filter).
--     (3) a same-brand `user` (submitter, not recipient) sees ZERO — the
--         auth_is_privileged() conjunct is load-bearing.
--     (4) super_admin sees BOTH brands.
--   Trigger generation (arms 5a-9) — one notification per submission, right
--     type / brand (via store→brand) / actor / store_name:
--     (5a) eod_submissions INSERT (status='submitted') for a vendor with NO
--          suggested order → the routine 'eod' notification, unchanged.
--     (5b) SPEC 149 (R-1 / AC-3) — the same INSERT for a vendor WITH a
--          suggested order (below-par linked item) → exactly one 'order_ready'
--          and ZERO 'eod'. The pre-149 single arm picked an arbitrary seeded
--          vendor that happened to have below-par Towson inventory, so it
--          pinned behavior spec 149 deliberately changed; both branches are now
--          pinned against DEDICATED fixture vendors instead of seed state.
--     (6) inventory_counts INSERT kind='weekly' fires; a kind='spot' INSERT
--         does NOT (the shared-table filter).
--     (7) waste_log INSERT.
--     (8) purchase_orders INTO status='sent' → one 'po'.
--     (9) purchase_orders status split: partial→received yields exactly ONE
--         'receiving' (dedup), and the PO carries one 'po' + one 'receiving'.
--   Dedup (arms 10-11):
--     (10) a repeat emit for the same (type, source_id) does NOT double-insert.
--     (11) the store→brand denormalization stamps actor_name + store_name.
--
-- JWT-impersonation + hermetic begin/rollback pattern copied from
-- auth_can_see_store_brand_scope.test.sql.

begin;
create extension if not exists pgtap;

select plan(12);

-- ─── fixtures ─────────────────────────────────────────────────
do $$
declare
  v_admin_id   uuid := '11111111-1111-1111-1111-111111111111';  -- seed admin (brand A)
  v_user_id    uuid := '22222222-2222-2222-2222-222222222222';  -- seed manager (role 'user', brand A)
  v_master_id  uuid := '33333333-3333-3333-3333-333333333333';  -- seed master (brand A → promoted to super_admin)
  v_brand_a    uuid := '2a000000-0000-0000-0000-000000000001';  -- seed brand
  v_brand_b    uuid := 'b1000000-0000-0000-0000-000000000001';  -- test-only brand
  v_store_a    uuid := '00000000-0000-0000-0000-000000000001';  -- seed Towson (brand A)
  v_store_b    uuid := 'b1000001-0000-0000-0000-000000000001';  -- test-only foreign-brand store
begin
  perform set_config('test.admin_id',  v_admin_id::text,  true);
  perform set_config('test.user_id',   v_user_id::text,   true);
  perform set_config('test.master_id', v_master_id::text, true);
  perform set_config('test.brand_a',   v_brand_a::text,   true);
  perform set_config('test.brand_b',   v_brand_b::text,   true);
  perform set_config('test.store_a',   v_store_a::text,   true);
  perform set_config('test.store_b',   v_store_b::text,   true);
end $$;

-- Test-only foreign brand + store (rolled back at end).
insert into public.brands (id, name)
values (current_setting('test.brand_b', true)::uuid, 'Foreign Brand (test 120)')
on conflict (id) do nothing;

insert into public.stores (id, brand_id, name, address, status, eod_deadline_time)
values (
  current_setting('test.store_b', true)::uuid,
  current_setting('test.brand_b', true)::uuid,
  'Foreign Store (test 120)', '1 Foreign Way', 'active', '22:00'
)
on conflict (id) do nothing;

-- Two directly-inserted notifications (postgres role bypasses RLS), one per
-- brand, with known ids so the RLS arms can target them precisely.
insert into public.notifications (id, brand_id, store_id, actor_user_id, type, source_id, actor_name, store_name)
values
  ('cccc0000-0000-0000-0000-00000000000a',
   current_setting('test.brand_a', true)::uuid,
   current_setting('test.store_a', true)::uuid,
   current_setting('test.admin_id', true)::uuid,
   'eod', 'dddd0000-0000-0000-0000-00000000000a', 'A actor', 'Towson'),
  ('cccc0000-0000-0000-0000-00000000000b',
   current_setting('test.brand_b', true)::uuid,
   current_setting('test.store_b', true)::uuid,
   null,
   'waste', 'dddd0000-0000-0000-0000-00000000000b', 'B actor', 'Foreign Store (test 120)');


-- ─── Arm (1): brand-A admin sees the brand-A notification ──────
set local role authenticated;
select set_config('request.jwt.claims', jsonb_build_object(
  'sub', current_setting('test.admin_id', true),
  'role', 'authenticated',
  'app_metadata', jsonb_build_object('role', 'admin')
)::text, true);

select is(
  (select count(*)::int from public.notifications
    where id = 'cccc0000-0000-0000-0000-00000000000a'),
  1,
  'arm (1): brand-A admin SEES the brand-A notification'
);

-- ─── Arm (2): brand-A admin does NOT see the brand-B notification ─
select is(
  (select count(*)::int from public.notifications
    where id = 'cccc0000-0000-0000-0000-00000000000b'),
  0,
  'arm (2): brand-A admin gets ZERO rows for a brand-B notification (RLS denies)'
);

-- ─── Arm (3): same-brand `user` sees ZERO (privileged conjunct) ──
select set_config('request.jwt.claims', jsonb_build_object(
  'sub', current_setting('test.user_id', true),
  'role', 'authenticated',
  'app_metadata', jsonb_build_object('role', 'user')
)::text, true);

select is(
  (select count(*)::int from public.notifications
    where id in ('cccc0000-0000-0000-0000-00000000000a',
                 'cccc0000-0000-0000-0000-00000000000b')),
  0,
  'arm (3): same-brand user sees ZERO (auth_is_privileged() conjunct is load-bearing)'
);

-- ─── Arm (4): super_admin sees BOTH brands ────────────────────
reset role;
update public.profiles set role = 'super_admin', brand_id = null
 where id = current_setting('test.master_id', true)::uuid;

set local role authenticated;
select set_config('request.jwt.claims', jsonb_build_object(
  'sub', current_setting('test.master_id', true),
  'role', 'authenticated',
  'app_metadata', jsonb_build_object('role', 'super_admin')
)::text, true);

select is(
  (select count(*)::int from public.notifications
    where id in ('cccc0000-0000-0000-0000-00000000000a',
                 'cccc0000-0000-0000-0000-00000000000b')),
  2,
  'arm (4): super_admin sees BOTH brands'
);


-- ─── Trigger arms run as postgres (bypass RLS; count directly) ──
reset role;
select set_config('request.jwt.claims', null, true);

-- (5) eod_submissions INSERT → exactly ONE notification, whose TYPE now depends
--     on the spec-149 branch in tg_notify_eod_submission (R-1 / AC-3):
--       vendor has below-par items ⇒ 'order_ready' (REPLACES the routine 'eod')
--       otherwise                  ⇒ 'eod', unchanged spec-120 behavior.
--     The original single arm used `(select id from public.vendors limit 1)`,
--     which resolved to a seeded vendor that HAS below-par Towson inventory —
--     so it silently pinned pre-149 behavior and went red when spec 149 landed.
--     Both branches are now pinned explicitly, with DEDICATED vendors so neither
--     arm depends on seed inventory state.
insert into public.vendors (id, name, brand_id)
values
  ('eeee0000-0000-0000-0000-0000000005a0',   -- no item_vendors links at all
   '__sn_vendor_no_order__', current_setting('test.brand_a', true)::uuid),
  ('eeee0000-0000-0000-0000-0000000005b0',   -- one linked, below-par item
   '__sn_vendor_below_par__', current_setting('test.brand_a', true)::uuid);

do $$
declare v_cat uuid; v_item uuid;
begin
  insert into public.catalog_ingredients (brand_id, name, unit, case_qty, sub_unit_size, default_cost)
  values (current_setting('test.brand_a', true)::uuid,
          'SPEC120-BELOW-'||gen_random_uuid()::text, 'each', 1, 1, 1.00)
  returning id into v_cat;

  -- par 10, on hand 1 ⇒ eod_vendor_has_below_par() is true for this vendor.
  insert into public.inventory_items (store_id, catalog_id, vendor_id, cost_per_unit, current_stock, par_level)
  values (current_setting('test.store_a', true)::uuid, v_cat,
          'eeee0000-0000-0000-0000-0000000005b0', 1.00, 1, 10)
  returning id into v_item;

  insert into public.item_vendors (item_id, vendor_id, cost_per_unit, case_price, is_primary)
  values (v_item, 'eeee0000-0000-0000-0000-0000000005b0', 1.00, 1.00, true);
end $$;

-- (5a) NO below-par item ⇒ the routine 'eod' notification, unchanged.
insert into public.eod_submissions (id, store_id, date, submitted_by, status, vendor_id)
values ('eeee0000-0000-0000-0000-000000000005',
        current_setting('test.store_a', true)::uuid, current_date,
        current_setting('test.admin_id', true)::uuid, 'submitted',
        'eeee0000-0000-0000-0000-0000000005a0');

select is(
  (select format('%s|%s',
     (select count(*)::int from public.notifications
       where source_id = 'eeee0000-0000-0000-0000-000000000005'),
     (select count(*)::int from public.notifications
       where type = 'eod' and source_id = 'eeee0000-0000-0000-0000-000000000005'))),
  '1|1',
  'arm (5a): eod_submissions INSERT for a vendor with NO suggested order still generates exactly one eod notification'
);

-- (5b) below-par item ⇒ spec 149 'order_ready' REPLACES the 'eod' (AC-3).
insert into public.eod_submissions (id, store_id, date, submitted_by, status, vendor_id)
values ('eeee0000-0000-0000-0000-00000000005b',
        current_setting('test.store_a', true)::uuid, current_date,
        current_setting('test.admin_id', true)::uuid, 'submitted',
        'eeee0000-0000-0000-0000-0000000005b0');

select is(
  (select format('%s|%s|%s',
     (select count(*)::int from public.notifications
       where source_id = 'eeee0000-0000-0000-0000-00000000005b'),
     (select count(*)::int from public.notifications
       where type = 'order_ready' and source_id = 'eeee0000-0000-0000-0000-00000000005b'),
     (select count(*)::int from public.notifications
       where type = 'eod' and source_id = 'eeee0000-0000-0000-0000-00000000005b'))),
  '1|1|0',
  'arm (5b): spec 149 — a vendor WITH a suggested order emits exactly one order_ready and ZERO eod (AC-3, no double ping)'
);

-- (6) inventory_counts: kind='weekly' fires; kind='spot' does NOT.
insert into public.inventory_counts (id, store_id, kind, submitted_by)
values ('eeee0000-0000-0000-0000-000000000061',
        current_setting('test.store_a', true)::uuid, 'weekly',
        current_setting('test.admin_id', true)::uuid),
       ('eeee0000-0000-0000-0000-000000000062',
        current_setting('test.store_a', true)::uuid, 'spot',
        current_setting('test.admin_id', true)::uuid);

select is(
  (select count(*)::int from public.notifications
    where source_id in ('eeee0000-0000-0000-0000-000000000061',
                         'eeee0000-0000-0000-0000-000000000062')),
  1,
  'arm (6): only the weekly count notifies (spot is filtered by the trigger WHEN clause)'
);

-- (7) waste_log INSERT → one 'waste'.
insert into public.waste_log (id, store_id, quantity, logged_by)
values ('eeee0000-0000-0000-0000-000000000007',
        current_setting('test.store_a', true)::uuid, 1.5,
        current_setting('test.admin_id', true)::uuid);

select is(
  (select count(*)::int from public.notifications
    where type = 'waste' and source_id = 'eeee0000-0000-0000-0000-000000000007'),
  1,
  'arm (7): waste_log INSERT generates exactly one waste notification'
);

-- (8) purchase_orders INTO status='sent' → one 'po'.
insert into public.purchase_orders (id, store_id, created_by, status)
values ('eeee0000-0000-0000-0000-000000000008',
        current_setting('test.store_a', true)::uuid,
        current_setting('test.admin_id', true)::uuid, 'draft');
update public.purchase_orders set status = 'sent'
 where id = 'eeee0000-0000-0000-0000-000000000008';

select is(
  (select count(*)::int from public.notifications
    where type = 'po' and source_id = 'eeee0000-0000-0000-0000-000000000008'),
  1,
  'arm (8): PO transition into sent generates exactly one po notification'
);

-- (9) status split + receiving dedup: partial then received → ONE 'receiving';
--     the same PO carries one 'po' + one 'receiving'.
update public.purchase_orders
   set status = 'partial', received_by = current_setting('test.admin_id', true)::uuid
 where id = 'eeee0000-0000-0000-0000-000000000008';
update public.purchase_orders set status = 'received'
 where id = 'eeee0000-0000-0000-0000-000000000008';

select is(
  (select count(*)::int from public.notifications
    where source_id = 'eeee0000-0000-0000-0000-000000000008'),
  2,
  'arm (9): PO source carries one po + one receiving (partial→received dedups to one receiving)'
);

-- (10) repeat emit for the same (type, source_id) does NOT double-insert.
select public.emit_submission_notification(
  'eod', current_setting('test.store_a', true)::uuid,
  current_setting('test.admin_id', true)::uuid,
  'eeee0000-0000-0000-0000-000000000005'
);

select is(
  (select count(*)::int from public.notifications
    where type = 'eod' and source_id = 'eeee0000-0000-0000-0000-000000000005'),
  1,
  'arm (10): repeat emit for the same (type, source_id) is deduped (on conflict do nothing)'
);

-- (11) denormalization: actor_name + store_name stamped from store→brand join.
select is(
  (select store_name = (select name from public.stores where id = current_setting('test.store_a', true)::uuid)
          and actor_name is not null
     from public.notifications
    where source_id = 'eeee0000-0000-0000-0000-000000000007'),
  true,
  'arm (11): trigger denormalizes store_name (from store) and actor_name (from profile)'
);

select finish();
rollback;
