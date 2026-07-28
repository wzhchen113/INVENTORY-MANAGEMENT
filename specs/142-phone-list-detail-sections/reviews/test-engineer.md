## Test report for spec 142

Track confirmation: this spec is frontend-only (§0 of the Backend design
confirms no DB/RLS/edge-function/`db.ts` changes). `git diff --cached --stat`
against `supabase/`, `scripts/`, and `e2e/` shows zero touched files in those
trees. **Jest track only** — no pgTAP, no shell smokes, no new test framework
introduced (no vitest/playwright additions; `e2e/` untouched). Confirmed clean
against the "no fourth framework" rule.

**Revision note:** this report was updated after the frontend-developer closed
the coverage gaps flagged in the prior pass. Re-verified by re-running
`npx jest` and `npx tsc --noEmit` myself (not trusting the prior run) and
re-reading every new/changed test file below.

### Acceptance criteria status

**Global phone chrome**
- AC-C1 (52px bar, 44×44 hamburger, title never overlapped) → PASS — `src/screens/cmd/sections/phone/__tests__/chrome.test.tsx::MobileTopAppBar height (AC-C1)`
- AC-C2 (bell-only trailing slot; blocked copy moves to banner below bar) → PASS — `chrome.test.tsx::NotificationToggle variant="bar" (AC-C2)` + `::NotificationBlockedBanner (AC-C2)`
- AC-C3 (CmdStatusBar / ⌘K hint absent on phone) → PASS — `chrome.test.tsx::CmdStatusBar suppression on phone (AC-C3)`
- AC-C4 (no desktop tab strip / toolbar / fixed pane on phone, umbrella) → PASS — enforced per-section by `PhoneSections.acReg.test.tsx` + `PhoneInventory.acReg.test.tsx` (desktop markers absent, phone testID present, for all 7 touched sections)

