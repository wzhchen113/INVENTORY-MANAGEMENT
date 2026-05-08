-- supabase/migrations/20260507214842_spec007_order_schedule_unique.sql
--
-- Spec 007 §1: add a unique constraint on order_schedule at the
-- (store_id, day_of_week, vendor_id) grain so the new per-cell write surface
-- (addOrderScheduleEntry / removeOrderScheduleEntry from §3) can do
-- idempotent inserts via ON CONFLICT DO NOTHING.
--
-- The existing unique constraint on (store_id, day_of_week, vendor_name)
-- — added in 20260502071736_remote_schema.sql — does NOT cover the
-- vendor_id grain. Two rows with the same (store_id, day_of_week, vendor_id)
-- but different vendor_name strings (e.g. a vendor rename) would both
-- insert successfully today, breaking the per-cell toggle invariant.
--
-- Strategy: dedup any pre-existing duplicates at the new grain by keeping
-- the oldest row per (store_id, day_of_week, vendor_id), then add the
-- constraint. Rows with NULL vendor_id are NOT touched — Postgres treats
-- NULL as distinct for unique constraints, so they don't conflict.
--
-- Probe certification (local, 2026-05-07):
--   total rows in order_schedule = 0
--   duplicate (store_id, day_of_week, vendor_id) groups = 0
--   → dedup pre-pass is a no-op locally; DELETE returns 0 rows.
--
-- Idempotency:
--   - The DELETE...USING form is naturally idempotent — re-running it
--     after the dedup completes finds no rows where a.ctid > b.ctid.
--   - The ALTER TABLE ADD CONSTRAINT is guarded with `if not exists`-style
--     checks via a DO block so re-applying this migration on a DB that
--     already has the constraint is a no-op.
--
-- See specs/007-eod-vendor-day-filter.md (Backend design §1).

begin;

-- ─── Step 1: Dedup pre-existing duplicates at (store_id, day_of_week, vendor_id)
--
-- ctid is the physical row pointer; oldest row in each group is whichever
-- has the smallest ctid (earliest physical insert) which approximates
-- earliest created_at for unmodified rows. We use ctid here because it's
-- the standard PG idiom for self-join dedup and tolerates NULL vendor_id
-- (the `is not distinct from` predicate matches NULL = NULL).
--
-- For the spec's intended grain we don't actually want to collapse NULL
-- vendor_id rows (they're outside the new constraint's scope anyway), so
-- the predicate matches `vendor_id is not distinct from` to keep behavior
-- consistent if any NULL-vendor_id duplicates ever existed.
do $$
declare
  deleted_count int;
begin
  with dups as (
    delete from public.order_schedule a
     using public.order_schedule b
     where a.ctid > b.ctid
       and a.store_id    = b.store_id
       and a.day_of_week = b.day_of_week
       and a.vendor_id is not distinct from b.vendor_id
    returning a.id
  )
  select count(*) into deleted_count from dups;
  raise notice 'spec007: deduped % duplicate order_schedule rows at (store_id, day_of_week, vendor_id) grain', deleted_count;
end $$;

-- ─── Step 2: Add the unique constraint at the per-cell grain
--
-- Wrapped in a DO block so the migration is re-runnable. If the constraint
-- already exists (e.g. a prior partial apply), this is a no-op.
do $$
begin
  if not exists (
    select 1
      from pg_constraint
     where conname  = 'order_schedule_store_day_vendor_unique'
       and conrelid = 'public.order_schedule'::regclass
  ) then
    alter table public.order_schedule
      add constraint order_schedule_store_day_vendor_unique
      unique (store_id, day_of_week, vendor_id);
    raise notice 'spec007: added unique constraint order_schedule_store_day_vendor_unique';
  else
    raise notice 'spec007: unique constraint order_schedule_store_day_vendor_unique already exists, skipping';
  end if;
end $$;

commit;
