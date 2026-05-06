# Spec 001: Repoint orphaned "Burger Patty" prep references

Status: READY_FOR_BUILD

## User story
As a downstream consumer of the `pwa-catalog` edge function (the customer PWA), I want every `recipes[].prep_items[].prep_recipe_id` returned by the catalog to resolve to an entry in the top-level `prep_recipes[]` array, so that the "2AM Cheeseburger" recipe stops triggering the "unresolved-prep" warning banner and renders its prep ingredients correctly.

## Background
A previous migration (`supabase/migrations/20260504062318_brand_catalog_p2_backfill.sql`) deduplicated "Burger Patty" prep recipes by marking duplicates as `is_current = false`. However, four `recipe_prep_items` rows belonging to the "2AM Cheeseburger" recipe were left pointing at non-current duplicate `prep_recipe_id` values rather than at the canonical current row. The `pwa-catalog` edge function emits `prep_recipes[]` filtered to `is_current = true`, so these four references appear in `recipes[].prep_items[]` but cannot be resolved against the top-level array.

## Confirmed pre-existing facts (do not re-verify)
- 4 orphan `recipe_prep_items` rows.
- 4 non-current `prep_recipe_id` values (8-char prefixes): `cee2cc2a`, `34c637a8`, `156565d4`, `a3d56b0a`.
- 1 canonical replacement, full UUID: `500ef28d-3288-4fb8-accb-c3708d1491f9`.
- 1 affected recipe: "2AM Cheeseburger".
- All five `prep_recipes` rows belong to brand `2a000000-...`.
- All four orphans are duplicates of the same canonical "Burger Patty" prep.
- No dangling FKs, no cross-brand issues identified in the original probe.

## Acceptance criteria
- [ ] A new timestamped migration is added under `supabase/migrations/` following the established `YYYYMMDDHHMMSS_description.sql` naming convention.
- [ ] The migration is wrapped in an atomic transaction (`BEGIN` / `COMMIT`).
- [ ] The migration asserts that the canonical UUID `500ef28d-3288-4fb8-accb-c3708d1491f9` exists in `prep_recipes` AND has `is_current = true`. If not, `RAISE EXCEPTION` and abort.
- [ ] The migration counts the orphan `recipe_prep_items` rows in scope (rows in brand `2a000000-...` whose `prep_recipe_id` resolves to a "Burger Patty" prep with `is_current = false`) before mutating anything.
  - If the orphan count is exactly **0**, exit successfully as a no-op (idempotent re-run path).
  - If the orphan count is exactly **4**, repoint those 4 rows to the canonical UUID, then verify exactly 4 rows were updated. If the affected row count differs from 4, `RAISE EXCEPTION` and roll back.
  - If the orphan count is anything other than 0 or 4 (e.g., 1, 2, 3, 5+), `RAISE EXCEPTION` and roll back. Do not partially repair an unexpected state.
- [ ] After the migration is applied, re-running the orphan-count probe SQL returns 0 rows.
- [ ] After the migration is applied, hitting the local `pwa-catalog` edge function returns a payload where every `recipes[].prep_items[].prep_recipe_id` for the "2AM Cheeseburger" recipe appears in the top-level `prep_recipes[]` array.
- [ ] The migration has been reviewed by the security-auditor for RLS implications (writes touching `recipe_prep_items` under per-store RLS hardening — see `supabase/migrations/20260504173035_per_store_rls_hardening.sql`).
- [ ] The migration has been reviewed by the backend-architect for migration convention adherence (filename format, helper function usage such as `auth_can_see_store()` / `auth_is_admin()` if relevant, `SECURITY DEFINER` semantics if used, transaction style, comment style).

## Pre-implementation gate: sibling-table orphan probe
Before the architect designs the migration, run the following probe and document results inline in this spec (under "Probe results" below). Do NOT auto-expand scope based on the results — surface findings to the user, who decides whether sibling cleanup gets folded in or filed as a follow-up spec.

The probe must:
1. Enumerate every table in the `public` schema with a foreign key referencing `prep_recipes(id)` (use `information_schema.referential_constraints` joined to `key_column_usage`, or `pg_catalog.pg_constraint`).
2. For each such table, count rows whose `prep_recipe_id` (or equivalent column) points at a `prep_recipes` row with `is_current = false`.
3. Report per-table orphan counts back to the user as a checklist.

