# Spec 001: Repoint orphaned "Burger Patty" prep references

Status: DONE

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
- [x] A new timestamped migration is added under `supabase/migrations/` following the established `YYYYMMDDHHMMSS_description.sql` naming convention.
- [x] The migration is wrapped in an atomic transaction (`BEGIN` / `COMMIT`).
- [x] The migration asserts that the canonical UUID `500ef28d-3288-4fb8-accb-c3708d1491f9` exists in `prep_recipes` AND has `is_current = true`. If not, `RAISE EXCEPTION` and abort.
- [x] The migration counts the orphan `recipe_prep_items` rows in scope (rows in brand `2a000000-...` whose `prep_recipe_id` resolves to a "Burger Patty" prep with `is_current = false`) before mutating anything.
  - If the orphan count is exactly **0**, exit successfully as a no-op (idempotent re-run path).
  - If the orphan count is exactly **4**, repoint those 4 rows to the canonical UUID, then verify exactly 4 rows were updated. If the affected row count differs from 4, `RAISE EXCEPTION` and roll back.
  - If the orphan count is anything other than 0 or 4 (e.g., 1, 2, 3, 5+), `RAISE EXCEPTION` and roll back. Do not partially repair an unexpected state.
- [x] After the migration is applied **via `supabase db push` against a populated environment** (remote prod or a local DB that already has `seed.sql` loaded), re-running the orphan-count probe SQL returns 0 rows. This must hold under all three populated apply-path branches (Path A: remote, dedup applied, external canonical row exists → all 4 orphans deleted; Path B-original: populated without dedup applied, no external canonical row, no live unique index → 4 byte-identical UPDATEs collapsed by dedup later; Path B-revised: clean `db reset --local` re-execution, dedup index already live, no external canonical row → 3 sibling orphans deleted, 1 survivor updated to canonical). See "Backend design" section 5b for the apply-path matrix. **Post-merge note (2026-05-06):** Path A was never actually exercised — both local and remote produced Path B-revised `(3, 1)`. See "Post-merge review" at the end of this spec.
- [x] When applied via `supabase db reset --local` (which runs migrations against an EMPTY DB before loading `seed.sql`), the migration completes without error as a no-op. End-state orphans persisting after `seed.sql` loads is expected and is not a defect of this migration — see "Backend design" section 5b "Apply-path semantics and verification limits". Verified 2026-05-06: NOTICE output `"Spec 001: no-op (no orphans found — pre-seed apply OR already repaired)"` fired during fresh `db reset --local`; post-seed orphan probe returned 4 (expected).
- [x] **(AC7a — data invariant via SQL substitute)** After the migration is applied, every `prep_recipe_id` referenced by 2AM Cheeseburger's `recipe_prep_items` rows resolves to a `prep_recipes` row with `is_current = true`. Verified on local + remote via SQL probe (`docker exec ... psql` locally, `supabase db query --linked` remotely).
- [ ] **(AC7b — HTTP path through `pwa-catalog`) DEFERRED.** The HTTP path through the `pwa-catalog` edge function returning a self-consistent payload is currently blocked on a pre-existing infrastructure issue: `supabase_edge_runtime_imr-inventory` is bind-mounted to a stale `.claude/worktrees/pensive-raman-4d93c5/supabase/functions/` path, so the local edge runtime returns `503 BOOT_ERROR`. Filed as a separate task (edge runtime worktree-bind-mount fix). Not blocking Spec 001 closeout — AC7a's SQL-equivalent subset check verifies the same data invariant.
- [x] The migration has been reviewed by the security-auditor for RLS implications (writes touching `recipe_prep_items` under per-store RLS hardening — see `supabase/migrations/20260504173035_per_store_rls_hardening.sql`). Result 2026-05-06: clean — no critical/high/medium findings. See "Post-merge review".
- [x] The migration has been reviewed by the backend-architect for migration convention adherence (filename format, helper function usage such as `auth_can_see_store()` / `auth_is_admin()` if relevant, `SECURITY DEFINER` semantics if used, transaction style, comment style). Architect designed and revised the migration three times during this spec's lifecycle; the final design is the contract.

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

#### Ordering rationale (revised 2026-05-06 after Path B-revised failure on local clean reset)
The filename `20260504235959_*` is still load-bearing — it must sort before `supabase/migrations/20260505000000_dedupe_repointed_ingredient_lines.sql` so that on apply paths where neither has been applied yet, this repoint runs first and the dedup follows. **The previous "delete-or-repoint" revision (2026-05-06 morning) handled remote correctly but a second verification run surfaced a third populated-environment apply path the design didn't cover — Path B-revised below.** The full apply-path matrix the migration must handle:

