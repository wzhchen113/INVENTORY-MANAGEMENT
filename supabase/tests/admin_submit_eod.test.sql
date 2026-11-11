-- supabase/tests/admin_submit_eod.test.sql
--
-- Spec 189 — pgTAP coverage for supabase/migrations/20261109120000_admin_eod_replace.sql:
-- admin_submit_eod (definer gate), eod_write_submission (invoker writer),
-- the staff_submit_eod refactor + O-1 empty refusal (owner approved
-- 2026-11-09), and the unique index eod_entries_submission_item_uidx.
-- Wording per the spec's §12 changes (R1/AC-3/AC-4/AC-7/AC-8/AC-15/AC-24/
-- AC-26, new AC-33 and AC-34).
--
-- Arms (plan(101)):
--   K   (1-13)  AC-15 catalog: prosecdef / proconfig / EXECUTE for anon,
--               authenticated, service_role on both new functions;
--               staff_submit_eod still definer + authenticated-only; the
--               unique index exists.
--   P   (14-15) AC-16: no DELETE/ALL policy on either table; a direct delete
--               under an admin JWT removes 0 rows.
--   ST  (16-24) staff path after the refactor: envelope keys unchanged, full
--               set written, submitted_by forced to the caller (AC-7 staff
--               arm), last_updated_by untouched (AC-8 staff arm), the
--               null-total on-hand guard (AC-10 staff), stock_updates, one
--               audit row per entry with the actor prefix, client_uuid.
--   AS  (25-34) AC-3 admin over staff: staff rows remain with the admin's
--               change applied and the cleared row gone; id and client_uuid
--               kept; entry_count; last_updated_by = admin; 'Count cleared'
--               audit row (AC-24); cleared on-hand kept; replay → conflict
--               true with admin state intact; submitted_by = admin.
--   E   (35-41) AC-1 / AC-6 / AC-7 / AC-8 EDIT: exactly the new values, id
--               kept, one parent, order_approvals link kept, submitted_by,
--               on-hand through a primary and a non-primary link.
--   DR  (42-43) AC-2 draft then submit.
--   LO  (44-47) AC-4 left-out item: named → gone with on-hand kept; not named
--               → untouched (same row id, on-hand not re-written).
--   PF  (48-53) AC-5 payload fidelity, AC-8, AC-9 off-vendor, AC-10 NO NEED
--               and null-total, stock_updates.
--   AT  (54-65) AC-11 / AC-12 / AC-13 / AC-14 all-or-nothing and refusals,
--               plus the vendor-brand, NULL-vendor, status and overlap
--               refusals, each with state read back unchanged.
--   UQ  (66-69) AC-27 23505 through the table and the writer; a re-submit
--               still succeeds with one row per item.
--   EM  (70-76) AC-33 empty call / non-array / leave-zero refusals on a
--               200-day-old submission; a blank-only correction removes only
--               that row.
--   O1  (77-81) AC-34 (O-1, owner approved 2026-11-09): staff '[]' / NULL /
--               non-array refused, state kept, replay with '[]' still conflict.
--   N   (82-85) AC-26 notifications through the real writer.
--   RD  (86-96) AC-17/18/19 readers vs a control submitted once, and the
--               admin path's no-per-entry-server-audit check (AC-24).
--   NR  (97-101) AC-33 / security L1: '{NULL}', an absent id, and an item
--               whose row is in another submission are each refused with
--               22023 on a removal-only call; nothing changes.
--
-- Every "survived / removed / unchanged" claim is read back as postgres
-- (RLS-free) after `reset role`, with request.jwt.claims cleared, so an
-- RLS-hidden row can't pass by accident.
--
-- Fixture posture: brands, stores, vendors, catalog rows, items and links are
-- created INSIDE the transaction with fixed 18900000-… ids and 1999-12-* dates
-- (plus one current_date - 200 date for AC-33), so the file is green under the
-- committed seed and on a CI-fresh database. Principals: seed admin 1111
-- (admin, brand A) and seed user 2222 (role 'user', given membership of the
-- test store here). No `set role anon` (segfaults CI per spec 067).
-- now() is constant inside the transaction, so "submitted_at unchanged" arms
-- first backdate submitted_at to a literal. Hermetic: begin; … rollback;.

begin;
create extension if not exists pgtap;

select plan(101);

-- ─── fixtures (as postgres) ─────────────────────────────────────
do $$
declare
  v_brand_a uuid;
begin
  select brand_id into v_brand_a
    from public.profiles where id = '11111111-1111-1111-1111-111111111111';
  perform set_config('test.brand_a', v_brand_a::text, true);
  perform set_config('test.tag', substr(gen_random_uuid()::text, 1, 8), true);
  perform set_config('test.claims_admin', jsonb_build_object(
    'sub', '11111111-1111-1111-1111-111111111111',
    'role', 'authenticated',
    'app_metadata', jsonb_build_object('role', 'admin'))::text, true);
  perform set_config('test.claims_user', jsonb_build_object(
    'sub', '22222222-2222-2222-2222-222222222222',
    'role', 'authenticated',
    'app_metadata', jsonb_build_object('role', 'user'))::text, true);
end $$;

insert into public.brands (id, name)
values ('18900000-0000-0000-0000-0000000000b0', 'Foreign Brand (test 189)')
on conflict (id) do nothing;

-- S1 main, S2 holds the cross-store item, SR/SC readers re-submit/control,
-- SB is in the foreign brand.
insert into public.stores (id, brand_id, name, address, status, eod_deadline_time)
values
  ('18900000-0000-0000-0000-0000000000a1', current_setting('test.brand_a', true)::uuid, 'SPEC189 Main',    '1 Test Way', 'active', '22:00'),
  ('18900000-0000-0000-0000-0000000000a2', current_setting('test.brand_a', true)::uuid, 'SPEC189 Other',   '2 Test Way', 'active', '22:00'),
  ('18900000-0000-0000-0000-0000000000a3', current_setting('test.brand_a', true)::uuid, 'SPEC189 Readers', '3 Test Way', 'active', '22:00'),
  ('18900000-0000-0000-0000-0000000000a4', current_setting('test.brand_a', true)::uuid, 'SPEC189 Control', '4 Test Way', 'active', '22:00'),
  ('18900000-0000-0000-0000-0000000000b1', '18900000-0000-0000-0000-0000000000b0',      'SPEC189 Foreign', '5 Test Way', 'active', '22:00');

-- V: the counted vendor. VB: foreign brand. VN: notifications only (no links,
-- so its fresh branch is deterministically 'eod').
insert into public.vendors (id, name, brand_id)
values
  ('18900000-0000-0000-0000-0000000000f1', 'SPEC189-V-'  || current_setting('test.tag', true), current_setting('test.brand_a', true)::uuid),
  ('18900000-0000-0000-0000-0000000000f2', 'SPEC189-VB-' || current_setting('test.tag', true), '18900000-0000-0000-0000-0000000000b0'),
  ('18900000-0000-0000-0000-0000000000f3', 'SPEC189-VN-' || current_setting('test.tag', true), current_setting('test.brand_a', true)::uuid);

-- c01..c07 → S1 items I1..I7; c08 → S2 item X; c09 → R in SR and SC.
insert into public.catalog_ingredients (id, brand_id, name, unit, case_qty)
select ('18900000-0000-0000-0000-000000000c0' || k)::uuid,
       current_setting('test.brand_a', true)::uuid,
       'SPEC189-C' || k || '-' || current_setting('test.tag', true),
       'lbs', 1
  from generate_series(1, 9) k;

-- I1..I7 in S1. I7 has NO item_vendors link (the off-vendor escape hatch).
-- last_updated_by starts as the seed master so staff/admin differences show.
insert into public.inventory_items
  (id, store_id, catalog_id, vendor_id, cost_per_unit, current_stock, eod_remaining, par_level, last_updated_by)
select ('18900000-0000-0000-0000-00000000010' || k)::uuid,
       '18900000-0000-0000-0000-0000000000a1'::uuid,
       ('18900000-0000-0000-0000-000000000c0' || k)::uuid,
       case when k = 7 then null else '18900000-0000-0000-0000-0000000000f1'::uuid end,
       2.5, 42, 42, 5,
       '33333333-3333-3333-3333-333333333333'::uuid
  from generate_series(1, 7) k;

insert into public.inventory_items
  (id, store_id, catalog_id, vendor_id, cost_per_unit, current_stock, eod_remaining, par_level)
