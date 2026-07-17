// src/screens/staff/screens/Receiving.test.tsx — Spec 113 §4 (frontend slice).
//
// Renders the staff Receiving screen with the receiving carve-out mocked at its
// module boundary → asserts:
//   - the open-PO list renders (short id, status pill, vendor, date) + newest-first
//     (AC-7); a clear empty state when there are none.
//   - picking a PO prefills the "received now" input to the outstanding remainder
//     max(0, ordered − received) and shows NO price input anywhere (AC-8).
//   - the commit builds additive stock-only deltas (no price key), is confirm-gated
//     (receiving mutates stock), and mints ONE client uuid (AC-9/10).
//   - the online-only gate disables commit + shows the offline banner when
//     useConnectionStatus is offline; commit re-enables online (AC-11).
//   - success → success toast + list refresh (a now-received PO leaves the list);
//     an error surfaces via notifyBackendError and leaves inputs intact; a
//     conflict:true replay is treated as success-no-reapply (AC-12).
//
// Boundary mocking mirrors WeeklyCount.test.tsx / Reorder.test.tsx: mock the
// carve-out lib + useConnectionStatus + confirmAction, shim useFocusEffect to a
// plain effect, and stub the supabase client (sign-out only touches it).

jest.setTimeout(20000);

// useFocusEffect → run the callback once on mount (no navigator in tests).
// Spec 126 — <SettingsGear /> in the header also needs useNavigation.
jest.mock('@react-navigation/native', () => ({
  useFocusEffect: (cb: () => void | (() => void)) => {
    const { useEffect } = require('react');
    // eslint-disable-next-line react-hooks/rules-of-hooks
    useEffect(() => cb(), [cb]);
  },
  useNavigation: () => ({ navigate: jest.fn() }),
}));

// ─── mock the receiving carve-out at its module boundary ─────────────
// Keep the pure helpers real (buildReceiveDeltas / outstandingRemainder) — the
// screen relies on their behavior and they're separately unit-tested.
const mockFetchStaffOpenPos = jest.fn();
const mockFetchStaffPoLines = jest.fn();
const mockSubmitStaffReceive = jest.fn();
jest.mock('../lib/receiving', () => {
  const actual = jest.requireActual('../lib/receiving');
  return {
    ...actual,
    fetchStaffOpenPos: (...a: unknown[]) => mockFetchStaffOpenPos(...a),
    fetchStaffPoLines: (...a: unknown[]) => mockFetchStaffPoLines(...a),
    submitStaffReceive: (...a: unknown[]) => mockSubmitStaffReceive(...a),
  };
});

// A controllable online/offline signal (offline blocks submit — AC-11).
let mockOnline = true;
const setMockOnline = (v: boolean) => {
  mockOnline = v;
};
jest.mock('../hooks/useConnectionStatus', () => ({
  useConnectionStatus: () => mockOnline,
}));

// confirmAction is mocked to auto-confirm so the test exercises the post-confirm
// commit path deterministically; `mockConfirm` lets a test assert the confirm was
// invoked with the commit copy (the confirm-routing itself is covered by
// confirmAction's own contract).
const mockConfirm = jest.fn((_title: string, _message: string, onConfirm: () => void) => onConfirm());
jest.mock('../../../utils/confirmAction', () => ({
  confirmAction: (...args: unknown[]) =>
    (mockConfirm as unknown as (...a: unknown[]) => void)(...args),
}));

// Mint a deterministic client uuid so the AC-10 single-mint assertion is stable.
const mockUuid = jest.fn(() => 'uuid-fixed');
jest.mock('../lib/uuid', () => ({
  uuidv4: () => mockUuid(),
}));

// Receiving.tsx imports the real supabase client for its sign-out action — stub
// the boundary so the test env doesn't need SUPABASE_URL (mirrors Reorder.test).
// The data path is mocked at ../lib/receiving above.
jest.mock('../../../lib/supabase', () => ({
  supabase: {
    auth: { signOut: jest.fn().mockResolvedValue({ error: null }) },
  },
}));

