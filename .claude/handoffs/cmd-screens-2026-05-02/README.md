# Handoff — C · Command direction (desktop + mobile)

## Overview

This bundle is a complete spec for the **C · Command** direction of the inventory-management UI: an IDE-flavored, monospace-leaning, density-first interface for ops and warehouse pros. It covers:

- **Desktop** (1280 × 820) — three-pane: tree-nav sidebar with command palette, filterable item list, rich detail view (stat grid, 14-day stock chart vs. par, `properties.json`, recipe usage, activity log, status bar)
- **Mobile** (iPhone 402 × 874) — three screens that reflow the three desktop panes into a stack: Inventory list, Item detail, Tree-nav drawer + ⌘K palette
- **Two roles** on mobile: `admin` (full access) and `staff` (restricted — no costs, no audit, no vendors, no reports)
- **Two themes** on every surface: Light + Dark

The visual personality is deliberate: monospace for every numeral / ID / timestamp, sharp 5–6px radii, mint-green accent (`oklch(0.50 0.16 145)` light · `oklch(0.78 0.16 145)` dark), terminal-style breadcrumb (`inv://towson — inventory — atlantic-salmon`), kbd-hint pills, status bar. It rewards keyboard mastery and feels like a code editor.

## About the design files

The HTML files in this folder are **design references** — interactive prototypes built with React + inline JSX for visual fidelity. They are **not production code to copy directly**.

The implementation target is the existing app in `INVENTORY-MANAGEMENT/` — Expo SDK 54, React Native 0.81, TypeScript, Zustand, Supabase, deployed to iOS / Android / Vercel-hosted web. Recreate the design in that codebase using its existing patterns (Zustand store, `react-navigation`, `react-native-svg` for charts, `expo-font` for type loading). All Supabase wiring, realtime sync, auth, and store action signatures stay exactly as they are — only layout, typography, color, and component composition change.

If you are starting in a fresh codebase, React Native + Expo (with `react-native-web` for web parity) is the right choice. All examples below assume RN; web-only features (`⌘K` palette, breadcrumb path) gate behind `Platform.OS === 'web'`.

## Fidelity

**High-fidelity.** Every color, font size, line-height, padding, border, radius, and animation in this document is final. Pixel-match the prototypes.

## How to view the prototypes

```
open "Command Desktop.html"   # desktop, 1280×820, light + dark
open "Command Mobile.html"    # iPhone 402×874, 3 screens × 2 roles × 2 themes
```

Each file opens a pan/zoom design canvas. Click any artboard's expand icon for a fullscreen view; ←/→/Esc to navigate. The Tweaks panel (toolbar toggle) flips Light / Dark / Both.

---

## Design tokens

All tokens below should land in a single theme module — `src/theme/colors.ts` and `src/theme/typography.ts` — keyed by a `darkMode` boolean already in the Zustand store.

### Type

| Family | Stack | Usage |
|---|---|---|
| Sans | `"Inter Tight", "Inter", -apple-system, system-ui, sans-serif` | All UI labels, headings, body text |
| Mono | `"JetBrains Mono", "SF Mono", ui-monospace, monospace` | Every numeric value, ID, timestamp, code-style label, kbd hint, breadcrumb, filter input, tab name (`detail.tsx`), section caption (`STOCK_HISTORY.DAT`), status bar text |

Load both via `expo-font` + `@expo-google-fonts/inter-tight` + `@expo-google-fonts/jetbrains-mono` — weights 400 / 500 / 600 / 700.

Every numeric value MUST set `fontVariant: ['tabular-nums']` (RN supports this directly).

#### Type ramp

| Token | Family | Size | Weight | Letter-spacing | Use |
|---|---|---|---|---|---|
| `display` | sans | 26 | 700 | -0.4 | Item-detail H1 (desktop & mobile) |
| `h1` | sans | 24 | 700 | -0.4 | Screen titles ("Inventory", "Count queue") |
| `h2` | sans | 14 | 700 | -0.1 | List-pane title, drawer header |
| `body` | sans | 13 | 400 | 0 | Default body |
| `bodySm` | sans | 12 | 400 | 0 | Detail metadata, secondary text |
| `kpiValue` | mono | 20 (desktop) / 18 (mobile) | 600 | -0.3 | Stat-grid values |
| `kpiLabel` | mono | 9.5 (desktop) / 9 (mobile) | 600 (uppercase) | 0.5 | Stat-grid labels, section captions |
| `tableNum` | mono | 11–13 | 400–500 | 0 | Inline numbers (qty/par, costs, dates) |
| `caption` | mono | 10–10.5 | 600 (uppercase) | 0.6 | Card titles like `STOCK_HISTORY.DAT — 14D` |
| `kbd` | mono | 9.5–10 | 500 | 0 | Keyboard hints in pills |
| `tab` | mono | 12 | 500 | 0 | Tab labels (`detail.tsx`) |
| `breadcrumb` | mono | 11 | 400 | 0 | Title-bar path |
| `statusBar` | mono | 10 | 400 | 0 | Bottom status bar |

### Colors — Command palette (single source of truth)

