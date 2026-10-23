// src/screens/cmd/sections/phone/__tests__/PhoneOrdering.noNeed.spec174.test.tsx
//
// Spec 174 (G5, D1; AC-14..AC-19) — the phone Ordering card tags a stepped-up
// NO NEED line, so the manager sees they are overriding a "more than enough"
// count. The tag lives inside the EXPORTED `VendorOrderCard`, which BOTH
// PhoneOrdering (spec 143) and PhoneApproveOrder (spec 149) render — so every
// assertion runs through both screens, and `PhoneApproveOrder.tsx` is not
// edited (AC-18 by inheritance). The line filter is unchanged: an UNEDITED NO
// NEED row stays hidden (AC-17).
//
// Uses the REAL store slices + the REAL i18n catalog so the rendered strings
// are the production strings; only `db` / supabase are stubbed (the spec 151
// idiom).

import React from 'react';
import { StyleSheet } from 'react-native';
import { render, within } from '@testing-library/react-native';

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

import { PhoneOrdering } from '../PhoneOrdering';
import { PhoneApproveOrder } from '../PhoneApproveOrder';
import { useStore } from '../../../../../store/useStore';
import { usePaletteAction } from '../../../../../lib/paletteAction';
import { LightCmd } from '../../../../../theme/colors';

