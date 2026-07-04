## Test report for spec 112

Scope confirmed frontend-only (OQ-8): `git status --porcelain -- supabase/`
returns empty. Per project policy, pgTAP DB tests and shell smokes are **not
required** for this spec — noted explicitly rather than silently skipped.
jest is the only applicable track.

### Acceptance criteria status

- **AC-1 (operational columns, 8-col order).** → **PASS** —
  `src/components/cmd/InventoryTable.test.tsx::AC-1 — operational columns at a
  wide (≥1400) width` (renders all 8 header labels + a data row's cost/
  stock-value/vendor cells) and
  `src/screens/cmd/__tests__/InventoryDesktopLayout.test.tsx::renders the
  operational column headers + a data row at full width` (same, through the
  real i18n keys). Verified `visibleColumnsForWidth` returns the 8 columns in
  spec order (name, onHand, status, costEach, stockValue, vendor, category,
  lastCounted) at ≥1400.

- **AC-2 (money cells match the detail header exactly — ★).** → **PASS** —
  `InventoryDesktopLayout.test.tsx::renders identical ★ money strings in the
  table cell and the detail header`. This is a genuine equality pin, not two
  independently-computed expectations: the test first asserts `$0.02`/`$120`
  render (table cell, pane closed), then opens the pane and asserts
  `getAllByText('$0.02').length ≥ 2` / `getAllByText('$120').length ≥ 2` — i.e.
  the SAME literal string now appears in both the table cell and the
  `DetailPane`'s `StatCard` header, produced by the SAME `itemMoney.ts`
  functions. Traced the render path: `InventoryTable.tsx`'s cost/each cell
  renders `formatCostPerEach(it)` as a standalone sibling `<Text>` (the unit
  label `/g` is a SEPARATE `<Text>`, not concatenated) — this is the money
  string as an isolated leaf. `StatCard.tsx`'s `value` prop is likewise
  rendered as its own standalone `<Text>{value}</Text>` leaf. Both sides feed
  from `itemMoney.ts` (`formatCostPerEach`, `formatStockValue`) — there is
  exactly one definition, confirmed by reading `InventoryDesktopLayout.tsx:33,
  613-617,625` (DetailPane header calls the helpers) and
  `InventoryTable.tsx:27-31,172,175,185` (table cells call the same imports).
  Math checked against spec-104 semantics: `formatCostPerEach` = raw per-each
  `costPerUnit.toFixed(2)` (NOT multiplied — confirmed no `× subUnitSize` in
  the cost-per-each path); `formatStockValue` = `currentStock ×
  (costPerUnit||0) × (subUnitSize||1)` (the OQ-5 per-each→per-counted-unit
  bridge, confirmed present). Fixture (`costPerUnit=0.02, subUnitSize=2000,
  currentStock=3`) → `$0.02` / `$120` matches the spec's case-6 pin exactly,
  also independently unit-pinned in
  `src/screens/cmd/lib/__tests__/itemMoney.test.ts`.

- **AC-3 (no auto-select on entry).** → **PASS** —
  `InventoryDesktopLayout.test.tsx::shows NO detail pane on entry (pane absent,
  no ✕)` — asserts `queryByLabelText(CLOSE_ARIA)` is null on mount with no
  palette action. Confirmed in source: the `:141-145`-era auto-select effect
  is gone from `InventoryDesktopLayout.tsx`; `selectedName` initializes to
  `null` and no effect sets it on mount. Confirmed via `git log` that no
  pre-spec-112 test ever pinned the old auto-select behavior (no prior
  `InventoryDesktopLayout.test.tsx` existed), consistent with the design
  note's claim.

- **AC-4 (click opens the side pane, table stays visible).** → **PASS** —
  `InventoryDesktopLayout.test.tsx::opens on row click, closes via ✕` (open
  half) plus the row-swap/pane-open-8→6 tests, all of which press a row and
  then find the ✕ (pane) present alongside the table (the table's own header
  cells remain queryable in the same tree). The "side pane, not takeover"
  shape is a rendering/layout claim (the `flexDirection: 'row'` table+pane
  sibling structure) — jest's tree assertions correctly confirm co-presence;
  the literal visual layout claim is a browser-verification item (see Notes).

- **AC-5 (three close paths: ✕ / Esc / same-row re-click).** → **PASS** — all
  three explicitly pinned as separate `it()` blocks:
  `closes via ✕` (inside case 3), `closes via Esc (web keydown)` (dispatches a
  real `KeyboardEvent('keydown', {key:'Escape'})` on `window`, wrapped in
  `act()`), `closes via same-row re-click (toggle-off)`. The Esc test also
  depends on the `Platform.OS` mock being forced to `'web'`
  (`react-native/Libraries/Utilities/Platform` mock, line 53-57) — correctly
  set up so the web-only listener installs under jsdom (which jest-expo
  otherwise defaults to `'ios'`).

