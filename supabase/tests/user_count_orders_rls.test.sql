-- supabase/tests/user_count_orders_rls.test.sql
--
-- Spec 103 / design §13 — pgTAP coverage for the per-user custom count-screen
-- order table public.user_count_orders. Mirrors the JWT-claims-injection shape
-- of staff_role_eod_rls.test.sql (set request.jwt.claims + `set local role
-- authenticated` inside a hermetic begin/rollback).
--
-- Two real seed profiles stand in for users A and B (FK to profiles already
-- satisfied; the begin/rollback rolls back every write):
--   A = 22222222-2222-2222-2222-222222222222 (seed manager, app role 'user')
--   B = 11111111-1111-1111-1111-111111111111 (seed admin)
-- A third synthetic id with app_metadata.role = 'super_admin' asserts there is
-- NO admin bypass (US-2 privacy).
--
-- Assertions (plan = 13):
--   RLS owner-scoping (AC-1):
--     (1)  A inserts its own (admin-eod, vendorX) order → succeeds.
--     (2)  A reads it back → 1 row with the expected item_ids (round-trip, AC-3
--          at the SQL layer).
--     (3)  B SELECTs A's row → 0 rows (RLS hides).
--     (4)  B UPDATE of A's row → 0 rows affected (RLS denies).
--     (5)  B DELETE of A's row → 0 rows affected (RLS denies).
--     (6)  B INSERT of a row OWNED BY A (user_id = A) → 42501 (WITH CHECK
--          denial) — the cross-user write-spoof guard, under a 2nd screen key.
--     (7)  A super_admin JWT SELECTs A's row → 0 rows (NO admin bypass, US-2).
--   Key independence + NULL-vendor uniqueness (AC-2; design §1.2):
--     (8)  A writes admin-inventory (NULL vendor) → coexists with the admin-eod
--          row (2 distinct rows for A).
--     (9)  A re-upserts admin-inventory (NULL vendor) a 2nd time → still exactly
--          ONE NULL-vendor row (the novendor partial unique index fired; no
--          duplicate). item_ids reflects the 2nd write.
--     (10) A writes admin-eod under a SECOND vendorY → two admin-eod rows (one
--          per vendor) coexist (the vendor partial unique index keys on the
--          full triple).
--     (11) Writing admin-inventory left the admin-eod/vendorX item_ids
--          unchanged (independence — one key's write does not mutate another).
--   Reset (AC-4):
--     (12) A deletes admin-eod/vendorX → that row is gone (0 rows for the key).
--     (13) admin-inventory (NULL vendor) is UNTOUCHED by the reset (still 1 row).
--
-- The existing permissive_policy_lint.test.sql scans the four new policies
-- automatically; auth.uid() = user_id is not trivially-wide, so it passes with
-- NO allowlist edit (design §13). No new lint test is needed here.
--
-- Hermetic isolation: begin; ... rollback;.

begin;
create extension if not exists pgtap;

select plan(13);

-- ─── fixtures ──────────────────────────────────────────────────
do $$
declare
  v_user_a uuid := '22222222-2222-2222-2222-222222222222';
  v_user_b uuid := '11111111-1111-1111-1111-111111111111';
  v_super  uuid := '99999999-9999-9999-9999-999999999999';
  v_vendor_x uuid;
  v_vendor_y uuid;
begin
  select id into v_vendor_x from public.vendors order by id limit 1;
  select id into v_vendor_y from public.vendors order by id offset 1 limit 1;

  perform set_config('test.user_a',   v_user_a::text,   true);
  perform set_config('test.user_b',   v_user_b::text,   true);
  perform set_config('test.super',    v_super::text,    true);
  perform set_config('test.vendor_x', v_vendor_x::text, true);
  perform set_config('test.vendor_y', v_vendor_y::text, true);
end $$;

-- Helper: re-impersonate a given subject + app role. Inlined at each switch
-- (CTEs / functions can't persist a role swap across statements cleanly).

-- ─── Impersonate USER A (app role 'user') ──────────────────────
set local role authenticated;
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub',          current_setting('test.user_a', true),
    'role',         'authenticated',
    'app_metadata', jsonb_build_object('role', 'user')
  )::text,
  true
);

