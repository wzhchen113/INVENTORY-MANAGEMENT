// src/lib/cmdSelectors.scopedRollups.test.ts — Spec 159 Track 1 (jest).
//
// Covers the four scope-aware rollups the Dashboard scope picker runs on:
//   - computeStoreFoodCostSeries      (per-store, extracted verbatim from
//                                      DashboardSection's foodCostTrend14)
//   - computeScopedFoodCostSeries     (AC-B4 per-day unweighted mean)
//   - computeScopedCogs               (AC-B6 Σ theoretical / Σ actual)
//   - computeScopedTopVarianceItems   (AC-B7 / PM-4 merge → re-rank → truncate)
//
// The load-bearing invariant across all four (AC-S4 / AC-S6 / AC-S7): a
// SINGLE-element `storeIds` must reproduce the pre-spec-159 focal-store
// numbers exactly. Every describe below therefore pins a single-store
// identity case alongside the aggregate case. Fixtures span 2 stores plus
// one store with no data at all.
//
// `now` is injected everywhere it matters — never let a wall-clock day
// boundary decide whether this file passes.

// Stub `./supabase`: cmdSelectors.ts transitively imports useStore → db.ts →
// supabase.ts, which calls createClient() at module load and crashes without
// EXPO_PUBLIC_SUPABASE_URL. The functions under test are pure; the import
// chain is the only thing that touches Supabase. Mirrors
// cmdSelectors.unconfirmedPoWindow.test.ts:19.
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
  computeStoreFoodCostSeries,
  computeScopedFoodCostSeries,
  computeScopedCogs,
  computeScopedTopVarianceItems,
  computeCogsTheoretical,
  computeCogsActual,
  computeTopVarianceItems,
  sumScopedWaste,
} from './cmdSelectors';
import type {
  EODSubmission, EODEntry, InventoryItem, POSImport, Recipe, Store, WasteEntry,
} from '../types';

// ── Fixture helpers ────────────────────────────────────────────
const A = 'store-a';
const B = 'store-b';
const EMPTY = 'store-empty'; // visible, but has no EOD / POS / inventory rows

