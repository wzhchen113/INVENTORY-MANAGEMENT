-- supabase/tests/user_stores_own_row_writes.test.sql
--
-- Spec 195 (renumbered from 190): pgTAP regression for
-- supabase/migrations/20261109195000_user_stores_drop_own_row_writes.sql,
-- which drops the own-row write policy "Users can manage own store links"
-- on public.user_stores and keeps the own-row read policy.
--
-- Twenty-seven arms, plan(27). T1-T23 follow spec 195 D-5; T24-T27 were
-- added after review (release proposal step 4).
--
--   Policy shape (AC-1, AC-2), as postgres:
--     T1  policies_are: exactly the admin arm and the own-row read.
--     T2  read policy is PERMISSIVE | SELECT | (user_id = auth.uid()).
--     T3  admin policy permissive/cmd/qual/with_check byte-equal to the
--         text captured from local pg_policies BEFORE the migration ran.
--     T4  the migration's fail-closed W + R predicate as one string.
--
--   Refusals (the hole is closed):
--     T5-T6   AC-4     store-less staff invitee (NULL brand, no links,
--                      JWT user) self-links a brand-B store -> 42501, 0 rows.
--     T7      AC-5(b)  demoted admin (NULL brand, holds Towson, stale JWT
--                      admin) self-links Charles (brand A) -> 42501. The
--                      trigger admits it (same brand), so RLS refuses.
--     T8      AC-5(a1) same caller self-links store B while holding
--                      Towson -> P0001 from the trigger, which runs BEFORE
--                      the RLS WITH CHECK (spec 195 D-0). Pins the trigger
--                      layer; unchanged by this spec.
--     T9-T10  AC-5(c)  own-row DELETE affects 0 rows; Towson link remains.
--     T11     AC-5(d)  own-row UPDATEs (cross-brand and no-op) affect 0 rows.
--     T12     AC-5(a2) after postgres removes the caller's links (the
--                      "unlink" step), the same caller self-links store B
--                      -> 42501. This is the 187-H2 step the drop closes.
--     T13     AC-5(e)  auth_can_see_store(store B) is false for the caller.
--     T14-T15 AC-7     seed manager's own-row DELETE affects 0 rows; links
--                      unchanged.
--     T16-T17 AC-8     seed manager's own-row upserts (do nothing / do
--                      update) on a new store -> 42501.
--
--   No regression:
--     T18-T19 AC-9     seed manager reads exactly their own links.
--     T20-T21 AC-10    brand-A admin inserts then deletes a brand-A link
--                      for a brand-A user (admin arm).
--     T22-T23 AC-11    super_admin (NULL brand) inserts then deletes the
--                      same link (admin arm via auth_can_see_brand's
--                      super_admin short-circuit).
--
--   Guards and AC-3 post-state pins, as postgres:
--     T24     the seed manager holds at least one link, so T14, T15 and
--             T18 cannot pass vacuously.
--     T25     authenticated still holds SELECT/INSERT/UPDATE/DELETE on
--             user_stores (no grant change; the admin arm needs them).
--     T26     the only non-internal trigger is user_stores_brand_match_trg,
--             enabled, calling user_stores_brand_match().
--     T27     user_stores is not in the supabase_realtime publication.
--
-- Callers are impersonated the PostgREST way: `set local role
-- authenticated` plus `set_config('request.jwt.claims', ..., true)`.
-- Fixtures and verification reads run as postgres after `reset role;
-- select set_config('request.jwt.claims', '', true);`. Same pattern as
-- legacy_permissive_policy_dropout.test.sql.
--
-- Affected-row counts: the write runs in a DO block, `get diagnostics`
-- reads row_count, and set_config stashes it for an is() outside. T11
-- wraps its cross-brand UPDATE in an exception handler (-1 on P0001 or
-- 42501 only) so that a mutation which re-opens own-row UPDATE fails the
-- arm instead of aborting the file, while any other error still aborts.
--
-- RLS refusals are pinned by message text, not just SQLSTATE: a grant
-- revoke would also be 42501 but says 'permission denied for table
-- user_stores' (and would break the admin arm).
--
-- The super_admin is a synthetic profile inserted as postgres rather than
-- the seed master promoted mid-txn, so this file does not depend on any
-- profiles UPDATE guard.
--
-- Hermetic: begin; ... rollback;

