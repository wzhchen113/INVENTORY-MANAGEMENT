-- ============================================================
-- Spec 198 ROLLBACK - emergency use only. NOT a migration (lives outside
-- supabase/migrations/, so the CLI never applies it).
--
-- Reverts supabase/migrations/20261110120000_invitations_hardening.sql:
--   1. drops create_invitation, check_invitation_code, register_invited_profile(text)
--   2. recreates register_invited_profile() verbatim from
--      20261007000000_profiles_insert_hardening.sql:133-262 (incl. revoke/grant)
--   3. recreates get_pending_invitation(text) verbatim from
--      20260607120000_profiles_username.sql:111-160 (grant to anon, authenticated)
--   4. drops the invitations_provenance_guard trigger and its function
--   5. recreates INSERT/UPDATE verbatim from 20261109191000 (with 191's
--      comments) and SELECT/DELETE verbatim from 20260514150000:33-35, 46-48
--   6. re-grants consume_invitation(uuid,text) to authenticated
--   7. KEEPS the anon/PUBLIC revoke on assert_not_last_of_role (prod's prior state)
--   8. KEEPS invited_by / code_hash, invitations_code_hash_key and
--      invitations_code_hash_format (inert; dropping them loses provenance)
--   9. fail-closed DO block: 1/1/1/1 permissive policies
--
-- RE-OPENS 195-H1 (cross-brand invitation read/delete), 164-M1 (invitation
-- squatting + the anon get_pending_invitation oracle), 191-M1 (planted
-- never-expiring admin invitations) and the spec 198 review H1 (any in-scope
-- admin can UPDATE a consumed invitation back to used = false: 191's UPDATE
-- policy, restored verbatim below, is neither super_admin-only nor limited to
-- unused rows). Leave the schema_migrations row in
-- place. Revert the frontend and send-invite-email in the same window: the
-- new client calls create_invitation / check_invitation_code /
-- register_invited_profile(p_code), all dropped here.
--
-- Dry-run first: run locally with the final commit; swapped for rollback;.
-- Prod: MCP execute_sql, then notify pgrst, 'reload schema';
-- ============================================================

begin;

set local lock_timeout = '5s';

-- 1
drop function if exists public.create_invitation(text, text, text, text[], uuid, text);
drop function if exists public.check_invitation_code(text, text);
drop function if exists public.register_invited_profile(text);

-- 2 (verbatim, 20261007000000:133-262)
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

-- 3 (verbatim, 20260607120000:111-160)
create function public.get_pending_invitation(p_email text)
returns table (
  id uuid,
  email text,
  name text,
  role text,
  store_ids text[],
  brand_id uuid,
  resolved_brand_id uuid,
  username text,
  expires_at timestamptz
)
language sql
security definer
set search_path = public
as $$
  select
    i.id,
    i.email,
    i.name,
    i.role,
    i.store_ids,
    i.brand_id,
    coalesce(
      i.brand_id,
      (
        select s.brand_id
          from public.stores s
         where i.store_ids is not null
           and array_length(i.store_ids, 1) >= 1
           and s.id = (i.store_ids[1])::uuid
      )
    ) as resolved_brand_id,
    i.username,
    i.expires_at
    from public.invitations i
   where i.email = lower(p_email)
     and i.used = false
     and (i.expires_at is null or i.expires_at > now())
   limit 1;
$$;

comment on function public.get_pending_invitation(text) is
  'Spec 069 + 095 — returns the pending invitation for an email, including
   resolved_brand_id (COALESCE(brand_id, brand of store_ids[1]) — spec 069) and
   username (the admin-assigned username threaded through to registerInvitedUser
   — spec 095). SECURITY DEFINER so the stores lookup bypasses RLS at register
   time (the new user has no user_stores rows yet).';

grant execute on function public.get_pending_invitation(text) to anon, authenticated;

-- 4
drop trigger if exists invitations_provenance_guard on public.invitations;
drop function if exists public.assert_invitation_provenance();

-- 5a SELECT / DELETE (verbatim, 20260514150000:33-35, 46-48)
drop policy if exists "Admins can read invitations"   on public.invitations;
drop policy if exists "Admins can delete invitations" on public.invitations;

create policy "Admins can read invitations"
  on public.invitations for select
  using (public.auth_is_privileged());

create policy "Admins can delete invitations"
  on public.invitations for delete
  using (public.auth_is_privileged());

-- 5b INSERT / UPDATE (verbatim, 20261109191000:504-560)
drop policy if exists "Admins can insert invitations" on public.invitations;
create policy "Admins can insert invitations"
  on public.invitations
  for insert
  to authenticated
  with check (
    public.auth_profile_is_privileged()
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

comment on policy "Admins can insert invitations" on public.invitations is
  'spec 191 / 164-M2: privileged check deliberately reads profiles.role via '
  'auth_profile_is_privileged(), not the JWT claim (stale up to jwt_expiry '
  'after demotion). Rest of predicate unchanged from spec 164.';

drop policy if exists "Admins can update invitations" on public.invitations;
create policy "Admins can update invitations"
  on public.invitations
  for update
  to authenticated
  using (
    public.auth_profile_is_privileged()
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
    public.auth_profile_is_privileged()
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

comment on policy "Admins can update invitations" on public.invitations is
  'spec 191 / 164-M2: privileged check deliberately reads profiles.role via '
  'auth_profile_is_privileged(), not the JWT claim (stale up to jwt_expiry '
  'after demotion). Rest of predicate unchanged from spec 164.';

-- 6
grant execute on function public.consume_invitation(uuid, text) to authenticated;

-- 7 / 8: intentionally nothing.

-- 9
do $$
declare
  v_cmd   text;
  v_count int;
begin
  foreach v_cmd in array array['SELECT', 'INSERT', 'UPDATE', 'DELETE'] loop
    select count(*) into v_count
      from pg_policies
     where schemaname = 'public'
       and tablename  = 'invitations'
       and permissive = 'PERMISSIVE'
       and cmd in (v_cmd, 'ALL');
    if v_count <> 1 then
      raise exception '198 rollback: expected exactly one permissive %/ALL policy on public.invitations, found %', v_cmd, v_count;
    end if;
  end loop;
  if to_regprocedure('public.register_invited_profile()') is null
     or to_regprocedure('public.get_pending_invitation(text)') is null then
    raise exception '198 rollback: legacy functions were not restored';
  end if;
end $$;

commit;
