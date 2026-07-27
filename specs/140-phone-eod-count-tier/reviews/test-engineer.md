## Test report for spec 140

### Acceptance criteria status

**Day strip**
- AC-1 (7-day day strip, ≥44×44 cells, dow/dom mono, status-dot color from
  `deriveDayStatus`, selected = accent border + `accentBg`) → **NOT TESTED**.
  Source-correct: `PhoneEodCount.tsx:213-241` renders exactly this (50×50
  cells, `dotColorFor` maps today→accent / submitted→ok / late→warn /
  draft→info / uncounted→violet / rest→fg3, matching the spec table
  byte-for-byte; selected cell gets `accentBg`/`C.accent` border). No test
  exercises day-cell rendering, selection (`setSelectedIso`), multiple day
  statuses, or the dot-color mapping. The `PhoneEodCount.test.tsx` harness
  fixture (`WEEK`) contains a single `status: 'today'` day and no test ever
  taps a day cell.
- AC-2 (selecting a locked/rest day preserves existing lock/rest gating,
  restyled only) → **NOT TESTED**. Source-correct:
  `PhoneEodCount.tsx:339-355` (rest-day dashed banner) and
  `PhoneEodCount.tsx:495-538` (`locked = isRestDay || isVendorLocked` disables
  wells, shows submitted values, opacity 0.6) and `:403-420` (Edit button swap
  when `isVendorLocked`). The test harness declares `isVendorLocked` /
  `isRestDay` props but **never sets either to `true` in any test** — grep
  confirms zero occurrences of `isVendorLocked={true}` / `isRestDay={true}`
  anywhere in `PhoneEodCount.test.tsx`. This is a real coverage gap for a
  criterion that's explicitly about *regression* safety.

**Vendor tabs + progress**
- AC-3 (vendor tab strip, active 2px underline, per-tab "counted/total" → "✓"
  on submit, counted-once-globally via `hasEntry`/`deriveCountedItemIds`) →
  **PARTIAL / NOT TESTED for the tab UI itself**. The counted-once-globally
  *semantics* are directly tested (see AC-5 — a shared item counted under
  another vendor reads counted via `countedItemIds`), and `perVendorProgress`
  (`PhoneEodCount.tsx:177-183`) consumes the identical `countedItemIds` set, so
  by code-reading the per-tab math is consistent. But no test ever: renders
  more than one vendor tab (`VENDOR_TABS` fixture is a single-vendor array),
  switches tabs (`setSelectedVendorId`), asserts the "N/M" text, or asserts the
  "✓" swap when `submittedVendorIds` is non-empty (it is always an empty
  `Set` in every test). Source at `PhoneEodCount.tsx:267-303` matches the AC.
- AC-4 (progress row "N OF M COUNTED" + status label + 3px accent bar,
  fill = countedNum/total) → **NOT TESTED**. Source-correct
  (`PhoneEodCount.tsx:307-334`). No test asserts the progress-row text or the
  bar's `width` style.

**Count row**
- AC-5 (20×20 indicator square, dashed/uncounted vs accentBg+✓/counted,
  counted-once-globally, replaces red-name treatment) → **PASS** —
  `PhoneEodCount.test.tsx::"shows ✓ for a counted row and none for an
  uncounted row"` and `::"counted-once-globally: an item counted under ANOTHER
  vendor reads counted here"` (`eod-counted-{id}` testID present/absent).
  Source confirms 20×20 / `CmdRadius.xs` (`PhoneEodCount.tsx:560-574`) and the
  item name is unconditionally `C.fg` on phone (no `rowUncounted ? danger :
  fg` ternary present in `CountRow`), matching AC-5's "replaces" clause — but
  the "name is always fg, never danger" half of the claim is source-verified
  only, not asserted via a color check in any test.
- AC-6 (item name + meta line, two 62×48 wells, empty = dashed + "—", filled =
  panel2 + value) → **PARTIAL / functional PASS, visual details untested**.
  Functional behavior is exercised: tapping a well opens the sheet seated on
  the right item/field (`"tapping a well opens the keypad sheet..."`), and
  entering digits marks the row counted (`"digit entry writes through..."`).
  Source confirms exact 62×48 geometry (`PhoneEodCount.tsx:527-538`) and the
  dashed/"—"-vs-panel2/value swap. No test queries for the literal `'—'`
  glyph, asserts `borderStyle: 'dashed'` vs `'solid'`, or asserts the row meta
  line's counted-suffix (`· {total} {unit}`) distinct from the sheet's running
  total string.
