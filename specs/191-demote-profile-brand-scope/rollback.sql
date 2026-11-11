-- ============================================================
-- specs/191-demote-profile-brand-scope/rollback.sql
--
-- Rollback for supabase/migrations/20261109191000_demote_profile_brand_scope.sql
-- (spec 191). NOT a migration. Run it once, as postgres, with owner approval,
-- through the same channel as the apply (Supabase MCP execute_sql on prod;
-- psql locally). Rolling back re-opens 164-H2 and 187-H2 step 1.
--
-- ENCODING - DO NOT ASCII-FY OR RETYPE THIS FILE. Steps 2 and 3 are byte
-- copies of the pre-191 bodies, non-ASCII comment glyphs included (em dash,
-- arrow and section sign in the trigger function; em dashes in the RPC).
-- Those bytes are part of prosrc, so they decide whether the normalized md5s
-- return to the baselines below. If a step must be re-made, copy it with sed
-- from the source migration, never by hand:
--   step 1  20261007000000_profiles_insert_hardening.sql  L54-66, L68-83,
--                                                          L276-322, L324-353
--   step 2  20260517050000_rls_hardening_followups.sql     L196-248
--   step 3  20260520000000_demote_profile_to_user_rpc.sql  L55-132, L141-142
--
-- Order (spec 191 design, "Rollback"):
--   1. The three policies, verbatim from 20261007000000, with spec 164's
--      profiles INSERT comment (the two invitations policies had no comment
--      before 191; drop + create clears 191's). Then spec 164's fail-closed
--      DO blocks, unchanged.
--   2. assert_brand_id_immutable_for_self() from 20260517050000, with its
--      comment.
--   3. demote_profile_to_user(uuid) from 20260520000000, with its grants. It
--      had no comment before 191, so 191's comment is removed.
--   4. Drop assert_demote_not_last_of_role(uuid,text) and
--      auth_profile_is_privileged(), last: the step 1 policies depend on the
--      helper, and the step 2 and 3 bodies call the wrapper.
--
-- Expected afterwards, normalized md5 = md5(regexp_replace(prosrc, '\s+', ' ', 'g')):
--   assert_brand_id_immutable_for_self()  c7318dd854a9a63bc2a7adb7cab3b4f3
--   demote_profile_to_user(uuid)          f77056fbf50ff1478a156ecd8b508f6b
--   assert_not_last_of_role(uuid,text)    0638c51b89305a6c109a146f2feb7f9a (191 never touches it)
--   spec 164 counts 1 / 1 / 1, and both new functions absent.
-- The local dry run of this file (begin; <file without its commit>; checks;
-- rollback;) is recorded in the spec's Implementation notes. If it cannot be
-- repeated through MCP execute_sql before a prod rollback, the post-rollback
-- md5 check above is the proof that the non-ASCII bytes survived that channel.
--
-- VERSION ROW:
--   - 191 applied to prod but NOT yet pushed: after this file commits, also
--       delete from supabase_migrations.schema_migrations
--        where version = '20261109191000';
--     and revert the repo files.
--   - 191 ALREADY pushed: do not run this file as a manual rollback, and
--     never delete the version row of a pushed migration. Ship this body as a
--     new forward migration with a later version instead.
--
-- DEPENDENCIES: if the user_stores follow-up (release proposal X2: the
-- "Admins can manage all store links" policy switched to
-- auth_profile_is_privileged()) has landed, roll it back FIRST: its policy
-- depends on the helper, so step 4 here would fail. The same goes for any
-- later object that references either new function. Check first with:
--   select classid::regclass, objid, deptype from pg_depend
--    where refobjid in ('public.auth_profile_is_privileged()'::regprocedure,
--                       'public.assert_demote_not_last_of_role(uuid,text)'::regprocedure);
--   (expect only the three step 1 policies)
-- ============================================================

begin;

-- Same reason as the migration: DROP/CREATE POLICY take AccessExclusiveLock on
-- public.profiles and public.invitations. Fail fast; a timeout changes nothing.
set local lock_timeout = '5s';

-- ------------------------------------------------------------
-- 1. Policies, verbatim from 20261007000000 (L54-66, L68-83)
-- ------------------------------------------------------------
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
-- 1 (cont). Invitations policies, verbatim from 20261007000000 (L276-322, L324-353)
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


-- ------------------------------------------------------------
-- 2. assert_brand_id_immutable_for_self(), verbatim from 20260517050000
--    (L196-248), comment included. Non-ASCII bytes are intentional.
-- ------------------------------------------------------------
create or replace function public.assert_brand_id_immutable_for_self()
returns trigger
language plpgsql
security invoker
set search_path = public, auth
as $$
begin
  if tg_op = 'UPDATE' and not public.auth_is_super_admin() then
    -- Self-edits: existing Spec 041 contract — message strings are
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
      -- Closes Row J — same-brand role-escalation. brand_id transfers are
      -- already blocked by the policy WITH CHECK + row-level CHECK.
      --
      -- The trigger function is SECURITY INVOKER as of Spec 042 round-4
      -- so `current_user` here reflects the caller's actual Postgres
      -- role. PostgREST authenticated → 'authenticated' (fires);
      -- pgTAP after `reset role` → 'postgres' (skips); migration →
      -- 'postgres' (skips); service_role bearer → 'service_role'
      -- (skips — service_role bypasses RLS but BEFORE triggers do
      -- still fire, so the explicit allowlist matters).
      --
      -- See §13 "Round-4 design revision" for the empirical evidence
      -- (PostgreSQL trigger semantics match a direct SECURITY INVOKER
      -- call — the dev's row-2 probe).
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
  end if;
  return new;
end
$$;

comment on function public.assert_brand_id_immutable_for_self() is
  'Spec 042 round-4 final (extends Spec 041 round-1 fix): rejects any UPDATE that mutates profiles.role for non-super_admin callers in hostile contexts (current_user in authenticated, anon). Function is SECURITY INVOKER as of round-4 so current_user inside the body reflects the caller''s Postgres role; inner helpers (auth.uid, auth_is_super_admin) remain SECURITY DEFINER and read profiles reliably under postgres. Round-3 was SECURITY DEFINER and `current_user` collapsed to postgres, leaving Row J open — see specs/042-rls-hardening-followups.md §"Round-4 BLOCKER" + §13 Round-4 revision for the empirical evidence.';


-- ------------------------------------------------------------
-- 3. demote_profile_to_user(uuid), verbatim from 20260520000000 (L55-132,
--    L141-142). Non-ASCII bytes are intentional. It had no comment before
--    spec 191.
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
  v_caller_id uuid := auth.uid();
  v_demoted   uuid;
begin
  -- (1) Defense-in-depth: refuse when auth.uid() is null. The RPC is
  -- only reachable from authenticated PostgREST sessions in practice
  -- (GRANT EXECUTE is to authenticated only — see below), but
  -- service_role bearers and unset JWT claims can both produce
  -- auth.uid() = null. A null caller can never satisfy the
  -- "caller != target" predicate safely, so refuse fail-closed.
  --
  -- Refusal string is intentionally unified with the self-check below
  -- (`'cannot demote self'`). A distinct `'caller is null'` string would
  -- leak that the auth was missing to a probing caller; the unified
  -- string is the safer surface. pgTAP arm (iv) verifies this contract.
  if v_caller_id is null then
    raise exception using
      errcode = 'P0001',
      message = 'cannot demote self';
  end if;

  -- (2) Role gate. SECURITY DEFINER bypasses RLS, so the inline
  -- `auth_is_privileged()` check is the authorization source of truth.
  -- Mirrors the edge-function `ADMIN_ROLES` set
  -- (admin / master / super_admin) — CLAUDE.md "Edge function role
  -- gates mirror auth_is_privileged()" convention.
  if not public.auth_is_privileged() then
    raise exception using
      errcode = '42501',
      message = 'forbidden';
  end if;

  -- (3) THE GUARD. Stable refusal string parallel to spec 012c's
  -- 'cannot delete self' (delete-user/index.ts:168-173) and spec 031's
  -- 'cannot delete the last super_admin'. Spec 050 AC A.
  if target_user_id = v_caller_id then
    raise exception using
      errcode = 'P0001',
      message = 'cannot demote self';
  end if;

  -- (4) Destructive op. Mirrors the body the previous
  -- demoteProfileToUser helper performed via direct PostgREST
  -- (src/lib/db.ts:2757-2766 pre-spec-050). Both columns must change in
  -- a single UPDATE so (a) profiles_role_brand_consistent CHECK passes
  -- (role='user' allows any brand_id including NULL) and (b) the H5
  -- pre-flight in hard_delete_brand stops counting this row toward the
  -- blocking total. RLS is bypassed by SECURITY DEFINER — this is by
  -- design: the RPC is the new authoritative gate and the surrounding
  -- policies (`super_admin_manage_profiles`,
  -- `assert_brand_id_immutable_for_self`) are now defense-in-depth only.
  update public.profiles
     set role = 'user', brand_id = null
   where id = target_user_id
  returning id into v_demoted;

  -- (5) Target didn't exist. Raise so the client gets a structured
  -- error instead of a silent no-op.
  if not found then
    raise exception using
      errcode = 'P0002',
      message = 'target profile not found';
  end if;

  -- (6) Return the demoted profile's id. Preserves the
  -- `demoteProfileToUser(profileId: string): Promise<string>` contract
  -- at src/lib/db.ts post-wrap.
  return v_demoted;
end;
$$;

comment on function public.demote_profile_to_user(uuid) is null;

revoke execute on function public.demote_profile_to_user(uuid) from public, anon;
grant  execute on function public.demote_profile_to_user(uuid) to authenticated;


-- ------------------------------------------------------------
-- 4. Drop the two spec 191 functions, last.
-- ------------------------------------------------------------
drop function public.assert_demote_not_last_of_role(uuid, text);
drop function public.auth_profile_is_privileged();

commit;
