## Test report for spec 071

### Acceptance criteria status

- AC1: `StorePicker.tsx` root element is `SafeAreaView` from `react-native-safe-area-context` (NOT the deprecated `react-native` re-export), with explicit `edges={['top', 'bottom']}` → PASS — `src/screens/staff/screens/StorePicker.test.tsx::StorePicker — spec 071 safe-area root / root element is SafeAreaView (not a bare View)` + `::root SafeAreaView carries edges={["top", "bottom"]}`. Implementation at `StorePicker.tsx:20` imports from the correct package; `StorePicker.tsx:39` carries the exact `edges` array. Both assertions are load-bearing: the mock in `tests/jest.setup.ts:62` renders `SafeAreaView` as `React.createElement('SafeAreaView', props, children)` so `.type === 'SafeAreaView'` would flip to `'View'` on revert; `edges` is forwarded via `...props` spread so the `toEqual` would fail if the prop were dropped or changed.

- AC2: On a viewport with a top inset the rendered header row is positioned at or below the safe-area top boundary — NOT TESTED (jest / jsdom only) — manual device QA required. This is explicitly out of jest scope per the architect's Risk §1 ("react-native-web SafeAreaView is a plain `<div>` shim … browsers without notch resolve inset to `0px`"). Marked as a process gap, NOT a blocker — same posture used for spec 070's AC10 visual delta. Ships through EAS native QA.

- AC3: On a viewport with a bottom inset the FlatList's last-item bottom padding sits above the safe-area bottom boundary — NOT TESTED (jest / jsdom only) — same posture as AC2. Process gap, not a blocker.

- AC4: `EODCount.tsx` is confirmed already-correct (`SafeAreaView` with `edges={['top', 'bottom']}` from `react-native-safe-area-context` at `EODCount.tsx:390`) → PASS — verified by direct read: `EODCount.tsx:28` imports `SafeAreaView` from `react-native-safe-area-context`; `EODCount.tsx:390-392` uses `<SafeAreaView style={...} edges={['top', 'bottom']}>`. No code change required; audit evidence captured here.

- AC5: No staff file imports `SafeAreaView` from `react-native` (the deprecated re-export) → PASS — `grep -rn "from 'react-native'" src/screens/staff/ | grep SafeAreaView` returns zero matches. Both staff screens source the component from `react-native-safe-area-context` only.

- AC6: No change to `App.tsx`'s `SafeAreaProvider` mount → PASS — `git diff HEAD -- App.tsx` produces no output; `App.tsx` is in the unmodified working tree.

- AC7: No new dependency added → PASS — `git diff HEAD -- package.json` produces no output; `react-native-safe-area-context` was already a transitive dep via `@react-navigation/native` and already imported in `App.tsx` and `EODCount.tsx`.

- AC8: Jest render test for `StorePicker` renders without throwing when no `SafeAreaProvider` is in the test tree → PASS — `src/screens/staff/screens/StorePicker.test.tsx::StorePicker — spec 071 safe-area root / renders without throwing when no SafeAreaProvider is mounted`. The `jest.mock` in `tests/jest.setup.ts:56-66` stubs `SafeAreaView` as a string-tag host element, so the component never touches the real native provider at all — confirms the library's default-insets fallback is sufficient.

- AC9: Visual smoke on web at viewport simulating notch — title row is visually inset from the top of the viewport → NOT TESTED (manual check, explicitly not a CI gate per spec). Process gap only; matches the architect's Risk §1 and the implementer's note that desktop browsers shim the inset to `0px`. Ships through manual QA.

- AC10: No regression in spec 070's color / elevation behavior — `backgroundColor: c.bg` is preserved on the new root → PASS — `StorePicker.tsx:38` confirms `style={[styles.container, { backgroundColor: c.bg }]}` is present on the `SafeAreaView` root, identical to what was on the prior `View` root.

---

### Test run

```
npx jest src/screens/staff --no-coverage

PASS unit src/screens/staff/i18n/i18n.test.ts
PASS unit src/screens/staff/lib/theme.test.ts
PASS unit src/screens/staff/lib/eodQueue.test.ts
PASS unit src/screens/staff/store/useStaffStore.test.ts
PASS unit src/screens/staff/hooks/useConnectionStatus.test.ts
PASS unit src/screens/staff/hooks/useEodSubmit.test.ts
PASS component src/screens/staff/components/ListRow.test.tsx
PASS component src/screens/staff/screens/StorePicker.test.tsx
PASS component src/screens/staff/screens/EODCount.test.tsx

Test Suites: 9 passed, 9 total
Tests:       74 passed, 74 total
Snapshots:   0 total
Time:        1.629 s
```

Verbose breakdown for `StorePicker.test.tsx`:

```
StorePicker (spec-063 original)
  ✓ renders one row per store
  ✓ tapping a row sets the active store
  ✓ shows the count subtitle
StorePicker — spec 071 safe-area root (4 new assertions)
  ✓ renders without throwing when no SafeAreaProvider is mounted
  ✓ root element is SafeAreaView (not a bare View)
  ✓ root SafeAreaView carries edges={["top", "bottom"]}
  ✓ renders the "Select your store" title above the inset
```

Typecheck: `npx tsc --noEmit -p tsconfig.json` → exit 0, no output.

### Notes

1. **Root-identity assertion is load-bearing.** The mock at `tests/jest.setup.ts:62` renders `SafeAreaView` via `React.createElement('SafeAreaView', props, children)`, giving the element `.type === 'SafeAreaView'` (string). A revert to bare `<View>` would produce `.type === 'View'` and fail the assertion. The `edges` prop is forwarded through the `...props` spread, so the `toEqual(['top', 'bottom'])` assertion is equally load-bearing.

2. **Visual inset on notched devices (AC2, AC3, AC9) is a process gap, not a test blocker.** This is the identical posture the project uses for spec 070's visual-delta AC and for `EODCount.tsx`'s existing safe-area behavior. `react-native-web` resolves `env(safe-area-inset-*)` to `0px` on desktop browsers, so no visible diff appears on web preview. Device-level verification ships through EAS native QA.

3. **spec-063 original three tests are fully preserved and passing.** The implementer correctly extended the pre-existing `StorePicker.test.tsx` rather than overwriting it. The `beforeEach` Zustand state seed covers all seven tests.

4. **No fourth test framework introduced.** The four new assertions land in the existing jest component project (`src/screens/**/*.test.tsx` glob) with no new config, no new mock file, and no new CI workflow.

5. **EODCount empty-state branch (EODCount.tsx:376-381) has no explicit `edges` prop** (defaults to all-four-edges). The architect flagged this in spec 071 Risk §4 as a minor follow-up, out of scope here. Not a blocker.