begin;
create extension if not exists pgtap;

select plan(27);


-- --- fixtures (constants stashed via set_config) -------------------------
do $$
declare
  v_admin_id      uuid := '11111111-1111-1111-1111-111111111111';  -- seed admin (brand A)
  v_manager_id    uuid := '22222222-2222-2222-2222-222222222222';  -- seed manager (role 'user', brand A)
  v_brand_a       uuid := '2a000000-0000-0000-0000-000000000001';  -- seed brand
  v_brand_b       uuid := 'b1000000-0000-0000-0000-000000000195';  -- test-only foreign brand
  v_store_towson  uuid := '00000000-0000-0000-0000-000000000001';  -- seed Towson (brand A)
  v_store_charles uuid := '1ea549bb-8b50-4078-9301-479311d9fdec';  -- seed Charles (brand A), unlinked for every caller here
  v_store_b       uuid := 'b1000001-0000-0000-0000-000000000195';  -- test-only foreign-brand store
  v_invitee_id    uuid := '19500000-0000-0000-0000-000000000001';  -- user, NULL brand, no links
  v_demoted_id    uuid := '19500000-0000-0000-0000-000000000002';  -- user, NULL brand, holds Towson, stale admin JWT
  v_target_id     uuid := '19500000-0000-0000-0000-000000000003';  -- user, brand A, no links
  v_super_id      uuid := '19500000-0000-0000-0000-000000000004';  -- super_admin, NULL brand
begin
  perform set_config('test.admin_id',      v_admin_id::text,      true);
  perform set_config('test.manager_id',    v_manager_id::text,    true);
  perform set_config('test.brand_a',       v_brand_a::text,       true);
  perform set_config('test.brand_b',       v_brand_b::text,       true);
  perform set_config('test.store_towson',  v_store_towson::text,  true);
  perform set_config('test.store_charles', v_store_charles::text, true);
  perform set_config('test.store_b',       v_store_b::text,       true);
  perform set_config('test.invitee_id',    v_invitee_id::text,    true);
  perform set_config('test.demoted_id',    v_demoted_id::text,    true);
  perform set_config('test.target_id',     v_target_id::text,     true);
  perform set_config('test.super_id',      v_super_id::text,      true);
end $$;

insert into public.brands (id, name)
values (current_setting('test.brand_b', true)::uuid, 'Foreign Brand (test 195)')
on conflict (id) do nothing;

insert into public.stores (id, brand_id, name, address, status, eod_deadline_time)
values (
  current_setting('test.store_b', true)::uuid,
  current_setting('test.brand_b', true)::uuid,
  'Foreign Store (test 195)',
  '1 Foreign Way',
  'active',
  '22:00'
)
on conflict (id) do nothing;

-- Synthetic auth.users rows. Every token column is '' (NULL tokens break
-- GoTrue). Column list copied from legacy_permissive_policy_dropout.test.sql.
insert into auth.users (
  id, instance_id, aud, role,
  email, encrypted_password,
  email_confirmed_at, created_at, updated_at,
  raw_app_meta_data, raw_user_meta_data,
  is_super_admin, is_anonymous,
  confirmation_token, recovery_token,
  email_change_token_new, email_change,
  email_change_token_current, phone_change,
  phone_change_token, reauthentication_token
)
select v.id, '00000000-0000-0000-0000-000000000000',
       'authenticated', 'authenticated',
       v.email, '',
       now(), now(), now(),
       jsonb_build_object('provider','email','providers',array['email'],'role',v.role),
       '{}'::jsonb, false, false,
       '','','','','','','',''
  from (values
    (current_setting('test.invitee_id', true)::uuid, 'invitee-195@local.test', 'user'),
    (current_setting('test.demoted_id', true)::uuid, 'demoted-195@local.test', 'user'),
    (current_setting('test.target_id',  true)::uuid, 'target-195@local.test',  'user'),
    (current_setting('test.super_id',   true)::uuid, 'super-195@local.test',   'super_admin')
  ) as v(id, email, role)