const stores: Store[] = [
  { id: A, brandId: 'brand-1', name: 'Alpha', address: '', status: 'active' },
  { id: B, brandId: 'brand-1', name: 'Bravo', address: '', status: 'active' },
  { id: EMPTY, brandId: 'brand-1', name: 'Empty', address: '', status: 'active' },
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

// `itemName` defaults to '' so the variance rows resolve their label the
// way production rows do (`e.itemName || item.name` → the inventory row).
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

function mkPos(over: Partial<POSImport>): POSImport {
  return {
    id: 'pos', filename: '', importedAt: '', importedBy: '',
    date: '2026-08-10', storeId: A, items: [],
    ...over,
  };
}

// ── computeStoreFoodCostSeries ─────────────────────────────────
describe('computeStoreFoodCostSeries', () => {
  // The v1 mock: 30 + (entries.length % 5) on days with an EOD, null otherwise.
  const NOW = new Date('2026-08-10T18:00:00.000Z'); // UTC day = 2026-08-10

  it('returns one slot per day, oldest → newest, null on days with no EOD', () => {
    const eod = [
      mkEod({ id: 's1', storeId: A, date: '2026-08-08', entries: [mkEntry({}), mkEntry({})] }),
      mkEod({ id: 's2', storeId: A, date: '2026-08-10', entries: [mkEntry({})] }),
    ];

    const series = computeStoreFoodCostSeries(A, eod, 4, NOW);

    // days 08-07, 08-08, 08-09, 08-10
    expect(series).toEqual([null, 32, null, 31]);
  });

  it('ignores other stores\' submissions entirely', () => {
    const eod = [
      mkEod({ id: 's-b', storeId: B, date: '2026-08-10', entries: [mkEntry({ storeId: B })] }),
    ];
    expect(computeStoreFoodCostSeries(A, eod, 2, NOW)).toEqual([null, null]);
  });

  it('a store with no data at all is an all-null series, never zeros', () => {
    // 0% food cost would render as a real (catastrophic) number — null is
    // what makes the sparkline/headline skip the day instead.
    const series = computeStoreFoodCostSeries(EMPTY, [mkEod({ storeId: A })], 3, NOW);
    expect(series).toEqual([null, null, null]);
    expect(series.some((v) => v === 0)).toBe(false);
  });

  it('keeps .find() first-match semantics when a store has two EODs on one day', () => {
    // Per-vendor partitioning (spec 020) means multiple submissions per day
    // are normal. The v1 memo took the FIRST match, not the latest — this is
    // preserved byte for byte (PM-3), quirk and all.
    const eod = [
      mkEod({ id: 'first', storeId: A, date: '2026-08-10', entries: [mkEntry({})] }),          // → 31
      mkEod({ id: 'second', storeId: A, date: '2026-08-10', entries: [mkEntry({}), mkEntry({}), mkEntry({})] }), // → 33
    ];
    expect(computeStoreFoodCostSeries(A, eod, 1, NOW)).toEqual([31]);
  });

  it('wraps the mock at 5 entries (30 + n % 5)', () => {
    const five = [mkEntry({}), mkEntry({}), mkEntry({}), mkEntry({}), mkEntry({})];
    const eod = [mkEod({ storeId: A, date: '2026-08-10', entries: five })];
    expect(computeStoreFoodCostSeries(A, eod, 1, NOW)).toEqual([30]);
  });
});

// ── computeScopedFoodCostSeries ────────────────────────────────
describe('computeScopedFoodCostSeries', () => {
  const NOW = new Date('2026-08-10T18:00:00.000Z');

  const eod = [
    // 08-09: only A has data (32). 08-10: A (31) and B (34).
    mkEod({ id: 'a1', storeId: A, date: '2026-08-09', entries: [mkEntry({}), mkEntry({})] }),
    mkEod({ id: 'a2', storeId: A, date: '2026-08-10', entries: [mkEntry({})] }),
    mkEod({ id: 'b1', storeId: B, date: '2026-08-10', entries: [mkEntry({}), mkEntry({}), mkEntry({}), mkEntry({})] }),
  ];

  it('single-element storeIds is byte-identical to computeStoreFoodCostSeries (AC-S4)', () => {
    expect(computeScopedFoodCostSeries([A], eod, 4, NOW))
      .toEqual(computeStoreFoodCostSeries(A, eod, 4, NOW));
  });

  it('averages per day across only the stores that have a value that day', () => {
    const series = computeScopedFoodCostSeries([A, B], eod, 3, NOW);
    // 08-08: nobody → null. 08-09: A only → 32 (not 16 — B is skipped, not 0).
    // 08-10: (31 + 34) / 2 = 32.5.
    expect(series).toEqual([null, 32, 32.5]);
  });

  it('a day where NO scoped store has a value stays null', () => {
    const series = computeScopedFoodCostSeries([A, B], eod, 5, NOW);
    expect(series.slice(0, 2)).toEqual([null, null]);
  });

  it('a store with no data never drags the mean toward zero', () => {
    const withEmpty = computeScopedFoodCostSeries([A, B, EMPTY], eod, 3, NOW);
    const without = computeScopedFoodCostSeries([A, B], eod, 3, NOW);
    expect(withEmpty).toEqual(without);
  });

  it('empty storeIds yields an all-null series of the requested length', () => {
    expect(computeScopedFoodCostSeries([], eod, 3, NOW)).toEqual([null, null, null]);
  });
});

// ── computeScopedCogs ──────────────────────────────────────────
describe('computeScopedCogs', () => {
  const START = '2026-08-04';
  const END = '2026-08-10';

  // Two stores, one shared catalog ingredient, different per-store costs.
  const inventory: InventoryItem[] = [
    mkItem({ id: 'inv-a', storeId: A, catalogId: 'cat-1', costPerUnit: 2 }),
    mkItem({ id: 'inv-b', storeId: B, catalogId: 'cat-1', costPerUnit: 3 }),
  ];

  const recipes: Recipe[] = [{
    id: 'r-1', menuItem: 'Burger', category: 'main', sellPrice: 10,
    ingredients: [{ itemId: 'cat-1', itemName: 'Beef', quantity: 2, unit: 'lb' }],
    prepItems: [], brandId: 'brand-1', storeId: 'brand-1',
  }];

  const posImports: POSImport[] = [
    mkPos({ id: 'p-a', storeId: A, date: '2026-08-09', items: [
      { menuItem: 'Burger', qtySold: 10, revenue: 100, recipeId: 'r-1', recipeMapped: true },
    ] }),
    mkPos({ id: 'p-b', storeId: B, date: '2026-08-09', items: [
      { menuItem: 'Burger', qtySold: 5, revenue: 50, recipeId: 'r-1', recipeMapped: true },
    ] }),
  ];

  // Depletion: A 100 → 70 (30 × $2 = $60). B 40 → 25 (15 × $3 = $45).
  const eodSubmissions: EODSubmission[] = [
    mkEod({ id: 'a-prior', storeId: A, date: '2026-08-08', entries: [mkEntry({ itemId: 'inv-a', actualRemaining: 100 })] }),
    mkEod({ id: 'a-cur', storeId: A, date: '2026-08-09', entries: [mkEntry({ itemId: 'inv-a', actualRemaining: 70 })] }),
    mkEod({ id: 'b-prior', storeId: B, date: '2026-08-08', entries: [mkEntry({ itemId: 'inv-b', actualRemaining: 40, storeId: B })] }),
    mkEod({ id: 'b-cur', storeId: B, date: '2026-08-09', entries: [mkEntry({ itemId: 'inv-b', actualRemaining: 25, storeId: B })] }),
  ];

  it('single-element storeIds reproduces the focal-store numbers exactly (AC-S6)', () => {
    const scoped = computeScopedCogs([A], START, END, inventory, eodSubmissions, posImports, recipes);
    // Same expressions the deleted useCogsForCurrentStore used.
    const theoretical = computeCogsTheoretical(A, START, END, posImports, recipes, inventory);
    const actual = computeCogsActual(A, START, END, inventory, eodSubmissions);
    expect(scoped).toEqual({
      theoretical,
      actual,
      delta: +(actual - theoretical).toFixed(2),
      pct: theoretical > 0 ? +(((actual - theoretical) / theoretical) * 100).toFixed(1) : 0,
    });
    // Concretely: 10 × 2 × $2 = $40 theoretical, $60 actual.
    expect(scoped).toEqual({ theoretical: 40, actual: 60, delta: 20, pct: 50 });
  });

  it('sums theoretical and actual across the scope (AC-B6)', () => {
    const scoped = computeScopedCogs([A, B], START, END, inventory, eodSubmissions, posImports, recipes);
    // theoretical: A 10×2×$2 = 40, B 5×2×$3 = 30 → 70.
    // actual:      A $60,             B $45      → 105.
    expect(scoped.theoretical).toBe(70);
    expect(scoped.actual).toBe(105);
    expect(scoped.delta).toBe(35);
    expect(scoped.pct).toBe(50);
  });

  it('a store with no data contributes nothing (order-independent)', () => {
    const withEmpty = computeScopedCogs([A, EMPTY, B], START, END, inventory, eodSubmissions, posImports, recipes);
    const without = computeScopedCogs([A, B], START, END, inventory, eodSubmissions, posImports, recipes);
    expect(withEmpty).toEqual(without);
  });

  it('pct collapses to 0 when Σtheoretical is 0 rather than dividing by zero', () => {
    const scoped = computeScopedCogs([A, B], START, END, inventory, eodSubmissions, [], recipes);
    expect(scoped.theoretical).toBe(0);
    expect(scoped.actual).toBe(105);
    expect(scoped.pct).toBe(0);
    expect(Number.isFinite(scoped.delta)).toBe(true);
  });

  it('empty storeIds is an all-zero rollup, not NaN', () => {
    expect(computeScopedCogs([], START, END, inventory, eodSubmissions, posImports, recipes))
      .toEqual({ theoretical: 0, actual: 0, delta: 0, pct: 0 });
  });

  it('does not leak binary-float dust when summing already-rounded per-store values', () => {
    // 0.1 + 0.2 territory: each per-store value is 2dp, the sum must stay 2dp.
    const inv = [
      mkItem({ id: 'i-a', storeId: A, catalogId: 'cat-1', costPerUnit: 0.1 }),
      mkItem({ id: 'i-b', storeId: B, catalogId: 'cat-1', costPerUnit: 0.2 }),
    ];
    const eod = [
      mkEod({ id: 'pa', storeId: A, date: '2026-08-08', entries: [mkEntry({ itemId: 'i-a', actualRemaining: 1 })] }),
      mkEod({ id: 'ca', storeId: A, date: '2026-08-09', entries: [mkEntry({ itemId: 'i-a', actualRemaining: 0 })] }),
      mkEod({ id: 'pb', storeId: B, date: '2026-08-08', entries: [mkEntry({ itemId: 'i-b', actualRemaining: 1, storeId: B })] }),
      mkEod({ id: 'cb', storeId: B, date: '2026-08-09', entries: [mkEntry({ itemId: 'i-b', actualRemaining: 0, storeId: B })] }),
    ];
    const scoped = computeScopedCogs([A, B], START, END, inv, eod, [], recipes);
    expect(scoped.actual).toBe(0.3);
  });

  // DOCUMENTATION-ONLY (spec 159 Risk R-B / fix-pass item 4) — this test
  // records `computeScopedCogs`'s behavior with an EMPTY `recipes` array; it
  // is NOT a regression guard for the R-B cross-brand limitation and cannot
  // become one. `computeScopedCogs` is brand-unaware by construction — it
  // only ever sees whatever `recipes` array its caller passes — so the R-B
  // bug lives entirely at the DashboardSection call site (the `recipes`
  // slice it holds is the FOCAL store's brand only, via
  // `fetchAllForStore` → `fetchRecipes(brandId)`), not in this function.
  // If the OQ-4 follow-up ever lands a cross-brand recipe fetch, this exact
  // test — `recipes: []` — still asserts `theoretical: 0`, unmodified,
  // because it hands the function no recipes at all regardless of what the
  // real app would now have loaded. It would NOT catch a regression to R-B,
  // and it would NOT go red once R-B is fixed. The real regression guard for
  // R-B is the component-level test in
  // `DashboardSection.scopePicker.spec159.test.tsx` ("AC-B6 (R-B pin)"),
  // which exercises the actual call site with a `recipes` slice populated
  // for only ONE of two scoped brands — that test's `theoretical` assertion
  // is what should go red first when OQ-4 lands.
  it('documents computeScopedCogs with an EMPTY recipes array (not a call-site regression guard)', () => {
    const scoped = computeScopedCogs([A, B], START, END, inventory, eodSubmissions, posImports, []);
    expect(scoped.theoretical).toBe(0);   // no recipes at all → nothing to deplete against
    expect(scoped.actual).toBe(105);      // ...but actual is still fully counted
  });
});

// ── computeScopedTopVarianceItems ──────────────────────────────
describe('computeScopedTopVarianceItems', () => {
  const START = '2026-08-04';
  const END = '2026-08-10';

  // Per-store item ids never collide (inventory_items.id is per-store), which
  // is why merging per-store top-N lists is equivalent to a global top-N (PM-4).
  const inventory: InventoryItem[] = [
    mkItem({ id: 'a-1', storeId: A, name: 'A-Big', costPerUnit: 10 }),
    mkItem({ id: 'a-2', storeId: A, name: 'A-Small', costPerUnit: 1 }),
    mkItem({ id: 'b-1', storeId: B, name: 'B-Huge', costPerUnit: 50 }),
    mkItem({ id: 'b-2', storeId: B, name: 'B-Mid', costPerUnit: 5 }),
  ];

  const eodSubmissions: EODSubmission[] = [
    mkEod({ id: 'a-prior', storeId: A, date: '2026-08-08', entries: [
      mkEntry({ id: 'e1', itemId: 'a-1', actualRemaining: 10 }),
      mkEntry({ id: 'e2', itemId: 'a-2', actualRemaining: 10 }),
    ] }),
    mkEod({ id: 'a-cur', storeId: A, date: '2026-08-09', entries: [
      mkEntry({ id: 'e3', itemId: 'a-1', actualRemaining: 8 }),   // Δ -2 × $10 = -20
      mkEntry({ id: 'e4', itemId: 'a-2', actualRemaining: 7 }),   // Δ -3 × $1  = -3
    ] }),
    mkEod({ id: 'b-prior', storeId: B, storeName: '', date: '2026-08-08', entries: [
      mkEntry({ id: 'e5', itemId: 'b-1', actualRemaining: 10, storeId: B }),
      mkEntry({ id: 'e6', itemId: 'b-2', actualRemaining: 10, storeId: B }),
    ] }),
    mkEod({ id: 'b-cur', storeId: B, date: '2026-08-09', entries: [
      mkEntry({ id: 'e7', itemId: 'b-1', actualRemaining: 9, storeId: B }),  // Δ -1 × $50 = -50
      mkEntry({ id: 'e8', itemId: 'b-2', actualRemaining: 6, storeId: B }),  // Δ -4 × $5  = -20
    ] }),
  ];

  it('single-element storeIds is identical to computeTopVarianceItems (AC-S7)', () => {
    expect(computeScopedTopVarianceItems([A], START, END, inventory, eodSubmissions, stores, 5))
      .toEqual(computeTopVarianceItems(A, START, END, inventory, eodSubmissions, stores, 5));
  });

  it('merges per-store lists and re-ranks globally by |deltaCost| desc', () => {
    const rows = computeScopedTopVarianceItems([A, B], START, END, inventory, eodSubmissions, stores, 5);
    expect(rows.map((r) => r.itemName)).toEqual(['B-Huge', 'A-Big', 'B-Mid', 'A-Small']);
    expect(rows.map((r) => r.deltaCost)).toEqual([-50, -20, -20, -3]);
  });

  it('tags every row with the store it came from (PM-5 store-name column)', () => {
    const rows = computeScopedTopVarianceItems([A, B], START, END, inventory, eodSubmissions, stores, 5);
    const byName = new Map(rows.map((r) => [r.itemName, r]));
    expect(byName.get('A-Big')).toMatchObject({ storeId: A, storeName: 'Alpha' });
    expect(byName.get('B-Huge')).toMatchObject({ storeId: B, storeName: 'Bravo' });
  });

  it('truncates the merged list to `limit`', () => {
    const rows = computeScopedTopVarianceItems([A, B], START, END, inventory, eodSubmissions, stores, 2);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.itemName)).toEqual(['B-Huge', 'A-Big']);
  });

  it('breaks |deltaCost| ties by storeIds order (stable sort, deterministic)', () => {
    // A-Big and B-Mid are both -20. Iterating [A, B] puts A-Big first;
    // iterating [B, A] puts B-Mid first. Nothing here is engine-dependent.
    const ab = computeScopedTopVarianceItems([A, B], START, END, inventory, eodSubmissions, stores, 5);
    const ba = computeScopedTopVarianceItems([B, A], START, END, inventory, eodSubmissions, stores, 5);
    expect(ab.filter((r) => Math.abs(r.deltaCost) === 20).map((r) => r.itemName))
      .toEqual(['A-Big', 'B-Mid']);
    expect(ba.filter((r) => Math.abs(r.deltaCost) === 20).map((r) => r.itemName))
      .toEqual(['B-Mid', 'A-Big']);
  });

  it('a store with no data contributes no rows', () => {
    const withEmpty = computeScopedTopVarianceItems([A, EMPTY, B], START, END, inventory, eodSubmissions, stores, 5);
    const without = computeScopedTopVarianceItems([A, B], START, END, inventory, eodSubmissions, stores, 5);
    expect(withEmpty).toEqual(without);
  });

  it('empty storeIds yields []', () => {
    expect(computeScopedTopVarianceItems([], START, END, inventory, eodSubmissions, stores, 5)).toEqual([]);
  });
});

