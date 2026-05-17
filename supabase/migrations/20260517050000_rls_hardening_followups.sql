-- ============================================================
-- Spec 042: RLS hardening followups
--
-- Three policy tightenings + one trigger broadening. Closes the
-- three carry-forward findings from Spec 041's security audit (1
-- High, 2 Medium):
--
--   (1) order_schedule WRITE policy missing the per-store gate —
--       cross-brand admin could INSERT/UPDATE/DELETE any row.
--   (2) "Admins can update any profile" missing the brand gate —
--       cross-brand admin could PATCH any profile column.
--   (3) "Users can update own profile" missing WITH CHECK —
--       defense-in-depth against post-write row-key forgery.
--
-- This migration also extends the Spec 041 trigger
-- (assert_brand_id_immutable_for_self) so the role-write lockdown
-- fires for ALL UPDATEs by non-super_admin callers — not just
-- self-UPDATEs. Closes Row J of the Q1 matrix: a brand-A admin
-- promoting another brand-A user to super_admin. The brand_id
-- check stays self-only because the new WITH CHECK on policy (2)
-- plus the existing profiles_role_brand_consistent row-level
-- CHECK already block cross-user brand_id transfers.
--
-- Depends on Spec 041 (auth_can_see_store brand-arm tightening).
-- Migration timestamp ordering (20260517050000 > 20260517040000)
-- guarantees correct apply order under the supabase CLI. Rolling
-- back Spec 041 in prod REQUIRES rolling back Spec 042 in lockstep
-- — rolling back just 042 would re-open the cross-brand write
-- paths without disturbing the 041-tightened READ path.
--
-- See specs/042-rls-hardening-followups.md §10 (migration shape)
-- and §13 (final architect-approved trigger body, round-4,
-- 2026-05-17 — SECURITY INVOKER + `current_user`-based
-- discriminator; round-3's SECURITY DEFINER form was empirically
-- refuted in the §"Round-4 BLOCKER" section).
-- ============================================================


-- ─── Pre-flight (defense-in-depth — mirrors Spec 041) ──────────
-- Spec 041's pre-flight already re-asserts the invariant from the
-- profiles_role_brand_consistent CHECK installed by 012a. We
-- re-assert it again here as belt-and-suspenders: an operator
-- could have temporarily disabled the CHECK for a backfill between
-- 041 and 042 deploy. Without this guard, the tightened "Admins
-- can update any profile" policy would read brand_id NULL for
-- those rows and silently strip cross-brand admin visibility.
--
-- raise EXCEPTION (not warning) — fail-closed per the same
-- contract as Spec 041's pre-flight.
do $$
begin
  if exists (
    select 1 from public.profiles
     where role in ('admin','master') and brand_id is null
  ) then
    raise exception
      '042: pre-flight failed: admin/master profile(s) with NULL brand_id exist; resolve before applying';
  end if;
end $$;


-- ============================================================
-- (1) order_schedule WRITE policy — tighten the admin arm to
--     the caller's own brand via auth_can_see_store(store_id).
--
-- Drop + recreate, idempotent. Strict superset for super_admin
-- (auth_can_see_store short-circuits on auth_is_super_admin).
-- Brand-admin loses cross-brand INSERT/UPDATE/DELETE; same-brand
-- INSERT/UPDATE/DELETE continues to admit.
-- ============================================================
drop policy if exists "Admins can write order_schedule" on public.order_schedule;

create policy "Admins can write order_schedule"
  on public.order_schedule for all
  using      (public.auth_is_privileged() and public.auth_can_see_store(store_id))
  with check (public.auth_is_privileged() and public.auth_can_see_store(store_id));

comment on policy "Admins can write order_schedule" on public.order_schedule is
  'Spec 042: admins limited to own-brand stores via auth_can_see_store; super_admin retains cross-brand via auth_is_super_admin short-circuit.';


-- ============================================================
-- (2) "Admins can update any profile" — tighten the admin arm
--     to target rows in the caller's own brand via
--     auth_can_see_brand(brand_id). Self-arm preserved so a
--     regular user can still PATCH their own profile under this
--     policy (matches the existing semantics).
--
-- USING and WITH CHECK both reference the row's brand_id. USING
-- is evaluated against the OLD row (pre-UPDATE); WITH CHECK
-- against the NEW row (post-UPDATE). The WITH CHECK clause is
-- what blocks cross-user brand-transfer attacks (Row F of the
-- spec Q1 matrix — brand-A admin moving another user FROM brand
-- A TO brand B): NEW.brand_id is brand B, admin is in brand A,
-- WITH CHECK rejects.
-- ============================================================
drop policy if exists "Admins can update any profile" on public.profiles;

