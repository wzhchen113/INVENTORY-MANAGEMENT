# Spec 139: Exportable count files with a per-export language picker

Status: READY_FOR_REVIEW

## User story

As a store manager working an admin count screen, I want to export the current
count as a CSV or PDF file in a language I choose at export time (English,
Spanish, or 中文 / zh-CN), so that I can hand a correctly-localized count sheet
to whoever needs it — and the Chinese file must open cleanly in Excel and print
with real glyphs, not tofu boxes.

This applies to BOTH admin count screens:
- EOD count — [src/screens/cmd/sections/EODCountSection.tsx](../src/screens/cmd/sections/EODCountSection.tsx)
- Inventory count — [src/screens/cmd/sections/InventoryCountSection.tsx](../src/screens/cmd/sections/InventoryCountSection.tsx)

## Acceptance criteria

### Export UI (both screens)
- [ ] EODCountSection renders a **CSV** export button and a **PDF** export button.
- [ ] InventoryCountSection renders a **CSV** export button and a **PDF** export button.
- [ ] A **language picker/toggle** sits next to the CSV/PDF buttons on each
      screen, offering exactly the three supported locales: `en` (English),
      `es` (Español), `zh-CN` (中文).
- [ ] The language picker **defaults to the app's current active locale** on
      first render of the screen.
- [ ] The chosen export language applies to that export only; it does not
      change the app-wide locale/UI language.

### Localized content
- [ ] Exported item **names** render in the picked language via
      `getLocalizedName` ([src/i18n/localizedName.ts](../src/i18n/localizedName.ts)),
      resolving from `InventoryItem.i18nNames` with the documented silent
      English fallback (no `(en)` tag, no `[untranslated]` placeholder).
- [ ] With the picker set to `en`, the export output is byte-for-byte the
      plain-English path (English literals preserved verbatim), matching the
      `reorderExport.ts` locale contract so jest pins hold.
