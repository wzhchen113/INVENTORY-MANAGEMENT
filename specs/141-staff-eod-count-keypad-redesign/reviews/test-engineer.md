## Test report for spec 141

### Acceptance criteria status

- AC-1 (indicator replaces red-name; name always `c.text`) → PASS —
  `src/screens/staff/screens/eod/StaffEodCountRow.test.tsx::StaffEodCountRow — indicator`
  (dashed/no-✓ when uncounted, ✓+aria "Counted" when counted, name color pinned
  to `darkColors.text` in both states — the runtime palette is dark per spec
  070/OQ-B, and the test correctly asserts against that, not the stale "light"
  wording in CLAUDE.md's file-map comment).
- AC-2 (row metadata: thumb, UpdatedBadge, unit · case-of-N, running total,
  two wells) → PASS —
  `StaffEodCountRow.test.tsx::StaffEodCountRow — wells` +
  `::StaffEodCountRow — metadata (AC-2)` (CS well only when `hasPack`, `—`
  placeholder, legacy `eod-item-<field>-<id>` ids preserved on the value text,
  running-total line, Updated badge conditional).
- AC-3 (staff `BottomSheet` primitive: RN `Modal`+`Animated`, no
  `ResponsiveSheet`/`@gorhom`/Reanimated import, staff hooks, scrim tap + ✕
  dismiss, no drag) → PARTIAL. Source (`src/screens/staff/components/BottomSheet.tsx`)
  matches the design faithfully (verified by read: `Modal transparent`, scrim
  `TouchableOpacity` → `onClose`, inner swallow-tap, `Animated.Value` slide from
  `vh`→`0`, `useNativeDriver: Platform.OS !== 'web'`, `useStaffColors`/
  `useStaffTokens`/`useStaffElevation`, no PanResponder/gesture code). **But
  there is no `BottomSheet.test.tsx` and no test anywhere presses the
  `staff-sheet-scrim` testID** — every close assertion in
  `StaffKeypadSheet.test.tsx` and `EODCount.test.tsx` goes through
  `eod-sheet-close` (the ✕) only. The scrim-tap-dismiss half of AC-3 is
  source-correct but untested. See Notes.
- AC-4 (tap a well → sheet opens seated on that item, tapped well active;
  header/wells/running-total/digit-pad/footer contents) → PASS —
  `StaffKeypadSheet.test.tsx` (title, both wells, running total, digit keys,
  footer) + `EODCount.test.tsx`'s `enterCount` helper, exercised end-to-end in
  ~15 tests (tap well → `eod-sheet-title` appears → digits land in the correct
  map). AC-4's note-row omission (OQ-A) is explicitly asserted: `renders NO note
  input (OQ-A)` via `UNSAFE_queryAllByType(TextInput)`.
- AC-5 (digit append rules: 0–9 append, single `.`, `⌫` drop, max-5, `'0'`
  valid, writes go straight into `caseCounts`/`unitCounts`) → PASS —
  `src/screens/staff/lib/eodKeypad.test.ts` (barrel re-export identity +
  append/dot/backspace/max-5/`'0'`-valid smoke, mirroring the exhaustive
  `src/lib/eodKeypad.test.ts`) and integration through `enterCount` in
  `EODCount.test.tsx` (case/unit maps update live, feed submit + the gate + the
  indicator, no separate commit step).
- AC-6 (active field defaults by `caseQty`; tapping the other well switches) →
  PASS at both levels — unit: `activeFieldFor` in the barrel test; UI:
  `StaffKeypadSheet.test.tsx::'switches the active field when the inactive well
  is tapped (AC-6)'`; integration: every `enterCount(api, id, field, value)`
  call in `EODCount.test.tsx` presses the specific well testID and asserts the
  value lands under that field, which only passes if `openSheet`'s
  `setActiveField(field)` and `onKey`'s field-routing are wired correctly.
- AC-7 (NEXT ITEM advances w/ wraparound over the full on-screen order;
  DONE ✓ relabel when nothing uncounted; SKIP advances without recording) →
  PARTIAL. Unit-level PASS: `advanceUncounted` wraparound/DONE-null covered in
  both `src/lib/eodKeypad.test.ts` (admin, pre-existing) and the staff barrel
  test. Presentational-level PASS: `StaffKeypadSheet.test.tsx` confirms SKIP/
  NEXT press their callback props and the button relabels to "Done ✓" when
  `isDone=true`. **Gap: no test drives SKIP or NEXT ITEM through a live
  `<EODCount/>` render.** `grep -n "eod-sheet-next\|eod-sheet-skip"
  src/screens/staff/screens/EODCount.test.tsx` returns nothing — the
  orchestrator's own `advance`/`onSkip`/`onNext`/`orderedForAdvance`/`isDone`
  wiring (the `useCallback`s in `EODCount.tsx:397-436`) is exercised only
  indirectly (by the completeness-gate jump test, which sets `sheetItemId` via
  a different code path — the `pendingFocusId` effect, not `advance()`). A bug
  in the real `advance` wiring (e.g. iterating `items` instead of
  `orderedForAdvance` in Custom view, or a stale `sheetItem` closure) would not
  be caught by the current suite. See Notes — this is the most consequential
  gap in the report.
- AC-8 (Today/Yesterday restyled 2-cell strip; `yesterdayIncomplete`
  red-alert + late banner unchanged) → PASS —
  `EODCount.test.tsx::'EODCount — late (yesterday) count'` (no late banner on
  Today, late banner + correct submit date on Yesterday, Today-reminder banner
  shown/hidden by `yesterdayIncomplete`). Still exactly `eod-date-today` /
  `eod-date-yesterday`, `[1, 0]` order preserved in source.
- AC-9 (vendor switcher + submitted-status dot restyled, behavior unchanged,
  single-vendor static label) → PASS —
  `EODCount.test.tsx` single-vendor label test, chip-switcher test, and
  `'spec 129 vendor status + edit flow'::'colors each vendor chip green
  (submitted) vs red (outstanding)'`.
- AC-10 ("X of N counted" progress, same `countedNum`/`items.length`
  derivation, optional progress bar) → PASS (derivation) — `countedNum` is
  exercised throughout every submit/gate test in `EODCount.test.tsx` (the gate
  literally blocks on it). The new `eod-progress-fill` bar element itself has
  no dedicated width/fill-percentage assertion, but it is a pure derived-style
  read of the same tested `countedNum`/`items.length` values, so this is a
  low-risk, presentation-only gap, not flagged as blocking.
- AC-REG-1 (completeness gate + jump now opens the sheet) → PASS —
  `EODCount.test.tsx::'blocks submit on a fully-blank row → gate toast + opens
  the keypad on the uncounted item'` and the spec-103 custom-order variant
  `'AC-12: the gate jump opens the keypad on the first uncounted in the CUSTOM
  order'` (jump target resolved against the on-screen custom order, not fetch
  order). Toast + `search`-clear + sheet-opens-on-target all asserted.
- AC-REG-2 (counted-once — cases OR units non-blank) → PASS — exercised
  throughout (`'includes a row when ONLY Units is filled'`, `'...ONLY Cases is
  filled'`, indicator tests in `StaffEodCountRow.test.tsx`). `fetchItemsForVendor`
  / `item_vendors` querying is untouched (verified by reading the unmodified
  fetch helper in `EODCount.tsx`).
- AC-REG-3 (spec-129 state machine, locked read-only wells, no keypad on
  locked tap) → PASS — full `'EODCount — spec 129 vendor status + edit flow'`
  block (UNSUBMITTED editable, post-submit locks + "Edit", SUBMITTED_LOCKED on
  load, Edit→editable+Cancel, Cancel reverts+re-locks, re-Submit from EDITING,
  vendor-switch resets `editing`) plus
  `StaffEodCountRow.test.tsx::'locked wells are disabled and do NOT open the
  keypad (AC-REG-3)'`.
- AC-REG-4 (offline queue: `useEodSubmit`/`eodQueue`/`QueueIndicator`, all
  outcome branches) → PASS — `git diff` confirms
  `src/screens/staff/hooks/useEodSubmit.test.ts` and
  `src/screens/staff/lib/eodQueue.test.ts` are byte-unmodified (untracked diff
  is empty for both) and both ran green in the full suite. `EODCount.test.tsx`
  covers `success` / `success-replay` / `forbidden` / `queued` / generic-error
  toasts, all via the well+sheet entry path (`enterCount`) rather than the old
  inline inputs — same assertions, migrated entry mechanism.
- AC-REG-5 (date window `dayOffset ∈ {0,1}` only, submit-time date capture) →
  PASS — `'captures the date at submit time, not at mount time (spec §11 risk
  c)'` and the yesterday-submit-date test. No code path adds a third date
  option; `[1, 0]` is the only offset set rendered.
- AC-REG-6 (spec-103 `CountOrderDragList`, Default⇄Custom, drag-disabled-while-
  searching, shared `renderEodRow`) → PASS — `'EODCount — spec 103 custom
  order'` block: opens in Custom view from a saved order, AC-9 byte-identical
  submit payload regardless of view, AC-12 gate jump follows custom order,
  Reset returns to default. `renderEodRow` is confirmed (by reading
  `EODCount.tsx:863-893`) to be the single shared callback fed to both the
  `FlatList` and `CountOrderDragList`/`ScrollView` branches, so Custom is
  provably byte-identical.
- AC-REG-7 (i18n + search + per-store) → PARTIAL. i18n: PASS, machine-guarded
  — `src/screens/staff/i18n/i18n.test.ts` flattens all three catalogs and
  fails on any key/placeholder mismatch; the ten new `eod.sheet.*`/`eod.row.*`
  keys are present with EN/ES/中文 values (verified by reading the three
  catalog diffs) and the full suite (which includes this test) is green.
  Per-store scoping: PASS by inspection — `activeStore.id` keys every fetch,
  untouched by this diff. **Search-narrows-the-list: NOT TESTED — pre-existing
  gap, not introduced or regressed by this spec.** `grep -n "eod-search"
  src/screens/staff/screens/EODCount.test.tsx` and the same grep against
  `git show HEAD:...EODCount.test.tsx` both return nothing — no test (before or
  after this change) exercises the search box narrowing `visibleItems`, and
  there is no `matchesQuery.test.ts`. The `search` code path itself is
  unmodified by this diff. Not a regression, but AC-REG-7's "search still
  narrows" clause has zero test evidence either way. See Notes.
- AC-REG-8 (no backend delta) → PASS — verified directly:
  `git diff --stat -- supabase/` and `git diff --stat -- src/lib/db.ts` both
  return empty; `src/lib/eodKeypad.ts` / `src/lib/eodKeypad.test.ts` are
  untracked-as-modified (git diff empty) — the staff barrel is a pure
  read-only re-export. `git status --porcelain` shows only staff-subtree files
  modified/added.

### Test run

```
npx jest > te141.log 2>&1; echo $?
```
Exit code: `0`.
```
Test Suites: 144 passed, 144 total
Tests:       1496 passed, 1496 total
Snapshots:   2 passed, 2 total
Time:        5.027 s
Ran all test suites in 2 projects.
```
No failures. (Console noise: expected `act(...)` warnings from
`fetchYesterdayIncomplete`'s async `setState` and one expected
`notifyBackendError` warn from a deliberately-failing-RPC test — both
pre-existing patterns, not new failures.)

```
npm run typecheck        → tsc --noEmit           → exit 0, no errors
npm run typecheck:test    → tsc -p tsconfig.test.json --noEmit → exit 0, no errors
```

Track classification per spec 022 / this spec's own `## Project-specific notes`
(**jest track only** — no pgTAP, no shell smoke, no DB/RLS/edge-function
surface touched): confirmed correct. `git diff --stat -- supabase/` is empty,
so `npm run test:db` / `npm run test:smoke` are correctly out of scope for this
spec and were not run.

### Notes

- **Most consequential gap — AC-7 orchestrator wiring untested.** The pure
  advance-with-wraparound logic (`advanceUncounted`) is well covered in
  isolation, and the presentational `StaffKeypadSheet` is confirmed to call its
  `onSkip`/`onNext` props — but nothing in `EODCount.test.tsx` presses
  `eod-sheet-next` or `eod-sheet-skip` against a live component and asserts the
  sheet actually re-seats on the next uncounted item, wraps around the full
  on-screen order (including the Custom-view divergence the spec calls out at
  §7 as "intentional and testable"), or that the button visibly relabels to
  "Done ✓" and closes on tap once every item is counted through real state.
  Recommend adding 2-3 integration tests to `EODCount.test.tsx` before ship:
  (1) open a 3-item list, count item 1, tap NEXT ITEM from item 1 → sheet
  re-seats on item 3 (skipping counted item 2 or whichever remains uncounted);
  (2) count everything except the currently-seated item, tap NEXT ITEM → button
  read "Done ✓" and closes the sheet on tap; (3) same NEXT-ITEM advance
  performed once in Custom view to prove `orderedForAdvance` (not `items`) is
  what's iterated. This is a coverage gap, not a known bug — I did not observe
  incorrect behavior, only absence of an integration-level test for a path the
  spec itself flags as a deliberate, "testable" divergence from the admin
  build.
- **AC-3 scrim-tap dismiss untested.** No `BottomSheet.test.tsx` exists and no
  test anywhere presses the `staff-sheet-scrim` testID. The ✕-close path is
  well covered transitively via `StaffKeypadSheet.test.tsx`. Source inspection
  shows the scrim `TouchableOpacity` correctly wires `onPress={onClose}` and
  the inner sheet body swallows taps so they don't fall through — this reads
  as correct, but it is source-correct-but-untested. A cheap fix: a small
  `BottomSheet.test.tsx` pressing `staff-sheet-scrim` and asserting `onClose`
  fires, plus asserting a press *inside* the sheet body does NOT call
  `onClose` (the swallow guard). Recommend before ship, low effort.
- **AC-REG-7 search-narrows-the-list has zero test coverage, before or after
  this spec.** Confirmed via `git show HEAD:` that this predates spec 141 —
  the search code path (`matchesQuery`, `visibleItems` filtering) is
  byte-unmodified by this diff, so this is not a regression the developer
  introduced, and I am not blocking on it as a spec-141 defect. Flagging it
  because AC-REG-7 explicitly names "the ingredient-name search... still
  narrows the list" as a preserved behavior with no test backing that claim
  either way. Recommend a follow-up ticket (not this spec) to add a search
  test to `EODCount.test.tsx` and a `matchesQuery.test.ts` unit test.
- **OQ-A (note field omission) is correctly implemented and explicitly
  tested-for-absence** — `StaffKeypadSheet.test.tsx::'renders NO note input
  (OQ-A)'` asserts zero `TextInput` elements render inside the sheet. This
  matches the spec's own resolution (§0 OQ-A) that the note row is a flagged
  gap, not a defect, for this build.
- **OQ-B (palette) correctly implemented.** `useStaffColors()` is confirmed
  (by reading `src/screens/staff/theme.ts:148-150`) to be pinned to the DARK
  palette unconditionally (spec 070), and every new component
  (`BottomSheet`, `StaffEodCountRow`, `StaffKeypadSheet`) consumes the hooks
  rather than hardcoding a palette. `StaffEodCountRow.test.tsx` correctly
  asserts against `darkColors.text` (not `lightColors`), which is the accurate
  runtime behavior, not a test bug.
- **AC-10 progress-bar fill percentage has no dedicated assertion** — low risk,
  presentation-only, driven by the already-tested `countedNum`/`items.length`
  values. Not blocking.
- **CI note.** The staff `EODCount.test.tsx` suite carries an explicit
  `jest.setTimeout(15000)` comment referencing a prior CI flake (2-core runner
  contention) — this predates spec 141 and was not touched by this diff; noted
  only for completeness, not a new risk.
- **Phone-width staff browser pass** (staff sign-in → store select → open well
  → keypad → advance → submit) is explicitly out of scope for this report per
  the dispatch instructions — that is main-Claude's separate manual/preview-tool
  verification, not covered by the jest run above.
- **Framework discipline.** No new test framework was introduced; all new
  test files (`eodKeypad.test.ts`, `StaffEodCountRow.test.tsx`,
  `StaffKeypadSheet.test.tsx`, migrated `EODCount.test.tsx`) are plain jest +
  `@testing-library/react-native`, consistent with the existing staff-subtree
  convention. No pgTAP or shell-smoke additions were needed or made (no DB/RLS/
  edge-function surface — confirmed by the empty `supabase/` diff).
- **`app.json` slug** — not touched, not implicated by this spec; no action
  needed.
