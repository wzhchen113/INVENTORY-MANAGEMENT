-- Spec 006: House Special Blend (Sauce) — remote canonical drift cleanup.
--
-- Deletes the stale `prep_recipes` row at canonical name
-- 'House Special Blend (Sauce)' that has `is_current = false` on remote
-- (id prefix '4fbd90'), plus the 6 `prep_recipe_ingredients` rows that
-- fan out from it. The current canonical (id prefix '36016d31',
-- `is_current = true`) is left untouched.
--
-- Pinned identifiers (resolved via §1 probe, recorded in spec build notes):
--   STALE_PREP_ID     = '4fbd90cc-7e06-4eef-a462-82efd386bfef'
--   CANONICAL_PREP_ID = '36016d31-4da1-466b-9547-e528cf0f4c8f' (not used here;
--                       documented for cross-reference only)
--   BRAND_ID          = '2a000000-0000-0000-0000-000000000001' (2AM PROJECT)
--
-- Idempotency contract (Spec 003 / 005 precedent):
--   First apply  — assertion 1 sees 1 row, assertion 2 sees parent=1
--                  + ings=6, DELETEs remove 6 + 1, assertions 3/4 see (6, 1).
--   Second apply — assertion 1 sees 0 rows, assertion 2 sees parent=0
--                  + ings=0, DELETEs remove 0 + 0, assertions 3/4 see (0, 0).
--                  Transaction commits cleanly with no-op deletes.
--   Mismatch     — RAISE EXCEPTION, transaction rolls back, no partial repair.
--
-- Apply-path matrix (spec §13):
--   A  remote prod     — primary apply target. Assertions all pass.
--   B  fresh local DB  — pre-seed: idempotent no-op. All zeros.
--   C  seeded local DB — local has the row at id 4fbd90 but with
--                        `is_current = true` (NOT false), so assertion 1's
--                        WHERE filters it out (parent count 0) but the
--                        ingredient fan-out is 6. Assertion 2 raises:
--                        'parent stale row absent but 6 orphan ingredient
--                        rows remain'. **This abort is expected and
--                        desirable** — it catches exactly the drift shape
--                        the spec exists to clean up. Local is not the
--                        apply target for this migration.
--
-- Recovery: see scripts/recovery-snapshots/<timestamp>-spec006/ for the
-- captured pre-delete row contents (TSV + JSON). Rollback procedure in
-- spec §14.

BEGIN;

-- ─── Assertion 1: stale prep_recipes row exists in expected shape (or is
-- ─── already gone for idempotency).
DO $$
DECLARE
  v_count int;
BEGIN
  SELECT count(*) INTO v_count
    FROM prep_recipes
   WHERE id = '4fbd90cc-7e06-4eef-a462-82efd386bfef'::uuid
     AND brand_id = '2a000000-0000-0000-0000-000000000001'::uuid
     AND name = 'House Special Blend (Sauce)'
     AND is_current = false;

  IF v_count NOT IN (0, 1) THEN
    RAISE EXCEPTION
      'spec006: stale prep_recipes row count = %, expected 0 or 1',
      v_count;
  END IF;
END $$;

-- ─── Assertion 2: ingredient fan-out matches manifest exactly when the
-- ─── parent is still present, and is zero when the parent is gone
-- ─── (idempotency invariant).
DO $$
DECLARE
  v_parent int;
  v_ing    int;
BEGIN
  SELECT count(*) INTO v_parent
    FROM prep_recipes
   WHERE id = '4fbd90cc-7e06-4eef-a462-82efd386bfef'::uuid
     AND is_current = false;

  SELECT count(*) INTO v_ing
    FROM prep_recipe_ingredients
   WHERE prep_recipe_id = '4fbd90cc-7e06-4eef-a462-82efd386bfef'::uuid;

  IF v_parent = 1 AND v_ing <> 6 THEN
    RAISE EXCEPTION
      'spec006: parent stale row present but ingredient fan-out = %, expected 6',
      v_ing;
  END IF;

  IF v_parent = 0 AND v_ing <> 0 THEN
    RAISE EXCEPTION
      'spec006: parent stale row absent but % orphan ingredient rows remain (idempotency invariant violated)',
      v_ing;
  END IF;
END $$;

-- ─── Delete: ingredients first (FK respect), with deleted-count assertion.
DO $$
DECLARE
  v_deleted int;
BEGIN
  DELETE FROM prep_recipe_ingredients
   WHERE prep_recipe_id = '4fbd90cc-7e06-4eef-a462-82efd386bfef'::uuid;

  GET DIAGNOSTICS v_deleted = ROW_COUNT;

  IF v_deleted NOT IN (0, 6) THEN
    RAISE EXCEPTION
      'spec006: prep_recipe_ingredients delete affected % rows, expected 0 or 6',
      v_deleted;
  END IF;
END $$;

-- ─── Delete: the parent prep_recipes row, with deleted-count assertion.
DO $$
DECLARE
  v_deleted int;
BEGIN
  DELETE FROM prep_recipes
   WHERE id = '4fbd90cc-7e06-4eef-a462-82efd386bfef'::uuid;

  GET DIAGNOSTICS v_deleted = ROW_COUNT;

  IF v_deleted NOT IN (0, 1) THEN
    RAISE EXCEPTION
      'spec006: prep_recipes delete affected % rows, expected 0 or 1',
      v_deleted;
  END IF;
END $$;

COMMIT;
