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
import {
  formatQty,
  formatSuggested,
  formatSuggestedPdfParts,
  todayLocalIso,
} from '../../../utils/reorderExport';

// CSV — same column set as buildReorderCsv MINUS the 'Est. Cost' column, PLUS
// a 'Needs Order' column (2026-07) so both the needs-to-order and the have-
// enough-stock rows are present and distinguishable, matching the two on-screen
// sections. Rows come from ALL displayed items.
export function buildStaffReorderCsv(payload: ReorderPayload): string {
  const columns = [
    'Vendor',
    'Needs Order',
    'Item Name',
    'On Hand',
    'Pending PO',
    'Par Level',
    'Suggested Qty',
    'Cases',
    'Units Per Case',
    'Unit',
    'Flags',
    'EOD Counted At',
  ];
  const rows: Record<string, string | number>[] = [];
  for (const vendor of payload.vendors) {
    for (const item of vendor.items) {
      const isCase = item.suggestedCases != null;
      rows.push({
        'Vendor': vendor.vendorName,
        'Needs Order': item.needsOrder === false ? 'no' : 'yes',
        'Item Name': item.itemName,
        'On Hand': item.onHand,
        'Pending PO': item.pendingPoQty,
        'Par Level': item.parLevel,
        'Suggested Qty': isCase ? item.suggestedUnits : item.suggestedQty,
        'Cases': item.suggestedCases != null ? item.suggestedCases : '',
        'Units Per Case': item.caseQty > 1 ? item.caseQty : '',
        'Unit': item.unit,
        'Flags': (item.flags || []).join(', '),
        'EOD Counted At': vendor.eodSubmittedAt || '',
      });
    }
  }
  return Papa.unparse(rows, { columns });
}

// Plain text — TWO sections mirroring the screen (2026-07): NEEDS TO ORDER
// (below par, cases-aware Suggested figure) then HAVE ENOUGH STOCK (at/above
// par, on-hand). NO cost. Footer carries the count of items to order.
export function buildStaffReorderText(payload: ReorderPayload, storeName: string): string {
  const date = (payload.asOfDate && payload.asOfDate.slice(0, 10)) || todayLocalIso();
  const lines: string[] = [];
  lines.push('I.M.R — Reorder list');
  lines.push(`Store: ${storeName}`);
  lines.push(`As of: ${date}`);
  lines.push('');

  const section = (
    title: string,
    keep: (it: ReorderPayload['vendors'][number]['items'][number]) => boolean,
    itemLine: (it: ReorderPayload['vendors'][number]['items'][number]) => string,
  ) => {
    const groups = payload.vendors
      .map((v) => ({ v, items: v.items.filter(keep) }))
      .filter((g) => g.items.length > 0);
    lines.push(`=== ${title} ===`);
    if (groups.length === 0) {
      lines.push('  (none)');
      lines.push('');
      return;
    }
    for (const { v, items } of groups) {
      const sourceLabel = v.onHandSource === 'eod' ? 'EOD' : 'STOCK FALLBACK';
      lines.push(`${v.vendorName || 'unnamed vendor'} — ${sourceLabel}`);
      if (v.nextDeliveryDate) lines.push(`  next delivery: ${v.nextDeliveryDate}`);
      for (const item of items) lines.push(itemLine(item));
      lines.push('');
    }
  };

  section(
    'NEEDS TO ORDER',
    (it) => it.needsOrder !== false,
    (item) => `  - ${item.itemName}: ${formatSuggested(item)}`,
  );
  section(
    'HAVE ENOUGH STOCK',
    (it) => it.needsOrder === false,
    (item) => `  - ${item.itemName}: on hand ${formatQty(item.onHand)} ${item.unit}`.trimEnd(),
  );

  lines.push(`Total items to order: ${payload.kpis.itemCount}`);
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
export function buildStaffReorderPdfHtml(payload: ReorderPayload, storeName: string): string {
  const date = (payload.asOfDate && payload.asOfDate.slice(0, 10)) || todayLocalIso();

  const vendorBlock = (vendor: ReorderPayload['vendors'][number], items: typeof vendor.items, cls: string) => {
    const sourceLabel = vendor.onHandSource === 'eod' ? 'EOD' : 'STOCK FALLBACK';
    const daysLabel =
      vendor.daysUntilNextDelivery === 0
        ? 'today'
        : vendor.daysUntilNextDelivery === 1
          ? 'tomorrow'
          : `in ${vendor.daysUntilNextDelivery} days`;
    const subHeader = `${escapeHtml(vendor.vendorName || 'unnamed vendor')} &middot; Source: ${sourceLabel} &middot; Next delivery: ${escapeHtml(vendor.nextDeliveryDate || '—')} (${daysLabel})`;
    const rows = items
      .map((item) => {
        const { main, sub } = formatSuggestedPdfParts(item);
        const suggestedCell = sub
          ? `<span class="strong">${escapeHtml(main)}</span><span class="sub-unit"> &middot; ${escapeHtml(sub)}</span>`
          : `<span class="strong">${escapeHtml(main)}</span>`;
        return `
          <tr>
            <td>${escapeHtml(item.itemName)}</td>
            <td class="num">${formatQty(item.onHand)}</td>
            <td class="num">${formatQty(item.pendingPoQty)}</td>
            <td class="num">${formatQty(item.parLevel)}</td>
            <td class="num">${suggestedCell}</td>
            <td>${escapeHtml(item.unit)}</td>
          </tr>`;
      })
      .join('');
    return `
      <h2 class="${cls}">${subHeader}</h2>
      <table class="${cls}">
        <thead>
          <tr>
            <th>Item</th><th class="num">On Hand</th><th class="num">Pending</th>
            <th class="num">Par</th><th class="num">Suggested</th><th>Unit</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>`;
  };

  const section = (
    title: string,
    cls: string,
    keep: (it: ReorderPayload['vendors'][number]['items'][number]) => boolean,
  ) => {
    const groups = payload.vendors
      .map((v) => ({ v, items: v.items.filter(keep) }))
      .filter((g) => g.items.length > 0);
    const body = groups.length
      ? groups.map((g) => vendorBlock(g.v, g.items, cls)).join('')
      : '<p class="none">(none)</p>';
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
  .sub-unit { font-weight: 400; font-size: 9px; color: #777; }
  .none { color: #999; font-size: 11px; margin: 4px 0 0 0; }
  .footer { margin-top: 20px; font-size: 12px; font-weight: 700; }
  .gen { margin-top: 28px; font-size: 9px; color: #999; }
</style>
</head>
<body>
  <h1 class="title">I.M.R — Per-Vendor Reorder Suggestions</h1>
  <p class="sub">Store: ${escapeHtml(storeName)} &nbsp;|&nbsp; As of: ${escapeHtml(date)}</p>
  ${section('Needs to Order', 'needs', (it) => it.needsOrder !== false)}
  ${section('Have Enough Stock', 'enough', (it) => it.needsOrder === false)}
  <p class="footer">Items to order: ${payload.kpis.itemCount}</p>
  <p class="gen">Generated by I.M.R — Inventory Management for Restaurant</p>
</body>
</html>`;
}
