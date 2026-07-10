// src/screens/staff/lib/reorderExportStaff.ts — staff-only, cost-free reorder
// export builders.
//
// Owner decision (2026-07): the staff surface shows NO cost — only order
// quantities. The shared `src/utils/reorderExport.ts` builders embed prices
// (Est. Cost CSV column, per-item `(est $X)` + subtotals in text, Est. Cost
// PDF column + Est. total footer) and are byte-for-byte shared with the ADMIN
// desktop Reorder export, so they must NOT change. These staff-local builders
// are the price-stripped mirror: same columns / layout / cases-aware Suggested
// string, minus every cost field.
//
// PURE (no React / theme / supabase), same posture as the shared util — the
// staff `shareReorder.ts` orchestrator branches on Platform.OS for the actual
// download / share I/O. The quantity-side helpers (formatQty / formatSuggested
// / formatSuggestedPdf / slug + date) are reused from the shared util so the
// Suggested figure stays identical to the on-screen and admin output; only the
// cost columns/lines are dropped here.

import Papa from 'papaparse';
import type { ReorderPayload } from '../../../types';
import { t, type Locale } from '../../../i18n';
import { getLocalizedName } from '../../../i18n/localizedName';
import {
  formatQty,
  formatSuggested,
  formatSuggestedPdfParts,
  localizeUnit,
  todayLocalIso,
} from '../../../utils/reorderExport';

// 2026-07 — localized downloads. Same posture as the shared admin builders:
// `locale === 'en'` yields byte-identical output; es / zh-CN translate the
// chrome, the case noun, the unit token, and item names (via each item's
// i18n_names, which the staff fetchReorder mapper already surfaces). The
// export-label keys live in the shared `reorderExport.*` namespace of the
// admin catalog (src/i18n) — units are shared vocabulary and these export
// files already import from the shared util, so there is one dictionary.
type ItemT = ReorderPayload['vendors'][number]['items'][number];
const nameOf = (item: ItemT, locale: Locale): string =>
  getLocalizedName({ name: item.itemName, i18nNames: item.i18nNames }, locale);
const unitOf = (unit: string, locale: Locale): string =>
  locale === 'en' ? unit : localizeUnit(unit, locale);

// CSV — same column set as buildReorderCsv MINUS the 'Est. Cost' column, PLUS
// a 'Needs Order' column (2026-07) so both the needs-to-order and the have-
// enough-stock rows are present and distinguishable, matching the two on-screen
// sections. Rows come from ALL displayed items.
export function buildStaffReorderCsv(payload: ReorderPayload, locale: Locale = 'en'): string {
  const H = (k: string, en: string) => (locale === 'en' ? en : t(locale, k));
  const cVendor = H('reorderExport.colVendor', 'Vendor');
  const cNeeds = H('reorderExport.colNeedsOrder', 'Needs Order');
  const cItemName = H('reorderExport.colItemName', 'Item Name');
  const cOnHand = H('reorderExport.colOnHand', 'On Hand');
  const cPendingPo = H('reorderExport.colPendingPo', 'Pending PO');
  const cParLevel = H('reorderExport.colParLevel', 'Par Level');
  const cSuggestedQty = H('reorderExport.colSuggestedQty', 'Suggested Qty');
  const cCases = H('reorderExport.colCases', 'Cases');
  const cUnitsPerCase = H('reorderExport.colUnitsPerCase', 'Units Per Case');
  const cUnit = H('reorderExport.colUnit', 'Unit');
  const cFlags = H('reorderExport.colFlags', 'Flags');
  const cEodAt = H('reorderExport.colEodCountedAt', 'EOD Counted At');
  const yes = locale === 'en' ? 'yes' : t(locale, 'reorderExport.yes');
  const no = locale === 'en' ? 'no' : t(locale, 'reorderExport.no');
  const columns = [
    cVendor,
    cNeeds,
    cItemName,
    cOnHand,
    cPendingPo,
    cParLevel,
    cSuggestedQty,
    cCases,
    cUnitsPerCase,
    cUnit,
    cFlags,
    cEodAt,
  ];
  const rows: Record<string, string | number>[] = [];
  for (const vendor of payload.vendors) {
    for (const item of vendor.items) {
      const isCase = item.suggestedCases != null;
      rows.push({
        [cVendor]: vendor.vendorName,
        [cNeeds]: item.needsOrder === false ? no : yes,
        [cItemName]: nameOf(item, locale),
        [cOnHand]: item.onHand,
        [cPendingPo]: item.pendingPoQty,
        [cParLevel]: item.parLevel,
        [cSuggestedQty]: isCase ? item.suggestedUnits : item.suggestedQty,
        [cCases]: item.suggestedCases != null ? item.suggestedCases : '',
        [cUnitsPerCase]: item.caseQty > 1 ? item.caseQty : '',
        [cUnit]: unitOf(item.unit, locale),
        [cFlags]: (item.flags || []).join(', '),
        [cEodAt]: vendor.eodSubmittedAt || '',
      });
    }
  }
  return Papa.unparse(rows, { columns });
}

