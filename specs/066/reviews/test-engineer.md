## Test report for spec 066

### Acceptance criteria status

- AC1: Single new migration file `supabase/migrations/20260528000000_actor_fk_cascade_audit.sql` lands with all 11 FK swaps (10 `no action` → `set null`, 1 restoration of missing `prep_recipes.created_by` FK) → PASS — `supabase/migrations/20260528000000_actor_fk_cascade_audit.sql` (11 alter-table pairs verified)
- AC2: `prep_recipes.created_by` FK restored as `references public.profiles(id) on delete set null` within the same migration → PASS — migration line 94-98; NOTICE at reset confirms prior FK was absent (`constraint "prep_recipes_created_by_fkey" of relation "prep_recipes" does not exist, skipping`); FK now present and arm (11) asserts `confdeltype = 'n'`
- AC3: `bash scripts/test-db.sh` runs green — all 34 pre-existing pgTAP suites continue to pass → PASS — 35/35 pass (34 pre-existing + 1 new)
- AC4: New pgTAP file `supabase/tests/actor_fk_cascade_audit.test.sql` bulk-verifies all 13 FKs in scope (spec originally said 12; design §5/Q6 corrects to 13 by adding both positive controls) with `confdeltype = 'n'` → PASS — `select plan(13);` matches 13 `select is(...)` arms; all 13 pass
- AC5: No application code changes — `src/lib/db.ts`, `src/store/useStore.ts`, screens, edge functions untouched → PASS — `git status` shows only 2 untracked new files (`supabase/migrations/20260528000000_actor_fk_cascade_audit.sql`, `supabase/tests/actor_fk_cascade_audit.test.sql`) plus the spec directory; no modifications to any existing file
- AC6: Production push deferred to main Claude post-merge → PASS — neither file triggers an automated push; no deploy tooling invoked
- AC7: Migration applies cleanly via `npx supabase db reset`; mutation test causes corresponding arm to fail → PASS — clean apply confirmed; mutation test independently verified (see below)
- AC8: Header comment captures trigger-orthogonality, RLS non-impact, realtime non-impact rationale once at file level; per-statement one-liners only → PASS — all three rationale blocks appear in the header (lines 28, 41, 43), before `begin;`; per-statement comments are single-line only

### Test run

**Migration apply (`npx supabase db reset --local`)**
Clean apply. Only expected notice: `constraint "prep_recipes_created_by_fkey" of relation "prep_recipes" does not exist, skipping`. No errors.

**pgTAP suite (`bash scripts/test-db.sh`)**
```
✓ 35/35 DB test file(s) passed
```
actor_fk_cascade_audit.test.sql: 13/13 assertions passed

**Jest (`npm test`)**
```
Test Suites: 33 passed, 33 total
Tests:       316 passed, 316 total
```

**Typecheck**
```
npm run typecheck     — clean (no output)
npm run typecheck:test — clean (no output)
```

**Mutation test (independently verified — arm 7, `flags.user_id`)**

Changed `flags.user_id` constraint from `on delete set null` to `on delete no action` in the migration, ran `npx supabase db reset && bash scripts/test-db.sh supabase/tests/actor_fk_cascade_audit.test.sql`. Result:

```
not ok 7 - arm (7): flags.user_id FK references profiles(id) with on delete set null.
# Failed test 7: ...
#         have: a
#         want: n
# Looks like you failed 1 test of 13
✗ 1/1 DB test file(s) failed
```

Arms 1–6 and 8–13 remained green. Exactly one arm failed, pointing directly at the mutated FK. Mutation was then reverted; full 35/35 restored.

**Misspelled constraint spot-check**

Ran the pgTAP query with a nonexistent table/column. The query returns NULL, and `is(NULL, 'n', msg)` fails with `have: NULL, want: n`. There is no silent-pass risk from a future constraint rename or column typo in the test file.

### Notes

**AC4 count discrepancy (informational, not a block).** The original spec AC4 says "12 constraints"; the architect's design §5/Q6 explicitly authorizes 13 by adding both `inventory_counts.submitted_by` and `eod_submissions.submitted_by` as positive-control regression guards. The implementation correctly follows the design (13 arms), and the spec acknowledges this count update. Not a defect.

**Migration statement order vs. spec guidance.** The spec says "alphabetical-by-table is fine." The actual migration uses strict alphabetical order (`audit_log`, `flags` ×2, `inventory_items`, `pos_imports`, `prep_recipes`, `purchase_orders` ×2, `report_definitions`, `report_runs`, `waste_log`). This matches and is correct.

**Future-proofing gap (Nit, non-blocking).** The new pgTAP test asserts `confdeltype = 'n'` for the 13 named (table, column) pairs only. A future migration that introduces a NEW actor FK column with `on delete no action` would not be caught by this test. The spec explicitly acknowledges this as acceptable for v1 (Q5 / §5 discussion). A future global guard could be added as a separate spec — the pattern in `permissive_policy_lint.test.sql` demonstrates how to write a catch-all catalog probe. Not a block; surfaced per task instruction.

**`user_stores.user_id` out-of-scope confirmation.** The migration does not touch `user_stores.user_id` (the intentional `on delete cascade` join-table FK). Confirmed by grep — it appears only in the header comment as an explicit out-of-scope callout.

## Handoff
next_agent: NONE
