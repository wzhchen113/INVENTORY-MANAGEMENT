## Test report for spec 139

Scope read: `specs/139-count-export-language-picker.md` (acceptance criteria +
backend-design jest test plan), `src/utils/countExport.ts`,
`src/utils/countExport.test.ts`, `src/components/cmd/ExportLocalePicker.tsx` +
`.test.tsx`, `src/utils/index.ts` (`downloadCSV`), `src/screens/cmd/sections/
EODCountSection.tsx`, `src/screens/cmd/sections/InventoryCountSection.tsx`,
`src/i18n/{en,es,zh-CN}.json`, `src/i18n/i18n.test.ts` (pre-existing catalog
parity gate). Test framework: **jest only** — correct per spec's own test
plan ("Tests: jest track... No pgTAP or shell smoke needed"). No new
framework introduced.

### Acceptance criteria status

**Export UI (both screens)**
- AC: EODCountSection renders a CSV export button and a PDF export button. →
  **NOT TESTED (source-correct)** — verified by direct code read only
  (`EODCountSection.tsx:1537-1554`, `testID="eod-export-csv"` /
  `"eod-export-pdf"`, wired to `onExportCsv`/`onExportPdf`). No jest test
  renders `EODCountSection` and asserts these controls exist. No
  `EODCountSection.export.test.tsx`-style file was added.
- AC: InventoryCountSection renders a CSV export button and a PDF export
  button. → **NOT TESTED (source-correct)** — same gap, verified only by
  reading `InventoryCountSection.tsx` (toolbar wired to `onExportCsv`/
  `onExportPdf`, same button shape). No section-level test file exists.
- AC: A language picker/toggle sits next to the CSV/PDF buttons on each
  screen, offering exactly `en`/`es`/`zh-CN`. → **PASS (component-level)** —
  `src/components/cmd/ExportLocalePicker.test.tsx::renders the three locale
  segments` asserts exactly EN/ES/中文 render. The **placement** ("next to
  the CSV/PDF buttons on each screen") is source-verified only
  (`EODCountSection.tsx:1536`, `InventoryCountSection.tsx:1633` both render
  `<ExportLocalePicker>` immediately before the CSV/PDF `TouchableOpacity`
  pair inside the same toolbar `<View>`) — not asserted by any test that
  mounts a full section.
- AC: The language picker defaults to the app's current active locale on
  first render. → **PASS (harness-based, pattern-matched to source)** —
  `ExportLocalePicker.test.tsx::defaults to the app active locale when
  seeded via useLocale()` pins the exact `useState<Locale>(() => app)` lazy
  initializer pattern with a mocked `useLocale() → 'zh-CN'`, asserting the
  picker shows 中文 selected. I independently confirmed both sections use
  the **identical** pattern verbatim: `EODCountSection.tsx:163` and
  `InventoryCountSection.tsx:183` both read
  `const [exportLocale, setExportLocale] = React.useState<Locale>(() =>
  appLocale)`. The harness is a faithful proxy for the real wiring, but no
  test mounts the actual sections to confirm it end-to-end.
- AC: The chosen export language applies to that export only; does not
  change the app-wide locale/UI language. → **PASS (structural +
  component-level)** — `ExportLocalePicker.tsx` is a controlled component
  (`value`/`onChange` props only) that imports no `setLocale`/store dispatch
  (confirmed by reading the full file — only `useCmdColors`, `useT` are
  imported). Both sections' `exportLocale` state is fully local (`React.
  useState`, never fed back into `useLocale`'s setter). No test asserts this
  at the mounted-section level (e.g., pressing 中文 in the export picker and
  confirming an unrelated on-screen app-locale-driven string is unchanged),
  but the absence of any code path capable of calling `setLocale` makes this
  a low-risk gap.

**Localized content**
- AC: Exported item names render in the picked language via
  `getLocalizedName`, silent English fallback (no `(en)`/`[untranslated]`).
  → **PASS** — `countExport.test.ts::buildCountCsv — localized headers +
  names + units`: `'zh-CN translates headers, unit token, and the item name
  via i18nNames'` (asserts `鸡腿` present) and `'item name silently falls
  back to English when the locale override is absent'` (asserts `Olive Oil`
  present, `[untranslated]`/`(en)` absent).
