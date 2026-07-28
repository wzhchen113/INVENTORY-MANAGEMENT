# Spec 142: Phone tier for list/detail admin sections + global phone chrome

Status: READY_FOR_REVIEW

> Second build increment of the admin-console phone-optimization program driven
> by the external design handoff (`design_handoff_imr_phone`, revision 2). Spec
> 140 delivered the phone EOD-count section + the `PhoneType` ramp + the
> `ResponsiveSheet` keypad idiom. This spec covers (A) the **global phone
> chrome** (52px top app bar, banner-below-bar, no status footer) and (B) the
> **list/detail admin sections**: Inventory (items list + catalog mode + item
> detail), Menu impact, Menu items/BOM (Recipes), Prep recipes, Vendors, and
> Waste log. Every one of these currently squeezes its desktop master-detail
> split into phone width — the exact defect the handoff's "⚠ HARD RULES"
> section forbids. This is a frontend-only, presentation-layer change gated on
> `useIsPhone()`; no backend, migrations, edge functions, or `src/lib/db.ts`
> contract changes.

## User story

As a store manager holding my phone on the floor, I want the Inventory, Menu,
Prep, Vendors, and Waste sections to show full item names in scrollable list
rows and open a full-screen detail when I tap one — instead of a cramped
side-by-side split with vertically-stacked letters, "2A…" truncations, and a
desktop tab strip / toolbar / status footer I can't use — so that I can read
and act on my catalog one-handed at 375px without pinch-zooming or scrolling
sideways.

## Acceptance criteria

All criteria below apply ONLY when `useIsPhone()` is true (viewport < 768px OR
any native platform), inside the existing `ResponsiveCmdShell` phone branch
(`src/screens/cmd/ResponsiveCmdShell.tsx:382`). The desktop (≥1100px) and tablet
(768–1099px) layouts of every touched section MUST remain byte-unchanged (see
AC-REG). The handoff's "⚠ HARD RULES" (README §25–56) are normative: no
master-detail split pane, no desktop table reuse, no vertical letter-stacking,
no desktop chrome (tab strips / EDIT·DELETE·+COUNT toolbars / status footer /
⌘K hints), a fixed 52px never-overlapped top bar, ≥44×44 hit floors, and real
data volumes (143 items / 41 menu items) virtualized and grouped. Every color
maps 1:1 to existing `LightCmd`/`DarkCmd` tokens — no new palette values. The
`PhoneType` ramp and `ResponsiveSheet` bottom-sheet idiom from spec 140 are
reused, not re-invented.

### Global phone chrome (Hard Rules 4 + 5)

- [ ] AC-C1: The phone top app bar (`MobileTopAppBar`, mounted at
  `ResponsiveCmdShell.tsx:387`) is a **fixed 52px** row (currently a fixed ~44px
  row per the handoff root-cause note) with a hairline bottom border and `panel`
  background: leading ☰ hamburger (≥44×44) + section title (`PhoneType.screenTitle`,
  single line, ellipsized), trailing bell (badged) · refresh ↻ · theme ◐ each a
  ≥44×44 hit target. The title is never overlapped by trailing content.
- [ ] AC-C2: The "notifications blocked" multi-line copy no longer renders inside
  the top app bar's trailing slot. `NotificationToggle`
  (`src/components/cmd/NotificationToggle.tsx`, mounted at
  `ResponsiveCmdShell.tsx:390-395`) on phone contributes only a badged bell
  glyph (≥44×44) to the trailing row; the blocked/enable-push messaging renders
  as a **dismissible banner row BELOW the 52px bar** (or a toast), never on top
  of the title. Root cause fixed: the fixed-height bar no longer spills.
- [ ] AC-C3: `CmdStatusBar` (rendered unconditionally at
  `src/screens/cmd/InventoryDesktopLayout.tsx:603`: `synced · UTF-8 · LF · ⌘K ·
  version`) does **not** render when `useIsPhone()` is true, on any section it
  appears on. No `⌘K` hint text renders on phone.
- [ ] AC-C4: No section in scope renders a desktop tab strip (e.g.
  `items.tsv` / `catalog.tsv` / `detail.tsx` / `usage.tsx`), an
  EDIT/DELETE/+COUNT toolbar row, or a fixed-width detail pane on phone. (Enforced
  per-section by the ACs below; this is the umbrella statement of Hard Rule 4.)

### Shared phone drill-in scaffold (Hard Rule 1 + Global patterns §83)

- [ ] AC-D1: A shared phone drill-in scaffold generalizes the Brands
  full-screen-on-demand idiom (`src/screens/cmd/sections/BrandsSection.tsx:225`,
  the `isCompact && showDetail` early-return). Structure/placement is the
  architect's call (e.g. a new `src/screens/cmd/sections/phone/` folder mirroring
  the `eod/` precedent) — this spec requires that the six sections in scope
  share ONE scaffold rather than each hand-rolling its own.
- [ ] AC-D2: On phone, tapping a list row REPLACES the screen with a full-screen
  detail (Hard Rule 1). The list is NOT visible behind or beside it; no pane is
  narrower than 320px because there is no pane. Nothing is selected by default —
  the list opens with no detail shown (Hard Rule 7).
- [ ] AC-D3: The detail's header is a **52px** row with a **44px ← back** control
  and a mono parent-name caption (`PhoneType.caption`, upper) naming the parent
  screen (e.g. "INVENTORY", "VENDORS", "MENU"). Detail enters with a slide-in
  (220ms; RN `Animated`, matching the spec-140 sheet idiom — NOT
  Reanimated-on-web, NOT `@gorhom/bottom-sheet`).
- [ ] AC-D4: Pressing ← always returns to the list the user left and **restores
  the prior scroll position** (the list is not remounted-from-top).
- [ ] AC-D5: Desktop-only edit actions (e.g. EDIT RECIPE, DELETE) that have no
  phone form in this spec surface an **honest toast** (e.g. "Edit on desktop")
  instead of a fake/no-op form (handoff §203).

### Inventory — items list + catalog mode + item detail (handoff §123)

- [ ] AC-INV1: The Inventory list (`src/screens/cmd/InventoryDesktopLayout.tsx`,
  which today renders a narrow list + the desktop `DetailPane` fixed at width
  620 with `detail.tsx`/`usage.tsx` tabs + an EDIT/DELETE/+COUNT toolbar) renders
  on phone as a single full-width scrolling list with NO detail pane and NO
  toolbar. A 44px search input + a **segmented status filter** (46px:
  ALL/OUT/LOW/OK, each segment showing a count over a micro label, active =
  `panel2` fill) replaces the desktop chip cloud; the filter is always visible.
- [ ] AC-INV2: Rows are grouped by category with mono captions
  (`PhoneType.caption`). Each row is a **two-line card** (≥48 tall): line 1 =
  status pill (OUT/LOW/OK, `StatusPill`) + name (`PhoneType.itemName`, `flex:1`,
  ellipsize only past full available width) + right-aligned "44 /40 lbs"
  (`PhoneType.tableNum` 600 + fg3 suffix, nowrap); line 2 = a 3px par bar (fill =
  status color, width = stock/par, clamped) + "$/unit · VENDOR" meta
  (`PhoneType.metaMono`). No name is truncated to "2A…"; no column truncated to
  "C…"; no letter-stacking. Status pills use semantic OUT/LOW/OK tokens, never
  the accent (handoff §91).