| Path | Starting state | Required end state |
|---|---|---|
| **A) `db push` to remote (the original failing case)** | 4 orphan rows + 1 pre-existing canonical-pointing row `(330d2882-..., 500ef28d-..., oz, 6)`. Dedup migration already applied → `recipe_prep_items_logical_unique` index already live. | 0 orphans, 1 canonical-pointing row preserved. |
| **B-original) `db push` to a populated environment without dedup applied** | 4 orphans, no external canonical-pointing row, no unique index. | 4 byte-identical canonical-pointing rows; the dedup migration (running later on the same push) collapses them to 1. |
| **B-revised) Manual re-execute after `db reset --local` (the second failing case)** | 4 orphans (all share `(330d2882-..., oz)`, differ by `prep_recipe_id`), no external canonical-pointing row, **dedup index already live** (the dedup migration ran against an empty DB during reset, then `seed.sql` re-introduced the 4 orphans which fit because they form 4 distinct `(recipe_id, prep_recipe_id, unit)` tuples). | 0 orphans, 1 canonical-pointing row (the survivor orphan repointed). |
| **C) `db reset --local`** | Empty DB at migration time. Migration runs as no-op. `seed.sql` (pulled 2026-05-02) then loads 4 orphans against the now-existing unique index — cleanly, because the 4 orphans point at 4 distinct non-current UUIDs. | 4 orphans persist post-seed (acknowledged limitation per 5b). |
| **D) Re-run after success** | 0 orphans. | No-op. |

The first revision's design (4c = "DELETE if external canonical exists" + 4d = "UPDATE all remaining orphans") handles **A**, **B-original**, **C**, **D** correctly but **fails on B-revised**: 4c finds 0 external collisions (no external canonical-pointing row exists), so all 4 orphans fall through to 4d. 4d's bare UPDATE then tries to collapse 4 orphans onto the same `(330d2882-..., 500ef28d-..., oz)` tuple, which violates the live unique index intra-update on the second row, aborting with `duplicate key value violates unique constraint "recipe_prep_items_logical_unique"`.

The revised section 5 design ("ROW_NUMBER survivor + branch on external canonical") handles all five paths uniformly by partitioning per `(recipe_id, unit)` and reasoning at the GROUP level rather than the per-row level:
- **A:** for each `(recipe_id, unit)` group of orphans, an external canonical row exists → survivor is DELETED (along with siblings) → all 4 orphans deleted, the pre-existing canonical row preserved.
- **B-original:** no external canonical row, no unique index → survivor + siblings all UPDATEd to canonical → 4 byte-identical rows, dedup later collapses.
- **B-revised:** no external canonical row, unique index live → siblings DELETEd, survivor UPDATEd → 1 canonical-pointing row.
- **C:** count = 0 branch fires → no-op.
- **D:** count = 0 branch fires → no-op.

Filename note: the timestamp stays `20260504235959`. Still required to sort before `20260505000000_dedupe_repointed_ingredient_lines.sql` for Path B-original (the only apply path where the relative order between this migration and dedup matters at apply time). Developer must NOT bump the timestamp at apply time. The `20260504235959` slot is load-bearing for correctness.

