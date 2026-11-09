-- supabase/tests/order_approvals_fk_set_null.test.sql
--
-- Spec 178 — order_approvals' two ON DELETE SET NULL foreign keys
-- (approved_by → profiles, source_submission_id → eod_submissions) must be
-- able to fire past tg_order_approvals_guard(), which treats both columns as
-- immutable provenance. The FK's SET NULL is an ordinary UPDATE on
-- order_approvals and DOES fire the BEFORE UPDATE guard, so before the fix
-- D1-D3 raised 'order approval is immutable'. D4 passed even then, and pins that
-- it keeps passing: a store delete queues its approval cascade before the SET
-- NULL the EOD cascade queues, so the approvals are gone when that one fires.
--
-- Plan (15 arms; each D-arm is an (a) lives_ok on the delete + a (b) state check):
--   DELETE PATHS (must succeed, and must null the pointer — not drop the row)
--     (D1) deleting the approving profile nulls approved_by; the row survives.
--     (D2) deleting the auth.users row (the delete-user edge function's final
--          step; profiles.id cascades from auth.users) succeeds the same way.
--     (D3) deleting the source EOD submission nulls source_submission_id; the
--          row survives. API callers can't do this (no DELETE policy), so this
--          is the service-role / server-side path.
--     (D4) deleting a store that owns both approvals and EOD submissions
--          succeeds and cascades both away.
--   GUARD STILL HOLDS (the fix must not open a client-side scrub)
--     (G1) NULLing approved_by while the profile still exists is refused.
--     (G2) NULLing source_submission_id while the submission still exists is
--          refused.
--     (G3) re-pointing approved_by at another profile is refused.
--     (G4) re-pointing a NULLed source_submission_id at a live submission is
--          refused (NULL → value is not a "referenced row is gone" move).
--     (G5) a signed-in store admin who can update the approval but whose RLS
--          hides the approver's profile (a super_admin, brand_id NULL) still
--          cannot NULL approved_by. (G5a) and (G5b) pin that setup. The guard
--          reads the profile as its owner; if it ran as the caller, the hidden
--          profile would look deleted.
--
-- Hermetic: begin; … rollback;. Every fixture is created inside the
-- transaction, so the file is green under the committed seed AND on a
-- CI-fresh database. Fixtures are written as postgres (RLS bypassed): the
-- arms exercise the trigger, not the policies. Only G5 runs as authenticated.

begin;
create extension if not exists pgtap;

select plan(15);

-- ─── fixtures ──────────────────────────────────────────────────
do $$
declare
  v_brand uuid := 'b1780000-0000-0000-0000-000000000001';
begin
  perform set_config('test.brand',    v_brand::text, true);
  perform set_config('test.store_a',  'b1780001-0000-0000-0000-000000000001', true);
  perform set_config('test.store_b',  'b1780001-0000-0000-0000-000000000002', true);
  perform set_config('test.vendor',   'b1780002-0000-0000-0000-000000000001', true);
  perform set_config('test.p1',       'b1780003-0000-0000-0000-000000000001', true);
  perform set_config('test.p2',       'b1780003-0000-0000-0000-000000000002', true);
  perform set_config('test.p3',       'b1780003-0000-0000-0000-000000000003', true);
  perform set_config('test.p_sa',     'b1780003-0000-0000-0000-000000000009', true);
  perform set_config('test.sub1',     'b1780004-0000-0000-0000-000000000001', true);
  perform set_config('test.sub2',     'b1780004-0000-0000-0000-000000000002', true);
  perform set_config('test.sub3',     'b1780004-0000-0000-0000-000000000003', true);
  perform set_config('test.oa1',      'b1780005-0000-0000-0000-000000000001', true);
  perform set_config('test.oa2',      'b1780005-0000-0000-0000-000000000002', true);
  perform set_config('test.oa3',      'b1780005-0000-0000-0000-000000000003', true);
  perform set_config('test.oa4',      'b1780005-0000-0000-0000-000000000004', true);
  perform set_config('test.oa5',      'b1780005-0000-0000-0000-000000000005', true);
end $$;

insert into public.brands (id, name)
values (current_setting('test.brand', true)::uuid, 'FK SET NULL Brand (test 178)');

insert into public.stores (id, brand_id, name, address, status, eod_deadline_time)
values
  (current_setting('test.store_a', true)::uuid, current_setting('test.brand', true)::uuid,
   'Store A (test 178)', '1 Test Way', 'active', '22:00'),
  (current_setting('test.store_b', true)::uuid, current_setting('test.brand', true)::uuid,
   'Store B (test 178)', '2 Test Way', 'active', '22:00');