```ts
export const Light = {
  bg:          '#FAFAF8',
  panel:       '#FFFFFF',         // sidebar, list pane, cards
  panel2:      '#F4F4F0',         // input bg, filter chip bg, hover
  border:      'rgba(20,20,20,0.07)',
  borderStrong:'rgba(20,20,20,0.14)',
  fg:          '#0E1014',
  fg2:         '#5A5F68',
  fg3:         '#9094A0',
  accent:      'oklch(0.50 0.16 145)',
  accentBg:    'oklch(0.93 0.06 145 / 1)',
  ok:          '#3B6D11',
  okBg:        '#EAF3DE',
  warn:        '#854F0B',
  warnBg:      '#FAEEDA',
  danger:      '#791F1F',
  dangerBg:    '#FCEBEB',
  info:        '#185FA5',
  infoBg:      '#E6F1FB',
};

export const Dark = {
  bg:          '#08090C',
  panel:       '#0E1014',
  panel2:      '#181B22',
  border:      'rgba(255,255,255,0.06)',
  borderStrong:'rgba(255,255,255,0.12)',
  fg:          '#E6E8EC',
  fg2:         '#9BA0AB',
  fg3:         '#5C6270',
  accent:      'oklch(0.78 0.16 145)',
  accentBg:    'oklch(0.30 0.08 145 / 0.4)',
  ok:          '#5CB832',
  okBg:        'rgba(92,184,50,0.15)',
  warn:        '#E0A030',
  warnBg:      'rgba(224,160,48,0.15)',
  danger:      '#E04848',
  dangerBg:    'rgba(224,72,72,0.15)',
  info:        '#5AA8F0',
  infoBg:      'rgba(90,168,240,0.15)',
};
```

> **OKLCH note:** RN doesn't accept `oklch()` directly. Convert at build-time with a tiny helper (or precompute):
> - `Light.accent`   → `#3F7C20`
> - `Light.accentBg` → `#E0EFC9`
> - `Dark.accent`    → `#7DD668`
> - `Dark.accentBg`  → `rgba(58,130,40,0.40)`
> Pixel-match those hex values; the mints came from oklch only because the prototype is HTML.

### Spacing scale (px)

`2 · 4 · 6 · 8 · 10 · 12 · 14 · 16 · 18 · 20 · 22 · 24 · 28 · 32`

Most surfaces use `12 / 14 / 16` as the dominant rhythm. The status bar uses `8` vertically. Stat-grid gap = `10` (desktop) / `8` (mobile). Card inner padding = `12`–`14`.

### Radii (px)

| Token | Value | Use |
|---|---|---|
| `xs` | 3 | Status pills, kbd hints, version pills |
| `sm` | 4 | Title-bar buttons, small inputs |
| `md` | 5 | Filter input, tree-nav left-rail items |
| `lg` | 6 | Cards (stat tiles, chart, properties, activity) |

No surface in this design uses radius > 6. Sharpness is part of the personality — do NOT round to 8/10/14.

### Borders & shadows

- Borders are 1px and use the `border` / `borderStrong` tokens above. Never full-strength black/white.
- The Command direction uses **no shadows**. Layered separation comes from `border` + `panel` background steps. Do not add elevation.

### Status conventions

| Status | Meaning | Color (light / dark fg / bg) |
|---|---|---|
| `ok`     | stock ≥ par   | `#3B6D11` / `#5CB832`  on `#EAF3DE` / `rgba(92,184,50,.15)` |
| `low`    | stock < par   | `#854F0B` / `#E0A030`  on `#FAEEDA` / `rgba(224,160,48,.15)` |
| `out`    | stock = 0     | `#791F1F` / `#E04848`  on `#FCEBEB` / `rgba(224,72,72,.15)` |
| `info`   | neutral note  | `#185FA5` / `#5AA8F0`  on `#E6F1FB` / `rgba(90,168,240,.15)` |

Status pills are always rendered in mono, ALL CAPS, weight 700, with letter-spacing 0.5, padding `2px 7px`, radius 3.

Always pair the color cue with text or an icon (e.g., a 6px round status dot beside the row label) for accessibility.

---

## Desktop layout (1280 × 820)

### Topology

```
┌── Title bar ── 32px ───────────────────────────────────────────────────┐
│ ●●●   inv://towson — inventory — atlantic-salmon          ● connected │
├── Sidebar (240px) ──┬── List (340px) ──┬── Detail (flex) ──────────────┤
│                     │                  │                                │
│ [im.cmd] [v2.4]     │ Inventory  12 it │ Tabs: detail.tsx usage.tsx … │
│ ⌘P Go to anything…  │ filter:status:lo │                              │
│ ▾ OPERATIONS        │ ● Beef tenderloin│ i03  LOW                     │
│   Dashboard         │ ● Atlantic salmon│ Atlantic salmon              │
│   Inventory ←sel    │   ↑ selected     │ Seafood · Samuels · 1h ago   │
│   EOD count         │ ● Heirloom tomato│                              │
│   Waste log         │ ...              │ ┌──┬──┬──┬──┐ stat grid      │
│ ▾ PLANNING ...      │                  │ │ON│CO│ST│DA│                │
│ ▾ INSIGHTS ...      │                  │ └──┴──┴──┴──┘                │
│                     │                  │ ┌─ stock_history.dat ──┐     │
│                     │                  │ │ chart + par dashed   │     │
│                     │                  │ └──────────────────────┘     │
│                     │                  │ ┌─ properties.json ──┐       │
│                     │                  │ ┌─ used in 4 recipes  ┐       │
│                     │                  │ └─ activity_log ──────┘       │
├──────────────────── Status bar 24px ──────────────────────────────────┤
│ ● synced  row 3/142  cat:seafood              UTF-8 LF  ⌘K palette   │
└────────────────────────────────────────────────────────────────────────┘
```

