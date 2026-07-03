-- supabase/tests/user_count_drafts_rls.test.sql
--
-- Spec 106 / design §13 — pgTAP coverage for the per-user PRIVATE resumable
-- DRAFT table public.user_count_drafts. Mirrors the JWT-claims-injection shape
-- of user_count_orders_rls.test.sql (set request.jwt.claims + `set local role
-- authenticated` inside a hermetic begin/rollback).
--
-- Two real seed profiles stand in for users A and B (FK to profiles already
-- satisfied; the begin/rollback rolls back every write):
--   A = 22222222-2222-2222-2222-222222222222 (seed manager, app role 'user')
--   B = 11111111-1111-1111-1111-111111111111 (seed admin)
-- A third synthetic id with app_metadata.role = 'super_admin' asserts there is
-- NO admin bypass (AC-10 privacy).
--
-- Two real seed stores stand in for storeX / storeY (store_id is NOT NULL and
-- FK to public.stores):
--   storeX = 'Frederick', storeY = 'Charles'.
--
-- Assertions (plan = 11) — owner-scoping is the core AC-10 surface:
--   RLS owner-scoping (AC-10):
--     (1)  A inserts its own (admin-inventory, storeX) draft → succeeds.
--     (2)  A reads it back → expected payload + saved_at (round-trip, AC-3 at
--          the SQL layer).
--     (3)  B SELECTs A's row → 0 rows (RLS hides).
--     (4)  B UPDATE of A's row → 0 rows affected (RLS USING denies).
--     (5)  B DELETE of A's row → 0 rows affected (RLS USING denies).
--     (6)  B INSERT of a row OWNED BY A (user_id = A) under staff-weekly →
--          42501 (WITH CHECK spoof guard).
--     (7)  A super_admin JWT SELECTs A's row → 0 rows (NO admin bypass, AC-10).
--   Single-slot overwrite + key independence (AC-4):
--     (8)  A upserts the SAME (admin-inventory, storeX) slot a 2nd time → still
--          exactly ONE row; payload reflects the 2nd write (the FULL-unique
--          ON CONFLICT fired — whole-draft overwrite, the analog of spec-103
--          arm 9 but for the FULL constraint, not a partial index).
--     (9)  A writes (staff-weekly, storeX) → coexists with the admin-inventory
--          row (2 distinct screen keys for the same user+store).
--     (10) A writes (admin-inventory, storeY) → coexists with (admin-inventory,
--          storeX) — store_id is part of the slot identity (per-store slots).
--   Single-slot delete (AC-7 / AC-8):
--     (11) A deletes (admin-inventory, storeX) → gone; the staff-weekly and
--          storeY rows are UNTOUCHED (single-slot delete).
--
-- The existing permissive_policy_lint.test.sql scans the four new policies
-- automatically (auth.uid() = user_id is not trivially-wide → passes with NO
-- allowlist edit), and public_grants_explicit.test.sql arm 1 asserts the
-- table's SELECT grant automatically (it HOLDS the grant → NOT allowlisted).
-- Neither is duplicated here (design §13).
--
-- Hermetic isolation: begin; ... rollback;.

begin;
create extension if not exists pgtap;

select plan(11);

-- ─── fixtures ──────────────────────────────────────────────────
do $$
declare
  v_user_a uuid := '22222222-2222-2222-2222-222222222222';
  v_user_b uuid := '11111111-1111-1111-1111-111111111111';
  v_super  uuid := '99999999-9999-9999-9999-999999999999';
  v_store_x uuid;
  v_store_y uuid;
begin
  select id into v_store_x from public.stores where name = 'Frederick' limit 1;
  select id into v_store_y from public.stores where name = 'Charles'   limit 1;
  -- Fall back to any two distinct stores if the named seed rows are absent, so
  -- the suite is robust to a reduced seed.
  if v_store_x is null then
    select id into v_store_x from public.stores order by id limit 1;
  end if;
  if v_store_y is null then
    select id into v_store_y from public.stores where id <> v_store_x order by id limit 1;
  end if;

  perform set_config('test.user_a',  v_user_a::text,  true);
  perform set_config('test.user_b',  v_user_b::text,  true);
  perform set_config('test.super',   v_super::text,   true);
  perform set_config('test.store_x', v_store_x::text, true);
  perform set_config('test.store_y', v_store_y::text, true);
