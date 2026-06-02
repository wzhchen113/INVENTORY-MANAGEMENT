## Test report for spec 086

### Acceptance criteria status

#### Staff catalog / type (EodItem)

- AC-TYPE-1: `EodItem` gains `caseQty: number | null` field → PASS — `src/screens/staff/lib/types.ts:29` declares the field; `EODCount.test.tsx` "renders with TWO inputs" mocks `case_qty: 12` and the field is threaded through.
- AC-TYPE-2: `fetchItemsForVendor` selects `case_qty` from `catalog_ingredients` and maps to `EodItem.caseQty` → PASS — `EODCount.tsx:124` adds `case_qty` to the select; `EODCount.tsx:149` maps via `c?.case_qty == null ? null : Number(c.case_qty)`. Covered by the "renders with TWO inputs" test which mocks a non-null `case_qty` and the "null caseQty → ×1" test which omits it.
- AC-TYPE-3: Absent/null `caseQty` defaults to **1** at the conversion site (`caseQty || 1`) → PASS — `EODCount.tsx:358` uses `(it.caseQty || 1)`. Covered non-vacuously by `EODCount.test.tsx` "defaults caseQty to 1 when the catalog has no case_qty (null → ×1)": catalog row has no `case_qty` key, 4 cases × 1 + 5 units = 9 is asserted and would fail if `|| 1` were missing.

#### Staff EOD screen (EODCount.tsx)

- AC-SCREEN-1: Each item row renders two numeric inputs — `eod-item-cases-${id}` and `eod-item-units-${id}` — the old `eod-item-input-${id}` removed → PASS — `EODCount.test.tsx:93-96` asserts both new testIDs present and `queryByTestId('eod-item-input-item-1')` returns null.
- AC-SCREEN-2: Per-item state uses two `Record<string,string>` maps (`caseCounts` / `unitCounts`) → PASS — `EODCount.tsx:227-228` declares both state vars. Exercised by the conversion and pre-fill tests.
- AC-SCREEN-3: Total = `cases × (caseQty || 1) + units`; empty → 0 before multiply/add → PASS (two tests):
  - `EODCount.test.tsx` "converts Cases × caseQty + Units": 2 cases × 12 + 3 units = 27 asserted; would fail if formula were wrong.
  - `EODCount.test.tsx` "defaults caseQty to 1 when catalog has no case_qty": 4 × 1 + 5 = 9. Both real `caseQty` (12) and null `caseQty` (→ 1) are tested with non-trivial arithmetic.
- AC-SCREEN-4: Row "entered" when EITHER Cases OR Units non-empty; fully-blank rows skipped → PASS (three tests covering all branches):
  - "includes a row when ONLY Units is filled": units=7.5, cases blank → row included, cases null.
  - "includes a row when ONLY Cases is filled" (added by test-engineer): cases=3 × caseQty=4 = 12, units blank → row included, each null.
  - "skips a fully-blank row": neither filled → noCountsEntered toast, `mockSubmit` not called.
- AC-SCREEN-5: Pre-fill seeds BOTH inputs from `fetchExistingSubmission`; `actual_remaining_each ?? actual_remaining` legacy fallback → PASS (two tests):
  - "shows the pre-fill banner and seeds both boxes from a split submission": cases=2, units=5 pre-filled correctly.
  - "pre-fills a LEGACY row (null splits) as Cases blank, Units = total": `actual_remaining_cases=null, actual_remaining_each=null, actual_remaining=18` → cases box shows `''`, units box shows `'18'`. Directly exercises the `?? actual_remaining` fallback.
- AC-SCREEN-6: Submit/Queued/Already-submitted toasts and forbidden-banner behavior unchanged → PASS — `EODCount.test.tsx` covers all four: "Submitted" toast (line 272), "Already submitted" (line 289), forbidden banner (line 307), queued/input-clear (line 327).

#### Staff queue + submit hook

