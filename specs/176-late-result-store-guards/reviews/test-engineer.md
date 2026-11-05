## Test report for spec 176

Reviewed the uncommitted working tree against HEAD 8acecc4 plus the untracked `src/store/useStore.lateResultGuards.spec176.test.ts`. Nothing was staged or committed.

### Acceptance criteria status
All store-level ACs run against the real Zustand store with `db` and `../lib/auth` stubbed, per the spec. Jest is the only track (no DB change). "New suite" means `src/store/useStore.lateResultGuards.spec176.test.ts`.

- AC-1 (late success dropped) -> PASS. New suite, `AC-1 - late success: B's payload, owner and error stay`. Anti-vacuity: `fetchReorder` asserted called with ('A','D'). Reference identity via `toBe(PB)`.
- AC-2 (late failure dropped) -> PASS. New suite, `AC-2 - late failure...`. Error stays null, payload and owner unchanged, `Toast.show` not called.
- AC-3 (loading reset, no newer request) -> PASS. New suite, `AC-3 ...` via `it.each` (resolves and rejects). Switch to `{ id: '' }`; loading ends false; the other three fields are unchanged.
- AC-4 (loading left alone with a newer request) -> PASS. New suite, `AC-4 - a newer foreground request is in flight...`. Asserts the second fetch call is ('B','D'), loading stays true, then B lands with FB, owner 'B' and loading false.
- AC-5 (not dropped on generation alone) -> PASS. New suite, `AC-5 ...`. The silent refresh is asserted to have gone out (call 2 is ('S','D')), then F lands with loading false and error null.
- AC-6 (current-store control) -> PASS. New suite, `AC-6 - current-store control`. Covers success and failure.
- AC-7 (refused when owner differs) -> PASS. New suite, `AC-7 - owner A, snapshot B...` plus `AC-7 / P2 - a null owner...`. Returns null, no upsert, exactly one toast. The text2 begins "Reorder list belongs to a different store" and is asserted not equal to the "Active store changed" message.
- AC-8 (passes when equal) -> PASS. New suite, `AC-8 - owner equals the snapshot store`. Upsert called once; no toast.
- AC-9 (existing guards keep order and behavior) -> PASS.
  - Missing and `__all__` snapshot stores stay silent even when the owner mismatches (so the backstop would have fired if it ran first): new suite, `AC-9 - a %s snapshot store...` (2 cases).
  - A mid-export switch gives the existing message and exactly one toast, with the owner also mismatching: `AC-9 - a mid-export store switch...`.
  - An undated snapshot with a mismatched owner stays silent: `§4 - an undated snapshot...`.
  - The spec 156 store suite passes (full run).
- AC-10 (stale single-store load writes nothing, no tails) -> PASS. New suite, `AC-10 ...`. `currentUser` is set so notifications would fire. `fetchAll('A')` is asserted called. `LOAD_KEYS` (22 keys: all slices, `menuCapacity`, `lastCounted*`, the five reorder fields) are compared by reference. `fetchMenuCapacity`, `fetchItemsLastCounted`, `fetchReorderSuggestions`, `cleanupOldRecords` and `fetchNotifications` are all not called.
- AC-11 (stale load, fetch fails) -> PASS. New suite, `AC-11 ...`. Only a warn; no writes, tails or toast.
- AC-12 (stale `__all__` load) -> PASS. New suite, `AC-12 ...`. `fetchAll` called for S1 and S2; the slices and `lastCounted*` are unchanged by reference.
- AC-13 (`stores` write and current-store controls) -> PASS. Three tests:
  - Stale load still writes `stores`.
  - Current-store load writes its slices and runs the capacity and last-counted tails once each with 'B', plus notifications.
  - Current-store `__all__` load still writes.
