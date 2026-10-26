> **History (round 1, 2026-10-23): FIXES_NEEDED.** Round 1 had no Criticals, every AC passed, and all three CI gates were green. It was held for two Should-fix items. **SF-1:** a stale reload for the previous store could clear the new store's freshly landed payload, which left the list permanently blank. That is the exact symptom spec 175 removes. The `currentStore?.id === sid` predicate term behind it was unpinned (test-engineer survivor 3). **SF-2 / security L1:** `lastOrderContext` could show the previous store's quantities on the R1 keep path, and a late previous-store read could make that stick. Optional nits were also listed. Fix round 1 handled both. SF-1 was fixed with the owner-chosen rule A′ (keep iff the current store owns the payload; silent refresh only when `sid` is current) instead of the literal rule in the round-1 proposal, because the literal rule turns the frozen spec 151 store-switch test red, which AC-20 forbids. SF-2 was fixed with a store-change drop guard in `loadLastOrderContext`. The nits were applied too.

## Verdict
verdict: SHIP_READY
rationale: Both round-1 Should-fix items are closed and pinned by mutation-checked tests. No reviewer reports a Critical or Should-fix. All ACs pass, with full jest, both typechecks, AC-17 and AC-22 re-run on the final build. All three CI gates on `main` (head 8872de2) are green. The two open security Lows (L2 carried, L3 new) affect integrity of the store's own data, have pre-existing root causes, and go to a follow-up spec (reasoning below).

## Findings summary

- **code-reviewer (fix round 1 re-review):** 0 Critical, 0 Should-fix, 6 Nits.
  - **SF-1 closed.** The reviewer traced A′ (`src/store/useStore.ts:2197-2203`) through four cases: the race, an ordinary switch, a same-store reload, and the foreign-owner removal. They agree A′ is the right way to resolve the conflict between the proposal and AC-20.
  - **SF-2 closed.** There are guards on both settle paths of `loadLastOrderContext`, and the R1 window is now documented.
  - **All round-1 nits addressed.** The `as any` casts and the `everyDay()` duplicate were deliberately left alone, which is acceptable.
  - **New nits, all cosmetic:**
    - `silentRefreshFrom` holds a payload but only `.asOfDate` is used.
    - The source comment at `:2180` contains the review ID "code-reviewer SF-1".
    - The spread comment at `:2235-2243` repeats the block above it.
    - There is a `getMockImplementation()` cast at `useStore.reorderReload.spec175.test.ts:515`.
    - The `await p` sync in the guard tests is a note only: it is correct and should not be "fixed".
    - One pre-existing, out-of-scope nit (see Out of scope).
  - The reviewer had no shell and relied on the reported gates. Main-verification independently confirms those gates.
- **security-auditor (fix round 1 re-audit):** 0 Critical, 0 High, 0 Medium. 2 Low are open and 1 is closed.
  - **L1 closed.** The guard bounds the R1 context window to one RPC round-trip. An A→B→A round-trip leaves A's data under A, so no store boundary is crossed.
  - **L2 carried, unchanged:** the foreground cross-store race in `loadReorderSuggestions` can lead, via export, to a draft PO under the wrong store. The auditor rates it Medium standalone, and the owner put it out of scope. A′ does not widen it: a foreign-owned payload now gets cleared by *any* later reload, including a stale one.
  - **L3 new:** after A′'s stale-keep branch, a stale `loadFromSupabase(A)` that lands after B's reload still overwrites `inventory` / `vendors` / `orderSchedule` / `brand` with A's rows, while B's reorder list stays live. If the user exports in that window, they record a B draft PO with B's own item ids and quantities. But `cost_per_unit_counted` is understated (the `subUnitSize` lookup misses and falls back to 1, so the spec-104 bridge is skipped) and order codes are blank. Before this round, the list went blank in that window, so no export could happen. The auditor's verdict is "Nothing blocks spec 175."
  - Verified:
    - A′ keys on the current store, and `currentStore` is always written before the load starts, so no previous-store payload is ever kept under a new store.
    - The keep check and the `set` are still atomic.
    - Brand switch, logout and session loss are safe; the late context read is now also dropped after sign-out.
    - The spec 156 snapshot is intact.
    - No secrets in tests.
