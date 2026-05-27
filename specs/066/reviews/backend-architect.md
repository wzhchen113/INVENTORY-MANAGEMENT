# Spec 066 — backend-architect post-implementation drift review

Reviewer: backend-architect (post-impl mode)
Verdict: **SHIP_READY**

The implementation matches the design end-to-end. All 8 verification points pass. No Critical, Should-fix, or Minor findings.

---

## Drift checklist

### 1. Migration body matches the §2 design sketch — matches design

The migration file [supabase/migrations/20260528000000_actor_fk_cascade_audit.sql](../../../supabase/migrations/20260528000000_actor_fk_cascade_audit.sql) contains exactly 11 swap/restoration blocks wrapped in a single `begin; ... commit;`. Each block follows the canonical shape:

```sql
alter table public.<table>
  drop constraint if exists <table>_<column>_fkey;
alter table public.<table>
  add constraint <table>_<column>_fkey
    foreign key (<column>) references public.profiles(id) on delete set null;
```

Header comment ([supabase/migrations/20260528000000_actor_fk_cascade_audit.sql:1-50](../../../supabase/migrations/20260528000000_actor_fk_cascade_audit.sql)) captures all four rationale dimensions per AC8: spec 065 lineage + sibling-reference shapes, out-of-scope tables (`user_stores`, `eod_submissions`, `inventory_counts`), trigger orthogonality (including the `report_runs_check_definition_consistency_trg` neighbor analysis from §Q5), and RLS+realtime non-impact. Idempotency note is also present at lines 46–49.

**Justified deviation — ordering:** the §2 sketch listed swaps in survey-order (the order of the table 1-10 from the spec). The actual file uses alphabetical-by-table: audit_log → flags.resolved_by → flags.user_id → inventory_items → pos_imports → prep_recipes → purchase_orders.{created_by, received_by} → report_definitions → report_runs → waste_log. The design's AC §"In scope" explicitly authorized "alphabetical-by-table is fine; no ordering dependency" and the spec's `## Files changed` appendix declares "alphabetical by table" as the chosen order. Statement-independence is verified — no FK in the sweep references another table in the sweep, so any order is valid. **Matches design.**

### 2. Migration covers the 11 columns from the survey — matches design

Constraint name lookup in the migration file:

| # | Spec table | Migration line | Constraint name |
|---|---|---|---|
| 1 | `audit_log.user_id` | [55-59](../../../supabase/migrations/20260528000000_actor_fk_cascade_audit.sql) | `audit_log_user_id_fkey` |
| 2 | `flags.resolved_by` | [62-66](../../../supabase/migrations/20260528000000_actor_fk_cascade_audit.sql) | `flags_resolved_by_fkey` |
| 3 | `flags.user_id` | [69-73](../../../supabase/migrations/20260528000000_actor_fk_cascade_audit.sql) | `flags_user_id_fkey` |
| 4 | `inventory_items.last_updated_by` | [76-80](../../../supabase/migrations/20260528000000_actor_fk_cascade_audit.sql) | `inventory_items_last_updated_by_fkey` |
| 5 | `pos_imports.imported_by` | [83-87](../../../supabase/migrations/20260528000000_actor_fk_cascade_audit.sql) | `pos_imports_imported_by_fkey` |
| 6 | `prep_recipes.created_by` (RESTORATION) | [94-98](../../../supabase/migrations/20260528000000_actor_fk_cascade_audit.sql) | `prep_recipes_created_by_fkey` |
| 7 | `purchase_orders.created_by` | [101-105](../../../supabase/migrations/20260528000000_actor_fk_cascade_audit.sql) | `purchase_orders_created_by_fkey` |
| 8 | `purchase_orders.received_by` | [108-112](../../../supabase/migrations/20260528000000_actor_fk_cascade_audit.sql) | `purchase_orders_received_by_fkey` |
| 9 | `report_definitions.created_by` | [115-119](../../../supabase/migrations/20260528000000_actor_fk_cascade_audit.sql) | `report_definitions_created_by_fkey` |
| 10 | `report_runs.ran_by` | [122-126](../../../supabase/migrations/20260528000000_actor_fk_cascade_audit.sql) | `report_runs_ran_by_fkey` |
| 11 | `waste_log.logged_by` | [129-133](../../../supabase/migrations/20260528000000_actor_fk_cascade_audit.sql) | `waste_log_logged_by_fkey` |

