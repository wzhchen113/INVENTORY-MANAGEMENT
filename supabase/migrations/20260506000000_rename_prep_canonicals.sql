-- supabase/migrations/20260506000000_rename_prep_canonicals.sql
--
-- Spec 005: rename four prep_recipes name-variants in brand 2a000000-...
-- onto their owner-curated canonical names so every affected name resolves
-- to exactly one is_current = true row. See specs/005-prep-canonical-curation.md
-- and docs/internal/prep-canonicalness-notes.md (the owner-curated source of
-- truth for canonical names).
--
-- Per amendment #3 (2026-05-06): the manifest is 4 rows / 16 grand total,
-- all mechanic = 'rename-into-collision', NO is_current flips. The 5th-row
-- extension introduced in amendment #2 (House Special Blend (Sauce)) was
-- dropped after the apply-time source-name re-probe confirmed Reading 2
-- (degenerate no-op); sibling Spec 006 owns that cleanup.
--
-- Renames (old_name → new_name, brand_id-scoped):
--   Tumeric Mix                  → Tumeric Seasoning (House Mix)         (4 rows)
--   House Special Seasoning Mix  → House Special Seasoning (House Mix)   (8 rows)
--   2AM Sauce                    → 2AM SAUCE                             (3 rows)
--   2AM SAUCE 10                 → 2AM SAUCE                             (1 row)
--
-- Mechanic: each old_name has 0 is_current = true rows; each new_name
-- already has exactly 1 is_current = true row (the existing canonical).
-- The renamed rows all carry is_current = false and join the existing
-- canonical's non-current pool as version-history siblings. The partial
-- unique index prep_recipes_brand_name_current_unique
-- (brand_id, lower(name)) WHERE is_current = true (added 2026-05-05) is
-- not triggered because every renamed row is excluded from the partial
-- index by the is_current = false predicate.
--
-- Control flow: count rows under the four old_names first; only run the
-- mutation when the count matches the manifest's expected grand total.
-- Avoids spurious failures during `db reset --local` (migrations run
-- against an empty DB before seed loads). See spec section 5 apply-path
-- matrix and Spec 001's idempotent-no-op precedent.
--
-- Idempotent: 0 rows under any old_name = no-op success. Full manifest
-- match = rename. Anything else = abort + rollback.
-- Out of scope: prep_recipe_ingredients (Spec 003); House Special Blend
-- (Sauce) remote-only drift (sibling Spec 006).
--
-- Filename note: 20260506000000 sorts immediately after
-- 20260505065303_admin_rpcs_lock_anon.sql, which is the latest migration
-- in the original run (before the spec004 cluster). Spec 003's eventual
-- migration must take a later timestamp.

BEGIN;

DO $$
DECLARE
  v_brand_id           constant uuid := '2a000000-0000-0000-0000-000000000001';
  v_expected_grand     constant int  := 16;     -- 4 + 8 + 3 + 1 per amendment #3
  v_actual_grand       int;
  v_renamed_count      int;
  v_name_count         int;
  v_target_canon_count int;
  r                    record;
