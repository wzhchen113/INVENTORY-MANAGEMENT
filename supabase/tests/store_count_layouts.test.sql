-- supabase/tests/store_count_layouts.test.sql
--
-- Spec 110 / design §11 — pgTAP coverage for the named, store-SHARED weekly-count
-- layouts table public.store_count_layouts + its three SECURITY DEFINER write
-- RPCs (save / rename / delete) + the AC-13 user_count_orders cleanup predicate.
-- Mirrors the JWT-claims-injection shape of staff_role_eod_rls.test.sql +
-- user_count_orders_rls.test.sql (`set local role authenticated` +
-- request.jwt.claims with app_metadata.role; hermetic begin; ... rollback;). NO
-- `set role anon` (segfaults CI) — the anon negatives are covered by the
-- null-caller fail-close inside the RPCs and by has_function_privilege checks.
--
-- Fixtures (real seed profiles + stores; the begin/rollback rolls back every
-- write):
--   A = 22222222-2222-2222-2222-222222222222 (seed manager, app role 'user' —
--       the STAFF-ROLE stand-in; user_stores = Towson + Frederick).
--   B = 11111111-1111-1111-1111-111111111111 (seed admin — the PRIVILEGED
--       member; 2AM-brand admin, so auth_can_see_store is true for every 2AM
--       store).
--   Store A (both are members)          = Frederick.
--   Store B-only (A is NOT a member)    = Charles.
-- (Verified against the local seed: manager A is a member of Frederick+Towson
-- only; every seed store is in the 2AM brand so admin B sees them all.)
--
-- Assertion plan (27) — every §11 case pinned:
--   §11.1  Privileged create within cap:
--     (1)  B create 'Walk A' on Frederick returns a non-null id.
--     (2)  the created row lands at position = 1.
--   §11.2  Round-trip / list (+ fill to 3):
--     (3)  the created row reads back with the expected name + item_ids.
--     (4)  after two more creates, Frederick has exactly 3 layouts.
--   §11.3  4th create refused atomically:
--     (5)  a 4th save (layout_id null) on Frederick → P0001 'layout limit reached'.
--   §11.4  Overwrite (AC-5 / AC-7 last-write-wins):
--     (6)  overwrite layout1 → its item_ids + name are the new values.
--     (7)  overwrite kept position = 1 (slot unchanged).
--     (8)  Frederick still has exactly 3 layouts (overwrote, did not create).
--     (9)  overwrite stamped a fresh updated_at (> the row's created_at, which
--          the test back-dated an hour first so the fresh now() is provably later).
--   §11.5  Rename (AC-6):
--     (10) rename layout2 → name updates.
--     (11) rename left layout2's item_ids unchanged.
--   §11.6  Delete (AC-6) + slot reuse:
--     (12) delete layout3 → Frederick drops to 2 layouts.
--     (13) a create after the delete reuses the freed slot (position = 3).
--   §11.7  Staff-role member SELECTs but is DENIED writes (AC-3b — the headline):
--     (14) as A: SELECT Frederick's layouts → returns the rows (>0).
--     (15) as A: save RPC on Frederick → 42501 'forbidden' (RPC role gate).
--     (15b/18b-d) SEC SF-1 pin: rename/delete as A → SAME 42501 for a REAL id
--          and a FAKE id (role gate runs BEFORE row-resolve — no existence
--          oracle for non-privileged callers).
--     (16) as A: direct INSERT into the table → 42501 (RLS WITH CHECK denial).
--     (17) as A: direct UPDATE of a Frederick layout → 0 rows (RLS USING denies).
--     (18) as A: direct DELETE of a Frederick layout → 0 rows (RLS USING denies).
--   §11.8  Non-member sees nothing + cannot write (store isolation, AC-2/AC-3):
--     (19) as A: SELECT Charles' layouts → 0 rows (A is not a Charles member).
--     (20) as A: save RPC on Charles → 42501 (store gate).
--     (21) after a Charles layout is seeded via postgres (RLS bypass), A still
--          sees 0 Charles layouts.
--   §11.9  Privileged cross-store (admin visibility is intended):
--     (22) as B: save on Charles SUCCEEDS — every seed store is admin-visible to
--          B, so auth_can_see_store admits the privileged admin cross-store
--          (documented: admins have brand-wide store visibility).
--   §11.10 Name validation:
--     (23) empty name → P0001 'layout name required'.
--     (24) 61-char name → P0001 'layout name too long'.
--     (25) whitespace-only name → P0001 (trimmed to empty → 'layout name required').
--   §11.11 Structural cap ceiling (belt-and-braces, RPC-independent):
--     (26) direct INSERT (postgres, RLS bypassed) of position 4 → 23514 (CHECK).
--   §11.12 AC-13 cleanup DELETE predicate:
--     (27) seed one Weekly + one EOD user_count_orders row, re-run the exact
--          cleanup DELETE, and assert the Weekly row is gone AND the EOD row
--          survives (predicate scoping — tests the DELETE, not migration replay).
--
-- The existing permissive_policy_lint.test.sql auto-scans the four new policies;
-- auth_can_see_store()/auth_is_privileged() are not trivially-wide, so it passes
-- with NO allowlist edit (design §11). No new lint test is needed here.
--
-- Hermetic isolation: begin; ... rollback;.

