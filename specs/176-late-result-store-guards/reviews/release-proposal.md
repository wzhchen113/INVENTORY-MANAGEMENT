# Spec 176 release proposal

Release-coordinator synthesis, 2026-10-26 (second pass). The first pass returned FIXES_NEEDED with three blocking items. This pass re-checked each one against the files on disk:
- the spec's `## Open questions resolved` section;
- `reviews/main-verification.md`;
- the working-tree text of `src/store/useStore.ts` at the two comment sites;
- the five reviewer files, re-read for severity.

The change is still uncommitted on top of HEAD `8acecc4` (spec 175), which has not been pushed either.

## Verdict
verdict: SHIP_READY
rationale: No reviewer raised a Critical, AC-1 to AC-24 pass, and the three items that blocked the first pass are now resolved on disk: D-2 owner acceptance is recorded, AC-25 is complete within the limits of the local seed, and both Should-fix comments are corrected.

### Re-check of the three blocking items
1. **D-2 owner acceptance: resolved.** `specs/176-late-result-store-guards.md` L214 under `## Open questions resolved` reads: "The owner accepted D-2 on 2026-10-26, after the post-impl reviews and before commit. The §8 fallback is not used, and D-T2 stays (architect SF-1)." This closes architect SF-1 and the test-engineer's note. The acceptance came from the owner to main Claude; I cannot confirm it independently, but it is now on the record in the spec. No code change follows from it.
2. **AC-25: resolved, with the seed limits noted.** `main-verification.md` now covers every AC-25 bullet:
   - the L3 stale-reload race at desktop: nothing written, 060/160 tails skipped, overlay not stranded;
   - a same-store realtime reload with Ordering open: one reload, then exactly one background `report_reorder_list` refresh, and the loading text never appeared;
   - quick switches in a row: seven at desktop and six at 390x844, both with Ordering open. The overlay never stuck, and the Inventory row ids match the DB for the final store;
   - a clean console in both passes;
   - a "Rows touched" note.

   Limits, none blocking:
   - **Empty reorder list.** The seed returns 0 reorder suggestions, so "keeps the list on screen" was seen as "no loading state, and the 10 brand-wide warnings stayed". The non-empty keep-list case rests on the unmodified spec 175 suites and D-T2.
   - **Switch speed.** The overlay blocks a second UI switch, so "quick succession" means each switch started as soon as the previous overlay cleared.
   - **Slices checked by eye.** Only inventory was checked by row id. Vendors and schedule rest on jest AC-10 and AC-13.
   - **Timestamps.** Two local `updated_at` timestamps were bumped by the trigger and could not be put back. This is the local stack only, and `npm run dev:db:reset` restores the seed. "Restore any rows you touched" is met for column values.
   - **L2.** No browser check is possible on this seed, so it rests on jest only (AC-1 to AC-9, D-T2).