end $$;

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

-- ─── (1) A inserts its own (admin-inventory, storeX) draft ─────
select lives_ok(
  format(
    $q$insert into public.user_count_drafts (user_id, screen, store_id, payload, saved_at)
       values (%L::uuid, 'admin-inventory', %L::uuid,
               '{"v":1,"kind":"spot","caseCounts":{"i1":"3"}}'::jsonb,
               '2026-07-02T10:00:00.000Z'::timestamptz)$q$,
    current_setting('test.user_a', true),
    current_setting('test.store_x', true)
  ),
  '(1) user A can INSERT its own (admin-inventory, storeX) draft row'
);

-- ─── (2) A reads it back (round-trip, AC-3) ────────────────────
select is(
  (
    select payload
      from public.user_count_drafts
     where user_id  = current_setting('test.user_a', true)::uuid
       and screen   = 'admin-inventory'
       and store_id = current_setting('test.store_x', true)::uuid
  ),
  '{"v":1,"kind":"spot","caseCounts":{"i1":"3"}}'::jsonb,
  '(2) user A reads back its own draft row with the expected payload (round-trip)'
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
      from public.user_count_drafts
     where user_id = current_setting('test.user_a', true)::uuid
  ),
  0::bigint,
  '(3) user B CANNOT SELECT user A''s draft rows (RLS SELECT scope hides them)'
);

-- ─── (4) B UPDATE of A's row → 0 rows affected ─────────────────
-- A cross-user UPDATE is not an error under RLS — it matches 0 rows (the USING
-- clause filters A's row out of B's visible set). A data-modifying CTE cannot
-- be nested in a subquery, so run the UPDATE in a `do` block, stash
-- GET DIAGNOSTICS ROW_COUNT into a session var, then assert (same stash-then-
-- assert shape as user_count_orders_rls).
do $$
declare
  v_rows int;
begin
  update public.user_count_drafts
     set payload = '{"hacked":true}'::jsonb
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
  delete from public.user_count_drafts
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
    $q$insert into public.user_count_drafts (user_id, screen, store_id, payload, saved_at)
       values (%L::uuid, 'staff-weekly', %L::uuid, '{"v":1}'::jsonb,
               '2026-07-02T10:05:00.000Z'::timestamptz)$q$,
    current_setting('test.user_a', true),
    current_setting('test.store_x', true)
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

-- ─── (7) super_admin cannot SELECT A's row (NO bypass, AC-10) ──
select is(
  (
    select count(*)::bigint
      from public.user_count_drafts
     where user_id = current_setting('test.user_a', true)::uuid
  ),
  0::bigint,
  '(7) a super_admin JWT CANNOT SELECT user A''s draft rows (no admin bypass — AC-10 privacy)'
);

-- ─── Back to USER A for single-slot + key-independence + delete ─
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

-- A upserts the SAME (admin-inventory, storeX) slot a SECOND time with a new
-- payload — the FULL unique constraint is a valid ON CONFLICT target, so this
-- REPLACES the row (whole-draft overwrite, AC-4).
insert into public.user_count_drafts (user_id, screen, store_id, payload, saved_at)
values (
  current_setting('test.user_a', true)::uuid,
  'admin-inventory',
  current_setting('test.store_x', true)::uuid,
  '{"v":1,"kind":"close","caseCounts":{"i1":"9","i2":"4"}}'::jsonb,
  '2026-07-02T10:10:00.000Z'::timestamptz
)
on conflict (user_id, screen, store_id)
do update set payload = excluded.payload, saved_at = excluded.saved_at;

