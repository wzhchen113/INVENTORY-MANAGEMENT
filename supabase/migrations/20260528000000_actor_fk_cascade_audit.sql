-- ============================================================
-- Spec 066 — Allow profile deletion when audit-trail rows reference it.
--
-- Generalizes the spec 065 fix across every actor FK referencing
-- public.profiles(id). The init schema (20260405000759_init_schema.sql)
-- and several follow-on migrations declared `<actor>_by uuid
-- references profiles(id)` without an ON DELETE clause; the default
-- NO ACTION blocks profile deletion whenever ANY dependent audit-
-- trail row exists in any of the 11 tables in scope. This is the
-- same shape spec 065 closed for eod_submissions
-- (20260527000000_eod_submissions_submitted_by_on_delete_set_null.sql);
-- spec 066 closes the remaining 10 instances and restores the
-- prep_recipes FK that 20260502071736_remote_schema.sql:43 dropped
-- on 2026-05-02 (never re-added).
--
-- Sibling reference shapes:
--   - inventory_counts.submitted_by already SET NULL
--     (20260513000000_inventory_counts.sql:76).
--   - eod_submissions.submitted_by SET NULL after spec 065
--     (20260527000000_eod_submissions_submitted_by_on_delete_set_null.sql).
--
-- Out of scope (intentional): user_stores.user_id stays ON DELETE
-- CASCADE — join-table semantic. eod_submissions.submitted_by and
-- inventory_counts.submitted_by are already SET NULL and untouched
-- here; they appear in the actor_fk_cascade_audit.test.sql probe as
-- positive-control regression guards.
--
-- Trigger orthogonality. None of the 11 tables in scope have a
-- BEFORE INSERT/UPDATE trigger that rewrites the actor column the
-- way eod_submissions_set_submitted_by_trg
-- (20260514120030_eod_submissions_consistency.sql:78-94) does for
-- eod_submissions. The closest neighbor is
-- report_runs_check_definition_consistency_trg, which rewrites
-- new.ran_by := auth.uid() on direct INSERT — but FK cascade on
-- profile DELETE is a system-level UPDATE issued by the referential-
-- action machinery that does NOT invoke user-visible BEFORE UPDATE
-- row triggers on the affected column. Even if it did, auth.uid()
-- under the postgres cascade role is NULL, so the effective result
-- would still be <actor> = NULL. No trigger changes required.
--
-- No RLS policy references any of the 11 actor columns in its
-- USING or WITH CHECK clause; nulling does not affect policy
-- evaluation. No realtime publication membership change; the
-- "docker restart supabase_realtime_*" ritual does NOT apply.
--
-- Idempotency. Every `drop constraint if exists` makes this
-- migration re-apply-safe on a database that already has the
-- canonical-named FK. A renamed constraint no-ops the drop; the
-- subsequent add re-creates the canonical name.
-- ============================================================

begin;

-- audit_log.user_id: textbook audit-actor null-out.
alter table public.audit_log
  drop constraint if exists audit_log_user_id_fkey;
alter table public.audit_log
  add constraint audit_log_user_id_fkey
    foreign key (user_id) references public.profiles(id) on delete set null;

-- flags.resolved_by: resolver pointer; null out on delete.
alter table public.flags
  drop constraint if exists flags_resolved_by_fkey;
alter table public.flags
  add constraint flags_resolved_by_fkey
    foreign key (resolved_by) references public.profiles(id) on delete set null;

-- flags.user_id: submitter pointer; flag content survives deletion.
alter table public.flags
  drop constraint if exists flags_user_id_fkey;
alter table public.flags
  add constraint flags_user_id_fkey
    foreign key (user_id) references public.profiles(id) on delete set null;

-- inventory_items.last_updated_by: audit attribution; null out on delete.
alter table public.inventory_items
  drop constraint if exists inventory_items_last_updated_by_fkey;
alter table public.inventory_items
  add constraint inventory_items_last_updated_by_fkey
    foreign key (last_updated_by) references public.profiles(id) on delete set null;

-- pos_imports.imported_by: audit attribution; null out on delete.
alter table public.pos_imports
  drop constraint if exists pos_imports_imported_by_fkey;
alter table public.pos_imports
  add constraint pos_imports_imported_by_fkey
    foreign key (imported_by) references public.profiles(id) on delete set null;

-- prep_recipes.created_by: RESTORE missing FK (dropped 2026-05-02 by
-- 20260502071736_remote_schema.sql:43, never re-added). Column has
-- been NULL-by-default since the drop; src/lib/db.ts has zero
-- writes to it. Prod orphan check returned 0 rows pre-PR. See spec
-- 066 design §3 for the full analysis.
alter table public.prep_recipes
  drop constraint if exists prep_recipes_created_by_fkey;
alter table public.prep_recipes
  add constraint prep_recipes_created_by_fkey
    foreign key (created_by) references public.profiles(id) on delete set null;

-- purchase_orders.created_by: audit attribution; null out on delete.
alter table public.purchase_orders
  drop constraint if exists purchase_orders_created_by_fkey;
alter table public.purchase_orders
  add constraint purchase_orders_created_by_fkey
    foreign key (created_by) references public.profiles(id) on delete set null;

-- purchase_orders.received_by: audit attribution; null out on delete.
alter table public.purchase_orders
  drop constraint if exists purchase_orders_received_by_fkey;
alter table public.purchase_orders
  add constraint purchase_orders_received_by_fkey
    foreign key (received_by) references public.profiles(id) on delete set null;

-- report_definitions.created_by: creator pointer; null out on delete.
alter table public.report_definitions
  drop constraint if exists report_definitions_created_by_fkey;
alter table public.report_definitions
  add constraint report_definitions_created_by_fkey
    foreign key (created_by) references public.profiles(id) on delete set null;

-- report_runs.ran_by: runner pointer; run output is the historical record.
alter table public.report_runs
  drop constraint if exists report_runs_ran_by_fkey;
alter table public.report_runs
  add constraint report_runs_ran_by_fkey
    foreign key (ran_by) references public.profiles(id) on delete set null;

-- waste_log.logged_by: waste records are historical; logger pointer can null out.
alter table public.waste_log
  drop constraint if exists waste_log_logged_by_fkey;
alter table public.waste_log
  add constraint waste_log_logged_by_fkey
    foreign key (logged_by) references public.profiles(id) on delete set null;

commit;