values
  ('18900000-0000-0000-0000-000000000201', '18900000-0000-0000-0000-0000000000a2',
   '18900000-0000-0000-0000-000000000c08', '18900000-0000-0000-0000-0000000000f1', 2.5, 42, 42, 5),
  ('18900000-0000-0000-0000-000000000301', '18900000-0000-0000-0000-0000000000a3',
   '18900000-0000-0000-0000-000000000c09', '18900000-0000-0000-0000-0000000000f1', 2.5, 42, 42, 5),
  ('18900000-0000-0000-0000-000000000401', '18900000-0000-0000-0000-0000000000a4',
   '18900000-0000-0000-0000-000000000c09', '18900000-0000-0000-0000-0000000000f1', 2.5, 42, 42, 5);

-- Links to V. I2's only link is NON-primary (AC-8 "primary or not").
insert into public.item_vendors (item_id, vendor_id, cost_per_unit, case_price, is_primary)
select ('18900000-0000-0000-0000-00000000010' || k)::uuid,
       '18900000-0000-0000-0000-0000000000f1'::uuid, 2.5, 2.5, (k <> 2)
  from generate_series(1, 6) k;
insert into public.item_vendors (item_id, vendor_id, cost_per_unit, case_price, is_primary)
values
  ('18900000-0000-0000-0000-000000000201', '18900000-0000-0000-0000-0000000000f1', 2.5, 2.5, true),
  ('18900000-0000-0000-0000-000000000301', '18900000-0000-0000-0000-0000000000f1', 2.5, 2.5, true),
  ('18900000-0000-0000-0000-000000000401', '18900000-0000-0000-0000-0000000000f1', 2.5, 2.5, true);

-- The role-'user' store member, for the staff path and AC-13.
insert into public.user_stores (user_id, store_id)
values ('22222222-2222-2222-2222-222222222222', '18900000-0000-0000-0000-0000000000a1');

-- Read-back helpers (called as postgres only).
create function pg_temp.sub_of(p_store uuid, p_date date, p_vendor uuid) returns uuid
language sql as $$
  select id from public.eod_submissions
   where store_id = p_store and date = p_date and vendor_id = p_vendor
$$;

-- Entries as "<item suffix>=<value>[/NN]" sorted by item.
create function pg_temp.entries_of(p_sub uuid) returns text
language sql as $$
  select coalesce(string_agg(
           right(e.item_id::text, 3) || '=' || coalesce(trim_scale(e.actual_remaining)::text, 'null')
           || case when e.no_need then '/NN' else '' end,
           ',' order by e.item_id), '')
    from public.eod_entries e
   where e.submission_id = p_sub
$$;

-- Everything AC-11..AC-14 promise is untouched: entries (with ids), parent,
-- S1 on-hand, notification rows for the submission, S1 audit rows.
create function pg_temp.state_of(p_sub uuid) returns text
language sql as $$
  select concat_ws(' | ',
    (select coalesce(string_agg(
              e.id::text || ':' || right(e.item_id::text, 3) || '='
              || coalesce(trim_scale(e.actual_remaining)::text, 'null')
              || coalesce('/' || trim_scale(e.actual_remaining_cases)::text, '')
              || coalesce('/' || trim_scale(e.actual_remaining_each)::text, '')
              || case when e.no_need then '/NN' else '' end || '/' || e.notes,
              ',' order by e.item_id), '')
       from public.eod_entries e where e.submission_id = p_sub),
    (select s.status || '@' || s.submitted_at::text || '@' || coalesce(s.submitted_by::text, '-')
       from public.eod_submissions s where s.id = p_sub),
    (select string_agg(right(ii.id::text, 3) || ':' || ii.current_stock::text || '/'
                       || ii.eod_remaining::text || '/' || coalesce(ii.last_updated_by::text, '-'),
                       ',' order by ii.id)
       from public.inventory_items ii
      where ii.store_id = '18900000-0000-0000-0000-0000000000a1'),
    (select count(*)::text from public.notifications n
      where coalesce(n.submission_id, n.source_id) = p_sub),
    (select count(*)::text from public.audit_log a
      where a.store_id = '18900000-0000-0000-0000-0000000000a1'))
$$;


-- ═══ K — AC-15 catalog arms ═══════════════════════════════════════
select is(
  (select prosecdef from pg_proc where oid = 'public.admin_submit_eod(uuid, date, uuid, text, jsonb, uuid[])'::regprocedure),
  true,
  '(1) AC-15: admin_submit_eod is SECURITY DEFINER');

select is(
  (select proconfig from pg_proc where oid = 'public.admin_submit_eod(uuid, date, uuid, text, jsonb, uuid[])'::regprocedure),
  array['search_path=public']::text[],
  '(2) AC-15: admin_submit_eod pins search_path = public');

select is(
  (select prosecdef from pg_proc where oid = 'public.eod_write_submission(uuid, date, uuid, text, jsonb, uuid, uuid[], text, uuid)'::regprocedure),
  false,
  '(3) AC-15: eod_write_submission is SECURITY INVOKER');

select is(
  (select proconfig from pg_proc where oid = 'public.eod_write_submission(uuid, date, uuid, text, jsonb, uuid, uuid[], text, uuid)'::regprocedure),
  array['search_path=public']::text[],
  '(4) AC-15: eod_write_submission pins search_path = public');

select is(has_function_privilege('anon',
  'public.admin_submit_eod(uuid, date, uuid, text, jsonb, uuid[])', 'execute'),
  false, '(5) AC-15: anon lacks EXECUTE on admin_submit_eod');

select is(has_function_privilege('authenticated',
  'public.admin_submit_eod(uuid, date, uuid, text, jsonb, uuid[])', 'execute'),
  true, '(6) AC-15: authenticated has EXECUTE on admin_submit_eod');

select is(has_function_privilege('service_role',
  'public.admin_submit_eod(uuid, date, uuid, text, jsonb, uuid[])', 'execute'),
  false, '(7) AC-15: service_role lacks EXECUTE on admin_submit_eod');

select is(has_function_privilege('anon',
  'public.eod_write_submission(uuid, date, uuid, text, jsonb, uuid, uuid[], text, uuid)', 'execute'),
  false, '(8) AC-15: anon lacks EXECUTE on eod_write_submission');

select is(has_function_privilege('authenticated',
  'public.eod_write_submission(uuid, date, uuid, text, jsonb, uuid, uuid[], text, uuid)', 'execute'),
  false, '(9) AC-15: authenticated lacks EXECUTE on eod_write_submission');

select is(has_function_privilege('service_role',
  'public.eod_write_submission(uuid, date, uuid, text, jsonb, uuid, uuid[], text, uuid)', 'execute'),
  false, '(10) AC-15: service_role lacks EXECUTE on eod_write_submission');

select is(
  (select prosecdef from pg_proc where oid = 'public.staff_submit_eod(uuid, uuid, date, text, text, jsonb, uuid)'::regprocedure),
  true,
  '(11) staff_submit_eod is still SECURITY DEFINER after the refactor');

select is(
  format('%s|%s|%s',
    has_function_privilege('anon',          'public.staff_submit_eod(uuid, uuid, date, text, text, jsonb, uuid)', 'execute'),
    has_function_privilege('authenticated', 'public.staff_submit_eod(uuid, uuid, date, text, text, jsonb, uuid)', 'execute'),
    has_function_privilege('service_role',  'public.staff_submit_eod(uuid, uuid, date, text, text, jsonb, uuid)', 'execute')),
  'f|t|f',
  '(12) staff_submit_eod ACL carried over: authenticated only');

select is(
  (select indexdef from pg_indexes
    where schemaname = 'public' and indexname = 'eod_entries_submission_item_uidx'),
  'CREATE UNIQUE INDEX eod_entries_submission_item_uidx ON public.eod_entries USING btree (submission_id, item_id)',
  '(13) D-1: unique index on eod_entries (submission_id, item_id)');


-- ═══ P — AC-16 no DELETE / ALL policy ═════════════════════════════
select is(
  (select count(*)::int from pg_policies
    where schemaname = 'public'
      and tablename in ('eod_entries', 'eod_submissions')
      and cmd in ('DELETE', 'ALL')),
  0,
  '(14) AC-16: no DELETE or ALL policy on eod_entries or eod_submissions');

-- A row to aim the delete at (as postgres, no claims).
insert into public.eod_submissions (id, store_id, date, vendor_id, status)
values ('18900000-0000-0000-0000-00000000d016', '18900000-0000-0000-0000-0000000000a1',
        date '1999-11-16', '18900000-0000-0000-0000-0000000000f1', 'draft');
insert into public.eod_entries (submission_id, item_id, actual_remaining)
values ('18900000-0000-0000-0000-00000000d016', '18900000-0000-0000-0000-000000000101', 3);