**Expected outcome based on the original probe:** only `recipe_prep_items` should have orphans, with count = 4. Anything else is news and must be surfaced before this spec proceeds.

### Probe results
_Run 2026-05-05 against local DB (`docker exec ... psql` against `supabase_db_imr-inventory`)._

- [x] `recipe_prep_items` orphan count: **4** (matches expectation)
- [x] Other FK-referencing tables enumerated: 3 FKs total to `prep_recipes(id)`:
  - `recipe_prep_items.prep_recipe_id`
  - `prep_recipe_ingredients.prep_recipe_id`
  - `prep_recipe_ingredients.sub_recipe_id`
- [x] Orphans found in any other table: **YES — see "Blocked" section below.**

#### Per-column orphan counts

| Column | Dangling (FK target missing) | Non-current (`is_current = false`) | Total orphans |
|---|---|---|---|
| `recipe_prep_items.prep_recipe_id` | 0 | 4 | **4** |
| `prep_recipe_ingredients.prep_recipe_id` | 0 | 399 | **399** |
| `prep_recipe_ingredients.sub_recipe_id` | 0 | 0 | 0 (459 rows are NULL, ignored) |

#### Probe SQL (reproducible)

```sql
-- 1. Enumerate FKs to prep_recipes(id):
SELECT con.conname, src_tbl.relname AS src_table, src_col.attname AS src_column
FROM pg_catalog.pg_constraint con
JOIN pg_catalog.pg_class      src_tbl ON src_tbl.oid = con.conrelid
JOIN pg_catalog.pg_namespace  src_ns  ON src_ns.oid  = src_tbl.relnamespace
JOIN pg_catalog.pg_class      tgt_tbl ON tgt_tbl.oid = con.confrelid
JOIN pg_catalog.pg_namespace  tgt_ns  ON tgt_ns.oid  = tgt_tbl.relnamespace
JOIN pg_catalog.pg_attribute  src_col ON src_col.attrelid = con.conrelid AND src_col.attnum = con.conkey[1]
WHERE con.contype = 'f' AND tgt_ns.nspname = 'public' AND tgt_tbl.relname = 'prep_recipes'
ORDER BY src_tbl.relname;

-- 2. Per-column orphan count (one query per FK column, with FILTER to split classes):
SELECT '<col_path>' AS column_path,
       COUNT(*) FILTER (WHERE pr.id IS NULL)                                AS dangling,
       COUNT(*) FILTER (WHERE pr.id IS NOT NULL AND pr.is_current = false)  AS non_current,
       COUNT(*) FILTER (WHERE pr.id IS NULL OR pr.is_current = false)       AS total_orphans
FROM public.<src_table> t
LEFT JOIN public.prep_recipes pr ON pr.id = t.<src_column>;

-- 3. Characterization of the prep_recipe_ingredients.prep_recipe_id orphans:
SELECT pr.name, pr.brand_id::text AS brand, COUNT(*) AS orphan_rows
FROM public.prep_recipe_ingredients t
JOIN public.prep_recipes pr ON pr.id = t.prep_recipe_id
WHERE pr.is_current = false
GROUP BY pr.name, pr.brand_id
ORDER BY orphan_rows DESC;
```

## Sibling-table finding (out of scope — logged for follow-up)

The probe surfaced a much larger orphan population in a sibling table (`prep_recipe_ingredients`). This was reviewed by the user on 2026-05-05 and **explicitly excluded from this spec's scope**. Findings recorded here for traceability and to seed follow-up specs.

### What was found
`prep_recipe_ingredients.prep_recipe_id` has **399 orphan rows** pointing at non-current `prep_recipes`. Characterization:

- **52** distinct non-current `prep_recipe_id` values affected (vs 4 in `recipe_prep_items`)
- **10** distinct prep names affected, all in **1** brand (`2a000000-0000-0000-0000-000000000001`) — same brand as the original 4-row bug
- Top offenders by orphan-row count:

| Prep name | Orphan ingredient rows |
|---|---|
| 2AM SAUCE | 150 |
| House Special Seasoning Mix | 56 |
| Cajun Seasoning (House Mix) | 48 |
| White Sauce | 36 |
| 2AM Sauce | 30 |
| Burger Patty | 28 |
| Tumeric Mix | 20 |
| Yellow Rice | 16 |
| 2AM SAUCE 10 | 10 |
| Tumeric Seasoning (House Mix) | 5 |

