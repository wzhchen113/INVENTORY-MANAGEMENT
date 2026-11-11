-- ============================================================
-- Spec 198 - invitations hardening: brand-scoped SELECT/DELETE, a claim needs
-- a one-time invite code, bounded expiry, provenance (invited_by) and a
-- claim-time inviter re-check. Closes 195-H1 (a)(b)(c), 164-M1 (squatting and
-- the anon get_pending_invitation oracle), 191-M1 (a)(b) and 191-L3.
--
-- Design authority: specs/198-invitations-hardening.md "## Backend design".
-- Depends on spec 191 (20261109191000): auth_profile_is_privileged() and the
-- P_INV text copied below. The prerequisite DO block aborts if 191 is absent.
--
-- This migration, in one transaction:
--   0. lock_timeout 5s
--   1. prerequisite DO block (spec 191 present; authenticated can call
--      extensions.gen_random_bytes, which the INVOKER create_invitation needs)
--   2. columns invited_by uuid and code_hash text (additive, nullable, no
--      default, no FK on invited_by), check invitations_code_hash_format,
--      partial unique index invitations_code_hash_key
--   3. trigger function public.assert_invitation_provenance() (SECURITY
--      INVOKER) + BEFORE INSERT OR UPDATE trigger invitations_provenance_guard;
--      EXECUTE revoked from public, anon, authenticated (review L2, hygiene)
--   4. clamp (D-4): pending rows with NULL expiry or expiry > now()+7d are set
--      to now()+48h (runs as postgres; the trigger skips it)
--   5. all four invitations policies dropped and recreated, all `to
--      authenticated`, all on auth_profile_is_privileged(); UPDATE is
--      super_admin-only and only on unused rows (review H1, owner
--      2026-11-10), so no client can revive a consumed invitation
--   6. drop get_pending_invitation(text) and register_invited_profile();
--      create register_invited_profile(text), check_invitation_code(text,text)
--      and create_invitation(text,text,text,text[],uuid,text)
--   7. ride-along grants: assert_not_last_of_role loses anon/PUBLIC (D-5, a
--      no-op on prod); consume_invitation loses authenticated (D-6)
--   8. fail-closed DO block
--
-- ------------------------------------------------------------
-- CODE (AD-1): 16 bytes from extensions.gen_random_bytes (pgcrypto, CSPRNG),
-- hex-encoded: 32 lowercase hex chars, 128 bits. Stored as
-- code_hash = encode(sha256(convert_to(code, 'UTF8')), 'hex'). No salt: the
-- secret is uniform 128-bit, and a salt would rule out the index probe. The
-- plaintext is returned once by create_invitation and never stored, logged
-- or raised.
--
-- create_invitation CHECK ORDER (SECURITY INVOKER; RLS is the authority):
--   1. auth.uid() null or not auth_profile_is_privileged() -> 42501 'forbidden'
--   2. blank email                                 -> 22023 'email required'
--   3. role not in (user, admin)                   -> 22023 'invalid role'
--   4. admin with NULL brand                       -> P0001 'admin invitation requires a brand'
--   5. staff brand: p_brand_id, else the brand of store_ids[1] (text
--      comparison), else - zero stores only - the caller's own brand when the
--      caller is admin/master (AD-4; NULL for a super_admin)
--   6. delete the caller-visible pending rows for the email (re-invite, B8)
--   7. insert (the trigger stamps invited_by; the INSERT policy enforces
--      SCOPE, EXPIRY and code_hash); return {invitation_id, code, expires_at}
--
-- register_invited_profile(p_code) CHECK ORDER (SECURITY DEFINER; every
-- refusal is P0001; 'no pending invitation' is the single string for every
-- code/identity/expiry/inviter failure, so it is no oracle):
--   R1  auth.uid() null                             'not authenticated'
--   R2  profile already exists                      'profile already exists'
--   R3a blank auth.users email                      'no pending invitation'
--   R3b blank p_code                                'no pending invitation'
--   R3c no row with code_hash = hash(lower(btrim(p_code))) (for update)
--                                                   'no pending invitation'
--   R3d email mismatch, used, NULL expiry, expired  'no pending invitation'
--   R5  role not in (user, admin)                   'invitation role not allowed'
--   R6  admin with NULL brand                       'admin invitation requires a brand'
--   R7  (D3) inviter profile missing (incl. NULL invited_by), inviter role
--       not admin/master/super_admin, or admin/master inviter whose brand is
--       distinct from the resolved brand (read FOR SHARE)
--                                                   'no pending invitation'
--   W1-W3 insert profiles, insert user_stores, mark the invitation used
-- The former R4 'multiple pending invitations' is gone: the unique index on
-- code_hash makes R3c single-row (B5).
-- check_invitation_code(email, code) applies the same conditions as one
-- predicate (CP), including R3b's blank-code guard, and returns 0 rows or 1
-- row {name}; pgTAP invitations_hardening B6-agree pins CP against R3-R7
-- (with a sha256('') fixture for R3b).
--
-- Why R7 locks the inviter FOR SHARE: it conflicts with the FOR NO KEY UPDATE
-- that demote_profile_to_user takes on its target and with a profiles DELETE,
-- so a claim racing a demotion or deletion of its inviter waits, re-reads the
-- committed row (READ COMMITTED) and refuses. Lock order: invitation row,
-- then inviter row; demote locks profiles rows only, so no cycle.
--
-- Why the privileged checks read profiles and not auth_is_privileged(): a
-- demoted admin's access token keeps app_metadata.role until it expires
-- (spec 191 / 164-M2). This deliberately deviates from the CLAUDE.md "mirror
-- auth_is_privileged()" convention (spec 157 rule: record the reason inline).
--
-- ENCODING: pure ASCII on purpose (spec 163 M1: non-ASCII bytes inside a
-- function body can make the normalized-md5 rollout check mismatch).
--
-- REALTIME: no supabase_realtime publication change; no realtime container
-- restart is needed.
--
-- PROD-APPLY (spec 064 gate, project MEMORY; owner approval required; after
-- spec 191's prod apply): run the spec's P-1, P-2, P-3, P-8, P-9, P-12 and
-- section 9 Q-1, Q-2, Q-4, Q-6, Q-7 read-only first and save the rollback
-- inputs. Then execute_sql this exact body via the Supabase MCP with, as the
-- last statement before the final commit;,
--   insert into supabase_migrations.schema_migrations (version, name)
--   values ('20261110120000', 'invitations_hardening');
-- (not apply_migration, which writes its own version), then
--   notify pgrst, 'reload schema';
-- Verify by NORMALIZED-MD5 (md5(regexp_replace(prosrc, '\s+', ' ', 'g')))
-- create_invitation, check_invitation_code, register_invited_profile(text)
-- and assert_invitation_provenance against local, plus prosecdef (f / t / t
-- / f), proconfig, owner postgres and proacl; consume_invitation and
-- assert_not_last_of_role bodies unchanged; no get_pending_invitation and no
-- zero-argument register_invited_profile row. Compare pg_policies md5(qual) /
-- md5(with_check) for the four invitations policies against local, run the
-- section 10 step 5 privilege matrix, confirm the columns, index, constraint
-- and enabled trigger, and re-run P-2 / P-3. Then deploy send-invite-email.
--
-- ROLLBACK: specs/198-invitations-hardening/rollback.sql (one transaction,
-- dry-run locally; not a migration). Re-opens 195-H1, 164-M1 and 191-M1.
--
-- Tests: supabase/tests/invitations_hardening.test.sql (new),
--        supabase/tests/profiles_insert_hardening.test.sql (K-6..K-11, K-13,
--        sections C/D/E), invitations_super_admin_rls.test.sql,
--        profiles_username.test.sql (arm 16 retired),
--        staff_brand_id_backfill.test.sql (arms 8, 9, 13 retired),
--        consume_invitation_sets_profile_id.test.sql (arm E flipped).
-- ============================================================

begin;

-- ALTER TABLE and the policy DDL take AccessExclusiveLock on
-- public.invitations. Fail fast instead of queueing; a timeout changes
-- nothing, retry.
set local lock_timeout = '5s';

-- ------------------------------------------------------------
-- 1. Prerequisites
-- ------------------------------------------------------------
do $$
begin
  if to_regprocedure('public.auth_profile_is_privileged()') is null then
    raise exception '198: requires spec 191 (20261109191000) applied first';
  end if;
  if not has_schema_privilege('authenticated', 'extensions', 'USAGE')
     or not has_function_privilege('authenticated', 'extensions.gen_random_bytes(integer)', 'EXECUTE') then
    raise exception '198: authenticated cannot call extensions.gen_random_bytes';
  end if;
end $$;


-- ------------------------------------------------------------
-- 2. Columns, constraint, index
-- No FK on invited_by: it would add a referential action to every profiles
-- delete for no gain; the claim already refuses a missing inviter row.
-- No NOT NULL on expires_at: the bound lives in the policies and the claim.
-- ------------------------------------------------------------
alter table public.invitations
  add column invited_by uuid,
  add column code_hash  text;

alter table public.invitations
  add constraint invitations_code_hash_format
  check (code_hash is null or code_hash ~ '^[0-9a-f]{64}$');

create unique index invitations_code_hash_key
  on public.invitations (code_hash)
  where code_hash is not null;

comment on column public.invitations.invited_by is
  'spec 198: auth.uid() of the inviting client, stamped by '
  'invitations_provenance_guard on INSERT and frozen on UPDATE. '
  'register_invited_profile re-checks this profile at claim time (D3).';
comment on column public.invitations.code_hash is
  'spec 198: hex sha256 of the one-time invite code. The plaintext is '
  'returned once by create_invitation and never stored.';


-- ------------------------------------------------------------
-- 3. Provenance trigger (AD-3)
-- SECURITY INVOKER so current_user is the real caller (spec 042 round-4).
-- postgres (migrations, fixtures, MCP, the DEFINER claim's own UPDATE) and
-- service_role skip.
-- ------------------------------------------------------------
create or replace function public.assert_invitation_provenance()
returns trigger
language plpgsql
security invoker
set search_path = public, auth
as $$
begin
  if current_user in ('authenticated', 'anon') then
    if tg_op = 'INSERT' then
      new.invited_by := auth.uid();
    else
      new.invited_by := old.invited_by;
      new.code_hash  := old.code_hash;
    end if;
  end if;
  return new;
end
$$;

comment on function public.assert_invitation_provenance() is
  'spec 198: BEFORE INSERT OR UPDATE on public.invitations. For '
  'authenticated/anon callers, INSERT overwrites invited_by with auth.uid() '
  '(D1) and UPDATE keeps invited_by and code_hash unchanged (D2). postgres '
  'and service_role skip. SECURITY INVOKER so current_user is the caller.';

drop trigger if exists invitations_provenance_guard on public.invitations;
create trigger invitations_provenance_guard
  before insert or update on public.invitations
  for each row execute function public.assert_invitation_provenance();

-- Review L2: hygiene only. A trigger function cannot be called outside a
-- trigger, and Postgres checks EXECUTE on it at CREATE TRIGGER time, not when
-- the trigger fires, so client inserts/updates still run it. The revoke keeps
-- the "no PUBLIC entry" privilege sweep uniform.
revoke all on function public.assert_invitation_provenance() from public, anon, authenticated;


-- ------------------------------------------------------------
-- 4. Clamp legacy pending rows (D-4). Expected 0 rows on prod.
-- invitations_hardening.test.sql C3 runs a copy of this UPDATE;
-- src/lib/invitationsClamp.source.test.ts pins the two copies equal
-- (whitespace-normalised).
-- ------------------------------------------------------------
do $$
declare
  v_n int;
begin
  update public.invitations
     set expires_at = now() + interval '48 hours'
   where used = false
     and (expires_at is null or expires_at > now() + interval '7 days');
  get diagnostics v_n = row_count;
  raise notice '198: clamped % pending invitation(s)', v_n;
end $$;


-- ------------------------------------------------------------
-- 5. Policies. SCOPE is spec 191's P_INV body without its privilege leaf,
-- verbatim from 20261109191000; D7 is the D-7 rule for rows with no brand and
-- no stores (super_admin or the inviter only; a NULL invited_by gives NULL on
-- its arm, so legacy rows are super_admin only); EXPIRY is the D-3 bound.
-- Written out in full (no helper) so the policy text checks can see them.
-- ------------------------------------------------------------
drop policy if exists "Admins can read invitations"   on public.invitations;
drop policy if exists "Admins can insert invitations" on public.invitations;
drop policy if exists "Admins can update invitations" on public.invitations;
drop policy if exists "Admins can delete invitations" on public.invitations;

create policy "Admins can read invitations"
  on public.invitations
  for select
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
    and (
      invitations.brand_id is not null
      or cardinality(coalesce(invitations.store_ids, '{}'::text[])) > 0
      or public.auth_is_super_admin()
      or invitations.invited_by = auth.uid()
    )
  );

comment on policy "Admins can read invitations" on public.invitations is
  'spec 198 (195-H1a): profiles-backed privilege (auth_profile_is_privileged), '
  'the spec 191 P_INV brand/store scope, and the D-7 rule: a row with no '
  'brand and no stores is visible to the super_admin and its inviter only.';

create policy "Admins can delete invitations"
  on public.invitations
  for delete
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
    and (
      invitations.brand_id is not null
      or cardinality(coalesce(invitations.store_ids, '{}'::text[])) > 0
      or public.auth_is_super_admin()
      or invitations.invited_by = auth.uid()
    )
  );