1:1 with the spec's survey table (10 sweep + 1 restoration). No extras, no omissions. `eod_submissions.submitted_by` correctly NOT in the migration (out-of-scope per spec 065). `user_stores.user_id` correctly NOT in the migration (intentional `on delete cascade`). `inventory_counts.submitted_by` correctly NOT in the migration (already SET NULL). **Matches design.**

### 3. `prep_recipes.created_by` restoration matches §Q2 path (a) — matches design

The restoration block at [supabase/migrations/20260528000000_actor_fk_cascade_audit.sql:89-98](../../../supabase/migrations/20260528000000_actor_fk_cascade_audit.sql) restores the FK with `on delete set null` and NO data clean-up step. Per the spec's `## Files changed` verification record step 1: "Prod orphan check ... `orphan_count = 0`. Green-light to proceed with single-file migration as designed." The header comment at lines 89-93 explicitly notes "Prod orphan check returned 0 rows pre-PR."

This matches Q2 path (a) from the design — restore as `on delete set null`, no clean-up step. The path (b) escape valve (data clean-up first / split migration) was not needed because the orphan count returned 0. **Matches design.**

### 4. pgTAP test has all 13 arms — matches design

Test file [supabase/tests/actor_fk_cascade_audit.test.sql](../../../supabase/tests/actor_fk_cascade_audit.test.sql) declares `select plan(13);` at line 44 and lands 13 `is(...)` blocks:

| Arm | Coverage |
|---|---|
| (1) [47-63](../../../supabase/tests/actor_fk_cascade_audit.test.sql) | `inventory_items.last_updated_by` — sweep |
| (2) [66-82](../../../supabase/tests/actor_fk_cascade_audit.test.sql) | `waste_log.logged_by` — sweep |
| (3) [85-101](../../../supabase/tests/actor_fk_cascade_audit.test.sql) | `purchase_orders.created_by` — sweep |
| (4) [104-120](../../../supabase/tests/actor_fk_cascade_audit.test.sql) | `purchase_orders.received_by` — sweep |
| (5) [123-139](../../../supabase/tests/actor_fk_cascade_audit.test.sql) | `pos_imports.imported_by` — sweep |
| (6) [142-158](../../../supabase/tests/actor_fk_cascade_audit.test.sql) | `audit_log.user_id` — sweep |
| (7) [161-177](../../../supabase/tests/actor_fk_cascade_audit.test.sql) | `flags.user_id` — sweep |
| (8) [180-196](../../../supabase/tests/actor_fk_cascade_audit.test.sql) | `flags.resolved_by` — sweep |
| (9) [199-215](../../../supabase/tests/actor_fk_cascade_audit.test.sql) | `report_definitions.created_by` — sweep |
| (10) [218-234](../../../supabase/tests/actor_fk_cascade_audit.test.sql) | `report_runs.ran_by` — sweep |
| (11) [242-259](../../../supabase/tests/actor_fk_cascade_audit.test.sql) | `prep_recipes.created_by` — RESTORATION |
| (12) [266-282](../../../supabase/tests/actor_fk_cascade_audit.test.sql) | `inventory_counts.submitted_by` — positive control |
| (13) [290-307](../../../supabase/tests/actor_fk_cascade_audit.test.sql) | `eod_submissions.submitted_by` — positive control |

Plan = 10 + 1 + 2 = 13 ✓. Each arm uses the recommended lookup pattern: `(conrelid, conkey, contype = 'f', confrelid = 'public.profiles'::regclass)` — robust against constraint rename per the design's §5 closing recommendation. Arm-failure messages cite the migration file and the regression scenario, which is the "hand-written form" the design preferred over single-CTE aggregation.

Hermetic isolation present: `begin;` at line 41, `select * from finish();` and `rollback;` at lines 310-311 — schema-introspection only, no JWT impersonation, no fixture. **Matches design.**

### 5. Timestamp `20260528000000_` matches §Q3 — matches design

