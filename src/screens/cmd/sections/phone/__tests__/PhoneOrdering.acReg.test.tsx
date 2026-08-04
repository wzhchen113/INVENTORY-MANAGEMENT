// src/screens/cmd/sections/phone/__tests__/PhoneOrdering.acReg.test.tsx
//
// Spec (2026-07) AC-REG — the phone Ordering guard is the sole behavioral fork.
// With isPhone false (desktop AND tablet) ReorderSection renders its desktop
// tree (the `reorder.tsx` TabStrip tab) and NOT the phone component; with
// isPhone true only the phone component renders. Mirrors
// PhoneSections.acReg.test.tsx.

import React from 'react';
import { render, fireEvent } from '@testing-library/react-native';

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

let mockTier: 'phone' | 'tablet' | 'desktop' = 'desktop';
jest.mock('../../../../../theme/breakpoints', () => {
  const actual = jest.requireActual('../../../../../theme/breakpoints');
  return {
    ...actual,
    useIsPhone: () => mockTier === 'phone',
    useIsTablet: () => mockTier === 'tablet',
    useIsDesktop: () => mockTier === 'desktop',
    useIsCompact: () => mockTier !== 'desktop',
    useBreakpoint: () => mockTier,
  };
});

import ReorderSection from '../../ReorderSection';
import { useStore } from '../../../../../store/useStore';
import { toISODate } from '../../../../../utils/reportDates';

function seed() {
  useStore.setState({
    currentStore: { id: 'store-1', brandId: 'b', name: 'F', address: '', status: 'active' } as any,
    currentUser: { id: 'user-1', name: 'Admin', email: 'a@b.c', role: 'admin' } as any,
    stores: [{ id: 'store-1', name: 'F' } as any],
    orderSchedule: undefined,
    reorderPayload: null,
    reorderLoading: false,
    reorderError: null,
    reorderEdits: {},
    vendors: [],
    inventory: [],
    loadReorderSuggestions: (async () => {}) as any,
  });
}

beforeEach(() => { jest.clearAllMocks(); seed(); });

describe('Reorder / Ordering — AC-REG', () => {
  it('desktop renders the desktop tree, not the phone component', () => {
    mockTier = 'desktop';
    const { queryByTestId, queryByText } = render(<ReorderSection />);
    expect(queryByTestId('phone-ordering')).toBeNull();
    expect(queryByText('reorder.tsx')).toBeTruthy();
  });

  it('tablet also stays on the desktop tree', () => {
    mockTier = 'tablet';
    const { queryByTestId, queryByText } = render(<ReorderSection />);
    expect(queryByTestId('phone-ordering')).toBeNull();
    expect(queryByText('reorder.tsx')).toBeTruthy();
  });

  it('phone renders the phone Ordering component and no desktop tab strip', () => {
    mockTier = 'phone';
    const { getByTestId, queryByText } = render(<ReorderSection />);
    expect(getByTestId('phone-ordering')).toBeTruthy();
    expect(queryByText('reorder.tsx')).toBeNull();
  });

  // Spec 151 (AC-REG-3) — the last-order context line is additive on BOTH
  // trees, and it must not leak across the fork: the phone tree renders the
  // phone line only, the desktop tree the desktop line only. The context is
  // fetched by the effect ABOVE the guard, so both tiers are hydrated by the
  // same call — this pins that the RENDER still respects the fork.
  it('the last-order context line lands on the tier that is actually rendering', () => {
    const withContext = () =>
      useStore.setState({
        orderSchedule: {
          Monday: [{ vendorId: 'v-a', vendorName: 'US Foods', deliveryDay: 'Monday' }],
          Tuesday: [{ vendorId: 'v-a', vendorName: 'US Foods', deliveryDay: 'Tuesday' }],
          Wednesday: [{ vendorId: 'v-a', vendorName: 'US Foods', deliveryDay: 'Wednesday' }],
          Thursday: [{ vendorId: 'v-a', vendorName: 'US Foods', deliveryDay: 'Thursday' }],
          Friday: [{ vendorId: 'v-a', vendorName: 'US Foods', deliveryDay: 'Friday' }],
          Saturday: [{ vendorId: 'v-a', vendorName: 'US Foods', deliveryDay: 'Saturday' }],
          Sunday: [{ vendorId: 'v-a', vendorName: 'US Foods', deliveryDay: 'Sunday' }],
        } as any,
        reorderPayload: {
          asOfDate: toISODate(new Date()),
          vendors: [{
            vendorId: 'v-a', vendorName: 'US Foods', scheduleKnown: true,
            nextDeliveryDate: toISODate(new Date()), daysUntilNextDelivery: 1,
            onHandSource: 'eod', eodSubmittedAt: `${toISODate(new Date())}T18:00:00Z`,
            vendorTotalCost: 90,
            items: [{
              itemId: 'i-1', itemName: 'Wings', unit: 'lb', onHand: 0, pendingPoQty: 0,
              parLevel: 100, usageForecasted: 0, parReplacement: 0, suggestedQty: 30,
              costPerUnit: 3, estimatedCost: 90, caseQty: 6, suggestedCases: 5,
              suggestedUnits: 30, flags: [],
            }],
          }],
          kpis: { vendorCount: 1, itemCount: 1, totalEstimatedCost: 90, eodSourcedVendorCount: 1, stockFallbackVendorCount: 0 },
          warnings: [],
        } as any,
        inventory: [{ id: 'i-1', subUnitSize: 1 } as any],
        lastOrderContext: {
          'v-a': {
            vendorId: 'v-a', lastOrderDate: '2026-07-29', confidence: 'placed',
            source: 'purchase_order', sourceId: 'po-1', countedDate: '2026-07-29',
            itemsTruncated: false,
            items: { 'i-1': { itemId: 'i-1', orderedQtyBase: 78, countedQtyBase: 30 } },
          },
        },
        loadLastOrderContext: (async () => {}) as any,
      });

    mockTier = 'phone';
    withContext();
    const phone = render(<ReorderSection />);
    expect(phone.getByTestId('phone-order-last-order-i-1')).toBeTruthy();
    expect(phone.queryByTestId('reorder-last-order-i-1')).toBeNull();
    phone.unmount();

    mockTier = 'desktop';
    withContext();
    const desktop = render(<ReorderSection />);
    desktop.getAllByTestId(/^reorder-vendor-toggle-/).forEach((t) => fireEvent.press(t));
    expect(desktop.getByTestId('reorder-last-order-i-1')).toBeTruthy();
    expect(desktop.queryByTestId('phone-order-last-order-i-1')).toBeNull();
  });
});
