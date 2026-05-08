-- supabase/migrations/20260508120000_spec008_profiles_sidebar_layout.sql
--
-- Spec 008 §1: per-user sidebar layout override.
--
-- Adds a nullable jsonb column to profiles. NULL means "use the
-- hardcoded default groups array verbatim" — the uncustomized invariant.
-- Non-null is the override-list shape documented in §2 of the spec
-- backend design (specs/008-sidebar-layout-customization.md):
--
--   {
--     "v": 1,
--     "items": [
--       { "id": "Inventory", "group": "Operations", "order": 0, "hidden": false },
--       { "id": "Reports",   "group": "Operations", "order": 4 },
--       { "id": "DBInspector", "hidden": true }
--     ]
--   }
--
-- Additive, metadata-only, no backfill, no policy change. Inherits the
-- existing profiles row-level policies (id = auth.uid() for users;
-- admin/master JWT bypass). RLS is row-scoped — adding a column does
-- not require new policies. Verified at design time:
--   - "Users can update own profile" → using (id = auth.uid())
--   - "Admins can update any profile" → using (admin/master role OR id = auth.uid())
-- Both policies gate writes to the new column for free.
--
-- Rollout safety:
--   - Nullable, no default → metadata-only, instant in PG 17, no row rewrite.
--   - `if not exists` makes this re-runnable on a DB that already has the
--     column (idempotency rule from prior migrations).
--   - Rollback is `alter table public.profiles drop column sidebar_layout`
--     which would erase user customizations — that's the explicit revert
--     semantic, not silent data loss.
--
-- Realtime: profiles is on the supabase_realtime publication today, but
-- per design §0.6 the spec does NOT add or change the publication. The
-- column is published for free as part of the existing publication
-- membership, but the app does not subscribe to profile changes (this
-- is per-user single-writer state). No `docker restart
-- supabase_realtime_imr-inventory` step needed.
--
-- See specs/008-sidebar-layout-customization.md §1.

begin;

alter table public.profiles
  add column if not exists sidebar_layout jsonb;

comment on column public.profiles.sidebar_layout is
  'Spec 008: per-user Cmd UI sidebar override list. NULL = use default. Shape: { v: 1, items: [{ id, group?, order?, hidden? }, ...] }. See specs/008-sidebar-layout-customization.md §2.';

commit;
