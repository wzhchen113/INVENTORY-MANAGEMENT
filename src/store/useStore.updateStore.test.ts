// src/store/useStore.updateStore.test.ts — Spec 083 (store-deactivation-toggle).
//
// Pins the spec-083 changes to useStore.updateStore:
//   (1) `status` is now included in the partial update delegated to
//       db.updateStore (the documented persistence gap).
//   (2) The write is delegated to db.updateStore — the inline
//       supabase.from('stores') carve-out is closed.
//   (3) Optimistic-then-revert: local `stores`/`currentStore` update first,
//       then on a db error the slice reverts AND notifyBackendError toasts.
//
// Mocking follows useStore.test.ts: stub ../lib/supabase (module-eval crash
// guard), ../lib/auth (dynamic-import boundary), and ../lib/db (namespace
// import). State isolation via snapshot-and-replace in beforeEach.

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
  // Spec 083 — the new store-write path updateStore delegates to.
  updateStore: jest.fn().mockResolvedValue(undefined),
}));

import Toast from 'react-native-toast-message';
import * as db from '../lib/db';
import { useStore } from './useStore';

const INITIAL_STATE = useStore.getState();
const updateStoreMock = db.updateStore as jest.Mock;
const toastShowMock = (Toast as any).show as jest.Mock;

/** Flush microtasks so the db.updateStore promise chain settles. */
const flush = () => new Promise<void>((r) => setImmediate(r));

describe('useStore.updateStore — spec 083 status persistence', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    useStore.setState(INITIAL_STATE, true);
    useStore.setState({
      stores: [
        { id: 's1', brandId: 'b1', name: 'Store One', address: '1 Main', status: 'active' },
      ],
      currentStore: { id: 's1', brandId: 'b1', name: 'Store One', address: '1 Main', status: 'active' },
    });
  });

  it('optimistically flips status locally and delegates to db.updateStore with status', async () => {
    useStore.getState().updateStore('s1', { status: 'inactive' });

    // Optimistic local update — both the list row and currentStore.
    expect(useStore.getState().stores[0].status).toBe('inactive');
    expect(useStore.getState().currentStore.status).toBe('inactive');

    // Delegated to db.updateStore (carve-out closed) WITH status included.
    expect(updateStoreMock).toHaveBeenCalledTimes(1);
    const [id, updates] = updateStoreMock.mock.calls[0];
    expect(id).toBe('s1');
    expect(updates.status).toBe('inactive');

    await flush();
  });

  it('passes through name/address/eodDeadlineTime alongside status', async () => {
    useStore.getState().updateStore('s1', { name: 'Renamed', eodDeadlineTime: '22:00' });

    const [, updates] = updateStoreMock.mock.calls[0];
    expect(updates.name).toBe('Renamed');
    expect(updates.eodDeadlineTime).toBe('22:00');

    await flush();
  });

  it('reverts the optimistic update and toasts via notifyBackendError on db error', async () => {
    updateStoreMock.mockRejectedValueOnce(new Error('rls denied'));

    useStore.getState().updateStore('s1', { status: 'inactive' });
    // Optimistic value is applied first.
    expect(useStore.getState().stores[0].status).toBe('inactive');

    await flush();

    // Reverted both slices.
    expect(useStore.getState().stores[0].status).toBe('active');
    expect(useStore.getState().currentStore.status).toBe('active');

    // notifyBackendError fired an error toast.
    expect(toastShowMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error' }),
    );
  });
});
