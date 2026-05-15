# Test report for spec 037

## Acceptance criteria status

### Backend — `public.report_run_custom(uuid, jsonb)`

- AC-B1: Migration creates function with correct signature, `language plpgsql`, `security invoker`, `set search_path = public` → PASS — migration file confirms all four attributes verbatim.
- AC-B2: First statement raises 42501 if `auth_can_see_store(p_store_id)` returns false → PASS — `supabase/tests/report_run_custom.test.sql::arm 4` (store visibility gate).
- AC-B3: Second statement raises 42501 if `auth_is_privileged()` returns false, with message `'Custom SQL requires admin privilege'` → PASS — `supabase/tests/report_run_custom.test.sql::arm 3` (privilege gate; uses option (c) — flips manager JWT `app_metadata.role` to `'user'`, no synthetic DB user needed).
- AC-B4: Dispatcher re-created with `when 'custom'` arm after `when 'velocity'`, all existing arms preserved, `not_implemented` fallback intact → PASS — migration lines 310–354 verified; arm placement correct; `reports_anon_revoke.test.sql::arm 1` confirms the dispatcher's anon-revoke grant is refreshed.
- AC-B5: Grants: `revoke execute ... from public, anon; grant execute ... to authenticated` → PASS — migration lines 298–299 confirmed; `supabase/tests/reports_anon_revoke.test.sql::arm 8` (new arm) exercises the lockdown end-to-end.
- AC-B6: `sql` param accepted; `series_n` not accepted; unknown keys ignored → PASS — migration code confirmed; no test arm exercising explicit unknown-key forwarding, but the spec notes forward-compat is inherited from existing pattern. Acceptable.
- AC-B7: Empty/missing `sql` → 22023 with `'Custom SQL: sql parameter required'`; whitespace-only also fails → PASS — `supabase/tests/report_run_custom.test.sql::arm 5`.
- AC-B8 (Guard 1): `SET LOCAL transaction_read_only = on` before EXECUTE; DML/DDL → 25006 re-raised as `'Custom SQL: only SELECT statements are allowed'` → **FAIL (test weakened, see Criticals)**. The DML arm (6) and DDL arm (7) assert 42601 not 25006, because the SELECT-wrap blocks those statements at parse time before the read-only flag fires. The guard's exception arm (`when read_only_sql_transaction`) is never exercised by any test in the suite.
- AC-B9 (Guard 2): `SET LOCAL statement_timeout = '5s'` before EXECUTE; 57014 → `'Custom SQL: timed out after 5s'` → **FAIL (test omitted entirely, see Criticals)**. No arm tests the timeout path. The dev's substitution (arm 8 = schema lockout) replaces architect's slot 10 (timeout) AND slot 8 (RLS enforcement), leaving both gaps.
- AC-B10 (Guard 3): Row cap — LIMIT 1001 outer wrap; if 1001 rows returned, trim to 1000 + `_truncated: true` → PASS — `supabase/tests/report_run_custom.test.sql::arm 9` verifies `rows_len = 1000`, `_row_count = 1000`, `_truncated = true` using `generate_series(1, 2000)`.
- AC-B11 (Guard 4): `security invoker` — RLS filters by caller's UID; admin on Frederick calling `inventory_items WHERE store_id = '<charles-id>'` returns 0 rows → **FAIL (test omitted, see Criticals)**. Architect's arm 8 (RLS enforcement) is missing from the test file. This is the load-bearing "RLS not lexical inject" anchor from §A2.4 that the spec explicitly required.
- AC-B12 (Guard 5): Schema lockout — `auth.users` → 42501 re-raised as `'Custom SQL: access denied to non-public schema'` → PASS — `supabase/tests/report_run_custom.test.sql::arm 8`.
- AC-B13: Error sanitization wall — all seven exception classes map to fixed strings; raw SQLERRM logged but not exposed → PASS for 42601 (arm 6), 22023 (arm 5), 42501/schema-lockout (arm 8). **NOT TESTED for 25006 (`read_only_sql_transaction`), 57014 (`query_canceled`), 42P01 (`undefined_table`), 42703 (`undefined_column`), and the catch-all `WHEN OTHERS`** — only three of the seven sanitization branches are exercised.
- AC-B14: Empty result → `columns: []`, `kpis: []`, `rows: []`, `series: []`, `_truncated: false`, `_row_count: 0` → PASS — `supabase/tests/report_run_custom.test.sql::arm 11` (bonus arm, verifies all six fields).
- AC-B15: Envelope shape — all six top-level keys → PASS — `supabase/tests/report_run_custom.test.sql::arm 13`; `kpis: []`, `series: []` always; `_truncated`/`_row_count` new keys → PASS.
- AC-B16: No KPI tone bands; `_truncated`/`_row_count` ride as own keys → PASS — migration and arm 13 confirm.
- AC-B17: No prep-recipe/recursive CTE; migration header explicitly notes absence → PASS — confirmed in migration header.
- AC-B18: No new index → PASS — migration contains no `CREATE INDEX` statement.
- AC-B19: Columns derived from first row's `jsonb_object_keys WITH ORDINALITY`; `key == label`; `align: null` → PASS — `supabase/tests/report_run_custom.test.sql::arm 10`.

