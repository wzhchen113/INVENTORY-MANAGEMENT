-- pgTAP coverage for copy_catalog_rows(p_source, p_target, p_table, p_source_ids).
-- Migration: supabase/migrations/20260518000000_spec049_cross_brand_copy.sql.
--
-- Asserts the 9 arms in spec 049 §M (rejection split across 1a/1b/2):
--   (1a) caller with profiles.role='master' rejected with 'super_admin only' — role gate
--   (1b) caller with profiles.role='admin' rejected with 'super_admin only'  — role gate
--   (2)  caller with profiles.role='master' AND JWT app_metadata.role='master' rejected — role gate
--   (3) anon lacks EXECUTE on copy_catalog_rows                             — GRANT lockdown
--   (4) super_admin can copy N rows of catalog_ingredients (positive)       — happy path
--   (5) super_admin can copy N rows of vendors (positive)                   — happy path
--   (6) skip-on-conflict: pre-existing target row skipped, new row copied   — semantics
--   (7) source == target rejected with 'source and target brands must differ'
--   (8) invalid p_table rejected with 'invalid table: recipes'
--   (9) exactly FOUR audit_log rows in target with action='catalog_copy',
--       item_ref='catalog_ingredients'; ZERO audit rows in source brand
--
-- Anon-revoke (arm 3) uses `has_function_privilege('anon', ..., 'EXECUTE')`
-- per the spec 045 rewrite — do NOT use `set local role anon` (segfaults
-- under newer pg-version in CI).
--
-- Promotes the seed admin (11111111-…) to super_admin within the
-- transaction so auth_can_see_brand() short-circuits to TRUE for the
-- brand-new target brand (which no one is a member of). All mutations
-- roll back at the end. Pattern mirrors copy_brand_catalog.test.sql.

begin;
create extension if not exists pgtap;

select plan(14);

-- ─── fixtures ──────────────────────────────────────────────────────────────
-- Brand-new target brand (no one is a member; super-admin sees via
-- short-circuit). Single brand per spec, no spillover to other tests.
insert into public.brands (id, name)
values ('cafe1049-0000-0000-0000-000000000001', '__test_spec049_target__')
on conflict (id) do nothing;

-- Promote the seed admin to super_admin (brand_id must be NULL per the
-- profiles_role_brand_consistent CHECK). All other fixtures use the
-- master/manager seed rows directly.
update public.profiles
   set role = 'super_admin', brand_id = null
 where id = '11111111-1111-1111-1111-111111111111';

-- Promote the seed manager (id=22..., role='user' in the seed) to 'admin'
-- so the (1b) rejection arm can exercise the auth_is_super_admin() gate
-- against a caller whose profiles.role='admin' (distinct from the (1a)
-- master arm). 'admin' requires brand_id NOT NULL per
-- profiles_role_brand_consistent; the seed already sets brand_id to the
-- seed 2AM PROJECT brand, so no further mutation is needed. Rolled back
-- at the end of this transaction along with all other fixture writes.
update public.profiles
   set role = 'admin'
 where id = '22222222-2222-2222-2222-222222222222';

-- Stash two catalog_ingredients ids from the seed source brand for the
-- positive ingredients arm + the conflict arm.
do $$
declare
  v_ing_id_1 uuid;
  v_ing_id_2 uuid;
  v_ven_id_1 uuid;
  v_ven_id_2 uuid;
  v_first_ing_name text;
