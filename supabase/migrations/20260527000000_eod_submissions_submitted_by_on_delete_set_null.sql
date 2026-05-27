-- ============================================================
-- Spec 065 — Allow profile deletion when eod_submissions rows reference it.
--
-- The init schema declared `submitted_by uuid references profiles(id)` with
-- no ON DELETE clause, defaulting to NO ACTION. That blocks profile deletion
-- whenever a dependent eod_submissions row exists, surfacing in
-- supabase/tests/auth_can_see_store_brand_scope.test.sql arm (12) where the
-- teardown `delete from profiles where id = manager_id` fails with an FK
-- violation.
--
-- The sibling audit-trail table `inventory_counts.submitted_by`
-- (20260513000000_inventory_counts.sql:76) already has ON DELETE SET NULL.
-- This migration brings eod_submissions in line so historical EOD records
-- are preserved (with NULL submitted_by indicating the original submitter
-- has been removed) and profile deletion is not blocked on audit-trail
-- cleanup.
--
-- Trigger orthogonality. The eod_submissions_set_submitted_by_trg trigger
-- (spec 020 round-2, 20260514120030_eod_submissions_consistency.sql:78-94)
-- fires BEFORE INSERT OR UPDATE on eod_submissions and rewrites
-- new.submitted_by := auth.uid(). FK cascade on profile DELETE is a
-- system-level UPDATE issued by the referential-action machinery — it does
-- NOT invoke user-visible BEFORE UPDATE row triggers for the affected
-- column. Even if it did, auth.uid() under the postgres cascade role is
-- NULL, so the effective result would still be submitted_by = NULL. No
-- trigger changes required.
--
-- No RLS policy references submitted_by; nulling does not affect policy
-- evaluation. No realtime publication membership change; the
-- "docker restart supabase_realtime_*" ritual does NOT apply.
-- ============================================================

begin;

alter table public.eod_submissions
  drop constraint if exists eod_submissions_submitted_by_fkey;

alter table public.eod_submissions
  add constraint eod_submissions_submitted_by_fkey
    foreign key (submitted_by) references public.profiles(id) on delete set null;

commit;