- **AC-6 (row-swap keeps pane open, no close/reopen flicker).** → **PASS** —
  `InventoryDesktopLayout.test.tsx::swaps content on a different-row click
  without closing`. Clicks Tomato (pane open, asserts `Tomato` appears ≥2×:
  row + hero), then clicks Basil and asserts the ✕ is STILL present (pane
  never closed) and `Basil` now appears ≥2× (hero swapped). This correctly
  distinguishes "swap" from "close-then-reopen" because it never asserts an
  intermediate absence of the ✕.

- **AC-7 (priority-based collapse, tiers + boundaries).** → **PASS** (with a
  minor gap noted below). `InventoryTable.test.tsx` covers `visibleColumnsForWidth`
  at 1400 (all 8), 1399 (drop lastCounted), 1200 (keep category), 1150 (floor:
  drop both). Render-level tests hit 1450 / 1250 / 1150 for the same tiers.
  **Gap:** neither test file calls `visibleColumnsForWidth(1100)` or `(1199)`
  — the literal tier-boundary integers from the design note's table — though
  both sides of both boundaries ARE exercised via 1150/1200/1250 and
  1399/1400/1450, so the tier LOGIC is proven; only the exact edge integers
  are untested. Not blocking (the `>=` comparisons in
  `visibleColumnsForWidth` make 1100 and 1199 low-risk given 1150 and 1200 are
  already pinned on either side of the only boundary between them), but
  flagging per the review request's explicit ask.

  **AC-7 post-impl-fix regression pins — verified as genuine, not
  tautological:**
  (a) *Pane-open 8→6.* Traced the math: `tableWidth = windowWidth -
  (chromeW ?? FALLBACK_CHROME) - (item ? PANE_WIDTH : 0)` in
  `InventoryDesktopLayout.tsx:232-235`. In the jest renderer `onLayout` never
  fires (confirmed by the test's own comment and by RNTL's known behavior), so
  `chromeW` stays `null` and `FALLBACK_CHROME` (260) is used for the whole
  test. With `mockWindowWidth=1800` (the `beforeEach` default): closed
  (`item` undefined) → `1800-260-0=1540` → all 8 columns; after
  `fireEvent.press('Tomato')` sets `selectedName` → `item` becomes defined →
  re-render computes `1800-260-620=920` → the 6-column floor. The test reads
  `visibleColCount()` via `screen.queryByText(<i18n key>)` against the ACTUAL
  rendered tree (not a width prop or a mock), goes from 8 → 6, and separately
  asserts the specific dropped keys (`lastCountedCol`, `categoryCol`) are
  absent while floor survivors remain. **This test would FAIL against the
  pre-fix frozen-`onLayout`-measured-width code**: per the spec's own
  post-impl-fix narrative, the pre-fix code measured `listWidth` once via
  `onLayout` on the flex:1 wrapper at mount and never recomputed it on the
  `item` truthy transition, so `visibleColCount()` would have stayed `8`
  after the press and the `expect(visibleColCount()).toBe(6)` assertion would
  fail. Confirmed a genuine regression pin.
  (b) *1500px window → 7 columns.* The test reassigns the module-level
  `mockWindowWidth = 1500` before calling `renderLayout()`; this flows through
  the mocked `react-native/Libraries/Utilities/useWindowDimensions` factory
  (`default: () => ({ width: mockWindowWidth, ... })`, line 73-76) into the
  component's `windowWidth` variable, then into the `tableWidth` arithmetic,
  then into the `width` prop passed to `InventoryTable`. This IS driven
  through the mocked hook and the component's own derivation — it is NOT a
  direct `width` prop injected on `InventoryTable` that bypasses
  `InventoryDesktopLayout`'s arithmetic. `1500-260-0=1240` → tier 1200-1399 →
  7 columns (drop lastCounted only), matching the assertion.

- **AC-8 (catalog.tsv / categories untouched).** → **PASS** —
  `InventoryDesktopLayout.test.tsx::keeps the catalog.tsv boundary` — presses
  the `catalog.tsv` tab (via the functional `TabStrip` stub) and confirms
  `InventoryCatalogMode`'s marker renders. This is a smoke test of the branch
  boundary, matching the spec's own framing ("a smoke assertion that the
  boundary held") — appropriately scoped, since `InventoryCatalogMode`'s own
  internal behavior is out of this spec's scope and presumably has its own
  test coverage elsewhere (not audited here — out of AC-8's claim, which is
  only that the BOUNDARY held).