- AC-14 (stale-but-newest load resets overlay) -> PASS. New suite, `AC-14 ...` via `it.each` (success and failure).
- AC-15 (stale load skips reset while a newer load is in flight) -> PASS. New suite, `AC-15 ...`. Ordering is proven by `fetchAll` call 2 being 'B'. A leaves the overlay set; B resets it and its slices are written.
- AC-16 (session-probe bail unchanged) -> PASS. `useStore.sessionLoss.spec152.test.ts` is unmodified in the diff and passes.
- AC-17 (A' logic unchanged, spec 175 tests unmodified) -> PASS.
  - The diff of `useStore.ts` touches only comments in the A' block and the reorder spread, plus the two added `return` drops and the `finally` gate.
  - Spec 175 "stale store-A reload landing after B's foreground load" (~:511) and "stale reload with the payload owned by the current store" (~:540) are not in the diff and pass.
  - Comments are updated as specified.
- AC-18 (spec 175 foreign-owner test rewrite) -> PASS. `useStore.reorderReload.spec175.test.ts`, "a reload for a store that is no longer current writes nothing, even when it owns the payload (spec 176)".
  - Setup is unchanged (`currentStore` B, load 'S').
  - It now asserts `fetchAll('S')` called, `fetchReorder` not called, `reorderPayload` is `P` by identity, and the fields equal the pre-call snapshot.
  - Intent preserved: it still pins the interaction between a foreign owner and a stale load.
  - The foreign-owner clear is still pinned by the spec 175 AC-12 case.
- AC-19 (spec 175 AC-2 same-store rewrite) -> PASS. Only the mid-fetch `setState({ currentStore: B })` line was deleted, with a comment. All assertions are retained: fetch called ('A','D'), payload F, owner 'A', and same-`set` pairing. The cross-store variant moved to AC-1 of this suite.
- AC-20 (non-current-store load tests seed `currentStore`) -> PASS.
  - spec160: five sites seeded (`store-1`; `store-1` for L205; `__all__`; `store-1`; `store-1` then `store-2`).
  - spec151: `store-2` seeded.
  - spec175 AC-15: `__all__` seeded.
  - Assertions are otherwise unchanged. In these tests, being current makes the branch really run, so the clear assertions are no longer vacuous.
  - Grep sweep of `loadFromSupabase(` in `*.test.ts(x)`: the remaining sites are spec 175 (`seedSameStore` or explicit stores, or the intentionally-stale 'A' cases), spec 152 (seeds `s1`), and the PhoneOrdering spec 175 tests (seed `store-1`). No missed site; full jest is green.
- AC-21 (spec 156 store suite) -> PASS. The diff is exactly one added line, `reorderStoreId: 'store-1'`, in the top-level `beforeEach`. No assertion changed.
- AC-22 (unmodified suites) -> PASS. None of the following are in the diff, and all pass in the full run:
  - `useStore.switching.test.ts`
  - `useStore.sessionLoss.spec152.test.ts`
  - `useStore.lastOrderContextGuard.spec175.test.ts`
  - `PhoneOrdering.reorderReload.spec175.test.tsx`
  - `PhoneOrdering.recordExport.spec156.test.tsx`
  - `ReorderSection.recordExport.spec156.test.tsx`
  - the other `ReorderSection.*`, `PhoneOrdering.*` and `PhoneApproveOrder.*` tests
- AC-23 (scope fences) -> PASS. `git diff HEAD --stat` on `src/screens`, `src/components`, `src/lib`, `supabase` and `app.json` is empty. `src/types/index.ts` has doc comments only. The `StoreActions` signature is unchanged.
- AC-24 (full gates) -> PASS. See Test run.
- AC-25 (browser store-switch check) -> PENDING MAIN VERIFICATION. Being done by main Claude with preview tools; not missing, not counted as NOT TESTED.
- Architect-added D-T1 (out-of-order probes) -> PASS. New suite, `D-T1 ...`. It pins the bump-after-probe placement.
- Architect-added D-T2 (silent-only newer requests cannot strand `reorderLoading`) -> PASS. New suite, `D-T2 ...`. It fails under the literal `reorderRequestGen` gate (developer reported verifying this by temporary mutation; I did not re-run the mutation).

### Test run
- `npx jest` (full, both projects): Test Suites 266 passed / 266; Tests 3334 passed / 3334; Snapshots 17 passed. 0 failures.
- `npx jest` on the new suite plus `useStore.sessionLoss.spec152` and `useStore.switching`: 3 suites, 54 tests, all passed.
- `npm run typecheck`: exit 0.
- `npm run typecheck:test`: exit 0. This is the gate jest misses.
- Test count: the new suite has 25 tests (the developer's count). The full-run total of 3334 matches the developer's reported figure.

### Notes
- **Edited committed tests.** All five edited files keep the original intent. The only changes are the minimal seeding or setup edits the spec requires. No assertion was weakened, and the AC-18 rewrite was strengthened with identity checks.
- **D-2 deviation from the literal R-1 wording.** The design gates the dropped-result `reorderLoading` reset on a newest-foreground marker rather than `reorderRequestGen`. The architect showed the literal rule can strand `reorderLoading: true`, and D-T2 pins the fix. The design asked main Claude to relay this to the owner. I could not confirm that happened, so the owner sign-off should be checked.
- **Accepted residual.** An older load that settles while a newer load is still inside its session probe can clear the overlay early. This is narrower than before and is documented in the code and by D-T1.
- **Coverage gaps (not blocking).**
  - Native testing is not applicable (shared store logic).
  - The `po_items` cross-store gap stays open server-side by design (the spec's out-of-scope follow-up).
  - No pgTAP or shell smoke is needed (no DB change).
- **Pre-release checks.** AC-25 needs a pass from main Claude. After pushing, `test.yml`, `db-migrations-applied.yml` and (by hand) `e2e.yml` need a check per CLAUDE.md.
- **Verdict.** All ACs except AC-25 are PASS. 0 FAIL and 0 NOT TESTED. No Criticals from the test side. AC-25 remains an open gate for the release-coordinator.
