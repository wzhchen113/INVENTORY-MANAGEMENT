## Test report for spec 006

### Acceptance criteria status

- **AC1** — `docs/internal/prep-canonicalness-notes.md` line 99 edited so the
  canonical prefix for `House Special Blend (Sauce)` reads `36016d31` (replacing
  `4fbd90`), committed in the same change as the migration. →
  **VERIFIED (live evidence)**
  Staged diff confirms: `-### House Special Blend (Sauce) (canonical prefix: 4fbd90)`
  → `+### House Special Blend (Sauce) (canonical prefix: 36016d31)`.
  All seven artifacts — migration, owner-notes edit, and four recovery-snapshot
  files — are staged together in the same pending commit. The spec requires
  co-commit; the staged set satisfies that requirement pending the user's
  `git commit` invocation.

- **AC2** — One new timestamped migration in `supabase/migrations/`, wrapped in a
  single `BEGIN; … COMMIT;` transaction. →
  **VERIFIED (code-verified + live evidence)**
  File `supabase/migrations/20260507030000_spec006_house_special_blend_sauce_cleanup.sql`
  exists, is 126 lines, opens with `BEGIN;` at line 40, and closes with `COMMIT;`
  at line 126. Verified by direct inspection. Apply log confirms it was accepted by
  `supabase db push` without error.

- **AC3** — Pre-impl remote probe records exact row counts in `## Build notes`:
  2 `prep_recipes` rows (one `36016d31` `is_current = true`, one `4fbd90`
  `is_current = false`), and 6 `prep_recipe_ingredients` rows for the stale
  row. →
  **VERIFIED (live evidence)**
  Build notes § "§1 gate outputs" documents:
  - gate_a: 2 rows, prefixes `36016d31` (is_current=true) and `4fbd90`
    (is_current=false). PASS.
  - gate_b: ingredient fan-out for stale parent = 6. PASS.
  - gate_c: ingredient fan-out for canonical parent = 6. Recorded (not gated).
  - gate_d: global orphan total = 405. PASS.
  All four STOP conditions cleared before apply.

- **AC4** — Migration deletes exactly 6 `prep_recipe_ingredients` rows then 1
  `prep_recipes` row, both deletes guarded by count assertions; transaction aborts
  on unexpected counts. →
  **VERIFIED (code-verified + live evidence)**
  The committed SQL at lines 92–107 performs `DELETE FROM prep_recipe_ingredients`
  scoped to the stale UUID, then checks `GET DIAGNOSTICS v_deleted = ROW_COUNT;
  IF v_deleted NOT IN (0, 6) THEN RAISE EXCEPTION`. Lines 109–124 do the same for
  the parent row with bounds `{0, 1}`. Post-apply verify_a=0, verify_b=0 confirm
  both deletes landed with no partial state. Assertions 3 and 4 are present and
  correctly scoped.

- **AC5** — Migration is idempotent: re-running results in 0 deletes, transaction
  still commits cleanly. →
  **CODE-VERIFIED**
  Assertion 1 accepts `v_count IN (0, 1)` — 0 rows after first apply is
  explicitly allowed. Assertion 2's `v_parent = 0 AND v_ing = 0` branch is a
  clean exit (no RAISE). The DELETE statements produce 0 affected rows;
  assertions 3 and 4 accept `NOT IN (0, 6)` / `NOT IN (0, 1)` respectively,
  so 0 also passes. The transaction commits cleanly. Path-B (fresh local DB
  pre-seed) in the apply-path matrix describes exactly this scenario and matches
  the assertion logic. Re-run was not executed live against prod post-apply
  (that would be the definitive verification), but the SQL logic is unambiguous.

- **AC6** — Post-apply verification probe records in `## Build notes`: exactly 1
  `prep_recipes` row at name `House Special Blend (Sauce)` (`36016d31`,
  `is_current = true`); 0 `prep_recipe_ingredients` rows referencing the stale
  id; global orphan count decreased by exactly 6. →
  **VERIFIED (live evidence)**
  §5 verification table (spec lines 995–1000):
  - verify_a (stale row gone): expected 0, actual 0. PASS.
  - verify_b (orphan ings for stale id gone): expected 0, actual 0. PASS.
  - verify_c (canonical untouched): expected `36016d31` / is_current=true,
    actual `36016d31` / true. PASS.
  - verify_d (Spec 003 grand-total): expected 399, actual 399. PASS.
  All four probes ran live against project `ebwnovzzkwhsdxkpyjka` immediately
  post-push.

