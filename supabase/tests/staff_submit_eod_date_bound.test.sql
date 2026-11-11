-- supabase/tests/staff_submit_eod_date_bound.test.sql
--
-- Spec 193 — pgTAP coverage for
-- supabase/migrations/20261109190000_staff_eod_date_bound.sql:
--   • the staff_submit_eod date window (design §6.1), and
--   • the R9 'Count cleared' audit in eod_write_submission's
--     p_removed_item_ids NULL branch (design §6.5).
--
-- A = (now() at time zone 'America/New_York')::date, computed once in the
-- fixture (test.anchor). now() is the transaction start, so A can't move
-- mid-suite. "The refusal" is SQLSTATE 22023 with the constant message
-- 'staff_submit_eod: p_date is outside the staff window (35 days back to 1 day
-- ahead, America/New_York)'.
--
-- Arm map (plan 69):
--   DB  (1-6)   AC-1 / AC-13 / AC-2 / AC-14: first-time A-36 and A+2 refuse
--               and leave no parent; A-35 and A+1 succeed (conflict false).
--   DS  (7-8)   AC-3 / R5: over a seeded A-36 submission S, the refusal
--               leaves S, its entries, on-hand, notifications and the store's
--               audit_log count unchanged.
--   DL  (9)     AC-4 lint: SQLSTATE <> 42501, and the message holds none of
--               the client's dequeue / network substrings.
--   DR  (10-11) AC-6: a replay of S's stored client_uuid is conflict = true
--               with S's id, and nothing changes.
--   DG  (12)    AC-7: an out-of-membership caller at A-36 gets 42501.
--   DN  (13-14) AC-20: p_date NULL refuses; nothing written.
--   DT  (15-22) AC-21 / R6: under Etc/GMT-14 and Etc/GMT+12 the bounds hold.
--   DP  (23-28) AC-5: JWT admin, JWT master and profiles.role = super_admin
--               each succeed at A-36 and A+2.
--   DK  (29-36) AC-8 catalog + R6 structural pins on staff_submit_eod.
--   R9  (37-60) AC-22..AC-27: 'Count cleared' rows for dropped items only,
--               value shapes, first submit / replay / full re-send write
--               none, every refusal and writer error rolls them back, and a
--               privileged caller of the staff RPC is audited the same way.
--   RK  (61-69) AC-28: eod_write_submission catalog, ACL and structure.
--
-- Fixture posture: every vendor, catalog row, item and link is created INSIDE
-- the transaction (tagged SPEC193-*-<tag>), so every triple is fresh by
-- construction and no pre-delete is needed. Principals: seed manager 2222
-- (role 'user', member of Frederick, not Charles), seed admin 1111 (admin,
-- Frederick's brand), seed master 3333 (master, then promoted to
-- profiles.role = 'super_admin' inside the transaction for the super_admin
-- arms). Every "unchanged" / "no row" claim is read back as postgres
-- (`reset role`, claims cleared). No `set role anon` (segfaults CI per spec
-- 067). Hermetic: begin; … rollback;.

begin;
create extension if not exists pgtap;

select plan(69);

-- ─── fixtures (as postgres) ─────────────────────────────────────
do $$
declare
  v_frederick uuid;
  v_charles   uuid;
  v_brand     uuid;
  v_tag       text := substr(gen_random_uuid()::text, 1, 8);
  v_v         uuid;
  v_v2        uuid;
  v_vr        uuid;
  v_a         date := (now() at time zone 'America/New_York')::date;
begin
  select id, brand_id into v_frederick, v_brand from public.stores where name = 'Frederick' limit 1;
  select id into v_charles from public.stores where name = 'Charles' limit 1;

  insert into public.vendors (name, brand_id) values ('SPEC193-V-'  || v_tag, v_brand) returning id into v_v;
  insert into public.vendors (name, brand_id) values ('SPEC193-V2-' || v_tag, v_brand) returning id into v_v2;
  insert into public.vendors (name, brand_id) values ('SPEC193-VR-' || v_tag, v_brand) returning id into v_vr;

  perform set_config('test.anchor',    v_a::text,          true);
  perform set_config('test.tag',       v_tag,              true);
  perform set_config('test.frederick', v_frederick::text,  true);
  perform set_config('test.charles',   v_charles::text,    true);
  perform set_config('test.brand',     v_brand::text,      true);
  perform set_config('test.v',         v_v::text,          true);
  perform set_config('test.v2',        v_v2::text,         true);
  perform set_config('test.vr',        v_vr::text,         true);
  perform set_config('test.manager_id', '22222222-2222-2222-2222-222222222222', true);
  perform set_config('test.admin_id',   '11111111-1111-1111-1111-111111111111', true);
  perform set_config('test.master_id',  '33333333-3333-3333-3333-333333333333', true);
  perform set_config('test.msg',
    'staff_submit_eod: p_date is outside the staff window (35 days back to 1 day ahead, America/New_York)', true);
  perform set_config('test.msg_o1', 'staff_submit_eod: p_entries must be a non-empty array', true);
  perform set_config('test.claims_user', jsonb_build_object(
    'sub', '22222222-2222-2222-2222-222222222222', 'role', 'authenticated',
    'app_metadata', jsonb_build_object('role', 'user'))::text, true);
  perform set_config('test.claims_admin', jsonb_build_object(
    'sub', '11111111-1111-1111-1111-111111111111', 'role', 'authenticated',
    'app_metadata', jsonb_build_object('role', 'admin'))::text, true);
  perform set_config('test.claims_master', jsonb_build_object(
    'sub', '33333333-3333-3333-3333-333333333333', 'role', 'authenticated',
    'app_metadata', jsonb_build_object('role', 'master'))::text, true);
  -- The super_admin arms: JWT role 'user', privileged only through
  -- profiles.role (set just before those arms).
  perform set_config('test.claims_super', jsonb_build_object(
    'sub', '33333333-3333-3333-3333-333333333333', 'role', 'authenticated',
    'app_metadata', jsonb_build_object('role', 'user'))::text, true);
end $$;

-- C1..C4 (unit lbs) and I1..I4 at Frederick, on-hand 42/42, each linked to
-- VR; I1 and I2 also linked to V (the date-bound S). The seeded on-hand (42)
-- differs from every seeded entry value, so "on-hand unchanged" can fail.
create temp table _cat on commit drop as
with ins as (
  insert into public.catalog_ingredients (brand_id, name, unit)
  select current_setting('test.brand', true)::uuid,
         'SPEC193-C' || k || '-' || current_setting('test.tag', true),
         'lbs'
    from unnest(array['1','2','3','4']) as k
  returning id, name
)
select id, name, split_part(name, '-', 2) as kind from ins;

