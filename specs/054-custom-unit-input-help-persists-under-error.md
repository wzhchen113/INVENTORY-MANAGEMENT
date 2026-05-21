# Spec 054: CustomUnitInput — help text persists alongside the error

Status: READY_FOR_REVIEW

## User story

As a store manager creating a new ingredient, when I pick **+ custom…** in
the DEFAULT UNIT or PACK UNIT dropdown and the inline TextInput appears, I
want the help string (per spec 052) to stay visible if I accidentally blur
the field without typing — so I still see "the smallest unit you count one
of (each, lb, oz, mL)" telling me what to type, rather than just a red
`required` message with no instruction.

## Acceptance criteria

- [ ] In `src/components/cmd/IngredientForm.tsx`, when the `CustomUnitInput`
  component receives both a non-empty `help` prop and a non-empty `error`
  prop, BOTH strings render in the DOM tree at the same time (separate
  `<Text>` blocks under the input). The current `{error || help}` swap
  is gone.
- [ ] The `error` string renders in `C.danger`. The `help` string renders
  in `C.fg3`. Both at `fontSize: 10`, `mono(400)`, matching the existing
  visual rhythm.
- [ ] When `help` is empty and `error` is non-empty, only the error
  renders (no empty leading `<Text>`).
- [ ] When `error` is empty and `help` is non-empty, only the help
  renders (existing behavior preserved).
- [ ] The red focus-border behavior on `error` (line 277:
  `borderColor = focus ? C.accent : error ? C.danger : C.border`) is
  unchanged.
- [ ] Fix applies in both call sites: the DEFAULT UNIT custom branch AND
  the PACK UNIT custom branch (the component is rendered in two places
  per spec 046; one code change covers both because they share
  `CustomUnitInput`).
- [ ] Jest test added asserting that after a blur-with-empty-value
  produces the `required` error, the help string from spec 052 is STILL
  present in the rendered tree. Test goes in
  `src/components/cmd/IngredientForm.help-text.test.tsx` alongside the
  existing four tests.
- [ ] Spec 052's existing four tests continue to pass unmodified.

## In scope

- The `CustomUnitInput` component in
  `src/components/cmd/IngredientForm.tsx` (lines ~265-349), specifically
  the trailing `{(help || error) ? … : null}` block at lines 342-346.
- One new jest test in
  `src/components/cmd/IngredientForm.help-text.test.tsx` covering the
  blur-with-empty → help-still-visible flow for the DEFAULT UNIT custom
  branch.

## Out of scope (explicitly)

- Harmonizing `InputLine` (line 224) and `SelectField` (lines 80, 133)
  which share the identical `{error || help}` swap pattern. Rationale:
  the user-visible quirk surfaced via spec 052's preview verification is
  specific to `CustomUnitInput` because `validateCustomUnit` returns a
  `required` error on blur-with-empty. `InputLine` and `SelectField` do
  not have that same blur-validation behavior wired in their current
  call sites, so the swap is observable here and not there. A follow-up
  spec can harmonize all three if the architect decides the inconsistency
  is worth a sweep.
- Extracting a shared `<HelpAndError>` block. Same rationale as above:
  the scope creep from touching three components plus their tests is
  larger than the value of one-off harmonization right now. Defer.
- Changing the validation contract (`validateCustomUnit` still returns
  `'required'` for empty input — the fix is presentational only).
- Adding an error icon, ARIA `aria-describedby`, or accessibility
  improvements beyond what the existing block already provides.
- Restyling the help-text typography (font size, weight, spacing).

## Open questions — RESOLVED (2026-05-21)

User accepted all PM-recommended defaults in a single batch:

- **Q1 → (a) both stacked BELOW the input** (help directly under, error below it). Consistent with `InputLine` and `SelectField` rhythm.
- **Q2 → inherit current treatment** (`C.danger` text + red border via existing line 277 logic). No icon, no fill.
- **Q3 → always shown when `help` prop is non-empty.** Parent already unmounts the component on successful commit, so "disappears on commit" is naturally true. No new internal conditional.
- **Q4 → component-local fix for 054.** The identical `{error || help}` pattern in `InputLine` and `SelectField` is acknowledged but NOT folded into this spec — surfaced as a future-spec candidate (architect can flag for a 055 if motivated).
- **Q5 → one new test in existing [src/components/cmd/IngredientForm.help-text.test.tsx](src/components/cmd/IngredientForm.help-text.test.tsx).** Use the same `Harness` shape from spec 052's tests #3 and #4.

The rest of this section preserves the original PM deliberation for architect reference.

---

## Open questions (original deliberation — superseded by resolutions above)

The spec stays DRAFT until the user confirms (or course-corrects) the
defaults below. Each recommendation is justified against the existing
codebase pattern.

