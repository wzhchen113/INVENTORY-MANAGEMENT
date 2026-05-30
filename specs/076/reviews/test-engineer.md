## Test report for spec 076

### Acceptance criteria status

- AC1: `computeAttentionQueue` derives `todayISO` and `yesterdayISO` for `eod_missing` using `getLocalDateISO(timezone, now)` and a whole-day-ms back-step — NOT `now.toISOString().slice(0,10)` → PASS — `src/lib/cmdSelectors.eodAndStreak.test.ts::canonical regression: at Mon 23:00 ET (Tue 03:00 UTC), todayISO resolves to NY Monday` (Test 2)

- AC2: `computeAttentionQueue` derives `startSevenISO`/`endISO` for `food_cost_streak` using `getLocalDateISO(timezone, now)` for end anchor and a six-day-ms back-step for start anchor → PASS — `src/lib/cmdSelectors.eodAndStreak.test.ts::7d window ends on NY "today" at the UTC-skew instant` (Test 4)

- AC3: `computeStoreFoodCostVariancePp` is NOT modified; fix is at call site only → PASS — confirmed via `git diff main -- src/lib/cmdSelectors.ts`; only the three call-site lines (`startSevenISO` derivation and `todayISO` derivation) changed; the helper function body is untouched. The call site passes `startSevenISO` and `todayISO` (both now tz-correct) as before.

- AC4: `isPastDeadline(now, store?.eodDeadlineTime)` continues to receive the raw `now: Date`, not a tz-shifted Date → PASS — `src/lib/cmdSelectors.eodAndStreak.test.ts::receives the raw \`now: Date\`, not a tz-shifted Date` (Test 6). Implementation at line 773 passes `now` directly; diff confirms no change to the call site argument.

- AC5: DST-safe — back-step uses whole-day-ms subtraction from UTC instant, NOT `setDate()` on a Date object → PASS — implementation confirmed: `new Date(now.getTime() - 24 * 60 * 60 * 1000)` and `new Date(now.getTime() - 6 * 24 * 60 * 60 * 1000)`. Pre-fix code used `setDate(getDate() - 1)` and `setDate(getDate() - 6)` (UTC-process-tz-anchored). Diff confirms the replacement.

- AC6: All three rules in `computeAttentionQueue` derive consistently from local-tz at the same instant → PASS — `src/lib/cmdSelectors.eodAndStreak.test.ts::canonical instant: eod_missing, food_cost_streak, unconfirmed_po all derive Monday-ET anchors` (Test 5). Comment at lines 866-871 ratifies the invariant in code.

- AC7 (jest test — agreement-day baseline): `eod_missing` at `2026-05-26T04:00:00Z` with `timezone = 'America/New_York'` → `todayISO = '2026-05-26'`, `yesterdayISO = '2026-05-25'` → PASS — `src/lib/cmdSelectors.eodAndStreak.test.ts::agreement-day baseline: UTC and NY agree at 04:00 UTC on Tuesday` (Test 1)

- AC8 (jest test — cross-boundary regression): `eod_missing` at `2026-05-26T03:00:00Z` with `timezone = 'America/New_York'` → `todayISO` MUST be `'2026-05-25'`, `yesterdayISO` MUST be `'2026-05-24'` → PASS — `src/lib/cmdSelectors.eodAndStreak.test.ts::canonical regression: at Mon 23:00 ET (Tue 03:00 UTC), todayISO resolves to NY Monday` (Test 2)

- AC (jest test — food_cost_streak 7d window): at `2026-05-26T03:00:00Z`, window MUST be `[2026-05-19, 2026-05-25]` → PASS — `src/lib/cmdSelectors.eodAndStreak.test.ts::7d window ends on NY "today" at the UTC-skew instant` (Test 4). Streak fixture produces 5 days with `id = 'store-1:fc_streak:5'`, `sev = 'high'`.

- AC (jest test — cross-day-boundary streak regression guard): streak at `2026-05-26T03:00:00Z` with variance pp >= 1 for days `[2026-05-21..2026-05-25]` MUST be 5, `sev = 'high'` → PASS — same Test 4 (combined test covers both the window and the streak-count assertions).

- AC9: `cmdSelectors.unconfirmedPoWindow.test.ts` byte-untouched → PASS — `git diff main -- src/lib/cmdSelectors.unconfirmedPoWindow.test.ts` returns 0 lines. All 9 tests in that file pass.

- AC (tsc passes — no signature changes): `npx tsc --noEmit -p tsconfig.json` → PASS — exit 0.

- AC (tsc test passes): `npx tsc --noEmit -p tsconfig.test.json` → PASS — exit 0.