- AC-7 (tap a well → keypad sheet on `ResponsiveSheet`
  `presentation.phone:'bottom-sheet'`; item name/meta/✕; two field wells,
  tapped well = active w/ accent border+accentBg; note input; running total;
  3-col digit pad; footer SKIP/NEXT ITEM; digits append to active field, max 5
  chars/one ".", active field auto-selects CS well when `caseQty>1` else
  units) → **PASS**. Digit-append rules are exhaustively pure-tested in
  `src/lib/eodKeypad.test.ts` (append, single-decimal, backspace, 5-char clamp
  incl. decimal-at-clamp, custom maxLen). Component-level: sheet opens seated
  on the tapped item/field (`"tapping a well opens the keypad sheet seated on
  that item"`), and the active-field-follows-tapped-well rule is exercised by
  `"switching the active field lets the pad write the CS well when caseQty >
  1"` (2 cases × 25 = 50 lb confirms the CS well, not the units-default well,
  received the digit). One gap: the ✕-close / scrim-tap dismiss path
  (`onClose`→`closeSheet`, `PhoneEodCount.tsx:469`) is never exercised by
  `fireEvent` in any test — source-correct (wired to a one-line
  `setSheetItemId(null)`), but untested. `ResponsiveSheet.tsx` itself also has
  no dedicated test file (pre-existing gap, not introduced by 140).
- AC-8 (NEXT ITEM advances to next uncounted w/ wraparound, relabels DONE ✓
  when nothing remains, tapping DONE ✓ closes + toast; SKIP advances w/o
  recording; scrim/✕ dismiss) → **PASS** (advance/wrap/DONE/SKIP); ✕/scrim
  dismiss untested (see AC-7 note, same gap). Pure: `advanceUncounted` is
  exhaustively covered (`eodKeypad.test.ts` — forward search, skip-counted,
  wraparound, "only-uncounted-is-current" edge case, null-on-all-counted,
  null-on-empty-list, negative-fromIndex normalization). Component:
  `"NEXT ITEM advances to the next uncounted item; relabels DONE ✓..."`
  (asserts the button text becomes `DONE ✓`, tapping it closes the sheet, and
  `Toast.show` fires with `text1: 'All items counted ✓'`);
  `"NEXT ITEM wraps around to the top"`; `"SKIP advances without recording the
  current item"` (confirms the skipped item's `eod-counted-a` stays absent).
- AC-9 (`0` is a valid count; row counted iff cases OR units non-blank) →
  **PASS** — `eodKeypad.test.ts::"treats '0' from empty as a valid '0'
  (AC-9)"` asserts `appendKeypadDigit('', '0') === '0'` directly. Minor note:
  the component test titled `"digit entry writes through to the well +
  running total (0 is valid)"` doesn't actually press the `'0'` key (it
  presses `'1'`/`'2'`) — its title over-promises slightly, but the AC-9
  guarantee itself is properly pinned by the pure-module test cited above, and
  `hasEntry`/`localHasEntry` are the pre-existing, unmodified store
  predicates (not new logic to re-verify here).

**Submit gate + post-submit**
- AC-10 (in-flow submit bar: "N LEFT"/"READY"/"SENT ✓" caption + 48px primary
  button; disabled = panel2/fg3, enabled = accent/accentFg) → **PARTIAL /
  NOT TESTED for the state transitions**. Only
  `"the submit button calls the reused onSubmit"` exists, which presses
  `eod-submit` and checks the mock fires — it does not assert the caption text
  in the LEFT/READY/SENT states, nor the disabled/enabled color swap
  (`PhoneEodCount.tsx:388-401,421-448`). Source matches the spec exactly by
  reading.
- AC-11 (submit blocked until every item counted; blocked path clears search,
  jumps/focuses first uncounted item via `pendingFocusItem`, opens its
  sheet) → **PARTIAL — the phone-side bridge is tested, the underlying gate
  is NOT tested anywhere in the repo, old or new**. The child's reaction to
  `pendingFocusItem` becoming non-null (seat item, open sheet) IS tested:
  `"a non-null pendingFocusItem opens the keypad sheet on that item (gate
  jump)"`. But the actual gate logic — the real `onSubmit` in
  `EODCountSection.tsx:783` that blocks on an incomplete count, fires the
  "N remaining" toast, clears search, and calls `setPendingFocusItem` — is
  **never invoked end-to-end by any render-level test**, in this spec's new
  tests (`PhoneEodCount.test.tsx` passes `onSubmit` as a bare `jest.fn()`
  stub) or in any pre-existing `EODCountSection` test (confirmed by
  repo-wide grep: no test file renders `EODCountSection` and presses its real
  submit control — the two existing `customOrder`/`countedOnce` suites only
  exercise the pure `firstUncounted`/`deriveCountedItemIds` helpers in
  isolation). This is a pre-existing gap this spec inherits rather than
  introduces, but the spec's own AC-11 language ("the existing behavior is
  preserved unchanged") asserts a behavior that has no integration test
  proving it, on phone or desktop.
