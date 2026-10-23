// src/lib/cmdSelectors.eodNoNeed.test.ts — Spec 172 (AC-27).
//
// Behavioral pairs: given an otherwise identical EOD history WITH and
// WITHOUT one NO NEED entry, every numeric selector returns identical output.
// A NO NEED entry carries no quantity (`actualRemaining: null, noNeed: true`)
// and must be treated exactly like an absent entry — never as a count of 0.
//
// The NO NEED entry is deliberately placed on an item that HAS a prior
// numeric count, a cost, and a par, so a selector that read it as 0 would
// produce a large variance / depletion / series point and the pair would
// diverge (i.e. the test is not vacuous — see the "would read as 0" arms).

// cmdSelectors.ts transitively imports useStore → db.ts → supabase.ts,
// which calls createClient() at module load. Mirrors
// cmdSelectors.scopedRollups.test.ts.
jest.mock('./supabase', () => ({
  supabase: {
    auth: { getSession: jest.fn() },
    channel: jest.fn(() => ({
      on: jest.fn().mockReturnThis(),
      subscribe: jest.fn(),
    })),
    removeChannel: jest.fn(),
    from: jest.fn(),
    rpc: jest.fn(),
    functions: { invoke: jest.fn() },
  },
}));

import {
  computeCogsActual,
  computeScopedCogs,
  computeScopedFoodCostSeries,
  computeScopedTopVarianceItems,
  computeStoreFoodCostSeries,
  computeStoreFoodCostVariancePp,
  computeTopVarianceItems,
  computeVarianceLines,
  getStockSeries,
} from './cmdSelectors';
import type { EODEntry, EODSubmission, InventoryItem, POSImport, Store } from '../types';

const A = 'store-a';
const B = 'store-b';
const stores: Store[] = [
  { id: A, brandId: 'brand-1', name: 'Alpha', address: '', status: 'active' },
  { id: B, brandId: 'brand-1', name: 'Bravo', address: '', status: 'active' },
];

function mkItem(over: Partial<InventoryItem>): InventoryItem {
  return {
    id: 'item', catalogId: 'cat', name: 'Item', category: 'produce', unit: 'lb',
    costPerUnit: 0, currentStock: 0, parLevel: 0, averageDailyUsage: 0,
    safetyStock: 0, vendorId: '', vendorName: '', usagePerPortion: 0,
    lastUpdatedBy: '', lastUpdatedAt: '', eodRemaining: 0, storeId: A,
    casePrice: 0, caseQty: 1, subUnitSize: 1, subUnitUnit: '',
    ...over,
  };
}

function mkEntry(over: Partial<EODEntry>): EODEntry {
  return {
    id: 'e', itemId: 'item', itemName: '', actualRemaining: 0, unit: 'lb',
    submittedBy: '', submittedByUserId: '', timestamp: '', date: '', storeId: A,
    notes: '',
    ...over,
  };
}

function mkEod(over: Partial<EODSubmission>): EODSubmission {
  return {
    id: 'sub', date: '2026-08-10', storeId: A, storeName: '', vendorId: 'v-1',
    submittedBy: '', submittedByUserId: '', timestamp: '2026-08-10T23:00:00Z',
    itemCount: 0, status: 'submitted', entries: [],
    ...over,
  };
}

const inventory: InventoryItem[] = [
  mkItem({ id: 'x', name: 'X', costPerUnit: 2, parLevel: 10, currentStock: 3 }),
  mkItem({ id: 'y', name: 'Y', costPerUnit: 3, parLevel: 8, currentStock: 4 }),
];

const NO_NEED_X = (date: string): EODEntry =>
  mkEntry({ id: `nn-${date}`, itemId: 'x', actualRemaining: null, noNeed: true, date });

/**
 * Three days of history for store A (and one for B). X is counted on day 1
 * and day 2; on day 3 X is NO NEED (`with`) or simply absent (`without`).
 * Y is counted every day.
 */
function history(withNoNeed: boolean, d1: string, d2: string, d3: string): EODSubmission[] {
  return [
    mkEod({
      id: 's1', date: d1, timestamp: `${d1}T23:00:00Z`,
      entries: [
        mkEntry({ id: 'x1', itemId: 'x', actualRemaining: 10, date: d1 }),
        mkEntry({ id: 'y1', itemId: 'y', actualRemaining: 8, date: d1 }),
      ],
    }),
    mkEod({
      id: 's2', date: d2, timestamp: `${d2}T23:00:00Z`,
      entries: [
        mkEntry({ id: 'x2', itemId: 'x', actualRemaining: 6, date: d2 }),
        mkEntry({ id: 'y2', itemId: 'y', actualRemaining: 5, date: d2 }),
      ],
    }),
    mkEod({
      id: 's3', date: d3, timestamp: `${d3}T23:00:00Z`,
      entries: [
        mkEntry({ id: 'y3', itemId: 'y', actualRemaining: 2, date: d3 }),
        ...(withNoNeed ? [NO_NEED_X(d3)] : []),
      ],
    }),
    mkEod({
      id: 'b1', storeId: B, date: d3, timestamp: `${d3}T23:00:00Z`,
      entries: [mkEntry({ id: 'b-y', itemId: 'y', storeId: B, actualRemaining: 1, date: d3 })],
    }),
  ];
}

