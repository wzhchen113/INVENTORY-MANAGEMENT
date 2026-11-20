// src/screens/cmd/sections/phone/__tests__/PhoneOrdering.datePicker.test.tsx
//
// Phone Ordering — the "FOR <date> ▾" chip opens the shared ReorderDatePicker
// so a phone user can step back to earlier dates' EOD-based orders. It used to
// only toast "Change the reorder date on desktop".
//
// Two layers:
//   1. PhoneOrdering standalone — chip opens the calendar, a past day reports
//      up through `onDateChange`, future days stay disabled, no toast.
//   2. ReorderSection at the phone tier — the pick reaches the parent's fetch
//      effect, so `loadReorderSuggestions` re-runs for the picked date.
// Harness mirrors PhoneOrdering.test.tsx (real store, db/supabase stubbed).

import React from 'react';
import { render, fireEvent, act } from '@testing-library/react-native';
import Toast from 'react-native-toast-message';

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
import ReorderSection from '../../ReorderSection';
import { useStore } from '../../../../../store/useStore';
import { usePaletteAction } from '../../../../../lib/paletteAction';

const pad = (n: number) => String(n).padStart(2, '0');
function isoOf(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function seed(asOfDate: string) {
  useStore.setState({
    currentStore: { id: 'store-1', brandId: 'b', name: 'F', address: '', status: 'active' } as any,
    orderSchedule: {} as any,
    reorderPayload: {
      asOfDate,
      vendors: [],
      kpis: { vendorCount: 0, itemCount: 0, totalEstimatedCost: 0, eodSourcedVendorCount: 0, stockFallbackVendorCount: 0 },
      warnings: [],
    } as any,
    reorderLoading: false,
    reorderError: null,
    reorderEdits: {},
    vendors: [],
    inventory: [],
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  usePaletteAction.getState().consume();
});

describe('PhoneOrdering — reorder date chip', () => {
  const selected = '2026-11-12';
  const max = '2026-11-19';

  beforeEach(() => seed(selected));

  it('tapping the chip opens the calendar instead of the desktop-only toast', () => {
    const { getByTestId, getByText, queryByTestId } = render(
      <PhoneOrdering selectedDate={selected} onDateChange={jest.fn()} maxDate={max} activeWeekdays={new Set()} />,
    );
    expect(getByText(/NOV 12/)).toBeTruthy();
    expect(queryByTestId('phone-order-datepicker-prev-month')).toBeNull();

    fireEvent.press(getByTestId('phone-order-date-chip'));

    expect(getByTestId('phone-order-datepicker-prev-month')).toBeTruthy();
    expect(Toast.show).not.toHaveBeenCalled();
  });

  it('picking an earlier day reports it through onDateChange', () => {
    const onDateChange = jest.fn();
    const { getByTestId } = render(
      <PhoneOrdering selectedDate={selected} onDateChange={onDateChange} maxDate={max} activeWeekdays={new Set()} />,
    );
    fireEvent.press(getByTestId('phone-order-date-chip'));
    fireEvent.press(getByTestId('phone-order-datepicker-day-5'));
    expect(onDateChange).toHaveBeenCalledWith('2026-11-05');

    // Previous month works too (going back is the point of the fix).
    fireEvent.press(getByTestId('phone-order-date-chip'));
    fireEvent.press(getByTestId('phone-order-datepicker-prev-month'));
    fireEvent.press(getByTestId('phone-order-datepicker-day-30'));
    expect(onDateChange).toHaveBeenLastCalledWith('2026-10-30');
  });

  it('days after maxDate stay unselectable', () => {
    const onDateChange = jest.fn();
    const { getByTestId } = render(
      <PhoneOrdering selectedDate={selected} onDateChange={onDateChange} maxDate={max} activeWeekdays={new Set()} />,
    );
    fireEvent.press(getByTestId('phone-order-date-chip'));
    fireEvent.press(getByTestId('phone-order-datepicker-day-20'));
    expect(onDateChange).not.toHaveBeenCalled();
  });

  it('without onDateChange the chip is display-only (no toast, no calendar)', () => {
    const { getByTestId, queryByTestId } = render(<PhoneOrdering />);
    fireEvent.press(getByTestId('phone-order-date-chip'));
    expect(queryByTestId('phone-order-datepicker-prev-month')).toBeNull();
    expect(Toast.show).not.toHaveBeenCalled();
  });
});

describe('ReorderSection (phone tier) — date pick reloads suggestions', () => {
  it('re-runs loadReorderSuggestions for the picked date', () => {
    const today = isoOf(new Date());
    seed(today);
    const loadReorderSuggestions = jest.fn();
    useStore.setState({ loadReorderSuggestions } as any);

    const { getByTestId } = render(<ReorderSection />);
    expect(loadReorderSuggestions).toHaveBeenLastCalledWith(today);

    // Day 1 of the previous month is always in the past.
    const now = new Date();
    const firstOfPrev = isoOf(new Date(now.getFullYear(), now.getMonth() - 1, 1));
    fireEvent.press(getByTestId('phone-order-date-chip'));
    fireEvent.press(getByTestId('phone-order-datepicker-prev-month'));
    act(() => {
      fireEvent.press(getByTestId('phone-order-datepicker-day-1'));
    });

    expect(loadReorderSuggestions).toHaveBeenLastCalledWith(firstOfPrev);
  });
});