// Plain text — TWO sections mirroring the screen (2026-07): NEEDS TO ORDER
// (below par, cases-aware Suggested figure) then HAVE ENOUGH STOCK (at/above
// par, on-hand). NO cost. Footer carries the count of items to order.
export function buildStaffReorderText(
  payload: ReorderPayload,
  storeName: string,
  locale: Locale = 'en',
): string {
  const L = (k: string, en: string, vars?: Record<string, string | number>) =>
    locale === 'en' ? en : t(locale, k, vars);
  const date = (payload.asOfDate && payload.asOfDate.slice(0, 10)) || todayLocalIso();
  const lines: string[] = [];
  lines.push(L('reorderExport.listTitle', 'I.M.R — Reorder list'));
  lines.push(`${L('reorderExport.store', 'Store')}: ${storeName}`);
  lines.push(`${L('reorderExport.asOf', 'As of')}: ${date}`);
  lines.push('');

  const section = (
    title: string,
    keep: (it: ItemT) => boolean,
    itemLine: (it: ItemT) => string,
  ) => {
    const groups = payload.vendors
      .map((v) => ({ v, items: v.items.filter(keep) }))
      .filter((g) => g.items.length > 0);
    lines.push(`=== ${title} ===`);
    if (groups.length === 0) {
      lines.push(`  ${L('reorderExport.none', '(none)')}`);
      lines.push('');
      return;
    }
    for (const { v, items } of groups) {
      const sourceLabel =
        v.onHandSource === 'eod'
          ? L('reorderExport.sourceEod', 'EOD')
          : L('reorderExport.sourceStock', 'STOCK FALLBACK');
      lines.push(`${v.vendorName || L('reorderExport.unnamedVendor', 'unnamed vendor')} — ${sourceLabel}`);
      if (v.nextDeliveryDate) lines.push(`  ${L('reorderExport.nextDelivery', 'next delivery')}: ${v.nextDeliveryDate}`);
      for (const item of items) lines.push(itemLine(item));
      lines.push('');
    }
  };

  // Section titles keep the English uppercase in en; localized otherwise.
  section(
    locale === 'en' ? 'NEEDS TO ORDER' : t(locale, 'reorderExport.needsToOrder').toUpperCase(),
    (it) => it.needsOrder !== false,
    (item) => `  - ${nameOf(item, locale)}: ${formatSuggested(item, locale)}`,
  );
  section(
    locale === 'en' ? 'HAVE ENOUGH STOCK' : t(locale, 'reorderExport.haveEnough').toUpperCase(),
    (it) => it.needsOrder === false,
    (item) =>
      locale === 'en'
        ? `  - ${item.itemName}: on hand ${formatQty(item.onHand)} ${item.unit}`.trimEnd()
        : `  - ${nameOf(item, locale)}: ${t(locale, 'reorderExport.onHandLine', {
            qty: formatQty(item.onHand),
            unit: unitOf(item.unit, locale),
          })}`.trimEnd(),
  );

  lines.push(`${L('reorderExport.itemsToOrder', 'Total items to order')}: ${payload.kpis.itemCount}`);
  return lines.join('\n');
}

