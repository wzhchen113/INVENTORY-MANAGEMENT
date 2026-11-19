// src/screens/cmd/sections/phone/__tests__/PhoneOrdering.primaryWins.spec201.test.tsx
//
// Spec 201 (AC-22) — the phone tier of the "also from … — switch" line.
//
// The line lives ONCE inside the exported `VendorOrderCard`, which both
// PhoneOrdering and PhoneApproveOrder render:
//   - PhoneOrdering (footer='default') → the line AND the switch control, wired
//     to `switchItemPrimaryVendor` with a confirmAction confirm;
//   - PhoneApproveOrder (footer='none') → the line text-only, no switch (the
//     approve screen reviews a fixed order; switching there would move the
//     item off the order under review).
// Uses the REAL store slices + REAL English catalog (only db / supabase are
// stubbed), the same posture as PhoneOrdering.lastOrderContext.spec151.test.tsx.

import React from 'react';
import { render, fireEvent, act } from '@testing-library/react-native';

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, left: 0, right: 0, bottom: 0 }),
}));

jest.mock('react-native-toast-message', () => ({
  __esModule: true,
  default: { show: jest.fn(), hide: jest.fn() },
}));

jest.mock('../../../../../utils/confirmAction', () => ({
  confirmAction: jest.fn(),
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

jest.mock('../../../../../theme/breakpoints', () => {
  const actual = jest.requireActual('../../../../../theme/breakpoints');
  return { ...actual, useIsPhone: () => true, useIsTablet: () => false, useIsDesktop: () => false, useIsCompact: () => true, useBreakpoint: () => 'phone' };
});

import Toast from 'react-native-toast-message';
import { confirmAction } from '../../../../../utils/confirmAction';
import { PhoneOrdering } from '../PhoneOrdering';
import { PhoneApproveOrder } from '../PhoneApproveOrder';
import { useStore } from '../../../../../store/useStore';
import { usePaletteAction } from '../../../../../lib/paletteAction';

const confirmActionMock = confirmAction as jest.Mock;
const toastShowMock = (Toast as any).show as jest.Mock;

function todayIso(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

const BRAVO = { vendorId: 'v-b', vendorName: 'Bravo Supply' };

function item(over: Record<string, any> = {}): any {
  return {
    itemId: 'f1', itemName: 'Fryer Oil', unit: 'jug',
    onHand: 0, pendingPoQty: 0, parLevel: 10, usageForecasted: 0, parReplacement: 0,
    suggestedQty: 6, costPerUnit: 3, estimatedCost: 18, caseQty: 1,
    suggestedCases: null, suggestedUnits: 6, flags: [],
    otherVendorCount: 1, alsoFromVendors: [BRAVO], yieldedFromVendors: [BRAVO],
    ...over,
  };
}

function vendorRow(over: Record<string, any> = {}): any {
  return {
    vendorId: 'v-a', vendorName: 'Alpha Foods', scheduleKnown: true,
    nextDeliveryDate: todayIso(), daysUntilNextDelivery: 1, onHandSource: 'eod',
    eodSubmittedAt: `${todayIso()}T18:00:00Z`, items: [item()], vendorTotalCost: 18, ...over,
  };
}

function everyDay(vendorIds: string[]) {
  const entries = vendorIds.map((id) => ({ vendorId: id, vendorName: id, deliveryDay: 'Monday' }));
  return { Monday: entries, Tuesday: entries, Wednesday: entries, Thursday: entries, Friday: entries, Saturday: entries, Sunday: entries };
}

const switchMock = jest.fn();

function seed(vendors: any[] = [vendorRow()]) {
  useStore.setState({
    currentStore: { id: 'store-1', brandId: 'b', name: 'Frederick', address: '', status: 'active' } as any,
    stores: [{ id: 'store-1', name: 'Frederick' } as any],
    orderSchedule: everyDay(vendors.map((v) => v.vendorId)) as any,
    reorderPayload: {
      asOfDate: todayIso(),
      vendors,
      kpis: { vendorCount: vendors.length, itemCount: 1, totalEstimatedCost: 18, eodSourcedVendorCount: 1, stockFallbackVendorCount: 0 },
      warnings: [],
    } as any,
    reorderLoading: false,
    reorderError: null,
    reorderEdits: {},
    inventory: [{ id: 'f1', subUnitSize: 1 } as any],
    vendors: [{ id: 'v-a', extensionOrdering: true, orderUnit: 'case' } as any],
    lastOrderContext: null,
    approvalContext: { submissionId: 'sub-1', storeId: 'store-1', vendorId: 'v-a', businessDate: todayIso() },
    approval: null,
    approvalLoading: false,
    approvalError: null,
    approvalBusy: false,
    submissionNotifications: [],
    loadOrderApproval: (async () => {}) as any,
    loadReorderSuggestions: (async () => {}) as any,
    loadLastOrderContext: (async () => {}) as any,
    approveAndOrder: (async () => null) as any,
    markOrderApprovalOrdered: (async () => {}) as any,
    switchItemPrimaryVendor: switchMock as any,
  } as any);
}

beforeEach(() => {
  jest.clearAllMocks();
  usePaletteAction.setState({ pending: null });
  switchMock.mockReset();
  seed();
});

describe('PhoneOrdering — spec 201 primary wins (AC-22)', () => {
  it('renders "also from B" with a switch on A\'s F row', () => {
    const { getByTestId, getAllByTestId } = render(<PhoneOrdering />);
    expect(getByTestId('reorder-yielded-from-f1')).toHaveTextContent('also from Bravo Supply');
    expect(getByTestId('reorder-switch-primary-f1-v-b')).toHaveTextContent('switch');
    expect(getAllByTestId(/^reorder-switch-primary-f1-/)).toHaveLength(1);
    // Phone has no spec-102 "order from one" line at all.
    expect(() => getByTestId('reorder-also-from-f1')).toThrow();
  });

  it('a row with an empty yielded list renders no line and no switch', () => {
    seed([vendorRow({ items: [item({ yieldedFromVendors: [] })] })]);
    const { queryByTestId } = render(<PhoneOrdering />);
    expect(queryByTestId('reorder-yielded-from-f1')).toBeNull();
    expect(queryByTestId('reorder-switch-primary-f1-v-b')).toBeNull();
  });

  it('switch → switchItemPrimaryVendor(A→B, as-of) with a confirmAction confirm', async () => {
    switchMock.mockImplementation(async (args: any) => ((await args.confirm()) ? 'switched' : 'cancelled'));
    confirmActionMock.mockImplementation((_t: string, _b: string, onConfirm: () => void) => onConfirm());

    const { getByTestId } = render(<PhoneOrdering />);
    fireEvent.press(getByTestId('reorder-switch-primary-f1-v-b'));
    await act(async () => { await new Promise<void>((r) => setTimeout(r, 0)); });

    expect(switchMock).toHaveBeenCalledWith(
      expect.objectContaining({ itemId: 'f1', fromVendorId: 'v-a', toVendorId: 'v-b', asOfDate: todayIso() }),
    );
    expect(confirmActionMock).toHaveBeenCalledTimes(1);
    expect(confirmActionMock.mock.calls[0][0]).toBe('Make Bravo Supply the primary vendor?');
    expect(confirmActionMock.mock.calls[0][1]).toContain('Alpha Foods');
    expect(confirmActionMock.mock.calls[0][1]).toContain('permanent for this store');
  });

  it('refused (3c) → error toast, no confirm', async () => {
    switchMock.mockResolvedValue('refused');
    const { getByTestId } = render(<PhoneOrdering />);
    fireEvent.press(getByTestId('reorder-switch-primary-f1-v-b'));
    await act(async () => { await new Promise<void>((r) => setTimeout(r, 0)); });

    expect(confirmActionMock).not.toHaveBeenCalled();
    expect(toastShowMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'error',
        text2: "Fryer Oil is already on today's Alpha Foods order. Remove it from that order first.",
      }),
    );
  });
});

describe('PhoneApproveOrder — spec 201 (inherits the card, text-only)', () => {
  it('renders the "also from" line with NO switch control', () => {
    const { getByTestId, queryByTestId } = render(
      <PhoneApproveOrder request={{ submissionId: 'sub-1', storeId: 'store-1' }} />,
    );
    expect(getByTestId('reorder-yielded-from-f1')).toHaveTextContent('also from Bravo Supply');
    expect(queryByTestId('reorder-switch-primary-f1-v-b')).toBeNull();
  });
});