begin
  -- Pick two arbitrary source-brand ingredients (deterministic by name
  -- order so test reruns are stable).
  select id, name into v_ing_id_1, v_first_ing_name
    from public.catalog_ingredients
   where brand_id = '2a000000-0000-0000-0000-000000000001'
   order by name
   limit 1;
  select id into v_ing_id_2
    from public.catalog_ingredients
   where brand_id = '2a000000-0000-0000-0000-000000000001'
     and id <> v_ing_id_1
   order by name
   limit 1;

  -- Same for vendors.
  select id into v_ven_id_1
    from public.vendors
   where brand_id = '2a000000-0000-0000-0000-000000000001'
   order by name
   limit 1;
  select id into v_ven_id_2
    from public.vendors
   where brand_id = '2a000000-0000-0000-0000-000000000001'
     and id <> v_ven_id_1
   order by name
   limit 1;

  perform set_config('test.ing_id_1',  v_ing_id_1::text,  true);
  perform set_config('test.ing_id_2',  v_ing_id_2::text,  true);
  perform set_config('test.ven_id_1',  v_ven_id_1::text,  true);
  perform set_config('test.ven_id_2',  v_ven_id_2::text,  true);
  perform set_config('test.first_ing_name', v_first_ing_name, true);
end $$;

-- ─── (1a) caller profiles.role='master' rejected ──────────────────────────
-- JWT app_metadata.role='admin' but profiles.role='master' for id=33....
-- auth_is_super_admin() reads public.profiles (NOT the JWT app_metadata),
-- finds 'master', and returns FALSE — clean rejection. This arm doubles
-- as evidence that the gate ignores the JWT claim when profiles disagrees.
set local role authenticated;
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub',          '33333333-3333-3333-3333-333333333333',
    'role',         'authenticated',
    'app_metadata', jsonb_build_object('role', 'admin')
  )::text,
  true
);

select throws_ok(
  format(
    $q$select public.copy_catalog_rows(
        '2a000000-0000-0000-0000-000000000001'::uuid,
        'cafe1049-0000-0000-0000-000000000001'::uuid,
        'catalog_ingredients',
        array[%L]::uuid[]
      )$q$,
    current_setting('test.ing_id_1', true)
  ),
  'super_admin only',
  '(1a) rejected: caller has profiles.role=''master'' (JWT app_metadata.role=''admin'' is irrelevant)'
);

reset role;

-- ─── (1b) caller profiles.role='admin' rejected ───────────────────────────
-- Fixture id=22... was promoted to profiles.role='admin' in the fixtures
-- block above. auth_is_super_admin() reads profiles, finds 'admin', and
-- returns FALSE. Independent evidence that a profiles.role='admin' caller
-- is rejected (1a only covers profiles.role='master').
set local role authenticated;
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub',          '22222222-2222-2222-2222-222222222222',
    'role',         'authenticated',
    'app_metadata', jsonb_build_object('role', 'admin')
  )::text,
  true
);

select throws_ok(
  format(
    $q$select public.copy_catalog_rows(
        '2a000000-0000-0000-0000-000000000001'::uuid,
        'cafe1049-0000-0000-0000-000000000001'::uuid,
        'catalog_ingredients',
        array[%L]::uuid[]
      )$q$,
    current_setting('test.ing_id_1', true)
  ),
  'super_admin only',
  '(1b) rejected: caller has profiles.role=''admin'''
);

reset role;

-- ─── (2) caller profiles.role='master' with matching JWT rejected ─────────
-- JWT app_metadata.role='master' and profiles.role='master' for id=33...
-- (seed default). auth_is_super_admin() returns FALSE. Pairs with (1a) to
-- show the gate rejects 'master' regardless of whether the JWT agrees.
set local role authenticated;
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub',          '33333333-3333-3333-3333-333333333333',
    'role',         'authenticated',
    'app_metadata', jsonb_build_object('role', 'master')
  )::text,
  true
);

select throws_ok(
  format(
    $q$select public.copy_catalog_rows(
        '2a000000-0000-0000-0000-000000000001'::uuid,
        'cafe1049-0000-0000-0000-000000000001'::uuid,
        'catalog_ingredients',
        array[%L]::uuid[]
      )$q$,
    current_setting('test.ing_id_1', true)
  ),
  'super_admin only',
  '(2) rejected: caller has profiles.role=''master'' (JWT app_metadata.role=''master'')'
);

reset role;