- **test-engineer (fix round 1 re-review):** 0 FAIL, 0 NOT TESTED. The AC table is unchanged: AC-1 to AC-20 PASS, and AC-21/AC-22 are covered by main-verification.
  - Round-1 survivor 3 (the unpinned current-store term) is now killed by three A′ cases: race, stale-kept, and foreign-owner removal. Each asserts `fetchAllForStore` for anti-vacuity.
  - Independent mutation run in a scratch copy, 8 mutants, all killed. This includes "keep keyed on `sid`", "tail without `sid === currentId`", the pre-fix predicate, the proposal's literal rule, owner-only keep, and each `loadLastOrderContext` guard half on its own.
  - AC-20 holds: tests appear only as `A` in the staged set, and the frozen spec 151 suites pass unmodified.
  - Targeted run: 8 suites, 106 tests, all green.
  - The R1 context window has no direct test, only the late-read guard tests. The reviewer accepts this as low risk.
- **backend-architect (post-impl, round 1 only):** no contract drift. 0 Critical, 0 Should-fix, 3 Minor (M-3 was closed by main-verification's AC-17 diff).
  - The architect did **not** re-review fix round 1. A′ replaces the §6.3 keep predicate, including the architect-added `currentStore?.id === sid` term.
  - I don't count that as contract drift. No API, DB, RPC or `db.ts` surface changed. The rule is internal store logic that the owner approved and that is recorded in the spec's `## Fix round 1`. code-reviewer, security-auditor and test-engineer each traced it independently.
  - If you want the design doc reconciled, see optional step 2.
- **main-verification (fix round 1):**
  - Full `npx jest`: 265/265 suites, 3309/3309 tests, 17/17 snapshots.
  - `typecheck` and `typecheck:test`: exit 0.
  - AC-17 non-comment filter: 0 lines.
  - **AC-22 re-run on the final build** (phone width, Towson; rows restored afterwards):
    - same-store reload: the list stayed and refreshed from 30 to 29 lines;
    - switch to Frederick: cleared to `0 VENDORS · 0 LINES`;
    - switch back: reloaded at 29 lines.
  - The CSV self-echo and the desktop steps were not repeated. Both passed on the round-1 build, and A′ leaves the same-store path logically identical (current = owner = `sid`).
- **CI on `main` (head 8872de2, re-checked 2026-10-25):** `test.yml`, `db-migrations-applied.yml` and `e2e.yml` all **success**.

### Classification of the open security Lows

- **L3: follow-up, not a blocker.**
  - **Why not a blocker:**
    - No reviewer rates it above Low, and the auditor explicitly says it does not block.
    - It is integrity of the current store's *own* data only. No A row is written under B and no store or user boundary is crossed. The PO lines are B's item ids under `store_id = B`; only the derived cost and order codes degrade.
    - It needs a narrow race: A's `fetchAllForStore` has to resolve after B's *entire* reload (session probe, `fetchStores`, `fetchAllForStore`).
    - It heals on B's next reload, and the draft PO it would record is a draft.
    - The root cause predates spec 175: a stale `loadFromSupabase` result overwrites the non-reorder slices. I flagged it in round 1 as a coordinator observation. On `main` today it already puts A's inventory under B in every other section.
  - **Why A′ is still the right call despite it:** going back to "clear on stale reload" would re-introduce SF-1, a permanent blank list for every user who hits the race. That is a worse, user-visible failure of this spec's own goal. The auditor says the same.
  - **The correct fix is out of scope here:** drop a single-store `loadFromSupabase` result when `sid !== get().currentStore?.id` at settle (no `set`, no tails). That changes `loadFromSupabase` for *every* slice and the spec 060 / spec 160 tails, so it needs its own spec and tests. It also makes A′'s stale-reload branch dead code, which is fine.
  - **Honest caveat:** spec 175 does newly make this window *exportable*, where before the list was blank. That is why it should go first in the follow-up spec, not into the backlog.
- **L2: follow-up, not a blocker.** This is unchanged from round 1.
  - It predates spec 175, the owner declared it out of scope, and A′ narrows its persistence rather than widening it.
  - It is Medium standalone and can reach a write, so it shares the next spec with L3.
  - Both are "a late result from a previous store lands under the current store", and both end at the same export → `recordExportedOrder` write. One "stale-result guard" spec closes both.

## Recommended next steps (ordered)

1. **Commit and deploy** once you confirm. Main Claude does not auto-commit.
   - The staged set is 14 paths: the spec, 6 review files including this proposal, 4 modified source files (`useStore.ts`, `types/index.ts`, `ReorderSection.tsx`, `PhoneOrdering.tsx`), and 3 new test files.
   - Before committing, re-stage the review files that have unstaged edits (code-reviewer, security-auditor and test-engineer show `AM`) and this rewritten proposal.
2. **(Optional, before commit) Cosmetic cleanup.** None of this changes behavior; if you skip it, put it in the follow-up spec.
   - Remove "code-reviewer SF-1" from the source comment at `src/store/useStore.ts:2180` and keep the "why".
   - Trim the spread comment at `:2235-2243` to a pointer.
   - Rename `silentRefreshFrom` to something like `payloadToRefresh`.

   If you do any of these, re-run full `npx jest`, both typechecks and the AC-17 filter afterwards.

   Separately, you can ask backend-architect to append a one-line note to the spec's `## Backend design` §6.3 saying A′ supersedes the original predicate. That is optional design-doc hygiene, not drift.
3. **After the push:**
   - Confirm that the latest `test.yml` **and** `db-migrations-applied.yml` runs on `main` are green (CLAUDE.md gate rule).
   - Check `e2e.yml` manually until it is promoted to a listed gate (project memory).
   - The change is client-only, so the migrations gate should be unaffected.
4. **Follow-up spec (next): stale-result guards for store switches.** This covers L3 and L2, plus the round-1 coordinator observation.
   - (a) In the single-store `loadFromSupabase`, drop the result when `sid !== currentStore.id` at settle. This closes L3 and the general stale overwrite of `inventory` / `vendors` / `orderSchedule` / `brand`.
   - (b) In `loadReorderSuggestions`, drop the result when `currentStore.id !== storeId` at completion (reset `reorderLoading` only), and/or make the export snapshot refuse when `reorderStoreId !== currentStore.id`. This closes L2.
   - (c) Verify whether the server-side draft-PO upsert rejects item ids from another store. The auditor did not check this.
   - (d) Optionally have `buildDraftOrderLines` refuse lines whose `itemId` is not in the current `inventory`. That is a defense-in-depth guard against the costing degradation.

## Out of scope for this review

- **Security L2 and L3.** These are follow-ups, not blockers; see the classification above and step 4.
- **Pre-existing `reorderLoading: false` on the clear spread** (code-reviewer re-review, out-of-scope nit). A stale reload that settles during the new store's foreground load briefly shows the empty state until the foreground result lands. The old unconditional clear did the same, and A′ does not make it worse.
- **Stale comments in frozen test files**, which AC-20 freezes:
  - `useStore.recordExportedOrder.spec156.test.ts:311`
  - `ReorderSection.lastOrderContext.spec151.test.tsx:180`
  - the `it()` titles at `ReorderSection.recordExport.spec156.test.tsx:429` and `PhoneOrdering.recordExport.spec156.test.tsx:293`

  These belong in a later comment sweep.
- **Date mismatch after a PO lifecycle mutation.** The no-arg `loadReorderSuggestions()` loads the server's today. This is pre-existing and already listed as out of scope in the spec.
- **Architect risk #1:** one background `report_reorder_list` per same-store reload while any payload is held. This was accepted. Revisit (null the payload on section unmount) only if it shows up in profiles. TopProgressBar lighting during the silent refresh is expected chrome.
- **Untested R1 context window** (test-engineer note). It is documented in code and bounded by the late-read guard. A direct test can ride along with the follow-up spec if wanted.
- **Stale `loadMenuCapacity(A)` / `loadItemsLastCounted(A)` tails** fired by a stale reload. This is a coordinator observation and pre-existing. Fix (a) in step 4 removes it, because the tails would no longer run for a non-current `sid`.
