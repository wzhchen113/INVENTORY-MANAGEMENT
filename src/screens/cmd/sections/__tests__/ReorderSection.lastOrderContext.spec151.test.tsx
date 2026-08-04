// src/screens/cmd/sections/__tests__/ReorderSection.lastOrderContext.spec151.test.tsx
//
// Spec 151 (AC-15, §7.1, §7.3) — the DESKTOP tier of the last-order context.
//
// Covers:
//   • the §7.1 fetch effect: ONE call for ALL visible vendors, keyed on the
//     DERIVED id string (a payload swap with identical ids must NOT refetch)
//     and carrying the reorder payload's own as-of date (AC-23);
//   • the desktop item-row context line + the card-level AC-9 empty line,
//     which is asserted on the COLLAPSED first paint (desktop cards default
//     collapsed, so the empty state has to be glanceable without an expand);
//   • R-G's 'hidden' state (AC-17): with the context null the desktop card
//     renders exactly as it does today;
//   • AC-REG-2: the suggested quantity / est-$ / ORDER input are untouched.
//
// Uses the REAL store, the REAL i18n catalog and the REAL pure formatter, so
// the assertions are the production strings. Only supabase/db are stubbed.

import React from 'react';
import { render, fireEvent } from '@testing-library/react-native';

jest.mock('react-native/Libraries/Utilities/Platform', () => ({
  __esModule: true,
  default: { OS: 'web', select: (obj: any) => obj.web ?? obj.default },
  OS: 'web',
}));

jest.mock('react-native-toast-message', () => ({
  __esModule: true,
  default: { show: jest.fn(), hide: jest.fn() },
}));

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, left: 0, right: 0, bottom: 0 }),
}));