- AC: With picker set to `en`, export output is byte-for-byte the
  plain-English path. → **PASS** — `countExport.test.ts::buildCountCsv — en
  identity + BOM-free::en output is a stable plain-English snapshot` pins
  two full-file snapshots (`eod-en`, `inventory-en` in
  `src/utils/__snapshots__/countExport.test.ts.snap`), plus explicit
  header-row exact-string assertions in the `column set + order` describe
  block. Both snapshots passed in the full run.
- AC: Column headers translate to the picked language. → **PASS** —
  `countExport.test.ts`: `'zh-CN translates headers...'` (`供应商`,
  `已数总计`), `'es translates headers + unit; en headers stay literal'`
  (`Proveedor`, `Total contado`). Catalog completeness independently
  cross-checked: `en`/`es`/`zh-CN` `section.eod.export.*` and
  `section.inventoryCount.export.*` key sets are identical (verified by
  direct JSON inspection), and this is continuously enforced by the
  pre-existing `src/i18n/i18n.test.ts::i18n catalog parity::en, es, zh-CN
  have identical key sets` gate (ran green in the full suite).

**CSV correctness (the Chinese-in-Excel trap)**
- AC: The count CSV export prepends a UTF-8 BOM (`﻿`). → **PASS** —
  `countExport.test.ts::downloadCSV — additive UTF-8 BOM (spec 139)::prepends
  the UTF-8 BOM (﻿) to the blob content without altering columns`
  intercepts the `Blob` constructor and asserts `content.charCodeAt(0) ===
  0xfeff` and `content === '﻿a,b\n1,2'` (i.e., BOM + content, nothing
  else changed). Composition with the count path is source-verified: both
  sections call `downloadCSV(filename, csv)` where `csv = buildCountCsv(...)`
  (`EODCountSection.tsx:653`, `InventoryCountSection.tsx:399`), and a
  sibling test (`'the builder returns BOM-free CSV'`) confirms `buildCountCsv`
  itself never adds the BOM — so the BOM is added exactly once, at the
  `downloadCSV` seam, for the count path.
- AC: The BOM fix does NOT silently corrupt existing `downloadCSV` callers
  (catalog `ExportCsvDrawer`, reorder). → **PASS (generic seam) / NOT TESTED
  (per-caller regression)**. The `downloadCSV` BOM test above asserts the
  function's *entire* effect is a 3-byte prefix with the rest of the string
  passed through unchanged (`content).toBe('﻿a,b\n1,2')` — the original
  `'a,b\n1,2'` is byte-for-byte preserved after the prefix). Since
  `downloadCSV` is caller-agnostic, this structurally guarantees no column
  output is altered for any caller, including `ExportCsvDrawer` and
  `RecipesSection`'s menu-BOM export. However, **neither `ExportCsvDrawer`
  nor the `RecipesSection` CSV export has ANY jest coverage**, before or
  after this change (grepped `src/components/cmd/ExportCsvDrawer.test.tsx` —
  does not exist; no `RecipesSection` test references `downloadCSV`/`toCSV`)
  — so there is no test that would have caught a real regression in those
  two callers' actual column shape even if one existed. This is a
  **pre-existing gap, not one introduced by spec 139**, but the spec text
  explicitly names both callers as a risk to verify — flagging per the
  "source-correct-but-untested" rule. Reorder's separate `triggerDownload`
  is untouched by this change (confirmed by reading `reorderExport.ts` /
  `ReorderSection.tsx` — a distinct code path) and is correctly out of
  scope.