- [ ] AC-INV3: The list uses `FlatList` virtualization and handles the real
  143-item volume without rendering all rows eagerly and without a
  selected-by-default row.
- [ ] AC-INV4: Tapping a row opens the full-screen **item detail** (via the AC-D
  scaffold) that wholesale replaces the desktop `detail.tsx`/`usage.tsx` tab
  pane: pill + "CAT · id · VENDOR" caption, name (22/600), a stat panel (on-hand
  in status color / par, 4px bar, COST · CASE PACK · SUGGEST cells), action
  buttons **COUNT NOW** (accent — deep-links into the EOD keypad for that item
  via the existing `usePaletteAction` `eodFocusItemId` bridge from spec 140) +
  **VIEW IN ORDERING** (outline), a PROPERTIES card (category / vendor / case
  pack + $-per-case / stock value / avg daily use / days-of-stock / last
  counted), and RECENT COUNTS history rows. Status/on-hand read from the existing
  `inventory` slice + `getItemStatus`.
- [ ] AC-INV5: Catalog mode (`src/screens/cmd/sections/InventoryCatalogMode.tsx`,
  today a fixed 340px left pane) follows the same phone shape: full-width list +
  full-screen detail, no fixed-width pane. Catalog reads its existing data
  source; no new store fields.
- [ ] AC-INV6 (per-section acceptance check, handoff §53): at 375×812 in
  Inventory, list rows show full names, tapping a row fills the screen with its
  detail, ← restores scroll position, nothing renders sideways, and there is no
  horizontal scrolling except the (chip/segment) filter row.

### Menu impact (capacity model — handoff §188)

- [ ] AC-MI1: `src/screens/cmd/sections/MenuImpactSection.tsx` (today a
  desktop table with fixed-width columns 110/90/140: MENU ITEM / MAKEABLE /
  LIMITED BY / LOW INGR.) renders on phone as two-line card rows (Hard Rule 2),
  NOT a table: line 1 = capacity pill (×0 danger / ~N warn when <15 / ~N ok) +
  name (`flex:1`, ellipsize past full width) ; line 2 = "LIMITED BY <ingredient>"
  + a "N LOW" tag (warn when >0). Rows are sorted by capacity ascending
  (most-impacted first). A chip row exposes ALL n / IMPACTED ONLY n; a KPI line
  shows "N BLOCKED · N LIMITED · MOST-IMPACTED FIRST".
- [ ] AC-MI2: Makeable/limited-by use the server-computed `menuCapacity`
  selector when available, with the client fallback
  `makeable = min over tracked BOM lines of floor(onHand / needPerPlate)` and
  `limitedBy = argmin` (handoff §194) — reusing whatever the desktop section
  already computes; no new backend surface.
- [ ] AC-MI3: Tapping a Menu-impact row opens the **same menu-item detail** as
  the Menu items/BOM section (AC-BOM2), via the AC-D scaffold.
- [ ] AC-MI4: Menu-impact per-section acceptance check passes at 375×812 (full
  names, full-screen detail, ← restores scroll, nothing sideways, no horizontal
  scroll except the chip row).

### Menu items / BOM — Recipes (handoff §177)

- [ ] AC-BOM1: `src/screens/cmd/sections/RecipesSection.tsx` (today a 340px pane
  + three `TabStrip`s) renders on phone as a full-width grouped list, no pane, no
  tab strips. Row = margin pill + name (`flex:1`) / "N INGREDIENTS · COST $8.19"
  meta / right = price + makeable tag ("×0 MAKEABLE" danger, "~N" warn when <15,
  else fg3).
- [ ] AC-BOM2: Tapping a row opens the full-screen menu-item detail: makeable
  pill + stats MAKEABLE / PRICE / MARGIN; an **INGREDIENT AVAILABILITY** section
  whose caption names the limiting ingredient, one row per BOM line (name, "NEED
  1.5 lbs / PLATE · MAKES ×N", on-hand + status colored by OUT/LOW/OK; untracked
  sub-recipes show a "PREP" tag); a PLATE COSTING row; and actions EDIT RECIPE
  (honest toast per AC-D5) + ORDER SHORTAGES → Ordering (via `usePaletteAction`).
  Reads the existing `recipes` slice + cost getters.
- [ ] AC-BOM3: Recipes per-section acceptance check passes at 375×812.

### Prep recipes (handoff §185)

- [ ] AC-PREP1: `src/screens/cmd/sections/PrepRecipesSection.tsx` (today a 340px
  pane) renders on phone as a full-width list, no pane. Row = name (`flex:1`) /
  "YIELD 10 lbs · $8.40/BATCH" / right "$0.84/lb" + "IN N MENU ITEMS".
- [ ] AC-PREP2: Tapping a row opens the full-screen prep detail: stats YIELD /
  BATCH COST / COST PER UNIT; an INGREDIENTS section (qty per batch + cost); a
  USED IN section (menu item + sell price + current makeable); actions EDIT
  RECIPE (honest toast per AC-D5) + LOG A BATCH (honest toast unless a phone form
  already exists — reuse existing behavior; no new form built here). Reads the
  existing `prepRecipes` slice + cost getters.
- [ ] AC-PREP3: Prep per-section acceptance check passes at 375×812.

### Vendors (handoff §174)

- [ ] AC-VEN1: `src/screens/cmd/sections/VendorsSection.tsx` (today a 300px left
  pane + a `TabStrip` detail) renders on phone as a full-width list, no pane, no
  tab strip. Row = delivery-days pill + name (`flex:1`) / "contact · phone" /
  "LEAD 2d" + "CUTOFF 15:00 · N ITEMS".
- [ ] AC-VEN2: Tapping a row opens the full-screen vendor detail: stats LEAD TIME
  / CUTOFF / ITEMS; sections CONTACT, ORDER CODES (item ↔ vendor SKU), SCHEDULE;
  actions CALL VENDOR + VIEW IN ORDERING (via `usePaletteAction`). Reads the
  existing `vendors` slice.
- [ ] AC-VEN3: Vendors per-section acceptance check passes at 375×812.

### Waste log (two-step log sheet — handoff §163/§195)

- [ ] AC-WASTE1: `src/screens/cmd/sections/WasteLogSection.tsx` (today a 340px
  pane) renders on phone as a full-width event feed, no pane. Header meta shows
  the period total (e.g. "−$46.90 THIS WK"); a horizontally-scrolling reason chip
  row (all / spoiled / dropped / expired / comped, each with live counts, ≥44×44,
  active = accent border + `accentBg`) filters the feed. Event rows show item +
  meta with cost in the danger token.
