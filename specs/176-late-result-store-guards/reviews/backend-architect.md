# Spec 176 — backend-architect post-implementation drift review

Reviewer: backend-architect (post-impl mode), 2026-10-26.
Baseline: `main` at `8acecc4` plus the uncommitted working tree (`src/store/useStore.ts`, `src/types/index.ts`, four modified test files, and the untracked `src/store/useStore.lateResultGuards.spec176.test.ts`).
Measured against: `## Backend design` in [specs/176-late-result-store-guards.md](../../176-late-result-store-guards.md).

**Method caveat:** this session had no shell, so I could not run `git diff`. I read the working-tree content of every changed file and compared it with the design. Claims that a region is "unchanged" (the spec 152 bail block, the A′ code, the spec 175 `:511` / `:540` tests) rest on reading the current text, which matches the design pseudocode. For the two spec 175 tests, they also rest on line offsets: both moved by exactly +2, which matches the two edits above them. Before shipping, a reviewer with a shell should confirm with `git diff 8acecc4 -- src/store/useStore.reorderReload.spec175.test.ts` that the hunks touch only `:208`, `:496` and `:562`.

## Verdict

**No Critical findings. One Should-fix (process, not code). Four Minor findings.** The implementation matches the design on every structural point I was asked to check.

## Conformance checklist

| Design item | Where | Result |
|---|---|---|
| §2.1 `latestForegroundReorderGen` module-level, next to `reorderRequestGen` | [useStore.ts:242-252](../../../src/store/useStore.ts) | Matches. Only writer is L4760. `startSilentReorderRefresh` never touches it (doc clause at L282). |
| §3.1 `loadFromSupabaseGen` module-level | [useStore.ts:254-263](../../../src/store/useStore.ts) | Matches. Only reads/writes are L2159 and L2380. |
| N1 / R-4 counter placement: after the probe and the `sessionLost` retire, in the same synchronous step as `storeLoading: true`, with `try` opened right after | [useStore.ts:2150-2161](../../../src/store/useStore.ts) | Matches exactly. `!sid` (L2099) runs before any bump. The spec 152 bail block (L2131-2149), including the identity-moved early return at L2139, reads as unchanged (AC-16). |
| R-4 gated `finally` | [useStore.ts:2380](../../../src/store/useStore.ts) | Matches: `if (loadGen === loadFromSupabaseGen) set({ storeLoading: false, switching: null })`. Comment keeps "single reset point" and adds the probe-window residual. |
| R-3 drop, `__all__` branch: after `Promise.all`, before `set`, inside `try` | [useStore.ts:2181](../../../src/store/useStore.ts) | Matches. Same expression as the single-store drop (`sid !== get().currentStore?.id`). `finally` still runs. |
| R-3 drop, single-store branch: after `fetchAllForStore`, before `const before = get()` | [useStore.ts:2219](../../../src/store/useStore.ts) | Matches. No `await` between the check and `before` / the `set`. Every tail (L2336-2364) sits after the `set`, so a drop skips all of them. |
| R-3 `stores` write unchanged | [useStore.ts:2163-2166](../../../src/store/useStore.ts) | Unchanged, and it runs before both drops (AC-13). |
| AC-17 A′ code text unchanged apart from comments | [useStore.ts:2247-2253](../../../src/store/useStore.ts), spread at L2301-2307 | Code reads as unchanged. Comments updated as §3.5 asks: KEEP / CLEAR / SILENT REFRESH bullets, plus the reorder spread sentence at L2294-2295. The R1-timing paragraph and the `lastOrderContext` window note were left alone, as designed. |
| R-1 / D-2 in `loadReorderSuggestions`: bump, then marker, then `reorderLoading: true` in one synchronous step | [useStore.ts:4759-4761](../../../src/store/useStore.ts) | Matches. |
| R-1 success path: stale check before the existing `set`, gated reset, `return` | [useStore.ts:4764-4768](../../../src/store/useStore.ts) | Matches. The non-stale `set` is unchanged. |
| R-1 failure path: `console.warn` on both stale and non-stale, then stale check, gated reset, `return` | [useStore.ts:4770-4776](../../../src/store/useStore.ts) | Matches. A dropped failure never writes `reorderError` and never toasts. |
| R-1 "never drop on generation alone" | same | Holds. The non-stale paths never read `gen`. |
| R-2 placement: after `!storeId` / `'__all__'`, after the `currentStore` refusal, after `!referenceDate`; before `createdByUserId`, `buildDraftOrderLines` and `recordingKeys.add`; synchronous | [useStore.ts:4028-4034](../../../src/store/useStore.ts) | Matches §4 order steps 1-5. There is no `await` before it. |
| R-2 message and context | [useStore.ts:4029-4032](../../../src/store/useStore.ts) | `notifyBackendError('Record exported order', new Error('Reorder list belongs to a different store — not recorded'))`. Byte-identical to the design, including the em dash. |
| R-2 header comment, plus the `reorderPayload` bullet parenthetical | [useStore.ts:3983-3987](../../../src/store/useStore.ts), L4018-4027 | Done. |
| §3.5 `loadReorderSuggestions` doc | [useStore.ts:4746-4755](../../../src/store/useStore.ts) | Done. Covers R-1 on both paths, D-2, and no drop on generation alone. |
| §6 types doc | [src/types/index.ts:747-748, 757-762](../../../src/types/index.ts) | Done, with one wording carry-over (Minor-1). |
| AC-23 scope fence | git status | Holds. Nothing under `src/screens/`, `src/components/`, `src/lib/db.ts`, `supabase/**` or `app.json` changed. `StoreActions` has no new action and there is no new state key. No code path bypasses `db.ts`. |
| Data model, RLS, realtime | n/a | No migration, RLS, RPC, edge-function or publication change, as designed. The `po_items.item_id` gap remains the out-of-scope server-side follow-up. |