Notable: `2AM SAUCE` (150) and `2AM Sauce` (30) and `2AM SAUCE 10` (10) all appear separately — case- and suffix-variant duplicates that the dedup either did not collapse or collapsed in the opposite direction from how `prep_recipe_ingredients` was repointed. **"Burger Patty" itself has 28 orphan ingredient rows** in addition to the 4 `recipe_prep_items` orphans this spec was written to fix.

### Why this matters
The original 4-row `recipe_prep_items` bug is the visible tip; `prep_recipe_ingredients` (which defines what each prep is MADE OF) carries a ~100x larger version of the same root cause from the Phase 2 backfill. The semantic impact differs from the `recipe_prep_items` case:

- `recipe_prep_items` orphans break a downstream API contract (the `pwa-catalog` `prep_recipes[]` lookup).
- `prep_recipe_ingredients` orphans do NOT necessarily break any external contract — a non-current prep with intact ingredient rows is internally consistent. Whether the orphans matter depends on whether the canonical and non-canonical versions of each prep have DIFFERENT ingredient lists. That has not been investigated and is out of scope for this probe.

### Decision (2026-05-05)
- **Do NOT expand this spec.** The 4-row `recipe_prep_items` fix proceeds independently as originally scoped.
- **File as separate specs** after Spec 001 ships and proves stable:
  - **Spec 002 (investigation):** Determine whether canonical and non-canonical versions of each affected prep (`2AM SAUCE`, `House Special Seasoning Mix`, etc.) have divergent ingredient lists. The ingredient-divergence question only matters for `prep_recipe_ingredients` cleanup; if ingredients diverge, naive repointing would silently change recipe behavior.
  - **Spec 003 (cleanup):** Repoint the 399 `prep_recipe_ingredients.prep_recipe_id` orphans, informed by the Spec 002 findings.

### Why proceeding with Spec 001 in isolation is safe
The 399 `prep_recipe_ingredients` finding does NOT change the safety analysis for the 4 `recipe_prep_items` rows in scope here:

- `recipe_prep_items` has no ingredient list of its own — it only carries a `prep_recipe_id` reference plus quantity/unit. Repointing the reference cannot change "what the prep is made of"; that's `prep_recipe_ingredients`' concern.
- The four orphan refs all collapse onto a single canonical "Burger Patty" prep that already exists with `is_current = true`. The repoint changes which `prep_recipes` row the cheeseburger lookup table points to; it does not change the cheeseburger's recipe.
- The Spec 001 fix is therefore independent of and unblocked by the Spec 002/003 work.

## Migration shape (illustrative — architect owns final form)
The migration must encode the idempotency-vs-strictness contract above. The intended control flow:

```
BEGIN;

-- 1. Assert canonical exists and is current.
--    RAISE EXCEPTION if not.

-- 2. Count orphan recipe_prep_items rows in brand 2a000000-...
--    whose prep_recipe_id maps to a "Burger Patty" prep with is_current = false.

-- 3. Branch on count:
--      = 0  -> RAISE NOTICE 'no-op, already repointed'; COMMIT.
--      = 4  -> UPDATE those 4 rows to point at the canonical UUID;
--              verify GET DIAGNOSTICS row_count = 4;
--              RAISE EXCEPTION if not exactly 4.
--      else -> RAISE EXCEPTION 'unexpected orphan count: %', n.

COMMIT;
```

The architect should confirm whether targeting belongs in pure SQL or inside a `DO $$ ... $$` block, and whether the brand UUID + canonical UUID should be referenced as literals or looked up by name within the same migration.

## In scope
- One new SQL migration in `supabase/migrations/` that repoints the 4 orphan `recipe_prep_items.prep_recipe_id` values to canonical UUID `500ef28d-3288-4fb8-accb-c3708d1491f9`.
- Pre-implementation probe of all sibling tables that FK to `prep_recipes.id`, with results recorded in this spec.
- Local verification via the orphan-count probe SQL and the `pwa-catalog` edge function payload.