- [ ] AC-WASTE2: A "+ LOG WASTE" button (48px) opens a **two-step bottom sheet**
  on `ResponsiveSheet` (`presentation.phone: 'bottom-sheet'`, the spec-140
  idiom): step 1 = item picker (48px scrollable rows); step 2 = qty stepper (52px,
  ±≥44 buttons) + reason chips (SPOILED/DROPPED/EXPIRED/COMPED, 2×2, active =
  accent border + `accentBg`) + a cost preview + SAVE (accent). SAVE calls the
  existing `logWaste` store action and prepends the event to the feed. No new
  backend surface.
- [ ] AC-WASTE3: Waste per-section acceptance check passes at 375×812.

### Regression guard

- [ ] AC-REG1: With `useIsPhone()` false (tablet 768–1099px AND desktop ≥1100px,
  web), the render output of every touched section — `InventoryDesktopLayout`,
  `InventoryCatalogMode`, `MenuImpactSection`, `RecipesSection`,
  `PrepRecipesSection`, `VendorsSection`, `WasteLogSection` — is byte-unchanged
  from `main`. All new phone code paths are gated behind `isPhone` early-returns;
  the desktop/tablet return subtrees are not edited. A jest snapshot or explicit
  render assertion at a desktop width and a tablet width pins this per section.
- [ ] AC-REG2: The spec-140 phone EOD-count flow is unaffected **except** where
  it benefits from the shared chrome fixes (52px bar, banner-below-bar, no status
  footer). No EOD count-entry behavior changes.
- [ ] AC-REG3: Both themes (Light + Dark via `useCmdColors()`) render correctly
  for every new phone surface; the `CmdStatusBar` suppression and the
  banner-below-bar hold in both.

## In scope

- Global phone chrome: `MobileTopAppBar` → fixed 52px; `NotificationToggle`
  blocked-copy moved to a dismissible banner-below-bar (or toast); `CmdStatusBar`
  suppressed on phone.
- One shared phone drill-in scaffold (list → full-screen detail, 52px header /
  44px ← / mono parent caption / 220ms slide-in / back-restores-scroll),
  generalized from the Brands idiom.
- Phone-tier restyle behind `useIsPhone()` of: Inventory items list + item
  detail (`InventoryDesktopLayout.tsx`), Inventory catalog mode
  (`InventoryCatalogMode.tsx`), Menu impact (`MenuImpactSection.tsx`), Menu
  items/BOM / Recipes (`RecipesSection.tsx`), Prep recipes
  (`PrepRecipesSection.tsx`), Vendors (`VendorsSection.tsx`), Waste log
  (`WasteLogSection.tsx`).
- Inventory segmented ALL/OUT/LOW/OK status filter; two-line card rows with
  `flex:1` names; category grouping with mono captions; `FlatList`
  virtualization; ≥44×44 hit floors; semantic status pills (never the accent);
  honest toasts for desktop-only edit actions.
- The Waste two-step log sheet on the existing `ResponsiveSheet`.
- Reuse of the spec-140 `PhoneType` ramp (`src/theme/typography.ts`),
  `ResponsiveSheet` (`src/components/cmd/ResponsiveSheet.tsx`), `StatusPill`,
  `SectionCaption`, `useCmdColors()`, `CmdRadius`, and `LightCmd`/`DarkCmd`
  tokens only — NO new palette values, and reuse (not duplication) of the ramp.
- Both themes (Light + Dark). Web phone (<768px) AND native (always phone tier).

## Out of scope (explicitly)

These are later specs / separate increments, not built here:

- **Bottom-dock navigation.** The handoff's `navStyle` decision (bottom-dock vs
  drawer) is deferred; this spec builds against today's hamburger `MobileNavDrawer`
  and MUST NOT introduce bottom-dock nav. Rationale: shell-wide decision, not a
  list/detail concern.
- **Login** (handoff §213), **notifications sheet** (handoff §217 — only the
  bell-in-bar + blocked-banner relocation is in scope, not the full sheet),
  **store/brand switch takeover** (handoff §224), **Dashboard** (§158),
  **Ordering** (§137), **weekly Inventory count / reconciliation** (§152/§198),
  **POS imports**, **Audit log**, **Reports**, **Users & access** (invite sheet),
  **Brands** (already has the compact drill-in that this scaffold generalizes),
  **DB inspector**. Each is its own later increment.
- **The STAFF app** (`src/screens/staff/`, `StaffStack`). Separate surface;
  RoleRouter mounts the Cmd UI only for admin/master/super_admin. Not touched.
- **Desktop + tablet layouts** of the touched sections — byte-unchanged (AC-REG).
- **New backend / migrations / RPCs / edge functions / `src/lib/db.ts` contract
  changes.** Pure presentation-layer. Menu impact reuses the existing
  `menuCapacity` selector (+ client fallback already present); Waste reuses
  `wasteLog`/`logWaste`; Vendors `vendors`; Recipes `recipes` + cost getters;
  Prep `prepRecipes` + cost getters; Inventory `inventory`/`getItemStatus`.
- **New palette values.** Handoff guarantees 1:1 token mapping.
- **Building phone edit/create forms** for recipes, prep, vendors, catalog
  items — desktop-only edit actions get an honest toast (AC-D5); this spec adds
  no new create/edit form except the Waste two-step log sheet (which reuses the
  existing `logWaste` action).
- **`app.json` slug** — untouched (load-bearing, see CLAUDE.md).

## Open questions resolved

- Q: Which surfaces are in scope? → A: Fixed by the owner — (A) global phone
  chrome and (B) Inventory (items list + catalog mode + item detail), Menu
  impact, Menu items/BOM (Recipes), Prep recipes, Vendors, Waste log. Everything
  else (bottom-dock nav, login, notifications sheet, store switch, Dashboard,
  Ordering, weekly count, reconciliation, POS imports, audit log, reports, users,
  Brands, DB inspector) is explicitly a later spec.
- Q: Count-flow default? → A: Already decided in spec 140 (keypad sheet); not
  re-opened here.
- Q: Drill-in pattern — new scaffold vs per-section hand-roll? → A: One shared
  scaffold generalizing the Brands `isCompact && showDetail` idiom
  (`BrandsSection.tsx:225`). Exact file structure is the architect's call
  (recommended default: a `sections/phone/` folder mirroring the `eod/`
  precedent) — not a blocker.
- Q: Does the notifications-overlap fix require the full notifications sheet? →
  A: No. Only the fixed-52px bar + relocating the blocked-copy to a
  banner-below-bar (or toast) is in scope; the full sheet is a later spec.

## Dependencies

- Existing primitives (no new libs):
  - `useIsPhone()` / `useBreakpoint()` — `src/theme/breakpoints.ts`.
  - `PhoneType` ramp — `src/theme/typography.ts:61` (spec 140), reused as-is;
    if a role is missing for a list/detail need, extend additively (existing
    `Type` map stays byte-unchanged).
  - `ResponsiveSheet` (`presentation.phone: 'bottom-sheet'`) —
    `src/components/cmd/ResponsiveSheet.tsx` (Waste two-step log sheet).
  - `StatusPill`, `SectionCaption`, `useCmdColors()`, `CmdRadius`,
    `LightCmd`/`DarkCmd` — existing theme tokens.
  - Brands drill-in idiom to generalize — `src/screens/cmd/sections/BrandsSection.tsx:225`.
  - Deep-link plumbing — `usePaletteAction` (`src/lib/paletteAction.ts`), already
    carrying `eodFocusItemId` (spec 140) for the Inventory COUNT NOW deep-link and
    the section-switch `request(...)` for VIEW IN ORDERING / ORDER SHORTAGES.
