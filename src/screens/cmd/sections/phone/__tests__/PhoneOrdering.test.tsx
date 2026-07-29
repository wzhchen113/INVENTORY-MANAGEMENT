// src/screens/cmd/sections/phone/__tests__/PhoneOrdering.test.tsx
//
// Spec (2026-07) phone Ordering — card rendering, the case-stepper write-through
// (setReorderEditQty base units), the spec-130 count-not-submitted violet state
// + its EOD deep-link, and the overflow action sheet. Uses the REAL store slices
// (useStore.setState) + real reorderDayFilter / poCaseDisplay / applyReorderEdits
// so the derived quantities and partition match production.

import React from 'react';
import { render, fireEvent } from '@testing-library/react-native';

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

// The sheet (ResponsiveSheet) reads the breakpoint — force phone.
jest.mock('../../../../../theme/breakpoints', () => {
  const actual = jest.requireActual('../../../../../theme/breakpoints');
  return { ...actual, useIsPhone: () => true, useIsTablet: () => false, useIsDesktop: () => false, useIsCompact: () => true, useBreakpoint: () => 'phone' };
});

import { PhoneOrdering } from '../PhoneOrdering';
import { useStore } from '../../../../../store/useStore';
import { usePaletteAction } from '../../../../../lib/paletteAction';

function todayIso(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function item(over: Record<string, any>): any {
  return {
    itemId: over.itemId, itemName: over.itemName ?? over.itemId, unit: over.unit ?? 'lbs',
    onHand: 0, pendingPoQty: 0, parLevel: 100, usageForecasted: 0, parReplacement: 0,
    suggestedQty: over.suggestedUnits ?? 20, costPerUnit: over.costPerUnit ?? 3,
    estimatedCost: over.estimatedCost ?? 60, caseQty: over.caseQty ?? 5,
    suggestedCases: over.suggestedCases ?? 4, suggestedUnits: over.suggestedUnits ?? 20,
    flags: [], ...over,
  };
}

function vendor(over: Record<string, any>): any {
  return {
    vendorId: over.vendorId, vendorName: over.vendorName, scheduleKnown: true,
    nextDeliveryDate: todayIso(), daysUntilNextDelivery: 1,
    onHandSource: over.onHandSource ?? 'eod', eodSubmittedAt: over.eodSubmittedAt ?? null,
    items: over.items ?? [], vendorTotalCost: over.vendorTotalCost ?? 0,
  };
}

function everyDay(vendorIds: string[]) {
  const entries = vendorIds.map((id) => ({ vendorId: id, vendorName: id, deliveryDay: 'Monday' }));
  return { Monday: entries, Tuesday: entries, Wednesday: entries, Thursday: entries, Friday: entries, Saturday: entries, Sunday: entries };
}

const counted = vendor({
  vendorId: 'v-a', vendorName: 'Counted Co', onHandSource: 'eod', eodSubmittedAt: `${todayIso()}T18:00:00Z`,
  items: [item({ itemId: 'a1', itemName: 'French Fries', caseQty: 5, suggestedUnits: 20, estimatedCost: 60, costPerUnit: 3 })],
  vendorTotalCost: 60,
});
const notSubmitted = vendor({
  vendorId: 'v-b', vendorName: 'Uncounted Co', onHandSource: 'stock', eodSubmittedAt: null,
  items: [item({ itemId: 'b1', itemName: 'Ranch', caseQty: 4, suggestedUnits: 8 })],
  vendorTotalCost: 40,
});

function seed() {
  useStore.setState({
    currentStore: { id: 'store-1', brandId: 'b', name: 'F', address: '', status: 'active' } as any,
    orderSchedule: everyDay(['v-a', 'v-b']) as any,
    reorderPayload: {
      asOfDate: todayIso(),
      vendors: [counted, notSubmitted],
      kpis: { vendorCount: 2, itemCount: 2, totalEstimatedCost: 100, eodSourcedVendorCount: 1, stockFallbackVendorCount: 1 },
      warnings: [],
    } as any,
    reorderLoading: false,
    reorderError: null,
    reorderEdits: {},
    vendors: [
      { id: 'v-a', extensionOrdering: true, orderUnit: 'case' } as any,
      { id: 'v-b', extensionOrdering: false, orderUnit: 'case' } as any,
    ],
    inventory: [
      { id: 'a1', subUnitSize: 1 } as any,
      { id: 'b1', subUnitSize: 1 } as any,
    ],
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  usePaletteAction.getState().consume();
  seed();
});

describe('PhoneOrdering — spec (2026-07)', () => {
  it('renders a card per primary vendor with the full name and KPI line', () => {
    const { getByText, getByTestId } = render(<PhoneOrdering />);
    expect(getByText('Counted Co')).toBeTruthy();
    expect(getByText('Uncounted Co')).toBeTruthy();
    // KPI counts only the counted (active) vendor + its one line.
    expect(getByTestId('phone-order-kpi')).toHaveTextContent('1 VENDORS · 1 LINES · est $60.00');
  });

  it('the case stepper writes the BASE-unit qty through setReorderEditQty (clamped ≥0)', () => {
    const { getByTestId } = render(<PhoneOrdering />);
    // French Fries: caseQty 5, suggestedUnits 20 → 4 cases. +1 → 5 cases → base 25.
    fireEvent.press(getByTestId('phone-order-step-a1-inc'));
    expect(useStore.getState().reorderEdits['v-a']?.a1).toBe(25);
    // − four times from 4 cases clamps at 0 (base 0), never negative.
    for (let i = 0; i < 6; i++) fireEvent.press(getByTestId('phone-order-step-a1-dec'));
    expect(useStore.getState().reorderEdits['v-a']?.a1).toBe(0);
  });

  it('renders the spec-130 violet count-not-submitted state and deep-links to EOD', () => {
    const { getByTestId, queryByTestId } = render(<PhoneOrdering />);
    expect(getByTestId('phone-order-not-submitted-v-b')).toBeTruthy();
    // The not-submitted card has no stepper / footer primary.
    expect(queryByTestId('phone-order-step-b1-inc')).toBeNull();
    expect(queryByTestId('phone-order-fill-cart-v-b')).toBeNull();
    fireEvent.press(getByTestId('phone-order-go-count-v-b'));
    const pending = usePaletteAction.getState().pending;
    expect(pending?.section).toBe('EODCount');
    expect(pending?.eodFocusItemId).toBe('b1');
  });

  it('extension vendor shows FILL CART; non-extension is not rendered here (violet)', () => {
    const { getByTestId } = render(<PhoneOrdering />);
    expect(getByTestId('phone-order-fill-cart-v-a')).toBeTruthy();
  });

  it('the ··· overflow opens an action sheet with the four export/tool actions', () => {
    const { getByTestId, queryByTestId } = render(<PhoneOrdering />);
    expect(queryByTestId('phone-order-sheet-quick')).toBeNull();
    fireEvent.press(getByTestId('phone-order-more-v-a'));
    expect(getByTestId('phone-order-sheet-quick')).toBeTruthy();
    expect(getByTestId('phone-order-sheet-csv')).toBeTruthy();
    expect(getByTestId('phone-order-sheet-pdf')).toBeTruthy();
    expect(getByTestId('phone-order-sheet-schedule')).toBeTruthy();
    // ORDER SCHEDULE is desktop-first → honest toast + close.
    fireEvent.press(getByTestId('phone-order-sheet-schedule'));
    expect(queryByTestId('phone-order-sheet-quick')).toBeNull();
  });
});
