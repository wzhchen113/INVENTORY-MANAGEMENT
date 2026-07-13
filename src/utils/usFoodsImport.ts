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
import { slugifyStore } from './reorderExport';
import {
  csvSafe,
  deriveOrderLine,
  isOrdered,
  resolveExportBase,
  type ImportOrderPlan,
  type ImportVendorConfig,
} from './vendorImportShared';

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

// YYYY-MM-DD → M/D/YYYY (no leading zeros), the US date format the template
// uses ("2/21/2024"). Falls back to the raw input if it isn't an ISO date.
function toUsDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || '');
  if (!m) return iso || '';
  const [, y, mo, d] = m;
  return `${Number(mo)}/${Number(d)}/${y}`;
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
    // cases → CS, base units → EA; prices/pack derived once in the shared helper
    // (informational — US Foods ignores them on upload).
    const { cases, units, packSize, casePrice, eachPrice } = deriveOrderLine(item);
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
      'CS PRICE': casePrice,
      'EA PRICE': eachPrice,
      'CS': cases,
      'EA': units,
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

// The US Foods vendor config = the shared per-store config PLUS the US-Foods-
// only division fields (distributor / department).
export interface UsFoodsVendorConfig extends ImportVendorConfig {
  importDistributorNumber?: string;
  importDepartment?: string;
}

/**
 * Pure planner for the US Foods export off a reorder payload for ONE store.
 * The per-store CUSTOMER NUMBER resolution, item selection, filename cue flags,
 * and omitted-vendor count come from the shared `resolveExportBase`; this only
 * adds the US-Foods-specific header (distributor/department) + filename. Everything
 * the `onCsvPress` branch needs EXCEPT the DOM download + toast, so the trigger
 * logic is unit-testable.
 */
export function planUsFoodsExport(
  payload: ReorderPayload,
  storeId: string,
  storeName: string,
  cfg: UsFoodsVendorConfig,
  orderCodeFor: (item: ReorderItem) => string | null | undefined,
): ImportOrderPlan {
  const base = resolveExportBase(payload, storeId, cfg);
  const { csv, included, skippedNoCode } = buildUsFoodsImportCsv(
    base.items,
    {
      customerNumber: base.customerNumber,
      distributor: cfg.importDistributorNumber || '',
      department: cfg.importDepartment || '0',
      asOfDate: base.date,
    },
    orderCodeFor,
  );
  return {
    csv,
    filename: `USFoods_ImportOrder_${slugifyStore(storeName)}_${base.date}.csv`,
    included,
    skippedNoCode,
    otherVendorCount: base.otherVendorCount,
    customerNumberMissing: base.customerNumberMissing,
  };
}
