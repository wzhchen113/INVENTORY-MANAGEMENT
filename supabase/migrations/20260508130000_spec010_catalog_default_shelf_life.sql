-- supabase/migrations/20260508130000_spec010_catalog_default_shelf_life.sql
--
-- Spec 010 §1: per-ingredient default shelf life used to auto-compute
-- inventory_items.expiry_date on receipt.
--
-- Adds a single nullable int column to catalog_ingredients. NULL means
-- "no auto-compute on receive" — the per-store inventory_items.expiry_date
-- (already on the init schema, see 20260405000759_init_schema.sql:63)
-- can still be set/overridden on a per-row basis. The auto-stamp branch
-- in ReceivingSection only fires when (a) the inventory row has no
-- existing expiry_date and (b) the catalog row has a non-null shelf
-- life — see specs/010-attention-queue-phase-2.md §5.
--
-- Why catalog-level (brand-shared), not per-store inventory_items:
--   Shelf life is a property of the ingredient itself (chicken vs.
--   dry goods), not of one store's stock. Matches the brand-catalog
--   refactor's "shape lives once at the brand level" pattern (Spec
--   005 P1-P5, 2026-05-04). The escape hatch is the per-row
--   inventory_items.expiry_date which an admin can set independently.
--
-- Rollout safety:
--   - Nullable, no default → metadata-only, instant in PG 17, no row
--     rewrite.
--   - `if not exists` makes this re-runnable on a DB that already has
--     the column (idempotency rule from prior migrations).
--   - Rollback is `alter table public.catalog_ingredients drop column
--     default_shelf_life_days` which would erase admin-set defaults —
--     that's the explicit revert semantic, not silent data loss.
--   - Additive only — safe to ship without coordinated frontend release;
--     old clients ignore the new column.
--
-- RLS impact: NONE. catalog_ingredients already has brand-scoped
-- policies from the brand-catalog refactor (see 20260504073942_brand_
-- catalog_p5_rls.sql). Adding a column does not require a policy
-- change — the existing row-scoped policies gate writes to every
-- column on the row.
--
-- Realtime: NO publication membership change. catalog_ingredients is
-- already on the supabase_realtime publication (CatalogIngredientsTab
-- realtime-syncs today via the brand-* channel). The new column rides
-- the existing publication for free; no `docker restart
-- supabase_realtime_imr-inventory` step needed.
--
-- See specs/010-attention-queue-phase-2.md §1.

begin;

alter table public.catalog_ingredients
  add column if not exists default_shelf_life_days int;

comment on column public.catalog_ingredients.default_shelf_life_days is
  'Spec 010: default days from receipt to expiry. NULL = no auto-compute. Per-store inventory_items.expiry_date can override on a per-row basis.';

commit;
