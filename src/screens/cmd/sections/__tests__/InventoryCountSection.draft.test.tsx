// src/screens/cmd/sections/__tests__/InventoryCountSection.draft.test.tsx
//
// Spec 106 — admin Inventory count save-draft + resume, the restore-on-open flow
// (§14 / AC-5..AC-8, AC-11, AC-13..AC-16). A full render of the section with the
// draft I/O mocked at the db.ts boundary (the same boundary the parStatus sibling
// stubs) and the device-local trio + connection signal mocked so the test drives
// online/offline + local-copy behavior deterministically.
//
// The store (`useStore`) is seeded directly (inventory / currentStore /
// currentUser) — the section reads these via selectors, and a full render exercises
// the EXACT draft-load effect + banner + Discard + delete-on-submit wiring rather
// than re-deriving them out of band.
//
// `.test.tsx` so the jsdom `component` project picks it up.

import { fireEvent, render, waitFor } from '@testing-library/react-native';
import Toast from 'react-native-toast-message';

// supabase — stubbed so the section's module graph loads (EXPO_PUBLIC_SUPABASE_*
// unset) and the section's own realtime channel subscription is inert.
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

// db.ts — the draft fetch/save/delete boundary (+ the other reads the section
// fires on mount, stubbed inert). Each test drives its own mockFetchDraft value.
// Declared as bare jest.fn() (permissive jest.Mock<any, any> signature) so the
// `(...a: unknown[]) => mockFn(...a)` re-forwarding below type-checks under
// tsconfig.test.json — a `jest.fn(() => Promise.resolve(...))` inline impl infers
// a ZERO-arg call signature that rejects the spread (TS2556). The resolved value
// is set in beforeEach via .mockResolvedValue(...).
const mockFetchDraft = jest.fn();
const mockSaveDraft = jest.fn();
const mockDeleteDraft = jest.fn();
jest.mock('../../../../lib/db', () => ({
  __esModule: true,
  fetchCountDraft: (...a: unknown[]) => mockFetchDraft(...a),
  saveCountDraft: (...a: unknown[]) => mockSaveDraft(...a),
  deleteCountDraft: (...a: unknown[]) => mockDeleteDraft(...a),
  // Inert stubs for the rest of the section's db.ts surface.
  fetchRecentInventoryCounts: jest.fn(() => Promise.resolve([])),
  fetchInventoryCount: jest.fn(() => Promise.resolve(null)),
  fetchCountOrder: jest.fn(() => Promise.resolve(null)),
  saveCountOrder: jest.fn(() => Promise.resolve()),
  resetCountOrder: jest.fn(() => Promise.resolve()),
  fetchReorderForCountedOnHand: jest.fn(() => Promise.resolve({})),
}));

// Admin device-local trio — an in-memory single-slot record keyed by the storage
// key builder, so the test can seed a local draft + assert writes/clears without
// touching real localStorage.
let mockLocalStore: Record<string, { payload: Record<string, unknown>; savedAt: string; unsynced: boolean }> = {};
const localKey = (userId: string, screen: string, storeId: string) => `${screen}.${storeId}.${userId}`;
jest.mock('../../../../lib/countDraftLocal', () => ({
  __esModule: true,
  readLocalCountDraft: (userId: string, screen: string, storeId: string) =>
    mockLocalStore[localKey(userId, screen, storeId)] ?? null,
  writeLocalCountDraft: (
    userId: string,
    screen: string,
    storeId: string,
    rec: { payload: Record<string, unknown>; savedAt: string; unsynced: boolean },
  ) => {
    mockLocalStore[localKey(userId, screen, storeId)] = rec;
  },
  clearLocalCountDraft: (userId: string, screen: string, storeId: string) => {
    delete mockLocalStore[localKey(userId, screen, storeId)];
  },
}));

// Connection signal — controllable online/offline.
let mockOnline = true;
const setMockOnline = (v: boolean) => {
  mockOnline = v;
};
jest.mock('../../../../hooks/useConnectionStatus', () => ({
  useConnectionStatus: () => mockOnline,
}));

// confirmAction — auto-confirm so the Discard post-confirm behavior is
// deterministic (Platform.OS is 'ios' in the jsdom env → the util would route to
// Alert.alert otherwise). `mockConfirm` lets a test assert the confirm fired.
const mockConfirm = jest.fn(
  (_title: string, _message: string, onConfirm: () => void) => onConfirm(),
);
jest.mock('../../../../utils/confirmAction', () => ({
  confirmAction: (...args: unknown[]) =>
    (mockConfirm as unknown as (...a: unknown[]) => void)(...args),
}));

import InventoryCountSection from '../InventoryCountSection';
import { useStore } from '../../../../store/useStore';
import { serializeAdminInventoryDraft } from '../../../../lib/countDrafts';

// Seed the store with an active store + user + one inventory item (dual-input,
// caseQty > 1). The section reads inventory via `s.inventory.filter(storeId)`.
function seedStore() {
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
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockFetchDraft.mockResolvedValue(null);
  mockSaveDraft.mockResolvedValue(undefined);
  mockDeleteDraft.mockResolvedValue(undefined);
  mockLocalStore = {};
  setMockOnline(true);
  seedStore();
});

