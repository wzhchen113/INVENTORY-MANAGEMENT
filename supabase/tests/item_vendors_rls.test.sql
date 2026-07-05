-- supabase/tests/item_vendors_rls.test.sql
--
-- Spec 102 / AC-B / AC-I — pgTAP coverage for the item_vendors RLS policies
-- in supabase/migrations/20260630000000_item_vendors.sql.
--
-- item_vendors has NO store_id column; each of its four policies
-- (store_member_{read,insert,update,delete}_item_vendors) joins to
-- inventory_items and gates on auth_can_see_store(ii.store_id) — the
-- per-store-RLS-hardening child-table pattern. AC-B binding requirement:
-- "A user who cannot see a store cannot read or write that store's
-- item↔vendor links."
--
-- Fourteen assertions, manager@local.test (id 2222…, role=user) whose
-- user_stores cover Towson + Frederick only — so Charles is the
-- negative-membership store (mirrors staff_role_eod_rls.test.sql).
-- Assertions (1)-(8) are the spec-102 baseline; (9)-(12) below are spec 114
-- (the (10) + (11) groups each split into two select calls → plan(14)):
--
--   (1) fixture resolve — Frederick + Charles + a vendor resolve.
--   (2) member SELECT — the manager CAN read its own store's (Frederick)
--       link (seeded by postgres below).
--   (3) non-member SELECT — the manager sees ZERO rows of a Charles item's
--       link (RLS SELECT scope; the row exists, seeded by postgres).
--   (4) member INSERT — the manager CAN insert a link for a Frederick item
--       (WITH CHECK passes via auth_can_see_store(Frederick)).
--   (5) non-member INSERT — inserting a link for a CHARLES item raises 42501
--       (the INSERT WITH CHECK re-validates the joined store).
--   (6) non-member UPDATE — updating the Charles item's link (seeded) to
--       re-point it is a no-op under RLS: the USING clause hides the row, so
--       0 rows are affected and the persisted cost is unchanged. (Postgres
--       UPDATE under RLS filters by USING silently rather than raising; we
--       assert the row was NOT mutated.)
--   (7) non-member UPDATE via item swap — pointing an UPDATE's new item_id at
--       a Charles item (from a Frederick-owned link the manager CAN see)
--       raises 42501: the WITH CHECK on the NEW row re-validates the joined
--       store and rejects the cross-store move.
--   (8) member DELETE — the manager CAN delete its own Frederick link.
--
-- Spec 114 (D-11) — the additive `order_code` column inherits the four
-- policies above unchanged (RLS is row-level, column-agnostic). Four more:
--
--   (9)  metadata — item_vendors HAS an `order_code` column (AC-1).
--   (10) metadata — `order_code` is nullable / text (AC-1). No default, no
--        backfill: existing rows are NULL. (Asserted via col_is_null +
--        col_type_is, catalog reads that are RLS-independent.)
--   (11) member WRITE + omitted→NULL (AC-1/AC-3). The manager's own Frederick
--        link is created WITHOUT an order_code (starts NULL — the omitted
--        case, NOT ''), then the manager UPDATEs order_code = 'US-777' and it
--        reads back — proving a store member can write AND read the new
--        column on their own store's link, and that an omitted code persists
--        as SQL NULL rather than the string 'undefined' or ''.
--   (12) non-member WRITE denied (AC-2) — the manager's UPDATE of order_code
--        on the CHARLES link is a no-op under the USING clause (0 rows; the
--        column stays NULL), re-read under postgres. This is the inherited-
--        policy REGRESSION PIN: the added column did NOT punch a hole in the
--        whole-row policy — RLS is row-level, so a non-member still cannot
--        write order_code on a store they can't see.
--
-- Charles rows the manager must NOT see are seeded under the postgres role
-- (RLS-bypassing) then re-impersonated, mirroring staff_role_eod_rls.test.sql
-- assertion (8). No `set role anon` (segfaults CI per spec 067).
--
-- CI-fresh safe: every link this test reads/writes is seeded INSIDE the
-- transaction — it never depends on the 564-row backfill seed. Hermetic
-- isolation: begin; … rollback;.

begin;
create extension if not exists pgtap;

select plan(14);

-- ─── (9)/(10) metadata — order_code column exists, nullable, text (AC-1) ─
-- Catalog reads, RLS-independent, so they run up front under postgres before
-- any impersonation. Proves the additive migration landed the column with
-- the intended shape (nullable text, no default → existing rows NULL).
select has_column('public'::name, 'item_vendors'::name, 'order_code'::name,
  '(9) item_vendors has an order_code column (spec 114 additive)');
select col_is_null('public'::name, 'item_vendors'::name, 'order_code'::name,
  '(10a) order_code is nullable (no NOT NULL, no default — existing rows NULL)');
select col_type_is('public'::name, 'item_vendors'::name, 'order_code'::name, 'text'::text,
  '(10b) order_code is text (free-form vendor code, no uniqueness)');

