-- supabase/migrations/20260507040000_spec003_repoint_or_delete_ingredient_orphans.sql
--
-- Spec 003: clear 399 orphaned prep_recipe_ingredients.prep_recipe_id rows
-- (in brand 2a000000-...) that point at non-current prep_recipes rows.
-- See specs/003-prep-recipe-ingredients-orphans.md (Backend design §0–§13).
--
-- Strategy resolved per the spec's Q1: "delete divergent, repoint matching".
-- Architect's §5 finding (apply-path matrix): under the live unique index
-- prep_recipe_ingredients_logical_unique on (prep_recipe_id, type, catalog_id,
-- sub_recipe_id, unit), repointing a "matching" orphan onto the canonical's
-- prep_recipe_id collides immediately because the canonical already has the
-- equivalent row. The semantically-equivalent operation that preserves the
-- canonical's authoritative ingredient list is to DELETE the orphan in both
-- branches:
--   - matching orphan: canonical already has the row → orphan is redundant
--   - divergent orphan: canonical's row is authoritative → orphan is discarded
-- After both DELETEs, the orphan source prep_recipes rows have zero
-- prep_recipe_ingredients pointing at them, and the canonical preps' ingredient
-- lists are byte-identical pre/post migration.
--
-- Control flow: count orphans first; only proceed if count = 0 (no-op) or
-- count = 399 (expected). Mirrors Spec 001's count-first idempotency pattern.
--
-- Per-prep assertions: the _spec003_expectations temp table encodes the
-- per-name (repoint, delete) expected counts certified at probe time
-- (2026-05-07, post-Spec-005 + post-Spec-006 prod state). Mismatch on any
-- per-prep row aborts with diagnostic NOTICEs naming which prep diverged.
--
-- Probe certification (local, 2026-05-07):
--   gate_1 grand total       = 399
--   gate_1b distinct sources = 52
--   gate_5 cross-brand       = 1 brand only (2a000000-...)
--   gate_7 sub_recipe        = 0 orphans (no regression)
--
-- Per-prep certified counts (gate_4):
--   2AM SAUCE                           : 155 repoint, 35 delete = 190
--   House Special Seasoning (House Mix) :  48 repoint,  8 delete =  56
--   Cajun Seasoning (House Mix)         :  44 repoint,  4 delete =  48
--   White Sauce                         :  24 repoint, 12 delete =  36
--   Burger Patty                        :  20 repoint,  8 delete =  28
--   Tumeric Seasoning (House Mix)       :  25 repoint,  0 delete =  25
--   Yellow Rice                         :  16 repoint,  0 delete =  16
--   Grand total                         : 332 repoint, 67 delete = 399
--
-- Apply-path matrix (per design §5):
--   A) db push to remote (live populated)        — 399 orphans → DELETEs apply
--   B) db reset --local (empty DB at apply time) — 0 orphans → no-op
--   C) re-run after success                      — 0 orphans → no-op
--
-- Idempotent: 0 orphans = no-op success. 399 orphans = full repair.
-- Anything else = abort + rollback. No partial repair under unexpected state.
--
-- Filename note: the 20260507040000 timestamp is load-bearing — it must sort
-- AFTER 20260507030000_spec006_* (dedup index live; Spec 006 cleanup applied).
-- It does NOT need to sort before any future migration.
--
-- RLS: migration runs as `postgres` superuser via `supabase db push` /
-- `db reset`. Table has policies (per brand-catalog refactor migrations) but
-- they are bypassed by superuser. DELETEs do not fire WITH CHECK.
-- No realtime publication change. No UI / edge function impact.
--
-- Out of scope (per spec):
--   - Deleting now-unreferenced non-current prep_recipes (the 52 sources)
--   - Constraint guards (trigger / partial unique index on is_current)
--   - Variant-name unification (Spec 005 already handled the four name renames)
--   - sub_recipe_id repair (gate 7 confirmed 0 orphans)

BEGIN;

DO $$
DECLARE
  v_brand_id              constant uuid := '2a000000-0000-0000-0000-000000000001';
  v_grand_total_expected  constant int  := 399;
  v_orphan_count          int;
  v_repointed_count       int;
  v_deleted_count         int;
  v_canon_visible_count   int;
  v_mismatch_found        boolean := false;
  r                       record;
