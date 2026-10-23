// src/utils/usageCalculations.eodNoNeed.test.ts — Spec 172 (AC-27).
//
// buildReconciliationLines must treat a NO NEED entry (`actualRemaining:
// null, noNeed: true`) exactly like an absent entry, on BOTH paths that read
// `actualRemaining`:
//   • the closing count (the end-date submission's entries → one line each);
//   • the opening stock (the prior day's entry, else inventory currentStock).
// Behavioral pairs: identical output with and without the NO NEED entry.

import { buildReconciliationLines } from './usageCalculations';
import type { EODEntry, EODSubmission, InventoryItem } from '../types';

const S = 'store-a';

function mkItem(over: Partial<InventoryItem>): InventoryItem {
  return {
    id: 'item', catalogId: 'cat', name: 'Item', category: 'produce', unit: 'lb',
    costPerUnit: 1, currentStock: 0, parLevel: 0, averageDailyUsage: 0,
    safetyStock: 0, vendorId: '', vendorName: '', usagePerPortion: 0,
    lastUpdatedBy: '', lastUpdatedAt: '', eodRemaining: 0, storeId: S,
    casePrice: 0, caseQty: 1, subUnitSize: 1, subUnitUnit: '',
    ...over,
  };
}

function mkEntry(over: Partial<EODEntry>): EODEntry {
  return {
    id: 'e', itemId: 'item', itemName: 'Item', actualRemaining: 0, unit: 'lb',
    submittedBy: 'Pat', submittedByUserId: 'u', timestamp: '2026-08-10T23:00:00Z',
    date: '', storeId: S, notes: '',
    ...over,
  };
}

function mkEod(date: string, entries: EODEntry[]): EODSubmission {
  return {
    id: `sub-${date}`, date, storeId: S, storeName: '', vendorId: 'v-1',
    submittedBy: 'Pat', submittedByUserId: 'u', timestamp: `${date}T23:00:00Z`,
    itemCount: entries.length, status: 'submitted', entries,
  };
}

const inventory: InventoryItem[] = [
  mkItem({ id: 'x', catalogId: 'cx', name: 'X', currentStock: 9 }),
  mkItem({ id: 'y', catalogId: 'cy', name: 'Y', currentStock: 4 }),
];

const PRIOR = '2026-08-09';
const DAY = '2026-08-10';

const nn = (date: string): EODEntry =>
  mkEntry({ id: `nn-${date}`, itemId: 'x', itemName: 'X', actualRemaining: null, noNeed: true, date });

describe('buildReconciliationLines — NO NEED is identical to an absent entry (AC-27)', () => {
  it('closing count: a NO NEED entry on the end date produces no line (never a 0 count)', () => {
    const base = [
      mkEod(PRIOR, [mkEntry({ id: 'x0', itemId: 'x', itemName: 'X', actualRemaining: 6, date: PRIOR })]),
    ];
    const without = [...base, mkEod(DAY, [mkEntry({ id: 'y1', itemId: 'y', itemName: 'Y', actualRemaining: 3, date: DAY })])];
    const withNN = [...base, mkEod(DAY, [
      mkEntry({ id: 'y1', itemId: 'y', itemName: 'Y', actualRemaining: 3, date: DAY }),
      nn(DAY),
    ])];
    const a = buildReconciliationLines(DAY, DAY, S, [], [], withNN, inventory);
    const b = buildReconciliationLines(DAY, DAY, S, [], [], without, inventory);
    expect(a).toEqual(b);
    expect(a.map((l) => l.itemId)).toEqual(['y']);
  });

  it('opening stock: a NO NEED entry on the prior day falls back to currentStock like an absent one', () => {
    const closing = mkEod(DAY, [mkEntry({ id: 'x1', itemId: 'x', itemName: 'X', actualRemaining: 5, date: DAY })]);
    const without = [mkEod(PRIOR, []), closing];
    const withNN = [mkEod(PRIOR, [nn(PRIOR)]), closing];
    const a = buildReconciliationLines(DAY, DAY, S, [], [], withNN, inventory);
    const b = buildReconciliationLines(DAY, DAY, S, [], [], without, inventory);
    expect(a).toEqual(b);
    // Fallback to inventory currentStock (9), NOT a fabricated 0.
    expect(a[0].openingStock).toBe(9);
  });

  it('a NO-NEED-only end-date submission yields no lines, same as an empty one', () => {
    const a = buildReconciliationLines(DAY, DAY, S, [], [], [mkEod(DAY, [nn(DAY)])], inventory);
    const b = buildReconciliationLines(DAY, DAY, S, [], [], [mkEod(DAY, [])], inventory);
    expect(a).toEqual(b);
    expect(a).toEqual([]);
  });
});