- **AC-8b (store switch closes the pane).** → **PASS** —
  `InventoryDesktopLayout.test.tsx::clears selection (closes the pane) when
  the store switches`. Opens the pane, mutates `mockState.currentStore.id` to
  `'store-2'`, `rerender()`s, and asserts the ✕ (pane) is gone. Correctly
  exercises the `[currentStore.id]`-keyed `useEffect` in
  `InventoryDesktopLayout.tsx:180-182`.

- **AC-8c (selection ephemeral across section changes).** → **PASS** (via
  code inspection, not a NEW test). The `section !== 'Inventory' →
  setSelectedName(null)` effect (`InventoryDesktopLayout.tsx:137-139`) is
  byte-identical to the pre-existing `:105-107` behavior the spec says is
  already covered; this spec did not touch that effect. No new jest case
  targets it (the spec's own AC-13 list doesn't ask for one either, since it's
  a no-op carry-forward), and this is a reasonable design-time waiver — the
  effect's logic is unchanged and trivial (a one-line conditional), and the
  spec explicitly frames it as "already the existing behavior."

- **AC-9 (i18n ×3 for the 5 new keys, real translations).** → **PASS** — read
  `src/i18n/en.json`, `es.json`, `zh-CN.json` directly: all 5 keys
  (`nameCol`, `stockValueCol`, `categoryCol`, `lastCountedCol`,
  `closeDetailAria`) exist under `section.inventory.*` in all three catalogs
  with real, non-placeholder es/zh-CN strings (e.g. `stockValueCol` →
  "valor stock" / "库存价值"; `closeDetailAria` → "Cerrar detalle del
  artículo" / "关闭商品详情"). The pre-existing
  `src/i18n/i18n.test.ts::i18n catalog parity` suite's identical-key-set
  assertion (`flattenKeys` diff across all three catalogs) ran clean in the
  full jest pass and would hard-fail if any catalog were missing one of these
  5 keys, or if a leaf were a non-string placeholder — confirmed this
  mechanism is real by reading the test file directly (not just trusting the
  spec's claim).

- **AC-10 (below-1100 narrow tier: keep usable list ↔ detail).** → **NOT
  TESTED.** `InventoryDesktopLayout.test.tsx` forces
  `mockIsDesktop.mockReturnValue(true)` in every test's `beforeEach` (line
  230) and no test in either new file ever sets `useIsDesktop → false` or
  otherwise exercises the `<1100` `else`-branch (`InventoryDesktopLayout.tsx`
  lines 467-520 — the `InventoryRow` + `FlatList` full-width list ↔
  full-width-detail swap). Confirmed via grep: no test file in the repo (past
  or present) mocks `useIsDesktop` to `false` for this component, and
  `InventoryRow.tsx` itself has never had a dedicated test file in this
  repo's history (`git log --diff-filter=A -- "*InventoryRow*test*"` returns
  nothing). This is a genuine coverage gap on a listed AC, not a design-time
  waiver — the spec explicitly frames AC-10 as "must not regress today's
  phone/tablet usability," but there is no automated check that it doesn't.

- **AC-11 (drawers keep working: EDIT / DELETE / +COUNT with the pane
  open).** → **NOT TESTED.** No test in either new file presses EDIT, DELETE,
  or +COUNT, or asserts `deleteItem`/`setEditDrawerOpen`/the palette
  `request()` fire correctly, or that DELETE clears the selection. The
  `IngredientFormDrawer` is mocked to `() => null` in the test file (so its
  open/close prop is never actually observed), and `deleteItem` is a bare
  `jest.fn()` never asserted to have been called. Traced this logic against
  the pre-spec-112 commit (`b77d7f6`): the `confirmAction` → `deleteItem` →
  clear-selection → toast wiring is a byte-for-byte carry-forward (spec 112
  changed WHERE the pane renders, not this logic), and it was ALSO untested
  before spec 112 (no `InventoryDesktopLayout.test.tsx` existed prior). So
  this is a pre-existing gap that spec 112 does not newly introduce or
  regress — but the AC is explicitly listed in the spec's acceptance
  criteria, and per house rules an AC with no test is a BLOCK regardless of
  whether the underlying code changed. Flagging as NOT TESTED, not waived.

