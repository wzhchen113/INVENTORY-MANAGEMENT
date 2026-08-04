// src/screens/cmd/sections/phone/__tests__/PhoneOrdering.lastOrderContext.spec151.test.tsx
//
// Spec 151 (AC-14, §10 jest bullets 3 + 5 + 6) — the phone tier of the
// last-order context line.
//
// The point of this file is AC-14: the line is added ONCE, inside the EXPORTED
// `VendorOrderCard`, which BOTH PhoneOrdering (spec 143) and PhoneApproveOrder
// (spec 149) render. So every rendering assertion below runs TWICE — once
// through each screen — and `PhoneApproveOrder.tsx` is not edited at all. If a
// future change forks the card, the approve-screen half of this suite goes red.
//
// Uses the REAL store slices + the REAL pure formatter so the rendered strings
// are the production strings; only `db` / supabase are stubbed.

import React from 'react';
import { render } from '@testing-library/react-native';

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, left: 0, right: 0, bottom: 0 }),
}));

jest.mock('react-native-toast-message', () => ({
  __esModule: true,
  default: { show: jest.fn(), hide: jest.fn() },
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
import { PhoneOrdering } from '../PhoneOrdering';
import { PhoneApproveOrder } from '../PhoneApproveOrder';
import { useStore } from '../../../../../store/useStore';
import { usePaletteAction } from '../../../../../lib/paletteAction';
import type { LastOrderContext } from '../../../../../types';

const DATE = '2026-08-03';

function item(over: Record<string, any> = {}): any {
  return {
    itemId: 'a1', itemName: 'Wings', unit: 'lb',
    onHand: 0, pendingPoQty: 0, parLevel: 100, usageForecasted: 0, parReplacement: 0,
    suggestedQty: 30, costPerUnit: 3, estimatedCost: 60, caseQty: 6,
    suggestedCases: 5, suggestedUnits: 30, flags: [], ...over,
  };
}

function vendorRow(over: Record<string, any> = {}): any {
  return {
    vendorId: 'v-a', vendorName: 'US Foods', scheduleKnown: true,
    nextDeliveryDate: DATE, daysUntilNextDelivery: 1, onHandSource: 'eod',
    eodSubmittedAt: `${DATE}T18:00:00Z`, items: [item()], vendorTotalCost: 60, ...over,
  };
}

function everyDay(vendorIds: string[]) {
  const entries = vendorIds.map((id) => ({ vendorId: id, vendorName: id, deliveryDay: 'Monday' }));
  return { Monday: entries, Tuesday: entries, Wednesday: entries, Thursday: entries, Friday: entries, Saturday: entries, Sunday: entries };
}

function todayIso(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** The anchor: JUL 29, a placed PO, 78 base ordered (13 CS @ 6/case) and 30
 *  base counted (5 CS). Exactly the owner's example line. */
const CONTEXT: LastOrderContext = {
  'v-a': {
    vendorId: 'v-a',
    lastOrderDate: '2026-07-29',
    confidence: 'placed',
    source: 'purchase_order',
    sourceId: 'po-1',
    countedDate: '2026-07-29',
    itemsTruncated: false,
    items: { a1: { itemId: 'a1', orderedQtyBase: 78, countedQtyBase: 30 } },
  },
};

function seed(over: Record<string, any> = {}) {
  useStore.setState({
    currentStore: { id: 'store-1', brandId: 'b', name: 'Frederick', address: '', status: 'active' } as any,
    stores: [{ id: 'store-1', name: 'Frederick' } as any],
    orderSchedule: everyDay(['v-a']) as any,
    reorderPayload: {
      asOfDate: todayIso(),
      vendors: [vendorRow()],
      kpis: { vendorCount: 1, itemCount: 1, totalEstimatedCost: 60, eodSourcedVendorCount: 1, stockFallbackVendorCount: 0 },
      warnings: [],
    } as any,
    reorderLoading: false,
    reorderError: null,
    reorderEdits: {},
    inventory: [{ id: 'a1', subUnitSize: 1 } as any],
    vendors: [{ id: 'v-a', extensionOrdering: true, orderUnit: 'case' } as any],
    lastOrderContext: null,
    // Approve-screen slices (the deep link is pre-resolved; this suite drives
    // the RENDER, exactly as PhoneApproveOrder.test.tsx does).
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
    ...over,
  } as any);
}

/** AC-14 — the SAME assertions run through both consumers of VendorOrderCard. */
const SURFACES: Array<[string, () => React.ReactElement]> = [
  ['PhoneOrdering (spec 143)', () => <PhoneOrdering />],
  ['PhoneApproveOrder (spec 149)', () => <PhoneApproveOrder request={{ submissionId: 'sub-1', storeId: 'store-1' }} />],
];

beforeEach(() => {
  jest.clearAllMocks();
  usePaletteAction.setState({ pending: null });
  seed();
});

describe.each(SURFACES)('last-order context on %s', (_label, screen) => {
  it('AC-1 — renders the full context line under the item name', () => {
    useStore.setState({ lastOrderContext: CONTEXT });
    const { getByTestId } = render(screen());
    // Regex (substring) because the base fixture also renders the trend
    // marker as a sibling <Text> inside the same node — pinned separately below.
    expect(getByTestId('phone-order-last-order-a1'))
      .toHaveTextContent(/LAST JUL 29 · COUNTED 5 CS · ORDERED 13 CS/);
  });

  it('R-G / AC-17 — renders NOTHING while the context is null (not loaded)', () => {
    useStore.setState({ lastOrderContext: null });
    const { queryByTestId } = render(screen());
    expect(queryByTestId('phone-order-last-order-a1')).toBeNull();
    expect(queryByTestId('phone-order-last-order-none-v-a')).toBeNull();
    // The order line itself still renders — the annotation is decoration.
    expect(queryByTestId('phone-order-line-a1')).not.toBeNull();
    expect(Toast.show).not.toHaveBeenCalled();
  });

  it('AC-9 — a loaded context with no anchor shows ONE card-level line, not per row', () => {
    useStore.setState({ lastOrderContext: {} });
    const { getByTestId, queryByTestId, queryAllByText } = render(screen());
    expect(getByTestId('phone-order-last-order-none-v-a'))
      .toHaveTextContent('NO PRIOR ORDER ON RECORD');
    expect(queryByTestId('phone-order-last-order-a1')).toBeNull();
    expect(queryAllByText('NO PRIOR ORDER ON RECORD')).toHaveLength(1);
  });

  it('AC-3 — a `recorded` anchor adds the NOT CONFIRMED qualifier', () => {
    useStore.setState({
      lastOrderContext: { 'v-a': { ...CONTEXT['v-a'], confidence: 'recorded' } },
    });
    const { getByTestId } = render(screen());
    expect(getByTestId('phone-order-last-order-a1')).toHaveTextContent(/NOT CONFIRMED/);
  });

  it('AC-11 — the trend marker renders on an EOD-sourced vendor', () => {
    // On hand 48 base = 8 CS vs 30 base = 5 CS counted → ▲ +3 CS.
    useStore.setState({
      lastOrderContext: CONTEXT,
      reorderPayload: {
        ...useStore.getState().reorderPayload!,
        vendors: [vendorRow({ items: [item({ onHand: 48 })] })],
      } as any,
    });
    const { getByTestId } = render(screen());
    expect(getByTestId('phone-order-last-order-delta-a1')).toHaveTextContent('▲ +3 CS');
  });

  it('AC-12 — the marker is suppressed on a stock fallback, the line is not', () => {
    useStore.setState({
      lastOrderContext: CONTEXT,
      reorderPayload: {
        ...useStore.getState().reorderPayload!,
        vendors: [vendorRow({ onHandSource: 'stock', items: [item({ onHand: 48 })] })],
      } as any,
    });
    const { getByTestId, queryByTestId } = render(screen());
    // Regex (substring) because the base fixture also renders the trend
    // marker as a sibling <Text> inside the same node — pinned separately below.
    expect(getByTestId('phone-order-last-order-a1'))
      .toHaveTextContent(/LAST JUL 29 · COUNTED 5 CS · ORDERED 13 CS/);
    expect(queryByTestId('phone-order-last-order-delta-a1')).toBeNull();
  });

  it('AC-8 / R-10 — an item absent from the anchor order says NOT ORDERED, never ORDERED 0', () => {
    useStore.setState({
      lastOrderContext: {
        'v-a': {
          ...CONTEXT['v-a'],
          items: { a1: { itemId: 'a1', orderedQtyBase: null, countedQtyBase: 30 } },
        },
      },
    });
    const { getByTestId } = render(screen());
    const node = getByTestId('phone-order-last-order-a1');
    expect(node).toHaveTextContent(/LAST JUL 29 · COUNTED 5 CS · NOT ORDERED/);
    expect(node).not.toHaveTextContent(/ORDERED 0/);
  });

  it('AC-7 — a missing count omits the COUNTED clause entirely', () => {
    useStore.setState({
      lastOrderContext: {
        'v-a': {
          ...CONTEXT['v-a'],
          countedDate: null,
          items: { a1: { itemId: 'a1', orderedQtyBase: 78, countedQtyBase: null } },
        },
      },
    });
    const { getByTestId } = render(screen());
    const node = getByTestId('phone-order-last-order-a1');
    expect(node).toHaveTextContent(/LAST JUL 29 · ORDERED 13 CS/);
    expect(node).not.toHaveTextContent(/COUNTED/);
  });
});

describe('AC-REG — the spec-143 / spec-149 surfaces are unchanged when there is no context', () => {
  it('PhoneOrdering renders its KPI strip, card, stepper and cost with context null', () => {
    useStore.setState({ lastOrderContext: null });
    const { getByTestId, getByText } = render(<PhoneOrdering />);
    expect(getByText('US Foods')).toBeTruthy();
    expect(getByTestId('phone-order-kpi')).toHaveTextContent('1 VENDORS · 1 LINES · est $60.00');
    expect(getByTestId('phone-order-step-a1-inc')).toBeTruthy();
    expect(getByTestId('phone-order-line-cost-a1')).toHaveTextContent('$60.00');
  });

  it('PhoneApproveOrder keeps its single primary + disclosure with context null', () => {
    useStore.setState({ lastOrderContext: null });
    const { getByTestId } = render(
      <PhoneApproveOrder request={{ submissionId: 'sub-1', storeId: 'store-1' }} />,
    );
    expect(getByTestId('phone-approve-primary')).toBeTruthy();
    expect(getByTestId('phone-approve-disclosure')).toBeTruthy();
  });

  it('the context line never adds a tappable target (AC-16)', () => {
    useStore.setState({ lastOrderContext: CONTEXT });
    const { getByTestId } = render(<PhoneOrdering />);
    const node = getByTestId('phone-order-last-order-a1');
    expect(node.props.onPress).toBeUndefined();
    expect(node.props.accessibilityRole).toBeUndefined();
    // One line, ellipsized past full width — never a horizontal-scroll source.
    expect(node.props.numberOfLines).toBe(1);
  });
});
