## Test report for spec 175

### Acceptance criteria status
Store suite = `src/store/useStore.reorderReload.spec175.test.ts` (18 tests). Phone suite = `src/screens/cmd/sections/phone/__tests__/PhoneOrdering.reorderReload.spec175.test.tsx` (2 tests).

- AC-1 (`reorderStoreId` field; null in initial state, SIGNED_OUT_DATA_RESET, after logout) → PASS — store suite `AC-1 — reorderStoreId field > is null in the initial state and after logout()`. Typed in `src/types/index.ts`. Mutation "omit from SIGNED_OUT_DATA_RESET" is killed.
- AC-2 (foreground success writes owner in the same set, value captured at call start; failure leaves owner and payload unchanged) → PASS — `AC-2 — ... writes the store captured at call start, in the same set as the payload` and `... on failure leaves reorderStoreId and reorderPayload unchanged ...`. Both owner mutations (omit write; use currentStore at completion) are killed. The "every other payload-nulling write also nulls the owner" clause is covered by AC-1 (reset) and AC-12 (store-switch clear) tests.
- AC-3 (payload never null, `lastOrderContext` same ref in every state) → PASS — `AC-3 / AC-5 — payload never null, loading never true, context kept by reference` (subscribe recorder).
- AC-4 (exactly one `fetchReorderSuggestions('S','D')`; `loadFromSupabase` not blocked on it) → PASS — `AC-4 — exactly one silent fetch, and loadFromSupabase does not await it` (never-resolving fetch).
- AC-5 (never `reorderLoading === true`) → PASS — same recorder test as AC-3. The mutation "silent refresh sets loading" is killed.
- AC-6 (success: fresh payload, error null, owner 'S'; prior error kept until success) → PASS — `AC-6 — success replaces the payload and clears a pre-existing error only when it lands`.
- AC-7 (failure: payload ref kept, error and owner unchanged, console.warn, no toast, no unhandled rejection) → PASS — `AC-7 — failure keeps the payload, warns only, no toast, no unhandled rejection`. The "no unhandled rejection" check relies on jest's own fail-on-unhandled-rejection, not an explicit assertion. The dev's reasoning in the spec notes is sound. Mutations "toast on failure" and "set reorderError on failure" are killed.
- AC-8 (store changed: dropped) → PASS — `AC-8 — store changed before it settles: dropped`. Mutation killed.
- AC-9 (foreground load in flight: dropped, foreground lands) → PASS — `AC-9 — foreground load in flight (started BEFORE the silent one)`. The silent fetch is issued after the foreground one, so the generation check cannot be what drops it. Only the loading rule can. Mutation "remove loading check" is killed, and so is "keep branch resets reorderLoading".
- AC-10 (foreground started after and already finished: dropped) → PASS — `AC-10 — foreground load started AFTER and already finished: dropped`. Mutations "remove gen check" and "remove gen bump in foreground load" are both killed.
- AC-11 (payload null or date changed: dropped) → PASS — `AC-11a` and `AC-11b`. Each of the two guard halves is killed independently.
- AC-12 (store switch writes the four spec 021/151 values plus `reorderStoreId: null`; both the owned-elsewhere and null-owner setups) → PASS — the two `AC-12 / AC-13` tests. Mutations "clear branch omits owner null" and "keep predicate ignores owner" are killed.
- AC-13 (store switch: zero `fetchReorderSuggestions` calls from `loadFromSupabase`) → PASS — same two tests.
- AC-14 (nothing loaded: zero fetches, payload stays null) → PASS — `AC-14 — nothing loaded`.
- AC-15 (`__all__`: five fields unchanged by value and ref; zero fetches; branch code unchanged) → PASS — `AC-15 — __all__ leaves all five reorder fields untouched and fetches nothing`. The diff has no hunk in the `__all__` branch, so the "code unchanged" clause holds.
- AC-16 (`reorderEdits` not reset; `recordExportedOrder` does not call `loadReorderSuggestions`; capacity and last-counted tails unchanged) → PASS — `AC-16 — untouched neighbours` (reorderEdits same ref, `fetchMenuCapacity` and `fetchItemsLastCounted` each called once with 'S'). The second clause is pinned by the existing, unmodified `useStore.recordExportedOrder.spec156.test.ts` (passes).
- AC-17 (ReorderSection.tsx and PhoneOrdering.tsx comment-only; PhoneApproveOrder.tsx untouched; export snapshot unchanged) → PASS (by diff inspection, not a test). `git diff` of both section files shows only `//` comment hunks. PhoneApproveOrder.tsx is not in `git diff --name-only`. There is no automated test for this AC, which fits the spec.
- AC-18 (stale comments corrected) → PASS for non-test `src/`; residual in test files, allowed by the design note. A grep of the stale phrases in non-test source finds none, and all 13 sites in design §8.1 are corrected. Remaining stale comments are only in frozen test files, `useStore.recordExportedOrder.spec156.test.ts:311`, `ReorderSection.lastOrderContext.spec151.test.tsx:180` and the `it()` titles at `ReorderSection.recordExport.spec156.test.tsx:429` / `PhoneOrdering.recordExport.spec156.test.tsx:293`. The spec's literal "No comment in `src/`" contradicts AC-20 and Out of scope, and the architect's reading applies. Not a defect. Suggest a follow-up sweep.
- AC-19 (phone render test, pending and resolved checkpoints) → PASS — phone suite `R1 + R2 — list stays while the silent refresh is pending, then shows the fresh payload`, plus the `R3 control`. Checks `phone-order-card-v-a`, `phone-order-line-a1` / `a2`, the KPI text (`1 VENDORS · 1 LINES`, then `· 2 LINES`) and absence of `phone-order-empty` and `phone-order-loading`.
- AC-20 (existing suites pass unmodified) → PASS. `git diff --name-only` lists only `ReorderSection.tsx`, `PhoneOrdering.tsx`, `useStore.ts` and `types/index.ts`, with no `*.test.*` files. The two new test files are untracked, so they are additions and not modifications. spec151 `lastOrderContext`, `switching`, spec160 `lastCounted` and spec156 `recordExportedOrder` suites all pass. The main session is covering the remaining `ReorderSection.*` / `PhoneOrdering.*` / `PhoneApproveOrder.*` files in the full jest run.
- AC-21 (full jest, typecheck, typecheck:test) → PARTIAL. `npm run typecheck` and `npm run typecheck:test` both pass clean (run here). Full `npx jest` is deferred to the main session's run, and I did not run it.
- AC-22 (browser check) → PENDING (main session is doing it). Not counted as missing.

