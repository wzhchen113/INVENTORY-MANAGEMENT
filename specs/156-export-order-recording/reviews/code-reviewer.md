# Code review for spec 156

Scope reviewed: `src/store/useStore.ts` (D-1/D-2/D-4 regions), `src/screens/cmd/sections/ReorderSection.tsx`
(3 call sites + 2 selectors), `src/screens/cmd/sections/phone/PhoneOrdering.tsx` (3 call sites + 1 selector),
and the three new jest files (`useStore.recordExportedOrder.spec156.test.ts`,
`ReorderSection.recordExport.spec156.test.tsx`, `PhoneOrdering.recordExport.spec156.test.tsx`), against the
spec's ACs, the backend design's D-1..D-4/F-1/F-2, and the documented deviation.

Overall: this is a clean, disciplined implementation. The extraction is byte-faithful, the six call sites are
mechanically identical, the in-flight guard is correctly scoped, and every JSDoc/comment traces back to a
specific AC or design section instead of restating "what" the code does. No direct Supabase calls outside
`db.ts`, no inline color literals, no `window.confirm`/`Alert.alert`, no web-only API without a guard (n/a —
no such API touched), no realtime channel changes, no legacy-file edits, no `app.json` touch.

## Critical

None.

## Should-fix

- `src/screens/cmd/sections/ReorderSection.tsx:409,494,503`, `src/screens/cmd/sections/phone/PhoneOrdering.tsx:607,633,647`
  — the safety-net `.catch(() => {})` swallows any rejection with zero trace: no `console.warn`, no
  `notifyBackendError`, nothing. Today this is provably dead code — `recordExportedOrder`'s own `try/catch`
  (`src/store/useStore.ts:3607-3635`) guarantees the returned promise never rejects (D-2 property 3), and the
  test suite exercises that contract directly (`useStore.recordExportedOrder.spec156.test.ts` "a thrown write
  NEVER rejects"). But if a future edit to `recordExportedOrder` ever reintroduces a rejection path (e.g. a
  stray `await` added above the `try`, or a refactor that moves a guard outside the `try`), this catch would
  hide it completely at all six call sites simultaneously, with no console line and no toast — exactly the
  silent-fake-success shape CLAUDE.md calls out from the spec 031/032 history. Suggest
  `.catch((e) => console.warn('[recordExportedOrder]', e))` at minimum, so a contract violation is at least
  visible in the console the way every other failure path in this codebase is.

## Nits

