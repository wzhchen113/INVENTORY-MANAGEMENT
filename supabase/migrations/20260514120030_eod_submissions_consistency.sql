-- ============================================================
-- Spec 020 — EOD per-vendor submissions, round-2 consistency fixes.
--
-- Closes the security-auditor's 4 Critical findings against
-- `20260514120000_eod_submissions_vendor_id.sql` +
-- `20260514120010_staff_submit_eod_v2.sql`. All four were live-PoC
-- verified under `manager@local.test` JWT impersonation
-- (`specs/020-eod-per-vendor-submissions/reviews/security-auditor.md`)
-- and are the **same shape** that spec 019 closed via
-- `20260513120000_inventory_counts_consistency.sql` (the third+fourth
-- recurrence of the
-- `auth_can_see_store(store_id)`-alone-is-sufficient-for-writes lesson).
-- That earlier file is the canonical template for this one.
--
-- Findings closed here:
--
--   C1 (submitted_by forgery via direct PostgREST INSERT). The RLS
--     INSERT policy on `eod_submissions` only gates on
--     `auth_can_see_store(store_id)`; the column has no default and no
--     override, so a hand-crafted INSERT can attribute the row to any
--     user. Closed by a BEFORE INSERT/UPDATE trigger that overrides
--     `new.submitted_by := auth.uid()` unconditionally — same shape as
--     spec 019's `inventory_counts_set_submitted_by` and as spec 016's
--     `report_runs_check_definition_consistency` `ran_by` override.
--     For service-role callers (the staff-app Edge Function) `auth.uid()`
--     returns NULL, which preserves the existing
--     `staff_submit_eod_v2.sql:91-92` "null FK for staff-app users" path
--     (staff-app users have no `profiles` row).
--
--   C2 (cross-store `item_id` spoof via direct entry INSERT). The
--     entries RLS scopes through the parent submission via `EXISTS`,
--     but never asserts that the entry's `inventory_items.store_id`
--     matches the parent `eod_submissions.store_id`. The RPC's
--     transactional path checks this implicitly via the vendor-scoped
--     `update inventory_items where vendor_id = p_vendor_id`, but a
--     direct PostgREST entry INSERT bypasses the RPC entirely. Closed
--     by a BEFORE INSERT/UPDATE trigger on `eod_entries` that
--     re-asserts the relationship.
--
--   C3 (UPDATE allows audit-field rewrite — `submitted_by`,
--     `submitted_at`, `date`, `status`, etc.). Spec 020 Q5 explicitly
--     designs an admin EDIT flow, so we can NOT take spec 019's
--     "drop UPDATE policy entirely" closure. Two layers instead:
--     (a) The C1 override trigger neutralizes `submitted_by` rewrite.
--     (b) The UPDATE policy is locked down to admin/master/super-admin
--         via `auth_is_privileged()`. Store members can no longer
--         rewrite audit fields, but the Cmd UI's admin-only EDIT flow
--         (Q5) is preserved — `useRole()` returns 'admin' for all
--         authed users per CLAUDE.md placeholder, and the underlying
--         `auth_is_privileged()` short-circuits to true for any
--         JWT-claim admin/master/super-admin. The same posture as
--         spec 019's `inventory_counts` would be append-only-and-no-
--         edit; spec 020 differs because Q5 mandates an EDIT path.
--
--   C4 (DELETE allows audit-trail destruction). Append-only posture
--     chosen — submissions are advisory historical snapshots and the
--     frontend never DELETEs them. Drop the DELETE policies entirely;
--     without a policy, RLS denies DELETE under any non-superuser
--     caller. Same posture as spec 019's `inventory_counts` and as
--     spec 020's append-only intent. Store-cascade-delete still works
--     (the cascade runs as the postgres role, not via PostgREST).
--
-- Note on store-cascade-delete and FK cascade from eod_submissions to
-- eod_entries: the existing FK `on delete cascade` (init_schema L130)
-- still works through the cascade path because the cascade runs as
-- the postgres role under a normal admin store-deletion flow, not via
-- PostgREST.
-- ============================================================

-- ─── (1) submitted_by override trigger on eod_submissions ───
-- BEFORE INSERT/UPDATE on `eod_submissions`. The function overrides
-- `submitted_by` with `auth.uid()` regardless of what the client passed.
-- `security invoker` — RLS already gates which rows the caller can see.
-- For service-role callers (the staff-app Edge Function via
-- `staff_submit_eod_v2`) `auth.uid()` returns NULL, which is the right
-- "system" attribution and matches the existing v2 RPC's explicit NULL
-- write at `20260514120010_staff_submit_eod_v2.sql:91-92`.
create or replace function public.eod_submissions_set_submitted_by()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  new.submitted_by := auth.uid();
  return new;
