## Code review for spec 171 (re-review after Review-fix round 1)

Scope read: the round-1 spec section, `src/lib/eodKeypad.ts`, `src/lib/eodCountMode.ts`, `PhoneKeypadSheet.tsx`, `PhoneEodCount.tsx`, `StaffKeypadSheet.tsx`, the staff `eodKeypad.ts` barrel, staff `EODCount.tsx`, `StaffEodCountRow.tsx`, `EODCountSection.tsx`, `IngredientForm.tsx`, `IngredientFormDrawer.tsx`, `SelectField.tsx` and its callers, the `db.ts` comment, and the new jest arms in `PhoneWeeklyCount.test.tsx` and `eodKeypad.test.ts`. I read the files directly because this agent has no shell. I did not re-run jest or typecheck, and I relied on the spec's recorded results for those. The git status snapshot shows `PhoneWeeklyCount.tsx` unmodified.

Project-policy checks are still clean:
- No `supabase` call outside `db.ts`.
- No inline color literals.
- No `confirm` or `Alert`.
- No unguarded web-only API.
- No deleted-file edits.
- No `app.json` change.
- No new realtime channel.
- No custom JWT SQL.
- No new tests outside the jest track.

### Critical

None. The previous Critical is **CLOSED**.

- `PhoneKeypadSheet.tsx:31,53,75` now takes an optional `countMode`. It computes `box = countMode ? eodBoxes(countMode) : eodBoxesFor(item.caseQty)`.
  - When the prop is omitted, the layout depends on `caseQty` alone, with no stored mode. It never reads `item.eodCountMode`.
  - The prop doc explains why: `PhoneWeeklyCount` shares the sheet and is out of scope.
- `PhoneWeeklyCount.tsx` is unchanged and passes no `countMode`. Its one-arg `activeFieldFor(caseQty)` seat (L161, L189) always lands on a rendered well under the legacy layout. This is the case that was failing: a `caseQty` 24 item stored as `cases_only` or `units_only`.
- `PhoneEodCount.tsx:468` passes `effectiveEodCountMode(sheetItem.caseQty, sheetItem.eodCountMode)`. That is the same resolution `seatedField` clamps against at L131-133, so wells and seat cannot disagree.
- `PhoneKeypadSheet` has exactly two consumers, `PhoneEodCount` and `PhoneWeeklyCount` (grep-verified), so no caller was missed.
- `PhoneWeeklyCount.test.tsx:224-278` adds 3 arms for each of `units_only` and `cases_only`.
  - Each arm opens the CS well, the units well, and the blocked-submit seat.
  - Each arm asserts that both sheet wells render, that the digit lands in the visible field, and that the other setter is not called.
  - They drive the real component rather than a mock, which is the right level.
  - The spec records a mutation check: reverting the sheet to read `item.eodCountMode` fails all 6.

### Should-fix

All three previous items are **CLOSED**. No new Should-fix items.

- **CLOSED:** duplicated clamp and box resolution.
  - `eodBoxesFor` and `clampActiveField` are in `src/lib/eodKeypad.ts:73-95`, and both are pure and total.
  - Call sites:
    - `clampActiveField`: `PhoneEodCount.tsx:131-133` and staff `EODCount.tsx:414-416`.
    - `eodBoxesFor`: `StaffKeypadSheet.tsx:72` and the default arm of `PhoneKeypadSheet.tsx:75`.
  - The staff barrel (`src/screens/staff/lib/eodKeypad.ts:14-21`) re-exports both, so the staff subtree stays on its single staff-local import path.
  - `activeFieldFor`'s one-arg behavior is untouched.
  - Unit arms cover both helpers (`eodKeypad.test.ts:151-190`):
    - the omitted-stored legacy arm;
    - the `caseQty` <= 1 arm, where the mode is ignored;
    - the clamp-to-seat arms for `units_only` and `cases_only`.
  - The row-level `eodBoxes(rowMode)` sites remain, intentionally. They resolve a locked or live `rowMode` first, so they are not the same expression.