comment on policy "Admins can delete invitations" on public.invitations is
  'spec 198 (195-H1a): same predicate as "Admins can read invitations".';

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
    and invitations.expires_at is not null
    and invitations.expires_at <= now() + interval '7 days'
    and invitations.code_hash is not null
    and invitations.invited_by = auth.uid()
  );

comment on policy "Admins can insert invitations" on public.invitations is
  'spec 198 (on top of spec 191 / 164-M2): privileged check reads '
  'profiles.role via auth_profile_is_privileged(), not the JWT claim. Adds '
  'the D-3 expiry bound (non-NULL, at most now()+7 days), requires a '
  'code_hash (AD-2: a code-less row could never be claimed), and requires '
  'invited_by = auth.uid() (always true while invitations_provenance_guard '
  'stamps it; fails closed if the trigger is dropped).';

create policy "Admins can update invitations"
  on public.invitations
  for update
  to authenticated
  using (
    public.auth_profile_is_privileged()
    and public.auth_is_super_admin()
    and invitations.used = false
    and invitations.role in ('user', 'admin')
    and (invitations.brand_id is null or public.auth_can_see_brand(invitations.brand_id))
    and not exists (
      select 1
        from unnest(coalesce(invitations.store_ids, '{}'::text[])) as sid(store_id)
        left join public.stores s on s.id::text = lower(sid.store_id)
       where s.id is null
          or not public.auth_can_see_brand(s.brand_id)
    )
    and (
      invitations.brand_id is not null
      or cardinality(coalesce(invitations.store_ids, '{}'::text[])) > 0
      or public.auth_is_super_admin()
      or invitations.invited_by = auth.uid()
    )
  )
  with check (
    public.auth_profile_is_privileged()
    and public.auth_is_super_admin()
    and invitations.used = false
    and invitations.role in ('user', 'admin')
    and (invitations.brand_id is null or public.auth_can_see_brand(invitations.brand_id))
    and not exists (
      select 1
        from unnest(coalesce(invitations.store_ids, '{}'::text[])) as sid(store_id)
        left join public.stores s on s.id::text = lower(sid.store_id)
       where s.id is null
          or not public.auth_can_see_brand(s.brand_id)
    )
    and (
      invitations.brand_id is not null
      or cardinality(coalesce(invitations.store_ids, '{}'::text[])) > 0
      or public.auth_is_super_admin()
      or invitations.invited_by = auth.uid()
    )
    and invitations.expires_at is not null
    and invitations.expires_at <= now() + interval '7 days'
  );

