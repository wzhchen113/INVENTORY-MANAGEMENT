-- supabase/tests/items_last_counted.test.sql
--
-- Spec 160 / backend design §11 — pgTAP coverage for
-- supabase/migrations/20260817000000_items_last_counted.sql.
--
-- The migration EXTRACTS spec 128's per-(store, item) last-counted union out of
-- staff_items_updated into public.items_last_counted(p_store_id) and rewires
-- staff_items_updated to LEFT JOIN it. This file pins the extracted function's
-- contract; the behavior-preservation half of the change is pinned by
-- supabase/tests/ingredient_changed_badge.test.sql, which runs UNEDITED (design
-- §0.3 — editing that file would itself be the defect).
--
-- Assertions mirror the shape of ingredient_changed_badge.test.sql rather than
-- re-deriving the semantics:
--
--   Structure (1-3)  — function exists; the `returns table` shape is pinned
--                      byte-for-byte; STABLE + SECURITY INVOKER (the latter is
--                      load-bearing: it is the only reason RLS applies at all).
--   Computation (4-9) — eod source alone; max over BOTH sources; the
--                      inventory_counts source alone; a DRAFT eod does not set
--                      the date; a DRAFT inventory_count does not set it;
--                      never-counted → NULL (AC-2, AC-3, AC-5).
--   Cardinality (10)  — ONE row per inventory_items row in the store,
--                      including never-counted items and an item whose catalog
--                      row is in a foreign brand. Row presence is never
--                      load-bearing for the client; a NULL value is the one and
--                      only never-counted signal (AC-9 at the backend).
--   Catalog-drop (11-12) — THE reason design §0.2 rejected reusing
--                      staff_items_updated for the admin column. Under RLS, an
--                      item whose catalog_ingredients row is invisible is
--                      DROPPED by staff_items_updated's inner catalog join but
--                      RETAINED (with a value) by items_last_counted. Arm 12 is
--                      the negative control that proves arm 11 is meaningful.
--   Isolation (13-14) — counted at store A ⇒ NULL at store B, and store A's
--                      rows do not leak into store B's result set (AC-4).
--   RLS (15)          — a caller with no user_stores grant for the store gets
--                      the EMPTY SET, not rows-with-NULL (AC-6). The driver is
--                      `inventory_items where store_id = p_store_id`, so the
--                      per-store policy zeroes the driver.
--   Grants (16)       — no EXECUTE for anon/public; EXECUTE for authenticated.
--                      Catalog-query via has_function_privilege, NOT
--                      `set local role anon` + throws_ok — see the spec 045 /
--                      067 note in reports_anon_revoke.test.sql (the
--                      runtime-role-switch pattern segfaulted Postgres in CI).
--
-- Timestamps are fixed literals, never now(), so every comparison is exact and
-- the file is wall-clock independent.
--
-- Hermetic: begin; … rollback; — every fixture (including a test-only foreign
-- brand) is created inside the txn and rolled back. The computation arms run as
-- the postgres superuser (RLS bypassed); arms 11-12 and 15 explicitly
-- impersonate JWT callers via `set local role authenticated` +
-- request.jwt.claims, the pattern from
-- auth_can_see_store_brand_scope.test.sql:96-106.

begin;
create extension if not exists pgtap;

select plan(16);

-- ─── Structure ─────────────────────────────────────────────────
select has_function(
  'public', 'items_last_counted', array['uuid'],
  '(1) public.items_last_counted(uuid) exists'
);

select is(
  (select pg_get_function_result(p.oid)
     from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'items_last_counted'),
  'TABLE(item_id uuid, last_counted_at timestamp with time zone)',
  '(2) items_last_counted returns table(item_id uuid, last_counted_at timestamptz)'
);

select is(
  (select p.provolatile::text || case when p.prosecdef then 'D' else 'I' end
     from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'items_last_counted'),
  'sI',
  '(3) items_last_counted is STABLE + SECURITY INVOKER (RLS rides the caller)'
);

-- ─── Fixtures ──────────────────────────────────────────────────
-- Two stores inside the SEED brand (so the seed admin JWT can see them via
-- auth_is_admin + auth_can_see_brand) plus one test-only foreign brand whose
-- catalog row is deliberately invisible to that admin.
do $$
declare
  v_brand_a uuid := '2a000000-0000-0000-0000-000000000001';  -- seed brand
