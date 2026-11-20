-- supabase/tests/po_number_server_assigned.test.sql
--
-- Spec 196 — pgTAP coverage for public.purchase_orders_po_number_guard() and
-- trigger purchase_orders_po_number_guard_trg in
-- supabase/migrations/20261109200000_po_number_server_assigned.sql.
--
--   A  catalog: AC-13 (INVOKER, search_path, owner, EXECUTE revoked), AC-12
--      (anon in the one role literal; body reads no claims / no auth.*), AC-14
--      (wiring, no column list, no WHEN, sorts before set_po_number, first
--      BEFORE ROW INSERT trigger), AC-15 (spec 190 objects unchanged)
--   C  staff (authenticated): AC-1, AC-2, AC-3, AC-4 refusals; AC-6, AC-7,
--      AC-8 allowed updates; AC-5 generated inserts
--   D  brand admin: anti-vacuity, AC-1, AC-3, AC-5
--   E  super_admin: anti-vacuity, AC-1
--   F  service_role: AC-9, AC-10
--   G  postgres, claims cleared: AC-9, AC-10
--   H  postgres with stale staff claims: AC-11
--   I  read-back as postgres, claims cleared, by fixture id
--
-- House rules (spec 196 D-10):
--   * Every refusal is throws_ok(..., 'P0001', 'po_number is server-assigned'),
--     so an RLS 42501 or a spec 177/194 refusal can't pass as this guard.
--   * Every allowed UPDATE is is(pg_temp.try_sql(...), 'ok:1'), so a 0-row
--     update (RLS, a wrong WHERE) can't pass as success.
--   * Sequence state is read and format_po_number is called only as postgres.
--     Explicit numbers are format_po_number(seq_next() + 10000 + k), computed
--     once after the fixtures, so no arm reaches spec 190's skip loop. The file
--     never calls setval. SEQUENCE VALUES PERSIST across the rollback (gaps are
--     accepted by spec 190), so no arm asserts an absolute number.
--   * No `set role anon` (segfaults CI, spec 067). anon is evidenced by the
--     AC-12 prosrc arm and the AC-13 has_function_privilege arm.
--
-- Hermetic (begin; … rollback;). Fixture uuid prefix b196…:
--   b1960001 brand B   b1960002 store S   b1960003 users (1 staff, 2 admin,
--   3 super_admin)   b1960004 POs   b1960005 catalog (01), item (02), line (03)
-- PO ids: 1-13 fixtures P1..P13 (generated as postgres); 21-23 AC-1 attempts
-- (staff/admin/super_admin); 31-33 AC-2(a); 34-36 AC-2(b); 41-44 AC-5 (staff
-- omit, staff null, admin omit, admin null); 51 AC-9 postgres; 52 AC-9
-- service_role; 53 AC-11.

begin;
create extension if not exists pgtap;

select plan(68);