-- ─── (3) anon lacks EXECUTE ───────────────────────────────────────────────
-- Catalog probe, no role switch. Same shape as reports_anon_revoke (post
-- spec-045 rewrite).
select ok(
  not has_function_privilege(
    'anon',
    'public.copy_catalog_rows(uuid, uuid, text, uuid[])',
    'EXECUTE'
  ),
  '(3) anon lacks EXECUTE on copy_catalog_rows'
);

-- ─── (4) super_admin copies catalog_ingredients ──────────────────────────
set local role authenticated;
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub',          '11111111-1111-1111-1111-111111111111',
    'role',         'authenticated',
    'app_metadata', jsonb_build_object('role', 'super_admin')
  )::text,
  true
);

-- The composite return type lands as a single row; extract `copied`.
select cmp_ok(
  (
    select (public.copy_catalog_rows(
        '2a000000-0000-0000-0000-000000000001'::uuid,
        'cafe1049-0000-0000-0000-000000000001'::uuid,
        'catalog_ingredients',
        array[
          current_setting('test.ing_id_1', true)::uuid,
          current_setting('test.ing_id_2', true)::uuid
        ]
      )).copied
  ),
  '=',
  2,
  '(4) super_admin copies 2 catalog_ingredients rows'
);

reset role;

-- ─── (5) super_admin copies vendors ───────────────────────────────────────
set local role authenticated;
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub',          '11111111-1111-1111-1111-111111111111',
    'role',         'authenticated',
    'app_metadata', jsonb_build_object('role', 'super_admin')
  )::text,
  true
);

select cmp_ok(
  (
    select (public.copy_catalog_rows(
        '2a000000-0000-0000-0000-000000000001'::uuid,
        'cafe1049-0000-0000-0000-000000000001'::uuid,
        'vendors',
        array[
          current_setting('test.ven_id_1', true)::uuid,
          current_setting('test.ven_id_2', true)::uuid
        ]
      )).copied
  ),
  '=',
  2,
  '(5) super_admin copies 2 vendors rows'
);

reset role;

-- ─── (6) skip-on-conflict ─────────────────────────────────────────────────
-- The target brand already has the first source ingredient (from arm 4).
-- Re-copying it should land in skipped_names with skipped=1, and any
-- second new id should still copy successfully.
--
-- Seed a NEW ingredient in the SOURCE brand under a unique name so that
-- when we run copy{ing1, new_ing}, ing1 conflicts and new_ing copies.
do $$
declare
  v_new_id uuid;
begin
  insert into public.catalog_ingredients (brand_id, name, unit)
  values ('2a000000-0000-0000-0000-000000000001'::uuid,
          '__spec049_unique_ingredient__',
          'each')
  returning id into v_new_id;
  perform set_config('test.ing_id_new', v_new_id::text, true);
end $$;

set local role authenticated;
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub',          '11111111-1111-1111-1111-111111111111',
    'role',         'authenticated',
    'app_metadata', jsonb_build_object('role', 'super_admin')
  )::text,
  true
);

-- Verify (copied=1, skipped=1, skipped_names contains the first ing name).
select is(
  (
    select (public.copy_catalog_rows(
        '2a000000-0000-0000-0000-000000000001'::uuid,
        'cafe1049-0000-0000-0000-000000000001'::uuid,
        'catalog_ingredients',
        array[
          current_setting('test.ing_id_1',   true)::uuid,
          current_setting('test.ing_id_new', true)::uuid
        ]
      )).copied
  ),
  1,
  '(6a) skip-on-conflict: copied=1 (only the new ingredient was inserted)'
);

select is(
  (
    select (public.copy_catalog_rows(
        '2a000000-0000-0000-0000-000000000001'::uuid,
        'cafe1049-0000-0000-0000-000000000001'::uuid,
        'catalog_ingredients',
        array[
          current_setting('test.ing_id_1',   true)::uuid,
          current_setting('test.ing_id_new', true)::uuid
        ]
      )).skipped
  ),
  -- ing_id_1 conflicts AND ing_id_new conflicts (now in target because
  -- previous call inserted it). Both skipped this time.
  2,
  '(6b) re-running with the same ids yields skipped=2 (both rows now exist in target)'
);

