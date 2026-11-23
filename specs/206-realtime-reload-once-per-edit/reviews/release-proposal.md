# Release proposal: spec 206 (one realtime reload per edit, never two at once)

Release coordinator, 2026-11-23. Built from the three reviewer files in this directory (code-reviewer.md, security-auditor.md, test-engineer.md), the spec, and spot checks of `src/navigation/CmdNavigator.tsx` and `src/lib/db.ts`.

## Verdict
verdict: SHIP_READY
rationale: No reviewer raised a Critical, High, Medium or should-fix finding. All 16 acceptance criteria pass (AC-13's base typecheck fails only locally, for an environmental reason). The latest runs of `test.yml`, `db-migrations-applied.yml` and `e2e.yml` on `main` (8431180) are all green.

## Findings summary

- **code-reviewer:** 0 Critical, 0 Should-fix, 6 Nits.
  - Top nits:
    - two defensive branches in `realtimeReloadScheduler.ts` can't be reached: `onSettled`'s `dirty && isWriting()` (L136-140) and `onTimer`'s `isWriting()` guard (L148);
    - `Promise.resolve(p)` at L126 has no "why" comment;
    - the write and non-write patches in `inflight.ts` (L116-127, L176-190) repeat the base fields;
    - case labels repeat in the hook test (`(b)`, `(d)` and `(e)` each appear twice);
    - one `handleSync()` call after unmount runs outside `act`;
    - the exports-for-test in the hook file are unannotated.
  - Coverage limit: this reviewer had no shell. It read the `CmdNavigator.tsx` and `inflight.test.ts` changes only by grep, not line by line. For the scheduler test it read only the case titles, not the bodies. Its file states this in the Scope line.
  - The test-engineer covers that gap: it mapped every AC to named cases in `inflight.test.ts`, `realtimeReloadScheduler.test.ts` and the hook test, and confirmed the `CmdNavigator.tsx` diff.
  - I also read `CmdNavigator.tsx` L1-78. The inline `reloadTimerRef` debounce is gone, `useRef` is no longer imported, and `useRealtimeReloadScheduler()` (L66) comes before `useRealtimeSync` (L67).
- **security-auditor:** 0 Critical, 0 High, 0 Medium, 2 Low.
  - **Low 1: a hung write that ignores the abort signal holds live updates.** The hard abort only aborts the controller. A request inside a `kind: 'write'` track that isn't wired to `signal` can keep `_writeCount > 0` past 30 s. Before this spec, that only kept the loading bar lit. Now it also holds every realtime reload on that client until the request settles.
    - Known sites: the `uploadIngredientImage` storage upload and the orphan-header deletes in `createPurchaseOrderDraft` and `upsertVendorDraftOrder`.
    - I confirmed the `createPurchaseOrderDraft` site: db.ts L1780 runs `await supabase.from('purchase_orders').delete().eq('id', poId)` with no `.abortSignal(signal)`.
    - The architect's §11 risk note already flags the same class of problem for the storage `.remove()` calls. The design accepted it as non-blocking.
  - **Low 2: logout doesn't reset `useInflight`.** It is a module singleton, so a write from user A that is still in flight can delay user B's first realtime reloads in the same JS runtime. No data crosses between users; it only delays updates. No fix is required.
  - Checked with no finding: stale data across a store switch, stale data across a user switch, the spec 152 session probe, event spoofing or amplification, client-side authorization, logging, and unhandled rejections.
- **test-engineer:** 16 PASS, 0 FAIL, 0 NOT TESTED.
  - Full `npx jest`: 322 suites and 4131 tests pass. `npm run typecheck:test` exits 0.
  - `npm run typecheck` fails locally only with 24 TS2688 errors from git-ignored duplicate `node_modules/@types/* 2` folders. CI runs `npm ci` first, so it won't have them. This is not a spec 206 defect.
  - AC-14 to AC-16 pass on the developer's recorded browser results; the test-engineer did not re-run them.
    - Measured with Playwright, not the preview tools, plus 250 ms of emulated latency per request.
    - At 250 ms: baseline 3, 2 and 3 reloads per edit, with overlap; after the change, 1, 1 and 1. At 0 ms both builds gave 1.
    - The vendor-link variant has no separate pre-change baseline.
  - No coverage gaps flagged. No existing test depended on the old inline debounce.
  - This file was transcribed by main Claude from the agent's inline hand-back, as its header says.
- **backend-architect (post-impl):** not run. The change is frontend-only: no migration, RLS, edge function or `db.ts` change. The design's section 0 file table matches the spec's `## Files changed` list.

**CI gates on `main`** (reported by main Claude, 8431180, 2026-11-23 17:44Z): `test.yml` success, `db-migrations-applied.yml` success, `e2e.yml` success.

## Recommended next steps (ordered)

1. **Commit and deploy, on the owner's explicit go-ahead only.** Stage only these spec 206 paths:
   - `src/lib/inflight.ts`
   - `src/lib/inflight.test.ts`
   - `src/lib/realtimeReloadScheduler.ts` (new)
   - `src/lib/realtimeReloadScheduler.test.ts` (new)
   - `src/hooks/useRealtimeReloadScheduler.ts` (new)
   - `src/hooks/useRealtimeReloadScheduler.test.ts` (new)
   - `src/navigation/CmdNavigator.tsx`
   - `specs/206-realtime-reload-once-per-edit.md` (new)
   - `specs/206-realtime-reload-once-per-edit/reviews/code-reviewer.md`, `security-auditor.md`, `test-engineer.md` and `release-proposal.md` (all new)

   Do **not** stage any of these. They are unrelated uncommitted work:
   - `.claude/agents/*`
   - `CLAUDE.md`
   - `app.json`
   - `specs/181-native-internal-build.md`
   - `src/lib/nativeAppConfig.spec181.test.ts`
   - `specs/205-rls-visibility-once-per-query.md`

   Before staging, run `git diff -- src/lib/inflight.ts src/lib/inflight.test.ts src/navigation/CmdNavigator.tsx` to confirm those three files hold only spec 206 hunks. They were already modified files, and I could not diff them (no shell). Because other specs' work shares the index, use the temp-`GIT_INDEX_FILE` approach from the shared-index commit note if needed.

2. **After the push to `main`:**
   - Confirm the latest runs of `test.yml` and `db-migrations-applied.yml` are green, and check `e2e.yml` by hand.
   - Web deploys through Vercel on the push. There is no prod database step, because there's no migration.
   - Native picks up the change with the next EAS build; this spec doesn't trigger one.

3. **(Optional, not blocking) A separate follow-up for security Low 1.** Either:
   - add `.abortSignal(signal)` to the two orphan-header deletes (db.ts L1780 `createPurchaseOrderDraft`, and the matching line in `upsertVendorDraftOrder` near L1946) and to the storage `.remove()` calls the architect listed (db.ts L5971, L5982, L6022); or
   - add a hold ceiling in the scheduler of about `HARD_ABORT_MS`. Note that this means relaxing R3's "no timer while writes are in flight", so it needs the owner's approval.

4. **(Optional, not blocking) Code-reviewer nits,** in one tidy-up pass if wanted:
   - add a one-line comment for `Promise.resolve(p)`;
   - renumber the repeated hook-test case labels;
   - wrap the post-unmount `handleSync()` in `act`;
   - keep the two defensive branches with their "defensive" comments as they are now, or drop them.

   None of these change behaviour.

5. **(Optional) Local environment:** run `npm ci`, or delete the `node_modules/@types/* 2` folders, so `npm run typecheck` is clean locally.

## Out of scope for this review

- **Fire-and-forget tails still overlap.** `items_last_counted` and the other tails can still overlap the next reload. Fixing that means changing `loadFromSupabase`, which the spec puts out of scope; it is a spec residual risk.
- **Narrowing the unfiltered `fetchInventory()`** to the current store (slowness finding 3).
- **The explicit post-mutation reloads:** `applyVendorsToAllStores`, `stockStoreFromStore` and `receivePurchaseOrder`. These and the store-switch loads still bypass the scheduler (slowness finding 5).
- **The RLS per-row cost.** That is spec 205, which is in progress in the working tree and must not be bundled with this commit.
- **Resetting `useInflight` on logout** (security Low 2). Only worth a spec if `hasWriteInflight` ever comes to be treated as per-user state.
- **Late self-echo.** If a realtime echo arrives after a reload has started, it adds one extra reload. It wasn't seen locally. If prod telemetry shows 2 reloads per edit, that needs a new owner decision, because self-echo windows and payload matching are explicitly not approved.