begin
  perform set_config('test.brand_a',   v_brand_a::text, true);
  perform set_config('test.brand_b',   'b1600000-0000-0000-0000-000000000001', true);
  perform set_config('test.store_a',   '16000000-0000-0000-0000-000000000001', true);
  perform set_config('test.store_b',   '16000000-0000-0000-0000-000000000002', true);
  perform set_config('test.admin_id',  '11111111-1111-1111-1111-111111111111', true);  -- seed admin (brand A)
  perform set_config('test.manager_id','22222222-2222-2222-2222-222222222222', true);  -- seed 'user' role, no grant for our stores
end $$;

insert into public.brands (id, name)
  values (current_setting('test.brand_b', true)::uuid, 'Spec160 Foreign Brand');

insert into public.stores (id, name, address, status, brand_id)
  values ('16000000-0000-0000-0000-000000000001', 'Spec160 Store A', '1 A St', 'active',
          current_setting('test.brand_a', true)::uuid),
         ('16000000-0000-0000-0000-000000000002', 'Spec160 Store B', '2 B St', 'active',
          current_setting('test.brand_a', true)::uuid);

insert into public.vendors (id, name, brand_id)
  values ('16e00000-0000-0000-0000-000000000001', 'Spec160 Vendor',
          current_setting('test.brand_a', true)::uuid);

-- Five brand-A catalog rows + one brand-B (foreign) catalog row.
insert into public.catalog_ingredients (id, brand_id, name, unit)
  values ('16c00000-0000-0000-0000-000000000001', current_setting('test.brand_a', true)::uuid, 'Spec160 Both Sources', 'ea'),
         ('16c00000-0000-0000-0000-000000000002', current_setting('test.brand_a', true)::uuid, 'Spec160 Count Only',   'ea'),
         ('16c00000-0000-0000-0000-000000000003', current_setting('test.brand_a', true)::uuid, 'Spec160 Draft Eod',    'ea'),
         ('16c00000-0000-0000-0000-000000000004', current_setting('test.brand_a', true)::uuid, 'Spec160 Draft Count',  'ea'),
         ('16c00000-0000-0000-0000-000000000005', current_setting('test.brand_a', true)::uuid, 'Spec160 Never',        'ea'),
         ('16c00000-0000-0000-0000-000000000006', current_setting('test.brand_b', true)::uuid, 'Spec160 Foreign Cat',  'ea');

-- Six items in store A. i6 points at the FOREIGN-brand catalog row: the FK is
-- satisfied, but a brand-A caller cannot SELECT that catalog row.
insert into public.inventory_items (id, store_id, catalog_id, vendor_id, cost_per_unit)
  values ('16100000-0000-0000-0000-000000000001', '16000000-0000-0000-0000-000000000001', '16c00000-0000-0000-0000-000000000001', '16e00000-0000-0000-0000-000000000001', 1),
         ('16100000-0000-0000-0000-000000000002', '16000000-0000-0000-0000-000000000001', '16c00000-0000-0000-0000-000000000002', '16e00000-0000-0000-0000-000000000001', 1),
         ('16100000-0000-0000-0000-000000000003', '16000000-0000-0000-0000-000000000001', '16c00000-0000-0000-0000-000000000003', '16e00000-0000-0000-0000-000000000001', 1),
         ('16100000-0000-0000-0000-000000000004', '16000000-0000-0000-0000-000000000001', '16c00000-0000-0000-0000-000000000004', '16e00000-0000-0000-0000-000000000001', 1),
         ('16100000-0000-0000-0000-000000000005', '16000000-0000-0000-0000-000000000001', '16c00000-0000-0000-0000-000000000005', '16e00000-0000-0000-0000-000000000001', 1),
         ('16100000-0000-0000-0000-000000000006', '16000000-0000-0000-0000-000000000001', '16c00000-0000-0000-0000-000000000006', '16e00000-0000-0000-0000-000000000001', 1);