import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import Toast from 'react-native-toast-message';
import { Receiving } from './Receiving';
import { useStaffStore } from '../store/useStaffStore';
import type { StaffOpenPo, StaffPoLine } from '../lib/receiving';

// ── fixtures ──
function po(over: Partial<StaffOpenPo> & { id: string }): StaffOpenPo {
  return {
    status: 'sent',
    vendorName: over.id,
    referenceDate: '2026-07-03',
    createdAt: '2026-07-03T10:00:00Z',
    ...over,
  };
}

function line(over: Partial<StaffPoLine> & { poItemId: string }): StaffPoLine {
  return {
    itemId: over.poItemId,
    itemName: 'Item',
    unit: 'each',
    orderedQty: 0,
    receivedQty: 0,
    i18nNames: {},
    ...over,
  };
}

function renderScreen() {
  return render(
    <SafeAreaProvider>
      <Receiving />
    </SafeAreaProvider>,
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  setMockOnline(true);
  // Default: happy resolves so a test only overrides what it cares about.
  mockFetchStaffOpenPos.mockResolvedValue([]);
  mockFetchStaffPoLines.mockResolvedValue([]);
  mockSubmitStaffReceive.mockResolvedValue({ status: 'received', conflict: false });
  useStaffStore.setState({
    authState: {
      kind: 'signed-in',
      userId: 'user-1',
      stores: [
        { storeId: 'store-1', storeName: 'Towson' },
        { storeId: 'store-2', storeName: 'Frederick' },
      ],
    },
    activeStore: { id: 'store-1', name: 'Towson' },
    locale: 'en',
  });
});

describe('Receiving — open-PO list + empty state (AC-7)', () => {
  it('renders the open POs with a short id, status pill, vendor name and date', async () => {
    mockFetchStaffOpenPos.mockResolvedValue([
      po({ id: 'po-aaaaaa', status: 'sent', vendorName: 'Acme', referenceDate: '2026-07-03' }),
      po({ id: 'po-bbbbbb', status: 'partial', vendorName: 'Beta', referenceDate: '2026-07-02' }),
    ]);
    const { getByTestId, getByText } = renderScreen();
    await waitFor(() => expect(getByTestId('staff-receiving-po-po-aaaaaa')).toBeTruthy());
    expect(getByTestId('staff-receiving-po-po-bbbbbb')).toBeTruthy();
    // Vendor names + status pills render.
    expect(getByText('Acme')).toBeTruthy();
    expect(getByText('Beta')).toBeTruthy();
    expect(getByText('SENT')).toBeTruthy();
    expect(getByText('PARTIAL')).toBeTruthy();
    // The screen requested the active store's open POs.
    expect(mockFetchStaffOpenPos).toHaveBeenCalledWith('store-1');
  });

  it('shows the empty state when there are no open POs', async () => {
    mockFetchStaffOpenPos.mockResolvedValue([]);
    const { getByTestId, queryByTestId } = renderScreen();
    await waitFor(() => expect(getByTestId('staff-receiving-empty')).toBeTruthy());
    expect(queryByTestId('staff-receiving-list')).toBeNull();
  });

  it('shows the initial loading state while the fetch is pending', () => {
    mockFetchStaffOpenPos.mockReturnValue(new Promise<never>(() => {}));
    const { getByTestId } = renderScreen();
    expect(getByTestId('staff-receiving-loading')).toBeTruthy();
  });

  it('shows a retry-able error pane when the fetch rejects', async () => {
    mockFetchStaffOpenPos.mockRejectedValue(new Error('permission denied for relation purchase_orders'));
    const { getByTestId, getByText } = renderScreen();
    await waitFor(() => expect(getByTestId('staff-receiving-error')).toBeTruthy());
    expect(getByText('permission denied for relation purchase_orders')).toBeTruthy();
    // Retry re-invokes the fetch.
    mockFetchStaffOpenPos.mockResolvedValue([po({ id: 'po-1', vendorName: 'Acme' })]);
    await act(async () => {
      fireEvent.press(getByTestId('staff-receiving-retry'));
    });
    await waitFor(() => expect(getByTestId('staff-receiving-po-po-1')).toBeTruthy());
  });
});