### Tests against §7

- **New suite** [src/store/useStore.lateResultGuards.spec176.test.ts](../../../src/store/useStore.lateResultGuards.spec176.test.ts):
  - It follows the §7.1 harness: the spec 175 mocks, `hasActiveSession → true`, replace-reset `INITIAL_STATE`, `beforeEach` re-arming `fetchAll` / `fetchStores` / `upsertVendorDraftOrder`.
  - Both harness rules are honored. AC-15 and D-T1 assert the newer load's `fetchAllForStore` call before settling the older load (L645, L683). Every deferred is settled, including AC-5's silent `dS` (L360).
  - Anti-vacuity asserts are present on every drop case: AC-1 to AC-4 via `startA` (L260), AC-10 and AC-11 via `startStaleA` (L497), AC-12 (L546-547), and AC-13 stale (L560).
  - AC-7 asserts a single toast whose `text2` starts with the R-2 prefix and differs from the store-change text, as §7.1 asks.
  - The suite adds a P2 null-owner case (L428) and a §4 "undated stays silent" case (L476). Both pin design decisions.
  - **D-T1** (L663-703) matches §7.2. Under bump-after-probe L1 ends up holding the counter and resets. Under bump-before-probe it strands. The developer reports mutation-checking this.
  - **D-T2** (L705-738) matches §7.2 step for step. It includes the silent refresh landing (L733-736), which proves silent refreshes are no longer suppressed.
- **AC-19**, [useStore.reorderReload.spec175.test.ts:208-228](../../../src/store/useStore.reorderReload.spec175.test.ts): the mid-fetch `setState({ currentStore: store('B') })` is removed. The title, the `record()` pairing loop and every assertion are kept, and the cross-reference comment is added. Matches §7.3.
- **AC-20**, same file at L496-498: `seedSameStore({ reorderError: 'kept', currentStore: store('__all__') })`. Matches.
- **AC-18**, same file at L564-579: retitled. It captures `before`, asserts `fetchAll('S')`, asserts `fetchReorder` was not called, checks `toBe(P)` identity and `reorderFields()` equality, and cites the `:446` case. Matches §7.3.
- **AC-17**: the `:513` race test and the `:542` stale-owned test read as unmodified (see the method caveat).
- **AC-20**, [useStore.lastCounted.spec160.test.ts](../../../src/store/useStore.lastCounted.spec160.test.ts): `currentStore` is seeded before every `loadFromSupabase` call (L136, L204, L250, L271/L274), and `'__all__'` at L228. Matches.
- **AC-20**, [useStore.lastOrderContext.spec151.test.ts:142-143](../../../src/store/useStore.lastOrderContext.spec151.test.ts): `store-2` is seeded before the load. Matches.
- **AC-21**, [useStore.recordExportedOrder.spec156.test.ts:139](../../../src/store/useStore.recordExportedOrder.spec156.test.ts): `reorderStoreId: 'store-1'` added to the top-level `beforeEach`. Matches.
- **Grep sweep**: I independently checked the other `loadFromSupabase(` callers in `src/**/*.test.*`. `useStore.sessionLoss.spec152.test.ts` loads only `'s1'`, with `currentStore = s1` seeded at L112. `PhoneOrdering.reorderReload.spec175.test.tsx` loads `'store-1'`, with `store-1` seeded at L166. Neither needs an edit. Neither is in git status, so AC-16 and AC-22 hold.