Filename is `20260528000000_actor_fk_cascade_audit.sql` — midnight-anchored, next available after spec 065's `20260527000000_`. Exact value the architect's §Q3 resolution recommended. **Matches design.**

### 6. No accidental drift outside scope — matches design

The spec's `## Files changed` section declares only two new files plus the spec markdown itself. Spot-checks confirmed:

- `supabase/migrations/20260528000000_actor_fk_cascade_audit.sql` — new file, present.
- `supabase/tests/actor_fk_cascade_audit.test.sql` — new file, present (35 test files total in `supabase/tests/`; 34 pre-existing + 1 new).
- No edits to any other migration, no edits to `src/lib/db.ts`, `src/store/useStore.ts`, screens, or edge functions.

The spec's verification record step 5 reports `npx tsc --noEmit` clean and `npm test` 33 jest suites / 316 tests pass — consistent with AC5 (SQL-only change). **Matches design.**

### 7. Trigger orthogonality verified — matches design

The migration's header comment at [supabase/migrations/20260528000000_actor_fk_cascade_audit.sql:28-44](../../../supabase/migrations/20260528000000_actor_fk_cascade_audit.sql) carries the exact §Q5 analysis: identifies `report_runs_check_definition_consistency_trg` as the lone neighbor in scope that rewrites `ran_by`, explains why FK cascade is orthogonal to user-visible BEFORE UPDATE row triggers, and notes that `auth.uid()` under the postgres cascade role is NULL anyway. The migration touches only the FK action on `report_runs.ran_by` and does NOT touch the trigger — confirmed by grep ([supabase/migrations/20260510130000_report_runs_consistency.sql:90-94](../../../supabase/migrations/20260510130000_report_runs_consistency.sql) is the trigger definition and is undisturbed by spec 066). **Matches design.**

### 8. Developer's 4-step verification plan executed — matches design

The spec's `## Files changed` section enumerates all five verification steps from the design's §6 plan plus one bonus JS toolchain check:

- Step 1 — prod orphan check returned `orphan_count = 0`. ✓
- Step 2 — `npx supabase db reset` clean apply with only the expected "constraint does not exist, skipping" notice for the prep_recipes FK no-op (this is the `drop constraint if exists` on a since-deleted FK — exactly what the idempotency clause was designed to handle). ✓
- Step 3 — `bash scripts/test-db.sh` = 35/35 pgTAP files green (34 pre-existing + 1 new at 13/13 assertions). ✓
- Step 4 — mutation test on arm (6) `audit_log.user_id`: reverted to `on delete no action`, test failed with `# Failed test 6 ... have: a / want: n`, then reverted to `set null` and re-ran full suite green. Exact pattern the design's §6.3 prescribed. ✓
- Step 5 — `npm test` (33 suites / 316 tests) + `npx tsc --noEmit` (clean). Confirms AC5. ✓

All four design-required verification steps complete. **Matches design.**

---

## Risk re-check (design §7)

| Design risk | Status post-impl |
|---|---|
| Orphan rows in any of the 10 swap tables block `add constraint` validation. | Did not materialize — `db reset` clean per step 2. |
| Orphan rows in `prep_recipes.created_by` block validation on restoration. | Did not materialize — prod orphan check returned 0 per step 1. |
| Constraint name mismatch. | N/A — `drop constraint if exists` handled the prep_recipes case (where no constraint existed pre-migration). |
| `alter table` lock contention. | Not exercised in local apply; sub-second per design §7. Prod push is main Claude's call post-merge per AC6. |

No new risks surfaced during review.

---

## Verdict

SHIP_READY. The implementation is a byte-for-byte realization of the §2 design sketch (modulo the alphabetical-by-table re-ordering, which was explicitly authorized by both the AC §"In scope" guidance and the spec's `## Files changed` appendix). All 8 drift points clear, all 4 verification steps executed, and the test suite is at 35/35 with mutation-guard confirmation that arm (6) catches a NO ACTION regression.

No Critical, Should-fix, or Minor findings.

## Handoff
next_agent: NONE
prompt: Architectural drift review complete. 0 findings. SHIP_READY.
payload_paths:
  - specs/066/reviews/backend-architect.md
