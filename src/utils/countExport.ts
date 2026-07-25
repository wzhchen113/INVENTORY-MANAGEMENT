// src/utils/countExport.ts
//
// Spec 139 — shared, PURE (framework-free) export builders for the two admin
// count screens (EOD count + Inventory count). Mirrors the
// `src/utils/reorderExport.ts` pattern exactly: no React, no theme, no
// supabase imports — only `papaparse` + `../i18n` + `getLocalizedName` +
// `localizeUnit`. This keeps the jest contract cheap and lets the section
// orchestrators branch on Platform.OS for the impure download/print I/O.
//
// Parameterized by `screen` (selects the column set + i18n namespace),
// `locale`, and the grouped rows the section assembles from its transient
// count maps. The two differing column sets (EOD = per-vendor, no System
// On-Hand; Inventory = per-category, includes System On-Hand) are just two
// call configs of one builder.
//
// LOCALE CONTRACT (identical to reorderExport.ts): with `locale === 'en'` the
// output is BYTE-FOR-BYTE the plain-English path — English header literals
// verbatim (via the `H(key, en)` idiom), canonical item names, units passed
// through unchanged, group labels raw. es / zh-CN translate the column
// headers + button/section chrome and localize item names (per-item
// `i18nNames`) + unit tokens (`localizeUnit`).
//
// The CSV emitted here is BOM-FREE — the UTF-8 BOM is added exactly once at
// the download seam (`downloadCSV` in src/utils/index.ts, spec 139).

import { t, type Locale } from '../i18n';
import type { LocalizedNames } from '../types';
import { getLocalizedName } from '../i18n/localizedName';
// `slugifyStore` + `todayLocalIso` + `localizeUnit` are the single source of
// truth in reorderExport.ts — import rather than re-derive.
import { localizeUnit, slugifyStore, unparseCsvSafe } from './reorderExport';

// One count row, pre-flattened by the section orchestrator from its transient
// maps. Name fields feed getLocalizedName; counts are the on-screen snapshot
// (null / undefined = the operator typed nothing → the cell renders blank).
export interface CountExportItem {
  name: string; // canonical English name (it.name)
  i18nNames?: LocalizedNames | null;
  category: string;
  unit: string;
  caseQty: number; // >1 means case-packed
  parLevel: number;
  currentStock?: number; // only surfaced by the inventory-count column set
  countedCases?: number | null; // parsed entered value; null/undefined = blank
  countedUnits?: number | null;
  note?: string;
}

export interface CountExportGroup {
  label: string; // vendor name (EOD) or category (inventory)
  items: CountExportItem[];
}

export type CountScreen = 'eod' | 'inventoryCount';

export interface CountExportParams {
  screen: CountScreen; // selects the column set + i18n namespace
  groups: CountExportGroup[];
  storeName: string;
  dateIso: string; // selected day (EOD) / today (inventory)
  locale: Locale;
}