- `src/store/useStore.ts:787` — the `recordExportedOrder` interface entry is typed as a required function
  (`(vendor: ReorderVendor) => Promise<string | null>`), but all six call sites invoke it with `?.` because
  three frozen mocked-`useStore` test suites (AC-REG-1) carry a partial state object with no
  `recordExportedOrder` key at all, cast through `as any`. That's a real and well-justified reason (see the
  Deviation adjudication below), but the mismatch is only explained in six near-duplicate call-site comments,
  not at the one place (`useStore.ts:787`) a reader would look first when wondering why callers guard a
  non-optional field. A one-line addendum to that JSDoc ("call sites use `?.` — the three spec-138/123 frozen
  mocks predate this field") would save the next reader a grep.
- `specs/156-export-order-recording.md:1093-1100` (design §D-3) — the literal call-site snippet in the design
  doc is now stale relative to the shipped shape (`void recordExportedOrder?.(vendor).catch(() => {})` vs. the
  bare `recordExportedOrder(vendor);` written there). The "Files changed" deviation note at the bottom of the
  spec correctly documents this, so it's not a hidden drift, but a future reader who only skims §D-3 and not
  the deviation callout would be misled. (out-of-scope) worth a one-line design-doc amendment at the next spec
  touching this file; not blocking for 156.

## Deviation adjudication — `void recordExportedOrder?.(vendor).catch(() => {})` vs. D-3's bare call

**Verdict: accept.** The deviation is narrow, tested, and forced by two constraints the design itself created,
not by implementer convenience:

1. **The optional call (`?.`) is required by AC-REG-1.** `ReorderSection.spec138.test.tsx`,
   `ReorderSection.spec123.test.tsx`, and `ReorderSection.resetAfterExport.spec138.test.tsx` all mock `useStore`
   with a literal state object that predates this spec and carries no `recordExportedOrder` key (confirmed —
   `ReorderSection.resetAfterExport.spec138.test.tsx:104-124` has no such field). AC-REG-1 is explicit and
   binding: "the existing suites stay green with no edits." A bare `recordExportedOrder(vendor)` call would
   throw `TypeError: recordExportedOrder is not a function` in all three the moment an export succeeds in those
   suites, forcing an edit to files the spec explicitly froze. Editing them was the only alternative, and it's
   the wrong trade — those suites pin FILL-CART's edit-reset timing and the raw export outputs, unrelated
   surfaces this spec must not touch.
2. **The `.catch` is required by the design's own test plan.** §9(b)(9) explicitly specs "recordExportedOrder
   mock rejects → the press still resolves, the clear still happened, no unhandled rejection" — and that
   exact test exists and passes (`ReorderSection.recordExport.spec156.test.tsx` "AC-6 — a failing recorder
   never breaks the export"). `void`-ing an unguarded promise that rejects IS an unhandled rejection in Node/Jest;
   the design asked for a property that the literal D-3 snippet cannot deliver on its own. The `.catch` doesn't
   weaken D-2 property 3 (never-rejects-by-contract) — it makes that contract non-load-bearing at the six call
   sites, i.e. defense in depth for exactly the scenario D-2 already promises won't happen.
3. **Confirmed via source read that neither addition changes the contract.** In both files, the recording call
   remains (a) invoked, not awaited; (b) gated on the same success boolean (`shared` / `ok`) at every site; (c)
   ordered strictly before `clearReorderEditsForVendor(...)` with no `await` in between (verified at
   `ReorderSection.tsx:408-410,493-496,502-505` and `PhoneOrdering.tsx:606-609,631-635,646-649`). JS run-to-completion
   semantics mean everything synchronous inside `recordExportedOrder` up to its first `await` (the
   `db.upsertVendorDraftOrder` call) executes before the call site's next line runs — so D-2 property 1's
   snapshot-before-await discipline is preserved regardless of the `void`/`.catch` wrapping.
4. Optional-chaining short-circuit semantics were verified: `recordExportedOrder?.(vendor).catch(() => {})` is a
   single OptionalChain: when `recordExportedOrder` is `undefined`, the ENTIRE expression (including the
   trailing `.catch(...)`) short-circuits to `undefined` without evaluating `.catch` — there is no risk of a
   `Cannot read property 'catch' of undefined` in the three frozen suites.

The only cost is the Should-fix above (silent swallow with no logging) — real but low severity given the
underlying contract is independently pinned by its own test.

## Extraction fidelity (buildDraftOrderLines) — ★ spec-104 bridge

`src/store/useStore.ts:168-186` is a verbatim structural match to the pre-refactor inline builder and to its
sibling `buildOrderApprovalLines` (`useStore.ts:113-134`): same `edits[itemId] ?? (suggestedUnits || suggestedQty || 0)`
overlay, same `costPerUnit * subUnitSize` ★ bridge (subUnitSize resolved from `inventory` by `itemId`, defaulting
to 1 — not dropped), same `itemId && orderedQty > 0` filter. `fillCartForVendor` (`useStore.ts:3518-3572`) is
refactored to call it with everything else byte-identical, and the parity is pinned by an executable test
(`useStore.recordExportedOrder.spec156.test.ts` "PARITY: its output deep-equals the lines fillCartForVendor
passes to the writer", driven through the real `fillCartForVendor` action, not a duplicated fixture). This is
the single easiest place for this spec to silently mis-cost every recorded order (R-2 in the design's risk
table) and it's correctly guarded.

## Six call sites — gating / ordering

All six sites (`ReorderSection.tsx:408-410` quick-order, `:493-496` CSV both branches, `:502-505` PDF;
`PhoneOrdering.tsx:606-609` quick-order, `:631-635` CSV both branches, `:646-649` PDF) gate the record call on
the exact success boolean the spec-138 edit-clear already used (`shared` / `ok`), invoke the record call
un-awaited, and place the record call strictly before `clearReorderEditsForVendor(...)` with no intervening
`await`. The CSV sites each fire exactly one record call after the `if (ok)` covering both the generic and the
US-FOODS/SYSCO import branch, matching D-3's table exactly (not one call per branch). Store selectors
(`recordExportedOrder`) are declared at the top of each component body alongside the existing
`clearReorderEditsForVendor` selector, never inside a conditional or callback (AC-REG-8).

## In-flight `Set` (F-1 / D-4)

`recordingKeys` (`useStore.ts:203`) is module-level, not Zustand state (correctly avoids a re-render on every
export). The key is added only after the AC-4/AC-5 guards pass and immediately before the first `await`
(`useStore.ts:3604-3606`), and released in a `finally` that wraps the write and the post-write refresh
(`useStore.ts:3632-3635`), so a thrown error or an inflight timeout can't wedge it. Tests cover the double-fire
collapse, the release-after-resolve re-open, cross-vendor non-interference, and release-on-throw
(`useStore.recordExportedOrder.spec156.test.ts` "D-4" describe block) — all pass through the real
implementation, not a stub.

## Snapshot-before-await discipline (D-2 property 1)

Verified by direct read: `storeId`, `createdByUserId`, `referenceDate`, and the built `lines` (via
`buildDraftOrderLines`, itself pure and synchronous) are all resolved in `recordExportedOrder`
(`useStore.ts:3581-3598`) before the function's only `await` (`db.upsertVendorDraftOrder` at `useStore.ts:3608`).
No test exercises the specific regression scenario (a future edit moving one of these reads below the `await`)
directly — that would require a test that fires `recordExportedOrder` unawaited, synchronously mutates
`reorderEdits` before the write resolves, and asserts the write still reflects the pre-mutation values. That's
a coverage question, not a code-correctness one (the code is right today), so it's noted here for visibility
but left to test-engineer's lane rather than raised as a finding.

## Handoff

next_agent: NONE
prompt: Code review complete. 0 Critical, 1 Should-fix, 2 Nits. Deviation (void-optional-catch wrapper on the
  six recordExportedOrder call sites vs. D-3's bare call) is adjudicated ACCEPT — forced by AC-REG-1's frozen
  mocks plus the design's own no-unhandled-rejection test requirement, verified safe via optional-chaining
  short-circuit semantics and JS run-to-completion ordering, and exercised by an explicit "AC-6 at the seam"
  test.
payload_paths:
  - specs/156-export-order-recording/reviews/code-reviewer.md
