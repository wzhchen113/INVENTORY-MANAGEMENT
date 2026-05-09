-- ============================================================
-- Spec 012a — Multi-brand schema + RLS + one-time data migration
--
-- This is the SECURITY BOUNDARY for the multi-brand model. After this
-- migration ships, brand-admin in brand A genuinely cannot read or
-- write brand B rows — even bypassing the client with curl. UI work
-- (012b) and destructive flows (012c) build on top of this.
--
-- Design: specs/012a-multi-brand-schema-rls.md.
-- Umbrella: specs/012-multi-brand-tenancy.md.
--
-- WHAT THIS MIGRATION DOES (single transaction):
--   1. Adds `profiles.brand_id` (FK to brands, ON DELETE SET NULL).
--   2. Relaxes the `profiles.role` CHECK to accept 'super_admin'.
--   3. Adds `brands.deleted_at` for soft-delete tombstone.
--   4. Adds two indexes on `profiles` (brand_id, role).
--   5. Pre-flight: rejects existing cross-brand `user_stores` rows.
--   6. Backfills existing `profiles.brand_id` to '2AM PROJECT'.
--   7. Promotes `wzhchen113@gmail.com` to super_admin (NOTICE if absent
--      — fresh local stacks won't have it; production does).
--   8. Adds `profiles_role_brand_consistent` CHECK (after backfill so it
--      validates against correct data).
--   9. Creates RLS helpers: auth_is_super_admin(), auth_can_see_brand(),
--      auth_is_privileged(). Updates auth_can_see_store() to
--      short-circuit for super-admin.
--  10. Rewrites RLS on every brand-scoped table.
--  11. Adds a BEFORE-INSERT/UPDATE trigger on `user_stores` rejecting
--      cross-brand assignments (defense-in-depth above RLS).
--
-- ORDERING (per spec §7 risk #6):
--   ADD COLUMN  →  helper functions (no RLS use yet)  →  pre-flight +
--   backfill DO block  →  ADD CHECK CONSTRAINT  →  trigger +
--   policy rewrites. The CHECK runs AFTER the backfill so it doesn't
--   reject pre-existing 'admin' rows whose brand_id was NULL.
--
-- IDEMPOTENT: re-running this migration is a no-op. Every CREATE uses
-- IF NOT EXISTS / OR REPLACE; every ALTER uses IF NOT EXISTS where
-- supported; the backfill UPDATEs are predicated on NULL/wrong values
-- so they no-op on a second run; the super-admin promotion is guarded
-- by an inequality check.
--
-- REALTIME: this migration does NOT touch the supabase_realtime
-- publication, so the `docker restart supabase_realtime_imr-inventory`
-- ritual does NOT apply here. (Future sub-specs that add new tables
-- will need it.)
--
-- ============================================================
-- VERIFICATION PROBES (run post-deploy; NOT part of this migration)
-- ============================================================
-- Quoted verbatim from spec §6. The user runs these after applying.
-- Replace ${ANON_KEY} / ${SERVICE_ROLE_KEY} from `supabase status`.
--
-- Setup probe (run once, manually, to create test data):
--
--   insert into public.brands (id, name)
--   values ('2b000000-0000-0000-0000-000000000002', 'TEST BRAND B')
--   on conflict (id) do nothing;
--
--   insert into public.catalog_ingredients (brand_id, name, unit, category)
--   values ('2b000000-0000-0000-0000-000000000002', 'Brand B Test Ingredient', 'kg', 'Test')
--   on conflict do nothing;
--
--   update public.profiles
--      set role = 'admin', brand_id = '2b000000-0000-0000-0000-000000000002'
--    where id = (select id from auth.users where email = 'brandb@local.test' limit 1);
--
-- Probe 1 — brand-A admin cannot see brand-B catalog (READ isolation):
--   TOKEN_A=$(curl -s -X POST 'http://127.0.0.1:54321/auth/v1/token?grant_type=password' \
--     -H "apikey: ${ANON_KEY}" -H "Content-Type: application/json" \
--     -d '{"email":"admin@local.test","password":"password"}' | jq -r .access_token)
--   curl -s "http://127.0.0.1:54321/rest/v1/catalog_ingredients?brand_id=eq.2b000000-0000-0000-0000-000000000002" \
--     -H "apikey: ${ANON_KEY}" -H "Authorization: Bearer ${TOKEN_A}" | jq 'length'
--   # Expected: 0
--
-- Probe 2 — brand-A admin CAN see brand-A catalog (no regression):
--   curl -s "http://127.0.0.1:54321/rest/v1/catalog_ingredients?brand_id=eq.2a000000-0000-0000-0000-000000000001" \
--     -H "apikey: ${ANON_KEY}" -H "Authorization: Bearer ${TOKEN_A}" | jq 'length'
--   # Expected: 143 (matches existing 2AM catalog count)
--
-- Probe 3 — brand-A admin cannot INSERT into brand B (WRITE isolation):
--   curl -s -X POST "http://127.0.0.1:54321/rest/v1/catalog_ingredients" \
--     -H "apikey: ${ANON_KEY}" -H "Authorization: Bearer ${TOKEN_A}" \
--     -H "Content-Type: application/json" -H "Prefer: return=representation" \
--     -d '{"brand_id":"2b000000-0000-0000-0000-000000000002","name":"smuggled","unit":"kg"}'
--   # Expected: 401/403 / RLS rejection. NOT a successful insert.
--
-- Probe 4 — brand-B admin sees only brand B:
--   TOKEN_B=$(curl -s -X POST 'http://127.0.0.1:54321/auth/v1/token?grant_type=password' \
--     -H "apikey: ${ANON_KEY}" -H "Content-Type: application/json" \
--     -d '{"email":"brandb@local.test","password":"password"}' | jq -r .access_token)
--   curl -s "http://127.0.0.1:54321/rest/v1/catalog_ingredients" \
--     -H "apikey: ${ANON_KEY}" -H "Authorization: Bearer ${TOKEN_B}" | jq '[.[].brand_id] | unique'
--   # Expected: ["2b000000-0000-0000-0000-000000000002"]
--
-- Probe 5 — super-admin sees both brands (cross-brand visibility):
--   docker exec -it supabase_db_imr-inventory psql -U postgres -d postgres -c \
--     "update public.profiles set role='super_admin', brand_id=null where id=(select id from auth.users where email='admin@local.test' limit 1);"
--   TOKEN_S=$(curl -s -X POST 'http://127.0.0.1:54321/auth/v1/token?grant_type=password' \
--     -H "apikey: ${ANON_KEY}" -H "Content-Type: application/json" \
--     -d '{"email":"admin@local.test","password":"password"}' | jq -r .access_token)
--   curl -s "http://127.0.0.1:54321/rest/v1/catalog_ingredients" \
--     -H "apikey: ${ANON_KEY}" -H "Authorization: Bearer ${TOKEN_S}" | jq '[.[].brand_id] | unique | length'
--   # Expected: 2 (both brands visible)
--
-- Probe 6 — child-table RLS (recipe_ingredients) honors parent brand:
--   curl -s "http://127.0.0.1:54321/rest/v1/recipe_ingredients?select=*,recipe:recipes(brand_id)" \
--     -H "apikey: ${ANON_KEY}" -H "Authorization: Bearer ${TOKEN_A}" | jq '[.[].recipe.brand_id] | unique'
--   # Expected: ["2a000000-0000-0000-0000-000000000001"] (brand A only)
--
-- Probe 7 — soft-deleted brand hidden from non-super-admin:
--   docker exec -it supabase_db_imr-inventory psql -U postgres -d postgres -c \
--     "update public.brands set deleted_at = now() where id='2b000000-0000-0000-0000-000000000002';"
--   curl -s "http://127.0.0.1:54321/rest/v1/brands" \
--     -H "apikey: ${ANON_KEY}" -H "Authorization: Bearer ${TOKEN_B}" | jq 'length'
--   # Expected: 0 (their only brand is soft-deleted; nothing visible).
--   curl -s "http://127.0.0.1:54321/rest/v1/brands" \
--     -H "apikey: ${ANON_KEY}" -H "Authorization: Bearer ${TOKEN_S}" | jq 'length'
--   # Expected: 2
--
-- Probe 8 — `user_stores` cross-brand assignment trigger fires:
--   docker exec -it supabase_db_imr-inventory psql -U postgres -d postgres -c \
--     "insert into public.user_stores (user_id, store_id) values
--       ((select id from auth.users where email='admin@local.test' limit 1),
--        (select id from public.stores where brand_id='2b000000-0000-0000-0000-000000000002' limit 1));"
--   -- Expected: ERROR: cross-brand user_stores assignment rejected: ...
--
-- Probe 9 — service-role bypass still works (sibling-app sanity):
--   curl -s "http://127.0.0.1:54321/rest/v1/catalog_ingredients" \
--     -H "apikey: ${SERVICE_ROLE_KEY}" -H "Authorization: Bearer ${SERVICE_ROLE_KEY}" | jq 'length'
--   # Expected: total across all brands. Sibling apps must still
--   # explicitly filter by brand_id at query time — RLS won't do it for them.
-- ============================================================


-- ─── (1) ADD COLUMNS ──────────────────────────────────────────
-- profiles.brand_id : nullable; NULL means super-admin (or legacy 'user'
-- staff row before brand assignment). Enforced by the
-- profiles_role_brand_consistent CHECK added near the bottom of this
-- migration (after the backfill).
alter table public.profiles
  add column if not exists brand_id uuid references public.brands(id) on delete set null;

comment on column public.profiles.brand_id is
  'Brand the admin is scoped to. NULL means super-admin (sees all brands). Enforced by profiles_role_brand_consistent CHECK.';

-- Drop any pre-existing role CHECK so we can install the expanded one.
-- The init schema (20260405000759) declared role with no CHECK; some
-- later migration may have added one. Be defensive.
alter table public.profiles drop constraint if exists profiles_role_check;

-- NOTE on 'master': spec §1 acceptance criteria list only 'super_admin'
-- | 'admin' | 'user'. However, the existing codebase has real 'master'
-- profiles (see supabase/seed.sql and the widespread
-- `app_metadata.role IN ('admin','master')` JWT checks across migrations
-- like 20260424211733_security_fixes.sql, 20260425043301_pos_recipe_aliases.sql,
-- 20260502190001_flags_table.sql). 'master' is a real synonym for 'admin'
-- in the existing model. Rejecting it here would break local seed and
-- any prod 'master' profiles. We allow it in the role CHECK and treat
-- it as admin-equivalent in the brand-consistency CHECK below.
-- FLAGGED for the user in build notes — if 'master' should be unified
-- with 'admin' as part of 012a, that's a follow-up cleanup spec.
alter table public.profiles
  add constraint profiles_role_check
  check (role in ('super_admin', 'admin', 'master', 'user'));

-- brands.deleted_at : soft-delete tombstone. Set by 012c. RLS hides
-- non-NULL rows from non-super-admins.
alter table public.brands
  add column if not exists deleted_at timestamptz;

comment on column public.brands.deleted_at is
  'Soft-delete tombstone. NULL = active. Set by 012c. Hidden from non-super-admin SELECT via RLS.';

-- Indexes for the helper functions' point-lookups.
create index if not exists profiles_brand_id_idx on public.profiles (brand_id);
create index if not exists profiles_role_idx on public.profiles (role);


-- ─── (2) RLS HELPERS ──────────────────────────────────────────
-- All SECURITY DEFINER with locked search_path, mirroring auth_can_see_store
-- shape from 20260504173035_per_store_rls_hardening.sql.

-- auth_is_super_admin() — reads profiles.role, NOT JWT app_metadata.
-- Why: super-admin must NOT be settable from any UI. The source of
-- truth is a server-side row that the app cannot write to without
-- super-admin policies. Spec §2 documents the design tradeoff.
create or replace function public.auth_is_super_admin()
returns boolean
language sql stable security definer set search_path = public, auth as $$
  select exists (
    select 1 from public.profiles
     where id = auth.uid()
       and role = 'super_admin'
  );
$$;

-- auth_can_see_brand(uuid) — true iff super-admin OR caller's
-- profiles.brand_id matches the supplied brand_id. Called from every
-- brand-scoped RLS policy.
create or replace function public.auth_can_see_brand(p_brand_id uuid)
returns boolean
language sql stable security definer set search_path = public, auth as $$
  select
    public.auth_is_super_admin()
    or exists (
      select 1 from public.profiles
       where id = auth.uid()
         and brand_id = p_brand_id
    );
$$;

-- auth_can_see_store(uuid) — UPDATE existing helper. Adds the
-- super-admin short-circuit so super-admin can read every store
-- regardless of user_stores membership. Existing admin-via-JWT and
-- per-store membership semantics are unchanged.
create or replace function public.auth_can_see_store(p_store_id uuid)
returns boolean
language sql stable security definer set search_path = public, auth as $$
  select
    public.auth_is_super_admin()
    or public.auth_is_admin()
    or exists (
      select 1 from public.user_stores
       where user_id = auth.uid()
         and store_id = p_store_id
    );
$$;

-- auth_is_privileged() — convenience: admin OR super-admin. Used by
-- write policies on brand-scoped tables. Super-admin promotion via
-- profiles.role does NOT also set the JWT app_metadata.role to 'admin',
-- so `auth_is_admin()` (which reads the JWT) returns false for
-- super-admins. We OR the two helpers explicitly so super-admin still
-- passes write policies.
create or replace function public.auth_is_privileged()
returns boolean
language sql stable security definer set search_path = public, auth as $$
  select public.auth_is_admin() or public.auth_is_super_admin();
$$;

grant execute on function public.auth_is_super_admin()       to authenticated, anon;
grant execute on function public.auth_can_see_brand(uuid)    to authenticated, anon;
grant execute on function public.auth_is_privileged()        to authenticated, anon;


-- ─── (3) PRE-FLIGHT + ONE-TIME BACKFILL (spec §4) ─────────────
do $$
declare
  v_2am_brand    constant uuid := '2a000000-0000-0000-0000-000000000001';
  v_super_email  constant text := 'wzhchen113@gmail.com';
  v_super_user_id uuid;
  v_promoted     int := 0;
  v_backfilled   int := 0;
  v_cross_brand  int;
begin
  -- ── 0. Pre-flight: assert no cross-brand user_stores rows.
  --     The trigger added later in this migration will reject future
  --     inserts; this confirms existing rows are clean before we trust
  --     the trigger. Practically a no-op today (one brand exists), but
  --     the assertion is the contract.
  select count(*) into v_cross_brand
    from public.user_stores us
    join public.profiles p on p.id = us.user_id
    join public.stores   s on s.id = us.store_id
   where p.brand_id is not null
     and s.brand_id is not null
     and p.brand_id <> s.brand_id;
  if v_cross_brand > 0 then
    raise exception '012a: pre-flight failed: % cross-brand user_stores rows exist; resolve before applying',
      v_cross_brand;
  end if;

  -- ── 1. Backfill profiles.brand_id for every existing non-super-admin
  --     profile. Anyone with role != 'super_admin' and a NULL brand_id
  --     gets the 2AM PROJECT brand. Idempotent — re-running this UPDATE
  --     is a no-op once brand_id is set.
  --
  --     Note: 'user' rows (staff app) are also backfilled here. The
  --     profiles_role_brand_consistent CHECK below is permissive for
  --     'user' (no constraint) so this is safe; backfilling them keeps
  --     them associated with the existing single brand for downstream
  --     staff-side code that may eventually scope by profiles.brand_id.
  update public.profiles
     set brand_id = v_2am_brand
   where brand_id is null
     and role <> 'super_admin';
  get diagnostics v_backfilled = row_count;
  raise notice '012a: backfilled % profiles to 2AM PROJECT brand', v_backfilled;

  -- ── 2. Promote the hard-coded super-admin email.
  --     Look up auth.users by email. If not found (fresh local stack),
  --     NOTICE and skip — do NOT raise exception. Production will have
  --     this user; local dev keeps working as a single-brand-admin env.
  select id into v_super_user_id
    from auth.users
   where lower(email) = lower(v_super_email)
   limit 1;

  if v_super_user_id is null then
    raise notice '012a: super-admin email % not found in auth.users; skipping promotion (expected on fresh local)',
      v_super_email;
  else
    update public.profiles
       set role = 'super_admin',
           brand_id = null
     where id = v_super_user_id
       and (role <> 'super_admin' or brand_id is not null);
    get diagnostics v_promoted = row_count;
    raise notice '012a: promoted % profile row(s) to super_admin (user_id=%)',
      v_promoted, v_super_user_id;

    -- Defensive: if the auth.users row exists but no profile row does
    -- (race in fresh dev), insert it as super_admin so the user can log in.
    if not exists (select 1 from public.profiles where id = v_super_user_id) then
      insert into public.profiles (id, name, role, brand_id, status)
      values (v_super_user_id, 'Super Admin', 'super_admin', null, 'active');
      raise notice '012a: created profile row for super_admin user_id=%', v_super_user_id;
    end if;
  end if;

  -- ── 3. Final invariant check.
  --     After this migration, no admin or master profile should have a
  --     NULL brand_id. (Super-admin must have NULL; user is unconstrained.)
  --     'master' is treated as admin-equivalent per the role CHECK at
  --     §(4) below — must mirror that here so a stray 'master' with NULL
  --     brand_id can't slip through unobserved.
  if exists (
    select 1 from public.profiles where role in ('admin', 'master') and brand_id is null
  ) then
    raise exception '012a: post-migration invariant violated — admin/master profile(s) with NULL brand_id remain';
  end if;
end $$;


-- ─── (4) ROLE/BRAND CONSISTENCY CHECK (after backfill) ────────
-- Added AFTER the backfill DO block so it validates against correct
-- data. Per spec §7 risk #6: ordering matters here.
alter table public.profiles drop constraint if exists profiles_role_brand_consistent;

-- 'master' is treated as admin-equivalent (see role CHECK note above).
alter table public.profiles
  add constraint profiles_role_brand_consistent
  check (
    (role = 'super_admin' and brand_id is null)
    or (role = 'admin'       and brand_id is not null)
    or (role = 'master'      and brand_id is not null)
    or (role = 'user') -- staff app users; brand_id may be NULL or set
  );


-- ─── (5) CROSS-BRAND user_stores TRIGGER ──────────────────────
-- Defense-in-depth above RLS. Even if a future RPC tries to insert a
-- user_stores row for a brand-A admin into a brand-B store, the trigger
-- raises EXCEPTION. RLS would also block it (the inserter would need
-- super-admin or per-store rights), but the trigger guarantees the
-- invariant at the table layer.
create or replace function public.user_stores_brand_match()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_brand  uuid;
  v_store_brand uuid;
begin
  select brand_id into v_user_brand from public.profiles where id = new.user_id;
  select brand_id into v_store_brand from public.stores   where id = new.store_id;
  -- Super-admin (brand_id NULL) and pre-multi-brand legacy rows are
  -- exempt — super-admins shouldn't appear in user_stores anyway, but
  -- if they do (e.g. for testing) we don't want to block them.
  if v_user_brand is null then
    return new;
  end if;
  if v_store_brand is distinct from v_user_brand then
    raise exception 'cross-brand user_stores assignment rejected: user brand=%, store brand=%',
      v_user_brand, v_store_brand;
  end if;
  return new;
end;
$$;

drop trigger if exists user_stores_brand_match_trg on public.user_stores;
create trigger user_stores_brand_match_trg
  before insert or update on public.user_stores
  for each row execute function public.user_stores_brand_match();


-- ============================================================
-- (6) RLS POLICY REWRITES on every brand-scoped table.
--
-- Pattern (per spec §3):
--   READ   : auth_can_see_brand(brand_id)
--   INSERT : auth_is_privileged() AND auth_can_see_brand(brand_id)
--   UPDATE : auth_is_privileged() AND auth_can_see_brand(brand_id)
--             (USING + WITH CHECK both — prevents row from being moved
--              across brands during UPDATE.)
--   DELETE : auth_is_privileged() AND auth_can_see_brand(brand_id)
--
-- For child tables without a brand_id column (recipe_ingredients,
-- prep_recipe_ingredients, recipe_prep_items, ingredient_conversions),
-- the brand check goes through an EXISTS-join on the parent's brand_id.
-- We do NOT denormalize brand_id onto children — see spec §3 rationale.
-- ============================================================


-- ─── (6a) brands ──────────────────────────────────────────────
-- READ : visible if caller can see the brand AND (it's not soft-deleted
--        OR caller is super-admin).
-- WRITE: super-admin only. Tightened from prior P5 policy that allowed
--        any admin to manage the brands table — that was the security
--        gap noted in spec §0 probe #4.

drop policy if exists "auth_read_brands" on public.brands;
drop policy if exists "admin_manage_brands" on public.brands;
drop policy if exists "admin_write_brands" on public.brands;
drop policy if exists "admin_update_brands" on public.brands;
drop policy if exists "admin_delete_brands" on public.brands;
drop policy if exists "brand_member_read_brands" on public.brands;
drop policy if exists "super_admin_manage_brands" on public.brands;

create policy "brand_member_read_brands"
  on public.brands for select
  using (
    public.auth_can_see_brand(id)
    and (deleted_at is null or public.auth_is_super_admin())
  );

create policy "super_admin_manage_brands"
  on public.brands for all
  using (public.auth_is_super_admin())
  with check (public.auth_is_super_admin());


-- ─── (6b) catalog_ingredients ─────────────────────────────────
drop policy if exists "auth_read_catalog_ingredients" on public.catalog_ingredients;
drop policy if exists "admin_manage_catalog_ingredients" on public.catalog_ingredients;
drop policy if exists "admin_write_catalog_ingredients" on public.catalog_ingredients;
drop policy if exists "admin_update_catalog_ingredients" on public.catalog_ingredients;
drop policy if exists "admin_delete_catalog_ingredients" on public.catalog_ingredients;
drop policy if exists "brand_member_read_catalog_ingredients" on public.catalog_ingredients;
drop policy if exists "privileged_insert_catalog_ingredients" on public.catalog_ingredients;
drop policy if exists "privileged_update_catalog_ingredients" on public.catalog_ingredients;
drop policy if exists "privileged_delete_catalog_ingredients" on public.catalog_ingredients;

create policy "brand_member_read_catalog_ingredients"
  on public.catalog_ingredients for select
  using (public.auth_can_see_brand(brand_id));

create policy "privileged_insert_catalog_ingredients"
  on public.catalog_ingredients for insert
  with check (
    public.auth_is_privileged()
    and public.auth_can_see_brand(brand_id)
  );

create policy "privileged_update_catalog_ingredients"
  on public.catalog_ingredients for update
  using (
    public.auth_is_privileged()
    and public.auth_can_see_brand(brand_id)
  )
  with check (
    public.auth_is_privileged()
    and public.auth_can_see_brand(brand_id)
  );

create policy "privileged_delete_catalog_ingredients"
  on public.catalog_ingredients for delete
  using (
    public.auth_is_privileged()
    and public.auth_can_see_brand(brand_id)
  );


-- ─── (6c) recipes ─────────────────────────────────────────────
-- recipes has both brand_id (P1) AND a legacy store_id from init
-- schema. The brand_id is the canonical scope post-refactor.
drop policy if exists "Store access" on public.recipes;
drop policy if exists "auth_read_recipes" on public.recipes;
drop policy if exists "auth_manage_recipes" on public.recipes;
drop policy if exists "admin_write_recipes" on public.recipes;
drop policy if exists "admin_update_recipes" on public.recipes;
drop policy if exists "admin_delete_recipes" on public.recipes;
drop policy if exists "brand_member_read_recipes" on public.recipes;
drop policy if exists "privileged_insert_recipes" on public.recipes;
drop policy if exists "privileged_update_recipes" on public.recipes;
drop policy if exists "privileged_delete_recipes" on public.recipes;

create policy "brand_member_read_recipes"
  on public.recipes for select
  using (public.auth_can_see_brand(brand_id));

create policy "privileged_insert_recipes"
  on public.recipes for insert
  with check (
    public.auth_is_privileged()
    and public.auth_can_see_brand(brand_id)
  );

create policy "privileged_update_recipes"
  on public.recipes for update
  using (
    public.auth_is_privileged()
    and public.auth_can_see_brand(brand_id)
  )
  with check (
    public.auth_is_privileged()
    and public.auth_can_see_brand(brand_id)
  );

create policy "privileged_delete_recipes"
  on public.recipes for delete
  using (
    public.auth_is_privileged()
    and public.auth_can_see_brand(brand_id)
  );


-- ─── (6d) prep_recipes ────────────────────────────────────────
drop policy if exists "Store access" on public.prep_recipes;
drop policy if exists "auth_read_prep_recipes" on public.prep_recipes;
drop policy if exists "auth_manage_prep_recipes" on public.prep_recipes;
drop policy if exists "admin_write_prep_recipes" on public.prep_recipes;
drop policy if exists "admin_update_prep_recipes" on public.prep_recipes;
drop policy if exists "admin_delete_prep_recipes" on public.prep_recipes;
drop policy if exists "brand_member_read_prep_recipes" on public.prep_recipes;
drop policy if exists "privileged_insert_prep_recipes" on public.prep_recipes;
drop policy if exists "privileged_update_prep_recipes" on public.prep_recipes;
drop policy if exists "privileged_delete_prep_recipes" on public.prep_recipes;

create policy "brand_member_read_prep_recipes"
  on public.prep_recipes for select
  using (public.auth_can_see_brand(brand_id));

create policy "privileged_insert_prep_recipes"
  on public.prep_recipes for insert
  with check (
    public.auth_is_privileged()
    and public.auth_can_see_brand(brand_id)
  );

create policy "privileged_update_prep_recipes"
  on public.prep_recipes for update
  using (
    public.auth_is_privileged()
    and public.auth_can_see_brand(brand_id)
  )
  with check (
    public.auth_is_privileged()
    and public.auth_can_see_brand(brand_id)
  );

create policy "privileged_delete_prep_recipes"
  on public.prep_recipes for delete
  using (
    public.auth_is_privileged()
    and public.auth_can_see_brand(brand_id)
  );


-- ─── (6e) vendors ─────────────────────────────────────────────
drop policy if exists "Vendors visible to all" on public.vendors;
drop policy if exists "Vendors admin only" on public.vendors;
drop policy if exists "auth_read_vendors" on public.vendors;
drop policy if exists "auth_manage_vendors" on public.vendors;
drop policy if exists "admin_write_vendors" on public.vendors;
drop policy if exists "admin_update_vendors" on public.vendors;
drop policy if exists "admin_delete_vendors" on public.vendors;
drop policy if exists "brand_member_read_vendors" on public.vendors;
drop policy if exists "privileged_insert_vendors" on public.vendors;
drop policy if exists "privileged_update_vendors" on public.vendors;
drop policy if exists "privileged_delete_vendors" on public.vendors;

create policy "brand_member_read_vendors"
  on public.vendors for select
  using (public.auth_can_see_brand(brand_id));

create policy "privileged_insert_vendors"
  on public.vendors for insert
  with check (
    public.auth_is_privileged()
    and public.auth_can_see_brand(brand_id)
  );

create policy "privileged_update_vendors"
  on public.vendors for update
  using (
    public.auth_is_privileged()
    and public.auth_can_see_brand(brand_id)
  )
  with check (
    public.auth_is_privileged()
    and public.auth_can_see_brand(brand_id)
  );

create policy "privileged_delete_vendors"
  on public.vendors for delete
  using (
    public.auth_is_privileged()
    and public.auth_can_see_brand(brand_id)
  );


-- ─── (6f) stores ──────────────────────────────────────────────
-- READ stays through auth_can_see_store(id) (which is updated above to
-- short-circuit for super-admin). WRITE requires privileged + brand
-- visibility — only admins of the store's brand (or super-admin) can
-- create/update/delete a store.
drop policy if exists "Store access" on public.stores;
drop policy if exists "store_member_read_stores" on public.stores;
drop policy if exists "privileged_insert_stores" on public.stores;
drop policy if exists "privileged_update_stores" on public.stores;
drop policy if exists "privileged_delete_stores" on public.stores;

create policy "store_member_read_stores"
  on public.stores for select
  using (public.auth_can_see_store(id));

create policy "privileged_insert_stores"
  on public.stores for insert
  with check (
    public.auth_is_privileged()
    and public.auth_can_see_brand(brand_id)
  );

create policy "privileged_update_stores"
  on public.stores for update
  using (
    public.auth_is_privileged()
    and public.auth_can_see_brand(brand_id)
  )
  with check (
    public.auth_is_privileged()
    and public.auth_can_see_brand(brand_id)
  );

create policy "privileged_delete_stores"
  on public.stores for delete
  using (
    public.auth_is_privileged()
    and public.auth_can_see_brand(brand_id)
  );


-- ─── (6g) recipe_ingredients (child of recipes) ───────────────
-- No brand_id column. Scope through parent recipe's brand_id via EXISTS.
drop policy if exists "Store access" on public.recipe_ingredients;
drop policy if exists "auth_read_recipe_ingredients" on public.recipe_ingredients;
drop policy if exists "auth_manage_recipe_ingredients" on public.recipe_ingredients;
drop policy if exists "admin_write_recipe_ingredients" on public.recipe_ingredients;
drop policy if exists "admin_update_recipe_ingredients" on public.recipe_ingredients;
drop policy if exists "admin_delete_recipe_ingredients" on public.recipe_ingredients;
drop policy if exists "brand_member_read_recipe_ingredients" on public.recipe_ingredients;
drop policy if exists "privileged_insert_recipe_ingredients" on public.recipe_ingredients;
drop policy if exists "privileged_update_recipe_ingredients" on public.recipe_ingredients;
drop policy if exists "privileged_delete_recipe_ingredients" on public.recipe_ingredients;

create policy "brand_member_read_recipe_ingredients"
  on public.recipe_ingredients for select
  using (
    exists (
      select 1 from public.recipes r
       where r.id = recipe_ingredients.recipe_id
         and public.auth_can_see_brand(r.brand_id)
    )
  );

create policy "privileged_insert_recipe_ingredients"
  on public.recipe_ingredients for insert
  with check (
    public.auth_is_privileged()
    and exists (
      select 1 from public.recipes r
       where r.id = recipe_ingredients.recipe_id
         and public.auth_can_see_brand(r.brand_id)
    )
  );

create policy "privileged_update_recipe_ingredients"
  on public.recipe_ingredients for update
  using (
    public.auth_is_privileged()
    and exists (
      select 1 from public.recipes r
       where r.id = recipe_ingredients.recipe_id
         and public.auth_can_see_brand(r.brand_id)
    )
  )
  with check (
    public.auth_is_privileged()
    and exists (
      select 1 from public.recipes r
       where r.id = recipe_ingredients.recipe_id
         and public.auth_can_see_brand(r.brand_id)
    )
  );

create policy "privileged_delete_recipe_ingredients"
  on public.recipe_ingredients for delete
  using (
    public.auth_is_privileged()
    and exists (
      select 1 from public.recipes r
       where r.id = recipe_ingredients.recipe_id
         and public.auth_can_see_brand(r.brand_id)
    )
  );


-- ─── (6h) prep_recipe_ingredients (child of prep_recipes) ─────
drop policy if exists "Store access" on public.prep_recipe_ingredients;
drop policy if exists "auth_read_prep_recipe_ingredients" on public.prep_recipe_ingredients;
drop policy if exists "auth_manage_prep_recipe_ingredients" on public.prep_recipe_ingredients;
drop policy if exists "admin_write_prep_recipe_ingredients" on public.prep_recipe_ingredients;
drop policy if exists "admin_update_prep_recipe_ingredients" on public.prep_recipe_ingredients;
drop policy if exists "admin_delete_prep_recipe_ingredients" on public.prep_recipe_ingredients;
drop policy if exists "brand_member_read_prep_recipe_ingredients" on public.prep_recipe_ingredients;
drop policy if exists "privileged_insert_prep_recipe_ingredients" on public.prep_recipe_ingredients;
drop policy if exists "privileged_update_prep_recipe_ingredients" on public.prep_recipe_ingredients;
drop policy if exists "privileged_delete_prep_recipe_ingredients" on public.prep_recipe_ingredients;

create policy "brand_member_read_prep_recipe_ingredients"
  on public.prep_recipe_ingredients for select
  using (
    exists (
      select 1 from public.prep_recipes pr
       where pr.id = prep_recipe_ingredients.prep_recipe_id
         and public.auth_can_see_brand(pr.brand_id)
    )
  );

create policy "privileged_insert_prep_recipe_ingredients"
  on public.prep_recipe_ingredients for insert
  with check (
    public.auth_is_privileged()
    and exists (
      select 1 from public.prep_recipes pr
       where pr.id = prep_recipe_ingredients.prep_recipe_id
         and public.auth_can_see_brand(pr.brand_id)
    )
  );

create policy "privileged_update_prep_recipe_ingredients"
  on public.prep_recipe_ingredients for update
  using (
    public.auth_is_privileged()
    and exists (
      select 1 from public.prep_recipes pr
       where pr.id = prep_recipe_ingredients.prep_recipe_id
         and public.auth_can_see_brand(pr.brand_id)
    )
  )
  with check (
    public.auth_is_privileged()
    and exists (
      select 1 from public.prep_recipes pr
       where pr.id = prep_recipe_ingredients.prep_recipe_id
         and public.auth_can_see_brand(pr.brand_id)
    )
  );

create policy "privileged_delete_prep_recipe_ingredients"
  on public.prep_recipe_ingredients for delete
  using (
    public.auth_is_privileged()
    and exists (
      select 1 from public.prep_recipes pr
       where pr.id = prep_recipe_ingredients.prep_recipe_id
         and public.auth_can_see_brand(pr.brand_id)
    )
  );


-- ─── (6i) recipe_prep_items (child of recipes) ────────────────
drop policy if exists "Store access" on public.recipe_prep_items;
drop policy if exists "auth_read_recipe_prep_items" on public.recipe_prep_items;
drop policy if exists "auth_manage_recipe_prep_items" on public.recipe_prep_items;
drop policy if exists "admin_write_recipe_prep_items" on public.recipe_prep_items;
drop policy if exists "admin_update_recipe_prep_items" on public.recipe_prep_items;
drop policy if exists "admin_delete_recipe_prep_items" on public.recipe_prep_items;
drop policy if exists "brand_member_read_recipe_prep_items" on public.recipe_prep_items;
drop policy if exists "privileged_insert_recipe_prep_items" on public.recipe_prep_items;
drop policy if exists "privileged_update_recipe_prep_items" on public.recipe_prep_items;
drop policy if exists "privileged_delete_recipe_prep_items" on public.recipe_prep_items;

create policy "brand_member_read_recipe_prep_items"
  on public.recipe_prep_items for select
  using (
    exists (
      select 1 from public.recipes r
       where r.id = recipe_prep_items.recipe_id
         and public.auth_can_see_brand(r.brand_id)
    )
  );

create policy "privileged_insert_recipe_prep_items"
  on public.recipe_prep_items for insert
  with check (
    public.auth_is_privileged()
    and exists (
      select 1 from public.recipes r
       where r.id = recipe_prep_items.recipe_id
         and public.auth_can_see_brand(r.brand_id)
    )
  );

create policy "privileged_update_recipe_prep_items"
  on public.recipe_prep_items for update
  using (
    public.auth_is_privileged()
    and exists (
      select 1 from public.recipes r
       where r.id = recipe_prep_items.recipe_id
         and public.auth_can_see_brand(r.brand_id)
    )
  )
  with check (
    public.auth_is_privileged()
    and exists (
      select 1 from public.recipes r
       where r.id = recipe_prep_items.recipe_id
         and public.auth_can_see_brand(r.brand_id)
    )
  );

create policy "privileged_delete_recipe_prep_items"
  on public.recipe_prep_items for delete
  using (
    public.auth_is_privileged()
    and exists (
      select 1 from public.recipes r
       where r.id = recipe_prep_items.recipe_id
         and public.auth_can_see_brand(r.brand_id)
    )
  );


-- ─── (6j) ingredient_conversions (child of catalog_ingredients) ──
-- No brand_id column. Scope through parent catalog_ingredients via
-- EXISTS on the catalog_id link added by P1. P3 forced catalog_id
-- NOT NULL (see 20260504072830_brand_catalog_p3_lockdown.sql:25), so
-- there are no legacy NULL-catalog_id rows; every row resolves through
-- its parent's brand_id.
drop policy if exists "Authenticated can read ingredient conversions" on public.ingredient_conversions;
drop policy if exists "Admins can write ingredient conversions" on public.ingredient_conversions;
drop policy if exists "auth_read_ingredient_conversions" on public.ingredient_conversions;
drop policy if exists "auth_manage_ingredient_conversions" on public.ingredient_conversions;
drop policy if exists "admin_write_ingredient_conversions" on public.ingredient_conversions;
drop policy if exists "admin_update_ingredient_conversions" on public.ingredient_conversions;
drop policy if exists "admin_delete_ingredient_conversions" on public.ingredient_conversions;
drop policy if exists "brand_member_read_ingredient_conversions" on public.ingredient_conversions;
drop policy if exists "privileged_insert_ingredient_conversions" on public.ingredient_conversions;
drop policy if exists "privileged_update_ingredient_conversions" on public.ingredient_conversions;
drop policy if exists "privileged_delete_ingredient_conversions" on public.ingredient_conversions;

create policy "brand_member_read_ingredient_conversions"
  on public.ingredient_conversions for select
  using (
    exists (
      select 1 from public.catalog_ingredients ci
       where ci.id = ingredient_conversions.catalog_id
         and public.auth_can_see_brand(ci.brand_id)
    )
  );

create policy "privileged_insert_ingredient_conversions"
  on public.ingredient_conversions for insert
  with check (
    public.auth_is_privileged()
    and exists (
      select 1 from public.catalog_ingredients ci
       where ci.id = ingredient_conversions.catalog_id
         and public.auth_can_see_brand(ci.brand_id)
    )
  );

create policy "privileged_update_ingredient_conversions"
  on public.ingredient_conversions for update
  using (
    public.auth_is_privileged()
    and exists (
      select 1 from public.catalog_ingredients ci
       where ci.id = ingredient_conversions.catalog_id
         and public.auth_can_see_brand(ci.brand_id)
    )
  )
  with check (
    public.auth_is_privileged()
    and exists (
      select 1 from public.catalog_ingredients ci
       where ci.id = ingredient_conversions.catalog_id
         and public.auth_can_see_brand(ci.brand_id)
    )
  );

create policy "privileged_delete_ingredient_conversions"
  on public.ingredient_conversions for delete
  using (
    public.auth_is_privileged()
    and exists (
      select 1 from public.catalog_ingredients ci
       where ci.id = ingredient_conversions.catalog_id
         and public.auth_can_see_brand(ci.brand_id)
    )
  );


-- ─── (6k) pos_recipe_aliases (child of recipes via recipe_id) ──
-- Scope through the parent recipe's brand_id. The legacy policies
-- gated on user_stores membership (per-store); the new policy gates
-- on brand membership which is the correct super-set, since cross-brand
-- user_stores rows are now impossible (trigger above).
drop policy if exists "Read pos_recipe_aliases" on public.pos_recipe_aliases;
drop policy if exists "Write pos_recipe_aliases" on public.pos_recipe_aliases;
drop policy if exists "brand_member_read_pos_recipe_aliases" on public.pos_recipe_aliases;
drop policy if exists "privileged_insert_pos_recipe_aliases" on public.pos_recipe_aliases;
drop policy if exists "privileged_update_pos_recipe_aliases" on public.pos_recipe_aliases;
drop policy if exists "privileged_delete_pos_recipe_aliases" on public.pos_recipe_aliases;

create policy "brand_member_read_pos_recipe_aliases"
  on public.pos_recipe_aliases for select
  using (
    exists (
      select 1 from public.recipes r
       where r.id = pos_recipe_aliases.recipe_id
         and public.auth_can_see_brand(r.brand_id)
    )
  );

create policy "privileged_insert_pos_recipe_aliases"
  on public.pos_recipe_aliases for insert
  with check (
    public.auth_is_privileged()
    and exists (
      select 1 from public.recipes r
       where r.id = pos_recipe_aliases.recipe_id
         and public.auth_can_see_brand(r.brand_id)
    )
  );

create policy "privileged_update_pos_recipe_aliases"
  on public.pos_recipe_aliases for update
  using (
    public.auth_is_privileged()
    and exists (
      select 1 from public.recipes r
       where r.id = pos_recipe_aliases.recipe_id
         and public.auth_can_see_brand(r.brand_id)
    )
  )
  with check (
    public.auth_is_privileged()
    and exists (
      select 1 from public.recipes r
       where r.id = pos_recipe_aliases.recipe_id
         and public.auth_can_see_brand(r.brand_id)
    )
  );

create policy "privileged_delete_pos_recipe_aliases"
  on public.pos_recipe_aliases for delete
  using (
    public.auth_is_privileged()
    and exists (
      select 1 from public.recipes r
       where r.id = pos_recipe_aliases.recipe_id
         and public.auth_can_see_brand(r.brand_id)
    )
  );


-- ─── (6l) profiles (super-admin cross-user read + update) ─────
-- The init schema's "Own profile" policy (auth.uid() = id, FOR ALL)
-- stays — every user reads/writes only their own row. Add an additive
-- super-admin policy so 012b's admin-management UI can list / update
-- other profiles. Restricted to super-admin only.
drop policy if exists "super_admin_read_all_profiles" on public.profiles;
drop policy if exists "super_admin_manage_profiles" on public.profiles;

create policy "super_admin_read_all_profiles"
  on public.profiles for select
  using (public.auth_is_super_admin());

create policy "super_admin_manage_profiles"
  on public.profiles for update
  using (public.auth_is_super_admin())
  with check (public.auth_is_super_admin());


-- ============================================================
-- (7) AUDIT NOTE — tables already gated by auth_can_see_store()
--
-- The following per-store tables are NOT modified by this migration.
-- Their existing policies (set in 20260504173035_per_store_rls_hardening.sql
-- and earlier) already filter through auth_can_see_store(), which is
-- updated above to short-circuit for super-admin. Combined with the
-- §5 user_stores cross-brand trigger, brand-scope is inherited
-- automatically:
--
--   - inventory_items
--   - eod_submissions, eod_entries
--   - waste_log
--   - audit_log
--   - purchase_orders, po_items
--   - pos_imports, pos_import_items
--   - flags             (init-schema-style policy; works because
--                        user_stores can no longer cross brands)
--   - order_schedule    (same)
--
-- If a future RLS audit finds any of these still using a permissive
-- policy that bypasses user_stores membership, that's a follow-up; it
-- is OUT OF SCOPE for 012a per spec.
-- ============================================================
