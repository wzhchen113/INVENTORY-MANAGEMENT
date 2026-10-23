// src/store/useStore.updateItem.catalogRevert.spec173.test.ts — Spec 173
// (AC-10; design D6).
//
// When db.updateInventoryItem rejects (any of the spec-173 catalog failure
// modes: lookup error, missing catalog_id, UPDATE error, 0-row UPDATE),
// useStore.updateItem must:
//   (a) apply the optimistic value first,
//   (b) revert the item to its pre-edit snapshot once the rejection settles,
//   (c) toast exactly once via notifyBackendError('Update item', e).
// notifyBackendError is module-local, so it is observed through the
// globally-mocked Toast.show (tests/jest.setup.ts), like the other store tests.
//
// Mocking follows useStore.updateStore.test.ts: stub ../lib/supabase
// (module-eval crash guard), ../lib/auth (dynamic-import boundary), and
// ../lib/db (namespace import). State isolation via snapshot-and-replace.

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
  cleanupOldRecords: jest.fn().mockResolvedValue(undefined),
  updateInventoryItem: jest.fn(),
  // updateItem fires an audit event unconditionally.
  addAuditEvent: jest.fn().mockResolvedValue(undefined),
}));

import Toast from 'react-native-toast-message';
import * as db from '../lib/db';
import { useStore } from './useStore';
import type { InventoryItem } from '../types';

const INITIAL_STATE = useStore.getState();
const updateInventoryItemMock = db.updateInventoryItem as jest.Mock;
const toastShowMock = (Toast as any).show as jest.Mock;

/** Flush microtasks so the db.updateInventoryItem promise chain settles. */
const flush = () => new Promise<void>((r) => setImmediate(r));

const ITEM_ID = 'item-000000001';

const ITEM: InventoryItem = {
  id: ITEM_ID,
  catalogId: 'catalog-000001',
  name: 'Lettuce Iceberg',
  category: 'Produce',
  unit: 'each',
  costPerUnit: 1,
  currentStock: 10,
  parLevel: 20,
  averageDailyUsage: 0,
  safetyStock: 0,
  vendorId: '',
  vendorName: '',
  usagePerPortion: 0,
  lastUpdatedBy: '',
  lastUpdatedAt: '',
  eodRemaining: 0,
  storeId: 's1',
  casePrice: 24,
  caseQty: 24,
  subUnitSize: 1,
  subUnitUnit: '',
  eodCountMode: 'cases_and_units',
};

/** A controllable deferred so (a) can be asserted before the rejection lands. */
function deferred() {
  let reject!: (e: unknown) => void;
  const promise = new Promise<void>((_res, rej) => {
    reject = rej;
  });
  return { promise, reject };
}

beforeEach(() => {
  jest.clearAllMocks();
  useStore.setState(INITIAL_STATE, true);
  useStore.setState({
    currentStore: { id: 's1', brandId: 'b1', name: 'Store One', address: '1 Main', status: 'active' },
    inventory: [{ ...ITEM }],
  });
});

describe('useStore.updateItem — spec 173 catalog-failure revert (AC-10)', () => {
  it.each([
    [
      'PostgREST-shaped rejection',
      { code: '23514', message: 'violates check constraint', details: null, hint: null },
    ],
    [
      'Error rejection',
      new Error('Catalog change not saved: no permission to edit this catalog ingredient, or it no longer exists.'),
    ],
  ])('reverts to the pre-edit snapshot and toasts once (%s)', async (_label, rejection) => {
    const snapshot = useStore.getState().inventory.find((i) => i.id === ITEM_ID);
    expect(snapshot).toBeDefined();
    const pre = { ...snapshot! };

    const d = deferred();
    updateInventoryItemMock.mockReturnValueOnce(d.promise);

    useStore.getState().updateItem(ITEM_ID, { name: 'New' });

    // (a) optimistic value applied synchronously.
    expect(useStore.getState().inventory.find((i) => i.id === ITEM_ID)?.name).toBe('New');
    expect(updateInventoryItemMock).toHaveBeenCalledWith(ITEM_ID, { name: 'New' });
    expect(toastShowMock).not.toHaveBeenCalled();

    d.reject(rejection);
    await flush();

    // (b) reverted to the pre-edit snapshot.
    expect(useStore.getState().inventory.find((i) => i.id === ITEM_ID)).toEqual(pre);

    // (c) notifyBackendError('Update item', e) toasted exactly once.
    expect(toastShowMock).toHaveBeenCalledTimes(1);
    expect(toastShowMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'error',
        text1: 'Update item failed',
        text2: rejection.message,
      }),
    );
  });
});