on conflict (id) do nothing;

-- Profiles, inserted as postgres (profiles_insert_role_guard only fires for
-- authenticated/anon). profiles_role_brand_consistent: 'user' may be NULL
-- brand; 'super_admin' must be NULL brand.
insert into public.profiles (id, name, role, initials, color, status, brand_id)
values
  (current_setting('test.invitee_id', true)::uuid,
   'Invitee (test 195)', 'user', 'IN', '#888888', 'active', null),
  (current_setting('test.demoted_id', true)::uuid,
   'Demoted (test 195)', 'user', 'DE', '#888888', 'active', null),
  (current_setting('test.target_id', true)::uuid,
   'Target (test 195)', 'user', 'TG', '#888888', 'active',
   current_setting('test.brand_a', true)::uuid),
  (current_setting('test.super_id', true)::uuid,
   'Super (test 195)', 'super_admin', 'SU', '#888888', 'active', null)
on conflict (id) do nothing;

-- The demoted admin keeps a brand-A link from before demotion. The trigger
-- admits it as a NULL-brand first link.
insert into public.user_stores (user_id, store_id)
values (current_setting('test.demoted_id', true)::uuid,
        current_setting('test.store_towson', true)::uuid)
on conflict do nothing;

-- The seed manager's link count, counted as postgres (not hardcoded).
select set_config(
  'test.mgr_n',
  (select count(*)::text from public.user_stores
    where user_id = current_setting('test.manager_id', true)::uuid),
  true
);


-- ============================================================
-- Policy shape (AC-1, AC-2), as postgres
-- ============================================================

-- T1
select policies_are(
  'public', 'user_stores',
  ARRAY['Admins can manage all store links', 'Users can read own store links'],
  'T1 (AC-1): user_stores has exactly the admin arm and the own-row read policy'
);

-- T2
select is(
  (select permissive || '|' || cmd || '|' || qual
     from pg_policies
    where schemaname = 'public' and tablename = 'user_stores'
      and policyname = 'Users can read own store links'),
  'PERMISSIVE|SELECT|(user_id = auth.uid())',
  'T2 (AC-1): own-row read policy is PERMISSIVE SELECT (user_id = auth.uid()), unchanged'
);

-- T3: literal captured from local pg_policies on 2026-11-09 BEFORE the
-- spec 195 migration was applied. qual and with_check are the same
-- 139-byte string, so one md5 covers both:
-- md5(qual) = md5(with_check) = b05a4d4429e322a9cf194d6072b5f6d3.
-- Reuse it for the prod P-1 comparison.
-- The literal is Postgres' pretty-printed deparse (newlines, indentation).
-- If T3 fails after a Postgres major-version bump with no policy edit,
-- re-capture it from pg_policies; that is a deparse change, not a security
-- regression.
select is(
  (select permissive || '|' || cmd || '|' || qual || '|' || with_check
     from pg_policies
    where schemaname = 'public' and tablename = 'user_stores'
      and policyname = 'Admins can manage all store links'),
  E'PERMISSIVE|ALL|(auth_is_privileged() AND (EXISTS ( SELECT 1\n   FROM stores s\n  WHERE ((s.id = user_stores.store_id) AND auth_can_see_brand(s.brand_id)))))|(auth_is_privileged() AND (EXISTS ( SELECT 1\n   FROM stores s\n  WHERE ((s.id = user_stores.store_id) AND auth_can_see_brand(s.brand_id)))))',
  'T3 (AC-1): admin policy permissive/cmd/qual/with_check byte-identical to the pre-migration text'
);