create policy "Admins can update any profile"
  on public.profiles for update
  using (
    (public.auth_is_privileged() and public.auth_can_see_brand(brand_id))
    or (id = auth.uid())
  )
  with check (
    (public.auth_is_privileged() and public.auth_can_see_brand(brand_id))
    or (id = auth.uid())
  );

comment on policy "Admins can update any profile" on public.profiles is
  'Spec 042: admin/master arm limited to own brand via auth_can_see_brand. Self-arm preserved. WITH CHECK mirrors USING — no brand-transfer during UPDATE.';


-- ============================================================
-- (3) "Users can update own profile" — add WITH CHECK mirroring
--     the USING clause. Defense-in-depth against post-write
--     row-key forgery (UPDATE ... SET id = <other-uuid>). No
--     current attack chain reaches this gap, but adding the
--     clause closes the structural weakness security-auditor
--     flagged across Spec 041 rounds 1-4.
-- ============================================================
drop policy if exists "Users can update own profile" on public.profiles;

create policy "Users can update own profile"
  on public.profiles for update
  using      (id = auth.uid())
  with check (id = auth.uid());

comment on policy "Users can update own profile" on public.profiles is
  'Spec 042: WITH CHECK added to block row-key forgery (UPDATE ... SET id = <other-uuid>). Defense-in-depth — no current attack chain reaches this gap.';


-- ============================================================
-- (4) Trigger broadening — assert_brand_id_immutable_for_self()
--
-- Spec 041 installed this trigger to block self-UPDATE of
-- profiles.brand_id and profiles.role for non-super_admin
-- callers. Spec 042 extends it: the role check now fires for
-- ALL UPDATEs by non-super_admin, not just self-UPDATEs. Closes
-- Row J of the spec Q1 matrix — brand-A admin promoting another
-- brand-A user to super_admin (the tightened admin policy admits
-- this because the target's brand_id is still brand A, but the
-- promotion is still a privilege-escalation attack).
--
-- The brand_id check STAYS self-only because:
--   (a) cross-user brand_id transfers are already blocked by the
--       new WITH CHECK on policy (2) — NEW.brand_id of foreign
--       brand fails the brand check for a non-super_admin caller.
--   (b) the row-level profiles_role_brand_consistent CHECK
--       blocks brand_id=NULL unless role='super_admin' is also
--       being set, and setting role='super_admin' would itself
--       be rejected by the new role branch below.
--
-- Message-string contract:
--   - Self-edit branch preserves the EXACT Spec 041 strings so
--     supabase/tests/auth_can_see_store_brand_scope.test.sql
--     arms 7-8 continue to pass:
--       'brand_id is read-only for self-edits (super_admin only)'
--       'role is read-only for self-edits (super_admin only)'
--   - Cross-user branch uses a DISTINCT new string so the test
--     for arm 13 of the Spec 042 plan can disambiguate the two
--     code paths:
--       'role changes require super_admin'
--
-- create-or-replace-function preserves the trigger binding
-- (profiles_self_brand_lock). No drop trigger / create trigger
-- needed.
-- ============================================================
-- SECURITY mode: INVOKER (Spec 042 round-4). The round-3 body was
-- SECURITY DEFINER, which collapsed `current_user` to the function
-- owner (`postgres`) inside the body and made the
-- `current_user in ('authenticated', 'anon')` guard unreachable
-- from any caller — leaving Row J (same-brand role-escalation)
-- open. Under SECURITY INVOKER, `current_user` reflects the
-- caller's actual Postgres role: PostgREST authenticated →
-- 'authenticated' (fires); pgTAP after `reset role` → 'postgres'
-- (skips); migration → 'postgres' (skips); service_role bearer →
-- 'service_role' (skips — allowlist excludes it). Inner helpers
-- `auth.uid()` and `public.auth_is_super_admin()` remain SECURITY
-- DEFINER and continue to read profiles under the function
-- owner's identity, independent of this trigger's mode.
--
-- Empirical verification of the SECURITY INVOKER current_user
-- semantics (run via /tmp/probe_round4_option1_v2.sql, 2026-05-17):
--   ── PROBE A: postgres role direct ──
--   NOTICE:  PROBE: current_user=postgres session_user=postgres
--   ── PROBE B: authenticated role with JWT impersonation ──
--   NOTICE:  PROBE: current_user=authenticated session_user=postgres
--   ── PROBE C: after reset role (pgTAP fixture pattern) ──
--   NOTICE:  PROBE: current_user=postgres session_user=postgres
-- All three probes match the expected outcome in spec §13
-- Round-4 design revision.
--
-- See spec/042 §"Round-4 BLOCKER" + §13 Round-4 revision for the
-- full rationale and risk register.
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