BEGIN
  -- 1. Count orphans first (Spec 001 lessons learned: count before canonical
  --    lookup). Avoids spurious failures during `db reset --local` (migrations
  --    run against an empty DB before seed loads).
  SELECT COUNT(*) INTO v_orphan_count
    FROM public.prep_recipe_ingredients pri
    JOIN public.prep_recipes pr ON pr.id = pri.prep_recipe_id
   WHERE pr.is_current = false;

  IF v_orphan_count = 0 THEN
    RAISE NOTICE 'Spec 003: no-op (no orphans found — pre-seed apply OR already repaired)';

  ELSIF v_orphan_count = v_grand_total_expected THEN
    -- 2. Apply-context sanity check: if non-current preps are visible at
    --    expected count, the canonical preps for the affected names must also
    --    be visible. Defends against partial-RLS-hiding silent no-op.
    SELECT COUNT(*) INTO v_canon_visible_count
      FROM public.prep_recipes
     WHERE is_current = true
       AND brand_id = v_brand_id
       AND name IN (
         '2AM SAUCE',
         'House Special Seasoning (House Mix)',
         'Cajun Seasoning (House Mix)',
         'White Sauce',
         'Burger Patty',
         'Tumeric Seasoning (House Mix)',
         'Yellow Rice'
       );

    IF v_canon_visible_count < 7 THEN
      RAISE EXCEPTION 'Spec 003: % orphans visible but only % of 7 canonical preps visible — restricted apply context?',
        v_orphan_count, v_canon_visible_count;
    END IF;

    -- 3. Build the expectations manifest (architect-certified per-prep counts
    --    from the 2026-05-07 probe).
    CREATE TEMP TABLE _spec003_expectations (
      prep_name             text PRIMARY KEY,
      expected_repoint_cnt  int  NOT NULL,
      expected_delete_cnt   int  NOT NULL
    ) ON COMMIT DROP;

    INSERT INTO _spec003_expectations (prep_name, expected_repoint_cnt, expected_delete_cnt) VALUES
      ('2AM SAUCE',                           155, 35),
      ('House Special Seasoning (House Mix)',  48,  8),
      ('Cajun Seasoning (House Mix)',          44,  4),
      ('White Sauce',                          24, 12),
      ('Burger Patty',                         20,  8),
      ('Tumeric Seasoning (House Mix)',        25,  0),
      ('Yellow Rice',                          16,  0);

    -- 4. Classify orphans into matching/divergent. NULL handling matches the
    --    dedup index semantics: catalog_id, sub_recipe_id, unit, quantity
    --    compared with IS NOT DISTINCT FROM; type compared via COALESCE(*, 'raw').
    CREATE TEMP TABLE _spec003_orphan_decisions (
      orphan_id      uuid PRIMARY KEY,
      prep_name      text NOT NULL,
      classification text NOT NULL CHECK (classification IN ('matching', 'divergent'))
    ) ON COMMIT DROP;

    INSERT INTO _spec003_orphan_decisions (orphan_id, prep_name, classification)
    WITH orphans AS (
      SELECT pri.id           AS orphan_id,
             pr.name          AS prep_name,
             pr.brand_id      AS brand_id,
             pri.catalog_id,
             pri.sub_recipe_id,
             COALESCE(pri.type, 'raw') AS type,
             pri.unit,
             pri.quantity
        FROM public.prep_recipe_ingredients pri
        JOIN public.prep_recipes pr ON pr.id = pri.prep_recipe_id
       WHERE pr.is_current = false
    ),
    canonicals AS (
      SELECT pr.name           AS prep_name,
             pr.brand_id       AS brand_id,
             pri.catalog_id,
             pri.sub_recipe_id,
             COALESCE(pri.type, 'raw') AS type,
             pri.unit,
             pri.quantity
        FROM public.prep_recipe_ingredients pri
        JOIN public.prep_recipes pr ON pr.id = pri.prep_recipe_id
       WHERE pr.is_current = true
         AND pr.name IN (SELECT DISTINCT prep_name FROM orphans)
    )
    SELECT o.orphan_id,
           o.prep_name,
           CASE WHEN EXISTS (
             SELECT 1 FROM canonicals c
              WHERE c.prep_name    = o.prep_name
                AND c.brand_id     = o.brand_id
                AND c.catalog_id    IS NOT DISTINCT FROM o.catalog_id
                AND c.sub_recipe_id IS NOT DISTINCT FROM o.sub_recipe_id
                AND c.type          = o.type
                AND c.unit          IS NOT DISTINCT FROM o.unit
                AND c.quantity      IS NOT DISTINCT FROM o.quantity
           ) THEN 'matching' ELSE 'divergent' END
      FROM orphans o;

    -- 5. Per-prep assertion BEFORE mutation. Validates the classification
    --    matches the architect's manifest before any rows are touched.
    --    Diagnostic NOTICE per mismatched prep, then RAISE EXCEPTION.
    FOR r IN
      SELECT e.prep_name,
             e.expected_repoint_cnt,
             e.expected_delete_cnt,
             COALESCE(a.actual_repoint_cnt, 0) AS actual_repoint_cnt,
             COALESCE(a.actual_delete_cnt, 0)  AS actual_delete_cnt
        FROM _spec003_expectations e
        LEFT JOIN (
          SELECT prep_name,
                 COUNT(*) FILTER (WHERE classification = 'matching')  AS actual_repoint_cnt,
                 COUNT(*) FILTER (WHERE classification = 'divergent') AS actual_delete_cnt
            FROM _spec003_orphan_decisions
           GROUP BY prep_name
        ) a USING (prep_name)
       WHERE COALESCE(a.actual_repoint_cnt, 0) <> e.expected_repoint_cnt
          OR COALESCE(a.actual_delete_cnt, 0)  <> e.expected_delete_cnt
    LOOP
      v_mismatch_found := true;
      RAISE NOTICE 'Spec 003: per-prep mismatch on "%": expected (% repoint, % delete), got (% repoint, % delete)',
        r.prep_name, r.expected_repoint_cnt, r.expected_delete_cnt,
        r.actual_repoint_cnt, r.actual_delete_cnt;
    END LOOP;

    -- Also detect orphans whose prep_name is NOT in the manifest at all
    -- (would mean a new affected name surfaced post-probe).
    FOR r IN
      SELECT d.prep_name, COUNT(*) AS actual_total
        FROM _spec003_orphan_decisions d
        LEFT JOIN _spec003_expectations e USING (prep_name)
       WHERE e.prep_name IS NULL
       GROUP BY d.prep_name
    LOOP
      v_mismatch_found := true;
      RAISE NOTICE 'Spec 003: unexpected affected prep "%" (% orphans) not in manifest',
        r.prep_name, r.actual_total;
    END LOOP;

    IF v_mismatch_found THEN
      RAISE EXCEPTION 'Spec 003: per-prep classification did not match architect-certified manifest — rolling back';
    END IF;

    -- 6. Mutation 1: DELETE matching orphans (canonical already has the row).
    --    Counted as "repointed" semantically — orphan's information is
    --    preserved via canonical's pre-existing equivalent row.
    DELETE FROM public.prep_recipe_ingredients
     WHERE id IN (
       SELECT orphan_id FROM _spec003_orphan_decisions WHERE classification = 'matching'
     );
    GET DIAGNOSTICS v_repointed_count = ROW_COUNT;

    -- 7. Mutation 2: DELETE divergent orphans (canonical's row is authoritative;
    --    orphan's divergent content is discarded per Q1 directive).
    DELETE FROM public.prep_recipe_ingredients
     WHERE id IN (
       SELECT orphan_id FROM _spec003_orphan_decisions WHERE classification = 'divergent'
     );
    GET DIAGNOSTICS v_deleted_count = ROW_COUNT;

    -- 8. Grand-total assertion (defense-in-depth; per-prep assert in step 5
    --    should already guarantee this, but explicit grand-total is cheap).
    IF v_repointed_count + v_deleted_count <> v_grand_total_expected THEN
      RAISE EXCEPTION 'Spec 003: expected % total rows affected, got % matching-deduped + % divergent-discarded = %',
        v_grand_total_expected, v_repointed_count, v_deleted_count,
        v_repointed_count + v_deleted_count;
    END IF;

    RAISE NOTICE 'Spec 003: cleared % orphans (% matching-deduped, % divergent-discarded) across 7 preps',
      v_repointed_count + v_deleted_count, v_repointed_count, v_deleted_count;

  ELSE
    RAISE EXCEPTION
      'Spec 003: unexpected orphan count % (expected 0 or %) — aborting',
      v_orphan_count, v_grand_total_expected;
  END IF;
END
$$;

COMMIT;