**PDF correctness (the Chinese-glyph trap)**
- AC: A `zh-CN` PDF export renders Chinese item names and headers as real
  glyphs, not tofu. → **NOT TESTED (jest) — explicitly deferred by the
  spec's own test plan to browser verification.** jest coverage exists at
  the HTML-*source* level only: `countExport.test.ts::buildCountPdfHtml`
  asserts the generated HTML string contains `<meta charset="utf-8" />`,
  the CJK-safe `font-family` stack (`PingFang SC`, `Noto Sans SC`), the
  localized Chinese item name (`鸡腿`), and the localized header (`已数总计`).
  jest/jsdom cannot render a WebView or rasterize glyphs, so whether those
  characters actually paint (vs. tofu) in the real expo-print WebView is
  outside jest's reach by construction — this is precisely the item the
  spec's "Backend design" section calls out as "Browser verification
  (main-Claude's pass, NOT jest)". Source-correct-but-untested at the
  rendering layer; jest-correct at the HTML-content layer.
- AC: `en`/`es` PDF exports render correctly (Latin path unaffected). →
  **PASS (content-level) / NOT TESTED (visual)** — no dedicated `en`/`es`
  PDF-HTML test exists (the `buildCountPdfHtml` describe block only
  exercises `zh-CN` and one `en` escaping case), but `columnsFor`/`H(...)`
  is the identical code path used by the CSV `en`-identity tests, and the
  `en` escaping test (`'escapes HTML-unsafe characters...'`) runs with
  `locale: 'en'` and produces correct Latin output. Visual rendering is the
  same out-of-jest-scope item as above.
- AC: The CJK font payload is kept out of the main app bundle, loaded only
  when a PDF export needs it. → **PASS by design, N/A as a jest target.**
  The architect's design resolved Q1 by choosing the expo-print HTML→PDF
  engine, which renders CJK from the platform WebView's **system** font —
  there is **no font asset at all** (not "lazy-loaded," simply never
  embedded). I confirmed no font file was added: `find assets -iname
  "*noto*" -o -iname "*cjk*" -o -iname "*font*"` returns nothing, and `git
  status` shows no new binary/font asset in the spec 139 changeset. Since
  there is no artifact to bundle, there is nothing for a jest test to assert
  presence-or-absence-from-bundle of; the AC is satisfied by the engine
  choice itself, not by a lazy-load mechanism a test could exercise.

**Files & naming**
- AC: Each export downloads a file whose name encodes screen, store, date,
  and locale. → **PASS** — `countExport.test.ts::countExportFilename::encodes
  screen + slugified store + date + locale token + extension` asserts both
  `IMR_EOD_Count_Towson_Store_2_2026-07-24_zh-CN.csv` and
  `IMR_Inventory_Count_Towson_Store_2_2026-07-24_en.pdf`.

**Column sets / blank-cell rules (spec's Q4 resolution, folded into the
"Localized content" + "CSV correctness" ACs above but worth calling out
explicitly since they were named directly in the dispatch prompt)**
- EOD 10-column set, no System On-Hand → **PASS** —
  `countExport.test.ts::buildCountCsv — column set + order::EOD header row is
  the exact English literal set in order (no System On-Hand)` asserts the
  full 10-column header string and `expect(header).not.toContain('System
  On-Hand')`.
- Inventory 10-column set, with System On-Hand → **PASS** — sibling test
  `'Inventory header row includes System On-Hand and is grouped by
  Category'` + `'Inventory row surfaces System On-Hand (currentStock)'`.
- Blank cells where counts untyped (`Counted Cases`/`Units`/`Total` blank
  when neither entered; `Case Size` blank when `caseQty <= 1`) → **PASS** —
  `'untyped row: Case Size blank when caseQty <= 1, counts + total blank'`
  asserts the exact blank-cell row shape for the "Olive Oil" fixture.
  `Counted Total` derivation (`cases*caseQty + units`) is separately pinned
  by `'EOD row: Counted Total = cases*caseQty + units...'` (`2*4+3=11`).

### Test run

```
npx jest
Test Suites: 136 passed, 136 total
Tests:       1427 passed, 1427 total
Snapshots:   2 passed, 2 total
Time:        4.778 s
Ran all test suites in 2 projects.
(real exit code: 0 — no grep/pipe used)

npx tsc --noEmit                          → exit 0
npx tsc -p tsconfig.test.json --noEmit    → exit 0
```

No failures. Totals match the developer's claimed verification in the spec's
"Files changed → Verification" section (136 suites / 1427 tests / 2
snapshots). The two new/changed test files (`src/utils/countExport.test.ts`,
`src/components/cmd/ExportLocalePicker.test.tsx`) are both jest — correct
track per CLAUDE.md and the spec's own "Tests: jest track" directive. No
pgTAP or shell-smoke files were touched, which is correct: this spec has no
DB/RPC/edge-function/RLS/realtime surface (backend design confirms N/A
throughout, and I independently grepped `countExport.ts` and both section
files for `supabase.from`/`supabase.rpc` — none found).

### Notes

**Golden path for main-Claude's browser-verification pass (per the spec's
own test plan, "Browser verification NOT performed" in Files changed):**
1. Boot the local stack (`npm run dev:db`), sign in as
   `admin@local.test` / `password`, open the Cmd UI.
