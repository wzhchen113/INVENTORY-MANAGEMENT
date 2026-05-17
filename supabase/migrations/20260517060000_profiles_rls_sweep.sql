-- ============================================================
-- Spec 043: Profiles RLS sweep — cross-brand SELECT + DELETE
--           lockdown.
--
-- Closes the two remaining cross-brand admin attack surfaces on
-- public.profiles. Spec 042 closed UPDATE (and the cross-user
-- trigger broadening); this spec closes SELECT (information
-- disclosure) and DELETE (destructive action).
--
-- Behaviour after this migration:
--   - SELECT: super_admin sees every profile in every brand;
--     admin/master sees own-brand profiles; every authed user
--     can still read their OWN profile via the `id = auth.uid()`
--     self-arm.
--   - DELETE: super_admin can delete any profile (subject to the
--     spec 031 last-of-role guard); admin/master can delete
--     own-brand profiles only. Self-DELETE is independently
--     blocked by the spec 041 BEFORE-DELETE trigger
--     (profiles_self_delete_lock), unchanged here.
--
-- Strictly additive in the rollback sense — rolling back this
-- migration restores the brand-blind admin SELECT and DELETE
-- policies. Lockstep contract with Spec 041 / 042: rolling back
-- 043 alone reopens cross-brand SELECT + DELETE but leaves the
-- Spec 041 self-edit triggers + Spec 042 UPDATE tightening + Spec
-- 042 trigger broadening in force. Rolling back 042 alone would
-- reopen UPDATE; rolling back 041 alone would reopen the helper
-- semantics 042/043 depend on. Roll back the three in reverse
-- order (043 → 042 → 041) if a full rollback is required.
--
-- Companion fixture amendment required: spec 043 also patches
-- supabase/tests/rls_hardening_followups.test.sql arm (9) — three
-- lines (`reset role; select set_config('request.jwt.claims', '',
-- true);`) inserted before the arm-9 verification SELECT so the
-- inspection step bypasses RLS. Pre-043 the verification SELECT
-- ran under the brand-A admin JWT and admitted the cross-brand
-- row via the brand-blind admin SELECT arm; post-043 the
-- tightened SELECT policy returns 0 rows for that read and the
-- assertion fails. See specs/043-profiles-rls-sweep.md §
-- "Pre-existing pgTAP test interaction (Open question 1)".
--
-- Depends on Spec 041 (auth_can_see_brand semantics) and Spec 042
-- (mirror pattern for profile UPDATE policy). Migration timestamp
-- ordering (20260517060000 > 20260517050000) guarantees correct
-- apply order under the supabase CLI.
--
-- See specs/043-profiles-rls-sweep.md §"Backend / architecture
-- design".
-- ============================================================


-- ─── Pre-flight (belt-and-suspenders — mirrors Spec 041/042) ──
-- The profiles_role_brand_consistent CHECK (012a) already blocks
-- admin/master rows with NULL brand_id at the row level. We
-- re-assert that invariant here as defense-in-depth: an operator
-- could have temporarily disabled the CHECK for a backfill
-- between 042 and 043 deploy. Without this guard, the new SELECT
-- and DELETE USING clauses would read brand_id NULL for those
-- rows and silently strip them from cross-admin visibility
-- (other than super_admin, who short-circuits via
-- auth_is_super_admin). raise EXCEPTION — fail-closed per the
-- same contract as Spec 041/042 pre-flights.
do $$
begin
  if exists (
    select 1 from public.profiles
     where role in ('admin','master') and brand_id is null
  ) then
    raise exception
      '043: pre-flight failed: admin/master profile(s) with NULL brand_id exist; resolve before applying';
  end if;
end $$;


-- ============================================================
-- (1) "Admins can read all profiles" SELECT — tighten the admin
--     arm to own-brand rows via auth_can_see_brand(brand_id).
--     Self-arm preserved (id = auth.uid()) so every authed
--     caller can still read their own profile via this policy
--     too — duplicates the still-present "Users can read own
--     profile" policy but matches the Spec 042 self-arm pattern
--     on the UPDATE policy. super_admin retains cross-brand
--     visibility via the auth_is_super_admin short-circuit
--     inside auth_can_see_brand.
--
-- Pre-043 USING (from remote_schema.sql:381-386):
--   ((((auth.jwt() -> 'app_metadata'::text) ->> 'role'::text) =
--      ANY (ARRAY['admin'::text, 'master'::text]))
--      OR (id = auth.uid()))
-- Brand-blind admin arm + self-arm. Any admin/master can
-- enumerate every profile in every brand — the cross-brand
-- information-disclosure leak spec 043 closes.
-- ============================================================
drop policy if exists "Admins can read all profiles" on public.profiles;

create policy "Admins can read all profiles"
  on public.profiles for select
  using (
    (public.auth_is_privileged() and public.auth_can_see_brand(brand_id))
    or id = auth.uid()
  );

comment on policy "Admins can read all profiles" on public.profiles is
  'Spec 043: admin/master arm limited to own brand via auth_can_see_brand. Self-arm preserved. super_admin short-circuits via auth_is_super_admin inside auth_can_see_brand.';


-- ============================================================
-- (2) "Admins can delete profiles" DELETE — tighten the admin
--     arm to own-brand rows. No self-arm: self-DELETE is
--     independently blocked by the Spec 041
--     profiles_self_delete_lock BEFORE-DELETE trigger; adding
--     an `id = auth.uid()` arm here would admit the DELETE
--     through RLS only for the trigger to reject it (confusing
--     but not unsafe). Cleaner to keep the policy strict and
--     let the trigger be the final authority on self-DELETE.
--
-- Pre-043 USING (from remote_schema.sql:372-377):
--   ((((auth.jwt() -> 'app_metadata'::text) ->> 'role'::text) =
--      ANY (ARRAY['admin'::text, 'master'::text])))
-- Brand-blind admin arm; no self-arm. Any admin/master can
-- delete any profile in any brand (subject to Spec 041's
-- BEFORE-DELETE trigger blocking SELF-delete) — the cross-brand
-- destructive-action leak spec 043 closes.
-- ============================================================
drop policy if exists "Admins can delete profiles" on public.profiles;

create policy "Admins can delete profiles"
  on public.profiles for delete
  using (
    public.auth_is_privileged() and public.auth_can_see_brand(brand_id)
  );

comment on policy "Admins can delete profiles" on public.profiles is
  'Spec 043: admin/master arm limited to own brand via auth_can_see_brand. No self-arm — self-DELETE independently blocked by profiles_self_delete_lock trigger (spec 041). super_admin short-circuits via auth_is_super_admin inside auth_can_see_brand.';