### Title bar (32 px)

- Background `panel`, `border-bottom: 1px solid border`
- Padding `0 12`
- Left: three macOS traffic lights (11×11px, gap 6) — `#FF5F57`, `#FEBC2E`, `#28C840`. **Cosmetic only — do not wire to window controls.**
- Center: breadcrumb in `breadcrumb` type token, color `fg3`, format `inv://<store> — <section> — <slug>`
- Right: connection indicator — 6px `ok` dot + word `connected` in `kbd` mono, color `fg3`

### Sidebar (240 px)

- Background `panel`, right border `border`
- **Header** (12/14 padding): 22px square accent tile (radius 5, mono `i` glyph in black), `im.cmd` label (sans 13/600), version pill (mono 9.5 in pill: 1px border, padding 2/6, radius 3)
- **Command bar** (10px below header): full-width pill, `panel2` bg, `border`, radius 5, padding 5/9. `⌘P` mono 10 + `Go to anything…` sans 11. Wires to ⌘P / ⌘K (web) — opens Command Palette modal.
- **Tree** (6/0 padding):
  - Group label: mono 9.5/600 caps, color `fg3`, letter-spacing 0.6, prefixed by `▾` chevron
  - Group items: 4/14/4/26 padding, sans 12.5
    - Default: color `fg2`, transparent left-border
    - Selected: bg `accentBg`, color `fg`, **3px solid `accent` left border**
- **Footer** (8/14): `border-top: border`, mono 10, `● admin` left, EOD progress `18/24` right

#### Tree IA — admin

```
▾ OPERATIONS
  Dashboard · Inventory · EOD count · Waste log · Receiving
▾ PLANNING
  Purchase orders · Vendors · Recipes · Restock
▾ INSIGHTS
  Reconciliation · POS imports · Audit log · Reports
```

### List pane (340 px)

- Background `panel`, right border `border`
- **Header** (14/16/10 padding, `border-bottom`):
  - Title (sans 14/700, letter-spacing -0.1) + count (mono 10, `fg3`)
  - Filter input row: `panel2` bg, `border`, radius 5, padding 5/9. `filter:` (mono 11, `fg3`) + structured query input (mono 11, `fg`). Placeholder: `status:low cat:produce`.
- **Rows** (10/16, `border-bottom`):
  - Top row: 6px status dot · name (sans 13/600) · ID `i03` (mono 10, `fg3`)
  - Bottom row: `12.4/18 lb` (mono, tabular-nums) · 3px par-bar (status-color fill on `panel2` track, radius 99) · category (mono 10, `fg3`)
  - Selected: `accentBg` bg, **2px solid `accent` left border**

### Detail pane (flex)

- Background `bg`
- **Tab bar** (36px, `panel` bg, `border-bottom`):
  - Tabs `detail.tsx`, `usage.tsx`, `audit.tsx`, `recipes.tsx` — mono 12/500, padding 8/14
  - Active tab: color `fg`, **2px solid `accent` underline**
  - Inactive: color `fg2`
  - Right side: `EDIT` (ghost 4/10, mono 10.5, 1px border) + `+ COUNT` (filled accent, black text, weight 700, mono 10.5)
- **Body** (18/22 padding):
  - **Hero** (margin-bottom 18): item ID (mono 11, `fg3`) + status pill · `<h1>` display 26 · meta line `Seafood · supplied by Samuels · last counted 1h ago` (sans 13, `fg2`)
  - **Stat grid** — 4 columns, gap 10, each card: `panel` bg, `border` 1px, radius 6, padding 12/14
    - Label (mono 9.5 caps, `fg3`)
    - Value (mono 20/600 tabular)
    - Subtext (mono 10, `fg3`)
    - Cards: `On hand · Cost / unit · Stock value · Days of cover`
  - **Two-column row** (gap 14):
    - **Stock history** (1.4fr): card with caption `STOCK_HISTORY.DAT — 14D` and meta `par=12 · safety=4`. SVG inline: 4 horizontal grid lines (`stroke=border`, `dasharray="2 4"`), dashed par line (`stroke=warn`, `dasharray="3 3"`), filled area `accent` at 15% opacity, polyline `accent` 2px, dots `r=1.8` except final `r=3.5`. Legend below in mono 10.5: `■ on-hand · — par level · ↘ 62% in 14d`
    - **Properties** (1fr): card with caption `PROPERTIES.JSON`. Mono 11.5/1.7 line-height. Each row: key in `fg3`, value in `fg`, separated by 1px dashed `border`. Keys: `category, unit, vendor, cost_per_unit, par_level, avg_daily_usage, safety_stock, lead_time_days, last_counted`.
  - **Recipes & activity row** (gap 14, margin-top 14):
    - **Recipes used in**: card with `USED IN 4 RECIPES` caption. Rows: name (sans 12.5/500) + portion (mono 11, `fg2`) + sold/wk (mono 11, `fg`, 60px right-aligned)
    - **Activity log**: card with `ACTIVITY_LOG`. Rows: timestamp (mono 10, `fg3`, 32px) + 18×18 round avatar (`accentBg` bg, `accent` text, mono 9/700, 2-letter initials) + `<who> <action>` (sans 12)

