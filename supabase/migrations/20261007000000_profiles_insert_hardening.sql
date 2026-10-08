-- ============================================================
-- Spec 164 - close the public.profiles INSERT privilege-escalation hole.
--
-- Before this migration the profiles INSERT policy
-- "Anyone can insert own profile or admin can insert any" ended in an
-- `OR (auth.uid() IS NOT NULL)` tail, so ANY authenticated caller (including
-- a fresh anon-key signUp) could insert a profiles row with any id, role and
-- brand_id. The AFTER INSERT trigger profiles_sync_role_to_jwt then copied
-- that role into auth.users.raw_app_meta_data, minting an admin/master claim.
--
-- This migration, in one transaction:
--   1. Replaces the profiles INSERT policy with a single privileged,
--      brand-scoped policy (no self-arm, no wide tail) and asserts that no
--      other permissive INSERT/ALL policy remains on profiles.
--   2. Adds a BEFORE INSERT guard trigger (SECURITY INVOKER) that refuses
--      non-'user' role inserts from authenticated/anon callers unless the
--      caller is super_admin.
--   3. Adds public.register_invited_profile(), a SECURITY DEFINER RPC that
--      completes invited-user registration for the CALLING user, deriving
--      role / brand / username / stores from the pending invitation row.
--      The client (src/lib/auth.ts registerInvitedUser) no longer inserts
--      profiles or user_stores and no longer calls consume_invitation.
--   4. Tightens the invitations INSERT/UPDATE policies: the invitation is
--      now the trust anchor for registration, so a caller may only write an
--      invitation it could legitimately grant (role user/admin, brand and
--      every store in the caller's scope), and asserts that exactly one
--      permissive INSERT/ALL and one UPDATE/ALL policy remain on invitations.
--
-- ENCODING: this file is pure ASCII on purpose. The prod normalized-md5
-- check hashes pg_get_functiondef(); non-ASCII bytes inside function bodies
-- risk false mismatches over MCP (spec 163 M1 lesson).
--
-- REALTIME: no supabase_realtime publication change. No realtime container
-- restart is needed.
--
-- PROD-APPLY (spec 064 gate, project MEMORY): execute_sql this body via the
-- Supabase MCP, INSERT the exact version '20261007000000' into
-- supabase_migrations.schema_migrations, then VERIFY both new functions by
-- NORMALIZED-MD5, compare pg_policies text for profiles INSERT and
-- invitations INSERT/UPDATE against local, and confirm
-- has_function_privilege('anon', 'public.register_invited_profile()',
-- 'EXECUTE') = false. Must be applied to prod BEFORE spec 163's
-- 20261008000000_get_profile_emails.sql.
--
-- Design authority: specs/164-profiles-insert-hardening.md "## Backend design".
-- ============================================================

begin;

-- ------------------------------------------------------------
-- 1. profiles INSERT policy swap (design 1.1)
-- ------------------------------------------------------------
drop policy if exists "Anyone can insert own profile or admin can insert any" on public.profiles;
drop policy if exists "Admins can insert profiles in own brand" on public.profiles;  -- idempotency

create policy "Admins can insert profiles in own brand"
  on public.profiles
  as permissive
  for insert
  to authenticated
  with check (public.auth_is_privileged() and public.auth_can_see_brand(brand_id));

comment on policy "Admins can insert profiles in own brand" on public.profiles is
  'spec 164: privileged + brand-scoped only; no self-arm. Non-super_admin '
  'callers are further limited to role=user by profiles_insert_role_guard. '
  'Registration goes through register_invited_profile().';

-- Fail-closed: any other permissive INSERT/ALL policy (e.g. prod dashboard
-- drift) would OR the hole back open. Abort the apply if one exists.
do $$
declare
  v_count int;
begin
  select count(*) into v_count
    from pg_policies
   where schemaname = 'public'
     and tablename  = 'profiles'
     and permissive = 'PERMISSIVE'
     and cmd in ('INSERT', 'ALL');
  if v_count <> 1 then
    raise exception '164: expected exactly one permissive INSERT/ALL policy on public.profiles, found %', v_count;
  end if;
end $$;


-- ------------------------------------------------------------
-- 2. BEFORE INSERT role guard (design 1.2)
--
-- SECURITY INVOKER is load-bearing (spec 042 round-4 lesson): current_user
-- must reflect the real caller. It fires for authenticated/anon and skips
-- postgres (migrations, seed, pgTAP fixtures), service_role, and the
-- SECURITY DEFINER register_invited_profile() RPC (current_user = owner).
-- BEFORE ROW triggers run before RLS WITH CHECK, so for a non-'user' role
-- this P0001 is what a refused caller sees (spec 164 D6).
-- ------------------------------------------------------------
create or replace function public.assert_profile_insert_role_allowed()
returns trigger
language plpgsql
security invoker
set search_path = public, auth
as $$
begin
  if current_user in ('authenticated', 'anon')
     and new.role is distinct from 'user'
     and not public.auth_is_super_admin() then
    raise exception 'non-user role inserts require super_admin';
  end if;
  return new;
end
$$;

comment on function public.assert_profile_insert_role_allowed() is
  'spec 164: BEFORE INSERT guard on public.profiles. Refuses non-user role '
  'inserts by authenticated/anon callers that are not super_admin '
  '(P0001 ''non-user role inserts require super_admin''). SECURITY INVOKER '
  'so current_user is the real caller; skips postgres, service_role and '
  'SECURITY DEFINER functions owned by postgres.';

drop trigger if exists profiles_insert_role_guard on public.profiles;
create trigger profiles_insert_role_guard
  before insert on public.profiles
  for each row execute function public.assert_profile_insert_role_allowed();


-- ------------------------------------------------------------
-- 3. Server-side invited-user registration RPC (design 1.3 / 3)
--
-- Returns uuid (not a TABLE): plpgsql OUT-param names like role / brand_id
-- would shadow columns. Owner MUST be postgres (table owner of profiles,
-- user_stores, invitations) so the body bypasses RLS; otherwise the new
-- profiles INSERT policy above would refuse the registering caller.
-- ------------------------------------------------------------
create or replace function public.register_invited_profile()
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid      uuid := auth.uid();
  v_email    text;
  v_count    int;
  v_inv      public.invitations%rowtype;
  v_brand    uuid;
  v_initials text;
begin
  -- R1
  if v_uid is null then
    raise exception 'not authenticated';
  end if;

  -- R2 (checked before the invitation lookup so a repeat call reports this,
  -- even though its invitation is now used)
  if exists (select 1 from public.profiles p where p.id = v_uid) then
    raise exception 'profile already exists';
  end if;

  -- Identity binding: the caller's auth.users email (design D7).
  select lower(u.email) into v_email from auth.users u where u.id = v_uid;
  if coalesce(v_email, '') = '' then
    raise exception 'no pending invitation';
  end if;

  -- Pending set: same predicates as get_pending_invitation /
  -- consume_invitation, with the stored email lowercased too.
  select count(*) into v_count
    from public.invitations i
   where lower(i.email) = v_email
     and i.used = false
     and (i.expires_at is null or i.expires_at > now());

  -- R3 / R4
  if v_count = 0 then
    raise exception 'no pending invitation';
  end if;
  if v_count > 1 then
    raise exception 'multiple pending invitations';
  end if;

  select i.* into v_inv
    from public.invitations i
   where lower(i.email) = v_email
     and i.used = false
     and (i.expires_at is null or i.expires_at > now())
     for update;
  if not found then
    -- lost a race with a concurrent registration
    raise exception 'no pending invitation';
  end if;

  -- R5
  if v_inv.role is null or v_inv.role not in ('user', 'admin') then
    raise exception 'invitation role not allowed';
  end if;

  -- R6
  if v_inv.role = 'admin' and v_inv.brand_id is null then
    raise exception 'admin invitation requires a brand';
  end if;

  -- Brand: spec 069 resolved_brand_id rule for staff; invitation brand for admin.
  if v_inv.role = 'user' then
    v_brand := coalesce(
      v_inv.brand_id,
      (
        select s.brand_id
          from public.stores s
         where v_inv.store_ids is not null
           and array_length(v_inv.store_ids, 1) >= 1
           and s.id = (v_inv.store_ids[1])::uuid
      )
    );
  else
    v_brand := v_inv.brand_id;
  end if;

  -- Initials: mirrors the former client rule
  -- name.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase()
  v_initials := upper(left(coalesce(
    (
      select string_agg(left(t.w, 1), '' order by t.ord)
        from unnest(string_to_array(v_inv.name, ' ')) with ordinality as t(w, ord)
    ),
    ''
  ), 2));

  -- Guard trigger skips here (current_user = owner postgres);
  -- profiles_sync_role_to_jwt writes raw_app_meta_data.role.
  insert into public.profiles (id, name, role, brand_id, username, status, color, initials)
  values (v_uid, v_inv.name, v_inv.role, v_brand, v_inv.username, 'active', '#378ADD', v_initials);

  -- user_stores_brand_match_trg still enforces the brand on every row.
  insert into public.user_stores (user_id, store_id)
  select distinct v_uid, sid::uuid
    from unnest(coalesce(v_inv.store_ids, '{}'::text[])) as sid
   where sid is not null;

  update public.invitations
     set used = true,
         profile_id = v_uid
   where id = v_inv.id;

  return v_uid;
end
$$;

comment on function public.register_invited_profile() is
  'spec 164: completes invited-user registration for the CALLING user '
  '(auth.uid()). Takes no parameters; role, brand, username and stores are '
  'derived from the single pending invitation matching the caller''s '
  'auth.users email (case-insensitive). Atomically inserts profiles + '
  'user_stores and marks the invitation used. Refuses (P0001) with: '
  'not authenticated | profile already exists | no pending invitation | '
  'multiple pending invitations | invitation role not allowed | '
  'admin invitation requires a brand. Owner must be postgres.';

-- REVOKE FROM `public` IS LOAD-BEARING: CREATE FUNCTION grants EXECUTE to
-- PUBLIC, and spec 097's ALTER DEFAULT PRIVILEGES gives anon an explicit
-- grant on new public functions, so both must be revoked. service_role keeps
-- its default grant; harmless (no auth.uid() -> 'not authenticated').
revoke all     on function public.register_invited_profile() from public, anon;
grant  execute on function public.register_invited_profile() to authenticated;


-- ------------------------------------------------------------
-- 4. invitations INSERT / UPDATE policies (design 1.4)
--
-- Shared predicate P_INV. Columns are qualified with `invitations.` because
-- the subquery joins stores; an unqualified brand_id there would bind to
-- stores.brand_id. Store ids are compared as text so a malformed id fails
-- closed (42501) instead of throwing 22P02 from inside the policy. A NULL
-- element, an unknown store id, or a store hidden by stores RLS all
-- left-join to NULL and are refused.
-- SELECT and DELETE policies are intentionally untouched.
-- ------------------------------------------------------------
drop policy if exists "Admins can insert invitations" on public.invitations;
create policy "Admins can insert invitations"
  on public.invitations
  for insert
  to authenticated
  with check (
    public.auth_is_privileged()
    and invitations.role in ('user', 'admin')
    and (invitations.brand_id is null or public.auth_can_see_brand(invitations.brand_id))
    and not exists (
      select 1
        from unnest(coalesce(invitations.store_ids, '{}'::text[])) as sid(store_id)
        left join public.stores s on s.id::text = lower(sid.store_id)
       where s.id is null
          or not public.auth_can_see_brand(s.brand_id)
    )
  );

drop policy if exists "Admins can update invitations" on public.invitations;
create policy "Admins can update invitations"
  on public.invitations
  for update
  to authenticated
  using (
    public.auth_is_privileged()
    and invitations.role in ('user', 'admin')
    and (invitations.brand_id is null or public.auth_can_see_brand(invitations.brand_id))
    and not exists (
      select 1
        from unnest(coalesce(invitations.store_ids, '{}'::text[])) as sid(store_id)
        left join public.stores s on s.id::text = lower(sid.store_id)
       where s.id is null
          or not public.auth_can_see_brand(s.brand_id)
    )
  )
  with check (
    public.auth_is_privileged()
    and invitations.role in ('user', 'admin')
    and (invitations.brand_id is null or public.auth_can_see_brand(invitations.brand_id))
    and not exists (
      select 1
        from unnest(coalesce(invitations.store_ids, '{}'::text[])) as sid(store_id)
        left join public.stores s on s.id::text = lower(sid.store_id)
       where s.id is null
          or not public.auth_can_see_brand(s.brand_id)
    )
  );

-- Fail-closed (spec 164 architect S1): the invitation row is now the trust
-- anchor for register_invited_profile(). Any other permissive INSERT/UPDATE/
-- ALL policy on invitations (e.g. prod dashboard drift) would OR P_INV back
-- open and let any signed-up caller write its own admin invitation. Abort
-- the apply if either write command is not covered by exactly one policy.
do $$
declare
  v_insert int;
  v_update int;
begin
  select count(*) into v_insert
    from pg_policies
   where schemaname = 'public'
     and tablename  = 'invitations'
     and permissive = 'PERMISSIVE'
     and cmd in ('INSERT', 'ALL');
  if v_insert <> 1 then
    raise exception '164: expected exactly one permissive INSERT/ALL policy on public.invitations, found %', v_insert;
  end if;

  select count(*) into v_update
    from pg_policies
   where schemaname = 'public'
     and tablename  = 'invitations'
     and permissive = 'PERMISSIVE'
     and cmd in ('UPDATE', 'ALL');
  if v_update <> 1 then
    raise exception '164: expected exactly one permissive UPDATE/ALL policy on public.invitations, found %', v_update;
  end if;
end $$;

commit;
