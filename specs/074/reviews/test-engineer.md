## Test report for spec 074

### Acceptance criteria status

- AC1: `computeAttentionQueue` accepts `timezone: string` (required, before `now`) and uses `getWeekWindow(timezone, now)` to derive `weekStartISO` = most recent Monday 00:00 in the store's configured timezone. On a Monday, `weekStartISO === todayISO`; on a Sunday, `weekStartISO === todayISO - 6`. → PASS — `src/utils/weekWindow.test.ts::getWeekWindow / America/New_York on a Monday — week is fresh` (both ISOs are `2026-05-25`); `src/utils/weekWindow.test.ts::getWeekWindow / America/New_York on a Sunday` (`[0]='2026-05-25'`, `[6]='2026-05-31'`, length 7). Implementation at `src/lib/cmdSelectors.ts:749` places `timezone` before `now`; TypeScript CI gate enforces the positional contract.

- AC2: The `unconfirmed_po` loop no longer uses `lookback = 4..7`. Instead it iterates each ISO date from `weekStartISO` through `todayISO - 1` (yesterday inclusive) in the store's timezone, emitting one row per (vendor, date) miss. Today is excluded. → PASS — `grep -n "lookback"` finds only a comment (line 969), not a loop. Implementation at `cmdSelectors.ts:877-906` uses `isoDateRange(mondayStart, nextMondayStart).filter(iso => iso < todayISOInTz)`. `src/lib/cmdSelectors.unconfirmedPoWindow.test.ts::Wednesday afternoon — only Monday miss included` confirms 1 row not 3+ rows (Thu/Fri are future, excluded by filter). `src/lib/cmdSelectors.unconfirmedPoWindow.test.ts::"Today" is excluded from the window even though it is in the current week` directly pins the `< todayISOInTz` filter — this test would fail if the filter were removed.

- AC3: On a Monday morning, `unconfirmed_po` loop emits ZERO rows (range is empty). Verified with deterministic `now`. → PASS — `src/lib/cmdSelectors.unconfirmedPoWindow.test.ts::Monday morning at 00:01 local — empty (window contains only today)` (`now = 2026-05-25T04:01:00Z` = 00:01 EDT Monday → 0 rows). Also covered by `src/lib/cmdSelectors.unconfirmedPoWindow.test.ts::Edge case: clock right at Monday 00:00` which verifies the Sunday→Monday flip (lateSunday has rows; Monday has 0).

- AC4: No other attention rule's window changes (`eod_missing` still uses today/yesterday tz-naive; `low_out_stock` uses live status; `food_cost_streak` uses trailing-7d variance; `expiry` is still forward-looking). → PASS — `cmdSelectors.ts` lines 753-784 (`eod_missing`) and 814-848 (`food_cost_streak`) still use `todayISO = now.toISOString().slice(0,10)`, unchanged. `low_out_stock` (lines 789-812) and `expiry` (lines 908+) are structurally unchanged. The test file's `supabase` mock + isolated `poItemsOnly()` filter ensures the selector is exercised as a whole but only `unconfirmed_po` rows are asserted — the other rules run but are not deliberately broken by any change. Verified by code inspection.

- AC5: DashboardSection per-store column visual format does not change. Only the contents of `queue` shorten on dates past Monday. → PASS (by construction). `DashboardSection.tsx` adds only `const timezone = useStore(s => s.timezone)` and passes it as the new positional argument to `computeAttentionQueue`, plus adds `timezone` to the `useMemo` dependency array (line 298). No layout, styling, or rendering logic was modified. No dedicated jest test is warranted for a one-argument pass-through change in a complex React component; visual non-regression is guaranteed by the unchanged JSX structure.

- AC6: Unit test — `computeAttentionQueue` with `now = 2026-05-27T10:00 EDT` (Wednesday), vendor scheduled Mon/Tue/Wed/Thu/Fri, only Tue has a submission → ONE `unconfirmed_po` row for the Monday miss. → PASS — `src/lib/cmdSelectors.unconfirmedPoWindow.test.ts::Wednesday afternoon — only Monday miss included (Tue matched; Wed=today; Thu/Fri future)` (`now = 2026-05-27T14:00:00Z` = 10:00 EDT Wednesday, returns 1 row with id `store-1:po:vendor-v:2026-05-25`). The UTC timestamp correctly represents 10:00 AM EDT.

- AC7: Unit test — same fixture with `now = 2026-05-25T10:00 EDT` (Monday) → ZERO `unconfirmed_po` rows. → PASS — `src/lib/cmdSelectors.unconfirmedPoWindow.test.ts::Monday morning at 00:01 local — empty` covers the Monday case. The spec cited `10:00` Monday; the test uses `00:01` Monday — a stricter window test (less time has passed). Both share the same semantic: Monday means empty window.