### Backend — Dispatcher arm

- AC-D1: `when 'custom'` arm slots between `'velocity'` and `not_implemented` fallback → PASS — migration lines 338–339 confirmed.
- AC-D2: Dispatcher's outer auth gate still fires before arm dispatch → PASS — migration lines 320–323 confirmed.
- AC-D3: Custom runner's internal privilege check fires after dispatch (defense-in-depth) → PASS — migration structure confirmed.

### Frontend — `templates.ts`

- AC-F1: `custom` template `status` flipped from `'preview'` to `'live'` → PASS — `src/screens/cmd/sections/reports/templates.ts` line 36 confirmed `status: 'live'`.
- AC-F2: Comment line `// Spec 037 flipped 'custom' to 'live' ...` added above `TEMPLATES` → PASS — line 17 of templates.ts confirmed.

### Frontend — `NewReportModal.tsx`

- AC-N1: When `isCustom`: hide preset chips, hide range from/to, hide `by:` toggle, show multiline SQL textarea (8 rows, mono font, correct placeholder) → PASS — code verified in `src/components/cmd/NewReportModal.tsx` lines ~442–460.
- AC-N2: Hint line `'SELECT only · public.* tables · 5s timeout · max 1000 rows · RLS-filtered to your stores'` shown below textarea → PASS — code verified.
- AC-N3: Save-time: `sql.trim() === ''` → toast `'SQL required'`, do NOT save → PASS (code logic confirmed at lines ~290–293). **NOT TESTED via jest** (see below).
- AC-N4: Save-time params shape `{ sql: string }` with no `range`/`from`/`to`/`by` → PASS (code confirmed at lines ~317–318). **NOT TESTED via jest**.
- AC-N5: `isCustom` branch gates all three hidden controls; non-custom branches unaffected → PASS — code verified.
- AC-N6: `sqlFocused` guard prevents plain `Enter` from firing `onCreate` inside textarea; `Cmd-Enter`/`Ctrl-Enter` still creates → PASS (code confirmed at line ~349). **NOT TESTED via jest**.
- AC-N7: `sql` state reset on each modal open; reset on template change → PASS — code confirmed at lines ~175–230.

### Frontend — `ReportDetailFrame.tsx`

- AC-R1: When `isCustom`: hide range chip, hide by chip, hide reset link → PASS — code verified lines ~377–411.
- AC-R2: Show inline read-only saved SQL above result table in `mono(400)` → PASS — code verified lines ~456–470.
- AC-R3: When `output._truncated === true`, render truncation hint above `ResultTable` in `C.warn` color → PASS — code verified lines ~911–930.
- AC-R4: `overrideRange`/`onRangeChange`/`onResetOverrides` props not passed for custom → PASS — `ReportsSection.tsx` line 246 `selectedSupportsRange` excludes `'custom'`; lines 277–281 gate the props.
- AC-R5: No `overrideBy` / `onByChange` for custom → PASS — `selectedSupportsBy` excludes `'custom'` at line 245.
- AC-R6: `OverrideBy` union NOT widened for custom (no `'sql'` sentinel) → PASS — confirmed in `ReportsSection.tsx`.
- AC-R7: `RUN` button enabled same as other live templates → PASS — no custom-specific disable logic found.

