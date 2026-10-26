## Code review for spec 175

Scope read: spec + architect design, `src/store/useStore.ts` (all spec-175 hunks), `src/types/index.ts`, the comment edits in `ReorderSection.tsx` / `PhoneOrdering.tsx`, and both new test files. I could not run `git diff` (no shell in this review), so AC-17 ("comment-only edits in the two section files") is checked by reading every `spec 175` hunk in those files, not by diff. Every hunk I found is a comment. Architecture and security are out of my lane. Where a finding touches the cross-store design I mark it "defer to architect".

The keep-vs-clear predicate and the silent-refresh drop rules are correct for every case in the ACs. I traced these interleavings by hand and all behave as designed:
- Foreground load before the silent refresh, landing before or after it.
- Foreground load after the silent refresh.
- Overlapping silent refreshes.
- Logout during a silent refresh.
- Date change during a silent refresh.

Project conventions hold: no direct Supabase calls (the silent path goes through `db.fetchReorderSuggestions`), no inline colors, no web-only APIs, no legacy files touched, no new realtime channels, and both tests are on the jest track.

### Critical
- None.

### Should-fix
- `src/store/useStore.ts:2171-2174` (with the clear spread at `:2228-2234`) — the `currentStore?.id === sid` term turns a stale reload into a *clear*, and the clear can blank the current store's list with nothing to re-fetch it. Scenario:
  1. A's reload is mid-`fetchAllForStore`.
  2. The user switches to B, and B's foreground load lands (`reorderStoreId === 'B'`).
  3. A's `set` then runs. `pre.currentStore.id !== 'A'`, so `keepReorder` is false and B's fresh payload is nulled.
  4. B's own `loadFromSupabase` then sees `reorderPayload === null` and also clears.

  The result is a permanently blank list for B, which is the symptom this spec removes. The section effect is keyed on store and date, and neither moves. The design doc (§6.3) says the term "can only clear more", which is true, but "clear more" is not harmless here. A stale reload should not touch the reorder slice. If A's payload is still showing under B, B's own reload clears it. Suggested fix: when `pre.currentStore?.id !== sid`, spread no reorder keys at all (neither keep nor clear), for example:
  ```ts
  const isCurrent = pre.currentStore?.id === sid;
  const keepReorder = isCurrent && pre.reorderPayload && pre.reorderStoreId === sid;
  ...(isCurrent && !keepReorder ? { …clear… } : {}),
  ```
  Add one test for it. No test pins this term today (see Nits). Defer to architect for the final call, since the term was the architect's addition.

- `src/store/useStore.ts:2223-2227` (the R1 note) and `:2228` — on the R1 path (B's foreground payload lands before `loadFromSupabase(B)`'s `set`), the keep branch leaves `lastOrderContext` untouched. At that point it is still store A's context, because `setCurrentStore` does not clear it. The spec 151 comment two lines above calls clearing it on a switch "load-bearing, not cosmetic" (vendor-keyed, so a shared vendor renders A's quantities against B's lines). The R1 note says "its fresh payload is kept" but never mentions that the context is kept too.
  - A's context stays on screen until `loadLastOrderContext` for B lands. That effect does re-fire, because `currentStore?.id` is in its deps, so the exposure is a window and not permanent.
  - The window is longer than before: the old unconditional clear nulled the context at this `set`.
  - Either state this in the comment as an accepted window, or tie `lastOrderContext` to the owner. For example, clear it whenever the kept payload's owner differs from the context's store. Defer to architect, since this is the cross-store leak the spec flags as its main review item.

