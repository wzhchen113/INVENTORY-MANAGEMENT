-- supabase/migrations/20260602120000_spec093_case_qty_backfill.sql
--
-- Spec 093 — Ingredient case-size canonical fix (data backfill).
--
-- Context (spec 093 §0/§1): the catalog "case size" that reorder (088) and
-- EOD (086) read lives in `catalog_ingredients.case_qty` (UNITS-PER-CASE).
-- A form-binding bug let managers type the case size into the field bound to
-- `sub_unit_size` instead, so prod has rows whose real case size is mis-filed
-- in `sub_unit_size` while `case_qty` stays 1. This migration moves the
-- unambiguous mis-filed rows back into `case_qty` and flags the ambiguous
-- "both axes populated" rows for owner hand-review. NO DDL beyond one audit
-- table; the form/UI fix is a separate frontend slice.
--
-- Owner-confirmed decisions honored here (spec 093 handoff):
--   • (R1) Population B is auto-migrated — no pre-review gate.
--   • (R2) `default_cost` is NOT recomputed for migrated rows (out of scope).
--          After this runs, migrated B rows' `default_cost` may be internally
--          inconsistent with `default_case_price / case_qty`; this is the
--          spec's deliberate out-of-scope boundary, not a bug in this file.
--
-- The four populations (spec 093 §1a, predicates numeric-safe via
-- coalesce(...,1) mirroring reorder 088):
--   A. Canonical      case_qty > 1 AND sub_unit_size <= 1  → leave untouched.
--   B. Mis-filed      case_qty <= 1 AND sub_unit_size > 1  → AUTO-MIGRATE:
--                       case_qty := sub_unit_size, sub_unit_size := 1.
--   C. Split / both   case_qty > 1 AND sub_unit_size > 1   → DO NOT mutate;
--                       snapshot into the audit table for owner hand-review.
--   D. Degenerate     case_qty <= 1 AND sub_unit_size <= 1 → leave untouched.
--
-- `sub_unit_unit` is intentionally NOT part of the predicate (some B rows
-- carry an empty sub_unit_unit; gating on it would silently skip them) and is
-- left as-is by the UPDATE (vestigial-but-harmless for a pure case-size row;
-- reorder/EOD/cost paths never read it).
--
-- Idempotent / re-run safe: the B predicate self-extinguishes (after the
-- UPDATE, migrated rows have sub_unit_size = 1, so they no longer match
-- sub_unit_size > 1). The audit insert is guarded with `on conflict do
-- nothing`. A documented `-- BACKOUT` block lives at the foot of this file
-- (restore-from-audit, then drop the table) and is NOT auto-applied.
--
-- This migration is prod-touching and is run by the owner via an explicit
-- `supabase db push`. The Population C count is RAISEd so the owner sees
-- "N split rows flagged" in the push output.

begin;

-- ─── Step 1: audit / backout table ─────────────────────────────────────────
-- Survives the transaction so it is BOTH the Population-B backout source AND
-- the Population-C hand-review list (single artifact, two readers). It is a
-- back-office migration artifact — never read by the app, never reached over
-- PostgREST. RLS-enabled-no-policy = deny-all to anon/authenticated, which is
-- the desired posture; the explicit revoke below makes the intent unmistakable
-- and is NOT added to any realtime publication (spec 093 §2/§6).
create table if not exists public.spec093_case_qty_backfill_audit (
  catalog_id         uuid primary key,
  name               text,
  brand_id           uuid,
  old_case_qty       numeric,
  old_sub_unit_size  numeric,
  old_sub_unit_unit  text,
  new_case_qty       numeric,
  new_sub_unit_size  numeric,
  population         char(1),
  migrated_at        timestamptz default now()
);

alter table public.spec093_case_qty_backfill_audit enable row level security;
revoke all on public.spec093_case_qty_backfill_audit from anon, authenticated;

-- ─── Step 2: snapshot Population B (auto-migrate) ──────────────────────────
-- old_* = current values; new_* = (sub_unit_size, 1) i.e. the proposed move.
insert into public.spec093_case_qty_backfill_audit (
  catalog_id, name, brand_id,
  old_case_qty, old_sub_unit_size, old_sub_unit_unit,
  new_case_qty, new_sub_unit_size, population
)
select
  c.id, c.name, c.brand_id,
  c.case_qty, c.sub_unit_size, c.sub_unit_unit,
  c.sub_unit_size, 1, 'B'
from public.catalog_ingredients c
where coalesce(c.case_qty, 1) <= 1
  and coalesce(c.sub_unit_size, 1) > 1
on conflict (catalog_id) do nothing;

-- ─── Step 3: snapshot Population C (hand-review only — NEVER mutated) ───────
-- new_* = NULL (no proposed change; the owner resolves these by hand).
insert into public.spec093_case_qty_backfill_audit (
  catalog_id, name, brand_id,
  old_case_qty, old_sub_unit_size, old_sub_unit_unit,
  new_case_qty, new_sub_unit_size, population
)
select
  c.id, c.name, c.brand_id,
  c.case_qty, c.sub_unit_size, c.sub_unit_unit,
  null, null, 'C'
from public.catalog_ingredients c
where coalesce(c.case_qty, 1) > 1
  and coalesce(c.sub_unit_size, 1) > 1
on conflict (catalog_id) do nothing;

-- Report the Population C count so the owner sees the hand-review size in the
-- `db push` output.
do $$
declare
  v_c_count integer;
begin
  select count(*) into v_c_count
  from public.spec093_case_qty_backfill_audit
  where population = 'C';
  raise notice 'spec093 backfill: % split rows flagged for owner hand-review (population C). See public.spec093_case_qty_backfill_audit where population = ''C''.', v_c_count;
end $$;

-- ─── Step 4: UPDATE Population B ONLY ──────────────────────────────────────
-- Move the case size from sub_unit_size into the canonical case_qty column.
-- sub_unit_unit is intentionally left untouched. default_cost is intentionally
-- NOT recomputed (R2). updated_at bumped so realtime fan-out replays the change
-- for any admin with the catalog open during the push (spec 093 §6).
update public.catalog_ingredients c
   set case_qty      = c.sub_unit_size,
       sub_unit_size = 1,
       updated_at    = now()
 where coalesce(c.case_qty, 1) <= 1
   and coalesce(c.sub_unit_size, 1) > 1;

commit;

-- ───────────────────────────────────────────────────────────────────────────
-- BACKOUT (documented, NOT auto-applied)
--
-- The project has no down-migration convention; this is the "documented
-- backout" the owner asked for. Run by hand only if the push needs reverting.
-- It restores the Population-B rows from the audit snapshot, then drops the
-- audit table (which also discards the Population-C hand-review list — export
-- that list first if it is still needed).
--
--   begin;
--   update public.catalog_ingredients c
--      set case_qty      = a.old_case_qty,
--          sub_unit_size = a.old_sub_unit_size,
--          updated_at    = now()
--     from public.spec093_case_qty_backfill_audit a
--    where a.catalog_id = c.id
--      and a.population  = 'B';
--   drop table public.spec093_case_qty_backfill_audit;
--   commit;
-- ───────────────────────────────────────────────────────────────────────────
