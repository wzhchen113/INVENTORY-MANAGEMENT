-- supabase/tests/order_approvals_approver_snapshot.test.sql
--
-- Spec 187 — order_approvals keeps the approver's name, email and id after their
-- profile is deleted, a row with no approver can't be approved, the approver
-- follows the lines while pending, only the approver may change a pending row,
-- and public.profiles has no DELETE policy.
-- Shipped in supabase/migrations/20261108130000_order_approval_approver_snapshot.sql.
--
-- Plan (76 arms), by acceptance criterion. "The snapshot" is approved_by_name,
-- approved_by_email and approved_by_id. _t187_view pins all three.
--   SNAPSHOT
--     AC-1          the RPC stores the caller's real name, email and id.
--     AC-2 (a, b)   a direct INSERT with a forged / empty snapshot stores the real
--                   values. (c) naming someone else as approver is still 42501.
--     AC-2d         a blank profiles.name falls back to the email, on a direct
--                   INSERT and through the RPC.
--     AC-3          NULL approved_by stores NULL in all three columns, whatever is
--                   supplied.
--     AC-4 (a-e)    a hand edit of any snapshot column is refused at every status,
--                   on a NULL-approver row, and as postgres. (f) the rows are unchanged.
--     AC-5 (a-c)    deleting the profile (as postgres, and as postgres with another
--                   admin's claims) and deleting the auth.users row each NULL approved_by
--                   and leave the snapshot (id included) and approved_at, at all three
--                   statuses.
--     AC-6          renaming the approver doesn't touch the snapshot.
--     AC-7 (a-f)    posture of the two definer functions, no EXECUTE for API roles,
--                   the trigger's type and enabled state, the RPC is still INVOKER.
--     AC-7g         approved_by_id is a nullable uuid with no foreign key.
--   RE-STAMP
--     AC-8          B's RPC call on A's pending row: approver, snapshot, lines all B's,
--                   approved_at moved.
--     AC-8a         a retry by the same approver refreshes the lines and leaves
--                   approved_at and the snapshot, even after a rename.
--     AC-8b         a re-stamp by a caller with a blank name stores the email as name.
--     AC-8c         a re-stamp by a caller with a padded name stores it trimmed.
--     AC-9          AC-8 through the race branch (t149_race_hide_once pattern).
--     AC-10a2, AC-10b2, AC-10c, AC-10d  approved_by to someone else or NULL refused
--                   while pending; to the caller refused once the row has left pending.
--     AC-10a        forged values in the re-stamp UPDATE lose to the real ones and now().
--     AC-10b, AC-10b3  re-pointing refused as postgres and as service_role with no claims.
--     AC-11 (a-c)   a direct update of approved_at is refused at every status.
--     AC-12 (a, b)  the RPC on an approved / ordered row, as another admin, writes nothing.
--   A ROW WITH NO APPROVER
--     AC-13         pending -> approved is refused with an admin's JWT.
--     AC-14 (a, b)  approved -> ordered and the external_ref re-mint write succeed.
--     AC-15 (a, b)  recovery: another admin's RPC call stamps them, then the row approves.
--   DIRECT PROFILE DELETES
--     AC-16         no DELETE or ALL policy on public.profiles.
--     AC-17 (a-d)   same-brand, cross-brand and super_admin self deletes remove 0 rows
--                   with no error; the rows and their approvals are untouched.
--     AC-18         as postgres with an admin's claims, self-delete still raises.
--   STAFF
--     S-1, S-2      a store-linked staff user can't read the snapshot or use the RPC.
--   WHO MAY CHANGE A PENDING ROW (amendment A1, audit 187-H1 and 187-H2)
--     AC-32a        each listed column, changed alone by another admin on A's pending
--                   row, is refused with 'belongs to another approver'.
--     AC-32b        and the row is unchanged.
--     AC-33         the same change on a row with no approver: 'has no approver'.
--     AC-34a        the approver's own channel fallback and advance with external_ref.
--     AC-34b        postgres and service_role with no claims are not subject to it.
--     AC-34c        another admin's re-mint on an approved row still passes.
--     AC-36         after B re-stamps, A's late Instacart-shaped write-back is refused.
--     AC-35 (a-e, h-j)  a JWT 'admin' claim on a 'user' profile (same brand, and NULL
--                   brand with a store link) can't re-stamp (RPC or PATCH), approve its
--                   own row or change lines on someone else's. Each route runs for both.
--                   The NULL-brand RPC (AC-35j) is refused earlier, with P0002.
--     AC-35 (f, g)  a master and a super_admin profile can create and approve.
--     AC-37a        a stale claim's RPC insert is refused (release re-proposal M-R1).
--     AC-37b        known gap until the auth_is_admin() / auth_is_privileged()
--                   convergence spec (named in spec 191, not yet filed): a stale claim
--                   can still move an approved row to ordered.
--   WHO MAY INSERT (release re-proposal M-R1)
--     AC-38a, AC-38b  a stale claim's direct INSERT at pending, approved and ordered is
--                   refused, for both profile shapes, and no row is created.
--     AC-38c        a real admin's direct INSERT at approved and at ordered is refused.
--     AC-38d        postgres and service_role with no claims can still insert approved
--                   and ordered rows, and the stamp still fills the snapshot.
--
-- AC-19 (the flipped arms) lives in profiles_rls_sweep.test.sql and
-- auth_can_see_store_brand_scope.test.sql. AC-20 to AC-22 live in
-- audit_log_rls_hardening.test.sql.
--
-- Fixtures: rows are written as postgres with approved_at one hour back, so
-- "approved_at moved" is observable inside one transaction, where now() is
-- constant. A row is addressed by its day number (business_date =
-- 2026-01-01 + day), which also works for rows the RPC creates. Caller actions run
-- under `set local role` and record their outcome into a setting, and every
-- assertion runs as postgres, so an RLS-clipped read can't pass an arm by accident.
--
-- Hermetic: begin; … rollback;. Every fixture and helper is created inside the
-- transaction, so the file is green under the committed seed AND on a CI-fresh
-- database.

begin;
create extension if not exists pgtap;

select plan(76);

-- ─── fixtures ──────────────────────────────────────────────────
insert into public.brands (id, name) values
  ('b1870000-0000-0000-0000-000000000001', 'Snapshot Brand (test 187)'),
  ('b1870000-0000-0000-0000-000000000002', 'Foreign Brand (test 187)');

insert into public.stores (id, brand_id, name, address, status, eod_deadline_time)
values ('b1870001-0000-0000-0000-000000000001', 'b1870000-0000-0000-0000-000000000001',
        'Store (test 187)', '1 Test Way', 'active', '22:00');

insert into public.vendors (id, name, brand_id)
values ('b1870002-0000-0000-0000-000000000001', '__oa187_vendor__',
        'b1870000-0000-0000-0000-000000000001');

insert into public.catalog_ingredients (id, brand_id, name, unit)
values ('b1870005-0000-0000-0000-000000000001', 'b1870000-0000-0000-0000-000000000001',
        '__oa187_cat__', 'each');

insert into public.inventory_items (id, store_id, catalog_id)
values ('b1870006-0000-0000-0000-000000000001', 'b1870001-0000-0000-0000-000000000001',
        'b1870005-0000-0000-0000-000000000001');

-- People, keyed by the last two hex digits of their id. 0a to 0f are brand admins.
create temp table _t187_people (tag text, role text, brand uuid) on commit drop;
insert into _t187_people values
  ('0a', 'admin',       'b1870000-0000-0000-0000-000000000001'),  -- A
  ('0b', 'admin',       'b1870000-0000-0000-0000-000000000001'),  -- B
  ('0c', 'admin',       'b1870000-0000-0000-0000-000000000001'),  -- AC-5, profile delete
  ('0d', 'admin',       'b1870000-0000-0000-0000-000000000001'),  -- AC-5, auth.users delete
  ('0e', 'admin',       'b1870000-0000-0000-0000-000000000001'),  -- AC-5, delete with B's claims
  ('0f', 'admin',       'b1870000-0000-0000-0000-000000000001'),  -- AC-6, AC-8a, renamed
  ('a0', 'super_admin', null),                                    -- AC-17
  ('a1', 'user',        'b1870000-0000-0000-0000-000000000001'),  -- S-1, staff
  ('a2', 'user',        'b1870000-0000-0000-0000-000000000002'),  -- AC-17, cross-brand target
  ('a3', 'user',        'b1870000-0000-0000-0000-000000000001'),  -- AC-17, same-brand target
  ('a4', 'user',        null),                                    -- AC-35c-e, AC-37b, demoted shape
  ('b0', 'master',      'b1870000-0000-0000-0000-000000000001'),  -- AC-35f, name padded
  ('b1', 'admin',       'b1870000-0000-0000-0000-000000000001');  -- AC-2d, AC-8b, blank name

insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
                        email_confirmed_at, created_at, updated_at,
                        raw_app_meta_data, raw_user_meta_data)