**Shared phone drill-in scaffold**
- AC-D1 (ONE shared scaffold, not six hand-rolled) → PASS (structural, not a behavior test) — verified by import grep: `PhoneCatalogList`, `PhoneInventoryList`/`PhoneInventoryDetail`, `PhoneMenuImpactList`, `PhonePrepRecipesList`, `PhoneMenuItemsList`, `PhoneVendorsList` all import `PhoneDrillScaffold`/`usePhoneDrill` from the one file; Waste correctly opts out (feed + sheet, no list→detail drill)
- AC-D2 (nothing selected by default; full-screen replace, no pane) → PASS — `PhoneDrillScaffold.test.tsx::shows the list only by default`
- AC-D3 (52px header / 44px ← / mono parent caption, 220ms slide-in) → PASS for header/back/caption — `PhoneDrillScaffold.test.tsx::opens a full-screen detail with a 52px header...`. The 220ms `Animated` timing itself is not asserted (RN `Animated` timing is not straightforwardly jest-observable without mocking `Animated.timing`) — acceptable gap, matches spec-140 precedent of not asserting sheet-animation duration either.
- AC-D4 (back restores scroll — list never remounted) → PASS — `PhoneDrillScaffold.test.tsx::returns to the list on ← and never remounts it` (mount-count probe stays at 1 across open→close)
- AC-D5 (honest toast for desktop-only edit actions) → PASS — `honestToast.test.tsx` (Recipes/Menu-impact shared detail: EDIT RECIPE toast + ORDER SHORTAGES nav) **and now also** `PhonePrepRecipes.test.tsx::opens stats + INGREDIENTS + USED IN and fires honest toasts` (EDIT RECIPE **and** LOG A BATCH, both asserted against the exact `Toast.show` call). Previously-flagged gap (Prep's honest toasts had no dedicated test) is closed.

**Inventory**
- AC-INV1 (segmented ALL/OUT/LOW/OK filter, always visible, 44px search) → PASS — `PhoneInventoryList.test.tsx::segments partition the set into ALL/OUT/LOW/OK counts`, `::filters the list to a status when its segment is tapped`
- AC-INV2 (two-line card row, semantic status pill not accent, no letter-stacking/truncation) → PASS (core claim) — `PhoneInventoryList.test.tsx::renders the OUT status pill in a semantic token, never the accent`. The row's right-aligned "44 /40 lbs" value and par bar are not individually pixel-asserted — minor, non-blocking (covered by dispatcher's manual pass).
- AC-INV3 (FlatList virtualization at 143 items, no default selection) → PASS — `PhoneInventoryList.test.tsx::virtualizes 143 items...`, `::selects nothing by default (no detail overlay)`
- AC-INV4 (item detail: pill/caption/name, stat panel, COUNT NOW deep-link, VIEW IN ORDERING, PROPERTIES card, RECENT COUNTS) → **PASS (gap closed)** — new `PhoneInventoryDetail.test.tsx`: `::renders name, stat panel, and PROPERTIES card`, `::COUNT NOW deep-links into the EOD keypad for this item` (asserts the exact `usePaletteAction` payload `{ section: 'EODCount', selectedName: null, eodFocusItemId: 'i1' }`), `::VIEW IN ORDERING jumps to the Ordering section`, `::RECENT COUNTS renders the item audit history`, `::RECENT COUNTS shows an empty state when there is no history`.
- AC-INV5 (catalog mode same phone shape, no fixed pane) → **PASS, and materially strengthened** — `PhoneInventory.acReg.test.tsx::phone catalog survives the tier-change remount (AC-INV5)`. This is the standout finding of this revision: the original acReg test rendered desktop and phone as if they were the *same* component instance switching props, which masked a real bug — `ResponsiveCmdShell` mounts `InventoryDesktopLayout` at a different JSX position per tier, so a tier change genuinely **unmounts + remounts** the host, which would reset the local `viewMode` `useState` back to `'per-store'` and make catalog-mode-on-phone unreachable after any resize. The rewritten test explicitly renders desktop, presses `catalog.tsv`, **unmounts**, then renders a **fresh** phone instance and asserts `phone-catalog` (not `phone-inventory`) is what comes up. This fails without the new `src/screens/cmd/lib/inventoryViewMode.ts` module-level persistence and passes with it — a genuine regression test for a bug that the prior test shape could not have caught. Good catch.
- AC-INV6 (375×812 visual acceptance check) → Manual evidence only (see Notes) — not a jest-testable criterion in the literal sense (full-viewport visual walkthrough); dispatcher performed this in-browser per the task brief, and additionally re-verified catalog-on-phone end-to-end in the browser after the AC-INV5 fix.

**Menu impact**
- AC-MI1 (two-line card rows sorted by capacity ascending, chip row, KPI line) → **PASS (gap closed)** — sort: `PhoneMenuImpact.test.tsx::PhoneMenuImpactList sort (AC-MI1)`; chips + KPI (new): `::renders the KPI caption and the ALL / IMPACTED ONLY chips` (asserts the exact "1 BLOCKED · 1 LIMITED · MOST-IMPACTED FIRST" caption text against a hand-counted fixture) and `::IMPACTED ONLY chip filters out the healthy row` (asserts the makeable-30 row is filtered out, the blocked/limited rows remain).
- AC-MI2 (server `menuCapacity` selector + client fallback formula) → PASS — `PhoneMenuImpact.test.tsx::clientMenuCapacity` (×2), `::recipeCapacity (server vs client)` (×2)
- AC-MI3 (same menu-item detail as BOM section) → PASS (structural, not a rendered-equality test) — both `PhoneMenuImpactList.tsx:129` and `PhoneMenuItemsList.tsx:152` import and render the identical `PhoneMenuItemDetail` component keyed off `recipeId={drill.selected.id}`; no jest test asserts this equivalence directly but the source guarantees it (single shared component, not two copies). Low risk — leaving as a note, not a block.
- AC-MI4 (375×812 visual acceptance) → Manual evidence only.