- [ ] Column **headers** translate to the picked language. (Architect confirms
      yes/no — recommendation: YES, for a coherent localized file, mirroring
      `buildReorderCsv`'s localized-header approach. See open questions.)

### CSV correctness (the Chinese-in-Excel trap)
- [ ] The count CSV export **prepends a UTF-8 BOM** (`﻿`) so a `zh-CN`
      (and `es` accented) export opens with correct characters in Excel — no
      mojibake.
- [ ] The BOM fix does NOT silently corrupt existing `downloadCSV` callers
      (Inventory catalog ExportCsvDrawer, reorder). Architect decides: fix
      `downloadCSV` for all callers vs. add a BOM-aware variant/flag. See open
      questions.

### PDF correctness (the Chinese-glyph trap)
- [ ] A `zh-CN` PDF export renders Chinese item names and headers as real
      glyphs (an embedded CJK font), not blank/tofu boxes.
- [ ] `en`/`es` PDF exports render correctly (Latin path unaffected).
- [ ] The CJK font payload is kept out of the main app bundle — loaded only
      when a PDF export actually needs it. Architect pins the exact strategy
      (subset vs. full, lazy-load). See open questions.

### Files & naming
- [ ] Each export downloads a file whose name encodes the screen, store, date,
      and locale (exact convention pinned by architect; follow the
      `slugifyStore` + `todayLocalIso` shape from `reorderExport.ts`).

## In scope
- Net-new CSV + PDF export UI on EODCountSection and InventoryCountSection
  (neither has any export today).
- A per-export language picker (en / es / zh-CN) on each screen, defaulting to
  the app's current locale.
- Localized item names via `getLocalizedName` and (recommended) localized
  headers via the existing es / zh-CN i18n catalogs.
- UTF-8 BOM on the count CSV so Chinese opens correctly in Excel.
- CJK font embedding so Chinese renders in the count PDF (owner has accepted
  the PDF font-size cost).
- Pure, framework-free export builders following the `reorderExport.ts`
  pattern (testable, no DOM/theme imports), with DOM-coupled download
  orchestration staying in the section files.

## Out of scope (explicitly)
- **The staff app** ([src/screens/staff/](../src/screens/staff/)) — this feature
  is admin count screens only. Staff EOD entry gets no export here.
- **Reorder export** ([src/utils/reorderExport.ts](../src/utils/reorderExport.ts)) —
  already exports; it is the reference pattern, not a target. No changes beyond
  any shared BOM/util decision the architect explicitly scopes in.
- **Inventory catalog export** (ExportCsvDrawer) — already exports; not a
  target. Only touched if the architect chooses to fix `downloadCSV` centrally
  (and then only to ADD a BOM without changing its column output).
- **Changing the app-wide locale** — the picker is export-scoped only.
- **New backend/RPC/edge-function work** — export is a pure client-side
  transform of already-loaded count data. No migrations.
- **New translation strings for item names** — relies on existing
  `catalog_ingredients.i18n_names`; untranslated names fall back to English
  silently (existing behavior).
- **Realtime** — export is a read-time snapshot; no channels touched.
- **app.json slug** — untouched.

## Open questions resolved (owner — SETTLED, do not reopen)
- Q: Which screens get export? → A: BOTH — EOD count AND Inventory count.
- Q: Which formats? → A: BOTH CSV and PDF, on each screen.
- Q: How is language chosen? → A: A per-export picker/toggle next to the
  CSV/PDF buttons; three locales (en / es / zh-CN); chosen at export time.
- Q: What renders in the picked language? → A: Item names, via
  `getLocalizedName`. Headers: recommended yes (architect confirms).
- Q: Is the PDF CJK-font byte cost acceptable? → A: Yes, owner explicitly
  accepted it.
- Q: Default language for the picker? → A: The app's current active locale.

## Open questions for the ARCHITECT (not the owner)
1. **PDF CJK font strategy.** Subset vs. full Noto Sans SC (or equivalent);
   how to keep multi-MB font data out of the main Vercel/EAS bundle
   (lazy-load / dynamic import on first PDF export?). Also: does the reorder
   PDF path use jsPDF or `expo-print` HTML→PDF? `reorderExport.ts` ships BOTH a
   jsPDF-era note and a `buildReorderPdfHtml` (expo-print) builder — pick ONE
   PDF engine for the count export and justify CJK glyph support on it
   (expo-print/HTML gets CJK "for free" from the system/webview font on web +
   native, which may sidestep font embedding entirely; jsPDF needs
   `addFileToVFS`/`addFont`). Resolve engine choice first — it determines
   whether the font-embedding question even applies.
2. **Header translation: yes/no.** Recommendation yes (coherent localized
   file, matches `buildReorderCsv`). Confirm and pin the header keys per
   screen in the es / zh-CN catalogs.
3. **Exact column sets per screen.** Pin the precise column list + order for
   EOD count (per-vendor items: counted qty, unit, etc.) and Inventory count
   (full item set: counted qty, par, unit, etc.), reflecting what each screen
   actually shows. Confirm whether EOD export is grouped per-vendor like
   `buildReorderCsv`.
4. **BOM approach.** Fix `downloadCSV` in [src/utils/index.ts](../src/utils/index.ts)
   to prepend `﻿` for all callers, vs. add a BOM-aware variant/flag used
   only by the count export. Note existing callers (catalog, reorder) must not
   have their column output changed; adding a BOM is generally safe for Excel
   but confirm no downstream parser chokes on it.
5. **Shared vs. per-screen builders.** Whether the two screens share one
   parameterized pure builder module (à la `reorderExport.ts`) or get two
   sibling modules, given their different column sets.

## Dependencies
- `getLocalizedName` — [src/i18n/localizedName.ts](../src/i18n/localizedName.ts)
- i18n catalogs — [src/i18n/es.json](../src/i18n/es.json),
  [src/i18n/zh-CN.json](../src/i18n/zh-CN.json) (add export header/label keys)
- `InventoryItem.i18nNames` (from `catalog_ingredients.i18n_names` JSONB)
- Reference pattern — [src/utils/reorderExport.ts](../src/utils/reorderExport.ts)
  (PapaParse CSV, localized headers, `slugifyStore`, `todayLocalIso`,
  `escapeHtml`, PDF-HTML builder) and its DOM orchestrators in
  `ReorderSection.tsx`.
- `downloadCSV` — [src/utils/index.ts:115](../src/utils/index.ts)
- A CJK font asset (e.g. Noto Sans SC subset) IF the chosen PDF engine needs
  embedding — new asset, lazy-loaded.

## Project-specific notes
- Cmd UI section / legacy: Cmd UI — EODCountSection + InventoryCountSection
  under `src/screens/cmd/sections/`. No legacy surface.
- Per-store or admin-global: per-store — both count screens operate on the
  active store's data; export is a client-side transform of already-loaded,
  RLS-scoped count data. No new data access.
- Realtime channels touched: none.
- Migrations needed: no.
- Edge functions touched: none.
- Web/native scope: primarily admin desktop (web) count screens. If the chosen
  PDF engine is `expo-print`, native is inherently supported; if jsPDF, this is
  web-first — architect to state the platform posture explicitly.
- Tests: **jest** track — pure export builders (BOM presence, localized
  names/headers per locale, en byte-for-byte identity, column sets) are unit-
  testable exactly like the existing `reorderExport` jest pins. Name the jest
  track in the build. No pgTAP or shell smoke needed (no DB/edge change).

---

## Backend design

**Frontend-primary feature.** Export is a pure client-side transform of
already-loaded, RLS-scoped count data. There is **no** DB / RPC / edge / RLS /
realtime / migration work. The backend-facing sections below are marked N/A
with the reason.

### Resolution of the five architect open questions (read this first)

#### Q1 — PDF engine + CJK. RESOLVED: expo-print HTML→PDF. NO font embedding.

The PM's finding is confirmed and sharpened. The **pure** builder in
[src/utils/reorderExport.ts](../src/utils/reorderExport.ts) ships exactly one PDF
path — `buildReorderPdfHtml` (expo-print HTML→PDF, spec 089 C). The jsPDF path
is NOT in that module; it lives only in the admin orchestrator
[src/screens/cmd/sections/ReorderSection.tsx:1040](../src/screens/cmd/sections/ReorderSection.tsx)
(`handlePdfExport`), and it is precisely the path that **cannot** do CJK — line
1051 hard-falls-back `zh-CN → en` because jsPDF's built-in Helvetica has no CJK
glyphs. The staff orchestrator
[src/screens/staff/lib/shareReorder.ts:164](../src/screens/staff/lib/shareReorder.ts)
(`shareReorderPdf`) uses expo-print and stays **fully localized including
zh-CN**.

Decision for spec 139: **use the expo-print HTML→PDF engine** (the staff
pattern), on both web (`Print.printAsync({ html })` → browser print dialog) and
native (`Print.printToFileAsync` → share sheet). expo-print renders the HTML in
the platform WebView, which draws CJK from the **system** font (iOS PingFang SC,
Android Noto Sans CJK, desktop browser CJK fallback) — so **Chinese glyphs come
for free** and NO multi-MB font asset is bundled or lazy-loaded.

This **overrides / simplifies** the spec's "CJK font embedding" AC (lines 51-57,
plus the In-scope "CJK font embedding" bullet and the Dependency line for a Noto
Sans SC asset): those are satisfied by engine choice, not by embedding. Two
hard requirements on the generated HTML to guarantee glyphs:
- `<meta charset="utf-8" />` (already the shape in `buildReorderPdfHtml` line
  351 — carry it verbatim).