-- ─── helpers ────────────────────────────────────────────────────────────────
create function pg_temp.bid(n int) returns uuid language sql immutable as
  $$ select ('b1960001-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid $$;
create function pg_temp.sid(n int) returns uuid language sql immutable as
  $$ select ('b1960002-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid $$;
create function pg_temp.uid(n int) returns uuid language sql immutable as
  $$ select ('b1960003-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid $$;
create function pg_temp.pid(n int) returns uuid language sql immutable as
  $$ select ('b1960004-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid $$;
create function pg_temp.fid(n int) returns uuid language sql immutable as
  $$ select ('b1960005-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid $$;

create function pg_temp.login(p_uid uuid, p_app_role text) returns void
language plpgsql as $$
begin
  perform set_config('request.jwt.claims', jsonb_build_object(
    'sub', p_uid, 'role', 'authenticated',
    'app_metadata', jsonb_build_object('role', p_app_role))::text, true);
end $$;

-- The value the next nextval() will return. postgres only.
create function pg_temp.seq_next() returns bigint language sql volatile as $$
  select case when is_called then last_value + 1 else last_value end
    from public.purchase_orders_po_number_seq
$$;

-- po_number by id. postgres only (reads past RLS).
create function pg_temp.po(p_id uuid) returns text language sql stable as $$
  select po_number from public.purchase_orders where id = p_id
$$;

-- Returns 'ok:<row_count>' or the SQLSTATE (kept_records_delete_hardening).
create function pg_temp.try_sql(p_sql text) returns text
language plpgsql as $$
declare
  v_n bigint;
begin
  execute p_sql;
  get diagnostics v_n = row_count;
  return 'ok:' || v_n;
exception when others then
  return sqlstate;
end;
$$;

-- ═══ A. Catalog (postgres, before fixtures) ════════════════════════════════
-- AC-13
select is(
  (select prosecdef from pg_proc where oid = 'public.purchase_orders_po_number_guard()'::regprocedure),
  false,
  'AC-13: purchase_orders_po_number_guard is SECURITY INVOKER'
);
select is(
  (select proconfig from pg_proc where oid = 'public.purchase_orders_po_number_guard()'::regprocedure),
  array['search_path=public'],
  'AC-13: purchase_orders_po_number_guard pins search_path=public'
);
select is(
  (select pg_get_userbyid(proowner)::text from pg_proc
    where oid = 'public.purchase_orders_po_number_guard()'::regprocedure),
  'postgres',
  'AC-13: purchase_orders_po_number_guard is owned by postgres'
);
select ok(
  not has_function_privilege('public', 'public.purchase_orders_po_number_guard()', 'EXECUTE'),
  'AC-13: PUBLIC cannot EXECUTE purchase_orders_po_number_guard'
);
select ok(
  not has_function_privilege('anon', 'public.purchase_orders_po_number_guard()', 'EXECUTE'),
  'AC-13: anon cannot EXECUTE purchase_orders_po_number_guard'
);
select ok(
  not has_function_privilege('authenticated', 'public.purchase_orders_po_number_guard()', 'EXECUTE'),
  'AC-13: authenticated cannot EXECUTE purchase_orders_po_number_guard'
);

-- AC-12
select ok(
  (select prosrc ~* $re$current_user\s+not\s+in\s*\(\s*'anon'\s*,\s*'authenticated'\s*\)$re$
     from pg_proc where oid = 'public.purchase_orders_po_number_guard()'::regprocedure),
  'AC-12: the one role test is current_user not in (''anon'', ''authenticated'')'
);
select ok(
  (select prosrc !~* 'jwt'
     from pg_proc where oid = 'public.purchase_orders_po_number_guard()'::regprocedure),
  'AC-12/R3: the guard body never mentions jwt (reads no claims)'
);
select ok(
  (select prosrc !~* 'auth\.'
     from pg_proc where oid = 'public.purchase_orders_po_number_guard()'::regprocedure),
  'AC-12/R3: the guard body calls no auth.* function'
);

-- AC-14
select is(
  (select tgenabled::text from pg_trigger
    where tgrelid = 'public.purchase_orders'::regclass
      and tgname = 'purchase_orders_po_number_guard_trg'),
  'O',
  'AC-14: purchase_orders_po_number_guard_trg exists and is enabled'
);
select is(
  (select tgtype::int from pg_trigger
    where tgrelid = 'public.purchase_orders'::regclass
      and tgname = 'purchase_orders_po_number_guard_trg'),
  23,
  'AC-14: tgtype = 23 (ROW + BEFORE + INSERT + UPDATE; no DELETE, no TRUNCATE)'
);
select is(
  (select cardinality(tgattr::int2[]) from pg_trigger
    where tgrelid = 'public.purchase_orders'::regclass
      and tgname = 'purchase_orders_po_number_guard_trg'),
  0,
  'AC-14: no column list (fires on every UPDATE and sees the final NEW)'
);
select ok(
  (select tgqual is null from pg_trigger
    where tgrelid = 'public.purchase_orders'::regclass
      and tgname = 'purchase_orders_po_number_guard_trg'),
  'AC-14: no WHEN clause'
);
select is(
  (select tgfoid from pg_trigger
    where tgrelid = 'public.purchase_orders'::regclass
      and tgname = 'purchase_orders_po_number_guard_trg'),
  'public.purchase_orders_po_number_guard()'::regprocedure::oid,
  'AC-14: the trigger runs public.purchase_orders_po_number_guard()'
);
select ok(
  'purchase_orders_po_number_guard_trg' collate "C" < 'set_po_number' collate "C",
  'AC-14: the guard''s name sorts before set_po_number (C collation)'
);
select is(
  (select tgname::text from pg_trigger
    where tgrelid = 'public.purchase_orders'::regclass
      and not tgisinternal
      and tgtype & 7 = 7
    order by tgname collate "C"
    limit 1),
  'purchase_orders_po_number_guard_trg',
  'AC-14: the guard is the FIRST BEFORE ROW INSERT trigger on purchase_orders'
);

-- AC-15
select is(
  (select prosecdef from pg_proc where oid = 'public.generate_po_number()'::regprocedure),
  true,
  'AC-15: generate_po_number stays SECURITY DEFINER'
);
select is(
  (select proconfig from pg_proc where oid = 'public.generate_po_number()'::regprocedure),
  array['search_path=public'],
  'AC-15: generate_po_number keeps search_path=public'
);
select ok(
  (select pg_get_triggerdef(oid) ilike '%when ((new.po_number is null))%'
     from pg_trigger
    where tgrelid = 'public.purchase_orders'::regclass and tgname = 'set_po_number'),
  'AC-15: set_po_number keeps WHEN (new.po_number IS NULL)'
);

-- ═══ B. Fixtures (postgres) ════════════════════════════════════════════════
-- Brand B, store S. uid(1) staff (role user, member of S), uid(2) brand-B
-- admin, uid(3) super_admin (brand_id NULL per profiles_role_brand_consistent).
insert into public.brands (id, name) values (pg_temp.bid(1), '__s196_brand_b__');

insert into public.stores (id, brand_id, name, address, status) values
  (pg_temp.sid(1), pg_temp.bid(1), 's196 store S', '1 Spec Way', 'active');

insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password,
  email_confirmed_at, created_at, updated_at,
  raw_app_meta_data, raw_user_meta_data, is_super_admin, is_anonymous,
  confirmation_token, recovery_token, email_change_token_new, email_change,
  email_change_token_current, phone_change, phone_change_token, reauthentication_token
)
select pg_temp.uid(v.n), '00000000-0000-0000-0000-000000000000',
       'authenticated', 'authenticated', 's196-' || v.n || '@local.test', '',
       now(), now(), now(),
       jsonb_build_object('provider', 'email', 'role', v.r), '{}'::jsonb, false, false,
       '', '', '', '', '', '', '', ''
  from (values (1, 'user'), (2, 'admin'), (3, 'super_admin')) as v(n, r);

insert into public.profiles (id, name, role, initials, color, status, brand_id) values
  (pg_temp.uid(1), 's196 store-S staff',  'user',        'SS', '#888888', 'active', pg_temp.bid(1)),
  (pg_temp.uid(2), 's196 brand-B admin',  'admin',       'BA', '#888888', 'active', pg_temp.bid(1)),
  (pg_temp.uid(3), 's196 super admin',    'super_admin', 'SA', '#888888', 'active', null)
on conflict (id) do update
  set role = excluded.role, brand_id = excluded.brand_id, name = excluded.name;

insert into public.user_stores (user_id, store_id) values (pg_temp.uid(1), pg_temp.sid(1));

insert into public.catalog_ingredients (id, brand_id, name, unit, case_qty, sub_unit_size, default_cost) values
  (pg_temp.fid(1), pg_temp.bid(1), '__test_spec196_item__', 'each', 4, 1, 5);

insert into public.inventory_items (id, store_id, catalog_id, case_price, cost_per_unit, current_stock, par_level, usage_per_portion) values
  (pg_temp.fid(2), pg_temp.sid(1), pg_temp.fid(1), 20, 5, 0, 0, 0);

-- P1..P13: drafts, po_number omitted (generated).
insert into public.purchase_orders (id, store_id, status, total_cost)
select pg_temp.pid(n), pg_temp.sid(1), 'draft', 0
  from generate_series(1, 13) as n;

-- P11: one line, then moved to 'sent' as postgres (AC-8 receive target).
insert into public.po_items (id, po_id, item_id, ordered_qty) values
  (pg_temp.fid(3), pg_temp.pid(11), pg_temp.fid(2), 2);
update public.purchase_orders set status = 'sent' where id = pg_temp.pid(11);

-- test.orig_P<n>: each fixture's generated number, for the read-backs.
do $$
begin
  for n in 1..13 loop
    perform set_config('test.orig_P' || n, pg_temp.po(pg_temp.pid(n)), true);
  end loop;
end $$;

-- Explicit numbers, far ahead of the sequence (computed last).
do $$
declare
  v_base bigint := pg_temp.seq_next() + 10000;
  v_names text[] := array[
    'n_ins_staff', 'n_ins_admin', 'n_ins_super',      -- k = 1..3   AC-1
    'n_2a_1', 'n_2a_2', 'n_2a_3', 'n_2b',              -- k = 4..7   AC-2
    'n_upd_staff', 'n_upd_admin',                      -- k = 8..9   AC-3
    'n_a', 'n_b',                                      -- k = 10..11 AC-4
    'n_sr_ins', 'n_sr_upd', 'n_pg_ins', 'n_pg_upd',    -- k = 12..15 AC-9/10
    'n_stale'];                                        -- k = 16     AC-11
begin
  for k in 1..array_length(v_names, 1) loop
    perform set_config('test.' || v_names[k], public.format_po_number(v_base + k), true);
  end loop;
end $$;

-- ═══ C. Staff (authenticated) ══════════════════════════════════════════════
set local role authenticated;
select pg_temp.login(pg_temp.uid(1), 'user');

-- AC-1 staff
select throws_ok(
  $$insert into public.purchase_orders (id, store_id, status, po_number)
    values (pg_temp.pid(21), pg_temp.sid(1), 'draft', current_setting('test.n_ins_staff'))$$,
  'P0001', 'po_number is server-assigned',
  'AC-1: staff cannot INSERT an explicit po_number'
);

-- AC-2 (a): three rows, all explicit.
select throws_ok(
  $$insert into public.purchase_orders (id, store_id, status, po_number) values
      (pg_temp.pid(31), pg_temp.sid(1), 'draft', current_setting('test.n_2a_1')),
      (pg_temp.pid(32), pg_temp.sid(1), 'draft', current_setting('test.n_2a_2')),
      (pg_temp.pid(33), pg_temp.sid(1), 'draft', current_setting('test.n_2a_3'))$$,
  'P0001', 'po_number is server-assigned',
  'AC-2: a staff multi-row INSERT of explicit numbers is refused'
);
-- AC-2 (b): two NULL rows first (they pass both triggers), explicit row LAST.
select throws_ok(
  $$insert into public.purchase_orders (id, store_id, status, po_number) values
      (pg_temp.pid(34), pg_temp.sid(1), 'draft', null),
      (pg_temp.pid(35), pg_temp.sid(1), 'draft', null),
      (pg_temp.pid(36), pg_temp.sid(1), 'draft', current_setting('test.n_2b'))$$,
  'P0001', 'po_number is server-assigned',
  'AC-2: a staff multi-row INSERT mixing NULL rows with one explicit row (last) is refused'
);

-- AC-3 staff
select throws_ok(
  $$update public.purchase_orders set po_number = current_setting('test.n_upd_staff')
     where id = pg_temp.pid(1)$$,
  'P0001', 'po_number is server-assigned',
  'AC-3: staff cannot UPDATE a PO onto another number'
);
select throws_ok(
  $$update public.purchase_orders set po_number = null where id = pg_temp.pid(3)$$,
  'P0001', 'po_number is server-assigned',
  'AC-3: staff cannot UPDATE a numbered PO to NULL'
);

-- AC-4
select throws_ok(
  $$update public.purchase_orders
       set po_number = case id when pg_temp.pid(4) then current_setting('test.n_a')
                               when pg_temp.pid(5) then current_setting('test.n_b') end
     where id in (pg_temp.pid(4), pg_temp.pid(5))$$,
  'P0001', 'po_number is server-assigned',
  'AC-4: a staff UPDATE renumbering two POs is refused'
);

-- AC-6
select is(
  pg_temp.try_sql($q$update public.purchase_orders set status = 'sent'
                      where id = 'b1960004-0000-0000-0000-000000000006'$q$),
  'ok:1',
  'AC-6: staff status draft->sent (markPurchaseOrderSent shape) succeeds'
);
select is(
  pg_temp.try_sql($q$update public.purchase_orders set status = 'sent'
                      where id = 'b1960004-0000-0000-0000-000000000007' and status = 'draft'$q$),
  'ok:1',
  'AC-6: staff extension markOrdered shape (where status = ''draft'') succeeds'
);
select is(
  pg_temp.try_sql($q$update public.purchase_orders set total_cost = 42
                      where id = 'b1960004-0000-0000-0000-000000000008'$q$),
  'ok:1',
  'AC-6: staff total_cost update succeeds'
);

-- AC-7
select is(
  pg_temp.try_sql($q$update public.purchase_orders set po_number = po_number
                      where id = 'b1960004-0000-0000-0000-000000000009'$q$),
  'ok:1',
  'AC-7: staff set po_number = po_number succeeds'
);
select is(
  pg_temp.try_sql(format(
    $q$update public.purchase_orders set po_number = %L, status = 'sent'
        where id = 'b1960004-0000-0000-0000-000000000010'$q$,
    current_setting('test.orig_P10'))),
  'ok:1',
  'AC-7: staff PATCH echoing the current po_number literal with a status change succeeds'
);

-- AC-8: receive_purchase_order is SECURITY INVOKER, so its UPDATE runs as
-- authenticated and goes through the guard's client branch.
select is(
  pg_temp.try_sql($q$select public.receive_purchase_order(
      'b1960004-0000-0000-0000-000000000011',
      '[{"po_item_id":"b1960005-0000-0000-0000-000000000003","received_qty":2}]'::jsonb,
      'b19600ee-0000-0000-0000-000000000001'::uuid)$q$),
  'ok:1',
  'AC-8: staff receive_purchase_order on a sent PO succeeds'
);

-- AC-5 staff: omit, then explicit NULL. Each expected value is stashed as
-- postgres immediately before the insert.
reset role;
select set_config('test.exp_41', public.format_po_number(pg_temp.seq_next()), true);
set local role authenticated;
select pg_temp.login(pg_temp.uid(1), 'user');
select lives_ok(
  $$insert into public.purchase_orders (id, store_id, status)
    values (pg_temp.pid(41), pg_temp.sid(1), 'draft')$$,
  'AC-5: staff INSERT omitting po_number succeeds'
);

reset role;
select set_config('test.exp_42', public.format_po_number(pg_temp.seq_next()), true);
set local role authenticated;
select pg_temp.login(pg_temp.uid(1), 'user');
select lives_ok(
  $$insert into public.purchase_orders (id, store_id, status, po_number)
    values (pg_temp.pid(42), pg_temp.sid(1), 'draft', null)$$,
  'AC-5: staff INSERT with po_number = NULL succeeds'
);

-- ═══ D. Admin (authenticated) ══════════════════════════════════════════════
reset role;
set local role authenticated;
select pg_temp.login(pg_temp.uid(2), 'admin');

select ok(
  public.auth_can_see_store(pg_temp.sid(1)),
  'D anti-vacuity: the brand-B admin can see store S'
);
select throws_ok(
  $$insert into public.purchase_orders (id, store_id, status, po_number)
    values (pg_temp.pid(22), pg_temp.sid(1), 'draft', current_setting('test.n_ins_admin'))$$,
  'P0001', 'po_number is server-assigned',
  'AC-1: a brand admin cannot INSERT an explicit po_number'
);
select throws_ok(
  $$update public.purchase_orders set po_number = current_setting('test.n_upd_admin')
     where id = pg_temp.pid(2)$$,
  'P0001', 'po_number is server-assigned',
  'AC-3: a brand admin cannot UPDATE a PO onto another number'
);

reset role;
select set_config('test.exp_43', public.format_po_number(pg_temp.seq_next()), true);
set local role authenticated;
select pg_temp.login(pg_temp.uid(2), 'admin');
select lives_ok(
  $$insert into public.purchase_orders (id, store_id, status)
    values (pg_temp.pid(43), pg_temp.sid(1), 'draft')$$,
  'AC-5: admin INSERT omitting po_number succeeds'
);

reset role;
select set_config('test.exp_44', public.format_po_number(pg_temp.seq_next()), true);
set local role authenticated;
select pg_temp.login(pg_temp.uid(2), 'admin');
select lives_ok(
  $$insert into public.purchase_orders (id, store_id, status, po_number)
    values (pg_temp.pid(44), pg_temp.sid(1), 'draft', null)$$,
  'AC-5: admin INSERT with po_number = NULL succeeds'
);

-- ═══ E. Super_admin (authenticated) ════════════════════════════════════════
-- Anti-vacuity matters here: a BEFORE trigger fires before RLS WITH CHECK, so
-- a refusal alone can't prove the caller could otherwise write.
reset role;
set local role authenticated;
select pg_temp.login(pg_temp.uid(3), 'super_admin');

select ok(
  public.auth_can_see_store(pg_temp.sid(1)),
  'E anti-vacuity: the super_admin can see store S'
);
select throws_ok(
  $$insert into public.purchase_orders (id, store_id, status, po_number)
    values (pg_temp.pid(23), pg_temp.sid(1), 'draft', current_setting('test.n_ins_super'))$$,
  'P0001', 'po_number is server-assigned',
  'AC-1: a super_admin cannot INSERT an explicit po_number'
);

-- ═══ F. service_role ═══════════════════════════════════════════════════════
reset role;
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

select lives_ok(
  $$insert into public.purchase_orders (id, store_id, status, po_number)
    values (pg_temp.pid(52), pg_temp.sid(1), 'draft', current_setting('test.n_sr_ins'))$$,
  'AC-9: service_role INSERT with an explicit po_number succeeds'
);
select is(
  pg_temp.try_sql(format(
    $q$update public.purchase_orders set po_number = %L
        where id = 'b1960004-0000-0000-0000-000000000013'$q$,
    current_setting('test.n_sr_upd'))),
  'ok:1',
  'AC-10: service_role UPDATE changing po_number succeeds'
);

-- ═══ G. postgres, claims cleared ═══════════════════════════════════════════
reset role;
select set_config('request.jwt.claims', '', true);

select lives_ok(
  $$insert into public.purchase_orders (id, store_id, status, po_number)
    values (pg_temp.pid(51), pg_temp.sid(1), 'draft', current_setting('test.n_pg_ins'))$$,
  'AC-9: postgres INSERT with an explicit po_number succeeds'
);
select is(
  pg_temp.try_sql(format(
    $q$update public.purchase_orders set po_number = %L
        where id = 'b1960004-0000-0000-0000-000000000012'$q$,
    current_setting('test.n_pg_upd'))),
  'ok:1',
  'AC-10: postgres UPDATE changing po_number succeeds'
);

-- ═══ H. postgres with stale staff claims ═══════════════════════════════════
set local role authenticated;
select pg_temp.login(pg_temp.uid(1), 'user');
reset role;

select is(current_user::text, 'postgres', 'H anti-vacuity: current_user is postgres');
select is(
  current_setting('request.jwt.claims')::jsonb ->> 'sub',
  pg_temp.uid(1)::text,
  'H anti-vacuity: the staff claims are still set'
);
select lives_ok(
  $$insert into public.purchase_orders (id, store_id, status, po_number)
    values (pg_temp.pid(53), pg_temp.sid(1), 'draft', current_setting('test.n_stale'))$$,
  'AC-11: postgres with stale staff claims can INSERT an explicit po_number (test is current_user)'
);

-- ═══ I. Read-back (postgres, claims cleared) ═══════════════════════════════
reset role;
select set_config('request.jwt.claims', '', true);

-- AC-1
select is(
  (select count(*)::int from public.purchase_orders
    where id in (pg_temp.pid(21), pg_temp.pid(22), pg_temp.pid(23))),
  0,
  'AC-1 read-back: none of the three refused inserts wrote a row'
);
select is(
  (select count(*)::int from public.purchase_orders
    where po_number in (current_setting('test.n_ins_staff'),
                        current_setting('test.n_ins_admin'),
                        current_setting('test.n_ins_super'))),
  0,
  'AC-1 read-back: no row holds any of the three attempted numbers'
);

-- AC-2
select is(
  (select count(*)::int from public.purchase_orders
    where id in (pg_temp.pid(31), pg_temp.pid(32), pg_temp.pid(33),
                 pg_temp.pid(34), pg_temp.pid(35), pg_temp.pid(36))),
  0,
  'AC-2 read-back: no row from either multi-row INSERT exists (NULL rows included)'
);

-- AC-3
select is(
  format('a=%s b=%s c=%s',
    pg_temp.po(pg_temp.pid(1)) = current_setting('test.orig_P1'),
    pg_temp.po(pg_temp.pid(2)) = current_setting('test.orig_P2'),
    pg_temp.po(pg_temp.pid(3)) = current_setting('test.orig_P3')),
  'a=t b=t c=t',
  'AC-3 read-back: P1, P2 and P3 keep their original numbers'
);

-- AC-4
select is(
  format('a=%s b=%s',
    pg_temp.po(pg_temp.pid(4)) = current_setting('test.orig_P4'),
    pg_temp.po(pg_temp.pid(5)) = current_setting('test.orig_P5')),
  'a=t b=t',
  'AC-4 read-back: P4 and P5 keep their original numbers'
);

-- AC-5
select is(pg_temp.po(pg_temp.pid(41)), current_setting('test.exp_41'),
  'AC-5 read-back: staff omitted insert got the next sequence value');
select is(pg_temp.po(pg_temp.pid(42)), current_setting('test.exp_42'),
  'AC-5 read-back: staff NULL insert got the next sequence value');
select is(pg_temp.po(pg_temp.pid(43)), current_setting('test.exp_43'),
  'AC-5 read-back: admin omitted insert got the next sequence value');
select is(pg_temp.po(pg_temp.pid(44)), current_setting('test.exp_44'),
  'AC-5 read-back: admin NULL insert got the next sequence value');
select ok(
  (select count(*) = 4 and bool_and(po_number ~ '^PO-[0-9]{3,}$')
     from public.purchase_orders
    where id in (pg_temp.pid(41), pg_temp.pid(42), pg_temp.pid(43), pg_temp.pid(44))),
  'AC-5 read-back: all four generated numbers match ^PO-[0-9]{3,}$'
);

-- AC-6
select is(
  (select status || '/' || (po_number = current_setting('test.orig_P6'))::text
     from public.purchase_orders where id = pg_temp.pid(6)),
  'sent/true',
  'AC-6 read-back: P6 is sent and keeps its number'
);
select is(
  (select status || '/' || (po_number = current_setting('test.orig_P7'))::text
     from public.purchase_orders where id = pg_temp.pid(7)),
  'sent/true',
  'AC-6 read-back: P7 is sent and keeps its number'
);
select is(
  (select total_cost::text || '/' || (po_number = current_setting('test.orig_P8'))::text
     from public.purchase_orders where id = pg_temp.pid(8)),
  '42.00/true',
  'AC-6 read-back: P8 total_cost is 42 and keeps its number'
);

-- AC-7
select is(pg_temp.po(pg_temp.pid(9)), current_setting('test.orig_P9'),
  'AC-7 read-back: P9 keeps its number');
select is(
  (select status || '/' || (po_number = current_setting('test.orig_P10'))::text
     from public.purchase_orders where id = pg_temp.pid(10)),
  'sent/true',
  'AC-7 read-back: P10 is sent and keeps its number'
);

-- AC-8
select is(
  (select status || '/' || (po_number = current_setting('test.orig_P11'))::text
     from public.purchase_orders where id = pg_temp.pid(11)),
  'received/true',
  'AC-8 read-back: P11 is received and keeps its number'
);

-- AC-9
select is(pg_temp.po(pg_temp.pid(51)), current_setting('test.n_pg_ins'),
  'AC-9 read-back: the postgres explicit number is kept');
select is(pg_temp.po(pg_temp.pid(52)), current_setting('test.n_sr_ins'),
  'AC-9 read-back: the service_role explicit number is kept');

-- AC-10
select is(pg_temp.po(pg_temp.pid(12)), current_setting('test.n_pg_upd'),
  'AC-10 read-back: P12 has the number postgres set');
select is(pg_temp.po(pg_temp.pid(13)), current_setting('test.n_sr_upd'),
  'AC-10 read-back: P13 has the number service_role set');

-- AC-11
select is(pg_temp.po(pg_temp.pid(53)), current_setting('test.n_stale'),
  'AC-11 read-back: the stale-claims postgres explicit number is kept');

select * from finish();
rollback;
