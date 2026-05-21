## Test report for spec 054

### Acceptance criteria status

- AC1: When `CustomUnitInput` receives both non-empty `help` and non-empty `error`, BOTH strings render simultaneously (the `{error || help}` swap is gone) → PASS — `src/components/cmd/IngredientForm.help-text.test.tsx::keeps the DEFAULT UNIT help string visible alongside the "required" error after blurring CustomUnitInput with an empty value`
- AC2: `error` renders in `C.danger`; `help` renders in `C.fg3`; both at `fontSize: 10`, `mono(400)` → PASS (prop-reuse verified in source; no direct style assertion in test — acceptable for a copy-only spec, noted below)
- AC3: `help` empty + `error` non-empty → only error renders (no empty leading `<Text>`) → PASS — implementation uses `{help ? … : null}` so an empty `help` never mounts a node; covered implicitly by test #5 where `help` is non-empty and by component structure confirmed via source read
- AC4: `error` empty + `help` non-empty → only help renders (spec 052 regression check) → PASS — `src/components/cmd/IngredientForm.help-text.test.tsx::keeps the DEFAULT UNIT help string visible after flipping into CustomUnitInput via the "+ custom…" sentinel` (test #3) and test #4 cover this; both pass
- AC5: Border behavior (`borderColor = focus ? C.accent : error ? C.danger : C.border`) on line 277 unchanged → PASS — verified in source at line 277; the new JSX diff touches only lines 342-351 and leaves line 277 untouched
- AC6: Fix applies to BOTH DEFAULT UNIT and PACK UNIT branches → PASS — both branches share the single `CustomUnitInput` component; the fix is in the component body, so one code change covers both call sites. No separate PACK UNIT blur test exists (see Notes)
- AC7: Jest test added asserting blur-with-empty produces `required` error while help string is still present → PASS — `src/components/cmd/IngredientForm.help-text.test.tsx` test #5 (line 205)
- AC8: Spec 052's existing four tests continue to pass unmodified → PASS — all four pass, confirmed by the targeted run

### Test run

```
npm test -- --ci --testPathPattern="IngredientForm.help-text"

PASS component src/components/cmd/IngredientForm.help-text.test.tsx
  IngredientForm — spec 052 help text
    ✓ renders the DEFAULT UNIT help string under the SelectField branch on initial render (116 ms)
    ✓ renders the PACK UNIT prefixed help string under the SelectField branch on initial render (6 ms)
    ✓ keeps the DEFAULT UNIT help string visible after flipping into CustomUnitInput via the "+ custom…" sentinel (15 ms)
    ✓ keeps the PACK UNIT prefixed help string visible after flipping into CustomUnitInput via the "+ custom…" sentinel (12 ms)
    ✓ keeps the DEFAULT UNIT help string visible alongside the "required" error after blurring CustomUnitInput with an empty value (16 ms)

Tests: 5 passed, 5 total

Full suite: npm test -- --ci
Test Suites: 18 passed, 18 total
Tests:       187 passed, 187 total
```

### Notes

**`fireEvent` mechanism in test #5.** Test #5 uses `fireEvent(inlineInput, 'blur')` — the raw event form rather than `fireEvent.blur(inlineInput)`. Both dispatch a synthetic blur event through the testing-library event handler chain and are functionally equivalent; this is representative of the blur user behavior.

**PACK UNIT branch blur test gap (Should-fix, non-blocking).** The spec says the fix applies to both call sites; it does, because both use the same `CustomUnitInput` component body. However, no PACK UNIT-specific blur test exists. The four spec-052 tests include a PACK UNIT flip test (test #4) that exercises the help-still-visible path, but there is no test #6 that blurs the PACK UNIT inline input empty and checks for help+error coexistence. The symmetry is architecturally guaranteed (one component, one code path), but the test surface is asymmetric. This is a Should-fix gap rather than a BLOCK — the fix is correct for both branches by construction, but a parallel PACK UNIT blur test would eliminate any future regression surface if the two call sites ever diverge.

**Style assertion absent (acceptable).** AC2 (color and font tokens) is verified only by reading the source (lines 342-351) rather than a computed-style assertion in the test. This is acceptable because `@testing-library/react-native` does not surface inline style values through `getByText` queries; asserting colors would require `toHaveStyle` on the `Text` node, which adds test fragility on a copy-only presentational spec. The source diff confirms the correct tokens (`C.fg3` for help, `C.danger` for error, both at `fontSize: 10, fontFamily: mono(400)`).

**`validateCustomUnit` string confirmed.** The literal string `'required'` is returned by `validateCustomUnit` at line 138 of `IngredientForm.tsx` and stored verbatim by the parent at line 677. The test's `getByText('required')` assertion matches the actual error string with no translation layer involved.

**No backend touch.** No pgTAP or smoke tests needed or added. Correct per spec.
