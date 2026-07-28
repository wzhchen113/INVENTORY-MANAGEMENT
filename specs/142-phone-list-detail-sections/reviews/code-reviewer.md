# Code review for spec 142

Scope reviewed: `src/screens/cmd/sections/phone/` (scaffold, widgets, 9 phone
components, `menuCapacityFallback.ts`, `__tests__/`), the chrome components
(`MobileTopAppBar`, `NotificationToggle`, `NotificationBlockedBanner`,
`ThemeToggle`, `RefreshButton`), `ResponsiveCmdShell.tsx`,
`InventoryDesktopLayout.tsx`, the six host-section guards, `typography.ts`,
and the i18n catalogs. Focus: AC-REG discipline, rules-of-hooks guard
placement, widget/token discipline, FlatList usage, duplication, naming, dead
code. Runtime/visual verification at 375×812 was done by the dispatcher and is
out of scope here.

**Update (re-review):** the frontend-developer applied a fix round against the
findings below. Re-verified against the current staged tree, including the new
`src/screens/cmd/lib/inventoryViewMode.ts` module as fresh code. All four prior
findings are resolved; one small new nit surfaced from the fix itself
(duplicate leftover comment header). No new Critical/Should-fix issues found.

## Critical

- ~~`src/screens/cmd/InventoryDesktopLayout.tsx:347` — AC-INV5 unreachable~~
  **FIXED.** Re-verified `InventoryDesktopLayout.tsx:358-371`: the phone branch
  now checks `viewMode === 'catalog'` and routes to `<InventoryCatalogMode
  selectedName={selectedName} onSelectName={setSelectedName} />` (whose own
  `isPhone` guard then renders `PhoneCatalogList`) before falling back to
  `<PhoneInventoryList/>` for every other `viewMode`. This resolves the
  reachability bug itself.

  The fix also addresses the deeper root cause I hadn't traced: `viewMode` is
  `InventoryDesktopLayout`'s local `useState`, and `ResponsiveCmdShell.tsx`
  mounts `InventoryDesktopLayout` at a structurally different position in each
  of its three tier branches (`isPhone` / `isTablet` / else, three separate
  `return`s at `ResponsiveCmdShell.tsx:396/446/512`) — so a resize across the
  768/1100 breakpoint unmounts and remounts the body, which would silently
  reset `viewMode` back to `'per-store'` even with the ternary-ordering fix
  alone. The new `src/screens/cmd/lib/inventoryViewMode.ts` is a plain module
  singleton (`getLastInventoryViewMode` / `setLastInventoryViewMode`) that
  `InventoryDesktopLayout` seeds its `useState` from and mirrors every
  `setViewMode` call back into — reviewed as fresh code:
  - Correctly scoped: one Inventory host is ever mounted at a time, so a
    module-level `let` (not a store slice) is appropriate here — no
    cross-store or cross-tab bleed risk since it's plain UI-navigation state,
    not data.
  - `setViewMode` (`InventoryDesktopLayout.tsx:135-138`) is a `useCallback`
    wrapper that writes the module singleton then calls the raw setter,
    replacing the previous raw `setViewMode` used at the three `TabStrip
    onChange` call sites and the palette-action effect (`line 243`) —
    confirmed all four write sites go through the wrapped setter, not the raw
    one, so nothing bypasses persistence.
  - Test-pollution risk (a module singleton mutated by one test leaking into
    the next) is handled: `PhoneInventory.acReg.test.tsx:78` and
    `InventoryDesktopLayout.test.tsx:239-240` both call
    `setLastInventoryViewMode('per-store')` in `beforeEach`, and Jest's
    per-file module registry means state doesn't leak across test files
    anyway — only within a file, which is exactly where the reset guards.
  - The new `PhoneInventory.acReg.test.tsx:112-124` test
    (`'phone catalog survives the tier-change remount (AC-INV5)'`) honestly
    models the real bug shape — render desktop, click catalog.tsv,
    **`.unmount()`** the desktop instance, then mount a **fresh**
    `InventoryDesktopLayout` instance with `mockTier = 'phone'` — rather than
    flipping a mocked tier under a single persistent instance (which
    would've kept passing before the fix, since a live `isPhone` flip without
    unmount preserves `useState`). This is the right shape to actually catch
    the regression; I traced it by hand against the pre-fix code and confirm
    it would have failed.
  - Minor, non-blocking observation (not a new finding): because the
    singleton is shared across all three `ResponsiveCmdShell` tier branches,
    `viewMode` now also survives tablet↔desktop remounts, not just
    phone-related ones — a side benefit slightly outside AC-INV5's literal
    scope, but it's additive persistence of existing state, not a change to
    any section's render *output*, so it doesn't put AC-REG1 at risk.