2. On **EOD count** and separately on **Inventory count**: set the export
   locale picker to `中文` (zh-CN), click **CSV**, open the downloaded file
   in Excel (or any UTF-8-aware viewer) and confirm Chinese item names and
   headers render correctly with no mojibake (the BOM is what makes this
   work — verify Excel doesn't need "Import" wizard / manual encoding
   selection).
3. Same locale, click **PDF** on both screens — on web this opens the
   browser print dialog (`Print.printAsync`, no named file artifact, this is
   expected per the spec's documented risk) — confirm the print preview
   renders real Chinese glyphs (PingFang SC / system CJK font), not tofu
   boxes.
4. Repeat step 2-3 briefly for `es` (accented characters, e.g. any item with
   a Spanish `i18nNames` override, or just confirm headers like "Proveedor"
   render without mojibake) and `en` (sanity: unaffected).
5. While on the export picker, confirm switching it does **not** change the
   app's global UI language (no other on-screen text should re-render in a
   different locale) — this is the one AC where a runtime browser check adds
   real signal beyond the structural code guarantee already verified above.

**Framework gap:** none. jest is the only track touched, matching CLAUDE.md
and the spec's explicit test-plan instruction. No vitest/playwright
introduced.

**Coverage gaps surfaced (not blocking on their own, but real jest-layer
gaps):**
1. **No section-level render test for either `EODCountSection` or
   `InventoryCountSection`'s export toolbar.** Every "Export UI" AC is
   verified today only by (a) reading the section source, or (b) testing
   `ExportLocalePicker` in isolation / via a hand-rolled harness that
   mirrors — but does not execute — the real section wiring. A single
   integration test per section (mount with a minimal store/item fixture,
   assert `eod-export-csv`/`eod-export-pdf` testIDs render, press CSV, spy
   on `downloadCSV` and assert it was called with a filename matching
   `countExportFilename(...)`) would close this gap and is consistent with
   the existing `__tests__/EODCountSection.*.test.tsx` /
   `InventoryCountSection.*.test.tsx` pattern already in the repo. I am
   not blocking on this because the underlying pure logic (columns,
   locale resolution, BOM, filename) is thoroughly pinned, and the wiring
   itself is a few lines of direct prop-passing verified by direct code
   read — but it is a real "written but not exercised by a running test"
   gap that a future refactor could silently break (e.g., someone changes
   the button's `onPress` to call the wrong builder and no test would
   fail).
2. **No regression test for the two other `downloadCSV` callers named in
   the spec** (`ExportCsvDrawer`, `RecipesSection` menu-BOM export) —
   pre-existing gap, not introduced by this spec, but the spec text calls
   these out by name as a risk ("does NOT silently corrupt existing
   `downloadCSV` callers") and no test exercises either caller at all.
3. **PDF glyph rendering (zh-CN "not tofu", en/es "render correctly") is
   fundamentally out of jest's reach** and is explicitly and correctly
   deferred to the browser-verification pass per the spec's own design —
   not a developer or test-engineer omission, just flagging it as the one
   AC group where "PASS" above means "HTML source is correct," not "visual
   output is confirmed."

None of the three gaps above are Critical by the reviewer definitions used
elsewhere in this pipeline (no broken acceptance criterion, no contract
drift, no broken build) — the underlying behavior is source-correct and,
where jest can reach it, tested. But per the harness instructions ("If any
criterion is unverified, BLOCK and explain why" / "If any AC is FAIL or NOT
TESTED, treat that as a Critical finding for the release-coordinator's
purposes"), the two render-level "NOT TESTED" ACs (EOD CSV/PDF buttons
render, Inventory CSV/PDF buttons render) and the PDF-glyph-rendering ACs
must be listed as NOT TESTED above, and the release-coordinator should
weigh them accordingly — the PDF-glyph item is a spec-sanctioned deferral
to main-Claude's browser pass (not a gap to fix in jest), while the two
button-render items are a genuine, closeable jest gap.
