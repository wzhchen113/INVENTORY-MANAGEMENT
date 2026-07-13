// src/utils/syscoImport.ts — SYSCO "Import Order" file builder.
//
// SYSCO's order file is a THREE-record-type layout (mirrors the operator's
// downloaded order export):
//   H,<order#>,<route>,<customer#>,"<datetime>",<delivery>,N,,,<PO>,<PO>,<total>,<count>,<status>
//   F,SUPC,"Case Qty","Split Qty","Cust #",Pack/Size,Brand,Description,"Mfr #","Per Lb","Case $","Each $"
//   P,<SUPC>,<Case Qty>,<Split Qty>,,<Pack/Size>,<Brand>,<Description>,,N,<Case $>,<Each $>
//
// For a reorder ORDER we emit an H header (customer# + order datetime; the
// order#/total/status fields SYSCO assigns are left blank), the F field row
// verbatim, and one P row per below-par SYSCO item — `SUPC` = the item's
// order_code, `Case Qty` / `Split Qty` = the reorder cases / loose units.
// Description / Pack Size / prices are populated for readability (owner
// decision, mirroring the US Foods file). Items with no order code are skipped
// and counted.
//
// Upload-format caveat: this mirrors the layout of the operator's SYSCO export;
// the owner is to test-upload before relying on it (SYSCO's accepted upload
// shape isn't independently verified — spec 114 background).
//
// PURE (no DOM / theme / supabase). Uses a custom row serializer (not
// Papa.unparse) so the quoting matches SYSCO's style — text fields with spaces
// are quoted, numeric/code fields are not.

import type { ReorderItem, ReorderPayload } from '../types';
import { slugifyStore } from './reorderExport';
import {
  csvSafe,
  deriveOrderLine,
  isOrdered,
  resolveExportBase,
  type ImportOrderPlan,
  type ImportVendorConfig,
} from './vendorImportShared';

export interface SyscoImportHeader {
  customerNumber: string; // → H row customer number
  asOfDate: string; // YYYY-MM-DD → order datetime ("Mon DD, YYYY")
}

export interface SyscoImportResult {
  csv: string;
  included: number; // P rows written (needs-order items WITH an order code)
  skippedNoCode: number; // needs-order items dropped for a missing order code
}

// The F record — SYSCO's column names, byte-for-byte from the export.
const SYSCO_FIELD_ROW = [
  'F',
  'SUPC',
  'Case Qty',
  'Split Qty',
  'Cust #',
  'Pack/Size',
  'Brand',
  'Description',
  'Mfr #',
  'Per Lb',
  'Case $',
  'Each $',
] as const;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// YYYY-MM-DD → "Jul 06, 2026" (SYSCO's H-row datetime style, date portion).
function toSyscoDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || '');
  if (!m) return iso || '';
  const [, y, mo, d] = m;
  return `${MONTHS[Number(mo) - 1] ?? mo} ${d}, ${y}`;
}

// Serialize one record. A field is quoted iff it contains a comma, quote,
// newline (LF or bare CR), OR a space — matching SYSCO's export (which quotes
// "Case Qty", "SYS PRM", etc. but leaves SUPC / numbers / "1/50LB" bare).
// Embedded quotes are doubled per RFC 4180. The bare `\r` MUST be in the
// trigger set (not just `\n`): rows join with CRLF, so an unquoted lone `\r` in
// a staff-writable value (order code / item name) would otherwise read as a
// record terminator and split the row into a spurious fragment.
function syscoRow(fields: (string | number)[]): string {
  return fields
    .map((raw) => {
      const s = String(raw);
      return /[",\r\n ]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    })
    .join(',');
}

/**
 * Build the SYSCO Import-Order file for one vendor's reorder items. Only
 * ordered items (below par, qty > 0) with a resolvable order code (SUPC) are
 * emitted; the rest are counted in `skippedNoCode`. A header-only file (H + F)
 * is still returned when nothing is ordered.
 */
export function buildSyscoImportCsv(
  items: ReorderItem[],
  header: SyscoImportHeader,
  orderCodeFor: (item: ReorderItem) => string | null | undefined,
): SyscoImportResult {
  const datetime = toSyscoDate(header.asOfDate);
  const lines: string[] = [];
  // H record: only customer # + order datetime + the literal 'N' flag are
  // populated; order #, delivery date, PO, total, count, status are SYSCO-
  // assigned and left blank on an outbound order. 14 fields, matching the export.
  lines.push(syscoRow(['H', '', '', csvSafe(header.customerNumber), datetime, '', 'N', '', '', '', '', '', '', '']));
  lines.push(syscoRow(SYSCO_FIELD_ROW as unknown as string[]));

  let included = 0;
  let skippedNoCode = 0;
  for (const item of items) {
    if (!isOrdered(item)) continue;
    const code = (orderCodeFor(item) || '').trim();
    if (!code) {
      skippedNoCode += 1;
      continue;
    }
    // cases → Case Qty, base units → Split Qty; prices/pack derived once in the
    // shared helper (informational — SYSCO ignores them on upload).
    const { cases, units, packSize, casePrice, eachPrice } = deriveOrderLine(item);
    lines.push(
      syscoRow([
        'P',
        csvSafe(code), // SUPC
        cases, // Case Qty
        units, // Split Qty
        '', // Cust #
        csvSafe(packSize), // Pack/Size
        '', // Brand (not stored)
        csvSafe(item.itemName), // Description
        '', // Mfr #
        'N', // Per Lb
        casePrice, // Case $
        eachPrice, // Each $
      ]),
    );
    included += 1;
  }

  return { csv: lines.join('\r\n'), included, skippedNoCode };
}

// SYSCO needs no vendor fields beyond the shared per-store config.
export type SyscoVendorConfig = ImportVendorConfig;

/**
 * Pure planner for the SYSCO export off a reorder payload for ONE store — the
 * per-store customer number resolution, item selection, cue flags, and
 * omitted-vendor count come from the shared `resolveExportBase`; this adds the
 * SYSCO builder + filename. Everything the onCsvPress branch needs except the
 * DOM download + toast (so the trigger logic is unit-testable).
 */
export function planSyscoExport(
  payload: ReorderPayload,
  storeId: string,
  storeName: string,
  cfg: SyscoVendorConfig,
  orderCodeFor: (item: ReorderItem) => string | null | undefined,
): ImportOrderPlan {
  const base = resolveExportBase(payload, storeId, cfg);
  const { csv, included, skippedNoCode } = buildSyscoImportCsv(
    base.items,
    { customerNumber: base.customerNumber, asOfDate: base.date },
    orderCodeFor,
  );
  return {
    csv,
    filename: `SYSCO_Order_${slugifyStore(storeName)}_${base.date}.csv`,
    included,
    skippedNoCode,
    otherVendorCount: base.otherVendorCount,
    customerNumberMissing: base.customerNumberMissing,
  };
}