end;
$$;

drop trigger if exists eod_submissions_set_submitted_by_trg
  on public.eod_submissions;
create trigger eod_submissions_set_submitted_by_trg
  before insert or update on public.eod_submissions
  for each row execute function public.eod_submissions_set_submitted_by();

-- ─── (2) cross-store consistency trigger on eod_entries ─────
-- BEFORE INSERT/UPDATE on `eod_entries`. The function reads the
-- parent submission's `store_id` and the entry's `item_id.store_id`
-- and refuses the write if they don't match (or if either lookup
-- fails under the caller's RLS). Raises `42501` so the dispatcher
-- and trigger speak the same error class to the frontend — same
-- pattern as spec 019's `inventory_count_entries_check_store` and
-- spec 016's `report_runs_check_definition_consistency`.
create or replace function public.eod_entries_check_store()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_submission_store_id uuid;
  v_item_store_id       uuid;
begin
  select store_id into v_submission_store_id
    from public.eod_submissions
   where id = new.submission_id;
  if v_submission_store_id is null then
    raise exception 'eod_entries: parent submission not found or not visible'
      using errcode = '42501';
  end if;

  select store_id into v_item_store_id
    from public.inventory_items
   where id = new.item_id;
  if v_item_store_id is null or v_item_store_id is distinct from v_submission_store_id then
    raise exception 'eod_entries: item store mismatch with parent submission'
      using errcode = '42501';
  end if;

  return new;
end;
$$;

drop trigger if exists eod_entries_check_store_trg
  on public.eod_entries;
create trigger eod_entries_check_store_trg
  before insert or update on public.eod_entries
  for each row execute function public.eod_entries_check_store();

-- ─── (3) Lock down UPDATE — admin-only (preserves Q5 EDIT) ────
-- Drop the store-member UPDATE policies on both tables. Spec 020 Q5
-- explicitly designs an admin EDIT flow, so we replace (rather than
-- remove) the UPDATE policy with an admin-gated version. This
-- preserves the user-visible Cmd UI EDIT path while blocking
-- store-member audit-field rewrites (C3).
drop policy if exists "store_member_update_eod_submissions"
  on public.eod_submissions;
drop policy if exists "store_member_update_eod_entries"
  on public.eod_entries;

-- New admin-only UPDATE policy on `eod_submissions`. `auth_is_privileged()`
-- short-circuits to admin/master/super-admin from
-- `20260509000000_multi_brand_schema_rls.sql:235-241`. We still gate on
-- `auth_can_see_store(store_id)` so a privileged caller can't update
-- a submission outside their brand membership.
create policy "admin_update_eod_submissions"
  on public.eod_submissions for update
  using      (public.auth_is_privileged() and public.auth_can_see_store(store_id))
  with check (public.auth_is_privileged() and public.auth_can_see_store(store_id));

-- New admin-only UPDATE policy on `eod_entries`. Scopes through the
-- parent submission's `store_id` (mirrors the existing read/insert
-- policies in `per_store_rls_hardening.sql:87-122`).
create policy "admin_update_eod_entries"
  on public.eod_entries for update
  using (
    public.auth_is_privileged()
    and exists (
      select 1 from public.eod_submissions s
       where s.id = eod_entries.submission_id
         and public.auth_can_see_store(s.store_id)
    )
  )
  with check (
    public.auth_is_privileged()
    and exists (
      select 1 from public.eod_submissions s
       where s.id = eod_entries.submission_id
         and public.auth_can_see_store(s.store_id)
    )
  );

-- ─── (4) Lock down DELETE — append-only ──────────────────────
-- Drop the DELETE policies on both tables. Without a policy, RLS
-- denies DELETE under any non-superuser caller. Submissions are
-- advisory historical snapshots; the frontend never DELETEs them.
-- Store-cascade-delete (stores(id) on delete cascade) still works
-- because the cascade runs as the postgres role, not via PostgREST.
-- The parent->child cascade on `eod_entries.submission_id ON DELETE
-- CASCADE` (init_schema L130) likewise runs as postgres and is
-- unaffected.
drop policy if exists "store_member_delete_eod_submissions"
  on public.eod_submissions;
drop policy if exists "store_member_delete_eod_entries"
  on public.eod_entries;