describe('InventoryCountSection — spec 106 save-draft + resume', () => {
  it('is a real React component that imports the draft helpers', () => {
    expect(typeof InventoryCountSection).toBe('function');
  });

  it('AC-5/AC-6/AC-16: restores the SERVER draft into the inputs and shows the banner', async () => {
    const savedAt = new Date(Date.now() - 3 * 60_000).toISOString();
    mockFetchDraft.mockResolvedValue({
      payload: serializeAdminInventoryDraft({
        kind: 'open',
        countedAtLocal: '',
        notes: 'post-delivery',
        caseCounts: { 'item-1': '2' },
        unitCounts: { 'item-1': '5' },
        itemNotes: {},
      }),
      savedAt,
    });
    const { getByTestId, getByDisplayValue } = render(<InventoryCountSection />);
    // The restored banner renders…
    await waitFor(() => expect(getByTestId('inv-draft-banner')).toBeTruthy());
    // …with a Discard affordance (AC-7)…
    expect(getByTestId('inv-draft-discard')).toBeTruthy();
    // …and the typed values are restored verbatim into the case/unit inputs.
    await waitFor(() => expect(getByDisplayValue('2')).toBeTruthy());
    expect(getByDisplayValue('5')).toBeTruthy();
  });

  it('AC-15/AC-16: restores the LOCAL draft when its saved_at is NEWER than the server (and pushes it up)', async () => {
    const localSavedAt = new Date().toISOString();
    const serverSavedAt = new Date(Date.now() - 10 * 60_000).toISOString();
    mockLocalStore[localKey('user-1', 'admin-inventory', 'store-1')] = {
      payload: serializeAdminInventoryDraft({
        kind: 'spot',
        countedAtLocal: '',
        notes: '',
        caseCounts: {},
        unitCounts: { 'item-1': '9' },
        itemNotes: {},
      }),
      savedAt: localSavedAt,
      unsynced: true,
    };
    mockFetchDraft.mockResolvedValue({
      payload: serializeAdminInventoryDraft({
        kind: 'spot',
        countedAtLocal: '',
        notes: '',
        caseCounts: {},
        unitCounts: { 'item-1': '3' },
        itemNotes: {},
      }),
      savedAt: serverSavedAt,
    });
    const { getByDisplayValue } = render(<InventoryCountSection />);
    // The NEWER local value wins the restore.
    await waitFor(() => expect(getByDisplayValue('9')).toBeTruthy());
    // reconcile action was 'push' → the local draft was saved up to the server.
    await waitFor(() => expect(mockSaveDraft).toHaveBeenCalled());
    // …and the local copy's unsynced flag was cleared.
    expect(mockLocalStore[localKey('user-1', 'admin-inventory', 'store-1')].unsynced).toBe(false);
  });

  it('AC-11: a stale item id in a restored draft is ignored (only live ids restore, no crash)', async () => {
    mockFetchDraft.mockResolvedValue({
      payload: serializeAdminInventoryDraft({
        kind: 'spot',
        countedAtLocal: '',
        notes: '',
        caseCounts: {},
        // item-ghost was deleted since the draft was saved → dropped on restore.
        unitCounts: { 'item-1': '7', 'item-ghost': '99' },
        itemNotes: {},
      }),
      savedAt: new Date().toISOString(),
    });
    const { getByDisplayValue, queryByDisplayValue } = render(<InventoryCountSection />);
    // The live value restores…
    await waitFor(() => expect(getByDisplayValue('7')).toBeTruthy());
    // …and the stale id's value never appears (its item isn't rendered).
    expect(queryByDisplayValue('99')).toBeNull();
  });

  it('AC-7: Discard deletes the server row + the local copy and clears the form', async () => {
    mockLocalStore[localKey('user-1', 'admin-inventory', 'store-1')] = {
      payload: serializeAdminInventoryDraft({
        kind: 'spot',
        countedAtLocal: '',
        notes: '',
        caseCounts: {},
        unitCounts: { 'item-1': '4' },
        itemNotes: {},
      }),
      savedAt: new Date().toISOString(),
      unsynced: false,
    };
    mockFetchDraft.mockResolvedValue({
      payload: serializeAdminInventoryDraft({
        kind: 'spot',
        countedAtLocal: '',
        notes: '',
        caseCounts: {},
        unitCounts: { 'item-1': '4' },
        itemNotes: {},
      }),
      savedAt: new Date().toISOString(),
    });
    const { getByTestId, queryByTestId, getByDisplayValue, queryByDisplayValue } = render(
      <InventoryCountSection />,
    );
    await waitFor(() => expect(getByTestId('inv-draft-banner')).toBeTruthy());
    expect(getByDisplayValue('4')).toBeTruthy();
    fireEvent.press(getByTestId('inv-draft-discard'));
    // The confirm fired…
    expect(mockConfirm).toHaveBeenCalled();
    // …the server delete fired…
    await waitFor(() => expect(mockDeleteDraft).toHaveBeenCalled());
    // …the local copy is gone…
    expect(mockLocalStore[localKey('user-1', 'admin-inventory', 'store-1')]).toBeUndefined();
    // …the banner is dismissed and the input cleared back to fresh.
    await waitFor(() => expect(queryByTestId('inv-draft-banner')).toBeNull());
    expect(queryByDisplayValue('4')).toBeNull();
  });

  it('AC-1/AC-12: Save is UNGATED — it writes the server draft + a synced local copy even with ZERO rows filled', async () => {
    const { getByTestId } = render(<InventoryCountSection />);
    await waitFor(() => expect(getByTestId('inv-save-draft')).toBeTruthy());
    // Press Save with a completely empty form — the count-everything gate applies
    // only to Submit, so a partial (here empty) draft still persists (AC-1/AC-12).
    fireEvent.press(getByTestId('inv-save-draft'));
    await waitFor(() => expect(mockSaveDraft).toHaveBeenCalled());
    // The online success toast is shown.
    const call = (Toast.show as jest.Mock).mock.calls.find((c) => c[0]?.text1 === 'Draft saved');
    expect(call).toBeTruthy();
    // The local mirror was written as synced (online path).
    expect(mockLocalStore[localKey('user-1', 'admin-inventory', 'store-1')]?.unsynced).toBe(false);
  });

  it('AC-14: offline Save writes an UNSYNCED local copy + the offline toast (no server write)', async () => {
    // The Save path is server-first now: an OFFLINE save is observed as a
    // server-write REJECTION → local-fallback (unsynced) + the offline toast.
    // Reject the server write to simulate offline / network failure.
    mockSaveDraft.mockRejectedValue(new Error('offline'));
    const { getByTestId } = render(<InventoryCountSection />);
    await waitFor(() => expect(getByTestId('inv-save-draft')).toBeTruthy());
    fireEvent.press(getByTestId('inv-save-draft'));
    // Offline toast shown (server write was ATTEMPTED then fell back to local).
    await waitFor(() => {
      const call = (Toast.show as jest.Mock).mock.calls.find(
        (c) => c[0]?.text1 === 'Saved on this device — will sync when online',
      );
      expect(call).toBeTruthy();
    });
    // The server write was attempted (server-first) but a local UNSYNCED copy is
    // the durable result. No error toast — the save succeeded locally (AC-14).
    expect(mockSaveDraft).toHaveBeenCalled();
    const errCall = (Toast.show as jest.Mock).mock.calls.find((c) => c[0]?.type === 'error');
    expect(errCall).toBeUndefined();
    expect(mockLocalStore[localKey('user-1', 'admin-inventory', 'store-1')]?.unsynced).toBe(true);
  });

  it('AC-9: pressing Save calls ONLY the draft helper — Submit is never invoked (no history row)', async () => {
    // Seed a submit spy on the store. AC-9: a draft is purely resumable state —
    // Save must NOT route through submitInventoryCount (which is the only path
    // that writes current_stock + the inventory_counts history row).
    const mockSubmit = jest.fn(() => Promise.resolve({ conflict: false } as unknown));
    useStore.setState({ submitInventoryCount: mockSubmit as any });
    const { getByTestId } = render(<InventoryCountSection />);
    await waitFor(() => expect(getByTestId('inv-save-draft')).toBeTruthy());
    fireEvent.press(getByTestId('inv-save-draft'));
    // The draft helper fired…
    await waitFor(() => expect(mockSaveDraft).toHaveBeenCalled());
    // …and Submit was NOT — Save and Submit are independent affordances.
    expect(mockSubmit).not.toHaveBeenCalled();
  });

  it('AC-17: a fresh mount (new device, empty local slot) restores the server draft the first device saved', async () => {
    // Cross-device visibility (AC-17): the server is the source of truth once
    // synced. This "second device" has an EMPTY local slot (mockLocalStore is
    // reset in beforeEach) and the server fetch returns the row the first device
    // saved — the fresh mount must fetch + restore it. (The DB owner-read layer
    // that makes this the SAME user's row across sessions is covered by the
    // pgTAP owner-scoped RLS suite; here we prove the client restores a
    // server-only draft on a device with no local copy.)
    const savedAt = new Date(Date.now() - 60_000).toISOString();
    mockFetchDraft.mockResolvedValue({
      payload: serializeAdminInventoryDraft({
        kind: 'spot',
        countedAtLocal: '',
        notes: '',
        caseCounts: {},
        unitCounts: { 'item-1': '42' },
        itemNotes: {},
      }),
      savedAt,
    });
    // No local draft on this device.
    expect(mockLocalStore[localKey('user-1', 'admin-inventory', 'store-1')]).toBeUndefined();
    const { getByTestId, getByDisplayValue } = render(<InventoryCountSection />);
    // The server draft restores into the input on the fresh device…
    await waitFor(() => expect(getByDisplayValue('42')).toBeTruthy());
    // …with the restored banner.
    expect(getByTestId('inv-draft-banner')).toBeTruthy();
  });
});