## Out of scope (explicitly)
- **Deleting the 4 orphaned non-current `prep_recipes` rows.** Tracked as a separate follow-up spec after this one ships and proves stable. Repointing references is reversible; deleting `prep_recipes` rows is not.
- **Auto-expanding to other sibling tables.** If the probe finds orphans elsewhere, the user decides whether to expand — the implementer does not.
- **Changes to the `pwa-catalog` edge function.** The function's `is_current = true` filter is correct; the bug is bad data, not bad code.
- **Client-side ("unresolved-prep" banner) verification.** Customer PWA is not runnable locally in this repo.
- **UI changes in `imr-inventory`.** Backend data fix only — no Cmd UI section, no legacy admin screen, nothing to wire up in the app.
- **A general-purpose deduplication tool or cron.** This is a one-shot fix for a known incident.

## Open questions resolved
- Q1 — Targeting strategy → A: General-within-brand with hard assertions. Repoint any non-current "Burger Patty" `recipe_prep_items` refs in brand `2a000000-...` to the canonical current one. Must fail loudly if it would change MORE OR FEWER than 4 rows.
- Q2 — Delete the 4 orphaned non-current `prep_recipes` rows → A: Out of scope. Separate follow-up spec.
- Q3 — Sibling tables that reference `prep_recipes.id` → A: Investigate first via the pre-implementation probe gate above. Surface findings; do not auto-expand.
- Q4 — Transactional safety → A: Yes to all — `BEGIN/COMMIT`, `RAISE EXCEPTION` if affected count != 4, assert canonical UUID exists and `is_current = true` before updating, idempotent (count = 0 is success).
- Q5 — Acceptance criteria → A: (a) orphan-count probe = 0, (b) `pwa-catalog` payload self-consistent for 2AM Cheeseburger, plus (NEW) explicit security-auditor RLS review and backend-architect migration-convention review.

## Idempotency contract (explicit, because Q1 and Q4 are in tension)
The strictness rule from Q1 ("fail if !=4 rows would change") and the idempotency rule from Q4 ("safe to re-run as a no-op") are reconciled as follows:

- The migration first **counts** orphan rows that would be repointed, before issuing any `UPDATE`.
- **Count = 0** → already repaired (or never broken in this environment). Exit success without mutating anything. This is the re-run path.
- **Count = 4** → expected first-run state. Issue the `UPDATE`, verify exactly 4 rows changed, commit.
- **Count = anything else** → unexpected database state. Abort with `RAISE EXCEPTION` and roll back. Do not silently repair.

This makes the migration safe to apply against: (a) a broken environment (fixes it), (b) an already-fixed environment (no-op), (c) any other environment (loud failure, no partial writes).

## Dependencies
- Existing migration `supabase/migrations/20260504062318_brand_catalog_p2_backfill.sql` (the migration that introduced the orphans).
- Existing migration `supabase/migrations/20260504173035_per_store_rls_hardening.sql` (RLS context the security-auditor must review the new migration against).
- Existing edge function `supabase/functions/pwa-catalog/` (used for acceptance verification; not modified).
- Local Supabase dev stack (`npm run dev:db`) for verification.

## Project-specific notes
- **Cmd UI section / legacy:** N/A — backend-only data fix, no UI surface.
- **Per-store or admin-global:** Brand-scoped (`2a000000-...`). Migration runs as superuser at apply time; RLS does not gate the migration itself, but the security-auditor must confirm the write does not violate any post-apply invariant under per-store RLS. This migration assumes superuser apply context (standard supabase db push or local apply). If applied through a non-superuser path, the row-count assertions could fail silently due to RLS visibility. Architect/developer must confirm the apply path before merge. If non-superuser apply ever becomes possible, this migration must be revisited.
- **Realtime channels touched:** `brand-2a000000-...` will fire on the `recipe_prep_items` UPDATE if that table is in the realtime publication. Connected clients will reload — expected and benign. Note the realtime publication gotcha (mid-session pub changes need `docker restart supabase_realtime_imr-inventory`); this migration does not change the publication, so no restart needed.
- **Migrations needed:** Yes — one new timestamped SQL migration.
- **Edge functions touched:** None modified. `pwa-catalog` used for verification only.
- **Web/native scope:** N/A — backend-only.
- **Tests:** No test framework wired up in this repo. Verification is manual via the orphan-count probe SQL and a `curl` against the local `pwa-catalog` function. No need to introduce a test framework for this fix.
- **`app.json` slug:** Not touched.

## Backend design

