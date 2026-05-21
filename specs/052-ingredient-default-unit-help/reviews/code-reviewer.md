# Code review — Spec 052

Date: 2026-05-20
Reviewer: code-reviewer

## Verdict

0 Critical, 2 Should-fix, 3 Nits.

## Critical

None.

## Should-fix

- **`src/components/cmd/IngredientForm.help-text.test.tsx:122`** — DEFAULT UNIT SelectField test uses `screen.getAllByText(DEFAULT_UNIT_HELP).length > 0` but doesn't assert exact count. On initial render both the SelectField branch (active) and the CustomUnitInput branch (not mounted) could theoretically both match if a render-path bug existed; `toBeGreaterThan(0)` would pass even if the wrong node carried the text. Prefer `expect(screen.getAllByText(DEFAULT_UNIT_HELP)).toHaveLength(1)` for the SelectField-only branches (tests 1 and 2), and `toHaveLength(1)` for the post-flip branches (tests 3 and 4 after the flip, where only CustomUnitInput is mounted). Same tightness applied in `CopyToBrandDialog.test.tsx` where `.toHaveLength(1)` is the norm. The current form gives false confidence: a double-render regression would still pass.

- **`src/components/cmd/IngredientForm.help-text.test.tsx:195`** — `customRows[customRows.length - 1]` is fragile. If SelectField renders the option panel inline and both the DEFAULT UNIT and PACK UNIT dropdowns are simultaneously open, this index could resolve to the wrong row. A more stable selector would `getByRole` on the PACK UNIT's panel container or filter by a `testID` on the PACK UNIT SelectField's option list. At minimum, add a comment explaining why `[last]` is correct (e.g. "default dropdown is closed at this point so there is exactly one `'+ custom…'` row"). The parallel `customRows[0]` in test 3 has the same latent ambiguity but is less risky because both fields default to closed.

## Nits

- **`IngredientForm.tsx:342–346`** (referenced in spec) — The pre-existing `{error || help}` render in `CustomUnitInput` means that after a blur-with-empty-value the `'required'` error string replaces the help text. The spec explicitly flags this as a pre-existing quirk and deems it out of scope here, which is correct. Recommend a follow-up spec to render errors inline (e.g. red border + error below, help text always present above) rather than replacing help with errors; the current behaviour materially undercuts the spec's goal in the validation-error state.

- **`IngredientForm.help-text.test.tsx:144`** — `typeof next === 'function' ? (next as any)(vals) : next` uses an `as any` cast to silence the updater-function type. The `onChange` prop type on `IngredientForm` could instead be `(next: IngredientFormValues | ((prev: IngredientFormValues) => IngredientFormValues)) => void` if the component already supports functional updaters; otherwise the Harness can simply pass `(next) => setVals(next)` since `blankValues()` starts in a state where the `'+ custom…'` press doesn't mutate `values` at all (it only flips component-local `customMode`). Minor, but `as any` in test code can mask real type errors.

- **`IngredientForm.help-text.test.tsx:113–115`** — `DEFAULT_UNIT_HELP` and `PACK_UNIT_HELP` declared as `const` strings at module scope. Correct and clean. Noting explicitly because the spec's pre-existing-quirk note said the PACK UNIT string is 154 chars — having it as a named constant makes the diff obvious if wording ever changes.

- **`IngredientForm.help-text.test.tsx:31–54`** — The `supabase.from(...)` mock is more elaborate than it needs to be for this test (insert, update, delete, eq, single chains). This component doesn't call `supabase.from(...)` directly (all DB access goes through `useStore`), so the mock is defensive boilerplate that matches the project's convention for avoiding import-time crashes. No action needed; mirrors the established mock shape correctly.
