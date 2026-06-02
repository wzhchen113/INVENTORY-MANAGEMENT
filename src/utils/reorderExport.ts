// src/utils/reorderExport.ts
//
// Spec 089 (A) — shared, PURE (framework-free) export formatters for the
// reorder list. Extracted verbatim out of the Cmd-themed
// `src/screens/cmd/sections/ReorderSection.tsx` so BOTH the admin desktop
// Reorder section AND the staff Reorder screen import one copy — the
// spec-088 cases·units string + the spec-025 CSV column set are
// byte-for-byte load-bearing (the staff Suggested string must match the
// admin output exactly), so a single source of truth defends against
// drift the moment a rounding rule or column set changes.
//
// No React, no theme, no supabase imports — same pure-util pattern as
// `reorderDayFilter.ts` / `enumLabels.ts`, which keeps the jest contract
// cheap and lets the staff screen import this WITHOUT pulling in the Cmd
// theme.
//
// The DOM-coupled orchestrators (`triggerDownload`, `handleCsvExport`,
// `handlePdfExport`) stay in `ReorderSection.tsx` (admin, web-only) — they
// are not pure and the staff surface needs a different cross-platform
// orchestration (`src/screens/staff/lib/shareReorder.ts`). Only the pure
// builders live here.

import Papa from 'papaparse';
import type { ReorderItem, ReorderPayload } from '../types';

export function formatQty(n: number): string {
  if (!Number.isFinite(n)) return '0';
  // Match the units / variance runners' shape: drop trailing zeros but
  // keep up to 2 decimals.
  const rounded = Math.round(n * 100) / 100;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(2).replace(/\.?0+$/, '');
}

export function formatMoney(n: number): string {
  return `$${(Math.round(n * 100) / 100).toFixed(2)}`;
}

// Spec 088 — the Suggested order is shown in WHOLE CASES for items with a
// case size (server sets `suggestedCases` non-null iff `caseQty > 1`), plus
// the underlying ordered base-unit total so the figure matches how you order
// from the vendor AND the math stays glanceable: `N cases · M unit`
// (singular `1 case`). `M` is the server-authoritative `suggestedUnits` — the
// FE never re-derives `cases × caseQty` (defends against any server
// rounding-rule change) and does NO cost math (Est $ rides on the
// server-rounded `estimatedCost`). Non-case items render exactly as before:
// `{suggestedQty} {unit}`. Exported for jest.
export function formatSuggested(item: ReorderItem): string {
  if (item.suggestedCases != null) {
    const cases = item.suggestedCases;
    const caseWord = cases === 1 ? 'case' : 'cases';
    return `${formatQty(cases)} ${caseWord} · ${formatQty(item.suggestedUnits)} ${item.unit}`.trim();
  }
  return `${formatQty(item.suggestedQty)} ${item.unit}`.trim();
}

// PDF variant — same cases·units split with the compact `cs` abbreviation
// (a glanceable string is fine for a print artifact). Exported for jest.
export function formatSuggestedPdf(item: ReorderItem): string {
  if (item.suggestedCases != null) {
    return `${formatQty(item.suggestedCases)} cs · ${formatQty(item.suggestedUnits)} ${item.unit}`.trim();
  }
  return `${formatQty(item.suggestedQty)} ${item.unit}`.trim();
}

export function slugifyStore(name: string): string {
  return name.replace(/\s+/g, '_').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 60) || 'store';
}

// Local-time `YYYY-MM-DD` (NOT UTC). Built from local date components so
// the name is honest — mirrors `reportDates.ts:toISODate()` and the staff
// screen's `todayIso()`. (The prior `toISOString().slice(0,10)` returned UTC
// midnight, which in any negative-offset TZ rolls back a day.) In production
// this is only reached when `payload.asOfDate` is absent (the RPC always sets
// it), so the fix is a name-vs-implementation correctness fix with nil runtime
// impact.
export function todayLocalIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Spec 025 AC4 — one CSV covering all vendors. Column order is fixed
// via `Papa.unparse(rows, { columns })` so accidental row-field changes
// don't reshape the header.
// Exported for jest (spec 088 — case columns).
export function buildReorderCsv(payload: ReorderPayload): string {
  const columns = [
    'Vendor',
    'Item Name',
    'On Hand',
    'Pending PO',
    'Par Level',
    'Suggested Qty',
    // Spec 088 — explicit numeric-friendly case columns right after
    // `Suggested Qty` so the case count and the ordered base-unit total are
    // both recoverable + spreadsheet-summable. Empty for non-case rows.
    'Cases',
    'Units Per Case',
    'Unit',
    'Est. Cost',
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
        // Case rows carry the ordered base-unit total `M`; non-case rows
        // carry the raw suggestion (byte-for-byte unchanged from today).
        'Suggested Qty': isCase ? item.suggestedUnits : item.suggestedQty,
        'Cases': item.suggestedCases != null ? item.suggestedCases : '',
        'Units Per Case': item.caseQty > 1 ? item.caseQty : '',
        'Unit': item.unit,
        // No `$` — CSV stays numeric-friendly for spreadsheet sums. Already
        // case-rounded server-side; the FE does no cost math.
        'Est. Cost': item.estimatedCost.toFixed(2),
        'Flags': (item.flags || []).join(', '),
        'EOD Counted At': vendor.eodSubmittedAt || '',
      });
    }
  }
  return Papa.unparse(rows, { columns });
}

