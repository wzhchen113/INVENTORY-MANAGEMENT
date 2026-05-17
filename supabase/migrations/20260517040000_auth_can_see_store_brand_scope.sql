-- ============================================================
-- Spec 041: Brand-scoped per-store visibility
--
-- Redefines public.auth_can_see_store(p_store_id uuid) so the
-- admin/master OR-arm tightens to the caller's own brand. Before
-- this migration, any caller whose JWT app_metadata.role was in
-- ('admin','master') passed for every store row across every brand
-- — that was the cross-brand leak Bobby (a brand-admin) hit on prod
-- (TitleBar store picker + raw PostgREST reads). See
-- specs/041-brand-scoped-store-visibility.md.
--
-- New three-arm semantics:
--   (i)   super_admin (profiles.role)               → sees every store
--   (ii)  admin/master JWT + own-brand store        → sees store
--          (gated by public.auth_can_see_brand(s.brand_id) which
--           returns true iff caller is super_admin OR caller's
--           profiles.brand_id matches s.brand_id)
--   (iii) any other caller (incl. role='user')      → sees store iff
--          a user_stores row exists for (auth.uid(), store_id)
--
-- The signature, language, volatility, security context, and
-- search_path are byte-identical to the 012a definition at
-- supabase/migrations/20260509000000_multi_brand_schema_rls.sql:216.
-- Only the body tightens. Every RLS policy and SECURITY DEFINER
-- RPC that already calls this helper picks up the tighter
-- truthiness with no policy or RPC body changes required.
--
-- See spec §1 (function diff), §2 (cascade table list), and §9
-- (pgTAP plan at supabase/tests/auth_can_see_store_brand_scope.test.sql).
--
-- ─── Profile column-write lockdown (added per review-round 1) ──
-- This migration also installs a BEFORE-UPDATE trigger on
-- public.profiles that prevents non-super_admin callers from
-- self-modifying the two security-load-bearing columns:
--   - profiles.brand_id (now the gate for the admin/master arm
--     of auth_can_see_store; a self-PATCH would defeat the entire
--     spec 041 tightening — security-auditor live-verified)
--   - profiles.role     (defense-in-depth — a self-promotion from
--     admin to super_admin would be game-over)
--
-- Without this trigger, the pre-existing "Users can update own
-- profile" RLS policy at
-- supabase/migrations/20260502071736_remote_schema.sql:417-422
-- has no `with check` clause restricting which columns may be
-- self-written, so a brand-admin could PATCH /rest/v1/profiles?id=eq.<self>
-- with {"brand_id": "<any-brand>"} and immediately regain full
-- cross-brand access via the now-tightened helper. Spec 041
-- promotes these columns to a security boundary; the trigger
-- locks them down. super_admin callers retain the ability to
-- change other users' brand_id / role through the
-- super_admin_manage_profiles policy in 012a.
-- ============================================================


-- ─── Pre-flight (belt-and-suspenders for the 012a CHECK) ─────
-- The profiles_role_brand_consistent CHECK installed by 012a
-- (supabase/migrations/20260509000000_multi_brand_schema_rls.sql:341-348)
-- already prevents admin/master profiles from having NULL
-- brand_id at the row level. We re-assert the invariant here as a
-- defensive fail-closed check so the migration REFUSES to apply
-- if the structural invariant has somehow drifted (e.g. an
-- operator disabled the CHECK for a one-off backfill and forgot
-- to re-enable, then a stray UPDATE landed). Without this guard,
-- the new helper would silently strip such an admin's store
-- visibility — operationally invisible until the brand-admin
-- complained.
--
-- raise EXCEPTION (not warning) per the architect's design in
-- spec §0 Q4 — fail-closed is the contract. (The earlier draft
-- of this migration used `raise warning`; the review round
-- flagged that as contract drift since the spec body says
-- "the migration refuses to apply", and a warning is invisible
-- in a successful deploy log.) See spec §0 Q4 (lines 354-380)
-- for the rationale.
do $$
begin
  if exists (
    select 1 from public.profiles
     where role in ('admin','master') and brand_id is null
  ) then
    raise exception
      '041: pre-flight failed: admin/master profile(s) with NULL brand_id exist; resolve before applying';
  end if;
end $$;


-- ─── Redefine public.auth_can_see_store(uuid) ────────────────
create or replace function public.auth_can_see_store(p_store_id uuid)
returns boolean
language sql stable security definer set search_path = public, auth as $$
  select
    public.auth_is_super_admin()
    or (
      public.auth_is_admin()
      and exists (
        select 1
          from public.stores s
         where s.id = p_store_id
           and public.auth_can_see_brand(s.brand_id)
      )
    )
    or exists (
      select 1
        from public.user_stores
       where user_id = auth.uid()
         and store_id = p_store_id
    );
