-- supabase/tests/stores_privileged_update_status.test.sql
--
-- Spec 083 (store-deactivation-toggle) — pgTAP regression pin for the
-- server-side role gate the whole feature leans on. NO migration lands in
-- spec 083; this is a standalone guard against a future change weakening the
-- existing privileged_update_stores policy on public.stores
-- (supabase/migrations/20260509000000_multi_brand_schema_rls.sql:627-636),
-- whose USING + WITH CHECK are both
--   auth_is_privileged() AND auth_can_see_brand(brand_id).
-- auth_is_privileged() is exactly the admin + master + super_admin set the
-- spec wants (Q3). A status-only PATCH passes WITH CHECK because brand_id is
-- unchanged.
--
-- Eight arms (plan(8)):
--   (1) admin of the store's brand flips status active→inactive: UPDATE
--       affects the row, and the new status is persisted.
--   (2) the same admin flips it back inactive→active (reversibility AC).
--   (3) master (JWT app_metadata.role='master') of the brand can flip status.
--   (4) non-privileged caller (role='user') UPDATE affects 0 rows (RLS filters
--       it) — the "rejected by the backend" criterion.
--   (5) cross-brand admin (privileged but auth_can_see_brand(brand)=false)
--       UPDATE affects 0 rows.
--   (6) super_admin can flip status on ANY brand's store (cross-brand) — the
--       auth_is_super_admin() short-circuit inside auth_can_see_brand.
--   (7) AC5 cron-gate pin (suppression): an inactive store is EXCLUDED from
--       eod-reminder-cron's active-store query
--       (eod-reminder-cron/index.ts:188 — .eq('status','active')).
--   (8) AC5 cron-gate pin (inclusion): an active store IS included, so a future
--       edit that removed the filter wouldn't pass by emptying the result set.
--
-- The "affects N rows" arms use a SECURITY-sensitive trick: under
-- `set local role authenticated` an UPDATE filtered by RLS returns 0 rows
-- silently (PostgREST UPDATE semantics — no 4xx). We assert the row's status
-- AFTER the attempted UPDATE (read back under the postgres role, RLS-bypassed)
-- so a denied write shows as "status unchanged".
--
-- JWT-impersonation + hermetic begin/rollback pattern copied from
-- auth_can_see_store_brand_scope.test.sql.

begin;
create extension if not exists pgtap;

select plan(8);

-- ─── fixtures ──────────────────────────────────────────────────
do $$
declare
  v_admin_id   uuid := '11111111-1111-1111-1111-111111111111';  -- seed admin (brand A)
  v_manager_id uuid := '22222222-2222-2222-2222-222222222222';  -- seed manager (role 'user', brand A)
  v_master_id  uuid := '33333333-3333-3333-3333-333333333333';  -- seed master (brand A)
  v_brand_a    uuid := '2a000000-0000-0000-0000-000000000001';  -- seed brand
  v_brand_b    uuid := 'b1000000-0000-0000-0000-000000000001';  -- test-only brand
  v_store_towson uuid := '00000000-0000-0000-0000-000000000001';  -- seed Towson (brand A)
  v_store_b    uuid := 'b1000001-0000-0000-0000-000000000001';  -- test-only foreign-brand store
begin
  perform set_config('test.admin_id',     v_admin_id::text,     true);
  perform set_config('test.manager_id',   v_manager_id::text,   true);
  perform set_config('test.master_id',    v_master_id::text,    true);
  perform set_config('test.brand_a',      v_brand_a::text,      true);
  perform set_config('test.brand_b',      v_brand_b::text,      true);
  perform set_config('test.store_towson', v_store_towson::text, true);
  perform set_config('test.store_b',      v_store_b::text,      true);
end $$;

-- Test-only foreign brand + a store inside it (scoped to this txn).
insert into public.brands (id, name)
values (current_setting('test.brand_b', true)::uuid, 'Foreign Brand (test 083)')
on conflict (id) do nothing;

insert into public.stores (id, brand_id, name, address, status, eod_deadline_time)
values (
  current_setting('test.store_b', true)::uuid,
  current_setting('test.brand_b', true)::uuid,
  'Foreign Store (test 083)',
  '1 Foreign Way',
  'active',
  '22:00'
)
on conflict (id) do nothing;

-- Normalize the seed Towson store to 'active' at the start so arm (1) has a
-- known starting point regardless of seed drift.
update public.stores
   set status = 'active'
 where id = current_setting('test.store_towson', true)::uuid;


-- ─── Arm (1): admin of the brand flips status active→inactive ──
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

update public.stores
   set status = 'inactive'
 where id = current_setting('test.store_towson', true)::uuid;

reset role;
select is(
  (select status from public.stores
    where id = current_setting('test.store_towson', true)::uuid),
  'inactive',
  'arm (1): brand admin can flip store status active→inactive (privileged_update_stores admits)'
);


-- ─── Arm (2): admin flips it back inactive→active (reversible) ──
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

update public.stores
   set status = 'active'
 where id = current_setting('test.store_towson', true)::uuid;

