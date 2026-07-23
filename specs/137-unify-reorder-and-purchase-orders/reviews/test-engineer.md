## Test report for spec 137

### Acceptance criteria status

- AC1: A single "Ordering" sidebar item (PLANNING group) replaces the separate
  `Reorder` and `PurchaseOrders` sidebar items; selecting it opens a tabbed
  surface with Reorder + Purchase orders tabs → **PASS** —
  `src/screens/cmd/sections/__tests__/OrderingSection.test.tsx::OrderingSection — shell render + landing tab::renders both tabs and mounts the Reorder tab`
  (component-level) + `e2e/reorder.spec.ts::AC-REORD-DEPTH-1` (live-stack,
  clicks `nav-Ordering` then `ordering-tab-reorder`, ran green against the
  local Supabase stack — see Test run below). The `cmdSelectors.ts` item-swap
  itself (`Ordering` replacing `Reorder`/`PurchaseOrders` in
  `useDefaultSidebarGroups`) has no dedicated jest unit test asserting the
  sidebar-group *contents*, but it is exercised transitively by the e2e run
  (nav-Ordering only exists if the selector emits that id) and by the git
  diff, which shows the swap landed exactly per the architect's design (see
  Notes).

- AC2: The surface defaults to the Reorder tab on open → **PASS** —
  `OrderingSection.test.tsx::renders both tabs and mounts the Reorder tab
  (ReorderSection) on open` (asserts `reorder-root` present, `po-filter-all`
  absent on initial mount).

- AC3: Reorder tab renders `ReorderSection`, Purchase-orders tab renders
  `POsSection`, both mounted as-is, no per-section behavior loss, tab switch
  shows the corresponding content → **PASS** —
  `OrderingSection.test.tsx::switches to the Purchase-orders tab on manual tab
  press (ReorderSection unmounts)` + the full unchanged
  `ReorderSection.*`/`POsSection.test.tsx` suites (all green, see Test run).

- AC4: Pressing `+ CREATE PO` on a Reorder vendor card, on `createPoDraft`
  success, switches the active tab to Purchase orders AND selects the newly
  created draft PO in the list pane → **PASS** —
  `OrderingSection.test.tsx::"+ CREATE PO" success flips to the PO tab and
  preselects the new draft` (presses `reorder-create-po-v-a`, awaits
  `reorder-root` unmount, asserts `po-list-po-123` carries the "selected"
  2px accent border style).

- AC5: The manual path still works — switch to Purchase-orders and select any
  PO by hand, independent of the deep-link → **PASS** —
  `OrderingSection.test.tsx::manual path still works — no signal fires when
  just switching tabs` (asserts the auto-select effect picks the newest PO
  and `useOrderingHandoff.getState().pendingPoId` stays `null`).

- AC6: Spec-123 duplicate-prevention preserved — the Reorder card still shows
  the disabled "PO CREATED" chip after a PO exists for (store, vendor, date)
  → **PASS** — `ReorderSection.spec123.test.tsx` (existing suite, byte-
  unchanged, ran green in the full suite — see Test run and Notes for the
  git-diff verification that this file was not touched).

- AC7: Sidebar-override fallback — a saved override referencing the old
  `Reorder`/`PurchaseOrders` ids lands on the new "Ordering" destination, no
  dead entry, no crash, dedupe when both legacy ids are saved → **PASS** —
  `OrderingSection.test.tsx::remapLegacySidebarOverrideIds — spec-008
  override fallback` (six unit tests: single-id remap ×2, dedupe of both
  legacy ids to one `Ordering`, non-legacy ids pass through untouched,
  null/undefined/empty inputs unchanged, and an `applySidebarOverride`
  integration check that the remapped id is actually placed per the override).