// ─── Spec 089 (C) — NEW shared plain-text + PDF-HTML builders ───────
// These feed the cross-platform share/export path (staff + admin). They
// are pure string builders (no DOM, no theme) so the staff
// `shareReorder.ts` orchestrator can branch on Platform.OS and either
// download (web) or write a temp file + open the OS share sheet (native).

// Plain-text builder — the share-sheet-friendliest format (drops straight
// into an email/SMS body to a vendor). One block per vendor with the
// cases-aware `formatSuggested` Suggested figure and the server-rounded
// est cost; a footer with the client-recomputed totals. The caller passes
// the DERIVED payload (primary vendors + recomputed kpis) so the text
// matches the on-screen filtered + as-of view.
export function buildReorderText(payload: ReorderPayload, storeName: string): string {
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
      // `- {item}: {N cases · M unit}  (est {$X})` — the order figure is the
      // cases-aware string (identical to the on-screen Suggested column).
      lines.push(
        `  - ${item.itemName}: ${formatSuggested(item)}  (est ${formatMoney(item.estimatedCost)})`,
      );
    }
    lines.push(`  subtotal: ${formatMoney(vendor.vendorTotalCost)}`);
    lines.push('');
  }

  lines.push(
    `Total items: ${payload.kpis.itemCount}  ·  Est. total: ${formatMoney(payload.kpis.totalEstimatedCost)}`,
  );
  return lines.join('\n');
}

// Minimal HTML escape for the PDF-HTML builder. Five-character escape so
// vendor / item names with `& < > " '` don't break the markup (the same
// defense-in-depth posture the edge-function email templates use).
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Spec 089 (C) = Option 2 — PDF EVERYWHERE. `expo-print` renders HTML → PDF
// on native; on web we ALSO drive expo-print (it shims to window.print /
// an iframe under react-native-web). This builder produces the print HTML
// shared by both platforms so there is ONE PDF layout (no jsPDF/HTML drift).
// Uses `formatSuggestedPdf` (the compact `cs` variant) to match the admin
// PDF's Suggested cell. The caller passes the derived (filtered) payload.
export function buildReorderPdfHtml(payload: ReorderPayload, storeName: string): string {
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
        .map(
          (item) => `
            <tr>
              <td>${escapeHtml(item.itemName)}</td>
              <td class="num">${formatQty(item.onHand)}</td>
              <td class="num">${formatQty(item.pendingPoQty)}</td>
              <td class="num">${formatQty(item.parLevel)}</td>
              <td class="num strong">${escapeHtml(formatSuggestedPdf(item))}</td>
              <td>${escapeHtml(item.unit)}</td>
              <td class="num">${formatMoney(item.estimatedCost)}</td>
            </tr>`,
        )
        .join('');
      return `
        <h2>${subHeader}</h2>
        <table>
          <thead>
            <tr>
              <th>Item</th><th class="num">On Hand</th><th class="num">Pending</th>
              <th class="num">Par</th><th class="num">Suggested</th><th>Unit</th>
              <th class="num">Est. Cost</th>
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
  td.strong { font-weight: 700; }
  .footer { margin-top: 20px; font-size: 12px; font-weight: 700; }
  .gen { margin-top: 28px; font-size: 9px; color: #999; }
</style>
</head>
<body>
  <h1>I.M.R — Per-Vendor Reorder Suggestions</h1>
  <p class="sub">Store: ${escapeHtml(storeName)} &nbsp;|&nbsp; As of: ${escapeHtml(date)}</p>
  ${vendorBlocks || '<p>(no items to order)</p>'}
  <p class="footer">Total items: ${payload.kpis.itemCount} &nbsp;|&nbsp; Est. total: ${formatMoney(payload.kpis.totalEstimatedCost)}</p>
  <p class="gen">Generated by I.M.R — Inventory Management for Restaurant</p>
</body>
</html>`;
}