- a CJK-safe `font-family` stack. The current reorder stack
  (`-apple-system, Helvetica, Arial, sans-serif`) resolves CJK via system
  fallback on all three targets, but make it explicit in the count HTML:
  `font-family: -apple-system, "PingFang SC", "Hiragino Sans GB",
  "Microsoft YaHei", "Noto Sans CJK SC", "Noto Sans SC", Helvetica, Arial,
  sans-serif;` so a headless/minimal print environment still has a named CJK
  family to reach for.

Do NOT reuse the admin jsPDF `handlePdfExport` for counts — it would re-introduce
the exact zh-CN→en fallback this spec exists to avoid. (The admin reorder jsPDF
CJK gap is pre-existing and OUT of scope here; note it as a follow-up only.)

Platform posture: CSV is web-first (matches every existing admin exporter —
`downloadCSV` and reorder's `triggerDownload` both assume the DOM). PDF via
expo-print is inherently cross-platform. Both count screens are admin-desktop
(web) surfaces, so this is consistent.

#### Q2 — CSV BOM. RESOLVED: centralize in `downloadCSV`; count CSV routes through it.

`downloadCSV` callers today (grep): the catalog `ExportCsvDrawer`
([src/components/cmd/ExportCsvDrawer.tsx:77](../src/components/cmd/ExportCsvDrawer.tsx))
and the menu-BOM export in
[src/screens/cmd/sections/RecipesSection.tsx:221](../src/screens/cmd/sections/RecipesSection.tsx).
Both open in Excel / Google Sheets, both can carry non-ASCII (accented / CJK
ingredient + menu-item names), and both have the identical mojibake exposure.
A UTF-8 BOM (`﻿`) is Excel- and Sheets-safe and is **additive** — it does
NOT change any column output, only prefixes 3 bytes.

Decision: **prepend `﻿` centrally inside `downloadCSV`**
([src/utils/index.ts:115](../src/utils/index.ts)), and have the count-CSV
orchestrator emit through `downloadCSV` so there is exactly **one** owner of the
BOM. This is the spec-authorized "fix `downloadCSV` centrally" branch (line
126). It fixes the two existing exporters' latent mojibake as a free side
effect; flag both in the review as touched-but-additive.
- Change shape (developer authors): `new Blob(['﻿' + csvContent], { type:
  'text/csv;charset=utf-8;' })`.
- Do NOT touch reorder's separate `triggerDownload` (out of scope; its data is
  ASCII-clean today and reorder is explicitly a non-target).