jest.mock('../../../../lib/supabase', () => ({
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

jest.mock('../../../../lib/db', () =>
  new Proxy({ __esModule: true }, { get: (t: Record<string, unknown>, p: string) => (p in t ? (t as any)[p] : jest.fn(() => Promise.resolve(null))) }),
);

// AC-REG-3 — force the DESKTOP tier so the section renders its desktop tree.
jest.mock('../../../../theme/breakpoints', () => {
  const actual = jest.requireActual('../../../../theme/breakpoints');
  return { ...actual, useIsPhone: () => false, useIsTablet: () => false, useIsDesktop: () => true, useIsCompact: () => false, useBreakpoint: () => 'desktop' };
});

import ReorderSection from '../ReorderSection';
import { useStore } from '../../../../store/useStore';
import { toISODate } from '../../../../utils/reportDates';
import type { LastOrderContext, ReorderItem, ReorderVendor } from '../../../../types';

const TODAY = toISODate(new Date());

function item(over: Partial<ReorderItem> = {}): ReorderItem {
  return {
    itemId: 'i-1', itemName: 'Wings', unit: 'lb',
    onHand: 0, pendingPoQty: 0, parLevel: 100, usageForecasted: 0, parReplacement: 0,
    suggestedQty: 30, costPerUnit: 3, estimatedCost: 90,
    caseQty: 6, suggestedCases: 5, suggestedUnits: 30, flags: [],
    ...over,
  };
}

function vendorRow(over: Partial<ReorderVendor> = {}): ReorderVendor {
  return {
    vendorId: 'v-a', vendorName: 'US Foods', scheduleKnown: true,
    nextDeliveryDate: TODAY, daysUntilNextDelivery: 1, onHandSource: 'eod',
    eodSubmittedAt: `${TODAY}T18:00:00Z`, items: [item()], vendorTotalCost: 90,
    ...over,
  };
}

function everyDay(vendorIds: string[]) {
  const entries = vendorIds.map((id) => ({ vendorId: id, vendorName: id, deliveryDay: 'Monday' }));
  return { Monday: entries, Tuesday: entries, Wednesday: entries, Thursday: entries, Friday: entries, Saturday: entries, Sunday: entries };
}

const CONTEXT: LastOrderContext = {
  'v-a': {
    vendorId: 'v-a',
    lastOrderDate: '2026-07-29',
    confidence: 'placed',
    source: 'purchase_order',
    sourceId: 'po-1',
    countedDate: '2026-07-29',
    itemsTruncated: false,
    items: { 'i-1': { itemId: 'i-1', orderedQtyBase: 78, countedQtyBase: 30 } },
  },
};

const loadLastOrderContext = jest.fn(async (_vendorIds: string[], _asOfDate?: string) => {});

function seed(over: Record<string, any> = {}) {
  useStore.setState({
    locale: 'en',
    currentStore: { id: 'store-1', brandId: 'b', name: 'Frederick', address: '', status: 'active' } as any,
    currentUser: { id: 'user-1', name: 'Admin', email: 'a@b.c', role: 'admin' } as any,
    stores: [{ id: 'store-1', name: 'Frederick' } as any],
    orderSchedule: everyDay(['v-a']) as any,
    reorderPayload: {
      asOfDate: TODAY,
      vendors: [vendorRow()],
      kpis: { vendorCount: 1, itemCount: 1, totalEstimatedCost: 90, eodSourcedVendorCount: 1, stockFallbackVendorCount: 0 },
      warnings: [],
    } as any,
    reorderLoading: false,
    reorderError: null,
    reorderEdits: {},
    inventory: [{ id: 'i-1', subUnitSize: 1 } as any],
    vendors: [{ id: 'v-a', extensionOrdering: false, orderUnit: 'case' } as any],
    lastOrderContext: null,
    loadReorderSuggestions: (async () => {}) as any,
    loadLastOrderContext: loadLastOrderContext as any,
    ...over,
  } as any);
}

/** Desktop cards open COLLAPSED (spec 135) — expand to reach the item rows. */
function expandAll(getAllByTestId: (m: RegExp) => any[]) {
  getAllByTestId(/^reorder-vendor-toggle-/).forEach((t) => fireEvent.press(t));
}

beforeAll(() => {
  (global as any).Blob = class {};
  const w = (global as any).window ?? ((global as any).window = {});
  w.URL = { createObjectURL: () => 'blob:x', revokeObjectURL: () => {} };
});

beforeEach(() => {
  jest.clearAllMocks();
  seed();
});

describe('§7.1 — the fetch effect (ONE call, above the isPhone guard)', () => {
  it('fires once with every visible vendor id and the payload as-of date', () => {
    render(<ReorderSection />);
    expect(loadLastOrderContext).toHaveBeenCalledTimes(1);
    expect(loadLastOrderContext).toHaveBeenCalledWith(['v-a'], TODAY);
  });

  it('AC-23 — ONE call for MANY vendors, never one per vendor', () => {
    seed({
      orderSchedule: everyDay(['v-a', 'v-b', 'v-c']) as any,
      reorderPayload: {
        asOfDate: TODAY,
        vendors: [
          vendorRow(),
          vendorRow({ vendorId: 'v-b', vendorName: 'Sysco' }),
          vendorRow({ vendorId: 'v-c', vendorName: 'BJs' }),
        ],
        kpis: { vendorCount: 3, itemCount: 3, totalEstimatedCost: 270, eodSourcedVendorCount: 3, stockFallbackVendorCount: 0 },
        warnings: [],
      } as any,
    });
    render(<ReorderSection />);
    expect(loadLastOrderContext).toHaveBeenCalledTimes(1);
    expect(loadLastOrderContext.mock.calls[0][0]).toEqual(['v-a', 'v-b', 'v-c']);
  });

  it('does NOT refetch when the payload is replaced with identical vendor ids', () => {
    const { rerender } = render(<ReorderSection />);
    expect(loadLastOrderContext).toHaveBeenCalledTimes(1);
    // A fresh array object carrying the same ids. The derived string key is
    // unchanged, so no refetch. NOTE (architect review M-1): this is NOT the
    // full realtime-replay path — `loadFromSupabase` nulls `reorderPayload`
    // first, so a real replay keys '' in between and DOES refetch once. Pinned
    // here is the narrower claim the string key actually buys.
    useStore.setState({
      reorderPayload: {
        ...useStore.getState().reorderPayload!,
        vendors: [vendorRow()],
      } as any,
    });
    rerender(<ReorderSection />);
    expect(loadLastOrderContext).toHaveBeenCalledTimes(1);
  });

  it('does not fire when there is nothing to annotate', () => {
    seed({
      reorderPayload: {
        asOfDate: TODAY, vendors: [],
        kpis: { vendorCount: 0, itemCount: 0, totalEstimatedCost: 0, eodSourcedVendorCount: 0, stockFallbackVendorCount: 0 },
        warnings: [],
      } as any,
    });
    render(<ReorderSection />);
    expect(loadLastOrderContext).not.toHaveBeenCalled();
  });
});

describe('AC-15 — the desktop item-row context line', () => {
  it('renders below the breakdown with the composed sentence', () => {
    seed({ lastOrderContext: CONTEXT });
    const { getAllByTestId, getByTestId } = render(<ReorderSection />);
    expandAll(getAllByTestId);
    expect(getByTestId('reorder-last-order-i-1'))
      .toHaveTextContent(/LAST JUL 29 · COUNTED 5 CS · ORDERED 13 CS/);
  });

  it('AC-11 — carries the neutral trend marker', () => {
    seed({
      lastOrderContext: CONTEXT,
      reorderPayload: {
        asOfDate: TODAY,
        vendors: [vendorRow({ items: [item({ onHand: 48 })] })],
        kpis: { vendorCount: 1, itemCount: 1, totalEstimatedCost: 90, eodSourcedVendorCount: 1, stockFallbackVendorCount: 0 },
        warnings: [],
      } as any,
    });
    const { getAllByTestId, getByTestId } = render(<ReorderSection />);
    expandAll(getAllByTestId);
    expect(getByTestId('reorder-last-order-delta-i-1')).toHaveTextContent('▲ +3 CS');
  });

  it('AC-12 — suppresses the marker on a stock-fallback vendor', () => {
    seed({
      lastOrderContext: CONTEXT,
      reorderPayload: {
        asOfDate: TODAY,
        vendors: [vendorRow({ onHandSource: 'stock', items: [item({ onHand: 48 })] })],
        kpis: { vendorCount: 1, itemCount: 1, totalEstimatedCost: 90, eodSourcedVendorCount: 0, stockFallbackVendorCount: 1 },
        warnings: [],
      } as any,
    });
    const { getAllByTestId, getByTestId, queryByTestId } = render(<ReorderSection />);
    expandAll(getAllByTestId);
    expect(getByTestId('reorder-last-order-i-1')).toBeTruthy();
    expect(queryByTestId('reorder-last-order-delta-i-1')).toBeNull();
  });

  it('AC-9 — a loaded context with no anchor shows ONE card-level line, not per row', () => {
    // Deliberately NO expandAll(): desktop cards open COLLAPSED, so the
    // card-level empty state must be GLANCEABLE on first paint (AC-9 "stated
    // once", mirroring the phone tier's header placement). It lives in the
    // always-visible stats row, not in the collapse-gated footer.
    seed({ lastOrderContext: {} });
    const { getAllByTestId, getByTestId, queryByTestId, queryAllByText } = render(<ReorderSection />);
    expect(getByTestId('reorder-last-order-none-v-a'))
      .toHaveTextContent('NO PRIOR ORDER ON RECORD');
    // Structural: it sits in the always-visible stats row, NOT the footer
    // (which is inside the `!collapsed` guard). `getAllByTestId` because the
    // vendor may render under either the needs-order or the ok group.
    expect(getAllByTestId(/^reorder-vendor-stats-/)[0])
      .toHaveTextContent(/est cost: \$90\.00·NO PRIOR ORDER ON RECORD$/);
    // The collapse-gated body is genuinely still collapsed at this point.
    expect(queryByTestId('reorder-vendor-item-i-1')).toBeNull();
    // Still nothing per row (the rows are behind the collapse guard anyway).
    expect(queryByTestId('reorder-last-order-i-1')).toBeNull();
    expect(queryAllByText('NO PRIOR ORDER ON RECORD')).toHaveLength(1);
  });

  it('AC-9 — the card-level line stays a SINGLE line once the card is expanded', () => {
    seed({ lastOrderContext: {} });
    const { getAllByTestId, getByTestId, queryByTestId, queryAllByText } = render(<ReorderSection />);
    expandAll(getAllByTestId);
    expect(getByTestId('reorder-last-order-none-v-a')).toBeTruthy();
    expect(queryByTestId('reorder-last-order-i-1')).toBeNull();
    expect(queryAllByText('NO PRIOR ORDER ON RECORD')).toHaveLength(1);
  });

  it('R-G / AC-17 — a null context renders nothing at all', () => {
    seed({ lastOrderContext: null });
    const { getAllByTestId, queryByTestId } = render(<ReorderSection />);
    // Collapsed first paint: the card-level line must be absent here too, or
    // the load window would claim "no prior order on record".
    expect(queryByTestId('reorder-last-order-none-v-a')).toBeNull();
    expandAll(getAllByTestId);
    expect(queryByTestId('reorder-last-order-i-1')).toBeNull();
    expect(queryByTestId('reorder-last-order-none-v-a')).toBeNull();
    // The row itself is untouched.
    expect(queryByTestId('reorder-vendor-item-i-1')).not.toBeNull();
  });
});

describe('AC-REG — the shipped desktop row is unchanged', () => {
  it('keeps the ORDER input seeded from suggestedUnits with the context present', () => {
    seed({ lastOrderContext: CONTEXT });
    const { getAllByTestId, getByTestId } = render(<ReorderSection />);
    expandAll(getAllByTestId);
    // 30 base / caseQty 6 = 5 cases — the spec-134 display seed, untouched by
    // this spec (AC-REG-2: display-only, never nudges a quantity).
    expect(getByTestId('reorder-ordered-i-1').props.defaultValue).toBe('5');
  });

  it('AC-REG-3 — the DESKTOP tree renders the desktop line, never the phone one', () => {
    seed({ lastOrderContext: CONTEXT });
    const { getAllByTestId, getByTestId, queryByTestId } = render(<ReorderSection />);
    expandAll(getAllByTestId);
    expect(getByTestId('reorder-last-order-i-1')).toBeTruthy();
    expect(queryByTestId('phone-order-last-order-i-1')).toBeNull();
    expect(queryByTestId('phone-ordering')).toBeNull();
  });
});