select ('b1870003-0000-0000-0000-0000000000' || tag)::uuid,
       '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
       'oa187-' || tag || '@local.test', '', now(), now(), now(),
       jsonb_build_object('role', role), '{}'::jsonb
  from _t187_people;

-- b1's name is only whitespace, so the snapshot name falls back to the email
-- (AC-2d, AC-8b). b0's is padded, so the stored name is trimmed (AC-35f).
insert into public.profiles (id, name, role, brand_id)
select ('b1870003-0000-0000-0000-0000000000' || tag)::uuid,
       case tag when 'b1' then '   '
                when 'b0' then '  Person b0 (t187)  '
                else 'Person ' || tag || ' (t187)' end,
       role, brand
  from _t187_people;

-- a1 is brand staff and a4 is the demoted shape (role user, NULL brand). Both are
-- linked to the store, so an 'admin' JWT claim lets them see its approvals.
insert into public.user_stores (user_id, store_id)
values ('b1870003-0000-0000-0000-0000000000a1', 'b1870001-0000-0000-0000-000000000001'),
       ('b1870003-0000-0000-0000-0000000000a4', 'b1870001-0000-0000-0000-000000000001');

-- Rows, by day number. Empty lines keep spec 177's lines-store trigger out of the
-- way until the RPC writes real ones.
insert into public.order_approvals
  (store_id, vendor_id, business_date, approved_by, approved_at, channel, status, lines)
select 'b1870001-0000-0000-0000-000000000001', 'b1870002-0000-0000-0000-000000000001',
       date '2026-01-01' + v.day,
       case when v.tag is null then null
            else ('b1870003-0000-0000-0000-0000000000' || v.tag)::uuid end,
       now() - interval '1 hour', 'manual', v.status, '[]'::jsonb
  from (values
    ( 1, '0a', 'pending'),  ( 2, '0a', 'approved'), ( 3, '0a', 'ordered'),   -- AC-4, AC-10, AC-11
    ( 4, null, 'pending'),                                                   -- AC-4
    (11, '0c', 'pending'),  (12, '0c', 'approved'), (13, '0c', 'ordered'),   -- AC-5
    (14, '0d', 'pending'),  (15, '0d', 'approved'), (16, '0d', 'ordered'),   -- AC-5
    (17, '0e', 'pending'),  (18, '0e', 'approved'), (19, '0e', 'ordered'),   -- AC-5
    (21, '0f', 'pending'),                                                   -- AC-6, AC-8a
    (31, '0a', 'pending'),                                                   -- AC-8
    (32, '0a', 'pending'),                                                   -- AC-9
    (33, '0a', 'pending'),                                                   -- AC-10
    (34, '0a', 'pending'),                                                   -- AC-10a
    (35, '0a', 'pending'),                                                   -- AC-10b
    (41, '0a', 'approved'), (42, '0a', 'ordered'),                           -- AC-12
    (51, null, 'pending'),                                                   -- AC-13
    (52, null, 'approved'), (53, null, 'approved'),                          -- AC-14
    (54, null, 'pending'),                                                   -- AC-15
    (71, 'a3', 'approved'),                                                  -- AC-17
    (91, '0a', 'pending'),                                                   -- AC-32
    (92, null, 'pending'),                                                   -- AC-33
    (93, '0a', 'pending'),                                                   -- AC-34a
    (94, '0a', 'pending'),  (95, '0a', 'pending'),                           -- AC-34b
    (96, '0a', 'approved'),                                                  -- AC-34c
    (97, '0a', 'pending'),                                                   -- AC-36
    (98, '0a', 'pending'),                                                   -- AC-35a
    (99, 'a1', 'pending'),                                                   -- AC-35b
    (100, '0a', 'pending'),                                                  -- AC-35c, AC-35d
    (102, 'a4', 'pending'),                                                  -- AC-35e
    (105, '0a', 'approved'),                                                 -- AC-37b
    (108, '0a', 'pending'),                                                  -- AC-8b
    (110, '0a', 'pending'),                                                  -- AC-35h, AC-35i
    (111, '0a', 'pending'),                                                  -- AC-35j
    (112, '0a', 'pending')                                                   -- AC-8c
  ) as v(day, tag, status);
-- Days the callers' RPCs and INSERTs create: 61, 70, 72-74, 81 (refused),
-- 103 (AC-35f), 104 (AC-35g), 106 and 107 (AC-2d), 109 (AC-37a, refused),
-- 113 to 120 (AC-38a to AC-38c, refused), 121 to 124 (AC-38d).

-- ─── test-only helpers (rolled back with everything else) ──────
-- Run a statement as the current role. 'ok:<rows>' or '<sqlstate>: <message>'.
create function public._t187_try(p_sql text) returns text
language plpgsql as $$
declare
  v_rows bigint;
begin
  execute p_sql;
  get diagnostics v_rows = row_count;
  return 'ok:' || v_rows;
exception when others then
  return sqlstate || ': ' || sqlerrm;
end $$;

-- Update the row for a day as the current role.
create function public._t187_upd(p_day int, p_set text) returns text
language plpgsql as $$
begin
  return public._t187_try(format(
    $q$update public.order_approvals set %s
        where store_id = 'b1870001-0000-0000-0000-000000000001'
          and vendor_id = 'b1870002-0000-0000-0000-000000000001'
          and business_date = date '2026-01-01' + %s$q$, p_set, p_day));
end $$;

-- Call create_order_approval for a day as the current role, with one real line.
create function public._t187_rpc(p_day int, p_item_name text) returns text
language plpgsql as $$
begin
  return public._t187_try(format(
    $q$select public.create_order_approval(
         'b1870001-0000-0000-0000-000000000001'::uuid,
         'b1870002-0000-0000-0000-000000000001'::uuid,
         date '2026-01-01' + %s, %L::jsonb, null)$q$,
    p_day,
    jsonb_build_array(jsonb_build_object(
      'item_id', 'b1870006-0000-0000-0000-000000000001',
      'item_name', p_item_name, 'qty_base', 2, 'case_qty', 1,
      'unit', 'each', 'cost_per_counted_unit', 1))::text));
end $$;