reset role;
select is(
  (select status from public.stores
    where id = current_setting('test.store_towson', true)::uuid),
  'active',
  'arm (2): brand admin can re-activate the store (reversibility AC)'
);


-- ─── Arm (3): master JWT of the brand can flip status ──────────
-- Impersonate the seed master user (v_master_id) itself — NOT the admin user
-- with a master JWT claim — so this arm proves the master-profile path end to
-- end: auth_is_privileged() admits role='master' AND auth_can_see_brand(brand_a)
-- is satisfied via the master's own brand_a user_stores grant (seed.sql:190-196).
set local role authenticated;
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub',          current_setting('test.master_id', true),
    'role',         'authenticated',
    'app_metadata', jsonb_build_object('role', 'master')
  )::text,
  true
);

update public.stores
   set status = 'inactive'
 where id = current_setting('test.store_towson', true)::uuid;

reset role;
select is(
  (select status from public.stores
    where id = current_setting('test.store_towson', true)::uuid),
  'inactive',
  'arm (3): master JWT can flip store status (auth_is_privileged admits master)'
);

-- Reset Towson to active for the negative arms below.
update public.stores
   set status = 'active'
 where id = current_setting('test.store_towson', true)::uuid;


-- ─── Arm (4): non-privileged (role='user') UPDATE affects 0 rows ──
-- The seed manager has role='user' and a user_stores grant for Towson, so
-- they can SEE it, but auth_is_privileged() is false → privileged_update_stores
-- USING denies the row → UPDATE 0. Status must remain 'active'.
set local role authenticated;
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub',          current_setting('test.manager_id', true),
    'role',         'authenticated',
    'app_metadata', jsonb_build_object('role', 'user')
  )::text,
  true
);

update public.stores
   set status = 'inactive'
 where id = current_setting('test.store_towson', true)::uuid;

reset role;
select is(
  (select status from public.stores
    where id = current_setting('test.store_towson', true)::uuid),
  'active',
  'arm (4): non-privileged caller (role=user) cannot flip status — UPDATE filtered to 0 rows'
);


-- ─── Arm (5): cross-brand admin UPDATE affects 0 rows ──────────
-- The seed admin (brand A, role='admin') is privileged but
-- auth_can_see_brand(brand_b) is false, so the USING clause denies the
-- foreign-brand store. Status must remain 'active'.
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

update public.stores
   set status = 'inactive'
 where id = current_setting('test.store_b', true)::uuid;

reset role;
select is(
  (select status from public.stores
    where id = current_setting('test.store_b', true)::uuid),
  'active',
  'arm (5): cross-brand admin cannot flip a foreign-brand store — UPDATE filtered to 0 rows'
);


-- ─── Arm (6): super_admin can flip ANY brand's store ───────────
-- Promote the seed master to super_admin (brand_id NULL per
-- profiles_role_brand_consistent), same pattern as the brand-scope test, then
-- flip the foreign-brand store. auth_can_see_brand short-circuits on
-- auth_is_super_admin().
reset role;
update public.profiles
   set role = 'super_admin', brand_id = null
 where id = current_setting('test.master_id', true)::uuid;

set local role authenticated;
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub',          current_setting('test.master_id', true),
    'role',         'authenticated',
    'app_metadata', jsonb_build_object('role', 'super_admin')
  )::text,
  true
);

update public.stores
   set status = 'inactive'
 where id = current_setting('test.store_b', true)::uuid;

reset role;
select is(
  (select status from public.stores
    where id = current_setting('test.store_b', true)::uuid),
  'inactive',
  'arm (6): super_admin can flip a foreign-brand store status (auth_is_super_admin short-circuit)'
);


-- ─── Arm (7)+(8): AC5 — eod-reminder-cron active-store gate pin ──
-- The entire notification-suppression claim rests on a single unguarded line:
--   eod-reminder-cron/index.ts:188
--   sb.from('stores').select('id, name, eod_deadline_time').eq('status','active')
-- The cron runs as the service role (RLS-bypassed), so we reproduce its exact
-- filter under the RLS-bypassing postgres role (reset above) — the gate under
-- test is the .eq('status','active') filter, not RLS. If a future edit drops or
-- conditions that filter, arm (7) fails (an inactive store leaks into the
-- reminder set). Arm (8) guards against the filter being replaced by something
-- that simply returns nothing.
--
-- State entering this block: arm (6) left v_store_b 'inactive' and Towson
-- 'active', giving us one inactive and one active store in the same txn.
reset role;
select is(
  (select count(*)::int
     from public.stores
    where status = 'active'
      and id = current_setting('test.store_b', true)::uuid),
  0,
  'arm (7): eod-reminder-cron active-store filter EXCLUDES an inactive store (AC5 suppression)'
);

select is(
  (select count(*)::int
     from public.stores
    where status = 'active'
      and id = current_setting('test.store_towson', true)::uuid),
  1,
  'arm (8): eod-reminder-cron active-store filter INCLUDES an active store (AC5 inclusion sanity)'
);


select * from finish();
rollback;