#### Q3 — Header translation. RESOLVED: YES.

Translate column headers (and section/vendor/category group labels, buttons,
filename chrome) via the es / zh-CN catalogs, mirroring `buildReorderCsv`'s
`H(key, en)` pattern. English literals stay byte-identical on the `en` path (the
identity contract). Pin the key namespaces:
- EOD: `section.eod.export.*`
- Inventory count: `section.inventoryCount.export.*`

(Shared tokens like `yes`/`no` are not needed — count rows carry no boolean
column. Unit tokens reuse the existing `enum.unit.*` dictionary via
`localizeUnit`.)

#### Q4 — Exact column sets. RESOLVED (see below). EOD grouped per-vendor; Inventory grouped per-category.

Both screens render an identical per-item row shape: `name`, `unit`,
`caseQty` (case size, shown only when >1), `parLevel`, a **case** count input, a
**unit/each** count input, and a note field (EOD:
[EODCountSection.tsx:765-891](../src/screens/cmd/sections/EODCountSection.tsx);
Inventory:
[InventoryCountSection.tsx:1080-1169](../src/screens/cmd/sections/InventoryCountSection.tsx)).
The export is a **snapshot of the current count** — it reflects the operator's
on-screen entered values (blank where nothing was typed), which doubles as a
fill-in worksheet. The section orchestrator reads its own transient count maps
and assembles rows; the pure builder never touches React state.

**EOD count** — grouped per vendor (like `buildReorderCsv`), across all vendor
tabs shown for the selected day, for the selected date. Columns in order:

| # | Header key (`section.eod.export.`) | en literal | Source |
|---|---|---|---|
| 1 | `colVendor` | `Vendor` | group label (repeated per row) |
| 2 | `colCategory` | `Category` | `item.category` |
| 3 | `colItemName` | `Item Name` | `getLocalizedName({name, i18nNames}, locale)` |
| 4 | `colUnit` | `Unit` | `localizeUnit(item.unit, locale)` |
| 5 | `colCaseSize` | `Case Size` | `caseQty > 1 ? caseQty : ''` |
| 6 | `colParLevel` | `Par Level` | `item.parLevel` |
| 7 | `colCountedCases` | `Counted Cases` | entered case value or `''` |
| 8 | `colCountedUnits` | `Counted Units` | entered unit/each value or `''` |
| 9 | `colCountedTotal` | `Counted Total` | `cases*caseQty + units`, `''` if neither entered |
| 10 | `colNote` | `Note` | entered note or `''` |

EOD **excludes** system on-hand deliberately — an EOD sheet handed to a counter
should be a blind count (no bias). Owner-flippable.