insert into public.vendors (id, name, brand_id)
values (current_setting('test.vendor', true)::uuid, '__oa178_vendor__',
        current_setting('test.brand', true)::uuid);

-- Three approvers. profiles.id references auth.users(id) ON DELETE CASCADE,
-- so each needs an auth.users row (D2 deletes through it).
insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
                        email_confirmed_at, created_at, updated_at,
                        raw_app_meta_data, raw_user_meta_data)
select p::uuid, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
       'oa178-' || right(p, 1) || '@local.test', '', now(), now(), now(),
       '{"role":"admin"}'::jsonb, '{}'::jsonb
  from unnest(array[current_setting('test.p1', true),
                    current_setting('test.p2', true),
                    current_setting('test.p3', true),
                    current_setting('test.p_sa', true)]) as p;

insert into public.profiles (id, name, role, brand_id)
select p::uuid, 'Approver ' || right(p, 1) || ' (test 178)', 'admin',
       current_setting('test.brand', true)::uuid
  from unnest(array[current_setting('test.p1', true),
                    current_setting('test.p2', true),
                    current_setting('test.p3', true)]) as p;

-- G5's approver: a super_admin has no brand, so RLS hides their profile from a
-- brand admin (p3 acts as that admin in G5).
insert into public.profiles (id, name, role, brand_id)
values (current_setting('test.p_sa', true)::uuid, 'Super admin (test 178)', 'super_admin', null);

insert into public.eod_submissions (id, store_id, vendor_id, date, status)
values
  (current_setting('test.sub1', true)::uuid, current_setting('test.store_a', true)::uuid,
   current_setting('test.vendor', true)::uuid, date '2026-10-01', 'submitted'),
  (current_setting('test.sub2', true)::uuid, current_setting('test.store_a', true)::uuid,
   current_setting('test.vendor', true)::uuid, date '2026-10-02', 'submitted'),
  (current_setting('test.sub3', true)::uuid, current_setting('test.store_b', true)::uuid,
   current_setting('test.vendor', true)::uuid, date '2026-10-03', 'submitted');

-- Empty lines keep spec 177's lines-store trigger out of the way.
-- oa1: approved by p1, from sub1 (D1, D3, G2).
-- oa2: approved by p2, from sub2 (D2, G1, G3).
-- oa3: store B, approved by p3, from sub3 (D4).
-- oa4: approved by p1, no source submission (G4).
-- oa5: approved by the super_admin, no source submission (G5).
insert into public.order_approvals
  (id, store_id, vendor_id, business_date, approved_by, channel, status, lines, source_submission_id)
values
  (current_setting('test.oa1', true)::uuid, current_setting('test.store_a', true)::uuid,
   current_setting('test.vendor', true)::uuid, date '2026-10-01',
   current_setting('test.p1', true)::uuid, 'manual', 'ordered', '[]'::jsonb,
   current_setting('test.sub1', true)::uuid),
  (current_setting('test.oa2', true)::uuid, current_setting('test.store_a', true)::uuid,
   current_setting('test.vendor', true)::uuid, date '2026-10-02',
   current_setting('test.p2', true)::uuid, 'manual', 'approved', '[]'::jsonb,
   current_setting('test.sub2', true)::uuid),
  (current_setting('test.oa3', true)::uuid, current_setting('test.store_b', true)::uuid,
   current_setting('test.vendor', true)::uuid, date '2026-10-03',
   current_setting('test.p3', true)::uuid, 'manual', 'pending', '[]'::jsonb,
   current_setting('test.sub3', true)::uuid),
  (current_setting('test.oa4', true)::uuid, current_setting('test.store_a', true)::uuid,
   current_setting('test.vendor', true)::uuid, date '2026-10-04',
   current_setting('test.p1', true)::uuid, 'manual', 'pending', '[]'::jsonb, null),
  (current_setting('test.oa5', true)::uuid, current_setting('test.store_a', true)::uuid,
   current_setting('test.vendor', true)::uuid, date '2026-10-05',
   current_setting('test.p_sa', true)::uuid, 'manual', 'pending', '[]'::jsonb, null);


-- ─── GUARD STILL HOLDS (run first, while every referenced row exists) ──
select throws_ok(
  format('update public.order_approvals set approved_by = null where id = %L',
         current_setting('test.oa2', true)),
  'P0001', 'order approval is immutable',
  '(G1) NULLing approved_by while the approving profile still exists is refused'
);