comment on policy "Admins can update invitations" on public.invitations is
  'spec 198 (on top of spec 191 / 164-M2): privileged check reads '
  'profiles.role via auth_profile_is_privileged(), not the JWT claim. '
  'Review H1: UPDATE is super_admin-only (auth_is_super_admin(), '
  'profiles-backed) and admits only unused rows (used = false in USING and '
  'WITH CHECK), so no client can revive a consumed invitation or set used; '
  'the SECURITY DEFINER claim is the only writer of used = true. Re-invite '
  '(create_invitation) is the supported way to change an invitation. Adds '
  'the D-7 rule to USING and WITH CHECK (AD-12) and the D-3 expiry bound to '
  'WITH CHECK. invited_by and code_hash are frozen by the provenance trigger.';


-- ------------------------------------------------------------
-- 6. Functions
-- ------------------------------------------------------------
drop function if exists public.get_pending_invitation(text);
drop function if exists public.register_invited_profile();

-- 6a. The claim. Returns uuid (not a TABLE): plpgsql OUT-param names would
-- shadow columns. Owner MUST be postgres (owner of profiles, user_stores,
-- invitations) so the body bypasses RLS.
create function public.register_invited_profile(p_code text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid      uuid := auth.uid();
  v_email    text;
  v_code     text;
  v_inv      public.invitations%rowtype;
  v_brand    uuid;
  v_inviter  record;
  v_initials text;
begin
  -- R1
  if v_uid is null then
    raise exception 'not authenticated';
  end if;

  -- R2 (before the invitation lookup so a repeat call reports this)
  if exists (select 1 from public.profiles p where p.id = v_uid) then
    raise exception 'profile already exists';
  end if;

  -- R3a: identity binding is the caller's auth.users email.
  select lower(u.email) into v_email from auth.users u where u.id = v_uid;
  if coalesce(v_email, '') = '' then
    raise exception 'no pending invitation';
  end if;

  -- R3b
  v_code := lower(btrim(p_code));
  if coalesce(v_code, '') = '' then
    raise exception 'no pending invitation';
  end if;

  -- R3c: select by code (B5); the partial unique index makes this single-row.
  select i.* into v_inv
    from public.invitations i
   where i.code_hash = encode(sha256(convert_to(v_code, 'UTF8')), 'hex')
     for update;
  if not found then
    raise exception 'no pending invitation';
  end if;

  -- R3d
  if lower(v_inv.email) <> v_email
     or v_inv.used
     or v_inv.expires_at is null
     or v_inv.expires_at <= now() then
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

  -- Brand: spec 069 resolved brand for staff (text comparison, so a
  -- malformed store id resolves to NULL instead of throwing 22P02);
  -- invitation brand for admin.
  if v_inv.role = 'user' then
    v_brand := coalesce(
      v_inv.brand_id,
      (select s.brand_id from public.stores s where s.id::text = lower(v_inv.store_ids[1]))
    );
  else
    v_brand := v_inv.brand_id;
  end if;

  -- R7 (D3): re-check the inviter from profiles, not the JWT.
  select p.role, p.brand_id into v_inviter
    from public.profiles p
   where p.id = v_inv.invited_by
     for share;
  if not found
     or v_inviter.role is null
     or v_inviter.role not in ('admin', 'master', 'super_admin')
     or (v_inviter.role in ('admin', 'master') and v_inviter.brand_id is distinct from v_brand) then
    raise exception 'no pending invitation';
  end if;

  -- Initials: name.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase()
  v_initials := upper(left(coalesce(
    (
      select string_agg(left(t.w, 1), '' order by t.ord)
        from unnest(string_to_array(v_inv.name, ' ')) with ordinality as t(w, ord)
    ),
    ''
  ), 2));

  -- W1. The insert-role guard skips here (current_user = owner postgres);
  -- profiles_sync_role_to_jwt writes raw_app_meta_data.role.
  insert into public.profiles (id, name, role, brand_id, username, status, color, initials)
  values (v_uid, v_inv.name, v_inv.role, v_brand, v_inv.username, 'active', '#378ADD', v_initials);

  -- W2. user_stores_brand_match_trg still enforces the brand on every row.
  insert into public.user_stores (user_id, store_id)
  select distinct v_uid, sid::uuid
    from unnest(coalesce(v_inv.store_ids, '{}'::text[])) as sid
   where sid is not null;

  -- W3
  update public.invitations
     set used = true,
         profile_id = v_uid
   where id = v_inv.id;

  return v_uid;
end
$$;

comment on function public.register_invited_profile(text) is
  'spec 198 (replaces the spec 164 zero-argument version): completes '
  'invited-user registration for the CALLING user. The invitation is '
  'selected by the sha256 of p_code; its email must equal the caller''s '
  'auth.users email (case-insensitive), it must be unused and unexpired '
  '(NULL expiry = expired), and its inviter must still be privileged in its '
  'brand (profiles, read FOR SHARE). Atomically inserts profiles + '
  'user_stores and marks the invitation used. Refuses (P0001) with: not '
  'authenticated | profile already exists | no pending invitation | '
  'invitation role not allowed | admin invitation requires a brand. Owner '
  'must be postgres.';

-- REVOKE FROM public IS LOAD-BEARING (CREATE FUNCTION grants PUBLIC, and
-- spec 097's default privileges grant anon).
revoke all     on function public.register_invited_profile(text) from public, anon;
grant  execute on function public.register_invited_profile(text) to authenticated;

-- 6b. The code-gated pre-check (replaces get_pending_invitation). Predicate
-- CP = R3-R7 of register_invited_profile, as one filter. 0 rows for every
-- refusal; 1 row {name} only when the claim would succeed.
create function public.check_invitation_code(p_email text, p_code text)
returns table (name text)
language sql
stable
security definer
set search_path = public
as $$
  select i.name
    from public.invitations i
   where nullif(btrim(p_code), '') is not null
     and i.code_hash = encode(sha256(convert_to(lower(btrim(p_code)), 'UTF8')), 'hex')
     and lower(i.email) = lower(btrim(p_email))
     and i.used = false
     and i.expires_at is not null
     and i.expires_at > now()
     and i.role in ('user', 'admin')
     and (i.role <> 'admin' or i.brand_id is not null)
     and exists (
       select 1
         from public.profiles p
        where p.id = i.invited_by
          and p.role in ('admin', 'master', 'super_admin')
          and (
            p.role = 'super_admin'
            or p.brand_id = coalesce(
                 i.brand_id,
                 (select s.brand_id from public.stores s where s.id::text = lower(i.store_ids[1]))
               )
          )
     )
   limit 1;
$$;

comment on function public.check_invitation_code(text, text) is
  'spec 198 (replaces get_pending_invitation): anon-callable register '
  'pre-check. Returns one row {name} only when register_invited_profile '
  'would accept this email + code (same conditions: code hash, email, '
  'unused, unexpired, role, admin brand, inviter still privileged in the '
  'resolved brand); otherwise 0 rows, the same response for every refusal.';

revoke all     on function public.check_invitation_code(text, text) from public;
grant  execute on function public.check_invitation_code(text, text) to anon, authenticated;

-- 6c. The create path (AD-2). SECURITY INVOKER: every write is subject to the
-- invitations policies, so this function can do nothing a direct PostgREST
-- write could not. Returns jsonb: plpgsql OUT names such as expires_at would
-- shadow the columns.
create function public.create_invitation(
  p_email     text,
  p_name      text,
  p_role      text,
  p_store_ids text[],
  p_brand_id  uuid,
  p_username  text
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = public
as $$
declare
  v_email    text;
  v_stores   text[];
  v_brand    uuid;
  v_username text;
  v_code     text;
  v_hash     text;
  v_id       uuid;
  v_exp      timestamptz;
begin
  -- 1
  if auth.uid() is null or not public.auth_profile_is_privileged() then
    raise exception using errcode = '42501', message = 'forbidden';
  end if;

  -- 2
  v_email := lower(btrim(p_email));
  if coalesce(v_email, '') = '' then
    raise exception using errcode = '22023', message = 'email required';
  end if;

  -- 3
  if p_role is null or p_role not in ('user', 'admin') then
    raise exception using errcode = '22023', message = 'invalid role';
  end if;

  -- 4
  v_stores := coalesce(p_store_ids, '{}'::text[]);

  -- 5
  v_brand := p_brand_id;
  if p_role = 'admin' then
    if v_brand is null then
      raise exception using errcode = 'P0001', message = 'admin invitation requires a brand';
    end if;
  else
    if v_brand is null and cardinality(v_stores) > 0 then
      v_brand := (select s.brand_id from public.stores s where s.id::text = lower(v_stores[1]));
    end if;
    if v_brand is null and cardinality(v_stores) = 0 then
      -- AD-4 (design default, owner may flip): a zero-store staff invitation
      -- from an admin/master carries the inviter's own brand, so the claim's
      -- inviter-brand re-check (D3) can pass. A super_admin's stays NULL.
      v_brand := (
        select p.brand_id
          from public.profiles p
         where p.id = auth.uid()
           and p.role in ('admin', 'master')
      );
    end if;
  end if;

  -- 6
  v_username := nullif(lower(btrim(p_username)), '');

  -- 7. Never raise or log v_code.
  v_code := encode(extensions.gen_random_bytes(16), 'hex');
  v_hash := encode(sha256(convert_to(v_code, 'UTF8')), 'hex');
  v_id   := gen_random_uuid();
  v_exp  := now() + interval '48 hours';

  -- 8. Re-invite (B8): RLS limits this to pending rows the caller can see.
  delete from public.invitations where lower(email) = v_email and used = false;

  -- 9. No RETURNING. The trigger stamps invited_by.
  insert into public.invitations (id, email, profile_id, name, role, store_ids, brand_id, username, expires_at, code_hash)
  values (v_id, v_email, '00000000-0000-0000-0000-000000000000', p_name, p_role, v_stores, v_brand, v_username, v_exp, v_hash);

  -- 10
  return jsonb_build_object('invitation_id', v_id, 'code', v_code, 'expires_at', v_exp);
end
$$;

comment on function public.create_invitation(text, text, text, text[], uuid, text) is
  'spec 198: creates (or, for a caller-visible pending row with the same '
  'email, replaces) an invitation and returns {invitation_id, code, '
  'expires_at}. The 32-hex code is returned once; only its sha256 is '
  'stored. SECURITY INVOKER: the invitations RLS policies decide what may be '
  'written. Errors: forbidden (42501) | email required (22023) | invalid '
  'role (22023) | admin invitation requires a brand (P0001) | RLS 42501.';

revoke all     on function public.create_invitation(text, text, text, text[], uuid, text) from public, anon;
grant  execute on function public.create_invitation(text, text, text, text[], uuid, text) to authenticated;


-- ------------------------------------------------------------
-- 7. Ride-along grants
-- ------------------------------------------------------------
-- D-5 (191-L3): no-op on prod (P-9); removes the local anon grant.
revoke execute on function public.assert_not_last_of_role(uuid, text) from public, anon;
grant  execute on function public.assert_not_last_of_role(uuid, text) to authenticated, service_role;

-- D-6: no caller since spec 164; any account could burn an invitation with
-- it. service_role keeps EXECUTE. Body unchanged.
-- The explicit service_role grant is needed on a fresh build: 20260531000000
-- revoked PUBLIC, and service_role had no grant of its own there. Prod and the
-- long-lived local stack already hold one, so it is a no-op on them.
revoke execute on function public.consume_invitation(uuid, text) from public, anon, authenticated;
grant  execute on function public.consume_invitation(uuid, text) to service_role;


-- ------------------------------------------------------------
-- 8. Fail-closed. Any raise rolls the whole migration back.
-- ------------------------------------------------------------
do $$
declare
  v_cmd   text;
  v_count int;
  v_bad   int;
begin
  -- 8.1 exactly one permissive policy per command (ALL counts for each)
  foreach v_cmd in array array['SELECT', 'INSERT', 'UPDATE', 'DELETE'] loop
    select count(*) into v_count
      from pg_policies
     where schemaname = 'public'
       and tablename  = 'invitations'
       and permissive = 'PERMISSIVE'
       and cmd in (v_cmd, 'ALL');
    if v_count <> 1 then
      raise exception '198: expected exactly one permissive %/ALL policy on public.invitations, found %', v_cmd, v_count;
    end if;
  end loop;

  -- 8.2 roles
  select count(*),
         count(*) filter (where roles <> '{authenticated}'::name[])
    into v_count, v_bad
    from pg_policies
   where schemaname = 'public'
     and tablename  = 'invitations'
     and policyname in ('Admins can read invitations', 'Admins can insert invitations',
                        'Admins can update invitations', 'Admins can delete invitations');
  if v_count <> 4 or v_bad <> 0 then
    raise exception '198: expected the 4 invitations policies to be to authenticated; found %, % with other roles', v_count, v_bad;
  end if;

  select count(*) into v_count
    from pg_policies
   where schemaname = 'public'
     and tablename  = 'invitations'
     and ('anon' = any(roles) or 'public' = any(roles));
  if v_count <> 0 then
    raise exception '198: % invitations policy(ies) name anon or public', v_count;
  end if;

  -- 8.3 policy text
  select count(*) filter (where not (
           (x.t is null or (position('auth_profile_is_privileged()' in x.t) > 0
                            and position('auth_is_privileged()' in x.t) = 0))
         ))
    into v_bad
    from (
      select lower(regexp_replace(qual, '\s+', ' ', 'g')) as t
        from pg_policies where schemaname = 'public' and tablename = 'invitations'
      union all
      select lower(regexp_replace(with_check, '\s+', ' ', 'g'))
        from pg_policies where schemaname = 'public' and tablename = 'invitations'
    ) x;
  if v_bad <> 0 then
    raise exception '198: % invitations policy expression(s) lack auth_profile_is_privileged() or contain auth_is_privileged()', v_bad;
  end if;

  select count(*) into v_count
    from pg_policies
   where schemaname = 'public'
     and tablename  = 'invitations'
     and cmd in ('SELECT', 'DELETE')
     and position('auth_can_see_brand'        in lower(regexp_replace(qual, '\s+', ' ', 'g'))) > 0
     and position('auth_is_super_admin()'     in lower(regexp_replace(qual, '\s+', ' ', 'g'))) > 0
     and position('invited_by = auth.uid()'   in lower(regexp_replace(qual, '\s+', ' ', 'g'))) > 0;
  if v_count <> 2 then
    raise exception '198: SELECT/DELETE qual must carry auth_can_see_brand, auth_is_super_admin() and invited_by = auth.uid(); % of 2 do', v_count;
  end if;

  select count(*) into v_count
    from pg_policies
   where schemaname = 'public'
     and tablename  = 'invitations'
     and cmd = 'INSERT'
     and position('code_hash is not null'   in lower(regexp_replace(with_check, '\s+', ' ', 'g'))) > 0
     and position('invited_by = auth.uid()' in lower(regexp_replace(with_check, '\s+', ' ', 'g'))) > 0
     and position('7 days'                  in lower(regexp_replace(with_check, '\s+', ' ', 'g'))) > 0;
  if v_count <> 1 then
    raise exception '198: INSERT with_check must carry code_hash is not null, invited_by = auth.uid() and 7 days';
  end if;

  select count(*) into v_count
    from pg_policies
   where schemaname = 'public'
     and tablename  = 'invitations'
     and cmd = 'UPDATE'
     and position('invited_by = auth.uid()' in lower(regexp_replace(qual, '\s+', ' ', 'g'))) > 0
     and position('7 days'                  in lower(regexp_replace(with_check, '\s+', ' ', 'g'))) > 0;
  if v_count <> 1 then
    raise exception '198: UPDATE qual must carry invited_by = auth.uid() and with_check 7 days';
  end if;

  -- H1: UPDATE is super_admin-only and on unused rows only. D7 already holds
  -- one auth_is_super_admin() arm, so the H1 leaf makes it at least two.
  select count(*) into v_count
    from (
      select lower(regexp_replace(qual, '\s+', ' ', 'g'))       as q,
             lower(regexp_replace(with_check, '\s+', ' ', 'g')) as w
        from pg_policies
       where schemaname = 'public'
         and tablename  = 'invitations'
         and cmd = 'UPDATE'
    ) x
   where position('used = false' in x.q) > 0
     and position('used = false' in x.w) > 0
     and (length(x.q) - length(replace(x.q, 'auth_is_super_admin()', ''))) / length('auth_is_super_admin()') >= 2
     and (length(x.w) - length(replace(x.w, 'auth_is_super_admin()', ''))) / length('auth_is_super_admin()') >= 2;
  if v_count <> 1 then
    raise exception '198: UPDATE qual and with_check must carry used = false and the super_admin-only leaf (H1)';
  end if;

  -- 8.4 functions
  if to_regprocedure('public.get_pending_invitation(text)') is not null then
    raise exception '198: get_pending_invitation(text) still exists';
  end if;
  if to_regprocedure('public.register_invited_profile()') is not null then
    raise exception '198: zero-argument register_invited_profile() still exists';
  end if;
  if not exists (select 1 from pg_proc
                  where oid = to_regprocedure('public.register_invited_profile(text)')
                    and prosecdef
                    and pg_get_userbyid(proowner) = 'postgres') then
    raise exception '198: register_invited_profile(text) must be SECURITY DEFINER and owned by postgres';
  end if;
  if not exists (select 1 from pg_proc
                  where oid = to_regprocedure('public.create_invitation(text,text,text,text[],uuid,text)')
                    and not prosecdef) then
    raise exception '198: create_invitation must exist and be SECURITY INVOKER';
  end if;

  -- 8.5 grants
  if has_function_privilege('anon', 'public.assert_not_last_of_role(uuid,text)', 'EXECUTE') then
    raise exception '198: anon can still execute assert_not_last_of_role';
  end if;
  if has_function_privilege('authenticated', 'public.consume_invitation(uuid,text)', 'EXECUTE') then
    raise exception '198: authenticated can still execute consume_invitation';
  end if;
  if has_function_privilege('anon', 'public.create_invitation(text,text,text,text[],uuid,text)', 'EXECUTE') then
    raise exception '198: anon can execute create_invitation';
  end if;
  if has_function_privilege('anon', 'public.register_invited_profile(text)', 'EXECUTE') then
    raise exception '198: anon can execute register_invited_profile(text)';
  end if;
  if has_function_privilege('anon', 'public.assert_invitation_provenance()', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.assert_invitation_provenance()', 'EXECUTE') then
    raise exception '198: a client role can still execute assert_invitation_provenance() (L2)';
  end if;

  -- 8.6 expiry invariant
  select count(*) into v_count
    from public.invitations
   where used = false
     and (expires_at is null or expires_at > now() + interval '7 days');
  if v_count <> 0 then
    raise exception '198: % pending invitation(s) outside the 7-day bound after the clamp', v_count;
  end if;
end $$;

commit;