-- One item in store B for the SAME catalog row as store A's i1 — the per-store
-- isolation fixture (the ingredient is counted at A, never at B).
insert into public.inventory_items (id, store_id, catalog_id, vendor_id, cost_per_unit)
  values ('16100000-0000-0000-0000-0000000000b1', '16000000-0000-0000-0000-000000000002', '16c00000-0000-0000-0000-000000000001', '16e00000-0000-0000-0000-000000000001', 1);

-- ─── (4) the eod source alone sets the date ───────────────────
insert into public.eod_submissions (id, store_id, date, vendor_id, status, submitted_at)
  values ('16d00000-0000-0000-0000-000000000001', '16000000-0000-0000-0000-000000000001',
          '2026-08-10', '16e00000-0000-0000-0000-000000000001', 'submitted',
          '2026-08-10 12:00:00+00');
insert into public.eod_entries (submission_id, item_id, actual_remaining)
  values ('16d00000-0000-0000-0000-000000000001', '16100000-0000-0000-0000-000000000001', 5);

select is(
  (select last_counted_at from public.items_last_counted('16000000-0000-0000-0000-000000000001')
     where item_id = '16100000-0000-0000-0000-000000000001'),
  '2026-08-10 12:00:00+00'::timestamptz,
  '(4) a SUBMITTED eod count sets last_counted_at'
);

-- ─── (5) max over BOTH sources ────────────────────────────────
-- A later submitted inventory_counts row for the same item must win.
insert into public.inventory_counts (id, store_id, kind, status, counted_at, submitted_at)
  values ('16f00000-0000-0000-0000-000000000001', '16000000-0000-0000-0000-000000000001',
          'close', 'submitted', '2026-08-12 09:30:00+00', '2026-08-12 09:30:00+00');
insert into public.inventory_count_entries (count_id, item_id)
  values ('16f00000-0000-0000-0000-000000000001', '16100000-0000-0000-0000-000000000001');

select is(
  (select last_counted_at from public.items_last_counted('16000000-0000-0000-0000-000000000001')
     where item_id = '16100000-0000-0000-0000-000000000001'),
  '2026-08-12 09:30:00+00'::timestamptz,
  '(5) last_counted_at is the max over BOTH eod and inventory_counts sources'
);

-- ─── (6) the inventory_counts source alone sets the date ──────
insert into public.inventory_counts (id, store_id, kind, status, counted_at, submitted_at)
  values ('16f00000-0000-0000-0000-000000000002', '16000000-0000-0000-0000-000000000001',
          'spot', 'submitted', '2026-08-11 08:00:00+00', '2026-08-11 08:00:00+00');
insert into public.inventory_count_entries (count_id, item_id)
  values ('16f00000-0000-0000-0000-000000000002', '16100000-0000-0000-0000-000000000002');

select is(
  (select last_counted_at from public.items_last_counted('16000000-0000-0000-0000-000000000001')
     where item_id = '16100000-0000-0000-0000-000000000002'),
  '2026-08-11 08:00:00+00'::timestamptz,
  '(6) a SUBMITTED inventory_counts row alone sets last_counted_at (any kind)'
);

-- ─── (7) a DRAFT eod does NOT set the date ────────────────────
insert into public.eod_submissions (id, store_id, date, vendor_id, status, submitted_at)
  values ('16d00000-0000-0000-0000-000000000002', '16000000-0000-0000-0000-000000000001',
          '2026-08-13', '16e00000-0000-0000-0000-000000000001', 'draft',
          '2026-08-13 12:00:00+00');
insert into public.eod_entries (submission_id, item_id, actual_remaining)
  values ('16d00000-0000-0000-0000-000000000002', '16100000-0000-0000-0000-000000000003', 5);

select is(
  (select last_counted_at from public.items_last_counted('16000000-0000-0000-0000-000000000001')
     where item_id = '16100000-0000-0000-0000-000000000003'),
  null,
  '(7) a DRAFT eod submission does NOT set last_counted_at'
);

-- ─── (8) a DRAFT inventory_count does NOT set the date ────────
insert into public.inventory_counts (id, store_id, kind, status, counted_at, submitted_at)
  values ('16f00000-0000-0000-0000-000000000003', '16000000-0000-0000-0000-000000000001',
          'weekly', 'draft', '2026-08-13 13:00:00+00', '2026-08-13 13:00:00+00');
