## Test report for spec 135

### Acceptance criteria status

- AC1: Each expandable `VendorCard` header renders a `▸`/`▾` chevron affordance matching the existing "NO ORDER SCHEDULE" toggle → **PASS** — `src/screens/cmd/sections/__tests__/ReorderSection.spec135.test.tsx::exposes accessibilityState.expanded reflecting current state` (a11y state toggles); glyph byte-match with the precedent toggle (lines 575-577 vs the "NO ORDER SCHEDULE" toggle at ~1655) verified by direct code read, consistent with project convention — no existing test (including the precedent group toggle's own test) asserts the raw `▾`/`▸` glyph text either, so this is not a coverage regression, just noting the glyph itself is confirmed by inspection, not by a jest string assertion.

- AC2: The tap target for toggling is the chevron + vendor-name text; badges/short id/stats row/footer buttons do NOT toggle → **NOT TESTED** — no test in `ReorderSection.spec135.test.tsx` presses a badge, the stats row, or a footer button (e.g. `reorder-create-po-v-a`) and then asserts the card stays expanded / `onToggleCollapse` did not fire. Verified correct **by code structure** only: `headerNameRowCollapsible` (ReorderSection.tsx:565-590) wraps only the chevron `Text` + vendor-name `Text` in the `TouchableOpacity`; badges, short id, stats row (line 686), and the footer (line 790) are structural siblings outside that touchable, so there is no event-bubbling path by which pressing them could fire `onToggleCollapse`. This is a real behavior described by an AC with no direct jest assertion — flagged below as a gap, not blocking given the low-risk sibling structure (also called out favorably in the code-reviewer's file).

- AC3: The toggle control has `accessibilityRole="button"` and `accessibilityState={{ expanded: <bool> }}` reflecting current state → **PASS** — `ReorderSection.spec135.test.tsx::exposes accessibilityState.expanded reflecting current state` (asserts `true` before press, `false` after `fireEvent.press`). `accessibilityRole="button"` itself is set in code (line 570) but not independently asserted by a `props.accessibilityRole` check in the test — only `accessibilityState` is read. Treating as PASS since the same JSX prop is exercised by the render and the missing prop-value assertion is a minor test-completeness nit, not a functional gap.

- AC4: Default state on load is EXPANDED for every card → **PASS** — `ReorderSection.spec135.test.tsx::renders every card expanded by default (body + header stats visible)`.

- AC5: When collapsed, column-header strip / item rows / footer (actions + eod-counted line) / open quick-order preview are hidden; header block (name/badges/next-delivery/stats row) stays visible → **PASS** — `ReorderSection.spec135.test.tsx::collapse hides the body (columns/items/footer) but keeps the header stats`. Verified by code read that the quick-order preview block (lines 821-846) and the eod-counted-line footer content (lines 789-819) are both inside the same `!collapsed` gate as the column strip/items, so the single footer-testID probe (`reorder-create-po-v-a`) used by the test is representative of the whole gated block, confirmed by direct code inspection of the JSX (one `{!collapsed ? (<>...</>) : null}` wrapper spanning lines 712-848).

- AC6: Pressing CREATE PO / quick-order / CSV / PDF never toggles collapse → **NOT TESTED** (same gap as AC2 — no test presses a footer button and asserts collapse state is unaffected). Structurally guaranteed (footer is a sibling of the toggle touchable, and while collapsed the footer isn't rendered at all so it cannot be pressed), but not exercised by jest.

- AC7: Collapsed/expanded state is per-session `ReorderSection` state (a `Set` of collapsed vendor keys), survives debounced realtime reloads, resets to all-expanded on store switch or navigate-away-and-back, no persistence → **PARTIALLY TESTED** — the `Set`-based per-card independence (group-qualified keys) IS tested (see AC-key-independence below). The **store-switch reset** is **NOT TESTED**: no test in `ReorderSection.spec135.test.tsx` (or any other Reorder test) changes `mockState.currentStore` mid-test and asserts `collapsedKeys` resets to empty. Verified by code read only: `setCollapsedKeys(new Set())` sits inside the `storeChanged` branch of the existing store-switch effect (ReorderSection.tsx:1237-1245), gated correctly so it does NOT fire on the same-store `selectedDate` change path. Survival across realtime-driven re-renders is true by construction (state lives in `useState` at the `ReorderSection` level, which doesn't remount on prop/parent re-render) and isn't itself something jest would need to separately exercise — no gap there. Navigate-away-and-back reset is unmount-for-free per the design's own caveat and is native-navigation-shell behavior, out of scope for a component test. **The store-switch-reset half of this AC has no direct test coverage.**

- AC8: The violet "count not submitted" card renders NO chevron and is NOT collapsible → **PASS** — `ReorderSection.spec135.test.tsx::the count-not-submitted card has no chevron and is not collapsible` (asserts `queryByTestId('reorder-vendor-toggle-nosub-v-b')` and `queryByTestId('reorder-vendor-toggle-need-v-b')` are both null while the state block itself is present).

- AC9: KPI stat cards and warning banners are unaffected → **PASS (by regression, not new assertion)** — no new test in the spec135 file exercises KPI/warning-banner rendering directly, but this spec touches no KPI-computation or warning code path (`computeReorderKpis` / warnings array untouched — confirmed by code read), and the pre-existing KPI/warning-banner assertions in `ReorderSection.test.tsx` continue to pass unmodified in the full `npx jest` run (see below), which is direct regression evidence that this AC holds.

- AC10: The "NO ORDER SCHEDULE" group toggle continues to work; a card inside that group is independently collapsible via its own chevron once the group is expanded → **PARTIALLY TESTED / gap on the new half.** The group-toggle-continues-to-work half is regression-covered by the pre-existing `ReorderSection.test.tsx::renders the secondary no-schedule group (collapsed) when scheduleKnown=false vendors exist` test, which still passes. The **new** half of this AC — that a card inside the (now-expanded) no-schedule group has its own working chevron — is **NOT TESTED**: no test in the suite expands the no-schedule group (`fireEvent.press` on `reorder-no-schedule-toggle`) and then interacts with a `nosched-`-keyed card's toggle. The `nosched-${vendorId}` key rename and prop-threading at the no-schedule call site (ReorderSection.tsx:1667-1677) is code-identical to the tested `need-`/`ok-` call sites, so risk is low, but this is a real, spec-called-out scenario with zero direct jest coverage.

- AC11 (jest track requirement): a `ReorderSection`-level test asserts collapse hides item rows/column strip/footer while keeping header stats, and that the not-submitted card has no chevron → **PASS** — both assertions present and passing in `ReorderSection.spec135.test.tsx`.

### Group-qualified key independence (explicitly requested check)

**PASS** — `ReorderSection.spec135.test.tsx::keys collapse per group — collapsing the needs card leaves the enough card open`. Uses vendor `v-c` with one below-par item (`c1`, renders under `need-v-c`) and one at-par item (`c2`, renders under `ok-v-c`), collapses only `need-v-c`, and asserts `ok-v-c`'s item row + footer (`reorder-create-po-v-c`) remain present. This is the correct scenario shape per the spec's own dependency note (same `vendorId` can render in both needs and enough groups via `splitReorderVendorsByNeed`).

### No stale reliance on the renamed no-schedule key or "always visible body" assumption

Checked: no existing test (`ReorderSection.test.tsx`, `ReorderSectionCases.test.tsx`, `ReorderSection.spec123.test.tsx`, `ReorderSection.spec130.test.tsx`) references a React `key=` value directly (React keys are not queryable via RTL, and none of these files use `toMatchSnapshot`/`toJSON`), so the bare-`${vendorId}` → `nosched-${vendorId}` React-key rename is invisible to and safe against all pre-existing tests. Likewise, no existing test asserted "the body is always visible with no way to hide it" as a negative assertion — the pre-existing suite only asserts presence of column strip/items/footer under default (expanded) conditions, which is unchanged behavior (AC4/default-expanded holds), so nothing broke by construction. Confirmed empirically: full `npx jest` run below is green across all 125 suites, including all four sibling Reorder test files.

### Test run

```
npx tsc --noEmit                              → clean, no output
npx tsc -p tsconfig.test.json --noEmit        → clean, no output
npx jest                                      → Test Suites: 125 passed, 125 total
                                                 Tests:       1361 passed, 1361 total
                                                 Time:        4.721s
npx jest ReorderSection.spec135 --verbose     → 5/5 tests passed:
  ✓ renders every card expanded by default (body + header stats visible)
  ✓ collapse hides the body (columns/items/footer) but keeps the header stats
  ✓ keys collapse per group — collapsing the needs card leaves the enough card open
  ✓ the count-not-submitted card has no chevron and is not collapsible
  ✓ exposes accessibilityState.expanded reflecting current state
```

No failures. Console noise in the full run is pre-existing act()-wrapping warnings from unrelated `EODCount.tsx` tests (staff subtree) — not introduced by this spec and not test failures.

### Notes

- **Framework:** jest only, correct track for a Cmd UI component-level change per CLAUDE.md's three-track policy. No new framework introduced.
- **Live browser verification** of the visual chevron/collapse interaction is being handled by the main session per the task instructions — **covered-by-main-session, not blocking** from this report's perspective.
- **Coverage gaps found** (two distinct, both low-risk-by-code-structure but zero direct jest assertion):
  1. **AC2/AC6 — tap-target scoping.** No test presses a badge, the stats row, or a footer action button and asserts the card does NOT collapse/expand as a result. The current structure (siblings outside the toggle `TouchableOpacity`, footer unrendered while collapsed) makes this safe by construction, and the code-reviewer's file independently confirms the same structural read, but a regression here (e.g. a future refactor that nests the badges/footer inside the touchable) would not be caught by the current suite.
  2. **AC7/AC10 — store-switch reset and no-schedule-group card independence.** No test simulates a store switch (`mockState.currentStore` change) and asserts `collapsedKeys` resets to empty; no test expands the "NO ORDER SCHEDULE" group and interacts with a `nosched-`-keyed card's own chevron. Both paths are code-verified correct by inspection (store-switch reset sits correctly inside the `storeChanged` branch; the no-schedule call site threads the same four props as the tested `need-`/`ok-` sites) but neither is exercised by an automated test today.
- Per the "if any criterion is unverified, BLOCK" instruction: I'm treating AC2/AC6 (tap-target scoping) and the store-switch-reset half of AC7, plus the no-schedule-card-independence half of AC10, as **NOT TESTED** rather than silently rounding up to PASS, since the task explicitly asked me to check for exactly these things. These are the release-coordinator's call on whether to treat as Critical (no security/data-integrity stake — pure client view-state, and each gap is independently code-verified as structurally correct) versus a "ship with a follow-up test" recommendation. I am not the one to weigh that tradeoff — flagging for the release-coordinator per the standing instruction that any NOT TESTED AC is Critical for their purposes.
- All other ACs (default-expanded, collapse-hides-body-keeps-stats, not-submitted-has-no-chevron, group-qualified key independence, a11y `accessibilityState`, jest-track requirement) are directly PASS with a named test.