set local role authenticated;
select set_config('request.jwt.claims', current_setting('test.claims_admin', true), true);
delete from public.eod_entries where submission_id = '18900000-0000-0000-0000-00000000d016';
reset role;
select set_config('request.jwt.claims', '', true);

select is(
  (select count(*)::int from public.eod_entries
    where submission_id = '18900000-0000-0000-0000-00000000d016'),
  1,
  '(15) AC-16: a direct delete from eod_entries under an admin JWT removes 0 rows (read back as postgres)');


-- ═══ ST — staff path after the refactor (D3 = 1999-12-03) ═════════
-- I1=5, I2=7, I3=9, I4 non-NO-NEED with a NULL total. p_submitted_by names
-- someone else; the trigger must still record the caller.
set local role authenticated;
select set_config('request.jwt.claims', current_setting('test.claims_user', true), true);
select set_config('test.r_staff', public.staff_submit_eod(
  '18900000-0000-0000-0000-0000000cc001'::uuid,
  '18900000-0000-0000-0000-0000000000a1'::uuid,
  date '1999-12-03',
  '33333333-3333-3333-3333-333333333333',
  'submitted',
  '[{"ingredient_id":"18900000-0000-0000-0000-000000000101","actual_remaining":5,"unit":"lbs"},
    {"ingredient_id":"18900000-0000-0000-0000-000000000102","actual_remaining":7},
    {"ingredient_id":"18900000-0000-0000-0000-000000000103","actual_remaining":9},
    {"ingredient_id":"18900000-0000-0000-0000-000000000104","actual_remaining":null}]'::jsonb,
  '18900000-0000-0000-0000-0000000000f1'::uuid)::text, true);
reset role;
select set_config('request.jwt.claims', '', true);

select set_config('test.sub_d3',
  pg_temp.sub_of('18900000-0000-0000-0000-0000000000a1', date '1999-12-03', '18900000-0000-0000-0000-0000000000f1')::text,
  true);

select is(
  (select array_agg(k order by k) from jsonb_object_keys(current_setting('test.r_staff', true)::jsonb) k),
  array['conflict', 'entry_ids', 'stock_updates', 'submission_id']::text[],
  '(16) staff envelope keys are unchanged by the refactor');

select is(
  pg_temp.entries_of(current_setting('test.sub_d3', true)::uuid),
  '101=5,102=7,103=9,104=null',
  '(17) staff path still writes the full set it was sent');

select is(
  (select submitted_by from public.eod_submissions where id = current_setting('test.sub_d3', true)::uuid),
  '22222222-2222-2222-2222-222222222222'::uuid,
  '(18) AC-7 staff arm: submitted_by is the caller even when p_submitted_by names someone else');

select is(
  (select format('%s/%s/%s', current_stock, eod_remaining, last_updated_by)
     from public.inventory_items where id = '18900000-0000-0000-0000-000000000101'),
  '5.000/5.000/33333333-3333-3333-3333-333333333333',
  '(19) AC-8 staff arm: on-hand written, last_updated_by left unchanged');

select is(
  (select format('%s/%s', current_stock, eod_remaining)
     from public.inventory_items where id = '18900000-0000-0000-0000-000000000104'),
  '42.000/42.000',
  '(20) AC-10 staff: a non-NO-NEED entry with a NULL total writes no on-hand (never current_stock = NULL)');

select is(
  (select array_agg(right(x->>'ingredient_id', 3) order by x->>'ingredient_id')
     from jsonb_array_elements(current_setting('test.r_staff', true)::jsonb -> 'stock_updates') x),
  array['101', '102', '103']::text[],
  '(21) staff stock_updates omits the NULL-total entry');

select is(
  (select count(*)::int from public.audit_log
    where store_id = '18900000-0000-0000-0000-0000000000a1'
      and action = 'EOD entry'
      and user_id is null
      and detail = '22222222-2222-2222-2222-222222222222 · vendor: SPEC189-V-' || current_setting('test.tag', true)),
  4,
  '(22) staff audit: one server row per entry, actor prefix + vendor suffix, user_id NULL (unchanged shape)');

select is(
  (select value from public.audit_log
    where store_id = '18900000-0000-0000-0000-0000000000a1'
      and action = 'EOD entry'
      and user_id is null
      and item_ref = 'SPEC189-C1-' || current_setting('test.tag', true)),
  '5 lbs',
  '(23) staff audit value is the sent total + unit (unchanged expression)');

select is(
  (select client_uuid from public.eod_submissions where id = current_setting('test.sub_d3', true)::uuid),
  '18900000-0000-0000-0000-0000000cc001'::uuid,
  '(24) staff submit records its client_uuid');


-- ═══ AS — AC-3 admin over the staff submission ════════════════════
set local role authenticated;
select set_config('request.jwt.claims', current_setting('test.claims_admin', true), true);
select set_config('test.r_as', public.admin_submit_eod(
  '18900000-0000-0000-0000-0000000000a1'::uuid,
  date '1999-12-03',
  '18900000-0000-0000-0000-0000000000f1'::uuid,
  'submitted',
  '[{"ingredient_id":"18900000-0000-0000-0000-000000000101","actual_remaining":50}]'::jsonb,
  array['18900000-0000-0000-0000-000000000103']::uuid[])::text, true);
reset role;
select set_config('request.jwt.claims', '', true);

select is(
  pg_temp.entries_of(current_setting('test.sub_d3', true)::uuid),
  '101=50,102=7,104=null',
  '(25) AC-3: the staff rows remain, with the admin''s change applied and the cleared row gone');

select is(
  (current_setting('test.r_as', true)::jsonb ->> 'submission_id')::uuid,
  current_setting('test.sub_d3', true)::uuid,
  '(26) AC-6: admin over staff keeps the submission id');

select is(
  (select client_uuid from public.eod_submissions where id = current_setting('test.sub_d3', true)::uuid),
  '18900000-0000-0000-0000-0000000cc001'::uuid,
  '(27) AC-3: client_uuid is unchanged by the admin re-submit');

select is(
  (current_setting('test.r_as', true)::jsonb ->> 'entry_count')::int,
  3,
  '(28) admin envelope entry_count = the entries the submission holds after the call');

select is(
  (select format('%s/%s/%s', current_stock, eod_remaining, last_updated_by)
     from public.inventory_items where id = '18900000-0000-0000-0000-000000000101'),
  '50.000/50.000/11111111-1111-1111-1111-111111111111',
  '(29) AC-8 admin arm: on-hand written and last_updated_by = the caller');

select is(
  (select format('%s|%s|%s', user_id, detail, value) from public.audit_log
    where store_id = '18900000-0000-0000-0000-0000000000a1'
      and action = 'EOD entry'
      and detail like 'Count cleared%'
      and item_ref = 'SPEC189-C3-' || current_setting('test.tag', true)),
  '11111111-1111-1111-1111-111111111111|Count cleared · vendor: SPEC189-V-'
    || current_setting('test.tag', true) || '|9 lbs',
  '(30) AC-24: one server ''Count cleared'' row for the cleared entry, with the removed value');

select is(
  (select format('%s/%s', current_stock, eod_remaining)
     from public.inventory_items where id = '18900000-0000-0000-0000-000000000103'),
  '9.000/9.000',
  '(31) AC-4 (via AC-3): the cleared item''s on-hand keeps its previous value');

-- Replay the staff's original client_uuid.
set local role authenticated;
select set_config('request.jwt.claims', current_setting('test.claims_user', true), true);
select set_config('test.r_replay', public.staff_submit_eod(
  '18900000-0000-0000-0000-0000000cc001'::uuid,
  '18900000-0000-0000-0000-0000000000a1'::uuid,
  date '1999-12-03', null, 'submitted',
  '[{"ingredient_id":"18900000-0000-0000-0000-000000000101","actual_remaining":5}]'::jsonb,
  '18900000-0000-0000-0000-0000000000f1'::uuid)::text, true);
reset role;
select set_config('request.jwt.claims', '', true);

select is(
  current_setting('test.r_replay', true)::jsonb ->> 'conflict',
  'true',
  '(32) AC-3: replaying the staff''s original client_uuid returns conflict: true');

select is(
  pg_temp.entries_of(current_setting('test.sub_d3', true)::uuid),
  '101=50,102=7,104=null',
  '(33) AC-3: the replay leaves the admin''s entries alone');

select is(
  (select submitted_by from public.eod_submissions where id = current_setting('test.sub_d3', true)::uuid),
  '11111111-1111-1111-1111-111111111111'::uuid,
  '(34) AC-7: after the admin re-submit, submitted_by = the admin (auth.uid())');