**Menu items / BOM (Recipes)**
- AC-BOM1 (row: margin pill, name, ingredient count + cost meta, price + makeable tag) → **PASS (gap closed)** — new `PhoneMenuItems.test.tsx::renders the ingredient-count + cost meta and the price` (asserts "2 INGREDIENTS · COST $" — 1 raw + 1 prep line — and "$12.00"). The margin pill / "×0 MAKEABLE" makeable-tag styling is not separately asserted in this row test — minor residual gap, low risk given `CapacityPill` is shared code already covered by `PhoneMenuImpact.test.tsx`'s chip/KPI assertions on the same underlying capacity math.
- AC-BOM2 (detail: stats, INGREDIENT AVAILABILITY rows, PLATE COSTING, EDIT RECIPE honest toast, ORDER SHORTAGES) → **PASS (gap closed)** — `PhoneMenuItems.test.tsx::opens the shared detail with stats, ingredient availability, PREP tag and plate costing` (MAKEABLE/PRICE/MARGIN stat labels, the raw-ingredient row + "NEED 2 lbs / PLATE" meta, the untracked-sub-recipe "PREP" tag on "House Sauce", the "PLATE COSTING" section) **plus** `honestToast.test.tsx` for EDIT RECIPE toast + ORDER SHORTAGES nav.
- AC-BOM3 (375×812 visual acceptance) → Manual evidence only.

**Prep recipes**
- AC-PREP1 (row: name, yield/batch cost meta, per-unit + "IN N MENU ITEMS") → **PASS (gap closed)** — new `PhonePrepRecipes.test.tsx::renders the yield/batch meta and the "IN N MENU ITEMS" count`.
- AC-PREP2 (detail: stats, INGREDIENTS, USED IN, EDIT RECIPE + LOG A BATCH honest toasts) → **PASS (gap closed)** — `PhonePrepRecipes.test.tsx::opens stats + INGREDIENTS + USED IN and fires honest toasts` (YIELD/BATCH COST stat labels, the ingredient row "Tomato", "USED IN 1 MENU ITEMS" + the consuming recipe name "Wings", and both honest toasts asserted against their exact copy).
- AC-PREP3 (375×812 visual acceptance) → Manual evidence only.

