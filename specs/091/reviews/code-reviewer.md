# Code review for spec 091

## Critical

None.

## Should-fix

- `src/utils/reorderExport.test.ts:177-193` — The `FakeDate` in the first `todayLocalIso` test case explicitly declares `constructor() { super(); }`. The `super()` call invokes `new RealDate()` with no arguments, capturing the real wall-clock time — but the method overrides (`getFullYear`, `getMonth`, `getDate`, `toISOString`) mean the captured wall-clock value is never read. This works today, but it silently depends on `new RealDate()` not throwing. The second test at line 204 omits the constructor entirely, which is the cleaner pattern (the parent constructor is used implicitly). Minor inconsistency across two `FakeDate` classes in the same `describe`. Not a bug, but the explicit no-op constructor in the first case is misleading about whether the real date matters. Prefer omitting the constructor to match the second case or add a comment explaining the no-op.

- `src/screens/staff/screens/Reorder.test.tsx:331-348` (B4) — The test presses `prev-month` once and then `day-1`, relying on the fact that day 1 of the previous calendar month will always be less than the `firstAsOf` (today). This is true in all practical cases, but the assertion `secondAsOf < firstAsOf` has an implicit assumption that today is never month-day-1 (if today were 2026-06-01, then `prevMonth` takes the view to May, and day-1 of May = `2026-05-01` which is still less than `2026-06-01`; so this actually holds universally). More importantly, the test clicks `staff-reorder-datepicker-day-1` without first verifying that day-1 is not disabled (i.e., not `> maxDate`). A day-1 cell in the previous month is always before today, so `isFuture` is always false and the cell is always enabled — this is fine. No actual bug. Flagging for transparency: the test has no comment explaining why day-1 of the previous month is safe to use as the "guaranteed past date." A one-line note would make the intent clear to future readers.

## Nits

- `src/utils/reorderExport.test.ts:165` — The `afterEach` at line 167 restores `global.Date = RealDate` but there is no corresponding `beforeEach`. If a prior test in the same file somehow corrupts `global.Date`, the `afterEach` will restore the already-corrupted value. The pattern is correct for within-describe cleanup, but the `RealDate` capture at line 166 happens at `describe` parse time, before any test runs — which is actually the right time to capture it. No real risk here, but a `beforeEach(() => { global.Date = RealDate; })` alongside the `afterEach` would be belt-and-suspenders.

- `src/screens/cmd/sections/ReorderSection.tsx:227-235` — D1 comment is clear and well-placed. Minor: the comment says "a per-vendor qty total spans items with DIFFERENT units (each / gal / lbs / bags / cases)" but `cases` is not a unit in the system — items have units like `each` and a separate `caseQty`. The examples parenthetical is cosmetic but listing `cases` as a unit example is slightly imprecise. Does not affect the reader's understanding of the intent.

- `src/components/cmd/ReorderDatePicker.tsx:37-44` — A4 comment is present and explains the trade-off. The final sentence "See spec 091 for the (a)-vs-(b) trade-off" is a spec reference that will be stale once this is merged into `main` without a link to the spec file. Consider replacing with a content summary rather than a spec pointer, since the rationale is already fully stated in the preceding two sentences.

- `src/utils/reorderDayFilter.ts:84-86` — A3 guard is cleaner than the original `getDay()` form. The comment at line 84 says "both return null for e.g. 'not-a-date' or '2026-13-40'" — technically `'not-a-date'` produces an invalid Date differently (the string is not parseable), while `'2026-13-40T00:00:00'` is also invalid (month 13). Both produce `NaN` from `getTime()`. The comment is accurate; just noting that the two examples are both in the same failure mode.

---

## Summary

This is a clean cleanup batch. No Criticals. The production-code changes (A1, A2, A3, D1) are all correct and scoped to their stated intentions. A1's local-components approach matches the `todayIso()` function already in the staff screen and `toISODate()` in the admin surface. A2's per-render recompute correctly mirrors the admin pattern. A3's `Number.isNaN(d.getTime())` idiom is semantically equivalent and clearer. D1 is comment-plus-label-only with no math change confirmed. The test additions (B1–B5, A1/A3) are non-vacuous: B3 exercises the null-store early-return; B4 exercises the `useEffect` date-change path; B5 holds the fetch pending and asserts the loading testID; A1's fake `Date` would catch a regression to the old UTC form; A3's `'2026-13-40'` assertion directly covers the new guard. C1 is comment-only; `plan(12)` matches the 12 assertion calls (1 `isnt` + 11 `is/ok`). C2 narrows `any` to the real data shape without widening the test coverage. The two Should-fix items are minor test hygiene (a misleading no-op constructor and a missing comment on why day-1 is a safe test fixture), not correctness issues. All findings are within the changed files.

---

## Resolution (post-review fix-pass — main Claude)

Both Should-fixes folded in; the 4 Nits deferred (cosmetic comment wording). PLUS the test-engineer's A2 coverage gap closed (see test-engineer.md).

- **S1 (misleading no-op `FakeDate` constructor, `reorderExport.test.ts`)** — **fixed.** Removed the explicit `constructor() { super(); }` (matches the cleaner second `FakeDate`) + added a one-line note that the parent constructor is implicit and the overrides are what the assertion reads.
- **S2 (missing "why day-1 is a safe past-date fixture" comment, `Reorder.test.tsx` B4)** — **fixed.** Added a note: day-1-of-the-previous-month is always strictly before today → never `> maxDate` → never future-disabled → always pressable.
- **A2 coverage gap (raised by test-engineer)** — **closed.** Added a per-render `maxDate` test in `Reorder.test.tsx` (`jest.setSystemTime` + re-render + `UNSAFE_getByType(ReorderDatePicker).props.maxDate`): asserts maxDate = Jun 2 at mount, then advances the clock to Jun 3, re-renders, and asserts maxDate = Jun 3 — which the old `useMemo(() => todayIso(), [])` would FAIL (it'd stay Jun 2). Non-vacuous. (`setSystemTime` controls `new Date()` without breaking the component's own date parsing — unlike a global `Date` swap.)
- **Nits (4)** — deferred (cosmetic): the `cases`-as-unit-example wording in the D1 comment, the A4 spec-reference staleness, the A3 comment's two same-mode examples, and the `beforeEach` belt-and-suspenders.

Re-verified post-fix-pass: full `npx jest` **564/564** (was 563, +1 A2 test); base + test-graph typechecks exit 0; pgTAP `report_reorder_list_cases` stays 12/12 (untouched).