-- ─── fixtures (postgres role — seed cross-store rows RLS would hide) ──
do $$
declare
  v_manager_id  uuid := '22222222-2222-2222-2222-222222222222';
  v_frederick   uuid;
  v_charles     uuid;
  v_vendor_id   uuid;
  v_other_vid   uuid;
  v_fred_item   uuid;
  v_charles_item uuid;
begin
  select id into v_frederick from public.stores where name = 'Frederick' limit 1;
  select id into v_charles   from public.stores where name = 'Charles'   limit 1;
  select id into v_vendor_id from public.vendors order by id limit 1;
  select id into v_other_vid from public.vendors order by id desc limit 1;

  -- A Frederick item + a Charles item (any seed items in those stores).
  select id into v_fred_item    from public.inventory_items where store_id = v_frederick limit 1;
  select id into v_charles_item from public.inventory_items where store_id = v_charles   limit 1;

  -- Seed a link for the CHARLES item under postgres (bypasses RLS) so the
  -- non-member SELECT/UPDATE assertions have a real row the manager must not
  -- see/mutate. is_primary = false deliberately: the 564-row backfill seed
  -- may already have linked this Charles item with a PRIMARY row, and the
  -- item_vendors_one_primary_per_item partial-unique index permits only ONE
  -- primary per item. A second primary would violate it; this test asserts
  -- on RLS visibility/mutability, not on primary, so a non-primary link is
  -- fine. on conflict do nothing keeps it robust if the seed already linked
  -- this exact (item, vendor) pair.
  insert into public.item_vendors (item_id, vendor_id, cost_per_unit, case_price, is_primary)
  values (v_charles_item, v_vendor_id, 99.00, 99.00, false)
  on conflict (item_id, vendor_id)
    do update set cost_per_unit = 99.00, case_price = 99.00, is_primary = false;

  perform set_config('test.manager_id',    v_manager_id::text,   true);
  perform set_config('test.frederick_id',  v_frederick::text,    true);
  perform set_config('test.charles_id',    v_charles::text,      true);
  perform set_config('test.vendor_id',     v_vendor_id::text,    true);
  perform set_config('test.other_vid',     v_other_vid::text,    true);
  perform set_config('test.fred_item',     v_fred_item::text,    true);
  perform set_config('test.charles_item',  v_charles_item::text, true);
end $$;

select isnt(current_setting('test.charles_item', true), '',
  '(1) fixture: Frederick + Charles items + a vendor resolve from seed');

-- ─── Impersonate the staff user (manager@local.test, role=user) ─
set local role authenticated;
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub',           current_setting('test.manager_id', true),
    'role',          'authenticated',
    'app_metadata',  jsonb_build_object('role', 'user')
  )::text,
  true
);

-- Seed a Frederick link AS THE MANAGER (exercises the INSERT WITH CHECK on a
-- member store — assertion (4)). is_primary = false: the seed backfill may
-- already have created a PRIMARY link for this Frederick item (under its
-- scalar vendor), and item_vendors_one_primary_per_item permits only one
-- primary per item — a second primary would violate it. This test asserts on
-- RLS read/write/delete, not on primary, so a non-primary link is correct.
-- do update keeps it robust if this exact (item, vendor) pair already exists.
create temp table _fred_link on commit drop as
with ins as (
  insert into public.item_vendors (item_id, vendor_id, cost_per_unit, case_price, is_primary)
  values (
    current_setting('test.fred_item', true)::uuid,
    current_setting('test.vendor_id', true)::uuid,
    11.00, 44.00, false
  )
  on conflict (item_id, vendor_id)
    do update set cost_per_unit = excluded.cost_per_unit, is_primary = false
  returning id
)
select id from ins;

-- ─── (4) member INSERT succeeded — the Frederick link exists ────
-- (Placed early because the WITH-block above IS the insert; assert it landed.)
select is(
  (select count(*)::bigint from public.item_vendors
    where item_id = current_setting('test.fred_item', true)::uuid
      and vendor_id = current_setting('test.vendor_id', true)::uuid),
  1::bigint,
  '(4) member CAN INSERT a link for an own-store (Frederick) item (WITH CHECK passes)'
);

-- ─── (2) member SELECT — manager reads its own Frederick link ───
-- Scoped to the exact (item, vendor) pair the manager just wrote (the
-- Frederick item may carry other seed links under its scalar vendor; the
-- point here is the member can read the link it owns).
select is(
  (select count(*)::bigint from public.item_vendors
    where item_id = current_setting('test.fred_item', true)::uuid
      and vendor_id = current_setting('test.vendor_id', true)::uuid),
  1::bigint,
  '(2) member CAN SELECT its own store''s item_vendors link'
);

-- ─── (3) non-member SELECT — Charles link is invisible (0 rows) ─
select is(
  (select count(*)::bigint from public.item_vendors
    where item_id = current_setting('test.charles_item', true)::uuid),
  0::bigint,
  '(3) non-member sees ZERO rows of a Charles item''s link (RLS SELECT scope)'
);