- Store slices (all existing, no schema/store-field changes): `inventory` +
  `getItemStatus`, `menuCapacity` selector, `recipes` + cost getters,
  `prepRecipes` + cost getters, `vendors`, `wasteLog` + `logWaste`.
- Shell integration points to modify: `ResponsiveCmdShell.tsx:382-398`
  (MobileTopAppBar height + trailing slot + banner-below-bar),
  `InventoryDesktopLayout.tsx:603` (CmdStatusBar suppression on phone).
- No dependency blocks the build — all open questions are resolved.

## Project-specific notes

- **Cmd UI section / legacy:** Admin Cmd UI only — `src/screens/cmd/` and its
  `sections/`. No legacy surface (spec 025 deleted it).
- **Which app:** Admin console only. Staff app explicitly out of scope.
- **Per-store or admin-global:** Per-store. All reads stay scoped to
  `currentStore.id` exactly as today; per-store RLS unchanged (no policy edits).
  Brand-scoped catalog reads (catalog mode, recipes) keep their existing scoping.
- **Realtime channels touched:** None changed. The existing `store-{id}` /
  `brand-{id}` sync (`src/hooks/useRealtimeSync.ts`) continues to drive reloads;
  no new publication membership → the `docker restart supabase_realtime_imr-inventory`
  publication gotcha does not apply.
- **Migrations needed:** No.
- **Edge functions touched:** None.
- **Web/native scope:** Both. Web phone (<768px) AND native (always phone tier).
  Nothing here is web-only.
- **Tests (spec 022 tracks):** jest track only. New/updated jest tests:
  (a) the desktop + tablet regression guards per touched section (AC-REG1);
  (b) the shared drill-in scaffold (open on tap, back-restores-scroll, no pane
  rendered on phone); (c) Inventory segmented filter counts + two-line row +
  status-pill-not-accent + FlatList virtualization at 143 items;
  (d) Menu-impact capacity sort + client fallback formula; (e) Waste two-step
  sheet → `logWaste` prepend; (f) honest-toast for desktop-only edit actions;
  (g) global chrome: 52px bar height, blocked-copy renders below the bar not
  inside it, `CmdStatusBar` absent on phone. No pgTAP (no DB change) and no shell
  smoke (no edge fn / curl path) needed.
- **Reference (outside the repo, spec-140 precedent):** the interactive prototype
  `design_handoff_imr_phone/IMR Phone Console.dc.html` and its `README.md` /
  `original-brief.md`. Recreate the intended look inside the RN/RNW codebase; the
  HTML is a reference, not production code.

## Non-goals recap

Bottom-dock nav, login, notifications sheet, store-switch takeover, Dashboard,
Ordering, weekly count, reconciliation, POS imports, audit log, reports, users &
access, Brands (already compact), DB inspector — all deferred to later specs.
Frontend-only: no migrations, no edge functions, no `src/lib/db.ts` contract
changes.

## Backend design

### 0. Backend contract: NO CHANGES (confirmed)

This spec is **frontend / presentation-layer only**. I have read the shell
(`ResponsiveCmdShell.tsx`), the Inventory host (`InventoryDesktopLayout.tsx`),
all seven touched sections, the spec-140 `eod/` phone precedent, `ResponsiveSheet`,
`PhoneType`, `useNotificationToggle`, `usePaletteAction`, and `breakpoints.ts`.
There is **nothing to design on the backend**:

- **Data model:** no new tables / columns / indexes. No migration file.
- **RLS:** no policy adds or edits. Every read stays scoped to `currentStore.id`
  (per-store) and the existing brand-scoped catalog reads, exactly as today.
  `auth_can_see_store()` / `auth_is_admin()` untouched.
- **API contract (PostgREST vs RPC):** unchanged. Menu impact keeps reading the
  server-computed `menuCapacity` slice (`compute_menu_capacity` RPC via
  `db.ts:fetchMenuCapacity`) with the already-present client fallback; Waste keeps
  `wasteLog` + `logWaste`; Vendors `vendors`; Recipes `recipes` + cost getters;
  Prep `prepRecipes` + cost getters; Inventory `inventory` + `getItemStatus`.
- **Edge functions:** none touched. No `verify_jwt` / service-token changes.
- **`src/lib/db.ts` surface:** **no new helper, no signature change, no new mapper.**
  All phone components read the same already-mapped store slices the desktop panes
  read. This is a hard constraint of the spec (In scope / Out of scope both say so)
  — if a builder finds themselves adding a `db.ts` function, that is drift; stop
  and re-surface.
- **Realtime:** no publication membership change → the
  `docker restart supabase_realtime_imr-inventory` gotcha does **not** apply. The
  existing `store-{id}` / `brand-{id}` channels (`useRealtimeSync`, 400ms debounce)
  continue to drive reloads; phone components re-render off the same slices.
- **Frontend store impact (`useStore.ts`):** **no slice changes, no new actions,
  no new fields.** The only store *action* invoked from new code is the existing
  `logWaste` (Waste two-step sheet), which already carries its own
  optimistic-then-revert + `notifyBackendError` path — new code calls it unchanged,
  so the optimistic pattern is inherited, not re-implemented.

The remainder of this section is the **frontend seam design** the two builders
(chrome + sections) implement against.

### 1. Global phone chrome (AC-C1…C4)

Three edits, all gated on `useIsPhone()` (native always phone; web < 768px).

**1a. `MobileTopAppBar` → fixed 52px (AC-C1).** In
`src/components/cmd/MobileTopAppBar.tsx`, the inner row `height: 44` (line 58)
becomes `height: 52`. The hamburger touch target grows from 32×32 to **≥44×44**
(keep the current `hitSlop`, bump `width/height` to 44 and center the glyph); the
title stays `numberOfLines={1}` with `flex: 1` so trailing content can never
overlap it (AC-C1: "title never overlapped"). Title font may move to
`PhoneType.screenTitle` (sans 600 / 20) — but note this bar is shared with tablet;
keep the size bump **phone-only** via a passed prop or a `useIsPhone()` read inside
the bar so the tablet render stays byte-unchanged (AC-REG covers only the seven
sections, but do not regress tablet chrome). Simplest: add an optional
`height?: number` + `titleType?: TextStyle` prop, default to today's 44/sans-14,
and pass 52 / `PhoneType.screenTitle` from the phone branch of `ResponsiveCmdShell`.
This keeps the tablet caller (if any) untouched.

**1b. Trailing slot: bell-only, blocked-copy relocated (AC-C2).** Today
`ResponsiveCmdShell.tsx:390-395` mounts `<NotificationToggle/>` (which renders a
132px-wide multi-line pill: label + `m.body` + `m.iosSteps` + retry) directly in
the 8px-gap trailing row — this is the exact spill the handoff forbids. Fix:

