// src/screens/cmd/sections/__tests__/InventoryCountSection.clientUuid.spec181.test.tsx
//
// Spec 181 (B1 / AC-10). The admin weekly-count submit used to fall back to a
// non-UUID `cu-<ts>-…` idempotency key when `crypto.randomUUID` was missing —
// which is ALWAYS the case on Hermes — and `submit_inventory_count`'s
// `uuid`-typed `p_client_uuid` rejected it. With `globalThis.crypto` deleted,
// the key the section hands to `submitInventoryCount` must be a real v4 UUID.
//
// Scaffold reused from InventoryCountSection.draft.test.tsx: supabase / db.ts /
// device-local trio / connection signal / confirm / desktop-tier mocks. A server
// draft seeds one non-blank count so the Submit button is enabled.
//
// `.test.tsx` so the jsdom `component` project picks it up.

import { fireEvent, render, waitFor } from '@testing-library/react-native';

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
      single: jest.fn(() => Promise.resolve({ data: null, error: null })),
    })),
    rpc: jest.fn(() => Promise.resolve({ data: null, error: null })),
    channel: jest.fn(() => ({ on: jest.fn().mockReturnThis(), subscribe: jest.fn(() => ({ unsubscribe: jest.fn() })) })),
    removeChannel: jest.fn(),
    functions: { invoke: jest.fn() },
  },
}));

const mockFetchDraft = jest.fn();
jest.mock('../../../../lib/db', () => ({
  __esModule: true,
  fetchCountDraft: (...a: unknown[]) => mockFetchDraft(...a),
  saveCountDraft: jest.fn(() => Promise.resolve()),
  deleteCountDraft: jest.fn(() => Promise.resolve()),
  fetchRecentInventoryCounts: jest.fn(() => Promise.resolve([])),
  fetchInventoryCount: jest.fn(() => Promise.resolve(null)),
  fetchCountOrder: jest.fn(() => Promise.resolve(null)),
  saveCountOrder: jest.fn(() => Promise.resolve()),
  resetCountOrder: jest.fn(() => Promise.resolve()),
  fetchReorderForCountedOnHand: jest.fn(() => Promise.resolve({})),
  fetchStoreCountLayouts: jest.fn(() => Promise.resolve([])),
  saveStoreCountLayout: jest.fn(() => Promise.resolve('layout-1')),
  renameStoreCountLayout: jest.fn(() => Promise.resolve('layout-1')),
  deleteStoreCountLayout: jest.fn(() => Promise.resolve('layout-1')),
}));

jest.mock('../../../../lib/countDraftLocal', () => ({
  __esModule: true,
  readLocalCountDraft: jest.fn(() => null),
  loadLocalCountDraft: jest.fn(() => Promise.resolve(null)),
  writeLocalCountDraft: jest.fn(),
  clearLocalCountDraft: jest.fn(),
}));

jest.mock('../../../../hooks/useConnectionStatus', () => ({
  useConnectionStatus: () => true,
}));

jest.mock('../../../../utils/confirmAction', () => ({
  confirmAction: (_t: string, _m: string, onConfirm: () => void) => onConfirm(),
}));

jest.mock('../../../../theme/breakpoints', () => {
  const actual = jest.requireActual('../../../../theme/breakpoints');
  return { ...actual, useIsPhone: () => false, useIsTablet: () => false, useIsDesktop: () => true, useIsCompact: () => false, useBreakpoint: () => 'desktop' };
});

import InventoryCountSection from '../InventoryCountSection';
import { useStore } from '../../../../store/useStore';
import { serializeAdminInventoryDraft } from '../../../../lib/countDrafts';

const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const realCrypto = Object.getOwnPropertyDescriptor(globalThis, 'crypto');

type SubmitInput = { clientUuid: string; entries: unknown[] };
const mockSubmit = jest.fn((_input: SubmitInput) =>
  Promise.resolve({ countId: 'count-1', conflict: false, entryIds: ['e-1'] }),
);

beforeEach(() => {
  jest.clearAllMocks();
  mockFetchDraft.mockResolvedValue({
    payload: serializeAdminInventoryDraft({
      kind: 'open',
      countedAtLocal: '',
      notes: '',
      caseCounts: { 'item-1': '2' },
      unitCounts: {},
      itemNotes: {},
    }),
    savedAt: new Date(Date.now() - 60_000).toISOString(),
  });
  useStore.setState({
    currentStore: { id: 'store-1', brandId: 'brand-1', name: 'Frederick', address: '', status: 'active' } as any,
    currentUser: { id: 'user-1', name: 'Admin', email: 'a@b.c', role: 'admin' } as any,
    inventory: [
      {
        id: 'item-1',
        storeId: 'store-1',
        name: 'Flour',
        category: 'Dry Goods',
        unit: 'lb',
        caseQty: 12,
        parLevel: 0,
        currentStock: 0,
      } as any,
    ],
    submitInventoryCount: mockSubmit as any,
  });
  // Simulate Hermes: no crypto global at all.
  Object.defineProperty(globalThis, 'crypto', { value: undefined, configurable: true, writable: true });
});

afterEach(() => {
  if (realCrypto) {
    Object.defineProperty(globalThis, 'crypto', realCrypto);
  } else {
    delete (globalThis as { crypto?: unknown }).crypto;
  }
});

describe('InventoryCountSection submit clientUuid (spec 181 B1)', () => {
  it('with globalThis.crypto undefined, mints a v4 UUID (never a cu- fallback)', async () => {
    const { getByDisplayValue, getByText } = render(<InventoryCountSection />);
    // Wait for the server draft to restore the one count (enables Submit).
    await waitFor(() => expect(getByDisplayValue('2')).toBeTruthy());

    fireEvent.press(getByText('SUBMIT COUNT'));

    await waitFor(() => expect(mockSubmit).toHaveBeenCalledTimes(1));
    const input = mockSubmit.mock.calls[0][0];
    expect(input.clientUuid).toMatch(V4);
    expect(input.clientUuid.startsWith('cu-')).toBe(false);
    expect(input.entries).toHaveLength(1);
  });
});