- **Q1: Rendering shape.** Options were (a) both lines visible — help
  above the field, error below; (b) help above, error replaces help; (c)
  help right-of-input, error below.
  **PM recommendation: (a) with both lines BELOW the input** — the
  existing label already sits ABOVE the input (lines 299-301), and `help`
  has consistently rendered BELOW the input in `InputLine` (line 224) and
  `SelectField` (lines 80, 133). Render the help BELOW the input, then
  the error BELOW the help — two stacked `<Text>` blocks under the field
  with `gap: 2`. Keeps visual rhythm consistent and the help string stays
  spatially anchored to the input it describes.

- **Q2: Visual treatment of error.** **PM recommendation: inherit the
  current treatment** — `C.danger` text + red border via the existing
  line 277 logic. No icon, no background fill. Reason: the goal is a
  minimal presentational fix, not a redesign; introducing an icon
  expands scope into the project's icon set.

- **Q3: When does help disappear?** **PM recommendation: always shown
  when the `help` prop is non-empty.** The component does not own the
  lifecycle — the parent (`IngredientForm`) already controls whether
  `CustomUnitInput` is mounted at all (it swaps back to `SelectField`
  after a successful commit). So "help disappears on successful commit"
  is naturally true via unmount. No new internal conditional is needed.

- **Q4: Component-local fix vs. shared `<HelpAndError>` block.**
  **PM recommendation: component-local.** Verified that `InputLine` and
  `SelectField` do share the same `{error || help}` swap (four
  occurrences across two files), but the user-visible regression only
  surfaces in `CustomUnitInput` because `validateCustomUnit` runs on
  blur. A shared block introduces a third file and a sweep across three
  components plus their tests — that is a separate spec if drift is
  worth fixing. For now, fix the one observable bug; surface the drift
  as a follow-up consideration to the architect.

- **Q5: Test scope.** **PM recommendation: one new test in the existing
  file** (`IngredientForm.help-text.test.tsx`). Reason: that file
  already has the full mock graph (supabase / theme / useT / useStore /
  translate) wired for `IngredientForm` rendering, and a fifth test
  matches the spec-052 lineage. Use the same `Harness` shape from tests
  #3 and #4 to drive the SelectField → "+ custom…" flip, then fire a
  `blur` on the inline TextInput, then assert that both the
  `DEFAULT_UNIT_HELP` substring AND a `required`-shaped error string
  are present.

## Dependencies

- Spec 046 (CustomUnitInput exists with `help` and `error` props).
- Spec 052 (the spec-052 help strings — `DEFAULT_UNIT_HELP` and
  `PACK_UNIT_HELP` — are the strings that must stay visible).
- No migration. No edge function. No DB change.

## Project-specific notes

- **Cmd UI section:** `src/screens/cmd/sections/IngredientsSection.tsx`
  is the consumer surface; the component change lives in
  `src/components/cmd/IngredientForm.tsx` which `IngredientsSection`
  renders.
- **Per-store or admin-global:** N/A — pure presentational fix in a
  shared form component, no data path touched.
- **Realtime channels touched:** none.
- **Migrations needed:** no.
- **Edge functions touched:** none.
- **Web/native scope:** both. The `CustomUnitInput` is platform-agnostic
  (one render branch, no `Platform.OS` fork inside the help+error
  block). The new jest test runs under jest-expo's iOS platform default
  (per the spec-052 test header comment), so the assertion exercises
  the native render path; the web render path uses identical JSX for
  the help+error block.
- **Tests track:** jest (component-project / jsdom). Same file and
  mock-graph as spec 052's existing test.
- **`app.json` slug:** not touched.

## Backend design

Pure frontend presentational fix. No data model, RLS, API contract, edge
function, `src/lib/db.ts` helper, realtime channel, or `useStore` slice is
touched. The list below names each architect-checklist heading and explicitly
records the no-op so the post-impl reviewer can confirm at a glance.

- **Data model changes.** None. No migration file.
- **RLS impact.** None.
- **API contract.** None.
- **Edge function changes.** None.
- **`src/lib/db.ts` surface.** Untouched.
- **Realtime impact.** None. (And therefore the `supabase_realtime_imr-inventory`
  publication-restart gotcha does NOT apply — flagged explicitly so the
  release-coordinator does not surface it as a deploy step.)
- **Frontend store impact.** None. `useStore.ts` is not modified. The
  optimistic-then-revert pattern is N/A — no backend round-trip.

The actual work is in one component and one test file. The design below
covers what the developer needs to land before flipping to
`Status: READY_FOR_REVIEW`.

### 1. JSX diff sketch — `CustomUnitInput`, [src/components/cmd/IngredientForm.tsx:342-346](../src/components/cmd/IngredientForm.tsx)