## Findings

### Critical

None.

### Should-fix

**SF-1. The spec does not record that the owner accepted D-2 (process, not code).**
- Design §2.3 and §8 asked main Claude to relay D-2 to the owner before or alongside dispatch. D-2 is the change that gates R-1's `reorderLoading` reset on the newest *foreground* request instead of the literal `reorderRequestGen` reading.
- `## Files changed` says "D-2 implemented as designed", but nothing in the spec records the owner's acceptance.
- The code is correct under D-2, and D-T2 pins it. But R-1's text, and the "Newest reorder request" definition it uses, still describe the literal rule.
- **Action:** before SHIP_READY, release-coordinator should confirm the owner accepted D-2, and a one-line note should go in the spec, e.g. under "Open questions resolved".
- If the owner rejects D-2, the fallback in §8 applies: revert the gate to `gen === reorderRequestGen`, drop D-T2, and record the strand as a known defect.

### Minor

**M-1. A types doc keeps a phrase the design asked to replace.**
- [src/types/index.ts:757-759](../../../src/types/index.ts) still says the comparison is used "to tell a store switch (clear) from a same-store reload (keep plus silent refresh)".
- §6 asked for this to be replaced by the "compared with the CURRENT store" framing. The developer added that framing but kept the old clause too.
- It is not wrong: a foreign owner is still, in practice, the result of a switch. But since spec 176, the real distinction is foreign owner versus current owner. This is a cosmetic fix and can wait for a comment sweep.

**M-2. "Spec 176 AC-20" markers are applied inconsistently in the spec 160 suite.**
- [useStore.lastCounted.spec160.test.ts](../../../src/store/useStore.lastCounted.spec160.test.ts) labels the seeds at L135 and L227 but not those at L204, L250 or L271/L274.
- These are cosmetic only. Leave them unless the file is touched again.

**M-3. Informational: R-2 can refuse a legitimate export after an A → B → A round trip.**
- Sequence: an export starts on B, the user switches to A, then back to B while the share sheet is open, and the record fires after B's A′ clear but before B's foreground reload lands. The owner is then `null`, so R-2 refuses with "Reorder list belongs to a different store" even though the snapshot lines were B's.
- This is the safe side by design (P2), the window is narrow, and the toast is actionable (re-export).
- No change requested. It is noted so the message text is not later read as a bug report. The old store-change guard alone would have recorded in this case.

**M-4. Informational: a dropped load can still briefly raise `storeLoading`.**
- In the D-T1 sequence, a dropped older load whose probe resolves last writes `storeLoading: true` after the newer load has already cleared it. Spec 055 skeletons can then re-show until that dropped load's fetch settles. Its `finally` then resets, because it holds the counter. `switching` stays `null`, so the spec 111 overlay itself does not reappear.
- This is pre-existing behavior (every load writes `storeLoading: true` before fetching) and sits inside the §3.3 accepted residual. It is not a strand, and the change narrows it.
- No action. A future spec could move the `storeLoading: true` write behind a "still current" check if the flash ever matters.

## Open items outside this review's scope

- The AC-25 browser check is still open (per `## Files changed`). It belongs to main Claude or test-engineer.
- After the push, check that `test.yml` and `db-migrations-applied.yml` are green on `main`, and check `e2e.yml` by hand. This is client-only, so the migration gate should be unaffected.

## Handoff
next_agent: NONE
prompt: Architectural drift review complete. 0 Critical, 1 Should-fix (owner acceptance of D-2 not recorded in the spec), 4 Minor.
payload_paths:
  - specs/176-late-result-store-guards/reviews/backend-architect.md