-- ═══ E — AC-1 EDIT (D1 = 1999-12-01) ═════════════════════════════
set local role authenticated;
select set_config('request.jwt.claims', current_setting('test.claims_admin', true), true);
select set_config('test.r_d1a', public.admin_submit_eod(
  '18900000-0000-0000-0000-0000000000a1'::uuid, date '1999-12-01',
  '18900000-0000-0000-0000-0000000000f1'::uuid, 'submitted',
  '[{"ingredient_id":"18900000-0000-0000-0000-000000000101","actual_remaining":6},
    {"ingredient_id":"18900000-0000-0000-0000-000000000102","actual_remaining":8}]'::jsonb,
  '{}'::uuid[])::text, true);
reset role;
select set_config('request.jwt.claims', '', true);

-- A linked approval, inserted as postgres (pending, no approver).
insert into public.order_approvals
  (id, store_id, vendor_id, business_date, approved_by, channel, status, lines, source_submission_id)
values
  ('18900000-0000-0000-0000-0000000aa001', '18900000-0000-0000-0000-0000000000a1',
   '18900000-0000-0000-0000-0000000000f1', date '1999-12-01', null, 'manual', 'pending', '[]'::jsonb,
   (current_setting('test.r_d1a', true)::jsonb ->> 'submission_id')::uuid);

set local role authenticated;
select set_config('request.jwt.claims', current_setting('test.claims_admin', true), true);
select set_config('test.r_d1b', public.admin_submit_eod(
  '18900000-0000-0000-0000-0000000000a1'::uuid, date '1999-12-01',
  '18900000-0000-0000-0000-0000000000f1'::uuid, 'submitted',
  '[{"ingredient_id":"18900000-0000-0000-0000-000000000101","actual_remaining":18},
    {"ingredient_id":"18900000-0000-0000-0000-000000000102","actual_remaining":20}]'::jsonb,
  '{}'::uuid[])::text, true);
reset role;
select set_config('request.jwt.claims', '', true);

select set_config('test.sub_d1', current_setting('test.r_d1a', true)::jsonb ->> 'submission_id', true);

select is(
  pg_temp.entries_of(current_setting('test.sub_d1', true)::uuid),
  '101=18,102=20',
  '(35) AC-1: an EDIT re-submit leaves exactly 2 entries, holding 18 and 20');

select is(
  current_setting('test.r_d1b', true)::jsonb ->> 'submission_id',
  current_setting('test.sub_d1', true),
  '(36) AC-6: the EDIT keeps eod_submissions.id');

select is(
  (select count(*)::int from public.eod_submissions
    where store_id = '18900000-0000-0000-0000-0000000000a1'
      and date = date '1999-12-01'
      and vendor_id = '18900000-0000-0000-0000-0000000000f1'),
  1,
  '(37) AC-6: one parent row per (store, date, vendor)');

select is(
  (select source_submission_id from public.order_approvals where id = '18900000-0000-0000-0000-0000000aa001'),
  current_setting('test.sub_d1', true)::uuid,
  '(38) AC-6: a linked order_approvals row keeps its source_submission_id');

select is(
  (select submitted_by from public.eod_submissions where id = current_setting('test.sub_d1', true)::uuid),
  '11111111-1111-1111-1111-111111111111'::uuid,
  '(39) AC-7: submitted_by = the caller''s auth.uid() (the admin function takes no id)');

select is(
  (select format('%s/%s/%s', current_stock, eod_remaining, last_updated_by)
     from public.inventory_items where id = '18900000-0000-0000-0000-000000000101'),
  '18.000/18.000/11111111-1111-1111-1111-111111111111',
  '(40) AC-8: a primary-linked numeric entry sets current_stock, eod_remaining and last_updated_by');

select is(
  (select format('%s/%s/%s', current_stock, eod_remaining, last_updated_by)
     from public.inventory_items where id = '18900000-0000-0000-0000-000000000102'),
  '20.000/20.000/11111111-1111-1111-1111-111111111111',
  '(41) AC-8: a NON-primary-linked numeric entry writes the on-hand too');


-- ═══ DR — AC-2 draft then submit (D2 = 1999-12-02) ═══════════════
set local role authenticated;
select set_config('request.jwt.claims', current_setting('test.claims_admin', true), true);
select public.admin_submit_eod(
  '18900000-0000-0000-0000-0000000000a1'::uuid, date '1999-12-02',
  '18900000-0000-0000-0000-0000000000f1'::uuid, 'draft',
  '[{"ingredient_id":"18900000-0000-0000-0000-000000000101","actual_remaining":1}]'::jsonb,
  '{}'::uuid[]);
select public.admin_submit_eod(
  '18900000-0000-0000-0000-0000000000a1'::uuid, date '1999-12-02',
  '18900000-0000-0000-0000-0000000000f1'::uuid, 'submitted',
  '[{"ingredient_id":"18900000-0000-0000-0000-000000000101","actual_remaining":6},
    {"ingredient_id":"18900000-0000-0000-0000-000000000102","actual_remaining":6},
    {"ingredient_id":"18900000-0000-0000-0000-000000000103","actual_remaining":6},
    {"ingredient_id":"18900000-0000-0000-0000-000000000104","actual_remaining":6},
    {"ingredient_id":"18900000-0000-0000-0000-000000000105","actual_remaining":6},
    {"ingredient_id":"18900000-0000-0000-0000-000000000106","actual_remaining":6}]'::jsonb,
  '{}'::uuid[]);
reset role;
select set_config('request.jwt.claims', '', true);

select set_config('test.sub_d2',
  pg_temp.sub_of('18900000-0000-0000-0000-0000000000a1', date '1999-12-02', '18900000-0000-0000-0000-0000000000f1')::text,
  true);

select is(
  (select format('%s/%s', count(*), count(distinct item_id)) from public.eod_entries
    where submission_id = current_setting('test.sub_d2', true)::uuid),
  '6/6',
  '(42) AC-2: draft then submit leaves exactly 6 entries for 6 distinct items');

select is(
  (select status from public.eod_submissions where id = current_setting('test.sub_d2', true)::uuid),
  'submitted',
  '(43) AC-2: status moved draft → submitted');


-- ═══ LO — AC-4 left-out item (D4 = 1999-12-04) ═══════════════════
set local role authenticated;
select set_config('request.jwt.claims', current_setting('test.claims_admin', true), true);
select public.admin_submit_eod(
  '18900000-0000-0000-0000-0000000000a1'::uuid, date '1999-12-04',
  '18900000-0000-0000-0000-0000000000f1'::uuid, 'submitted',
  '[{"ingredient_id":"18900000-0000-0000-0000-000000000101","actual_remaining":1},
    {"ingredient_id":"18900000-0000-0000-0000-000000000105","actual_remaining":2},
    {"ingredient_id":"18900000-0000-0000-0000-000000000106","actual_remaining":3}]'::jsonb,
  '{}'::uuid[]);
reset role;
select set_config('request.jwt.claims', '', true);

select set_config('test.sub_d4',
  pg_temp.sub_of('18900000-0000-0000-0000-0000000000a1', date '1999-12-04', '18900000-0000-0000-0000-0000000000f1')::text,
  true);
select set_config('test.d4_i5_entry',
  (select id::text from public.eod_entries
    where submission_id = current_setting('test.sub_d4', true)::uuid
      and item_id = '18900000-0000-0000-0000-000000000105'),
  true);

-- Re-submit: I1 changed, I6 named as cleared, I5 not named.
set local role authenticated;
select set_config('request.jwt.claims', current_setting('test.claims_admin', true), true);
select public.admin_submit_eod(
  '18900000-0000-0000-0000-0000000000a1'::uuid, date '1999-12-04',
  '18900000-0000-0000-0000-0000000000f1'::uuid, 'submitted',
  '[{"ingredient_id":"18900000-0000-0000-0000-000000000101","actual_remaining":11}]'::jsonb,
  array['18900000-0000-0000-0000-000000000106']::uuid[]);
reset role;
select set_config('request.jwt.claims', '', true);

select is(
  pg_temp.entries_of(current_setting('test.sub_d4', true)::uuid),
  '101=11,105=2',
  '(44) AC-4: the item named in the removal list is gone');

select is(
  (select format('%s/%s', current_stock, eod_remaining)
     from public.inventory_items where id = '18900000-0000-0000-0000-000000000106'),
  '3.000/3.000',
  '(45) AC-4: the cleared item''s current_stock and eod_remaining keep their previous values');

select is(
  (select id::text from public.eod_entries
    where submission_id = current_setting('test.sub_d4', true)::uuid
      and item_id = '18900000-0000-0000-0000-000000000105'),
  current_setting('test.d4_i5_entry', true),
  '(46) AC-4 (§12): an item NOT named stays untouched (same row id, same value)');