// ── sumScopedWaste ──────────────────────────────────────────────
// Spec 159 fix-pass item 1 — extracted so wasteWeek and wasteEventCount
// (DashboardSection.tsx) share ONE copy of the scope filter, the 7-day
// window, the R-A isFinite guard, and the UNBRIDGED cost rule (spec 104
// R1). The load-bearing assertion is the last case below: a row carrying a
// `subUnitSize` must NOT be multiplied by it — waste's `costPerUnit` is a
// frozen per-counted-unit snapshot, unlike the LIVE inventory reads
// elsewhere in the section that DO bridge with `× (subUnitSize || 1)`.
describe('sumScopedWaste', () => {
  const NOW_MS = new Date('2026-08-10T12:00:00.000Z').getTime();
  const WITHIN = new Date(NOW_MS - 2 * 24 * 3600 * 1000).toISOString(); // 2 days ago
  const OUT_OF_WINDOW = new Date(NOW_MS - 8 * 24 * 3600 * 1000).toISOString(); // 8 days ago

  function mkWaste(over: Partial<WasteEntry>): WasteEntry {
    return {
      id: 'w', itemId: 'item', itemName: '', quantity: 1, unit: 'lb',
      costPerUnit: 1, reason: 'Expired', loggedBy: '', loggedByUserId: '',
      timestamp: WITHIN, notes: '', storeId: A,
      ...over,
    };
  }

  it('sums quantity × costPerUnit across scoped stores, counting events in the same pass', () => {
    const entries = [
      mkWaste({ id: 'w1', storeId: A, quantity: 3, costPerUnit: 2, timestamp: WITHIN }), // $6
      mkWaste({ id: 'w2', storeId: B, quantity: 1, costPerUnit: 5, timestamp: WITHIN }), // $5
    ];
    const result = sumScopedWaste(entries, new Set([A, B]), NOW_MS);
    expect(result).toEqual({ dollars: 11, events: 2 });
  });

  it('excludes a row outside the trailing 7-day window', () => {
    const entries = [
      mkWaste({ id: 'w1', storeId: A, quantity: 3, costPerUnit: 2, timestamp: WITHIN }),      // in
      mkWaste({ id: 'w2', storeId: A, quantity: 100, costPerUnit: 100, timestamp: OUT_OF_WINDOW }), // out
    ];
    const result = sumScopedWaste(entries, new Set([A]), NOW_MS);
    expect(result).toEqual({ dollars: 6, events: 1 });
  });

  it('excludes a store outside scopeIds', () => {
    const entries = [
      mkWaste({ id: 'w1', storeId: A, quantity: 3, costPerUnit: 2, timestamp: WITHIN }),
      mkWaste({ id: 'w2', storeId: B, quantity: 999, costPerUnit: 999, timestamp: WITHIN }),
    ];
    const result = sumScopedWaste(entries, new Set([A]), NOW_MS);
    expect(result).toEqual({ dollars: 6, events: 1 });
  });

  it('R-A guard: an unparseable focal timestamp is dropped explicitly, not NaN-compared', () => {
    const entries = [
      mkWaste({ id: 'w1', storeId: A, quantity: 3, costPerUnit: 2, timestamp: WITHIN }),
      // A locale-string timestamp Date.parse can't parse in this runtime —
      // simulates fetchWasteLog's toLocaleString() under a hostile locale.
      mkWaste({ id: 'w2', storeId: A, quantity: 100, costPerUnit: 100, timestamp: 'not-a-date' }),
    ];
    const result = sumScopedWaste(entries, new Set([A]), NOW_MS);
    expect(result).toEqual({ dollars: 6, events: 1 });
  });

  // Spec 104 R1 — the exact regression this test exists to catch. WasteEntry
  // has no subUnitSize field; a row that carries one anyway (`as any`, e.g.
  // an accidental future join) must still be summed UNBRIDGED. If a future
  // edit adds `* (subUnitSize || 1)` to sumScopedWaste — the exact mistake
  // spec 104 R1 exists to prevent, and one that looks correct next to
  // totalInvValue's bridge two memos away in DashboardSection — this must
  // fail.
  it('does NOT apply the spec-104 subUnitSize bridge (frozen per-counted-unit snapshot)', () => {
    const entries = [
      mkWaste({
        id: 'w1', storeId: A, quantity: 4, costPerUnit: 10, timestamp: WITHIN,
        ...( { subUnitSize: 6 } as any ),
      }),
    ];
    const result = sumScopedWaste(entries, new Set([A]), NOW_MS);
    // UNBRIDGED: 4 × $10 = $40. A `× subUnitSize` bridge would read $240.
    expect(result.dollars).toBe(40);
  });

  it('empty entries / empty scopeIds yields a zero rollup', () => {
    expect(sumScopedWaste([], new Set([A]), NOW_MS)).toEqual({ dollars: 0, events: 0 });
    expect(sumScopedWaste([mkWaste({ storeId: A })], new Set(), NOW_MS)).toEqual({ dollars: 0, events: 0 });
  });
});
