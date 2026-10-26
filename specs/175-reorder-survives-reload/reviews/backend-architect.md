# Spec 175 — backend-architect post-implementation drift review

Reviewer: backend-architect (post-impl mode), 2026-10-23.
Compared against: `## Backend design` in [specs/175-reorder-survives-reload.md](../../175-reorder-survives-reload.md), including the developer's "Implementation notes" under `## Files changed`.

**Verdict: no contract drift.** 0 Critical, 0 Should-fix, 3 Minor (none need a code change).

**Coverage limit.** I had no shell in this run, so I could not run `git diff`. I read every design-named site directly:
- `useStore.ts`: L3, L190-278, L1122-1137, L1250-1255, L1372-1381, L2131-2273, L3673-3682, L3895-3914, L3976-3980, L4637-4662;
- `types/index.ts`: L741-760;
- `ReorderSection.tsx`: L373-377, L504-508, L1491-1501, L1548-1558;
- `PhoneOrdering.tsx`: L611-622;
- both new test files in full.

I also grepped for every `reorderPayload:` write and every remaining reorder-slice write in non-test `src/`. Whether those two UI files contain **only** comment hunks (AC-17) has not been checked against a mechanical diff (see M-3).

---

## Critical

None.

## Should-fix

None.

## Minor

### M-1. The AC-7 unhandled-rejection check was swapped for jest's global behavior (a recorded deviation from design §9.1 T7)

[src/store/useStore.reorderReload.spec175.test.ts:297-322](../../../src/store/useStore.reorderReload.spec175.test.ts)

The design asked for a `process.on('unhandledRejection', spy)` assertion. The developer dropped it because a probe showed the spy is never called in this jest setup. The test now relies on jest failing the running test on an unhandled rejection.

This is acceptable at the architecture level:
- The structural guarantee is in the code. `startSilentReorderRefresh` uses `.then(...).catch(...)` ([useStore.ts:262-277](../../../src/store/useStore.ts)), so a throw inside the success handler is caught too.
- The `console.warn('[Supabase] silent reorder refresh:', 'x')` assertion proves that `.catch` handled the rejected fetch.
- The only uncovered path is a throw inside the `.catch` body. That body is a single `console.warn`, so the risk is negligible.

One caveat: the claim that jest fails the running test on an unhandled rejection depends on the environment. test-engineer should confirm it for this project's jest config, or accept the warn assertion as the AC-7 evidence. No design change is needed.

### M-2. The silent-tail guard is `keepReorder && pre.reorderPayload`, not `pre.reorderPayload!` (a recorded deviation)

[src/store/useStore.ts:2271-2273](../../../src/store/useStore.ts)

`keepReorder` already requires `pre.reorderPayload !== null` (L2172), so the extra conjunct is redundant but behaves the same. It avoids a non-null assertion and adds no new path.

The `StoreApi` type is imported on its own line ([useStore.ts:3](../../../src/store/useStore.ts)) instead of being added to the L2 import. That is also cosmetic. Not drift.

### M-3. AC-17 "comment-only" still needs a mechanical diff check

[src/screens/cmd/sections/ReorderSection.tsx](../../../src/screens/cmd/sections/ReorderSection.tsx), [src/screens/cmd/sections/phone/PhoneOrdering.tsx](../../../src/screens/cmd/sections/phone/PhoneOrdering.tsx)

Every design-named comment site (§8.1 #9-#13) carries the corrected wording, and the code next to them looks unchanged:
- the `exportContext` body at PhoneOrdering L619-622;
- the `snapshot` body at ReorderSection L509-512;
- the as-of effect at ReorderSection L1502+.

Without a diff, though, I cannot rule out a stray non-comment hunk elsewhere in either file. code-reviewer (or release-coordinator) should run `git diff -U0 -- src/screens/cmd/sections/ReorderSection.tsx src/screens/cmd/sections/phone/PhoneOrdering.tsx` and check that every `+` and `-` line is a comment. `PhoneApproveOrder.tsx` is not in the git status, which matches the design.

---

## Design conformance checklist (matched, for the record)

| Design point | Where | Status |
|---|---|---|
| §6.1 type and doc after `reorderError`, mirroring `lastCountedStoreId` | `types/index.ts:752-760` | Matches |
| §6.1 initial `reorderStoreId: null as string \| null` beside `reorderError` | `useStore.ts:1381` | Matches |
| §6.1 `SIGNED_OUT_DATA_RESET` key (covers `logout` and `handleSessionLost`) | `useStore.ts:1254` | Matches |
| N2: every non-test `reorderPayload` write tracks the owner | L272, L1250, L1378, L2229, L4656. No other writers in non-test `src/` | Matches |
| §6.2 bump after the `!storeId` guard and before the first `set`/`await`; `reorderStoreId: storeId` in the same success `set`; catch unchanged | `useStore.ts:4649-4662` | Matches |
| §6.3 keep predicate computed after `fetchAllForStore`, with no `await` before the `set` (R1); it includes the architect-added `currentStore?.id === sid` term | `useStore.ts:2165-2176` | Matches |
| §6.3 conditional spread: keep writes no reorder key; clear writes the five nulls/false | `useStore.ts:2228-2234` | Matches |
| §6.3 `reorderEdits`, `menuCapacity`, `lastCounted*` untouched; `__all__` branch untouched | `useStore.ts:2131-2163`, `2235-2257` | Matches |
| §6.3 silent tail after the capacity and last-counted tails, not awaited, `asOfDate` passed verbatim (N3) | `useStore.ts:2263-2273` | Matches |
| §6.4 module-level `reorderRequestGen` and private `startSilentReorderRefresh` after `recordingKeys`; no new `StoreActions` member | `useStore.ts:227-278` | Matches |
| §6.4 drop order: gen, store, loading, payload/date, null-fresh; one success `set` with no `reorderLoading`; `.then().catch()` with warn only | `useStore.ts:261-277` | Matches |
| §6.4 counter not bumped in the store-switch clear or the signed-out reset | Grep: only L261 and L4652 touch it | Matches |
| §3 / §5 no new `db.ts` helper, no direct `supabase.*` call | `db.fetchReorderSuggestions` only | Matches |
| §8.1 comments #1-#13 | All sites listed above. The stale-phrase grep in `src/` returns only test files (frozen by AC-20) and the corrected wording at `useStore.ts:195` / `ReorderSection.tsx:508` | Matches |
| §9.1 T1-T16 (anti-vacuity: `fetchAllForStore('S')` on every same-store case, `('S','D')` on every keep case; `hasActiveSession` mocked true) | store suite | Matches, apart from the T7 swap in M-1 |
| §9.2 harness changes 1-3 (session with a user, explicit Proxy entries including `fetchStores` and an `orderSchedule` covering `v-a`, no stubbed actions); R1 and R2 at both checkpoints; R3 control | phone suite | Matches. R1 and R2 are one test with two checkpoints, which is what the design's "continue" wording intended |

No RLS, migration, edge-function, realtime-publication, or `app.json` changes, as designed.

## Handoff
next_agent: NONE
prompt: Architectural drift review complete. 3 findings by severity: 0 Critical, 0 Should-fix, 3 Minor (M-1 AC-7 test-mechanism swap is acceptable, but test-engineer should confirm jest's unhandled-rejection posture; M-2 cosmetic guard and import shape; M-3 AC-17 comment-only status needs a mechanical `git diff -U0` on the two UI files, which this reviewer could not run).
payload_paths:
  - specs/175-reorder-survives-reload/reviews/backend-architect.md