### 0. Open questions
None blocking. The acceptance criteria, Q1–Q5 resolutions, and the "Decision (2026-05-05)" + "Why proceeding with Spec 001 in isolation is safe" sections fully constrain the design.

### 1. Pure SQL vs `DO $$ ... $$` block — decision: **`DO $$ ... $$` block**
Pure SQL cannot satisfy the acceptance criteria. The contract requires:
- Conditional branching on a row count (0 → no-op success; 4 → repair; else → `RAISE EXCEPTION`).
- A pre-write assertion that the canonical UUID exists with `is_current = true`.
- A post-write assertion via `GET DIAGNOSTICS ... = ROW_COUNT` against the expected `4`.

All three require PL/pgSQL control flow (`IF / ELSIF / ELSE`, `RAISE`, `GET DIAGNOSTICS`). A `DO $$ ... $$` block is the conventional carrier for one-shot migrations of this shape — confirmed by the directly-related precedent `supabase/migrations/20260504062318_brand_catalog_p2_backfill.sql`, which uses the same pattern (`DECLARE v_brand_id constant uuid := '2a000000-...'`, `GET DIAGNOSTICS v_count = ROW_COUNT`, `RAISE NOTICE`). No reusable function is needed because this is a one-shot incident repair, not a generalized cleanup utility.

### 2. UUID literals vs name lookup — decision: **brand UUID literal, canonical UUID lookup with assertion**
Per Q1 ("general-within-brand"), the canonical row must be **looked up** by `(name, brand_id, is_current)` rather than hardcoded — that's what makes the migration "general within the brand" and not a single-UUID-to-single-UUID rewrite. Brand UUID stays a literal because brand identity is stable, the precedent migration treats `'2a000000-0000-0000-0000-000000000001'` as a `constant uuid` literal, and looking the brand up by name would introduce a fresh failure mode (brand renamed) for zero benefit.

Concretely:
- **Brand UUID:** literal `'2a000000-0000-0000-0000-000000000001'::uuid`, declared as `constant` in the `DECLARE` block.
- **Canonical prep UUID:** looked up via `SELECT id FROM prep_recipes WHERE name = 'Burger Patty' AND brand_id = v_brand_id AND is_current = true`. Must return **exactly one row**. Implementation pattern (architect-supplied, developer authors final):

  ```sql
  -- Inside the DO block:
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

  -- Belt-and-suspenders check against the spec's recorded UUID (drift detection,
  -- not the source of truth — the lookup above is the source of truth):
  IF v_canonical_id <> '500ef28d-3288-4fb8-accb-c3708d1491f9'::uuid THEN
    RAISE EXCEPTION
      'Spec 001: canonical "Burger Patty" UUID drift — expected %, got %',
      '500ef28d-3288-4fb8-accb-c3708d1491f9'::uuid, v_canonical_id;
  END IF;
  ```

  The drift-detection check satisfies acceptance criterion line 23 ("asserts that the canonical UUID `500ef28d-...` exists in `prep_recipes` AND has `is_current = true`") without making the migration UUID-coupled in its primary path.

### 3. Migration filename — `supabase/migrations/20260505000000_repoint_burger_patty_orphans.sql`
- Convention: `YYYYMMDDHHMMSS_snake_case.sql` per `supabase/migrations/`.
- Date: 2026-05-05 (today). Time component `000000` chosen to sort cleanly after the 2026-05-04 brand-catalog Phase 2/3/5 migrations and before any other 2026-05-05 work — there are currently no other migrations dated 2026-05-05, so any time within the day works. Developer may bump to wall-clock time at apply if another 2026-05-05 migration lands first (filename is design-time guidance, not a contract).
- Description: `repoint_burger_patty_orphans` — short, snake_case, names the action and the affected entity.