Before:
```tsx
{(help || error) ? (
  <Text style={{ fontFamily: mono(400), fontSize: 10, color: error ? C.danger : C.fg3 }}>
    {error || help}
  </Text>
) : null}
```

After:
```tsx
{help ? (
  <Text style={{ fontFamily: mono(400), fontSize: 10, color: C.fg3 }}>
    {help}
  </Text>
) : null}
{error ? (
  <Text style={{ fontFamily: mono(400), fontSize: 10, color: C.danger }}>
    {error}
  </Text>
) : null}
```

Notes on the diff:
- Two independent `<Text>` blocks. Each renders only when its own prop is
  non-empty, so the four prop-state combinations behave per the
  acceptance criteria:
  - `help`-only → one fg3 line (existing behavior preserved).
  - `error`-only → one danger line, no empty leading `<Text>`.
  - both → help line, then error line.
  - neither → nothing renders (matches the current `null` branch).
- The conditional collapse on `help ? … : null` is what makes "if `help`
  is empty and `error` is non-empty, only the error renders" naturally
  true without a third branching arm. No new boolean state, no new
  helper.
- The parent `<View>` already has `gap: 4` (line 298), which spaces the
  two `<Text>` blocks identically to how other forms stack
  label/input/help rows. No new style code.

### 2. Style preservation

Both `<Text>` blocks share `fontFamily: mono(400), fontSize: 10`. Help
uses `color: C.fg3`. Error uses `color: C.danger`. These mirror the
exact tokens the current single-block uses for its respective branches —
the only change is splitting the ternary on color into two literal
assignments. No new theme tokens, no new font weights, no new spacing
values.

### 3. Border treatment

Line 277's `borderColor = focus ? C.accent : error ? C.danger : C.border`
stays as-is. The red focus-border on `error` is the spatial cue that the
input is invalid; the inline error string is the textual cue; the help
line, now persistent, is the instructional cue. All three coexist
without overlap.

### 4. Test design — one new test in [src/components/cmd/IngredientForm.help-text.test.tsx](../src/components/cmd/IngredientForm.help-text.test.tsx)

Add a fifth `it(…)` after test #4. Use the `Harness` shape from tests #3
and #4 verbatim. Sequence:

1. Render `<Harness />`.
2. Press the DEFAULT UNIT display (`enum.unit.each`) to open the
   dropdown.
3. Press the first `+ custom…` row to flip `customMode.default = true`,
   mounting `CustomUnitInput`.
4. Find the inline `TextInput` (by placeholder `e.g. case, box, tray`)
   and fire a `blur` event. The `autoFocus` already drove focus on
   mount, so the blur is the user-equivalent action of clicking away
   without typing.
5. The blur invokes `CustomUnitInput.handleCommit` → parent `onCommit`
   at line 660 → `validateCustomUnit('', knownKeys)` returns
   `{ ok: false, error: 'required' }` → parent sets
   `customError.default = 'required'` and `return`s without flipping
   `customMode.default` off. The component re-renders with
   `error='required'` and the unchanged `help` prop.
6. Two assertions:
   - `expect(screen.getAllByText(DEFAULT_UNIT_HELP)).toHaveLength(1)` —
     the spec 052 help line is still present.
   - `expect(screen.getByText('required')).toBeTruthy()` — the new
     error line is also rendered as a separate node.

Both assertions together would FAIL against the old `{error || help}`
shape because `getAllByText(DEFAULT_UNIT_HELP)` would return `0` matches
once the error supplanted the help. Both PASS against the new shape.
This is the regression-detector property the acceptance criteria
require.

Mock graph is already wired (lines 31-106 of the test file).
Boundary-mock additions: none.

A note on the `customError.default` string: the parent stores
`'required'` byte-for-byte (line 672) when `validateCustomUnit` returns
that error key. So `getByText('required')` is the literal assertion;
no key-echoing translator involvement.

Test file header comment should be expanded to mention spec 054 (one
extra line at the top, e.g. `// Spec 054 added the fifth test below
that blurs the inline input to assert help + error coexist.`).

### 5. Verification gates