- AC8: Unit test — same fixture with `now = 2026-05-31T23:00 EDT` (Sunday) → 4 rows (Mon/Wed/Thu/Fri; Tue had a match). → PASS — `src/lib/cmdSelectors.unconfirmedPoWindow.test.ts::Sunday night just before midnight — full Mon..Sat past days (Tue matched)` (`now = 2026-06-01T03:59:00Z` = 23:59 EDT Sunday, 4 rows for Mon/Wed/Thu/Fri). The spec stated `23:00`; the test uses `23:59` — same semantic, slightly stricter boundary.

- AC9: Timezone is honored: `now = 2026-05-26T03:00:00Z` with `timezone = 'America/New_York'` (23:00 local Monday) MUST treat `weekStartISO` as `2026-05-25`, NOT roll the week forward. → PASS — `src/utils/weekWindow.test.ts::America/New_York at UTC-late-night boundary (still Monday local)` asserts `isos[0] = '2026-05-25'`, `isos[6] = '2026-05-31'`, and `getLocalDateISO(...)` = `'2026-05-25'`. Also covered at the selector level by `src/lib/cmdSelectors.unconfirmedPoWindow.test.ts::UTC late-night Monday in NY still treats this week as starting on the NY Monday` (returns 0 rows, confirming weekStart=today).

---

### Test run

```
npx jest --no-coverage

Test Suites: 39 passed, 39 total
Tests:       378 passed, 378 total   (was 376 before spec 074 tests; +2 added by this reviewer)
Snapshots:   0 total
Time:        2.002 s
Ran all test suites in 2 projects.

npx tsc --noEmit -p tsconfig.json       → exit 0 (clean)
npx tsc --noEmit -p tsconfig.test.json  → exit 0 (clean)
```

Pre-review: 376 tests / 39 suites (implementer's reported count confirmed).
Post-review: 378 tests / 39 suites (2 tests added by this reviewer, both in existing files).

---

### Notes

**Tests added by this reviewer (both minimal, load-bearing):**

1. **Fall-back DST symmetry pin** — `src/utils/weekWindow.test.ts::America/New_York fall-back week`. US DST ends 2026-11-01. Verifies the week containing the fall-back transition (Mon 2026-10-26 EDT through Sun 2026-11-01 EST) enumerates all 7 days correctly, both before and after the transition. The spring-forward test (already present) covers the same structural code path, but a future developer who special-cases one DST direction would be caught by having both directions pinned. Net: ~20 lines added, symmetric with the existing spring-forward test.

2. **Today-exclusion discriminating test** — `src/lib/cmdSelectors.unconfirmedPoWindow.test.ts::"Today" is excluded from the window even though it is in the current week (spec 074 today-exclusion)`. The pre-existing "out-of-window" test (lines 158-163) was flagged by the code reviewer as vacuously true: `2026-05-20` (prior week Wednesday) could never appear in the output regardless of whether the `< todayISOInTz` filter exists, because `isoDateRange(mondayStart, nextMondayStart)` only enumerates the current week by construction. The new test asserts that `2026-05-27` (today, Wednesday, in the current week, with no submission) does NOT appear — this assertion would FAIL if the `< todayISOInTz` filter were removed from `cmdSelectors.ts:880`. It is the discriminating counterpart the "out-of-window" AC requires.

**Should-fix from code reviewer, noted for release-coordinator:**

The code reviewer flagged a `getWeekWindow` signature deviation: the architect's Decision 4 specified `now: Date = new Date()` as optional (with wall-clock default for non-test callers), but the implementer shipped it as required with no default. The production call site in `DashboardSection.tsx` always passes `now` implicitly (no `now` argument, relying on the selector's own `now: Date = new Date()` default), so there is no runtime breakage. However the deviation is from the signed-off spec. This is a Should-fix, not a blocking Critical — documented here for the release-coordinator.

The code reviewer also noted the "Monday on a Monday" test only asserts `[0]` not the full 7-element array. The Sunday and Wednesday tests assert the full array. This is a Nit, not blocking.

**isoDateRange interface: spec draft vs. implementation.** The architect's `### Helper signature` block specified `isoDateRange(startISO: string, endISO: string)` with string args. The implementation uses `(start: Date, end: Date)`. The tests correctly match the implementation (Date objects throughout). TypeScript CI confirmed the signature is internally consistent. The deviation is from the illustrative spec draft, not from a functional requirement — the helper's behavior is identical, only the argument representation differs. Noted as a Nit.

**No new test framework introduced.** All 2 added tests land in the existing jest track under the same files as the implementer's tests. No new file created.

**pgTAP / smoke tracks: N/A.** This spec is pure client-side selector logic — no migrations, no RPC, no edge functions, no realtime. The architect explicitly scoped to jest only.