### Status bar (24 px)

- `panel` bg, `border-top`, padding `0 14`, mono 10, color `fg3`
- Left: `● synced  row 3 / 142  cat:seafood`
- Right: `UTF-8  LF  ⌘K palette` (the `⌘K palette` text uses `accent` color)

---

## Mobile layout (iPhone 402 × 874)

The desktop's three panes become three full-screen views, navigable via stack push/pop:

1. **Tree-nav drawer** (corresponds to desktop sidebar) — slide-in from left
2. **Inventory list** (corresponds to desktop middle pane) — entry screen after auth
3. **Item detail** (corresponds to desktop detail pane) — pushed on row tap

Status bar inset: every screen starts content at `paddingTop: 54` to clear the iOS dynamic island. Bottom status bar adds `paddingBottom: 28` to clear the home indicator.

### Mobile · Inventory list

- **Header** (`panel` bg, padding `54 / 16 / 10`, `border-bottom`):
  - Top row: `☰` menu icon (18px, `fg2`) · breadcrumb `inv://towson — inventory` (mono 11, `fg3`, ellipsis on overflow) · **role badge** (see below)
  - Title row: `<h1>` 24/700 · count `12 items` (mono 11, `fg3`)
  - Filter input: same as desktop, with `⌘K` mono pill on the right
  - **Filter chips** (margin-top 10, horizontal scroll): pill format `<key> <count>` — first chip selected with `accent` border + `accentBg` bg
- **List rows** (12/16, `border-bottom`): identical to desktop list pane but full-width — name 14, ID mono 10, qty/par mono with tabular-nums, par-bar 3px height, category right-aligned (54px reserved)
- **Bottom status bar** (`panel` bg, padding `8 / 12 / 28`, `border-top`): `● synced  12 / 142` left · `+ COUNT` (`accent`, weight 600) right

### Mobile · Item detail

- **Header** (`panel` bg, padding `54 / 14 / 8`):
  - `‹ inventory` back link (mono 13, `accent`, weight 600)
  - Centered file label `i03.tsx` (mono 10.5, `fg3`)
  - Right: role badge OR `⋯` (mono 13, `accent`)
- **Tab strip** (`panel` bg, `border-bottom`): tabs flex-1, mono 10.5, active gets 2px `accent` underline
- **Body** (padding 14):
  - Hero: ID + status pill · `<h1>` 24/700 · meta line (sans 12, `fg2`)
  - **Action row** (gap 8): `+ COUNT` (filled accent, flex 1) · `EDIT` (ghost, flex 1) · `⌥` overflow (46px square ghost) — all mono 11/700, padding 10/0, radius 5
  - **Stat grid 2×2** (gap 8): same card style as desktop but compressed — value mono 18 (down from 20), label mono 9, subtext mono 9.5
  - **Stock history card** (margin-top 12): same SVG as desktop, scaled to 340w × 100h (down from 520×140), 3 grid lines instead of 5
  - **Properties card** (margin-top 12): mono 11/1.7, same row style
  - **Activity log card** (margin-top 12): same as desktop, slice to 3 entries

### Mobile · Tree-nav drawer + ⌘K palette

- **Header** (`panel` bg, padding `54 / 16 / 12`, `border-bottom`):
  - 26×26 accent tile + app name `im.cmd` (sans 14/700) + sub-line `admin@towson · v2.4` (mono 10, `fg3`)
  - Right: role badge OR close `✕`
  - Below: ⌘P palette field — `panel2` bg, `borderStrong`, radius 6, padding 9/12. `⌘P` (mono 11, `fg3`) + query text (mono 12, `fg`) with blinking caret + `esc` kbd pill
- **Palette results section** (`accentBg` bg, padding 10/16, `border-bottom`):
  - Label `MATCHES` (mono 9.5 caps, `fg3`) + scope hint on staff
  - Result rows: type tag (mono 9.5/700, 50px, caps) · name (sans 13/500) · meta (mono 10, status color) · ID (mono 10, `fg3`, 30px right)
- **Tree** (padding 8/0/12):
  - Group label: 4/16/6 padding, mono 9.5/600 caps, `▾` chevron, color `fg3`
  - Group items: 9/16/9/32 padding, sans 14, with kbd hint pill `⌘I` etc. on the right
  - Selected: `accentBg` bg, **3px solid `accent` left border**, weight 600