- AC-12 (successful submit: mark vendor submitted, clear draft, drop EDIT,
  toast, navigate to Ordering via `usePaletteAction`) → **NOT TESTED**, same
  reasoning as AC-11 — the real `onSubmit` success path (including the
  `usePaletteAction.getState().request({section:'Ordering', ...})` call) has
  no render-level test anywhere in the repo (repo-wide grep for
  `usePaletteAction` in `*.test.tsx` only turns up
  `InventoryDesktopLayout.test.tsx`, unrelated to EOD submit). Design says
  this path is "reused verbatim," which is true structurally (no new code),
  but "reused verbatim" is not the same as "previously tested" — it wasn't.

**Phone type ramp + hit floors**
- AC-13 (`PhoneType` roles, additive, `metaMono ≥ 10.5`, `microCaption ≥
  8.5`) → **PASS** — `PhoneType.test.tsx` asserts the floors directly, the
  full family/weight/size/letterSpacing/transform table for all 11 roles
  (screenTitle, itemName, body, metaMono, caption, microCaption, wellValue,
  wellValueSheet, kpiValue, keypadKey, tableNum), the `tabular-nums`
  `fontVariant` on the 5 tabular roles, and the additive contract (`Type.body`
  / `Type.h2` / `Type.caption` asserted unchanged). Confirmed via `git diff
  main` that `typography.ts`'s only change is a new exported block — the
  existing `Type` map is untouched.
- AC-14 (all phone-EOD tappables ≥ 44×44: day cells, vendor tabs, wells
  62×48, ✕ 44, keypad keys 50-54 tall, SKIP/NEXT ITEM, submit 48-50) →
  **NOT TESTED as an explicit assertion; source-correct by inspection**. Every
  dimension is hardcoded in the two components exactly as specified: day
  cell `minWidth/minHeight: 50` (`PhoneEodCount.tsx:223-224`), vendor tab
  `minHeight: 44` (`:281`), row well `width:62,height:48` (`:528-529`), ✕
  `44×44` (`PhoneKeypadSheet.tsx:127`), digit key `height:52` (`:236`),
  footer buttons `height:48` (`:153,170`), submit button `height:48`
  (`PhoneEodCount.tsx:410,435`). No test reads any `Pressable`'s `.props.style`
  to numerically pin these floors — a future refactor could shrink one below
  44 without failing the suite.

**Regression guard**
- AC-REG (desktop/tablet byte-unchanged, isPhone-gated) → **PASS, with a
  caveat on assertion strength**. `EODCountSection.acReg.test.tsx` passes and
  mocks `useIsPhone` per case, asserting (a) desktop shows the "This week"
  sidebar text and no phone `eod-submit` testID, (b) phone shows `eod-submit`
  and not "This week". This is the "explicit render assertion" option the
  spec permits (as an alternative to a snapshot) but it is a narrow two-marker
  check, not a full-tree byte diff — it would not catch an unrelated wording
  or style edit elsewhere in the desktop return subtree that doesn't touch
  either marker. I independently corroborated AC-REG by reading `git diff main
  -- src/screens/cmd/sections/EODCountSection.tsx`: the only changes are (1)
  one new import, (2) the `if (isPhone) return <PhoneEodCount model={...}/>`
  block inserted between the two pre-existing early-return guards, and (3)
  `export` added to `EODHistoryTab` / `VarianceLogTab`. Zero textual edits
  inside the desktop return subtree. Given that diff, I'm confident AC-REG
  holds; a literal snapshot would still be stronger regression protection
  going forward (the spec explicitly offered a snapshot as the first, stronger
  option), and is a low-cost follow-up.

### Test run

```
npx jest > te140.log 2>&1; echo $?
```
Exit code: **0**. `Test Suites: 141 passed, 141 total` / `Tests: 1472 passed,
1472 total` / `Snapshots: 2 passed, 2 total`. Matches the design doc's stated
verification numbers exactly. No failures, no skipped tests.

