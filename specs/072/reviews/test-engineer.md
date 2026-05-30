## Test report for spec 072

### Acceptance criteria status

Spec 072 does not number ACs formally; the root causes and fixes are stated as
requirements. The meaningful behavioral invariants are extracted below.

- AC1: `styles.container` on both `EODCount` and `StorePicker` is
  `StyleSheet.absoluteFillObject` (positions the SafeAreaView to the Card, not
  in flow) → PASS — code confirmed in both files. No jest assertion warranted
  (see "Notes / pinning container shape" below); the DOM chain in the spec is
  the load-bearing proof.

- AC2: Items / stores `FlatList` carries `style={{ flex: 1 }}` on the populated
  branch of both screens (makes the FlatList the scroll container, not the
  document body) → PASS — code confirmed; new regression-guard assertions added
  and passing (see below).

- AC3: Jest suite green after the fix — 9 suites / 74 tests already passing
  pre-fix + 2 new regression guards → PASS — 76 tests, 0 failures.

- AC4: TypeScript clean — `npx tsc --noEmit -p tsconfig.json` exit 0 → PASS.

- AC5: "List scrolls when populated past viewport" end-to-end check → NOT
  TESTED (correctly deferred — jsdom cannot size a viewport; this is a
  viewport-dependent behavior that requires a real browser; deferred per spec
  §"Out-of-scope follow-ups").

### Regression guards added

Two new `describe` blocks were added to pin the load-bearing fix:

`src/screens/staff/screens/StorePicker.test.tsx`
- `StorePicker — spec 072 scroll-pinned-footer` → `stores FlatList carries style
  with flex: 1 (scroll container guard)`: uses `UNSAFE_getAllByType(FlatList)`
  to locate the stores FlatList and asserts `flex === 1` on its `style` prop.
  Fails if the style is removed, set to 0, or the prop is dropped.

`src/screens/staff/screens/EODCount.test.tsx`
- `EODCount — spec 072 scroll-pinned-footer` → `items FlatList carries style
  with flex: 1 (scroll container guard)`: same pattern; waits for
  `eod-item-row-item-1` to appear (populated branch), then asserts on the last
  FlatList in the tree (the vertical items list). Fails on the same regression
  vector.

Both assertions follow the existing `ListRow.test.tsx` style-inspection idiom
(flatten the style prop array, find the target key). Both are under 20 lines.

### Test run

```
npx jest src/screens/staff --no-coverage
```

```
Test Suites: 9 passed, 9 total
Tests:       76 passed, 76 total
Snapshots:   0 total
Time:        ~1.9 s
```

TypeScript:
```
npx tsc --noEmit -p tsconfig.json
exit: 0
```

Note: A `VirtualizedList` act() warning appears in the EODCount test run. This
is a pre-existing React Test Renderer noise from FlatList internals firing
internal setState after the test ends. It was present before this spec and does
not indicate a test failure — all assertions pass.

### Notes

**Pinning `styles.container` shape (absoluteFillObject) — not warranted.**
Main Claude's call was correct. `StyleSheet.absoluteFillObject` is a static
constant (`{ position: 'absolute', left: 0, right: 0, top: 0, bottom: 0 }`).
A jest assertion that inspects the rendered root element's `position` prop
would test nothing beyond "the constant was spread correctly" — no rendering
behavior is driven by the assertion. The spec's DOM chain (computed heights
before/after) is the actual proof. Pinning was correctly rejected.

**Pinning FlatList `flex: 1` — warranted (and added).**
Unlike the container shape, the FlatList `style` prop is the active fix: it
changes which element claims leftover space and becomes the scroll container.
It is also the asymmetry the spec explicitly calls out (loading/empty panes
already had `flex: 1`; the populated branch did not). If reverted silently the
bug recurs. The assertion is cheap (no new test infrastructure), follows the
existing idiom, and is behaviorally load-bearing.

**Viewport scroll end-to-end test — correctly out of scope.**
A jsdom jest cannot size a viewport to 375×812 and confirm that a FlatList with
31 rows scrolls internally while the footer stays visible. This requires a
real browser. The spec correctly defers this as a future integration check.
There is no framework in-tree for browser-level E2E (playwright, cypress) —
surface as a gap if the user wants it. No new framework introduced here.

**Native testing gap.**
The fix is structural (SafeAreaView absolute-fill + FlatList flex: 1) and
React Native Yoga handles this correctly per spec. The web regression was
web-specific (RNW `min-height: 100%` + `flex: 0 0 auto` screen-wrapper
loophole). Native testing is not set up in-tree; no new infrastructure
introduced.