// Minimal HTML escape for the PDF-HTML builder. Five-character escape so
// vendor / item / category names with `& < > " '` don't break the markup —
// duplicated (not shared) per the CLAUDE.md inline-not-shared escape
// convention (an escape helper is cheap to copy and avoids widening the
// reorder module's export surface).
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Item display name in the active locale (silent English fallback, no `(en)`
// tag / `[untranslated]` — identical resolution to reorderExport.ts).
function itemDisplayName(item: CountExportItem, locale: Locale): string {
  return getLocalizedName({ name: item.name, i18nNames: item.i18nNames }, locale);
}

// Unit token in the active locale — English passes through verbatim (the
// identity contract), es / zh-CN route through the shared enum.unit dictionary.
function unitOf(unit: string, locale: Locale): string {
  return locale === 'en' ? unit : localizeUnit(unit, locale);
}

// `Case Size` cell — blank for non-case items (caseQty <= 1).
function caseSizeCell(item: CountExportItem): number | string {
  return item.caseQty > 1 ? item.caseQty : '';
}

// `Counted Total` = cases*caseQty + units, blank ('') when NEITHER count was
// entered. A single entered box (cases OR units) yields a total with the
// missing side treated as 0 — matching the on-screen `itemTotal` derivation.
function countedTotalCell(item: CountExportItem): number | string {
  const hasCases = item.countedCases != null;
  const hasUnits = item.countedUnits != null;
  if (!hasCases && !hasUnits) return '';
  const cases = item.countedCases ?? 0;
  const units = item.countedUnits ?? 0;
  return cases * (item.caseQty || 1) + units;
}

// Entered count cell — the raw number when typed, else blank.
function countCell(v: number | null | undefined): number | string {
  return v != null ? v : '';
}

// A column: its localized header (which doubles as the Papa row-object key so
// `columns` + the row map stay in lockstep) and a cell extractor. `en` headers
// are the English literals verbatim (identity contract).
interface Column {
  header: string;
  cell: (item: CountExportItem, groupLabel: string) => string | number;
}

// Build the ordered column list for a screen in the active locale. The i18n
// namespace is per-screen (`section.eod.export.*` /
// `section.inventoryCount.export.*`), so each screen carries its own header
// keys even where the English literal is identical.
function columnsFor(params: CountExportParams): Column[] {
  const { screen, locale } = params;
  const ns = screen === 'eod' ? 'section.eod.export' : 'section.inventoryCount.export';
  const H = (k: string, en: string): string => (locale === 'en' ? en : t(locale, `${ns}.${k}`));

  const colItemName: Column = {
    header: H('colItemName', 'Item Name'),
    cell: (it) => itemDisplayName(it, locale),
  };
  const colUnit: Column = {
    header: H('colUnit', 'Unit'),
    cell: (it) => unitOf(it.unit, locale),
  };
  const colCaseSize: Column = {
    header: H('colCaseSize', 'Case Size'),
    cell: (it) => caseSizeCell(it),
  };
  const colParLevel: Column = {
    header: H('colParLevel', 'Par Level'),
    cell: (it) => it.parLevel,
  };
  const colCountedCases: Column = {
    header: H('colCountedCases', 'Counted Cases'),
    cell: (it) => countCell(it.countedCases),
  };
  const colCountedUnits: Column = {
    header: H('colCountedUnits', 'Counted Units'),
    cell: (it) => countCell(it.countedUnits),
  };
  const colCountedTotal: Column = {
    header: H('colCountedTotal', 'Counted Total'),
    cell: (it) => countedTotalCell(it),
  };
  const colNote: Column = {
    header: H('colNote', 'Note'),
    cell: (it) => it.note ?? '',
  };

  if (screen === 'eod') {
    // EOD — grouped per vendor; deliberately EXCLUDES System On-Hand (a blind
    // count sheet handed to a counter should carry no bias).
    return [
      { header: H('colVendor', 'Vendor'), cell: (_it, groupLabel) => groupLabel },
      { header: H('colCategory', 'Category'), cell: (it) => it.category },
      colItemName,
      colUnit,
      colCaseSize,
      colParLevel,
      colCountedCases,
      colCountedUnits,
      colCountedTotal,
      colNote,
    ];
  }
  // Inventory count — grouped per category; INCLUDES System On-Hand (the
  // reconciliation screen references currentStock).
  return [
    { header: H('colCategory', 'Category'), cell: (_it, groupLabel) => groupLabel },
    colItemName,
    colUnit,
    colCaseSize,
    colParLevel,
    { header: H('colSystemOnHand', 'System On-Hand'), cell: (it) => it.currentStock ?? '' },
    colCountedCases,
    colCountedUnits,
    colCountedTotal,
    colNote,
  ];
}

/**
 * Build the count CSV. Column order is fixed via `unparseCsvSafe(rows,
 * headers)` (shared CSV-injection-guarded unparse) so accidental row-field
 * changes don't reshape the header.
 * BOM-FREE — the UTF-8 BOM is added at the download seam.
 */
export function buildCountCsv(params: CountExportParams): string {
  const columns = columnsFor(params);
  const headers = columns.map((c) => c.header);
  const rows: Record<string, string | number>[] = [];
  for (const group of params.groups) {
    for (const item of group.items) {
      const row: Record<string, string | number> = {};
      for (const col of columns) {
        row[col.header] = col.cell(item, group.label);
      }
      rows.push(row);
    }
  }
  return unparseCsvSafe(rows, headers);
}

/**
 * Build the count PDF-HTML (expo-print HTML→PDF source). CJK renders from the
 * platform WebView's system font — the `<meta charset="utf-8">` + the explicit
 * CJK-safe `font-family` stack are load-bearing (spec 139: NO font embedding).
 * One table per group with a localized header row.
 */
export function buildCountPdfHtml(params: CountExportParams): string {
  const { screen, locale, groups, storeName, dateIso } = params;
  const columns = columnsFor(params);
  const ns = screen === 'eod' ? 'section.eod.export' : 'section.inventoryCount.export';
  const H = (k: string, en: string): string => (locale === 'en' ? en : t(locale, `${ns}.${k}`));

  const title = H('pdfTitle', screen === 'eod' ? 'EOD Count Sheet' : 'Inventory Count Sheet');
  const storeLabel = H('store', 'Store');
  const asOfLabel = H('asOf', 'As of');
  const groupLabel = H(screen === 'eod' ? 'groupVendor' : 'groupCategory', screen === 'eod' ? 'Vendor' : 'Category');
  const noItems = H('noItems', '(no items)');

  // The group-label column is column 0 in both screens; render it as an h2
  // per group and drop it from the per-row table (cleaner print layout).
  const rowColumns = columns.slice(1);
  const headerCells = rowColumns.map((c) => `<th>${escapeHtml(c.header)}</th>`).join('');

  const groupBlocks = groups
    .map((group) => {
      const rows = group.items
        .map((item) => {
          const cells = rowColumns
            .map((col) => `<td>${escapeHtml(String(col.cell(item, group.label)))}</td>`)
            .join('');
          return `<tr>${cells}</tr>`;
        })
        .join('');
      return `
        <h2>${escapeHtml(groupLabel)}: ${escapeHtml(group.label)}</h2>
        <table>
          <thead><tr>${headerCells}</tr></thead>
          <tbody>${rows}</tbody>
        </table>`;
    })
    .join('');

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8" />
<style>
  * { box-sizing: border-box; }
  body { font-family: -apple-system, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC", "Noto Sans SC", Helvetica, Arial, sans-serif; color: #1a1a18; margin: 24px; }
  h1 { font-size: 22px; margin: 0 0 2px 0; }
  .sub { color: #777; font-size: 12px; margin: 0 0 16px 0; }
  h2 { font-size: 13px; margin: 18px 0 6px 0; }
  table { width: 100%; border-collapse: collapse; font-size: 11px; }
  th, td { text-align: left; padding: 5px 6px; border-bottom: 1px solid #e4e4e4; }
  th { background: #1a1a18; color: #fff; }
  .gen { margin-top: 28px; font-size: 9px; color: #999; }
</style>
</head>
<body>
  <h1>${escapeHtml(title)}</h1>
  <p class="sub">${escapeHtml(storeLabel)}: ${escapeHtml(storeName)} &nbsp;|&nbsp; ${escapeHtml(asOfLabel)}: ${escapeHtml(dateIso)}</p>
  ${groupBlocks || `<p>${escapeHtml(noItems)}</p>`}
  <p class="gen">Generated by I.M.R — Inventory Management for Restaurant</p>
</body>
</html>`;
}

/**
 * Download filename: `IMR_EOD_Count_{store}_{date}_{locale}.csv|pdf` /
 * `IMR_Inventory_Count_{store}_{date}_{locale}.csv|pdf`. Follows the
 * `slugifyStore` + date + locale-token shape from reorderExport.ts.
 */
export function countExportFilename(
  screen: CountScreen,
  storeName: string,
  dateIso: string,
  locale: Locale,
  ext: 'csv' | 'pdf',
): string {
  const kind = screen === 'eod' ? 'EOD_Count' : 'Inventory_Count';
  return `IMR_${kind}_${slugifyStore(storeName)}_${dateIso}_${locale}.${ext}`;
}