**Inventory count** — grouped per category. Columns in order:

| # | Header key (`section.inventoryCount.export.`) | en literal | Source |
|---|---|---|---|
| 1 | `colCategory` | `Category` | group label |
| 2 | `colItemName` | `Item Name` | `getLocalizedName(...)` |
| 3 | `colUnit` | `Unit` | `localizeUnit(...)` |
| 4 | `colCaseSize` | `Case Size` | `caseQty > 1 ? caseQty : ''` |
| 5 | `colParLevel` | `Par Level` | `item.parLevel` |
| 6 | `colSystemOnHand` | `System On-Hand` | `item.currentStock` |
| 7 | `colCountedCases` | `Counted Cases` | entered or `''` |
| 8 | `colCountedUnits` | `Counted Units` | entered or `''` |
| 9 | `colCountedTotal` | `Counted Total` | derived, `''` if neither |
| 10 | `colNote` | `Note` | entered or `''` |

Inventory count **includes** System On-Hand — it is the reconciliation screen
(the on-screen variance references `currentStock`).

No dollar/cost columns on either sheet (a count sheet is unit-quantity, not
cost; keeps it numeric-clean and avoids the spec-104 per-each cost bridge).

#### Q5 — Shared vs per-screen builders. RESOLVED: one shared parameterized module.

New pure module `src/utils/countExport.ts`, mirroring `reorderExport.ts`
(framework-free: no React/theme/supabase — only `papaparse` + `../i18n` +
`getLocalizedName` + `localizeUnit`). Parameterized by locale + column set +
grouped rows, so the two differing column sets are just two call configs. The
language picker feeds `locale` into every builder entry point.

### Proposed module surface — `src/utils/countExport.ts`

```ts
import type { Locale } from '../i18n';
import type { LocalizedNames } from '../types';

// One count row, pre-flattened by the section orchestrator from its transient
// maps. Name fields feed getLocalizedName; counts are the on-screen snapshot.
export interface CountExportItem {
  name: string;                 // canonical English name (it.name)
  i18nNames?: LocalizedNames | null;
  category: string;
  unit: string;
  caseQty: number;              // >1 means case-packed
  parLevel: number;
  currentStock?: number;        // only surfaced by the inventory-count column set
  countedCases?: number | null; // parsed entered value; null/undefined = blank
  countedUnits?: number | null;
  note?: string;
}

export interface CountExportGroup {
  label: string;                // vendor name (EOD) or category (inventory)
  items: CountExportItem[];
}

export type CountScreen = 'eod' | 'inventoryCount';

export interface CountExportParams {
  screen: CountScreen;          // selects the column set + i18n namespace
  groups: CountExportGroup[];
  storeName: string;
  dateIso: string;              // selected day (EOD) / today (inventory)
  locale: Locale;
}

export function buildCountCsv(params: CountExportParams): string;
export function buildCountPdfHtml(params: CountExportParams): string;

// `IMR_EOD_Count_{store}_{date}_{locale}.csv|pdf`
// `IMR_Inventory_Count_{store}_{date}_{locale}.csv|pdf`
export function countExportFilename(
  screen: CountScreen, storeName: string, dateIso: string,
  locale: Locale, ext: 'csv' | 'pdf',
): string;
```