-- ─── (8) single-slot overwrite: still ONE row, payload replaced ─
select is(
  (
    select count(*)::bigint || '|' || (
      select payload::text
        from public.user_count_drafts
       where user_id  = current_setting('test.user_a', true)::uuid
         and screen   = 'admin-inventory'
         and store_id = current_setting('test.store_x', true)::uuid
    )
      from public.user_count_drafts
     where user_id  = current_setting('test.user_a', true)::uuid
       and screen   = 'admin-inventory'
       and store_id = current_setting('test.store_x', true)::uuid
  ),
  '1|{"v": 1, "kind": "close", "caseCounts": {"i1": "9", "i2": "4"}}',
  '(8) a 2nd upsert of the SAME (admin-inventory, storeX) slot REPLACES rather than duplicates (FULL-unique ON CONFLICT — whole-draft overwrite, AC-4)'
);

-- A writes (staff-weekly, storeX) — a DIFFERENT screen key, same user+store.
insert into public.user_count_drafts (user_id, screen, store_id, payload, saved_at)
values (
  current_setting('test.user_a', true)::uuid,
  'staff-weekly',
  current_setting('test.store_x', true)::uuid,
  '{"v":1,"caseCounts":{"w1":"2"}}'::jsonb,
  '2026-07-02T10:15:00.000Z'::timestamptz
)
on conflict (user_id, screen, store_id)
do update set payload = excluded.payload, saved_at = excluded.saved_at;

-- ─── (9) staff-weekly coexists with admin-inventory (same store) ─
select is(
  (
    select count(*)::bigint
      from public.user_count_drafts
     where user_id  = current_setting('test.user_a', true)::uuid
       and store_id = current_setting('test.store_x', true)::uuid
  ),
  2::bigint,
  '(9) A''s (staff-weekly, storeX) draft coexists with its (admin-inventory, storeX) draft — 2 distinct screen keys'
);

-- A writes (admin-inventory, storeY) — same screen, DIFFERENT store.
insert into public.user_count_drafts (user_id, screen, store_id, payload, saved_at)
values (
  current_setting('test.user_a', true)::uuid,
  'admin-inventory',
  current_setting('test.store_y', true)::uuid,
  '{"v":1,"kind":"open","caseCounts":{"y1":"1"}}'::jsonb,
  '2026-07-02T10:20:00.000Z'::timestamptz
)
on conflict (user_id, screen, store_id)
do update set payload = excluded.payload, saved_at = excluded.saved_at;

-- ─── (10) per-store slots: admin-inventory/storeY coexists w/ storeX ─
select is(
  (
    select count(*)::bigint
      from public.user_count_drafts
     where user_id = current_setting('test.user_a', true)::uuid
       and screen  = 'admin-inventory'
  ),
  2::bigint,
  '(10) two admin-inventory rows under different stores coexist (store_id is part of the slot identity — per-store slots)'
);

-- ─── (11) single-slot delete: A deletes (admin-inventory, storeX) ─
delete from public.user_count_drafts
 where user_id  = current_setting('test.user_a', true)::uuid
   and screen   = 'admin-inventory'
   and store_id = current_setting('test.store_x', true)::uuid;

select is(
  (
    -- The deleted slot is gone (0), and exactly the OTHER TWO rows remain
    -- (staff-weekly/storeX + admin-inventory/storeY) — untouched by the delete.
    select
      (select count(*)::bigint from public.user_count_drafts
        where user_id  = current_setting('test.user_a', true)::uuid
          and screen   = 'admin-inventory'
          and store_id = current_setting('test.store_x', true)::uuid)
      || '|' ||
      (select count(*)::bigint from public.user_count_drafts
        where user_id = current_setting('test.user_a', true)::uuid)
  ),
  '0|2',
  '(11) deleting (admin-inventory, storeX) removes ONLY that slot; the staff-weekly + storeY rows are UNTOUCHED (single-slot delete — AC-7/AC-8)'
);

select * from finish();
rollback;