select throws_ok(
  format('update public.order_approvals set source_submission_id = null where id = %L',
         current_setting('test.oa1', true)),
  'P0001', 'order approval is immutable',
  '(G2) NULLing source_submission_id while the submission still exists is refused'
);

select throws_ok(
  format('update public.order_approvals set approved_by = %L where id = %L',
         current_setting('test.p3', true), current_setting('test.oa2', true)),
  'P0001', 'order approval is immutable',
  '(G3) re-pointing approved_by at another profile is refused'
);

select throws_ok(
  format('update public.order_approvals set source_submission_id = %L where id = %L',
         current_setting('test.sub2', true), current_setting('test.oa4', true)),
  'P0001', 'order approval is immutable',
  '(G4) setting a NULL source_submission_id to a live submission is refused'
);

-- (G5) as a brand admin (p3). Results are read into settings so the role can
-- be reset before any pgTAP call: authenticated can't write pgTAP's bookkeeping.
set local role authenticated;
select set_config('request.jwt.claims', jsonb_build_object(
  'sub', current_setting('test.p3', true),
  'role', 'authenticated',
  'app_metadata', jsonb_build_object('role', 'admin')
)::text, true);

select set_config('test.g5_sees_approval',
  (select count(*)::text from public.order_approvals
    where id = current_setting('test.oa5', true)::uuid), true);
select set_config('test.g5_sees_profile',
  (select count(*)::text from public.profiles
    where id = current_setting('test.p_sa', true)::uuid), true);

do $$
begin
  update public.order_approvals set approved_by = null
   where id = current_setting('test.oa5', true)::uuid;
  perform set_config('test.g5_outcome', 'update allowed', true);
exception when others then
  perform set_config('test.g5_outcome', sqlstate || ': ' || sqlerrm, true);
end $$;

reset role;
select set_config('request.jwt.claims', null, true);

select is(current_setting('test.g5_sees_approval', true), '1',
  '(G5a) setup: the brand admin can see the approval');

select is(current_setting('test.g5_sees_profile', true), '0',
  '(G5b) setup: RLS hides the super_admin approver''s profile from the brand admin');

select is(current_setting('test.g5_outcome', true), 'P0001: order approval is immutable',
  '(G5) NULLing approved_by is refused even when the caller''s RLS hides the profile');


-- ─── DELETE PATHS ──────────────────────────────────────────────
-- (D1) profile delete → approved_by SET NULL.
select lives_ok(
  format('delete from public.profiles where id = %L', current_setting('test.p1', true)),
  '(D1a) deleting a profile that approved orders succeeds'
);

select results_eq(
  format($q$select approved_by is null, source_submission_id is not null
              from public.order_approvals where id in (%L, %L) order by id$q$,
         current_setting('test.oa1', true), current_setting('test.oa4', true)),
  $$values (true, true), (true, false)$$,
  '(D1b) deleting the approving profile nulls approved_by on both of its approvals; the rows survive'
);

-- (D2) auth.users delete → profiles cascade → approved_by SET NULL.
select lives_ok(
  format('delete from auth.users where id = %L', current_setting('test.p2', true)),
  '(D2a) deleting the auth.users row of an approver succeeds'
);

select is(
  (select count(*)::int from public.order_approvals
    where id = current_setting('test.oa2', true)::uuid and approved_by is null),
  1,
  '(D2b) deleting the auth.users row (delete-user''s final step) nulls approved_by; the row survives'
);

-- (D3) EOD submission delete → source_submission_id SET NULL.
select lives_ok(
  format('delete from public.eod_submissions where id = %L', current_setting('test.sub1', true)),
  '(D3a) deleting an EOD submission an approval points at succeeds'
);

select is(
  (select count(*)::int from public.order_approvals
    where id = current_setting('test.oa1', true)::uuid and source_submission_id is null),
  1,
  '(D3b) deleting the source EOD submission nulls source_submission_id; the row survives'
);

-- (D4) A store delete on its own. eod_submissions has no DELETE policy, so
-- db.deleteStore's earlier eod_submissions delete removes 0 rows for an API
-- caller and the stores delete does the real work.
select lives_ok(
  format('delete from public.stores where id = %L', current_setting('test.store_b', true)),
  '(D4a) deleting a store that has EOD submissions and approvals succeeds'
);

select is(
  (select count(*)::int from public.order_approvals
    where id = current_setting('test.oa3', true)::uuid),
  0,
  '(D4b) deleting a store whose approvals point at its own EOD submissions succeeds and cascades the approvals'
);

select * from finish();
rollback;
