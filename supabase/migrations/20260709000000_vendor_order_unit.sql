-- ============================================================
-- Spec 115 (W-2) — Per-vendor quick-order counting unit on `public.vendors`.
--
-- R-2 (owner ruling): the quick-order block's number becomes a per-vendor
-- "order unit" — 'case' vs 'unit', DEFAULTING to 'case'. Most wholesale
-- quick-order boxes are case-based, so pasting counted units (e.g. 24) into a
-- case-based box silently orders a pallet. 'case' is the safe default; the
-- quick-order builder divides counted units by the item's case_qty and rounds
-- UP to whole cases when the vendor's unit is 'case', and passes counted units
-- verbatim (spec 114 behavior) when it is 'unit'. The unit is the vendor's
-- (brand-level), not per-(item, vendor) — vendors is brand-scoped.
--
-- This migration is PURELY ADDITIVE and NON-DESTRUCTIVE: one text column with
-- a constant NOT NULL DEFAULT and a two-value CHECK, NO backfill statement, NO
-- change to any existing column, NO drop, NO index. Existing rows read 'case'
-- from the DEFAULT — R-2's safe default supplied to every vendor with zero
-- backfill.
--
-- `add column … not null default '<constant>'` is a metadata-only, instant,
-- non-rewriting operation on Postgres 17 for a CONSTANT default (the stored
-- default is recorded once; existing rows are not rewritten and read the
-- default lazily). Safe on the 11-vendor seed and on prod. Reversible-by-design
-- (repo has no down-migration convention): a single
--   alter table public.vendors drop column order_unit;
-- returns the system to exactly its prior state (no index, no dependent object,
-- no FK).
--
-- Shape (OQ-5, confirmed by the architect): `text NOT NULL DEFAULT 'case'
-- CHECK (order_unit in ('case','unit'))`. text+CHECK matches the codebase's
-- existing enum-ish text columns (vendors.order_cutoff_time; purchase_orders
-- statuses use text+CHECK, not PG enums); a real PG enum type would add a
-- `create type` + a harder-to-alter dependency for no benefit.
--
-- INHERITED WITH ZERO CHANGE (this migration touches NONE of the below):
--   • RLS — the four `vendors` policies gate the WHOLE ROW, column-agnostically,
--     so `order_unit` is covered by SELECT / INSERT / UPDATE / DELETE the
--     instant it exists. No new policy, no policy edit. The applied policy
--     state (the architect's live-schema audit corrects a stale comment — see
--     below) is:
--       SELECT : brand_member_read_vendors   — auth_can_see_brand(brand_id)
--                (20260509000000_multi_brand_schema_rls.sql:575)
--       INSERT : privileged_insert_vendors OR "Vendors admin only"
--                (auth_is_privileged [+ auth_can_see_brand on the former])
--       UPDATE : privileged_update_vendors   — auth_is_privileged()
--                AND auth_can_see_brand(brand_id), USING + WITH CHECK
--                (20260509000000_multi_brand_schema_rls.sql:586)
--       DELETE : privileged_delete_vendors   — same gate as UPDATE
--     STALE-COMMENT CORRECTION: the comment in
--     20260517010000_vendors_master_role_fix.sql ("UPDATE/DELETE on vendors
--     have no policies today; intentionally leaving them denied") is STALE
--     DOCUMENTATION that predates awareness that 20260509000000 (8 days
--     earlier) had already installed privileged_update_vendors /
--     privileged_delete_vendors. UPDATE is NOT ungated and NOT denied — it is
--     correctly privileged-gated. `order_unit` inherits that gate: a
--     non-privileged member cannot flip it. This is proven at the DB boundary
--     by the pgTAP extension in supabase/tests/vendors_role_access.test.sql
--     (UPDATE cases: privileged CAN, non-privileged CANNOT), which makes the
--     stale comment honest. (The spec-053 permissive-policy lint arm stays
--     green untouched — no policy is added, so no allowlist edit is expected.)
--   • Grants — the table-level grants on public.vendors extend to every column
--     automatically, including one added later (combined with the spec-097
--     default-privileges migration 20260618000000_public_grants_explicit.sql
--     there is NO grant hunk here and no grant leak).
--   • Realtime publication membership — public.vendors is ALREADY in the
--     supabase_realtime publication (20260514140000_realtime_publication_tighten.sql:52,
--     which rebuilt the publication from FOR ALL TABLES to an explicit allowlist
--     that lists public.vendors; no later migration drops/recreates it) and
--     ALREADY subscribed on the brand-{id} channel in useRealtimeSync.ts:68.
--     An order_unit edit therefore replays to other admin clients on the
--     existing brand-{id} channel with no wiring change. (This corrects the
--     spec's OQ-3 premise, which asserted vendors was subscribed-but-never-
--     published — it has been published since 2026-05-14.)
--
-- REALTIME PUBLICATION GOTCHA — DELIBERATE ABSENCE. The documented
-- `docker restart supabase_realtime_imr-inventory` step (CLAUDE.md / MEMORY.md
-- "Realtime publication gotcha") applies ONLY when a migration changes
-- supabase_realtime publication MEMBERSHIP. This migration ADDS A COLUMN to an
-- already-published table — it does NOT touch the publication. So the restart
-- step does NOT apply here (same deliberate absence as spec-114's order_code
-- migration). Flagged explicitly so the deploy checklist is not padded with a
-- no-op restart.
--
-- PROD-APPLY (DDL, verify by COLUMN PRESENCE — spec 064 gate). Additive DDL
-- apply via the Supabase MCP (project memory "Prod migration via Supabase MCP"
-- — `db push` lacks the prod password):
--   1. execute_sql the `alter table … add column` (+ the comment) below.
--   2. INSERT the exact version '20260709000000' into
--      supabase_migrations.schema_migrations so db-migrations-applied.yml
--      (spec 064) stays green.
--   3. VERIFY the column landed with the right shape:
--        select 1 from information_schema.columns
--         where table_schema='public' and table_name='vendors'
--           and column_name='order_unit'
--           and is_nullable='NO'
--           and column_default = '''case''::text';
-- Verify by COLUMN PRESENCE, NOT a body-only normalized-md5 — that md5 check
-- is for CREATE-OR-REPLACE FUNCTION bodies; there is no function here.
-- NO publication apply (OQ-3 — already published). NO policy apply (OQ-4 —
-- already gated). The developer FLAGS this prod-apply in the handoff and does
-- NOT push it themselves; db-migrations-applied.yml goes red until the
-- schema_migrations row lands (expected, resolves on apply).
-- ============================================================

-- The lone hunk: the additive text column with a constant NOT NULL DEFAULT and
-- a two-value CHECK. `if not exists` keeps a manual re-apply idempotent
-- (mirrors the guard in the spec-114 order_code migration).
alter table public.vendors
  add column if not exists order_unit text not null default 'case'
    check (order_unit in ('case', 'unit'));

comment on column public.vendors.order_unit is
  'spec 115 (W-2): the counting unit the vendor''s web quick-order box expects. '
  '''case'' (default) → the quick-order builder divides counted units by the '
  'item''s case_qty and rounds UP to whole cases; ''unit'' → counted units '
  'verbatim (spec 114 behavior). Brand-level (vendors is brand-scoped). Inherits '
  'the existing vendors RLS (brand_member_read_vendors / privileged_insert_vendors '
  '+ "Vendors admin only" / privileged_update_vendors / privileged_delete_vendors) '
  'column-agnostically. Additive: existing rows read ''case'' from the DEFAULT — '
  'no backfill.';
