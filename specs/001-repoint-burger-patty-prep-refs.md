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
- [ ] After the migration is applied **via `supabase db push` against a populated environment** (remote prod or a local DB that already has `seed.sql` loaded), re-running the orphan-count probe SQL returns 0 rows.
- [ ] When applied via `supabase db reset --local` (which runs migrations against an EMPTY DB before loading `seed.sql`), the migration completes without error as a no-op. End-state orphans persisting after `seed.sql` loads is expected and is not a defect of this migration — see "Backend design" section 5b "Apply-path semantics and verification limits".
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

### 3. Migration filename — `supabase/migrations/20260504235959_repoint_burger_patty_orphans.sql`
- Convention: `YYYYMMDDHHMMSS_snake_case.sql` per `supabase/migrations/`.
- Timestamp: **`20260504235959`** — chosen to sort **immediately before** the unapplied dedup migration `20260505000000_dedupe_repointed_ingredient_lines.sql`. See "Ordering rationale" below; this filename is now a contract, not a guidance — changing it later breaks the apply-order safety analysis.
- Description: `repoint_burger_patty_orphans` — short, snake_case, names the action and the affected entity.

#### Ordering rationale (post-design probe finding, 2026-05-05)
A subsequent probe surfaced that `supabase/migrations/20260505000000_dedupe_repointed_ingredient_lines.sql` is on disk but unapplied to the local DB, and creates a new `recipe_prep_items_logical_unique` UNIQUE index on `(recipe_id, prep_recipe_id, unit) NULLS NOT DISTINCT`. If this Spec 001 migration ran **after** the dedup migration, the `UPDATE` would collapse all 4 cheeseburger orphans onto a single `(2AM Cheeseburger, 500ef28d-..., oz)` tuple and **violate the new unique index**, aborting the transaction. (No pre-existing canonical-pointing row exists for this recipe — confirmed by probe — so the collision count is 4 identical tuples post-update, not 5.)

By sorting **before** the dedup migration, the populated-DB apply path (`supabase db push` against prod or against a local DB with `seed.sql` already loaded — see section 5b) goes:
1. This migration runs first. The count branch evaluates to 4, the repair branch fires.
2. The 4 orphans are repointed to canonical, producing 4 byte-identical rows differing only by `id`. The unique index does not yet exist, so no violation.
3. The dedup migration then runs and collapses those 4 to 1 via its `ROW_NUMBER() OVER (PARTITION BY recipe_id, prep_recipe_id, unit) ... WHERE rn > 1` DELETE.
4. The unique index is created against a now-clean state and succeeds.

End state on the populated-DB path: exactly one `recipe_prep_items` row for `(2AM Cheeseburger, 500ef28d-..., oz, 6)`. The dedup migration is left unmodified — no coordination required between the two migrations beyond filename order.

The same filename ordering is also correct under `db reset --local`: both this migration and the dedup migration run as no-ops against the empty DB, the unique index is created against an empty `recipe_prep_items` (no rows to violate it), and `seed.sql` then loads. The seed's 4 orphan rows point at 4 *distinct* non-current `prep_recipe_id` UUIDs, so they form 4 distinct `(recipe_id, prep_recipe_id, unit)` tuples and do not violate the unique index — the seed loads cleanly even though the orphans persist. The "end state has 4 orphans" condition described in section 5b is unrelated to and not blocked by the unique index.

Developer must NOT bump the timestamp at apply time. The `20260504235959` slot is load-bearing for correctness.