## Should-fix

- ~~`PhoneMenuItemDetail.tsx:77-95` — duplicated BOM conversion math~~
  **FIXED.** `PhoneMenuItemDetail.tsx:81` now calls `recipeRawLines(recipe,
  inventory, currentStore?.id ?? '')` from `menuCapacityFallback.ts` and reads
  `onHand`/`needPerPlate`/`name` off the aligned result instead of
  re-deriving the `getConversionFactor` math locally. The file still does its
  own `inventory.find(...)` per line (`line 84-86`), but that's now a distinct,
  non-duplicated concern — fetching the raw `item` for the status pill color
  and the raw (unconverted) on-hand display, which the pure helper doesn't
  return. No remaining logic duplication.
- ~~Three independent `PropertyCard`-shaped components~~ **FIXED.**
  `PhoneWidgets.tsx:198-215` now exports one shared `PropertyCard`, and all
  three call sites (`PhoneInventoryDetail.tsx:137`, `PhoneCatalogList.tsx:125`,
  `PhoneVendorsList.tsx:79,96`) use it — Vendors' two calls (CONTACT +
  SCHEDULE) confirm the ≥2-use threshold cleanly.
- ~~`PhoneInventoryList.tsx:97` dead `vendors` subscription~~ **FIXED** —
  removed; grep confirms no remaining `s.vendors` read in the file.
- ~~`PhoneCatalogList.tsx:157` dead `ingredientCategories` subscription~~
  **FIXED** — removed; grep confirms no remaining `s.ingredientCategories`
  read in the file.

## Nits

- ~~`PhoneWasteLog.tsx` naming inconsistency~~ **Acknowledged, left as-is** per
  my original note that it wasn't worth a rename (matches the spec's own
  "Files changed" naming). No action needed.
- ~~`removeClippedSubviews` inconsistency across the seven phone `FlatList`s~~
  **FIXED** — all seven now pass `removeClippedSubviews={Platform.OS !==
  'web'}` (`PhoneInventoryList`, `PhoneCatalogList`, `PhoneMenuImpactList`,
  `PhoneMenuItemsList`, `PhonePrepRecipesList`, `PhoneVendorsList`,
  `PhoneWasteLog`).
- ~~Missing spec-104 cost-bridge rationale comment in the Waste sheet~~
  **FIXED** — `PhoneWasteLogSheet.tsx:64-67` now carries the "Spec 104 (OQ-5)"
  comment mirroring `WasteLogSection.tsx`'s explanation of the
  `× subUnitSize` bridge.
- **New, small** — `src/screens/cmd/sections/phone/PhoneWidgets.tsx:177` and
  `:217` — the `PropertyCard` section was inserted between two identical
  `// ── StatPanel ─────` comment-block headers; the first one (line 177) is a
  leftover from the insertion point and should read `// ── PropertyCard
  ─────` (or be deleted, since line 179 already has the correct header).
  Cosmetic only, doesn't affect behavior.

## Fresh-code check: `src/screens/cmd/lib/inventoryViewMode.ts`

Read in full as new code (not just as the "fix" for the Critical above):

- Small, single-purpose file: one type export, one `let`, two accessor
  functions. No hidden state beyond `viewMode` itself.
- Doc comment (`lines 1-15`) accurately explains *why* a module singleton was
  chosen over a store slice (single-instance UI nav state, no cross-tab sync
  wanted, needs synchronous read at `useState` initializer time) — this is a
  "why" comment, not a "what" comment, consistent with this project's
  commenting convention.
- No `db.ts` / Supabase / async touch — pure client-side navigation memory,
  correctly out of the "frontend store impact: none" backend-design claim
  (this isn't `useStore.ts`, so spec §0's "no slice changes" constraint isn't
  implicated).
- No color/token/platform concerns — it's plain TS, not a component.

No findings against this file.