describe('Receiving — pick → prefilled lines, no price surface (AC-8)', () => {
  it('prefills the "received now" input to the outstanding remainder and shows NO price input', async () => {
    mockFetchStaffOpenPos.mockResolvedValue([po({ id: 'po-1', vendorName: 'Acme' })]);
    mockFetchStaffPoLines.mockResolvedValue([
      line({ poItemId: 'poi-1', itemName: 'Buns', orderedQty: 10, receivedQty: 3 }),
    ]);
    const { getByTestId, queryByTestId } = renderScreen();
    await waitFor(() => expect(getByTestId('staff-receiving-po-po-1')).toBeTruthy());
    await act(async () => {
      fireEvent.press(getByTestId('staff-receiving-po-po-1'));
    });
    await waitFor(() => expect(getByTestId('staff-receiving-line-poi-1')).toBeTruthy());
    // Prefill = max(0, 10 - 3) = 7.
    expect(getByTestId('staff-receiving-input-poi-1').props.value).toBe('7');
    // R-1 belt: there is NO price/cost input anywhere on the staff screen.
    expect(queryByTestId('staff-receiving-price-poi-1')).toBeNull();
    expect(queryByTestId('receiving-price-poi-1')).toBeNull();
  });

  it('clamps the prefill to 0 for a fully-received line', async () => {
    mockFetchStaffOpenPos.mockResolvedValue([po({ id: 'po-1', vendorName: 'Acme' })]);
    mockFetchStaffPoLines.mockResolvedValue([
      line({ poItemId: 'poi-1', orderedQty: 5, receivedQty: 5 }),
    ]);
    const { getByTestId } = renderScreen();
    await waitFor(() => expect(getByTestId('staff-receiving-po-po-1')).toBeTruthy());
    await act(async () => {
      fireEvent.press(getByTestId('staff-receiving-po-po-1'));
    });
    await waitFor(() => expect(getByTestId('staff-receiving-input-poi-1')).toBeTruthy());
    expect(getByTestId('staff-receiving-input-poi-1').props.value).toBe('0');
  });

  it('shows the no-line-items state when the PO has no lines', async () => {
    mockFetchStaffOpenPos.mockResolvedValue([po({ id: 'po-1', vendorName: 'Acme' })]);
    mockFetchStaffPoLines.mockResolvedValue([]);
    const { getByTestId } = renderScreen();
    await waitFor(() => expect(getByTestId('staff-receiving-po-po-1')).toBeTruthy());
    await act(async () => {
      fireEvent.press(getByTestId('staff-receiving-po-po-1'));
    });
    await waitFor(() => expect(getByTestId('staff-receiving-no-lines')).toBeTruthy());
  });
});