-- ─── (1) A inserts its own (admin-eod, vendorX) order ──────────
select lives_ok(
  format(
    $q$insert into public.user_count_orders (user_id, screen, vendor_id, item_ids)
       values (%L::uuid, 'admin-eod', %L::uuid, '["i1","i2","i3"]'::jsonb)$q$,
    current_setting('test.user_a', true),
    current_setting('test.vendor_x', true)
  ),
  '(1) user A can INSERT its own (admin-eod, vendorX) order row'
);

-- ─── (2) A reads it back (round-trip, AC-3) ────────────────────
select is(
  (
    select item_ids
      from public.user_count_orders
     where user_id   = current_setting('test.user_a', true)::uuid
       and screen    = 'admin-eod'
       and vendor_id = current_setting('test.vendor_x', true)::uuid
  ),
  '["i1","i2","i3"]'::jsonb,
  '(2) user A reads back its own order row with the expected item_ids (round-trip)'
);

-- ─── Impersonate USER B ────────────────────────────────────────
set local role authenticated;
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub',          current_setting('test.user_b', true),
    'role',         'authenticated',
    'app_metadata', jsonb_build_object('role', 'admin')
  )::text,
  true
);

-- ─── (3) B cannot SELECT A's row (RLS hides) ───────────────────
select is(
  (
    select count(*)::bigint
      from public.user_count_orders
     where user_id = current_setting('test.user_a', true)::uuid
  ),
  0::bigint,
  '(3) user B CANNOT SELECT user A''s order rows (RLS SELECT scope hides them)'
);

-- ─── (4) B UPDATE of A's row → 0 rows affected ─────────────────
-- A cross-user UPDATE is not an error under RLS — it simply matches 0 rows
-- (the USING clause filters A's row out of B's visible set). A data-modifying
-- CTE cannot be nested in a subquery (Postgres restriction), so run the UPDATE
-- in a `do` block, capture GET DIAGNOSTICS ROW_COUNT into a session var, then
-- assert on it (same stash-then-assert shape as permissive_policy_lint).
do $$
declare
  v_rows int;
begin
  update public.user_count_orders
     set item_ids = '["hacked"]'::jsonb
   where user_id = current_setting('test.user_a', true)::uuid;
  get diagnostics v_rows = row_count;
  perform set_config('test.b_update_rows', v_rows::text, true);
end $$;

select is(
  current_setting('test.b_update_rows', true)::int,
  0,
  '(4) user B UPDATE of user A''s row affects 0 rows (RLS USING denies)'
);

-- ─── (5) B DELETE of A's row → 0 rows affected ─────────────────
do $$
declare
  v_rows int;
begin
  delete from public.user_count_orders
   where user_id = current_setting('test.user_a', true)::uuid;
  get diagnostics v_rows = row_count;
  perform set_config('test.b_delete_rows', v_rows::text, true);
end $$;

select is(
  current_setting('test.b_delete_rows', true)::int,
  0,
  '(5) user B DELETE of user A''s row affects 0 rows (RLS USING denies)'
);

-- ─── (6) B INSERT of a row OWNED BY A → 42501 (WITH CHECK) ──────
-- The cross-user write-spoof: B tries to write a row whose user_id is A's,
-- under a DIFFERENT screen key (staff-weekly). The INSERT WITH CHECK
-- (auth.uid() = user_id) fails because B's auth.uid() ≠ A. Raises 42501.
select throws_ok(
  format(
    $q$insert into public.user_count_orders (user_id, screen, vendor_id, item_ids)
       values (%L::uuid, 'staff-weekly', null, '["spoof"]'::jsonb)$q$,
    current_setting('test.user_a', true)
  ),
  '42501',
  null,
  '(6) user B INSERT of a row owned by user A is blocked by RLS WITH CHECK (42501)'
);

-- ─── Impersonate SUPER_ADMIN ───────────────────────────────────
set local role authenticated;
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub',          current_setting('test.super', true),
    'role',         'authenticated',
    'app_metadata', jsonb_build_object('role', 'super_admin')
  )::text,
  true
);

-- ─── (7) super_admin cannot SELECT A's row (NO bypass, US-2) ────
select is(
  (
    select count(*)::bigint
      from public.user_count_orders
     where user_id = current_setting('test.user_a', true)::uuid
  ),
  0::bigint,
  '(7) a super_admin JWT CANNOT SELECT user A''s order rows (no admin bypass — US-2 privacy)'
);