- **Footer** (`panel` bg, padding `10 / 16 / 28`, `border-top`): `● admin@towson` (mono 10.5, `fg3`) + `EOD 18/24` right

---

## Role permissions (admin vs staff)

The same three mobile screens render differently based on `currentUser.role`. Use a single `role` prop / `useRole()` hook; do not duplicate components.

| Surface | Admin | Staff |
|---|---|---|
| **Header role badge** | `◆ admin` filled (`accent` text on `accentBg`, 1px `accent` border) | `○ staff` ghost (`fg2` text on `panel2`, 1px `border`) |
| **List screen title** | "Inventory" / `142 items` | "Count queue" / `12 to do` |
| **List filter chips** | `all · ok · low · out · protein · produce` | `to count · low · out · my zone` |
| **List filter query** | `status:low cat:produce` | `zone:line assigned:maria.g` |
| **Bottom status bar count** | `12 / 142` | `12 / 12` |
| **Detail tab strip** | `detail.tsx · usage.tsx · audit.tsx · recipes.tsx` (4 tabs) | `detail.tsx · count.tsx · recipes.tsx` (3 tabs — no audit) |
| **Detail meta line** | `Seafood · Samuels · 1h ago` (vendor visible) | `Seafood · walk-in 1 · 1h ago` (storage location instead) |
| **Detail action buttons** | `+ COUNT` · `EDIT` · `⌥` overflow | `+ COUNT` · `FLAG ISSUE` (no EDIT, no overflow) |
| **Detail stat grid** | `On hand · Cost / unit · Stock value · Days cover` | `On hand · Last count · Variance · Days cover` (no $) |
| **Stock chart** | 14-day window, ↘ 62% callout | 7-day window, ↘ 31% callout |
| **Properties** | `category, unit, vendor, cost_per_unit, par_level, avg_daily_usage, lead_time_days` | `category, unit, par_level, storage, count_freq, allergens` + `2 fields hidden` chip + a single greyed `cost_per_unit — admin only` row at the bottom |
| **Activity log card title** | `activity_log` (full feed) | `your_activity` (filtered to current user) + footer note `· full audit log restricted to admins ·` |
| **Tree IA** | Operations / Planning / Insights | Tasks / Reference + a locked **Admin-only** section showing `Vendors`, `Reports`, `Audit log`, `Reconciliation` strikethrough with `restricted` tag at 42% opacity |
| **Palette scope** | items, recipes, vendors, audit, screens | items, recipes only (`scope: items, recipes` hint visible) |
| **Footer status** | `EOD 18/24` | `your shift · 18:42` (`accent` color) |

### Server-side enforcement

UI hiding is **not** access control. Every restricted field must also be enforced at the data layer:

- Supabase RLS policies must reject staff reads of `cost_per_unit`, `vendor_id`, `purchase_orders`, `audit_log`
- Existing `useStore` selectors must return `null` / `undefined` for restricted fields when `currentUser.role !== 'admin'`
- The UI then either hides the row or renders the `— admin only` placeholder shown above

Treat the role prop as a presentation hint that mirrors backend truth, not as the gate.

---

## Components to build

A flat checklist mapping each design element to the component that should land in `src/components/` (or wherever your shared primitives live). Reuse existing primitives where they exist.

### Atoms

- [ ] **`StatusDot`** — 6px / 7px round, color via `status` prop (`ok | low | out | info`)
- [ ] **`StatusPill`** — mono 10/700 caps, padding 2/7, radius 3, fg + bg via status
- [ ] **`KbdHint`** — mono 9.5–11, padding 1/5, 1px border, radius 3
- [ ] **`RoleBadge`** — admin/staff variants, mono 9.5/700 caps, see above
- [ ] **`ParBar`** — track 3px / radius 99 on `panel2`, fill via status color, ratio = `min(stock/par, 1)`
- [ ] **`AccentTile`** — square (22 / 26 / 32), radius 5, `accent` bg, mono center glyph
- [ ] **`Avatar`** — 18×18 round, `accentBg` bg, `accent` text, mono 9/700 initials
- [ ] **`SectionCaption`** — mono 9.5–10.5/600 caps, letter-spacing 0.6, color `fg2`/`fg3`

### Molecules

- [ ] **`StatCard`** — caption + value + subtext, used in 4-up desktop and 2×2 mobile detail grids. Props: `{ label, value, sub }`
- [ ] **`FilterInput`** — `panel2` bg, `border`, radius 5, prefix `filter:`, suffix `⌘K` kbd hint
- [ ] **`FilterChip`** — pill, padding 4/9, mono 10.5/600, `accentBg` + `accent` border when selected
- [ ] **`InventoryRow`** — used in both desktop list pane and mobile list. Two-line layout, status dot, name, ID, qty/par, par-bar, category
- [ ] **`PropertiesJson`** — key/value rows separated by 1px dashed border, mono 11/1.7
- [ ] **`ActivityRow`** — timestamp + avatar + name + action
- [ ] **`TreeGroup`** — group label + items, with selected-state left-border + kbd hint on each item

### Organisms