describe('Receiving — commit (AC-9/10)', () => {
  async function pickPo(getByTestId: (id: string) => unknown) {
    await waitFor(() => expect(getByTestId('staff-receiving-po-po-1')).toBeTruthy());
    await act(async () => {
      fireEvent.press(getByTestId('staff-receiving-po-po-1') as never);
    });
    await waitFor(() => expect(getByTestId('staff-receiving-line-poi-1')).toBeTruthy());
  }

  it('confirms then calls submitStaffReceive with the additive deltas (no price key) and ONE client uuid', async () => {
    mockFetchStaffOpenPos.mockResolvedValue([po({ id: 'po-1', vendorName: 'Acme' })]);
    mockFetchStaffPoLines.mockResolvedValue([
      line({ poItemId: 'poi-1', orderedQty: 10, receivedQty: 0 }),
      line({ poItemId: 'poi-2', orderedQty: 4, receivedQty: 0 }),
    ]);
    const { getByTestId } = renderScreen();
    await pickPo(getByTestId);
    // Override poi-2 to a partial receive; poi-1 keeps its prefilled 10.
    fireEvent.changeText(getByTestId('staff-receiving-input-poi-2'), '2');
    await act(async () => {
      fireEvent.press(getByTestId('staff-receiving-commit'));
    });
    // The commit is confirm-gated (receiving mutates stock).
    expect(mockConfirm).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(mockSubmitStaffReceive).toHaveBeenCalledTimes(1));
    const [poId, deltas, clientUuid] = mockSubmitStaffReceive.mock.calls[0];
    expect(poId).toBe('po-1');
    expect(deltas).toEqual([
      { poItemId: 'poi-1', receivedQty: 10 },
      { poItemId: 'poi-2', receivedQty: 2 },
    ]);
    // No price key on any delta (R-1).
    for (const d of deltas) {
      expect(Object.keys(d).sort()).toEqual(['poItemId', 'receivedQty']);
    }
    // One client uuid minted for the commit (idempotency).
    expect(mockUuid).toHaveBeenCalledTimes(1);
    expect(clientUuid).toBe('uuid-fixed');
  });

  it('filters zero/blank rows from the payload', async () => {
    mockFetchStaffOpenPos.mockResolvedValue([po({ id: 'po-1', vendorName: 'Acme' })]);
    mockFetchStaffPoLines.mockResolvedValue([
      line({ poItemId: 'poi-1', orderedQty: 10, receivedQty: 0 }),
      line({ poItemId: 'poi-2', orderedQty: 4, receivedQty: 0 }),
    ]);
    const { getByTestId } = renderScreen();
    await pickPo(getByTestId);
    // Zero out poi-1; leave poi-2 at its prefilled 4.
    fireEvent.changeText(getByTestId('staff-receiving-input-poi-1'), '0');
    await act(async () => {
      fireEvent.press(getByTestId('staff-receiving-commit'));
    });
    await waitFor(() => expect(mockSubmitStaffReceive).toHaveBeenCalledTimes(1));
    const [, deltas] = mockSubmitStaffReceive.mock.calls[0];
    // Only the non-zero row survives.
    expect(deltas).toEqual([{ poItemId: 'poi-2', receivedQty: 4 }]);
  });

  it('blocks an all-zero commit with a nothing-to-receive message and never calls the RPC', async () => {
    mockFetchStaffOpenPos.mockResolvedValue([po({ id: 'po-1', vendorName: 'Acme' })]);
    mockFetchStaffPoLines.mockResolvedValue([
      line({ poItemId: 'poi-1', orderedQty: 10, receivedQty: 0 }),
    ]);
    const { getByTestId } = renderScreen();
    await pickPo(getByTestId);
    fireEvent.changeText(getByTestId('staff-receiving-input-poi-1'), '0');
    await act(async () => {
      fireEvent.press(getByTestId('staff-receiving-commit'));
    });
    expect(mockSubmitStaffReceive).not.toHaveBeenCalled();
    const call = (Toast.show as jest.Mock).mock.calls.find(
      (c) => c[0]?.text1 === 'Nothing to receive — enter at least one quantity.',
    );
    expect(call).toBeTruthy();
    // A blocked commit is not confirm-gated (nothing to confirm).
    expect(mockConfirm).not.toHaveBeenCalled();
  });
});