### Frontend — `ReportsSection.tsx`

- AC-S1: `selectedSupportsBy` excludes `'custom'` → PASS — line 245 confirmed.
- AC-S2: `selectedSupportsRange` excludes `'custom'`, gates `overrideRange`/`onRangeChange`/`onResetOverrides` → PASS — lines 246–281 confirmed.
- AC-S3: `onCatalogTilePress` unchanged for custom tile → PASS — no special-case found.
- AC-S4: `ReportsCustomPlaceholder` left as-is → PASS — file unmodified per `custom.tsx` tab contents.

### Tests

- AC-T1: Track 2 pgTAP `report_run_custom.test.sql` plan(13), 11 PM-pinned assertion classes + 2 fixture-sanity arms → **FAIL (see Criticals)** — plan(13) is present but three of the 13 architect-designated arms are substituted or omitted.
- AC-T2: Track 1 jest `NewReportModal.test.tsx` (5 assertions) → **FAIL** — file does not exist. Spec requires it; PM did NOT mark jest coverage optional (the "optional" note in the dev brief is not in the spec; the spec says "The test must").
- AC-T3: Track 3 shell smokes — deferred per spec → PASS (explicitly out of scope).
- AC-T4: `npm run typecheck` exit 0 → PASS (dev-verified).
- AC-T5: `npm run typecheck:test` exit 0 → PASS (dev-verified).

### Verification gates

- AC-V1: `npm test --ci` 54/54 PASS → PASS (dev-verified).
- AC-V2: `npm run test:db` PASS, file count 18 → 19 → PASS (dev-verified, 19/19).
- AC-V3: `npm run test:smoke` PASS → PASS (dev-verified).
- AC-V4: Manual browser smoke (7 sub-items) → NOT TESTED — manual gate; cannot be automated from this context.
- AC-V5: Post-merge deploy gate (`npx supabase db push --linked --yes`) → NOT TESTED — post-merge gate.

---

## Test run

Dev-reported results (pre-verified before handoff):
- `npm test -- --ci`: 54/54 PASS
- `npm run test:db`: 19/19 PASS (was 18, +1 from `report_run_custom.test.sql`)
- `npm run test:smoke`: PASS
- `npx tsc --noEmit`: clean
- `npm run typecheck:test`: clean

Test-engineer observation: the 19/19 pgTAP pass count confirms the test file runs without errors, but as noted below, three assertion classes required by the spec are not covered by the passing tests.

---

## Notes

### Critical findings (block release)

