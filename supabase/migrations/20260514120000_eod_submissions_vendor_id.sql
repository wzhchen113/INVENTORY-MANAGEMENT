-- ============================================================
-- Spec 020 — vendor_id on eod_submissions (per-vendor partitioning)
--
-- Three-phase shape (single transaction):
--   Phase A: add nullable vendor_id column + supporting index
--   Phase B: backfill via mode of inventory_items.vendor_id across
--            each submission's eod_entries
--   Phase C: drop old (store_id, date) unique, enforce NOT NULL on
--            vendor_id, add new (store_id, date, vendor_id) unique,
--            add FK with ON DELETE RESTRICT
--
-- Realtime: no publication change; supabase_realtime is FOR ALL TABLES
-- (per 20260502190000_realtime_publication.sql:14). Adding a column
-- to a table that is already in the publication does NOT change the
-- publication membership, so the docker restart ritual does NOT apply.
-- ============================================================

begin;

-- ─── Phase A — Add nullable column ─────────────────────────
alter table public.eod_submissions
  add column if not exists vendor_id uuid;

-- Index on the new column. Created BEFORE the backfill UPDATE so the
-- post-backfill recheck and the new (store_id, date, vendor_id)
-- unique can co-plan reasonably.
create index if not exists eod_submissions_vendor_id_idx
  on public.eod_submissions(vendor_id);

-- ─── Phase B — Backfill ────────────────────────────────────
-- For each existing eod_submissions row, infer vendor_id from the
-- mode of inventory_items.vendor_id across its eod_entries:
--   • SKIP entries whose inventory_items.vendor_id IS NULL (no signal).
--   • Mode = the vendor_id with the highest entry count among the
--     remaining (non-null-vendor) entries.
--   • Tiebreaker: lexicographically smallest vendor_id::text (i.e.,
--     UUID string compare). Deterministic and reproducible.
--
-- Edge cases:
--   • Submission with all entries' items having NULL vendor_id:
--     leaves vendor_id NULL (eligible set is empty).
--   • Submission with zero eod_entries rows: same — eligible set
--     is empty, vendor_id stays NULL.
-- Both edge cases fall through to the post-backfill recheck below,
-- which DELETEs the unrecoverable parent rows (children cascade via
-- the existing FK on eod_entries.submission_id ON DELETE CASCADE).
with mode_pick as (
  select
    s.id                              as submission_id,
    -- inner subquery: per-(submission, vendor_id) counts, ordered
    -- by count desc then vendor_id::text asc, take first.
    (
      select ii.vendor_id
      from   public.eod_entries e
      join   public.inventory_items ii on ii.id = e.item_id
      where  e.submission_id = s.id
        and  ii.vendor_id is not null
      group by ii.vendor_id
      order by count(*) desc, ii.vendor_id::text asc
      limit 1
    ) as inferred_vendor_id
  from public.eod_submissions s
  where s.vendor_id is null
)
update public.eod_submissions s
   set vendor_id = mp.inferred_vendor_id
  from mode_pick mp
 where mp.submission_id = s.id
   and mp.inferred_vendor_id is not null;

-- Post-backfill recheck. Any rows still NULL are unrecoverable
-- (no entries, OR every entry's item has NULL vendor_id). Audit-log
-- rows for those submissions stay in audit_log — audit_log has no
-- FK cascade from eod_submissions, so the trail is preserved even
-- as the unusable parent + its cascaded entries are removed.
do $$
declare
  v_orphans int;
  v_ids uuid[];
begin
  select count(*), array_agg(id)
    into v_orphans, v_ids
    from public.eod_submissions
   where vendor_id is null;
  if v_orphans > 0 then
    raise notice
      'spec020 backfill: % submission(s) have NULL vendor_id after backfill (no entries OR all entries had NULL item vendor). Deleting: %',
      v_orphans, v_ids;
    -- Children cascade via FK (eod_entries.submission_id … on delete
    -- cascade — see init_schema.sql:130). Audit_log rows for those
    -- entries STAY because audit_log is not FK-cascaded from
    -- eod_submissions.
    delete from public.eod_submissions where vendor_id is null;
  end if;
end$$;

-- ─── Phase C — Enforce + reshape constraints ───────────────
-- Drop the original (store_id, date) unique. In prod this was created
-- as `eod_submissions_store_date_key` via the remote schema migration
-- (20260502071736_remote_schema.sql:175-183) which built it as an
-- index-backed UNIQUE constraint. Defensively drop both possible
-- shapes (constraint and bare index) before reshaping.
alter table public.eod_submissions
  drop constraint if exists eod_submissions_store_date_key;
drop index if exists public.eod_submissions_store_date_key;
-- Belt-and-braces — the column ordering in the legacy index name
-- could also have been written as store_id_date_idx.
alter table public.eod_submissions
  drop constraint if exists eod_submissions_store_id_date_key;
drop index if exists public.eod_submissions_store_id_date_idx;

-- Enforce NOT NULL — safe now, all rows backfilled or deleted.
alter table public.eod_submissions
  alter column vendor_id set not null;

-- New unique constraint (store_id, date, vendor_id). Two same-day
-- submissions for the SAME vendor still merge (idempotent re-submit
-- of one vendor), but different vendors coexist.
alter table public.eod_submissions
  add constraint eod_submissions_store_id_date_vendor_id_key
  unique (store_id, date, vendor_id);

-- FK with ON DELETE RESTRICT. Preserves history — a vendor delete
-- must first clean up its EOD submissions.
alter table public.eod_submissions
  add constraint eod_submissions_vendor_id_fkey
  foreign key (vendor_id) references public.vendors(id)
  on delete restrict;

commit;