-- ─── (11) member WRITE order_code + omitted→NULL (spec 114, AC-1/AC-3) ─
-- The manager's Frederick link (created above WITHOUT an order_code) starts
-- NULL — the omitted case, proving an absent code persists as SQL NULL, not
-- '' and not the string 'undefined'. The manager (a member of Frederick)
-- then UPDATEs order_code and reads it back: a store member CAN write AND
-- read the new column on their own store's link. `is(NULL, NULL)` returns
-- true in pgTAP, so the first leg asserts the pre-write NULL directly.
select is(
  (select order_code from public.item_vendors
    where item_id = current_setting('test.fred_item', true)::uuid
      and vendor_id = current_setting('test.vendor_id', true)::uuid),
  null::text,
  '(11a) omitted order_code persisted as SQL NULL (not '''' / not "undefined")'
);
update public.item_vendors
   set order_code = 'US-777'
 where item_id = current_setting('test.fred_item', true)::uuid
   and vendor_id = current_setting('test.vendor_id', true)::uuid;
select is(
  (select order_code from public.item_vendors
    where item_id = current_setting('test.fred_item', true)::uuid
      and vendor_id = current_setting('test.vendor_id', true)::uuid),
  'US-777'::text,
  '(11b) member CAN write + read order_code on its own store''s link'
);

-- ─── (5) non-member INSERT — link for a Charles item → 42501 ────
-- The INSERT WITH CHECK re-validates the joined store; the manager cannot
-- see Charles, so the check fails with insufficient_privilege.
select throws_ok(
  format(
    $q$insert into public.item_vendors (item_id, vendor_id, cost_per_unit, case_price, is_primary)
       values (%L::uuid, %L::uuid, 1, 1, false)$q$,
    current_setting('test.charles_item', true),
    current_setting('test.other_vid', true)
  ),
  '42501',
  null,
  '(5) non-member INSERT of a link for a Charles item rejected by WITH CHECK (42501)'
);

-- ─── (6) non-member UPDATE — Charles link not mutated (USING hides it) ─
-- Update is RLS-filtered by USING; the Charles row is invisible to the
-- manager, so the UPDATE matches 0 rows and the postgres-seeded cost (99.00)
-- is preserved. Verified by re-reading under postgres after the attempt.
update public.item_vendors
   set cost_per_unit = 1
 where item_id = current_setting('test.charles_item', true)::uuid;

-- Spec 114 (12) — same non-member UPDATE, now targeting order_code: the
-- inherited-policy regression pin. The Charles link (postgres-seeded above
-- WITHOUT an order_code → NULL) is invisible to the manager, so this UPDATE
-- is a no-op under the USING clause. Re-read under postgres proves the added
-- column did NOT escape the whole-row policy (RLS is row-level, column-
-- agnostic — a non-member still cannot write order_code on a store they
-- can't see).
update public.item_vendors
   set order_code = 'HACK-1'
 where item_id = current_setting('test.charles_item', true)::uuid;

reset role;
select is(
  (select cost_per_unit from public.item_vendors
    where item_id = current_setting('test.charles_item', true)::uuid
      and vendor_id = current_setting('test.vendor_id', true)::uuid),
  99.00::numeric,
  '(6) non-member UPDATE does not mutate a Charles link (USING hides the row)'
);
select is(
  (select order_code from public.item_vendors
    where item_id = current_setting('test.charles_item', true)::uuid
      and vendor_id = current_setting('test.vendor_id', true)::uuid),
  null::text,
  '(12) non-member UPDATE cannot write order_code on a Charles link (stays NULL — RLS regression pin)'
);

-- Re-impersonate the manager for the remaining write assertions.
set local role authenticated;
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub',           current_setting('test.manager_id', true),
    'role',          'authenticated',
    'app_metadata',  jsonb_build_object('role', 'user')
  )::text,
  true
);

-- ─── (7) non-member UPDATE via item swap → 42501 ────────────────
-- From the manager's OWN visible Frederick link, attempt to re-point its
-- item_id at a Charles item. The USING clause admits the row (Frederick is
-- visible), but the WITH CHECK on the NEW row re-validates the joined store
-- (now Charles) and rejects it — proving the WITH CHECK guards cross-store
-- moves, not just the originating store.
select throws_ok(
  format(
    $q$update public.item_vendors
         set item_id = %L::uuid
       where item_id = %L::uuid
         and vendor_id = %L::uuid$q$,
    current_setting('test.charles_item', true),
    current_setting('test.fred_item', true),
    current_setting('test.vendor_id', true)
  ),
  '42501',
  null,
  '(7) UPDATE re-pointing a link to a Charles item rejected by WITH CHECK (42501)'
);

-- ─── (8) member DELETE — manager deletes its own Frederick link ─
delete from public.item_vendors
 where item_id = current_setting('test.fred_item', true)::uuid
   and vendor_id = current_setting('test.vendor_id', true)::uuid;

select is(
  (select count(*)::bigint from public.item_vendors
    where item_id = current_setting('test.fred_item', true)::uuid
      and vendor_id = current_setting('test.vendor_id', true)::uuid),
  0::bigint,
  '(8) member CAN DELETE its own store''s link'
);

select * from finish();
rollback;
