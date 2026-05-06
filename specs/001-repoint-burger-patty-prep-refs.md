# Spec 001: Repoint orphaned "Burger Patty" prep references

Status: READY_FOR_ARCH

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
_To be filled in by the architect or implementer before the migration is written._

- [ ] `recipe_prep_items` orphan count: ____
- [ ] Other FK-referencing tables enumerated: ____
- [ ] Orphans found in any other table: yes / no — if yes, **stop and surface to user**.

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
