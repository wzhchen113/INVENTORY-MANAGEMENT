-- supabase/tests/eod_update_notifications.test.sql
--
-- Spec 180 — pgTAP coverage for the EOD edit / promotion notifications shipped
-- in supabase/migrations/20261027000000_eod_update_notifications.sql
-- (design §8.1).
--
-- Arms (plan(33)):
--   C1  (1-4)   notifications.submission_id exists; the CHECK accepts
--               'eod_update', still accepts all 9 legacy values, still rejects
--               an unknown value (23514).
--   F1  (5-6)   AC-7 — a plain INSERT status='submitted' → exactly one fresh
--               eod/order_ready row (source_id = submission id, submission_id
--               NULL) and zero eod_update.
--   S1  (7-9)   AC-8/9/11 — staff_submit_eod first submit as staff user U,
--               then an edit (new client_uuid, same triple) as admin A → +1
--               eod_update with actor = A (NOT U), submission_id = the
--               submission, body = vendor name, source_id <> submission id;
--               the fresh row count stays 1.
--   S2  (10)    a third RPC edit → 2 eod_update rows.
--   S3  (11-12) an RPC replay with an already-stored client_uuid returns
--               conflict=true before the upsert → no new rows.
--   P1  (13-14) AC-8 db.ts shape — the PostgREST merge-duplicates upsert as an
--               admin JWT: first call is a fresh submit, the second is +1
--               eod_update whose actor is the admin.
--   D1  (15-16) AC-10 — a draft INSERT and a draft→draft upsert give 0 rows.
--   D2  (17)    AC-10 — draft→submitted gives exactly 1 fresh (non-update) row,
--               actor = the promoting caller, and 0 eod_update.
--   D3  (18-20) AC-10/11 — submitted→draft gives 0 new rows; a re-promotion
--               gives +1 eod_update and NO second fresh row — even when the
--               vendor has since gone below par (so a fresh emit would have
--               chosen 'order_ready', a different type the unique index would
--               NOT dedupe against the original 'eod').
--   G1  (21)    guard (G) — a claims-less UPDATE of a submitted row (postgres,
--               no JWT) gives 0 new rows.
--   R1  (22-24) RLS — a brand-A admin SELECTs the eod_update row; a
--               foreign-brand admin gets 0; a same-brand `user` gets 0.
--   T1  (25-27) eod_update_push_suppressed: TRUE with a same-store EOD-family
--               row inside 60 s; FALSE once that row is backdated 2 minutes;
--               FALSE for a different store.
--   A1  (28)    ACL — authenticated lacks EXECUTE on all four new functions.
--   A2  (29-30) trigger shape — notify_eod_resubmission is AFTER UPDATE OF
--               status, submitted_at with WHEN (new.status = 'submitted');
--               notify_eod_submission is still AFTER INSERT.
--   Review-fix arms (spec 180 release proposal, step 3):
--   S4  (31)    KNOWN BEHAVIOUR, pinned not endorsed (architect M-1): a replay
--               of an EDIT's client_uuid is NOT caught by the RPC's step (4)
--               (the row keeps the first submit's uuid), so it re-runs the
--               edit and emits +1 eod_update. Pre-existing staff_submit_eod
--               idempotency gap; a follow-up (client_uuid ledger) flips this.
--   G2  (32)    column-scoped trigger (architect M-2 / security Low 1): an
--               UPDATE that sets ONLY submitted_by — the shape of the FK
--               `on delete set null` action — under a user JWT gives 0 rows.
--   V1  (33)    vendor-name brand check (security Low 3): emit_eod_update with
--               a vendor from ANOTHER brand leaves body NULL.
--
-- Spec 189 (O-1, owner approved 2026-11-09): the staff_submit_eod calls used
-- to send '[]'. The RPC now refuses an empty payload with 22023, so they send
-- one entry for a Frederick item instead (test.payload). No arm's meaning
-- changes: the notification triggers key on the parent upsert, not entries.
--
-- Fixture posture: every vendor / store / item the assertions read is created
-- INSIDE the transaction, with synthetic 1999-11-* dates for the direct
-- inserts, so the file is green under the committed seed AND on a CI-fresh
-- database and never collides with other suites. The staff_submit_eod triple
-- chain (S1-S4) uses A - 14 (test.d_s, A = (now() at time zone
-- 'America/New_York')::date): anchor-relative because spec 193 bounds
-- store-member dates. Its vendor f2 is created in this transaction, so no
-- leftover row can pre-exist and no pre-delete is needed. Fresh vendors have NO item_vendors links, so their fresh
-- branch is deterministically 'eod' (until D3 adds a below-par link on
-- purpose). Principals: seed admin 1111 (admin, brand A), seed manager 2222
-- (role 'user', Towson + Frederick membership — mirrors
-- staff_role_eod_rls.test.sql), seed master 3333 (re-pointed to a test-only
-- brand B for the foreign-brand RLS probe). No `set role anon` (segfaults CI
-- per spec 067). Hermetic: begin; … rollback;.
--
-- Assertions read public.notifications as postgres (RLS-free) unless the arm
-- is about RLS. enqueue_submission_push is a NOTICE no-op locally (no
-- submission_push_url in _edge_auth), so no pg_net call ever fires.

begin;
create extension if not exists pgtap;

select plan(33);

-- ─── fixtures (as postgres) ─────────────────────────────────────
do $$
declare
  v_brand_a   uuid;
  v_frederick uuid;
  v_tag       text := substr(gen_random_uuid()::text, 1, 8);
begin
  select id, brand_id into v_frederick, v_brand_a
    from public.stores where name = 'Frederick' limit 1;

  perform set_config('test.admin_id',   '11111111-1111-1111-1111-111111111111', true);
  perform set_config('test.user_id',    '22222222-2222-2222-2222-222222222222', true);
  perform set_config('test.master_id',  '33333333-3333-3333-3333-333333333333', true);
  perform set_config('test.brand_a',    v_brand_a::text,   true);
  perform set_config('test.brand_b',    '18000000-0000-0000-0000-0000000000b0', true);
  perform set_config('test.frederick',  v_frederick::text, true);
  perform set_config('test.store_t1',   '18000000-0000-0000-0000-0000000000a1', true);
  perform set_config('test.store_t2',   '18000000-0000-0000-0000-0000000000a2', true);
  perform set_config('test.tag',        v_tag, true);
  -- Spec 193: the S1-S4 staff_submit_eod triple date (see header).
  perform set_config('test.d_s',
    ((now() at time zone 'America/New_York')::date - 14)::text, true);
  -- Spec 189 O-1: staff_submit_eod now refuses an empty payload, so the S*
  -- calls send one entry for a Frederick item. The fresh vendors have no
  -- item_vendors links, so it writes no on-hand and the fresh branch stays
  -- deterministically 'eod'. It adds one staff audit row per call, which no
  -- arm here counts.
  perform set_config('test.payload', jsonb_build_array(jsonb_build_object(
    'ingredient_id', (select ii.id from public.inventory_items ii
                       where ii.store_id = v_frederick order by ii.id limit 1),
    'actual_remaining', 1))::text, true);
end $$;

-- Test-only foreign brand (R1) + two brand-A throttle stores (T1).
insert into public.brands (id, name)
values (current_setting('test.brand_b', true)::uuid, 'Foreign Brand (test 180)')
on conflict (id) do nothing;

insert into public.stores (id, brand_id, name, address, status, eod_deadline_time)
values
  (current_setting('test.store_t1', true)::uuid, current_setting('test.brand_a', true)::uuid,
   'SPEC180 Throttle 1', '1 Test Way', 'active', '22:00'),
  (current_setting('test.store_t2', true)::uuid, current_setting('test.brand_a', true)::uuid,
   'SPEC180 Throttle 2', '2 Test Way', 'active', '22:00')
on conflict (id) do nothing;

-- One fresh vendor per arm family so the (store, date, vendor) triples never
-- overlap. No item_vendors links ⇒ the fresh branch is 'eod'.
insert into public.vendors (id, name, brand_id)
values
  ('18000000-0000-0000-0000-0000000000f1', 'SPEC180-VF-' || current_setting('test.tag', true),
   current_setting('test.brand_a', true)::uuid),
  ('18000000-0000-0000-0000-0000000000f2', 'SPEC180-VS-' || current_setting('test.tag', true),
   current_setting('test.brand_a', true)::uuid),
  ('18000000-0000-0000-0000-0000000000f3', 'SPEC180-VP-' || current_setting('test.tag', true),
   current_setting('test.brand_a', true)::uuid),
  ('18000000-0000-0000-0000-0000000000f4', 'SPEC180-VD-' || current_setting('test.tag', true),
   current_setting('test.brand_a', true)::uuid);

-- Helper view of every notification tied to a submission, fresh or edit.
create temp view _sub_notifs as
select n.*, coalesce(n.submission_id, n.source_id) as sub_id
  from public.notifications n;


-- ═══ C1 — column + CHECK ═════════════════════════════════════════
select has_column('public', 'notifications', 'submission_id',
  '(1) C1: notifications.submission_id exists');

select lives_ok(
  format($q$insert into public.notifications
             (brand_id, store_id, type, source_id, submission_id, store_name)
           values (%L::uuid, %L::uuid, 'eod_update',
                   '18000000-0000-0000-0000-0000000c0001'::uuid,
                   '18000000-0000-0000-0000-0000000c0002'::uuid, 'Fixture')$q$,
         current_setting('test.brand_a', true), current_setting('test.store_t2', true)),
  '(2) C1: notifications.type accepts the new ''eod_update'' value'
);

select lives_ok(
  format($q$insert into public.notifications
             (brand_id, store_id, type, source_id, store_name)
           select %L::uuid, %L::uuid, t.type,
                  ('18000000-0000-0000-0000-0000000c01' || lpad(t.ord::text, 2, '0'))::uuid,
                  'Fixture'
             from (values ('eod',1),('weekly',2),('waste',3),('receiving',4),('po',5),
                          ('missed_eod',6),('issue',7),('order_ready',8),('order_failed',9))
                  as t(type, ord)$q$,
         current_setting('test.brand_a', true), current_setting('test.store_t2', true)),
  '(3) C1: all nine legacy types are STILL accepted (additive widening)'
);

select throws_ok(
  format($q$insert into public.notifications
             (brand_id, store_id, type, source_id, store_name)
           values (%L::uuid, %L::uuid, 'eod_edited',
                   '18000000-0000-0000-0000-0000000c0003'::uuid, 'Fixture')$q$,
         current_setting('test.brand_a', true), current_setting('test.store_t2', true)),
  '23514', null,
  '(4) C1: notifications_type_check still rejects an unknown type'
);

-- The C1 rows sit on store_t2 and would make T1's "different store" probe
-- TRUE; they have served their purpose.
delete from public.notifications where store_id = current_setting('test.store_t2', true)::uuid;


-- ═══ F1 — fresh INSERT is unchanged (AC-7) ═══════════════════════
-- Superuser role (RLS-free) with the admin's claims, so the BEFORE trigger's
-- submitted_by := auth.uid() resolves to a real actor.
select set_config('request.jwt.claims', jsonb_build_object(
  'sub', current_setting('test.admin_id', true),
  'role', 'authenticated',
  'app_metadata', jsonb_build_object('role', 'admin')
)::text, true);

insert into public.eod_submissions (id, store_id, date, vendor_id, status)
values ('18000000-0000-0000-0000-00000000f001',
        current_setting('test.frederick', true)::uuid, date '1999-11-01',
        '18000000-0000-0000-0000-0000000000f1', 'submitted');

select is(
  (select format('%s|%s|%s',
     (select count(*) from public.notifications
       where source_id = '18000000-0000-0000-0000-00000000f001'
         and type in ('eod', 'order_ready')),
     (select count(*) from public.notifications
       where source_id = '18000000-0000-0000-0000-00000000f001'
         and type in ('eod', 'order_ready') and submission_id is null),
     (select count(*) from public.notifications
       where submission_id = '18000000-0000-0000-0000-00000000f001'
         and type = 'eod_update'))),
  '1|1|0',
  '(5) F1 AC-7: a fresh submitted INSERT emits exactly ONE eod/order_ready (submission_id NULL) and ZERO eod_update'
);

select is(
  (select type from public.notifications
    where source_id = '18000000-0000-0000-0000-00000000f001'),
  'eod',
  '(6) F1: a vendor with no below-par link takes the routine eod branch (extraction is behaviour-identical)'
);


-- ═══ S1/S2/S3 — staff_submit_eod edit path (AC-8, AC-9, AC-11) ═══
set local role authenticated;

-- First submit as the staff user U.
select set_config('request.jwt.claims', jsonb_build_object(
  'sub', current_setting('test.user_id', true),
  'role', 'authenticated',
  'app_metadata', jsonb_build_object('role', 'user')
)::text, true);

select public.staff_submit_eod(
  '18000000-0000-0000-0000-0000000cc001'::uuid,
  current_setting('test.frederick', true)::uuid,
  current_setting('test.d_s', true)::date, null, 'submitted', current_setting('test.payload', true)::jsonb,
  '18000000-0000-0000-0000-0000000000f2'::uuid);

-- Edit (same triple, NEW client_uuid) as admin A.
select set_config('request.jwt.claims', jsonb_build_object(
  'sub', current_setting('test.admin_id', true),
  'role', 'authenticated',
  'app_metadata', jsonb_build_object('role', 'admin')
)::text, true);

select public.staff_submit_eod(
  '18000000-0000-0000-0000-0000000cc002'::uuid,
  current_setting('test.frederick', true)::uuid,
  current_setting('test.d_s', true)::date, null, 'submitted', current_setting('test.payload', true)::jsonb,
  '18000000-0000-0000-0000-0000000000f2'::uuid);

reset role;

do $$
begin
  perform set_config('test.sub_s',
    (select id::text from public.eod_submissions
      where store_id = current_setting('test.frederick', true)::uuid
        and date = current_setting('test.d_s', true)::date
        and vendor_id = '18000000-0000-0000-0000-0000000000f2'), true);
end $$;

select is(
  (select count(*)::int from public.notifications
    where type = 'eod_update'
      and submission_id = current_setting('test.sub_s', true)::uuid),
  1,
  '(7) S1 AC-8: a submitted→submitted edit through staff_submit_eod emits exactly ONE eod_update'
);

select is(
  (select format('%s|%s|%s|%s|%s',
     (n.actor_user_id = current_setting('test.admin_id', true)::uuid),
     (n.actor_user_id = current_setting('test.user_id', true)::uuid),
     n.body,
     (n.source_id <> current_setting('test.sub_s', true)::uuid),
     (n.actor_name is not distinct from
       (select coalesce(p.username, p.name) from public.profiles p
         where p.id = current_setting('test.admin_id', true)::uuid)))
     from public.notifications n
    where n.type = 'eod_update'
      and n.submission_id = current_setting('test.sub_s', true)::uuid),
  format('t|f|SPEC180-VS-%s|t|t', current_setting('test.tag', true)),
  '(8) S1 AC-9: the eod_update actor is the EDITOR (admin A, not original submitter U); body = vendor name; source_id is a per-edit id'
);

select is(
  (select count(*)::int from public.notifications
    where source_id = current_setting('test.sub_s', true)::uuid
      and type in ('eod', 'order_ready')),
  1,
  '(9) S1 AC-11: the fresh-submit row stays exactly-once after an edit'
);

-- S2 — a third edit.
set local role authenticated;
select public.staff_submit_eod(
  '18000000-0000-0000-0000-0000000cc003'::uuid,
  current_setting('test.frederick', true)::uuid,
  current_setting('test.d_s', true)::date, null, 'submitted', current_setting('test.payload', true)::jsonb,
  '18000000-0000-0000-0000-0000000000f2'::uuid);
reset role;

select is(
  (select count(*)::int from public.notifications
    where type = 'eod_update'
      and submission_id = current_setting('test.sub_s', true)::uuid),
  2,
  '(10) S2 AC-8: two edits give two eod_update rows (one per edit, never deduped)'
);

-- S3 — replay of the client_uuid the row actually stores (the first call's;
-- the RPC's DO UPDATE keeps the original client_uuid) → idempotent early
-- return at RPC step (4), before the upsert.
set local role authenticated;
create temp table _s3_replay on commit drop as
select public.staff_submit_eod(
  '18000000-0000-0000-0000-0000000cc001'::uuid,
  current_setting('test.frederick', true)::uuid,
  current_setting('test.d_s', true)::date, null, 'submitted', current_setting('test.payload', true)::jsonb,
  '18000000-0000-0000-0000-0000000000f2'::uuid) as result;
reset role;

select is(
  (select (result ->> 'conflict') from _s3_replay),
  'true',
  '(11) S3: the replay hits the client_uuid idempotency return'
);

select is(
  (select count(*)::int from _sub_notifs
    where sub_id = current_setting('test.sub_s', true)::uuid),
  3,
  '(12) S3: an idempotent replay writes NO new notification (still 1 fresh + 2 eod_update)'
);


-- ═══ P1 — the db.ts PostgREST merge-duplicates upsert (AC-8) ══════
set local role authenticated;
select set_config('request.jwt.claims', jsonb_build_object(
  'sub', current_setting('test.admin_id', true),
  'role', 'authenticated',
  'app_metadata', jsonb_build_object('role', 'admin')
)::text, true);

-- First call: INSERT branch → fresh submit.
insert into public.eod_submissions (store_id, date, vendor_id, submitted_by, status, submitted_at)
values (current_setting('test.frederick', true)::uuid, date '1999-11-03',
        '18000000-0000-0000-0000-0000000000f3',
        current_setting('test.admin_id', true)::uuid, 'submitted', now())
on conflict (store_id, date, vendor_id) do update
  set store_id = excluded.store_id, date = excluded.date, vendor_id = excluded.vendor_id,
      submitted_by = excluded.submitted_by, status = excluded.status,
      submitted_at = excluded.submitted_at;

-- Second call: the same statement → DO UPDATE branch → an edit.
insert into public.eod_submissions (store_id, date, vendor_id, submitted_by, status, submitted_at)
values (current_setting('test.frederick', true)::uuid, date '1999-11-03',
        '18000000-0000-0000-0000-0000000000f3',
        current_setting('test.admin_id', true)::uuid, 'submitted', now())
on conflict (store_id, date, vendor_id) do update
  set store_id = excluded.store_id, date = excluded.date, vendor_id = excluded.vendor_id,
      submitted_by = excluded.submitted_by, status = excluded.status,
      submitted_at = excluded.submitted_at;

reset role;

do $$
begin
  perform set_config('test.sub_p',
    (select id::text from public.eod_submissions
      where store_id = current_setting('test.frederick', true)::uuid
        and date = date '1999-11-03'
        and vendor_id = '18000000-0000-0000-0000-0000000000f3'), true);
end $$;

select is(
  (select format('%s|%s',
     (select count(*) from public.notifications
       where source_id = current_setting('test.sub_p', true)::uuid
         and type in ('eod', 'order_ready')),
     (select count(*) from public.notifications
       where submission_id = current_setting('test.sub_p', true)::uuid
         and type = 'eod_update'))),
  '1|1',
  '(13) P1 AC-8: the PostgREST upsert shape — first call fresh, second call +1 eod_update'
);

select is(
  (select actor_user_id from public.notifications
    where submission_id = current_setting('test.sub_p', true)::uuid
      and type = 'eod_update'),
  current_setting('test.admin_id', true)::uuid,
  '(14) P1 AC-9: the db.ts-path eod_update actor is the admin making the edit'
);


-- ═══ D1/D2/D3 — drafts and promotions (AC-10, AC-11) ══════════════
set local role authenticated;

-- D1a — draft INSERT.
insert into public.eod_submissions (store_id, date, vendor_id, submitted_by, status, submitted_at)
values (current_setting('test.frederick', true)::uuid, date '1999-11-04',
        '18000000-0000-0000-0000-0000000000f4',
        current_setting('test.admin_id', true)::uuid, 'draft', now())
on conflict (store_id, date, vendor_id) do update
  set status = excluded.status, submitted_at = excluded.submitted_at;

reset role;
do $$
begin
  perform set_config('test.sub_d',
    (select id::text from public.eod_submissions
      where store_id = current_setting('test.frederick', true)::uuid
        and date = date '1999-11-04'
        and vendor_id = '18000000-0000-0000-0000-0000000000f4'), true);
end $$;

select is(
  (select count(*)::int from _sub_notifs
    where sub_id = current_setting('test.sub_d', true)::uuid),
  0,
  '(15) D1 AC-10: a draft INSERT notifies nobody'
);

-- D1b — draft → draft re-save.
set local role authenticated;
insert into public.eod_submissions (store_id, date, vendor_id, submitted_by, status, submitted_at)
values (current_setting('test.frederick', true)::uuid, date '1999-11-04',
        '18000000-0000-0000-0000-0000000000f4',
        current_setting('test.admin_id', true)::uuid, 'draft', now())
on conflict (store_id, date, vendor_id) do update
  set status = excluded.status, submitted_at = excluded.submitted_at;
reset role;

select is(
  (select count(*)::int from _sub_notifs
    where sub_id = current_setting('test.sub_d', true)::uuid),
  0,
  '(16) D1 AC-10: a draft→draft re-save notifies nobody'
);

-- D2 — draft → submitted promotion.
set local role authenticated;
insert into public.eod_submissions (store_id, date, vendor_id, submitted_by, status, submitted_at)
values (current_setting('test.frederick', true)::uuid, date '1999-11-04',
        '18000000-0000-0000-0000-0000000000f4',
        current_setting('test.admin_id', true)::uuid, 'submitted', now())
on conflict (store_id, date, vendor_id) do update
  set status = excluded.status, submitted_at = excluded.submitted_at;
reset role;

select is(
  (select format('%s|%s|%s',
     (select count(*) from public.notifications
       where source_id = current_setting('test.sub_d', true)::uuid
         and type in ('eod', 'order_ready')),
     (select count(*) from public.notifications
       where source_id = current_setting('test.sub_d', true)::uuid
         and type in ('eod', 'order_ready')
         and actor_user_id = current_setting('test.admin_id', true)::uuid),
     (select count(*) from public.notifications
       where submission_id = current_setting('test.sub_d', true)::uuid
         and type = 'eod_update'))),
  '1|1|0',
  '(17) D2 AC-10: draft→submitted is a FRESH submit — one eod/order_ready (actor = promoter), zero eod_update'
);

-- D3a — submitted → draft demotion.
set local role authenticated;
update public.eod_submissions set status = 'draft'
 where id = current_setting('test.sub_d', true)::uuid;
reset role;

select is(
  (select count(*)::int from _sub_notifs
    where sub_id = current_setting('test.sub_d', true)::uuid),
  1,
  '(18) D3 AC-10: a submitted→draft transition notifies nobody'
);

-- Make VD below par BEFORE the re-promotion, so a fresh emit would now choose
-- 'order_ready' — a different type from the original 'eod', which the
-- (type, source_id) unique index would NOT dedupe. Only the (R) branch keeps
-- AC-11 exactly-once here.
do $$
declare v_cat uuid; v_item uuid;
begin
  insert into public.catalog_ingredients (brand_id, name, unit, case_qty, sub_unit_size, default_cost)
  values (current_setting('test.brand_a', true)::uuid,
          'SPEC180-BELOW-' || current_setting('test.tag', true), 'each', 1, 1, 1.00)
  returning id into v_cat;

  insert into public.inventory_items (store_id, catalog_id, vendor_id, cost_per_unit, current_stock, par_level)
  values (current_setting('test.frederick', true)::uuid, v_cat,
          '18000000-0000-0000-0000-0000000000f4', 1.00, 1, 10)
  returning id into v_item;

  insert into public.item_vendors (item_id, vendor_id, cost_per_unit, case_price, is_primary)
  values (v_item, '18000000-0000-0000-0000-0000000000f4', 1.00, 1.00, true);
end $$;

-- D3b — re-promotion draft → submitted.
set local role authenticated;
update public.eod_submissions set status = 'submitted'
 where id = current_setting('test.sub_d', true)::uuid;
reset role;

select is(
  (select format('%s|%s',
     (select count(*) from public.notifications
       where source_id = current_setting('test.sub_d', true)::uuid
         and type in ('eod', 'order_ready')),
     (select count(*) from public.notifications
       where submission_id = current_setting('test.sub_d', true)::uuid
         and type = 'eod_update'))),
  '1|1',
  '(19) D3 AC-10/11: a re-promotion after a demotion is an eod_update, not a second fresh row'
);

select is(
  (select count(*)::int from public.notifications
    where source_id = current_setting('test.sub_d', true)::uuid
      and type = 'order_ready'),
  0,
  '(20) D3 AC-11: no cross-type duplicate — the original eod is not joined by an order_ready'
);


-- ═══ G1 — the claims-less guard ══════════════════════════════════
select set_config('request.jwt.claims', null, true);

update public.eod_submissions set submitted_at = submitted_at
 where id = '18000000-0000-0000-0000-00000000f001';

select is(
  (select count(*)::int from _sub_notifs
    where sub_id = '18000000-0000-0000-0000-00000000f001'),
  1,
  '(21) G1: an UPDATE with no JWT claims (maintenance write) notifies nobody'
);


-- ═══ R1 — eod_update rows ride the existing brand RLS ═════════════
-- Re-point the master to the test-only foreign brand, then probe as an
-- 'admin' JWT: auth_is_privileged() is TRUE but auth_can_see_brand(brand A)
-- is FALSE.
update public.profiles set brand_id = current_setting('test.brand_b', true)::uuid
 where id = current_setting('test.master_id', true)::uuid;

do $$
begin
  perform set_config('test.update_row',
    (select id::text from public.notifications
      where type = 'eod_update'
        and submission_id = current_setting('test.sub_p', true)::uuid), true);
end $$;

set local role authenticated;

select set_config('request.jwt.claims', jsonb_build_object(
  'sub', current_setting('test.admin_id', true),
  'role', 'authenticated',
  'app_metadata', jsonb_build_object('role', 'admin')
)::text, true);

select is(
  (select count(*)::int from public.notifications
    where id = current_setting('test.update_row', true)::uuid),
  1,
  '(22) R1: a brand-A admin SEES the eod_update row'
);

select set_config('request.jwt.claims', jsonb_build_object(
  'sub', current_setting('test.master_id', true),
  'role', 'authenticated',
  'app_metadata', jsonb_build_object('role', 'admin')
)::text, true);

select is(
  (select count(*)::int from public.notifications
    where id = current_setting('test.update_row', true)::uuid),
  0,
  '(23) R1: a foreign-brand admin gets ZERO rows (RLS denies)'
);

select set_config('request.jwt.claims', jsonb_build_object(
  'sub', current_setting('test.user_id', true),
  'role', 'authenticated',
  'app_metadata', jsonb_build_object('role', 'user')
)::text, true);

select is(
  (select count(*)::int from public.notifications
    where id = current_setting('test.update_row', true)::uuid),
  0,
  '(24) R1: a same-brand user gets ZERO rows (auth_is_privileged() conjunct)'
);

reset role;
select set_config('request.jwt.claims', null, true);


-- ═══ T1 — the 60 s edit-push throttle ════════════════════════════
insert into public.notifications (id, brand_id, store_id, type, source_id, store_name)
values
  ('18000000-0000-0000-0000-0000000d0001', current_setting('test.brand_a', true)::uuid,
   current_setting('test.store_t1', true)::uuid, 'eod',
   '18000000-0000-0000-0000-0000000d1001', 'SPEC180 Throttle 1'),
  ('18000000-0000-0000-0000-0000000d0002', current_setting('test.brand_a', true)::uuid,
   current_setting('test.store_t1', true)::uuid, 'eod_update',
   '18000000-0000-0000-0000-0000000d1002', 'SPEC180 Throttle 1');

select is(
  public.eod_update_push_suppressed(
    current_setting('test.brand_a', true)::uuid,
    current_setting('test.store_t1', true)::uuid,
    '18000000-0000-0000-0000-0000000d0002'::uuid),
  true,
  '(25) T1: suppressed when another same-store EOD-family row landed inside 60 s'
);

update public.notifications set created_at = now() - interval '2 minutes'
 where id = '18000000-0000-0000-0000-0000000d0001';

select is(
  public.eod_update_push_suppressed(
    current_setting('test.brand_a', true)::uuid,
    current_setting('test.store_t1', true)::uuid,
    '18000000-0000-0000-0000-0000000d0002'::uuid),
  false,
  '(26) T1: NOT suppressed when the only other row is older than 60 s'
);

update public.notifications set created_at = now()
 where id = '18000000-0000-0000-0000-0000000d0001';

select is(
  public.eod_update_push_suppressed(
    current_setting('test.brand_a', true)::uuid,
    current_setting('test.store_t2', true)::uuid,
    '18000000-0000-0000-0000-0000000d0002'::uuid),
  false,
  '(27) T1: NOT suppressed by a recent row for a DIFFERENT store'
);


-- ═══ A1 — ACL ═════════════════════════════════════════════════════
select is(
  (select format('%s|%s|%s|%s',
     has_function_privilege('authenticated',
       'public.emit_eod_submit_notification(uuid,uuid,uuid,uuid)', 'EXECUTE'),
     has_function_privilege('authenticated',
       'public.emit_eod_update(uuid,uuid,uuid,uuid)', 'EXECUTE'),
     has_function_privilege('authenticated',
       'public.eod_update_push_suppressed(uuid,uuid,uuid)', 'EXECUTE'),
     has_function_privilege('authenticated',
       'public.tg_notify_eod_resubmission()', 'EXECUTE'))),
  'f|f|f|f',
  '(28) A1: authenticated lacks EXECUTE on all four new internal functions'
);


-- ═══ A2 — trigger shape ═══════════════════════════════════════════
select ok(
  (select pg_get_triggerdef(t.oid) like '%AFTER UPDATE OF status, submitted_at ON public.eod_submissions%'
      and pg_get_triggerdef(t.oid) like '%WHEN ((new.status = ''submitted''::text))%'
      and pg_get_triggerdef(t.oid) like '%tg_notify_eod_resubmission()%'
     from pg_trigger t
    where t.tgrelid = 'public.eod_submissions'::regclass
      and t.tgname = 'notify_eod_resubmission'),
  '(29) A2: notify_eod_resubmission is AFTER UPDATE OF status, submitted_at WHEN (new.status = ''submitted'')'
);

select ok(
  (select pg_get_triggerdef(t.oid) like '%AFTER INSERT ON public.eod_submissions%'
      and pg_get_triggerdef(t.oid) like '%tg_notify_eod_submission()%'
     from pg_trigger t
    where t.tgrelid = 'public.eod_submissions'::regclass
      and t.tgname = 'notify_eod_submission'),
  '(30) A2: notify_eod_submission is still AFTER INSERT (untouched)'
);



-- ═══ S4 — edit-uuid replay re-notifies (KNOWN, architect M-1) ═════
-- The S2 edit's uuid (cc003) — the row still stores cc001, so step (4) of
-- staff_submit_eod misses it and the edit re-runs. Pinned so the follow-up
-- idempotency spec has a red→green target; NOT the desired end state.
set local role authenticated;
select set_config('request.jwt.claims', jsonb_build_object(
  'sub', current_setting('test.admin_id', true),
  'role', 'authenticated',
  'app_metadata', jsonb_build_object('role', 'admin')
)::text, true);

select public.staff_submit_eod(
  '18000000-0000-0000-0000-0000000cc003'::uuid,
  current_setting('test.frederick', true)::uuid,
  current_setting('test.d_s', true)::date, null, 'submitted', current_setting('test.payload', true)::jsonb,
  '18000000-0000-0000-0000-0000000000f2'::uuid);
reset role;

select is(
  (select count(*)::int from public.notifications
    where type = 'eod_update'
      and submission_id = current_setting('test.sub_s', true)::uuid),
  3,
  '(31) S4 KNOWN (M-1): replaying an EDIT''s client_uuid re-runs the edit and emits +1 eod_update (pre-existing RPC idempotency gap)'
);


-- ═══ G2 — the trigger is column-scoped (architect M-2) ════════════
-- Same statement shape as the FK `on delete set null` referential action on
-- eod_submissions.submitted_by: a SET of submitted_by ONLY, here under a real
-- user JWT so guard (G) would NOT stop it. The BEFORE trigger still rewrites
-- submitted_by, but a column-list trigger keys on the statement's SET targets.
select set_config('request.jwt.claims', jsonb_build_object(
  'sub', current_setting('test.admin_id', true),
  'role', 'authenticated',
  'app_metadata', jsonb_build_object('role', 'admin')
)::text, true);

update public.eod_submissions set submitted_by = null
 where id = '18000000-0000-0000-0000-00000000f001';

select set_config('request.jwt.claims', null, true);

select is(
  (select count(*)::int from _sub_notifs
    where sub_id = '18000000-0000-0000-0000-00000000f001'),
  1,
  '(32) G2: an UPDATE that sets only submitted_by (the FK SET NULL shape) does not fire notify_eod_resubmission, even with a user JWT'
);


-- ═══ V1 — vendor-name lookup is brand-checked (security Low 3) ════
insert into public.vendors (id, name, brand_id)
values ('18000000-0000-0000-0000-0000000000f9',
        'SPEC180-FOREIGN-' || current_setting('test.tag', true),
        current_setting('test.brand_b', true)::uuid);

select public.emit_eod_update(
  '18000000-0000-0000-0000-00000000f009'::uuid,
  current_setting('test.frederick', true)::uuid,
  '18000000-0000-0000-0000-0000000000f9'::uuid,
  current_setting('test.admin_id', true)::uuid);

select is(
  (select format('%s|%s', count(*), count(*) filter (where body is null))
     from public.notifications
    where type = 'eod_update'
      and submission_id = '18000000-0000-0000-0000-00000000f009'),
  '1|1',
  '(33) V1: a foreign-brand vendor never leaks its name — the eod_update row lands with body NULL'
);

select finish();
rollback;