function todayIso(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

const DATE = todayIso();

function item(over: Record<string, any> = {}): any {
  return {
    itemId: 'a1', itemName: 'Wings', unit: 'lb',
    onHand: 0, pendingPoQty: 0, parLevel: 100, usageForecasted: 0, parReplacement: 0,
    suggestedQty: 30, costPerUnit: 3, estimatedCost: 60, caseQty: 6,
    suggestedCases: 5, suggestedUnits: 30, flags: [], ...over,
  };
}

/** A NO NEED row as `report_reorder_list` emits it (spec 172 hunk R4). */
function noNeedItem(flags: string[] = ['no_need']): any {
  return item({
    itemId: 'n1', itemName: 'Napkins', unit: 'pack',
    onHand: 37, parLevel: 20, suggestedQty: 0, estimatedCost: 0,
    caseQty: 1, suggestedCases: null, suggestedUnits: 0, needsOrder: false, flags,
  });
}

function vendorRow(items: any[]): any {
  return {
    vendorId: 'v-a', vendorName: 'US Foods', scheduleKnown: true,
    nextDeliveryDate: DATE, daysUntilNextDelivery: 1, onHandSource: 'eod',
    eodSubmittedAt: `${DATE}T02:00:00Z`, items, vendorTotalCost: 60,
  };
}

function everyDay(vendorIds: string[]) {
  const entries = vendorIds.map((id) => ({ vendorId: id, vendorName: id, deliveryDay: 'Monday' }));
  return { Monday: entries, Tuesday: entries, Wednesday: entries, Thursday: entries, Friday: entries, Saturday: entries, Sunday: entries };
}

function seed(items: any[], reorderEdits: Record<string, Record<string, number>> = {}) {
  useStore.setState({
    currentStore: { id: 'store-1', brandId: 'b', name: 'Frederick', address: '', status: 'active' } as any,
    stores: [{ id: 'store-1', name: 'Frederick' } as any],
    orderSchedule: everyDay(['v-a']) as any,
    reorderPayload: {
      asOfDate: DATE,
      vendors: [vendorRow(items)],
      kpis: { vendorCount: 1, itemCount: 1, totalEstimatedCost: 60, eodSourcedVendorCount: 1, stockFallbackVendorCount: 0 },
      warnings: [],
    } as any,
    reorderLoading: false,
    reorderError: null,
    reorderEdits,
    inventory: [{ id: 'a1', subUnitSize: 1 } as any, { id: 'n1', subUnitSize: 1 } as any],
    vendors: [{ id: 'v-a', extensionOrdering: true, orderUnit: 'case' } as any],
    lastOrderContext: null,
    locale: 'en',
    darkMode: false,
    // Approve-screen slices (the deep link is pre-resolved; this suite drives
    // the RENDER, exactly as PhoneApproveOrder.test.tsx does).
    approvalContext: { submissionId: 'sub-1', storeId: 'store-1', vendorId: 'v-a', businessDate: DATE },
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
  } as any);
}

/** AC-18 — the SAME assertions run through both consumers of VendorOrderCard. */
const SURFACES: Array<[string, () => React.ReactElement]> = [
  ['PhoneOrdering (spec 143)', () => <PhoneOrdering />],
  ['PhoneApproveOrder (spec 149)', () => <PhoneApproveOrder request={{ submissionId: 'sub-1', storeId: 'store-1' }} />],
];

/** The manager stepped the NO NEED row up to 4 (base units). */
const EDITED = { 'v-a': { n1: 4 } };

const CARD_STATS = /LINES · .* CS · EST/;

beforeEach(() => {
  jest.clearAllMocks();
  usePaletteAction.setState({ pending: null });
});

describe.each(SURFACES)('NO NEED tag on %s', (_label, screen) => {
  it('AC-14 — an edited NO NEED line renders the tag, under the name, inside the line', () => {
    seed([item(), noNeedItem()], EDITED);
    const { getByTestId } = render(screen());
    const line = getByTestId('phone-order-line-n1');
    const tag = within(line).getByTestId('phone-order-noneed-n1');
    expect(tag).toHaveTextContent('NO NEED');
  });

  it('AC-17 — an UNEDITED NO NEED row renders neither its line nor the tag', () => {
    seed([item(), noNeedItem()]);
    const { queryByTestId, getByTestId } = render(screen());
    expect(queryByTestId('phone-order-line-n1')).toBeNull();
    expect(queryByTestId('phone-order-noneed-n1')).toBeNull();
    // The rest of the card is unaffected.
    expect(getByTestId('phone-order-line-a1')).toBeTruthy();
  });

  it('AC-16 — a non-flagged edited line renders no NO NEED tag', () => {
    seed([item(), noNeedItem([])], { 'v-a': { a1: 36, n1: 4 } });
    const { getByTestId, queryAllByTestId } = render(screen());
    expect(getByTestId('phone-order-line-a1')).toBeTruthy();
    expect(getByTestId('phone-order-line-n1')).toBeTruthy();
    expect(queryAllByTestId(/^phone-order-noneed-/)).toHaveLength(0);
  });

  it('AC-16 — only the NO NEED line is tagged when both lines are shown', () => {
    seed([item(), noNeedItem()], { 'v-a': { a1: 36, n1: 4 } });
    const { queryAllByTestId, getByTestId } = render(screen());
    expect(queryAllByTestId(/^phone-order-noneed-/)).toHaveLength(1);
    expect(within(getByTestId('phone-order-line-a1')).queryByTestId(/^phone-order-noneed-/)).toBeNull();
  });

  it('AC-17 — the card stats line is identical with the flag on and off', () => {
    seed([item(), noNeedItem()], EDITED);
    const on = render(screen());
    const statsOn = on.getAllByText(CARD_STATS).map((n) => n.props.children);
    on.unmount();
    seed([item(), noNeedItem([])], EDITED);
    const off = render(screen());
    const statsOff = off.getAllByText(CARD_STATS).map((n) => n.props.children);
    expect(statsOn.length).toBeGreaterThan(0);
    expect(statsOn).toEqual(statsOff);
  });

  it('AC-14 — the tag is localized through the active locale (es)', () => {
    seed([item(), noNeedItem()], EDITED);
    useStore.setState({ locale: 'es' } as any);
    const { getByTestId } = render(screen());
    expect(getByTestId('phone-order-noneed-n1')).toHaveTextContent('NO HACE FALTA');
  });

  it('AC-15 — fg3 flag-pill styling via theme tokens; non-interactive; the name keeps 1-line truncation', () => {
    seed([item(), noNeedItem()], EDITED);
    const { getByTestId } = render(screen());
    const tag = getByTestId('phone-order-noneed-n1');
    const style = StyleSheet.flatten(tag.props.style);
    expect(style.borderColor).toBe(LightCmd.border);
    expect(style.backgroundColor).toBe('transparent');
    expect(style.borderRadius).toBe(999);
    expect(tag.props.onPress).toBeUndefined();
    expect(tag.props.accessibilityRole).toBeUndefined();
    const label = within(tag).getByText('NO NEED');
    expect(StyleSheet.flatten(label.props.style).color).toBe(LightCmd.fg3);
    const name = within(getByTestId('phone-order-line-n1')).getByText('Napkins');
    expect(name.props.numberOfLines).toBe(1);
  });
});