create temp table _items on commit drop as
with ins as (
  insert into public.inventory_items
    (store_id, catalog_id, vendor_id, cost_per_unit, current_stock, eod_remaining,
     par_level, usage_per_portion, updated_at)
  select current_setting('test.frederick', true)::uuid, c.id,
         current_setting('test.vr', true)::uuid, 1, 42, 42, 10, 0,
         '2000-01-01 00:00:00+00'::timestamptz
    from _cat c
  returning id, catalog_id
)
select i.id, c.kind, c.name from ins i join _cat c on c.id = i.catalog_id;

do $$
declare r record;
begin
  for r in select kind, id, name from _items loop
    -- kind is 'C1'..'C4'; item settings are test.i1..test.i4, names test.n1..n4.
    perform set_config('test.i' || right(r.kind, 1), r.id::text, true);
    perform set_config('test.n' || right(r.kind, 1), r.name, true);
  end loop;
end $$;

insert into public.item_vendors (item_id, vendor_id, cost_per_unit, case_price, is_primary)
select i.id, current_setting('test.vr', true)::uuid, 1, 0, true from _items i
union all
select i.id, current_setting('test.v', true)::uuid, 1, 0, false
  from _items i where i.kind in ('C1', 'C2')
on conflict (item_id, vendor_id) do nothing;

-- Seeded submissions (as postgres; status submitted, fixed submitted_at).
--   S   (A-36, V)  I1=10, I2=20, client_uuid X  — date-bound AC-3 / AC-6
--   S_a (A-20, VR) I1=10, I2=20                  — AC-22
--   S_b (A-21, VR) I1=10, I3 NO NEED, I4 NULL    — AC-23
--   S_c (A-22, VR) I1=10, I2=20, client_uuid Xc  — AC-25
--   S_d (A-23, VR) I1=10, I2=20                  — AC-26 (O-1, 23514, 23505)
--   S_e (A-24, VR) I1=10, I2=20                  — AC-27
--   S_f (A-36, VR) I1=10, I2=20                  — AC-26 (date refusal)
--   (A-25, VR) is left empty for the AC-24 first submit.
do $$
declare
  v_a   date := current_setting('test.anchor', true)::date;
  v_fr  uuid := current_setting('test.frederick', true)::uuid;
  v_vr  uuid := current_setting('test.vr', true)::uuid;
  v_i1  uuid := current_setting('test.i1', true)::uuid;
  v_i2  uuid := current_setting('test.i2', true)::uuid;
  v_i3  uuid := current_setting('test.i3', true)::uuid;
  v_i4  uuid := current_setting('test.i4', true)::uuid;
  v_sub uuid;
  r     record;
begin
  perform set_config('test.x',  gen_random_uuid()::text, true);
  perform set_config('test.xc', gen_random_uuid()::text, true);

  for r in
    select * from (values
      ('s',   36, current_setting('test.v', true)::uuid, current_setting('test.x', true)::uuid),
      ('s_a', 20, v_vr, gen_random_uuid()),
      ('s_c', 22, v_vr, current_setting('test.xc', true)::uuid),
      ('s_d', 23, v_vr, gen_random_uuid()),
      ('s_e', 24, v_vr, gen_random_uuid()),
      ('s_f', 36, v_vr, gen_random_uuid())
    ) t(name, k, vendor, cu)
  loop
    insert into public.eod_submissions (store_id, date, vendor_id, status, submitted_at, client_uuid)
    values (v_fr, v_a - r.k, r.vendor, 'submitted', '2000-01-01 00:00:00+00'::timestamptz, r.cu)
    returning id into v_sub;
    insert into public.eod_entries (submission_id, item_id, actual_remaining, notes, no_need)
    values (v_sub, v_i1, 10, '', false),
           (v_sub, v_i2, 20, '', false);
    perform set_config('test.' || r.name, v_sub::text, true);
  end loop;

  insert into public.eod_submissions (store_id, date, vendor_id, status, submitted_at, client_uuid)
  values (v_fr, v_a - 21, v_vr, 'submitted', '2000-01-01 00:00:00+00'::timestamptz, gen_random_uuid())
  returning id into v_sub;
  insert into public.eod_entries (submission_id, item_id, actual_remaining, notes, no_need)
  values (v_sub, v_i1, 10,   '', false),
         (v_sub, v_i3, null, '', true),
         (v_sub, v_i4, null, '', false);
  perform set_config('test.s_b', v_sub::text, true);
end $$;

-- ─── read-back helpers (called as postgres only) ────────────────
create function pg_temp.sub_at(p_k int, p_vendor uuid) returns uuid
language sql as $$
  select id from public.eod_submissions
   where store_id = current_setting('test.frederick', true)::uuid
     and date = current_setting('test.anchor', true)::date - p_k
     and vendor_id = p_vendor
$$;

-- Entries with ids, sorted by item name.
create function pg_temp.entries_of(p_sub uuid) returns text
language sql as $$
  select coalesce(string_agg(
           e.id::text || ':' || split_part(ci.name, '-', 2) || '='
           || coalesce(trim_scale(e.actual_remaining)::text, 'null')
           || case when e.no_need then '/NN' else '' end,
           ',' order by ci.name), '')
    from public.eod_entries e
    join public.inventory_items ii on ii.id = e.item_id
    join public.catalog_ingredients ci on ci.id = ii.catalog_id
   where e.submission_id = p_sub
$$;

-- Everything a refusal must leave alone: the parent, its entries (ids and
-- values), I1..I4 on-hand, notifications for the submission, and the
-- store's audit_log row count.
create function pg_temp.state_of(p_sub uuid) returns text
language sql as $$
  select concat_ws(' | ',
    (select s.status || '@' || s.submitted_at::text || '@' || coalesce(s.client_uuid::text, '-')
       from public.eod_submissions s where s.id = p_sub),
    pg_temp.entries_of(p_sub),
    (select string_agg(split_part(ci.name, '-', 2) || ':' || ii.current_stock::text || '/'
                       || ii.eod_remaining::text, ',' order by ci.name)
       from public.inventory_items ii
       join public.catalog_ingredients ci on ci.id = ii.catalog_id
      where ci.name like 'SPEC193-%-' || current_setting('test.tag', true)),
    (select count(*)::text from public.notifications n
      where coalesce(n.submission_id, n.source_id) = p_sub),
    (select count(*)::text from public.audit_log a
      where a.store_id = current_setting('test.frederick', true)::uuid))
