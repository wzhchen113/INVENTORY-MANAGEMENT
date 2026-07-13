// src/utils/usFoodsImport.ts — US Foods "Import Order" CSV builder.
//
// The US Foods MOXē "Import Order" upload accepts an operator's order FILE and
// needs only CUSTOMER NUMBER + PRODUCT NUMBER + qty (CS/EA); description, pack,
// and prices are ignored on upload but populated here for human review (owner
// decision 2026-07). Builds on spec 114's per-(item,vendor) `order_code`
// mapping — an item with NO order code cannot be referenced by product number,
// so it is SKIPPED and counted (never emitted with a blank product number,
// which US Foods would reject).
//
// PURE (no DOM / theme / supabase) — same posture as `reorderExport.ts`. The
// caller resolves each item's order code (from the hydrated inventory rows, the
// same way the quick-order path does) and passes it via `orderCodeFor`.

import Papa from 'papaparse';
import type { ReorderItem, ReorderPayload } from '../types';
import { formatQty, slugifyStore, todayLocalIso } from './reorderExport';

// Exact template column order (Import_Order_Template.csv). Do not reorder — the
// US Foods importer maps by header name, but keeping the template's order makes
// the file diff-identical to a known-good sample.
export const US_FOODS_IMPORT_COLUMNS = [
  'CUSTOMER NUMBER',
  'DISTRIBUTOR',
  'DEPARTMENT',
  'DATE',
  'PO NUMBER',
  'PRODUCT NUMBER',
  'CUST PROD #',
  'DESCRIPTION',
  'BRAND',
  'PACK SIZE',
  'CS PRICE',
  'EA PRICE',
  'CS',
  'EA',
  'EXTENDED PRICE',
  'ORDER #',
  'STOCK STATUS',
  'EXCEPTIONS / AUTO-SUB',
  'SHORTED',
] as const;

export interface UsFoodsImportHeader {
  customerNumber: string; // → CUSTOMER NUMBER (vendors.account_number)
  distributor: string; // → DISTRIBUTOR (vendors.import_distributor_number)
  department: string; // → DEPARTMENT (vendors.import_department; default '0')
  poNumber?: string; // → PO NUMBER (operator's optional ref; blank by default)
  asOfDate: string; // YYYY-MM-DD → DATE rendered as M/D/YYYY
}

export interface UsFoodsImportResult {
  csv: string;
  included: number; // rows written (needs-order items WITH an order code)
  skippedNoCode: number; // needs-order items dropped for a missing order code
}

// Neutralize CSV / spreadsheet formula injection. A cell whose text begins with
// `= + - @` (or a leading tab/CR some clients treat as a formula lead-in) is
// prefixed with a single quote so Excel / Sheets render it as literal text, not
// an executable formula. Papa.unparse handles delimiter/quote escaping but NOT
// this. In-threat-model because `order_code` (→ PRODUCT NUMBER) is writable by
// any store member via the staff app, and this file is opened in a spreadsheet
// by an admin. Applied to every free-text cell (defense-in-depth on the
// admin-set header values too).
function csvSafe(value: string): string {
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}

// YYYY-MM-DD → M/D/YYYY (no leading zeros), the US date format the template
// uses ("2/21/2024"). Falls back to the raw input if it isn't an ISO date.
function toUsDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || '');
  if (!m) return iso || '';
  const [, y, mo, d] = m;
  return `${Number(mo)}/${Number(d)}/${y}`;
}

// An item is on the order iff it's below par (needsOrder !== false) AND has a
// positive suggested quantity. At/above-par ("have enough") rows never belong
// in an order-upload file.
function isOrdered(item: ReorderItem): boolean {
  if (item.needsOrder === false) return false;
  const cases = item.suggestedCases ?? 0;
  return cases > 0 || item.suggestedQty > 0;
}

// CS / EA split: case-size items (suggestedCases non-null) order in WHOLE CASES
// (CS = suggestedCases, EA = 0 — the reorder engine already rounded up); items
// with no case size order in base units (EA = suggestedQty, CS = 0).
function csEa(item: ReorderItem): { cs: number; ea: number } {
  if (item.suggestedCases != null) return { cs: item.suggestedCases, ea: 0 };
  return { cs: 0, ea: item.suggestedQty };
}

/**
 * Build the US Foods Import-Order CSV for one vendor's reorder items.
 * Only ordered items (below par, qty > 0) with a resolvable order code are
 * emitted; the rest are counted in `skippedNoCode`.
 */
