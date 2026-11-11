-- supabase/tests/staff_submit_eod_skip_unknown.test.sql
--
-- Spec 199 — pgTAP coverage for
-- supabase/migrations/20261110130000_staff_eod_skip_unknown_items.sql:
-- staff_submit_eod drops payload items that are missing from inventory_items
-- or belong to another store, reports them in skipped_item_ids, refuses a
-- NULL/absent ingredient_id (R3) and an all-skipped payload (R4) with 22023,
-- and keeps every earlier gate's code, message and order.
--
-- A = (now() at time zone 'America/New_York')::date (test.anchor); every
-- call date is A - k with k in 1..16, inside spec 193's staff window.
-- R3 = 'staff_submit_eod: every p_entries element needs an ingredient_id'
-- R4 = 'staff_submit_eod: no p_entries element names an item of this store'
--
-- Arm map (plan 57):
--   SK1  (1-8)   AC-1: [I1, D] partial skip (deleted item).
--   SK2  (9-12)  AC-2: [I1, X] partial skip (cross-store item); X untouched.
--   SK3  (13-15) AC-3: valid-only payload; envelope = 5 keys, skipped [].
--   SK4  (16-17) AC-4: [D, X] first submit refuses with R4; no parent.
--   SK5  (18-19) AC-5: [D] over S5 refuses with R4; S5 fully unchanged.
--   SK6  (20-21) AC-6: R3 / R4 SQLSTATE and message lint.
--   SK7  (22-24) AC-7: NULL and absent ingredient_id refuse with R3 over S7.
--   SK8  (25-29) AC-8: [I1, D] over S8; Count cleared for I2 only.
--   SK9  (30-36) AC-9 / R13: store gate (prefix pin), replay, O-1, date
--                window and vendor NULL each win over the new steps.
--   SK10 (37-40) AC-10: [I1, I1] still 23505; [I1, D, D] reports D once.
--   SK11 (41-44) AC-11: JWT admin gets the AC-1 result and the AC-4 refusal.
--   SK12 (45-54) AC-12: catalog posture, trigger kept, direct insert of X
--                still 42501, writer posture unchanged.
--   SK13 (55)    R10 structural pin: FOR KEY SHARE in staff_submit_eod.
--   SKX  (56-57) design §4: non-uuid id still 22P02; a skipped NO NEED +
--                quantity element raises nothing (R2).
--
-- Fixture posture (mirrors spec 193's suite): every vendor, catalog row, item
-- and link is created INSIDE the transaction (tagged SPEC199-*-<tag>), so
-- every (Frederick, A - k, V) triple is fresh by construction. Principals:
-- seed manager 2222 (role 'user', member of Frederick, not Charles) and seed
-- admin 1111 (admin, Frederick's brand). Every "unchanged" / "no row" claim
-- is read back as postgres (`reset role`, claims cleared). No `set role anon`
-- (segfaults CI per spec 067). Hermetic: begin; … rollback;.

begin;
create extension if not exists pgtap;

select plan(57);

-- ─── fixtures (as postgres) ─────────────────────────────────────
do $$
declare
  v_frederick uuid;
  v_charles   uuid;
  v_brand     uuid;
  v_cbrand    uuid;
  v_tag       text := substr(gen_random_uuid()::text, 1, 8);
  v_v         uuid;
  v_a         date := (now() at time zone 'America/New_York')::date;
begin
  select id, brand_id into v_frederick, v_brand from public.stores where name = 'Frederick' limit 1;
  select id, brand_id into v_charles, v_cbrand from public.stores where name = 'Charles' limit 1;

  insert into public.vendors (name, brand_id) values ('SPEC199-V-' || v_tag, v_brand) returning id into v_v;

  perform set_config('test.anchor',    v_a::text,          true);
  perform set_config('test.tag',       v_tag,              true);
  perform set_config('test.frederick', v_frederick::text,  true);
  perform set_config('test.charles',   v_charles::text,    true);
  perform set_config('test.brand',     v_brand::text,      true);
  perform set_config('test.cbrand',    v_cbrand::text,     true);
  perform set_config('test.v',         v_v::text,          true);
  perform set_config('test.d',         gen_random_uuid()::text, true);
  perform set_config('test.manager_id', '22222222-2222-2222-2222-222222222222', true);
  perform set_config('test.msg_r3', 'staff_submit_eod: every p_entries element needs an ingredient_id', true);
  perform set_config('test.msg_r4', 'staff_submit_eod: no p_entries element names an item of this store', true);
  perform set_config('test.msg_date',
    'staff_submit_eod: p_date is outside the staff window (35 days back to 1 day ahead, America/New_York)', true);
  perform set_config('test.msg_o1', 'staff_submit_eod: p_entries must be a non-empty array', true);
  perform set_config('test.msg_vendor', 'staff_submit_eod: vendor_id is required as of spec 020', true);
  perform set_config('test.claims_user', jsonb_build_object(
    'sub', '22222222-2222-2222-2222-222222222222', 'role', 'authenticated',
    'app_metadata', jsonb_build_object('role', 'user'))::text, true);
  perform set_config('test.claims_admin', jsonb_build_object(
    'sub', '11111111-1111-1111-1111-111111111111', 'role', 'authenticated',
    'app_metadata', jsonb_build_object('role', 'admin'))::text, true);
end $$;

-- C1, C2 (Frederick's brand) and CX (Charles's brand), unit lbs.
create temp table _cat on commit drop as
with ins as (
  insert into public.catalog_ingredients (brand_id, name, unit)
  select case when k = 'X' then current_setting('test.cbrand', true)::uuid
              else current_setting('test.brand', true)::uuid end,
         'SPEC199-C' || k || '-' || current_setting('test.tag', true),
         'lbs'
    from unnest(array['1','2','X']) as k
  returning id, name
)
select id, name, split_part(name, '-', 2) as kind from ins;

-- I1, I2 at Frederick and X at Charles, on-hand 42/42, fixed updated_at.
-- The seeded on-hand (42) differs from every seeded or sent entry value, so
-- "on-hand unchanged" can fail.
create temp table _items on commit drop as
with ins as (
  insert into public.inventory_items
    (store_id, catalog_id, vendor_id, cost_per_unit, current_stock, eod_remaining,
     par_level, usage_per_portion, updated_at)
  select case when c.kind = 'CX' then current_setting('test.charles', true)::uuid
              else current_setting('test.frederick', true)::uuid end,
         c.id,
         case when c.kind = 'CX' then null else current_setting('test.v', true)::uuid end,
         1, 42, 42, 10, 0, '2000-01-01 00:00:00+00'::timestamptz
    from _cat c
  returning id, catalog_id
)
select i.id, c.kind, c.name from ins i join _cat c on c.id = i.catalog_id;

do $$
declare r record;
begin
  for r in select kind, id, name from _items loop
    -- kind is 'C1', 'C2', 'CX'; settings test.i1 / test.i2 / test.ix.
    perform set_config('test.i' || lower(right(r.kind, 1)), r.id::text, true);
    perform set_config('test.n' || lower(right(r.kind, 1)), r.name, true);
  end loop;
end $$;

-- I1 and I2 are numeric + vendor-linked to V (so they appear in
-- stock_updates). X has no Frederick link.
insert into public.item_vendors (item_id, vendor_id, cost_per_unit, case_price, is_primary)
select i.id, current_setting('test.v', true)::uuid, 1, 0, true
  from _items i where i.kind in ('C1', 'C2')
on conflict (item_id, vendor_id) do nothing;

-- Seeded submissions (as postgres; status submitted, fixed submitted_at),
-- each holding I1 = 10 and I2 = 20 under V:
--   S5 (A-5), S7 (A-7), S8 (A-8), S9 (A-9, client_uuid test.xc), S10 (A-10).
do $$
declare
  v_a   date := current_setting('test.anchor', true)::date;
  v_fr  uuid := current_setting('test.frederick', true)::uuid;
  v_v   uuid := current_setting('test.v', true)::uuid;
  v_i1  uuid := current_setting('test.i1', true)::uuid;
  v_i2  uuid := current_setting('test.i2', true)::uuid;
  v_sub uuid;
  k     int;
begin
  perform set_config('test.xc', gen_random_uuid()::text, true);
  foreach k in array array[5, 7, 8, 9, 10] loop
    insert into public.eod_submissions (store_id, date, vendor_id, status, submitted_at, client_uuid)
    values (v_fr, v_a - k, v_v, 'submitted', '2000-01-01 00:00:00+00'::timestamptz,
            case when k = 9 then current_setting('test.xc', true)::uuid else gen_random_uuid() end)
    returning id into v_sub;
    insert into public.eod_entries (submission_id, item_id, actual_remaining, notes, no_need)
    values (v_sub, v_i1, 10, '', false),
           (v_sub, v_i2, 20, '', false);
    perform set_config('test.s' || k, v_sub::text, true);
  end loop;
end $$;

-- ─── read-back helpers (called as postgres only) ────────────────
create function pg_temp.sub_at(p_k int) returns uuid
language sql as $$
  select id from public.eod_submissions
   where store_id = current_setting('test.frederick', true)::uuid
     and date = current_setting('test.anchor', true)::date - p_k
     and vendor_id = current_setting('test.v', true)::uuid
$$;

-- Entry values without ids, sorted by item name. An entry whose item has no
-- catalog name would show as '?'.
create function pg_temp.vals_of(p_sub uuid) returns text
language sql as $$
  select coalesce(string_agg(
           coalesce(split_part(ci.name, '-', 2), '?') || '='
           || coalesce(trim_scale(e.actual_remaining)::text, 'null'),
           ',' order by ci.name), '')
    from public.eod_entries e
    left join public.inventory_items ii on ii.id = e.item_id
    left join public.catalog_ingredients ci on ci.id = ii.catalog_id
   where e.submission_id = p_sub
$$;

-- Entries with ids, sorted by item name.
create function pg_temp.entries_of(p_sub uuid) returns text
language sql as $$
  select coalesce(string_agg(
           e.id::text || ':' || coalesce(split_part(ci.name, '-', 2), '?') || '='
           || coalesce(trim_scale(e.actual_remaining)::text, 'null')
           || case when e.no_need then '/NN' else '' end,
           ',' order by ci.name), '')
    from public.eod_entries e
    left join public.inventory_items ii on ii.id = e.item_id
    left join public.catalog_ingredients ci on ci.id = ii.catalog_id
   where e.submission_id = p_sub
$$;

-- On-hand of every SPEC199 item (I1, I2 and X): stock / eod_remaining / updated_at.
create function pg_temp.onhand() returns text
language sql as $$
  select string_agg(split_part(ci.name, '-', 2) || ':' || ii.current_stock::text || '/'
                    || ii.eod_remaining::text || '@' || ii.updated_at::text, ',' order by ci.name)
    from public.inventory_items ii
    join public.catalog_ingredients ci on ci.id = ii.catalog_id
   where ci.name like 'SPEC199-%-' || current_setting('test.tag', true)
$$;

-- Everything a refusal must leave alone: the parent, its entries (ids and
-- values), on-hand, notifications for the submission, and the store's
-- audit_log row count (Count cleared rows included).
create function pg_temp.state_of(p_sub uuid) returns text
language sql as $$
  select concat_ws(' | ',
    (select s.status || '@' || s.submitted_at::text || '@' || coalesce(s.client_uuid::text, '-')
       from public.eod_submissions s where s.id = p_sub),
    pg_temp.entries_of(p_sub),
    pg_temp.onhand(),
    (select count(*)::text from public.notifications n
      where coalesce(n.submission_id, n.source_id) = p_sub),
    (select count(*)::text from public.audit_log a
      where a.store_id = current_setting('test.frederick', true)::uuid))
$$;

create function pg_temp.fred_audit() returns int
language sql as $$
  select count(*)::int from public.audit_log
   where store_id = current_setting('test.frederick', true)::uuid
$$;

-- Every Frederick 'Count cleared' row (any item_ref, NULL included).
create function pg_temp.cc_fred() returns int
language sql as $$
  select count(*)::int from public.audit_log
   where store_id = current_setting('test.frederick', true)::uuid
     and action = 'EOD entry'
     and detail like 'Count cleared%'
$$;

-- Frederick 'Count cleared' rows with that item_ref.
create function pg_temp.cc(p_item_ref text) returns int
language sql as $$
  select count(*)::int from public.audit_log
   where store_id = current_setting('test.frederick', true)::uuid
     and action = 'EOD entry'
     and detail like 'Count cleared%'
     and item_ref = p_item_ref
$$;

-- Frederick per-entry staff rows (user_id NULL, not 'Count cleared') for that item_ref.
create function pg_temp.pe(p_item_ref text) returns int
language sql as $$
  select count(*)::int from public.audit_log
   where store_id = current_setting('test.frederick', true)::uuid
     and action = 'EOD entry'
     and user_id is null
     and detail not like 'Count cleared%'
     and item_ref = p_item_ref
$$;


-- ═══ SK1 — AC-1 partial skip, deleted item (A - 1) ═══════════════
select set_config('test.fa0', pg_temp.fred_audit()::text, true);
select set_config('test.pe_i1', pg_temp.pe(current_setting('test.n1', true))::text, true);

set local role authenticated;
select set_config('request.jwt.claims', current_setting('test.claims_user', true), true);
select set_config('test.r1', public.staff_submit_eod(gen_random_uuid(),
  current_setting('test.frederick', true)::uuid,
  current_setting('test.anchor', true)::date - 1, null, 'submitted',
  jsonb_build_array(
    jsonb_build_object('ingredient_id', current_setting('test.i1', true)::uuid, 'actual_remaining', 5, 'unit', 'lbs'),
    jsonb_build_object('ingredient_id', current_setting('test.d', true)::uuid, 'actual_remaining', 7)),
  current_setting('test.v', true)::uuid)::text, true);
reset role;
select set_config('request.jwt.claims', '', true);

select is(current_setting('test.r1', true)::jsonb ->> 'conflict', 'false',
  '(1) AC-1: [I1, D] from a store member succeeds with conflict = false');
select is(current_setting('test.r1', true)::jsonb -> 'skipped_item_ids',
  jsonb_build_array(current_setting('test.d', true)),
  '(2) AC-1: skipped_item_ids = [D]');
select is(pg_temp.vals_of(pg_temp.sub_at(1)), 'C1=5',
  '(3) AC-1: exactly one eod_entries row is written, for I1');
select is(jsonb_array_length(current_setting('test.r1', true)::jsonb -> 'entry_ids'), 1,
  '(4) AC-1: entry_ids has length 1');
select is(
  (select array_agg(x ->> 'ingredient_id') from jsonb_array_elements(current_setting('test.r1', true)::jsonb -> 'stock_updates') x),
  array[current_setting('test.i1', true)],
  '(5) AC-1: stock_updates names only I1');
select is(pg_temp.fred_audit() - current_setting('test.fa0', true)::int, 1,
  '(6) AC-1: exactly one Frederick audit_log row was added (none for D)');
select is(pg_temp.pe(current_setting('test.n1', true)) - current_setting('test.pe_i1', true)::int, 1,
  '(7) AC-1: that row is I1''s per-entry ''EOD entry'' row');
select is(
  (select trim_scale(current_stock)::text || '/' || trim_scale(eod_remaining)::text from public.inventory_items
    where id = current_setting('test.i1', true)::uuid),
  '5/5',
  '(8) AC-1: I1''s on-hand is written from the valid entry');


-- ═══ SK2 — AC-2 partial skip, cross-store item (A - 2) ═══════════
select set_config('test.x_onhand',
  (select current_stock::text || '/' || eod_remaining::text || '@' || updated_at::text
     from public.inventory_items where id = current_setting('test.ix', true)::uuid), true);

set local role authenticated;
select set_config('request.jwt.claims', current_setting('test.claims_user', true), true);
select set_config('test.r2', public.staff_submit_eod(gen_random_uuid(),
  current_setting('test.frederick', true)::uuid,
  current_setting('test.anchor', true)::date - 2, null, 'submitted',
  jsonb_build_array(
    jsonb_build_object('ingredient_id', current_setting('test.i1', true)::uuid, 'actual_remaining', 6),
    jsonb_build_object('ingredient_id', current_setting('test.ix', true)::uuid, 'actual_remaining', 8)),
  current_setting('test.v', true)::uuid)::text, true);
reset role;
select set_config('request.jwt.claims', '', true);

select is(current_setting('test.r2', true)::jsonb -> 'skipped_item_ids',
  jsonb_build_array(current_setting('test.ix', true)),
  '(9) AC-2: [I1, X] succeeds and skipped_item_ids = [X]');
select is(pg_temp.vals_of(pg_temp.sub_at(2)), 'C1=6',
  '(10) AC-2: only I1 is written');
select is(
  (select current_stock::text || '/' || eod_remaining::text || '@' || updated_at::text
     from public.inventory_items where id = current_setting('test.ix', true)::uuid),
  current_setting('test.x_onhand', true),
  '(11) AC-2: X''s current_stock, eod_remaining and updated_at at Charles are unchanged');
select is(
  (select count(*)::int from public.audit_log
    where store_id = current_setting('test.frederick', true)::uuid
      and item_ref = current_setting('test.nx', true)),
  0,
  '(12) AC-2: no Frederick audit_log row names X');


-- ═══ SK3 — AC-3 valid-only envelope (A - 3) ══════════════════════
set local role authenticated;
select set_config('request.jwt.claims', current_setting('test.claims_user', true), true);
select set_config('test.r3', public.staff_submit_eod(gen_random_uuid(),
  current_setting('test.frederick', true)::uuid,
  current_setting('test.anchor', true)::date - 3, null, 'submitted',
  jsonb_build_array(
    jsonb_build_object('ingredient_id', current_setting('test.i1', true)::uuid, 'actual_remaining', 3),
    jsonb_build_object('ingredient_id', current_setting('test.i2', true)::uuid, 'actual_remaining', 4)),
  current_setting('test.v', true)::uuid)::text, true);
reset role;
select set_config('request.jwt.claims', '', true);

select is(
  (select array_agg(k order by k) from jsonb_object_keys(current_setting('test.r3', true)::jsonb) k),
  array['conflict', 'entry_ids', 'skipped_item_ids', 'stock_updates', 'submission_id']::text[],
  '(13) AC-3: a valid-only success envelope has exactly the four earlier keys plus skipped_item_ids');
select is(current_setting('test.r3', true)::jsonb -> 'skipped_item_ids', '[]'::jsonb,
  '(14) AC-3: skipped_item_ids is [] when nothing was skipped');
select is(
  jsonb_array_length(current_setting('test.r3', true)::jsonb -> 'entry_ids') || '/'
    || jsonb_array_length(current_setting('test.r3', true)::jsonb -> 'stock_updates') || '/'
    || (current_setting('test.r3', true)::jsonb ->> 'conflict') || '/'
    || pg_temp.vals_of(pg_temp.sub_at(3)),
  '2/2/false/C1=3,C2=4',
  '(15) AC-3: entry_ids, stock_updates, conflict and the written rows are as before');


-- ═══ SK4 — AC-4 all skipped, first submit (A - 4) ════════════════
set local role authenticated;
select set_config('request.jwt.claims', current_setting('test.claims_user', true), true);
select throws_ok(
  format($q$select public.staff_submit_eod(gen_random_uuid(), %L::uuid, %L::date, null, 'submitted',
              jsonb_build_array(jsonb_build_object('ingredient_id', %L::uuid, 'actual_remaining', 1),
                                jsonb_build_object('ingredient_id', %L::uuid, 'actual_remaining', 2)), %L::uuid)$q$,
    current_setting('test.frederick', true),
    current_setting('test.anchor', true)::date - 4,
    current_setting('test.d', true),
    current_setting('test.ix', true),
    current_setting('test.v', true)),
  '22023', current_setting('test.msg_r4', true),
  '(16) AC-4: [D, X] first submit raises 22023 with the R4 message');
reset role;
select set_config('request.jwt.claims', '', true);

select is(pg_temp.sub_at(4), null::uuid,
  '(17) AC-4: the refused call left no parent at (Frederick, A - 4, V)');


-- ═══ SK5 — AC-5 all skipped over S5 (A - 5) ══════════════════════
select set_config('test.state_s5', pg_temp.state_of(current_setting('test.s5', true)::uuid), true);

set local role authenticated;
select set_config('request.jwt.claims', current_setting('test.claims_user', true), true);
select throws_ok(
  format($q$select public.staff_submit_eod(gen_random_uuid(), %L::uuid, %L::date, null, 'submitted',
              jsonb_build_array(jsonb_build_object('ingredient_id', %L::uuid, 'actual_remaining', 1)), %L::uuid)$q$,
    current_setting('test.frederick', true),
    current_setting('test.anchor', true)::date - 5,
    current_setting('test.d', true),
    current_setting('test.v', true)),
  '22023', current_setting('test.msg_r4', true),
  '(18) AC-5: [D] over the existing submission S5 raises the R4 refusal');
reset role;
select set_config('request.jwt.claims', '', true);

select is(pg_temp.state_of(current_setting('test.s5', true)::uuid), current_setting('test.state_s5', true),
  '(19) AC-5/R7: S5''s status, submitted_at, client_uuid, entries, on-hand, notifications and Frederick''s audit_log count (Count cleared included) are unchanged');


-- ═══ SK6 — AC-6 R3 / R4 message lint ═════════════════════════════
set local role authenticated;
select set_config('request.jwt.claims', current_setting('test.claims_user', true), true);
do $$
begin
  begin
    perform public.staff_submit_eod(gen_random_uuid(), current_setting('test.frederick', true)::uuid,
      current_setting('test.anchor', true)::date - 15, null, 'submitted',
      jsonb_build_array(jsonb_build_object('ingredient_id', current_setting('test.i1', true)::uuid, 'actual_remaining', 1),
                        '{}'::jsonb),
      current_setting('test.v', true)::uuid);
    perform set_config('test.r3_state', 'no error', true);
    perform set_config('test.r3_msg', '', true);
  exception when others then
    perform set_config('test.r3_state', sqlstate, true);
    perform set_config('test.r3_msg', sqlerrm, true);
  end;
  begin
    perform public.staff_submit_eod(gen_random_uuid(), current_setting('test.frederick', true)::uuid,
      current_setting('test.anchor', true)::date - 16, null, 'submitted',
      jsonb_build_array(jsonb_build_object('ingredient_id', current_setting('test.d', true)::uuid, 'actual_remaining', 1)),
      current_setting('test.v', true)::uuid);
    perform set_config('test.r4_state', 'no error', true);
    perform set_config('test.r4_msg', '', true);
  exception when others then
    perform set_config('test.r4_state', sqlstate, true);
    perform set_config('test.r4_msg', sqlerrm, true);
  end;
end $$;
reset role;
select set_config('request.jwt.claims', '', true);

select ok(
  current_setting('test.r3_state', true) = '22023'
  and current_setting('test.r3_msg', true) = current_setting('test.msg_r3', true)
  and current_setting('test.r3_msg', true) !~* '42501|network request failed|failed to fetch|aborted|timeout|network|caller cannot see store',
  '(20) AC-6/R5: the R3 refusal is 22023 (not 42501) and its message has no 42501 / network / abort / timeout / store-gate text');
select ok(
  current_setting('test.r4_state', true) = '22023'
  and current_setting('test.r4_msg', true) = current_setting('test.msg_r4', true)
  and current_setting('test.r4_msg', true) !~* '42501|network request failed|failed to fetch|aborted|timeout|network|caller cannot see store',
  '(21) AC-6/R5: the R4 refusal is 22023 (not 42501) and its message has no 42501 / network / abort / timeout / store-gate text');


-- ═══ SK7 — AC-7 NULL / absent ingredient_id over S7 (A - 7) ══════
select set_config('test.state_s7', pg_temp.state_of(current_setting('test.s7', true)::uuid), true);

set local role authenticated;
select set_config('request.jwt.claims', current_setting('test.claims_user', true), true);
select throws_ok(
  format($q$select public.staff_submit_eod(gen_random_uuid(), %L::uuid, %L::date, null, 'submitted',
              jsonb_build_array(jsonb_build_object('ingredient_id', %L::uuid, 'actual_remaining', 1),
                                jsonb_build_object('ingredient_id', null)), %L::uuid)$q$,
    current_setting('test.frederick', true),
    current_setting('test.anchor', true)::date - 7,
    current_setting('test.i1', true),
    current_setting('test.v', true)),
  '22023', current_setting('test.msg_r3', true),
  '(22) AC-7: [I1, {ingredient_id: null}] raises 22023 with the R3 message');
select throws_ok(
  format($q$select public.staff_submit_eod(gen_random_uuid(), %L::uuid, %L::date, null, 'submitted',
              jsonb_build_array(jsonb_build_object('ingredient_id', %L::uuid, 'actual_remaining', 1),
                                '{}'::jsonb), %L::uuid)$q$,
    current_setting('test.frederick', true),
    current_setting('test.anchor', true)::date - 7,
    current_setting('test.i1', true),
    current_setting('test.v', true)),
  '22023', current_setting('test.msg_r3', true),
  '(23) AC-7: [I1, {}] (key absent) raises 22023 with the R3 message');
reset role;
select set_config('request.jwt.claims', '', true);

select is(pg_temp.state_of(current_setting('test.s7', true)::uuid), current_setting('test.state_s7', true),
  '(24) AC-7/R7: both R3 refusals over S7 left S7, its entries, on-hand, notifications and Frederick''s audit_log count unchanged');


-- ═══ SK8 — AC-8 Count cleared interaction over S8 (A - 8) ════════
select set_config('test.ccf0', pg_temp.cc_fred()::text, true);
select set_config('test.cc_i1', pg_temp.cc(current_setting('test.n1', true))::text, true);
select set_config('test.cc_i2', pg_temp.cc(current_setting('test.n2', true))::text, true);

set local role authenticated;
select set_config('request.jwt.claims', current_setting('test.claims_user', true), true);
select set_config('test.r8', public.staff_submit_eod(gen_random_uuid(),
  current_setting('test.frederick', true)::uuid,
  current_setting('test.anchor', true)::date - 8, null, 'submitted',
  jsonb_build_array(
    jsonb_build_object('ingredient_id', current_setting('test.i1', true)::uuid, 'actual_remaining', 11, 'unit', 'lbs'),
    jsonb_build_object('ingredient_id', current_setting('test.d', true)::uuid, 'actual_remaining', 1)),
  current_setting('test.v', true)::uuid)::text, true);
reset role;
select set_config('request.jwt.claims', '', true);

select is(pg_temp.vals_of(current_setting('test.s8', true)::uuid), 'C1=11',
  '(25) AC-8: after [I1, D] over S8, S8 holds only I1 = 11');
select is(pg_temp.cc_fred() - current_setting('test.ccf0', true)::int, 1,
  '(26) AC-8: exactly one new Frederick Count cleared row (none for D)');
select is(pg_temp.cc(current_setting('test.n2', true)) - current_setting('test.cc_i2', true)::int, 1,
  '(27) AC-8: that Count cleared row names I2');
select is(pg_temp.cc(current_setting('test.n1', true)) - current_setting('test.cc_i1', true)::int, 0,
  '(28) AC-8: no Count cleared row names the re-sent I1');
select is(current_setting('test.r8', true)::jsonb -> 'skipped_item_ids',
  jsonb_build_array(current_setting('test.d', true)),
  '(29) AC-8: skipped_item_ids = [D]');


-- ═══ SK9 — AC-9 / R13 gate order ═════════════════════════════════
set local role authenticated;
select set_config('request.jwt.claims', current_setting('test.claims_user', true), true);
do $$
begin
  perform public.staff_submit_eod(gen_random_uuid(), current_setting('test.charles', true)::uuid,
    current_setting('test.anchor', true)::date - 1, null, 'submitted',
    jsonb_build_array(jsonb_build_object('ingredient_id', current_setting('test.d', true)::uuid, 'actual_remaining', 1)),
    current_setting('test.v', true)::uuid);
  perform set_config('test.gate_state', 'no error', true);
  perform set_config('test.gate_msg', '', true);
exception when others then
  perform set_config('test.gate_state', sqlstate, true);
  perform set_config('test.gate_msg', sqlerrm, true);
end $$;
reset role;
select set_config('request.jwt.claims', '', true);

select ok(
  current_setting('test.gate_state', true) = '42501'
  and current_setting('test.gate_msg', true) like 'staff_submit_eod: caller cannot see store%',
  '(30) AC-9/R13: an outsider (Charles) sending [D] gets the store gate: 42501 and a message starting ''staff_submit_eod: caller cannot see store'' (client contract: src/screens/staff/hooks/useEodSubmit.ts STORE_GATE_TEXT)');

select set_config('test.state_s9', pg_temp.state_of(current_setting('test.s9', true)::uuid), true);
set local role authenticated;
select set_config('request.jwt.claims', current_setting('test.claims_user', true), true);
select set_config('test.r9', public.staff_submit_eod(current_setting('test.xc', true)::uuid,
  current_setting('test.frederick', true)::uuid,
  current_setting('test.anchor', true)::date - 9, null, 'submitted',
  jsonb_build_array(jsonb_build_object('ingredient_id', current_setting('test.d', true)::uuid, 'actual_remaining', 1)),
  current_setting('test.v', true)::uuid)::text, true);
reset role;
select set_config('request.jwt.claims', '', true);

select is(
  (select array_agg(k order by k) from jsonb_object_keys(current_setting('test.r9', true)::jsonb) k),
  array['conflict', 'reason', 'submission_id']::text[],
  '(31) AC-9: the replay envelope is unchanged and has no skipped_item_ids');
select is(
  (current_setting('test.r9', true)::jsonb ->> 'conflict') || '|' || (current_setting('test.r9', true)::jsonb ->> 'submission_id'),
  'true|' || current_setting('test.s9', true),
  '(32) AC-9: replaying S9''s client_uuid with [D] returns conflict = true and S9''s id');
select is(pg_temp.state_of(current_setting('test.s9', true)::uuid), current_setting('test.state_s9', true),
  '(33) AC-9: the replay changed nothing on S9');

set local role authenticated;
select set_config('request.jwt.claims', current_setting('test.claims_user', true), true);
select throws_ok(
  format($q$select public.staff_submit_eod(gen_random_uuid(), %L::uuid, %L::date, null, 'submitted',
              '[]'::jsonb, %L::uuid)$q$,
    current_setting('test.frederick', true),
    current_setting('test.anchor', true)::date - 1,
    current_setting('test.v', true)),
  '22023', current_setting('test.msg_o1', true),
  '(34) AC-9: ''[]'' still raises O-1''s 22023 message');
select throws_ok(
  format($q$select public.staff_submit_eod(gen_random_uuid(), %L::uuid, %L::date, null, 'submitted',
              jsonb_build_array(jsonb_build_object('ingredient_id', %L::uuid, 'actual_remaining', 1)), %L::uuid)$q$,
    current_setting('test.frederick', true),
    current_setting('test.anchor', true)::date - 36,
    current_setting('test.d', true),
    current_setting('test.v', true)),
  '22023', current_setting('test.msg_date', true),
  '(35) AC-9: A - 36 with [D] raises the spec 193 date-window message, not R4');
select throws_ok(
  format($q$select public.staff_submit_eod(gen_random_uuid(), %L::uuid, %L::date, null, 'submitted',
              jsonb_build_array(jsonb_build_object('ingredient_id', %L::uuid, 'actual_remaining', 1)), null::uuid)$q$,
    current_setting('test.frederick', true),
    current_setting('test.anchor', true)::date - 1,
    current_setting('test.d', true)),
  '22023', current_setting('test.msg_vendor', true),
  '(36) AC-9: a NULL vendor with [D] raises the vendor 22023 message');
reset role;
select set_config('request.jwt.claims', '', true);


-- ═══ SK10 — AC-10 duplicates (S10 at A - 10; fresh A - 11) ═══════
select set_config('test.state_s10', pg_temp.state_of(current_setting('test.s10', true)::uuid), true);

set local role authenticated;
select set_config('request.jwt.claims', current_setting('test.claims_user', true), true);
select throws_ok(
  format($q$select public.staff_submit_eod(gen_random_uuid(), %L::uuid, %L::date, null, 'submitted',
              jsonb_build_array(jsonb_build_object('ingredient_id', %L::uuid, 'actual_remaining', 1),
                                jsonb_build_object('ingredient_id', %L::uuid, 'actual_remaining', 2)), %L::uuid)$q$,
    current_setting('test.frederick', true),
    current_setting('test.anchor', true)::date - 10,
    current_setting('test.i1', true),
    current_setting('test.i1', true),
    current_setting('test.v', true)),
  '23505', null,
  '(37) AC-10: [I1, I1] over S10 still raises 23505');
reset role;
select set_config('request.jwt.claims', '', true);

select is(pg_temp.state_of(current_setting('test.s10', true)::uuid), current_setting('test.state_s10', true),
  '(38) AC-10: the 23505 left S10 unchanged');

set local role authenticated;
select set_config('request.jwt.claims', current_setting('test.claims_user', true), true);
select set_config('test.r10', public.staff_submit_eod(gen_random_uuid(),
  current_setting('test.frederick', true)::uuid,
  current_setting('test.anchor', true)::date - 11, null, 'submitted',
  jsonb_build_array(
    jsonb_build_object('ingredient_id', current_setting('test.i1', true)::uuid, 'actual_remaining', 2),
    jsonb_build_object('ingredient_id', current_setting('test.d', true)::uuid, 'actual_remaining', 1),
    jsonb_build_object('ingredient_id', current_setting('test.d', true)::uuid, 'actual_remaining', 3)),
  current_setting('test.v', true)::uuid)::text, true);
reset role;
select set_config('request.jwt.claims', '', true);

select is(current_setting('test.r10', true)::jsonb -> 'skipped_item_ids',
  jsonb_build_array(current_setting('test.d', true)),
  '(39) AC-10: [I1, D, D] succeeds and reports D once');
select is(
  (current_setting('test.r10', true)::jsonb ->> 'conflict') || '/'
    || jsonb_array_length(current_setting('test.r10', true)::jsonb -> 'entry_ids') || '/'
    || pg_temp.vals_of(pg_temp.sub_at(11)),
  'false/1/C1=2',
  '(40) AC-10: conflict false, one entry written (I1)');


-- ═══ SK11 — AC-11 privileged caller (JWT admin; A - 12, A - 13) ══
set local role authenticated;
select set_config('request.jwt.claims', current_setting('test.claims_admin', true), true);
select set_config('test.r11', public.staff_submit_eod(gen_random_uuid(),
  current_setting('test.frederick', true)::uuid,
  current_setting('test.anchor', true)::date - 12, null, 'submitted',
  jsonb_build_array(
    jsonb_build_object('ingredient_id', current_setting('test.i1', true)::uuid, 'actual_remaining', 4),
    jsonb_build_object('ingredient_id', current_setting('test.d', true)::uuid, 'actual_remaining', 1)),
  current_setting('test.v', true)::uuid)::text, true);
select throws_ok(
  format($q$select public.staff_submit_eod(gen_random_uuid(), %L::uuid, %L::date, null, 'submitted',
              jsonb_build_array(jsonb_build_object('ingredient_id', %L::uuid, 'actual_remaining', 1),
                                jsonb_build_object('ingredient_id', %L::uuid, 'actual_remaining', 2)), %L::uuid)$q$,
    current_setting('test.frederick', true),
    current_setting('test.anchor', true)::date - 13,
    current_setting('test.d', true),
    current_setting('test.ix', true),
    current_setting('test.v', true)),
  '22023', current_setting('test.msg_r4', true),
  '(41) AC-11: a JWT admin''s [D, X] gets the R4 refusal (no privileged exemption)');
reset role;
select set_config('request.jwt.claims', '', true);

select is(
  (current_setting('test.r11', true)::jsonb ->> 'conflict') || '|'
    || (current_setting('test.r11', true)::jsonb -> 'skipped_item_ids')::text,
  'false|' || jsonb_build_array(current_setting('test.d', true))::text,
  '(42) AC-11: a JWT admin''s [I1, D] succeeds with skipped_item_ids = [D]');
select is(pg_temp.vals_of(pg_temp.sub_at(12)), 'C1=4',
  '(43) AC-11: only I1 is written for the admin');
select is(pg_temp.sub_at(13), null::uuid,
  '(44) AC-11: the admin''s refused [D, X] left no parent at A - 13');


-- ═══ SK12 — AC-12 unchanged surfaces ═════════════════════════════
select is(
  (select prosecdef from pg_proc where oid = 'public.staff_submit_eod(uuid, uuid, date, text, text, jsonb, uuid)'::regprocedure),
  true, '(45) AC-12: staff_submit_eod is still SECURITY DEFINER');
select is(
  (select proconfig from pg_proc where oid = 'public.staff_submit_eod(uuid, uuid, date, text, text, jsonb, uuid)'::regprocedure),
  array['search_path=public']::text[], '(46) AC-12: staff_submit_eod pins search_path = public');
select ok(has_function_privilege('authenticated',
  'public.staff_submit_eod(uuid, uuid, date, text, text, jsonb, uuid)', 'execute'),
  '(47) AC-12: authenticated keeps EXECUTE on staff_submit_eod');
select ok(not has_function_privilege('anon',
  'public.staff_submit_eod(uuid, uuid, date, text, text, jsonb, uuid)', 'execute'),
  '(48) AC-12: anon lacks EXECUTE on staff_submit_eod');
select ok(not has_function_privilege('service_role',
  'public.staff_submit_eod(uuid, uuid, date, text, text, jsonb, uuid)', 'execute'),
  '(49) AC-12: service_role lacks EXECUTE on staff_submit_eod');
select has_trigger('public', 'eod_entries', 'eod_entries_check_store_trg',
  '(50) AC-12: eod_entries_check_store_trg still exists');

set local role authenticated;
select set_config('request.jwt.claims', current_setting('test.claims_user', true), true);
select throws_ok(
  format($q$insert into public.eod_entries (submission_id, item_id, actual_remaining, notes, no_need)
            values (%L::uuid, %L::uuid, 1, '', false)$q$,
    current_setting('test.r1', true)::jsonb ->> 'submission_id',
    current_setting('test.ix', true)),
  '42501', 'eod_entries: item store mismatch with parent submission',
  '(51) AC-12: a store member''s direct INSERT of X under their own Frederick submission still raises the trigger''s 42501');
reset role;
select set_config('request.jwt.claims', '', true);

select is(
  (select prosecdef from pg_proc where oid = 'public.eod_write_submission(uuid, date, uuid, text, jsonb, uuid, uuid[], text, uuid)'::regprocedure),
  false, '(52) AC-12: eod_write_submission is still SECURITY INVOKER');
select is(
  (select proconfig from pg_proc where oid = 'public.eod_write_submission(uuid, date, uuid, text, jsonb, uuid, uuid[], text, uuid)'::regprocedure),
  array['search_path=public']::text[], '(53) AC-12: eod_write_submission still pins search_path = public');
select ok(
  not has_function_privilege('authenticated',
    'public.eod_write_submission(uuid, date, uuid, text, jsonb, uuid, uuid[], text, uuid)', 'execute')
  and (select proacl from pg_proc where oid = 'public.eod_write_submission(uuid, date, uuid, text, jsonb, uuid, uuid[], text, uuid)'::regprocedure) is not null,
  '(54) AC-12: eod_write_submission still has no authenticated EXECUTE and a non-NULL (revoked) ACL');


-- ═══ SK13 — R10 structural pin ═══════════════════════════════════
select ok(
  -- Comments stripped first: the body's own comment mentions FOR KEY SHARE,
  -- so a bare ilike would still pass if the clause itself were dropped.
  regexp_replace(
    (select prosrc from pg_proc where oid = 'public.staff_submit_eod(uuid, uuid, date, text, text, jsonb, uuid)'::regprocedure),
    '--[^\n]*', '', 'g')
    ~* 'for\s+key\s+share\s+of\s+ii',
  '(55) R10: staff_submit_eod locks the checked inventory_items rows FOR KEY SHARE OF ii, outside comments (a pin, not a concurrency test)');


-- ═══ SKX — design §4 edge cases (A - 14) ═════════════════════════
set local role authenticated;
select set_config('request.jwt.claims', current_setting('test.claims_user', true), true);
select throws_ok(
  format($q$select public.staff_submit_eod(gen_random_uuid(), %L::uuid, %L::date, null, 'submitted',
              jsonb_build_array(jsonb_build_object('ingredient_id', %L::uuid, 'actual_remaining', 1),
                                jsonb_build_object('ingredient_id', 'not-a-uuid')), %L::uuid)$q$,
    current_setting('test.frederick', true),
    current_setting('test.anchor', true)::date - 14,
    current_setting('test.i1', true),
    current_setting('test.v', true)),
  '22P02', null,
  '(56) design §4: a non-uuid ingredient_id string still raises 22P02');
select set_config('test.rx', public.staff_submit_eod(gen_random_uuid(),
  current_setting('test.frederick', true)::uuid,
  current_setting('test.anchor', true)::date - 14, null, 'submitted',
  jsonb_build_array(
    jsonb_build_object('ingredient_id', current_setting('test.i1', true)::uuid, 'actual_remaining', 1),
    jsonb_build_object('ingredient_id', current_setting('test.d', true)::uuid, 'no_need', true, 'actual_remaining', 5)),
  current_setting('test.v', true)::uuid)::text, true);
reset role;
select set_config('request.jwt.claims', '', true);

select is(current_setting('test.rx', true)::jsonb -> 'skipped_item_ids',
  jsonb_build_array(current_setting('test.d', true)),
  '(57) R2: a skipped NO NEED element carrying a quantity raises nothing (never evaluated) and is reported');

select * from finish();
rollback;
