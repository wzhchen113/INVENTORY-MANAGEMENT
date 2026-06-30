# Code review — spec 103 (per-user count-screen custom sort)

Reviewer: code-reviewer. Captured by main Claude from the agent's report
(the agent completed the review but did not persist this file itself).

## Critical

- **`src/screens/staff/components/CountOrderDragList.tsx:86,105` — wrong a11y
  labels on the Weekly screen.** The staff drag row hardcodes
  `eod.reorder.moveUp` / `eod.reorder.moveDown` as the ▲/▼ accessibility
  labels, but this component is ALSO used by `WeeklyCount.tsx`, where the
  correct keys are `weekly.reorder.moveUp` / `weekly.reorder.moveDown` (both
  present in the staff i18n catalog). So every ▲/▼ button in the Weekly Custom
  view announces itself as an EOD action in all locales. Fix: accept an
  `ariaLabelUp`/`ariaLabelDown` prop pair (or a `screen: 'eod' | 'weekly'`
  prop) and thread the correct i18n key from each call site.

## Should-fix

- **`src/screens/cmd/sections/InventoryCountSection.tsx:322,338` — hardcoded
  English error toasts.** `onReorder`/`onResetOrder` use raw `'Could not save
  order'` / `'Check connection and try again'` / `'Could not reset order'`
  instead of `T(...)` keys — the EODCountSection (lines 388/405) uses i18n keys
  three lines away. Add keys under `section.countOrder` and call `T(...)`.
- **`nudge` duplicated** — `src/screens/staff/components/CountOrderDragList.tsx:36-43`
  and `src/components/cmd/CountOrderDragList.tsx:40-47` define identical 7-line
  pure reorder math; only the admin copy is tested
  (`CountOrderDragList.nudge.test.tsx`). It has no `supabase` dep → move it to
  `src/lib/countOrder.ts` next to `applyCountOrder`/`firstUncounted` and import
  in both wrappers (single source).
- **`CountOrderRow` interface duplicated in the staff subtree** —
  `CountOrderDragList.tsx:24` re-declares it instead of importing from
  `./CountOrderDragListWeb` (the admin side imports it). Follow the admin
  pattern.
- **`saveCountOrder` abort-mid-way** (`src/lib/db.ts` ~1979-2005; staff
  `src/screens/staff/lib/countOrder.ts:92-103` passes no signal): if the abort
  signal fires between the delete succeeding and the insert, the row is left
  deleted with no error → no revert (the comment claims "revert on thrown
  error", but an abort doesn't throw). Low-risk for a private view pref
  (next drop re-saves) but the comment is inaccurate; consider checking
  `signal.aborted` between the two calls.

## Nits

- `src/lib/countOrder.ts:46` — `applyCountOrder` JSDoc mentions de-dup of
  duplicate saved ids only in prose; promote it to a numbered contract rule
  (the test exercises it).
- `src/components/cmd/CountOrderDragListWeb.tsx:130` (+ staff `:109`) —
  `ref={setNodeRef as any}`; `as React.RefCallback<HTMLDivElement>` is more
  precise than bare `any`.
- `src/screens/cmd/sections/EODCountSection.tsx:364-374` — the vendor-change
  effect resets `viewMode` to default in the early-return guard even when
  uid/vendor didn't change; harmless but could flash a default frame.
- `src/screens/cmd/sections/EODCountSection.tsx:51-52` — the translate hook `T`
  shadows the outer identifier (pre-existing pattern; spec 103 extends it).
- `src/screens/staff/lib/countOrder.ts:18` — stale comment: says
  `saveCountOrder` "branches the `onConflict` target …" but the implementation
  is now delete-then-insert. Update the comment.
