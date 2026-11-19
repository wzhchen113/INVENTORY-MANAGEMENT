// src/store/useStore.switchItemPrimaryVendor.spec201.test.ts — Spec 201
// (§8; AC-25 / AC-26 / AC-27).
//
// `switchItemPrimaryVendor` is the store half of the reorder "also from … —
// switch" control. The pinned order:
//   1. 3c pre-check `db.isItemOnOpenOrder` → true ⇒ 'refused', confirm NEVER
//      called, nothing written (AC-26); a throwing pre-check ⇒ 'failed' +
//      notifyBackendError, confirm never called (fail closed).
//   2. confirm() false ⇒ 'cancelled', no write (AC-25.4).
//   3. optimistic inventory patch, then `db.setItemPrimaryVendor`.
//   4. server 3c refusal ⇒ revert + 'refused', NO notifyBackendError; any other
//      error ⇒ revert + notifyBackendError + 'failed' (AC-27).
//   5. success ⇒ reload the reorder list for the as-of date (AC-25.3) +
//      'Item edit' audit event ⇒ 'switched'.
// notifyBackendError is observed through the globally-mocked Toast.show
// (tests/jest.setup.ts), like the other store tests. Mocking follows
// useStore.updateItem.catalogRevert.spec173.test.ts.

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
  isItemOnOpenOrder: jest.fn(),
  setItemPrimaryVendor: jest.fn(),
  fetchReorderSuggestions: jest.fn(),
  addAuditEvent: jest.fn().mockResolvedValue(undefined),
}));

import Toast from 'react-native-toast-message';
import * as db from '../lib/db';
import { useStore, PRIMARY_SWITCH_OPEN_ORDER_REFUSAL } from './useStore';
import type { InventoryItem, ReorderPayload } from '../types';

const INITIAL_STATE = useStore.getState();
const isItemOnOpenOrderMock = db.isItemOnOpenOrder as jest.Mock;
const setItemPrimaryVendorMock = db.setItemPrimaryVendor as jest.Mock;
const fetchReorderSuggestionsMock = db.fetchReorderSuggestions as jest.Mock;
const addAuditEventMock = db.addAuditEvent as jest.Mock;
const toastShowMock = (Toast as any).show as jest.Mock;

const ITEM_ID = 'item-f';
const STORE_ID = 's1';
const VENDOR_A = 'vendor-a';
const VENDOR_B = 'vendor-b';
const AS_OF = '2026-11-16';

const ITEM: InventoryItem = {
  id: ITEM_ID,
  catalogId: 'catalog-f',
  name: 'Fryer Oil',
  category: 'Dry',
  unit: 'each',
  costPerUnit: 1,
  currentStock: 2,
  parLevel: 10,
  averageDailyUsage: 0,
  safetyStock: 0,
  vendorId: VENDOR_A,
  vendorName: 'Alpha Foods',
  usagePerPortion: 0,
  lastUpdatedBy: '',
  lastUpdatedAt: '',
  eodRemaining: 0,
  storeId: STORE_ID,
  casePrice: 24,
  caseQty: 1,
  subUnitSize: 1,
  subUnitUnit: '',
  eodCountMode: 'cases_and_units',
  vendors: [
    { vendorId: VENDOR_A, vendorName: 'Alpha Foods', costPerUnit: 1, casePrice: 24, isPrimary: true, orderCode: '', productPageUrl: '' },
    { vendorId: VENDOR_B, vendorName: 'Bravo Supply', costPerUnit: 1, casePrice: 24, isPrimary: false, orderCode: '', productPageUrl: '' },
  ],
  vendorIds: [VENDOR_A, VENDOR_B],
};

const RELOADED: ReorderPayload = {
  asOfDate: AS_OF,
  vendors: [],
  kpis: { vendorCount: 0, itemCount: 0, totalEstimatedCost: 0, eodSourcedVendorCount: 0, stockFallbackVendorCount: 0 },
  warnings: [],
} as unknown as ReorderPayload;