-- Direct INSERT of a row for a day, at a status, as the current role. The approver
-- is p_approver, or the caller when that is NULL.
create function public._t187_ins(p_day int, p_status text, p_approver uuid default null)
returns text
language plpgsql as $$
begin
  return public._t187_try(format(
    $q$insert into public.order_approvals
         (store_id, vendor_id, business_date, approved_by, channel, status, lines)
       values ('b1870001-0000-0000-0000-000000000001', 'b1870002-0000-0000-0000-000000000001',
               date '2026-01-01' + %s, %L::uuid, 'manual', %L, '[]'::jsonb)$q$,
    p_day, coalesce(p_approver, auth.uid()), p_status));
end $$;

-- Try all the hand edits of the snapshot on a day. Distinct outcomes, joined.
create function public._t187_edit_snapshot(p_day int, p_include_null boolean) returns text
language plpgsql as $$
declare
  v_set  text;
  v_seen text[] := '{}';
  v_out  text;
begin
  foreach v_set in array
    array['approved_by_name = ''Forged''', 'approved_by_email = ''forged@evil.test''',
          'approved_by_id = ''b1870003-0000-0000-0000-0000000000ff''']
    || case when p_include_null
            then array['approved_by_name = null', 'approved_by_email = null',
                       'approved_by_id = null']
            else '{}'::text[] end
  loop
    v_out := public._t187_upd(p_day, v_set);
    if not v_out = any (v_seen) then
      v_seen := v_seen || v_out;
    end if;
  end loop;
  return array_to_string(v_seen, ' / ');
end $$;

-- Change each column in amendment A1's pending-edit list on a day, one per UPDATE.
-- Distinct outcomes, joined. A column that slips the rule adds an 'ok:1'.
create function public._t187_edit_pending(p_day int) returns text
language plpgsql as $$
declare
  v_set  text;
  v_seen text[] := '{}';
  v_out  text;
begin
  foreach v_set in array array[
    $s$status = 'approved'$s$,
    $s$lines = '[{"item_id":"b1870006-0000-0000-0000-000000000001","item_name":"Planted","qty_base":1,"cost_per_counted_unit":1}]'::jsonb$s$,
    $s$line_count = 5$s$,
    $s$est_total_cost = 9.99$s$,
    $s$channel = 'extension'$s$,
    $s$external_ref = 'https://evil.test/planted'$s$,
    $s$external_ref_expires_at = now() + interval '1 day'$s$,
    $s$ordered_at = now()$s$]
  loop
    v_out := public._t187_upd(p_day, v_set);
    if not v_out = any (v_seen) then
      v_seen := v_seen || v_out;
    end if;
  end loop;
  return array_to_string(v_seen, ' / ');
end $$;

-- Set the JWT claims for an API caller.
create function public._t187_as(p_tag text, p_role text) returns void
language plpgsql as $$
begin
  perform set_config('request.jwt.claims', jsonb_build_object(
    'sub', 'b1870003-0000-0000-0000-0000000000' || p_tag,
    'role', 'authenticated',
    'app_metadata', jsonb_build_object('role', p_role))::text, true);
end $$;

grant execute on function public._t187_try(text),
                          public._t187_upd(int, text),
                          public._t187_rpc(int, text),
                          public._t187_ins(int, text, uuid),
                          public._t187_edit_snapshot(int, boolean),
                          public._t187_edit_pending(int),
                          public._t187_as(text, text)
  to authenticated, service_role;

-- A day's row, read as postgres:
--   approver tag | approved_by_id tag | name | email | approved_at | status | lines.
create function public._t187_view(p_day int) returns text
language sql stable as $$
  select concat_ws('|',
           coalesce(right(approved_by::text, 2), '--'),
           coalesce(right(approved_by_id::text, 2), '--'),
           coalesce(approved_by_name, '<null>'),
           coalesce(approved_by_email, '<null>'),
           case when approved_at = now() then 'now'
                when approved_at = now() - interval '1 hour' then 'backdated'
                else 'other' end,
           status,
           jsonb_array_length(lines))
    from public.order_approvals
   where store_id = 'b1870001-0000-0000-0000-000000000001'
     and vendor_id = 'b1870002-0000-0000-0000-000000000001'
     and business_date = date '2026-01-01' + p_day
$$;


-- ─── SNAPSHOT ──────────────────────────────────────────────────
set local role authenticated;
select public._t187_as('0a', 'admin');

-- AC-1: through the RPC.
select set_config('test.ac1', public._t187_rpc(70, 'A lines'), true);

-- AC-2: direct INSERTs through privileged_store_insert_order_approvals.
select set_config('test.ac2a', public._t187_try(
  $q$insert into public.order_approvals
       (store_id, vendor_id, business_date, approved_by, channel, status, lines,
        approved_by_name, approved_by_email, approved_by_id)
     values ('b1870001-0000-0000-0000-000000000001', 'b1870002-0000-0000-0000-000000000001',
             date '2026-01-01' + 72, auth.uid(), 'manual', 'pending', '[]'::jsonb,
             'Forged Name', 'forged@evil.test', 'b1870003-0000-0000-0000-0000000000ff')$q$), true);

select set_config('test.ac2b', public._t187_try(
  $q$insert into public.order_approvals
       (store_id, vendor_id, business_date, approved_by, channel, status, lines,
        approved_by_name, approved_by_email, approved_by_id)
     values ('b1870001-0000-0000-0000-000000000001', 'b1870002-0000-0000-0000-000000000001',
             date '2026-01-01' + 73, auth.uid(), 'manual', 'pending', '[]'::jsonb,
             '', '', null)$q$), true);

-- AC-2c: the trigger reads B's email into NEW, then the WITH CHECK refuses the row.
select set_config('test.ac2c', public._t187_try(
  $q$insert into public.order_approvals
       (store_id, vendor_id, business_date, approved_by, channel, status, lines)
     values ('b1870001-0000-0000-0000-000000000001', 'b1870002-0000-0000-0000-000000000001',
             date '2026-01-01' + 74, 'b1870003-0000-0000-0000-00000000000b', 'manual',
             'pending', '[]'::jsonb)$q$), true);

-- AC-4 as an admin at each status, and on a row with no approver.
select set_config('test.ac4a', public._t187_edit_snapshot(1, true), true);
select set_config('test.ac4b', public._t187_edit_snapshot(2, true), true);
select set_config('test.ac4c', public._t187_edit_snapshot(3, true), true);
select set_config('test.ac4d', public._t187_edit_snapshot(4, false), true);

-- AC-2d: b1's profiles.name is only whitespace.
select public._t187_as('b1', 'admin');
select set_config('test.ac2d_insert', public._t187_try(
  $q$insert into public.order_approvals
       (store_id, vendor_id, business_date, approved_by, channel, status, lines)
     values ('b1870001-0000-0000-0000-000000000001', 'b1870002-0000-0000-0000-000000000001',
             date '2026-01-01' + 106, auth.uid(), 'manual', 'pending', '[]'::jsonb)$q$), true);
select set_config('test.ac2d_rpc', public._t187_rpc(107, 'B1 lines'), true);

reset role;
select set_config('request.jwt.claims', '', true);

select is(current_setting('test.ac1', true) || ' ' || public._t187_view(70),
  'ok:1 0a|0a|Person 0a (t187)|oa187-0a@local.test|now|pending|1',
  'AC-1 create_order_approval stores the caller''s profiles.name, auth.users.email and id');

select is(current_setting('test.ac2a', true) || ' ' || public._t187_view(72),
  'ok:1 0a|0a|Person 0a (t187)|oa187-0a@local.test|now|pending|0',
  'AC-2a a direct INSERT with a forged name, email and approved_by_id stores the caller''s real values');

select is(current_setting('test.ac2b', true) || ' ' || public._t187_view(73),
  'ok:1 0a|0a|Person 0a (t187)|oa187-0a@local.test|now|pending|0',
  'AC-2b a direct INSERT with an empty name and email and a NULL id stores the caller''s real values');