select is(
  (select format('%s/%s', current_stock, eod_remaining)
     from public.inventory_items where id = '18900000-0000-0000-0000-000000000105'),
  '2.000/2.000',
  '(47) AC-4 (§12): the untouched item''s on-hand is not re-written');


-- ═══ PF — AC-5 / AC-9 / AC-10 (D5 = 1999-12-05) ══════════════════
-- I5 numeric with splits + note; I2 NO NEED; I3 null total (not NO NEED);
-- I7 off-vendor. Snapshot on-hand first.
select set_config('test.d5_before',
  (select string_agg(right(id::text, 3) || ':' || current_stock || '/' || eod_remaining, ',' order by id)
     from public.inventory_items
    where id in ('18900000-0000-0000-0000-000000000102',
                 '18900000-0000-0000-0000-000000000103',
                 '18900000-0000-0000-0000-000000000107')),
  true);

set local role authenticated;
select set_config('request.jwt.claims', current_setting('test.claims_admin', true), true);
select set_config('test.r_d5', public.admin_submit_eod(
  '18900000-0000-0000-0000-0000000000a1'::uuid, date '1999-12-05',
  '18900000-0000-0000-0000-0000000000f1'::uuid, 'submitted',
  '[{"ingredient_id":"18900000-0000-0000-0000-000000000102","actual_remaining":null,"actual_remaining_cases":null,"actual_remaining_each":null,"no_need":true,"notes":"plenty"},
    {"ingredient_id":"18900000-0000-0000-0000-000000000103","actual_remaining":null,"no_need":false,"notes":""},
    {"ingredient_id":"18900000-0000-0000-0000-000000000105","actual_remaining":26.5,"actual_remaining_cases":4,"actual_remaining_each":2.5,"no_need":false,"notes":"n1"},
    {"ingredient_id":"18900000-0000-0000-0000-000000000107","actual_remaining":99,"no_need":false,"notes":""}]'::jsonb,
  '{}'::uuid[])::text, true);
reset role;
select set_config('request.jwt.claims', '', true);

select set_config('test.sub_d5', current_setting('test.r_d5', true)::jsonb ->> 'submission_id', true);

select is(
  (select format('%s|%s|%s|%s|%s', actual_remaining, actual_remaining_cases, actual_remaining_each, notes, no_need)
     from public.eod_entries
    where submission_id = current_setting('test.sub_d5', true)::uuid
      and item_id = '18900000-0000-0000-0000-000000000105'),
  '26.500|4|2.5|n1|f',
  '(48) AC-5: a numeric row stores actual_remaining, the splits, notes and no_need as sent');

select is(
  (select format('%s|%s|%s|%s|%s', actual_remaining, actual_remaining_cases, actual_remaining_each, notes, no_need)
     from public.eod_entries
    where submission_id = current_setting('test.sub_d5', true)::uuid
      and item_id = '18900000-0000-0000-0000-000000000102'),
  '|||plenty|t',
  '(49) AC-5 / AC-10: a NO NEED row stores NULL numerics, its note and no_need = true');

select is(
  (select format('%s/%s', current_stock, eod_remaining)
     from public.inventory_items where id = '18900000-0000-0000-0000-000000000105'),
  '26.500/26.500',
  '(50) AC-8: the numeric linked entry writes the on-hand to the total');

select is(
  (select string_agg(right(id::text, 3) || ':' || current_stock || '/' || eod_remaining, ',' order by id)
     from public.inventory_items
    where id in ('18900000-0000-0000-0000-000000000102',
                 '18900000-0000-0000-0000-000000000103',
                 '18900000-0000-0000-0000-000000000107')),
  current_setting('test.d5_before', true),
  '(51) AC-9 / AC-10: NO NEED, NULL-total and off-vendor entries leave on-hand untouched');

select is(
  (select actual_remaining from public.eod_entries
    where submission_id = current_setting('test.sub_d5', true)::uuid
      and item_id = '18900000-0000-0000-0000-000000000107'),
  99.000::numeric,
  '(52) AC-9: the off-vendor entry is still stored');

select is(
  (select array_agg(right(x->>'ingredient_id', 3) order by x->>'ingredient_id')
     from jsonb_array_elements(current_setting('test.r_d5', true)::jsonb -> 'stock_updates') x),
  array['105', '107']::text[],
  '(53) stock_updates omits NO NEED and NULL-total entries (off-vendor stays, as before)');


-- ═══ AT — AC-11..AC-14 all-or-nothing and refusals (on D1) ════════
-- Seed an old literal submitted_at so "unchanged" can fail (now() is constant
-- per transaction). As postgres, no claims: no notification, submitted_by → NULL.
update public.eod_submissions
   set submitted_at = timestamptz '2000-01-01 12:00:00+00'
 where id = current_setting('test.sub_d1', true)::uuid;

select set_config('test.state_d1', pg_temp.state_of(current_setting('test.sub_d1', true)::uuid), true);

set local role authenticated;
select set_config('request.jwt.claims', current_setting('test.claims_admin', true), true);

select throws_ok(
  $q$select public.admin_submit_eod(
       '18900000-0000-0000-0000-0000000000a1'::uuid, date '1999-12-01',
       '18900000-0000-0000-0000-0000000000f1'::uuid, 'submitted',
       '[{"ingredient_id":"18900000-0000-0000-0000-000000000101","actual_remaining":77},
         {"ingredient_id":"18900000-0000-0000-0000-000000000102","actual_remaining":5,"no_need":true}]'::jsonb,
       array['18900000-0000-0000-0000-000000000103']::uuid[])$q$,
  '23514', null,
  '(54) AC-11: a re-submit whose last entry is NO NEED with a quantity raises 23514');

reset role;
select set_config('request.jwt.claims', '', true);
select is(pg_temp.state_of(current_setting('test.sub_d1', true)::uuid), current_setting('test.state_d1', true),
  '(55) AC-11: entries, parent status/submitted_at/submitted_by, S1 on-hand row by row, notifications and audit are all unchanged');

set local role authenticated;
select set_config('request.jwt.claims', current_setting('test.claims_admin', true), true);
select throws_ok(
  $q$select public.admin_submit_eod(
       '18900000-0000-0000-0000-0000000000a1'::uuid, date '1999-12-01',
       '18900000-0000-0000-0000-0000000000f1'::uuid, 'submitted',
       '[{"ingredient_id":"18900000-0000-0000-0000-000000000101","actual_remaining":77},
         {"ingredient_id":"18900000-0000-0000-0000-000000000201","actual_remaining":1}]'::jsonb,
       '{}'::uuid[])$q$,
  '42501', 'eod_entries: item store mismatch with parent submission',
  '(56) AC-12: a cross-store item raises 42501');
reset role;
select set_config('request.jwt.claims', '', true);
select is(pg_temp.state_of(current_setting('test.sub_d1', true)::uuid), current_setting('test.state_d1', true),
  '(57) AC-12: state unchanged after the cross-store refusal');

-- AC-13: role 'user' store member.
set local role authenticated;
select set_config('request.jwt.claims', current_setting('test.claims_user', true), true);
select throws_ok(
  $q$select public.admin_submit_eod(
       '18900000-0000-0000-0000-0000000000a1'::uuid, date '1999-12-01',
       '18900000-0000-0000-0000-0000000000f1'::uuid, 'submitted',
       '[{"ingredient_id":"18900000-0000-0000-0000-000000000101","actual_remaining":77}]'::jsonb,
       '{}'::uuid[])$q$,
  '42501', 'admin_submit_eod: caller cannot write EOD counts for store 18900000-0000-0000-0000-0000000000a1',
  '(58) AC-13: a non-privileged store member is refused with 42501');
reset role;
select set_config('request.jwt.claims', '', true);
select is(pg_temp.state_of(current_setting('test.sub_d1', true)::uuid), current_setting('test.state_d1', true),
  '(59) AC-13: state unchanged after the non-privileged refusal');

-- AC-14: privileged, but the store is in another brand.
set local role authenticated;
select set_config('request.jwt.claims', current_setting('test.claims_admin', true), true);
select throws_ok(
  $q$select public.admin_submit_eod(
       '18900000-0000-0000-0000-0000000000b1'::uuid, date '1999-12-01',
       '18900000-0000-0000-0000-0000000000f2'::uuid, 'submitted',
       '[{"ingredient_id":"18900000-0000-0000-0000-000000000101","actual_remaining":77}]'::jsonb,
       '{}'::uuid[])$q$,
  '42501', 'admin_submit_eod: caller cannot write EOD counts for store 18900000-0000-0000-0000-0000000000b1',
  '(60) AC-14: a privileged caller who can''t see the store is refused with 42501');

