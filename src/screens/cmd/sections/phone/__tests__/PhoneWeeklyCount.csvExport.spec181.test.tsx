// src/screens/cmd/sections/phone/__tests__/PhoneWeeklyCount.csvExport.spec181.test.tsx
//
// Spec 181 (C1 / AC-17, spec risk 4). The phone weekly-count "↓ CSV" chip runs
// InventoryCountSection's `onExportCsv`, which now AWAITS `downloadCSV` (on
// native that promise settles when the share sheet closes, and rejects when
// sharing is unavailable). Pins the call site, not just the helper:
//   - the success toast fires only AFTER downloadCSV resolves, never early;
//   - a rejection shows the exportFailed toast, no success toast, and no
//     unhandled rejection escapes the handler.
//
// Renders the real section on the phone tier (mock breakpoints) with
// `downloadCSV` replaced by a controllable promise. Scaffold mirrors
// PhoneWeeklyCount.acReg.test.tsx + InventoryCountSection.clientUuid.spec181.

import React from 'react';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import Toast from 'react-native-toast-message';

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, left: 0, right: 0, bottom: 0 }),
}));

jest.mock('../../../../../lib/supabase', () => ({
  __esModule: true,
  supabase: {
    auth: {
      getSession: jest.fn(() => Promise.resolve({ data: { session: null }, error: null })),
      onAuthStateChange: jest.fn(() => ({ data: { subscription: { unsubscribe: jest.fn() } } })),
    },
    from: jest.fn(() => ({ select: jest.fn().mockReturnThis(), eq: jest.fn().mockReturnThis(), order: jest.fn().mockReturnThis(), single: jest.fn(() => Promise.resolve({ data: null, error: null })), maybeSingle: jest.fn(() => Promise.resolve({ data: null, error: null })) })),
    rpc: jest.fn(() => Promise.resolve({ data: null, error: null })),
    channel: jest.fn(() => ({ on: jest.fn().mockReturnThis(), subscribe: jest.fn(() => ({ unsubscribe: jest.fn() })) })),
    removeChannel: jest.fn(),
    functions: { invoke: jest.fn() },
  },
}));

jest.mock('../../../../../lib/db', () =>
  new Proxy({ __esModule: true }, { get: (t: Record<string, unknown>, p: string) => (p in t ? (t as any)[p] : jest.fn(() => Promise.resolve(null))) }),
);

jest.mock('../../../../../lib/countDraftLocal', () => ({
  __esModule: true,
  readLocalCountDraft: jest.fn(() => null),
  loadLocalCountDraft: jest.fn(() => Promise.resolve(null)),
  writeLocalCountDraft: jest.fn(),
  clearLocalCountDraft: jest.fn(),
}));

jest.mock('../../../../../hooks/useConnectionStatus', () => ({
  useConnectionStatus: () => true,
}));

jest.mock('../../../../../theme/breakpoints', () => {
  const actual = jest.requireActual('../../../../../theme/breakpoints');
  return {
    ...actual,
    useIsPhone: () => true,
    useIsTablet: () => false,
    useIsDesktop: () => false,
    useIsCompact: () => true,
    useBreakpoint: () => 'phone',
  };
});

// Only downloadCSV is replaced; every other util (todayIso, etc.) is real.
const mockDownloadCSV = jest.fn<Promise<void>, [string, string]>();
jest.mock('../../../../../utils', () => ({
  ...jest.requireActual('../../../../../utils'),
  downloadCSV: (filename: string, csv: string) => mockDownloadCSV(filename, csv),
}));

import InventoryCountSection from '../../InventoryCountSection';
import { useStore } from '../../../../../store/useStore';

const toastShow = Toast.show as jest.Mock;
type ToastArg = { type: string; text1?: string; text2?: string };
const toastsOfType = (type: string): ToastArg[] =>
  toastShow.mock.calls.map((c) => c[0] as ToastArg).filter((a) => a.type === type);

function seed() {
  useStore.setState({
    currentStore: { id: 'store-1', brandId: 'b', name: 'Frederick', address: '', status: 'active' } as any,
    currentUser: { id: 'user-1', name: 'Admin', email: 'a@b.c', role: 'admin' } as any,
    stores: [{ id: 'store-1', name: 'Frederick' } as any],
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
    weeklyCountStatus: undefined,
    weeklyCountStatusLoading: false,
    loadWeeklyCountStatus: (async () => {}) as any,
    fetchStoreCountLayouts: (async () => []) as any,
  });
}

let warnSpy: jest.SpyInstance;
const unhandled: unknown[] = [];
const onUnhandled = (reason: unknown) => {
  unhandled.push(reason);
};

beforeEach(() => {
  jest.clearAllMocks();
  unhandled.length = 0;
  process.on('unhandledRejection', onUnhandled);
  warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  seed();
});

afterEach(() => {
  process.off('unhandledRejection', onUnhandled);
  warnSpy.mockRestore();
});

describe('phone weekly count — CSV export call site (spec 181 AC-17)', () => {
  it('shows the success toast only after downloadCSV resolves', async () => {
    let resolveShare: () => void = () => {};
    mockDownloadCSV.mockImplementation(
      () => new Promise<void>((resolve) => { resolveShare = resolve; }),
    );

    const { getByTestId } = render(<InventoryCountSection />);
    fireEvent.press(getByTestId('weekly-export-csv'));

    await waitFor(() => expect(mockDownloadCSV).toHaveBeenCalledTimes(1));
    const [filename, csv] = mockDownloadCSV.mock.calls[0];
    expect(filename).toMatch(/\.csv$/);
    expect(filename).toContain('Frederick');
    expect(csv).toContain('Flour');

    // Share sheet still open: no success toast yet, no error toast either.
    await act(async () => {
      await Promise.resolve();
    });
    expect(toastsOfType('success')).toHaveLength(0);
    expect(toastsOfType('error')).toHaveLength(0);

    await act(async () => {
      resolveShare();
    });

    await waitFor(() => expect(toastsOfType('success')).toHaveLength(1));
    expect(toastsOfType('success')[0]).toEqual(
      expect.objectContaining({ text1: 'CSV exported', text2: filename }),
    );
    expect(toastsOfType('error')).toHaveLength(0);
  });

  it('a rejection (e.g. sharing unavailable) shows exportFailed, no success toast, no unhandled rejection', async () => {
    mockDownloadCSV.mockRejectedValue(new Error('Sharing is not available on this device'));

    const { getByTestId } = render(<InventoryCountSection />);
    fireEvent.press(getByTestId('weekly-export-csv'));

    await waitFor(() => expect(toastsOfType('error')).toHaveLength(1));
    expect(toastsOfType('error')[0]).toEqual(expect.objectContaining({ text1: 'Export failed' }));
    expect(toastsOfType('success')).toHaveLength(0);
    expect(warnSpy).toHaveBeenCalledWith(
      '[InventoryCount] CSV export failed:',
      'Sharing is not available on this device',
    );

    // Give Node a turn to report any rejection that escaped the handler.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(unhandled).toEqual([]);
  });
});