describe('Receiving — online-only gate (AC-11)', () => {
  it('disables commit and shows the offline banner when offline; commit is not called on tap', async () => {
    setMockOnline(false);
    mockFetchStaffOpenPos.mockResolvedValue([po({ id: 'po-1', vendorName: 'Acme' })]);
    mockFetchStaffPoLines.mockResolvedValue([
      line({ poItemId: 'poi-1', orderedQty: 10, receivedQty: 0 }),
    ]);
    const { getByTestId } = renderScreen();
    await waitFor(() => expect(getByTestId('staff-receiving-po-po-1')).toBeTruthy());
    // The offline banner renders on the list view too.
    expect(getByTestId('staff-receiving-offline')).toBeTruthy();
    await act(async () => {
      fireEvent.press(getByTestId('staff-receiving-po-po-1'));
    });
    await waitFor(() => expect(getByTestId('staff-receiving-commit')).toBeTruthy());
    // The commit button is disabled while offline…
    expect(getByTestId('staff-receiving-commit').props.accessibilityState?.disabled).toBe(true);
    // …and even a forced press does not submit.
    await act(async () => {
      fireEvent.press(getByTestId('staff-receiving-commit'));
    });
    expect(mockSubmitStaffReceive).not.toHaveBeenCalled();
  });

  it('re-enables commit when the connection returns', async () => {
    setMockOnline(false);
    mockFetchStaffOpenPos.mockResolvedValue([po({ id: 'po-1', vendorName: 'Acme' })]);
    mockFetchStaffPoLines.mockResolvedValue([
      line({ poItemId: 'poi-1', orderedQty: 10, receivedQty: 0 }),
    ]);
    const { getByTestId, rerender, queryByTestId } = renderScreen();
    await waitFor(() => expect(getByTestId('staff-receiving-po-po-1')).toBeTruthy());
    await act(async () => {
      fireEvent.press(getByTestId('staff-receiving-po-po-1'));
    });
    await waitFor(() => expect(getByTestId('staff-receiving-commit')).toBeTruthy());
    expect(getByTestId('staff-receiving-commit').props.accessibilityState?.disabled).toBe(true);
    // Flip online + re-render → the banner clears and the commit re-enables.
    setMockOnline(true);
    rerender(
      <SafeAreaProvider>
        <Receiving />
      </SafeAreaProvider>,
    );
    await waitFor(() => expect(queryByTestId('staff-receiving-offline')).toBeNull());
    expect(getByTestId('staff-receiving-commit').props.accessibilityState?.disabled).toBe(false);
  });
});

