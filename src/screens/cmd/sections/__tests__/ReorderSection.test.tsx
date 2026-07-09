// src/screens/cmd/sections/__tests__/ReorderSection.test.tsx — Spec 087.
//
// Section-level interaction tests for the Reorder calendar wiring (test
// contract #3, the integration seam) plus the guard / empty-state
// branches that the pure-util tests can't reach because they're render
// decisions. Browser verification of the live golden path is covered
// out-of-band; these lock the seam so a future refactor can't silently
// drop the date→fetch wiring or the day-filter empty state.
//
// Boundary mocking mirrors VendorsSection.test.tsx: mock useCmdColors,
// useT (key-echoing with {var} interpolation), and useStore (fixed
// snapshot with a configurable `loadReorderSuggestions` spy). TabStrip is
// stubbed to render its `rightSlot` so the date picker is reachable.

jest.mock('../../../../theme/colors', () => ({
  useCmdColors: () => ({
    bg: '#FFFFFF', panel: '#F4F4F4', panel2: '#EAEAEA',
    border: '#CCCCCC', borderStrong: '#888888',
    fg: '#000000', fg2: '#444444', fg3: '#888888',
    accent: '#3F7C20', accentBg: '#E0EFC9', accentFg: '#FFFFFF',
    warn: '#854F0B', warnBg: '#FAEEDA',
    danger: '#791F1F', dangerBg: '#FCEBEB',
    ok: '#3B6D11', okBg: '#EAF3DE',
    info: '#185FA5', infoBg: '#E6F1FB',
  }),
  CmdRadius: { xs: 3, sm: 4, md: 5, lg: 6 },
}));

jest.mock('../../../../hooks/useT', () => ({
  useT: () => (key: string, vars?: Record<string, string | number>) => {
    if (!vars) return key;
    return Object.entries(vars).reduce(
      (acc, [k, v]) => acc.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v)),
      key,
    );
  },
}));

// TabStrip — render the rightSlot so the date-picker trigger is reachable.
jest.mock('../../../../components/cmd/TabStrip', () => {
  const ReactMod = require('react');
  const RN = require('react-native');
  return {
    TabStrip: ({ rightSlot }: { rightSlot?: React.ReactNode }) =>
      ReactMod.createElement(RN.View, { testID: 'tabstrip' }, rightSlot),
  };
});
jest.mock('../../../../components/cmd/StatCard', () => ({
  StatCard: () => null,
}));

jest.mock('../../../../store/useStore', () => {
  const state: any = {
    currentStore: { id: 'store-1', name: 'Test Store' },
    orderSchedule: {
      Monday: [{ vendorId: 'v-mon', vendorName: 'Mon Co', deliveryDay: 'Wednesday' }],
      Tuesday: [], Wednesday: [], Thursday: [], Friday: [], Saturday: [], Sunday: [],
    },
    reorderPayload: null,
    reorderLoading: false,
    reorderError: null,
    loadReorderSuggestions: jest.fn(),
  };
  const fn: any = jest.fn((selector: (s: any) => any) => selector(state));
  fn.getState = () => state;
  fn.__state = state;
  return { useStore: fn };
});

import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react-native';
import { toISODate } from '../../../../utils/reportDates';
import ReorderSection from '../ReorderSection';
import { useStore } from '../../../../store/useStore';

const mockState = (useStore as any).__state as Record<string, any>;

// A vendor shaped like the report payload.
function vendor(over: Record<string, any> & { vendorId: string }) {
  return {
    vendorId: over.vendorId,
    vendorName: over.vendorName ?? over.vendorId,
    scheduleKnown: over.scheduleKnown ?? true,
    nextDeliveryDate: '2026-06-02',
    daysUntilNextDelivery: 1,
    onHandSource: over.onHandSource ?? 'eod',
    eodSubmittedAt: null,
    items: over.items ?? [],
    vendorTotalCost: over.vendorTotalCost ?? 0,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  // Reset to defaults each test.
  mockState.currentStore = { id: 'store-1', name: 'Test Store' };
  mockState.orderSchedule = {
    Monday: [{ vendorId: 'v-mon', vendorName: 'Mon Co', deliveryDay: 'Wednesday' }],
    Tuesday: [], Wednesday: [], Thursday: [], Friday: [], Saturday: [], Sunday: [],
  };
  mockState.reorderPayload = null;
  mockState.reorderLoading = false;
  mockState.reorderError = null;
  mockState.loadReorderSuggestions = jest.fn();
});

