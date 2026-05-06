-- supabase/migrations/20260504235959_repoint_burger_patty_orphans.sql
--
-- Spec 001: clear 4 orphaned recipe_prep_items.prep_recipe_id values
-- (in brand 2a000000-...) that point at non-current "Burger Patty"
-- prep_recipes rows. Per (recipe_id, unit) group, at most one survivor
-- is repointed to the canonical "Burger Patty" UUID; sibling orphans
-- and survivors made redundant by an external canonical row are DELETEd.
-- See specs/001-repoint-burger-patty-prep-refs.md.
--
-- Control flow: count orphans first; only look up canonical when count = 4.
-- Avoids spurious failures during `db reset --local` (migrations run against
-- an empty DB before seed loads). See spec section 5b.
--
-- The count = 4 repair partitions orphans by (recipe_id, unit) using
-- ROW_NUMBER() — same shape as the dedup migration's survivor-selection.
-- Per group: rank > 1 ("siblings") are always DELETEd; rank = 1 ("survivor")
-- is DELETEd if an external (non-orphan) canonical-pointing row already
-- serves the group, otherwise UPDATEd to canonical. Total deleted + updated
-- MUST equal 4 or the migration aborts. See spec section 5 control flow
-- and section 5b apply-path matrix.
--
-- Idempotent: 0 orphans = no-op success. 4 orphans = repair.
-- Anything else = abort + rollback (do not silently repair an unexpected state).
-- Out of scope: prep_recipe_ingredients (see Spec 002/003).
--
-- Filename note: the 20260504235959 timestamp is load-bearing — it must sort
-- immediately before 20260505000000_dedupe_repointed_ingredient_lines.sql
-- for the populated-without-dedup apply path (Path B-original in section 5b).
-- Do not bump.

BEGIN;

DO $$
DECLARE
  v_brand_id        constant uuid := '2a000000-0000-0000-0000-000000000001';
  v_expected_canon  constant uuid := '500ef28d-3288-4fb8-accb-c3708d1491f9';
  v_canonical_ids   uuid[];
  v_canonical_id    uuid;
  v_orphan_count    int;
  v_deleted_count   int;
  v_updated_count   int;