- [ ] **`StockHistoryChart`** — `react-native-svg`. Polyline + filled area + dashed par line + dashed grid. Props: `{ data: number[], par: number, days: number, height: number }`
- [ ] **`TabStrip`** — mono `*.tsx` tabs, active gets `accent` underline. Both horizontal scroll on mobile
- [ ] **`TitleBar`** — desktop only: traffic lights + breadcrumb + connection indicator. Web-only.
- [ ] **`StatusBar`** — bottom sticky, mono 10, `fg3`, gap 14. Configurable left/right slots.
- [ ] **`Sidebar`** — desktop tree-nav + footer + ⌘P bar + accent tile header
- [ ] **`MobileNavDrawer`** — full-screen modal version of Sidebar with palette results above the tree
- [ ] **`CommandPalette`** — web-only `⌘K` modal. Fuzzy-matches across `inventory`, `vendors` (admin), `recipes`, `auditLog` (admin), screens. Use `Platform.select` to gate; on native, route the same shortcut to the mobile nav drawer.

---

## Interactions & behavior

- **List row tap / click** → push `ItemDetailScreen` (mobile) or replace detail pane (desktop)
- **Tree item click** → set `section` state, swap list pane content
- **Tab click** → swap detail body
- **Filter input** → debounce 0ms (instant), parse structured query (`status:low cat:produce`) — split tokens on whitespace, each token of form `key:value` becomes an AND-filter; bare tokens are full-text
- **`⌘K` / `⌘P`** (web) → open Command Palette modal at center, focus input, fuzzy-rank matches across enabled scopes (admin: all; staff: items + recipes), Enter to navigate
- **Status pill, par bar, status dot** → all derived from `currentStock` vs `parLevel`. No extra state
- **EDIT button** → admin only, opens existing item-edit form (your `IngredientsScreen` patterns)
- **+ COUNT button** → opens count modal pre-filled with current stock; on submit, calls existing `adjustStock()` action
- **FLAG ISSUE** (staff only) → opens a simple form: type (damage / quality / out / wrong-item) + photo + note; writes to a new `flags` table with `userId`, `itemId`, `type`, `note`, `photoUrl`, `resolved=false`. Admin sees flags as an inbox in `Insights`.
- **Hover (web)** → list rows tint with 4–6% surface overlay (use `panel2` over `panel`); ghost buttons gain `borderStrong` border
- **Selected row** → `accentBg` background + 3px `accent` left border (mobile) or 2px `accent` left border (desktop list pane)

### Animations

The Command direction is intentionally restrained. Use only:

- **Drawer slide** (mobile nav): translateX 280→0 over 220ms, ease-out
- **Modal fade** (palette): opacity 0→1 over 120ms, ease-out
- **Selected row** state: instant; no transition
- **Cursor blink** in filter inputs and palette: opacity 1→0 → 1 every 1s (steps(2))

No page transitions, no bounce, no spring physics, no parallax, no shimmer. The aesthetic is "code editor", not "consumer app".

---

## State management

Recreate using your existing Zustand store; no new top-level state shapes are required. The screens consume:

| State | Source | Notes |
|---|---|---|
| `inventory: InventoryItem[]` | `useStore` | already exists |
| `currentUser` | `useStore` | already exists; add `role: 'admin' \| 'staff'` if missing |
| `darkMode: boolean` | `useStore` | already wired to Supabase profile |
| `currentStore` | `useStore` | for breadcrumb path |
| `auditLog: AuditEvent[]` | `useStore` | for activity log card; admin-only on staff role |
| `RECENT_ACTIVITY` (component-local derive) | `useMemo` from `auditLog` | sliced/filtered per role |
| Selected item | screen-local `useState<string>('i03')` | desktop list pane drives detail pane |
| Selected section | screen-local `useState<string>('Inventory')` | desktop sidebar drives list pane title + filter scope |

Add three new memoized selectors next to their consumers (no new store keys):

- `getStockSeries(itemId, days)` — derives a daily stock series from `auditLog` events filtered by `recordId === itemId`, carry-forward on missing days
- `getRecipesUsingItem(itemId)` — joins `recipes` against the item ID
- `getCommandPaletteIndex()` — flat searchable list of `{ type, label, id, route, scope }` across inventory, vendors, recipes, audit, screens — filter by role at consume time

---

## Mock data

The prototypes ship with `data.jsx` as `window.IM_DATA` — 12 items, 6 categories, 6 vendors, 6 activity events, 5 POs, KPIs object. Use it for visual smoke-testing only; the real implementation reads from `useStore`.

```js
// Example item shape
{
  id: 'i03',
  name: 'Atlantic salmon',
  cat: 'Seafood',
  stock: 4.2,
  par: 12,
  unit: 'lb',
  cost: 14.20,
  vendor: 'Samuels',
  updated: '1h',
  status: 'low',  // 'ok' | 'low' | 'out' — derived from stock vs par
}
```

Match field names to the existing `InventoryItem` type — see `INVENTORY-MANAGEMENT/src/types/index.ts`.

---

## Files in this bundle

