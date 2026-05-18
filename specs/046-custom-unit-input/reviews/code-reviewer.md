# Code review for Spec 046 (custom-unit input)

## Critical

### C1 — Double-commit on web Enter

`src/components/cmd/IngredientForm.tsx:267-268` — `onBlur={() => {
setFocus(false); onCommit(); }}` fires after every `onSubmitEditing`
(also wired to `onCommit`). On web, pressing Enter triggers both
`onSubmitEditing` AND a focus-loss blur, so `onCommit()` is called
twice within the same React batch. First call succeeds; second call
runs with stale `customDraft` (state hasn't flushed) and calls
`set('unit', res.normalized)` plus parent `onChange` a second time.
The `onKeyPress` web guard at line 275 adds a potential third
invocation path.

**Fix:** add a `committedRef` flag at the top of `onCommit()` that
returns early if already-committed in the same logical cycle. OR
remove `onBlur → onCommit` and rely on explicit blur via ref after
successful commit.

### C2 — `validateCustomUnit` doesn't snap `each` / conversion units

`src/components/cmd/IngredientForm.tsx:121-130` — `CANONICAL_UNITS`
doesn't include `each`, so typing `EACH` returns `{ normalized:
'EACH', snappedToCanonical: false }`. `defaultUnitOptions` memo
detects `curLower === 'each'` and adds `'each'` to the acc Set, but
`values.unit` is now `'EACH'`. SelectField's display lookup uses
byte-for-byte equality (`value === options.value`) so the closed
dropdown shows the placeholder instead of the committed value (AC5
round-trip violation). Same failure for any conversion-derived unit
(e.g., typing `BAG` when `bag` is in the conversions tab).

**Fix:** extend the snap logic to accept "known good lowercase keys"
(`['each', ...allConversions]`) or normalize post-validate when
`options.some((o) => o.value === res.normalized.toLowerCase())`.

## Should-fix

### SF1 — `onKeyPress` redundant with `onSubmitEditing`

`IngredientForm.tsx:273-282` — RN Web 0.21 synthesizes
`onSubmitEditing` for `TextInput` regardless of form context.
Removing the `onKeyPress` Enter trap eliminates one of three commit
paths. Related to C1.

### SF2 — Banner shows lowercased unit name

`IngredientForm.tsx:539` — `abstractUnitWarning` interpolates the
lowercased `u`, but the user committed `"Case"` (case-preserved).
Banner reads `No conversion defined for "case"`. Use
`curRaw = (values.unit || '').trim()` for display, keep lowercased
for the comparison.

### SF3 — Jest `jest.mock` placement inconsistency

`IngredientForm.test.ts:57` — `jest.mock()` before `import`. Works
(Babel hoists), but inconsistent with sibling tests in this codebase.
Add an explicit hoisting comment OR move imports above the mock.

### SF4 — Hardcoded canonical list in test

`IngredientForm.test.ts:136-145` — Iterates `['g', 'kg', 'oz', ...]`
hardcoded. Future canonical-unit additions would silently bypass
this test. Import `CANONICAL_UNITS` and drive the loop.

## Nits

- Comment at `IngredientForm.tsx:291-293` describes the cancel-path
  race but not the symmetric commit-path race (related to C1).
- `IngredientForm.tsx:602-604` — pre-existing `&amp;` HTML entity in
  JSX. Out-of-scope.
- `CustomUnitInput` (line 236-312) hardcodes `autoFocus: true`.
  Accept `autoFocus?: boolean` for forward-compat. Low risk.
- Test header claims "15 cases" but actual count is 12 `it()` calls
  across 4 `describe()` blocks.

## Handoff
next_agent: NONE
prompt: 2 Critical, 4 Should-fix, 4 Nits.