reset role;

-- ─── (7) source == target rejected ────────────────────────────────────────
set local role authenticated;
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub',          '11111111-1111-1111-1111-111111111111',
    'role',         'authenticated',
    'app_metadata', jsonb_build_object('role', 'super_admin')
  )::text,
  true
);

select throws_ok(
  format(
    $q$select public.copy_catalog_rows(
        '2a000000-0000-0000-0000-000000000001'::uuid,
        '2a000000-0000-0000-0000-000000000001'::uuid,
        'catalog_ingredients',
        array[%L]::uuid[]
      )$q$,
    current_setting('test.ing_id_1', true)
  ),
  'source and target brands must differ',
  '(7) source == target rejected'
);

reset role;

-- ─── (8) invalid p_table ──────────────────────────────────────────────────
set local role authenticated;
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub',          '11111111-1111-1111-1111-111111111111',
    'role',         'authenticated',
    'app_metadata', jsonb_build_object('role', 'super_admin')
  )::text,
  true
);

select throws_ok(
  format(
    $q$select public.copy_catalog_rows(
        '2a000000-0000-0000-0000-000000000001'::uuid,
        'cafe1049-0000-0000-0000-000000000001'::uuid,
        'recipes',
        array[%L]::uuid[]
      )$q$,
    current_setting('test.ing_id_1', true)
  ),
  'invalid table: recipes',
  '(8) invalid p_table=recipes rejected'
);

reset role;

-- ─── (9a) exactly FOUR audit rows in target with the expected shape ──────
-- Arms 4, 5, 6a, 6b each wrote an audit row (4 successful super_admin
-- calls). All four target the same target brand. The earlier rejected
-- arms (1a, 1b, 2, 7, 8) did not write any audit rows because the gate
-- trips before any side-effect statement. Locked to '=' (not '>=') so a
-- vendors-audit-row regression or a stray audit insert in any arm would
-- fail this assertion.
--
-- Verify the COUNT of catalog_copy rows in target brand. Reading
-- audit_log directly (no JWT switch — pgTAP runs as postgres superuser
-- which bypasses RLS).
select cmp_ok(
  (
    select count(*)::int
      from public.audit_log
     where action = 'catalog_copy'
       and detail = 'cafe1049-0000-0000-0000-000000000001'
  ),
  '=',
  4,
  '(9a) exactly 4 audit_log rows in target with action=catalog_copy (arms 4/5/6a/6b each wrote one)'
);

-- Verify the shape of one of those rows: action, item_ref, value JSON.
select is(
  (
    select item_ref
      from public.audit_log
     where action = 'catalog_copy'
       and detail = 'cafe1049-0000-0000-0000-000000000001'
       and item_ref = 'catalog_ingredients'
     limit 1
  ),
  'catalog_ingredients',
  '(9b) target audit row has item_ref=catalog_ingredients'
);

-- Verify the JSON-serialized value carries source_brand_id.
select is(
  (
    select (value::jsonb ->> 'source_brand_id')
      from public.audit_log
     where action = 'catalog_copy'
       and detail = 'cafe1049-0000-0000-0000-000000000001'
       and item_ref = 'catalog_ingredients'
     limit 1
  ),
  '2a000000-0000-0000-0000-000000000001',
  '(9c) target audit row value JSON carries source_brand_id'
);

-- ─── (9d) ZERO audit rows pointing at the source brand ────────────────────
-- catalog_copy is target-brand-only per AC §6.
select is(
  (
    select count(*)::int
      from public.audit_log
     where action = 'catalog_copy'
       and detail = '2a000000-0000-0000-0000-000000000001'
  ),
  0,
  '(9d) zero catalog_copy audit rows pointing at source brand'
);

select * from finish();

rollback;