// Minimal five-character HTML escape (inlined — the shared util's copy is not
// exported; same defense-in-depth posture as the edge-function templates).
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// PDF HTML — TWO colour-coded sections mirroring the screen (2026-07): NEEDS
// TO ORDER (red) then HAVE ENOUGH STOCK (green), each with per-vendor tables of
// that section's items. NO cost. The section boxes replace the per-row status
// column.
export function buildStaffReorderPdfHtml(
  payload: ReorderPayload,
  storeName: string,
  locale: Locale = 'en',
): string {
  const L = (k: string, en: string, vars?: Record<string, string | number>) =>
    locale === 'en' ? en : t(locale, k, vars);
  const date = (payload.asOfDate && payload.asOfDate.slice(0, 10)) || todayLocalIso();

  // `isNeeds` drops the redundant Unit column (the unit already rides inside the
  // Suggested string) and paints ONLY the "N cs" case count red. The enough box
  // keeps the Unit column (it labels the On-Hand figure).
  const vendorBlock = (
    vendor: ReorderPayload['vendors'][number],
    items: typeof vendor.items,
    cls: string,
    isNeeds: boolean,
  ) => {
    const sourceLabel =
      vendor.onHandSource === 'eod'
        ? L('reorderExport.sourceEod', 'EOD')
        : L('reorderExport.sourceStock', 'STOCK FALLBACK');
    const daysLabel =
      vendor.daysUntilNextDelivery === 0
        ? L('reorderExport.deliveryToday', 'today')
        : vendor.daysUntilNextDelivery === 1
          ? L('reorderExport.deliveryTomorrow', 'tomorrow')
          : L('reorderExport.deliveryInDays', `in ${vendor.daysUntilNextDelivery} days`, {
              days: vendor.daysUntilNextDelivery,
            });
    const vendorName = vendor.vendorName || L('reorderExport.unnamedVendor', 'unnamed vendor');
    const subHeader = `${escapeHtml(vendorName)} &middot; ${L('reorderExport.source', 'Source')}: ${sourceLabel} &middot; ${L('reorderExport.nextDelivery', 'Next delivery')}: ${escapeHtml(vendor.nextDeliveryDate || '—')} (${daysLabel})`;
    const rows = items
      .map((item) => {
        const { main, sub } = formatSuggestedPdfParts(item, locale);
        // NEEDS: the case count is the manager's action figure → red. Non-case
        // needs items (no cases) stay default. ENOUGH: plain (Suggested is 0).
        const mainCls = isNeeds && item.suggestedCases != null ? 'strong cs-red' : 'strong';
        const suggestedCell = sub
          ? `<span class="${mainCls}">${escapeHtml(main)}</span><span class="sub-unit"> &middot; ${escapeHtml(sub)}</span>`
          : `<span class="${mainCls}">${escapeHtml(main)}</span>`;
        const unitCell = isNeeds ? '' : `<td>${escapeHtml(unitOf(item.unit, locale))}</td>`;
        return `
          <tr>
            <td>${escapeHtml(nameOf(item, locale))}</td>
            <td class="num">${formatQty(item.onHand)}</td>
            <td class="num">${formatQty(item.pendingPoQty)}</td>
            <td class="num">${formatQty(item.parLevel)}</td>
            <td class="num">${suggestedCell}</td>
            ${unitCell}
          </tr>`;
      })
      .join('');
    const unitHead = isNeeds ? '' : `<th>${L('reorderExport.colUnit', 'Unit')}</th>`;
    return `
      <h2 class="${cls}">${subHeader}</h2>
      <table class="${cls}">
        <thead>
          <tr>
            <th>${L('reorderExport.colItem', 'Item')}</th><th class="num">${L('reorderExport.colOnHand', 'On Hand')}</th><th class="num">${L('reorderExport.colPending', 'Pending')}</th>
            <th class="num">${L('reorderExport.colPar', 'Par')}</th><th class="num">${L('reorderExport.colSuggested', 'Suggested')}</th>${unitHead}
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>`;
  };

  const section = (
    title: string,
    cls: string,
    isNeeds: boolean,
    keep: (it: ItemT) => boolean,
  ) => {
    const groups = payload.vendors
      .map((v) => ({ v, items: v.items.filter(keep) }))
      .filter((g) => g.items.length > 0);
    const body = groups.length
      ? groups.map((g) => vendorBlock(g.v, g.items, cls, isNeeds)).join('')
      : `<p class="none">${L('reorderExport.none', '(none)')}</p>`;
    return `<h1 class="section ${cls}">${title}</h1>${body}`;
  };

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8" />
<style>
  * { box-sizing: border-box; }
  body { font-family: -apple-system, Helvetica, Arial, sans-serif; color: #1a1a18; margin: 24px; }
  h1.title { font-size: 22px; margin: 0 0 2px 0; }
  .sub { color: #777; font-size: 12px; margin: 0 0 16px 0; }
  h1.section { font-size: 15px; margin: 22px 0 8px 0; text-transform: uppercase; letter-spacing: 0.5px; }
  h1.section.needs { color: #b23030; }
  h1.section.enough { color: #2e7d1e; }
  h2 { font-size: 13px; margin: 16px 0 6px 0; }
  h2.needs { color: #b23030; }
  h2.enough { color: #2e7d1e; }
  table { width: 100%; border-collapse: collapse; font-size: 11px; }
  th, td { text-align: left; padding: 5px 6px; border-bottom: 1px solid #e4e4e4; }
  th { background: #1a1a18; color: #fff; }
  table.needs th { background: #b23030; }
  table.enough th { background: #2e7d1e; }
  td.num, th.num { text-align: right; }
  td.strong, .strong { font-weight: 700; }
  .cs-red { color: #b23030; }
  .sub-unit { font-weight: 400; font-size: 9px; color: #777; }
  .none { color: #999; font-size: 11px; margin: 4px 0 0 0; }
  .footer { margin-top: 20px; font-size: 12px; font-weight: 700; }
  .gen { margin-top: 28px; font-size: 9px; color: #999; }
</style>
</head>
<body>
  <h1 class="title">I.M.R — ${L('reorderExport.title', 'Per-Vendor Reorder Suggestions')}</h1>
  <p class="sub">${L('reorderExport.store', 'Store')}: ${escapeHtml(storeName)} &nbsp;|&nbsp; ${L('reorderExport.asOf', 'As of')}: ${escapeHtml(date)}</p>
  ${section(L('reorderExport.needsToOrder', 'Needs to Order'), 'needs', true, (it) => it.needsOrder !== false)}
  ${section(L('reorderExport.haveEnough', 'Have Enough Stock'), 'enough', false, (it) => it.needsOrder === false)}
  <p class="footer">${L('reorderExport.itemsToOrder', 'Items to order')}: ${payload.kpis.itemCount}</p>
  <p class="gen">${L('reorderExport.generatedBy', 'Generated by I.M.R — Inventory Management for Restaurant')}</p>
</body>
</html>`;
}