- AC-QUEUE-1: `EodEntry` extended to `{ item_id, actual_remaining, actual_remaining_cases, actual_remaining_each }` → PASS — `src/screens/staff/lib/types.ts:53-58`. TS strict enforces this everywhere.
- AC-QUEUE-2: `entriesForRpc` maps all three values into the RPC arg object → PASS — `useEodSubmit.ts:80-84`. `useEodSubmit.test.ts` "returns success when RPC returns 200 + conflict=false" asserts `p_entries` contains `{ ingredient_id, actual_remaining: 3, actual_remaining_cases: 1, actual_remaining_each: 1 }` — non-vacuous.
- AC-QUEUE-3: `QUEUE_KEY` bumped to `:v2` → PASS — `eodQueue.ts:26`. `useStaffStore.test.ts:72` asserts `setItem` called with `'imr-staff:eod-queue:v2'`.
- AC-QUEUE-4: `:v1 → :v2` read-once migrate → PASS (five tests in `eodQueue.test.ts`):
  - "migrates an in-flight v1 payload to the v2 shape and removes v1": total/each=count, cases=null, v1 key removed, v2 populated. Would fail if transform or remove were missing.
  - "is idempotent — does not clobber an existing non-empty v2 payload": v2 unchanged when pre-populated. Non-vacuous guard against clobber.
  - "is a no-op when there is no v1 payload": no write fires.
  - "running twice does not double-migrate": `store[QUEUE_KEY]` unchanged after second call.
  - "skips a malformed v1 entry but keeps the valid submission": partial corruption is tolerant.
  - "backs up and clears malformed v1 bytes (no throw)": corrupt bytes → backup key created, v1 removed, v2 absent.
- AC-QUEUE-5: Poison-queue key references updated to `:v2` in `e2e/fixtures/constants.ts`, `e2e/eod.spec.ts`, `useStaffStore.test.ts`, `tests/README.md` → PASS — verified in all four files: `constants.ts:72` (`STAFF_QUEUE_KEY = 'imr-staff:eod-queue:v2'`); `eod.spec.ts:13,51,57` passes `STAFF_QUEUE_KEY` to `addInitScript`; `useStaffStore.test.ts:72` asserts `:v2`; `tests/README.md:644-645` documents `:v2`.
- AC-QUEUE-6: Offline submit → reconnect → drain preserves cases/units → PASS — `useEodSubmit.test.ts` "queues + returns queued when offline" asserts enqueued entry carries `actual_remaining_cases: 1, actual_remaining_each: 1`. The drain-loop test "bumps attempts and continues" uses the 3-field shape throughout.

#### Backend RPC (staff_submit_eod)

- AC-RPC-1: `jsonb_to_recordset` column list gains `actual_remaining_cases numeric` and `actual_remaining_each numeric` → PASS — `20260601000000_staff_submit_eod_cases_each.sql:179-186` (Hunk A). pgTAP assertion (3) would fail if the columns weren't destructured.
- AC-RPC-2: RPC INSERTs both new fields alongside `actual_remaining` → PASS — migration lines 193-199 (Hunk B). pgTAP assertion (3) asserts `row(actual_remaining, actual_remaining_cases, actual_remaining_each) = row(17, 2, 3)` — non-vacuous; fails if either split column were absent.
- AC-RPC-3: `actual_remaining` stores the client-sent total, RPC does NOT recompute → PASS — pgTAP assertion (5) asserts `actual_remaining = 17` when 2 cases + 3 each were sent with total=17 (not pack-math-recomputed). Non-vacuous: if the RPC recomputed it would differ.
- AC-RPC-4: Signature unchanged — `(uuid, uuid, date, text, text, jsonb, uuid)` → PASS — `create or replace` used (not `drop+recreate`); pgTAP assertion (1) pins `has_function_privilege('authenticated', 'public.staff_submit_eod(uuid, uuid, date, text, text, jsonb, uuid)', 'EXECUTE') = true`.
- AC-RPC-5: Backward-compatible — element WITHOUT split keys inserts with `_cases/_each = NULL` → PASS — pgTAP assertion (4): legacy element with only `ingredient_id` and `actual_remaining=11` → row has `row(11, null, null)`. Non-vacuous.
- AC-RPC-6: `current_stock`/`eod_remaining` write continues to use `actual_remaining` (total) → PASS — migration line 211-215 unchanged; spec note that this is explicitly unchanged.
- AC-RPC-7: Audit-log `value` continues to render `actual_remaining` (total) + unit → PASS — migration line 234 uses `v_entry.actual_remaining::text`. Spec explicitly marks human-readable breakdown as out of v1.
- AC-RPC-8: `auth_can_see_store` gate and `eod_entries` consistency trigger not weakened → PASS — pgTAP assertion (6) calls the RPC for Charles (out of membership) with split keys present and asserts `42501` still raised. Consistency trigger implicitly exercised by assertions (2)+(3) succeeding (a cross-store item would have triggered the constraint and caused those to fail). The pre-existing `eod_submissions_consistency.test.sql` (11 assertions, all passing) continues to validate trigger behavior.

#### Admin EOD section — no behavior change

- AC-ADMIN-1: `EODCountSection.tsx` not modified beyond optional stale-comment fix → PASS — only the comment at line 60 ("Single qty input per item...") remained unchanged (the fix is optional per spec). The file was not otherwise touched. Verified by `git status` (clean tree at spec start).

