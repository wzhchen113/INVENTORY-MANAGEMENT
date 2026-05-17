-- pgTAP coverage for copy_brand_catalog(source, target).
-- Migration: supabase/migrations/20260517030000_copy_brand_catalog.sql.
--
-- Asserts:
--   (1) super_admin can call (gate + visibility both pass)
--   (2) plain user role is rejected with 'privileged only'
--   (3) source==target rejected
--   (4) actually copies rows from source brand to target brand
--   (5) ON CONFLICT (brand_id, lower(name)) DO NOTHING — re-running
--       returns 0 on the second call
--
-- Promotes a seed user to super_admin inside the transaction so
-- auth_can_see_brand() returns true for the brand-new target brand
-- (which no one is a member of). All mutations roll back at the end.

begin;
create extension if not exists pgtap;

select plan(5);

-- ─── fixtures ──────────────────────────────────────────────────────────────
insert into brands (id, name) values ('cafefeed-0000-0000-0000-000000000001', '__test_target_brand__')
on conflict (id) do nothing;

-- Promote the seed admin (11111111-...) to super_admin with brand_id=null
-- (the profiles_role_brand_consistent CHECK requires brand_id IS NULL for
-- super_admin). Pattern mirrors delete_last_privileged_guard.test.sql.
update public.profiles
   set role = 'super_admin', brand_id = null
 where id = '11111111-1111-1111-1111-111111111111';

-- ─── (1) super_admin can call ──────────────────────────────────────────────
set local role authenticated;
set local request.jwt.claims to '{"sub": "11111111-1111-1111-1111-111111111111", "role": "authenticated", "app_metadata": {"role": "super_admin"}}';

select lives_ok(
  $$select public.copy_brand_catalog('2a000000-0000-0000-0000-000000000001', 'cafefeed-0000-0000-0000-000000000001'::uuid)$$,
  '(1) super_admin can call copy_brand_catalog'
);

reset role;

-- ─── (2) plain user rejected ───────────────────────────────────────────────
set local role authenticated;
set local request.jwt.claims to '{"sub": "22222222-2222-2222-2222-222222222222", "role": "authenticated", "app_metadata": {"role": "user"}}';

select throws_ok(
  $$select public.copy_brand_catalog('2a000000-0000-0000-0000-000000000001', 'cafefeed-0000-0000-0000-000000000001'::uuid)$$,
  'privileged only',
  '(2) plain user is rejected with `privileged only`'
);

reset role;

-- ─── (3) source==target rejected ───────────────────────────────────────────
set local role authenticated;
set local request.jwt.claims to '{"sub": "11111111-1111-1111-1111-111111111111", "role": "authenticated", "app_metadata": {"role": "super_admin"}}';

select throws_ok(
  $$select public.copy_brand_catalog('2a000000-0000-0000-0000-000000000001', '2a000000-0000-0000-0000-000000000001'::uuid)$$,
  'source and target brands must differ',
  '(3) source==target is rejected'
);

-- ─── (4) actually copied rows ──────────────────────────────────────────────
select cmp_ok(
  (select count(*)::int from catalog_ingredients where brand_id = 'cafefeed-0000-0000-0000-000000000001'::uuid),
  '=',
  (select count(*)::int from catalog_ingredients where brand_id = '2a000000-0000-0000-0000-000000000001'::uuid),
  '(4) target brand row count equals source brand row count after copy'
);

-- ─── (5) re-running is idempotent ──────────────────────────────────────────
select cmp_ok(
  (select public.copy_brand_catalog('2a000000-0000-0000-0000-000000000001', 'cafefeed-0000-0000-0000-000000000001'::uuid)),
  '=', 0,
  '(5) re-running is idempotent (ON CONFLICT DO NOTHING returns 0)'
);

reset role;

select * from finish();

rollback;