const D1 = '2026-08-08';
const D2 = '2026-08-09';
const D3 = '2026-08-10';
const WITH = history(true, D1, D2, D3);
const WITHOUT = history(false, D1, D2, D3);

describe('AC-27 — NO NEED is identical to an absent entry', () => {
  it('fixture sanity: the WITH history really carries a NO NEED entry', () => {
    const s3 = WITH.find((s) => s.id === 's3')!;
    expect(s3.entries.some((e) => e.noNeed === true && e.actualRemaining === null)).toBe(true);
  });

  it('getStockSeries', () => {
    // Day keys must match getStockSeries' own local-midnight → ISO walk.
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const key = (back: number) => {
      const d = new Date(today);
      d.setDate(d.getDate() - back);
      return d.toISOString().slice(0, 10);
    };
    const w = history(true, key(2), key(1), key(0));
    const wo = history(false, key(2), key(1), key(0));
    const out = getStockSeries('x', 5, w);
    expect(out).toEqual(getStockSeries('x', 5, wo));
    // X carries its last numeric (6) forward — the NO NEED day is NOT a 0 point.
    expect(out[out.length - 1]).toBe(6);
    expect(out).not.toContain(0);
  });

  it.each(['priorEod', 'parLevel'] as const)('computeVarianceLines (%s)', (mode) => {
    const out = computeVarianceLines(A, inventory, WITH, stores, mode);
    expect(out).toEqual(computeVarianceLines(A, inventory, WITHOUT, stores, mode));
    // Read as 0, X would surface as a variance row; it must not.
    expect(out.find((l) => l.itemId === 'x')).toBeUndefined();
  });

  it('computeCogsActual', () => {
    const out = computeCogsActual(A, D1, D3, inventory, WITH);
    expect(out).toBe(computeCogsActual(A, D1, D3, inventory, WITHOUT));
    // X: (10-6)*2 = 8 ; Y: (8-5)*3 + (5-2)*3 = 18 → 26. Read as 0, X would add 6*2.
    expect(out).toBe(26);
  });

  it('computeTopVarianceItems', () => {
    const out = computeTopVarianceItems(A, D1, D3, inventory, WITH, stores, 5);
    expect(out).toEqual(computeTopVarianceItems(A, D1, D3, inventory, WITHOUT, stores, 5));
  });

  it('computeStoreFoodCostVariancePp — POS revenue present', () => {
    const pos: POSImport[] = [D1, D2, D3].map((date) => ({
      id: `pos-${date}`, filename: '', importedAt: '', importedBy: '', date, storeId: A,
      items: [{ menuItem: 'Burger', qtySold: 1, revenue: 100, recipeMapped: false }],
    }));
    const out = computeStoreFoodCostVariancePp(A, D1, D3, inventory, WITH, pos);
    expect(out).toEqual(computeStoreFoodCostVariancePp(A, D1, D3, inventory, WITHOUT, pos));
  });

  it('computeStoreFoodCostVariancePp — no POS revenue (entries.length proxy)', () => {
    const out = computeStoreFoodCostVariancePp(A, D1, D3, inventory, WITH, []);
    expect(out).toEqual(computeStoreFoodCostVariancePp(A, D1, D3, inventory, WITHOUT, []));
  });

  it('computeStoreFoodCostSeries (entries.length proxy counts numeric entries only)', () => {
    const now = new Date('2026-08-10T18:00:00.000Z');
    const out = computeStoreFoodCostSeries(A, WITH, 4, now);
    expect(out).toEqual(computeStoreFoodCostSeries(A, WITHOUT, 4, now));
  });

  it('scoped wrappers inherit the strip', () => {
    const now = new Date('2026-08-10T18:00:00.000Z');
    expect(computeScopedFoodCostSeries([A, B], WITH, 4, now))
      .toEqual(computeScopedFoodCostSeries([A, B], WITHOUT, 4, now));
    expect(computeScopedCogs([A, B], D1, D3, inventory, WITH, [], []))
      .toEqual(computeScopedCogs([A, B], D1, D3, inventory, WITHOUT, [], []));
    expect(computeScopedTopVarianceItems([A, B], D1, D3, inventory, WITH, stores, 5))
      .toEqual(computeScopedTopVarianceItems([A, B], D1, D3, inventory, WITHOUT, stores, 5));
  });

  it('the strip never mutates the caller\'s history', () => {
    const before = JSON.stringify(WITHOUT);
    const beforeWith = JSON.stringify(WITH);
    computeVarianceLines(A, inventory, WITHOUT, stores);
    computeCogsActual(A, D1, D3, inventory, WITHOUT);
    computeVarianceLines(A, inventory, WITH, stores);
    computeCogsActual(A, D1, D3, inventory, WITH);
    expect(JSON.stringify(WITHOUT)).toBe(before);
    expect(JSON.stringify(WITH)).toBe(beforeWith);
  });
});