```
npx tsc --noEmit          → exit 0
npx tsc -p tsconfig.test.json --noEmit → exit 0
```

Both typecheck gates green.

i18n parity check (`en.json` / `es.json` / `zh-CN.json` flattened key sets):
identical key sets across all three locales, including the 10 new
`section.eod.phone.*` keys — no drift.

### Golden path (main Claude's separate 375px browser verification)

For the manual browser pass (both Light + Dark Cmd themes at a 375px
viewport), the golden path to exercise end-to-end is:

1. Day strip → tap a non-today day cell (confirm accent border + `accentBg`
   selection swap, dot colors match status).
2. Vendor tab → tap a second vendor tab (confirm 2px accent underline moves,
   per-tab "N/M" reflects that vendor's items, counted-once-globally item
   reads counted under both tabs).
3. Tap well → keypad sheet opens seated on the tapped field (CS well active
   when `caseQty > 1`, else units); enter digits, confirm running total and
   row well update live.
4. NEXT → advance through remaining uncounted items with wraparound; confirm
   the button relabels **DONE ✓** on the last one and tapping it closes the
   sheet + fires the all-counted toast.
5. Submit gate → intentionally leave one item uncounted, tap the in-flow
   submit button, confirm the blocked-submit toast + jump seats/opens the
   sheet on the first uncounted item (this exact path — AC-11/AC-12 — has
   **no automated test**, see above; the browser pass is the only present
   verification of it).
6. Complete the count, submit successfully, confirm the navigate-to-Ordering
   jump lands correctly.

This golden path directly covers the two ACs (AC-11 gate-block, AC-12
post-submit navigate) that have no integration test in the suite — treat the
browser pass as load-bearing evidence for those two, not merely a visual
sanity check.

### Notes

- **Cheap pure-module surface (`src/lib/eodKeypad.ts`) is thorough** — this is
  the strongest part of the coverage. All three exported functions
  (`appendKeypadDigit`, `activeFieldFor`, `advanceUncounted`) have edge-case
  coverage including the decimal-at-clamp interaction, negative-index
  normalization, and the "only-uncounted-item-is-current" wraparound edge
  case. No gaps found here.
- **No test framework drift.** All new tests are jest (`.test.ts`/`.test.tsx`)
  using the existing `@testing-library/react-native` + `jest.mock` patterns
  already established by sibling `EODCountSection.*` test files. No vitest,
  playwright, or other framework introduced.
- **No DB/pgTAP or shell-smoke tests needed or added** — correctly, per the
  spec's own "Tests" section: this is a pure presentation-layer change with no
  migration, RPC, or edge-function surface.
- **Biggest actionable gap:** AC-1/AC-2/AC-3/AC-4/AC-10 (day strip, per-tab
  progress display, progress row, submit-bar state captions) and AC-11/AC-12
  (the real gate-block and post-submit-navigate paths) have zero automated
  coverage despite source-correct implementations verified by direct reading.
  None of these are new regressions introduced by spec 140 — AC-11/AC-12's gap
  in particular pre-dates this spec (the underlying `onSubmit` was never
  covered by a render-level test even on desktop) — but per this project's
  test-design rule ("every acceptance criterion maps to at least one test"),
  each of these ACs is a **gap requiring disclosure**, not a pass by
  association with a tested neighbor.
- **`app.json` slug** — untouched, not implicated by this spec; no action
  needed.
- **Realtime restart gotcha** — N/A; this spec makes no `supabase_realtime`
  publication change (confirmed via the design's own "Realtime impact"
  section and by this spec touching no migration files).

## Handoff
next_agent: NONE
prompt: Test report complete. 5 PASS (AC-5, AC-7, AC-8, AC-9, AC-13) + 1 PASS-with-caveat (AC-REG) + 6 PARTIAL (AC-3, AC-6, AC-10, AC-11, AC-12 have some coverage but leave the AC's core claim unverified) + 5 NOT TESTED (AC-1, AC-2, AC-4, AC-14, and the untested half of AC-6/AC-10) across 14 acceptance criteria + AC-REG. Full jest suite green (141 suites / 1472 tests, exit 0) and both typechecks green (exit 0); no test failures. The two most consequential gaps are AC-11/AC-12 (the real submit-gate-block and post-submit-navigate paths have never been exercised by a render-level test, on phone or desktop, old or new) — main Claude's separate 375px browser pass is the only present verification of those two and should be treated as load-bearing, not just a visual sanity check.
payload_paths:
  - specs/140-phone-eod-count-tier/reviews/test-engineer.md