-- T4: the fail-closed DO block's W + R checks as one string.
select is(
  (select string_agg(cmd || ':' || policyname, ',' order by cmd, policyname)
     from pg_policies
    where schemaname = 'public' and tablename = 'user_stores'
      and permissive = 'PERMISSIVE'),
  'ALL:Admins can manage all store links,SELECT:Users can read own store links',
  'T4 (AC-2): one permissive write policy (admin arm) and one permissive SELECT policy (own-row read)'
);


-- ============================================================
-- AC-4: store-less staff invitee
-- ============================================================
set local role authenticated;
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub',          current_setting('test.invitee_id', true),
    'role',         'authenticated',
    'app_metadata', jsonb_build_object('role', 'user')
  )::text,
  true
);

-- T5: first link, so the trigger admits; RLS refuses.
select throws_ok(
  format(
    $q$insert into public.user_stores (user_id, store_id) values (auth.uid(), %L::uuid)$q$,
    current_setting('test.store_b', true)
  ),
  '42501',
  'new row violates row-level security policy for table "user_stores"',
  'T5 (AC-4): NULL-brand invitee self-link to a foreign-brand store is refused by RLS'
);

reset role;
select set_config('request.jwt.claims', '', true);

-- T6
select is(
  (select count(*)::int from public.user_stores
    where user_id = current_setting('test.invitee_id', true)::uuid),
  0,
  'T6 (AC-4): invitee holds 0 links afterwards'
);


-- ============================================================
-- AC-5: demoted admin (NULL brand, holds Towson, stale admin JWT)
-- ============================================================
set local role authenticated;
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub',          current_setting('test.demoted_id', true),
    'role',         'authenticated',
    'app_metadata', jsonb_build_object('role', 'admin')
  )::text,
  true
);

-- T7: Charles is brand A, same as the held Towson link, so the trigger
-- admits. auth_is_privileged() is true (stale claim) but
-- auth_can_see_brand(A) is false for a NULL-brand 'user' profile.
select throws_ok(
  format(
    $q$insert into public.user_stores (user_id, store_id) values (auth.uid(), %L::uuid)$q$,
    current_setting('test.store_charles', true)
  ),
  '42501',
  'new row violates row-level security policy for table "user_stores"',
  'T7 (AC-5b): demoted admin self-link to an unlinked same-brand store is refused by RLS'
);

-- T8: trigger layer (D-0). Holding Towson (brand A), a brand-B row
-- conflicts in the NULL-brand branch and raises before RLS runs.
select throws_ok(
  format(
    $q$insert into public.user_stores (user_id, store_id) values (auth.uid(), %L::uuid)$q$,
    current_setting('test.store_b', true)
  ),
  'P0001',
  format(
    'cross-brand user_stores assignment rejected: user has no brand and store brands differ (existing brand=%s, new store brand=%s)',
    current_setting('test.brand_a', true),
    current_setting('test.brand_b', true)
  ),
  'T8 (AC-5a1): demoted admin holding a brand-A link gets the trigger P0001 for a brand-B self-link'
);

-- T9: own-row DELETE affects 0 rows.
do $$
declare
  v_n int;
begin
  delete from public.user_stores where user_id = auth.uid();
  get diagnostics v_n = row_count;
  perform set_config('test.t9', v_n::text, true);
end $$;

select is(
  current_setting('test.t9', true),
  '0',
  'T9 (AC-5c): demoted admin own-row DELETE affects 0 rows'
);

reset role;
select set_config('request.jwt.claims', '', true);

-- T10
select is(
  (select count(*)::int from public.user_stores
    where user_id  = current_setting('test.demoted_id', true)::uuid
      and store_id = current_setting('test.store_towson', true)::uuid),
  1,
  'T10 (AC-5c): demoted admin still holds the Towson link'
);

-- Fixture: re-seed the Towson link (idempotent) so T11 does not depend on
-- T9's outcome when a mutation re-opens own-row DELETE.
insert into public.user_stores (user_id, store_id)
values (current_setting('test.demoted_id', true)::uuid,
        current_setting('test.store_towson', true)::uuid)
on conflict do nothing;