select is(current_setting('test.ac2d_insert', true) || ' ' || current_setting('test.ac2d_rpc', true) || ' '
          || public._t187_view(106) || ' ' || public._t187_view(107),
  'ok:1 ok:1 b1|b1|oa187-b1@local.test|oa187-b1@local.test|now|pending|0 '
  || 'b1|b1|oa187-b1@local.test|oa187-b1@local.test|now|pending|1',
  'AC-2d a blank profiles.name stores the email as the name, on a direct INSERT and through the RPC');

select ok(current_setting('test.ac2c', true) like '42501: %'
          and public._t187_view(74) is null
          and current_setting('test.ac2c', true) not like '%oa187-%',
  'AC-2c naming someone else as approver is refused with 42501 and the error carries no email');

-- AC-3: owner-level, NULL approved_by, values supplied.
insert into public.order_approvals
  (store_id, vendor_id, business_date, approved_by, channel, status, lines,
   approved_by_name, approved_by_email, approved_by_id)
values ('b1870001-0000-0000-0000-000000000001', 'b1870002-0000-0000-0000-000000000001',
        date '2026-01-01' + 61, null, 'manual', 'pending', '[]'::jsonb,
        'Supplied Name', 'supplied@evil.test', 'b1870003-0000-0000-0000-0000000000ff');

select is(public._t187_view(61), '--|--|<null>|<null>|now|pending|0',
  'AC-3 an owner-level INSERT with NULL approved_by stores NULL in all three columns, whatever is supplied');

select is(current_setting('test.ac4a', true), 'P0001: order approval is immutable',
  'AC-4a every hand edit of the snapshot (value and NULL, all three columns) is refused on a pending row');
select is(current_setting('test.ac4b', true), 'P0001: order approval is immutable',
  'AC-4b every hand edit of the snapshot is refused on an approved row');
select is(current_setting('test.ac4c', true), 'P0001: order approval is immutable',
  'AC-4c every hand edit of the snapshot is refused on an ordered row');
select is(current_setting('test.ac4d', true), 'P0001: order approval is immutable',
  'AC-4d a hand edit of the snapshot is refused on a row with no approver');

select is(public._t187_edit_snapshot(1, true), 'P0001: order approval is immutable',
  'AC-4e every hand edit of the snapshot is refused as postgres');

select is(public._t187_view(1) || ' ' || public._t187_view(2) || ' ' || public._t187_view(3)
          || ' ' || public._t187_view(4),
  '0a|0a|Person 0a (t187)|oa187-0a@local.test|backdated|pending|0 '
  || '0a|0a|Person 0a (t187)|oa187-0a@local.test|backdated|approved|0 '
  || '0a|0a|Person 0a (t187)|oa187-0a@local.test|backdated|ordered|0 '
  || '--|--|<null>|<null>|backdated|pending|0',
  'AC-4f the refused edits left all four rows unchanged');

-- AC-5: three ways of losing the approver. Each delete records its outcome, so a
-- guard that refuses the FK's SET NULL turns the arm red instead of aborting the file.
select set_config('test.ac5a', public._t187_try(
  $q$delete from public.profiles where id = 'b1870003-0000-0000-0000-00000000000c'$q$), true);

select is(current_setting('test.ac5a', true) || ' '
          || public._t187_view(11) || ' ' || public._t187_view(12) || ' ' || public._t187_view(13),
  'ok:1 --|0c|Person 0c (t187)|oa187-0c@local.test|backdated|pending|0 '
  || '--|0c|Person 0c (t187)|oa187-0c@local.test|backdated|approved|0 '
  || '--|0c|Person 0c (t187)|oa187-0c@local.test|backdated|ordered|0',
  'AC-5a deleting the profile NULLs approved_by and keeps the snapshot (id included) and approved_at at every status');

select set_config('test.ac5b', public._t187_try(
  $q$delete from auth.users where id = 'b1870003-0000-0000-0000-00000000000d'$q$), true);

select is(current_setting('test.ac5b', true) || ' '
          || public._t187_view(14) || ' ' || public._t187_view(15) || ' ' || public._t187_view(16),
  'ok:1 --|0d|Person 0d (t187)|oa187-0d@local.test|backdated|pending|0 '
  || '--|0d|Person 0d (t187)|oa187-0d@local.test|backdated|approved|0 '
  || '--|0d|Person 0d (t187)|oa187-0d@local.test|backdated|ordered|0',
  'AC-5b deleting the auth.users row does the same');

-- With B's claims set, auth.uid() is not NULL inside the guard during the FK's
-- SET NULL. That must not be taken for a re-stamp, nor trip the pending-row rule.
select public._t187_as('0b', 'admin');
select set_config('test.ac5c', public._t187_try(
  $q$delete from public.profiles where id = 'b1870003-0000-0000-0000-00000000000e'$q$), true);
select set_config('request.jwt.claims', '', true);

select is(current_setting('test.ac5c', true) || ' '
          || public._t187_view(17) || ' ' || public._t187_view(18) || ' ' || public._t187_view(19),
  'ok:1 --|0e|Person 0e (t187)|oa187-0e@local.test|backdated|pending|0 '
  || '--|0e|Person 0e (t187)|oa187-0e@local.test|backdated|approved|0 '
  || '--|0e|Person 0e (t187)|oa187-0e@local.test|backdated|ordered|0',
  'AC-5c the same delete run with another admin''s claims set is not taken for a re-stamp');

-- AC-6
update public.profiles set name = 'Renamed (t187)'
 where id = 'b1870003-0000-0000-0000-00000000000f';

select is(public._t187_view(21),
  '0f|0f|Person 0f (t187)|oa187-0f@local.test|backdated|pending|0',
  'AC-6 renaming the approver doesn''t change the snapshot on their existing rows');

-- AC-7
select ok(
  (select p.prosecdef and p.proconfig @> array['search_path=public']
          and pg_get_userbyid(p.proowner) = 'postgres'
     from pg_proc p where p.oid = 'public.tg_order_approvals_stamp_approver()'::regprocedure),
  'AC-7a tg_order_approvals_stamp_approver is SECURITY DEFINER, search_path pinned, owned by postgres');

select ok(
  (select p.prosecdef and p.proconfig @> array['search_path=public']
          and pg_get_userbyid(p.proowner) = 'postgres'
     from pg_proc p where p.oid = 'public.tg_order_approvals_guard()'::regprocedure),
  'AC-7b tg_order_approvals_guard is SECURITY DEFINER, search_path pinned, owned by postgres');