BEGIN
  -- 1. Apply-context sanity check. If prep_recipes has any visible rows, the
  --    apply context is "real" (not pre-seed db reset). Confirm the canonical
  --    UUID is visible — if not, we're under an RLS-restricted context that
  --    would let the count = 0 branch silently mark a broken environment as
  --    "fixed". Empty prep_recipes (db reset --local before seed) skips this
  --    check by design.
  IF (SELECT COUNT(*) FROM public.prep_recipes) > 0 THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.prep_recipes WHERE id = v_expected_canon
    ) THEN
      RAISE EXCEPTION
        'Spec 001: canonical Burger Patty (%) not visible despite populated prep_recipes — restricted apply context?',
        v_expected_canon;
    END IF;
  END IF;

  -- 2. Count orphans. In-scope orphans = recipe_prep_items rows whose
  --    prep_recipe_id resolves to a "Burger Patty" prep in brand 2a000000-...
  --    with is_current = false. Against an empty DB this naturally returns 0.
  SELECT COUNT(*) INTO v_orphan_count
    FROM public.recipe_prep_items rpi
    JOIN public.prep_recipes pr ON pr.id = rpi.prep_recipe_id
   WHERE pr.name = 'Burger Patty'
     AND pr.brand_id = v_brand_id
     AND pr.is_current = false;

  -- 3. Branch on count. Canonical CURRENCY lookup, drift check, and the
  --    DELETE/UPDATE repair all live ONLY in the count = 4 branch; running
  --    them against an empty DB would fail spuriously. (Visibility was
  --    already validated in step 1.)
  IF v_orphan_count = 0 THEN
    RAISE NOTICE 'Spec 001: no-op (no orphans found — pre-seed apply OR already repaired)';

  ELSIF v_orphan_count = 4 THEN
    -- 4a. Look up the canonical CURRENT "Burger Patty" prep within the brand.
    --     Must be exactly one. Q1: general-within-brand targeting.
    SELECT array_agg(id) INTO v_canonical_ids
      FROM public.prep_recipes
     WHERE name = 'Burger Patty'
       AND brand_id = v_brand_id
       AND is_current = true;

    IF v_canonical_ids IS NULL OR array_length(v_canonical_ids, 1) <> 1 THEN
      RAISE EXCEPTION
        'Spec 001: expected exactly 1 current "Burger Patty" prep in brand %, found %',
        v_brand_id, COALESCE(array_length(v_canonical_ids, 1), 0);
    END IF;

    v_canonical_id := v_canonical_ids[1];

    -- 4b. Drift check against the spec's recorded canonical UUID. Lookup above
    --     is the source of truth; this just catches "wait, the canonical changed".
    IF v_canonical_id <> v_expected_canon THEN
      RAISE EXCEPTION
        'Spec 001: canonical "Burger Patty" UUID drift — expected %, got %',
        v_expected_canon, v_canonical_id;
    END IF;

    -- 4c. Compute per-orphan decisions in a single CTE chain, materialized
    --     into a TEMP TABLE so both the DELETE and the UPDATE see the same
    --     decision set without re-evaluating ROW_NUMBER (which would race
    --     against the DELETE's effects on the source rows). The temp table
    --     is auto-dropped at COMMIT (ON COMMIT DROP).
    --
    --     Decisions per orphan:
    --       'delete' -> rank > 1 in (recipe_id, unit) group, OR
    --                   rank = 1 AND an external canonical row serves the group
    --       'update' -> rank = 1 AND no external canonical in the group
    --
    --     "External canonical" = a recipe_prep_items row at
    --     (recipe_id, prep_recipe_id = canonical_id, unit IS NOT DISTINCT FROM)
    --     whose id is NOT one of the in-scope orphan ids. NOT IN (orphans)
    --     excludes ALL in-scope orphans, not just the one being tested —
    --     otherwise Path A misclassifies orphan-A as orphan-B's external
    --     collision target.
    CREATE TEMP TABLE _spec001_orphan_decisions
      ON COMMIT DROP
      AS
      WITH orphans AS (
        SELECT rpi.id, rpi.recipe_id, rpi.unit
          FROM public.recipe_prep_items rpi
          JOIN public.prep_recipes pr ON pr.id = rpi.prep_recipe_id
         WHERE pr.name = 'Burger Patty'
           AND pr.brand_id = v_brand_id
           AND pr.is_current = false
      ),
      ranked AS (
        SELECT
          o.id,
          o.recipe_id,
          o.unit,
          ROW_NUMBER() OVER (
            PARTITION BY o.recipe_id, o.unit
            ORDER BY o.id
          ) AS rn
        FROM orphans o
      ),
      with_external AS (
        SELECT
          r.id,
          r.rn,
          EXISTS (
            SELECT 1
              FROM public.recipe_prep_items ext
             WHERE ext.recipe_id      = r.recipe_id
               AND ext.prep_recipe_id = v_canonical_id
               AND ext.unit IS NOT DISTINCT FROM r.unit
               AND ext.id NOT IN (SELECT id FROM orphans)
          ) AS has_external_canonical
        FROM ranked r
      )
      SELECT
        id,
        CASE
          WHEN rn > 1 THEN 'delete'
          WHEN has_external_canonical THEN 'delete'
          ELSE 'update'
        END AS action
      FROM with_external;

    -- 4d-DELETE. Remove sibling orphans + redundant survivors.
    --   Path A:          (4, 0) — 3 siblings + 1 redundant survivor.
    --   Path B-original: (3, 1) — 3 siblings deleted.
    --   Path B-revised:  (3, 1) — 3 siblings deleted.
    DELETE FROM public.recipe_prep_items
     WHERE id IN (
       SELECT id FROM _spec001_orphan_decisions WHERE action = 'delete'
     );

    GET DIAGNOSTICS v_deleted_count = ROW_COUNT;

    -- 4d-UPDATE. Repoint surviving orphans (rank = 1, no external canonical).
    --   Path A:          0 updates.
    --   Path B-original: 1 update.
    --   Path B-revised:  1 update.
    UPDATE public.recipe_prep_items
       SET prep_recipe_id = v_canonical_id
     WHERE id IN (
       SELECT id FROM _spec001_orphan_decisions WHERE action = 'update'
     );

    GET DIAGNOSTICS v_updated_count = ROW_COUNT;

    -- 4e. Strictness: total rows affected (deleted + updated) MUST equal 4.
    --     This preserves the 0/4/else contract at the total-rows-affected
    --     level, regardless of how the 4 split between the two operations.
    IF v_deleted_count + v_updated_count <> 4 THEN
      RAISE EXCEPTION
        'Spec 001: expected total 4 rows affected (deleted + updated), got % deleted + % updated = % — rolling back',
        v_deleted_count, v_updated_count, v_deleted_count + v_updated_count;
    END IF;

    RAISE NOTICE 'Spec 001: cleared 4 Burger Patty orphans (% deleted as collisions, % repointed to canonical %)',
      v_deleted_count, v_updated_count, v_canonical_id;

  ELSE
    RAISE EXCEPTION
      'Spec 001: unexpected orphan count % (expected 0 or 4) — aborting',
      v_orphan_count;
  END IF;
END
$$;

COMMIT;