BEGIN
  -- 1. Manifest: the 4 (old_name, new_name, mechanic, expected_count) tuples.
  --    All rows use rename-into-collision; flip_target_uuid_prefix retained
  --    on the schema for parity with the original section-2 design but is
  --    NULL on every row (no is_current mutations under amendment #3).
  CREATE TEMP TABLE _spec005_renames (
    old_name                text PRIMARY KEY,
    new_name                text NOT NULL,
    mechanic                text NOT NULL CHECK (mechanic IN (
      'rename-only',
      'rename-plus-flip-is-current',
      'rename-into-collision'
    )),
    expected_rename_count   int NOT NULL,
    flip_target_uuid_prefix text
  ) ON COMMIT DROP;

  INSERT INTO _spec005_renames (old_name, new_name, mechanic, expected_rename_count, flip_target_uuid_prefix) VALUES
    ('Tumeric Mix',                  'Tumeric Seasoning (House Mix)',         'rename-into-collision', 4, NULL),
    ('House Special Seasoning Mix',  'House Special Seasoning (House Mix)',   'rename-into-collision', 8, NULL),
    ('2AM Sauce',                    '2AM SAUCE',                             'rename-into-collision', 3, NULL),
    ('2AM SAUCE 10',                 '2AM SAUCE',                             'rename-into-collision', 1, NULL);

  -- 2. Pre-mutation grand-total snapshot. Counts rows in prep_recipes whose
  --    name matches any manifest old_name in the target brand. This is the
  --    count the migration WILL mutate when it proceeds.
  SELECT COUNT(*) INTO v_actual_grand
    FROM public.prep_recipes pr
    JOIN _spec005_renames m ON m.old_name = pr.name
   WHERE pr.brand_id = v_brand_id;

  -- 3. Branch on grand total.
  --    = 0  -> no-op (pre-seed db reset OR already curated; neutral wording
  --            per Spec 001 lessons-learned).
  --    = 16 -> proceed with the rename.
  --    else -> abort + rollback.
  IF v_actual_grand = 0 THEN
    RAISE NOTICE 'Spec 005: no-op (no rows under any rename old_name — pre-seed apply OR already curated)';

  ELSIF v_actual_grand = v_expected_grand THEN

    -- 4a. Per-name actuals snapshot (BEFORE the mutation, so we can recover
    --     "how many rows under each old_name were just renamed" — once the
    --     UPDATE fires, the rows live under new_name and the old_name
    --     identity is gone). Joined against the manifest at assertion time.
    CREATE TEMP TABLE _spec005_actuals
      ON COMMIT DROP
      AS
      SELECT pr.name AS old_name,
             COUNT(*) AS actual_count
        FROM public.prep_recipes pr
        JOIN _spec005_renames m ON m.old_name = pr.name
       WHERE pr.brand_id = v_brand_id
       GROUP BY pr.name;

    -- 4b. Per-name strictness assertion. Each manifest row's expected_rename_count
    --     MUST equal the actual count; LEFT JOIN + COALESCE(0) catches the case
    --     where a manifest old_name has no matching rows (would surface as
    --     0 vs expected_rename_count > 0).
    IF EXISTS (
      SELECT 1
        FROM _spec005_renames m
        LEFT JOIN _spec005_actuals a USING (old_name)
       WHERE COALESCE(a.actual_count, 0) <> m.expected_rename_count
    ) THEN
      -- Diagnostic NOTICE per mismatched name, then RAISE EXCEPTION (Spec 003 pattern).
      FOR r IN
        SELECT m.old_name, m.expected_rename_count,
               COALESCE(a.actual_count, 0) AS actual_count
          FROM _spec005_renames m
          LEFT JOIN _spec005_actuals a USING (old_name)
         WHERE COALESCE(a.actual_count, 0) <> m.expected_rename_count
         ORDER BY m.old_name
      LOOP
        RAISE NOTICE 'Spec 005: per-name mismatch on "%": expected %, got %',
          r.old_name, r.expected_rename_count, r.actual_count;
      END LOOP;
      RAISE EXCEPTION
        'Spec 005: per-name affected-count assertion failed — rolling back';
    END IF;

    -- 4c. Pre-mutation target-canonical sanity check. Each new_name in the
    --     manifest must already have exactly one is_current = true row in
    --     the target brand (the existing canonical the renamed rows merge
    --     into as non-current siblings). Three distinct target names:
    --     2AM SAUCE, House Special Seasoning (House Mix), Tumeric Seasoning
    --     (House Mix). Spec section 8 build-stop 5.
    SELECT COUNT(*) INTO v_target_canon_count
      FROM public.prep_recipes pr
     WHERE pr.brand_id = v_brand_id
       AND pr.is_current = true
       AND pr.name IN (
         SELECT DISTINCT new_name FROM _spec005_renames
       );

    IF v_target_canon_count <> 3 THEN
      RAISE EXCEPTION
        'Spec 005: expected exactly 3 is_current=true canonicals across the manifest target names, found % — rolling back',
        v_target_canon_count;
    END IF;

    -- 4d. Mutation: single UPDATE driven by the manifest join. Per amendment
    --     #3 the simplified shape is `SET name = m.new_name` only; no
    --     is_current touches. Existing canonicals at the target names are
    --     never visited because they sit at new_name (not old_name) and the
    --     join key is on m.old_name = pr.name.
    UPDATE public.prep_recipes pr
       SET name = m.new_name
      FROM _spec005_renames m
     WHERE pr.name = m.old_name
       AND pr.brand_id = v_brand_id;

    GET DIAGNOSTICS v_renamed_count = ROW_COUNT;

    -- 4e. Grand-total post-UPDATE assertion. Total rows touched MUST equal
    --     the manifest's grand expected count (16 under amendment #3).
    IF v_renamed_count <> v_expected_grand THEN
      RAISE EXCEPTION
        'Spec 005: expected % rows renamed (manifest grand total), got % — rolling back',
        v_expected_grand, v_renamed_count;
    END IF;

    -- 4f. Distinct-name count for the diagnostic NOTICE.
    SELECT COUNT(*) INTO v_name_count FROM _spec005_renames;

    RAISE NOTICE 'Spec 005: renamed % prep_recipes rows across % names (0 is_current flips)',
      v_renamed_count, v_name_count;

  ELSE
    RAISE EXCEPTION
      'Spec 005: unexpected pre-mutation count % (expected 0 or %) — aborting',
      v_actual_grand, v_expected_grand;
  END IF;
END
$$;

COMMIT;