-- ─── Back to USER A for key-independence + reset arms ──────────
set local role authenticated;
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub',          current_setting('test.user_a', true),
    'role',         'authenticated',
    'app_metadata', jsonb_build_object('role', 'user')
  )::text,
  true
);

-- A writes its admin-inventory order (NULL vendor) — first write.
insert into public.user_count_orders (user_id, screen, vendor_id, item_ids)
values (
  current_setting('test.user_a', true)::uuid,
  'admin-inventory', null, '["inv1","inv2"]'::jsonb
)
on conflict (user_id, screen) where vendor_id is null
do update set item_ids = excluded.item_ids;

-- ─── (8) admin-inventory (NULL) coexists with admin-eod (vendorX) ─
select is(
  (
    select count(*)::bigint
      from public.user_count_orders
     where user_id = current_setting('test.user_a', true)::uuid
  ),
  2::bigint,
  '(8) A''s admin-inventory (NULL vendor) row coexists with its admin-eod (vendorX) row — 2 distinct keys'
);

-- A re-upserts admin-inventory (NULL vendor) a SECOND time with new item_ids.
insert into public.user_count_orders (user_id, screen, vendor_id, item_ids)
values (
  current_setting('test.user_a', true)::uuid,
  'admin-inventory', null, '["inv3","inv4","inv5"]'::jsonb
)
on conflict (user_id, screen) where vendor_id is null
do update set item_ids = excluded.item_ids;

-- ─── (9) NULL-vendor uniqueness: still ONE row, item_ids replaced ─
select is(
  (
    select count(*)::bigint
      from public.user_count_orders
     where user_id = current_setting('test.user_a', true)::uuid
       and screen  = 'admin-inventory'
       and vendor_id is null
  ),
  1::bigint,
  '(9) a 2nd NULL-vendor admin-inventory upsert REPLACES rather than duplicates (novendor partial unique index — design §1.2)'
);

-- A writes admin-eod under a SECOND vendor (vendorY).
insert into public.user_count_orders (user_id, screen, vendor_id, item_ids)
values (
  current_setting('test.user_a', true)::uuid,
  'admin-eod', current_setting('test.vendor_y', true)::uuid, '["y1"]'::jsonb
)
on conflict (user_id, screen, vendor_id) where vendor_id is not null
do update set item_ids = excluded.item_ids;

-- ─── (10) per-vendor EOD rows coexist (vendorX + vendorY) ──────
select is(
  (
    select count(*)::bigint
      from public.user_count_orders
     where user_id = current_setting('test.user_a', true)::uuid
       and screen  = 'admin-eod'
  ),
  2::bigint,
  '(10) two admin-eod rows under different vendors coexist (vendor partial unique index keys on the full triple — OQ-1)'
);

-- ─── (11) independence: admin-eod/vendorX item_ids unchanged ───
select is(
  (
    select item_ids
      from public.user_count_orders
     where user_id   = current_setting('test.user_a', true)::uuid
       and screen    = 'admin-eod'
       and vendor_id = current_setting('test.vendor_x', true)::uuid
  ),
  '["i1","i2","i3"]'::jsonb,
  '(11) writing admin-inventory + admin-eod/vendorY left admin-eod/vendorX item_ids unchanged (key independence — AC-2)'
);

-- ─── (12) reset: A deletes admin-eod/vendorX ───────────────────
delete from public.user_count_orders
 where user_id   = current_setting('test.user_a', true)::uuid
   and screen    = 'admin-eod'
   and vendor_id = current_setting('test.vendor_x', true)::uuid;

select is(
  (
    select count(*)::bigint
      from public.user_count_orders
     where user_id   = current_setting('test.user_a', true)::uuid
       and screen    = 'admin-eod'
       and vendor_id = current_setting('test.vendor_x', true)::uuid
  ),
  0::bigint,
  '(12) reset deletes the admin-eod/vendorX row for the caller (AC-4)'
);

-- ─── (13) reset left admin-inventory (NULL vendor) untouched ───
select is(
  (
    select count(*)::bigint
      from public.user_count_orders
     where user_id = current_setting('test.user_a', true)::uuid
       and screen  = 'admin-inventory'
       and vendor_id is null
  ),
  1::bigint,
  '(13) resetting admin-eod/vendorX left admin-inventory (NULL vendor) untouched — single-key reset (AC-4)'
);

select * from finish();
rollback;