- **AC7** — No `prep_recipe_ingredients` row references a `prep_recipes` row that
  no longer exists, scoped to name `House Special Blend (Sauce)`. →
  **VERIFIED (live evidence)**
  verify_b returning 0 directly proves this: zero `prep_recipe_ingredients` rows
  reference the deleted `4fbd90cc…` id. The only remaining row at this name is
  the `36016d31` canonical, which is `is_current = true` and was left untouched
  (verify_c). No dangling FK references remain.

- **AC8** — Migration is compatible with the existing partial unique index
  `prep_recipes_brand_name_current_unique` (deletes only, no `is_current` toggles). →
  **VERIFIED (code-verified)**
  The migration performs only DELETE operations. No UPDATE of `is_current` occurs
  anywhere in the file. The partial unique index on `(brand_id, lower(name)) WHERE
  is_current = true` is not exercised by a DELETE on a row with `is_current = false`.
  The `36016d31` canonical retains its unique slot before, during, and after. No
  index conflict possible.

---

### Additional findings

#### 1. §3 tightening — gap closed and verified (PASS)

The dev correctly identified that the architect's draft assertion 2 lacked
`AND is_current = false` on the parent SELECT, which would have caused path-C
(local with seed) to silently delete the local canonical row instead of
aborting. The fix was user-authorized on 2026-05-07 and applied before any
prod push. Verification:

- The committed migration at line 73 reads
  `WHERE id = '4fbd90cc-7e06-4eef-a462-82efd386bfef'::uuid AND is_current = false` —
  the tightening clause is present.
- Path-C dry-run output (from a local BEGIN/ROLLBACK test run) shows
  `v_parent = 0, v_ing = 6`, triggering the named exception `spec006: parent
  stale row absent but 6 orphan ingredient rows remain (idempotency invariant
  violated)`, then ROLLBACK. Local data was not mutated.
- Prod apply (path-A) was not affected because `4fbd90cc…` on prod had
  `is_current = false`, so assertion 2's new filter returns `v_parent = 1` there
  as well. The apply log's described assertion sequence (`assertion_1: v_count = 1`,
  `assertion_2: v_parent = 1, v_ing = 6`) is consistent with path-A behavior.

Gap closed. No residual risk.

#### 2. Apply log RAISE NOTICE language is inaccurate — minor documentation finding (LOW)

The apply log (spec lines 983–988) states:
> The `RAISE NOTICE` lines from the assertion block (`assertion_1: v_count = 1`,
> `assertion_2: v_parent = 1, v_ing = 6`, `assertion_3: deleted ingredients = 6`,
> `assertion_4: deleted parent = 1`) were not surfaced through `supabase db push`'s
> output filter.

The committed migration contains zero `RAISE NOTICE` statements. It has only
`RAISE EXCEPTION` guards. The path-C dry-run output that does show NOTICE lines
(`NOTICE: assertion_1: v_count = 0`) came from an instrumented dry-run script
that must have added NOTICE calls, not from the committed migration file itself.
The language in the apply log implies these NOTICE values were produced during
prod apply but suppressed — this is not accurate for the committed SQL.

The practical consequence is nil: the §5 verification probes prove post-apply
state is correct. The RAISE EXCEPTION guards are the safety net; NOTICE lines
are only observability. But the apply log's narrative is misleading for a
future operator reading it. This is a documentation defect, not a correctness
defect.

**Severity: LOW.** No action required to block ship. Can be corrected in a
follow-up spec update if the user desires.

#### 3. Recovery snapshot integrity — PASS

Line counts confirmed by `wc -l`:
- `prep_recipes_4fbd90.tsv`: 2 lines (1 header + 1 data row). Matches manifest.
- `prep_recipe_ingredients_4fbd90.tsv`: 7 lines (1 header + 6 data rows). Matches manifest.