- Add a `variant?: 'full' | 'bar'` prop to `NotificationToggle`
  (`src/components/cmd/NotificationToggle.tsx`). `variant="bar"` renders **only** a
  ≥44×44 bell-glyph `TouchableOpacity` (glyph `◔`, the production bell per handoff
  §257), with a small dot badge when `m.body`/`m.iosSteps`/`m.showRetry` indicate a
  blocked/needs-attention state. No `m.body` / `m.iosSteps` / retry text in bar
  mode. `variant="full"` (default) is byte-identical to today — the rail/tablet
  callers pass nothing and are unaffected.
- New component **`src/components/cmd/NotificationBlockedBanner.tsx`**: consumes the
  same `useNotificationToggle(userId, T)` hook (the hook's cross-instance re-probe
  registry, `useNotificationToggle.ts:26-38`, is explicitly designed for multiple
  concurrent instances — two mounts is safe). Renders a **dismissible row** with
  `m.body` / `m.iosSteps` / retry (`panel2` bg, hairline `border`, `PhoneType.body`
  copy, a ✕ dismiss on the right ≥44×44). Renders `null` when there is no blocked
  copy OR when dismissed.
- **Where it mounts + dismiss state:** in `ResponsiveCmdShell.tsx`, phone branch,
  as a sibling **between** `<MobileTopAppBar/>` (line 387-398) and the
  `<View style={{ flex: 1 }}>{Body}</View>` (line 399) — i.e. a full-width row
  BELOW the fixed 52px bar and ABOVE the body (AC-C2: "banner row BELOW the 52px
  bar…never on top of the title"). Dismiss state lives **inside
  `NotificationBlockedBanner`** as a local `useState(false)`, re-armed by a
  `useEffect` keyed on the blocked-message identity (a new/changed block re-shows;
  a re-render does not). This keeps `ResponsiveCmdShell` edits to two lines (bell
  variant + one banner mount) and does not thread dismiss state through the shell.

**1c. `CmdStatusBar` suppressed on phone (AC-C3).** `InventoryDesktopLayout.tsx`
renders `<CmdStatusBar height={24} .../>` unconditionally at line 603 as the footer
of the whole section-dispatch host (it wraps *every* section, not just Inventory).
Import `useIsPhone` (the file already imports `useIsDesktop` from
`../../theme/breakpoints`, line 34) and wrap: `{!isPhone && <CmdStatusBar …/>}`.
Because this footer is host-level, suppressing it once satisfies AC-C3 for **all**
sections in scope (and every other section), and removes the `⌘K palette` hint
(AC-C4 chrome). No `⌘K` keydown handler needs removal — it is a no-op affordance
on phone; only the visible hint disappears.

### 2. Shared phone drill-in scaffold (AC-D1…D5)

**Home:** new folder **`src/screens/cmd/sections/phone/`**, mirroring the spec-140
`eod/` precedent. This is the single shared scaffold generalizing the Brands
`isCompact && showDetail` early-return (`BrandsSection.tsx:225-295`) — but improved
on one axis: Brands *unmounts* its `ListPane` when showing detail (loses scroll).
AC-D4 requires **back-restores-scroll**, so the scaffold keeps the list **mounted**
and overlays the detail as an absolutely-positioned, slide-in `Animated.View`
(RN `Animated`, matching the spec-140 sheet idiom — NOT Reanimated-on-web, NOT
`@gorhom`). List scroll survives because the list is never unmounted.

**Files:**

- **`src/screens/cmd/sections/phone/usePhoneDrill.ts`** — tiny state hook:
  ```ts
  export function usePhoneDrill<T extends { id: string }>(): {
    selected: T | null;
    isDetail: boolean;        // selected !== null
    open: (item: T) => void;
    close: () => void;
  }
  ```
  Nothing is selected by default (AC-D2 / Hard Rule 7): `selected` starts `null`.

- **`src/screens/cmd/sections/phone/PhoneDrillScaffold.tsx`** — the presentational
  shell. Props:
  ```ts
  interface PhoneDrillScaffoldProps {
    list: React.ReactNode;          // the full-width FlatList/SectionList (always mounted)
    detail: React.ReactNode | null; // full-screen detail body when a row is open; null = list only
    parentCaption: string;          // mono upper caption, e.g. "INVENTORY" | "VENDORS" | "MENU"
    onBack: () => void;             // calls usePhoneDrill().close()
    testID?: string;
  }
  ```
  Renders `list` in a `flex:1` View; when `detail !== null`, mounts an
  `Animated.View` (absolute fill, `translateX` 100%→0 over **220ms ease-out**) on
  top, containing a **52px header** (44px `←` back `TouchableOpacity` +
  `parentCaption` in `PhoneType.caption` upper, hairline bottom border, `panel` bg)
  and the `detail` body in a `ScrollView`. Pressing `←` calls `onBack`; the scaffold
  animates out then the parent clears `selected`. Export the header sub-piece as
  `PhoneDetailHeader` for reuse/testing.

- **`src/screens/cmd/sections/phone/PhoneDrillScaffold.tsx`** also exports the
  standard **honest-toast helper** usage note (AC-D5): desktop-only edit actions
  (EDIT RECIPE, DELETE, LOG A BATCH where no phone form exists) call
  `Toast.show({ type: 'info', text1: <"Edit on desktop"> })` — no fake form. This is
  a call convention, not a new component (reuse `react-native-toast-message` as the
  sections already do).

**Deep-links (AC-INV4 / AC-BOM2 / AC-VEN2 / AC-MI):** the detail action buttons use
the existing `usePaletteAction` bridge (`src/lib/paletteAction.ts`) unchanged:
COUNT NOW → `request({ section: 'EODCount', selectedName: null, eodFocusItemId })`
(the spec-140 bridge field, line 16); VIEW IN ORDERING / ORDER SHORTAGES →
`request({ section: 'Ordering', selectedName: null })`. No new bridge fields.

### 3. Per-section integration (AC-REG placement)

**Pattern (consistent across all seven):** each phone component is its **own file
under `phone/` that reads the store slices directly via `useStore` hooks** — NOT
the spec-140 `model`-prop bundle. Rationale for diverging from 140: EOD had heavy
*shared* keypad/count state that had to be lifted so desktop and phone stayed in
sync; these seven are independent read-mostly views of the same slices, so a
self-contained phone file (that seeds/reads the store exactly like the AC-REG test
does) is simpler, avoids a 40-field prop bundle per section, and keeps each phone
file independently testable. The **only** behavioral fork in each parent is a guard
placed **after all existing hooks run** (rules-of-hooks safe when `isPhone` flips on
web resize) and immediately before the parent's main `return` — so the
desktop/tablet return subtree is byte-unchanged (AC-REG1).

| Parent | Guard placement | Phone file(s) | Store selectors/actions the phone file reads |
|---|---|---|---|
| `InventoryDesktopLayout.tsx` (Inventory `per-store` branch, ~line 440 fall-through) | **Inline JSX** `isPhone ? <PhoneInventoryList/> : (<existing list+DetailPane pane>)` — scoped to the `section==='Inventory' && viewMode==='per-store'` branch so out-of-scope sections (Dashboard/Ordering/etc.) are untouched | `phone/PhoneInventoryList.tsx` + `phone/PhoneInventoryDetail.tsx` | `inventory`, `getItemStatus`, `currentStore`; deep-link via `usePaletteAction` |
| `InventoryCatalogMode.tsx` | `if (isPhone) return <PhoneCatalogList .../>;` before its `return` | `phone/PhoneCatalogList.tsx` (reuses `PhoneInventoryDetail` shape) | existing catalog data source (brand-scoped), no new fields |
| `MenuImpactSection.tsx` | `if (isPhone) return <PhoneMenuImpact/>;` before `return` | `phone/PhoneMenuImpact.tsx` (detail = shared `PhoneMenuItemDetail`) | `menuCapacity` selector + client fallback (`makeable = min floor(onHand/needPerPlate)`, `limitedBy = argmin`), `recipes` |
| `RecipesSection.tsx` | `if (isPhone) return <PhoneRecipes/>;` before `return` | `phone/PhoneRecipes.tsx` + shared `phone/PhoneMenuItemDetail.tsx` | `recipes` + cost getters, `inventory`/`getItemStatus` for BOM availability |
| `PrepRecipesSection.tsx` | `if (isPhone) return <PhonePrepRecipes/>;` before `return` | `phone/PhonePrepRecipes.tsx` | `prepRecipes`, `getPrepRecipe`, `getPrepRecipeCost`, `getPrepRecipeCostPerUnit` |
| `VendorsSection.tsx` | `if (isPhone) return <PhoneVendors/>;` before `return` | `phone/PhoneVendors.tsx` | `vendors`, `inventory` (item↔SKU codes) |
| `WasteLogSection.tsx` | `if (isPhone) return <PhoneWasteLog/>;` before `return` | `phone/PhoneWasteLog.tsx` + `phone/PhoneWasteLogSheet.tsx` | `wasteLog`, `logWaste`, `inventory`, `currentStore`, `currentUser` |

Note the double-subscription cost (parent hooks still run, then it returns the phone
child which re-subscribes) is acceptable at these list sizes and is the price of a
minimal AC-REG diff. Do **not** early-return before the parent's hooks — that
violates rules-of-hooks when `isPhone` flips.

**Shared menu-item detail (AC-MI3 + AC-BOM2):** `PhoneMenuImpact` and `PhoneRecipes`
open the **same** `PhoneMenuItemDetail` — build it once in `phone/` and pass the
recipe id. This satisfies "Tapping a Menu-impact row opens the same menu-item detail
as the Menu items/BOM section."

### 4. Shared phone widgets vs per-section

New file **`src/screens/cmd/sections/phone/PhoneWidgets.tsx`** exporting the pieces
used by ≥2 sections (shared), all built on `useCmdColors()` + `PhoneType` +
`CmdRadius` + `StatusPill` — no new palette:

- **`TwoLineRow`** (SHARED — every list): line 1 = optional pill slot + name
  (`PhoneType.itemName`, `flex:1`, ellipsize only past full width) + right value
  slot (nowrap); line 2 = meta slot (`PhoneType.metaMono`) + optional tag/bar. Hard
  Rules 2/3: `flex:1` name, no letter-stacking, ≥48 tall.
- **`ChipRow`** (SHARED — Menu impact, Waste, Recipes filters): horizontally
  scrolling ≥44×44 chip row (NOT a wrapping cloud, Hard Rule 6); active = accent
  border + `accentBg`.
- **`GroupCaption`** (SHARED — Inventory, Recipes, Waste category/day groups): mono
  `PhoneType.caption` upper group header. (May thinly wrap the existing
  `SectionCaption`; keep it in `PhoneWidgets` for the phone-tier styling.)
- **`StatPanel`** (SHARED — every detail: Inventory / menu-item / prep / vendor):
  a row of stat cells (label `PhoneType.microCaption` over value
  `PhoneType.kpiValue`/`tableNum`, status-colored where relevant) + optional par/fill
  bar. Semantic status tokens only, never accent (handoff §91 / AC-INV2).

**Per-section (NOT shared)** — one-off enough to keep local to their phone file:

- **`SegmentedStatusFilter`** — Inventory-only 46px ALL/OUT/LOW/OK segmented control
  (count over micro-label, active = `panel2` fill). Only Inventory has it (AC-INV1);
  keep it in `PhoneInventoryList.tsx`.
- The **Waste two-step sheet body** (`PhoneWasteLogSheet.tsx`) — Waste-only.
- The **par bar** on the Inventory row and the **capacity/margin pills** — thin
  wrappers over `StatusPill`; local to their row files.

### 5. Reuse constraints (all satisfied — no new primitives)

- `PhoneType` (`src/theme/typography.ts:61`) — reused as-is. If a list/detail role
  is genuinely missing (e.g. a detail `name` at 22/600 for AC-INV4), **extend
  `PhoneType` additively** (append a key; the existing `Type` map and current
  `PhoneType` keys stay byte-unchanged — AC-13/AC-REG). Do not inline ad-hoc font
  sizes that duplicate a ramp role.
- `ResponsiveSheet` (`src/components/cmd/ResponsiveSheet.tsx`) with
  `presentation={{ phone: 'bottom-sheet' }}` — the Waste two-step log sheet
  (AC-WASTE2). Two internal steps (item picker → qty stepper + reason chips + cost
  preview + SAVE) are local `useState` inside `PhoneWasteLogSheet`; SAVE calls the
  existing `logWaste` and the sheet closes; the feed prepends via the store
  round-trip (no manual prepend needed — `wasteLog` re-derives). Reason chips use
  the existing `WasteReason` enum (`WasteLogSection.tsx:17`), not new strings.
- `StatusPill`, `useCmdColors()`, `CmdRadius`, `LightCmd`/`DarkCmd` — reused; no new
  palette values (both themes via `useCmdColors()`, AC-REG3).
- RN `Animated` (220ms slide-in-right for drill-in; the `ResponsiveSheet` already
  owns the 220ms slide-up for the Waste sheet). No Reanimated, no `@gorhom`.

### 6. Jest test plan (jest track only — no pgTAP, no shell smoke)

Follow the spec-140 `eod/__tests__/` naming under
**`src/screens/cmd/sections/phone/__tests__/`**. Each uses the spec-140 harness:
mock `src/lib/supabase`, inert `db.ts` Proxy, controllable `useIsPhone`/`useBreakpoint`
mock (`EODCountSection.acReg.test.tsx:52-61`), and `useStore.setState(...)` seeding.

1. **`chrome.test.tsx`** (AC-C1/C2/C3): renders the phone shell branch — asserts the
   top app bar row is 52px; `NotificationToggle variant="bar"` renders the bell but
   NOT `m.body` text; `NotificationBlockedBanner` renders the blocked copy below the
   bar (and disappears on ✕ dismiss); `CmdStatusBar` (`synced` / `⌘K palette`) is
   absent when `isPhone` true and present when false.
2. **`PhoneDrillScaffold.test.tsx`** (AC-D2/D3/D4): no detail shown by default;
   tapping a row opens a full-screen detail (list not rendered as a pane — assert no
   pane < 320px, i.e. the detail is the only visible header); the 52px header + 44px
   ← + mono parent caption render; pressing ← returns to the list; scroll position
   is preserved (assert the list View is the same instance / not remounted — a
   render-count or key-stability assertion).
3. **Per-section `*.acReg.test.tsx`** (AC-REG1) — one per touched section
   (`InventoryDesktopLayout`, `InventoryCatalogMode`, `MenuImpactSection`,
   `RecipesSection`, `PrepRecipesSection`, `VendorsSection`, `WasteLogSection`):
   with `isPhone=false` at a **desktop** width AND a **tablet** width, assert a
   desktop-only marker (e.g. a `TabStrip`/`DetailPane`/table header) is present and
   the phone component testID is absent; with `isPhone=true`, assert the phone
   component testID is present and the desktop marker is gone. Mirrors
   `EODCountSection.acReg.test.tsx`.
4. **`PhoneInventoryList.test.tsx`** (AC-INV1/2/3): segmented filter counts equal the
   ALL/OUT/LOW/OK partition of a seeded set; a two-line row renders a `StatusPill`
   with a semantic (out/low/ok) token and NOT `C.accent`; at 143 seeded items the
   list is a `FlatList` (virtualized — assert not all 143 row testIDs render eagerly)
   with no selected-by-default row.
5. **`PhoneMenuImpact.test.tsx`** (AC-MI1/2): rows sorted by capacity ascending
   (most-impacted first); the client-fallback formula
   `makeable = min floor(onHand/needPerPlate)`, `limitedBy = argmin` matches a hand
   computed fixture when the `menuCapacity` slice is absent.
6. **`PhoneWasteLog.test.tsx`** (AC-WASTE2): two-step sheet advances picker→stepper;
   SAVE calls the seeded `logWaste` spy with the chosen item/qty/reason; the feed
   reflects the prepended event.
7. **`honestToast.test.tsx`** (AC-D5): a desktop-only edit action (EDIT RECIPE /
   DELETE) fires `Toast.show` with the honest copy and calls no store mutator.

No test asserts DB/RPC/edge behavior (none changed).

### 7. Risks and tradeoffs

- **AC-REG is the primary risk.** Seven parents get a guard line; the desktop/tablet
  subtree must be byte-identical. The `*.acReg.test.tsx` desktop+tablet pins per
  section are the guardrail. Reviewers should diff each parent to confirm the only
  change is the guard + import.
- **Rules-of-hooks on web resize.** `isPhone` flips live on web. The guard MUST sit
  after all parent hooks (Inventory uses an inline JSX conditional inside render, not
  an early return — also safe). A guard placed above a `useMemo` would crash on
  resize. Called out explicitly for the builder.
- **Double store subscription** (parent hooks run, then phone child re-subscribes).
  Acceptable at these list sizes; the alternative (model-prop lift like spec 140)
  costs a 40-field bundle per section for no shared-state benefit. Documented choice.
- **`NotificationToggle` two-instance mount** (bell in bar + banner below). Safe by
  design — `useNotificationToggle`'s re-probe registry (`useNotificationToggle.ts`)
  exists precisely to keep multiple instances coherent; verify both reflect the same
  push state after an enable/disable in the chrome test.
- **`MobileTopAppBar` is shared with tablet.** The 52px/large-title change must be
  phone-gated (prop-driven) so tablet chrome does not regress — AC-REG only formally
  covers the seven sections, but a tablet chrome regression would still be a defect.
- **Perf on the 286 KB seed / 143 items.** `FlatList` virtualization (AC-INV3) is
  mandatory; a `.map()` over 143 rows on a phone is the exact defect the handoff
  called out. No cold-start / edge concern (no edge functions touched).
- **`PhoneType` additive extensions** must append only — a mutation of an existing
  ramp key would silently shift the spec-140 EOD surface. Enforce in review.

## Handoff
next_agent: frontend-developer
prompt: Implement against the design in this spec. It is frontend-only — no
  backend, migration, RLS, edge-function, realtime, or src/lib/db.ts contract
  changes (confirmed in ## Backend design §0). Build the three global chrome
  fixes in ResponsiveCmdShell / MobileTopAppBar / NotificationToggle /
  InventoryDesktopLayout (§1), the ONE shared drill-in scaffold under
  src/screens/cmd/sections/phone/ (§2, PhoneDrillScaffold + usePhoneDrill,
  list-stays-mounted so back restores scroll), the seven per-section isPhone
  guards keeping every desktop/tablet subtree byte-unchanged (§3 table), the
  shared PhoneWidgets vs per-section pieces (§4), reusing PhoneType /
  ResponsiveSheet / StatusPill / useCmdColors / CmdRadius only (§5), and the
  jest tests in §6. After implementation, set Status: READY_FOR_REVIEW and list
  files changed under ## Files changed.
payload_paths:
  - specs/142-phone-list-detail-sections.md

## Handoff (superseded — original PM handoff)
next_agent: backend-architect
prompt: Design the contract for this spec. It is frontend-only (no backend,
  migrations, edge functions, or db.ts contract changes) — focus the design on
  the frontend seams: the global chrome fixes in ResponsiveCmdShell
  (52px MobileTopAppBar + banner-below-bar for NotificationToggle blocked-copy +
  CmdStatusBar phone suppression), the ONE shared phone drill-in scaffold
  generalized from BrandsSection.tsx:225 (list → full-screen detail, 52px header
  / 44px ← / mono parent caption / 220ms slide-in / back-restores-scroll), and
  the per-section isPhone early-return placement for InventoryDesktopLayout,
  InventoryCatalogMode, MenuImpactSection, RecipesSection, PrepRecipesSection,
  VendorsSection, WasteLogSection — each keeping its desktop/tablet return subtree
  byte-unchanged (AC-REG). Confirm PhoneType/ResponsiveSheet reuse, name the new
  file structure, and lay out the jest test plan. Set Status: READY_FOR_BUILD.
payload_paths:
  - specs/142-phone-list-detail-sections.md

## Files changed

Implemented in three sequenced build chunks (a = global chrome + shared scaffold
+ widgets; b = Inventory; c = the five remaining sections). Desktop/tablet
subtrees of every touched section are byte-unchanged behind `isPhone` guards
(AC-REG).

### New — shared scaffold / widgets / chrome (chunk a)
- src/components/cmd/NotificationBlockedBanner.tsx
- src/screens/cmd/sections/phone/usePhoneDrill.ts
- src/screens/cmd/sections/phone/PhoneDrillScaffold.tsx
- src/screens/cmd/sections/phone/PhoneWidgets.tsx
- src/screens/cmd/sections/phone/__tests__/chrome.test.tsx
- src/screens/cmd/sections/phone/__tests__/PhoneDrillScaffold.test.tsx

### New — Inventory (chunk b)
- src/screens/cmd/sections/phone/PhoneInventoryList.tsx
- src/screens/cmd/sections/phone/PhoneInventoryDetail.tsx
- src/screens/cmd/sections/phone/PhoneCatalogList.tsx
- src/screens/cmd/sections/phone/__tests__/PhoneInventoryList.test.tsx
- src/screens/cmd/sections/phone/__tests__/PhoneInventory.acReg.test.tsx

### New — Menu impact / Menu items / Prep / Vendors / Waste (chunk c)
- src/screens/cmd/sections/phone/menuCapacityFallback.ts
- src/screens/cmd/sections/phone/PhoneMenuItemDetail.tsx
- src/screens/cmd/sections/phone/PhoneMenuImpactList.tsx
- src/screens/cmd/sections/phone/PhoneMenuItemsList.tsx
- src/screens/cmd/sections/phone/PhonePrepRecipesList.tsx
- src/screens/cmd/sections/phone/PhoneVendorsList.tsx
- src/screens/cmd/sections/phone/PhoneWasteLog.tsx
- src/screens/cmd/sections/phone/PhoneWasteLogSheet.tsx
- src/screens/cmd/sections/phone/__tests__/PhoneMenuImpact.test.tsx
- src/screens/cmd/sections/phone/__tests__/PhoneWasteLog.test.tsx
- src/screens/cmd/sections/phone/__tests__/honestToast.test.tsx
- src/screens/cmd/sections/phone/__tests__/PhoneSections.acReg.test.tsx

### New — review-round coverage (AC-INV4 / BOM1 / PREP1-2 / VEN1-2 gaps)
- src/screens/cmd/sections/phone/__tests__/PhoneInventoryDetail.test.tsx
- src/screens/cmd/sections/phone/__tests__/PhoneMenuItems.test.tsx
- src/screens/cmd/sections/phone/__tests__/PhonePrepRecipes.test.tsx
- src/screens/cmd/sections/phone/__tests__/PhoneVendors.test.tsx

### Review-round refactors (code-reviewer findings)
- src/screens/cmd/InventoryDesktopLayout.tsx        (Critical: phone catalog reachability — `viewMode==='catalog'` routes to InventoryCatalogMode → PhoneCatalogList)
- src/screens/cmd/sections/phone/PhoneWidgets.tsx    (Should-fix: shared PropertyCard, deduped from 3 copies)
- src/screens/cmd/sections/phone/PhoneInventoryDetail.tsx / PhoneCatalogList.tsx / PhoneVendorsList.tsx  (use shared PropertyCard)
- src/screens/cmd/sections/phone/PhoneMenuItemDetail.tsx  (Should-fix: reuse recipeRawLines() for the on-hand conversion)
- src/screens/cmd/sections/phone/PhoneInventoryList.tsx    (Should-fix: removed dead `vendors` subscription)
- src/screens/cmd/sections/phone/PhoneCatalogList.tsx      (Should-fix: removed dead `ingredientCategories` subscription)
- src/screens/cmd/sections/phone/PhoneWasteLogSheet.tsx    (nit: spec-104 per-each rationale comment)
- src/screens/cmd/sections/phone/{PhoneMenuImpactList,PhoneMenuItemsList,PhonePrepRecipesList,PhoneVendorsList,PhoneWasteLog}.tsx  (nit: uniform removeClippedSubviews)
- src/screens/cmd/sections/phone/__tests__/{PhoneInventory.acReg,PhoneMenuImpact,PhoneWasteLog}.test.tsx  (extended: catalog reachability, chip/KPI, chip-filter)

### Browser-repro follow-up — catalog reachability across the tier-change remount
- src/screens/cmd/lib/inventoryViewMode.ts  (NEW — module-level Inventory viewMode memory; survives the ResponsiveCmdShell tier-change remount so catalog-on-phone stays reachable on resize, AC-INV5)
- src/screens/cmd/InventoryDesktopLayout.tsx  (seed viewMode from the memory + mirror it in the setter; desktop/tablet output unchanged)
- src/screens/cmd/sections/phone/__tests__/PhoneInventory.acReg.test.tsx  (honest remount test: unmount desktop → fresh phone mount; fails without the memory, passes with it)
- src/screens/cmd/__tests__/InventoryDesktopLayout.test.tsx  (reset the viewMode memory in beforeEach so case 8's catalog.tsv press doesn't leak into cases 9/10)

### Modified — global chrome (chunk a; icon-only trailing glyphs added in browser-pass polish)
- src/components/cmd/MobileTopAppBar.tsx        (optional height/titleType props; 44×44 hamburger at 52px)
- src/components/cmd/NotificationToggle.tsx     (variant='bar' bell-only mode)
- src/components/cmd/ThemeToggle.tsx            (variant='bar' icon-only ◐, 44×44 — phone bar only)
- src/components/cmd/RefreshButton.tsx          (variant='bar' icon-only ↻, 44×44 — phone bar only)
- src/screens/cmd/ResponsiveCmdShell.tsx        (52px bar + icon-only bell/theme/refresh variants + banner-below-bar + display-label bar title)
- src/screens/cmd/InventoryDesktopLayout.tsx    (CmdStatusBar phone suppression; chunk b: Inventory phone guard + import)
- src/theme/typography.ts                       (chunk b: additive PhoneType.detailTitle / heroValue)

### Modified — host section guards (chunks b + c)
- src/screens/cmd/sections/InventoryCatalogMode.tsx   (chunk b: isPhone guard → PhoneCatalogList)
- src/screens/cmd/sections/MenuImpactSection.tsx      (chunk c: isPhone guard → PhoneMenuImpactList)
- src/screens/cmd/sections/RecipesSection.tsx         (chunk c: isPhone guard → PhoneMenuItemsList)
- src/screens/cmd/sections/PrepRecipesSection.tsx     (chunk c: isPhone guard → PhonePrepRecipesList)
- src/screens/cmd/sections/VendorsSection.tsx         (chunk c: isPhone guard → PhoneVendorsList)
- src/screens/cmd/sections/WasteLogSection.tsx        (chunk c: isPhone guard → PhoneWasteLog)

### Modified — i18n (chunks b + c; all three catalogs, parity kept)
- src/i18n/en.json / es.json / zh-CN.json   (section.inventory.editOnDesktop; common.editOnDesktop; common.availableOnDesktop)

### Modified — existing tests (harness updates for the new isPhone fork)
- src/screens/cmd/__tests__/InventoryDesktopLayout.test.tsx           (added useIsPhone:()=>false to breakpoints mock)
- src/screens/cmd/sections/__tests__/InventoryCatalogMode.test.tsx    (added useIsPhone:()=>false)
- src/screens/cmd/sections/__tests__/InventoryCatalogMode.spec122.test.tsx (added useIsPhone:()=>false)
- src/screens/cmd/sections/__tests__/MenuImpactSection.test.tsx       (added useIsPhone:()=>false)
- src/screens/cmd/sections/__tests__/VendorsSection.test.tsx          (added useIsPhone:()=>false)