3. **Code-reviewer Should-fix comments: resolved (working-tree text checked).**
   - `useStore.ts:3986-3991`: the parenthetical now ends "but the store switch and the as-of-date change remain." It names the two remaining paths, so the "those two" ambiguity is gone.
   - `useStore.ts:2375-2382`: the R-4 `finally` comment now says "The bump sits right before this `try`, so every load that takes a number reaches this reset". It gives the after-the-probe placement as a separate reason (bail and out-of-order probe never take a number they won't reset) and keeps the accepted-residual sentence. This matches the precise statement at L2153-2158.
   - Main Claude reports `npx jest src/store` (231/231) and `npm run typecheck` green after these comment-only edits. Before them, full `npx jest` (3334/3334) and `npm run typecheck:test` were green.

## Findings summary
- **code-reviewer:** 0 Critical, 2 Should-fix (both now fixed), 10 Nit (2 of them deferred or out of scope).
  - Open optional Nits:
    - the bare "D-2" label in the `loadReorderSuggestions` comment (now L4756);
    - the A′ lead-in wording;
    - the unasserted D-T2 comment at test L359-361;
    - the duplicated stale-drop lines;
    - the `mockReturnValueOnce` queues that `clearAllMocks` does not drain.
  - Convention, structure and scope-fence checks are all clean.
- **security-auditor:** 0 Critical, 0 High, 0 Medium, 3 Low.
  - L1: R-2 reads the list owner live, so an export whose await spans an owner change can still record under the wrong store.
  - L2: `fillCartForVendor`, `createPoDraft` and `approveAndOrder` have no owner check.
  - L3: a stale load still writes `stores`.
  - Spec 175's L2 and L3 are closed on the reachable paths. No RLS, realtime or `verify_jwt` surface is touched.
- **test-engineer:** AC-1 to AC-24 PASS (0 FAIL, 0 NOT TESTED), and D-T1 and D-T2 PASS.
  - Full jest: 266/266 suites, 3334/3334 tests. Both typechecks exit 0.
  - The AC-17 spec 175 tests are unmodified, confirmed with `git diff`. AC-25 was handed to main Claude and is now done (see above).
- **backend-architect (post-impl):** 0 Critical, 1 Should-fix (SF-1, now resolved by the recorded D-2 acceptance), 4 Minor. The implementation matches the design structurally.
  - M-1: the stale "store switch (clear)" clause is still in `src/types/index.ts:758`. Cosmetic.
  - M-2: the AC-20 markers are inconsistent. Cosmetic.
  - M-3 and M-4: informational.
- **main-verification:** AC-25 complete, with the limits listed in item 2 above.

## Recommended next steps (ordered)
1. **Commit (owner confirms).** Optional, same pass: the leftover nits, which do not block and are all comment or test-hygiene fixes.
   - qualify L4756 as "spec 176 D-2";
   - architect M-1 (`src/types/index.ts:758`);
   - the A′ lead-in wording;
   - assert `reorderPayload === FS` at test L359-361, or reword the comment;
   - `mockReset()` plus re-arming in the new suite's `beforeEach`.

   If any of these are taken, re-run full `npx jest` and `npm run typecheck:test`, not just `src/store`. Even without them, project practice is a full `npx jest` run right before commit. The last full run predates the comment-only edits.
2. **Push, then confirm CI (post-push action, not evidence).**
   - After pushing, confirm that the latest runs of **both** `test.yml` and `db-migrations-applied.yml` on `main` are green, and check `e2e.yml` by hand.
   - The push also carries the unpushed spec 175 commit `8acecc4`, so one green run covers both specs.
   - The change is client-only, so the migration gate should be unaffected. A red or in-progress gate still blocks closing the spec under the CLAUDE.md rule.
   - I had no shell in this pass and did not see the current state of `main`'s gates. If either gate is already red before the push, raise that first.

## Out of scope for this review
- **Server-side cross-store `item_id` rejection (proposed spec 177).** This is the owner-approved separate follow-up. It must cover both writers:
  - the `po_items` insert policy (`supabase/migrations/20260504173035_per_store_rls_hardening.sql:216`);
  - `create_order_approval`'s `p_lines` validation (`supabase/migrations/20260801000100_order_approvals.sql:325-345`), which accepts any well-formed UUID today.

  It closes security L1 and L2 for good.
- **Security L2 client guards (owner question).** Two options, either or both:
  - copy the R-2 owner check into `fillCartForVendor`, `createPoDraft` and `approveAndOrder`;
  - clear `reorderPayload` / `reorderStoreId` in the "All brands" placeholder `set`.

  The change is cheap and store-only, but spec 176 did not ask for it. It can be its own small spec or part of 177.
- **Security L1.** Carry `ownerStoreId` in `ExportRecordingContext`. This is a UI change, so it needs a future spec, and 177 also closes it.
- **Security L3.** Guard the `stores` write with the probe's identity. This predates spec 176 and is optional hardening.
- **Architect M-3 / M-4.** Informational only, with no change requested.
- **Code-reviewer deferred nits.** The frozen spec 175 test comments (L512-561) and the spec 111 "every load path funnels through here" sentence (`useStore.ts:2373-2374`). Both belong in the separate comment sweep.
- **Out of scope per the spec:**
  - out-of-order same-store reorder loads;
  - tails started by a current load that settle after a later switch;
  - `buildDraftOrderLines` membership filtering;
  - the `reorderLoading: false` in the A′ clear spread.

## Handoff
next_agent: NONE
prompt: SHIP_READY. All 3 earlier blockers are resolved on disk (D-2 acceptance recorded, AC-25 complete, both Should-fix comments fixed). Owner confirms the commit, then runs the post-push gate check (test.yml + db-migrations-applied.yml on main, e2e.yml by hand; the push also carries 8acecc4).
payload_paths:
  - specs/176-late-result-store-guards/reviews/release-proposal.md
