// src/screens/cmd/sections/__tests__/DashboardSection.scopePicker.spec159.test.tsx
//
// Spec 159 AC-T2 — component tests for the Dashboard-local scope picker.
//
//   AC-P2 / AC-S9  default scope is the SELECTED store → exactly one card
//   AC-B9          "All stores" → one card per VISIBLE store
//   AC-S1 / AC-B1  the headline TOTAL INV VALUE follows the scope
//   AC-P4          a global title-bar store change resets the scope
//   AC-V1          a store outside visibleStoresFor(...) is never an option
//                  (and never a card)
//   AC-P5          a scope narrowed away by a brand switch degrades to `all`,
//                  not to an empty dashboard
//   AC-P7          one visible store still renders the picker + the aggregate
//   OQ-1           the phone model is single-store even though `inventory` is
//                  cross-store (the regression this spec fixed for free)
//
// The pure aggregate reducers are covered separately in
// src/lib/cmdSelectors.scopedRollups.test.ts (AC-T1); this file is the wiring.

import React from 'react';
import { render, fireEvent, act } from '@testing-library/react-native';

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, left: 0, right: 0, bottom: 0 }),
}));

jest.mock('../../../../lib/supabase', () => ({
  __esModule: true,
  supabase: {
    auth: {
      getSession: jest.fn(() => Promise.resolve({ data: { session: null }, error: null })),
      onAuthStateChange: jest.fn(() => ({ data: { subscription: { unsubscribe: jest.fn() } } })),
    },
    from: jest.fn(() => ({
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      order: jest.fn().mockReturnThis(),
      single: jest.fn(() => Promise.resolve({ data: null, error: null })),
      maybeSingle: jest.fn(() => Promise.resolve({ data: null, error: null })),
    })),
    rpc: jest.fn(() => Promise.resolve({ data: null, error: null })),
    channel: jest.fn(() => ({
      on: jest.fn().mockReturnThis(),
      subscribe: jest.fn(() => ({ unsubscribe: jest.fn() })),
    })),
    removeChannel: jest.fn(),
    functions: { invoke: jest.fn() },
  },
}));

// The five cross-store reads the mount effect fires. They must resolve to the
// real EMPTY SHAPE (not null) — the merge memos spread them.
jest.mock('../../../../lib/db', () => {
  const explicit: Record<string, unknown> = {
    fetchEodSubmissionsForStores: jest.fn(() => Promise.resolve([])),
    fetchPosImportsForStores: jest.fn(() => Promise.resolve([])),
    fetchOrderScheduleForStores: jest.fn(() => Promise.resolve({})),
    fetchOrderSubmissionsForStores: jest.fn(() => Promise.resolve([])),
    fetchWasteLogForStores: jest.fn(() => Promise.resolve([])),
  };
  return new Proxy(
    { __esModule: true, ...explicit },
    {
      get: (t: Record<string, unknown>, p: string) =>
        p in t ? t[p] : jest.fn(() => Promise.resolve(null)),
    },
  );
});

let mockTier: 'phone' | 'tablet' | 'desktop' = 'desktop';
jest.mock('../../../../theme/breakpoints', () => {
  const actual = jest.requireActual('../../../../theme/breakpoints');
  return {
    ...actual,
    useIsPhone: () => mockTier === 'phone',
    useIsTablet: () => mockTier === 'tablet',
    useIsDesktop: () => mockTier === 'desktop',
    useIsCompact: () => mockTier !== 'desktop',
    useBreakpoint: () => mockTier,
  };
});

import DashboardSection from '../DashboardSection';
import { useStore } from '../../../../store/useStore';
import * as db from '../../../../lib/db';

const BRAND_A = 'brand-a';
const BRAND_B = 'brand-b';

const store = (id: string, name: string, brandId: string) =>
  ({ id, brandId, name, address: '', status: 'active' }) as any;

const TOWSON = store('store-1', 'Towson', BRAND_A);
const FREDERICK = store('store-2', 'Frederick', BRAND_A);
const OTHER_BRAND = store('store-3', 'Seafood Co', BRAND_B);

// Towson = $1,000.00 of stock, Frederick = $2,000.00 → all-stores = $3,000.00.
// The KPI renders `$${(value / 1000).toFixed(1)}k`, so the three scopes read
// $1.0k / $2.0k / $3.0k and are trivially distinguishable.
const item = (id: string, storeId: string, stock: number) =>
  ({
    id,
    storeId,
    name: `item-${id}`,
    unit: 'ea',
    currentStock: stock,
    parLevel: 1,
    costPerUnit: 10,
    subUnitSize: 1,
    category: 'Dry',
  }) as any;