begin;
create extension if not exists pgtap;

select plan(30);

-- ─── fixtures ──────────────────────────────────────────────────
do $$
declare
  v_user_a    uuid := '22222222-2222-2222-2222-222222222222';
  v_user_b    uuid := '11111111-1111-1111-1111-111111111111';
  v_frederick uuid;
  v_charles   uuid;
  v_vendor    uuid;
begin
  select id into v_frederick from public.stores where name = 'Frederick' limit 1;
  select id into v_charles   from public.stores where name = 'Charles'   limit 1;
  select id into v_vendor    from public.vendors limit 1;

  perform set_config('test.user_a',    v_user_a::text,    true);
  perform set_config('test.user_b',    v_user_b::text,    true);
  perform set_config('test.frederick', v_frederick::text, true);
  perform set_config('test.charles',   v_charles::text,   true);
  perform set_config('test.vendor',    v_vendor::text,    true);
end $$;

-- ═══ Impersonate ADMIN B (privileged member of Frederick) ═══════
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

-- ─── §11.1 (1) create returns a non-null id; stash it ──────────
do $$
declare
  v_id uuid;
begin
  v_id := public.save_store_count_layout(
    current_setting('test.frederick', true)::uuid,
    'Walk A',
    '["i1","i2"]'::jsonb,
    null
  );
  perform set_config('test.layout1', v_id::text, true);
end $$;

select isnt(
  current_setting('test.layout1', true),
  '',
  '(1) admin B create ''Walk A'' on Frederick returns a non-null layout id'
);

-- ─── §11.1 (2) the created row lands at position = 1 ───────────
select is(
  (select position from public.store_count_layouts
    where id = current_setting('test.layout1', true)::uuid),
  1::smallint,
  '(2) the first created layout is assigned position 1 (lowest free slot)'
);

-- ─── §11.2 (3) round-trip: name + item_ids read back ───────────
select is(
  (select name || '|' || item_ids::text from public.store_count_layouts
    where id = current_setting('test.layout1', true)::uuid),
  'Walk A|["i1", "i2"]',
  '(3) the created layout reads back with the expected name + item_ids (round-trip)'
);

-- Create two more so Frederick has three; stash their ids.
do $$
declare
  v_id2 uuid;
  v_id3 uuid;
begin
  v_id2 := public.save_store_count_layout(
    current_setting('test.frederick', true)::uuid, 'Walk B', '["i3","i4"]'::jsonb, null);
  v_id3 := public.save_store_count_layout(
    current_setting('test.frederick', true)::uuid, 'Walk C', '["i5"]'::jsonb, null);
  perform set_config('test.layout2', v_id2::text, true);
  perform set_config('test.layout3', v_id3::text, true);
end $$;

-- ─── §11.2 (4) Frederick now has exactly 3 layouts ─────────────
select is(
  (select count(*)::bigint from public.store_count_layouts
    where store_id = current_setting('test.frederick', true)::uuid),
  3::bigint,
  '(4) after three creates Frederick has exactly 3 layouts (slots 1..3 filled)'
);

-- ─── §11.3 (5) 4th create refused atomically (P0001) ───────────
select throws_ok(
  format(
    $q$select public.save_store_count_layout(%L::uuid, 'Walk D', '["i9"]'::jsonb, null)$q$,
    current_setting('test.frederick', true)
  ),
  'P0001',
  null,
  '(5) a 4th create on Frederick is refused — P0001 ''layout limit reached'' (atomic 3-cap, AC-2/OQ-6)'
);

-- ─── §11.4 overwrite (AC-5 / AC-7) ─────────────────────────────
-- Back-date layout1's created_at an hour (as postgres, RLS-bypass) so the
-- fresh updated_at the overwrite stamps via now() is PROVABLY later than
-- created_at within this single transaction (now() is txn-fixed, so without the
-- back-date created_at == updated_at and "advanced" could not be shown).
reset role;
update public.store_count_layouts
   set created_at = now() - interval '1 hour'
 where id = current_setting('test.layout1', true)::uuid;