**Vendors**
- AC-VEN1 (row: delivery-days pill, name, contact/phone meta, lead+cutoff+item count) → **PASS (gap closed)** — new `PhoneVendors.test.tsx::renders the vendor row with contact/phone and lead/cutoff/items meta` (asserts "Sam · (301) 555-1234" and "LEAD 2d · CUTOFF 15:00 · 1 ITEMS"). The `DeliveryPill` glyph itself is rendered (`PhoneVendorsList.tsx:168`) but not separately asserted by testID/text in this test — minor residual gap.
- AC-VEN2 (detail: stats, CONTACT, ORDER CODES, SCHEDULE, CALL VENDOR, VIEW IN ORDERING) → **PASS (gap closed), and includes real edge-case coverage** — `PhoneVendors.test.tsx::opens stats + CONTACT/ORDER CODES/SCHEDULE and CALL sanitizes the tel: URL` (asserts `Linking.openURL` is called with exactly `'tel:3015551234'` — i.e. the phone-string sanitizer strips formatting punctuation before building the `tel:` URI — plus VIEW IN ORDERING's palette-action payload) and `::CALL VENDOR short-circuits (no tel:) when the vendor has no phone` (asserts `openURL` is NOT called and an honest `Toast.show` fires instead, for a vendor with `phone: ''`). This is exactly the kind of edge-case/robustness test I look for — not a happy-path-only smoke test.
- AC-VEN3 (375×812 visual acceptance) → Manual evidence only.

**Waste log**
- AC-WASTE1 (event feed, period total, reason chip row filters, ≥44×44 chips) → **PASS (gap closed)** — `PhoneWasteLog.test.tsx::reason chip row filters the feed (AC-WASTE1)` (seeds an Expired + a Theft event, asserts both render under the default "all" state, then presses `chip-Theft` and asserts the Expired row disappears while the Theft row remains). The period-total header text itself ("−$46.90 THIS WK"-shaped string) is not separately asserted — minor residual gap.
- AC-WASTE2 (two-step bottom sheet: picker → stepper/reason/cost preview → SAVE → `logWaste`) → PASS — `PhoneWasteLog.test.tsx::advances picker → stepper and SAVE calls logWaste with the chosen item/qty/reason`
- AC-WASTE3 (375×812 visual acceptance) → Manual evidence only.

**Regression guard**
- AC-REG1 (desktop + tablet byte-unchanged for all 7 touched sections) → PASS — `PhoneSections.acReg.test.tsx` (MenuImpact/Recipes/Prep/Vendors/Waste × desktop+tablet+phone = 15 tests) + `PhoneInventory.acReg.test.tsx` (InventoryDesktopLayout + InventoryCatalogMode × desktop+tablet+phone, **plus the new tier-change-remount case** = 6 tests), plus the 5 pre-existing desktop-only host suites (`InventoryDesktopLayout.test.tsx`, `InventoryCatalogMode.test.tsx`, `InventoryCatalogMode.spec122.test.tsx`, `MenuImpactSection.test.tsx`, `VendorsSection.test.tsx`) updated with an explicit `useIsPhone: () => false` mock and otherwise unchanged, still green — confirming their full pre-existing desktop assertion surface is undisturbed. Verified the `setLastInventoryViewMode('per-store')` reset added to both `InventoryDesktopLayout.test.tsx`'s and `PhoneInventory.acReg.test.tsx`'s `beforeEach` — module-level state in `inventoryViewMode.ts` is a plain `let` singleton, and while Jest sandboxes the module registry per test *file* (no cross-file leakage), it is shared across `it` blocks *within* a file unless reset; both files reset it explicitly, and I confirmed by inspection that no test relies on a stale value from a prior case. Isolation is sound.
- AC-REG2 (spec-140 EOD flow unaffected) → PASS (regression-by-omission) — the full spec-140 `eod/__tests__/` suite runs unchanged and green as part of the full `npx jest` run; no EOD test file appears in the "Modified" list, and none needed the `useIsPhone` mock fix (EOD already mocks breakpoints per spec 140).
- AC-REG3 (both themes render correctly) → NOT TESTED via jest — no test in this spec (or, on inspection, in the existing spec-140 EOD suite) asserts `DarkCmd` token application; this matches existing project precedent (theme-token-application on Cmd UI phone surfaces has always been manual/visual, not jest-asserted, even for spec 140). Dispatcher's manual browser pass at 375×812 covered both Light and Dark for all seven surfaces — treated as the verification mechanism for this AC, consistent with how spec 140 was verified. Not scored as a blocking gap given the established precedent, but noted for completeness.

### Test run

```
npx tsc --noEmit                       → clean, 0 errors
npx jest                               → Test Suites: 156 passed, 156 total
                                          Tests: 1559 passed, 1559 total
                                          Snapshots: 2 passed, 2 total
                                          (matches the coordinator's expected
                                          156 suites / 1559 tests exactly)
```

pgTAP (`npm run test:db`) and shell smokes (`npm run test:smoke`) were not
run — correctly out of scope per §0 (no migration, RLS, or edge-function
changes) and confirmed by the empty `git diff --cached --stat` against
`supabase/` and `scripts/`.

### Notes

**All six previously-flagged NOT TESTED acceptance criteria are now closed**
with real, content-asserting tests (not smoke/snapshot tests): AC-INV4
(`PhoneInventoryDetail.test.tsx`), AC-BOM1/2 (`PhoneMenuItems.test.tsx`),
AC-PREP1/2 (`PhonePrepRecipes.test.tsx`), AC-VEN1/2 (`PhoneVendors.test.tsx`).
The Waste chip-filter half of AC-WASTE1 and the chip/KPI half of AC-MI1 are
also now closed via extensions to the existing `PhoneWasteLog.test.tsx` /
`PhoneMenuImpact.test.tsx` files. I re-read every one of these files in full
(not just skimmed test names) and they all assert real, specific outcomes:
exact `usePaletteAction` payloads, exact `Toast.show` call shapes, an exact
sanitized `tel:` string, a hand-counted KPI caption string, and a filtered-row
existence/non-existence pair — not `toBeTruthy()`-only placeholder assertions.

**Standout finding: the AC-INV5 catalog-reachability fix is a genuine bug
catch, not just a coverage-gap fill.** The original `acReg` test rendered the
desktop and phone catalog paths as independent, single-instance renders, which
is not how `ResponsiveCmdShell` actually behaves on a real viewport resize —
it mounts `InventoryDesktopLayout` at a different position in the tree per
tier, so crossing a breakpoint unmounts and remounts the host. A `useState`
for `viewMode` would silently reset to `'per-store'` on that remount, making
catalog-mode permanently unreachable on phone after any resize — a real,
user-facing defect that the old same-instance test could not have caught. The
new `src/screens/cmd/lib/inventoryViewMode.ts` module-level singleton fixes
this, and the rewritten test (`unmount()` the desktop instance, `render()` a
fresh phone instance, assert `phone-catalog` not `phone-inventory` comes up)
is exactly the shape needed to guard it. I checked the module-state isolation
between test files (Jest's per-file module sandboxing prevents cross-file
leakage) and within the two files that now import
`setLastInventoryViewMode` (both reset it in `beforeEach`) — sound.

**Residual minor gaps (non-blocking).** A few sub-details of already-PASS ACs
are not pixel/text-asserted and rely on the dispatcher's manual 375×812 pass
for visual confirmation: the Inventory row's par bar and right-aligned stock
figure (AC-INV2), the Vendors row's `DeliveryPill` glyph (AC-VEN1), the Waste
feed's period-total header string (AC-WASTE1), and the Menu-items row's margin
pill / makeable-tag color threshold (AC-BOM1). None of these represent
untested *behavior* — they're untested *styling* of already-behavior-tested
rows — and none are new to this revision (they were present, unflagged as
blocking, in the prior pass too). AC-MI3 (same shared detail component for
Menu-impact and Recipes) remains structurally-verified-by-source rather than
assertion-verified; low risk since it's a single shared component instantiated
from two call sites, not a duplicated implementation that could drift. AC-REG3
(both themes) remains jest-untested, consistent with existing project
precedent (spec 140 didn't jest-test dark mode either) and covered by the
dispatcher's manual pass.

**No framework drift.** Confirmed jest-only; no vitest/playwright files added
or modified for this spec; `tests/README.md`'s Track 4 (Playwright `e2e/`)
exists in the repo from spec 078 but was correctly left untouched.

**`app.json` slug** — untouched, as required.

**Realtime** — no publication changes; `docker restart
supabase_realtime_imr-inventory` not required for this spec.

### Verdict

With the six previously-blocking NOT TESTED acceptance criteria now closed by
real tests, and the two partial gaps (AC-WASTE1 chip filter, AC-MI1 chips/KPI)
also closed, I have no remaining Critical (FAIL / NOT TESTED) findings for
this spec. The one still-open item, AC-REG3 (both themes via jest), is
consistent with pre-existing project practice for Cmd UI phone surfaces and is
covered by the dispatcher's manual verification — I'm not scoring it as
blocking. Full jest suite green (156/156 suites, 1559/1559 tests) and
`npx tsc --noEmit` clean.