function seed(overrides: Record<string, unknown> = {}) {
  useStore.setState({
    currentStore: TOWSON,
    currentUser: { id: 'user-1', name: 'Admin', email: 'a@b.c', role: 'admin', stores: [] } as any,
    currentBrandId: BRAND_A,
    brand: { id: BRAND_A, name: '2AM PROJECT' } as any,
    brandsList: [{ id: BRAND_A, name: '2AM PROJECT' }, { id: BRAND_B, name: 'SEAFOOD' }] as any,
    stores: [TOWSON, FREDERICK, OTHER_BRAND],
    inventory: [item('i1', 'store-1', 100), item('i2', 'store-2', 200), item('i3', 'store-3', 900)],
    vendors: [],
    recipes: [],
    eodSubmissions: [],
    posImports: [],
    orderSubmissions: [],
    orderSchedule: {},
    wasteLog: [],
    auditLog: [],
    users: [],
    storeLoading: false,
    darkMode: false,
    ...overrides,
  } as any);
}

beforeEach(() => {
  jest.clearAllMocks();
  mockTier = 'desktop';
  seed();
});

// The mount effect fires five (mocked) cross-store reads whose `.then`s land
// outside React's batch; flushing them here keeps every assertion below on a
// settled tree and off the act() warning.
async function mount() {
  const view = render(<DashboardSection />);
  await act(async () => {});
  return view;
}