set local role authenticated;
select set_config(
  'request.jwt.claims',
  jsonb_build_object('sub', current_setting('test.user_b', true), 'role', 'authenticated',
                     'app_metadata', jsonb_build_object('role', 'admin'))::text,
  true
);

do $$
declare
  v_ret uuid;
begin
  v_ret := public.save_store_count_layout(
    current_setting('test.frederick', true)::uuid,
    'Walk A2',
    '["i9"]'::jsonb,
    current_setting('test.layout1', true)::uuid  -- non-null → overwrite
  );
  perform set_config('test.overwrite_ret', v_ret::text, true);
end $$;

-- (6) item_ids + name replaced on the overwritten row.
select is(
  (select name || '|' || item_ids::text from public.store_count_layouts
    where id = current_setting('test.layout1', true)::uuid),
  'Walk A2|["i9"]',
  '(6) overwrite replaced the selected layout''s name + item_ids (AC-5)'
);

-- (7) position unchanged (kept its slot).
select is(
  (select position from public.store_count_layouts
    where id = current_setting('test.layout1', true)::uuid),
  1::smallint,
  '(7) overwrite kept the layout''s position = 1 (slot unchanged, AC-5)'
);

-- (8) still exactly 3 (overwrote, did not create a new row).
select is(
  (select count(*)::bigint from public.store_count_layouts
    where store_id = current_setting('test.frederick', true)::uuid),
  3::bigint,
  '(8) overwrite did NOT create a new row — Frederick still has 3 layouts'
);

-- (9) updated_at stamped fresh (> the back-dated created_at).
select ok(
  (select updated_at > created_at from public.store_count_layouts
    where id = current_setting('test.layout1', true)::uuid),
  '(9) overwrite stamped a fresh updated_at (later than created_at — last-write-wins, AC-7)'
);

-- ─── §11.5 rename (AC-6) ───────────────────────────────────────
do $$
begin
  perform public.rename_store_count_layout(
    current_setting('test.layout2', true)::uuid, 'Renamed B');
end $$;

-- (10) name updated.
select is(
  (select name from public.store_count_layouts
    where id = current_setting('test.layout2', true)::uuid),
  'Renamed B',
  '(10) rename updated the layout''s name (AC-6)'
);

-- (11) item_ids unchanged by rename.
select is(
  (select item_ids from public.store_count_layouts
    where id = current_setting('test.layout2', true)::uuid),
  '["i3","i4"]'::jsonb,
  '(11) rename left the layout''s item_ids unchanged (AC-6)'
);

-- ─── §11.6 delete (AC-6) + slot reuse ──────────────────────────
do $$
begin
  perform public.delete_store_count_layout(current_setting('test.layout3', true)::uuid);
end $$;

-- (12) Frederick drops to 2 after deleting layout3 (which held slot 3).
select is(
  (select count(*)::bigint from public.store_count_layouts
    where store_id = current_setting('test.frederick', true)::uuid),
  2::bigint,
  '(12) delete removed the row — Frederick drops from 3 to 2 layouts (AC-6)'
);

-- (13) a create after the delete reuses the freed slot (position 3).
do $$
declare
  v_id uuid;
begin
  v_id := public.save_store_count_layout(
    current_setting('test.frederick', true)::uuid, 'Reused', '["i7"]'::jsonb, null);
  perform set_config('test.layout_reused', v_id::text, true);
end $$;

select is(
  (select position from public.store_count_layouts
    where id = current_setting('test.layout_reused', true)::uuid),
  3::smallint,
  '(13) a create after the delete reuses the freed slot (position 3)'
);

-- ═══ Impersonate STAFF-ROLE member A (role ''user'', member of Frederick) ═══
set local role authenticated;
select set_config(
  'request.jwt.claims',
  jsonb_build_object('sub', current_setting('test.user_a', true), 'role', 'authenticated',
                     'app_metadata', jsonb_build_object('role', 'user'))::text,
  true
);

-- ─── §11.7 (14) staff A CAN SELECT Frederick's layouts (AC-3) ──
select ok(
  (select count(*)::bigint from public.store_count_layouts
    where store_id = current_setting('test.frederick', true)::uuid) > 0,
  '(14) staff-role member A CAN SELECT Frederick''s shared layouts (AC-3)'
);

-- ─── §11.7 (15) staff A save RPC → 42501 (RPC role gate) ───────
select throws_ok(
  format(
    $q$select public.save_store_count_layout(%L::uuid, 'nope', '[]'::jsonb, null)$q$,
    current_setting('test.frederick', true)
  ),
  '42501',
  null,
  '(15) staff-role member A is DENIED the save RPC on Frederick — 42501 ''forbidden'' (RPC role gate, AC-3b)'
);