-- Vendor outside the store's brand (§3.1).
select throws_ok(
  $q$select public.admin_submit_eod(
       '18900000-0000-0000-0000-0000000000a1'::uuid, date '1999-12-01',
       '18900000-0000-0000-0000-0000000000f2'::uuid, 'submitted',
       '[{"ingredient_id":"18900000-0000-0000-0000-000000000101","actual_remaining":77}]'::jsonb,
       '{}'::uuid[])$q$,
  '42501', 'admin_submit_eod: vendor 18900000-0000-0000-0000-0000000000f2 is not in the brand of store 18900000-0000-0000-0000-0000000000a1',
  '(61) §3.1: a vendor from another brand is refused with 42501');

select throws_ok(
  $q$select public.admin_submit_eod(
       '18900000-0000-0000-0000-0000000000a1'::uuid, date '1999-12-01',
       null, 'submitted',
       '[{"ingredient_id":"18900000-0000-0000-0000-000000000101","actual_remaining":77}]'::jsonb,
       '{}'::uuid[])$q$,
  '22023', 'admin_submit_eod: vendor_id is required',
  '(62) §3.1: a NULL vendor is refused with 22023');

select throws_ok(
  $q$select public.admin_submit_eod(
       '18900000-0000-0000-0000-0000000000a1'::uuid, date '1999-12-01',
       '18900000-0000-0000-0000-0000000000f1'::uuid, 'final',
       '[{"ingredient_id":"18900000-0000-0000-0000-000000000101","actual_remaining":77}]'::jsonb,
       '{}'::uuid[])$q$,
  '22023', 'admin_submit_eod: status must be draft or submitted',
  '(63) §3.1: a status other than draft/submitted is refused with 22023');

select throws_ok(
  $q$select public.admin_submit_eod(
       '18900000-0000-0000-0000-0000000000a1'::uuid, date '1999-12-01',
       '18900000-0000-0000-0000-0000000000f1'::uuid, 'submitted',
       '[{"ingredient_id":"18900000-0000-0000-0000-000000000101","actual_remaining":77}]'::jsonb,
       array['18900000-0000-0000-0000-000000000101']::uuid[])$q$,
  '22023', 'admin_submit_eod: an item is in both p_entries and p_removed_item_ids',
  '(64) §3.1: an item in both p_entries and the removal list is refused with 22023');
reset role;
select set_config('request.jwt.claims', '', true);

-- (60)-(64) leave everything alone too: one combined check, plus SB never got a row.
select is(
  pg_temp.state_of(current_setting('test.sub_d1', true)::uuid)
    || ' | SB rows: '
    || (select count(*) from public.eod_submissions where store_id = '18900000-0000-0000-0000-0000000000b1'),
  current_setting('test.state_d1', true) || ' | SB rows: 0',
  '(65) AC-14 and §3.1: state unchanged after every refusal, and no row for the foreign store');


-- ═══ UQ — AC-27 the unique index ═════════════════════════════════
select throws_ok(
  format($q$insert into public.eod_entries (submission_id, item_id, actual_remaining)
            values (%L::uuid, '18900000-0000-0000-0000-000000000101'::uuid, 3)$q$,
         current_setting('test.sub_d1', true)),
  '23505', null,
  '(66) AC-27: a second row for the same (submission_id, item_id) raises 23505 through the table');

set local role authenticated;
select set_config('request.jwt.claims', current_setting('test.claims_admin', true), true);
select throws_ok(
  $q$select public.admin_submit_eod(
       '18900000-0000-0000-0000-0000000000a1'::uuid, date '1999-12-01',
       '18900000-0000-0000-0000-0000000000f1'::uuid, 'submitted',
       '[{"ingredient_id":"18900000-0000-0000-0000-000000000101","actual_remaining":3},
         {"ingredient_id":"18900000-0000-0000-0000-000000000101","actual_remaining":4}]'::jsonb,
       '{}'::uuid[])$q$,
  '23505', null,
  '(67) AC-27: a payload repeating an item raises 23505 through the writer');

select lives_ok(
  $q$select public.admin_submit_eod(
       '18900000-0000-0000-0000-0000000000a1'::uuid, date '1999-12-01',
       '18900000-0000-0000-0000-0000000000f1'::uuid, 'submitted',
       '[{"ingredient_id":"18900000-0000-0000-0000-000000000101","actual_remaining":19}]'::jsonb,
       '{}'::uuid[])$q$,
  '(68) AC-27: a re-submit of an existing pair still succeeds');
reset role;
select set_config('request.jwt.claims', '', true);

select is(
  pg_temp.entries_of(current_setting('test.sub_d1', true)::uuid),
  '101=19,102=20',
  '(69) AC-27: after the re-submit, one row per item');


-- ═══ EM — AC-33 empty calls on a 200-day-old submission ══════════
set local role authenticated;
select set_config('request.jwt.claims', current_setting('test.claims_admin', true), true);
select set_config('test.sub_old', (public.admin_submit_eod(
  '18900000-0000-0000-0000-0000000000a1'::uuid, current_date - 200,
  '18900000-0000-0000-0000-0000000000f1'::uuid, 'submitted',
  '[{"ingredient_id":"18900000-0000-0000-0000-000000000101","actual_remaining":1},
    {"ingredient_id":"18900000-0000-0000-0000-000000000102","actual_remaining":2},
    {"ingredient_id":"18900000-0000-0000-0000-000000000103","actual_remaining":3}]'::jsonb,
  '{}'::uuid[]) ->> 'submission_id'), true);
reset role;
select set_config('request.jwt.claims', '', true);

update public.eod_submissions
   set submitted_at = timestamptz '2000-01-01 12:00:00+00'
 where id = current_setting('test.sub_old', true)::uuid;

select set_config('test.state_old', pg_temp.state_of(current_setting('test.sub_old', true)::uuid), true);

set local role authenticated;
select set_config('request.jwt.claims', current_setting('test.claims_admin', true), true);
select throws_ok(
  format($q$select public.admin_submit_eod(
       '18900000-0000-0000-0000-0000000000a1'::uuid, %L::date,
       '18900000-0000-0000-0000-0000000000f1'::uuid, 'submitted', '[]'::jsonb, null)$q$,
       current_date - 200),
  '22023', 'admin_submit_eod: nothing to write (no entries and no removals)',
  '(70) AC-33: empty p_entries and no removals raises 22023');

select throws_ok(
  format($q$select public.admin_submit_eod(
       '18900000-0000-0000-0000-0000000000a1'::uuid, %L::date,
       '18900000-0000-0000-0000-0000000000f1'::uuid, 'submitted', null, '{}'::uuid[])$q$,
       current_date - 200),
  '22023', 'admin_submit_eod: nothing to write (no entries and no removals)',
  '(71) AC-33: NULL p_entries and an empty removal list raises 22023');

select throws_ok(
  format($q$select public.admin_submit_eod(
       '18900000-0000-0000-0000-0000000000a1'::uuid, %L::date,
       '18900000-0000-0000-0000-0000000000f1'::uuid, 'submitted', '{}'::jsonb, '{}'::uuid[])$q$,
       current_date - 200),
  '22023', 'admin_submit_eod: p_entries must be a JSON array',
  '(72) a non-array p_entries raises 22023');

select throws_ok(
  format($q$select public.admin_submit_eod(
       '18900000-0000-0000-0000-0000000000a1'::uuid, %L::date,
       '18900000-0000-0000-0000-0000000000f1'::uuid, 'submitted', '[]'::jsonb,
       array['18900000-0000-0000-0000-000000000101',
             '18900000-0000-0000-0000-000000000102',
             '18900000-0000-0000-0000-000000000103']::uuid[])$q$,
       current_date - 200),
  '22023', 'admin_submit_eod: a submission cannot be left with no entries',
  '(73) AC-33 rule B: naming every row in the removal list raises 22023');
reset role;
select set_config('request.jwt.claims', '', true);

select is(pg_temp.state_of(current_setting('test.sub_old', true)::uuid), current_setting('test.state_old', true),
  '(74) AC-33: entries and submitted_at unchanged after all four refusals (read back as postgres)');

set local role authenticated;
select set_config('request.jwt.claims', current_setting('test.claims_admin', true), true);
select lives_ok(
  format($q$select public.admin_submit_eod(
       '18900000-0000-0000-0000-0000000000a1'::uuid, %L::date,
       '18900000-0000-0000-0000-0000000000f1'::uuid, 'submitted', '[]'::jsonb,
       array['18900000-0000-0000-0000-000000000102']::uuid[])$q$,
       current_date - 200),
  '(75) AC-33: a blank-only correction (no entries, one removal) succeeds');
