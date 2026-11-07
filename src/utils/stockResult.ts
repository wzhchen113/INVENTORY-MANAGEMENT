// src/utils/stockResult.ts — Spec 184.
//
// The copy of the stocking result panel in `StoresTab`, as pure functions, so the
// STOCK dialog and create-and-stock report the same content by construction
// (AC-42). Hardcoded English, matching the drawer and tab around it.
//
// R-5: one run adds only what its source carries, so nothing here may say or imply
// that the store now has the full catalog. `stockResult.test.ts` pins that.

import type { StockStoreResult } from '../lib/db';
import type { InventoryItem, Vendor } from '../types';

export type StockResultTone = 'info' | 'warn';

export interface StockResultLine {
  /** Stable per-line id: the React key, and the panel's testID suffix. */
  id: string;
  tone: StockResultTone;
  text: string;
}

/** What `StockStoreDialog` hands up after a successful run. */
export interface StockRunReport {
  targetStoreId: string;
  targetName: string;
  sourceName: string;
  result: StockStoreResult;
}

/** What `StoreFormDrawer` hands up after a successful create. */
export interface StoreCreatedReport {
  storeId: string;
  storeName: string;
  /** The store chosen under "Stock from". Null for "Don't stock yet", or when the
   *  field wasn't offered. */
  sourceName: string | null;
  /** Null when no stock ran, or when it ran and failed. */
  result: StockStoreResult | null;
  /** AC-41: the store exists, but the stock RPC failed. */
  stockFailed: boolean;
  /** False only when the brand is known to have no store to copy from, where the
   *  `STOCK` action has nothing to offer (AC-29). A failed preview leaves it true:
   *  it says nothing about the brand. */
  canStockLater: boolean;
  /** AC-39: catalog rows no store carries. 0 hides the line. */
  uncarriedCount: number;
}

/** "1 item" / "3 items". The one count-and-noun helper for the spec 184 copy
 *  (dialog, drawer and result panel), so the English stays consistent until
 *  these surfaces move onto catalog keys. */
export const plural = (n: number, one: string, many: string = `${one}s`) =>
  `${n} ${n === 1 ? one : many}`;

/** AC-33, AC-34. Zero counts are hidden, apart from the headline's own numbers. */
export function buildStockResultLines(
  result: StockStoreResult,
  ctx: { sourceName: string; targetName: string },
): StockResultLine[] {
  const { sourceName, targetName } = ctx;
  const lines: StockResultLine[] = [];

  const copied = plural(result.itemsCopied, 'item');
  const links = plural(result.linksAdded, 'vendor link');
  lines.push({
    id: 'copied',
    tone: 'info',
    text: `Copied ${copied} and ${links} from ${sourceName} to ${targetName}. Stock starts at 0.`,
  });
  lines.push({
    id: 'skipped',
    tone: 'info',
    text: `Skipped ${plural(result.itemsSkipped, 'item')} ${targetName} already had, left unchanged.`,
  });

  // AC-33 lists ticked rows added without a zero rule, but on a run where nothing
  // was ticked a "0 catalog rows" line says nothing. It shows once anything was
  // ticked, including when every tick was skipped.
  if (result.extrasAdded > 0 || result.extrasSkipped > 0) {
    lines.push({
      id: 'extras-added',
      tone: 'info',
      text: `Added ${plural(result.extrasAdded, 'ticked catalog row')} with blank par and cost.`,
    });
  }
  if (result.extrasSkipped > 0) {
    lines.push({
      id: 'extras-skipped',
      tone: 'info',
      text: `Skipped ${plural(result.extrasSkipped, 'ticked catalog row')} that a store now carries.`,
    });
  }
  if (result.linksSkippedCrossBrand > 0) {
    lines.push({
      id: 'links-cross-brand',
      tone: 'warn',
      text: `Did not copy ${plural(result.linksSkippedCrossBrand, 'vendor link')} to a vendor outside this brand.`,
    });
  }
  if (result.itemsNoVendorLink > 0) {
    const verb = result.itemsNoVendorLink === 1 ? 'has' : 'have';
    const pronoun = result.itemsNoVendorLink === 1 ? 'it won’t' : 'they won’t';
    lines.push({
      id: 'no-vendor-link',
      tone: 'warn',
      text: `${plural(result.itemsNoVendorLink, 'added item')} ${verb} no vendor link, so ${pronoun} appear at EOD until linked.`,
    });
  }
  if (!result.targetHasOrderSchedule) {
    lines.push({
      id: 'no-schedule',
      tone: 'warn',
      text: `${targetName} has no order schedule, so staff EOD will show no vendors until one is set.`,
    });
  }
  return lines;
}