- Reuse `slugifyStore` + `todayLocalIso` by importing from `./reorderExport`
  (already the single source of truth for those helpers). `escapeHtml` is
  private in `reorderExport`; add a local copy in `countExport.ts` (matches the
  inline-not-shared escape convention in CLAUDE.md — an escape helper is cheap
  to duplicate and avoids widening the reorder module's export surface).
- CSV uses `Papa.unparse(rows, { columns })` with localized headers doubling as
  row keys — the exact `buildReorderCsv` idiom, so `en` stays byte-identical.
- `getLocalizedName` threads in via an internal `itemDisplayName(item, locale)`
  identical to `reorderExport.ts:48`. `localizeUnit(unit, locale)` (imported
  from `reorderExport`) localizes the unit token with English pass-through.
- **`en` identity contract:** with `locale === 'en'`, headers use the English
  literals verbatim, names return the canonical column, units pass through
  unchanged, group labels are raw — so the file is byte-for-byte a plain English
  export. Enforced the same way `reorderExport` enforces it.

### Data model changes
N/A — export reads already-loaded `inventory` / `eodSubmissions` / transient
count state. No table, column, index, or migration.

### RLS impact
N/A — no new table; the count data is already fetched through the store's
existing RLS-scoped loaders (`auth_can_see_store`). Export adds no data access.

### API contract
N/A — no PostgREST/RPC. Pure in-memory transform.

### Edge function changes
N/A — no function new or modified; `verify_jwt` untouched.

### `src/lib/db.ts` surface
N/A — no DB traffic. (Confirm in review that nothing in the implementation
reaches `supabase.from/rpc` directly — it must not.)

The only shared-util change outside the two section files is the additive BOM in
`downloadCSV` ([src/utils/index.ts:115](../src/utils/index.ts)) and the new
`src/utils/countExport.ts`. No camelCase mapping (no snake_case source).

### Realtime impact
N/A — export is a read-time snapshot; no channel replays it, and no
`supabase_realtime` publication membership changes (no `docker restart
supabase_realtime_imr-inventory` step needed).

### Frontend store impact
No `src/store/useStore.ts` slice changes and **no** optimistic-then-revert /
`notifyBackendError` path — export never writes. The picked export locale is
**local component state**, seeded from `useLocale()` on first render, and MUST
NOT call `setLocale` (that would change the app-wide UI language, violating AC
lines 27-28 / 87).

### UI wiring (both section files)

- **Language picker:** the existing
  [src/components/cmd/LocaleSwitcher.tsx](../src/components/cmd/LocaleSwitcher.tsx)
  is NOT reusable as-is — it calls `setLocale` (mutates app-wide locale). Build a
  small **export-scoped** control (a 3-state cycle pill visually mirroring
  `LocaleSwitcher`, or a 3-segment control) whose state is local
  `useState<Locale>(() => appLocale)` where `appLocale = useLocale()`. Reuse the
  locale-invariant labels `chrome.localeSwitcher.labels.{en,es,zh-CN}` so a pill
  reads `EN` / `ES` / `中文`. This can be a shared local component (e.g.
  `src/components/cmd/ExportLocalePicker.tsx`) imported by both sections.
- **Placement:** an export toolbar in each worksheet header region (top-right,
  near the existing search/filter controls), grouped left→right: locale picker,
  then `CSV`, then `PDF` buttons (styled with the existing Cmd button tokens).
- **Orchestration (impure, stays in the section — mirrors `ReorderSection`):**
  each section adds handlers that (1) assemble `CountExportGroup[]` from its
  transient maps, (2) call `buildCountCsv` / `buildCountPdfHtml` with the picked
  locale, (3) CSV → `downloadCSV(countExportFilename(...), csv)`; PDF →
  `Print.printAsync({ html })` on web / `Print.printToFileAsync` + share on
  native (the `shareReorder.ts` shape), (4) wrap in try/catch → success/failure
  `Toast`. Add the button labels + toasts under the `section.*.export.*`
  namespace (en/es/zh-CN).

### Risks and tradeoffs

- **expo-print web = print dialog, not a silent file.** On web `Print.printAsync`
  opens the browser print dialog (user picks "Save as PDF"); there is no named
  file artifact. This matches the staff reorder PDF UX and is the accepted
  web-PDF affordance — call it out in the UI copy so it isn't read as a bug.
- **BOM blast radius.** Centralizing the BOM touches the catalog and menu-BOM
  exports. Additive (3-byte prefix, no column change) and Excel/Sheets-safe, but
  it IS a change to two non-target exporters — reviewers should confirm no
  downstream re-import parser for those files rejects a BOM. If any does, fall
  back to a BOM-aware flag on `downloadCSV` used only by the count path (the
  spec's alternative branch).
- **CJK "for free" depends on the print environment's fonts.** Standard
  browsers, iOS, and Android all ship CJK system fonts, so this holds for the
  admin-desktop target. A locked-down kiosk browser with no CJK font would tofu
  — acceptable given the deployment reality; the explicit `font-family` stack
  minimizes it. This is browser-verification territory (main-Claude's pass).
- **Snapshot semantics.** Exporting entered-values-or-blank means an export
  taken mid-count reflects partial entry. That is the intended "current count"
  behavior; blank cells double as fill-in space.
- **No CI/edge/migration surface** → no `db-migrations-applied` exposure, no
  cold-start, no seed-dataset performance concern (transform is O(items) over an
  already-in-memory list).

### Jest test plan (pure builders — name the track in the build)

Cover `buildCountCsv`, `buildCountPdfHtml`, `countExportFilename` for BOTH
column sets (`eod`, `inventoryCount`):
1. **`en` identity** — output for `locale: 'en'` is byte-for-byte the plain
   English path (English header literals, canonical names, raw units/labels).
   Pin a fixture snapshot per screen.
2. **Localized names** — an item with `i18nNames['zh-CN']` renders the localized
   name under `zh-CN`; an item WITHOUT it silently falls back to English (no
   `(en)` tag / `[untranslated]`), per `getLocalizedName`.
3. **Localized headers** — `es` / `zh-CN` headers come from the catalogs; `en`
   headers are the literals.
4. **BOM presence** — assert `downloadCSV`'s emitted content begins with
   `﻿` (test at the `downloadCSV` seam, e.g. mock `Blob`/anchor and inspect
   the passed content), and that `buildCountCsv` itself returns BOM-free CSV
   (BOM is added once, at the download seam).
5. **Column set + order** — exact headers and order per screen; `Counted Total`
   derivation (`cases*caseQty + units`, blank when neither entered); `Case Size`
   blank when `caseQty <= 1`; EOD has no System On-Hand, inventory does.
6. **Filename** — encodes screen + slugified store + date + locale token, with
   correct extension.

Browser verification (main-Claude's pass, NOT jest): a `zh-CN` CSV opened as
UTF-8 in Excel shows Chinese (no mojibake), and the `zh-CN` PDF prints real
glyphs (no tofu), on both count screens.

## Handoff
next_agent: frontend-developer
prompt: Implement spec 139 against the Backend design. It is frontend-only —
  new pure module `src/utils/countExport.ts` (shared, parameterized by
  screen/locale/grouped-rows, mirroring `reorderExport.ts`), a shared
  export-scoped locale picker component, CSV + PDF export toolbars wired into
  EODCountSection and InventoryCountSection with impure orchestrators (CSV via
  the centrally-BOM'd `downloadCSV`; PDF via expo-print HTML→PDF — NO font
  embedding, CJK renders from the system font), the additive `﻿` BOM in
  `downloadCSV`, and the new `section.eod.export.*` / `section.inventoryCount.export.*`
  i18n keys in en/es/zh-CN. Do NOT reuse the admin jsPDF path (it drops zh-CN).
  Add the jest pins listed. Keep the `en` output byte-identical. After
  implementation, set Status: READY_FOR_REVIEW and list files under
  ## Files changed.
payload_paths:
  - specs/139-count-export-language-picker.md

---

## Files changed

### New
- `src/utils/countExport.ts` — pure, framework-free count-export builders
  (`buildCountCsv`, `buildCountPdfHtml`, `countExportFilename`), parameterized
  by `screen` (`eod` | `inventoryCount`) + `locale` + grouped rows. Mirrors
  `reorderExport.ts`: imports only `papaparse` + `../i18n` + `getLocalizedName`
  + `localizeUnit`/`slugifyStore` (from `reorderExport`), with a duplicated
  local `escapeHtml`. `en` output byte-identical via the `H(key, en)` idiom;
  PDF-HTML carries `<meta charset="utf-8">` + an explicit CJK-safe
  `font-family` stack (NO jsPDF, NO font embedding). CSV is BOM-free.
- `src/components/cmd/ExportLocalePicker.tsx` — export-scoped 3-segment locale
  control (EN / ES / 中文). CONTROLLED; the section owns the state. Reuses the
  locale-invariant `chrome.localeSwitcher.labels.*` copy. Never calls
  `setLocale` (does not mutate app-wide locale).
- `src/utils/countExport.test.ts` — jest pins: EOD/Inventory column set +
  order, `Counted Total` derivation, blank-cell rules, System On-Hand
  presence/absence, `en` identity snapshots, BOM-free builder output,
  localized headers/units/names + silent English name fallback, PDF-HTML
  charset+CJK-stack + HTML escaping, filename convention, AND the additive
  `﻿` BOM at the `downloadCSV` seam.
- `src/components/cmd/ExportLocalePicker.test.tsx` — renders 3 segments, marks
  the controlled value selected, fires `onChange`, and pins the default-seeds-
  from-app-locale contract via a section-mirroring harness.

### Modified
- `src/utils/index.ts` — `downloadCSV` now prepends the UTF-8 BOM (`﻿`)
  additively (`new Blob(['﻿' + csvContent], …)`). Central fix per the
  design. **Touches two existing non-target callers additively** (no column
  change): the catalog `ExportCsvDrawer` and the RecipesSection menu-BOM
  export — reviewers should confirm no downstream re-import parser rejects a
  leading BOM. Reorder's separate `triggerDownload` is NOT touched.
- `src/screens/cmd/sections/EODCountSection.tsx` — export toolbar (locale
  picker + CSV + PDF) in the count worksheet header; impure orchestrators
  assemble the per-vendor grouped snapshot across ALL vendor tabs for the
  selected date (blank where untyped), call the pure builders, CSV →
  `downloadCSV`, PDF → `Print.printAsync` (web) / `printToFileAsync` + share
  (native). EOD excludes System On-Hand.
- `src/screens/cmd/sections/InventoryCountSection.tsx` — same toolbar +
  orchestrators; per-category grouped snapshot across all store items
  (category chip is view-only), includes System On-Hand.
- `src/i18n/en.json`, `src/i18n/es.json`, `src/i18n/zh-CN.json` — added
  `section.eod.export.*` and `section.inventoryCount.export.*` header/label/
  toast keys (identical key sets across all three catalogs; parity test green).

### Verification
- `npx tsc --noEmit` → EXIT 0.
- `npx tsc -p tsconfig.test.json --noEmit` → EXIT 0.
- `npx jest` → EXIT 0 (136 suites, 1427 tests, 2 snapshots passed).
- **Browser verification NOT performed**: no `preview_*` browser tooling is
  available in this agent's toolset. Main Claude must verify in-browser that a
  `zh-CN` CSV opens as UTF-8 in Excel with real Chinese (no mojibake) and the
  `zh-CN` PDF prints real glyphs (no tofu) on both count screens — this is the
  spec's designated main-Claude pass.

### Follow-up (out of scope, noted only)
- The admin reorder jsPDF path (`ReorderSection.tsx` `handlePdfExport`) still
  hard-falls-back `zh-CN → en`; the architect flagged this as a pre-existing
  gap outside spec 139.

## Post-review fixes applied (before ship)

- **CSV formula-injection guard (security Medium + reorder Low).** Added a
  shared `csvSafeCell` / `unparseCsvSafe` in `src/utils/reorderExport.ts`:
  string cells beginning with `= + - @` / tab / CR are apostrophe-prefixed so a
  hostile catalog name / free-text note can't execute as an Excel formula.
  Numbers pass through untouched (negatives keep their sign). Applied at the
  unparse boundary of BOTH `buildCountCsv` and `buildReorderCsv` (closes the
  count Medium and the pre-existing reorder Low in one shared helper). Normal
  data is byte-unchanged → the `en` identity contract + existing snapshots
  hold. New unit tests in `reorderExport.test.ts`.
- **Dead i18n keys pruned (code-review Should-fix).** Removed
  `section.eod.export.noItemsToExport`, `section.inventoryCount.export.{noItemsToExport,colVendor,groupVendor}`
  from all three catalogs (never referenced; `colVendor`/`groupVendor` are
  eod-only). i18n parity gate stays green.
- Removed the now-unused `papaparse` import from `countExport.ts`.

Deferred as post-ship follow-up: two section-level render tests asserting the
export toolbar (CSV/PDF + locale picker) mounts on each count screen — the
toolbars are already verified live in the main-session browser pass.

Verification after fixes: `npx tsc --noEmit` + test-graph tsc both exit 0;
full `npx jest` 136 suites / 1430 tests / 2 snapshots, exit 0.