$$;

-- 'Count cleared' rows for Frederick with that item_ref.
create function pg_temp.cc(p_item_ref text) returns int
language sql as $$
  select count(*)::int from public.audit_log
   where store_id = current_setting('test.frederick', true)::uuid
     and action = 'EOD entry'
     and detail like 'Count cleared%'
     and item_ref = p_item_ref
$$;

-- 'Count cleared' rows for Frederick over every SPEC193 item.
create function pg_temp.cc_all() returns int
language sql as $$
  select count(*)::int from public.audit_log
   where store_id = current_setting('test.frederick', true)::uuid
     and action = 'EOD entry'
     and detail like 'Count cleared%'
     and item_ref like 'SPEC193-%-' || current_setting('test.tag', true)
$$;

-- Per-entry staff rows (user_id NULL, not 'Count cleared') for that item_ref.
create function pg_temp.pe(p_item_ref text) returns int
language sql as $$
  select count(*)::int from public.audit_log
   where store_id = current_setting('test.frederick', true)::uuid
     and action = 'EOD entry'
     and user_id is null
     and detail not like 'Count cleared%'
     and item_ref = p_item_ref
$$;

create function pg_temp.fred_audit() returns int
language sql as $$
  select count(*)::int from public.audit_log
   where store_id = current_setting('test.frederick', true)::uuid
$$;


-- ═══ DB — AC-1 / AC-13 / AC-2 / AC-14 (store member) ═════════════
set local role authenticated;
select set_config('request.jwt.claims', current_setting('test.claims_user', true), true);

select throws_ok(
  format($q$select public.staff_submit_eod(gen_random_uuid(), %L::uuid, %L::date, null, 'submitted',
              jsonb_build_array(jsonb_build_object('ingredient_id', %L::uuid, 'actual_remaining', 5)), %L::uuid)$q$,
    current_setting('test.frederick', true),
    current_setting('test.anchor', true)::date - 36,
    current_setting('test.i1', true),
    current_setting('test.v2', true)),
  '22023', current_setting('test.msg', true),
  '(1) AC-1/AC-13/AC-4: a store member''s first-time submit at A - 36 raises 22023 with the window message');

select throws_ok(
  format($q$select public.staff_submit_eod(gen_random_uuid(), %L::uuid, %L::date, null, 'submitted',
              jsonb_build_array(jsonb_build_object('ingredient_id', %L::uuid, 'actual_remaining', 5)), %L::uuid)$q$,
    current_setting('test.frederick', true),
    current_setting('test.anchor', true)::date + 2,
    current_setting('test.i1', true),
    current_setting('test.v2', true)),
  '22023', current_setting('test.msg', true),
  '(2) AC-14: a store member''s submit at A + 2 raises the same 22023 and message');

select is(
  (public.staff_submit_eod(gen_random_uuid(), current_setting('test.frederick', true)::uuid,
     current_setting('test.anchor', true)::date - 35, null, 'submitted',
     jsonb_build_array(jsonb_build_object('ingredient_id', current_setting('test.i1', true)::uuid, 'actual_remaining', 5)),
     current_setting('test.v2', true)::uuid)) ->> 'conflict',
  'false',
  '(3) AC-2: a store member''s submit at A - 35 (lower bound, inclusive) succeeds with conflict = false');

select is(
  (public.staff_submit_eod(gen_random_uuid(), current_setting('test.frederick', true)::uuid,
     current_setting('test.anchor', true)::date + 1, null, 'submitted',
     jsonb_build_array(jsonb_build_object('ingredient_id', current_setting('test.i1', true)::uuid, 'actual_remaining', 5)),
     current_setting('test.v2', true)::uuid)) ->> 'conflict',
  'false',
  '(4) AC-14: a store member''s submit at A + 1 (upper bound, inclusive) succeeds with conflict = false');

reset role;
select set_config('request.jwt.claims', '', true);

select is(pg_temp.sub_at(36, current_setting('test.v2', true)::uuid), null::uuid,
  '(5) AC-13: the refused first-time A - 36 call left no parent at (Frederick, A - 36, V2)');

select is(pg_temp.sub_at(-2, current_setting('test.v2', true)::uuid), null::uuid,
  '(6) AC-14: the refused A + 2 call left no parent at (Frederick, A + 2, V2)');


-- ═══ DS — AC-3 / R5 over the seeded A - 36 submission S ══════════
select set_config('test.state_s', pg_temp.state_of(current_setting('test.s', true)::uuid), true);

set local role authenticated;
select set_config('request.jwt.claims', current_setting('test.claims_user', true), true);
select throws_ok(
  format($q$select public.staff_submit_eod(gen_random_uuid(), %L::uuid, %L::date, null, 'submitted',
              jsonb_build_array(jsonb_build_object('ingredient_id', %L::uuid, 'actual_remaining', 99)), %L::uuid)$q$,
    current_setting('test.frederick', true),
    current_setting('test.anchor', true)::date - 36,
    current_setting('test.i1', true),
    current_setting('test.v', true)),
  '22023', current_setting('test.msg', true),
  '(7) AC-3: a store member''s re-submit over the existing A - 36 submission raises the refusal');
reset role;
select set_config('request.jwt.claims', '', true);

select is(pg_temp.state_of(current_setting('test.s', true)::uuid), current_setting('test.state_s', true),
  '(8) AC-3/R5: S''s status, submitted_at, client_uuid, entries, on-hand, notifications and Frederick''s audit_log count are unchanged');


-- ═══ DL — AC-4 lint: not 42501, no client-classifier substring ═══
set local role authenticated;
select set_config('request.jwt.claims', current_setting('test.claims_user', true), true);
do $$
begin
  perform public.staff_submit_eod(gen_random_uuid(), current_setting('test.frederick', true)::uuid,
    current_setting('test.anchor', true)::date - 36, null, 'submitted',
    jsonb_build_array(jsonb_build_object('ingredient_id', current_setting('test.i1', true)::uuid, 'actual_remaining', 5)),
    current_setting('test.v2', true)::uuid);
  perform set_config('test.lint_state', 'no error', true);
  perform set_config('test.lint_msg', '', true);
exception when others then
  perform set_config('test.lint_state', sqlstate, true);
  perform set_config('test.lint_msg', sqlerrm, true);
end $$;
reset role;
select set_config('request.jwt.claims', '', true);

select ok(
  current_setting('test.lint_state', true) = '22023'
  and current_setting('test.lint_state', true) <> '42501'
  and current_setting('test.lint_msg', true) !~* '42501|network request failed|failed to fetch|aborted|timeout|network',
  '(9) AC-4: the refusal''s SQLSTATE is not 42501 and its message has no 42501 / network / abort / timeout text (stays in the drain''s retry branch)');