- AC8: The existing per-section jest suites (`ReorderSection.test.tsx`,
  `ReorderSectionCases.test.tsx`, `ReorderSection.spec123/130/135.test.tsx`,
  `POsSection.test.tsx`) continue to pass unchanged → **PASS** — confirmed
  two ways: (1) `git status --short` shows none of these six test files as
  modified (only `ReorderSection.tsx`, `POsSection.tsx`, `TabStrip.tsx`, and
  the non-test files listed in the spec's "Files changed" are dirty); (2) all
  six suites are present and green in the full jest run (see Test run).

- AC9: A new jest test asserts (1) the Ordering shell renders both tabs and
  defaults to Reorder, (2) a simulated `createPoDraft` success routes to the
  Purchase-orders tab with the returned `poId` selected, (3) the
  sidebar-override fallback resolves an old-id override to the Ordering
  destination → **PASS** — all three land in
  `OrderingSection.test.tsx` exactly as designed (see AC1/2, AC4, AC7 above).

- Palette reachability (design §5, not separately numbered in the AC list but
  called out in this review's task) — ⌘K search still matches "reorder" and
  "purchase orders" search words and routes to Ordering, via the three-entry
  `SCREEN_ENTRIES_DEFS` + `alias`-disambiguated ids → **NOT TESTED**. The code
  change in `src/lib/cmdSelectors.ts` (three entries, all `route: { name:
  'Ordering' }`, `alias: 'reorder'` / `alias: 'pos'` folded into the built id
  to avoid a React-key/id collision) matches the design exactly on inspection,
  but there is no jest test anywhere in the repo that calls
  `getCommandPaletteIndex` / exercises `SCREEN_ENTRIES_DEFS` at all (grepped
  for `getCommandPaletteIndex`, `SCREEN_ENTRIES_DEFS`, `screen:Ordering` across
  `src/**/__tests__` and `src/**/*.test.ts*` — zero hits). This is a
  pre-existing gap (no prior spec ever added palette-entry coverage either),
  but spec 137 is the first to introduce the `alias`-disambiguation mechanism,
  which is exactly the kind of thing a future refactor could silently break
  (e.g. someone "simplifying" the id back to `screen:${name}` and reintroducing
  the three-way key collision) with nothing catching it. Flagging as NOT
  TESTED rather than blocking outright, since it was also not required by the
  spec's own §7 "Jest approach" (which only commits to the three
  `OrderingSection.test.tsx` seams) — but the spec's AC list bullet does
  explicitly mention it ("no dead/dangling sidebar entry... Mechanism is the
  architect's to specify" is about the override, but the standalone palette-
  reachability requirement in this review's task is a real, unclosed gap).

### Test run

```
npx jest > <scratchpad>/te137.log 2>&1; echo $?
```
Exit code: **0**
```
Test Suites: 129 passed, 129 total
Tests:       1376 passed, 1376 total
Snapshots:   0 total
Time:        4.616 s
```
Confirmed present and green in that run:
- `PASS component src/screens/cmd/sections/__tests__/ReorderSection.test.tsx`
- `PASS component src/screens/cmd/sections/__tests__/ReorderSection.spec123.test.tsx`
- `PASS component src/screens/cmd/sections/__tests__/ReorderSection.spec130.test.tsx`
- `PASS component src/screens/cmd/sections/__tests__/ReorderSection.spec135.test.tsx`
- `PASS component src/screens/cmd/sections/__tests__/ReorderSectionCases.test.tsx`
- `PASS component src/screens/cmd/sections/__tests__/POsSection.test.tsx`
- `PASS component src/screens/cmd/sections/__tests__/OrderingSection.test.tsx`

Typecheck gates (both required by CI):
```
npx tsc --noEmit             → exit 0
npx tsc -p tsconfig.test.json --noEmit → exit 0
```

Additional signal beyond the developer's own verification — the local
Supabase stack (`npm run dev:db`) was already running, so I ran the updated
Playwright e2e spec against the live app rather than relying on static review
alone:
```
npx playwright test e2e/reorder.spec.ts --project=chromium
```
Result: **4 passed** (3 auth-setup projects + `AC-REORD-DEPTH-1`), confirming
`nav-Ordering` → `ordering-tab-reorder` → `reorder-root` visible resolves
correctly end-to-end against the real sidebar/section wiring, not just the
mocked jest harness. Grepped the rest of `e2e/*.spec.ts` for stray
`nav-Reorder` / `nav-PurchaseOrders` references — none found; the update was
scoped correctly to `reorder.spec.ts` + `fixtures/constants.ts` (no other e2e
spec navigated through the old sidebar items).

`git status --short` / `git diff` confirm the working tree matches the spec's
own "Files changed" list exactly: new files
`src/screens/cmd/sections/OrderingSection.tsx`,
`src/lib/orderingHandoff.ts`,
`src/screens/cmd/sections/__tests__/OrderingSection.test.tsx`; modified files
`ReorderSection.tsx`, `POsSection.tsx`, `TabStrip.tsx`, `sidebarLayout.ts`,
`ResponsiveCmdShell.tsx`, `InventoryDesktopLayout.tsx`, `cmdSelectors.ts`,
`EODCountSection.tsx`, three i18n catalogs, and the two e2e files. No other
test file in the repo shows as modified.

### Notes

- **Interactive browser verification (preview tools).** The developer's own
  §Verification explicitly states the `preview_*` tools were not available in
  that agent's toolset, and substitutes a clean `npx expo export --platform
  web` as the non-interactive check. That gap is being covered externally
  (main Claude, via computer-use/Chrome preview tooling, separately from this
  review) rather than blocking here. For that pass, the golden path to
  exercise is: sidebar → click "Ordering" → lands on the Reorder tab by
  default → adjust a vendor's suggested quantities if desired → press
  "+ CREATE PO" on a vendor card → confirm the dialog → observe the shell
  auto-switch to the "Purchase orders" tab with the just-created draft PO
  already selected/highlighted in the list pane, no manual click needed →
  separately, confirm the manual path (switch tabs by hand, click any PO row)
  still works, and that a vendor with an existing PO for today still shows the
  disabled "PO CREATED" chip on the Reorder tab. Also worth an eyeball at the
  1100px responsive boundary (`ResponsiveCmdShell` / `MobileNavDrawer`) since
  the spec calls that out as a design risk area.
- **Palette reachability is the one real coverage gap** (detailed under the
  AC list above) — no jest test exercises `getCommandPaletteIndex` /
  `SCREEN_ENTRIES_DEFS` at all, so the three-entry `alias`-disambiguation this
  spec introduces (to prevent a `screen:Ordering` id/React-key collision) has
  no regression coverage. Recommend a small follow-up unit test (render or
  call `getCommandPaletteIndex` directly with a minimal `screens` list and
  assert three distinct ids/labels for "Ordering"/"Reorder"/"Purchase orders"
  all routing to `{ name: 'Ordering' }`) rather than blocking release on it —
  the underlying code was verified correct by direct read against the design,
  and it is exercised implicitly whenever the palette renders in any manual
  QA pass, but it is not CI-enforced.
- **No test framework introduced.** All new coverage lands in the existing
  jest track (`OrderingSection.test.tsx`) plus the pre-existing (spec 078)
  Playwright e2e track (`e2e/reorder.spec.ts`, already in-tree, not something
  this review introduced). No vitest/other framework was added or considered.
- **Scope discipline confirmed.** Nothing in this diff touches
  `supabase/migrations/`, RLS, edge functions, or `app.json`'s `slug` — matches
  the spec's own "N/A" backend-design sections; no pgTAP or shell-smoke
  coverage was needed or added, correctly.
