-- supabase/tests/submission_notifications.test.sql
--
-- Spec 120 — pgTAP coverage for the brand-scoped submission notification bell
-- shipped in supabase/migrations/20260715000000_submission_notifications.sql.
--
-- Eleven arms (plan(11)):
--   RLS scoping (arms 1-4):
--     (1) brand-A admin SEES a brand-A notification.
--     (2) brand-A admin gets ZERO rows for a brand-B notification (RLS denies,
--         not a client filter).
--     (3) a same-brand `user` (submitter, not recipient) sees ZERO — the
--         auth_is_privileged() conjunct is load-bearing.
--     (4) super_admin sees BOTH brands.
--   Trigger generation (arms 5-9) — one notification per submission, right
--     type / brand (via store→brand) / actor / store_name:
--     (5) eod_submissions INSERT (status='submitted').
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

select plan(11);

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

-- (5) eod_submissions INSERT → one 'eod' notification.
insert into public.eod_submissions (id, store_id, date, submitted_by, status, vendor_id)
values ('eeee0000-0000-0000-0000-000000000005',
        current_setting('test.store_a', true)::uuid, current_date,
        current_setting('test.admin_id', true)::uuid, 'submitted',
        (select id from public.vendors limit 1));

select is(
  (select count(*)::int from public.notifications
    where type = 'eod' and source_id = 'eeee0000-0000-0000-0000-000000000005'),
  1,
  'arm (5): eod_submissions INSERT generates exactly one eod notification'
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