**Critical 1 — RLS enforcement arm missing (architect's arm 8 / PM spec item 7)**

The spec requires an arm that verifies: an admin member of Frederick calling `SELECT * FROM public.inventory_items WHERE store_id = '<charles-id>'::uuid` returns 0 rows. This anchors the entire "RLS, not lexical inject" posture from §A2.4 — the spec states this is the load-bearing proof that Guard 4 (`security invoker`) actually filters cross-store rows.

The dev substituted this arm with schema-lockout coverage (arm 8 in the file). The schema-lockout arm is useful but covers a different guard (Guard 5). Guard 4 has no test. The RLS test is straightforward and does not require `pg_sleep`; there is no technical reason for its omission.

**Reproduction**: The test should be: run `report_run_custom('<frederick-id>', '{"sql":"SELECT * FROM public.inventory_items WHERE store_id = ''<charles-id>''::uuid"}')` as the admin JWT and assert `jsonb_array_length(rows) = 0`. The seed's Frederick admin is in all stores but RLS on `inventory_items` must filter by `auth_can_see_store` per the per-store-RLS migration.

**Critical 2 — Statement timeout arm missing (architect's arm 10 / PM spec item 6)**

The spec requires: `SELECT pg_sleep(10)` → 57014 re-raised as `'Custom SQL: timed out after 5s'`. The dev's migration header documents a caveat: `SET LOCAL statement_timeout` inside plpgsql does NOT enforce on inner dynamic `EXECUTE`; the operative budget is the `authenticated` role's connection-level 8s default.

The migration comment says "See pgTAP arm 8 for the end-to-end demonstration via a SESSION-level timeout set outside the call" — but that promised arm does not exist in the test file. The dev labeled the schema-lockout arm as the substitute.

This is a non-trivial substitution. If `SET LOCAL statement_timeout = '5s'` is truly ineffective inside the function, the `when query_canceled` branch in the exception handler is only reachable via the role-level 8s wall — meaning a query that runs for 6-7 seconds will NOT be caught and re-raised with the user-facing `'Custom SQL: timed out after 5s'` message; instead it propagates as a raw 57014 to the caller. The spec pins the re-raise as an AC requirement.

The dev's claim is "the property can only be observed end-to-end via a real PostgREST session (a follow-up smoke test concern, not pgTAP)". This is a judgment call that the test-engineer does not accept as sufficient for a security-relevant AC. The PM AC says "test runtime for this single case ≤ 6s, accepted as a one-off." The PM accepted the cost of a slow test; the dev omitted it.

**At minimum**: the test suite must exercise the `when query_canceled` exception arm OR the dev must surface a formal caveat to the PM that the `57014 → 'Custom SQL: timed out after 5s'` sanitization path is NOT covered and cannot be covered by pgTAP. If the latter, it must appear in the spec's manual gates with a concrete reproduction step.

**Critical 3 — `NewReportModal.test.tsx` does not exist**

The spec (both PM AC and architect §15 "Jest") requires a new file `src/components/cmd/NewReportModal.test.tsx` with five assertion points:
1. Modal renders with `initialTemplateId='custom'`; SQL textarea on screen.
2. Date-range chips NOT on screen.
3. CREATE with empty SQL → toast `'SQL required'`; `addReportDefinition` not called.
4. CREATE with non-empty SQL → `addReportDefinition` called with `params: { sql: '<value>' }` and no `range`/`from`/`to`/`by`.
5. (Soft) Plain Enter in textarea does not trigger create.

The dev brief says "jest optional" but that characterization does not appear in the spec. The spec says "The test must" (PM AC §Tests, Track 1). This is a required track, not advisory. The frontend implementation is correct but untested at the component level.

The `sql.trim() === ''` guard, the params shape, and the `sqlFocused` keyboard-gate are all logic branches with no automated coverage. These are the most likely regressions in a future refactor.

### Should-fix findings

**Should-fix 1 — DML/DDL rejection: Guard 1 (`read_only_sql_transaction`) exception arm is never exercised**

Arms 6 and 7 confirm that bare INSERT/CREATE TABLE are blocked at parse time with 42601 (before the read-only flag fires). This is a correct observation — the SELECT-wrap is a parse-time blocker. However, the migration's Guard 1 exception arm (`when read_only_sql_transaction → re-raise as 'Custom SQL: only SELECT statements are allowed'`) is now dead code: no currently-possible user input can reach it through the SELECT-wrap.

The dev's comment in the test file accurately describes this; the security guarantee is intact (DML is blocked). But this creates a documentation hazard: the spec's AC says Guard 1 fires with 25006. The migration implements 25006 in an unreachable code path. Future developers reading both will be confused.

**Recommendation**: either (a) add a comment in the migration's `when read_only_sql_transaction` arm explicitly stating it is unreachable given the current wrap strategy, or (b) add a note in the spec's §16 risks section acknowledging the dead-code arm. The dev's test file comments are good but the migration itself does not document the dead arm. This is a maintenance hazard, not a security issue.

**Should-fix 2 — `undefined_table`, `undefined_column`, and `WHEN OTHERS` sanitization branches have zero test coverage**

The sanitization wall has seven branches; only three are exercised (22023, 42601, 42501). The 42P01 (table not found), 42703 (column not found), and catch-all branches are untested. A typo in one of those RAISE messages would ship silently. These are lower-risk (user-facing, not security-affecting) but the spec explicitly pins their messages.

**Recommendation**: Add arms for `SELECT * FROM public.nonexistent_table` (→ 42P01) and `SELECT nonexistent_col FROM public.stores` (→ 42703). The `WHEN OTHERS` path is harder to trigger intentionally; document that gap.

**Should-fix 3 — Plan count in `reports_anon_revoke.test.sql` header comment stale**

The header says "11 RPCs covered" (the body of the bulleted list has 11 entries, matching the 12-plan count since one of the 12 is the fixture sanity arm). Wait — on re-read: `plan(12)`, the fixture sanity arm is arm 1 of the 12, and the body lists 11 RPCs covered (dispatcher + 10 individual functions). The header comment says "12 RPCs covered." Let me recheck...

Actually, re-reading the file: the header says `-- 12 RPCs covered` and lists 11 bullet entries (dispatcher + 10 individual functions = 11 entries). But the plan is 12 because the fixture sanity arm (Frederick store lookup) is arm 1 and the 11 RPC arms are arms 2–12. The header comment counts the fixture as one of the covered "arms" not "RPCs." The comment `12 RPCs covered` is imprecise but not a blocker — the mismatch between the bullet count (11) and the header number (12) could confuse future maintainers. The spec says "12 RPCs covered" was the target, but if you count the RPCs in the bullet list there are only 11 (dispatcher counts as one RPC). This is a nit.

### Nits

**Nit 1 — Fixture sanity arm 2 in `report_run_custom.test.sql`**: The architect's intended arm 2 was "fixture sanity: a non-privileged `'user'`-role member exists for the privilege gate" — specifically to confirm the seed has the `22222222-...` manager row. The implemented arm 2 instead validates the Charles store ID (needed for arm 4). The privilege-gate arm (arm 3) uses the manager JWT inline without a dedicated fixture sanity check. This is a minor deviation from the architect's plan but functionally equivalent since arm 3 itself would fail if the JWT weren't valid.

**Nit 2 — `'Custom SQL requires admin privilege'` error path in `db.ts`**: The `rawMessage.startsWith('Custom SQL')` allowlist in `runReport` (lines ~1926–1932) correctly passes through all seven sanitization-wall messages. However, the allowlist also passes through `'Custom SQL requires admin privilege'` (the privilege gate message) as designed. This is correct per the spec; noting for completeness.

**Nit 3 — Cross-spec `from > to` validation sweep**: The dev brief asks whether custom adds a `from > to` validation test. Answer: N/A. The custom template accepts no date parameters; `from` and `to` are not in its params shape. The 22023 validation it does have (`sql parameter required`) is covered by arm 5. The `from > to` sweep proposed in earlier specs' fast-follow lists applies only to templates with date range params (waste/vendor/velocity/cogs/variance); custom is correctly excluded.

**Nit 4 — `reports_anon_revoke.test.sql` plan comment precision**: The header note "Net: comment goes 8 → 12 across spec-034/035/036/037" is a build-up narrative across four specs. The body comment "12 RPCs covered" plus 11 bullet entries (one of which is a dispatcher) is internally consistent if you count the dispatcher as one of the covered surfaces. Not a blocker.

### Post-merge deploy gate

**This must not be skipped.** The migration `20260515130000_report_run_custom.sql` creates `public.report_run_custom` and re-creates the dispatcher `public.report_run`. Neither function exists in the current linked database until the migration is pushed.

Command: `npx supabase db push --linked --yes`

Until this runs in production, the `custom` template tile (now showing `status: 'live'`, no PREVIEW badge) will call the dispatcher, the dispatcher will fall to the `not_implemented` arm (because `report_run_custom` doesn't exist in the DB yet), and the user will see the "coming soon" stub response. This is a confusing regression from the user's perspective even though the code is correct.

---

## Summary table

| Criterion area | PASS | FAIL | NOT TESTED |
|---|---|---|---|
| Backend migration shape | 7 | 0 | 0 |
| Backend RPC guards (5) | 3 | 2 | 0 |
| Backend error sanitization (7 branches) | 3 | 0 | 4 |
| Backend envelope shape | 4 | 0 | 0 |
| Dispatcher arm | 3 | 0 | 0 |
| Frontend templates.ts | 2 | 0 | 0 |
| Frontend NewReportModal | 4 | 0 | 3 (jest missing) |
| Frontend ReportDetailFrame | 4 | 0 | 0 |
| Frontend ReportsSection | 4 | 0 | 0 |
| pgTAP test quality | 10 | 3 | 0 |
| Jest tests | 0 | 5 | 0 |
| Verification gates | 3 | 0 | 2 (manual) |

**3 Critical findings. Release is BLOCKED pending resolution.**
