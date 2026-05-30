## Code review for spec 076

### Critical

None.

### Should-fix

- `src/lib/cmdSelectors.eodAndStreak.test.ts:295-321` — Test 5 ("cross-rule structural anchor agreement") includes an `unconfirmed_po` assertion (`expect(po).toHaveLength(0)`) that is vacuous with the test fixture. The module-level `orderSchedule` is `{}` (empty — see line 61), so zero `unconfirmed_po` rows will fire regardless of whether the tz window has past days. The test comment claims "today is the first day of the work-week — the window contains only today" as the reason for zero rows, but the actual reason is the empty schedule. A reader relying on this assertion to verify that `unconfirmed_po` tz behavior was preserved gets false assurance. Suggested fix: either (a) add a non-empty `orderSchedule` to this test's `runQueue` call so the assertion is actually driven by the tz window being empty, or (b) drop the `unconfirmed_po` assertion from Test 5 entirely and note that unconfirmed_po tz coverage lives in the spec 074 sibling file. Option (b) is simpler and matches the existing separation of concerns.

### Nits

- `src/lib/cmdSelectors.unconfirmedPoWindow.test.ts:5-6` — The top-comment reference "(see inline comment in cmdSelectors.ts above the unconfirmed_po block)" now points to the spec 076 ratification note ("All three rules … derive their ISO date anchors via `getLocalDateISO` — ratified by spec 076"), not the pre-spec-074 inconsistency warning the comment was originally pointing to. The file is intentionally byte-untouched per AC #9, so this is a deferred cleanup rather than a spec 076 fix. A follow-up 1-line edit (remove or update the cross-reference) would prevent a future reader from following the pointer and finding the opposite of what the test-file comment claims.

- `src/lib/cmdSelectors.eodAndStreak.test.ts:54-56` — New test's `getItemStatus` correctly returns `'ok'` (a valid `ItemStatus = 'ok' | 'low' | 'out'` member). The spec 074 sibling file at `cmdSelectors.unconfirmedPoWindow.test.ts:53` uses `() => 'fine' as ItemStatus` — `'fine'` is not in the union and is suppressed with `as`. This is a pre-existing issue not introduced by spec 076, but the inconsistency between the two sibling files is now visible. Recommend a follow-up 1-line fix to the spec 074 file to align on `'ok'`.

## Resolution (post-review FE fix-pass — main Claude)

- **Should-fix (vacuous unconfirmed_po assertion in Test 5)**: **fixed.** Dropped the `expect(po).toHaveLength(0)` assertion per the reviewer's option (b) — matches the existing separation of concerns (spec 074's sibling file covers `unconfirmed_po` tz with a non-empty `orderSchedule` fixture; this file owns `eod_missing` + `food_cost_streak`). Test 5's eod_missing anchor assertion stays load-bearing on its own. Added a scope note to the test's leading comment explaining why the `unconfirmed_po` assertion was removed so a future reader doesn't re-add it.
- **Nit #1 (spec-074 file's stale cross-reference comment)**: **left as-is.** AC #9 says `cmdSelectors.unconfirmedPoWindow.test.ts` stays byte-untouched. The reviewer correctly classified this as a deferred 1-line cleanup; surfaces here as a follow-up candidate (would also pair naturally with Nit #2).
- **Nit #2 (`'fine'` vs `'ok'` ItemStatus inconsistency between sibling files)**: **left as-is** for the same AC #9 reason. The pre-existing spec-074 issue is now visible because spec 076 stays type-correct (`'ok'`); a future doc-pair cleanup can align both files.

Re-verified post-fix: `npx jest src/lib/cmdSelectors.eodAndStreak` → 6 tests pass. `npx tsc --noEmit -p tsconfig.json` → exit 0. The spec-076 file count and shape are unchanged from the implementer's report (40 suites / 386 tests across the full project).