function uncarriedLine(count: number): StockResultLine {
  const verb = count === 1 ? 'row is' : 'rows are';
  const pronoun = count === 1 ? 'it' : 'them';
  return {
    id: 'uncarried',
    tone: 'info',
    text: `${count} catalog ${verb} carried by no store. Add ${pronoun} from this store’s STOCK action.`,
  };
}

/** The panel after a successful create: AC-39, AC-41, AC-42. An empty list means
 *  there's nothing to add to the "Created store" toast, so no panel. */
export function buildStoreCreatedLines(report: StoreCreatedReport): StockResultLine[] {
  const { storeName, sourceName, result, stockFailed, canStockLater, uncarriedCount } = report;
  const lines: StockResultLine[] = [];
  if (result) {
    lines.push(
      ...buildStockResultLines(result, { sourceName: sourceName ?? '', targetName: storeName }),
    );
  } else if (stockFailed) {
    lines.push({
      id: 'not-stocked',
      tone: 'warn',
      text: `${storeName} was created but not stocked. Use STOCK on its row to try again.`,
    });
  } else if (canStockLater) {
    lines.push({
      id: 'no-items-yet',
      tone: 'info',
      text: `${storeName} has no items yet. Use STOCK on its row to copy them from another store.`,
    });
  }
  // AC-39 says rows "can be added from the store's STOCK action", which is only
  // true when STOCK has a source to offer (AC-29 hides the list otherwise).
  if (canStockLater && uncarriedCount > 0) lines.push(uncarriedLine(uncarriedCount));
  return lines;
}

/**
 * D-15. The vendors linked by the target's items whose per-store customer-number
 * map is in use but has nothing for this store. `vendorImportShared` resolves
 * `importCustomerNumbers[storeId] || accountNumber`, so these export under the
 * fallback account number. A blank entry falls back the same way, so it counts as
 * missing. A vendor with an empty or absent map has no per-store numbers at all,
 * and isn't a gap. Names are sorted, for a stable line.
 */
export function vendorsMissingCustomerNumber(
  targetStoreId: string,
  items: ReadonlyArray<Pick<InventoryItem, 'storeId' | 'vendorId' | 'vendorIds'>>,
  vendors: ReadonlyArray<Pick<Vendor, 'id' | 'name' | 'importCustomerNumbers'>>,
): string[] {
  const linked = new Set<string>();
  for (const item of items) {
    if (item.storeId !== targetStoreId) continue;
    // Same fallback as the EOD tabs: the scalar only stands in for a legacy row
    // with no link array.
    for (const id of item.vendorIds ?? (item.vendorId ? [item.vendorId] : [])) {
      if (id) linked.add(id);
    }
  }
  return vendors
    .filter((v) => {
      if (!linked.has(v.id)) return false;
      const numbers = v.importCustomerNumbers ?? {};
      return Object.keys(numbers).length > 0 && !numbers[targetStoreId];
    })
    .map((v) => v.name)
    .sort((a, b) => a.localeCompare(b));
}

/** D-15's one line. Null when no vendor is missing a number. */
export function customerNumberWarningLine(
  vendorNames: ReadonlyArray<string>,
  targetName: string,
): StockResultLine | null {
  if (vendorNames.length === 0) return null;
  const many = vendorNames.length > 1;
  return {
    id: 'customer-number',
    tone: 'warn',
    text: `${vendorNames.join(', ')} ${many ? 'have' : 'has'} no customer number for ${targetName}, so ${many ? 'their' : 'its'} import-order file uses the default account number until one is added under Vendors.`,
  };
}

/** D-15, when the check itself failed: not knowing mustn't read as "no warning". */
export function customerNumberCheckFailedLine(targetName: string): StockResultLine {
  return {
    id: 'customer-number',
    tone: 'warn',
    text: `Could not check vendor customer numbers for ${targetName}. Check them under Vendors before exporting an import-order file.`,
  };
}
