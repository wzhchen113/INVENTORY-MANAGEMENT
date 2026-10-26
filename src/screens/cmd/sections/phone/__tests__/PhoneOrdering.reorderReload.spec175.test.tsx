// src/screens/cmd/sections/phone/__tests__/PhoneOrdering.reorderReload.spec175.test.tsx
//
// Spec 175 (AC-19) — the phone Ordering list survives a same-store reload.
//
// The owner's bug: exporting a vendor's CSV / PDF records a draft PO, whose
// realtime self-echo runs `loadFromSupabase(currentStore.id)`, which used to
// null `reorderPayload` — the screen fell to "No reorder suggestions" /
// "0 VENDORS · 0 LINES" until the user navigated away and back.
//
// Harness follows PhoneOrdering.lastOrderContext.spec151.test.tsx (REAL store,
// `db` + supabase stubbed) with three deliberate differences, each of which
// would otherwise make the suite pass vacuously or crash:
//   1. `getSession` returns a session WITH a user, so the real
//      `hasActiveSession()` is true and `loadFromSupabase` gets past the
//      spec-152 probe instead of bailing (which would leave the payload alone
//      for the wrong reason).
//   2. The `db` Proxy defines `fetchStores`, `fetchAllForStore` & co.
//      explicitly; `fetchAllForStore` returns an `orderSchedule` covering the
//      vendor — the reload REPLACES `orderSchedule`, and an empty schedule
//      would empty the vendor partition (→ `phone-order-empty`) whether or not
//      the payload survived.
//   3. No store action is stubbed — the real `loadFromSupabase` runs.
// The "control (no owner tag)" case proves the harness CAN see the bug: with no owner tag,
// the same reload clears the list and `phone-order-empty` renders.

import React from 'react';
import { act, render } from '@testing-library/react-native';

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, left: 0, right: 0, bottom: 0 }),
}));

jest.mock('react-native-toast-message', () => ({
  __esModule: true,
  default: { show: jest.fn(), hide: jest.fn() },
}));

jest.mock('../../../../../lib/supabase', () => ({
  __esModule: true,
  supabase: {
    auth: {
      // (1) a live session — see the header.
      getSession: jest.fn(() => Promise.resolve({ data: { session: { user: { id: 'u1' } } }, error: null })),
      onAuthStateChange: jest.fn(() => ({ data: { subscription: { unsubscribe: jest.fn() } } })),
    },
    from: jest.fn(() => ({ select: jest.fn().mockReturnThis(), eq: jest.fn().mockReturnThis(), order: jest.fn().mockReturnThis(), single: jest.fn(() => Promise.resolve({ data: null, error: null })), maybeSingle: jest.fn(() => Promise.resolve({ data: null, error: null })) })),
    rpc: jest.fn(() => Promise.resolve({ data: null, error: null })),
    channel: jest.fn(() => ({ on: jest.fn().mockReturnThis(), subscribe: jest.fn(() => ({ unsubscribe: jest.fn() })) })),
    removeChannel: jest.fn(),
    functions: { invoke: jest.fn() },
  },
}));

function everyDay(vendorIds: string[]) {
  const entries = vendorIds.map((id) => ({ vendorId: id, vendorName: id, deliveryDay: 'Monday' }));
  return { Monday: entries, Tuesday: entries, Wednesday: entries, Thursday: entries, Friday: entries, Saturday: entries, Sunday: entries };
}

// (2) explicit entries for everything `loadFromSupabase` touches; anything
// else falls through to the spec-151 Proxy default.
jest.mock('../../../../../lib/db', () => {
  // Inlined: jest.mock factories may not close over module-scope helpers.
  const entries = [{ vendorId: 'v-a', vendorName: 'v-a', deliveryDay: 'Monday' }];
  const schedule = { Monday: entries, Tuesday: entries, Wednesday: entries, Thursday: entries, Friday: entries, Saturday: entries, Sunday: entries };
  const target: Record<string, unknown> = {
    __esModule: true,
    fetchStores: jest.fn(() => Promise.resolve([])),
    fetchAllForStore: jest.fn(() => Promise.resolve({
      brand: null,
      catalogIngredients: [],
      inventory: [{ id: 'a1', subUnitSize: 1 }, { id: 'a2', subUnitSize: 1 }],
      recipes: [],
      prepRecipes: [],
      vendors: [{ id: 'v-a', orderUnit: 'case' }],
      wasteLog: [],
      auditLog: [],
      eodSubmissions: [],
      orderSubmissions: [],
      posRecipeAliases: [],
      recipeCategories: [],
      ingredientCategories: [],
      ingredientConversions: [],
      orderSchedule: schedule,
      savedReports: [],
    })),
    fetchReorderSuggestions: jest.fn(),
    fetchMenuCapacity: jest.fn(() => Promise.resolve([])),
    fetchItemsLastCounted: jest.fn(() => Promise.resolve([])),
    cleanupOldRecords: jest.fn(() => Promise.resolve(undefined)),
  };
  return new Proxy(target, { get: (t: Record<string, unknown>, p: string) => (p in t ? t[p] : jest.fn(() => Promise.resolve(null))) });
});

jest.mock('../../../../../theme/breakpoints', () => {
  const actual = jest.requireActual('../../../../../theme/breakpoints');
  return { ...actual, useIsPhone: () => true, useIsTablet: () => false, useIsDesktop: () => false, useIsCompact: () => true, useBreakpoint: () => 'phone' };
});

import * as db from '../../../../../lib/db';
import { PhoneOrdering } from '../PhoneOrdering';
import { useStore } from '../../../../../store/useStore';
import { usePaletteAction } from '../../../../../lib/paletteAction';
import type { ReorderPayload } from '../../../../../types';

