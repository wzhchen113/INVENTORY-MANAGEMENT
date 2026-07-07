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

// CSV — same column set as buildReorderCsv MINUS the 'Est. Cost' column.
export function buildStaffReorderCsv(payload: ReorderPayload): string {
  const columns = [
    'Vendor',
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

// Plain text — one block per vendor, cases-aware Suggested figure, NO cost.
// Footer carries the item count only (no Est. total).
export function buildStaffReorderText(payload: ReorderPayload, storeName: string): string {
  const date = (payload.asOfDate && payload.asOfDate.slice(0, 10)) || todayLocalIso();
  const lines: string[] = [];
  lines.push('I.M.R — Reorder list');
  lines.push(`Store: ${storeName}`);
  lines.push(`As of: ${date}`);
  lines.push('');

  if (payload.vendors.length === 0) {
    lines.push('(no items to order)');
  }

  for (const vendor of payload.vendors) {
    const sourceLabel = vendor.onHandSource === 'eod' ? 'EOD' : 'STOCK FALLBACK';
    lines.push(`${vendor.vendorName || 'unnamed vendor'} — ${sourceLabel}`);
    if (vendor.nextDeliveryDate) {
      lines.push(`  next delivery: ${vendor.nextDeliveryDate}`);
    }
    for (const item of vendor.items) {
      lines.push(`  - ${item.itemName}: ${formatSuggested(item)}`);
    }
    lines.push('');
  }

  lines.push(`Total items: ${payload.kpis.itemCount}`);
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

// PDF HTML — same table as buildReorderPdfHtml MINUS the 'Est. Cost' column
// and the 'Est. total' footer figure.
export function buildStaffReorderPdfHtml(payload: ReorderPayload, storeName: string): string {
  const date = (payload.asOfDate && payload.asOfDate.slice(0, 10)) || todayLocalIso();
  const vendorBlocks = payload.vendors
    .map((vendor) => {
      const sourceLabel = vendor.onHandSource === 'eod' ? 'EOD' : 'STOCK FALLBACK';
      const daysLabel =
        vendor.daysUntilNextDelivery === 0
          ? 'today'
          : vendor.daysUntilNextDelivery === 1
            ? 'tomorrow'
            : `in ${vendor.daysUntilNextDelivery} days`;
      const subHeader = `${escapeHtml(vendor.vendorName || 'unnamed vendor')} &middot; Source: ${sourceLabel} &middot; Next delivery: ${escapeHtml(vendor.nextDeliveryDate || '—')} (${daysLabel})`;
      const rows = vendor.items
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
        <h2>${subHeader}</h2>
        <table>
          <thead>
            <tr>
              <th>Item</th><th class="num">On Hand</th><th class="num">Pending</th>
              <th class="num">Par</th><th class="num">Suggested</th><th>Unit</th>
            </tr>
          </thead>
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
  body { font-family: -apple-system, Helvetica, Arial, sans-serif; color: #1a1a18; margin: 24px; }
  h1 { font-size: 22px; margin: 0 0 2px 0; }
  .sub { color: #777; font-size: 12px; margin: 0 0 16px 0; }
  h2 { font-size: 13px; margin: 18px 0 6px 0; }
  table { width: 100%; border-collapse: collapse; font-size: 11px; }
  th, td { text-align: left; padding: 5px 6px; border-bottom: 1px solid #e4e4e4; }
  th { background: #1a1a18; color: #fff; }
  td.num, th.num { text-align: right; }
  td.strong, .strong { font-weight: 700; }
  .sub-unit { font-weight: 400; font-size: 9px; color: #777; }
  .footer { margin-top: 20px; font-size: 12px; font-weight: 700; }
  .gen { margin-top: 28px; font-size: 9px; color: #999; }
</style>
</head>
<body>
  <h1>I.M.R — Per-Vendor Reorder Suggestions</h1>
  <p class="sub">Store: ${escapeHtml(storeName)} &nbsp;|&nbsp; As of: ${escapeHtml(date)}</p>
  ${vendorBlocks || '<p>(no items to order)</p>'}
  <p class="footer">Total items: ${payload.kpis.itemCount}</p>
  <p class="gen">Generated by I.M.R — Inventory Management for Restaurant</p>
</body>
</html>`;
}