#### Backward compatibility / no data loss

- AC-COMPAT-1: Legacy `eod_entries` rows with null splits render without error; Cases blank, Units = total → PASS — covered by `EODCount.test.tsx` "pre-fills a LEGACY row" (jest) and pgTAP assertion (4) (DB). Both directly verify the `?? actual_remaining` fallback.

---

### Test run

**Track 1 (jest):**
```
npx jest --no-coverage
Test Suites: 47 passed, 47 total
Tests:       460 passed, 460 total   (was 459 before test-engineer added AC-SCREEN-4 cases-only test)
```
Staff-specific suites: `EODCount.test.tsx` (15 tests), `useEodSubmit.test.ts` (7 tests), `eodQueue.test.ts` (13 tests), `useStaffStore.test.ts` (7 tests), `i18n.test.ts` (5 tests) — all PASS.

**Typechecks:**
- `npx tsc --noEmit` (base) — exit 0
- `npx tsc -p tsconfig.test.json --noEmit` (test graph) — exit 0
- `npx tsc -p e2e/tsconfig.json --noEmit` (e2e graph) — exit 0

**Track 2 (pgTAP):**
```
npm run test:db
41/41 DB test file(s) passed
staff_submit_eod_cases_each.test.sql: 6/6 assertions passed
```
New file: `supabase/tests/staff_submit_eod_cases_each.test.sql` — 6 assertions (GRANT survived, happy path returns submission_id, all three values persist, backward-compat legacy insert, total stored as-received, per-store gate holds). All 6 PASS against the local Supabase stack.

**Track 4 (Playwright e2e):** NOT RUN locally. The e2e suite requires a running browser + local Supabase stack with the full fixture setup (`global-setup.ts` inserts order_schedule rows). The fixture key string flips (`:v1 → :v2` in `e2e/fixtures/constants.ts` and the `addInitScript` in `e2e/eod.spec.ts`) were verified by code inspection as correct. The e2e typecheck (`e2e/tsconfig.json`) passes. The e2e spec fills only the Units box (`eod-item-units-*`) with Cases blank, so the online-submit pre-fill assert (`toHaveValue('7')`) is unchanged in semantics. AC-EOD1, AC-EOD-PERSIST, and AC-EOD2/3 (online + offline) are exercised in the spec. Non-blocking per CI posture.

---

### Notes

**Test added by test-engineer:** One test was missing from the "EITHER filled" AC. The devs provided "units-only" and "both filled" but not "cases-only." Added `EODCount.test.tsx` "includes a row when ONLY Cases is filled (Units blank → each null)": cases=3 × caseQty=4 = 12, units blank → row included with `actual_remaining_each: null`. This test now passes (15/15 in the suite). The total count moved from 459 → 460.

**Vacuousness audit (critical ACs):**
- **Conversion with real caseQty=12:** 2×12+3=27 is asserted. Removing the `×caseQty` from the formula would give 2+3=5; test fails. Non-vacuous.
- **Conversion with null caseQty:** 4×1+5=9. Using caseQty=0 would give 0+5=5; test fails. Non-vacuous.
- **All three DB values persist:** pgTAP row tuple `(17, 2, 3)` — dropping any column from the INSERT would produce `(17, null, null)` or similar; test fails. Non-vacuous.
- **Legacy insert (backward-compat):** pgTAP row tuple `(11, null, null)` — if the absent keys caused an error rather than NULL, assertions (4) would fail (throws, no row). Non-vacuous.
- **`:v1 → :v2` migrate:** test verifies the exact 3-field shape of migrated entries and that v1 key is removed. A dropped `removeItem` call would leave v1 present; test fails. Non-vacuous.
- **Idempotency:** test verifies `store[QUEUE_KEY]` is byte-identical after a second call. A clobber would produce a different value. Non-vacuous.

**Optional stale comment not fixed:** `EODCountSection.tsx:60` still reads "Single qty input per item (no dual cases/each)." The spec explicitly marks this as optional; no test covers it; not a blocking issue.

**Track 4 note (non-blocking):** The e2e spec fills Units only (Cases blank) — it does not assert the Cases input's pre-fill value on reload, only the Units value. A future e2e test could extend the online-submit case to fill both Cases AND Units and assert both pre-fill correctly on reload. Not blocking for SHIP_READY (Track 4 is advisory in CI).

**CI status:** The latest `test.yml` run on `main` was green before this spec's work landed (per CLAUDE.md policy, the release-coordinator must confirm CI status post-merge).