-- ─── §11.7 (16) staff A direct INSERT → 42501 (RLS WITH CHECK) ─
-- Proves the gate is not merely in the RPC (defense-in-depth): a direct
-- PostgREST-style insert is refused by the privileged_insert_count_layouts
-- WITH CHECK. Uses position 2 (a slot A cannot know is free) — RLS fires before
-- any uniqueness check matters.
select throws_ok(
  format(
    $q$insert into public.store_count_layouts (store_id, name, item_ids, position)
       values (%L::uuid, 'direct', '[]'::jsonb, 2)$q$,
    current_setting('test.frederick', true)
  ),
  '42501',
  null,
  '(16) staff-role member A direct INSERT is blocked by RLS WITH CHECK (42501) — defense-in-depth, AC-3b'
);

-- ─── §11.7 (17) staff A direct UPDATE → 0 rows (RLS USING) ─────
do $$
declare
  v_rows int;
begin
  update public.store_count_layouts
     set name = 'hacked'
   where id = current_setting('test.layout1', true)::uuid;
  get diagnostics v_rows = row_count;
  perform set_config('test.a_update_rows', v_rows::text, true);
end $$;

select is(
  current_setting('test.a_update_rows', true)::int,
  0,
  '(17) staff-role member A direct UPDATE of a Frederick layout affects 0 rows (RLS USING denies, AC-3b)'
);

-- ─── §11.7 (18) staff A direct DELETE → 0 rows (RLS USING) ─────
do $$
declare
  v_rows int;
begin
  delete from public.store_count_layouts
   where id = current_setting('test.layout1', true)::uuid;
  get diagnostics v_rows = row_count;
  perform set_config('test.a_delete_rows', v_rows::text, true);
end $$;

select is(
  current_setting('test.a_delete_rows', true)::int,
  0,
  '(18) staff-role member A direct DELETE of a Frederick layout affects 0 rows (RLS USING denies, AC-3b)'
);

-- ─── (18b/c/d) SEC-review SF-1 pin — NO existence oracle ──────
-- The rename/delete role gate runs BEFORE the row-resolve, so a non-privileged
-- caller gets the IDENTICAL 42501 'forbidden' for a REAL layout id and a FAKE
-- one. If either of the fake-id cases ever starts raising P0002 instead, the
-- gate order regressed and the oracle is back.
select throws_ok(
  format(
    $q$select public.rename_store_count_layout(%L::uuid, 'x')$q$,
    current_setting('test.layout1', true)
  ),
  '42501',
  null,
  '(18b) staff-role A rename RPC on a REAL layout id → 42501 (role gate)'
);
select throws_ok(
  $q$select public.rename_store_count_layout('00000000-0000-4000-8000-00000000dead'::uuid, 'x')$q$,
  '42501',
  null,
  '(18c) staff-role A rename RPC on a FAKE id → SAME 42501, not P0002 (no existence oracle)'
);
select throws_ok(
  $q$select public.delete_store_count_layout('00000000-0000-4000-8000-00000000dead'::uuid)$q$,
  '42501',
  null,
  '(18d) staff-role A delete RPC on a FAKE id → SAME 42501, not P0002 (no existence oracle)'
);

-- ─── §11.8 (19) A sees 0 Charles layouts (not a member) ────────
select is(
  (select count(*)::bigint from public.store_count_layouts
    where store_id = current_setting('test.charles', true)::uuid),
  0::bigint,
  '(19) staff-role member A (NOT a Charles member) sees 0 Charles layouts (store isolation, AC-3)'
);

-- ─── §11.8 (20) A save RPC on Charles → 42501 (store gate) ─────
select throws_ok(
  format(
    $q$select public.save_store_count_layout(%L::uuid, 'x', '[]'::jsonb, null)$q$,
    current_setting('test.charles', true)
  ),
  '42501',
  null,
  '(20) staff-role member A save RPC on non-member Charles → 42501 (store gate)'
);

-- ─── §11.8 (21) seed a Charles layout via postgres; A still sees 0 ─
reset role;
insert into public.store_count_layouts (store_id, name, item_ids, position)
values (current_setting('test.charles', true)::uuid, 'Charles Walk', '["c1"]'::jsonb, 1);

set local role authenticated;
select set_config(
  'request.jwt.claims',
  jsonb_build_object('sub', current_setting('test.user_a', true), 'role', 'authenticated',
                     'app_metadata', jsonb_build_object('role', 'user'))::text,
  true
);

