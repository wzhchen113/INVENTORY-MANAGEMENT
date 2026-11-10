-- supabase/tests/generate_po_number_sequence.test.sql
--
-- Spec 190 — pgTAP coverage for the sequence-backed public.generate_po_number()
-- in supabase/migrations/20261109140000_po_number_sequence.sql.
--
--   AC-8   the sequence's next value is past every 'PO-<digits>' row (first,
--          before any fixture)
--   DP-1   generate_po_number is SECURITY DEFINER, purchase_orders is not FORCE
--          RLS, and the function owner owns the table (or bypasses RLS)
--   DP-2   anon / authenticated cannot EXECUTE either function
--   DP-3   anon / authenticated have no USAGE / SELECT / UPDATE on the sequence
--   DP-4   sequence shape (bigint, no cycle, cache 1, increment 1, min 1) and
--          pg_get_serial_sequence finds it through OWNED BY
--   DP-5   format_po_number is IMMUTABLE, INVOKER, search_path pinned
--   AC-6   format: 7 / 42 / 999 -> PO-007 / PO-042 / PO-999
--   AC-7   no truncation: PO-1000 / PO-12345, and PO-1000-or-later through the
--          real trigger path
--   AC-1   a store member who cannot see the top PO (same brand, other store)
--          gets a fresh number, no 23505
--   AC-2   a brand-A admin, while brand B holds the top PO, gets a fresh number
--   AC-3   numbers go up across owner / member / admin callers
--   AC-5   a deleted number is not reissued
--   AC-9   an explicit po_number is kept and does not advance the sequence
--   AC-10  the trigger skips a taken number it cannot see under RLS
--   AC-11  malformed rows ('PO-SAMS-PASS-1', 'LEGACY-99') don't break inserts
--   DP-6   100 taken numbers in a row -> 54000 with the designed message, and
--          the next insert clears itself (LAST: it burns about 100 numbers)
--   AC-4   (concurrency) is argued in spec 190 D-7 and exercised by
--          scripts/smoke-po-number-concurrency.sh, not here.
--
-- SEQUENCE VALUES PERSIST. nextval()/setval() are not undone by this file's
-- `rollback`, and the local database is shared. So no assertion depends on an
-- absolute sequence value unless the file set it, and the sequence is only ever
-- moved UP (AC-7 lifts it to 999 once if it is below that; DP-6 burns ~100 per
-- run). Gaps are accepted by the spec.
--
-- Sequence state is read and format_po_number is called only as postgres:
-- after spec 190, authenticated has neither SELECT on the sequence nor EXECUTE
-- on the formatter. Every role switch is `set local role authenticated` plus a
-- request.jwt.claims blob; `reset role` returns to postgres, which owns
-- purchase_orders and so reads every row regardless of RLS. No `set role anon`
-- (segfaults CI per spec 067); anon is checked with has_*_privilege.
--
-- Fixtures are hermetic (begin; … rollback;): two fresh brands, three stores,
-- a role-`user` member of store X only, and a brand-A admin. Every PO carries an
-- explicit id and is looked up by it (created_at is the transaction timestamp,
-- identical for every row here). status 'draft' keeps tg_notify_purchase_order
-- out of the way.

begin;
create extension if not exists pgtap;

select plan(57);

