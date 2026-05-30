## Test report for spec 073

### Acceptance criteria status

The spec has one explicit behavioral acceptance criterion and one explicit
no-test rationale:

- **AC1: The defensive empty-state `SafeAreaView` carries `edges={['top','bottom']}`
  matching the main render branch** → PASS (verified by source inspection —
  `src/screens/staff/screens/EODCount.tsx:376-378`; both branches are now
  byte-for-byte identical on the `SafeAreaView` shape).

- **AC2: `npx tsc --noEmit -p tsconfig.json` exits 0** → PASS (confirmed,
  no output).

- **AC3: `npx jest src/screens/staff` passes 9 suites / 76 tests unchanged** →
  PASS (9 suites, 76 tests, 0 failures).

### No-test call assessment

The spec's no-test rationale reads:

> "the empty branch only renders on a transient `!activeStore` state which the
> existing tests don't exercise; pinning a single prop here would test the
> literal with zero behavioral value, so no test added per the same reasoning
> as the spec-072 `styles.container` decision."

I assessed whether a cheap load-bearing assertion would meaningfully close a
real regression risk.

**What the assertion would look like.** To exercise the defensive branch a test
would need to call `useStaffStore.setState({ activeStore: null })` before
rendering, then query `UNSAFE_getByType(SafeAreaView)` and assert
`props.edges` deep-equals `['top','bottom']`.

**Why it does not clear the load-bearing bar.** The spec-071 root-identity test
(`EODCount.test.tsx::items FlatList carries style with flex: 1`) is the
standard cited for "load-bearing." That test earns its place because a future
editor could accidentally omit the `style={styles.itemListBody}` prop from
the FlatList, silently breaking the scroll-pinned-footer layout in a way that's
not caught by TypeScript. The regression is plausible (structural change to
JSX), invisible to the type system, and behaviorally observable.

The proposed `edges` assertion would pin a `ReadonlyArray<string>` literal on a
JSX prop of a SafeAreaView that:

1. Is already redundantly guarded by TypeScript — `edges` is typed and the
   compiler would reject a malformed value.
2. Sits on a branch that is never reached in production (the spec notes the
   navigator swaps to the picker before this branch can render).
3. Would only catch an editor who removed the prop or changed the array
   literal, neither of which is a plausible drift scenario — the main branch
   directly below carries the identical prop and would almost certainly be
   edited in tandem.

A "defensive branch renders" test would additionally require overriding the
Zustand store state in a way the existing `beforeEach` fixture doesn't set up,
adding test-infrastructure complexity for zero behavioral signal.

**Conclusion: the no-test call is correct.** This is implementation-detail
pinning of a string-array literal on a dead-code branch. No test added.

### Test run

```
npx jest src/screens/staff --no-coverage

Test Suites: 9 passed, 9 total
Tests:       76 passed, 76 total
Snapshots:   0 total
Time:        1.684 s
```

```
npx tsc --noEmit -p tsconfig.json
(exit 0, no output)
```

### Notes

- The one console noise line (`An update to VirtualizedList inside a test was
  not wrapped in act(...)`) is pre-existing, present across specs 071/072/073,
  and does not affect test pass/fail counts. It is a VirtualizedList
  state-update timing artifact in the JSDOM renderer, unrelated to this spec.
- No backend / RLS / migration / edge-function / realtime surface touched.
  pgTAP and smoke tracks are not relevant to this spec.
- The `act()` noise is the only open test-hygiene item; it predates spec 073
  and is out of scope here.
