// src/utils/vendorImportShared.ts — format-agnostic helpers shared by the
// per-vendor "Import Order" file builders (US Foods, SYSCO, …). Extracted so the
// CSV-injection guard, the ordered-item / quantity rules, the per-line
// derivation, the per-store export "base" (vendor items + customer number +
// omitted-vendor count), the export-plan shape, and the trigger-vendor pick are
// ONE source of truth across vendor formats rather than copied per builder.
//
// PURE (no DOM / theme / supabase), same posture as reorderExport.ts.

import type { ReorderItem, ReorderPayload, Vendor } from '../types';
import { formatQty, todayLocalIso } from './reorderExport';

// Neutralize CSV / spreadsheet formula injection. A cell whose text begins with
// `= + - @` (or a leading tab/CR some clients treat as a formula lead-in) is
// prefixed with a single quote so Excel / Sheets render it as literal text, not
// an executable formula. In-threat-model because `order_code` (the vendor
// product number) is writable by any store member via the staff app, and these
// files are opened in a spreadsheet by an admin. Papa handles delimiter/quote
// escaping but NOT this.
export function csvSafe(value: string): string {
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}

// An item belongs on an order file iff it's below par (needsOrder !== false)
// AND has a positive suggested quantity. At/above-par ("have enough") rows
// never belong in an order-upload file.
export function isOrdered(item: ReorderItem): boolean {
  if (item.needsOrder === false) return false;
  const cases = item.suggestedCases ?? 0;
  return cases > 0 || item.suggestedQty > 0;
}

// Split the suggested order into whole CASES vs loose UNITS. Case-size items
// (suggestedCases non-null) order in whole cases — the reorder engine already
// rounded up, so units = 0; items with no case size order in base units. Each
// vendor format maps these to its own columns (US Foods CS/EA, SYSCO Case
// Qty / Split Qty).
export function orderQuantities(item: ReorderItem): { cases: number; units: number } {
  if (item.suggestedCases != null) return { cases: item.suggestedCases, units: 0 };
  return { cases: 0, units: item.suggestedQty };
}

// The per-line values both vendor builders derive identically: the cases/units
// split, a human-readable pack size, and the (informational) case/each prices
// derived from the server-rounded line total. Empty strings where not
// applicable so a builder drops them straight into a cell.
export function deriveOrderLine(item: ReorderItem): {
  cases: number;
  units: number;
  packSize: string;
  casePrice: string;
  eachPrice: string;
} {
  const { cases, units } = orderQuantities(item);
  return {
    cases,
    units,
    packSize: item.caseQty > 1 ? `${formatQty(item.caseQty)} ${item.unit}`.trim() : '',
    casePrice: cases > 0 ? (item.estimatedCost / cases).toFixed(2) : '',
    eachPrice: units > 0 ? (item.estimatedCost / units).toFixed(2) : '',
  };
}

// The vendor-config subset the export planners need (a structural subset of
// `Vendor`). CUSTOMER NUMBER is per-store (each location has its own vendor
// ship-to/customer number); `account_number` is the brand-level fallback.
export interface ImportVendorConfig {
  id: string;
  accountNumber?: string;
  importCustomerNumbers?: Record<string, string>;
}

// The per-store export "base" shared by every format's planner: the vendor's
// items, its resolved customer number, the order date, and the count of OTHER
// vendors in the payload that this single-vendor file omits (Risk 1 cue).
export function resolveExportBase(
  payload: ReorderPayload,
  storeId: string,
  cfg: ImportVendorConfig,
): { items: ReorderItem[]; customerNumber: string; date: string; otherVendorCount: number; customerNumberMissing: boolean } {
  const pv = payload.vendors.find((v) => v.vendorId === cfg.id);
  const customerNumber = cfg.importCustomerNumbers?.[storeId] || cfg.accountNumber || '';
  return {
    items: pv ? pv.items : [],
    customerNumber,
    date: (payload.asOfDate && payload.asOfDate.slice(0, 10)) || todayLocalIso(),
    otherVendorCount: payload.vendors.filter((v) => v.vendorId !== cfg.id).length,
    customerNumberMissing: !customerNumber,
  };
}

// The uniform result every format's planner returns (was defined once per
// format + again in ReorderSection). `included`/`skippedNoCode` come from the
// format builder; the rest from resolveExportBase.
export interface ImportOrderPlan {
  csv: string;
  filename: string;
  included: number;
  skippedNoCode: number;
  otherVendorCount: number;
  customerNumberMissing: boolean;
}

// A recognized vendor-specific import format tag.
export type ImportFormat = 'us_foods' | 'sysco';
export function isImportFormat(v: string | null | undefined): v is ImportFormat {
  return v === 'us_foods' || v === 'sysco';
}

/**
 * Pick the vendor whose configured import format should drive the reorder CSV
 * button: the first vendor in the payload (order preserved) that both appears
 * in `vendors` and has a recognized `orderImportFormat`. Returns undefined when
 * no displayed vendor is import-configured (→ caller emits the generic CSV).
 * Pure, so the onCsvPress branch decision is unit-testable.
 */
export function pickImportVendor(payload: ReorderPayload, vendors: Vendor[]): Vendor | undefined {
  for (const pv of payload.vendors) {
    const v = vendors.find((x) => x.id === pv.vendorId);
    if (v && isImportFormat(v.orderImportFormat)) return v;
  }
  return undefined;
}
