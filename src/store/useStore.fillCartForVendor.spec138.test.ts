// src/store/useStore.fillCartForVendor.spec138.test.ts — Spec 138 (cart-filler).
//
// Pins useStore.fillCartForVendor — the store action the "Fill cart" button
// calls to hand a vendor's edited order to the browser extension:
//   • Builds lines from the vendor's items applying the per-session EDIT overlay
//     (reorderEdits ?? suggestion) and the per-COUNTED-unit cost snapshot
//     (costPerUnit per-each × subUnitSize).
//   • Keys the draft to the currently-displayed reorder date (referenceDate =
//     reorderPayload.asOfDate).
//   • On SUCCESS: refreshes purchase orders + reorder suggestions and CLEARS the
//     vendor's edit buffer (AC-7 reset-after-cart-fill).
//   • On FAILURE (db returns null OR throws): the buffer is PRESERVED so the
//     operator can retry (optimistic-then-revert: the buffer is the optimistic
//     state).
//
// Mocking mirrors useStore.createPoDraft.spec125.test.ts: stub ../lib/supabase,
// ../lib/auth, ../lib/db; db.upsertVendorDraftOrder is the assertion surface;
// refreshPurchaseOrders/loadReorderSuggestions internals stubbed. State
// isolation via snapshot-and-replace in beforeEach. clearReorderEditsForVendor
// is the REAL store action, so we inspect actual `reorderEdits` state.

jest.mock('react-native-toast-message', () => ({
  __esModule: true,
  default: { show: jest.fn(), hide: jest.fn() },
}));

jest.mock('../lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: jest.fn(),
      signOut: jest.fn(),
      onAuthStateChange: jest.fn(() => ({
        data: { subscription: { unsubscribe: jest.fn() } },
      })),
    },
    from: jest.fn(),
    channel: jest.fn(),
    removeChannel: jest.fn(),
  },
}));

jest.mock('../lib/auth', () => ({
  deleteUser: jest.fn(),
  signOut: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../lib/db', () => ({
  fetchStores: jest.fn().mockResolvedValue([]),
  fetchAllForStore: jest.fn().mockResolvedValue({
    brand: null, catalogIngredients: [], inventory: [], recipes: [], prepRecipes: [],
    vendors: [], wasteLog: [], auditLog: [], eodSubmissions: [], posRecipeAliases: [],
    recipeCategories: [], ingredientCategories: [], ingredientConversions: [],
  }),
  cleanupOldRecords: jest.fn().mockResolvedValue(undefined),
  fetchBrandsLite: jest.fn().mockResolvedValue([]),
  fetchBrandsWithStats: jest.fn().mockResolvedValue([]),
  // Spec 138 — the assertion surface.
  upsertVendorDraftOrder: jest.fn().mockResolvedValue('po-1'),
  // Fired by the post-fill refresh chain; stubbed to inert shapes.
  fetchRecentPurchaseOrders: jest.fn().mockResolvedValue([]),
  fetchReorderSuggestions: jest.fn().mockResolvedValue(null),
}));

import * as db from '../lib/db';
import { useStore } from './useStore';
import type { ReorderVendor } from '../types';

const INITIAL_STATE = useStore.getState();
const upsertMock = db.upsertVendorDraftOrder as jest.Mock;

const flush = () => new Promise<void>((r) => setImmediate(r));

function makeVendor(over?: Partial<ReorderVendor>): ReorderVendor {
  return {
    vendorId: 'v1',
    vendorName: 'BJ’s',
    daysUntil: 0,
    scheduleKnown: true,
    nextDeliveryDate: '2026-07-23',
    items: [
      { itemId: 'item-1', itemName: 'Buns', suggestedUnits: 3, suggestedQty: 3, costPerUnit: 2 } as any,
    ],
    ...over,
  } as ReorderVendor;
}

beforeEach(() => {
  jest.clearAllMocks();
  useStore.setState(INITIAL_STATE, true);
  upsertMock.mockResolvedValue('po-1');
  useStore.setState({
    currentStore: { id: 'store-1', name: 'Frederick' } as any,
    currentUser: { id: 'user-1' } as any,
    inventory: [{ id: 'item-1', catalogId: 'cat-1', subUnitSize: 4, storeId: 'store-1' } as any],
    reorderPayload: { asOfDate: '2026-07-22', vendors: [], kpis: {} as any, warnings: [] } as any,
    reorderEdits: { v1: { 'item-1': 5 } },
  });
});

describe('fillCartForVendor — line building + key', () => {
  it('passes the EDITED qty (buffer overlay) and per-counted-unit cost to upsert', async () => {
    await useStore.getState().fillCartForVendor(makeVendor());
    await flush();

    expect(upsertMock).toHaveBeenCalledTimes(1);
    const [params] = upsertMock.mock.calls[0];
    expect(params.storeId).toBe('store-1');
    expect(params.vendorId).toBe('v1');
    expect(params.createdByUserId).toBe('user-1');
    expect(params.referenceDate).toBe('2026-07-22'); // = reorderPayload.asOfDate
    // Edited 5 (NOT the server suggestion 3); cost = costPerUnit(2) × subUnitSize(4).
    expect(params.lines).toEqual([
      { itemId: 'item-1', orderedQty: 5, costPerUnitCounted: 8 },
    ]);
  });

  it('falls back to the server suggestion when the item has no edit', async () => {
    useStore.setState({ reorderEdits: {} }); // no edits for v1
    await useStore.getState().fillCartForVendor(makeVendor());
    await flush();
    const [params] = upsertMock.mock.calls[0];
    expect(params.lines[0].orderedQty).toBe(3); // suggestedUnits
  });
});

describe('fillCartForVendor — success', () => {
  it('clears the vendor buffer and refreshes POs + suggestions on success', async () => {
    const poId = await useStore.getState().fillCartForVendor(makeVendor());
    await flush();

    expect(poId).toBe('po-1');
    // AC-7: the vendor's edit buffer is cleared after a successful fill.
    expect(useStore.getState().reorderEdits.v1).toBeUndefined();
    // History + extension RPCs see the draft; suggestions reload.
    expect(db.fetchRecentPurchaseOrders).toHaveBeenCalledWith('store-1');
    expect(db.fetchReorderSuggestions).toHaveBeenCalled();
  });
});

describe('fillCartForVendor — failure preserves the buffer', () => {
  it('does NOT clear the buffer when upsert returns null', async () => {
    upsertMock.mockResolvedValueOnce(null);
    const poId = await useStore.getState().fillCartForVendor(makeVendor());
    await flush();

    expect(poId).toBeNull();
    // Buffer preserved so the operator can retry.
    expect(useStore.getState().reorderEdits.v1).toEqual({ 'item-1': 5 });
  });

  it('does NOT clear the buffer when upsert throws', async () => {
    upsertMock.mockRejectedValueOnce(new Error('rls denied'));
    const poId = await useStore.getState().fillCartForVendor(makeVendor());
    await flush();

    expect(poId).toBeNull();
    expect(useStore.getState().reorderEdits.v1).toEqual({ 'item-1': 5 });
  });

  it('returns null (no upsert) when there is no active store', async () => {
    useStore.setState({ currentStore: null as any });
    const poId = await useStore.getState().fillCartForVendor(makeVendor());
    await flush();
    expect(poId).toBeNull();
    expect(upsertMock).not.toHaveBeenCalled();
    // Buffer untouched.
    expect(useStore.getState().reorderEdits.v1).toEqual({ 'item-1': 5 });
  });
});