-- ═══ DR — AC-6 idempotent replay at A - 36 ═══════════════════════
set local role authenticated;
select set_config('request.jwt.claims', current_setting('test.claims_user', true), true);
select set_config('test.r_replay', public.staff_submit_eod(
  current_setting('test.x', true)::uuid, current_setting('test.frederick', true)::uuid,
  current_setting('test.anchor', true)::date - 36, null, 'submitted',
  jsonb_build_array(jsonb_build_object('ingredient_id', current_setting('test.i1', true)::uuid, 'actual_remaining', 99)),
  current_setting('test.v', true)::uuid)::text, true);
reset role;
select set_config('request.jwt.claims', '', true);

select is(
  (current_setting('test.r_replay', true)::jsonb ->> 'conflict')
    || '|' || (current_setting('test.r_replay', true)::jsonb ->> 'submission_id'),
  'true|' || current_setting('test.s', true),
  '(10) AC-6: a store member replaying S''s stored client_uuid at A - 36 gets conflict = true and S''s id');

select is(pg_temp.state_of(current_setting('test.s', true)::uuid), current_setting('test.state_s', true),
  '(11) AC-6: the replay changed nothing on S');


-- ═══ DG — AC-7 precedence: the store gate fires first ═══════════
set local role authenticated;
select set_config('request.jwt.claims', current_setting('test.claims_user', true), true);
select throws_ok(
  format($q$select public.staff_submit_eod(gen_random_uuid(), %L::uuid, %L::date, null, 'submitted',
              jsonb_build_array(jsonb_build_object('ingredient_id', %L::uuid, 'actual_remaining', 5)), %L::uuid)$q$,
    current_setting('test.charles', true),
    current_setting('test.anchor', true)::date - 36,
    current_setting('test.i1', true),
    current_setting('test.v2', true)),
  '42501', null,
  '(12) AC-7: a store member calling for Charles (not a member) at A - 36 gets 42501 from the store gate, not the window refusal');


-- ═══ DN — AC-20 p_date NULL ══════════════════════════════════════
select set_config('test.null_uuid', gen_random_uuid()::text, true);
select throws_ok(
  format($q$select public.staff_submit_eod(%L::uuid, %L::uuid, null::date, null, 'submitted',
              jsonb_build_array(jsonb_build_object('ingredient_id', %L::uuid, 'actual_remaining', 5)), %L::uuid)$q$,
    current_setting('test.null_uuid', true),
    current_setting('test.frederick', true),
    current_setting('test.i1', true),
    current_setting('test.v2', true)),
  '22023', current_setting('test.msg', true),
  '(13) AC-20: a store member with p_date NULL gets the window refusal');
reset role;
select set_config('request.jwt.claims', '', true);

select is(
  (select count(*)::int from public.eod_submissions
    where client_uuid = current_setting('test.null_uuid', true)::uuid),
  0,
  '(14) AC-20: the p_date NULL refusal wrote no parent');


-- ═══ DT — AC-21 / R6: the anchor ignores the session TimeZone ═══
set local role authenticated;
select set_config('request.jwt.claims', current_setting('test.claims_user', true), true);

set local timezone = 'Etc/GMT-14';
select throws_ok(
  format($q$select public.staff_submit_eod(gen_random_uuid(), %L::uuid, %L::date, null, 'submitted',
              jsonb_build_array(jsonb_build_object('ingredient_id', %L::uuid, 'actual_remaining', 5)), %L::uuid)$q$,
    current_setting('test.frederick', true), current_setting('test.anchor', true)::date - 36,
    current_setting('test.i1', true), current_setting('test.v2', true)),
  '22023', current_setting('test.msg', true),
  '(15) AC-21: under TimeZone Etc/GMT-14, A - 36 still refuses');
select throws_ok(
  format($q$select public.staff_submit_eod(gen_random_uuid(), %L::uuid, %L::date, null, 'submitted',
              jsonb_build_array(jsonb_build_object('ingredient_id', %L::uuid, 'actual_remaining', 5)), %L::uuid)$q$,
    current_setting('test.frederick', true), current_setting('test.anchor', true)::date + 2,
    current_setting('test.i1', true), current_setting('test.v2', true)),
  '22023', current_setting('test.msg', true),
  '(16) AC-21: under TimeZone Etc/GMT-14, A + 2 still refuses');
select lives_ok(
  format($q$select public.staff_submit_eod(gen_random_uuid(), %L::uuid, %L::date, null, 'submitted',
              jsonb_build_array(jsonb_build_object('ingredient_id', %L::uuid, 'actual_remaining', 5)), %L::uuid)$q$,
    current_setting('test.frederick', true), current_setting('test.anchor', true)::date - 35,
    current_setting('test.i1', true), current_setting('test.v2', true)),
  '(17) AC-21: under TimeZone Etc/GMT-14, A - 35 still succeeds');
select lives_ok(
  format($q$select public.staff_submit_eod(gen_random_uuid(), %L::uuid, %L::date, null, 'submitted',
              jsonb_build_array(jsonb_build_object('ingredient_id', %L::uuid, 'actual_remaining', 5)), %L::uuid)$q$,
    current_setting('test.frederick', true), current_setting('test.anchor', true)::date + 1,
    current_setting('test.i1', true), current_setting('test.v2', true)),
  '(18) AC-21: under TimeZone Etc/GMT-14, A + 1 still succeeds');

set local timezone = 'Etc/GMT+12';
select throws_ok(
  format($q$select public.staff_submit_eod(gen_random_uuid(), %L::uuid, %L::date, null, 'submitted',
              jsonb_build_array(jsonb_build_object('ingredient_id', %L::uuid, 'actual_remaining', 5)), %L::uuid)$q$,
    current_setting('test.frederick', true), current_setting('test.anchor', true)::date - 36,
    current_setting('test.i1', true), current_setting('test.v2', true)),
  '22023', current_setting('test.msg', true),
  '(19) AC-21: under TimeZone Etc/GMT+12, A - 36 still refuses');
select throws_ok(
  format($q$select public.staff_submit_eod(gen_random_uuid(), %L::uuid, %L::date, null, 'submitted',
              jsonb_build_array(jsonb_build_object('ingredient_id', %L::uuid, 'actual_remaining', 5)), %L::uuid)$q$,
    current_setting('test.frederick', true), current_setting('test.anchor', true)::date + 2,
    current_setting('test.i1', true), current_setting('test.v2', true)),
  '22023', current_setting('test.msg', true),
  '(20) AC-21: under TimeZone Etc/GMT+12, A + 2 still refuses');