- **AC-12 (a11y on the ✕ close: role + label).** → **PASS** (label) /
  **partial** (role). Every open/close assertion in the new test file queries
  via `screen.getByLabelText(CLOSE_ARIA)` /
  `screen.queryByLabelText(CLOSE_ARIA)` against the real i18n key string —
  this exercises the `accessibilityLabel={T('section.inventory.
  closeDetailAria')}` prop directly and would fail if the label were absent
  or wrong (confirmed present at `InventoryDesktopLayout.tsx:456-457`). The
  `accessibilityRole="button"` on the same element (`:456`) is present in
  source but is not independently queried by role in any test (e.g. no
  `getByRole('button', {name: ...})`) — a minor gap, but the label
  presence/absence checks across 7+ assertions give strong practical coverage
  of this element's a11y wiring. Calling this PASS overall since the
  primary AC-12 ask (the label exists and is correct) is directly exercised
  many times over; the role-specific query is a nice-to-have not present.

- **AC-13 (jest coverage — meta-criterion).** → **PASS** — all 8 of the
  spec's own enumerated jest cases (table columns; no detail on entry;
  open/close ×4 paths; row-swap; store-switch; ★ money value-pin; catalog
  boundary) plus the two AC-7 post-impl-fix regression pins are present and
  pass. See AC-1 through AC-8b above for the per-case breakdown.

- **AC-14 (web + native cross-platform primitives; Esc web-only).** → **PASS**
  (via code inspection + the Esc test). `InventoryTable.tsx` and
  `itemMoney.ts` reference zero web-only APIs (confirmed by the
  security-auditor's independent grep, which I cross-checked by reading both
  files directly — `View`/`Text`/`TouchableOpacity`/`FlatList` only). The
  `Platform.OS !== 'web'` early-return on the Esc listener
  (`InventoryDesktopLayout.tsx:189`) means native never touches
  `window`/`KeyboardEvent`; this early-return itself isn't directly tested
  under a native `Platform.OS` mock (the one test file that exercises Esc
  forces `Platform.OS='web'` to make the listener install — the inverse case,
  "native doesn't crash/leak," is asserted only by code inspection, not a
  dedicated native-mode test). Given the spec explicitly frames "its absence
  on native is acceptable" and no native test harness exists on this project
  (per CLAUDE.md, native testing is out of scope for this repo currently),
  I'm not blocking on the missing native-mode variant — this matches the
  documented project posture, not a spec-112-specific gap.

### Test run

```
npx jest
```
Result (clean re-run, confirmed twice): **90 suites passed / 90 total, 993
tests passed / 993 total**, 0 failed, 3.2s. Matches the dev's claim exactly.

Note: an initial full run hit `FAIL src/components/cmd/
CountOrderDragList.nudge.test.tsx — A jest worker process (pid=77211) was
terminated by another process: signal=SIGSEGV` (987/993 that run). This is an
unrelated jest-worker infra crash (out-of-process memory/parallelism
artifact), not a real test failure — confirmed by re-running that single
suite in isolation (`npx jest src/components/cmd/
CountOrderDragList.nudge.test.tsx`), which passed clean (6/6), and by two
subsequent full-suite re-runs both landing at 90/90 · 993/993 with no
SIGSEGV. `CountOrderDragList` is an unrelated drag-reorder feature, not part
of spec 112. Not counted as a spec-112 failure.

```
npx tsc --noEmit
```
Exit 0. Clean.

```
npx tsc -p tsconfig.test.json --noEmit
```
Exit 0. Clean.