set local role authenticated;
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub',          current_setting('test.demoted_id', true),
    'role',         'authenticated',
    'app_metadata', jsonb_build_object('role', 'admin')
  )::text,
  true
);

-- T11: (d1) cross-brand UPDATE and (d2) no-op UPDATE both affect 0 rows.
-- If own-row UPDATE were admitted, d1 would hit the trigger's P0001 (-1)
-- and d2 would update 1 row.
do $$
declare
  v_n1 int;
  v_n2 int;
begin
  begin
    update public.user_stores
       set store_id = current_setting('test.store_b', true)::uuid
     where user_id = auth.uid();
    get diagnostics v_n1 = row_count;
  exception when sqlstate 'P0001' or sqlstate '42501' then
    v_n1 := -1;
  end;

  update public.user_stores
     set store_id = store_id
   where user_id = auth.uid();
  get diagnostics v_n2 = row_count;

  perform set_config('test.t11', v_n1::text || ',' || v_n2::text, true);
end $$;

select is(
  current_setting('test.t11', true),
  '0,0',
  'T11 (AC-5d): demoted admin own-row UPDATEs (cross-brand and no-op) affect 0 rows'
);

-- Fixture: the "unlink" step, done by postgres.
reset role;
select set_config('request.jwt.claims', '', true);
delete from public.user_stores
 where user_id = current_setting('test.demoted_id', true)::uuid;

set local role authenticated;
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub',          current_setting('test.demoted_id', true),
    'role',         'authenticated',
    'app_metadata', jsonb_build_object('role', 'admin')
  )::text,
  true
);

-- T12: with no links the trigger admits a first link in any brand, so RLS
-- is the only gate. The admin arm sees auth_is_privileged() true and
-- auth_can_see_brand(B) false.
select throws_ok(
  format(
    $q$insert into public.user_stores (user_id, store_id) values (auth.uid(), %L::uuid)$q$,
    current_setting('test.store_b', true)
  ),
  '42501',
  'new row violates row-level security policy for table "user_stores"',
  'T12 (AC-5a2): unlinked demoted admin with a stale admin claim cannot self-link a foreign-brand store (187-H2 step)'
);

-- T13
select is(
  public.auth_can_see_store(current_setting('test.store_b', true)::uuid),
  false,
  'T13 (AC-5e): auth_can_see_store(foreign store) is false for the demoted admin'
);


-- ============================================================
-- AC-7, AC-8, AC-9: seed manager (role user, brand A, JWT user)
-- ============================================================
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

-- T14
do $$
declare
  v_n int;
begin
  delete from public.user_stores where user_id = auth.uid();
  get diagnostics v_n = row_count;
  perform set_config('test.t14', v_n::text, true);
end $$;

select is(
  current_setting('test.t14', true),
  '0',
  'T14 (AC-7): seed manager own-row DELETE affects 0 rows'
);

reset role;
select set_config('request.jwt.claims', '', true);

-- T15
select is(
  (select count(*)::text from public.user_stores
    where user_id = current_setting('test.manager_id', true)::uuid),
  current_setting('test.mgr_n', true),
  'T15 (AC-7): seed manager link count is unchanged'
);

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

-- T16
select throws_ok(
  format(
    $q$insert into public.user_stores (user_id, store_id) values (auth.uid(), %L::uuid)
       on conflict (user_id, store_id) do nothing$q$,
    current_setting('test.store_charles', true)
  ),
  '42501',
  'new row violates row-level security policy for table "user_stores"',
  'T16 (AC-8): seed manager own-row upsert (do nothing) on a new store is refused by RLS'
);

-- T17
select throws_ok(
  format(
    $q$insert into public.user_stores (user_id, store_id) values (auth.uid(), %L::uuid)
       on conflict (user_id, store_id) do update set store_id = excluded.store_id$q$,
    current_setting('test.store_charles', true)
  ),
  '42501',
  'new row violates row-level security policy for table "user_stores"',
  'T17 (AC-8): seed manager own-row upsert (do update) on a new store is refused by RLS'
);

