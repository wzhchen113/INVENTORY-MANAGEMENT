## Test report for spec 100

### Acceptance criteria status

- AC1: In zh-CN, every item name on the reorder tab renders its `i18n_names['zh-CN']` value when present, falling back silently to the English `name` when absent → PASS — `src/screens/staff/screens/Reorder.test.tsx::Reorder — localization (spec 100) > renders the item name in zh-CN when an override is present` + `falls back to English silently when the override is missing for the locale`

- AC2: The reorder RPC `report_reorder_list` emits `i18n_names` per item; `mapReorderVendor` + the `ReorderItem` type carry it; the admin desktop Reorder section is unaffected → PASS (two parts): pgTAP — `supabase/tests/report_reorder_list_i18n_names.test.sql` (7 assertions: key-present + value-equal for override row; key-present + `{}` for empty row; JSON-object type guards on both); mapper — `src/screens/staff/lib/fetchReorder.test.ts::maps per-item i18n_names → i18nNames when present` + `coalesces a missing/null i18n_names to {} (pre-migration + no-override safe)`. Admin `db.ts:mapReorderVendor` confirmed untouched (`git diff HEAD -- src/lib/db.ts` is empty).

- AC3: In zh-CN (and es), the "case/cases" suggested-order noun renders localized on the staff reorder screen. The shared `reorderExport.ts` util is NOT modified → PASS — `Reorder.test.tsx::localizes the plural case noun in es and normalizes the unit casing` (asserts "Pedir: 2 cajas · 48 case") + `uses the singular case key when exactly one case is suggested` (asserts "Pedir: 1 caja · 24 case"). Confirmed `src/utils/reorderExport.ts` has zero diff and its 22-test suite (`reorderExport.test.ts`) is still fully green.

- AC4: On the staff reorder render, the raw `item.unit` token (e.g. "CASE") is display-normalized to lowercase ("case") on the breakdown and suggested-order lines. No write to `catalog_ingredients.unit` → PASS — `Reorder.test.tsx::normalizes the raw unit token on the on-hand/par breakdown line` (asserts "on hand 0.5 lb · par 12 lb" and "Order: 11.5 lb" from raw "LB"); the plural/singular case tests assert the sub-unit total shows lowercase "case" from raw "CASE". The `normalizeUnit` helper is screen-local in `Reorder.tsx` and is never imported by the shared util.

- AC5: Admin desktop Reorder output and the CSV/text/PDF export bytes are byte-for-byte unchanged → PASS — `reorderExport.test.ts` (22 tests covering CSV, text, PDF, money formatting, all green). `git diff HEAD -- src/utils/reorderExport.ts` is empty (no diff). Admin `db.ts:mapReorderVendor` has no diff.

- AC6: The "EOD" badge renders localized in zh-CN / es (new catalog key, mirroring `reorder.source.stockFallback`) → PASS — `Reorder.test.tsx::routes the EOD badge through the catalog (reorder.source.eod)` (renders under zh-CN and confirms "EOD" text appears) + `shows STOCK FALLBACK (localized) when the source is stock, not EOD` (confirms "库存回退" appears and "EOD" is absent). The `reorder.source.eod` key exists in all three catalogs with value "EOD".

- AC7: Vendor grouping headers and vendor chips remain English (no change) → PASS — No localization was applied to `vendor.vendorName` in `Reorder.tsx`. The spec explicitly states vendor names are out of scope (proper nouns) and no `i18n_names` exists for vendors in the schema. Confirmed by code review of `VendorCard` — `vendor.vendorName` renders raw. No test asserts this because it is absence-of-change; see Notes below.

- AC8: Locale switching on the reorder screen re-translates the newly-localized strings (item names, case noun, EOD badge) live — reactive via `useI18n()` + `useStaffStore((s) => s.locale)` → PASS — `Reorder.test.tsx` tests locale-specific renders via `useStaffStore.setState({ locale: 'zh-CN' })` / `'es'` before rendering. The `useI18n()` reactivity pattern is covered end-to-end by `useI18n.reactivity.test.tsx` (2 passing assertions). `VendorCard` subscribes to the locale slice at line 139 (`const locale = useStaffStore((s) => s.locale)`) which is the spec-099 pattern.

