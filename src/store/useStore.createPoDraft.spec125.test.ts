// src/store/useStore.createPoDraft.spec125.test.ts — Spec 125
// (auto-receive-purchase-orders), Decision A thread-through.
//
// Pins the spec-125 FE change to useStore.createPoDraft: the vendor's
// scheduled next-delivery date is threaded into db.createPurchaseOrderDraft as
// `expectedDelivery` so it persists onto the PO header `expected_delivery` and
// the daily auto-receive DB job can flip the PO to received on/after that date.
//
// Decision A (architect): persist a REAL scheduled date ONLY. A
// schedule-unknown vendor (`scheduleKnown === false`) carries the reorder
// engine's synthetic `as_of + 7` fallback in `nextDeliveryDate`; persisting it
// would auto-receive on a guessed date (violates AC "no synthetic date"). So:
//   scheduleKnown === true  → expectedDelivery = vendor.nextDeliveryDate
//   scheduleKnown === false → expectedDelivery is undefined (key omitted)
//
// Mocking follows useStore.updateStore.test.ts: stub ../lib/supabase
// (module-eval crash guard), ../lib/auth (dynamic-import boundary), and
// ../lib/db (namespace import). db.createPurchaseOrderDraft is the assertion
// surface; fetchRecentPurchaseOrders + fetchReorderSuggestions are stubbed
// because createPoDraft fires refreshPurchaseOrders() + loadReorderSuggestions()
// on success. State isolation via snapshot-and-replace in beforeEach.

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
    brand: null,
    catalogIngredients: [],
    inventory: [],
    recipes: [],
    prepRecipes: [],
    vendors: [],
    wasteLog: [],
    auditLog: [],
    eodSubmissions: [],
    posRecipeAliases: [],
    recipeCategories: [],
    ingredientCategories: [],
    ingredientConversions: [],
  }),
  cleanupOldRecords: jest.fn().mockResolvedValue(undefined),
  fetchBrandsLite: jest.fn().mockResolvedValue([]),
  fetchBrandsWithStats: jest.fn().mockResolvedValue([]),
  updateCatalogIngredientI18n: jest.fn().mockResolvedValue(undefined),
  updateRecipeI18n: jest.fn().mockResolvedValue(undefined),
  updatePrepRecipeI18n: jest.fn().mockResolvedValue(undefined),
  updateRecipeCategoryI18n: jest.fn().mockResolvedValue(undefined),
  updateIngredientCategoryI18n: jest.fn().mockResolvedValue(undefined),
  // Spec 125 — the write path createPoDraft threads expectedDelivery into.
  createPurchaseOrderDraft: jest.fn().mockResolvedValue('po-new'),
  // Fired by the post-create refresh chain; stubbed to no-op shapes.
  fetchRecentPurchaseOrders: jest.fn().mockResolvedValue([]),
  fetchReorderSuggestions: jest.fn().mockResolvedValue(null),
}));

import * as db from '../lib/db';
import { useStore } from './useStore';
import type { ReorderVendor } from '../types';

const INITIAL_STATE = useStore.getState();
const createDraftMock = db.createPurchaseOrderDraft as jest.Mock;

/** Flush microtasks so the createPoDraft promise chain settles. */
const flush = () => new Promise<void>((r) => setImmediate(r));

/**
 * Minimal ReorderVendor with a single orderable line. Only the fields
 * createPoDraft reads carry meaning; the rest are inert defaults to satisfy
 * the strict type.
 */
function makeVendor(over: Partial<ReorderVendor>): ReorderVendor {
  return {
    vendorId: 'v1',
    vendorName: 'US FOOD',
    daysUntil: 0,
    scheduleKnown: true,
    nextDeliveryDate: '2026-07-20',
    items: [
      {
        itemId: 'item-1',
        itemName: 'Blue Cheese',
        suggestedUnits: 3,
        suggestedQty: 3,
        costPerUnit: 2,
      } as any,
    ],
    ...over,
  } as ReorderVendor;
}

describe('useStore.createPoDraft — spec 125 expectedDelivery thread-through', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    useStore.setState(INITIAL_STATE, true);
    createDraftMock.mockResolvedValue('po-new');
    useStore.setState({
      currentStore: { id: 'store-1', name: 'Frederick' } as any,
      inventory: [
        { id: 'item-1', catalogId: 'cat-1', subUnitSize: 1, storeId: 'store-1' } as any,
      ],
    });
  });

  it('passes expectedDelivery = vendor.nextDeliveryDate when scheduleKnown is true', async () => {
    await useStore
      .getState()
      .createPoDraft(makeVendor({ scheduleKnown: true, nextDeliveryDate: '2026-07-20' }));

    expect(createDraftMock).toHaveBeenCalledTimes(1);
    const [params] = createDraftMock.mock.calls[0];
    expect(params.expectedDelivery).toBe('2026-07-20');

    await flush();
  });

  it('omits expectedDelivery (undefined) when scheduleKnown is false — NOT the guessed date', async () => {
    // The reorder engine ALWAYS emits a nextDeliveryDate (synthetic as_of+7
    // fallback) even for schedule-unknown vendors. Decision A: that guessed
    // date must NOT be persisted, else the PO auto-receives on a wrong date.
    await useStore
      .getState()
      .createPoDraft(makeVendor({ scheduleKnown: false, nextDeliveryDate: '2026-07-25' }));

    expect(createDraftMock).toHaveBeenCalledTimes(1);
    const [params] = createDraftMock.mock.calls[0];
    // Key omitted → undefined, and definitely NOT the guessed 2026-07-25.
    expect(params.expectedDelivery).toBeUndefined();
    expect(params.expectedDelivery).not.toBe('2026-07-25');

    await flush();
  });

  it('omits expectedDelivery when scheduleKnown is true but nextDeliveryDate is empty', async () => {
    await useStore
      .getState()
      .createPoDraft(makeVendor({ scheduleKnown: true, nextDeliveryDate: '' }));

    expect(createDraftMock).toHaveBeenCalledTimes(1);
    const [params] = createDraftMock.mock.calls[0];
    expect(params.expectedDelivery).toBeUndefined();

    await flush();
  });
});