JSON files confirmed by inspection:
- `prep_recipes_4fbd90.json`: 1-element array; `id = 4fbd90cc-7e06-4eef-a462-82efd386bfef`,
  `is_current = false`, `brand_id = 2a000000-0000-0000-0000-000000000001`. Correct.
- `prep_recipe_ingredients_4fbd90.json`: 6-element array; all 6 rows have
  `prep_recipe_id = 4fbd90cc-7e06-4eef-a462-82efd386bfef`. Correct.

TSV and JSON are structurally consistent with each other (same 6 UUIDs appear in
both ingredient files). The `\copy ... FROM` rollback procedure in §14 would be
executable as written. Snapshot integrity passes.

All four files are staged in the current pending commit, satisfying the spec's
"committed alongside the migration" requirement.

#### 4. Spec 003 unblock — PASS

verify_d returning 399 (was 405, drop of exactly 6) closes Spec 003's gate_1
`+6 orphan total` stop condition. Spec 003's gate_1 contract is keyed on the 4
prep names from Spec 005's manifest (none of which is `House Special Blend
(Sauce)`), so the per-name conditions are unaffected. The grand-total orphan
count is now 399 on prod, matching the local baseline. Spec 003's next retry
can proceed without the grand-total mismatch stop condition firing.

#### 5. Things not directly testable (gaps) — noted, non-blocking

- **Idempotency re-run on prod.** The idempotency contract is verified by code
  inspection (SQL logic is unambiguous) but a live re-execution on prod post-apply
  was not performed. The risk of not testing this live is low: the path-B matrix
  case (fresh local DB) is structurally equivalent to a re-run on prod post-apply,
  and assertion 1's `IF v_count NOT IN (0, 1)` with an already-deleted id will
  reliably return `v_count = 0`.

- **Owner-notes ingredient lines 100–105.** The spec explicitly defers whether
  the `36016d31` canonical's 6 ingredients match the owner-curated lines beneath
  line 99. This is flagged in §15 as "Owner-notes drift" risk and explicitly
  out-of-scope for this spec. Not a gap in Spec 006's deliverable, but the user
  should re-curate those lines as a follow-up.

- **RLS path.** Spec §6 confirms no new RLS policies and migration runs under
  superuser context. No RLS test was written or executed (consistent with
  project policy: no test framework, and brand-catalog tables are not in the
  per-store RLS hardening set). Noted; not a Spec 006 gap.

#### 6. Test framework recommendation (repeated from prior reviews)

This project still has no automated test runner. Prior reviews recommended
Playwright for E2E (web UI flows) and Jest for unit/integration (store,
db.ts helpers, RLS enforcement). This spec — a backend-only data cleanup — does
not require a test runner to verify, but any future spec with UI surface or
RLS logic should be gated on a real test suite rather than manual psql probes.
This remains a known gap. No escalation; user decision pending.

---

### Test run

No automated test suite exists for this project. All verification is via:

1. Direct SQL inspection of the committed migration file.
2. Live prod post-apply verification probes (§5 in spec) run via Supabase MCP
   `execute_sql` against project `ebwnovzzkwhsdxkpyjka` on 2026-05-07.
3. Path-C dry-run executed locally against `supabase_db_imr-inventory` with
   BEGIN/ROLLBACK, result documented in spec build notes.
4. Recovery snapshot line count checked via `wc -l` and content inspected
   directly.

Pass/fail summary: 8 AC — 8 VERIFIED or CODE-VERIFIED, 0 FAIL, 0 NOT TESTED.
1 LOW documentation defect (RAISE NOTICE apply-log inaccuracy, non-blocking).

---

### Notes

- The migration is still in the staged (pre-commit) state. The user controls
  the commit. All artifacts are correctly staged together.
- The three-artifact co-commit requirement (migration + owner-notes + snapshot)
  is satisfied by the staging set; it will be satisfied in the commit itself
  when the user runs `git commit`.
- No deviation from spec scope was observed. The §3 tightening was user-authorized
  and correctly implemented.
- No CI is running; the `.github/workflows/` directory does not exist on disk.
  Migration correctness was manually verified.
