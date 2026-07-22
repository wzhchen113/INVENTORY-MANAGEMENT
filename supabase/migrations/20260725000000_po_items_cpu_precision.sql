-- ============================================================
-- po_items.cost_per_unit — widen numeric(10,2) → numeric(12,6).
--
-- Owner bug report 2026-07-22: the Corn On Cob line on draft PO 742211
-- showed $5,760 instead of $60. Root cause was a DATA error (the
-- item_vendors per-vendor cost held the $30 CASE price instead of the
-- $0.3125 per-each cost — fixed by direct UPDATE, backup in
-- public.item_vendors_cpu_backup_20260722), but the repair surfaced this
-- latent SCHEMA gap: spec 104 widened inventory_items.cost_per_unit and
-- item_vendors.cost_per_unit to numeric(12,6) when the per-each basis
-- landed, and po_items.cost_per_unit was missed at numeric(10,2). Any PO
-- snapshot of a cost with sub-cent precision silently rounds (corn's
-- correct 0.3125 → 0.31, turning the $60.00 line into $59.52).
--
-- Same shape as the spec 104 widenings: increasing precision/scale is
-- value-preserving for every existing row (2dp values embed exactly in
-- (12,6)); the rewrite is trivial at this table's size. No RLS, grant,
-- index, or policy impact — type-only change on one column.
-- ============================================================

alter table public.po_items
  alter column cost_per_unit type numeric(12,6);