describe('Receiving — success / error / replay (AC-12)', () => {
  async function pickAndReadyCommit(getByTestId: (id: string) => unknown) {
    await waitFor(() => expect(getByTestId('staff-receiving-po-po-1')).toBeTruthy());
    await act(async () => {
      fireEvent.press(getByTestId('staff-receiving-po-po-1') as never);
    });
    await waitFor(() => expect(getByTestId('staff-receiving-line-poi-1')).toBeTruthy());
  }

  it('on success shows a success toast and re-fetches the open POs (list refresh)', async () => {
    mockFetchStaffOpenPos.mockResolvedValue([po({ id: 'po-1', vendorName: 'Acme' })]);
    mockFetchStaffPoLines.mockResolvedValue([
      line({ poItemId: 'poi-1', orderedQty: 10, receivedQty: 0 }),
    ]);
    mockSubmitStaffReceive.mockResolvedValue({ status: 'received', conflict: false });
    const { getByTestId } = renderScreen();
    await pickAndReadyCommit(getByTestId);
    // The initial mount fetched the list once; clear so we can assert the refresh.
    mockFetchStaffOpenPos.mockClear();
    // On success the now-fully-received PO leaves the list.
    mockFetchStaffOpenPos.mockResolvedValue([]);
    await act(async () => {
      fireEvent.press(getByTestId('staff-receiving-commit'));
    });
    await waitFor(() => expect(mockSubmitStaffReceive).toHaveBeenCalled());
    const successCall = (Toast.show as jest.Mock).mock.calls.find(
      (c) => c[0]?.text1 === 'Delivery received',
    );
    expect(successCall).toBeTruthy();
    // The list refresh re-fetched the open POs…
    await waitFor(() => expect(mockFetchStaffOpenPos).toHaveBeenCalledWith('store-1'));
    // …and the screen returns to the empty list (the received PO is gone).
    await waitFor(() => expect(getByTestId('staff-receiving-empty')).toBeTruthy());
  });

  it('on a backend error surfaces via notifyBackendError, no success toast, inputs intact', async () => {
    mockFetchStaffOpenPos.mockResolvedValue([po({ id: 'po-1', vendorName: 'Acme' })]);
    mockFetchStaffPoLines.mockResolvedValue([
      line({ poItemId: 'poi-1', orderedQty: 10, receivedQty: 0 }),
    ]);
    // Simulate the AC-2 42501 refusal should staff ever reach it.
    mockSubmitStaffReceive.mockRejectedValue(
      Object.assign(new Error('forbidden: price change requires admin'), { code: '42501' }),
    );
    const { getByTestId } = renderScreen();
    await pickAndReadyCommit(getByTestId);
    fireEvent.changeText(getByTestId('staff-receiving-input-poi-1'), '6');
    await act(async () => {
      fireEvent.press(getByTestId('staff-receiving-commit'));
    });
    await waitFor(() => expect(mockSubmitStaffReceive).toHaveBeenCalled());
    // notifyBackendError toasts the error (label = the caller string).
    const errorCall = (Toast.show as jest.Mock).mock.calls.find(
      (c) => c[0]?.type === 'error' && c[0]?.text1 === 'submitStaffReceive',
    );
    expect(errorCall).toBeTruthy();
    // No success toast.
    const successCall = (Toast.show as jest.Mock).mock.calls.find(
      (c) => c[0]?.text1 === 'Delivery received',
    );
    expect(successCall).toBeFalsy();
    // The detail view is still shown (no phantom success return-to-list) and the
    // typed input retains its value.
    expect(getByTestId('staff-receiving-input-poi-1').props.value).toBe('6');
  });

  it('treats a conflict:true replay as success (refresh, no double-submit, no error toast)', async () => {
    mockFetchStaffOpenPos.mockResolvedValue([po({ id: 'po-1', vendorName: 'Acme' })]);
    mockFetchStaffPoLines.mockResolvedValue([
      line({ poItemId: 'poi-1', orderedQty: 8, receivedQty: 0 }),
    ]);
    // A replay envelope — the server already deduped.
    mockSubmitStaffReceive.mockResolvedValue({ status: 'received', conflict: true });
    const { getByTestId } = renderScreen();
    await pickAndReadyCommit(getByTestId);
    mockFetchStaffOpenPos.mockClear();
    mockFetchStaffOpenPos.mockResolvedValue([]);
    await act(async () => {
      fireEvent.press(getByTestId('staff-receiving-commit'));
    });
    await waitFor(() => expect(mockSubmitStaffReceive).toHaveBeenCalledTimes(1));
    // A replay is a SUCCESS, not an error — the success toast fires.
    const successCall = (Toast.show as jest.Mock).mock.calls.find(
      (c) => c[0]?.text1 === 'Delivery received',
    );
    expect(successCall).toBeTruthy();
    // No error toast for a conflict replay.
    const errorCall = (Toast.show as jest.Mock).mock.calls.find((c) => c[0]?.type === 'error');
    expect(errorCall).toBeFalsy();
    // The list refreshed and the RPC was NOT re-invoked (no double-submit).
    await waitFor(() => expect(mockFetchStaffOpenPos).toHaveBeenCalledWith('store-1'));
    expect(mockSubmitStaffReceive).toHaveBeenCalledTimes(1);
  });
});

describe('Receiving — root structure + no active store', () => {
  it('root is a SafeAreaView with edges top+bottom (staff convention)', async () => {
    mockFetchStaffOpenPos.mockResolvedValue([po({ id: 'po-1', vendorName: 'Acme' })]);
    const { getByTestId } = renderScreen();
    await waitFor(() => expect(getByTestId('staff-receiving-po-po-1')).toBeTruthy());
    const root = getByTestId('staff-receiving-root');
    expect(root.type).toBe('SafeAreaView');
    expect(root.props.edges).toEqual(['top', 'bottom']);
  });

  it('renders the defensive ActivityIndicator and does NOT fetch when activeStore is null', () => {
    useStaffStore.setState({ activeStore: null });
    const { UNSAFE_getByType, queryByTestId } = renderScreen();
    const { ActivityIndicator } = require('react-native');
    expect(UNSAFE_getByType(ActivityIndicator)).toBeTruthy();
    expect(queryByTestId('staff-receiving-root')).toBeNull();
    expect(mockFetchStaffOpenPos).not.toHaveBeenCalled();
  });
});
