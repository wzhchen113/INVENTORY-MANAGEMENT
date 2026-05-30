## Test report for spec 077

### Acceptance criteria status

Spec 077 has no behavioral changes and therefore no new acceptance criteria that require test coverage. The spec itself states "No new tests — these are comment/literal/doc edits with no new behavior to pin." The review task maps instead to four verification checks:

- AC1: `npx jest src/lib/cmdSelectors.unconfirmedPoWindow` — all 9 arms still green after `'fine'`→`'ok'` swap → PASS — `src/lib/cmdSelectors.unconfirmedPoWindow.test.ts` (9/9 arms)
- AC2: Full `npx jest` suite count unchanged at 40 suites / 386 tests → PASS
- AC3: `npx tsc --noEmit -p tsconfig.json` exits 0 → PASS
- AC4: `npx tsc --noEmit -p tsconfig.test.json` exits 0 → PASS
- AC5: "No new tests" call is correct — spec 075 doc patch and test-comment edits have no test surface → CONFIRMED CORRECT (see Notes)
- AC6: Fixture swap does not weaken any existing assertion → CONFIRMED (see Notes)

### Test run

```
npx jest src/lib/cmdSelectors.unconfirmedPoWindow --no-coverage

PASS unit src/lib/cmdSelectors.unconfirmedPoWindow.test.ts
  computeAttentionQueue.unconfirmed_po — Monday-reset window
    ✓ Monday morning at 00:01 local — empty (window contains only today) (8 ms)
    ✓ Wednesday afternoon — only Monday miss included (Tue matched; Wed=today; Thu/Fri future) (1 ms)
    ✓ Tuesday afternoon — only Monday miss; Sunday-and-earlier excluded
    ✓ Sunday night just before midnight — full Mon..Sat past days (Tue matched) (1 ms)
    ✓ Edge case: clock right at Monday 00:00 — previous week items immediately drop
  computeAttentionQueue.unconfirmed_po — in/out of window
    ✓ A missed-order row INSIDE the window is included (1 ms)
    ✓ A missed-order row OUTSIDE the window is excluded — structural invariant
    ✓ "Today" is excluded from the window even though it is in the current week (spec 074 today-exclusion)
  computeAttentionQueue.unconfirmed_po — timezone correctness
    ✓ UTC late-night Monday in NY still treats this week as starting on the NY Monday

Test Suites: 1 passed, 1 total
Tests:       9 passed, 9 total

npx jest --no-coverage (full suite)
Test Suites: 40 passed, 40 total
Tests:       386 passed, 386 total

npx tsc --noEmit -p tsconfig.json      → exit 0
npx tsc --noEmit -p tsconfig.test.json → exit 0
```

Console noise in the full run (`console.warn` in `useStore.test.ts` and `console.error` in `EODCount.test.tsx`) is pre-existing and unrelated to this spec — both suites pass.

### Notes

**Fixture swap safety (`'fine'`→`'ok'`).** The `getItemStatus` stub is declared at module scope and passed into `computeAttentionQueue` via `runQueue`. `inventory` is `[]` throughout every test arm in this file; `getItemStatus` is only called inside `computeAttentionQueue` when iterating `inventory` items. With an empty array it is never invoked. No test arm depended on the stub returning an out-of-union sentinel to exercise an error path — none of the 9 tests assert on `low_out_stock` items at all; they all filter to `unconfirmed_po` via `poItemsOnly`. Replacing `'fine' as ItemStatus` (a force-cast of a non-member) with `'ok'` (a valid union member requiring no cast) has zero behavioral effect and correctly removes the TS unsoundness. The comment at lines 53-56 was also updated to describe the new state accurately.

**"No new tests" verdict.** Agreed with the spec's call. The three changes are:
1. A test-file top-comment rewrite (no assertion changed, no fixture changed).
2. A test-fixture literal swap from `'fine'` to `'ok'` with a cast removal — behavior-preserving as established above.
3. A markdown spec-doc patch aligning `specs/075-missed-order-audit-log-parity.md` cron/backfill code blocks with the shipped migration's `'UTC'` form. The migration itself is untouched. A markdown doc has no test surface.

**Spec 075 UTC patch confirmation.** `specs/075-missed-order-audit-log-parity.md` lines 536-554 and 614-616 now carry the UTC form with an explicit as-shipped note. The shipped migration `20260530000000_record_missed_orders_rpc.sql` was not touched (per the spec's scope section). Consistent with architect's post-impl approval.

**Counts match spec 076 baseline.** 40 suites / 386 tests is unchanged from the spec 076 baseline — no regressions, no accidental new tests.