select lives_ok(
  format($q$select public.staff_submit_eod(gen_random_uuid(), %L::uuid, %L::date, null, 'submitted',
              jsonb_build_array(jsonb_build_object('ingredient_id', %L::uuid, 'actual_remaining', 5)), %L::uuid)$q$,
    current_setting('test.frederick', true), current_setting('test.anchor', true)::date - 35,
    current_setting('test.i1', true), current_setting('test.v2', true)),
  '(21) AC-21: under TimeZone Etc/GMT+12, A - 35 still succeeds');
select lives_ok(
  format($q$select public.staff_submit_eod(gen_random_uuid(), %L::uuid, %L::date, null, 'submitted',
              jsonb_build_array(jsonb_build_object('ingredient_id', %L::uuid, 'actual_remaining', 5)), %L::uuid)$q$,
    current_setting('test.frederick', true), current_setting('test.anchor', true)::date + 1,
    current_setting('test.i1', true), current_setting('test.v2', true)),
  '(22) AC-21: under TimeZone Etc/GMT+12, A + 1 still succeeds');

reset timezone;
reset role;
select set_config('request.jwt.claims', '', true);


-- ═══ DP — AC-5 privileged exemption (after the "no row" arms) ════
set local role authenticated;

select set_config('request.jwt.claims', current_setting('test.claims_admin', true), true);
select is(
  (public.staff_submit_eod(gen_random_uuid(), current_setting('test.frederick', true)::uuid,
     current_setting('test.anchor', true)::date - 36, null, 'submitted',
     jsonb_build_array(jsonb_build_object('ingredient_id', current_setting('test.i1', true)::uuid, 'actual_remaining', 5)),
     current_setting('test.v2', true)::uuid)) ->> 'conflict',
  'false', '(23) AC-5: JWT admin succeeds at A - 36');
select is(
  (public.staff_submit_eod(gen_random_uuid(), current_setting('test.frederick', true)::uuid,
     current_setting('test.anchor', true)::date + 2, null, 'submitted',
     jsonb_build_array(jsonb_build_object('ingredient_id', current_setting('test.i1', true)::uuid, 'actual_remaining', 5)),
     current_setting('test.v2', true)::uuid)) ->> 'conflict',
  'false', '(24) AC-5: JWT admin succeeds at A + 2');

select set_config('request.jwt.claims', current_setting('test.claims_master', true), true);
select is(
  (public.staff_submit_eod(gen_random_uuid(), current_setting('test.frederick', true)::uuid,
     current_setting('test.anchor', true)::date - 36, null, 'submitted',
     jsonb_build_array(jsonb_build_object('ingredient_id', current_setting('test.i1', true)::uuid, 'actual_remaining', 5)),
     current_setting('test.v2', true)::uuid)) ->> 'conflict',
  'false', '(25) AC-5: JWT master succeeds at A - 36');
select is(
  (public.staff_submit_eod(gen_random_uuid(), current_setting('test.frederick', true)::uuid,
     current_setting('test.anchor', true)::date + 2, null, 'submitted',
     jsonb_build_array(jsonb_build_object('ingredient_id', current_setting('test.i1', true)::uuid, 'actual_remaining', 5)),
     current_setting('test.v2', true)::uuid)) ->> 'conflict',
  'false', '(26) AC-5: JWT master succeeds at A + 2');

-- Promote the seed master's PROFILE to super_admin (as postgres, claims
-- cleared, so the profiles self-edit guards don't fire), then call with a
-- JWT role of 'user': privileged only through profiles.role.
reset role;
select set_config('request.jwt.claims', '', true);
update public.profiles
   set role = 'super_admin', brand_id = null
 where id = current_setting('test.master_id', true)::uuid;
set local role authenticated;

select set_config('request.jwt.claims', current_setting('test.claims_super', true), true);
select is(
  (public.staff_submit_eod(gen_random_uuid(), current_setting('test.frederick', true)::uuid,
     current_setting('test.anchor', true)::date - 36, null, 'submitted',
     jsonb_build_array(jsonb_build_object('ingredient_id', current_setting('test.i1', true)::uuid, 'actual_remaining', 5)),
     current_setting('test.v2', true)::uuid)) ->> 'conflict',
  'false', '(27) AC-5: profiles.role = super_admin (JWT role user) succeeds at A - 36');
select is(
  (public.staff_submit_eod(gen_random_uuid(), current_setting('test.frederick', true)::uuid,
     current_setting('test.anchor', true)::date + 2, null, 'submitted',
     jsonb_build_array(jsonb_build_object('ingredient_id', current_setting('test.i1', true)::uuid, 'actual_remaining', 5)),
     current_setting('test.v2', true)::uuid)) ->> 'conflict',
  'false', '(28) AC-5: profiles.role = super_admin (JWT role user) succeeds at A + 2');

reset role;
select set_config('request.jwt.claims', '', true);


-- ═══ DK — AC-8 catalog + R6 structural pins ══════════════════════
select ok(
  to_regprocedure('public.staff_submit_eod(uuid, uuid, date, text, text, jsonb, uuid)') is not null,
  '(29) AC-8: staff_submit_eod keeps its 7-argument signature');
select is(
  (select prosecdef from pg_proc where oid = 'public.staff_submit_eod(uuid, uuid, date, text, text, jsonb, uuid)'::regprocedure),
  true, '(30) AC-8: staff_submit_eod is still SECURITY DEFINER');
select ok(
  (select 'search_path=public' = any (proconfig)
     from pg_proc where oid = 'public.staff_submit_eod(uuid, uuid, date, text, text, jsonb, uuid)'::regprocedure),
  '(31) AC-8: staff_submit_eod pins search_path = public');
select ok(has_function_privilege('authenticated',
  'public.staff_submit_eod(uuid, uuid, date, text, text, jsonb, uuid)', 'execute'),
  '(32) AC-8: authenticated keeps EXECUTE on staff_submit_eod');
select ok(not has_function_privilege('anon',
  'public.staff_submit_eod(uuid, uuid, date, text, text, jsonb, uuid)', 'execute'),
  '(33) AC-8: anon lacks EXECUTE on staff_submit_eod');
select ok(not has_function_privilege('service_role',
  'public.staff_submit_eod(uuid, uuid, date, text, text, jsonb, uuid)', 'execute'),
  '(34) AC-8: service_role lacks EXECUTE on staff_submit_eod');