- AC9: New catalog keys exist in all three locales (en / es / zh-CN); the catalog-parity jest test sees them in all three → PASS — `src/screens/staff/i18n/i18n.test.ts::staff i18n catalog parity > en, es, zh-CN have identical key sets` (passes, 694 total jest tests green). All three keys (`reorder.source.eod`, `reorder.unit.case`, `reorder.unit.cases`) are present in en.json, es.json, and zh-CN.json. The parity test does a symmetric diff across all three catalogs and would fail if any key were missing.

---

### Test run

**jest (full suite):**
```
npm test -- --no-coverage
Test Suites: 66 passed, 66 total
Tests:       694 passed, 694 total
Time:        2.91 s
```
All 66 suites, all 694 tests pass. No regressions introduced.

**pgTAP DB tests:**
```
npm run test:db
PASS supabase/tests/report_reorder_list_i18n_names.test.sql (7 assertion(s) passed)
...
✗ 2/51 DB test file(s) failed
```

The spec 100 pgTAP file (`report_reorder_list_i18n_names.test.sql`) passes all 7 assertions cleanly.

The 2 failing files are:
- `supabase/tests/submit_weekly_count.test.sql` — references `public.submit_weekly_count(uuid, uuid, timestamp with time zone, jsonb, unknown)` which does not exist in the local stack (function signature mismatch)
- `supabase/tests/weekly_count_status.test.sql` — references `weekly_count_due_dow` column on `public.stores` which does not exist in the local stack

Both failures are pre-existing from spec 098 (weekly count). They appear in commits predating this spec (`78997a1 Spec 098: fix pgTAP plan count in submit_weekly_count`) and are not caused by any spec 100 change. Neither file touches `report_reorder_list`, `i18n_names`, or any localization path.

---

### Notes

**1. Vendor-name immutability test (AC7).** AC7 ("vendor grouping headers and chips remain English") is verified by code review (no localization applied to `vendor.vendorName`) and by the existing chip/filter tests that assert on raw vendor names like "Acme" and "Beta" in default locale. There is no dedicated regression test asserting that vendor names do NOT translate under zh-CN. This is a minor gap: if a future developer accidentally localizes vendor names, no test would catch it. The risk is low (no i18n source for vendors exists in the schema) but worth noting. Not a BLOCK.

**2. No literal in-browser pixel verification possible from the subagent.** The frontend developer flagged this limitation. The RNTL render-tree tests verify the text content of the rendered React tree with the correct locale fixture data, which is the appropriate test level for localized string resolution, unit normalization, and badge routing. The limitation is: RNTL does not exercise real CSS layout, native text rendering, or font glyph rendering. For this spec, none of the acceptance criteria require pixel-level verification — they all concern which string appears in the text node. The render-tree tests are sufficient evidence for the localization ACs. A real browser check would add confidence for layout-level concerns (multi-line overflow on zh-CN strings, etc.) but no AC mandates it and the spec explicitly calls out RNTL as the appropriate jest track. Not a BLOCK.

**3. Pre-existing pgTAP failures (spec 098) are CI risk.** The 2/51 pre-existing failures from spec 098 weekly-count tests will show as a red pgTAP run in CI. These are not caused by spec 100. However, per the CLAUDE.md hard rule, `release-coordinator` must not recommend SHIP_READY when the latest `test.yml` run on `main` is not green. If CI is currently failing on `main` due to spec 098, that must be resolved before this spec ships regardless of spec 100's own test status.

**4. reorderExport.ts byte-stability confirmed by two independent checks.** `git diff HEAD -- src/utils/reorderExport.ts` returns empty (no modifications), and `reorderExport.test.ts` (22 tests including CSV/text/PDF output byte checks) is green. This satisfies AC5.

**5. zh-CN singular/plural key design.** The spec notes that zh-CN has no plural form, so `reorder.unit.case` and `reorder.unit.cases` both resolve to `"{count} 箱"` in zh-CN. Both keys exist (required for parity), and the plural-branch logic in `suggestedMainLabel` still branches on `count === 1` even in zh-CN, which is harmless (same string either way). The parity test confirms both keys are present.