Totals: 19 PASS (AC-1 to AC-20 except AC-21's jest half), 0 FAIL, 0 NOT TESTED. AC-21 is partial (typechecks pass, full jest pending in the main session). AC-22 is pending.

### Test run
Command: `npx jest <the two new suites> src/store/useStore.lastOrderContext.spec151.test.ts src/store/useStore.switching.test.ts src/store/useStore.lastCounted.spec160.test.ts src/store/useStore.recordExportedOrder.spec156.test.ts`
Result: 6 suites passed, 81 tests passed, 0 failed.
`npm run typecheck`: clean. `npm run typecheck:test`: clean.

### Harness trap check (pass-for-the-wrong-reason)
Both suites avoid the traps. The store suite mocks `hasActiveSession` to true and asserts `fetchAllForStore('S')` ran in every same-store case. The phone suite's `getSession` returns a user, the `fetchAllForStore` stub supplies an `orderSchedule` covering `v-a`, and the real `loadFromSupabase` runs. The phone R3 control proves the harness can see the bug: with `reorderStoreId: null` the same reload renders `phone-order-empty`.

I also mutation-tested the fix in a throwaway copy of the repo under the scratchpad (`.../scratchpad/mut`), so the real tree was never touched. 27 mutants of `useStore.ts`, each run against the two new suites:

- **Killed:**
  - always clear (full revert of the fix): 12 store and phone tests fail;
  - removing any one of the four drop rules (gen, loading, store, payload/date);
  - silent refresh sets loading, toasts, or sets `reorderError` on failure;
  - silent refresh awaited;
  - silent refresh removed;
  - date not passed through;
  - owner recorded from `currentStore` at completion;
  - owner write omitted from the foreground load;
  - owner reset omitted from the clear branch or `SIGNED_OUT_DATA_RESET`;
  - keep branch that nulls the context, resets loading, nulls the error, or nulls the payload;
  - silent success that nulls the context or keeps the error;
  - foreground gen bump removed;
  - keep predicate ignoring the owner.
- **Survived (3):**
  1. Dropping `reorderStoreId` from the silent-refresh success `set`. This is an equivalent mutant on every reachable path, because the keep predicate already requires owner === sid. It is harmless.
  2. Dropping `pre.reorderPayload !== null` from the keep predicate. The state (owner set, payload null) is unreachable through the store's own writes, since the owner is nulled in the same write as the payload, and the silent tail is separately guarded on a non-null payload. Low value.
  3. Dropping the architect-added `pre.currentStore?.id === sid` term from the keep predicate. No test pins it. Details in the Notes below.

### Notes
- **Non-blocking gap (survivor 3).** The `currentStore?.id === sid` term in `keepReorder` is the architect's addition, not an AC. No test covers a stale reload for store A that lands after the user switched to B and clears the slice instead of keeping A's payload. The term can only clear more, so the risk is nil. If the owner wants the cross-store-leak guard pinned, add one store test: `currentStore 'B'`, `reorderStoreId 'S'`, payload P, `loadFromSupabase('S')`, expect the slice to be cleared and no fetch. Suggest, don't block.
- **AC-7 unhandled-rejection clause** is enforced implicitly (jest fails the running test on an unhandled rejection) rather than by an explicit assertion. This is acceptable and documented in the test.
- **R1 timing** (the section's foreground load for the new store landing before the clear) is not directly tested. AC-12/13 drive `loadFromSupabase` directly, as the design says. The behavior is low risk (a redundant silent refresh at worst).
- No new test framework, and no source or test files were modified by this review. The scratch mutation copy lives only in the scratchpad.
- AC-22 is pending the main session's browser check. The deploy checklist from the spec still applies: after a push, confirm `test.yml`, `db-migrations-applied.yml` and (manually) `e2e.yml` are green on main.

## Fix round 1 re-review

Re-review date 2026-10-25, against the staged fix round 1 (rule A′, plus the `loadLastOrderContext` store-change guard). Verdict: no change to the AC table above; **no new FAIL or NOT TESTED**. The survivor flagged in my first report is now killed.

### Previously unpinned `currentStore` term: now pinned
The old survivor was "drop the architect-added `currentStore?.id === sid` term". The rule is now keyed on the current store (`before.reorderStoreId === currentId`, tail gated on `sid === currentId`). Three A′ cases in `src/store/useStore.reorderReload.spec175.test.ts`, describe "fix round 1", pin it:
- `race — a stale store-A reload landing after B's foreground load keeps B's payload`. This is the SF-1 scenario. It asserts the payload is `PB` by reference, the owner is `'B'`, `lastOrderContext` is unchanged, and only one reorder fetch was made (the foreground one).
- `stale reload with the payload owned by the current store: kept by reference, NO silent fetch`. It pins both the keep side and the `sid === currentId` condition on the tail.
- `a payload owned by a store that is no longer current is removed, even by its owner's reload`. This covers the foreign-owner removal. All five fields become null/false/null, and there is no fetch.

Anti-vacuity: each case asserts `fetchAllForStore` was called with the reload's `sid`. The race test holds A's `fetchAllForStore` on a deferred promise and resolves it after B's foreground load lands, so the ordering under test really happens.

### Mutation check (scratch copy only, real tree untouched)
I mutated `useStore.ts` in a throwaway copy under the scratchpad (`.../scratchpad/mut2`) and ran the two spec 175 store suites, the phone suite and the frozen spec151 store suite against each mutant.

| Mutant | Result |
|---|---|
| Keep keyed on `sid` instead of the current store | killed: all 3 new A′ cases |
| Tail without `sid === currentId` | killed: race, stale-kept |
| Pre-fix-round predicate (`owner === sid && current === sid`) | killed: race, stale-kept |
| Proposal's literal rule (keep when `sid !== currentId`) | killed: foreign-owner removal (and the dev reports the frozen spec151 test goes red on the literal rule, so A′ is the only variant that satisfies both) |
| Owner-only keep, ignoring current store and `sid` | killed: foreign-owner removal, phone control, both AC-12/13 cases |
| `loadLastOrderContext` success guard removed | killed: only `a late store-A success does not overwrite store B's context` |
| `loadLastOrderContext` failure guard removed | killed: only `a late store-A failure does not null store B's context` |
| Tail fires regardless of `sid` (variant) | killed: race, stale-kept |

Each of the two guard halves is independently killed, so the new tests cannot pass for the wrong reason. The same-store control in the guard suite shows the guard is not over-broad: with no store change, both a success and a failure still land.

### AC-20 (no pre-existing test file modified)
`git diff --cached --name-status` lists tests only as `A`:
- `src/screens/cmd/sections/phone/__tests__/PhoneOrdering.reorderReload.spec175.test.tsx`
- `src/store/useStore.lastOrderContextGuard.spec175.test.ts`
- `src/store/useStore.reorderReload.spec175.test.ts`

The only `M` entries are `ReorderSection.tsx`, `PhoneOrdering.tsx`, `useStore.ts` and `types/index.ts`. There are no unstaged changes. AC-20 holds. The frozen spec151 store-switch test still passes, which is the reason A′ was chosen over the literal rule.

### AC-17 note
`useStore.ts` is the only non-comment source change, plus `types/index.ts`. I did not re-derive the AC-17 filter on the two section files. The main session and the dev report it empty, and the staged diff for those files is unchanged from my first review.

### Test run
Command: `npx jest` on the 3 spec175 suites, plus spec151 `useStore.lastOrderContext`, `useStore.switching`, spec160 `lastCounted`, spec156 `recordExportedOrder`, spec151 `PhoneOrdering.lastOrderContext` and `ReorderSection.lastOrderContext`.
Result: 8 suites passed, 106 tests passed, 0 failed.
The full suite was not run, per instructions. The main session reports 265/265 suites, 3309/3309 tests, `typecheck` and `typecheck:test` clean.

### Notes
- AC-22 (browser check) ran on the pre-fix-round build. The same-store path is logically unchanged by A′: for current store S, owner S and `sid` S, the keep and silent-refresh branch is identical to the earlier predicate. The change only affects stale-reload and foreign-owner cases, which the jest suites cover. I do not count this as missing. A quick re-check of the store-switch step (list clears and reloads for the new store) on the final build would be a cheap extra.
- The R1 window (previous store's `lastOrderContext` visible for about one RPC on the keep path) is documented in the code but has no direct test, only the late-read guard. This is accepted and low risk.
- No new test framework, and no source or test files were modified by this review. The index is unchanged.