Developer runs, in order:
1. `npm run typecheck` (project's `tsc --noEmit`). Should be a no-op
   given no type signature changed.
2. `npm test -- --ci src/components/cmd/IngredientForm.help-text.test.tsx`
   — all five tests pass, including the new fifth.
3. Manual preview against the running local dev server (already up
   from yesterday's spec 052 verification). In the ingredients form:
   - Open new-ingredient drawer.
   - DEFAULT UNIT → click "+ custom…" → click somewhere outside the
     input without typing → confirm BOTH "the smallest unit you count
     one of (each, lb, oz, mL)" AND "required" appear stacked below
     the input, in that order, with the input border red.
   - Type "case" → press Enter → confirm the form returns to the
     SelectField with `case` selected (sanity check that the
     commit-on-blur latch still works).
4. Run the full jest suite (`npm test -- --ci`) once to confirm spec
   052's existing four tests and any other tests that exercise
   `CustomUnitInput` (none found in a `grep -r CustomUnitInput tests/`)
   remain green.

### 6. Drift / convention risks

- **Vertical rhythm at 33% width.** The default-unit column is 33% wide
  with `gap: 10` between columns and `gap: 4` inside the column's
  `<View>`. Adding a second `<Text>` row adds at most ~14 px (one
  font-size-10 line plus the 4 px gap) under the input. The adjacent
  columns ("packs / order" and "units / pack") have an `InputLine` with
  one help line of identical height. When the error appears, the
  default-unit column grows one row taller than its neighbors, leaving
  the row's visual baseline ragged. This is unavoidable given the
  acceptance criterion that both lines stack; flagged for the reviewer
  but not blocking. If the user later complains, a follow-up spec
  could mirror the help-line height into `InputLine` so the ragged
  baseline is symmetric (or absorb both into a single fixed-height
  slot).
- **`InputLine` and `SelectField` still carry the same `{error || help}`
  pattern** (lines 80, 133, 224). Confirmed via grep. Per Q4 resolution
  these are NOT touched in spec 054. Architect notes the drift as a
  reasonable candidate for spec 055 if the user wants harmonization —
  but the user-visible regression is specific to `CustomUnitInput`
  because only it wires a blur-validation path that produces a
  persistent error string under the spec 052 help. No silent
  inconsistency lands.
- **Test platform note.** `IngredientForm.help-text.test.tsx` runs under
  jest-expo with `Platform.OS === 'ios'` (per the file's header
  comment). The `CustomUnitInput` JSX has no `Platform.OS` fork inside
  the `help`/`error` block, so the iOS-target test exercises the same
  rendered shape that the web build produces. No new platform branch
  needed.
- **No new imports.** The change reuses `Text`, `mono`, and `C` already
  imported at the top of `IngredientForm.tsx`. The test reuses
  `screen`, `fireEvent`, `render` already imported in the test file
  (line 110).
- **Last-of-role / self-guard / publication-restart rules** in
  [CLAUDE.md](../CLAUDE.md) are not triggered by this change. Recorded
  explicitly so the reviewer doesn't have to re-derive that.

### Risks and tradeoffs (summary)

- Risk: the new error line could push the form one line taller in the
  rare always-error state. Tradeoff: accepted, per acceptance
  criterion; visual ragged baseline is a known cost.
- Risk: the new test increases jest-suite time. Tradeoff: negligible —
  one additional render-and-press cycle inside an already-mocked file.
- Risk: developer accidentally fixes `InputLine`/`SelectField` in the
  same diff. Mitigation: spec out-of-scope section is explicit; the
  reviewer will flag any cross-file change as drift.

## Handoff
next_agent: frontend-developer
prompt: Implement against the design in this spec. The change is two
  files only — the `CustomUnitInput` JSX block at lines 342-346 of
  `src/components/cmd/IngredientForm.tsx`, and one new jest test
  appended to `src/components/cmd/IngredientForm.help-text.test.tsx`.
  Do not touch `InputLine`, `SelectField`, or any other call site of
  the `{error || help}` pattern — those are explicitly deferred per
  Q4. Run typecheck + jest + a manual preview pass (per the spec's
  Verification gates section). After implementation, set
  `Status: READY_FOR_REVIEW` and list files changed under
  `## Files changed`.
payload_paths:
  - specs/054-custom-unit-input-help-persists-under-error.md

## Files changed

- `src/components/cmd/IngredientForm.tsx` — `CustomUnitInput`: replaced the
  single `{(help || error) ? <Text>{error || help}</Text> : null}` block
  with two independent `{prop ? <Text/> : null}` blocks so help (`C.fg3`)
  and error (`C.danger`) coexist when both props are non-empty. No new
  state, no new styles, no new imports. `InputLine` and `SelectField`
  left untouched per spec Q4 resolution.
- `src/components/cmd/IngredientForm.help-text.test.tsx` — header comment
  extended with the spec 054 note; appended one new `it(...)` block
  (test #5) that opens the DEFAULT UNIT dropdown, presses `+ custom…`,
  blurs the inline `TextInput` (placeholder `e.g. case, box, tray`)
  with empty value, and asserts BOTH `DEFAULT_UNIT_HELP` (one match) AND
  the literal string `'required'` are present. Spec 052's existing four
  tests are unchanged.