**pgTAP (`npm run test:db`) and shell smokes (`npm run test:smoke`) were NOT
run** — per the spec's own Design note ("Backend surface: NONE... Reviewer
fan-out: skip all DB tracks") and confirmed independently via `git status
--porcelain -- supabase/` (empty). This is a deliberate, spec-authorized skip
for a frontend-only change, not a silent omission.

### Notes

- **Browser verification (main Claude, this session) stands as evidence for
  the visual/runtime ACs this jest suite cannot directly assert** (DOM
  layout/visual "side pane, not takeover," the live pane-open/window-resize
  re-tier under a REAL browser reflow rather than a mocked hook, and the
  live money-string byte-match in an actual rendered page): entry 8 cols /
  pane-open 6 cols / ✕-restore 8 cols / real-resize 7 cols confirmed live;
  money strings byte-match live; ✕ and Esc verified live. Per the task
  framing, the 1500px emulated-resize needed a `visualViewport` event
  dispatched manually — a browser-automation harness artifact (real user
  resizes fire this natively; the automation tool doesn't), not a product
  defect. This live pass is a reasonable substitute for the "Interactive
  click/resize browser tools were not available in THIS session" gap the
  frontend developer flagged in the spec's own Verification section — the
  gap has since been closed by the coordinator's browser pass, and the jest
  regression suite independently reproduces the same defect deterministically
  (see AC-7 above), so the two lines of evidence corroborate each other.

- **Two AC gaps, both Critical per house rules:**
  - **AC-10 (narrow `<1100` tier)** has zero jest coverage. No test in the
    repo, past or present, forces `useIsDesktop → false` for this component
    or exercises `InventoryRow`'s list↔detail swap path. This is new
    surface area for a test (the pre-spec-112 code had this exact
    `isDesktop`-gated fork already, per the design note's OQ-3 discussion —
    but it, too, was never tested, since no `InventoryDesktopLayout.test.tsx`
    existed before this spec). Recommend a follow-up jest case:
    `mockIsDesktop.mockReturnValue(false)` + assert `InventoryRow` renders
    full-width, clicking a row swaps to a full-width detail (no side-by-side),
    and ✕ returns to the list.
  - **AC-11 (drawers: EDIT / DELETE / +COUNT)** has zero jest coverage in
    either new test file. This logic is a verbatim carry-forward from
    pre-spec-112 code (confirmed via diff against `b77d7f6`) and was ALSO
    untested before this spec, so spec 112 introduces no NEW regression risk
    here — but the AC is explicitly listed and the "reused verbatim, no test
    needed" reasoning isn't stated anywhere in the spec or design note as an
    explicit waiver (the spec's own AC-13 jest-case enumeration simply never
    asked for one). Recommend a follow-up case: open the pane, press EDIT →
    assert the drawer prop flips to `visible=true`-equivalent (would need to
    un-mock `IngredientFormDrawer` or assert a call-count on a jest.fn mock);
    press DELETE → confirm `deleteItem` was called with the item id and the
    pane closes.

  Per the review request's house rule ("any AC FAIL/NOT TESTED is Critical
  unless defensibly waived"), I'm not treating either as a defensible waiver:
  AC-10 is genuinely new-to-this-spec surface with a real regression risk
  band (a change to the shared `tableWidth`/`isDesktop` branching could
  silently break the narrow path with nothing catching it), and AC-11, while
  low regression-risk (unchanged code), is still explicitly enumerated in the
  spec's acceptance criteria with no test and no stated waiver.

- **Minor, non-blocking gap:** `visibleColumnsForWidth` is not called at the
  literal boundary integers 1100 and 1199 (only 1150/1200/1250/1399/1400/1450
  are exercised). Both sides of the actual tier boundaries ARE covered, so
  this is a completeness nit, not a logic gap — noting per the review
  request's explicit ask, not blocking.

- **Minor, non-blocking gap:** `accessibilityRole="button"` on the ✕ close
  button is present in source but not independently queried by role in any
  test (only `accessibilityLabel` is exercised, repeatedly). AC-12's label
  requirement is well-covered; the role requirement is covered only by code
  inspection.

- **Framework note:** no new test framework was introduced. All new tests
  land in the existing jest track (`src/screens/cmd/lib/__tests__/
  itemMoney.test.ts`, `src/components/cmd/InventoryTable.test.tsx`,
  `src/screens/cmd/__tests__/InventoryDesktopLayout.test.tsx`), consistent
  with spec 022's three-track policy and the spec's own "jest is the only
  track this feature needs" framing.

- **`app.json` slug** — untouched, not referenced by this spec or its tests.
  No action needed.

## Resolution (main Claude, post-review fix pass — 2026-07-04)

Both NOT TESTED Criticals closed with real behavior pins in
`InventoryDesktopLayout.test.tsx`:

- **AC-10 (below-1100 narrow tier) — FIXED, 2 tests.** `useIsDesktop → false`:
  the InventoryRow list renders full-width with NO table header and no detail
  on entry; selecting swaps to the full-width detail (other rows gone, ✕
  present); ✕ returns to the list.
- **AC-11 (detail-header actions) — FIXED, 3 tests.** DELETE is confirm-gated
  (mockConfirm fired) → `deleteItem('i1')` → pane closes; EDIT opens the
  IngredientFormDrawer (visible-gated marker mock); + COUNT fires the palette
  bridge with `{ section: 'EODCount', eodFocusItemId: 'i1' }`.
- Plus one more pin from the code-review Should-fix: the store-switch clear is
  scoped to the per-store tab (selection survives a catalog-tab store switch).
- Minor nits (boundary integers, ✕ role query) — left as noted; the tier
  boundaries are covered via neighboring values on both sides.

Post-fix: jest 999/999 across 90 suites (+6 from the reviewed state), both
typechecks exit 0. The transient SIGSEGV jest-worker artifact did not recur
across the post-fix runs.