select ok(
  (select prosrc from pg_proc where oid = 'public.staff_submit_eod(uuid, uuid, date, text, text, jsonb, uuid)'::regprocedure)
    like '%America/New_York%',
  '(35) R6: staff_submit_eod anchors the window on America/New_York');
select ok(
  (select prosrc from pg_proc where oid = 'public.staff_submit_eod(uuid, uuid, date, text, text, jsonb, uuid)'::regprocedure)
    not like '%current_date%',
  '(36) R6: staff_submit_eod does not use current_date (session TimeZone would move it)');


-- ═══ R9 — AC-22 probe P7 re-run over S_a ═════════════════════════
select set_config('test.cc0', pg_temp.cc_all()::text, true);
select set_config('test.cc_c1', pg_temp.cc(current_setting('test.n1', true))::text, true);
select set_config('test.pe_c1', pg_temp.pe(current_setting('test.n1', true))::text, true);

set local role authenticated;
select set_config('request.jwt.claims', current_setting('test.claims_user', true), true);
select public.staff_submit_eod(gen_random_uuid(), current_setting('test.frederick', true)::uuid,
  current_setting('test.anchor', true)::date - 20, null, 'submitted',
  jsonb_build_array(jsonb_build_object('ingredient_id', current_setting('test.i1', true)::uuid,
                                       'actual_remaining', 11, 'unit', 'lbs')),
  current_setting('test.vr', true)::uuid);
reset role;
select set_config('request.jwt.claims', '', true);

select is(
  regexp_replace(pg_temp.entries_of(current_setting('test.s_a', true)::uuid), '^[0-9a-f-]+:', ''),
  'C1=11',
  '(37) AC-22: after the one-entry re-submit S_a holds only I1 = 11 (full replace unchanged)');
select is(pg_temp.cc_all() - current_setting('test.cc0', true)::int, 1,
  '(38) AC-22: exactly one new Count cleared row across the SPEC193 items');
select is(
  (select format('%s|%s|%s|%s|%s', a.store_id, a.user_id, a.detail, a.item_ref, a.value)
     from public.audit_log a
    where a.store_id = current_setting('test.frederick', true)::uuid
      and a.action = 'EOD entry'
      and a.detail like 'Count cleared%'
      and a.item_ref = current_setting('test.n2', true)),
  format('%s|%s|%s|%s|%s',
    current_setting('test.frederick', true), current_setting('test.manager_id', true),
    'Count cleared · vendor: SPEC193-VR-' || current_setting('test.tag', true),
    current_setting('test.n2', true), '20 lbs'),
  '(39) AC-22 probe P7 re-run: a staff full replace that drops I2 writes one Count cleared row for it (189 M1)');
select is(pg_temp.cc(current_setting('test.n1', true)) - current_setting('test.cc_c1', true)::int, 0,
  '(40) AC-22: no Count cleared row names the re-sent I1');
select is(pg_temp.pe(current_setting('test.n1', true)) - current_setting('test.pe_c1', true)::int, 1,
  '(41) AC-22: I1 gets exactly one new per-entry staff row');
select is(
  (select a.detail from public.audit_log a
    where a.store_id = current_setting('test.frederick', true)::uuid
      and a.action = 'EOD entry'
      and a.user_id is null
      and a.detail not like 'Count cleared%'
      and a.detail like '% · vendor: SPEC193-VR-' || current_setting('test.tag', true)
      and a.item_ref = current_setting('test.n1', true)),
  current_setting('test.manager_id', true) || ' · vendor: SPEC193-VR-' || current_setting('test.tag', true),
  '(42) AC-22: I1''s per-entry row under VR keeps today''s shape (user_id NULL, detail = caller uid · vendor; the only VR row so far)');


-- ═══ R9 — AC-23 value shapes and on-hand over S_b ════════════════
set local role authenticated;
select set_config('request.jwt.claims', current_setting('test.claims_user', true), true);
select public.staff_submit_eod(gen_random_uuid(), current_setting('test.frederick', true)::uuid,
  current_setting('test.anchor', true)::date - 21, null, 'submitted',
  jsonb_build_array(jsonb_build_object('ingredient_id', current_setting('test.i1', true)::uuid,
                                       'actual_remaining', 12, 'unit', 'lbs')),
  current_setting('test.vr', true)::uuid);
reset role;
select set_config('request.jwt.claims', '', true);

