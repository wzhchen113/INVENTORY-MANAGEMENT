-- ============================================================
-- Spec 191 - demote_profile_to_user brand scope, last-of-role guard, and
-- profiles-backed role checks for role-changing writes. Closes 164-H2, the
-- role-changing part of 164-M2, and step 1 of 187-H2.
--
-- Design authority: specs/191-demote-profile-brand-scope.md "## Backend design",
-- as amended by the owner-approved fix plan in
-- specs/191-demote-profile-brand-scope/reviews/release-proposal.md (2026-11-09:
-- lock_timeout, the wrapper's privilege check, the fail-closed brand step).
--
-- This migration, in one transaction (order matters: policies depend on the
-- helper, and the RPC and trigger depend on the wrapper):
--   1. public.auth_profile_is_privileged()          new, SECURITY DEFINER
--   2. public.assert_demote_not_last_of_role(uuid,text)  new, SECURITY INVOKER
--   3. public.demote_profile_to_user(uuid)          replaced
--   4. public.assert_brand_id_immutable_for_self()  replaced (new elsif branch)
--   5. three policies recreated with the profiles-backed privileged check:
--        public.profiles    "Admins can insert profiles in own brand" (INSERT)
--        public.invitations "Admins can insert invitations"           (INSERT)
--        public.invitations "Admins can update invitations"           (UPDATE)
--   6. fail-closed DO block (spec 164 counts plus a policy-text check)
--
-- ------------------------------------------------------------
-- demote_profile_to_user(target_user_id) CHECK ORDER (a contract; the spec's
-- acceptance criterion A, with the lock-order change recorded below):
--   1. auth.uid() is null                         -> P0001 'cannot demote self'
--   2. not auth_profile_is_privileged()           -> 42501 'forbidden'
--   3. target = caller                            -> P0001 'cannot demote self'
--   4. row-lock {caller, target} in id order (for no key update) and re-read
--      the caller; caller row missing or role not admin/master/super_admin
--                                                 -> 42501 'forbidden'
--   5. target row not found                       -> P0002 'target profile not found'
--   6. target is super_admin, caller is not       -> 42501 'forbidden: only a super_admin can demote a super_admin'
--   7. caller is not super_admin and the caller brand is NULL or the target
--      brand is distinct from it                  -> 42501 'forbidden: target is in a different brand'
--      (byte-identical to supabase/functions/delete-user/index.ts:156).
--      Written fail-closed (is distinct from 'super_admin'): while step 4
--      holds, only admin/master callers reach it, so behaviour is the same as
--      "in ('admin','master')"; if the step-4 re-read were ever dropped, a
--      caller demoted mid-call would get the brand refusal instead of
--      reaching every brand.
--   8. assert_demote_not_last_of_role(target, target_role)
--                                                 -> P0001 'cannot demote the last super_admin'
--                                                    P0001 'cannot demote the last master'
--   9. update profiles set role='user', brand_id=null; return the id.
--
-- Why step 2 reads profiles and not auth_is_privileged(): auth_is_admin() is
-- JWT-only, and a demoted admin's access token keeps app_metadata.role='admin'
-- for up to jwt_expiry. A role-changing write must not trust that claim
-- (164-M2). This is a deliberate deviation from the CLAUDE.md "mirror
-- auth_is_privileged()" convention (spec 157 rule: record the reason inline).
--
-- Deviation from criterion A step 4 (architect, recorded): row locks are taken
-- BEFORE the role advisory lock (which moves to step 8) so that the RPC and the
-- direct-PATCH trigger path both take locks in the order rows -> advisory.
-- A direct PATCH already holds its target row lock when the BEFORE trigger
-- runs; the reverse order on the RPC would deadlock against it.
--
-- LOCK DESIGN (the spec's concurrency criterion B4):
--   Layer 1: row locks (for no key update) on {caller, target} in id order.
--            Serializes any two demotions that share a caller or a target
--            (mutual demotion). The caller's role cannot change for the rest
--            of the call. `no key update` does not block FK key-share locks.
--   Layer 2: pg_advisory_xact_lock(hashtext('last_of_role:' || role)), taken
--            only for super_admin / master targets, immediately before the
--            count. Serializes third-party demotions of the same role. Shared
--            by the RPC and the trigger via assert_demote_not_last_of_role.
--   Unprivileged callers never take a lock: the RPC refuses them at step 2,
--   and the wrapper's first statement refuses them (42501 'forbidden') before
--   its role filter and its advisory lock when it is called directly.
--   READ COMMITTED is assumed (the PostgREST and psql default; verify with
--   `show transaction_isolation`): the wrapper is VOLATILE, so its count
--   statement takes a fresh snapshot after the lock is granted and sees a
--   competing demotion that committed while it waited. Under REPEATABLE READ
--   a waiter would see a stale count.
--   A multi-row super_admin role PATCH racing an RPC can deadlock (40P01);
--   Postgres aborts one side after deadlock_timeout. Fails closed; accepted.
--
-- LAST-OF-ROLE (the spec's criterion B3): the count stays in
-- public.assert_not_last_of_role, whose signature, body and grants are NOT
-- changed (delete-user and delete_last_privileged_guard.test.sql are
-- unaffected). The wrapper catches its P0001 and re-raises 'cannot demote the
-- last <role>' only when the message is exactly 'cannot delete the last
-- <role>'; any other P0001 is re-raised untouched (fail-closed coupling). The
-- coupling is pinned by pgTAP arms B1a, B1b and D2a, which go red if the
-- helper's wording changes; K-6 checks structure only.
--
-- DIRECT PATCH (the spec's section D, open question OQ-5):
-- assert_brand_id_immutable_for_self() gains an elsif branch for super_admin
-- callers when current_user is authenticated or anon and profiles.role
-- changes:
--   own row                         -> P0001 'cannot demote self'
--   row moving off super_admin/master and it is the last one
--                                   -> P0001 'cannot demote the last super_admin'
--                                      P0001 'cannot demote the last master'
-- The existing non-super_admin branch keeps its logic and message strings
-- identical to 20260517050000 ('brand_id is read-only for self-edits
-- (super_admin only)', 'role is read-only for self-edits (super_admin only)'
-- and 'role changes require super_admin'); three comment glyphs in it (em
-- dash, arrow, section sign) were ASCII-fied, so its text is not
-- byte-identical to the old body. postgres (migrations,
-- MCP applies, pgTAP fixtures, the SECURITY DEFINER RPC's own UPDATE) and
-- service_role are skipped.
-- Consequence (owner should know): promoting the LAST master straight to
-- super_admin is refused with 'cannot demote the last master', because it
-- moves the row off master. Workaround: promote someone else to master first.
--
-- POLICIES (the spec's section C): the three role-creating policies swap
-- public.auth_is_privileged() for public.auth_profile_is_privileged(); every
-- other clause is copied verbatim from 20261007000000. The invitations
-- SELECT/DELETE policies and every other profiles policy are untouched.
--
-- ENCODING: pure ASCII on purpose. Non-ASCII bytes inside a function body
-- feed the normalized-md5 rollout check, so an encoding difference in the
-- apply channel could produce a false mismatch (the spec 163 M1 lesson).
--
-- REALTIME: no supabase_realtime publication change. No realtime container
-- restart is needed. No table, column or index changes.
--
-- PROD-APPLY (spec 064 gate, project MEMORY; owner approval required): run the
-- read-only pre-checks in the spec's "Prod rollout" (H1) first, then
-- execute_sql this exact body via the Supabase MCP, then
--   insert into supabase_migrations.schema_migrations (version, name)
--   values ('20261109191000', 'demote_profile_brand_scope');
-- Verify by NORMALIZED-MD5 (md5(regexp_replace(prosrc, '\s+', ' ', 'g')))
-- demote_profile_to_user(uuid), assert_brand_id_immutable_for_self(),
-- auth_profile_is_privileged(), assert_demote_not_last_of_role(uuid,text)
-- against local; assert_not_last_of_role(uuid,text) must be unchanged. For
-- the same four, also compare against local: prosecdef (t / f / t / f in that
-- order), proconfig ({search_path=public, auth}), owner (postgres) and proacl.
-- Compare the pg_policies qual/with_check of the three policies against local
-- and confirm has_function_privilege('anon', ..., 'EXECUTE') = false for the
-- RPC and both new functions.
--
-- ROLLBACK: specs/191-demote-profile-brand-scope/rollback.sql (one
-- transaction, dry-run locally); not shipped as a migration. Re-opens 164-H2
-- and 187-H2 step 1.
--
-- Tests: supabase/tests/demote_profile_brand_scope.test.sql,
--        supabase/tests/profiles_insert_hardening.test.sql (K-2, K-16..K-18, E),
--        supabase/tests/demote_self_guard.test.sql (unmodified).
-- ============================================================

begin;

-- DROP/CREATE POLICY below take an AccessExclusiveLock on public.profiles and
-- public.invitations, and nearly every RLS check reads profiles. Fail fast
-- rather than queue reads behind a long transaction. A timeout changes
-- nothing; retry.
set local lock_timeout = '5s';

-- ------------------------------------------------------------
-- 1. public.auth_profile_is_privileged()
-- ------------------------------------------------------------
create or replace function public.auth_profile_is_privileged()
returns boolean
language sql
stable
security definer
set search_path = public, auth
as $$
  select exists (
    select 1
      from public.profiles
     where id = auth.uid()
       and role in ('admin', 'master', 'super_admin')
  );
$$;

comment on function public.auth_profile_is_privileged() is
  'spec 191 / 164-M2: profiles-backed privileged check for role-changing writes '
  '(demote RPC, assert_demote_not_last_of_role, invitations INSERT/UPDATE, '
  'profiles INSERT). Deliberately does '
  'not consult the JWT app_metadata.role claim, which stays stale for up to '
  'jwt_expiry after a demotion. auth_is_privileged() is unchanged; converging '
  'it is a follow-up spec.';

-- REVOKE FROM anon IS LOAD-BEARING: spec 097's ALTER DEFAULT PRIVILEGES gives
-- anon an explicit EXECUTE on new public functions, so revoking from PUBLIC
-- alone would leave it.
revoke all     on function public.auth_profile_is_privileged() from public, anon;
grant  execute on function public.auth_profile_is_privileged() to authenticated;


-- ------------------------------------------------------------
-- 2. public.assert_demote_not_last_of_role(uuid, text)
--
-- VOLATILE IS LOAD-BEARING: the perform below must take a fresh snapshot
-- after the advisory lock is granted. Never mark this STABLE.
-- SECURITY INVOKER: the trigger path runs as authenticated, which needs
-- EXECUTE. A direct call over PostgREST by an unprivileged caller is refused
-- by the first statement, before the role filter and the advisory lock, so it
-- can neither take the lock nor ask the last-of-role question. Both
-- legitimate callers pass it: the RPC has already checked the same auth.uid()
-- at its steps 2 and 4, and the trigger branch runs only for super_admins.
-- ------------------------------------------------------------
create or replace function public.assert_demote_not_last_of_role(
  p_target uuid,
  p_role   text
)
returns void
language plpgsql
volatile
security invoker
set search_path = public, auth
as $$
begin
  -- Caller must be privileged by profiles.role (never the JWT claim).
  if not public.auth_profile_is_privileged() then
    raise exception using
      errcode = '42501',
      message = 'forbidden';
  end if;

  -- This role list deliberately mirrors the roles assert_not_last_of_role
  -- guards; change both together.
  if p_role is null or p_role not in ('super_admin', 'master') then
    return;
  end if;

  perform pg_advisory_xact_lock(hashtext('last_of_role:' || p_role));

  begin
    perform public.assert_not_last_of_role(p_target, p_role);
  exception when sqlstate 'P0001' then
    if sqlerrm = 'cannot delete the last ' || p_role then
      raise exception using
        errcode = 'P0001',
        message = 'cannot demote the last ' || p_role;
    end if;
    raise;
  end;
end;
$$;

comment on function public.assert_demote_not_last_of_role(uuid, text) is
  'spec 191: last-of-role guard for demotions (demote_profile_to_user and '
  'super_admin direct role edits via assert_brand_id_immutable_for_self). '
  'First refuses a caller who is not privileged by profiles.role '
  '(auth_profile_is_privileged) with 42501 forbidden, before any lock. '
  'For super_admin/master only, takes pg_advisory_xact_lock(hashtext('
  '''last_of_role:'' || role)) then calls assert_not_last_of_role unchanged, '
  'translating its exact ''cannot delete the last <role>'' P0001 into '
  '''cannot demote the last <role>''. Any other P0001 is re-raised untouched. '
  'VOLATILE is load-bearing (fresh snapshot after the lock); SECURITY INVOKER '
  'so the trigger path can call it as authenticated.';

revoke all     on function public.assert_demote_not_last_of_role(uuid, text) from public, anon;
grant  execute on function public.assert_demote_not_last_of_role(uuid, text) to authenticated;


-- ------------------------------------------------------------
-- 3. public.demote_profile_to_user(uuid), replaced
-- ------------------------------------------------------------
create or replace function public.demote_profile_to_user(
  target_user_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_caller_id    uuid := auth.uid();
  v_caller_role  text;
  v_caller_brand uuid;
  v_target_role  text;
  v_target_brand uuid;
  v_target_found boolean := false;
  v_demoted      uuid;
  r              record;
begin
  -- (1) Null caller. Unified string so a probing caller cannot tell a missing
  -- session from a self-target (spec 050 arm iv).
  if v_caller_id is null then
    raise exception using
      errcode = 'P0001',
      message = 'cannot demote self';
  end if;

  -- (2) Cheap, lock-free privilege gate read from profiles.role (spec 191 /
  -- 164-M2). Not auth_is_privileged(): its admin/master arm trusts the token
  -- claim, which stays stale after a demotion.
  if not public.auth_profile_is_privileged() then
    raise exception using
      errcode = '42501',
      message = 'forbidden';
  end if;

  -- (3) Self guard (spec 050).
  if target_user_id = v_caller_id then
    raise exception using
      errcode = 'P0001',
      message = 'cannot demote self';
  end if;

  -- (4) Layer-1 locks: caller and target rows, in id order, so two
  -- demotions that share a row serialize instead of deadlocking. The
  -- values read here are the latest committed versions (READ COMMITTED
  -- re-fetches a row that changed while this call waited for its lock).
  for r in
    select p.id, p.role, p.brand_id
      from public.profiles p
     where p.id in (v_caller_id, target_user_id)
     order by p.id
       for no key update
  loop
    if r.id = v_caller_id then
      v_caller_role  := r.role;
      v_caller_brand := r.brand_id;
    else
      v_target_role  := r.role;
      v_target_brand := r.brand_id;
      v_target_found := true;
    end if;
  end loop;

  -- Race-proof re-read of the caller. This role list must stay equal to
  -- the set auth_profile_is_privileged() admits (step 2). Load-bearing for
  -- brand scope: a caller demoted while waiting for the lock stops here.
  -- pgTAP K-9 pins its presence.
  if v_caller_role is null
     or v_caller_role not in ('admin', 'master', 'super_admin') then
    raise exception using
      errcode = '42501',
      message = 'forbidden';
  end if;

  -- (5) Target did not exist.
  if not v_target_found then
    raise exception using
      errcode = 'P0002',
      message = 'target profile not found';
  end if;

  -- (6) Only a super_admin may demote a super_admin.
  if v_target_role = 'super_admin' and v_caller_role <> 'super_admin' then
    raise exception using
      errcode = '42501',
      message = 'forbidden: only a super_admin can demote a super_admin';
  end if;

  -- (7) Brand scope for every caller except a super_admin (in practice
  -- admin/master, given step 4). Fail-closed on purpose: any other role
  -- reaching here gets the brand check. NULL on either side refuses.
  -- Message is byte-identical to delete-user's brand gate.
  if v_caller_role is distinct from 'super_admin'
     and (v_caller_brand is null
          or v_target_brand is distinct from v_caller_brand) then
    raise exception using
      errcode = '42501',
      message = 'forbidden: target is in a different brand';
  end if;

  -- (8) Last-of-role guard + layer-2 role lock (super_admin/master only).
  perform public.assert_demote_not_last_of_role(target_user_id, v_target_role);

  -- (9) Destructive op. Both columns change in one UPDATE so
  -- profiles_role_brand_consistent passes. profiles_self_brand_lock fires
  -- with current_user = postgres here and skips its role branches; this
  -- function has already run every check.
  update public.profiles
     set role = 'user', brand_id = null
   where id = target_user_id
  returning id into v_demoted;

  return v_demoted;
end;
$$;

comment on function public.demote_profile_to_user(uuid) is
  'spec 050 + spec 191: demote a profile to role=user, brand_id=NULL. Check '
  'order: (1) null caller -> P0001 cannot demote self; (2) caller privilege '
  'read from profiles via auth_profile_is_privileged() -> 42501 forbidden; '
  '(3) self -> P0001 cannot demote self; (4) row locks on caller+target in id '
  'order (for no key update) and caller re-read -> 42501 forbidden; (5) P0002 '
  'target profile not found; (6) 42501 forbidden: only a super_admin can demote '
  'a super_admin; (7) every non-super_admin caller: 42501 forbidden: target is '
  'in a different brand (NULL-safe; matches delete-user); (8) '
  'assert_demote_not_last_of_role (advisory lock per role) -> P0001 cannot '
  'demote the last super_admin / master; (9) update and return the id. The '
  'caller check reads profiles.role, not auth_is_privileged(), because the JWT '
  'app_metadata.role claim stays stale for up to jwt_expiry after a demotion '
  '(164-M2; spec 157 deliberate-deviation rule).';

revoke execute on function public.demote_profile_to_user(uuid) from public, anon;
grant  execute on function public.demote_profile_to_user(uuid) to authenticated;


-- ------------------------------------------------------------
-- 4. public.assert_brand_id_immutable_for_self(), extended
--
-- Stays SECURITY INVOKER (spec 042 round-4: current_user must be the real
-- caller) and stays bound to profiles_self_brand_lock (BEFORE UPDATE, FOR
-- EACH ROW); the trigger binding is unchanged. The first branch has the same
-- logic and message strings as 20260517050000; three comment glyphs in it
-- (em dash, arrow, section sign) were ASCII-fied, so it is not byte-identical.
-- Reaching the new elsif means auth_is_super_admin() is true (the first
-- condition is "not auth_is_super_admin()").
-- ------------------------------------------------------------
create or replace function public.assert_brand_id_immutable_for_self()
returns trigger
language plpgsql
security invoker
set search_path = public, auth
as $$
begin
  if tg_op = 'UPDATE' and not public.auth_is_super_admin() then
    -- Self-edits: existing Spec 041 contract - message strings are
    -- contract per supabase/tests/auth_can_see_store_brand_scope.test.sql
    -- arms 7-8. DO NOT change these message strings.
    if old.id = auth.uid() then
      if old.brand_id is distinct from new.brand_id then
        raise exception
          'brand_id is read-only for self-edits (super_admin only)';
      end if;
      if old.role is distinct from new.role then
        raise exception
          'role is read-only for self-edits (super_admin only)';
      end if;
    elsif current_user in ('authenticated', 'anon') then
      -- Cross-user edits by AUTHENTICATED non-super_admin: NEW in Spec 042.
      -- Closes Row J - same-brand role-escalation. brand_id transfers are
      -- already blocked by the policy WITH CHECK + row-level CHECK.
      --
      -- The trigger function is SECURITY INVOKER as of Spec 042 round-4
      -- so `current_user` here reflects the caller's actual Postgres
      -- role. PostgREST authenticated -> 'authenticated' (fires);
      -- pgTAP after `reset role` -> 'postgres' (skips); migration ->
      -- 'postgres' (skips); service_role bearer -> 'service_role'
      -- (skips - service_role bypasses RLS but BEFORE triggers do
      -- still fire, so the explicit allowlist matters).
      --
      -- See section 13 "Round-4 design revision" for the empirical evidence
      -- (PostgreSQL trigger semantics match a direct SECURITY INVOKER
      -- call - the dev's row-2 probe).
      --
      -- All inner helpers used here (auth.uid(), auth_is_super_admin())
      -- remain SECURITY DEFINER and continue to read profiles under
      -- the function owner's identity, independent of the trigger's
      -- SECURITY INVOKER mode.
      if old.role is distinct from new.role then
        raise exception
          'role changes require super_admin';
      end if;
    end if;
  elsif tg_op = 'UPDATE'
        and current_user in ('authenticated', 'anon')
        and old.role is distinct from new.role then
    -- Spec 191 (OQ-5): the caller is a super_admin (profiles-backed) making a
    -- direct role edit. Self guard first, then the shared last-of-role
    -- wrapper (row lock already held by this UPDATE, then the role advisory
    -- lock; same order as the RPC). postgres and service_role skip.
    if old.id = auth.uid() then
      raise exception using
        errcode = 'P0001',
        message = 'cannot demote self';
    end if;
    perform public.assert_demote_not_last_of_role(old.id, old.role);
  end if;
  return new;
end
$$;

comment on function public.assert_brand_id_immutable_for_self() is
  'Spec 041 + 042 round-4 + 191: BEFORE UPDATE guard on public.profiles. For '
  'non-super_admin callers: self-edits may not change brand_id or role (spec '
  '041), and in hostile contexts (current_user in authenticated, anon) no '
  'cross-user role change is allowed (spec 042, ''role changes require '
  'super_admin''). For super_admin callers in hostile contexts (spec 191): a '
  'role change on their own row raises ''cannot demote self'', and moving a '
  'row off super_admin/master calls assert_demote_not_last_of_role (''cannot '
  'demote the last super_admin'' / ''cannot demote the last master''). '
  'postgres (migrations, pgTAP fixtures, SECURITY DEFINER RPCs) and '
  'service_role skip both role branches. Function is SECURITY INVOKER as of '
  'spec 042 round-4 so current_user inside the body reflects the caller''s '
  'Postgres role; inner helpers (auth.uid, auth_is_super_admin) remain '
  'SECURITY DEFINER and read profiles reliably under postgres. Round-3 was '
  'SECURITY DEFINER and `current_user` collapsed to postgres, leaving Row J '
  'open - see specs/042-rls-hardening-followups.md section "Round-4 BLOCKER" '
  '+ section 13 Round-4 revision for the empirical evidence.';


-- ------------------------------------------------------------
-- 5. Policies. Only auth_is_privileged() -> auth_profile_is_privileged()
-- changes; the rest is verbatim from 20261007000000.
-- ------------------------------------------------------------
drop policy if exists "Admins can insert profiles in own brand" on public.profiles;
create policy "Admins can insert profiles in own brand"
  on public.profiles
  as permissive
  for insert
  to authenticated
  with check (public.auth_profile_is_privileged() and public.auth_can_see_brand(brand_id));

comment on policy "Admins can insert profiles in own brand" on public.profiles is
  'spec 191 / 164-M2: privileged check deliberately reads profiles.role via '
  'auth_profile_is_privileged(), not the JWT claim (stale up to jwt_expiry '
  'after demotion). The rest of the predicate is unchanged from spec 164: '
  'privileged + brand-scoped only; no self-arm. Non-super_admin callers are '
  'further limited to role=user by profiles_insert_role_guard. Registration '
  'goes through register_invited_profile().';

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


-- ------------------------------------------------------------
-- 6. Fail-closed (the spec's criterion C5). Spec 164's three counts, then a
-- text check that the three recreated policies use the profiles-backed helper
-- and not auth_is_privileged(). position() rather than LIKE, so '_' is not a
-- wildcard. Any raise rolls the whole migration back.
-- ------------------------------------------------------------
do $$
declare
  v_count int;
  v_bad   int;
begin
  select count(*) into v_count
    from pg_policies
   where schemaname = 'public'
     and tablename  = 'profiles'
     and permissive = 'PERMISSIVE'
     and cmd in ('INSERT', 'ALL');
  if v_count <> 1 then
    raise exception '191: expected exactly one permissive INSERT/ALL policy on public.profiles, found %', v_count;
  end if;

  select count(*) into v_count
    from pg_policies
   where schemaname = 'public'
     and tablename  = 'invitations'
     and permissive = 'PERMISSIVE'
     and cmd in ('INSERT', 'ALL');
  if v_count <> 1 then
    raise exception '191: expected exactly one permissive INSERT/ALL policy on public.invitations, found %', v_count;
  end if;

  select count(*) into v_count
    from pg_policies
   where schemaname = 'public'
     and tablename  = 'invitations'
     and permissive = 'PERMISSIVE'
     and cmd in ('UPDATE', 'ALL');
  if v_count <> 1 then
    raise exception '191: expected exactly one permissive UPDATE/ALL policy on public.invitations, found %', v_count;
  end if;

  select count(*),
         count(*) filter (where not (
           -- INSERT policies carry only WITH CHECK; UPDATE carries both.
           (cmd = 'INSERT'
              and qual is null
              and position('auth_profile_is_privileged()' in with_check) > 0
              and position('auth_is_privileged()'         in with_check) = 0)
           or
           (cmd = 'UPDATE'
              and position('auth_profile_is_privileged()' in qual)       > 0
              and position('auth_is_privileged()'         in qual)       = 0
              and position('auth_profile_is_privileged()' in with_check) > 0
              and position('auth_is_privileged()'         in with_check) = 0)
         ))
    into v_count, v_bad
    from pg_policies
   where schemaname = 'public'
     and ((tablename = 'profiles'    and policyname = 'Admins can insert profiles in own brand')
       or (tablename = 'invitations' and policyname in ('Admins can insert invitations',
                                                        'Admins can update invitations')));
  if v_count <> 3 or v_bad <> 0 then
    raise exception '191: expected the 3 recreated policies to use auth_profile_is_privileged() and not auth_is_privileged(); found %, % malformed', v_count, v_bad;
  end if;
end $$;

commit;
