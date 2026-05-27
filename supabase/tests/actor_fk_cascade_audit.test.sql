-- supabase/tests/actor_fk_cascade_audit.test.sql
--
-- Spec 066 — pgTAP probe that asserts every actor FK referencing
-- public.profiles(id) has confdeltype = 'n' (ON DELETE SET NULL),
-- except the intentional cascade on user_stores.user_id. Catches a
-- future regression where any one of the 11 swapped FKs (or the 2
-- already-correct positive-control FKs) is silently reverted to NO
-- ACTION / RESTRICT / CASCADE / SET DEFAULT.
--
-- Plan (13 arms):
--   (1)–(10) — the 10 FK swaps landed by
--             20260528000000_actor_fk_cascade_audit.sql.
--   (11)    — prep_recipes.created_by FK RESTORATION (FK was dropped
--             by 20260502071736_remote_schema.sql:43 on 2026-05-02,
--             restored by this spec's migration with confdeltype 'n').
--   (12)    — inventory_counts.submitted_by — POSITIVE CONTROL,
--             already SET NULL from
--             20260513000000_inventory_counts.sql:76. Never touched
--             by this spec's migration; regression guard against a
--             future drive-by flip back to NO ACTION.
--   (13)    — eod_submissions.submitted_by — POSITIVE CONTROL,
--             SET NULL from spec 065
--             (20260527000000_eod_submissions_submitted_by_on_delete_set_null.sql).
--             Same regression-guard purpose as arm (12).
--
-- Hermetic isolation: begin; ... rollback;. The probe touches only
-- pg_constraint (catalog read) — no JWT impersonation, no INSERT,
-- no setup/teardown. Runs cleanly in any order vs. the other suites.
--
-- Lookup pattern: each arm queries pg_constraint by (conrelid, conkey,
-- contype = 'f') to find the inbound FK on the (table, column) pair,
-- rather than by constraint name. This is robust against constraint
-- rename (the migration's `drop constraint if exists` would no-op on
-- a renamed prior constraint, but the subsequent `add constraint`
-- creates the canonical name; the assertion still fires correctly
-- because it indexes on the column shape, not the constraint name).
--
-- See specs/066-actor-fk-cascade-audit-sweep.md §"Backend design"
-- for the full survey and migration rationale.

begin;
create extension if not exists pgtap;

select plan(13);


-- ─── Arm (1): inventory_items.last_updated_by → set null ───────
select is(
  (select c.confdeltype
     from pg_constraint c
     join pg_class t on t.oid = c.conrelid
     join pg_namespace n on n.oid = t.relnamespace
     join pg_attribute a on a.attrelid = t.oid and a.attnum = any(c.conkey)
    where n.nspname = 'public'
      and t.relname = 'inventory_items'
      and a.attname = 'last_updated_by'
      and c.contype = 'f'
      and c.confrelid = 'public.profiles'::regclass
    limit 1),
  'n'::"char",
  'arm (1): inventory_items.last_updated_by FK references profiles(id) with on delete set null. ' ||
  'If this arm fails, the FK posture has regressed — see 20260528000000_actor_fk_cascade_audit.sql.'
);


-- ─── Arm (2): waste_log.logged_by → set null ───────────────────
select is(
  (select c.confdeltype
     from pg_constraint c
     join pg_class t on t.oid = c.conrelid
     join pg_namespace n on n.oid = t.relnamespace
     join pg_attribute a on a.attrelid = t.oid and a.attnum = any(c.conkey)
    where n.nspname = 'public'
      and t.relname = 'waste_log'
      and a.attname = 'logged_by'
      and c.contype = 'f'
      and c.confrelid = 'public.profiles'::regclass
    limit 1),
  'n'::"char",
  'arm (2): waste_log.logged_by FK references profiles(id) with on delete set null. ' ||
  'If this arm fails, the FK posture has regressed — see 20260528000000_actor_fk_cascade_audit.sql.'
);


-- ─── Arm (3): purchase_orders.created_by → set null ────────────
select is(
  (select c.confdeltype
     from pg_constraint c
     join pg_class t on t.oid = c.conrelid
     join pg_namespace n on n.oid = t.relnamespace
     join pg_attribute a on a.attrelid = t.oid and a.attnum = any(c.conkey)
    where n.nspname = 'public'
      and t.relname = 'purchase_orders'
      and a.attname = 'created_by'
      and c.contype = 'f'
      and c.confrelid = 'public.profiles'::regclass
    limit 1),
  'n'::"char",
  'arm (3): purchase_orders.created_by FK references profiles(id) with on delete set null. ' ||
  'If this arm fails, the FK posture has regressed — see 20260528000000_actor_fk_cascade_audit.sql.'
);


-- ─── Arm (4): purchase_orders.received_by → set null ───────────
select is(
  (select c.confdeltype
     from pg_constraint c
     join pg_class t on t.oid = c.conrelid
     join pg_namespace n on n.oid = t.relnamespace
     join pg_attribute a on a.attrelid = t.oid and a.attnum = any(c.conkey)
    where n.nspname = 'public'
      and t.relname = 'purchase_orders'
      and a.attname = 'received_by'
      and c.contype = 'f'
      and c.confrelid = 'public.profiles'::regclass
    limit 1),
  'n'::"char",
  'arm (4): purchase_orders.received_by FK references profiles(id) with on delete set null. ' ||
  'If this arm fails, the FK posture has regressed — see 20260528000000_actor_fk_cascade_audit.sql.'
);


-- ─── Arm (5): pos_imports.imported_by → set null ───────────────
select is(
  (select c.confdeltype
     from pg_constraint c
     join pg_class t on t.oid = c.conrelid
     join pg_namespace n on n.oid = t.relnamespace
     join pg_attribute a on a.attrelid = t.oid and a.attnum = any(c.conkey)
    where n.nspname = 'public'
      and t.relname = 'pos_imports'
      and a.attname = 'imported_by'
      and c.contype = 'f'
      and c.confrelid = 'public.profiles'::regclass
    limit 1),
  'n'::"char",
  'arm (5): pos_imports.imported_by FK references profiles(id) with on delete set null. ' ||
  'If this arm fails, the FK posture has regressed — see 20260528000000_actor_fk_cascade_audit.sql.'
);


-- ─── Arm (6): audit_log.user_id → set null ─────────────────────
select is(
  (select c.confdeltype
     from pg_constraint c
     join pg_class t on t.oid = c.conrelid
     join pg_namespace n on n.oid = t.relnamespace
     join pg_attribute a on a.attrelid = t.oid and a.attnum = any(c.conkey)
    where n.nspname = 'public'
      and t.relname = 'audit_log'
      and a.attname = 'user_id'
      and c.contype = 'f'
      and c.confrelid = 'public.profiles'::regclass
    limit 1),
  'n'::"char",
  'arm (6): audit_log.user_id FK references profiles(id) with on delete set null. ' ||
  'If this arm fails, the FK posture has regressed — see 20260528000000_actor_fk_cascade_audit.sql.'
);


-- ─── Arm (7): flags.user_id → set null ─────────────────────────
select is(
  (select c.confdeltype
     from pg_constraint c
     join pg_class t on t.oid = c.conrelid
     join pg_namespace n on n.oid = t.relnamespace
     join pg_attribute a on a.attrelid = t.oid and a.attnum = any(c.conkey)
    where n.nspname = 'public'
      and t.relname = 'flags'
      and a.attname = 'user_id'
      and c.contype = 'f'
      and c.confrelid = 'public.profiles'::regclass
    limit 1),
  'n'::"char",
  'arm (7): flags.user_id FK references profiles(id) with on delete set null. ' ||
  'If this arm fails, the FK posture has regressed — see 20260528000000_actor_fk_cascade_audit.sql.'
);


-- ─── Arm (8): flags.resolved_by → set null ─────────────────────
select is(
  (select c.confdeltype
     from pg_constraint c
     join pg_class t on t.oid = c.conrelid
     join pg_namespace n on n.oid = t.relnamespace
     join pg_attribute a on a.attrelid = t.oid and a.attnum = any(c.conkey)
    where n.nspname = 'public'
      and t.relname = 'flags'
      and a.attname = 'resolved_by'
      and c.contype = 'f'
      and c.confrelid = 'public.profiles'::regclass
    limit 1),
  'n'::"char",
  'arm (8): flags.resolved_by FK references profiles(id) with on delete set null. ' ||
  'If this arm fails, the FK posture has regressed — see 20260528000000_actor_fk_cascade_audit.sql.'
);


-- ─── Arm (9): report_definitions.created_by → set null ─────────
select is(
  (select c.confdeltype
     from pg_constraint c
     join pg_class t on t.oid = c.conrelid
     join pg_namespace n on n.oid = t.relnamespace
     join pg_attribute a on a.attrelid = t.oid and a.attnum = any(c.conkey)
    where n.nspname = 'public'
      and t.relname = 'report_definitions'
      and a.attname = 'created_by'
      and c.contype = 'f'
      and c.confrelid = 'public.profiles'::regclass
    limit 1),
  'n'::"char",
  'arm (9): report_definitions.created_by FK references profiles(id) with on delete set null. ' ||
  'If this arm fails, the FK posture has regressed — see 20260528000000_actor_fk_cascade_audit.sql.'
);


-- ─── Arm (10): report_runs.ran_by → set null ───────────────────
select is(
  (select c.confdeltype
     from pg_constraint c
     join pg_class t on t.oid = c.conrelid
     join pg_namespace n on n.oid = t.relnamespace
     join pg_attribute a on a.attrelid = t.oid and a.attnum = any(c.conkey)
    where n.nspname = 'public'
      and t.relname = 'report_runs'
      and a.attname = 'ran_by'
      and c.contype = 'f'
      and c.confrelid = 'public.profiles'::regclass
    limit 1),
  'n'::"char",
  'arm (10): report_runs.ran_by FK references profiles(id) with on delete set null. ' ||
  'If this arm fails, the FK posture has regressed — see 20260528000000_actor_fk_cascade_audit.sql.'
);


-- ─── Arm (11): prep_recipes.created_by → set null (RESTORATION) ─
-- The FK was DROPPED on 2026-05-02 by 20260502071736_remote_schema.sql:43
-- and never re-added until this spec restored it. This arm fails
-- both if the FK is missing entirely (the regression scenario that
-- motivated the restoration) AND if it was reverted to NO ACTION.
select is(
  (select c.confdeltype
     from pg_constraint c
     join pg_class t on t.oid = c.conrelid
     join pg_namespace n on n.oid = t.relnamespace
     join pg_attribute a on a.attrelid = t.oid and a.attnum = any(c.conkey)
    where n.nspname = 'public'
      and t.relname = 'prep_recipes'
      and a.attname = 'created_by'
      and c.contype = 'f'
      and c.confrelid = 'public.profiles'::regclass
    limit 1),
  'n'::"char",
  'arm (11): prep_recipes.created_by FK references profiles(id) with on delete set null. ' ||
  'This FK was DROPPED on 2026-05-02 by 20260502071736_remote_schema.sql:43 and RESTORED by ' ||
  '20260528000000_actor_fk_cascade_audit.sql. If this arm fails the FK is either missing entirely ' ||
  '(restoration regressed) or reverted to NO ACTION.'
);


-- ─── Arm (12): inventory_counts.submitted_by → set null (POSITIVE CONTROL) ─
-- Already SET NULL since 20260513000000_inventory_counts.sql:76. NOT
-- touched by this spec's migration; this arm is a regression guard
-- against a future drive-by flip back to NO ACTION.
select is(
  (select c.confdeltype
     from pg_constraint c
     join pg_class t on t.oid = c.conrelid
     join pg_namespace n on n.oid = t.relnamespace
     join pg_attribute a on a.attrelid = t.oid and a.attnum = any(c.conkey)
    where n.nspname = 'public'
      and t.relname = 'inventory_counts'
      and a.attname = 'submitted_by'
      and c.contype = 'f'
      and c.confrelid = 'public.profiles'::regclass
    limit 1),
  'n'::"char",
  'arm (12, positive control): inventory_counts.submitted_by FK references profiles(id) with on delete set null. ' ||
  'Set by 20260513000000_inventory_counts.sql:76; untouched by spec 066. If this arm fails, an unrelated ' ||
  'migration silently reverted the FK posture — investigate the most recent inventory_counts migration.'
);


-- ─── Arm (13): eod_submissions.submitted_by → set null (POSITIVE CONTROL) ─
-- Already SET NULL since spec 065
-- (20260527000000_eod_submissions_submitted_by_on_delete_set_null.sql).
-- NOT touched by this spec's migration; same regression-guard
-- purpose as arm (12).
select is(
  (select c.confdeltype
     from pg_constraint c
     join pg_class t on t.oid = c.conrelid
     join pg_namespace n on n.oid = t.relnamespace
     join pg_attribute a on a.attrelid = t.oid and a.attnum = any(c.conkey)
    where n.nspname = 'public'
      and t.relname = 'eod_submissions'
      and a.attname = 'submitted_by'
      and c.contype = 'f'
      and c.confrelid = 'public.profiles'::regclass
    limit 1),
  'n'::"char",
  'arm (13, positive control): eod_submissions.submitted_by FK references profiles(id) with on delete set null. ' ||
  'Set by spec 065 (20260527000000_eod_submissions_submitted_by_on_delete_set_null.sql); untouched by spec 066. ' ||
  'If this arm fails, an unrelated migration silently reverted the FK posture — investigate the most recent ' ||
  'eod_submissions migration.'
);


select * from finish();
rollback;