$$;


-- Mirror the explicit grant pattern from auth_can_see_brand /
-- auth_is_super_admin / auth_is_privileged in 012a (:241-243).
-- The helper has been callable today via the implicit PUBLIC
-- EXECUTE default — this line just makes the grant state
-- explicit and byte-aligned with the sibling helpers. Idempotent.
grant execute on function public.auth_can_see_store(uuid) to authenticated, anon;


-- Documentation for future maintainers. Pins the three-arm
-- semantics to spec 041 so the next architect doesn't have to
-- re-derive the visibility model from the migration history.
comment on function public.auth_can_see_store(uuid) is
  'spec 041: super_admin sees all stores; admin/master sees stores in their own brand (via auth_can_see_brand on stores.brand_id); other roles see only stores granted via user_stores.';


-- ============================================================
-- Profile column-write lockdown — assert_brand_id_immutable_for_self()
--
-- Installed in response to security-auditor's live-verified
-- privilege-escalation finding on the first round of spec 041:
-- a brand-admin could PATCH their own profiles.brand_id to a
-- foreign brand and regain full cross-brand access via the
-- now-tightened helper. The trigger runs BEFORE UPDATE on
-- public.profiles and raises if a non-super_admin attempts to
-- change brand_id or role on their OWN row.
--
-- Why a trigger rather than a tighter RLS WITH CHECK clause?
-- - The existing "Users can update own profile" policy at
--   supabase/migrations/20260502071736_remote_schema.sql:417-422
--   has no `with check` clause; adding one would require a
--   `drop policy if exists` + recreate, which is invasive and
--   would touch a policy outside this spec's scope. A trigger
--   is additive, scoped to the exact two columns at risk, and
--   mirrors the existing user_stores_brand_match trigger
--   pattern from 012a (:357-381).
-- - The trigger fires regardless of which policy admitted the
--   UPDATE, so it also catches the "Admins can update any
--   profile" path when a brand-admin patches their own row
--   under that policy (the policy permits both id=auth.uid()
--   and admin/master role, the row predicate doesn't matter).
--
-- super_admin bypass: super_admin callers can change another
-- user's brand_id or role through the
-- super_admin_manage_profiles policy in 012a, and this trigger
-- explicitly checks auth_is_super_admin() to permit those
-- writes. The bypass is a profile-row check (profiles.role =
-- 'super_admin' for auth.uid()), NOT a JWT check, so it cannot
-- be forged.
--
-- Self-edit detection: the trigger only fires the lockdown
-- branch when old.id = auth.uid(). An admin/super_admin
-- updating ANOTHER user's profile through the admin policies
-- is unaffected by this trigger. (auth.uid() returns NULL for
-- the postgres superuser, so seed/migration UPDATEs run under
-- the postgres role are also unaffected — old.id = NULL is
-- never true.)
-- ============================================================
create or replace function public.assert_brand_id_immutable_for_self()
returns trigger
language plpgsql
security definer
set search_path = public, auth
as $$
begin
  -- Only enforce on self-edits where the security-load-bearing
  -- columns are actually changing. super_admin is exempt — they
  -- can change any user's brand_id or role through the
  -- super_admin_manage_profiles policy.
  if tg_op = 'UPDATE'
     and old.id = auth.uid()
     and not public.auth_is_super_admin() then
    if old.brand_id is distinct from new.brand_id then
      raise exception
        'brand_id is read-only for self-edits (super_admin only)';
    end if;
    if old.role is distinct from new.role then
      raise exception
        'role is read-only for self-edits (super_admin only)';
    end if;
  end if;
  return new;
end
$$;

drop trigger if exists profiles_self_brand_lock on public.profiles;
create trigger profiles_self_brand_lock
  before update on public.profiles
  for each row
  execute function public.assert_brand_id_immutable_for_self();

comment on function public.assert_brand_id_immutable_for_self() is
  'spec 041 (review-round 1 fix): rejects self-UPDATE of profiles.brand_id or profiles.role for non-super_admin callers. Closes a privilege-escalation chain where a brand-admin could PATCH their own brand_id to gain cross-brand visibility via the tightened auth_can_see_store helper.';


-- ============================================================
-- Delete-path lockdown — assert_profile_self_delete_blocked()
--
-- Installed in response to security-auditor's review-round 2
-- finding: the BEFORE-UPDATE trigger above does not cover the
-- DELETE+INSERT bypass. A brand-admin (JWT app_metadata.role =
-- 'admin') can DELETE their own profile row (permitted by the
-- existing "Admins can delete profiles" policy at
-- supabase/migrations/20260502071736_remote_schema.sql) and then
-- INSERT a fresh row at the same auth.uid() with foreign brand_id
-- or role='super_admin' (permitted by the existing self-INSERT
-- policy). The end-state is identical to the round-1 UPDATE
-- attack — full cross-brand visibility AND, in the role variant,
-- same-session super_admin self-escalation (auth_is_super_admin()
-- reads profiles.role server-side, so no JWT refresh needed).
--
-- Fix: a BEFORE-DELETE trigger that mirrors the UPDATE trigger
-- pattern above. Blocks self-DELETE for non-super_admin callers.
-- The companion INSERT path needs no separate guard — the PK
-- constraint on profiles.id + the FK to auth.users.id together
-- make a standalone self-INSERT (without first deleting the
-- existing row) impractical: PK collision blocks the second
-- INSERT while the original row exists, so the attack chain
-- requires the DELETE to succeed first. Blocking the DELETE
-- closes the chain at step 1.
--
-- super_admin retains the ability to DELETE any profile,
-- including their own — that path is independently gated by the
-- spec 031 last-of-role guard (public.assert_not_last_of_role),
-- which the delete-user edge function calls before any
-- destructive op.
-- ============================================================
create or replace function public.assert_profile_self_delete_blocked()
returns trigger
language plpgsql
security definer
set search_path = public, auth
as $$
begin
  -- Block self-delete by non-super_admin. Closes the DELETE+INSERT
  -- escalation path that bypasses profiles_self_brand_lock (the UPDATE
  -- trigger). Super_admin can still delete any profile (including
  -- their own, though that's gated upstream by the
  -- assert_not_last_of_role guard from spec 031).
  if old.id = auth.uid() and not public.auth_is_super_admin() then
    raise exception 'profile self-delete is not permitted (use admin delete flow)';
  end if;
  return old;
end
$$;

drop trigger if exists profiles_self_delete_lock on public.profiles;
create trigger profiles_self_delete_lock
  before delete on public.profiles
  for each row
  execute function public.assert_profile_self_delete_blocked();

comment on function public.assert_profile_self_delete_blocked() is
  'Spec 041 round-2 fix: blocks the DELETE+INSERT escalation chain that bypasses profiles_self_brand_lock.';


-- ============================================================
-- Truncate-path lockdown — REVOKE TRUNCATE on public.profiles
--
-- Installed in response to security-auditor's review-round 3
-- live-verified Critical: TRUNCATE+INSERT bypasses BOTH the
-- round-1 UPDATE trigger (profiles_self_brand_lock) AND the
-- round-2 DELETE trigger (profiles_self_delete_lock) because
-- TRUNCATE does not fire row-level triggers — it has its own
-- TRUNCATE statement-level trigger event class (documented
-- Postgres semantics). A brand-admin (JWT app_metadata.role =
-- 'admin') could TRUNCATE public.profiles CASCADE (clearing the
-- PK collision) and then INSERT a fresh row at auth.uid() with
-- role='super_admin' and any brand_id, reaching the same
-- end-state as the round-1 UPDATE and round-2 DELETE+INSERT
-- attacks — full cross-brand visibility AND same-session
-- super_admin self-escalation.
--
-- Why REVOKE rather than a BEFORE TRUNCATE trigger? Both close
-- the chain at step 1, but the REVOKE is the minimum surface:
--   - Supabase's default grants include TRUNCATE on every public
--     table to `authenticated` and `anon`. No legitimate client
--     flow calls TRUNCATE on profiles (verified: zero call sites
--     across `src/`, `supabase/functions/`, and the migration
--     history). Removing the privilege closes the attack chain
--     before the trigger layer is even reached.
--   - service_role retains TRUNCATE (separate grant audience),
--     so migrations and seed flows that run under service_role
--     or the postgres superuser are unaffected. The postgres
--     superuser bypasses all grants regardless.
--   - The round-1 and round-2 triggers remain the verb-bound
--     defenses for UPDATE and DELETE. The REVOKE is the
--     verb-bound defense for TRUNCATE — together they cover the
--     three "same end-state, different verb" attack paths the
--     security audit identified across rounds 1, 2, and 3.
--
-- See spec 041 ## Profile column-write lockdown — ### Truncate-path
-- lockdown for the rationale. Idempotent — re-running REVOKE on
-- a non-granted role is a no-op.
-- ============================================================
revoke truncate on public.profiles from authenticated, anon;
