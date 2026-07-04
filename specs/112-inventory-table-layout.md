# Spec 112: Inventory items — full-width operational table + detail-on-demand

Status: READY_FOR_REVIEW

> Owner ask, verbatim (with an annotated screenshot of the admin Inventory
> section, the always-visible detail pane marked "only show up when click
> ingredients"):
> "i want the ingredient page to be extended to be more columns on big screens,
> and details page of the ingredients only show up when click the ingredients"
>
> Today the admin desktop Inventory surface (`items.tsv` view) is a fixed-width
> 340px single-column item list on the LEFT plus an ALWAYS-VISIBLE detail pane on
> the RIGHT (the `detail.tsx` / `usage.tsx` / `audit.tsx` / `recipes.tsx` tabs),
> with the first item auto-selected on entry. The list rows show only: status
> dot, name, short id, on-hand/par + progress bar, category. This spec (a) widens
> the `items.tsv` list into a full-width multi-column OPERATIONAL table on big
> screens, and (b) makes the detail a right-side pane that opens ON CLICK (list
> stays visible, narrower) and closes via ✕ / Esc / re-clicking the same row —
> so the table gets the full width until the operator drills into an item. This
> is a **frontend-only** change: no new columns of data are fetched; the table
> reuses fields already on the in-memory `inventory` slice, and the two money
> columns REUSE the exact per-store detail-pane cost computations verbatim
> (spec 104 per-each basis — see AC-4 / the ★ costing rule).

## User story

As a **store manager in the admin Cmd UI on a large monitor**, when I open the
Inventory `items.tsv` view I want to see my ingredients as a wide table with the
operational columns I scan for (name, on-hand vs par, status, cost, stock value,
vendor, category, last counted) using the full screen width — and I want the
per-item detail to appear only when I click a row, sliding in from the right with
the list still visible, so that I can scan and compare many items at a glance and
drill into one on demand instead of having half my screen permanently spent on a
detail pane I didn't ask for.

## Problem / current state (verified in code)

- **`InventoryDesktopLayout.tsx` owns the `items.tsv` view** on EVERY breakpoint
  (`ResponsiveCmdShell.tsx:356` renders it as the section body for phone / tablet
  / desktop alike; `InventoryDesktopLayout.tsx:258-366`). Its `items.tsv` branch
  is a two-pane row: a fixed-width **340px list pane** (`:261-321`) built from
  `<InventoryRow>` rows, and a **flex detail pane** (`:323-364`) that always
  renders `<DetailPane>` for the selected item.
- **Auto-select on entry.** `:141-145` selects `items[0]` on first render when no
  `selectedName` is set — so the detail pane is always populated the moment the
  section loads (the status bar shows `row 1 / N`, `:377-381`). The owner's
  screenshot marks exactly this always-on pane as the thing that should "only
  show up when click ingredients."
- **Current row content** (`<InventoryRow>`, `src/components/cmd/InventoryRow.tsx`)
  is a two-line card: line 1 = status dot · localized name · short id; line 2 =
  `stock/par unit` · `<ParBar>` · category. No cost, no stock value, no vendor,
  no last-counted.
- **The money math to reuse (★ spec 104 per-each basis).** The per-store detail
  pane header (`DetailPane`, `InventoryDesktopLayout.tsx:448-461`) computes:
  - **Cost / each** = `item.costPerUnit` (already per-EACH), labeled with
    `item.subUnitUnit || 'each'` (`:456-459`). `costPerUnit` is the stored
    per-each cost; DO NOT multiply for the per-each cell.
  - **Stock value** = `item.currentStock * (item.costPerUnit || 0) *
    (item.subUnitSize || 1)` (`:449`) — the OQ-5 `× subUnitSize` bridge from
    per-each cost to a per-counted-unit dollar total. The new "stock value"
    column MUST use this exact expression.
  The new table's two money columns MUST reuse these two computations verbatim
  (extract to a tiny shared helper module OR call an exported function; either
  way there must be ONE definition of each, consumed by both the row/cell and
  the detail header). Re-deriving cost math in the table cell is FORBIDDEN
  (see the ★ rule under Acceptance criteria).
- **The "mobile stack" is dead code, NOT a live separate surface.**
  `InventoryListScreen.tsx` (and `ItemDetailScreen.tsx`) carry a header comment
  (`InventoryListScreen.tsx:1-7`): *"ORPHANED post-Spec-011 (2026-05-08)… Not
  imported anywhere… `ResponsiveCmdShell` + `InventoryDesktopLayout` now serve
  the Inventory section on every breakpoint, including phone."* A repo-wide grep
  confirms neither is imported by any live path. **Correction to the ask's
  premise:** there is no separate live mobile stack to "leave unchanged" — the
  same `InventoryDesktopLayout` renders on phone/tablet/desktop. This spec
  therefore must define the NARROW-viewport behavior of `InventoryDesktopLayout`
  itself (see AC-7 / OQ-3), and it leaves the two orphaned files on disk
  untouched (their future deletion is a separate cleanup, out of scope).
- **Catalog / categories tabs are owned by DIFFERENT components.** The `items.tsv`
  ↔ `catalog.tsv` ↔ `categories` `TabStrip` lives in `InventoryDesktopLayout`,
  but `catalog.tsv` renders `<InventoryCatalogMode>`
  (`src/screens/cmd/sections/InventoryCatalogMode.tsx` — its OWN 340px list +
  detail, grouped cross-store) and `categories` renders `<CategoriesSection>`.
  Neither shares `InventoryDesktopLayout`'s list/detail markup. The clean
  boundary: this spec changes ONLY the `items.tsv` (`viewMode === 'per-store'`)
  branch of `InventoryDesktopLayout`; `catalog.tsv` and `categories` are
  untouched (AC-8 / OQ-4).
- **The detail tabs themselves are reused unchanged.** `DetailPane` and its
  `detail.tsx` / `usage.tsx` / `audit.tsx` / `recipes.tsx` tab bodies
  (`:409-773`), plus the EDIT / DELETE / + COUNT header buttons (`:484-509`) and
  the EDIT drawer (`IngredientFormDrawer`, `:398-404`), are reused verbatim
  INSIDE the on-demand pane — this spec changes WHEN/WHERE the pane renders and
  its width, not its contents (AC-3 / AC-6).
- **Breakpoints** (`src/theme/breakpoints.ts`): phone `<768`, tablet `768–1099`,
  **desktop `≥1100`** (`DESKTOP_MIN_WIDTH = 1100`, `useIsDesktop()`). "Big
  screens" in the ask maps to the desktop tier (≥1100).
- **Filter / sort / ⌘K already exist and are unchanged.** The filter box
  (`FilterInput`, `:295`), the `parseFilter` / `matchesFilter` bare-token +
  `cat:` / `vendor:` search (`:113-136`), the locale-aware name sort (`:128-134`),
  and the ⌘K palette bridge (`:151-161`) all stay exactly as-is. No new sorting in
  v1 (OQ-5 — out of scope).

## Acceptance criteria

> ★ **COSTING RULE (spec 104 per-each basis) — non-negotiable.** The two money
> columns MUST reuse the existing per-store detail-pane computations, not
> re-derive them:
>   - `cost/each` cell = the item's per-each `costPerUnit` with the
>     `subUnitUnit || 'each'` label (the `InventoryDesktopLayout.tsx:456-459`
>     expression).
>   - `stock value` cell = `currentStock * (costPerUnit || 0) * (subUnitSize || 1)`
>     (the `:449` expression — the `× subUnitSize` per-each→per-counted-unit
>     bridge).
> There must be exactly ONE definition of each (shared helper / exported fn) that
> BOTH the table cell and the `DetailPane` header consume. A reviewer diff that
> shows a second, cell-local cost expression is a Critical.

**Table structure (big screens, `items.tsv`):**

- [ ] **AC-1 (operational columns).** On desktop (`≥1100`), the `items.tsv` view
  renders a **full-width table** (the 340px list pane is gone; the table spans the
  whole section body) with the OPERATIONAL COLUMN SET, in this order:
  1. **name** (status dot + localized name, left-aligned, flexes)
  2. **on-hand + par** (`stock/par unit` numeric + the existing `<ParBar>`)
  3. **status** (`<StatusPill>` or `<StatusDot>` — reuse existing)
  4. **cost / each** (per-each `costPerUnit`, `subUnitUnit||'each'` label — ★)
  5. **stock value** (`currentStock × costPerUnit × subUnitSize` — ★)
  6. **vendor** (`vendors.find(v => v.id === item.vendorId)?.name` — the lookup
     already done at `:168`; `'—'` when unset)
  7. **category** (`item.category`, or its localized label if trivially available
     via the existing `getLocalizedName` category path — dev's call; English
     `item.category` is acceptable for v1)
  8. **last counted** (`relativeTime(item.lastUpdatedAt)` — the expression used at
     `:473` / `:476`; `'never'` when null)
  A sticky/pinned header row labels each column via i18n keys (AC-9).
- [ ] **AC-2 (money cells match the detail header exactly).** For any given item,
  the `cost / each` and `stock value` cells render the SAME strings the
  `DetailPane` header shows for that item (same rounding: `costPerUnit.toFixed(2)`
  with `$` prefix and `—` when falsy; `inventoryValue.toFixed(0)` with `$`
  prefix). Pinned by a jest value assertion against a fixture item with a known
  `costPerUnit` / `subUnitSize` / `currentStock` (AC-13).

**Column collapse (narrower desktop widths):**

- [ ] **AC-7 (priority-based collapse).** The table degrades gracefully as the
  desktop viewport narrows. **name + on-hand/par + status ALWAYS survive** (the
  minimum useful row). The remaining columns drop in this priority order as width
  shrinks (highest number dropped FIRST): (8) last counted → (7) category →
  (6) vendor → (5) stock value → (4) cost/each. Mechanism is the dev's choice
  (width-keyed conditional columns via `useWindowDimensions`, or horizontal
  scroll past a min table width — the former is preferred so no column is hidden
  off-screen). Define at least the following two named tiers so the behavior is
  testable:
  - **≥1100 (desktop, wide):** all 8 columns.
  - **narrow-desktop band (≈1100–1400, exact px the dev's call):** at minimum
    drop `last counted` + `category` so cost/vendor/stock-value survive; the
    always-3 (name/on-hand/status) plus cost/each + stock value + vendor is the
    floor for a "table still worth it" width.
  Below desktop (`<1100`, tablet + phone) the table does NOT apply — see the
  narrow-viewport fallback (AC-10 / OQ-3).

**Detail on demand:**

- [ ] **AC-3 (no auto-select on entry).** On entering the `items.tsv` view NO
  item is auto-selected — the detail pane is ABSENT and the table occupies the
  full width. The `:141-145` first-render auto-select effect is removed for the
  `per-store` mode (the palette-driven `setSelectedName` at `:156` still works —
  a ⌘K "focus item X" still opens the pane for that item). The status bar's
  `row N / total` (`:377-381`) shows only when the pane is open (an item is
  selected); when closed, it is absent or shows total-only (dev's call, cheap).
- [ ] **AC-4 (click opens the side pane).** Clicking a table row opens the detail
  as a **right-side pane** that slides/appears from the right; the TABLE STAYS
  VISIBLE and narrows to make room (NOT a full-screen takeover). The pane shows
  the existing `<DetailPane>` (its `detail.tsx` / `usage.tsx` / `audit.tsx` /
  `recipes.tsx` tabs, EDIT / DELETE / + COUNT header) UNCHANGED. Slide animation
  is a nice-to-have, not required; an instantaneous show is acceptable for v1
  (OQ-6). The selected row gets the existing selected affordance (accent
  left-border / `accentBg`).
- [ ] **AC-5 (three close paths).** The pane closes and the table returns to full
  width via ALL THREE of: (a) a **✕ close button** in the pane header;
  (b) the **Esc** key (web); (c) **clicking the already-selected row again**
  (toggle-off). All three set `selectedName` back to `null`. Esc is web-only via a
  keydown listener (native has no hardware Esc; that's fine — AC-14).
- [ ] **AC-6 (switching rows swaps content — no close/reopen flicker).** With the
  pane open, clicking a DIFFERENT row swaps the detail content to the new item
  WITHOUT closing/reopening the pane (the pane stays; `selectedName` changes). The
  active detail tab (`tabId`) MAY reset to `detail.tsx` on row change or persist —
  dev's call; persisting is fine and cheaper.
- [ ] **AC-8b (store switch closes the pane).** When the active store changes
  (`currentStore.id` changes), the pane CLOSES (`selectedName` → `null`) so the
  table shows the new store's items full-width and the operator isn't left staring
  at a stale detail for an item that may not exist at the new store. (Today the
  selection is name-keyed and deliberately survives a store switch, `:97-99`; this
  spec overrides that for the detail pane — closing on store switch is the
  correct behavior for the new "detail on demand" model. See OQ-2.)
- [ ] **AC-8c (selection is ephemeral across section changes).** Leaving the
  Inventory section clears the selection (the existing `:105-107` effect already
  does this — `section !== 'Inventory'` → `setSelectedName(null)`); returning to
  Inventory shows the full-width table with no pane. No persistence of the open
  detail across section navigation (OQ-2).

**Narrow-viewport (tablet + phone) behavior:**

- [ ] **AC-10 (below desktop: keep today's usable list, not a broken wide table).**
  Below `1100` (tablet + phone), the operational wide table does NOT render.
  Because `InventoryDesktopLayout` is the ONLY Inventory surface on those tiers
  (the mobile stack is dead code), the narrow tiers keep a usable
  list-with-on-demand-detail experience. Recommended default (OQ-3): on narrow
  tiers, render the SAME list-then-detail flow (list occupies full width; tapping
  a row opens the detail full-width for that item; ✕ / back returns to the list) —
  i.e. the "detail on demand" behavior (AC-3/4/5) applies on narrow tiers too, but
  as a full-width list ↔ full-width detail swap rather than a side-by-side pane
  (there isn't room for side-by-side below 1100). The multi-COLUMN table is a
  desktop-only enhancement; narrow tiers show the existing single-column row
  content. This must not regress today's phone/tablet usability.

**Catalog / categories boundary:**

- [ ] **AC-8 (catalog.tsv + categories untouched).** The `catalog.tsv`
  (`<InventoryCatalogMode>`) and `categories` (`<CategoriesSection>`) tabs are
  UNCHANGED — same 340px-list-plus-detail (catalog) / same categories UI. Their
  auto-select-on-entry, their own detail panes, and their drawers behave exactly
  as today. This spec's changes are scoped to the `items.tsv`
  (`viewMode === 'per-store'`) branch of `InventoryDesktopLayout` ONLY. The shared
  `TabStrip` (items / catalog / categories) still switches between them.

**Drawers, i18n, platform, tests:**

- [ ] **AC-9 (i18n ×3 for new strings).** Every new user-visible string exists in
  all three admin catalogs (`en.json`, `es.json`, `zh-CN.json`) with REAL es /
  zh-CN translations (no English placeholders), read via `useT`. REUSE existing
  keys where present (verified): `section.inventory.onHandCol` ("on hand"),
  `.statusCol` ("status"), `.vendorCol` ("vendor"), `.costPerUnitCol` ("cost /
  ea"), `.parCol` ("par"). NEW keys needed: a **name** column header, a
  **stock value** column header, a **category** column header, a **last counted**
  column header, and the **✕ close aria label** for the pane. Recommend placing
  them under `section.inventory.*` (siblings of the existing `*Col` keys, e.g.
  `nameCol`, `stockValueCol`, `categoryCol`, `lastCountedCol`, and
  `closeDetailAria`). The pre-existing `src/i18n/i18n.test.ts` identical-key-set
  assertion auto-fails if any new key is missing from a catalog — no new parity
  test needed.
- [ ] **AC-11 (drawers keep working).** With the pane open, the EDIT drawer
  (`IngredientFormDrawer`, mode `edit`), the DELETE confirm (`confirmAction` →
  `deleteItem` → clear selection + toast, `:343-354`), and the + COUNT palette
  request (`:355-361`) behave EXACTLY as today. DELETE clears the selection and
  the pane closes (already the behavior at `:349`). The EDIT drawer still mounts
  at body root and overlays the chrome.
- [ ] **AC-12 (accessibility on the ✕ close).** The ✕ close button carries
  `accessibilityRole="button"` and an `accessibilityLabel` from the AC-9 i18n key
  (e.g. "Close item detail"). No focus-trap / modal-role rework (out of scope).
- [ ] **AC-14 (web + native).** The table + pane render on react-native-web
  (Vercel) AND native (EAS) using only cross-platform primitives — no web-only
  CSS. The Esc-key close is web-only (guarded by `Platform.OS === 'web'` on the
  keydown listener, AC-5); its absence on native is acceptable (native has ✕ +
  re-tap). Table column-collapse uses `useWindowDimensions` (cross-platform).

**Tests (jest — the only track this feature needs):**

- [ ] **AC-13 (jest coverage).** Track-1 jest tests pin:
  1. **table renders the operational columns** on a wide viewport (the header row
     shows name / on-hand / status / cost / stock value / vendor / category / last
     counted labels; rows render cost + stock-value cells). Pins AC-1.
  2. **no detail on entry** — mounting the `items.tsv` view with no palette action
     leaves `selectedName === null` and renders no `<DetailPane>` (the pane is
     absent). Pins AC-3.
  3. **click opens / ✕ closes / Esc closes / same-row re-click closes** — four
     assertions on the open→close transitions (Esc via a simulated web keydown).
     Pins AC-4 / AC-5.
  4. **switching rows swaps content without closing** — click row A (pane open),
     click row B → pane still present, detail now shows B. Pins AC-6.
  5. **store switch closes the pane** — with pane open, change `currentStore.id`
     → `selectedName` back to `null`, pane absent. Pins AC-8b.
  6. **money columns use the ★ bridge helpers (value assertion)** — a fixture
     item with `costPerUnit = 0.02`, `subUnitSize = 2000`, `currentStock = 3`
     renders `cost/each = $0.02` and `stock value = $120` (`3 × 0.02 × 2000`), and
     these strings MATCH the `DetailPane` header for the same fixture. Pins AC-2 /
     the ★ rule.
  7. **catalog.tsv / categories unchanged** — switching to `catalog.tsv` still
     renders `<InventoryCatalogMode>` with its auto-selected detail (a smoke
     assertion that the boundary held). Pins AC-8.
  Render tests mount the `items.tsv` branch (or `InventoryDesktopLayout` with a
  mocked store slice), mirroring existing section render-test patterns.

## In scope

- Rewriting the `items.tsv` (`viewMode === 'per-store'`) branch of
  `InventoryDesktopLayout.tsx` into a full-width operational table on desktop
  (`≥1100`) with the 8-column set (AC-1), priority-collapse for narrower desktop
  widths (AC-7), and a list ↔ detail flow below desktop (AC-10).
- Removing the first-render auto-select for `per-store` mode (AC-3).
- The on-demand right-side detail pane: click-to-open, ✕ / Esc / re-click to
  close, row-swap-without-close, store-switch-closes (AC-4/5/6/8b), reusing the
  existing `<DetailPane>` + tabs + drawers verbatim.
- Extracting the two money computations (per-each cost cell + stock-value cell)
  into ONE shared definition consumed by both the table cell and the `DetailPane`
  header (★ rule / AC-2), so cost math is defined once.
- New table-cell / row component work (a multi-column row or a small table
  component) under `src/components/cmd/` as the dev sees fit; may extend or
  replace the `items.tsv`-specific use of `<InventoryRow>` (whose two-line card is
  kept for the narrow-tier list per AC-10).
- New i18n strings ×3 admin locales (AC-9) + the ✕ aria label (AC-12).
- Jest coverage on the matching track (AC-13).

## Out of scope (explicitly)

- **New columns of DATA / new fetches.** Every column reads a field already on the
  in-memory `inventory` slice (or an already-loaded lookup: `vendors`). No new
  RPC, PostgREST select, edge function, or migration. Rationale: the ask is a
  layout change, not new data. Frontend-only.
- **Re-deriving cost math.** The two money columns REUSE the existing per-store
  detail-pane expressions (★ rule / AC-2). Rationale: spec 104's per-each basis is
  subtle (`× subUnitSize` bridge); a second definition is exactly how a basis
  regression sneaks in.
- **New sorting / sortable column headers.** v1 keeps the existing locale-aware
  name sort (`:128-134`) and does NOT add click-to-sort on columns. Rationale: the
  ask is "more columns" + "detail on click," not re-sortable tables; sortable
  headers are a clean follow-up spec.
- **Changing the filter box, status/category filter chips, or ⌘K behavior.** The
  `FilterInput`, `parseFilter`/`matchesFilter` search, and the palette bridge are
  untouched. Rationale: explicitly called out as "unchanged" in the ask.
- **`catalog.tsv` (`InventoryCatalogMode`) and `categories` (`CategoriesSection`).**
  Different components, own list/detail; not touched (AC-8). Rationale: scope
  containment; the boundary is the `items.tsv` branch only.
- **The `DetailPane` tab CONTENTS** (`detail.tsx` / `usage.tsx` / `audit.tsx` /
  `recipes.tsx` bodies, the 4-up stat grid, charts, properties). Reused verbatim;
  only WHERE/WHEN the pane renders and its width change. Rationale: the ask is
  about the pane's visibility, not its internals.
- **Deleting the orphaned `InventoryListScreen.tsx` / `ItemDetailScreen.tsx`.**
  They're dead code (confirmed unimported) but their removal is a separate cleanup
  sweep. Rationale: don't expand scope; this spec doesn't touch them.
- **A slide/transition animation as a hard requirement.** An instant show/hide is
  acceptable for v1; animation is a nice-to-have (OQ-6). Rationale: keep v1 small.
- **Focus-trap / full modal semantics on the pane.** The pane is an inline
  side-panel, not a modal; no focus management rework (only the ✕ aria label,
  AC-12). Rationale: matches the "list stays visible" side-pane model, not a
  takeover.
- **The `app.json` slug, identity drift, and the repo-root spreadsheet.**
  Untouched (CLAUDE.md load-bearing / DO-NOT-AUTO-FIX).

## Open questions resolved

The owner pre-authorized recommended defaults ("owner accepts defaults unless
flagged"); the two core UX rulings (detail style, column set) were collected up
front, so every question below resolves to a default rather than blocking.

- **OQ-1 — Detail presentation: side pane vs full-screen takeover?**
  → **A: side pane + ✕ close (OWNER RULING).** Clicking an item slides the detail
  pane in from the right; the list/table stays visible and narrows. ✕, Esc, or
  re-clicking the same row closes it and the table returns to full width. NOT a
  full-screen takeover. (AC-4 / AC-5.)
- **OQ-2 — Does the open detail persist across store switch / section change?**
  → **A: no — ephemeral.** The pane CLOSES on store switch (AC-8b — the stale
  detail would point at an item that may not exist at the new store) and on
  leaving the Inventory section (AC-8c — already the existing `:105-107`
  behavior). Re-entering Inventory shows the full-width table with no pane.
  Rationale: "detail on demand" means the operator re-opens intentionally; a
  persisted-open pane re-introduces the always-on-pane the owner asked to remove.
- **OQ-3 — Below 1100 (tablet + phone), where the "mobile stack" turned out to be
  dead code — what renders?** → **A: same `InventoryDesktopLayout`, narrow-tier
  list ↔ detail (AC-10).** Since `InventoryDesktopLayout` is the only Inventory
  surface on every breakpoint, the narrow tiers keep a usable single-column
  list-with-on-demand-detail (full-width list; tap a row → full-width detail; ✕ /
  back → list). The multi-COLUMN table is a desktop-only (≥1100) enhancement.
  Rationale: there's no room for side-by-side or 8 columns below 1100, and we must
  not regress today's phone/tablet usability. (Flagged correction: the ask assumed
  a separate live mobile stack; there isn't one.)
- **OQ-4 — Do catalog.tsv / categories get the same treatment?**
  → **A: no — out of scope, unchanged (AC-8).** They're owned by different
  components (`InventoryCatalogMode`, `CategoriesSection`) with their own
  list/detail. The change is scoped to the `items.tsv` branch. Rationale: the ask
  is "the ingredient page" (= the per-store items view); the catalog lens is a
  separate curation surface.
- **OQ-5 — Add sortable column headers in v1?** → **A: no.** Keep the existing
  locale-aware name sort; no click-to-sort. Rationale: not in the ask; a clean
  follow-up. (Out of scope.)
- **OQ-6 — Is a slide animation required?** → **A: no, nice-to-have.** An instant
  show/hide is acceptable for v1; the dev may add a lightweight slide. Rationale:
  keep v1 small; animation polish can follow.
- **OQ-7 — Column collapse: hide columns by width, or horizontal scroll?**
  → **A: hide by width (preferred), per the AC-7 priority order.** Width-keyed
  conditional columns (`useWindowDimensions`) keep every visible column fully
  on-screen; horizontal scroll would push cost/status off-screen on a laptop.
  Rationale: operational scanning wants the priority columns always visible, not
  scrolled-away.
- **OQ-8 — Backend surface?** → **A: NONE.** No migration, RPC, PostgREST select,
  edge function, RLS, or realtime change. Frontend-only: a table rewrite of one
  branch + an on-demand pane + a shared cost helper + i18n. The architect pass is
  expected to be a **fast contract ack** (confirm zero backend surface + the ★
  single-cost-definition invariant + the ephemeral-selection lifecycle), then hand
  to the frontend developer. Per the house state machine the PM sets
  `READY_FOR_ARCH` (not straight to `READY_FOR_BUILD`).

## Dependencies

- **`src/screens/cmd/InventoryDesktopLayout.tsx`** — the `items.tsv`
  (`viewMode === 'per-store'`) branch rewrite (table + on-demand pane); removal of
  the `:141-145` auto-select for that mode; the ✕ / Esc / re-click close wiring;
  the store-switch-closes effect (AC-8b). The `DetailPane` (`:409-591`) and its tab
  bodies are reused; the two money expressions (`:449`, `:456-459`) become the
  shared cost helper's single definition.
- **`src/components/cmd/InventoryRow.tsx`** — kept for the narrow-tier list
  (AC-10); the desktop multi-column row is new (may be a new component or an
  extended row). `<ParBar>`, `<StatusDot>`, `<StatusPill>` reused.
- **A shared cost helper** — extract the per-each `cost/each` label expression and
  the `stock value` (`currentStock × costPerUnit × subUnitSize`) expression into
  ONE module (e.g. under `src/utils/` alongside `perEachCost.ts`, or exported from
  `InventoryDesktopLayout`), consumed by both the table cell and the `DetailPane`
  header (★ rule / AC-2). Spec 104's per-each basis is the source of truth for the
  math; this spec must NOT change the numbers, only de-duplicate them.
- **i18n catalogs** — `src/i18n/en.json` / `es.json` / `zh-CN.json` gain the new
  column-header + ✕-aria keys under `section.inventory.*` (AC-9); existing
  `onHandCol` / `statusCol` / `vendorCol` / `costPerUnitCol` / `parCol` reused.
  Read via `useT` (`src/hooks/useT.ts`). Parity enforced by the pre-existing
  `src/i18n/i18n.test.ts`.
- **`src/theme/breakpoints.ts`** — `useIsDesktop()` / `DESKTOP_MIN_WIDTH` (1100)
  gate the table vs narrow-tier flow; `useWindowDimensions` drives column collapse
  (AC-7 / OQ-7). No change to the file.
- **Spec 104 (live)** — the per-each cost basis whose two consumer expressions the
  money columns reuse (the ★ rule). No change to spec-104 code; this spec relies
  on its computations verbatim.
- **Spec 011 (live)** — the responsive shell + `InventoryDesktopLayout`-serves-all
  -breakpoints topology this spec builds on (and whose orphaned
  `InventoryListScreen`/`ItemDetailScreen` remnants it leaves untouched).

## Project-specific notes

- **Cmd UI section / legacy:** the admin **Inventory** Cmd section
  (`src/screens/cmd/sections/`-adjacent — the `items.tsv` branch of
  `InventoryDesktopLayout`, which lives in `src/screens/cmd/`). No legacy admin
  surface (spec 025 deleted it; the orphaned narrow screens are dead code left
  untouched).
- **Which app:** **admin Cmd UI only** — this repo's admin surface. The folded-in
  staff surface (`src/screens/staff/`) and the customer PWA are not involved.
- **Per-store or admin-global:** reads **per-store** data (the `items.tsv` view is
  already filtered to `currentStore.id`, `:109-112`) but adds NO new data access —
  it re-lays-out the same store-scoped slice. `auth_can_see_store()` unchanged; no
  RLS surface.
- **Realtime channels touched:** **none.** No data mutation, no publication or
  channel change; the realtime-publication `docker restart` gotcha does NOT apply.
- **Migrations needed:** **no.** Zero DB surface — a client-side layout rewrite +
  a shared cost helper + i18n.
- **Edge functions touched:** **none.** No PostgREST/RPC/edge-function surface.
- **Web/native scope:** **both.** Admin ships web (Vercel) + native (EAS); the
  table + pane use only cross-platform primitives (`View`, `FlatList`/`ScrollView`,
  `Text`, `TouchableOpacity`, `useWindowDimensions`). The **Esc-key close is
  web-only** (guarded keydown listener, AC-5/AC-14); its absence on native is
  acceptable (✕ + re-tap cover it).
- **`app.json` slug:** untouched — no bearing on build identifiers; `slug` stays
  `towson-inventory` pending explicit approval.
- **No backend design expected (fast architect pass).** Per OQ-8 this is
  frontend-only (one-branch table rewrite + on-demand pane + a shared cost helper
  that de-duplicates existing math + i18n). The architect pass should be a **fast
  contract ack** — confirm zero backend surface, the ★ single-cost-definition
  invariant (one definition consumed by cell + header), and the ephemeral-selection
  lifecycle (no auto-select; closes on store switch + section change) — with no
  data-model or API design. Following the house state machine, this spec is
  `READY_FOR_ARCH` (not `READY_FOR_BUILD`); the architect confirms zero backend
  surface and hands to the frontend developer.
- **Test tracks (spec 022):**
  - **jest** (the only track this feature needs): the AC-13 cases — table columns
    render; no detail on entry; click-open / ✕-close / Esc-close / same-row-close;
    row-swap-without-close; store-switch-closes; the ★ money-cell value assertion
    (matched against the `DetailPane` header); catalog/categories boundary smoke.
    Render tests mount the `items.tsv` branch (or `InventoryDesktopLayout`) with a
    mocked store slice, mirroring existing section render-test patterns.
  - **pgTAP:** none — zero DB surface.
  - **shell smoke:** none anticipated.

## Design note

Fast architect pass — frontend-only. Every spec claim verified in code; the
contract below fixes the open decisions the PM left to "dev's call" so the FE
dev builds against a fixed shape.

### Verification (all confirmed)
- **Cost expressions.** `:449` stock value = `item.currentStock * (item.costPerUnit || 0) * (item.subUnitSize || 1)` and `:456-459` (`eachLabel = item.subUnitUnit || 'each'`; `item.costPerUnit ? '$'+item.costPerUnit.toFixed(2) : '—'`) are verbatim as the spec quotes. These are the ★ semantics.
- **Orphaned screens.** `src/screens/cmd/InventoryListScreen.tsx` and `ItemDetailScreen.tsx` carry the "ORPHANED post-Spec-011" header; `import.*(InventoryListScreen|ItemDetailScreen)` across `src/**/*.{ts,tsx}` returns **zero** live imports. Untouched by this spec (their deletion is a separate cleanup). Correct.
- **Ownership boundary.** Only the `viewMode === 'per-store'` else-branch (`:258-366`) is in scope. `catalog` → `<InventoryCatalogMode>` (`:237-252`) and `categories` → `<CategoriesSection>` (`:222-236`) own their own list/detail and are out of scope. The shared `TabStrip` stays. Correct.
- **i18n keys.** Existing `section.inventory.*` siblings are `onHandCol`/`parCol`/`statusCol`/`vendorCol`/`costPerUnitCol` (en.json ~`:331-344`). The `nameCol`/`categoryCol`/`stockValueCol` hits elsewhere in en.json are under OTHER parents (catalog/reports blocks), NOT `section.inventory` — so AC-9's "NEW keys needed" (`nameCol`, `stockValueCol`, `categoryCol`, `lastCountedCol`, `closeDetailAria` under `section.inventory.*`) is correct. `src/i18n/i18n.test.ts` parity auto-fails on any missing catalog key.

### Backend surface: NONE (OQ-8 confirmed)
No migration, RPC, PostgREST select, edge function, RLS, realtime/publication, or `src/lib/db.ts` change. The realtime `docker restart` gotcha does **not** apply. **Reviewer fan-out: skip all DB tracks** (backend-developer, pgTAP, RLS, realtime, `db.ts` diff). The only track is jest (Track 1). No `backend-architect` post-impl pass is warranted either — there is no contract for the backend to drift from.

### ★ Single cost-definition invariant (the load-bearing decision)
- **Home + name.** New module `src/screens/cmd/lib/itemMoney.ts` (create the `lib/` dir under `src/screens/cmd/`). **Do NOT extend `src/utils/perEachCost.ts`** — that spec-096 helper is a *different* computation (`casePrice / piecesPerCase`, null-when-no-breakdown) and reusing it would silently change the numbers. This helper is the `:449`/`:456-459` semantics only.
- **Signatures (verbatim math — the FE dev copies the expressions, does not re-derive):**
  ```ts
  // itemMoney.ts — the ONE definition of each money string. Spec 104 per-each basis.
  // Consumes already-camelCased inventory-slice fields; touches no Supabase.

  // Stock value — the :449 expression verbatim. Number, so callers can .toFixed().
  export function stockValue(item: {
    currentStock: number; costPerUnit?: number | null; subUnitSize?: number | null;
  }): number {
    return item.currentStock * (item.costPerUnit || 0) * (item.subUnitSize || 1);
  }

  // Display strings — the exact rounding/prefix/'—' the DetailPane header uses.
  export function formatStockValue(item: {...}): string   // `$${stockValue(item).toFixed(0)}`
  export function costPerEachLabel(item: { subUnitUnit?: string | null }): string  // item.subUnitUnit || 'each'
  export function formatCostPerEach(item: { costPerUnit?: number | null }): string // costPerUnit ? `$${costPerUnit.toFixed(2)}` : '—'
  ```
- **Both consumers.** The `DetailPane` header (currently inlining `inventoryValue`/`eachLabel`/`stats[]` at `:449`,`:456-460`) is **refactored to call these**, and the new table cells call the same functions. After the change there must be exactly ONE `currentStock * ... * subUnitSize` in the tree and ONE `.toFixed(2)`-with-`$`-prefix cost string. A reviewer diff showing a second cell-local cost expression is a **Critical** (the ★ rule). Keep the `sub`/`label` StatCard wrapping in `DetailPane`; only the *value* strings move into the helper.
- **jest value-pin (AC-13 case 6):** `costPerUnit=0.02, subUnitSize=2000, currentStock=3` → `formatCostPerEach = "$0.02"`, `formatStockValue = "$120"`. Assert the table cell strings **equal** the `DetailPane` header strings for the same fixture (render both, compare) so the single-definition property is enforced by test, not just by diff.

### Component decomposition (keep the diff reviewable)
- **Table lives in a NEW component**, not inline in the already-large `InventoryDesktopLayout`. Add `src/components/cmd/InventoryTable.tsx` (header row + rows + width-keyed column set). Rationale: the CLAUDE.md cleanup-backlog note flags section file-splits as pending; adding ~200 lines of new table markup inline into the `per-store` branch makes the diff hard to review and grows the file the backlog wants shrunk. A self-contained `InventoryTable` (props: `items`, `vendors`, `selectedName`, `onSelect`, `visibleColumns`/`width`, `locale`, `getItemStatus`) keeps the `InventoryDesktopLayout` branch to wiring (state, pane, close paths). This is additive, not a refactor of the file's other sections.
- **Reuse vs retire `InventoryRow`.** `InventoryRow` (`src/components/cmd/InventoryRow.tsx`, the two-line card) is **kept and reused** for the narrow tier (`<1100`, AC-10). It does **not** gain columns — the multi-column desktop row is `InventoryTable`'s own cell layout (new). Do not fold 8 columns into `InventoryRow`; that would bloat a component two other narrow surfaces depend on.
- **`StatusPill`/`StatusDot`/`ParBar`** reused as-is inside `InventoryTable`.

### Column collapse tiers (concrete — resolves AC-7 / OQ-7)
Width-keyed conditional columns via `useWindowDimensions()` (cross-platform; OQ-7 preferred over horizontal scroll). Columns 1/2/3 (name, on-hand+par, status) **always render**. Drop order highest-number-first: (8) last counted → (7) category → (6) vendor → (5) stock value → (4) cost/each. Concrete tiers keyed on the **width available to the list** (see the pane-open note):

| List width (px)      | Columns shown                                                        |
|----------------------|----------------------------------------------------------------------|
| `≥ 1400`             | all 8 (name, on-hand, status, cost/each, stock value, vendor, category, last counted) |
| `1200 – 1399`        | drop **last counted** → 7 cols                                       |
| `1100 – 1199`        | drop **category** → 6 cols (name, on-hand, status, cost/each, stock value, vendor) |
| `< 1100` (tablet/phone) | table does NOT render — narrow-tier list ↔ detail flow (AC-10)     |

The `1100–1199` floor (name/on-hand/status + cost/each + stock value + vendor) satisfies AC-7's "table still worth it" minimum. Below 1200 the always-3 plus the three highest-value money/vendor columns survive.

- **Pane-open width (the decision the spec left open under AC-7).** When the detail pane is OPEN, the table narrows. The tier MUST key on the **list's own rendered width, not the window width** — otherwise a full-window-wide table would keep all 8 columns while physically squeezed into ~55% of the screen, overflowing. Implement by measuring the list container with `onLayout` and passing its width to `InventoryTable`, OR compute `listWidth = paneOpen ? windowWidth - PANE_WIDTH : windowWidth` (with a fixed `PANE_WIDTH`, e.g. 560–640px, `flex: 1` list to the left). Either is acceptable; `onLayout` is the more robust. Feed **that** width into the tier table above. Result: opening the pane on a 1440px window (list ≈ 880px) collapses the table to the 6-column floor — correct.

### Selection state (resolves AC-3 / AC-8b / AC-8c)
- **Local `useState`**, not the store. Reuse the EXISTING `selectedName` `useState<string|null>` already at `:100` — it is already ephemeral and local. Do **not** promote to `useStore`; the spec calls selection ephemeral and per-instance, and no other surface needs to read it.
- **No auto-select (AC-3).** Delete/guard the `:141-145` first-render auto-select effect for `per-store` mode. Because `selectedName` initializes to `null` and there's no auto-select, the pane is absent on entry. The ⌘K bridge at `:152-161` (`setSelectedName(pendingPaletteAction.selectedName)`) is unchanged — a palette "focus item X" still opens the pane.
- **Store-switch closes the pane (AC-8b).** Add an effect keyed on `currentStore.id` that sets `selectedName(null)`:
  ```ts
  React.useEffect(() => { setSelectedName(null); }, [currentStore.id]);
  ```
  This intentionally overrides the old name-keyed "selection survives store switch" behavior (`:97-99` comment) for the new detail-on-demand model. Note ordering vs the palette effect: a ⌘K focus that also switches store is not a supported flow in v1 (palette focus targets the current store's items) — the store-id effect firing after mount is fine.
- **Section-leave clear (AC-8c).** The existing `:105-107` effect (`section !== 'Inventory' → setSelectedName(null)`) already covers this — unchanged.
- **`item` derivation** (`:163-166`, find-by-lowercased-name in `storeInventory`) is unchanged; `item === undefined` when `selectedName === null` → pane absent. That is the close mechanism for all three paths (they all set `selectedName = null`).

### Esc handling (resolves AC-5 / AC-14 — cross-platform)
- **Web-only keydown listener, `Platform.OS === 'web'`-gated**, in a `useEffect` — never referenced from the render path, so no web API leaks into the native bundle:
  ```ts
  React.useEffect(() => {
    if (Platform.OS !== 'web') return;                 // native: no-op, no listener
    if (!selectedName) return;                         // only while pane is open
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setSelectedName(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedName]);
  ```
  The `Platform.OS !== 'web'` early-return means `window`/`KeyboardEvent` are never touched on native (they're referenced only inside the guarded branch, and RN's Metro tree-shakes nothing here but the early return prevents execution). This is the same guard shape used for other web-only affordances in the codebase (`confirmAction`'s web branch, `webPush`). Add `Platform` to the existing `react-native` import at `:2`.
- The other two close paths: **✕ button** in the pane header `onPress={() => setSelectedName(null)}`; **same-row re-click** — the row `onPress` toggles: `onPress={() => setSelectedName(prev => prev === it.name.toLowerCase() ? null : it.name.toLowerCase())}`.

### a11y (resolves AC-12)
- **✕ close button:** `accessibilityRole="button"` + `accessibilityLabel={T('section.inventory.closeDetailAria')}` (new i18n key, e.g. "Close item detail" / real es+zh-CN). Mirrors the existing DELETE/+COUNT button a11y at `:494-495`,`:502-503`.
- **Row selection semantics:** each table row (`TouchableOpacity`) carries `accessibilityRole="button"` and `accessibilityState={{ selected: selectedName === it.name.toLowerCase() }}`. The visual selected affordance stays the existing accent left-border + `accentBg` (as `InventoryRow` does at `:52-55`).

### Realtime / frontend-store impact
- **Realtime:** none. No mutation, no publication change. `useRealtimeSync` untouched.
- **`src/store/useStore.ts`:** **no slice change.** Reads `inventory`/`vendors`/`getItemStatus`/`deleteItem`/`currentStore` already exposed. `deleteItem` still clears selection + toasts via the existing `:343-354` handler (AC-11); no optimistic/`notifyBackendError` path is added (no new mutation).

### jest cases the FE dev MUST pin (AC-13)
Mount the `per-store` branch (or `InventoryDesktopLayout` with a mocked store slice), mirroring existing section render tests:
1. **Table columns render** on a wide (`≥1400`) viewport — header row shows name / on-hand / status / cost / stock value / vendor / category / last counted labels; a data row renders cost + stock-value cells.
2. **No detail on entry** — mount with no palette action → `selectedName === null`, no `<DetailPane>` in the tree.
3. **Open / ✕ / Esc / same-row close** — click row → pane present; ✕ → absent; re-open, dispatch a web `keydown{key:'Escape'}` → absent; re-open, click the SAME row → absent (toggle).
4. **Row swap while open** — click row A (pane present), click row B → pane still present, detail now shows B (no unmount).
5. **Store switch closes** — pane open, change `currentStore.id` in the mocked slice → `selectedName` null, pane absent.
6. **Money value-pins (★)** — fixture `costPerUnit=0.02, subUnitSize=2000, currentStock=3` → cell `cost/each = "$0.02"`, `stock value = "$120"`; assert these EQUAL the `DetailPane` header strings for the same fixture (single-definition proof).
7. **Collapse tiers** — render at simulated widths and assert: `≥1400` → last-counted header present; `1200–1399` → last-counted absent, category present; `1100–1199` → category absent, vendor present, name/on-hand/status/cost/stock-value present.
8. **Catalog/categories untouched** — switch `viewMode` to `catalog` → `<InventoryCatalogMode>` still renders with its auto-selected detail (boundary smoke).

### Risks / tradeoffs
- **★ drift is the only real risk.** Mitigated by the single-definition helper + the case-6 equality assertion (cell string === header string). Enforce at review: any second cost expression is a Critical.
- **Pane-open collapse correctness.** If the tier keys on window width (not list width) with the pane open, columns overflow the narrowed list. The `onLayout`/`windowWidth - PANE_WIDTH` note above is the mitigation; case-7 should ideally also exercise the pane-open path (open pane on a wide window, assert collapsed column set) — recommended, not blocking.
- **Perf on the 286 KB seed.** Desktop table renders all filtered rows (the current list already does via `FlatList`). Keep `InventoryTable`'s rows in a `FlatList`/virtualized list, not a `.map()` in a `ScrollView`, to preserve current scroll perf on large stores.
- **Native Esc absence** is by-design (AC-14): native keeps ✕ + re-tap. No functional gap.
- **No cold-start / migration-ordering risk** — zero backend.

## Files changed

Frontend-only, per the design note. No backend / DB / edge-function surface touched.

**New**
- `src/screens/cmd/lib/itemMoney.ts` — the ★ single cost-definition module.
  `stockValue` / `formatStockValue` / `costPerEachLabel` / `formatCostPerEach`
  carry the `InventoryDesktopLayout.tsx:449` + `:456-459` spec-104 per-each
  semantics VERBATIM. Consumed by BOTH the table cells and the `DetailPane`
  header, so exactly one definition of each exists. Does NOT reuse
  `src/utils/perEachCost.ts` (different spec-096 math).
- `src/components/cmd/InventoryTable.tsx` — the full-width operational table
  (name, on-hand + par bar, status, cost/each, stock value, vendor, category,
  last counted). Column collapse keyed on the LIST width via the exported
  `visibleColumnsForWidth` (≥1400 all 8; 1200–1399 drop last-counted;
  1100–1199 drop category, 6-col floor). Rows: `accessibilityRole="button"`,
  `accessibilityState={{ selected }}`, toggle press. Reuses `StatusDot` /
  `StatusPill` / `ParBar`; rows in a `FlatList` (perf note). Money cells call
  the `itemMoney` helpers.
- `src/screens/cmd/lib/__tests__/itemMoney.test.ts` — unit-pins the ★ helper
  values (incl. the case-6 `$0.02` / `$120` value pin) in the fast node
  project.
- `src/components/cmd/InventoryTable.test.tsx` — pins AC-1 (operational
  headers + cost/stock-value cells at a wide width) and AC-7 collapse tiers
  (render at explicit widths + the pure `visibleColumnsForWidth`).
- `src/screens/cmd/__tests__/InventoryDesktopLayout.test.tsx` — pins the
  detail-on-demand lifecycle: no pane on entry; click opens; ✕ / Esc (web
  keydown) / same-row re-click close; row-swap-without-close; store-switch
  clears selection; the ★ money value pin asserted EQUAL between the table
  cell and the `DetailPane` header; catalog.tsv boundary smoke. Plus the two
  AC-7 post-impl-fix regression pins (pane-open re-tiers 8→6 cols; a narrower
  window drops to 7).

**Modified**
- `src/screens/cmd/InventoryDesktopLayout.tsx` — rewrote the
  `viewMode === 'per-store'` branch: full-width `InventoryTable` on desktop
  (≥1100) with an on-demand right-side detail pane; the table's collapse-tier
  width is derived ARITHMETICALLY (`tableWidth = windowWidth − chromeW − (pane
  while open)`) so it re-tiers reactively on window resize and pane open/close
  (see the AC-7 post-impl fix below); fixed `PANE_WIDTH`; web-only Esc listener
  (`Platform.OS === 'web'`-gated); ✕ close button (`accessibilityRole="button"`
  + `closeDetailAria`); same-row re-click toggle. Removed the `:141-145`
  auto-select; added a `[currentStore.id]` effect that clears selection
  (store switch closes the pane); kept the existing section-leave clear.
  `<1100` keeps the `InventoryRow` list ↔ full-width detail swap. Refactored
  the `DetailPane` header (and the `properties.json` `cost_per_unit` line) to
  consume the `itemMoney` helpers — the ★ single-definition invariant.
- `src/i18n/en.json`, `src/i18n/es.json`, `src/i18n/zh-CN.json` — added the 5
  new `section.inventory.*` keys (`nameCol`, `stockValueCol`, `categoryCol`,
  `lastCountedCol`, `closeDetailAria`) with real es / zh-CN translations.
  Existing `onHandCol` / `statusCol` / `vendorCol` / `costPerUnitCol` reused.

### Verification
- `npx tsc --noEmit` — exit 0.
- `npx tsc -p tsconfig.test.json --noEmit` — exit 0.
- `npx jest` (full suite) — 90 suites / 993 tests pass (includes the
  pre-existing `i18n` parity suite, which validates the 5 new keys across all
  three catalogs; no pre-existing test pinned the removed auto-select behavior;
  the +2 over the first pass are the AC-7 post-impl-fix regression pins).
- Web build: the react-native-web app bundle (`expo start --web`, port 8081)
  compiles to valid JS with `itemMoney` / `InventoryTable` /
  `InventoryDesktopLayout` present in the module graph and no TransformError.
  Interactive click/resize browser tools were not available in THIS session —
  the live pane-open/window-resize re-tier is best re-confirmed on the
  coordinator's side (which ran the original browser pass); the two new jest
  regression pins reproduce the defect deterministically in the meantime.

## Post-implementation fix (AC-7)

The coordinator's browser pass (Expo web, local stack) caught an AC-7 defect in
the first implementation: the column-collapse tiers never reacted after mount.
Root cause — in this react-native-web setup, `onLayout` on the flex:1 list
wrapper fires only at MOUNT; it does NOT re-fire when the element reflows via
pure CSS flex (the pane sibling mounting) nor on window resize. So the measured
`listWidth` was frozen at its mount value and `visibleColumnsForWidth` never
re-tiered: opening the 620px pane left the table rendering all 8 columns
overflowing/clipping under the pane, and a window shrink 1800→1500 still showed
8 columns.

Fix (deterministic, no reliance on onLayout resize semantics): derive the table
width arithmetically from the reactive `windowWidth` (from `useWindowDimensions`,
which IS reliably reactive). `onLayout` now measures the OUTER row container
(whose width does NOT change when the pane toggles) exactly once to capture the
CHROME overhead — `setChromeW(windowWidth − layout.width)` from the same frame —
and each render computes `tableWidth = max(320, windowWidth − (chromeW ??
FALLBACK_CHROME) − (item ? PANE_WIDTH : 0))`, fed to `InventoryTable`. Window
resizes re-tier via the subtraction; pane open/close re-tiers via the `item`
term; neither depends on `onLayout` ever re-firing. `FALLBACK_CHROME` (~260,
matching the current shell chrome) covers the first frame before the outer-row
onLayout sets `chromeW`. `visibleColumnsForWidth` is unchanged. Pinned by two new
jest regressions in `InventoryDesktopLayout.test.tsx` (pane-open 8→6; window
1500 → 7).

**Files touched by the fix:** `src/screens/cmd/InventoryDesktopLayout.tsx`
(width derivation + outer-row onLayout) and
`src/screens/cmd/__tests__/InventoryDesktopLayout.test.tsx` (mutable
`mockWindowWidth` + the two regression pins). No other files changed.