reset role;
select set_config('request.jwt.claims', '', true);

select is(
  pg_temp.entries_of(current_setting('test.sub_old', true)::uuid),
  '101=1,103=3',
  '(76) AC-33: the blank-only correction removes only that row');


-- ═══ O1 — AC-34 staff empty payloads (on D3) ═════════════════════
select set_config('test.state_d3', pg_temp.state_of(current_setting('test.sub_d3', true)::uuid), true);

set local role authenticated;
select set_config('request.jwt.claims', current_setting('test.claims_user', true), true);
select throws_ok(
  $q$select public.staff_submit_eod(
       '18900000-0000-0000-0000-0000000cc0e1'::uuid, '18900000-0000-0000-0000-0000000000a1'::uuid,
       date '1999-12-03', null, 'submitted', '[]'::jsonb,
       '18900000-0000-0000-0000-0000000000f1'::uuid)$q$,
  '22023', 'staff_submit_eod: p_entries must be a non-empty array',
  '(77) AC-34: staff_submit_eod with ''[]'' raises 22023');

select throws_ok(
  $q$select public.staff_submit_eod(
       '18900000-0000-0000-0000-0000000cc0e2'::uuid, '18900000-0000-0000-0000-0000000000a1'::uuid,
       date '1999-12-03', null, 'submitted', null,
       '18900000-0000-0000-0000-0000000000f1'::uuid)$q$,
  '22023', 'staff_submit_eod: p_entries must be a non-empty array',
  '(78) AC-34: staff_submit_eod with NULL raises 22023');

select throws_ok(
  $q$select public.staff_submit_eod(
       '18900000-0000-0000-0000-0000000cc0e3'::uuid, '18900000-0000-0000-0000-0000000000a1'::uuid,
       date '1999-12-03', null, 'submitted', '{}'::jsonb,
       '18900000-0000-0000-0000-0000000000f1'::uuid)$q$,
  '22023', 'staff_submit_eod: p_entries must be a non-empty array',
  '(79) O-1: staff_submit_eod with a non-array raises 22023');

select set_config('test.r_replay_empty', public.staff_submit_eod(
  '18900000-0000-0000-0000-0000000cc001'::uuid, '18900000-0000-0000-0000-0000000000a1'::uuid,
  date '1999-12-03', null, 'submitted', '[]'::jsonb,
  '18900000-0000-0000-0000-0000000000f1'::uuid)::text, true);
reset role;
select set_config('request.jwt.claims', '', true);

select is(pg_temp.state_of(current_setting('test.sub_d3', true)::uuid), current_setting('test.state_d3', true),
  '(80) AC-34: state unchanged after the staff empty refusals and the replay');

select is(
  current_setting('test.r_replay_empty', true)::jsonb ->> 'conflict',
  'true',
  '(81) AC-34: a replay of a processed uuid with ''[]'' still returns conflict: true');


-- ═══ N — AC-26 notifications through the real writer (VN) ═════════
-- VN has no item_vendors links, so the fresh branch is 'eod' and no on-hand
-- is written for I1 (off-vendor for VN).
set local role authenticated;
select set_config('request.jwt.claims', current_setting('test.claims_admin', true), true);
select set_config('test.sub_n1', (public.admin_submit_eod(
  '18900000-0000-0000-0000-0000000000a1'::uuid, date '1999-12-06',
  '18900000-0000-0000-0000-0000000000f3'::uuid, 'submitted',
  '[{"ingredient_id":"18900000-0000-0000-0000-000000000101","actual_remaining":1}]'::jsonb,
  '{}'::uuid[]) ->> 'submission_id'), true);
reset role;
select set_config('request.jwt.claims', '', true);

select is(
  (select format('%s/%s',
     count(*) filter (where n.type in ('eod', 'order_ready') and n.source_id = current_setting('test.sub_n1', true)::uuid),
     count(*) filter (where n.type = 'eod_update' and n.submission_id = current_setting('test.sub_n1', true)::uuid))
     from public.notifications n),
  '1/0',
  '(82) AC-26: a first submit gives one fresh eod/order_ready row and no eod_update');

set local role authenticated;
select set_config('request.jwt.claims', current_setting('test.claims_admin', true), true);
select public.admin_submit_eod(
  '18900000-0000-0000-0000-0000000000a1'::uuid, date '1999-12-06',
  '18900000-0000-0000-0000-0000000000f3'::uuid, 'submitted',
  '[{"ingredient_id":"18900000-0000-0000-0000-000000000101","actual_remaining":2}]'::jsonb,
  '{}'::uuid[]);
select set_config('test.sub_n2', (public.admin_submit_eod(
  '18900000-0000-0000-0000-0000000000a1'::uuid, date '1999-12-07',
  '18900000-0000-0000-0000-0000000000f3'::uuid, 'draft',
  '[{"ingredient_id":"18900000-0000-0000-0000-000000000101","actual_remaining":1}]'::jsonb,
  '{}'::uuid[]) ->> 'submission_id'), true);
reset role;
select set_config('request.jwt.claims', '', true);

select is(
  (select format('%s/%s',
     count(*) filter (where n.type in ('eod', 'order_ready') and n.source_id = current_setting('test.sub_n1', true)::uuid),
     count(*) filter (where n.type = 'eod_update' and n.submission_id = current_setting('test.sub_n1', true)::uuid))
     from public.notifications n),
  '1/1',
  '(83) AC-26: an edit gives exactly one eod_update and no second fresh row');

select is(
  (select count(*)::int from public.notifications n
    where coalesce(n.submission_id, n.source_id) = current_setting('test.sub_n2', true)::uuid),
  0,
  '(84) AC-26: a draft save gives no notification row');

set local role authenticated;
select set_config('request.jwt.claims', current_setting('test.claims_admin', true), true);
select public.admin_submit_eod(
  '18900000-0000-0000-0000-0000000000a1'::uuid, date '1999-12-07',
  '18900000-0000-0000-0000-0000000000f3'::uuid, 'submitted',
  '[{"ingredient_id":"18900000-0000-0000-0000-000000000101","actual_remaining":1}]'::jsonb,
  '{}'::uuid[]);
reset role;
select set_config('request.jwt.claims', '', true);

select is(
  (select format('%s/%s',
     count(*) filter (where n.type in ('eod', 'order_ready') and n.source_id = current_setting('test.sub_n2', true)::uuid),
     count(*) filter (where n.type = 'eod_update' and n.submission_id = current_setting('test.sub_n2', true)::uuid))
     from public.notifications n),
  '1/0',
  '(85) AC-26: draft → submitted gives exactly one fresh row and no eod_update');


-- ═══ RD — AC-17/18/19 readers: re-submitted (SR) vs control (SC) ══
-- Prior anchor 1999-12-09 counts 10 in both stores. On 1999-12-10 SR counts
-- 20 and is corrected to 1; SC counts 1 once. Same catalog, cost, par, link.
set local role authenticated;
select set_config('request.jwt.claims', current_setting('test.claims_admin', true), true);
select public.admin_submit_eod('18900000-0000-0000-0000-0000000000a3'::uuid, date '1999-12-09',
  '18900000-0000-0000-0000-0000000000f1'::uuid, 'submitted',
  '[{"ingredient_id":"18900000-0000-0000-0000-000000000301","actual_remaining":10}]'::jsonb, '{}'::uuid[]);
select public.admin_submit_eod('18900000-0000-0000-0000-0000000000a4'::uuid, date '1999-12-09',
  '18900000-0000-0000-0000-0000000000f1'::uuid, 'submitted',
  '[{"ingredient_id":"18900000-0000-0000-0000-000000000401","actual_remaining":10}]'::jsonb, '{}'::uuid[]);
select public.admin_submit_eod('18900000-0000-0000-0000-0000000000a3'::uuid, date '1999-12-10',
  '18900000-0000-0000-0000-0000000000f1'::uuid, 'submitted',
  '[{"ingredient_id":"18900000-0000-0000-0000-000000000301","actual_remaining":20}]'::jsonb, '{}'::uuid[]);
select public.admin_submit_eod('18900000-0000-0000-0000-0000000000a3'::uuid, date '1999-12-10',
  '18900000-0000-0000-0000-0000000000f1'::uuid, 'submitted',
  '[{"ingredient_id":"18900000-0000-0000-0000-000000000301","actual_remaining":1}]'::jsonb, '{}'::uuid[]);