- AC (comment replacement at ~lines 864-873): "pre-existing inconsistency" / "DO NOT fix drive-by" block replaced with 4-line ratification note → PASS — confirmed in diff; lines 866-871 now read "All three rules in this function ... derive their ISO date anchors via getLocalDateISO(timezone, now) — ratified by spec 076."

- AC (no change to rule SHAPES): `eod_missing` remains same-day boolean with yesterday-fallback; `food_cost_streak` remains rolling-7d streak metric; spec 074 Monday-reset NOT applied → PASS — rule shapes confirmed unchanged in diff and passing tests.

### Load-bearing analysis

All six tests are load-bearing against pre-fix code:

**Test 1 (agreement-day baseline)** — intentionally NOT load-bearing; it is the control case. Both pre-fix and post-fix produce `todayISO = '2026-05-26'` at `04:00 UTC` (UTC and NY agree). The test acts as a sanity floor; a future regression that breaks the post-fix derivation entirely would fail here.

**Test 2 (canonical regression)** — load-bearing on two assertions. Pre-fix: `todayISO = '2026-05-26'`, fixture has no sub for `'2026-05-26'` and no sub for `'2026-05-25'` → emits `id = 'store-1:eod:2026-05-26'`, `sev = 'low'` ("2 days running"). Test asserts `id = 'store-1:eod:2026-05-25'` and `sev = 'med'`. Pre-fix fails both.

**Test 3 ("2 days running")** — load-bearing. Pre-fix: no subs → emits `id = 'store-1:eod:2026-05-26'`. Test asserts `id = 'store-1:eod:2026-05-25'`. Pre-fix fails.

**Test 4 (food_cost_streak window)** — load-bearing. Pre-fix: `startSevenISO = '2026-05-20'`, `todayISO = '2026-05-26'`. Window is `[5/20, 5/26]` (7 entries). `variancePp[6]` (for `5/26`) = 0 (no EOD sub or POS import for `5/26` in fixture) → streak breaks at index 6 immediately → streak = 0, no item emitted. Test asserts `streak === 5, sev = 'high'`. Pre-fix emits no item, test fails on `toBeDefined()`.

**Test 5 (cross-rule anchor agreement)** — load-bearing on `eod_missing` id assertion. Pre-fix: `eod.id = 'store-1:eod:2026-05-26'`, test asserts `'store-1:eod:2026-05-25'`. Pre-fix fails.

**Test 6 (isPastDeadline invariant)** — load-bearing in two ways. (1) Pre-fix `todayISO = '2026-05-26'` → `id = 'store-1:eod:2026-05-26'`; test asserts `'store-1:eod:2026-05-25'`. (2) The `'02:00'` deadline discriminates in CI (process tz UTC): raw `now` has `getHours() === 3` in UTC, so `setHours(2)` produces a deadline 1 hour earlier → past → `sev = 'high'`. If a future refactor passed a tz-shifted Date (`new Date(getLocalDateISO(tz, now))` = `2026-05-25T00:00:00Z`), `getHours() === 0` < `02:00` → not past → `sev = 'med'`. Test would fail on `sev = 'high'`. The `'02:00'` value (vs the architect's suggested `'22:00'`) is the correct CI-safe choice: `'22:00'` would be a no-op in UTC process tz because `03:00 > 22:00` is false in the same-day comparison window.

### Test run

```
npx jest --no-coverage
Test Suites: 40 passed, 40 total
Tests:       386 passed, 386 total
Snapshots:   0 total
Time:        2.137 s
```

```
npx tsc --noEmit -p tsconfig.json       exit 0
npx tsc --noEmit -p tsconfig.test.json  exit 0
```

6 new tests in `src/lib/cmdSelectors.eodAndStreak.test.ts` (was 380 pre-spec, now 386). The claimed "40 suites / 386 tests" count is verified correct.

### Notes

**DST coverage**: The canonical test instant (May) is not a DST boundary. DST spring-forward and fall-back are covered at the `getLocalDateISO` helper level in `src/utils/weekWindow.test.ts` (lines 75-115), which the selector-level tests rely on. No additional DST boundary test is needed at the selector level — the DST safety is a property of the helper, not the selector.

**Asia/Tokyo coverage**: `getLocalDateISO` is exercised with `Asia/Tokyo` in `weekWindow.test.ts` (line 44). The spec is scoped to `America/New_York` for the selector tests; `+9` timezone coverage at the helper level is sufficient. No gap.

**Test 1 vacuousness**: The agreement-day baseline (Test 1) is intentionally not load-bearing against pre-fix code (both pre-fix and post-fix agree at `04:00 UTC`). This is by design — it is a control case, not a regression pin. The spec's "Files changed" section explicitly documents this. The remaining 5 tests carry the load-bearing work.

**No cheap gaps found**: After reviewing all six tests, the DST helper coverage, and the `+9` tz coverage in sibling tests, no uncovered load-bearing path was found. No additional tests added.
