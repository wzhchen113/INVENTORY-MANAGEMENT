## Code review for spec 139

Scope verified: `src/utils/index.ts` (`downloadCSV`), `src/utils/countExport.ts`,
`src/utils/countExport.test.ts`, `src/components/cmd/ExportLocalePicker.tsx` (+
test), `src/screens/cmd/sections/EODCountSection.tsx`,
`src/screens/cmd/sections/InventoryCountSection.tsx`, `src/i18n/{en,es,zh-CN}.json`.

Focused verification results (see Should-fix/Nits for the two gaps found):
- **BOM blast radius**: `downloadCSV` (`src/utils/index.ts:126-134`) is the only
  place the BOM is added. Both existing callers — `ExportCsvDrawer.tsx:77` and
  `RecipesSection.tsx:221` — have no jest coverage that pins the exact blob
  content, so the additive prefix cannot break `npx jest`. Neither exported CSV
  (inventory catalog, menu-BOM) is re-imported anywhere else in this codebase
  (the only CSV-import paths, `src/lib/csvImport.ts` /
  `src/utils/syscoImport.ts` / `src/utils/usFoodsImport.ts`, parse vendor
  invoice files, not IMR's own exports), so the residual risk is limited to an
  external tool the codebase doesn't control — correctly called out as a
  browser-verification item in the spec, not a code defect.
- **`en` byte-identity contract**: confirmed end-to-end. `columnsFor`'s
  `H(k, en)` (`src/utils/countExport.ts:128`) and `buildCountPdfHtml`'s local
  `H` (`countExport.ts:226`) both short-circuit to the literal on
  `locale === 'en'` and never call `t()`; `unitOf` (`countExport.ts:87-89`)
  short-circuits the same way; `getLocalizedName` (`src/i18n/localizedName.ts:53`)
  returns the canonical column outright for `en` without consulting
  `i18nNames`. No path reaches the i18n catalog on the English export. The
  `eod-en` / `inventory-en` jest snapshots pin this.
- **`ExportLocalePicker` scope**: confirmed export-scoped. It is a controlled
  component (`value`/`onChange` props only, `ExportLocalePicker.tsx:24-27`),
  never imports or calls `setLocale`, and both call sites seed local state via
  `useState<Locale>(() => appLocale)` where `appLocale = useLocale()`
  (`EODCountSection.tsx:162-163`, `InventoryCountSection.tsx:182-183`) — a
  lazy initializer that runs once, so a later app-locale change does not
  re-sync the export picker and the export picker never touches the app-wide
  locale slice.
- **Convention mirroring**: `countExport.ts` matches `reorderExport.ts`'s
  shape (Papa.unparse w/ columns-as-keys, `H(key, en)` idiom, imported
  `slugifyStore`/`localizeUnit` rather than re-derived, a duplicated
  `escapeHtml` per the inline-not-shared convention). No React/theme/supabase
  imports in the pure module.
- **CSV routing**: traced button → builder → download on both screens.
  `onExportCsv` → `buildCountCsv` → `downloadCSV(filename, csv)` at
  `EODCountSection.tsx:642-653` and `InventoryCountSection.tsx:388-399` — both
  go through the now-BOM'd `downloadCSV`, confirmed by the
  `countExport.test.ts` BOM seam test.
- **No direct Supabase calls**: grepped both section files and
  `countExport.ts`/`ExportLocalePicker.tsx` for `supabase.from`/`supabase.rpc`
  — none found. Export reads only already-loaded store state; no new
  `db.ts` surface, no optimistic-then-revert path needed (no write).

### Critical
(none)

### Should-fix
- `src/i18n/en.json:584,617`, `src/i18n/es.json:584,617`,
  `src/i18n/zh-CN.json:584,617` — `section.eod.export.noItemsToExport` /
  `section.inventoryCount.export.noItemsToExport` are added to all three
  catalogs but never referenced by either section. Unlike
  `ExportCsvDrawer.tsx:63-66` (which shows a "Nothing to export" toast and
  returns early when `rows.length === 0`), `onExportCsv`/`onExportPdf` in
  both `EODCountSection.tsx:642-692` and `InventoryCountSection.tsx:388-438`
  have no empty-groups guard — clicking export with zero countable items
  silently downloads a header-only CSV (the PDF path at least falls back to
  the `noItems` placeholder, a *different* key). Either wire the guard
  (mirroring `ExportCsvDrawer`'s pattern) or drop the dead key from all three
  catalogs.
- `src/i18n/en.json:594,606`, `src/i18n/es.json:594,606`,
  `src/i18n/zh-CN.json:594,606` — `section.inventoryCount.export.colVendor`
  and `.groupVendor` are copy-paste leftovers from the EOD block: the
  Inventory count column set is grouped by category only
  (`countExport.ts:181-192` never references `colVendor`/`groupVendor` for
  `screen === 'inventoryCount'`). Dead keys in all three catalogs; prune to
  avoid a future reader mistaking them for load-bearing.

### Nits
- `src/screens/cmd/sections/EODCountSection.tsx:642-692` and
  `src/screens/cmd/sections/InventoryCountSection.tsx:388-438` — the
  `onExportCsv`/`onExportPdf` try/catch + `Platform.OS === 'web'` branching
  is near-identical between the two sections (only the builder params and
  toast-key namespace differ). Consistent with the spec's explicit "stays in
  the section, mirrors ReorderSection" design, but if a third count-export
  surface ever appears, this is a good candidate for a shared
  `useCountExportHandlers`-style hook.
- `src/screens/cmd/sections/EODCountSection.tsx:614-619` and
  `src/screens/cmd/sections/InventoryCountSection.tsx:353-358` — `parseCount`
  is duplicated verbatim across both sections (same 5-line body). Minor;
  low-value extraction target.
- `src/components/cmd/ExportLocalePicker.tsx:20` imports `Locale` from
  `../../i18n` directly, while both section call sites import it from
  `../../../hooks/useLocale` (which re-exports the same type). Harmless —
  both resolve to the identical type — but a single file mixing the two
  forms would be worth flagging; here it's just cross-file style drift.