| File | Purpose |
|---|---|
| `README.md` | This document |
| `Command Desktop.html` | Desktop prototype canvas (light + dark) — open to view |
| `Command Mobile.html` | Mobile prototype canvas — 3 screens × 2 roles × 2 themes |
| `layout-command.jsx` | Source of the desktop layout — every measurement above is in this file |
| `layout-command-mobile.jsx` | Source of the mobile layouts (admin + staff) |
| `data.jsx` | Mock data (`window.IM_DATA`) |
| `design-canvas.jsx` | Pan/zoom canvas wrapper for presenting artboards (build-only, do not ship) |
| `tweaks-panel.jsx` | Floating tweaks panel for the prototypes (build-only, do not ship) |
| `ios-frame.jsx` | iPhone bezel for mobile mocks (build-only, do not ship) |

> **Build-only** files are infrastructure for the design canvas and have no implementation analog. Ignore them when building the real UI.

---

## Suggested implementation order

Per existing standing preference: commit after each step.

1. **Tokens + fonts.** Add `src/theme/colors.ts` (Light/Dark above) and `src/theme/typography.ts` (ramp above). Load Inter Tight + JetBrains Mono via `expo-font`. Splash holds until fonts ready. → commit
2. **Atoms.** Build `StatusDot`, `StatusPill`, `KbdHint`, `RoleBadge`, `ParBar`, `AccentTile`, `Avatar`, `SectionCaption`. Each one a single file, fully typed. → commit
3. **Molecules.** `StatCard`, `FilterInput`, `FilterChip`, `InventoryRow`, `PropertiesJson`, `ActivityRow`, `TreeGroup`. → commit
4. **Organisms.** `StockHistoryChart`, `TabStrip`, `TitleBar`, `StatusBar`, `Sidebar`, `MobileNavDrawer`. → commit
5. **Mobile screens.** `InventoryListScreen`, `ItemDetailScreen` (NEW — add navigation route), `NavDrawer` overlay. Wire role-based variants from a single `useRole()` hook. → commit
6. **Desktop layout.** Web-only three-pane `InventoryDesktopLayout` rendered at `Platform.OS === 'web' && width >= 1024`. Below that breakpoint, mobile screens render even on web. → commit
7. **`⌘K` Command Palette.** Web-only modal, mounted at app root. Listens for `keydown` on `document`. Fuzzy-matches based on `getCommandPaletteIndex()`. → commit
8. **Verification.** Type check (`npx tsc --noEmit`), font load on web, theme swap end-to-end, role swap end-to-end, palette nav, realtime sync still works. Use `INVENTORY-MANAGEMENT/`'s existing test patterns; add Storybook entries for each component if you have one.

---

## Out of scope

- Replacing `react-native-chart-kit` for charts that already use it (only add `react-native-svg` primitives for the new `StockHistoryChart`)
- Touching Supabase schema, RLS policies, edge functions, migrations
- Modifying `src/lib/{auth,db,supabase,webPush}.ts`
- Modifying realtime subscriptions or store action signatures
- iOS / Android native rebuilds — Expo handles bundling; no `expo prebuild` needed
- Replacing `react-navigation`

---

## Additional screens — `Command Screens.html`

`Command Desktop.html` shows the **Inventory** screen at full fidelity. The remaining 12 screens of the desktop app are specced in `Command Screens.html` — same chrome (sidebar, breadcrumb, status bar), each artboard 1280×820. Use it as the source of truth for layout, copy, and density. The implementer recreates each screen in the existing RN codebase.

The 12 screens fall into three patterns. **Pick the matching pattern; don't invent new layouts.**

### Pattern A — Workflow (single-task, full-bleed form)

One thing to do, top-to-bottom. Sticky header with breadcrumb + primary action; sticky footer with totals + submit. The middle scrolls.

| Screen | Purpose | Notes |
|---|---|---|
| **EOD count** | End-of-day physical count entry | Two-column: category list (left, 240px) + count grid (right). Each row = item · expected · counted (mono input) · variance (auto-calc, red/amber/green). Footer: `54 / 142 counted · 12 variance · Submit count`. |
| **Waste log** | Log spoilage, theft, prep loss | Form: item picker (combobox), qty + unit, reason (radio: `spoilage`, `prep`, `theft`, `expired`, `other`), notes, photo upload (optional). Recent entries below as a feed. |
| **Receiving** | Mark a PO as received, reconcile against invoice | Header: PO #, vendor, expected vs. actual totals. Body: line items in a table with `expected qty`, `received qty` (editable mono input), `variance`, `accept / short / reject` per row. Footer: `Mark received` (disabled until every row is touched). |
| **Restock** | Generate suggested order from par levels | Auto-populated table: item · on-hand · par · gap · suggested qty · vendor · est. cost. Each row has a checkbox. Footer: `12 selected · $1,840 est · Create POs (3 vendors)` — splits into per-vendor draft POs. |

**Component reuse from Inventory:** the table primitive (`Row`, `Cell`, mono numerics, sticky header) ports directly. Variance pills reuse the LOW/OUT badge from stock alerts (mint / amber / red).

### Pattern B — List + detail (master/detail, like Inventory)