- **CLOSED:** `EODCountSection.tsx:621-622`. `itemTotal` now uses `liveModeById(i.id)`, so `itemTotal`, `localHasEntry` (L643) and `buildSubmission` (L773) share one resolution path.
- **CLOSED:** `IngredientFormDrawer.tsx:17,66,166`. Both literals now use `DEFAULT_EOD_COUNT_MODE`, with one import. The constant now has a single source of truth across the form and the drawer.

### Nits

Previous nits:

- **CLOSED:** `EODCountSection.tsx:255-259`. The `caseInputRefs` declaration comment explains that the ref holds the first enabled input. The name was kept deliberately, to avoid touching the palette-focus code. Fine.
- **CLOSED:** `eodKeypad.ts:64`. The redundant `mode ?? undefined` is gone.
- **CLOSED:** `IngredientForm.tsx:1106`. The identity `.map` is gone and `EOD_COUNT_MODE_OPTIONS` is passed directly. That constant is already typed `ReadonlyArray<{ value: EodCountMode; label: string }>` (L109), which is assignable to the widened prop.
- **CLOSED:** staff `EODCount.tsx:748-763`. The stale comment and its dead line references are removed. The spec 171 paragraph remains.
- **CLOSED:** `StaffEodCountRow.tsx:29-37`. The `counted` and `total` prop docs now describe the mode-aware semantics, and the `hasPack` and `countMode` docs are accurate.
- **CLOSED:** `db.ts:467`. The comment now lists `eod_count_mode`.
- **CLOSED:** `EODCountSection.tsx:767-789`. The `?? 0` and `v?.` dead guards are replaced by a typed `flatMap`.
  - The `if (!v) return []` arm is explained in a comment as type narrowing only.
  - The remaining `?? undefined` converts `null` to `undefined`, which is meaningful.
- **OPEN, unchanged, out-of-scope, owner UX call:** a submitted `cases_only` item renders with an empty, dimmed UNITS box under the D7 legacy layout. This is AC-20-compliant. No change is requested.

`SelectField` widening verified safe:
- `SelectField.tsx:23` changed `options` from `Array<...>` to `ReadonlyArray<...>`.
- The component only calls `.find` and `.map` on `options` (L36, L71, L116). Both exist on `ReadonlyArray`, and nothing mutates.
- Every caller passes a mutable `Array` or a `ReadonlyArray`, and both assign to the widened prop:
  - `IngredientForm.tsx` (L995, 1061, 1103, 1160, 1377);
  - `InventoryCatalogMode.tsx` (L1224, 1295, via the `IngredientForm` re-export);
  - `RecipeFormDrawer.tsx` (L425, 467);
  - `PrepRecipeFormDrawer.tsx` (L407, 461).
- Widening a parameter type to a supertype cannot break an existing caller, and the typecheck results the spec records agree.
- The `InventoryCatalogMode` tests that stub `SelectField` are unaffected.

New nits introduced by the fixes:

- `src/screens/cmd/sections/eod/PhoneEodCount.tsx:468` — the effective mode is resolved inline in JSX. `clampActiveField` already resolves it internally at L131-133.
  - Hoisting `const sheetMode = sheetItem ? effectiveEodCountMode(...) : undefined` next to `seatedField` would put the two resolutions side by side and make the invariant "wells and seat use the same mode" visible.
  - It is correct as written, so this is a preference.
- `src/screens/cmd/sections/eod/PhoneKeypadSheet.tsx:31` — an optional prop that silently selects the legacy layout when omitted is a quiet default. Only two consumers exist, and the prop doc is clear, so I would not change it. If a third consumer ever appears, a required prop with an explicit `'legacy'` value would be harder to misuse.
- `src/screens/cmd/sections/phone/__tests__/PhoneWeeklyCount.test.tsx:224` — the new arms live under the `PhoneWeeklyCount` describe and exercise the sheet only through the weekly screen. That is the right regression surface, and no standalone `PhoneKeypadSheet` test exists to put them in. Nothing to do.