select ok(
  not has_function_privilege('anon',          'public.tg_order_approvals_stamp_approver()', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.tg_order_approvals_stamp_approver()', 'EXECUTE')
  and (select p.proacl is not null
              and not exists (select 1 from aclexplode(p.proacl) a
                               where a.grantee = 0 and a.privilege_type = 'EXECUTE')
         from pg_proc p where p.oid = 'public.tg_order_approvals_stamp_approver()'::regprocedure),
  'AC-7c tg_order_approvals_stamp_approver: no EXECUTE for anon, authenticated or PUBLIC');

select ok(
  not has_function_privilege('anon',          'public.tg_order_approvals_guard()', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.tg_order_approvals_guard()', 'EXECUTE')
  and (select p.proacl is not null
              and not exists (select 1 from aclexplode(p.proacl) a
                               where a.grantee = 0 and a.privilege_type = 'EXECUTE')
         from pg_proc p where p.oid = 'public.tg_order_approvals_guard()'::regprocedure),
  'AC-7d tg_order_approvals_guard: no EXECUTE for anon, authenticated or PUBLIC');

select ok(
  (select (t.tgtype::int & 127) = 7 and t.tgenabled = 'O'
          and t.tgfoid = 'public.tg_order_approvals_stamp_approver()'::regprocedure
     from pg_trigger t
    where t.tgrelid = 'public.order_approvals'::regclass
      and t.tgname = 'order_approvals_stamp_approver_trg'),
  'AC-7e order_approvals_stamp_approver_trg is BEFORE INSERT FOR EACH ROW and enabled');

select ok(
  (select not p.prosecdef from pg_proc p
    where p.oid = 'public.create_order_approval(uuid, uuid, date, jsonb, uuid)'::regprocedure),
  'AC-7f create_order_approval stays SECURITY INVOKER');

select ok(
  (select format_type(a.atttypid, a.atttypmod) = 'uuid' and not a.attnotnull
          and not exists (select 1 from pg_constraint c
                           where c.conrelid = a.attrelid and c.contype = 'f'
                             and a.attnum = any (c.conkey))
     from pg_attribute a
    where a.attrelid = 'public.order_approvals'::regclass
      and a.attname = 'approved_by_id' and not a.attisdropped),
  'AC-7g approved_by_id is a nullable uuid that no foreign key covers');


-- ─── RE-STAMP ──────────────────────────────────────────────────
set local role authenticated;
select public._t187_as('0b', 'admin');

-- AC-8
select set_config('test.ac8', public._t187_rpc(31, 'B lines'), true);

-- AC-10a: forged values in the same UPDATE as a re-stamp.
select set_config('test.ac10a', public._t187_upd(34,
  $q$approved_by = auth.uid(), approved_by_name = 'Forged',
     approved_by_email = 'forged@evil.test', approved_at = timestamptz '2000-01-01',
     approved_by_id = 'b1870003-0000-0000-0000-0000000000ff'$q$), true);

-- AC-10: as B, on A's rows.
select set_config('test.ac10a_other', public._t187_upd(33,
  $q$approved_by = 'b1870003-0000-0000-0000-00000000000f'$q$), true);
select set_config('test.ac10b_null', public._t187_upd(33, 'approved_by = null'), true);
select set_config('test.ac10c_approved', public._t187_upd(2, 'approved_by = auth.uid()'), true);
select set_config('test.ac10d_ordered', public._t187_upd(3, 'approved_by = auth.uid()'), true);

-- AC-11: as B, at every status.
select set_config('test.ac11a', public._t187_upd(1, 'approved_at = now()'), true);
select set_config('test.ac11b', public._t187_upd(2, 'approved_at = now()'), true);
select set_config('test.ac11c', public._t187_upd(3, 'approved_at = now()'), true);

-- AC-12: as B, on A's approved and ordered rows.
select set_config('test.ac12a', public._t187_rpc(41, 'B lines'), true);
select set_config('test.ac12b', public._t187_rpc(42, 'B lines'), true);

-- AC-8a: the renamed approver retries on their own row.
select public._t187_as('0f', 'admin');
select set_config('test.ac8a', public._t187_rpc(21, 'Same approver lines'), true);

-- AC-8b: a re-stamp by b1, whose name is blank.
select public._t187_as('b1', 'admin');
select set_config('test.ac8b', public._t187_rpc(108, 'B1 lines'), true);

-- AC-8c: a re-stamp by b0 (master), whose name is padded.
select public._t187_as('b0', 'master');
select set_config('test.ac8c', public._t187_rpc(112, 'B0 lines'), true);

reset role;
select set_config('request.jwt.claims', '', true);

select is(current_setting('test.ac8', true) || ' ' || public._t187_view(31) || ' '
          || (select lines->0->>'item_name' from public.order_approvals
               where store_id = 'b1870001-0000-0000-0000-000000000001'
                 and business_date = date '2026-01-01' + 31),
  'ok:1 0b|0b|Person 0b (t187)|oa187-0b@local.test|now|pending|1 B lines',
  'AC-8 another admin''s retry leaves the approver, snapshot and lines all theirs, and moves approved_at');

select is(current_setting('test.ac8a', true) || ' ' || public._t187_view(21) || ' '
          || (select lines->0->>'item_name' from public.order_approvals
               where store_id = 'b1870001-0000-0000-0000-000000000001'
                 and business_date = date '2026-01-01' + 21),
  'ok:1 0f|0f|Person 0f (t187)|oa187-0f@local.test|backdated|pending|1 Same approver lines',
  'AC-8a a retry by the same approver refreshes the lines and keeps approved_at and the snapshot, even after a rename');

select is(current_setting('test.ac8b', true) || ' ' || public._t187_view(108),
  'ok:1 b1|b1|oa187-b1@local.test|oa187-b1@local.test|now|pending|1',
  'AC-8b a re-stamp by a caller with a blank name stores their email as the name, their id, and moves approved_at');

select is(current_setting('test.ac8c', true) || ' ' || public._t187_view(112),
  'ok:1 b0|b0|Person b0 (t187)|oa187-b0@local.test|now|pending|1',
  'AC-8c a re-stamp by a caller with a padded name stores it trimmed');

select is(current_setting('test.ac10a', true) || ' ' || public._t187_view(34),
  'ok:1 0b|0b|Person 0b (t187)|oa187-0b@local.test|now|pending|0',
  'AC-10a forged values in the re-stamp UPDATE lose to the caller''s real values and now()');

select is(current_setting('test.ac10a_other', true), 'P0001: order approval is immutable',
  'AC-10a2 setting approved_by to anyone other than the caller is refused while pending');
select is(current_setting('test.ac10b_null', true), 'P0001: order approval is immutable',
  'AC-10b2 setting approved_by to NULL while the profile exists is refused while pending');
select is(current_setting('test.ac10c_approved', true), 'P0001: order approval is immutable',
  'AC-10c setting approved_by to the caller is refused on an approved row');
select is(current_setting('test.ac10d_ordered', true), 'P0001: order approval is immutable',
  'AC-10d setting approved_by to the caller is refused on an ordered row');

-- AC-10b: re-pointing with no claims. auth.uid() is NULL for both.
select is(public._t187_upd(35, $q$approved_by = 'b1870003-0000-0000-0000-00000000000f'$q$),
  'P0001: order approval is immutable',
  'AC-10b re-pointing approved_by on a pending row is refused as postgres with no claims');

set local role service_role;
select set_config('test.ac10b_sr', public._t187_upd(35,
  $q$approved_by = 'b1870003-0000-0000-0000-00000000000f'$q$), true);
reset role;

select is(current_setting('test.ac10b_sr', true), 'P0001: order approval is immutable',
  'AC-10b3 re-pointing approved_by on a pending row is refused as service_role with no claims');

select is(current_setting('test.ac11a', true), 'P0001: order approval is immutable',
  'AC-11a a direct update of approved_at is refused on a pending row');
select is(current_setting('test.ac11b', true), 'P0001: order approval is immutable',
  'AC-11b a direct update of approved_at is refused on an approved row');
select is(current_setting('test.ac11c', true), 'P0001: order approval is immutable',
  'AC-11c a direct update of approved_at is refused on an ordered row');

select is(current_setting('test.ac12a', true) || ' ' || public._t187_view(41),
  'ok:1 0a|0a|Person 0a (t187)|oa187-0a@local.test|backdated|approved|0',
  'AC-12a the RPC on an approved row, as a different admin, returns it with no change');
select is(current_setting('test.ac12b', true) || ' ' || public._t187_view(42),
  'ok:1 0a|0a|Person 0a (t187)|oa187-0a@local.test|backdated|ordered|0',
  'AC-12b the RPC on an ordered row, as a different admin, returns it with no change');

-- AC-9: the race branch. Same mechanism as order_approvals.test.sql arm C7: the
-- pre-select misses the row once, the INSERT hits the unique index, and the
-- handler re-reads the row and takes its own pending update.
create function public._t187_peek_visible(p_id uuid) returns boolean
language plpgsql volatile as $$
begin
  if coalesce(current_setting('test.oa_hide', true), '') = p_id::text then
    perform set_config('test.oa_hide', '<consumed>', true);
    return false;
  end if;
  return true;
end $$;
grant execute on function public._t187_peek_visible(uuid) to authenticated;

create policy "t187_race_hide_once" on public.order_approvals
  as restrictive for select using (public._t187_peek_visible(id));

select set_config('test.oa_hide', (
  select id::text from public.order_approvals
   where store_id = 'b1870001-0000-0000-0000-000000000001'
     and business_date = date '2026-01-01' + 32), true);

set local role authenticated;
select public._t187_as('0b', 'admin');
select set_config('test.ac9', public._t187_rpc(32, 'B race lines'), true);
reset role;
select set_config('request.jwt.claims', '', true);

drop policy "t187_race_hide_once" on public.order_approvals;
drop function public._t187_peek_visible(uuid);

select is(current_setting('test.ac9', true) || ' ' || current_setting('test.oa_hide', true) || ' '
          || public._t187_view(32) || ' '
          || (select lines->0->>'item_name' from public.order_approvals
               where store_id = 'b1870001-0000-0000-0000-000000000001'
                 and business_date = date '2026-01-01' + 32),
  'ok:1 <consumed> 0b|0b|Person 0b (t187)|oa187-0b@local.test|now|pending|1 B race lines',
  'AC-9 the race branch also stamps the caller, with the hide-once marker proving it took that branch');


-- ─── A ROW WITH NO APPROVER ────────────────────────────────────
set local role authenticated;
select public._t187_as('0a', 'admin');

select set_config('test.ac13', public._t187_upd(51, $q$status = 'approved'$q$), true);
select set_config('test.ac14a', public._t187_upd(52, $q$status = 'ordered'$q$), true);
select set_config('test.ac14b', public._t187_upd(53, $q$external_ref = 'https://example.test/remint'$q$), true);

-- AC-15: recovery by another admin.
select public._t187_as('0b', 'admin');
select set_config('test.ac15a', public._t187_rpc(54, 'B recovery lines'), true);
select set_config('test.ac15b', public._t187_upd(54, $q$status = 'approved'$q$), true);

reset role;
select set_config('request.jwt.claims', '', true);

select is(current_setting('test.ac13', true) || ' ' || public._t187_view(51),
  'P0001: order approval has no approver --|--|<null>|<null>|backdated|pending|0',
  'AC-13 pending -> approved with NULL approved_by raises P0001 with an admin''s JWT and the row is unchanged');

select is(current_setting('test.ac14a', true) || ' ' || public._t187_view(52) || ' '
          || (select (ordered_at is not null)::text from public.order_approvals
               where store_id = 'b1870001-0000-0000-0000-000000000001'
                 and business_date = date '2026-01-01' + 52),
  'ok:1 --|--|<null>|<null>|backdated|ordered|0 true',
  'AC-14a approved -> ordered with NULL approved_by succeeds and sets ordered_at');

select is(current_setting('test.ac14b', true) || ' '
          || (select external_ref from public.order_approvals
               where store_id = 'b1870001-0000-0000-0000-000000000001'
                 and business_date = date '2026-01-01' + 53),
  'ok:1 https://example.test/remint',
  'AC-14b an approved -> approved no-op that writes a new external_ref succeeds (the Instacart re-mint write)');

select is(current_setting('test.ac15a', true), 'ok:1',
  'AC-15a another admin''s create_order_approval on a pending row with no approver succeeds');

select is(current_setting('test.ac15b', true) || ' ' || public._t187_view(54),
  'ok:1 0b|0b|Person 0b (t187)|oa187-0b@local.test|now|approved|1',
  'AC-15b the RPC stamped them, and the row can then move to approved');


-- ─── DIRECT PROFILE DELETES ────────────────────────────────────
select is(
  (select count(*)::int from pg_policies
    where schemaname = 'public' and tablename = 'profiles' and cmd in ('DELETE', 'ALL')),
  0,
  'AC-16 public.profiles has no DELETE or ALL policy');

set local role authenticated;
select public._t187_as('0a', 'admin');
select set_config('test.ac17a', public._t187_try(
  $q$delete from public.profiles where id = 'b1870003-0000-0000-0000-0000000000a3'$q$), true);

select public._t187_as('a0', 'super_admin');
select set_config('test.ac17b', public._t187_try(
  $q$delete from public.profiles where id = 'b1870003-0000-0000-0000-0000000000a2'$q$), true);
select set_config('test.ac17c', public._t187_try(
  $q$delete from public.profiles where id = 'b1870003-0000-0000-0000-0000000000a0'$q$), true);

reset role;
select set_config('request.jwt.claims', '', true);

select is(current_setting('test.ac17a', true), 'ok:0',
  'AC-17a a brand admin deleting a same-brand profile removes 0 rows with no error');
select is(current_setting('test.ac17b', true), 'ok:0',
  'AC-17b a super_admin deleting a cross-brand profile removes 0 rows with no error');
select is(current_setting('test.ac17c', true), 'ok:0',
  'AC-17c a super_admin deleting their own profile removes 0 rows with no error');

select is(
  (select count(*)::int from public.profiles
    where id in ('b1870003-0000-0000-0000-0000000000a3',
                 'b1870003-0000-0000-0000-0000000000a2',
                 'b1870003-0000-0000-0000-0000000000a0'))
  || ' ' || public._t187_view(71),
  '3 a3|a3|Person a3 (t187)|oa187-a3@local.test|backdated|approved|0',
  'AC-17d all three profiles remain, and approved_by on the target''s approval is unchanged');

-- AC-18: the lock stays as a backstop.
select public._t187_as('0a', 'admin');
select throws_ok(
  $q$delete from public.profiles where id = 'b1870003-0000-0000-0000-00000000000a'$q$,
  'P0001',
  'profile self-delete is not permitted (use admin delete flow)',
  'AC-18 as postgres with an admin''s claims, a self-delete still raises (profiles_self_delete_lock)');
select set_config('request.jwt.claims', '', true);


-- ─── STAFF ─────────────────────────────────────────────────────
set local role authenticated;
select public._t187_as('a1', 'user');
select set_config('test.s1', (
  select count(*)::text from public.order_approvals
   where store_id = 'b1870001-0000-0000-0000-000000000001'), true);
select set_config('test.s2', public._t187_rpc(81, 'Staff lines'), true);
reset role;
select set_config('request.jwt.claims', '', true);

select is(current_setting('test.s1', true), '0',
  'S-1 a store-linked staff user sees no approvals, so no snapshot email');
select is(current_setting('test.s2', true), '42501: not authorized to approve orders',
  'S-2 a store-linked staff user can''t use the RPC');


-- ─── WHO MAY CHANGE A PENDING ROW (amendment A1) ───────────────
-- The listed columns: status, lines, line_count, est_total_cost, channel,
-- external_ref, external_ref_expires_at, ordered_at.
set local role authenticated;

-- AC-32a: B on A's pending row, each listed column alone.
select public._t187_as('0b', 'admin');
select set_config('test.ac32a', public._t187_edit_pending(91), true);

-- AC-34c: B's re-mint on A's approved row.
select set_config('test.ac34c', public._t187_upd(96,
  $q$status = 'approved', external_ref = 'https://example.test/remint-b',
     external_ref_expires_at = now() + interval '7 days'$q$), true);

-- AC-36: B re-stamps A's pending row through the RPC, then A's late
-- Instacart-shaped write-back lands.
select set_config('test.ac36_b', public._t187_rpc(97, 'B lines'), true);
select public._t187_as('0a', 'admin');
select set_config('test.ac36_a', public._t187_upd(97,
  $q$external_ref = 'https://example.test/late', external_ref_expires_at = now() + interval '7 days',
     status = 'approved'$q$), true);

-- AC-33: A on a pending row with no approver.
select set_config('test.ac33_lines', public._t187_upd(92,
  $q$lines = '[{"item_id":"b1870006-0000-0000-0000-000000000001","item_name":"A","qty_base":1,"cost_per_counted_unit":1}]'::jsonb$q$), true);
select set_config('test.ac33_channel', public._t187_upd(92, $q$channel = 'extension'$q$), true);

-- AC-34a: A's own channel fallback, then the advance with external_ref.
select set_config('test.ac34a_channel', public._t187_upd(93, $q$channel = 'extension'$q$), true);
select set_config('test.ac34a_advance', public._t187_upd(93,
  $q$status = 'approved', external_ref = 'https://example.test/a',
     external_ref_expires_at = now() + interval '7 days'$q$), true);

-- AC-37a, AC-35a, AC-35b, AC-35h, AC-35i, AC-38a: a1 is brand staff
-- (profiles.role 'user') with a stale 'admin' claim. AC-35b approves the a1 row
-- the fixtures inserted as postgres, because a1 can no longer insert one (AC-37a).
select public._t187_as('a1', 'admin');
select set_config('test.ac37a', public._t187_rpc(109, 'Stale lines'), true);
select set_config('test.ac35a', public._t187_rpc(98, 'Stale lines'), true);
select set_config('test.ac35b', public._t187_upd(99, $q$status = 'approved'$q$), true);
select set_config('test.ac35h', public._t187_upd(110, 'approved_by = auth.uid()'), true);
select set_config('test.ac35i', public._t187_upd(110,
  $q$lines = '[{"item_id":"b1870006-0000-0000-0000-000000000001","item_name":"A1","qty_base":1,"cost_per_counted_unit":1}]'::jsonb$q$), true);
select set_config('test.ac38a', public._t187_ins(113, 'pending') || ' / '
                                || public._t187_ins(114, 'approved') || ' / '
                                || public._t187_ins(115, 'ordered'), true);

-- AC-35c to AC-35e, AC-37b: a4 is the demoted shape (role 'user', NULL brand,
-- store-linked) with a stale 'admin' claim.
select public._t187_as('a4', 'admin');
select set_config('test.ac35c', public._t187_upd(100, 'approved_by = auth.uid()'), true);
select set_config('test.ac35d', public._t187_upd(100,
  $q$lines = '[{"item_id":"b1870006-0000-0000-0000-000000000001","item_name":"A4","qty_base":1,"cost_per_counted_unit":1}]'::jsonb$q$), true);
select set_config('test.ac35e', public._t187_upd(102, $q$status = 'approved'$q$), true);
select set_config('test.ac37b', public._t187_upd(105, $q$status = 'ordered'$q$), true);
select set_config('test.ac35j', public._t187_rpc(111, 'A4 lines'), true);
select set_config('test.ac38b', public._t187_ins(116, 'pending') || ' / '
                                || public._t187_ins(117, 'approved') || ' / '
                                || public._t187_ins(118, 'ordered'), true);

-- AC-38c: A, a real admin, inserting rows that are already approved or ordered.
select public._t187_as('0a', 'admin');
select set_config('test.ac38c', public._t187_ins(119, 'approved') || ' / '
                                || public._t187_ins(120, 'ordered'), true);

-- AC-35f, AC-35g: a master and a super_admin profile.
select public._t187_as('b0', 'master');
select set_config('test.ac35f', public._t187_rpc(103, 'Master lines') || ' '
                                || public._t187_upd(103, $q$status = 'approved'$q$), true);
select public._t187_as('a0', 'super_admin');
select set_config('test.ac35g', public._t187_rpc(104, 'Super lines') || ' '
                                || public._t187_upd(104, $q$status = 'approved'$q$), true);

reset role;
select set_config('request.jwt.claims', '', true);

-- AC-34b: postgres with no claims, then service_role with no claims.
select set_config('test.ac34b_pg', public._t187_upd(94,
  $q$lines = '[{"item_id":"b1870006-0000-0000-0000-000000000001","item_name":"PG","qty_base":1,"cost_per_counted_unit":1}]'::jsonb$q$)
  || ' ' || public._t187_upd(94, $q$status = 'approved'$q$), true);
set local role service_role;
select set_config('test.ac34b_sr', public._t187_upd(95,
  $q$lines = '[{"item_id":"b1870006-0000-0000-0000-000000000001","item_name":"SR","qty_base":1,"cost_per_counted_unit":1}]'::jsonb$q$)
  || ' ' || public._t187_upd(95, $q$status = 'approved'$q$), true);
reset role;

-- AC-38d: postgres, then service_role, both with no claims, insert rows that are
-- already approved or ordered, naming A as approver.
select set_config('test.ac38d_pg',
  public._t187_ins(121, 'approved', 'b1870003-0000-0000-0000-00000000000a') || ' '
  || public._t187_ins(122, 'ordered', 'b1870003-0000-0000-0000-00000000000a'), true);
set local role service_role;
select set_config('test.ac38d_sr',
  public._t187_ins(123, 'approved', 'b1870003-0000-0000-0000-00000000000a') || ' '
  || public._t187_ins(124, 'ordered', 'b1870003-0000-0000-0000-00000000000a'), true);
reset role;

-- How many rows exist for a range of days, read as postgres.
create function public._t187_count(p_from int, p_to int) returns int
language sql stable as $$
  select count(*)::int from public.order_approvals
   where store_id = 'b1870001-0000-0000-0000-000000000001'
     and vendor_id = 'b1870002-0000-0000-0000-000000000001'
     and business_date between date '2026-01-01' + p_from and date '2026-01-01' + p_to
$$;

-- A day's row with the columns AC-32 tries to change.
create function public._t187_view_full(p_day int) returns text
language sql stable as $$
  select public._t187_view(p_day) || ' ' || concat_ws('|',
           channel,
           (line_count = 0 and est_total_cost = 0)::text,
           coalesce(external_ref, '<null>'),
           coalesce(external_ref_expires_at::text, '<null>'),
           coalesce(ordered_at::text, '<null>'))
    from public.order_approvals
   where store_id = 'b1870001-0000-0000-0000-000000000001'
     and vendor_id = 'b1870002-0000-0000-0000-000000000001'
     and business_date = date '2026-01-01' + p_day
$$;

select is(current_setting('test.ac32a', true),
  'P0001: order approval belongs to another approver',
  'AC-32a each listed column changed alone by another admin on a pending row is refused: belongs to another approver');

select is(public._t187_view_full(91),
  '0a|0a|Person 0a (t187)|oa187-0a@local.test|backdated|pending|0 manual|true|<null>|<null>|<null>',
  'AC-32b and the row is unchanged, external_ref, channel and ordered_at included');

select is(current_setting('test.ac33_lines', true) || ' / ' || current_setting('test.ac33_channel', true)
          || ' ' || public._t187_view_full(92),
  'P0001: order approval has no approver / P0001: order approval has no approver '
  || '--|--|<null>|<null>|backdated|pending|0 manual|true|<null>|<null>|<null>',
  'AC-33 the same changes on a pending row with no approver: has no approver, row unchanged');

select is(current_setting('test.ac34a_channel', true) || ' ' || current_setting('test.ac34a_advance', true)
          || ' ' || public._t187_view(93) || ' '
          || (select channel || '|' || external_ref from public.order_approvals
               where store_id = 'b1870001-0000-0000-0000-000000000001'
                 and business_date = date '2026-01-01' + 93),
  'ok:1 ok:1 0a|0a|Person 0a (t187)|oa187-0a@local.test|backdated|approved|0 extension|https://example.test/a',
  'AC-34a the approver''s own channel fallback and advance with external_ref pass');

select is(current_setting('test.ac34b_pg', true) || ' ' || current_setting('test.ac34b_sr', true)
          || ' ' || public._t187_view(94) || ' ' || public._t187_view(95),
  'ok:1 ok:1 ok:1 ok:1 0a|0a|Person 0a (t187)|oa187-0a@local.test|backdated|approved|1 '
  || '0a|0a|Person 0a (t187)|oa187-0a@local.test|backdated|approved|1',
  'AC-34b postgres and service_role with no claims can change lines and approve a pending row');

select is(current_setting('test.ac34c', true) || ' '
          || (select external_ref from public.order_approvals
               where store_id = 'b1870001-0000-0000-0000-000000000001'
                 and business_date = date '2026-01-01' + 96),
  'ok:1 https://example.test/remint-b',
  'AC-34c another admin''s re-mint (status approved + new external_ref) on an approved row passes');

select is(current_setting('test.ac36_b', true) || ' ' || current_setting('test.ac36_a', true) || ' '
          || public._t187_view_full(97) || ' '
          || (select lines->0->>'item_name' from public.order_approvals
               where store_id = 'b1870001-0000-0000-0000-000000000001'
                 and business_date = date '2026-01-01' + 97),
  'ok:1 P0001: order approval belongs to another approver '
  || '0b|0b|Person 0b (t187)|oa187-0b@local.test|now|pending|1 manual|false|<null>|<null>|<null> B lines',
  'AC-36 after another admin re-stamps, the first approver''s late write-back is refused and the row stays theirs');

select is(current_setting('test.ac35a', true) || ' ' || public._t187_view(98),
  'P0001: order approval caller is not an admin '
  || '0a|0a|Person 0a (t187)|oa187-0a@local.test|backdated|pending|0',
  'AC-35a a same-brand user profile with an admin claim can''t re-stamp through the RPC, row unchanged');

select is(current_setting('test.ac35b', true) || ' ' || public._t187_view(99),
  'P0001: order approval caller is not an admin '
  || 'a1|a1|Person a1 (t187)|oa187-a1@local.test|backdated|pending|0',
  'AC-35b it can''t approve its own pending row either');

select is(current_setting('test.ac35h', true),
  'P0001: order approval caller is not an admin',
  'AC-35h the same-brand user profile with an admin claim can''t re-stamp with a PATCH');

select is(current_setting('test.ac35i', true) || ' ' || public._t187_view(110),
  'P0001: order approval caller is not an admin '
  || '0a|0a|Person 0a (t187)|oa187-0a@local.test|backdated|pending|0',
  'AC-35i nor change lines on someone else''s pending row, row unchanged');

select is(current_setting('test.ac35c', true),
  'P0001: order approval caller is not an admin',
  'AC-35c a NULL-brand store-linked user profile with an admin claim can''t re-stamp with a PATCH');

select is(current_setting('test.ac35d', true) || ' ' || public._t187_view(100),
  'P0001: order approval caller is not an admin '
  || '0a|0a|Person 0a (t187)|oa187-0a@local.test|backdated|pending|0',
  'AC-35d it can''t change lines on someone else''s pending row, row unchanged');

select is(current_setting('test.ac35e', true) || ' ' || public._t187_view(102),
  'P0001: order approval caller is not an admin '
  || 'a4|a4|Person a4 (t187)|oa187-a4@local.test|backdated|pending|0',
  'AC-35e it can''t approve its own pending row');

-- A NULL-brand profile can't read the brand's vendor (brand_member_read_vendors),
-- so the RPC refuses with P0002 before its UPDATE reaches the guard. The PATCH
-- route (AC-35c) is the one that reaches the guard's role check for this shape.
select is(current_setting('test.ac35j', true) || ' ' || public._t187_view(111),
  'P0002: vendor b1870002-0000-0000-0000-000000000001 not found '
  || '0a|0a|Person 0a (t187)|oa187-0a@local.test|backdated|pending|0',
  'AC-35j the NULL-brand user profile with an admin claim can''t re-stamp through the RPC either (refused earlier, vendor hidden), row unchanged');

select is(current_setting('test.ac35f', true) || ' ' || public._t187_view(103),
  'ok:1 ok:1 b0|b0|Person b0 (t187)|oa187-b0@local.test|now|approved|1',
  'AC-35f a master profile can create and approve its own row (and its padded name is stored trimmed)');

select is(current_setting('test.ac35g', true) || ' ' || public._t187_view(104),
  'ok:1 ok:1 a0|a0|Person a0 (t187)|oa187-a0@local.test|now|approved|1',
  'AC-35g a super_admin profile can create and approve its own row');

select is(current_setting('test.ac37a', true) || ' ' || coalesce(public._t187_view(109), '<no row>'),
  'P0001: order approval caller is not an admin <no row>',
  'AC-37a a stale admin claim can''t INSERT a pending row through the RPC, and no row is created');

select is(current_setting('test.ac37b', true) || ' ' || public._t187_view(105),
  'ok:1 0a|0a|Person 0a (t187)|oa187-0a@local.test|backdated|ordered|0',
  'AC-37b KNOWN GAP until the auth_is_admin() / auth_is_privileged() convergence spec (named in spec 191, not yet filed): a stale admin claim can still move an approved row to ordered');


-- ─── WHO MAY INSERT (release re-proposal M-R1) ────────────────
select is(current_setting('test.ac38a', true) || ' ' || public._t187_count(113, 115),
  'P0001: order approval caller is not an admin / '
  || 'P0001: order approval must be inserted as pending / '
  || 'P0001: order approval must be inserted as pending 0',
  'AC-38a a same-brand user profile with an admin claim can''t directly INSERT at pending, approved or ordered, and no row is created');

select is(current_setting('test.ac38b', true) || ' ' || public._t187_count(116, 118),
  'P0001: order approval caller is not an admin / '
  || 'P0001: order approval must be inserted as pending / '
  || 'P0001: order approval must be inserted as pending 0',
  'AC-38b a NULL-brand store-linked user profile with an admin claim can''t either');

select is(current_setting('test.ac38c', true) || ' ' || public._t187_count(119, 120),
  'P0001: order approval must be inserted as pending / '
  || 'P0001: order approval must be inserted as pending 0',
  'AC-38c a real admin can''t directly INSERT a row that is already approved or ordered');

select is(current_setting('test.ac38d_pg', true) || ' ' || current_setting('test.ac38d_sr', true) || ' '
          || public._t187_view(121) || ' ' || public._t187_view(122) || ' '
          || public._t187_view(123) || ' ' || public._t187_view(124),
  'ok:1 ok:1 ok:1 ok:1 '
  || '0a|0a|Person 0a (t187)|oa187-0a@local.test|now|approved|0 '
  || '0a|0a|Person 0a (t187)|oa187-0a@local.test|now|ordered|0 '
  || '0a|0a|Person 0a (t187)|oa187-0a@local.test|now|approved|0 '
  || '0a|0a|Person 0a (t187)|oa187-0a@local.test|now|ordered|0',
  'AC-38d postgres and service_role with no claims can still insert approved and ordered rows, and the stamp fills the snapshot');

select * from finish();
rollback;