select is(
  (select count(*)::bigint from public.store_count_layouts
    where store_id = current_setting('test.charles', true)::uuid),
  0::bigint,
  '(21) after a Charles layout is seeded (RLS-bypass), A STILL sees 0 Charles layouts (RLS SELECT scope, AC-2/AC-3)'
);

-- ═══ Impersonate ADMIN B again for the cross-store arm ══════════
set local role authenticated;
select set_config(
  'request.jwt.claims',
  jsonb_build_object('sub', current_setting('test.user_b', true), 'role', 'authenticated',
                     'app_metadata', jsonb_build_object('role', 'admin'))::text,
  true
);

-- ─── §11.9 (22) privileged admin cross-store write SUCCEEDS ────
-- Every seed store is in B's brand, so auth_can_see_store admits admin B for
-- Charles (documented: admins have brand-wide store visibility). Charles already
-- holds one seeded layout at slot 1, so B's create takes slot 2 and succeeds.
do $$
declare
  v_id uuid;
begin
  v_id := public.save_store_count_layout(
    current_setting('test.charles', true)::uuid, 'B on Charles', '["b1"]'::jsonb, null);
  perform set_config('test.charles_b_layout', v_id::text, true);
end $$;

select isnt(
  current_setting('test.charles_b_layout', true),
  '',
  '(22) admin B CAN save on Charles — admin brand-wide store visibility is intended (auth_can_see_store is the real gate)'
);

-- ─── §11.10 name validation (all as admin B) ───────────────────
-- (23) empty name → P0001.
select throws_ok(
  format(
    $q$select public.save_store_count_layout(%L::uuid, '', '[]'::jsonb, null)$q$,
    current_setting('test.frederick', true)
  ),
  'P0001',
  null,
  '(23) empty name → P0001 ''layout name required'''
);

-- (24) 61-char name → P0001 (over the 60 ceiling).
select throws_ok(
  format(
    $q$select public.save_store_count_layout(%L::uuid, %L, '[]'::jsonb, null)$q$,
    current_setting('test.frederick', true),
    repeat('x', 61)
  ),
  'P0001',
  null,
  '(24) a 61-char name → P0001 ''layout name too long'''
);

-- (25) whitespace-only name → P0001 (trims to empty).
select throws_ok(
  format(
    $q$select public.save_store_count_layout(%L::uuid, '   ', '[]'::jsonb, null)$q$,
    current_setting('test.frederick', true)
  ),
  'P0001',
  null,
  '(25) a whitespace-only name trims to empty → P0001 ''layout name required'''
);

-- ─── §11.11 (26) structural cap ceiling (postgres, RLS bypass) ─
-- A direct insert of position 4 violates the `position between 1 and 3` CHECK
-- (23514), independent of the RPC — the belt-and-braces structural cap.
reset role;
select throws_ok(
  format(
    $q$insert into public.store_count_layouts (store_id, name, item_ids, position)
       values (%L::uuid, 'slot4', '[]'::jsonb, 4)$q$,
    current_setting('test.frederick', true)
  ),
  '23514',
  null,
  '(26) a direct INSERT of position 4 violates the position 1..3 CHECK (23514) — structural cap, RPC-independent'
);

-- ─── §11.12 (27) AC-13 cleanup DELETE predicate ────────────────
-- Seed one Weekly (staff-weekly, NULL vendor) + one EOD (staff-eod, vendor) row
-- as postgres (RLS-bypass; owner scope irrelevant here — we test the DELETE
-- predicate's SCOPING, not migration replay). Then re-run the EXACT cleanup
-- DELETE and assert the Weekly row is gone AND the EOD row survives.
insert into public.user_count_orders (user_id, screen, vendor_id, item_ids)
values (current_setting('test.user_b', true)::uuid, 'staff-weekly', null, '["w1"]'::jsonb);
insert into public.user_count_orders (user_id, screen, vendor_id, item_ids)
values (current_setting('test.user_b', true)::uuid, 'staff-eod',
        current_setting('test.vendor', true)::uuid, '["e1"]'::jsonb);

-- The migration's exact cleanup predicate.
delete from public.user_count_orders
 where screen in ('admin-inventory', 'staff-weekly');

select is(
  (
    select
      (select count(*) from public.user_count_orders
        where user_id = current_setting('test.user_b', true)::uuid and screen = 'staff-weekly')::text
      || '/' ||
      (select count(*) from public.user_count_orders
        where user_id = current_setting('test.user_b', true)::uuid and screen = 'staff-eod')::text
  ),
  '0/1',
  '(27) AC-13 cleanup DELETE removed the seeded Weekly row (0) and left the EOD row intact (1)'
);

select * from finish();
rollback;
