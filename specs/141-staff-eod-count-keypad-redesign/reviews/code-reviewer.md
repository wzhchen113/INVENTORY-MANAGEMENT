# Code review for spec 141

Scope reviewed: `src/screens/staff/components/BottomSheet.tsx`,
`src/screens/staff/lib/eodKeypad.ts` (+ `.test.ts`),
`src/screens/staff/screens/eod/StaffEodCountRow.tsx` (+ `.test.tsx`),
`src/screens/staff/screens/eod/StaffKeypadSheet.tsx` (+ `.test.tsx`),
`src/screens/staff/screens/EODCount.tsx` (+ `.test.tsx`),
`src/screens/staff/i18n/{en,es,zh-CN}.json`. Cross-checked against
`src/lib/eodKeypad.ts` (unmodified), `src/screens/staff/lib/countOrder.ts`,
`src/screens/staff/theme.ts`, `src/components/cmd/ResponsiveSheet.tsx`
(reference idiom), and `src/screens/staff/components/ListRow.tsx`.

## Critical

None found.

- **AC-REG-8 verified.** Grepping the repo for `spec 141`/`Spec 141` markers
  returns exactly the 9 files listed under the spec's `## Files changed`, all
  under `src/screens/staff/`. Nothing under `supabase/` references this spec,
  and `src/lib/db.ts` is untouched. `src/lib/eodKeypad.ts` (the one `src/lib/`
  file the staff barrel imports) still carries only its original spec-140
  header — no spec-141 edit. The staff barrel
  (`src/screens/staff/lib/eodKeypad.ts`) is a pure 4-symbol re-export, matching
  the `countOrder.ts` precedent (OQ-C).
- **BottomSheet.tsx is clean.** No `@gorhom`, no `Reanimated`, no import from
  `src/components/cmd/` — only comments reference `ResponsiveSheet` by name
  for provenance. Every color/dimension comes from `useStaffColors()` /
  `useStaffTokens()` / `useStaffElevation()`; no hex/rgba literal in the file
  (OQ-B honored).
- **No note field, cleanly omitted.** `StaffKeypadSheetProps` has no `notes`
  field, no `TextInput` is rendered, and `StaffKeypadSheet.test.tsx:108-113`
  pins `UNSAFE_queryAllByType(TextInput)` to zero. This matches OQ-A's
  resolution — not a half-wired control.
- **i18n parity confirmed.** All ten additive keys
  (`eod.sheet.{close,casesWell,runningTotal,skip,nextItem,done,backspace,title}`,
  `eod.row.{counted,uncounted}`) exist in `en.json`, `es.json`, and
  `zh-CN.json`.
- **Store writes go through the existing setters.** `onKey` in `EODCount.tsx`
  (lines 406-417) mutates only via `setCaseCounts`/`setUnitCounts` — no new
  store fields, no `useStaffStore` slice change, matching §11 of the spec.

## Should-fix

- `src/screens/staff/screens/EODCount.tsx:863-893` (`renderEodRow`) —
  re-derives `counted` inline (`caseRaw.trim() !== '' || unitRaw.trim() !== ''`)
  instead of calling the `isCounted` callback already memoized a few dozen
  lines above (lines 377-381) for the exact same predicate. Combined with the
  `isBlank` re-implementation inside `onSubmit` (lines 702-703), the "cases OR
  units non-blank" rule now exists in **three** independent places in one
  file. `isCounted` was added specifically for this spec's keypad feature —
  it should have replaced the other two inline copies (or all three should
  call one shared local function) so a future tweak to the counted-once rule
  can't drift between the row, the gate, and `isDone`/`advance`. Suggest:
  `renderEodRow` calls `isCounted(item)` directly; `onSubmit`'s `isBlank` can
  stay as `!isCounted(it)` or be replaced outright.
- `src/screens/staff/screens/EODCount.tsx:1326-1342` — dead code / stale
  comment left over from the old DOM-focus jump path. The comment
  ("`jump to first uncounted row` scroll (pendingFocusId effect) can reach ANY
  row") and the `onScrollToIndexFailed` handler both describe a
  `scrollToIndex`-driven reveal that no longer exists: the spec-141
  `pendingFocusId` effect (lines 683-691) now opens the keypad sheet directly
  by id and never calls `scrollToIndex` anywhere in this file. `listRef` /
  `onScrollToIndexFailed` are therefore unreachable dead code, and the
  un-windowed `initialNumToRender`/`maxToRenderPerBatch`/`windowSize` tuning
  that this comment justifies is now solving a problem (row must be mounted to
  be scrolled/focused) that the sheet-based jump no longer has (the spec
  itself notes at §8 AC-REG-1 that "the target no longer has to be
  rendered/un-hidden first"). Spec §8 explicitly permits keeping `listRef`
  "harmlessly," but the comment block should be updated to say why (or the
  handler dropped) rather than describing behavior that was just removed —
  this is exactly the "no dead code from the old inline-input path" bar the
  spec calls out. Low risk (harmless no-op), but worth a follow-up cleanup
  pass rather than shipping a misleading comment.

## Nits

- `src/screens/staff/screens/EODCount.tsx:5` — the file-header comment still
  says "scrollable item list with **decimal-pad inputs**," which is stale
  after this rewrite (wells + keypad sheet). Doesn't affect behavior, just
  drifts from what a new reader will see in the JSX below.
- `src/screens/staff/screens/eod/StaffKeypadSheet.tsx:69` vs
  `StaffEodCountRowProps.hasPack` — `StaffEodCountRow` takes `hasPack` as an
  explicit prop (computed once by the orchestrator), while `StaffKeypadSheet`
  independently recomputes `const hasPack = (item.caseQty ?? 0) > 1;` from the
  `item` it's given. Same formula, two call sites; harmless today since both
  read `item.caseQty` directly, but a mild API inconsistency between the two
  new sibling components — pick one convention (prop vs. derive-from-item) if
  either is touched again.
- `src/screens/staff/screens/eod/StaffEodCountRow.tsx:133,152` and
  `StaffKeypadSheet.tsx:108,160` — `item.caseQty as number` assertions inside
  `hasPack ? … : …` branches. Logically safe (hasPack ⇒ caseQty > 1 ⇒
  non-null) but an `as` cast rather than a narrowing check; a
  `item.caseQty ?? 0` would avoid the assertion entirely at negligible cost.
- (out-of-scope) `src/screens/staff/screens/EODCount.tsx:864-873` — the
  cases/units total math (`cases * (caseQty || 1) + units`) is now
  independently duplicated at three sites in this file (`renderEodRow`,
  `sheetTotal`, and the `onSubmit` entry builder). This duplication predates
  spec 141 (the admin equivalent has the same shape) and the spec explicitly
  calls it "existing math" to preserve byte-for-byte, so not flagging as
  should-fix, but a future consolidation would remove real drift risk.

## Summary

The redesign is a faithful, well-scoped re-implementation: no backend
surface touched, no forbidden imports, no hardcoded palette, note field
cleanly omitted with a test pinning its absence, i18n parity complete across
all three catalogs, and the completeness gate / spec-129 lock-edit / spec-103
custom order / offline-queue regressions all read as correctly preserved and
are exercised by the migrated `EODCount.test.tsx` suite. The two Should-fix
items are both about not fully finishing the cleanup this spec's own
`isCounted`/sheet-based-jump changes should have triggered (duplicate
predicate, stale scroll-jump comment/dead handler) — neither is a behavior
bug, both are quick follow-ups.