const INITIAL_STATE = useStore.getState();
const fetchReorder = db.fetchReorderSuggestions as unknown as jest.Mock;
const fetchAll = db.fetchAllForStore as unknown as jest.Mock;

function todayIso(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

const DATE = todayIso();

/** Flush microtasks so any fire-and-forget promise chain settles. (jsdom has
 *  no `setImmediate`, so a zero-delay timer is the macrotask boundary here.) */
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: any) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function item(over: Record<string, any> = {}): any {
  return {
    itemId: 'a1', itemName: 'Wings', unit: 'lb',
    onHand: 0, pendingPoQty: 0, parLevel: 100, usageForecasted: 0, parReplacement: 0,
    suggestedQty: 30, costPerUnit: 3, estimatedCost: 60, caseQty: 6,
    suggestedCases: 5, suggestedUnits: 30, flags: [], ...over,
  };
}

function vendorRow(items: any[]): any {
  return {
    vendorId: 'v-a', vendorName: 'US Foods', scheduleKnown: true,
    nextDeliveryDate: DATE, daysUntilNextDelivery: 1, onHandSource: 'eod',
    eodSubmittedAt: `${DATE}T18:00:00Z`, items, vendorTotalCost: 60,
  };
}

function payload(items: any[]): ReorderPayload {
  return {
    asOfDate: DATE,
    vendors: [vendorRow(items)],
    kpis: { vendorCount: 1, itemCount: items.length, totalEstimatedCost: 60, eodSourcedVendorCount: 1, stockFallbackVendorCount: 0 },
    warnings: [],
  } as unknown as ReorderPayload;
}

/** One vendor, one line — the pre-reload list. */
const P = payload([item()]);
/** The silent refresh's fresh result — two lines, so the KPI proves it landed. */
const F = payload([item(), item({ itemId: 'a2', itemName: 'Thighs' })]);

function seed(over: Record<string, unknown> = {}) {
  useStore.setState({
    currentUser: null,
    switching: null,
    currentStore: { id: 'store-1', brandId: 'b', name: 'Frederick', address: '', status: 'active' } as any,
    stores: [{ id: 'store-1', name: 'Frederick' } as any],
    orderSchedule: everyDay(['v-a']) as any,
    reorderPayload: P,
    reorderStoreId: 'store-1',
    reorderLoading: false,
    reorderError: null,
    reorderEdits: {},
    inventory: [{ id: 'a1', subUnitSize: 1 } as any],
    vendors: [{ id: 'v-a', orderUnit: 'case' } as any],
    lastOrderContext: null,
    ...over,
  } as any);
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  usePaletteAction.setState({ pending: null });
  useStore.setState(INITIAL_STATE, true);
  seed();
});

afterEach(() => {
  (console.warn as jest.Mock).mockRestore?.();
});

describe('spec 175 — PhoneOrdering keeps the list through a same-store reload', () => {
  it('pending → resolved — list stays while the silent refresh is pending, then shows the fresh payload', async () => {
    const d = deferred<ReorderPayload>();
    fetchReorder.mockReturnValueOnce(d.promise);
    const { getByTestId, queryByTestId } = render(<PhoneOrdering />);

    // Baseline — the list is on screen before the reload.
    expect(getByTestId('phone-order-card-v-a')).toBeTruthy();

    await act(async () => {
      await useStore.getState().loadFromSupabase('store-1');
    });

    // Anti-vacuity: the reload actually ran and issued the silent refresh.
    expect(fetchAll).toHaveBeenCalledWith('store-1');
    expect(fetchReorder).toHaveBeenCalledTimes(1);
    expect(fetchReorder).toHaveBeenCalledWith('store-1', DATE);

    // Pending.
    expect(getByTestId('phone-order-card-v-a')).toBeTruthy();
    expect(getByTestId('phone-order-line-a1')).toBeTruthy();
    expect(getByTestId('phone-order-kpi')).toHaveTextContent(/1 VENDORS · 1 LINES/);
    expect(queryByTestId('phone-order-empty')).toBeNull();
    expect(queryByTestId('phone-order-loading')).toBeNull();

    // Resolved with the fresh two-line payload.
    await act(async () => {
      d.resolve(F);
      await flush();
    });

    expect(useStore.getState().reorderPayload).toBe(F);
    expect(getByTestId('phone-order-card-v-a')).toBeTruthy();
    expect(getByTestId('phone-order-line-a1')).toBeTruthy();
    expect(getByTestId('phone-order-line-a2')).toBeTruthy();
    expect(getByTestId('phone-order-kpi')).toHaveTextContent(/1 VENDORS · 2 LINES/);
    expect(queryByTestId('phone-order-empty')).toBeNull();
    expect(queryByTestId('phone-order-loading')).toBeNull();
  });

  it('control (no owner tag) — the same reload is a store switch: the list clears', async () => {
    seed({ reorderStoreId: null });
    const { getByTestId, queryByTestId } = render(<PhoneOrdering />);
    expect(getByTestId('phone-order-card-v-a')).toBeTruthy();

    await act(async () => {
      await useStore.getState().loadFromSupabase('store-1');
      await flush();
    });

    expect(fetchAll).toHaveBeenCalledWith('store-1');
    expect(fetchReorder).not.toHaveBeenCalled();
    expect(useStore.getState().reorderPayload).toBeNull();
    expect(getByTestId('phone-order-empty')).toBeTruthy();
    expect(queryByTestId('phone-order-card-v-a')).toBeNull();
  });
});