select is(
  (select string_agg(split_part(a.item_ref, '-', 2) || '=' || a.value, ',' order by a.item_ref)
     from public.audit_log a
    where a.store_id = current_setting('test.frederick', true)::uuid
      and a.action = 'EOD entry'
      and a.detail like 'Count cleared%'
      and a.item_ref in (current_setting('test.n3', true), current_setting('test.n4', true))),
  'C3=NO NEED,C4=',
  '(43) AC-23: the dropped NO NEED entry clears as ''NO NEED'' and the dropped NULL-total entry as ''''');
select is(
  (select string_agg(split_part(ci.name, '-', 2) || ':' || trim_scale(ii.current_stock)::text || '/'
                     || trim_scale(ii.eod_remaining)::text, ',' order by ci.name)
     from public.inventory_items ii
     join public.catalog_ingredients ci on ci.id = ii.catalog_id
    where ii.id in (current_setting('test.i3', true)::uuid, current_setting('test.i4', true)::uuid)),
  'C3:42/42,C4:42/42',
  '(44) AC-23: the cleared items'' current_stock and eod_remaining are untouched');


-- ═══ R9 — AC-24 first submit at (A - 25, VR) ═════════════════════
select set_config('test.cc0', pg_temp.cc_all()::text, true);
select set_config('test.pe0',
  pg_temp.pe(current_setting('test.n1', true)) || ',' || pg_temp.pe(current_setting('test.n2', true)), true);

set local role authenticated;
select set_config('request.jwt.claims', current_setting('test.claims_user', true), true);
select public.staff_submit_eod(gen_random_uuid(), current_setting('test.frederick', true)::uuid,
  current_setting('test.anchor', true)::date - 25, null, 'submitted',
  jsonb_build_array(
    jsonb_build_object('ingredient_id', current_setting('test.i1', true)::uuid, 'actual_remaining', 1),
    jsonb_build_object('ingredient_id', current_setting('test.i2', true)::uuid, 'actual_remaining', 2)),
  current_setting('test.vr', true)::uuid);
reset role;
select set_config('request.jwt.claims', '', true);

select is(pg_temp.cc_all() - current_setting('test.cc0', true)::int, 0,
  '(45) AC-24: a first-time submit writes zero Count cleared rows');
select is(
  (pg_temp.pe(current_setting('test.n1', true)) - split_part(current_setting('test.pe0', true), ',', 1)::int)
    || ',' ||
  (pg_temp.pe(current_setting('test.n2', true)) - split_part(current_setting('test.pe0', true), ',', 2)::int),
  '1,1',
  '(46) AC-24: a first-time submit writes one per-entry row per entry');


-- ═══ R9 — AC-25 replay and full re-send over S_c ═════════════════
select set_config('test.audit0', pg_temp.fred_audit()::text, true);

set local role authenticated;
select set_config('request.jwt.claims', current_setting('test.claims_user', true), true);
select set_config('test.r_replay_c', public.staff_submit_eod(
  current_setting('test.xc', true)::uuid, current_setting('test.frederick', true)::uuid,
  current_setting('test.anchor', true)::date - 22, null, 'submitted',
  jsonb_build_array(jsonb_build_object('ingredient_id', current_setting('test.i1', true)::uuid, 'actual_remaining', 3)),
  current_setting('test.vr', true)::uuid)::text, true);
reset role;
select set_config('request.jwt.claims', '', true);

select is(
  (current_setting('test.r_replay_c', true)::jsonb ->> 'conflict')
    || '|' || (current_setting('test.r_replay_c', true)::jsonb ->> 'submission_id'),
  'true|' || current_setting('test.s_c', true),
  '(47) AC-25: replaying S_c''s stored client_uuid returns conflict = true and S_c''s id');
select is(pg_temp.fred_audit() - current_setting('test.audit0', true)::int, 0,
  '(48) AC-25: the replay (whose payload would have dropped I2) writes zero audit_log rows of any kind');

select set_config('test.cc0', pg_temp.cc_all()::text, true);
select set_config('test.pe0',
  pg_temp.pe(current_setting('test.n1', true)) || ',' || pg_temp.pe(current_setting('test.n2', true)), true);

set local role authenticated;
select set_config('request.jwt.claims', current_setting('test.claims_user', true), true);
select public.staff_submit_eod(gen_random_uuid(), current_setting('test.frederick', true)::uuid,
  current_setting('test.anchor', true)::date - 22, null, 'submitted',
  jsonb_build_array(
    jsonb_build_object('ingredient_id', current_setting('test.i1', true)::uuid, 'actual_remaining', 13),
    jsonb_build_object('ingredient_id', current_setting('test.i2', true)::uuid, 'actual_remaining', 23)),
  current_setting('test.vr', true)::uuid);
reset role;
select set_config('request.jwt.claims', '', true);

select is(pg_temp.cc_all() - current_setting('test.cc0', true)::int, 0,
  '(49) AC-25: a full re-send of I1 and I2 writes zero Count cleared rows (replaced, not cleared)');
select is(
  (pg_temp.pe(current_setting('test.n1', true)) - split_part(current_setting('test.pe0', true), ',', 1)::int)
    || ',' ||
  (pg_temp.pe(current_setting('test.n2', true)) - split_part(current_setting('test.pe0', true), ',', 2)::int),
  '1,1',
  '(50) AC-25: the full re-send writes one per-entry row each');


-- ═══ R9 — AC-26 every refusal / writer error rolls the audit back ═
-- (a) the date refusal over S_f (A - 36).
select set_config('test.cc0', pg_temp.cc_all()::text, true);
select set_config('test.ent_f', pg_temp.entries_of(current_setting('test.s_f', true)::uuid), true);

set local role authenticated;
select set_config('request.jwt.claims', current_setting('test.claims_user', true), true);
select throws_ok(
  format($q$select public.staff_submit_eod(gen_random_uuid(), %L::uuid, %L::date, null, 'submitted',
              jsonb_build_array(jsonb_build_object('ingredient_id', %L::uuid, 'actual_remaining', 14)), %L::uuid)$q$,
    current_setting('test.frederick', true), current_setting('test.anchor', true)::date - 36,
    current_setting('test.i1', true), current_setting('test.vr', true)),
  '22023', current_setting('test.msg', true),
  '(51) AC-26: the date refusal over S_f (A - 36) raises 22023');
reset role;
select set_config('request.jwt.claims', '', true);

select is(
  format('%s|%s', pg_temp.cc_all() - current_setting('test.cc0', true)::int,
         pg_temp.entries_of(current_setting('test.s_f', true)::uuid)),
  format('0|%s', current_setting('test.ent_f', true)),
  '(52) AC-26/AC-3: the date refusal writes zero Count cleared rows and leaves S_f''s entries unchanged');

-- (b) the O-1 refusal over S_d.
select set_config('test.ent_d', pg_temp.entries_of(current_setting('test.s_d', true)::uuid), true);

set local role authenticated;
select set_config('request.jwt.claims', current_setting('test.claims_user', true), true);
select throws_ok(
  format($q$select public.staff_submit_eod(gen_random_uuid(), %L::uuid, %L::date, null, 'submitted',
              '[]'::jsonb, %L::uuid)$q$,
    current_setting('test.frederick', true), current_setting('test.anchor', true)::date - 23,
    current_setting('test.vr', true)),
  '22023', current_setting('test.msg_o1', true),
  '(53) AC-26: the O-1 empty-payload refusal over S_d raises 22023');
reset role;
select set_config('request.jwt.claims', '', true);

select is(
  format('%s|%s', pg_temp.cc_all() - current_setting('test.cc0', true)::int,
         pg_temp.entries_of(current_setting('test.s_d', true)::uuid)),
  format('0|%s', current_setting('test.ent_d', true)),
  '(54) AC-26: the O-1 refusal writes zero Count cleared rows and leaves S_d''s entries unchanged');

-- (c) a writer error AFTER the delete: NO NEED carrying a quantity (23514).
-- The CTE would have audited I2 before the loop failed; the rollback must
-- take that row with it.
set local role authenticated;
select set_config('request.jwt.claims', current_setting('test.claims_user', true), true);
select throws_ok(
  format($q$select public.staff_submit_eod(gen_random_uuid(), %L::uuid, %L::date, null, 'submitted',
              jsonb_build_array(
                jsonb_build_object('ingredient_id', %L::uuid, 'actual_remaining', 14),
                jsonb_build_object('ingredient_id', %L::uuid, 'no_need', true, 'actual_remaining', 1)),
              %L::uuid)$q$,
    current_setting('test.frederick', true), current_setting('test.anchor', true)::date - 23,
    current_setting('test.i1', true), current_setting('test.i3', true), current_setting('test.vr', true)),
  '23514', null,
  '(55) AC-26: a NO NEED element with a quantity over S_d fails in the writer after the delete (23514)');
reset role;
select set_config('request.jwt.claims', '', true);

select is(
  format('%s|%s', pg_temp.cc_all() - current_setting('test.cc0', true)::int,
         pg_temp.entries_of(current_setting('test.s_d', true)::uuid)),
  format('0|%s', current_setting('test.ent_d', true)),
  '(56) AC-26: the 23514 rollback takes the Count cleared row with it and leaves S_d''s entries unchanged');

-- (d) a writer error AFTER the delete: the same item twice (23505).
set local role authenticated;
select set_config('request.jwt.claims', current_setting('test.claims_user', true), true);
select throws_ok(
  format($q$select public.staff_submit_eod(gen_random_uuid(), %L::uuid, %L::date, null, 'submitted',
              jsonb_build_array(
                jsonb_build_object('ingredient_id', %L::uuid, 'actual_remaining', 14),
                jsonb_build_object('ingredient_id', %L::uuid, 'actual_remaining', 15)),
              %L::uuid)$q$,
    current_setting('test.frederick', true), current_setting('test.anchor', true)::date - 23,
    current_setting('test.i1', true), current_setting('test.i1', true), current_setting('test.vr', true)),
  '23505', null,
  '(57) AC-26: a payload naming I1 twice over S_d fails in the writer after the delete (23505)');
reset role;
select set_config('request.jwt.claims', '', true);

select is(
  format('%s|%s', pg_temp.cc_all() - current_setting('test.cc0', true)::int,
         pg_temp.entries_of(current_setting('test.s_d', true)::uuid)),
  format('0|%s', current_setting('test.ent_d', true)),
  '(58) AC-26: the 23505 rollback takes the Count cleared row with it and leaves S_d''s entries unchanged');


-- ═══ R9 — AC-27 a privileged caller of the staff RPC over S_e ════
-- The seed admin (1111) has a profile and sees Frederick (brand match).
select set_config('test.cc_c2', pg_temp.cc(current_setting('test.n2', true))::text, true);

set local role authenticated;
select set_config('request.jwt.claims', current_setting('test.claims_admin', true), true);
select public.staff_submit_eod(gen_random_uuid(), current_setting('test.frederick', true)::uuid,
  current_setting('test.anchor', true)::date - 24, null, 'submitted',
  jsonb_build_array(jsonb_build_object('ingredient_id', current_setting('test.i1', true)::uuid,
                                       'actual_remaining', 16, 'unit', 'lbs')),
  current_setting('test.vr', true)::uuid);
reset role;
select set_config('request.jwt.claims', '', true);

select is(pg_temp.cc(current_setting('test.n2', true)) - current_setting('test.cc_c2', true)::int, 1,
  '(59) AC-27: a JWT admin caller of staff_submit_eod that drops I2 writes exactly one Count cleared row for it');
select is(
  (select format('%s|%s|%s|%s|%s', a.store_id, a.user_id, a.detail, a.item_ref, a.value)
     from public.audit_log a
    where a.store_id = current_setting('test.frederick', true)::uuid
      and a.action = 'EOD entry'
      and a.detail like 'Count cleared%'
      and a.item_ref = current_setting('test.n2', true)
      and a.user_id = current_setting('test.admin_id', true)::uuid),
  format('%s|%s|%s|%s|%s',
    current_setting('test.frederick', true), current_setting('test.admin_id', true),
    'Count cleared · vendor: SPEC193-VR-' || current_setting('test.tag', true),
    current_setting('test.n2', true), '20 lbs'),
  '(60) AC-27: that row has the AC-22 shape with user_id = the admin (the audit follows the NULL branch, not the role)');


-- ═══ RK — AC-28 writer catalog, ACL and structure ════════════════
select is(
  (select prosecdef from pg_proc where oid = 'public.eod_write_submission(uuid, date, uuid, text, jsonb, uuid, uuid[], text, uuid)'::regprocedure),
  false, '(61) AC-28: eod_write_submission is still SECURITY INVOKER');
select is(
  (select proconfig from pg_proc where oid = 'public.eod_write_submission(uuid, date, uuid, text, jsonb, uuid, uuid[], text, uuid)'::regprocedure),
  array['search_path=public']::text[], '(62) AC-28: eod_write_submission pins search_path = public');
select ok(
  (select proacl from pg_proc where oid = 'public.eod_write_submission(uuid, date, uuid, text, jsonb, uuid, uuid[], text, uuid)'::regprocedure) is not null,
  '(63) AC-28: eod_write_submission has an explicit ACL (NULL would mean default EXECUTE to PUBLIC)');
select is(
  (select count(*)::int
     from pg_proc p, aclexplode(p.proacl) x
    where p.oid = 'public.eod_write_submission(uuid, date, uuid, text, jsonb, uuid, uuid[], text, uuid)'::regprocedure
      and x.grantee = 0),
  0, '(64) AC-28: no PUBLIC grantee on eod_write_submission');
select ok(not has_function_privilege('anon',
  'public.eod_write_submission(uuid, date, uuid, text, jsonb, uuid, uuid[], text, uuid)', 'execute'),
  '(65) AC-28: anon lacks EXECUTE on eod_write_submission');
select ok(not has_function_privilege('authenticated',
  'public.eod_write_submission(uuid, date, uuid, text, jsonb, uuid, uuid[], text, uuid)', 'execute'),
  '(66) AC-28: authenticated lacks EXECUTE on eod_write_submission');
select ok(not has_function_privilege('service_role',
  'public.eod_write_submission(uuid, date, uuid, text, jsonb, uuid, uuid[], text, uuid)', 'execute'),
  '(67) AC-28: service_role lacks EXECUTE on eod_write_submission');
select is(
  (select (length(p.prosrc) - length(replace(p.prosrc, t.tok, ''))) / length(t.tok)
     from pg_proc p,
          (select $t$'Count cleared · vendor: '$t$::text as tok) t
    where p.oid = 'public.eod_write_submission(uuid, date, uuid, text, jsonb, uuid, uuid[], text, uuid)'::regprocedure),
  2, '(68) AC-28: the writer source writes Count cleared in both branches (2 occurrences of the literal)');
select ok(
  (select prosrc from pg_proc where oid = 'public.eod_write_submission(uuid, date, uuid, text, jsonb, uuid, uuid[], text, uuid)'::regprocedure)
    like '%not exists%',
  '(69) AC-28: the NULL-branch audit filter uses NOT EXISTS (NOT IN would audit nothing on a NULL id)');

select * from finish();
rollback;