### 4. RLS / `SECURITY DEFINER` considerations — decision: **no `SECURITY DEFINER`, no policy changes**
- This is a one-shot migration, not a callable function. `SECURITY DEFINER` only applies to functions; the `DO` block runs as the migration role. No semantics to add.
- Migrations are applied by the `postgres` superuser via `supabase db push` / local `supabase db reset`, which bypasses RLS. The acceptance criteria (count assertions, exact-4 update count) therefore see the full table, not an RLS-filtered view. This is the only safe apply context — flagged in the existing "Project-specific notes" section (line 199, "superuser apply context") and re-flagged in section 7 below.
- **Policies the security-auditor must review against** (all defined in `supabase/migrations/20260504173035_per_store_rls_hardening.sql` and the brand-catalog Phase 5 file). For `recipe_prep_items` specifically, the auditor must check the `UPDATE` policy chain currently in force. The hardening migration above does **not** touch `recipe_prep_items` directly (it covers `inventory_items`, `eod_*`, `waste_log`, `audit_log`, `purchase_orders`, `po_items`, `pos_imports`, `pos_import_items`). `recipe_prep_items` policies live in earlier migrations — auditor must:
  1. Enumerate current `recipe_prep_items` policies (`SELECT polname FROM pg_policy WHERE polrelid = 'public.recipe_prep_items'::regclass`).
  2. Confirm none of them would reject this `UPDATE` when run as `postgres` (they won't — `postgres` bypasses RLS — but document the assumption).
  3. Confirm the post-update row state does not violate any `WITH CHECK` clause. Since we are only changing `prep_recipe_id` (not `recipe_id` or any store/brand-scoped column), and the new value is itself a valid `prep_recipes` row in the same brand, no policy invariant changes.
- No new policies are introduced. No helper-function changes (`auth_can_see_store()` / `auth_is_admin()` untouched).

### 5. Concrete migration sketch (developer refines, this is the contract)

**Control flow (Option B — count-first, canonical lookup gated behind the repair branch):**

The control flow was reordered after a `db reset --local` verification run surfaced that performing the canonical-row lookup *before* the orphan count caused the migration to abort with `expected exactly 1 current "Burger Patty" prep in brand ..., found 0` when run against an empty DB (migrations apply before `seed.sql` loads under `db reset`). See section 5b for the apply-path semantics that make Option B necessary.

The contract:
1. **Apply-context sanity check (FIRST).** If `prep_recipes` has any visible rows, assert the canonical Burger Patty UUID is visible. Closes the silent-no-op-under-RLS hole the count-first design otherwise opens. If `prep_recipes` is empty (the `db reset --local` pre-seed case), skip the check and proceed — there's no canonical to assert against yet, by design.
2. **Count orphans**, before any canonical *currency* lookup. The JOIN naturally returns 0 against an empty DB — no exception.
3. **If count = 0:** `RAISE NOTICE` no-op and exit success. Do **not** perform the canonical *currency* lookup or drift check in this branch — there's nothing to repair, and the visibility check from step 1 has already validated we can see the canonical UUID (when applicable).
4. **If count = 4:** look up the canonical CURRENT "Burger Patty" UUID, assert exactly one row, drift-check against `500ef28d-...`, perform the `UPDATE`, then `GET DIAGNOSTICS` assert exactly 4 rows changed.
5. **If count is anything else (1, 2, 3, 5+):** `RAISE EXCEPTION` and roll back. No partial repair.

Note on the separation: step 1 checks **visibility** of the canonical UUID (catches RLS / wrong-context apply); step 4 checks **currency** of the canonical row (catches `is_current = false` drift). The two are different failure modes and are checked in different branches.

```sql
-- supabase/migrations/20260504235959_repoint_burger_patty_orphans.sql
--
-- Spec 001: repoint 4 orphaned recipe_prep_items.prep_recipe_id values
-- (in brand 2a000000-...) from non-current "Burger Patty" prep_recipes
-- to the single canonical current one. See specs/001-repoint-burger-patty-prep-refs.md.
--
-- Control flow: count orphans first; only look up canonical when count = 4.
-- This avoids spurious failures during `db reset --local` (migrations run
-- against empty DB before seed loads). See spec section 5b.
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

  -- 3. Branch on count. Canonical CURRENCY lookup and drift check live ONLY in
  --    the count = 4 branch; running them against an empty DB would fail
  --    spuriously. (Visibility was already validated in step 1.)
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

    -- 4c. Repoint the 4 orphans to the canonical UUID. Re-assert the same
    --     WHERE clause used in the count so a race (none expected) cannot
    --     widen the blast radius.
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
- Step 1 performs a **visibility** sanity check on the canonical UUID (skipped when `prep_recipes` is empty). The canonical **currency** lookup, drift check, `UPDATE`, and `GET DIAGNOSTICS` assertion all live inside the `count = 4` branch. Against an empty DB, step 1 is skipped, the `count = 0` branch fires, and the migration exits cleanly — this is the fix for the `db reset --local` failure mode. Against a populated DB with hidden canonical (RLS misuse), step 1 fails loudly.
- All `RAISE EXCEPTION` paths roll back the transaction automatically; no manual `ROLLBACK` needed.
- No `SET LOCAL role` or `SECURITY DEFINER` — runs as the migration role (postgres).

### 5b. Apply-path semantics and verification limits

This migration is a one-shot repair of existing prod data. The apply path determines what state the DB is in when the migration runs, which in turn determines whether the repair branch fires. The two paths in active use behave differently and the difference is structural, not a defect of this migration:

- **`supabase db push` against a populated environment** (remote prod, or a local DB whose `seed.sql` has already been loaded). The 4 orphan rows exist when the migration runs. The count branch evaluates to 4, the repair branch fires, the `UPDATE` repoints all 4 rows to the canonical UUID, and the post-update assertion confirms exactly 4 rows changed. **End state: 0 orphans. The fix is verifiable on this path.**

- **`supabase db reset --local`**. Supabase resets the local DB to empty, then runs every migration in `supabase/migrations/` in timestamp order against the empty DB, then loads `supabase/seed.sql`. Because the seed pulled from prod on 2026-05-02 contains the 4 orphan `recipe_prep_items` rows AND the canonical "Burger Patty" `prep_recipes` row, the orphans are re-inserted *after* this migration has already executed as a no-op. The sibling dedup migration `20260505000000_dedupe_repointed_ingredient_lines.sql` likewise ran against empty tables and cannot help. **End state: 4 orphans persist in the local DB and there is no migration left to fix them.** This is a structural limitation of Postgres migrations + Supabase seed ordering — the migration cannot fix data that does not exist when it runs. Verification of the *fix's effect* is therefore only possible via `db push` to a populated environment.

For local development convenience: after `db reset --local` completes, a developer can manually re-execute the body of this migration via `psql` against the now-seeded local DB to demonstrate the fix locally — for example, `docker exec -i supabase_db_imr-inventory psql -U postgres -d postgres < supabase/migrations/20260504235959_repoint_burger_patty_orphans.sql`. This is a sanity check, not a formal verification path. The acceptance-criteria contract is satisfied by `db push` against a populated environment (see acceptance-criteria split above).

### 6. Realtime impact — fires on `brand-2a000000-...`, no publication change
- The `recipe_prep_items` `UPDATE` will trigger Realtime events **only if `recipe_prep_items` is in the `supabase_realtime` publication**. Per `src/hooks/useRealtimeSync.ts` lines 35–38, the `brand-{brandId}` channel subscribes to `recipes`, `prep_recipes`, `catalog_ingredients`, and `vendors` — **not `recipe_prep_items`**. So even if the row event is published, no admin client is currently listening for it. Connected clients will not auto-reload from this migration. This is fine: the bug being fixed is a stale-data issue visible to the customer PWA via `pwa-catalog`, which fetches fresh on each call and does not use Realtime.
- **No publication change required.** The migration does not `ALTER PUBLICATION supabase_realtime ADD TABLE ...`. The publication-membership gotcha (`docker restart supabase_realtime_imr-inventory` after `npm run dev:db` per the project memory note) **does not apply** to this migration. Flagged for the developer/auditor: do not add the table to the publication as part of this fix — that's an unrelated change.

### 7. Risks and tradeoffs
- **Apply-context fragility under Option B (residual after the visibility sanity check).** The migration assumes superuser apply (RLS bypass). Under the count-first Option B control flow, the `count = 0` no-op branch is wider than just "already repaired" — it also covers "pre-seed apply against an empty DB" (legitimate `db reset --local`). To prevent the obvious misuse path (RLS hides the orphans → `count = 0` → silent no-op of a broken environment), step 1 of the sketch performs a visibility sanity check: if `prep_recipes` has any visible rows but the canonical UUID is not visible, the migration aborts loudly. This catches partial-RLS-hiding (the realistic restricted-context scenario) and the "canonical was deleted in prod" failure mode. **Residual hole:** total RLS hiding (where the caller can see *no* `prep_recipes` rows at all) bypasses the visibility check because it triggers the same "looks like an empty DB" branch as `db reset --local`, and would silently no-op a broken environment. A second residual hole — an RLS policy filtering only on `is_current` would pass the canonical row through the visibility check while still hiding the non-current orphans from the count, producing the same silent-no-op outcome. Both are unreachable from any apply path actually in use (`supabase db push` / `db reset` / migrations role all run as superuser and bypass RLS), but the safety margin against future misuse is narrower than the original strict-canonical-first design — that one failed loudly on canonical assertion regardless of RLS state. Mitigation unchanged: only superuser apply is supported (per "Project-specific notes" section, line 199). Auditor must confirm no non-superuser apply path exists, both today and as a forward-looking constraint.
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
