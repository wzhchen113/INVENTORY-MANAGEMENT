-- supabase/tests/staff_reports_issue.test.sql
--
-- Spec 126 — pgTAP coverage for the staff "Report an issue" → 'issue'
-- notification path shipped in
-- supabase/migrations/20260720000000_staff_reports_issue_notifications.sql.
--
-- Twelve arms (plan(12)):
--   RPC happy path (arms 1-3), run as an authenticated brand-A admin (who can
--   see the seed brand-A store via auth_can_see_store):
--     (1) submit_staff_report inserts exactly ONE staff_reports row with the
--         derived brand/store/reporter + category/message.
--     (2) it emits exactly ONE 'issue' notification with source_id = report id,
--         category + body populated, actor_name = reporter, brand_id from store.
--     (3) staff_reports.reporter_user_id = auth.uid(), status defaults 'open'.
--   RPC gates (arms 4-6):
--     (4) a store the caller cannot see → 42501 (auth_can_see_store gate).
--     (5) an invalid category → 22023.
--     (6) an empty message → 22023.
--   staff_reports RLS + notifications RLS (arms 7-11):
--     (7) brand-A admin SEES the brand-A staff_reports row.
--     (8) a same-brand `user` (reporter, not reader) sees ZERO staff_reports
--         (auth_is_privileged() conjunct is load-bearing).
--     (9) brand-A admin gets ZERO brand-B staff_reports (RLS denies).
--     (10) brand-A admin SEES the brand-A 'issue' notification.
--     (11) brand-A admin gets ZERO brand-B 'issue' notifications.
--   Cross-brand (arm 12):
--     (12) super_admin sees BOTH brands' staff_reports + issue notifications.
--
-- JWT-impersonation + hermetic begin/rollback pattern copied from
-- submission_notifications.test.sql / missed_eod_notifications.test.sql.

begin;
create extension if not exists pgtap;

select plan(12);

-- ─── fixtures ─────────────────────────────────────────────────
do $$
declare
  v_admin_id  uuid := '11111111-1111-1111-1111-111111111111';  -- seed admin (brand A)
  v_user_id   uuid := '22222222-2222-2222-2222-222222222222';  -- seed manager (role 'user', brand A)
  v_master_id uuid := '33333333-3333-3333-3333-333333333333';  -- seed master (brand A → promoted to super_admin)
  v_brand_a   uuid := '2a000000-0000-0000-0000-000000000001';  -- seed brand
  v_brand_b   uuid := 'b1000000-0000-0000-0000-000000000001';  -- test-only brand
  v_store_a   uuid := '00000000-0000-0000-0000-000000000001';  -- seed Towson (brand A)
  v_store_b   uuid := 'b1000001-0000-0000-0000-000000000001';  -- test-only foreign-brand store
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
values (current_setting('test.brand_b', true)::uuid, 'Foreign Brand (test 126)')
on conflict (id) do nothing;

insert into public.stores (id, brand_id, name, address, status, eod_deadline_time)
values (
  current_setting('test.store_b', true)::uuid,
  current_setting('test.brand_b', true)::uuid,
  'Foreign Store (test 126)', '1 Foreign Way', 'active', '22:00'
)
on conflict (id) do nothing;

-- A brand-B staff_reports row + 'issue' notification (postgres bypasses RLS),
-- for the cross-brand RLS arms. Known ids so the arms target them precisely.
insert into public.staff_reports
  (id, brand_id, store_id, reporter_user_id, reporter_name, store_name, category, message)
values
  ('5aff0000-0000-0000-0000-00000000000b',
   current_setting('test.brand_b', true)::uuid,
   current_setting('test.store_b', true)::uuid,
   null, 'B reporter', 'Foreign Store (test 126)', 'equipment', 'brand B fridge down');

insert into public.notifications
  (id, brand_id, store_id, actor_user_id, type, source_id, actor_name, store_name, category, body)
values
  ('6a1f0000-0000-0000-0000-00000000000b',
   current_setting('test.brand_b', true)::uuid,
   current_setting('test.store_b', true)::uuid,
   null, 'issue', '5aff0000-0000-0000-0000-00000000000b',
   'B reporter', 'Foreign Store (test 126)', 'equipment', 'brand B fridge down');


-- ─── RPC happy path: run as authenticated brand-A admin ───────
-- The admin can see the seed brand-A store via auth_can_see_store (admin arm).
set local role authenticated;
select set_config('request.jwt.claims', jsonb_build_object(
  'sub', current_setting('test.admin_id', true),
  'role', 'authenticated',
  'app_metadata', jsonb_build_object('role', 'admin')
)::text, true);

select set_config('test.report_id',
  public.submit_staff_report(
    current_setting('test.store_a', true)::uuid,
    'inventory',
    '  Low on tomatoes  '
  )::text, true);

reset role;
select set_config('request.jwt.claims', null, true);

-- ─── Arm (1): exactly one staff_reports row, derived fields ───
select is(
  (select count(*)::int from public.staff_reports
    where id = current_setting('test.report_id', true)::uuid
      and brand_id = current_setting('test.brand_a', true)::uuid
      and store_id = current_setting('test.store_a', true)::uuid
      and category = 'inventory'
      and message = 'Low on tomatoes'          -- trimmed by the RPC
      and store_name = (select name from public.stores where id = current_setting('test.store_a', true)::uuid)),
  1,
  'arm (1): submit_staff_report inserts one staff_reports row with derived brand/store + trimmed message'
);