Two- or three-pane. Left = filterable list, right = detail. Same skeleton as the Inventory screen — fork that component.

| Screen | Purpose | Notes |
|---|---|---|
| **Purchase orders** | Browse open / sent / received POs | List: PO # (mono), vendor, status pill (`draft` / `sent` / `partial` / `received`), total, due. Detail: line items, vendor info, status timeline, actions (`Send`, `Mark received`, `Cancel`). |
| **Vendors** | Vendor directory + price lists | List: name, item count, last order, status. Detail: contact info (mono), payment terms, item price list (table), order history. |
| **Recipes** | Cost recipes against current ingredient prices | List: recipe name, yield, current cost, margin. Detail: ingredient table (qty · unit · ingredient · unit cost · line cost), live total cost (recomputes when ingredient prices change), suggested menu price at target margin. |
| **Reconciliation** | Resolve count variances into adjustments | List: outstanding variances (item, expected, counted, delta, $ impact). Detail: variance breakdown, possible causes (waste log entries, recent receivings, POS sales for that day), `Resolve` action that posts an adjustment with a reason. |

**Component reuse:** the entire `Inventory` three-pane shell. Replace the right-pane content; the left list + filter bar + breadcrumb stay identical.

### Pattern C — Stream / report (read-mostly)

No interactive primary task. Filter at top, content below. Often paginated or virtualized.

| Screen | Purpose | Notes |
|---|---|---|
| **Dashboard** | Daily overview — KPIs, food cost trend, stock alerts, activity feed | Already shown in `Command Screens.html`. Four KPI tiles (mono numerics, sparkline-free, just delta vs. target), 14-day food cost chart (reuse `StockHistoryChart`), stock alerts list (top 6, links to Inventory), activity log (last 6 events). |
| **POS imports** | Audit POS sales imports (Toast, Square, etc.) | Header: filter by source + date range. Table: timestamp · source · file · rows imported · errors · status. Click row → modal with raw import + parse errors. |
| **Audit log** | Immutable record of every state-changing action | Table: timestamp (mono) · actor · action (`stock.adjusted`, `po.created`, `count.submitted`, …) · entity · before → after diff. Filterable by actor, entity, action. No editing — read-only. |
| **Reports** | Pre-built reports — usage, variance, COGS, vendor performance | Top: report picker (segmented). Body: parameters (date range, filters), `Run` button, results table + chart. Export as CSV / PDF. |

**Component reuse:** Dashboard reuses the chart and activity log from Inventory. POS imports + Audit log are pure tables — same `Row` / `Cell` primitive. Reports needs one new component (parameter form), everything else is reuse.

### Implementation order

Build in this order — each phase reuses components from the prior phase:

1. **Pattern B forks first** (Purchase orders, Vendors, Recipes, Reconciliation) — they're 80% the Inventory screen with a different right pane. Establishes the list+detail skeleton.
2. **Pattern A workflows** (EOD count, Waste log, Receiving, Restock) — share a sticky-header + scroll-body + sticky-footer layout. Build that scaffold once.
3. **Pattern C streams** (Dashboard, POS imports, Audit log, Reports) — last, because they reuse the table + chart primitives now hardened.

Dashboard is the home route (`/`) and should ship in phase 3 alongside the other read-only screens, not first — it depends on the chart and activity-log components being final.

### Permissions per screen

`staff` role gets the same restrictions documented above for mobile, applied to these screens:

| Screen | Admin | Staff |
|---|---|---|
| Dashboard | Full | KPIs hidden, alerts + activity visible |
| EOD count | Full | Full (this is staff's primary task) |
| Waste log | Full | Full (also primary) |
| Receiving | Full | Full |
| Purchase orders | Full | **Hidden** |
| Vendors | Full | **Hidden** |
| Recipes | Full | View-only (no cost column) |
| Restock | Full | **Hidden** |
| Reconciliation | Full | **Hidden** |
| POS imports | Full | **Hidden** |
| Audit log | Full | **Hidden** |
| Reports | Full | **Hidden** |

The sidebar already groups by `OPERATIONS` / `PLANNING` / `INSIGHTS` — for staff, `PLANNING` and `INSIGHTS` collapse entirely (don't grey out — these are bigger sections than mobile's per-tab restriction).

---

## Open questions for the implementer

If anything below is ambiguous, surface it before building rather than guessing:

1. **Role source of truth.** Where does `currentUser.role` come from today? If it's not on the user profile yet, add a Supabase migration before building role-dependent UI.
2. **Flag-issue feature.** The `FLAG ISSUE` action assumes a `flags` table. Confirm whether this exists or needs to be designed.
3. **Mobile palette.** ⌘K is desktop-keyboard-driven; on mobile, the palette field at the top of the nav drawer serves the same purpose. Confirm the drawer is the right home for it.
4. **Tab `count.tsx` (staff).** This is a placeholder for a per-item count history. Confirm scope with product before designing.
5. **Restricted-section UI on staff.** The greyed `Admin-only` list in the nav drawer is intentional — staff can see what they don't have access to. Confirm this is wanted (vs. hiding outright).