select public.admin_submit_eod('18900000-0000-0000-0000-0000000000a4'::uuid, date '1999-12-10',
  '18900000-0000-0000-0000-0000000000f1'::uuid, 'submitted',
  '[{"ingredient_id":"18900000-0000-0000-0000-000000000401","actual_remaining":1}]'::jsonb, '{}'::uuid[]);

select set_config('test.var_sr', public.report_run_variance('18900000-0000-0000-0000-0000000000a3'::uuid,
  '{"from":"1999-12-09","to":"1999-12-10"}'::jsonb)::text, true);
select set_config('test.var_sc', public.report_run_variance('18900000-0000-0000-0000-0000000000a4'::uuid,
  '{"from":"1999-12-09","to":"1999-12-10"}'::jsonb)::text, true);
select set_config('test.ro_sr', public.report_reorder_list('18900000-0000-0000-0000-0000000000a3'::uuid,
  '{"as_of_date":"1999-12-10"}'::jsonb)::text, true);
select set_config('test.ro_sc', public.report_reorder_list('18900000-0000-0000-0000-0000000000a4'::uuid,
  '{"as_of_date":"1999-12-10"}'::jsonb)::text, true);
select set_config('test.ls_sr', public.report_weekly_lowstock('18900000-0000-0000-0000-0000000000a3'::uuid,
  '{"as_of_date":"1999-12-10"}'::jsonb)::text, true);
reset role;
select set_config('request.jwt.claims', '', true);

select is(
  (select r->>'counted' from jsonb_array_elements(current_setting('test.var_sr', true)::jsonb -> 'rows') r),
  '1.000',
  '(86) AC-17: report_run_variance shows counted 1 after the correction');

select is(
  (select k->>'value' from jsonb_array_elements(current_setting('test.var_sr', true)::jsonb -> 'kpis') k
    where k->>'label' = 'Net $ impact'),
  (select k->>'value' from jsonb_array_elements(current_setting('test.var_sc', true)::jsonb -> 'kpis') k
    where k->>'label' = 'Net $ impact'),
  '(87) AC-17: the net $ impact matches the control');

select is(
  (select k->>'value' from jsonb_array_elements(current_setting('test.var_sr', true)::jsonb -> 'kpis') k
    where k->>'label' = 'Net $ impact'),
  '-$22.50',
  '(88) AC-17: the net is negative (1 − 10 = −9 × $2.50), not the stacked sign flip');

select is(
  (select count(*)::int
     from jsonb_array_elements(current_setting('test.ro_sr', true)::jsonb -> 'vendors') v,
          jsonb_array_elements(v -> 'items') i
    where i->>'item_id' = '18900000-0000-0000-0000-000000000301'),
  1,
  '(89) AC-18: report_reorder_list shows one row for the item');

select is(
  (select (i->>'suggested_qty')::numeric
     from jsonb_array_elements(current_setting('test.ro_sr', true)::jsonb -> 'vendors') v,
          jsonb_array_elements(v -> 'items') i
    where i->>'item_id' = '18900000-0000-0000-0000-000000000301'),
  (select (i->>'suggested_qty')::numeric
     from jsonb_array_elements(current_setting('test.ro_sc', true)::jsonb -> 'vendors') v,
          jsonb_array_elements(v -> 'items') i
    where i->>'item_id' = '18900000-0000-0000-0000-000000000401'),
  '(90) AC-18: suggested_qty matches the control');

select is(
  (select (i->>'suggested_qty')::numeric
     from jsonb_array_elements(current_setting('test.ro_sr', true)::jsonb -> 'vendors') v,
          jsonb_array_elements(v -> 'items') i
    where i->>'item_id' = '18900000-0000-0000-0000-000000000301'),
  4::numeric,
  '(91) AC-18: suggested_qty = par 5 − on-hand 1');

select is(
  current_setting('test.ro_sr', true)::jsonb -> 'kpis' ->> 'item_count',
  current_setting('test.ro_sc', true)::jsonb -> 'kpis' ->> 'item_count',
  '(92) AC-18: kpis.item_count matches the control');

select is(
  (current_setting('test.ro_sr', true)::jsonb -> 'kpis' ->> 'total_estimated_cost')::numeric,
  (current_setting('test.ro_sc', true)::jsonb -> 'kpis' ->> 'total_estimated_cost')::numeric,
  '(93) AC-18: the estimate (kpis.total_estimated_cost) matches the control');

select is(
  (select (i->>'on_hand')::numeric
     from jsonb_array_elements(current_setting('test.ls_sr', true)::jsonb -> 'items') i
    where i->>'item_id' = '18900000-0000-0000-0000-000000000301'),
  1::numeric,
  '(94) AC-19: report_weekly_lowstock shows on_hand 1');

select is(
  (select count(*)::int from public.eod_entries e
     join public.eod_submissions s on s.id = e.submission_id
    where s.store_id = '18900000-0000-0000-0000-0000000000a3'
      and s.date = date '1999-12-10'),
  1,
  '(95) AC-17..19: the re-submitted reader fixture holds one entry (read back as postgres)');

-- AC-24: the admin path writes no per-entry server row. SR and SC only ever
-- get admin calls with no removals, so they hold no 'EOD entry' row at all.
-- No user_id filter: the writer's per-entry branch inserts user_id = NULL, so
-- a filter on the admin's id could never see the doubled-audit regression
-- (architect S1).
select is(
  (select count(*)::int from public.audit_log
    where store_id in ('18900000-0000-0000-0000-0000000000a3', '18900000-0000-0000-0000-0000000000a4')
      and action = 'EOD entry'),
  0,
  '(96) AC-24: the admin path writes no per-entry server audit row (the client writes it)');


-- ═══ NR — AC-33 removal-only calls that remove nothing (on the old sub) ═
-- Security L1 / architect N3. sub_old holds 101=1,103=3 after (75). Re-seed a
-- literal submitted_at so "unchanged" can fail (75 set it to the constant
-- now()). Each call sends 'draft' so a status flip would show in state_of.
-- Item 102 has no row here (cleared in 75) but does have one in D1.
update public.eod_submissions
   set submitted_at = timestamptz '2000-01-02 12:00:00+00'
 where id = current_setting('test.sub_old', true)::uuid;

select set_config('test.state_old_nr', pg_temp.state_of(current_setting('test.sub_old', true)::uuid), true);
select set_config('test.entries_d1_nr', pg_temp.entries_of(current_setting('test.sub_d1', true)::uuid), true);

set local role authenticated;
select set_config('request.jwt.claims', current_setting('test.claims_admin', true), true);
select throws_ok(
  format($q$select public.admin_submit_eod(
       '18900000-0000-0000-0000-0000000000a1'::uuid, %L::date,
       '18900000-0000-0000-0000-0000000000f1'::uuid, 'draft', '[]'::jsonb,
       '{NULL}'::uuid[])$q$,
       current_date - 200),
  '22023', 'admin_submit_eod: p_removed_item_ids must not contain NULL',
  '(97) L1: a removal list of ''{NULL}'' raises 22023');

select throws_ok(
  format($q$select public.admin_submit_eod(
       '18900000-0000-0000-0000-0000000000a1'::uuid, %L::date,
       '18900000-0000-0000-0000-0000000000f1'::uuid, 'draft', '[]'::jsonb,
       array['18900000-0000-0000-0000-00000000dead']::uuid[])$q$,
       current_date - 200),
  '22023', 'admin_submit_eod: nothing to write (no entries, and no removal names a row in this submission)',
  '(98) L1: a removal-only call naming an id with no row anywhere raises 22023');

select throws_ok(
  format($q$select public.admin_submit_eod(
       '18900000-0000-0000-0000-0000000000a1'::uuid, %L::date,
       '18900000-0000-0000-0000-0000000000f1'::uuid, 'draft', '[]'::jsonb,
       array['18900000-0000-0000-0000-000000000102']::uuid[])$q$,
       current_date - 200),
  '22023', 'admin_submit_eod: nothing to write (no entries, and no removal names a row in this submission)',
  '(99) L1: a removal-only call naming an item whose row is in another submission raises 22023');
reset role;
select set_config('request.jwt.claims', '', true);

select is(pg_temp.state_of(current_setting('test.sub_old', true)::uuid), current_setting('test.state_old_nr', true),
  '(100) L1: entries, status, submitted_at, notifications and S1 audit unchanged after (97)-(99) (read back as postgres)');

select is(pg_temp.entries_of(current_setting('test.sub_d1', true)::uuid), current_setting('test.entries_d1_nr', true),
  '(101) L1: the other submission''s row for that item is untouched');

select * from finish();
rollback;