export function buildUsFoodsImportCsv(
  items: ReorderItem[],
  header: UsFoodsImportHeader,
  orderCodeFor: (item: ReorderItem) => string | null | undefined,
): UsFoodsImportResult {
  const date = toUsDate(header.asOfDate);
  const department = header.department || '0';
  const rows: Record<string, string | number>[] = [];
  let skippedNoCode = 0;

  for (const item of items) {
    if (!isOrdered(item)) continue;
    const code = (orderCodeFor(item) || '').trim();
    if (!code) {
      skippedNoCode += 1;
      continue;
    }
    const { cs, ea } = csEa(item);
    // Prices are informational (US Foods ignores them on upload); derive from
    // the server-rounded line total so no FE cost math is invented.
    const csPrice = cs > 0 ? (item.estimatedCost / cs).toFixed(2) : '';
    const eaPrice = ea > 0 ? (item.estimatedCost / ea).toFixed(2) : '';
    const packSize = item.caseQty > 1 ? `${formatQty(item.caseQty)} ${item.unit}`.trim() : '';
    rows.push({
      'CUSTOMER NUMBER': csvSafe(header.customerNumber),
      'DISTRIBUTOR': csvSafe(header.distributor),
      'DEPARTMENT': csvSafe(department),
      'DATE': date,
      'PO NUMBER': csvSafe(header.poNumber || ''),
      'PRODUCT NUMBER': csvSafe(code),
      'CUST PROD #': '',
      'DESCRIPTION': csvSafe(item.itemName),
      'BRAND': '',
      'PACK SIZE': csvSafe(packSize),
      'CS PRICE': csPrice,
      'EA PRICE': eaPrice,
      'CS': cs,
      'EA': ea,
      'EXTENDED PRICE': item.estimatedCost.toFixed(2),
      'ORDER #': '',
      'STOCK STATUS': '',
      'EXCEPTIONS / AUTO-SUB': '',
      'SHORTED': '',
    });
  }

  // `{ fields, data }` form (not the rows+columns form) so the header row is
  // emitted even when the order is empty — a header-only file is still a valid,
  // recognizable US Foods template.
  const csv = Papa.unparse({
    fields: US_FOODS_IMPORT_COLUMNS as unknown as string[],
    data: rows.map((r) => US_FOODS_IMPORT_COLUMNS.map((c) => r[c])),
  });
  return { csv, included: rows.length, skippedNoCode };
}

// The vendor-config shape the export needs (a structural subset of `Vendor`).
export interface UsFoodsVendorConfig {
  id: string;
  accountNumber?: string;
  importDistributorNumber?: string;
  importDepartment?: string;
  importCustomerNumbers?: Record<string, string>;
}

export interface UsFoodsExportPlan {
  csv: string;
  filename: string;
  included: number;
  skippedNoCode: number;
  otherVendorCount: number; // non-US-Foods vendors in the payload, omitted from this file
  customerNumberMissing: boolean; // no per-store override AND no account_number fallback
}

/**
 * Pure planner for the US Foods export off a reorder payload for ONE store.
 * Resolves the store's items, its per-store CUSTOMER NUMBER (override →
 * account_number fallback), the filename, and the cue flags — everything the
 * `onCsvPress` branch needs EXCEPT the DOM download + toast. Extracted so the
 * branch decision + customer-number resolution are unit-testable (the trigger
 * logic previously had zero coverage). `orderCodeFor` resolves each item's
 * PRODUCT NUMBER (the caller reads it off the hydrated inventory rows).
 */
export function planUsFoodsExport(
  payload: ReorderPayload,
  storeId: string,
  storeName: string,
  cfg: UsFoodsVendorConfig,
  orderCodeFor: (item: ReorderItem) => string | null | undefined,
): UsFoodsExportPlan {
  const pv = payload.vendors.find((v) => v.vendorId === cfg.id);
  const items = pv ? pv.items : [];
  // CUSTOMER NUMBER is per-store (each location has its own US Foods ship-to
  // number); fall back to the vendor-level account_number.
  const customerNumber = cfg.importCustomerNumbers?.[storeId] || cfg.accountNumber || '';
  const date = (payload.asOfDate && payload.asOfDate.slice(0, 10)) || todayLocalIso();
  const { csv, included, skippedNoCode } = buildUsFoodsImportCsv(
    items,
    {
      customerNumber,
      distributor: cfg.importDistributorNumber || '',
      department: cfg.importDepartment || '0',
      asOfDate: date,
    },
    orderCodeFor,
  );
  return {
    csv,
    filename: `USFoods_ImportOrder_${slugifyStore(storeName)}_${date}.csv`,
    included,
    skippedNoCode,
    otherVendorCount: payload.vendors.filter((v) => v.vendorId !== cfg.id).length,
    customerNumberMissing: !customerNumber,
  };
}