-- T18
select is(
  (select count(*)::text from public.user_stores),
  current_setting('test.mgr_n', true),
  'T18 (AC-9): seed manager reads exactly their own links (own-row read unchanged)'
);

-- T19
select is(
  (select count(*)::int from public.user_stores where user_id <> auth.uid()),
  0,
  'T19 (AC-9): seed manager sees 0 links belonging to other users'
);


-- ============================================================
-- AC-10: brand-A admin (admin arm)
-- ============================================================
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

-- T20
select lives_ok(
  format(
    $q$insert into public.user_stores (user_id, store_id) values (%L::uuid, %L::uuid)$q$,
    current_setting('test.target_id', true),
    current_setting('test.store_charles', true)
  ),
  'T20 (AC-10): brand-A admin links a brand-A user to a brand-A store'
);

-- T21
do $$
declare
  v_n int;
begin
  delete from public.user_stores
   where user_id  = current_setting('test.target_id', true)::uuid
     and store_id = current_setting('test.store_charles', true)::uuid;
  get diagnostics v_n = row_count;
  perform set_config('test.t21', v_n::text, true);
end $$;

select is(
  current_setting('test.t21', true),
  '1',
  'T21 (AC-10): brand-A admin removes that link (1 row)'
);


-- ============================================================
-- AC-11: super_admin (NULL brand, admin arm via short-circuit)
-- ============================================================
set local role authenticated;
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub',          current_setting('test.super_id', true),
    'role',         'authenticated',
    'app_metadata', jsonb_build_object('role', 'super_admin')
  )::text,
  true
);

-- T22
select lives_ok(
  format(
    $q$insert into public.user_stores (user_id, store_id) values (%L::uuid, %L::uuid)$q$,
    current_setting('test.target_id', true),
    current_setting('test.store_charles', true)
  ),
  'T22 (AC-11): super_admin links a branded user to a store in that user''s brand'
);

-- T23
do $$
declare
  v_n int;
begin
  delete from public.user_stores
   where user_id  = current_setting('test.target_id', true)::uuid
     and store_id = current_setting('test.store_charles', true)::uuid;
  get diagnostics v_n = row_count;
  perform set_config('test.t23', v_n::text, true);
end $$;

select is(
  current_setting('test.t23', true),
  '1',
  'T23 (AC-11): super_admin removes that link (1 row)'
);

reset role;
select set_config('request.jwt.claims', '', true);


-- ============================================================
-- Guards and AC-3 post-state pins, as postgres
-- ============================================================

-- T24: T14, T15 and T18 compare against mgr_n; 0 would make them vacuous.
select ok(
  current_setting('test.mgr_n', true)::int > 0,
  'T24 (guard): seed manager holds at least one link, so T14/T15/T18 are not vacuous'
);

-- T25: no grant change (AC-3). A REVOKE would also break the admin arm.
select ok(
  has_table_privilege('authenticated', 'public.user_stores', 'SELECT')
  and has_table_privilege('authenticated', 'public.user_stores', 'INSERT')
  and has_table_privilege('authenticated', 'public.user_stores', 'UPDATE')
  and has_table_privilege('authenticated', 'public.user_stores', 'DELETE'),
  'T25 (AC-3): authenticated still holds SELECT/INSERT/UPDATE/DELETE on user_stores'
);

-- T26: trigger unchanged (AC-3).
select is(
  (select string_agg(t.tgname || ':' || t.tgenabled::text || ':' || p.proname,
                     ',' order by t.tgname)
     from pg_trigger t
     join pg_proc p on p.oid = t.tgfoid
    where t.tgrelid = 'public.user_stores'::regclass
      and not t.tgisinternal),
  'user_stores_brand_match_trg:O:user_stores_brand_match',
  'T26 (AC-3): the only trigger on user_stores is user_stores_brand_match_trg, enabled'
);

-- T27: publication unchanged (AC-3).
select is(
  (select count(*)::int
     from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'user_stores'),
  0,
  'T27 (AC-3): user_stores is not in the supabase_realtime publication'
);

select * from finish();
rollback;