### 4. RLS / `SECURITY DEFINER` considerations — decision: **no `SECURITY DEFINER`, no policy changes**
- This is a one-shot migration, not a callable function. `SECURITY DEFINER` only applies to functions; the `DO` block runs as the migration role. No semantics to add.
- Migrations are applied by the `postgres` superuser via `supabase db push` / local `supabase db reset`, which bypasses RLS. The acceptance criteria (count assertions, exact-4 update count) therefore see the full table, not an RLS-filtered view. This is the only safe apply context — flagged in the existing "Project-specific notes" section (line 199, "superuser apply context") and re-flagged in section 7 below.
- **Policies the security-auditor must review against** (all defined in `supabase/migrations/20260504173035_per_store_rls_hardening.sql` and the brand-catalog Phase 5 file). For `recipe_prep_items` specifically, the auditor must check the `UPDATE` policy chain currently in force. The hardening migration above does **not** touch `recipe_prep_items` directly (it covers `inventory_items`, `eod_*`, `waste_log`, `audit_log`, `purchase_orders`, `po_items`, `pos_imports`, `pos_import_items`). `recipe_prep_items` policies live in earlier migrations — auditor must:
  1. Enumerate current `recipe_prep_items` policies (`SELECT polname FROM pg_policy WHERE polrelid = 'public.recipe_prep_items'::regclass`).
  2. Confirm none of them would reject this `UPDATE` when run as `postgres` (they won't — `postgres` bypasses RLS — but document the assumption).
  3. Confirm the post-update row state does not violate any `WITH CHECK` clause. Since we are only changing `prep_recipe_id` (not `recipe_id` or any store/brand-scoped column), and the new value is itself a valid `prep_recipes` row in the same brand, no policy invariant changes.
- No new policies are introduced. No helper-function changes (`auth_can_see_store()` / `auth_is_admin()` untouched).

### 5. Concrete migration sketch (developer refines, this is the contract)
```sql
-- supabase/migrations/20260505000000_repoint_burger_patty_orphans.sql
--
-- Spec 001: repoint 4 orphaned recipe_prep_items.prep_recipe_id values
-- (in brand 2a000000-...) from non-current "Burger Patty" prep_recipes
-- to the single canonical current one. See specs/001-repoint-burger-patty-prep-refs.md.
--
-- Idempotent: 0 orphans = no-op success. 4 orphans = repair.
-- Anything else = abort + rollback (do not silently repair an unexpected state).
-- Out of scope: prep_recipe_ingredients (see Spec 002/003).

BEGIN;

DO $$
DECLARE
  v_brand_id        constant uuid := '2a000000-0000-0000-0000-000000000001';
  v_expected_canon  constant uuid := '500ef28d-3288-4fb8-accb-c3708d1491f9';
  v_canonical_ids   uuid[];
  v_canonical_id    uuid;
  v_orphan_count    int;
  v_updated_count   int;
BEGIN
  -- 1. Look up the canonical current "Burger Patty" prep within the brand.
  --    Must be exactly one. Q1: general-within-brand targeting.
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

  -- 2. Drift check against the spec's recorded canonical UUID. Lookup above is
  --    the source of truth; this just catches "wait, the canonical changed".
  IF v_canonical_id <> v_expected_canon THEN
    RAISE EXCEPTION
      'Spec 001: canonical "Burger Patty" UUID drift — expected %, got %',
      v_expected_canon, v_canonical_id;
  END IF;

  -- 3. Count orphans BEFORE mutating. In-scope orphans = recipe_prep_items rows
  --    whose prep_recipe_id resolves to a "Burger Patty" prep in brand
  --    2a000000-... with is_current = false.
  SELECT COUNT(*) INTO v_orphan_count
    FROM public.recipe_prep_items rpi
    JOIN public.prep_recipes pr ON pr.id = rpi.prep_recipe_id
   WHERE pr.name = 'Burger Patty'
     AND pr.brand_id = v_brand_id
     AND pr.is_current = false;

  -- 4. Branch on count.
  IF v_orphan_count = 0 THEN
    RAISE NOTICE 'Spec 001: no-op, recipe_prep_items already repointed';
  ELSIF v_orphan_count = 4 THEN
    UPDATE public.recipe_prep_items rpi
       SET prep_recipe_id = v_canonical_id
      FROM public.prep_recipes pr
     WHERE pr.id = rpi.prep_recipe_id
       AND pr.name = 'Burger Patty'
       AND pr.brand_id = v_brand_id
       AND pr.is_current = false;

    GET DIAGNOSTICS v_updated_count = ROW_COUNT;

    IF v_updated_count <> 4 THEN
      RAISE EXCEPTION
        'Spec 001: expected to update 4 rows, updated % — rolling back',
        v_updated_count;
    END IF;

    RAISE NOTICE 'Spec 001: repointed % recipe_prep_items rows to canonical %',
      v_updated_count, v_canonical_id;
  ELSE
    RAISE EXCEPTION
      'Spec 001: unexpected orphan count % (expected 0 or 4) — aborting',
      v_orphan_count;
  END IF;
END
$$;

COMMIT;
```

Notes on the sketch:
- The `BEGIN; ... COMMIT;` wrapping is explicit per acceptance criterion line 22 ("wrapped in an atomic transaction"). Supabase's `db push` already wraps each migration in a transaction, but the explicit pair is required by the spec and matches the precedent migration's intent.
- The `UPDATE` re-asserts the same `WHERE` clause used in the count, so any race between count and update (none expected — single-statement migration) cannot widen the blast radius.
- All `RAISE EXCEPTION` paths roll back the transaction automatically; no manual `ROLLBACK` needed.
- No `SET LOCAL role` or `SECURITY DEFINER` — runs as the migration role (postgres).

### 6. Realtime impact — fires on `brand-2a000000-...`, no publication change
- The `recipe_prep_items` `UPDATE` will trigger Realtime events **only if `recipe_prep_items` is in the `supabase_realtime` publication**. Per `src/hooks/useRealtimeSync.ts` lines 35–38, the `brand-{brandId}` channel subscribes to `recipes`, `prep_recipes`, `catalog_ingredients`, and `vendors` — **not `recipe_prep_items`**. So even if the row event is published, no admin client is currently listening for it. Connected clients will not auto-reload from this migration. This is fine: the bug being fixed is a stale-data issue visible to the customer PWA via `pwa-catalog`, which fetches fresh on each call and does not use Realtime.
- **No publication change required.** The migration does not `ALTER PUBLICATION supabase_realtime ADD TABLE ...`. The publication-membership gotcha (`docker restart supabase_realtime_imr-inventory` after `npm run dev:db` per the project memory note) **does not apply** to this migration. Flagged for the developer/auditor: do not add the table to the publication as part of this fix — that's an unrelated change.

### 7. Risks and tradeoffs
- **Apply-context fragility (highest risk).** The migration assumes superuser apply (RLS bypass). If ever applied through a non-superuser path (a hypothetical PostgREST RPC, a service-role client, etc.), the count step could under-report due to RLS visibility, and the `0` branch would silently mark a broken environment as "fixed". Mitigation: this is a `supabase/migrations/` file, applied only via `supabase db push` / `supabase db reset`. The "Project-specific notes" section (line 199) already pins this. Auditor should confirm no apply path other than superuser exists.
- **Concurrent writes during apply.** Standard migration risk. The `BEGIN/COMMIT` wrapper plus the implicit `UPDATE` row locks make the count-then-update pair safe against another writer racing in the same brand (the orphan rows would be locked when the `UPDATE` runs). Not a concern in practice — migrations apply during low-traffic windows and the affected rows aren't user-mutable from the Cmd UI.
- **Migration ordering.** Filename `20260505000000_*` sorts strictly after the 2026-05-04 Phase 5 migrations and before any future 2026-05-05 work. Safe.
- **Performance.** `recipe_prep_items` is small (low thousands of rows in the 286 KB seed dataset). Count + 4-row update is sub-millisecond. No index changes warranted.
- **No edge function cold-start risk.** This migration touches no edge functions.
- **Sibling-table contagion (out of scope, surfaced for awareness).** `prep_recipe_ingredients` has 399 analogous orphans. Spec 001 explicitly does not address them. The risk for Spec 001 is reputational only — a reviewer might ask "why didn't you fix the bigger one too?". The "Why proceeding with Spec 001 in isolation is safe" section in this spec answers that. No design accommodation needed.
- **`useRealtimeSync` not subscribed to `recipe_prep_items`.** Noted in section 6. If a future spec wants admin clients to auto-reload on `recipe_prep_items` changes, that's a separate hook change — out of scope here.

### 8. `src/lib/db.ts` surface, frontend store impact, edge function changes — none
- No new helpers in `src/lib/db.ts`. The fix is entirely server-side data repair.
- No `src/store/useStore.ts` slice changes. No optimistic-then-revert pattern applies (no client-initiated write).
- No edge function changes. `pwa-catalog` is used for verification only (acceptance criterion line 29) and its `verify_jwt = false` + service-token validation strategy is unchanged.
- No `src/screens/cmd/sections/` changes. No legacy `AdminScreens.tsx` changes.