### Nits
- `src/store/useStore.ts:2171-2174` and `:2271` — the predicate and the tail guard disagree. `keepReorder` tests `pre.reorderPayload !== null`, but the tail re-tests `pre.reorderPayload` for truthiness (a type-narrowing guard). If a test or a future write ever leaves it `undefined`, `keepReorder` is true, so nothing is cleared and no refresh fires, which is a silent half-keep. Make the predicate truthy-based (`!!pre.reorderPayload`), or derive the payload once, for example `const kept = (owner && current) ? pre.reorderPayload : null`, and use `kept` for both the spread and the tail. That also drops the redundant guard.
- `src/store/useStore.ts:2170` — `pre` is a vague name for a whole-state snapshot. `before` or `snapshot` reads better next to the later `get()` calls in the same `set`.
- `src/store/useStore.ts:2166-2169` and `:2206-2234` — the keep/clear rationale is split across two comment blocks, with the spec 175 and spec 151 paragraphs interleaved inside the object literal. Consider moving the predicate explanation entirely above `keepReorder` and leaving only the spec 151 "why the context clear is load-bearing" note at the spread.
- `src/store/useStore.ts:265-272` — inline `// AC-10`, `// AC-8`, `// AC-9`, `// AC-11`, `// AC-6` markers are spec numbers with no spec prefix, and they say nothing about why. The function docblock at `:249-253` already carries the reasons. Replace the markers with short "why" comments (for example "a newer request owns the payload") or delete them.
- `src/store/useStore.ts:252-253` — "Never rejects" is slightly off, since the function returns `void`, not a promise. It also overstates: a *synchronous* throw from `db.fetchReorderSuggestions` (not a function, or a mock that returns `undefined`) would escape `.then().catch()` and land in `loadFromSupabase`'s own `catch`. The real `db` function is `async`, so this is fine in production. Reword to "never produces an unhandled rejection", or note the assumption.
- `src/store/useStore.ts:264-265` — `const s = get()` is read before the cheapest check (`gen !== reorderRequestGen`). Moving `get()` below the generation check is cosmetic only.
- `src/store/useStore.reorderReload.spec175.test.ts:197-205` — the AC-1 test's first two assertions are redundant. `INITIAL_STATE.reorderStoreId` and `useStore.getState().reorderStoreId` are the same value after `setState(INITIAL_STATE, true)`. Keep one.
- `src/store/useStore.reorderReload.spec175.test.ts` — test coverage gap (defer to test-engineer): there is no test for the architect's `currentStore?.id === sid` term, that is, a reload for `sid` while `currentStore` is another store. This is also where the first Should-fix above lives.
- `src/store/useStore.reorderReload.spec175.test.ts:122-146`, `:446-509` — heavy `as any` and `as unknown as ReorderPayload` casts in fixtures (`store()`, `seedSameStore()`, `payload()`). That is normal for this project's tests. If you touch it again, a typed `Partial<FullStore>` for `seedSameStore` would drop the `as any`.
- `src/screens/cmd/sections/phone/__tests__/PhoneOrdering.reorderReload.spec175.test.tsx:194,233` — the case labels `R1 + R2` and `R3 control` collide with the spec's resolved-decision numbering (R1 = timing, R3 = foreground-wins generation rule, R4 = overlapping silent refreshes). The store suite uses "R4" in the spec's sense, so a reader gets two meanings of R3 across the two files. Rename the phone cases, for example "pending / resolved" and "control (no owner tag)".
- `src/screens/cmd/sections/phone/__tests__/PhoneOrdering.reorderReload.spec175.test.tsx:54-57` vs `:63-64` — the `everyDay()` helper and the inlined `schedule` inside the `jest.mock` factory duplicate each other. The header comment explains why (factories cannot close over module-scope helpers), so this is acceptable. A `mock`-prefixed variable, which jest allows, would remove the duplication.
- (out-of-scope) `src/store/useStore.recordExportedOrder.spec156.test.ts:311`, `ReorderSection.recordExport.spec156.test.tsx:429`, `PhoneOrdering.recordExport.spec156.test.tsx:293`, `ReorderSection.lastOrderContext.spec151.test.tsx:180` — these test comments still say a same-store reload nulls `reorderPayload`. They are frozen by AC-20. A later sweep can fix them.

---

## Fix round 1 re-review

Scope read: the spec's `## Fix round 1`, the current `loadFromSupabase` keep/clear block (`src/store/useStore.ts:2171-2294`), `startSilentReorderRefresh` (`:239-284`), `loadReorderSuggestions` (`:4670-4683`), `loadLastOrderContext` (`:4694-4719`), `setCurrentStore` (`:1628`), the "fix round 1" describe in `useStore.reorderReload.spec175.test.ts` (`:510-576`), the new `useStore.lastOrderContextGuard.spec175.test.ts`, and the renamed phone cases. I had no shell, so I did not run jest or `git diff`. I rely on the spec's reported green gates (265/265 suites, both typechecks) and the mutation table, and I read the tests to confirm they assert what the table claims.

Verdict: both prior Should-fixes are closed. No new Critical and no new Should-fix.