-- ─── Arm (2): exactly one 'issue' notification, denormalized ──
select is(
  (select count(*)::int from public.notifications
    where type = 'issue'
      and source_id = current_setting('test.report_id', true)::uuid
      and brand_id = current_setting('test.brand_a', true)::uuid
      and store_id = current_setting('test.store_a', true)::uuid
      and category = 'inventory'
      and body = 'Low on tomatoes'
      and actor_user_id = current_setting('test.admin_id', true)::uuid
      and store_name = (select name from public.stores where id = current_setting('test.store_a', true)::uuid)),
  1,
  'arm (2): emits one issue notification with source_id=report id, category+body populated, actor=reporter'
);

-- ─── Arm (3): reporter_user_id = caller, status defaults open ─
select is(
  (select reporter_user_id = current_setting('test.admin_id', true)::uuid
          and status = 'open'
     from public.staff_reports
    where id = current_setting('test.report_id', true)::uuid),
  true,
  'arm (3): staff_reports.reporter_user_id = auth.uid() and status defaults to open'
);


-- ─── Arm (4): store the caller cannot see → 42501 ─────────────
set local role authenticated;
select set_config('request.jwt.claims', jsonb_build_object(
  'sub', current_setting('test.admin_id', true),
  'role', 'authenticated',
  'app_metadata', jsonb_build_object('role', 'admin')
)::text, true);

select throws_ok(
  format(
    $q$ select public.submit_staff_report(%L::uuid, 'other', 'foreign store report') $q$,
    current_setting('test.store_b', true)
  ),
  '42501',
  null,
  'arm (4): reporting for a store the caller cannot see raises 42501 (auth_can_see_store gate)'
);

-- ─── Arm (5): invalid category → 22023 ────────────────────────
select throws_ok(
  format(
    $q$ select public.submit_staff_report(%L::uuid, 'not_a_category', 'valid message') $q$,
    current_setting('test.store_a', true)
  ),
  '22023',
  null,
  'arm (5): an invalid category raises 22023'
);

-- ─── Arm (6): empty message → 22023 ───────────────────────────
select throws_ok(
  format(
    $q$ select public.submit_staff_report(%L::uuid, 'other', '   ') $q$,
    current_setting('test.store_a', true)
  ),
  '22023',
  null,
  'arm (6): an empty (whitespace-only) message raises 22023'
);


-- ─── Arm (7): brand-A admin SEES the brand-A staff_reports row ─
-- (still impersonating brand-A admin)
select is(
  (select count(*)::int from public.staff_reports
    where id = current_setting('test.report_id', true)::uuid),
  1,
  'arm (7): brand-A admin SEES the brand-A staff_reports row (privileged+brand RLS)'
);

-- ─── Arm (8): same-brand user sees ZERO staff_reports ─────────
select set_config('request.jwt.claims', jsonb_build_object(
  'sub', current_setting('test.user_id', true),
  'role', 'authenticated',
  'app_metadata', jsonb_build_object('role', 'user')
)::text, true);

select is(
  (select count(*)::int from public.staff_reports
    where id = current_setting('test.report_id', true)::uuid),
  0,
  'arm (8): same-brand user sees ZERO staff_reports (auth_is_privileged() conjunct load-bearing)'
);

-- ─── Arm (9): brand-A admin gets ZERO brand-B staff_reports ───
select set_config('request.jwt.claims', jsonb_build_object(
  'sub', current_setting('test.admin_id', true),
  'role', 'authenticated',
  'app_metadata', jsonb_build_object('role', 'admin')
)::text, true);

select is(
  (select count(*)::int from public.staff_reports
    where id = '5aff0000-0000-0000-0000-00000000000b'),
  0,
  'arm (9): brand-A admin gets ZERO brand-B staff_reports (RLS denies)'
);

-- ─── Arm (10): brand-A admin SEES the brand-A issue notification ─
select is(
  (select count(*)::int from public.notifications
    where type = 'issue' and source_id = current_setting('test.report_id', true)::uuid),
  1,
  'arm (10): brand-A admin SEES the brand-A issue notification (inherited spec-120 RLS)'
);

-- ─── Arm (11): brand-A admin gets ZERO brand-B issue notification ─
select is(
  (select count(*)::int from public.notifications
    where id = '6a1f0000-0000-0000-0000-00000000000b'),
  0,
  'arm (11): brand-A admin gets ZERO brand-B issue notifications (RLS denies)'
);

-- ─── Arm (12): super_admin sees BOTH brands ───────────────────
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
  (select count(*)::int from public.staff_reports
    where id in (current_setting('test.report_id', true)::uuid,
                 '5aff0000-0000-0000-0000-00000000000b'))
  +
  (select count(*)::int from public.notifications
    where type = 'issue'
      and source_id in (current_setting('test.report_id', true)::uuid,
                        '5aff0000-0000-0000-0000-00000000000b')),
  4,
  'arm (12): super_admin sees BOTH brands staff_reports (2) + issue notifications (2)'
);

select finish();
rollback;