describe('Spec 159 — Dashboard scope picker', () => {
  it('AC-P2/AC-S9/AC-S1: defaults to the selected store — one card, one store’s value', async () => {
    const { queryByTestId, queryAllByText } = await mount();
    expect(queryByTestId('dashboard-store-card-store-1')).toBeTruthy();
    expect(queryByTestId('dashboard-store-card-store-2')).toBeNull();
    // Towson alone. ($1.0k also appears on Towson's own card mini-stat, which
    // is the point — the headline and the card finally agree.)
    expect(queryAllByText('$1.0k').length).toBeGreaterThan(0);
    expect(queryAllByText('$3.0k')).toHaveLength(0);
  });

  it('AC-B9/AC-B1: "All stores" renders every visible store, then back to one', async () => {
    const { queryByTestId, getByTestId, queryAllByText } = await mount();

    fireEvent.press(getByTestId('dashboard-scope-picker'));
    fireEvent.press(getByTestId('dashboard-scope-option-all'));

    expect(queryByTestId('dashboard-store-card-store-1')).toBeTruthy();
    expect(queryByTestId('dashboard-store-card-store-2')).toBeTruthy();
    // AC-B1 — Towson + Frederick only; the out-of-brand store's $9,000 is
    // EXCLUDED from the headline (it used to be summed unfiltered).
    expect(queryAllByText('$3.0k').length).toBeGreaterThan(0);

    fireEvent.press(getByTestId('dashboard-scope-picker'));
    fireEvent.press(getByTestId('dashboard-scope-option-store-2'));

    expect(queryByTestId('dashboard-store-card-store-1')).toBeNull();
    expect(queryByTestId('dashboard-store-card-store-2')).toBeTruthy();
    expect(queryAllByText('$2.0k').length).toBeGreaterThan(0);
    expect(queryAllByText('$3.0k')).toHaveLength(0);
  });

  it('AC-P4: a global title-bar store change resets the scope out of `all`', async () => {
    const { queryByTestId, getByTestId } = await mount();

    fireEvent.press(getByTestId('dashboard-scope-picker'));
    fireEvent.press(getByTestId('dashboard-scope-option-all'));
    expect(queryByTestId('dashboard-store-card-store-2')).toBeTruthy();

    await act(async () => {
      useStore.setState({ currentStore: FREDERICK } as any);
    });

    expect(queryByTestId('dashboard-store-card-store-1')).toBeNull();
    expect(queryByTestId('dashboard-store-card-store-2')).toBeTruthy();
  });

  it('AC-V1: a store outside visibleStoresFor(...) is neither an option nor a card', async () => {
    const { queryByTestId, getByTestId } = await mount();

    fireEvent.press(getByTestId('dashboard-scope-picker'));
    expect(queryByTestId('dashboard-scope-option-store-1')).toBeTruthy();
    expect(queryByTestId('dashboard-scope-option-store-2')).toBeTruthy();
    // Other brand — narrowed away by currentBrandId.
    expect(queryByTestId('dashboard-scope-option-store-3')).toBeNull();

    fireEvent.press(getByTestId('dashboard-scope-option-all'));
    expect(queryByTestId('dashboard-store-card-store-3')).toBeNull();
  });

  it('AC-P5: a scope narrowed away by a brand switch degrades to `all`, not to empty', async () => {
    const { queryByTestId, getByTestId } = await mount();

    fireEvent.press(getByTestId('dashboard-scope-picker'));
    fireEvent.press(getByTestId('dashboard-scope-option-store-2'));
    expect(queryByTestId('dashboard-store-card-store-2')).toBeTruthy();

    await act(async () => {
      useStore.setState({ currentBrandId: BRAND_B } as any);
    });

    // store-2 is no longer visible; the dashboard falls back to the aggregate
    // over the NEW visible set rather than rendering nothing.
    expect(queryByTestId('dashboard-store-card-store-2')).toBeNull();
    expect(queryByTestId('dashboard-store-card-store-3')).toBeTruthy();
  });

  it('AC-P7: a single visible store still renders the picker and the aggregate option', async () => {
    seed({ stores: [TOWSON], currentBrandId: BRAND_A });
    const { getByTestId, queryByTestId } = await mount();

    fireEvent.press(getByTestId('dashboard-scope-picker'));
    expect(queryByTestId('dashboard-scope-option-all')).toBeTruthy();
    expect(queryByTestId('dashboard-scope-option-store-1')).toBeTruthy();
  });

  it('OQ-1: the phone model is single-store even though `inventory` is cross-store', async () => {
    mockTier = 'phone';
    const { getByTestId } = await mount();
    // Towson only ($1,000.00) — NOT the $12,000.00 cross-store slice total.
    expect(getByTestId('phone-dash-kpi-invValue-value').props.children).toBe('$1,000.00');
  });

  // ── Fix-pass item 3 — remaining NOT-TESTED acceptance criteria batched
  // into this file (scaffolding already exists; no new file/hook/framework).

  it('AC-S2/AC-B2: STOCK ALERTS value + out/low sub-label follow the scope', async () => {
    seed({
      inventory: [
        item('ok-1', 'store-1', 100),
        { ...item('out-1', 'store-1', 0) }, // out at Towson
        { ...item('low-1', 'store-1', 3), parLevel: 5 }, // low at Towson (3 < 5, > 0)
        item('ok-2', 'store-2', 200),
        { ...item('out-2', 'store-2', 0) }, // out at Frederick
      ],
    });
    const { getByTestId, queryAllByText } = await mount();

    // AC-S2 — single-store (Towson, default): 1 out, 1 low.
    expect(queryAllByText('1 out · 1 low').length).toBeGreaterThan(0);

    fireEvent.press(getByTestId('dashboard-scope-picker'));
    fireEvent.press(getByTestId('dashboard-scope-option-all'));

    // AC-B2 — all-stores: Towson's out+low plus Frederick's out.
    expect(queryAllByText('2 out · 1 low').length).toBeGreaterThan(0);
  });

  it('AC-S5/AC-B5: EOD SUBMITTED renders x/N for the scope', async () => {
    const todayISO = new Date().toISOString().slice(0, 10);
    seed({
      eodSubmissions: [
        {
          id: 'e1', storeId: 'store-1', date: todayISO, storeName: '', vendorId: 'v-1',
          submittedBy: '', submittedByUserId: '', timestamp: '', itemCount: 0,
          status: 'submitted', entries: [],
        } as any,
      ],
    });
    const { getByTestId, queryAllByText } = await mount();

    // AC-S5 — single-store (Towson, default): submitted today → 1/1.
    expect(queryAllByText('1/1').length).toBeGreaterThan(0);

    fireEvent.press(getByTestId('dashboard-scope-picker'));
    fireEvent.press(getByTestId('dashboard-scope-option-store-2'));
    // Frederick alone: no submission today → 0/1.
    expect(queryAllByText('0/1').length).toBeGreaterThan(0);

    fireEvent.press(getByTestId('dashboard-scope-picker'));
    fireEvent.press(getByTestId('dashboard-scope-option-all'));
    // AC-B5 — all-stores (Towson + Frederick): 1/2.
    expect(queryAllByText('1/2').length).toBeGreaterThan(0);
  });

  it('AC-S8/AC-B8: heatmap renders one row per scoped store', async () => {
    const { getByTestId, queryAllByTestId } = await mount();

    // AC-S8 — single-store (Towson, default): exactly one row.
    expect(queryAllByTestId(/^heatmap-row-/).length).toBe(1);

    fireEvent.press(getByTestId('dashboard-scope-picker'));
    fireEvent.press(getByTestId('dashboard-scope-option-all'));

    // AC-B8 — all-stores: one row per visible store (Towson + Frederick;
    // the out-of-brand store is excluded per AC-V1/AC-V3).
    expect(queryAllByTestId(/^heatmap-row-/).length).toBe(2);
  });

  it('AC-V2: the mount-time cross-store fetch requests only visibleStores ids, not raw `stores`', async () => {
    await mount();

    // `stores` (seeded) includes the out-of-brand store-3; visibleStores
    // (currentBrandId = BRAND_A) does not. Every one of the five mount-time
    // reads must be called with the NARROWED id list.
    const wasteIds = (db.fetchWasteLogForStores as jest.Mock).mock.calls[0][0];
    const eodIds = (db.fetchEodSubmissionsForStores as jest.Mock).mock.calls[0][0];
    expect([...wasteIds].sort()).toEqual(['store-1', 'store-2']);
    expect([...eodIds].sort()).toEqual(['store-1', 'store-2']);
    expect(wasteIds).not.toContain('store-3');
    expect(eodIds).not.toContain('store-3');
  });

  it('AC-P3: selecting a scope option touches ONLY Dashboard-local state', async () => {
    const { getByTestId } = await mount();
    const setStateSpy = jest.spyOn(useStore, 'setState');
    const callsBefore = setStateSpy.mock.calls.length;

    fireEvent.press(getByTestId('dashboard-scope-picker'));
    fireEvent.press(getByTestId('dashboard-scope-option-all'));

    // `onSelect={setScope}` is a plain React.useState setter — selecting an
    // option must not call useStore.setState (no setCurrentStore, no
    // `profiles` write, no currentBrandId touch, per AC-P3).
    expect(setStateSpy.mock.calls.length).toBe(callsBefore);
    setStateSpy.mockRestore();
  });

  describe('AC-S10/AC-B10/AC-I2/AC-I3: hero title + greeting name the scope', () => {
    it('single-store: hero + greeting name the store', async () => {
      const { getByTestId } = await mount();
      expect(getByTestId('dashboard-hero-title').props.children).toBe('Towson · day in progress');
      expect(getByTestId('dashboard-greeting').props.children).toMatch(/Towson$/);
    });

    it('all-stores, single brand resolved: hero + greeting are brand-named (OQ-2)', async () => {
      const { getByTestId } = await mount();
      fireEvent.press(getByTestId('dashboard-scope-picker'));
      fireEvent.press(getByTestId('dashboard-scope-option-all'));

      // Only Towson + Frederick are visible (currentBrandId = BRAND_A) — one
      // distinct brandId, so the resolver prints the brand name, not the
      // generic fallback.
      expect(getByTestId('dashboard-hero-title').props.children)
        .toBe('2AM PROJECT · 2 stores · day in progress');
      expect(getByTestId('dashboard-greeting').props.children).toMatch(/2 stores$/);
    });

    it('all-stores, cross-brand scope: hero falls back to the generic count label', async () => {
      // Super-admin on "All brands" — visibleStores spans BRAND_A (Towson,
      // Frederick) and BRAND_B (Seafood Co): >1 distinct brandId, so
      // aggregateLabelFor must NOT print a brand name over the mixed set.
      seed({ currentBrandId: null });
      const { getByTestId } = await mount();
      fireEvent.press(getByTestId('dashboard-scope-picker'));
      fireEvent.press(getByTestId('dashboard-scope-option-all'));

      expect(getByTestId('dashboard-hero-title').props.children)
        .toBe('All stores (3) · day in progress');
      expect(getByTestId('dashboard-greeting').props.children).toMatch(/3 stores$/);
    });
  });

  // ── Fix-pass item 4 — the REAL AC-B6/R-B regression guard, at the layer
  // where the bug actually lives (the DashboardSection call site), not the
  // brand-unaware computeScopedCogs pure function. See the sibling
  // documentation-only test in cmdSelectors.scopedRollups.test.ts for why
  // that pure-function test cannot serve this purpose.
  describe('AC-B6 (R-B pin): cross-brand CoGS understates theoretical, not actual', () => {
    it('a scope spanning two brands, with recipes loaded for only ONE, renders the understated theoretical', async () => {
      const todayISO = new Date().toISOString().slice(0, 10);
      const priorISO = new Date(Date.now() - 24 * 3600 * 1000).toISOString().slice(0, 10);

      // Towson (BRAND_A) carries a catalogId the seeded `recipes` DOES cover.
      // Seafood Co (BRAND_B) carries a catalogId `recipes` has never heard
      // of — mirroring the real R-B shape: `recipes` only ever holds the
      // FOCAL store's brand (fetchAllForStore → fetchRecipes(brandId)).
      const towsonInv = { ...item('inv-t', 'store-1', 0), catalogId: 'cat-1', costPerUnit: 2 };
      const otherInv = { ...item('inv-o', 'store-3', 0), catalogId: 'cat-9', costPerUnit: 5 };

      const eodEntry = (itemId: string, storeId: string, remaining: number, date: string) =>
        ({
          id: `${itemId}-${date}`, itemId, itemName: '', actualRemaining: remaining, unit: 'ea',
          submittedBy: '', submittedByUserId: '', timestamp: '', date, storeId, notes: '',
        }) as any;
      const eod = (id: string, storeId: string, date: string, entries: any[]) =>
        ({
          id, date, storeId, storeName: '', vendorId: '', submittedBy: '', submittedByUserId: '',
          timestamp: '', itemCount: entries.length, status: 'submitted', entries,
        }) as any;

      seed({
        currentBrandId: null, // super-admin, "All brands" — visibleStores spans both brands
        inventory: [towsonInv, otherInv],
        recipes: [
          {
            id: 'r-1', menuItem: 'Burger', category: 'main', sellPrice: 10,
            ingredients: [{ itemId: 'cat-1', itemName: 'Beef', quantity: 2, unit: 'lb' }],
            prepItems: [], brandId: BRAND_A, storeId: BRAND_A,
          },
        ] as any,
        posImports: [
          {
            id: 'p-t', storeId: 'store-1', date: todayISO, filename: '', importedAt: '',
            importedBy: '',
            items: [{ menuItem: 'Burger', qtySold: 10, revenue: 100, recipeId: 'r-1', recipeMapped: true }],
          },
        ] as any,
        eodSubmissions: [
          eod('eod-t-prior', 'store-1', priorISO, [eodEntry('inv-t', 'store-1', 100, priorISO)]),
          eod('eod-t-cur', 'store-1', todayISO, [eodEntry('inv-t', 'store-1', 70, todayISO)]),
          eod('eod-o-prior', 'store-3', priorISO, [eodEntry('inv-o', 'store-3', 50, priorISO)]),
          eod('eod-o-cur', 'store-3', todayISO, [eodEntry('inv-o', 'store-3', 40, todayISO)]),
        ],
      });

      const { getByTestId, queryAllByText } = await mount();
      fireEvent.press(getByTestId('dashboard-scope-picker'));
      fireEvent.press(getByTestId('dashboard-scope-option-all'));

      // Towson: 10 qty × 2/recipe × $2/unit = $40 theoretical; 30-unit
      // depletion × $2 = $60 actual.
      // Seafood Co: $0 theoretical (R-B — its brand's recipes were never
      // loaded) even though its 10-unit depletion × $5 = $50 IS fully
      // counted in `actual`. Combined: $40 theoretical, $110 actual.
      //
      // This is the regression guard: if a future cross-brand recipe fetch
      // (OQ-4) makes Seafood Co's theoretical non-zero, `$40` stops
      // rendering and this assertion goes red — unlike the
      // cmdSelectors.scopedRollups.test.ts pure-function test, which cannot
      // detect that fix (see that test's own comment).
      expect(queryAllByText('$40').length).toBeGreaterThan(0);
      expect(queryAllByText('$110').length).toBeGreaterThan(0);

      // The label mitigation (M-3 fix, fix-pass item 5): the hero must NOT
      // claim a brand over this understated cross-brand number.
      expect(getByTestId('dashboard-hero-title').props.children)
        .toBe('All stores (3) · day in progress');
    });
  });
});