describe('ReorderSection wiring', () => {
  it('fetches with today as as_of_date on mount', () => {
    render(<ReorderSection />);
    const today = toISODate(new Date());
    expect(mockState.loadReorderSuggestions).toHaveBeenCalledWith(today);
  });

  it('re-fetches with the picked date when the calendar date changes', () => {
    render(<ReorderSection />);
    mockState.loadReorderSuggestions.mockClear();

    // Open the picker and select a known past date. Navigate back enough
    // months that the chosen day is guaranteed in the past regardless of
    // "today": go back 2 months, then pick the 1st.
    fireEvent.press(screen.getByTestId('reorder-datepicker-trigger'));
    fireEvent.press(screen.getByTestId('reorder-datepicker-prev-month'));
    fireEvent.press(screen.getByTestId('reorder-datepicker-prev-month'));
    fireEvent.press(screen.getByTestId('reorder-datepicker-day-1'));

    // The effect re-fires with the newly-selected ISO date.
    expect(mockState.loadReorderSuggestions).toHaveBeenCalledTimes(1);
    const calledWith = mockState.loadReorderSuggestions.mock.calls[0][0] as string;
    expect(calledWith).toMatch(/^\d{4}-\d{2}-01$/);
    expect(calledWith < toISODate(new Date())).toBe(true);
  });

  it('renders the no-focal-store empty state and does NOT fetch when currentStore.id is empty', () => {
    mockState.currentStore = { id: '', name: 'All Brands' };
    render(<ReorderSection />);
    expect(screen.getByTestId('reorder-no-store')).toBeTruthy();
    expect(screen.getByText('section.reorder.selectStore')).toBeTruthy();
    expect(mockState.loadReorderSuggestions).not.toHaveBeenCalled();
  });
});

describe('ReorderSection empty-state branches', () => {
  it('shows scheduled vendors regardless of order-out day (2026-07 week view)', () => {
    // The schedule is empty on EVERY weekday, but the payload vendor is
    // scheduleKnown=true. restrictToDay=false (week view) → it now renders in
    // the "Needs to Order" section regardless of its order-out day, rather
    // than being hidden by the old single-day filter.
    mockState.orderSchedule = {
      Monday: [], Tuesday: [], Wednesday: [], Thursday: [], Friday: [], Saturday: [], Sunday: [],
    };
    mockState.reorderPayload = {
      asOfDate: toISODate(new Date()),
      vendors: [
        vendor({
          vendorId: 'v-mon',
          items: [
            {
              itemId: 'i-1', itemName: 'Flour', unit: 'lb', onHand: 0, pendingPoQty: 0,
              parLevel: 10, usageForecasted: 0, parReplacement: 10, suggestedQty: 10,
              costPerUnit: 1, estimatedCost: 10, caseQty: 1, suggestedCases: null,
              suggestedUnits: 10, flags: [], needsOrder: true, otherVendorCount: 0,
              alsoFromVendors: [],
            },
          ],
        }),
      ],
      kpis: { vendorCount: 1, itemCount: 1, totalEstimatedCost: 10, eodSourcedVendorCount: 1, stockFallbackVendorCount: 0 },
      warnings: [],
    };

    render(<ReorderSection />);

    expect(screen.getByTestId('reorder-section-needs')).toBeTruthy();
    expect(screen.queryByTestId('reorder-empty-day')).toBeNull();
  });

  it('renders the secondary no-schedule group (collapsed) when scheduleKnown=false vendors exist', () => {
    mockState.reorderPayload = {
      asOfDate: toISODate(new Date()),
      vendors: [vendor({ vendorId: 'v-none', scheduleKnown: false })],
      kpis: { vendorCount: 1, itemCount: 0, totalEstimatedCost: 0, eodSourcedVendorCount: 1, stockFallbackVendorCount: 0 },
      warnings: [],
    };
    render(<ReorderSection />);
    // The toggle row is present; the vendor card is hidden until expanded.
    const toggle = screen.getByTestId('reorder-no-schedule-toggle');
    expect(toggle).toBeTruthy();
    expect(toggle.props.accessibilityState?.expanded).toBe(false);
  });
});