### 4. RLS / `SECURITY DEFINER` considerations — decision: **no `SECURITY DEFINER`, no policy changes**
- This is a one-shot migration, not a callable function. `SECURITY DEFINER` only applies to functions; the `DO` block runs as the migration role. No semantics to add.
- Migrations are applied by the `postgres` superuser via `supabase db push` / local `supabase db reset`, which bypasses RLS. The acceptance criteria (count assertions, exact-4 update count) therefore see the full table, not an RLS-filtered view. This is the only safe apply context — flagged in the existing "Project-specific notes" section (line 199, "superuser apply context") and re-flagged in section 7 below.
- **Policies the security-auditor must review against** (all defined in `supabase/migrations/20260504173035_per_store_rls_hardening.sql` and the brand-catalog Phase 5 file). For `recipe_prep_items` specifically, the auditor must check **both** the `UPDATE` and the `DELETE` policy chains currently in force — the revised section 5 design issues a DELETE in step 4c (collision elision) and an UPDATE in step 4d. The hardening migration above does **not** touch `recipe_prep_items` directly (it covers `inventory_items`, `eod_*`, `waste_log`, `audit_log`, `purchase_orders`, `po_items`, `pos_imports`, `pos_import_items`). `recipe_prep_items` policies live in earlier migrations — auditor must:
  1. Enumerate current `recipe_prep_items` policies (`SELECT polname FROM pg_policy WHERE polrelid = 'public.recipe_prep_items'::regclass`).
  2. Confirm none of them would reject this `DELETE` or `UPDATE` when run as `postgres` (they won't — `postgres` bypasses RLS — but document the assumption).
  3. Confirm the post-update row state does not violate any `WITH CHECK` clause. Since we are only changing `prep_recipe_id` (not `recipe_id` or any store/brand-scoped column), and the new value is itself a valid `prep_recipes` row in the same brand, no policy invariant changes. The DELETE removes orphan rows entirely; no `WITH CHECK` applies to deletes.
- No new policies are introduced. No helper-function changes (`auth_can_see_store()` / `auth_is_admin()` untouched).

### 5. Concrete migration sketch (developer refines, this is the contract)

**Control flow (revised 2026-05-06 evening — count-first, canonical lookup gated, repair partitioned by `(recipe_id, unit)` group with ROW_NUMBER survivor selection):**

The control flow was first reordered (count-first) after `db reset --local` surfaced that canonical lookup *before* orphan count failed against an empty DB. It was then revised again to split the repair into "DELETE colliding orphans + UPDATE the rest" after `db push` to remote failed on the live unique index when an external canonical row pre-existed. **It is now revised a third time** after Path B-revised (clean local reset → `seed.sql` re-introduces the 4 orphans → manual re-execute against the now-seeded local DB) revealed a fourth failure mode the morning revision didn't cover: **orphan-to-orphan intra-UPDATE collision**. All 4 local orphans share `(recipe_id = 330d2882-..., unit = oz)` and differ only by `prep_recipe_id`. They form 4 distinct tuples on the live unique index (each pointing at a distinct non-current UUID), so the seed loads them cleanly, but a bulk UPDATE that repoints all 4 onto the same canonical UUID would collapse them to a single tuple — only the first UPDATE succeeds, the second collides on the now-occupied tuple, the rest never run, transaction aborts.

The previous revision's 4c (`DELETE WHERE EXISTS … existing.id <> rpi.id`) doesn't catch this case because each orphan is the only row at its own pre-update tuple — they don't collide with each other *until repointed*. The fix is to think at the **`(recipe_id, unit)` group level** rather than the per-row level: per group, exactly one row should survive (either as a fresh canonical UPDATE, or zero rows if an external canonical already serves the group), and any siblings within the group are pure redundancy.

The revised contract:
1. **Apply-context sanity check (FIRST).** Unchanged. If `prep_recipes` has any visible rows, assert the canonical Burger Patty UUID is visible. Skip if `prep_recipes` is empty (`db reset --local` pre-seed case).
2. **Count orphans**, before any canonical *currency* lookup. The JOIN returns 0 against an empty DB.
3. **If count = 0:** `RAISE NOTICE` no-op and exit success.
4. **If count = 4:** look up canonical CURRENT "Burger Patty" UUID (4a), assert exactly one row, drift-check against `500ef28d-...` (4b), then partition the orphans by `(recipe_id, unit)` and apply group-level repair (4c–4e):
   - **4c. Compute per-orphan decisions in a single CTE.** For each orphan, derive (i) its rank within its `(recipe_id, unit)` group via `ROW_NUMBER() OVER (PARTITION BY recipe_id, unit ORDER BY id)` — rank = 1 is the "survivor"; rank > 1 are "siblings"; (ii) whether an **external** canonical-pointing row exists in the group (a `recipe_prep_items` row with the same `(recipe_id, unit)`, `prep_recipe_id = canonical_id`, that is itself NOT one of the orphans). Each orphan then has one of three actions:
     - `delete-as-sibling` (rank > 1) — pure intra-group redundancy, will collapse onto the survivor under any UPDATE.
     - `delete-as-redundant` (rank = 1, external canonical exists in group) — the external row already serves the group, the survivor is unnecessary.
     - `update-as-survivor` (rank = 1, no external canonical in group) — repoint to canonical.
   - **4d. DELETE all `delete-*` orphans, UPDATE all `update-as-survivor` orphans.** Two statements driven by the CTE result. Each orphan is touched by exactly one statement.
   - **4e. Strictness assertion.** `GET DIAGNOSTICS` after each. Require `v_deleted_count + v_updated_count = 4`. If not, `RAISE EXCEPTION` and roll back.
5. **If count is anything else (1, 2, 3, 5+):** `RAISE EXCEPTION` and roll back. No partial repair.

Notes on the partition logic:
- `ROW_NUMBER() OVER (PARTITION BY recipe_id, unit ORDER BY id)` mirrors the survivor-selection strategy used by the dedup migration `20260505000000_dedupe_repointed_ingredient_lines.sql` itself — same shape, same `id`-ordered tiebreaker, deterministic.
- "External canonical exists in group" means: a `recipe_prep_items` row with `(recipe_id = group.recipe_id, unit IS NOT DISTINCT FROM group.unit, prep_recipe_id = canonical_id)` whose `id` is NOT one of the in-scope orphan ids. This is the semantically correct version of the previous revision's `existing.id <> rpi.id` check — now scoped to "not any orphan" rather than "not myself", which is what catches Path A correctly.
- `unit` is compared with `IS NOT DISTINCT FROM` to mirror the `NULLS NOT DISTINCT` semantics of `recipe_prep_items_logical_unique`.
- The CTE runs once and feeds both the DELETE and the UPDATE — there is no race between them within the transaction. PostgreSQL evaluates each statement against the same MVCC snapshot taken at statement start; the DELETE removing siblings does not change the survivor's row identity by the time the UPDATE runs against the original orphan ids.

Apply-path verification table (for the section 5b path matrix below):

| Path | Survivors per group | External canonical? | (deleted, updated) | End state |
|---|---|---|---|---|
| **A** (remote) | 1 group, 4 orphans → 1 survivor + 3 siblings | yes | (4, 0) — 3 siblings + 1 redundant survivor | 1 row (the pre-existing external canonical) |
| **B-original** (populated, no dedup) | 1 group, 4 orphans → 1 survivor + 3 siblings | no | (3, 1) — 3 siblings deleted, 1 survivor updated | 1 canonical row |
| **B-revised** (clean reset, dedup live, no external canonical) | 1 group, 4 orphans → 1 survivor + 3 siblings | no | (3, 1) | 1 canonical row |
| **C** (db reset --local, pre-seed) | n/a (count = 0) | n/a | (0, 0) — branch skipped | unchanged (empty) |
| **D** (re-run) | n/a (count = 0) | n/a | (0, 0) — branch skipped | unchanged |

Note the unification: B-original and B-revised collapse to the same `(3, 1)` outcome under the new design. The morning revision's `(0, 4)` outcome for B-original is replaced — the new design always yields a single canonical-pointing row directly, without relying on the dedup migration to collapse byte-identical duplicates afterward. This is strictly better: it removes the cross-migration coupling that made B-original's correctness contingent on dedup running later in the same `db push`.

```sql
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
  -- 1. Apply-context sanity check. Unchanged from previous revision.
  IF (SELECT COUNT(*) FROM public.prep_recipes) > 0 THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.prep_recipes WHERE id = v_expected_canon
    ) THEN
      RAISE EXCEPTION
        'Spec 001: canonical Burger Patty (%) not visible despite populated prep_recipes — restricted apply context?',
        v_expected_canon;
    END IF;
  END IF;

  -- 2. Count orphans (in-scope = recipe_prep_items rows resolving to a
  --    Burger Patty prep in brand 2a000000-... with is_current = false).
  SELECT COUNT(*) INTO v_orphan_count
    FROM public.recipe_prep_items rpi
    JOIN public.prep_recipes pr ON pr.id = rpi.prep_recipe_id
   WHERE pr.name = 'Burger Patty'
     AND pr.brand_id = v_brand_id
     AND pr.is_current = false;

  -- 3. Branch on count.
  IF v_orphan_count = 0 THEN
    RAISE NOTICE 'Spec 001: no-op (no orphans found — pre-seed apply OR already repaired)';

  ELSIF v_orphan_count = 4 THEN
    -- 4a. Canonical CURRENT lookup.
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

    -- 4b. Drift check against the spec's recorded canonical UUID.
    IF v_canonical_id <> v_expected_canon THEN
      RAISE EXCEPTION
        'Spec 001: canonical "Burger Patty" UUID drift — expected %, got %',
        v_expected_canon, v_canonical_id;
    END IF;

    -- 4c. Compute per-orphan decisions in a single CTE chain, materialized
    --     into a TEMP TABLE so both the DELETE and the UPDATE see the same
    --     decision set without re-evaluating ROW_NUMBER (which would race
    --     against the DELETE's effects on the source rows). The temp table
    --     is auto-dropped at COMMIT (default ON COMMIT DROP behavior is
    --     "PRESERVE ROWS", so we explicitly use ON COMMIT DROP).
    --
    --     Decisions per orphan:
    --       'delete' -> rank > 1 in (recipe_id, unit) group, OR
    --                   rank = 1 AND an external canonical row serves the group
    --       'update' -> rank = 1 AND no external canonical in the group
    --
    --     "External canonical" = a recipe_prep_items row at
    --     (recipe_id, prep_recipe_id = canonical_id, unit IS NOT DISTINCT FROM)
    --     whose id is NOT one of the in-scope orphan ids.
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
    --   Path A:         (4, 0) — 3 siblings + 1 redundant survivor.
    --   Path B-original: (3, 1) — 3 siblings deleted.
    --   Path B-revised:  (3, 1) — 3 siblings deleted.
    DELETE FROM public.recipe_prep_items
     WHERE id IN (
       SELECT id FROM _spec001_orphan_decisions WHERE action = 'delete'
     );

    GET DIAGNOSTICS v_deleted_count = ROW_COUNT;

    -- 4d-UPDATE. Repoint surviving orphans (rank = 1, no external canonical).
    --   Path A:         0 updates.
    --   Path B-original: 1 update.
    --   Path B-revised:  1 update.
    UPDATE public.recipe_prep_items
       SET prep_recipe_id = v_canonical_id
     WHERE id IN (
       SELECT id FROM _spec001_orphan_decisions WHERE action = 'update'
     );

    GET DIAGNOSTICS v_updated_count = ROW_COUNT;

    -- 4e. Strictness: total rows affected MUST equal 4.
    IF v_deleted_count + v_updated_count <> 4 THEN
      RAISE EXCEPTION
        'Spec 001: expected total 4 rows affected (deleted + updated), got % deleted + % updated = % — rolling back',
        v_deleted_count, v_updated_count, v_deleted_count + v_updated_count;
    END IF;

    RAISE NOTICE 'Spec 001: cleared 4 Burger Patty orphans (% deleted, % repointed to canonical %)',
      v_deleted_count, v_updated_count, v_canonical_id;

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
- The `BEGIN; ... COMMIT;` wrapping is explicit per acceptance criterion line 22.
- Step 1 (visibility sanity check) is unchanged from the previous revision. Against an empty DB, step 1 is skipped, the `count = 0` branch fires, migration exits cleanly — preserves the `db reset --local` no-op.
- Step 4c materializes per-orphan decisions into a temp table `_spec001_orphan_decisions` with `ON COMMIT DROP`. Materialization (rather than two CTEs running independently in the DELETE and UPDATE) ensures both statements act on the **same** decision set; without materialization, the second statement's CTE would re-run `ROW_NUMBER` over a smaller `orphans` set after the first DELETE, and a row originally ranked sibling could be re-ranked survivor — the design fails. Temp table dropped automatically on COMMIT.
- The `ROW_NUMBER() OVER (PARTITION BY recipe_id, unit ORDER BY id)` survivor-selection mirrors the dedup migration `20260505000000_dedupe_repointed_ingredient_lines.sql`'s shape exactly. Same partition keys, same `ORDER BY id` tiebreaker, deterministic.
- The `has_external_canonical` EXISTS check uses `ext.id NOT IN (SELECT id FROM orphans)` rather than the previous revision's `ext.id <> rpi.id`. Critical: this excludes ALL in-scope orphans from being "external", not just the row we're testing. Otherwise Path A would incorrectly classify orphan-A as a "collision target" for orphan-B and the strictness assertion would still pass but for the wrong reason.
- `unit` comparison uses `IS NOT DISTINCT FROM` to mirror the `NULLS NOT DISTINCT` semantics of `recipe_prep_items_logical_unique`.
- Step 4e's strictness assertion (`deleted + updated = 4`) preserves the original 0/4/else contract at the total-rows-affected level. Per-statement splits the design admits: Path A `(4, 0)`, Path B-original / B-revised `(3, 1)`, and any future split (e.g., 2 groups of 2 → `(2, 2)`) all sum to 4.
- The DELETE then UPDATE order matters only for clarity — both statements key off the materialized temp table by id and target disjoint id sets, so swapping them would not affect correctness. Documented order is DELETE-first to match the "siblings + redundancy first, survivors next" mental model.
- All `RAISE EXCEPTION` paths roll back the transaction automatically; no manual `ROLLBACK` needed. The temp table is rolled back along with everything else.
- No `SET LOCAL role` or `SECURITY DEFINER` — runs as the migration role (postgres).

### 5b. Apply-path semantics and verification limits

This migration is a one-shot repair of existing prod data. The apply path determines what state the DB is in when the migration runs, which in turn determines how the count = 4 branch's DELETE / UPDATE counts split. Five apply paths exist; the design must handle all five:

- **Path A — `supabase db push` against remote (the original failing case from the 2026-05-05 verification run).** Remote already has the dedup migration `20260505000000_dedupe_repointed_ingredient_lines.sql` applied, so the `recipe_prep_items_logical_unique` UNIQUE index on `(recipe_id, prep_recipe_id, unit) NULLS NOT DISTINCT` is live. The remote `recipe_prep_items` table has **5 rows** for the 2AM Cheeseburger Burger Patty relationship: 4 orphans pointing at non-current UUIDs (`cee2cc2a`, `34c637a8`, `156565d4`, `a3d56b0a`) and 1 pre-existing **external** canonical-pointing row at `(330d2882-..., 500ef28d-..., oz, 6)`. All 4 orphans share the same `(recipe_id, unit) = (330d2882-..., oz)` group → ROW_NUMBER produces 1 survivor + 3 siblings. The survivor's group has an external canonical → survivor classified as `delete`. Siblings always classified as `delete`. **`v_deleted_count = 4`, `v_updated_count = 0`. End state: 0 orphans, the pre-existing external canonical row preserved.**

- **Path B-original — `supabase db push` against a populated environment without the dedup migration applied** (e.g., a populated environment whose `seed.sql` was loaded but where neither this migration nor the dedup migration has yet run). The 4 orphan rows exist; no external canonical-pointing row exists; the unique index does not yet exist. Survivor selection produces 1 survivor + 3 siblings. Survivor's group has no external canonical → survivor classified as `update`. Siblings classified as `delete`. **`v_deleted_count = 3`, `v_updated_count = 1`. End state: 0 orphans, 1 canonical-pointing row.** Note: this differs from the morning revision's `(0, 4) → dedup-collapses-later` behavior. The new design no longer relies on the dedup migration to collapse byte-identical duplicates afterward — it produces the single canonical row directly.

- **Path B-revised — manual re-execute after `db reset --local` (the new failing case from the 2026-05-05 evening verification run).** `db reset --local` runs every migration against an empty DB (this migration and dedup both exit as no-ops), then loads `seed.sql`. The seed re-introduces the 4 orphan `recipe_prep_items` rows; they fit on the live unique index because they form 4 distinct `(recipe_id, prep_recipe_id, unit)` tuples (each pointing at a distinct non-current UUID). No external canonical-pointing row exists in the seed. When the developer manually re-executes the migration body post-seed via psql, the count-first branch finds 4 orphans, all share `(330d2882-..., oz)`, ROW_NUMBER produces 1 survivor + 3 siblings, no external canonical → survivor classified as `update`, siblings `delete`. **`v_deleted_count = 3`, `v_updated_count = 1`. End state: 0 orphans, 1 canonical-pointing row.** The morning revision's design failed here because it deferred all collision detection to "external row exists" — with no external row, all 4 orphans fell through to the UPDATE, which then collided intra-update on the live unique index. The new design's per-group survivor selection prevents this: only the survivor (1 row) is ever updated; the other 3 are deleted before any UPDATE runs.

- **Path C — `supabase db reset --local` (no manual re-execute).** Supabase resets to empty, runs migrations in order against empty DB (no-op for this one), then loads `seed.sql`. The seed contains the 4 orphans and the canonical `prep_recipes` row but no external canonical `recipe_prep_items` row. **End state: 4 orphans persist in the local DB and there is no migration left to fix them.** Structural limitation of Postgres migrations + Supabase seed ordering — unchanged from the previous revision. Path B-revised is the manual remediation path for local development.

- **Path D — re-run after success.** 0 orphans visible. Step 2 returns 0, count = 0 branch fires, no-op. Idempotent.

For local development convenience: after `db reset --local` (Path C) completes, a developer can manually re-execute the migration body via `psql` against the now-seeded local DB — `docker exec -i supabase_db_imr-inventory psql -U postgres -d postgres < supabase/migrations/20260504235959_repoint_burger_patty_orphans.sql`. With the current local seed (no external canonical row), this exercises Path B-revised (3 deletes, 1 update). To exercise Path A locally, a developer would need to insert a synthetic external canonical-pointing row before re-executing — outside the scope of this spec. The acceptance-criteria contract is satisfied by `db push` against a populated environment (Path A on remote, Path B-original on a freshly-seeded environment without dedup applied) and by Path B-revised manual re-execute on local.

### 6. Realtime impact — fires on `brand-2a000000-...`, no publication change
- The `recipe_prep_items` `UPDATE` will trigger Realtime events **only if `recipe_prep_items` is in the `supabase_realtime` publication**. Per `src/hooks/useRealtimeSync.ts` lines 35–38, the `brand-{brandId}` channel subscribes to `recipes`, `prep_recipes`, `catalog_ingredients`, and `vendors` — **not `recipe_prep_items`**. So even if the row event is published, no admin client is currently listening for it. Connected clients will not auto-reload from this migration. This is fine: the bug being fixed is a stale-data issue visible to the customer PWA via `pwa-catalog`, which fetches fresh on each call and does not use Realtime.
- **No publication change required.** The migration does not `ALTER PUBLICATION supabase_realtime ADD TABLE ...`. The publication-membership gotcha (`docker restart supabase_realtime_imr-inventory` after `npm run dev:db` per the project memory note) **does not apply** to this migration. Flagged for the developer/auditor: do not add the table to the publication as part of this fix — that's an unrelated change.

### 7. Risks and tradeoffs
- **Apply-context fragility under Option B (residual after the visibility sanity check).** The migration assumes superuser apply (RLS bypass). Under the count-first Option B control flow, the `count = 0` no-op branch is wider than just "already repaired" — it also covers "pre-seed apply against an empty DB" (legitimate `db reset --local`). To prevent the obvious misuse path (RLS hides the orphans → `count = 0` → silent no-op of a broken environment), step 1 of the sketch performs a visibility sanity check: if `prep_recipes` has any visible rows but the canonical UUID is not visible, the migration aborts loudly. This catches partial-RLS-hiding (the realistic restricted-context scenario) and the "canonical was deleted in prod" failure mode. **Residual hole:** total RLS hiding (where the caller can see *no* `prep_recipes` rows at all) bypasses the visibility check because it triggers the same "looks like an empty DB" branch as `db reset --local`, and would silently no-op a broken environment. A second residual hole — an RLS policy filtering only on `is_current` would pass the canonical row through the visibility check while still hiding the non-current orphans from the count, producing the same silent-no-op outcome. Both are unreachable from any apply path actually in use (`supabase db push` / `db reset` / migrations role all run as superuser and bypass RLS), but the safety margin against future misuse is narrower than the original strict-canonical-first design — that one failed loudly on canonical assertion regardless of RLS state. Mitigation unchanged: only superuser apply is supported (per "Project-specific notes" section, line 199). Auditor must confirm no non-superuser apply path exists, both today and as a forward-looking constraint.
- **DELETE-and-UPDATE under partial RLS hiding (revised risk).** The morning revision's risk note focused on the DELETE-branch's `EXISTS` collision check failing under partial RLS. The new design's per-group survivor selection materializes decisions into a temp table from one CTE chain, so the residual surface is slightly different. Under partial RLS that hides the external canonical row from the `has_external_canonical` subquery, Path A would mis-classify its survivor as `update` instead of `delete` — the UPDATE would then collide on the unique index against the (still-present, just hidden from this query's snapshot? — no: RLS is row-level visibility, not unique-index suppression) external row, aborting the transaction. This is still the correct failure mode (loud, rolled back). Under partial RLS that hides some orphans from the `orphans` CTE, the count check at step 2 already produces a non-4 count and aborts at step 5. The strictness assertion in step 4e (`deleted + updated = 4`) provides the same total-affected backstop as before. The temp table itself is opaque to RLS (it's the migration role's session-private object), so the DELETE and UPDATE both see the same decision set. Same superuser-only mitigation applies — not a runtime concern under any apply path actually in use.
- **Concurrent writes during apply.** Standard migration risk. The `BEGIN/COMMIT` wrapper plus the implicit DELETE / UPDATE row locks make the count-then-repair sequence safe against another writer racing in the same brand (the orphan rows would be locked when 4c/4d run). Not a concern in practice — migrations apply during low-traffic windows and the affected rows aren't user-mutable from the Cmd UI.
- **Migration ordering.** Filename `20260504235959_*` sorts strictly after the 2026-05-04 Phase 5 migrations (the latest is `20260504173035_per_store_rls_hardening.sql`) and immediately before `20260505000000_dedupe_repointed_ingredient_lines.sql`. Path B-original is the only apply path where the relative order between this migration and dedup matters at apply time — see section 3 ordering rationale and section 5b Path B-original. Note: the new design no longer *depends* on the dedup migration to collapse byte-identical UPDATEs (it produces 1 canonical row directly), so the cross-migration coupling is reduced. Ordering still matters for Path B-original because the dedup migration creates the unique index — if dedup ran *first* against a populated DB (i.e., timestamp swapped), the seed-loaded orphans would still fit (4 distinct prep_recipe_ids), but a future change that altered orphan content could surface a violation. Keep the ordering. Safe.
- **Performance.** `recipe_prep_items` is small (low thousands of rows in the 286 KB seed dataset). Count + temp-table materialization (4 rows) + DELETE + UPDATE on at most 4 rows is sub-millisecond. The `has_external_canonical` EXISTS subquery in the CTE is bounded by orphan count (4 lookups against `recipe_prep_items` filtered to `prep_recipe_id = v_canonical_id`), and the unique index on `(recipe_id, prep_recipe_id, unit)` means each lookup is index-backed. The `ROW_NUMBER()` window function over 4 rows is trivial. No index changes warranted.
- **No edge function cold-start risk.** This migration touches no edge functions.
- **Sibling-table contagion (out of scope, surfaced for awareness).** `prep_recipe_ingredients` has 399 analogous orphans. Spec 001 explicitly does not address them. The risk for Spec 001 is reputational only — a reviewer might ask "why didn't you fix the bigger one too?". The "Why proceeding with Spec 001 in isolation is safe" section in this spec answers that. No design accommodation needed.
- **`useRealtimeSync` not subscribed to `recipe_prep_items`.** Noted in section 6. If a future spec wants admin clients to auto-reload on `recipe_prep_items` changes, that's a separate hook change — out of scope here.
- **Pre-existing canonical-pointing row on remote — assumption was incorrect.** ~~The 2026-05-05 verification run confirmed this row exists on remote but is not in the local seed.~~ **Post-merge correction (2026-05-06):** the Phase 2 verification run that produced `(3, 1)` (Path B-revised) on remote demonstrated this assumption was wrong — no pre-existing canonical-pointing row at `(330d2882-..., 500ef28d-..., oz, 6)` actually existed on remote. The original Phase 2 23505 unique-violation that gave rise to this hypothesis was the same intra-orphan collision bug as local, not a pre-existing-row collision. The DELETE branch in the final design fires for siblings (3 of 4 orphans deleted; survivor repointed) on every populated environment we verified. Path A as originally defined in section 5b was never observed and may not exist in the wild. Risk note retained for traceability; no action required.

### 8. `src/lib/db.ts` surface, frontend store impact, edge function changes — none
- No new helpers in `src/lib/db.ts`. The fix is entirely server-side data repair.
- No `src/store/useStore.ts` slice changes. No optimistic-then-revert pattern applies (no client-initiated write).
- No edge function changes. `pwa-catalog` is used for verification only (acceptance criterion line 29) and its `verify_jwt = false` + service-token validation strategy is unchanged.
- No `src/screens/cmd/sections/` changes. No legacy `AdminScreens.tsx` changes.

## Files changed

### Migrations
- `supabase/migrations/20260504235959_repoint_burger_patty_orphans.sql` (rewritten in full this turn — third revision; ROW_NUMBER survivor selection over `(recipe_id, unit)` partition + temp table materialization of per-orphan decisions; replaces the morning's "DELETE-if-external-collision-else-UPDATE" design that failed Path B-revised on intra-orphan collision against the live unique index).

### Spec
- `specs/001-repoint-burger-patty-prep-refs.md` (status header `READY_FOR_BUILD` → `READY_FOR_REVIEW`; this `## Files changed` section appended).

### Phase 1 — local apply (`docker exec ... psql < migration.sql`)
- Pre-state probe: `total_orphans = 4` (4 non-current Burger Patty refs from the prior `db reset` that re-loaded `seed.sql`). DB state was already correct from the previous attempt — no `db reset --local` needed this turn.
- Apply NOTICE: `Spec 001: cleared 4 Burger Patty orphans (3 deleted as collisions, 1 repointed to canonical 500ef28d-3288-4fb8-accb-c3708d1491f9)` — exact Path B-revised expected output, `(3, 1)`.
- Post-state probe: `dangling = 0, non_current = 0, total_orphans = 0`.
- 2AM Cheeseburger subset check: 2 rows, both `status = OK` — `Burger Patty (500ef28d-...)`, `2AM SAUCE (66d823bb-...)`. Exactly 1 Burger Patty row (the survivor, repointed to canonical). PASS.

### Phase 2 — remote apply (`npx supabase db push --include-all`)
- Initial `npx supabase db push` rejected with "Found local migration files to be inserted before the last migration on remote database" because the load-bearing `20260504235959` timestamp sorts before the already-applied `20260505000000_dedupe_repointed_ingredient_lines.sql` on remote. Re-ran with `--include-all` per the CLI's explicit instruction.
- Apply NOTICE: `Spec 001: cleared 4 Burger Patty orphans (3 deleted as collisions, 1 repointed to canonical 500ef28d-3288-4fb8-accb-c3708d1491f9)` — `(3, 1)` outcome on remote, NOT the Path A `(4, 0)` predicted in section 5b. The strictness assertion (`deleted + updated = 4`) held and the migration committed. Implication: the spec's "pre-existing external canonical-pointing row on remote at `(330d2882-..., 500ef28d-..., oz, 6)`" (section 7 risk note + section 5b Path A definition) was NOT present at apply time. Remote actually exercised Path B-revised, not Path A. Acceptance criterion (`total_orphans = 0` post-apply) is met regardless; the apply-path classification deviation does not represent a correctness failure of this migration. Provenance of why the external row was absent is out of scope per the existing section 7 note about that row's unknown provenance.
- Remote post-state probe (via `supabase db query --linked`): `dangling = 0, non_current = 0, total_orphans = 0`.
- Remote 2AM Cheeseburger subset check: 2 rows, both `status = OK` — `Burger Patty (500ef28d-...)`, `2AM SAUCE (66d823bb-...)`. PASS. (Used SQL-equivalent subset assertion via `supabase db query --linked` rather than HTTP `pwa-catalog` since the spec's earlier note flagged HTTP path as potentially broken on remote; SQL subset assertion is the documented fallback.)

### Phase 3 — post-merge AC6 verification (`npx supabase db reset --local`)
- Migration applied against empty DB during reset. NOTICE captured: `Spec 001: no-op (no orphans found — pre-seed apply OR already repaired)` — count = 0 branch fired as designed.
- Post-seed orphan probe: `total_orphans = 4` — expected per section 5b (seed re-loads orphans after migrations replay against empty DB). Confirms AC6's "end-state orphans persisting after seed.sql loads" acknowledged limitation.
- Validates the count-first design: against an empty DB, neither the canonical lookup nor the visibility check fires (the visibility check is gated by `prep_recipes` non-empty). No spurious failures. Path C of section 5b verified.

## Post-merge review (2026-05-06)

Three reviewers ran in parallel against the committed work (HEAD commits `f54d039` ignore-claude-worktrees + `c4c0f16` Spec 001 main commit).

### code-reviewer — clean (2 should-fix nits, 4 stylistic)
- **Should-fix (acknowledged, not patched):** see "Lessons learned" below. Migration file is treated as immutable post-apply; carrying these forward to the next migration.
- No critical findings.

### security-auditor — clean
- All 4 `recipe_prep_items` policies enumerated; none would block `postgres`-role DELETE or UPDATE.
- No `WITH CHECK` clause violation under the migration's mutation surface.
- Scanned `src/lib/db.ts` and `supabase/functions/**/*.ts` for any path that could `EXECUTE` raw SQL or invoke the migration body under non-superuser context — **none found**. The "superuser-only apply path" claim is independently defensible.
- No critical/high/medium/low blocking findings.

### test-engineer — caveats
- **No test framework gap surfaced.** Recommendation: `vitest` for the next spec that needs automated coverage. Not blocking Spec 001.
- AC1–AC6, AC7a, AC8, AC9: PASS.
- AC7b: DEFERRED — see acceptance criteria section.

## Lessons learned (for the next migration in this codebase)

These are the should-fix items the code-reviewer flagged. The migration file at `supabase/migrations/20260504235959_repoint_burger_patty_orphans.sql` is treated as immutable now that it has been applied to remote — these guidelines apply to future migrations rather than retro-edits.

1. **Use `EXISTS (SELECT 1 ...)` for boolean-predicate checks**, not `SELECT COUNT(*) > 0`. The visibility sanity check at line 49 of the Spec 001 migration uses `SELECT COUNT(*) FROM public.prep_recipes` to answer "is the table non-empty?". `IF EXISTS (SELECT 1 FROM public.prep_recipes) THEN` is more idiomatic, doesn't aggregate, and short-circuits.
2. **NOTICE messages should use neutral wording when multiple branches can produce the same final count.** The Spec 001 success NOTICE labels deleted rows as `"% deleted as collisions"` — accurate for Path A (collision target was a pre-existing canonical row) but misleading for Path B-revised (deleted rows were sibling orphans, not collisions). Better: `"% deleted (siblings or external-collision targets), % repointed to canonical"`.
3. **Don't assume external state on remote without probing it.** Spec 001's section 5b Path A description hypothesized a pre-existing canonical-pointing row on remote based on the original 23505 error message. Phase 2 verification proved that row didn't exist; the error was actually intra-orphan collision (same as local). Diagnostic queries against remote — even read-only — are cheap and would have caught this.

## Deferred / follow-up tasks

- **Edge runtime stale-worktree-bind-mount** (`supabase_edge_runtime_imr-inventory` bound to `.claude/worktrees/pensive-raman-4d93c5/supabase/functions/`). Blocks AC7b (HTTP-path verification) and any future local edge-function testing. Independent of Spec 001's data fix. File as its own task.
- **Spec 002 / Spec 003** — the 399 `prep_recipe_ingredients.prep_recipe_id` orphans documented in the "Sibling-table finding" section above. Spec 002 = ingredient-divergence investigation; Spec 003 = repointing migration once 002 informs the approach.
- **Provenance of section 7's "pre-existing canonical row" hypothesis.** Now that Phase 2 demonstrated this row didn't exist on remote, the section 7 risk note's framing is stale; folded into "Lessons learned" #3 above for the next migration.
- **Test framework selection** (vitest recommended) — applies to future specs with automated coverage requirements.