insert into public.inventory_count_entries (count_id, item_id)
  values ('16f00000-0000-0000-0000-000000000003', '16100000-0000-0000-0000-000000000004');

select is(
  (select last_counted_at from public.items_last_counted('16000000-0000-0000-0000-000000000001')
     where item_id = '16100000-0000-0000-0000-000000000004'),
  null,
  '(8) a DRAFT inventory_count does NOT set last_counted_at'
);

-- ─── (9) never counted → NULL ─────────────────────────────────
select is(
  (select last_counted_at from public.items_last_counted('16000000-0000-0000-0000-000000000001')
     where item_id = '16100000-0000-0000-0000-000000000005'),
  null,
  '(9) an item with no qualifying count in any source → last_counted_at IS NULL'
);

-- ─── (10) one row per inventory_items row in the store ────────
select is(
  (select count(*) from public.items_last_counted('16000000-0000-0000-0000-000000000001')),
  6::bigint,
  '(10) one row per inventory_items row in the store (incl. never-counted + foreign-catalog items)'
);

-- ─── (11)/(12) the catalog-join drop that motivated the extraction ────
-- Impersonate the seed brand-A admin. The brand-B catalog row behind item i6
-- is invisible to them (brand_member_read_catalog_ingredients →
-- auth_can_see_brand), so staff_items_updated's INNER catalog join drops i6
-- entirely. items_last_counted has no catalog join and must still return it —
-- otherwise the admin client cannot tell "omitted" from "never counted".
set local role authenticated;
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub',          current_setting('test.admin_id', true),
    'role',         'authenticated',
    'app_metadata', jsonb_build_object('role', 'admin')
  )::text,
  true
);

select is(
  (select count(*) from public.items_last_counted('16000000-0000-0000-0000-000000000001')
     where item_id = '16100000-0000-0000-0000-000000000006'),
  1::bigint,
  '(11) an item whose catalog row is RLS-invisible is STILL returned (no catalog join)'
);

select is(
  (select count(*) from public.staff_items_updated('16000000-0000-0000-0000-000000000001')
     where item_id = '16100000-0000-0000-0000-000000000006'),
  0::bigint,
  '(12) negative control: staff_items_updated DOES drop it (inner catalog join) — why §0.2 rejected reuse'
);

-- ─── (15) RLS: no user_stores grant → EMPTY SET ───────────────
-- Run before resetting the role. The seed manager is a plain 'user' in brand A
-- with no user_stores row for Spec160 Store A, so auth_can_see_store is false
-- and the driver returns zero rows — an empty set, NOT rows-with-NULL.
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub',          current_setting('test.manager_id', true),
    'role',         'authenticated',
    'app_metadata', jsonb_build_object('role', 'user')
  )::text,
  true
);

select is(
  (select count(*) from public.items_last_counted('16000000-0000-0000-0000-000000000001')),
  0::bigint,
  '(15) a caller with no visibility of the store gets the EMPTY SET (AC-6)'
);

reset role;

-- ─── (13)/(14) per-store isolation ────────────────────────────
-- The same catalog ingredient exists at store B as a separate inventory_items
-- row and was never counted there, even though store A counted it.
select is(
  (select last_counted_at from public.items_last_counted('16000000-0000-0000-0000-000000000002')
     where item_id = '16100000-0000-0000-0000-0000000000b1'),
  null,
  '(13) counted at store A ⇒ still NULL at store B for the same ingredient (AC-4)'
);

select is(
  (select count(*) from public.items_last_counted('16000000-0000-0000-0000-000000000002')),
  1::bigint,
  '(14) store A''s rows do not leak into store B''s result set'
);

-- ─── (16) grants ──────────────────────────────────────────────
-- Catalog-query assertion (NOT `set local role anon` + throws_ok) — see the
-- spec 045 / 067 note in reports_anon_revoke.test.sql: the runtime-role-switch
-- pattern segfaulted Postgres in CI.
select ok(
  not has_function_privilege('anon', 'public.items_last_counted(uuid)', 'EXECUTE')
  and has_function_privilege('authenticated', 'public.items_last_counted(uuid)', 'EXECUTE'),
  '(16) anon has no EXECUTE on items_last_counted(uuid); authenticated does'
);

select * from finish();
rollback;