const args = (confirm: () => Promise<boolean>) => ({
  itemId: ITEM_ID,
  fromVendorId: VENDOR_A,
  toVendorId: VENDOR_B,
  asOfDate: AS_OF,
  confirm,
});

const itemNow = () => useStore.getState().inventory.find((i) => i.id === ITEM_ID)!;

beforeEach(() => {
  jest.clearAllMocks();
  useStore.setState(INITIAL_STATE, true);
  useStore.setState({
    currentStore: { id: STORE_ID, brandId: 'b1', name: 'Store One', address: '1 Main', status: 'active' },
    inventory: [{ ...ITEM, vendors: ITEM.vendors!.map((l) => ({ ...l })) }],
    vendors: [
      { id: VENDOR_A, name: 'Alpha Foods' },
      { id: VENDOR_B, name: 'Bravo Supply' },
    ] as any,
  });
  isItemOnOpenOrderMock.mockResolvedValue(false);
  setItemPrimaryVendorMock.mockResolvedValue({ changed: true, previousVendorId: VENDOR_A, vendorId: VENDOR_B });
  fetchReorderSuggestionsMock.mockResolvedValue(RELOADED);
});

describe('useStore.switchItemPrimaryVendor — spec 201', () => {
  it('happy path (AC-25): pre-check → confirm → write → reload → audit → "switched"', async () => {
    const confirm = jest.fn(() => Promise.resolve(true));
    const result = await useStore.getState().switchItemPrimaryVendor(args(confirm));

    expect(result).toBe('switched');
    expect(isItemOnOpenOrderMock).toHaveBeenCalledWith({
      storeId: STORE_ID,
      itemId: ITEM_ID,
      vendorId: VENDOR_A,
      referenceDate: AS_OF,
    });
    expect(confirm).toHaveBeenCalledTimes(1);
    // One write through the atomic spec-124 demote-first RPC wrapper.
    expect(setItemPrimaryVendorMock).toHaveBeenCalledTimes(1);
    expect(setItemPrimaryVendorMock).toHaveBeenCalledWith(ITEM_ID, VENDOR_B, AS_OF);
    // Pre-check strictly before confirm, confirm strictly before the write.
    expect(isItemOnOpenOrderMock.mock.invocationCallOrder[0]).toBeLessThan(confirm.mock.invocationCallOrder[0]);
    expect(confirm.mock.invocationCallOrder[0]).toBeLessThan(setItemPrimaryVendorMock.mock.invocationCallOrder[0]);
    // AC-25.3 — reloaded the reorder list for the SAME as-of date, after the write.
    expect(fetchReorderSuggestionsMock).toHaveBeenCalledWith(STORE_ID, AS_OF);
    expect(setItemPrimaryVendorMock.mock.invocationCallOrder[0]).toBeLessThan(
      fetchReorderSuggestionsMock.mock.invocationCallOrder[0],
    );
    expect(useStore.getState().reorderPayload).toBe(RELOADED);
    // Local inventory converges: scalar + is_primary mirror (exactly one primary = B).
    expect(itemNow().vendorId).toBe(VENDOR_B);
    expect(itemNow().vendors!.filter((l) => l.isPrimary).map((l) => l.vendorId)).toEqual([VENDOR_B]);
    // Audit event.
    expect(addAuditEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'Item edit',
        detail: 'Primary vendor switched',
        itemRef: 'Fryer Oil',
        value: 'Alpha Foods → Bravo Supply',
        storeId: STORE_ID,
      }),
    );
    // No error toast.
    expect(toastShowMock).not.toHaveBeenCalled();
  });

  it('cancel (AC-25.4): confirm false → "cancelled", nothing written, no reload', async () => {
    const confirm = jest.fn(() => Promise.resolve(false));
    const result = await useStore.getState().switchItemPrimaryVendor(args(confirm));

    expect(result).toBe('cancelled');
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(setItemPrimaryVendorMock).not.toHaveBeenCalled();
    expect(fetchReorderSuggestionsMock).not.toHaveBeenCalled();
    expect(addAuditEventMock).not.toHaveBeenCalled();
    expect(itemNow().vendorId).toBe(VENDOR_A);
    expect(toastShowMock).not.toHaveBeenCalled();
  });

  it('refused by the pre-check (AC-26): item on an open order → "refused", confirm NEVER called, no write', async () => {
    isItemOnOpenOrderMock.mockResolvedValueOnce(true);
    const confirm = jest.fn(() => Promise.resolve(true));
    const result = await useStore.getState().switchItemPrimaryVendor(args(confirm));

    expect(result).toBe('refused');
    expect(confirm).not.toHaveBeenCalled();
    expect(setItemPrimaryVendorMock).not.toHaveBeenCalled();
    expect(fetchReorderSuggestionsMock).not.toHaveBeenCalled();
    expect(itemNow().vendorId).toBe(VENDOR_A);
    // The refusal toast is the component's job — the store raises no error toast.
    expect(toastShowMock).not.toHaveBeenCalled();
  });

  it('pre-check throws → "failed" + notifyBackendError, confirm NEVER called (fail closed)', async () => {
    isItemOnOpenOrderMock.mockRejectedValueOnce(new Error('network down'));
    const confirm = jest.fn(() => Promise.resolve(true));
    const result = await useStore.getState().switchItemPrimaryVendor(args(confirm));

    expect(result).toBe('failed');
    expect(confirm).not.toHaveBeenCalled();
    expect(setItemPrimaryVendorMock).not.toHaveBeenCalled();
    expect(toastShowMock).toHaveBeenCalledTimes(1);
    expect(toastShowMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error', text1: 'Switch primary vendor failed', text2: 'network down' }),
    );
  });

  it('server 3c backstop: the fixed RPC refusal → revert + "refused", NO notifyBackendError', async () => {
    let seenDuringWrite: InventoryItem | undefined;
    setItemPrimaryVendorMock.mockImplementationOnce(() => {
      seenDuringWrite = { ...itemNow() };
      return Promise.reject({
        code: 'P0001',
        message: `set_item_primary_vendor: ${PRIMARY_SWITCH_OPEN_ORDER_REFUSAL}`,
      });
    });
    const confirm = jest.fn(() => Promise.resolve(true));
    const result = await useStore.getState().switchItemPrimaryVendor(args(confirm));

    expect(result).toBe('refused');
    // Optimistic state was applied before the write …
    expect(seenDuringWrite?.vendorId).toBe(VENDOR_B);
    // … and reverted after the refusal.
    expect(itemNow()).toEqual(ITEM);
    expect(toastShowMock).not.toHaveBeenCalled();
    expect(fetchReorderSuggestionsMock).not.toHaveBeenCalled();
    expect(addAuditEventMock).not.toHaveBeenCalled();
  });

  it('write failure (AC-27): any other error → revert + notifyBackendError + "failed"', async () => {
    setItemPrimaryVendorMock.mockRejectedValueOnce({
      code: '42501',
      message: 'set_item_primary_vendor: privileged only',
    });
    const confirm = jest.fn(() => Promise.resolve(true));
    const result = await useStore.getState().switchItemPrimaryVendor(args(confirm));

    expect(result).toBe('failed');
    expect(itemNow()).toEqual(ITEM);
    expect(toastShowMock).toHaveBeenCalledTimes(1);
    expect(toastShowMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'error',
        text1: 'Switch primary vendor failed',
        text2: 'set_item_primary_vendor: privileged only',
      }),
    );
    expect(fetchReorderSuggestionsMock).not.toHaveBeenCalled();
    expect(addAuditEventMock).not.toHaveBeenCalled();
  });

  it('no active store (__all__) → "failed" with no pre-check, confirm or write', async () => {
    useStore.setState({
      currentStore: { id: '__all__', brandId: 'b1', name: 'All stores', address: '', status: 'active' },
    });
    const confirm = jest.fn(() => Promise.resolve(true));
    const result = await useStore.getState().switchItemPrimaryVendor(args(confirm));

    expect(result).toBe('failed');
    expect(isItemOnOpenOrderMock).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
    expect(setItemPrimaryVendorMock).not.toHaveBeenCalled();
  });
});