### Critical
- None.

### Should-fix
- None.

### Status of the prior findings
- **SF-1 (stale reload blanks the current store's list): closed.** I traced rule A′ at `:2197-2203`.
  - The race case (A's reload lands after B's foreground payload): `currentId = 'B'`, owner `'B'`, so the payload is kept by reference, no reorder key is written, and `silentRefreshFrom` is null because `sid ('A') !== currentId`. B's list survives and there is no stray fetch.
  - Ordinary store switch: `setCurrentStore` sets `currentStore` before it triggers the load, so by the time `loadFromSupabase(B)` settles, `currentId = 'B'` and an A-owned payload is cleared exactly as before. The frozen spec 151 test, which has `currentStore = store-1` and loads `store-2`, clears because the owner is not `store-2`.
  - Same-store reload: owner equals current, so the payload is kept and the silent refresh fires.
  - The one place A′ differs from the proposal (a foreign-owned payload is removed even when the reload is for its owner and that owner is no longer current) is the safer direction, and the third new case pins it.
  - A′ is a sound resolution of the proposal-vs-AC-20 conflict. I agree with the owner's call, and the spec's table of three variants against the frozen test is the right evidence.
- **SF-2 (`lastOrderContext` left on screen on the R1 keep path): closed.** `loadLastOrderContext` now drops its result on both settle paths when `get().currentStore?.id !== storeId` (`:4710`, `:4714`). The R1 comment at `:2191-2196` now names the accepted window and why the guard stops a late read extending it. The guard test file covers success-drop, failure-drop, and a same-store control. I read the three tests and they assert what the spec's mutation table says they do. The harness matches the spec 151 suite.
- **Prior nits:**
  - `pre` renamed to `before`; the `!== null` versus truthy mismatch is gone, since `keptReorder` is derived once and used for both the spread and the tail.
  - The bare `// AC-n` markers in `startSilentReorderRefresh` are now short "why" comments, and `get()` now follows the generation check.
  - "Never rejects" reworded, with the promise assumption stated.
  - The redundant AC-1 assertion is removed.
  - The phone cases are renamed ("pending → resolved", "control (no owner tag)").
  - The `as any` casts and the `everyDay()` duplication were left alone, which is acceptable.
  - The split rationale across two comment blocks is only partly addressed, but the spread comment now points at the block above `before`. See the first nit below.

### Nits
- `src/store/useStore.ts:2203` — `silentRefreshFrom` holds a whole `ReorderPayload`, but the only consumer (`:2293`) reads `.asOfDate`. The name reads like a date or a source. Either pass `keptReorder.asOfDate` and name it `silentRefreshDate` (string or null), or keep the payload and rename it `payloadToRefresh`. Cosmetic.
- `src/store/useStore.ts:2180` — "(spec 175 fix round 1, code-reviewer SF-1)" puts a review-finding ID in source. It will mean nothing to a reader in six months, and the spec file carries that history. Say why in the comment ("a stale reload must not blank a payload nothing would re-fetch") and drop the finding ID.
- `src/store/useStore.ts:2235-2243` — the spread comment still restates part of the rationale from `:2172-2196` ("A SAME-STORE RELOAD ... writes none, so the list stays on screen"). The spec 151 paragraph at `:2244-2248` is the only part that belongs at the spread. Trim the first half to a one-line pointer.
- (out-of-scope, pre-existing) `src/store/useStore.ts:2251` — the clear spread sets `reorderLoading: false`. If a stale reload for the old store settles while the new store's foreground load is still in flight, the section briefly shows its empty state until the foreground result lands. The old unconditional clear did the same, so it is not a regression. A′ does not make it worse. Mentioned only because the section's loading gate is where it would surface.
- `src/store/useStore.lastOrderContextGuard.spec175.test.ts:94-121` — the late-read tests synchronize on `await p` after `d.resolve`/`d.reject`. That is correct here because `p` is the action's own promise. No change needed; noting it so nobody "fixes" it with a `flush()`.
- `src/store/useStore.reorderReload.spec175.test.ts:515` — `(fetchAll.getMockImplementation() as () => Promise<unknown>)()` throws a confusing `undefined is not a function` if the default implementation is ever swapped for `mockResolvedValue`. A small shared `defaultShape` constant used by both the default mock and this test would remove the cast. Cosmetic.