-- ─── helpers ────────────────────────────────────────────────────────────────
create function pg_temp.bid(n int) returns uuid language sql immutable as
  $$ select ('b1900001-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid $$;
create function pg_temp.sid(n int) returns uuid language sql immutable as
  $$ select ('b1900002-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid $$;
create function pg_temp.uid(n int) returns uuid language sql immutable as
  $$ select ('b1900003-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid $$;
create function pg_temp.pid(n int) returns uuid language sql immutable as
  $$ select ('b1900004-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid $$;

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

-- (last_value, is_called) as text, for "state unchanged" checks. postgres only.
create function pg_temp.seq_state() returns text language sql volatile as $$
  select last_value::text || '/' || is_called::text
    from public.purchase_orders_po_number_seq
$$;

-- Numeric part of a PO's po_number, by id. postgres only (reads past RLS).
create function pg_temp.num(p_id uuid) returns bigint language sql stable as $$
  select (substring(po_number from '^PO-([0-9]+)$'))::bigint
    from public.purchase_orders where id = p_id
$$;

create function pg_temp.po(p_id uuid) returns text language sql stable as $$
  select po_number from public.purchase_orders where id = p_id
$$;

-- ═══ AC-8: seeded past existing numbers (before any fixture) ═══════════════
select ok(
  pg_temp.seq_next() > (
    select coalesce(max((substring(po_number from '^PO-([0-9]+)$'))::numeric), 0)
      from public.purchase_orders
  ),
  'AC-8: the sequence''s next value is greater than every PO-<digits> po_number'
);

-- ═══ DP-1: SECURITY DEFINER and the RLS bypass it relies on ════════════════
select ok(
  (select prosecdef from pg_proc where oid = 'public.generate_po_number()'::regprocedure),
  'DP-1: generate_po_number is SECURITY DEFINER'
);

select ok(
  not (select relforcerowsecurity from pg_class where oid = 'public.purchase_orders'::regclass),
  'DP-1: purchase_orders is not FORCE ROW LEVEL SECURITY'
);

select ok(
  (select p.proowner = c.relowner or r.rolbypassrls
     from pg_proc p
     join pg_roles r on r.oid = p.proowner
     cross join pg_class c
    where p.oid = 'public.generate_po_number()'::regprocedure
      and c.oid = 'public.purchase_orders'::regclass),
  'DP-1: generate_po_number''s owner owns purchase_orders (or bypasses RLS)'
);

-- ═══ DP-2: no client EXECUTE on either function ════════════════════════════
select ok(
  not has_function_privilege('anon', 'public.generate_po_number()', 'EXECUTE'),
  'DP-2: anon cannot EXECUTE generate_po_number()'
);
select ok(
  not has_function_privilege('authenticated', 'public.generate_po_number()', 'EXECUTE'),
  'DP-2: authenticated cannot EXECUTE generate_po_number()'
);
select ok(
  not has_function_privilege('anon', 'public.format_po_number(bigint)', 'EXECUTE'),
  'DP-2: anon cannot EXECUTE format_po_number(bigint)'
);
select ok(
  not has_function_privilege('authenticated', 'public.format_po_number(bigint)', 'EXECUTE'),
  'DP-2: authenticated cannot EXECUTE format_po_number(bigint)'
);

-- ═══ DP-3: no client privilege on the sequence ═════════════════════════════
select ok(
  not has_sequence_privilege('anon', 'public.purchase_orders_po_number_seq', 'USAGE'),
  'DP-3: anon has no USAGE on the sequence'
);
select ok(
  not has_sequence_privilege('anon', 'public.purchase_orders_po_number_seq', 'SELECT'),
  'DP-3: anon has no SELECT on the sequence'
);
select ok(
  not has_sequence_privilege('anon', 'public.purchase_orders_po_number_seq', 'UPDATE'),
  'DP-3: anon has no UPDATE on the sequence'
);
select ok(
  not has_sequence_privilege('authenticated', 'public.purchase_orders_po_number_seq', 'USAGE'),
  'DP-3: authenticated has no USAGE on the sequence'
);
select ok(
  not has_sequence_privilege('authenticated', 'public.purchase_orders_po_number_seq', 'SELECT'),
  'DP-3: authenticated has no SELECT on the sequence'
);
select ok(
  not has_sequence_privilege('authenticated', 'public.purchase_orders_po_number_seq', 'UPDATE'),
  'DP-3: authenticated has no UPDATE on the sequence'
);

-- ═══ DP-4: sequence shape ══════════════════════════════════════════════════
select is(
  (select seqtypid from pg_sequence where seqrelid = 'public.purchase_orders_po_number_seq'::regclass),
  'bigint'::regtype::oid,
  'DP-4: the sequence is bigint'
);
select is(
  (select seqcycle from pg_sequence where seqrelid = 'public.purchase_orders_po_number_seq'::regclass),
  false,
  'DP-4: the sequence is NO CYCLE'
);
select is(
  (select seqcache from pg_sequence where seqrelid = 'public.purchase_orders_po_number_seq'::regclass),
  1::bigint,
  'DP-4: the sequence has CACHE 1 (numbers stay in call order across sessions)'
);
select is(
  (select seqincrement from pg_sequence where seqrelid = 'public.purchase_orders_po_number_seq'::regclass),
  1::bigint,
  'DP-4: the sequence increments by 1'
);
select is(
  (select seqmin from pg_sequence where seqrelid = 'public.purchase_orders_po_number_seq'::regclass),
  1::bigint,
  'DP-4: the sequence has MINVALUE 1'
);
select is(
  pg_get_serial_sequence('public.purchase_orders', 'po_number'),
  'public.purchase_orders_po_number_seq',
  'DP-4: the sequence is OWNED BY purchase_orders.po_number'
);

-- ═══ DP-5: the formatter's shape ═══════════════════════════════════════════
select is(
  (select provolatile from pg_proc where oid = 'public.format_po_number(bigint)'::regprocedure),
  'i'::"char",
  'DP-5: format_po_number is IMMUTABLE'
);
select is(
  (select prosecdef from pg_proc where oid = 'public.format_po_number(bigint)'::regprocedure),
  false,
  'DP-5: format_po_number is SECURITY INVOKER'
);
select is(
  (select proconfig from pg_proc where oid = 'public.format_po_number(bigint)'::regprocedure),
  array['search_path=public'],
  'DP-5: format_po_number pins search_path=public'
);

-- ═══ AC-6 / AC-7: format in isolation ══════════════════════════════════════
select is(public.format_po_number(7),     'PO-007',   'AC-6: 7 -> PO-007');
select is(public.format_po_number(42),    'PO-042',   'AC-6: 42 -> PO-042');
select is(public.format_po_number(999),   'PO-999',   'AC-6: 999 -> PO-999');
select is(public.format_po_number(1000),  'PO-1000',  'AC-7: 1000 -> PO-1000 (no truncation)');
select is(public.format_po_number(12345), 'PO-12345', 'AC-7: 12345 -> PO-12345');

-- ─── fixtures (as postgres) ─────────────────────────────────────────────────
-- Brand A: store Z.  Brand B: stores X and Y.
-- uid(1): role `user`, brand B, member of X only (cannot see Y).
-- uid(2): role `admin`, brand A (sees Z, cannot see brand B).
insert into public.brands (id, name) values
  (pg_temp.bid(1), '__s190_brand_a__'),
  (pg_temp.bid(2), '__s190_brand_b__');

insert into public.stores (id, brand_id, name, address, status) values
  (pg_temp.sid(1), pg_temp.bid(2), 's190 store X (brand B)', '1 Spec Way', 'active'),
  (pg_temp.sid(2), pg_temp.bid(2), 's190 store Y (brand B)', '1 Spec Way', 'active'),
  (pg_temp.sid(3), pg_temp.bid(1), 's190 store Z (brand A)', '1 Spec Way', 'active');

insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password,
  email_confirmed_at, created_at, updated_at,
  raw_app_meta_data, raw_user_meta_data, is_super_admin, is_anonymous,
  confirmation_token, recovery_token, email_change_token_new, email_change,
  email_change_token_current, phone_change, phone_change_token, reauthentication_token
)
select pg_temp.uid(v.n), '00000000-0000-0000-0000-000000000000',
       'authenticated', 'authenticated', 's190-' || v.n || '@local.test', '',
       now(), now(), now(),
       jsonb_build_object('provider', 'email', 'role', v.r), '{}'::jsonb, false, false,
       '', '', '', '', '', '', '', ''
  from (values (1, 'user'), (2, 'admin')) as v(n, r);

insert into public.profiles (id, name, role, initials, color, status, brand_id) values
  (pg_temp.uid(1), 's190 store-X member', 'user',  'XM', '#888888', 'active', pg_temp.bid(2)),
  (pg_temp.uid(2), 's190 brand-A admin',  'admin', 'AA', '#888888', 'active', pg_temp.bid(1))
on conflict (id) do update
  set role = excluded.role, brand_id = excluded.brand_id, name = excluded.name;

insert into public.user_stores (user_id, store_id) values (pg_temp.uid(1), pg_temp.sid(1));

-- ═══ AC-1: same brand, another store ═══════════════════════════════════════
-- Store Y gets the highest number, generated as postgres.
insert into public.purchase_orders (id, store_id, status, total_cost)
values (pg_temp.pid(1), pg_temp.sid(2), 'draft', 0);

set local role authenticated;
select pg_temp.login(pg_temp.uid(1), 'user');

select ok(
  public.auth_can_see_store(pg_temp.sid(1))
    and not public.auth_can_see_store(pg_temp.sid(2))
    and (select count(*) from public.purchase_orders where id = pg_temp.pid(1)) = 0,
  'AC-1 anti-vacuity: the member sees store X but not store Y or Y''s top PO'
);

select lives_ok(
  $$insert into public.purchase_orders (id, store_id, status, total_cost)
    values (pg_temp.pid(2), pg_temp.sid(1), 'draft', 0)$$,
  'AC-1: a member who cannot see the top PO inserts with a NULL po_number (no 23505)'
);

reset role;

select is(
  (select count(*)::int from public.purchase_orders where po_number = pg_temp.po(pg_temp.pid(2))),
  1,
  'AC-1: the member''s generated number matches no other row table-wide'
);
select ok(
  pg_temp.num(pg_temp.pid(2)) > pg_temp.num(pg_temp.pid(1)),
  'AC-1: the member''s number is above store Y''s top number'
);

-- ═══ AC-2: another brand ═══════════════════════════════════════════════════
-- Brand B (store Y) gets the highest number, generated as postgres.
insert into public.purchase_orders (id, store_id, status, total_cost)
values (pg_temp.pid(3), pg_temp.sid(2), 'draft', 0);

set local role authenticated;
select pg_temp.login(pg_temp.uid(2), 'admin');

select ok(
  public.auth_can_see_store(pg_temp.sid(3))
    and not public.auth_can_see_store(pg_temp.sid(2))
    and (select count(*) from public.purchase_orders where id = pg_temp.pid(3)) = 0,
  'AC-2 anti-vacuity: the brand-A admin sees store Z but not brand B''s top PO'
);

select lives_ok(
  $$insert into public.purchase_orders (id, store_id, status, total_cost)
    values (pg_temp.pid(4), pg_temp.sid(3), 'draft', 0)$$,
  'AC-2: a brand-A admin inserts with a NULL po_number while brand B holds the top PO (no 23505)'
);

reset role;

select is(
  (select count(*)::int from public.purchase_orders where po_number = pg_temp.po(pg_temp.pid(4))),
  1,
  'AC-2: the admin''s generated number is unique table-wide'
);
select ok(
  pg_temp.num(pg_temp.pid(4)) > pg_temp.num(pg_temp.pid(3)),
  'AC-2: the admin''s number is above brand B''s top number'
);

-- ═══ AC-3: numbers go up across callers ════════════════════════════════════
-- owner (5) -> member (6) -> admin (7) -> owner (8)
insert into public.purchase_orders (id, store_id, status, total_cost)
values (pg_temp.pid(5), pg_temp.sid(2), 'draft', 0);

set local role authenticated;
select pg_temp.login(pg_temp.uid(1), 'user');
select lives_ok(
  $$insert into public.purchase_orders (id, store_id, status, total_cost)
    values (pg_temp.pid(6), pg_temp.sid(1), 'draft', 0)$$,
  'AC-3: the member''s generated insert succeeds'
);
select pg_temp.login(pg_temp.uid(2), 'admin');
select lives_ok(
  $$insert into public.purchase_orders (id, store_id, status, total_cost)
    values (pg_temp.pid(7), pg_temp.sid(3), 'draft', 0)$$,
  'AC-3: the admin''s generated insert succeeds'
);
reset role;

insert into public.purchase_orders (id, store_id, status, total_cost)
values (pg_temp.pid(8), pg_temp.sid(2), 'draft', 0);

select is(
  (select count(distinct po_number)::int from public.purchase_orders
    where id in (pg_temp.pid(5), pg_temp.pid(6), pg_temp.pid(7), pg_temp.pid(8))),
  4,
  'AC-3: four generated numbers across three callers are distinct'
);
select ok(
  pg_temp.num(pg_temp.pid(5)) < pg_temp.num(pg_temp.pid(6))
    and pg_temp.num(pg_temp.pid(6)) < pg_temp.num(pg_temp.pid(7))
    and pg_temp.num(pg_temp.pid(7)) < pg_temp.num(pg_temp.pid(8)),
  'AC-3: each generated number is greater than the one before (owner < member < admin < owner)'
);

-- ═══ AC-5: a deleted number is not reissued ════════════════════════════════
insert into public.purchase_orders (id, store_id, status, total_cost)
values (pg_temp.pid(9), pg_temp.sid(2), 'draft', 0);
do $$ begin perform set_config('test.ac5_n', pg_temp.num(pg_temp.pid(9))::text, true); end $$;
delete from public.purchase_orders where id = pg_temp.pid(9);

select is(
  (select count(*)::int from public.purchase_orders where id = pg_temp.pid(9)),
  0,
  'AC-5 anti-vacuity: the top PO was deleted'
);

insert into public.purchase_orders (id, store_id, status, total_cost)
values (pg_temp.pid(10), pg_temp.sid(2), 'draft', 0);

select ok(
  pg_temp.num(pg_temp.pid(10)) > current_setting('test.ac5_n')::bigint,
  'AC-5: the next generated number is above the deleted one (not reissued)'
);

-- ═══ AC-7: 1000 or later through the real trigger path ═════════════════════
-- Upward only: lift to 999 when next < 1000, else use next as it is. Any row
-- already holding the expected number is deleted inside this transaction.
do $$
declare
  v_expected bigint := pg_temp.seq_next();
begin
  if v_expected < 1000 then
    perform setval('public.purchase_orders_po_number_seq', 999, true);
    v_expected := 1000;
  end if;
  delete from public.purchase_orders
   where po_number = public.format_po_number(v_expected);
  perform set_config('test.ac7_expected', public.format_po_number(v_expected), true);
end $$;

insert into public.purchase_orders (id, store_id, status, total_cost)
values (pg_temp.pid(11), pg_temp.sid(2), 'draft', 0);

select is(
  pg_temp.po(pg_temp.pid(11)),
  current_setting('test.ac7_expected'),
  'AC-7: a real insert at counter >= 1000 gets the untruncated number (PO-1000 on a fresh DB)'
);
select ok(
  (substring(pg_temp.po(pg_temp.pid(11)) from 4))::bigint >= 1000,
  'AC-7: the generated numeric part is at least 1000'
);

-- ═══ AC-9: an explicit number skips the trigger and leaves the sequence ════
do $$
begin
  perform set_config('test.ac9_state', pg_temp.seq_state(), true);
  perform set_config('test.ac9_number', public.format_po_number(pg_temp.seq_next() + 500), true);
end $$;

insert into public.purchase_orders (id, store_id, po_number, status, total_cost)
values (pg_temp.pid(12), pg_temp.sid(2), current_setting('test.ac9_number'), 'draft', 0);

select is(
  pg_temp.po(pg_temp.pid(12)),
  current_setting('test.ac9_number'),
  'AC-9: an explicit po_number is kept unchanged'
);
select is(
  pg_temp.seq_state(),
  current_setting('test.ac9_state'),
  'AC-9: an explicit po_number does not advance the sequence'
);

-- ═══ AC-10: the trigger skips a taken number it cannot see ═════════════════
-- postgres puts the next candidate into store Y; the store-X member, who
-- cannot see Y, then generates.
do $$ begin perform set_config('test.ac10_next', pg_temp.seq_next()::text, true); end $$;

insert into public.purchase_orders (id, store_id, po_number, status, total_cost)
values (pg_temp.pid(13), pg_temp.sid(2),
        public.format_po_number(current_setting('test.ac10_next')::bigint), 'draft', 0);

set local role authenticated;
select pg_temp.login(pg_temp.uid(1), 'user');

select is(
  (select count(*)::int from public.purchase_orders where id = pg_temp.pid(13)),
  0,
  'AC-10 anti-vacuity: the member cannot see the row holding the next candidate'
);

select lives_ok(
  $$insert into public.purchase_orders (id, store_id, status, total_cost)
    values (pg_temp.pid(14), pg_temp.sid(1), 'draft', 0)$$,
  'AC-10: the generated insert succeeds although its first candidate is taken'
);

reset role;

select is(
  pg_temp.po(pg_temp.pid(14)),
  public.format_po_number(current_setting('test.ac10_next')::bigint + 1),
  'AC-10: the trigger skipped the taken number (RLS-blind check) and took the next one'
);
select is(
  pg_temp.seq_next(),
  current_setting('test.ac10_next')::bigint + 2,
  'AC-10: the sequence advanced by 2 (one skipped, one used)'
);

-- ═══ AC-11: malformed rows are still ignored ═══════════════════════════════
delete from public.purchase_orders where po_number in ('PO-SAMS-PASS-1', 'LEGACY-99');

insert into public.purchase_orders (id, store_id, po_number, status, total_cost)
values (pg_temp.pid(15), pg_temp.sid(2), 'PO-SAMS-PASS-1', 'draft', 0);

select lives_ok(
  $$insert into public.purchase_orders (id, store_id, status, total_cost)
    values (pg_temp.pid(16), pg_temp.sid(2), 'draft', 0)$$,
  'AC-11: a generated insert survives PO-SAMS-PASS-1 in the table'
);
select matches(
  pg_temp.po(pg_temp.pid(16)),
  '^PO-[0-9]{3,}$',
  'AC-11: the number generated next to PO-SAMS-PASS-1 is well formed'
);

insert into public.purchase_orders (id, store_id, po_number, status, total_cost)
values (pg_temp.pid(17), pg_temp.sid(2), 'LEGACY-99', 'draft', 0);

select lives_ok(
  $$insert into public.purchase_orders (id, store_id, status, total_cost)
    values (pg_temp.pid(18), pg_temp.sid(2), 'draft', 0)$$,
  'AC-11: a generated insert survives LEGACY-99 in the table'
);
select matches(
  pg_temp.po(pg_temp.pid(18)),
  '^PO-[0-9]{3,}$',
  'AC-11: the number generated next to LEGACY-99 is well formed'
);

-- ═══ DP-6: the skip loop's bound (LAST — burns ~100 numbers) ═══════════════
-- Occupy the next 100 candidates explicitly, then generate: attempts 1..100 all
-- hit a taken number and the 100th raises 54000 naming candidate next+99.
do $$
declare
  v_next bigint := pg_temp.seq_next();
begin
  insert into public.purchase_orders (store_id, po_number, status, total_cost)
  select pg_temp.sid(2), public.format_po_number(v_next + g), 'draft', 0
    from generate_series(0, 99) g
  on conflict on constraint purchase_orders_po_number_key do nothing;

  perform set_config('test.dp6_next', v_next::text, true);
  perform set_config('test.dp6_msg',
    'generate_po_number: no free PO number after 100 attempts (last tried '
      || public.format_po_number(v_next + 99) || ')', true);
end $$;

select throws_ok(
  $$insert into public.purchase_orders (id, store_id, status, total_cost)
    values (pg_temp.pid(19), pg_temp.sid(2), 'draft', 0)$$,
  '54000',
  current_setting('test.dp6_msg'),
  'DP-6: 100 taken numbers in a row raise 54000 with the designed message'
);

-- The failed insert's 100 nextval() calls were not rolled back, so the retry
-- lands just past the occupied block: the failure clears itself.
select lives_ok(
  $$insert into public.purchase_orders (id, store_id, status, total_cost)
    values (pg_temp.pid(20), pg_temp.sid(2), 'draft', 0)$$,
  'DP-6: the next generated insert succeeds (the bound failure clears itself)'
);
select is(
  pg_temp.po(pg_temp.pid(20)),
  public.format_po_number(current_setting('test.dp6_next')::bigint + 100),
  'DP-6: the retry takes the first number past the occupied block'
);

select * from finish();
rollback;
