// src/screens/cmd/sections/phone/__tests__/PhoneApproveOrder.acReg.test.tsx
//
// Spec 149 AC-REG-1 / AC-REG-2 — the Approve Order screen is reached ONLY
// through ReorderSection's phone fork, and that fork is the sole behavioral
// change:
//   • desktop AND tablet render the unchanged desktop tree even when an
//     `orderApproval` payload is pending (there is no desktop Approve surface);
//   • phone with NO pending payload renders PhoneOrdering unchanged (AC-REG-1);
//   • phone WITH a pending payload renders PhoneApproveOrder;
//   • consuming the payload returns the phone to PhoneOrdering (both
//     directions pinned, per design §7.4).
//
// Sibling of PhoneOrdering.acReg.test.tsx — same mocking shape.

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
import { usePaletteAction } from '../../../../../lib/paletteAction';

const APPROVAL = { submissionId: 'sub-1', storeId: 'store-1' };

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
    submissionNotifications: [],
    approvalContext: null,
    approval: null,
    approvalLoading: false,
    approvalError: null,
    approvalBusy: false,
    loadReorderSuggestions: (async () => {}) as any,
    loadOrderApproval: (async () => {}) as any,
    clearOrderApproval: (() => {}) as any,
  } as any);
}

function requestApproval() {
  usePaletteAction.getState().request({
    section: 'Ordering',
    selectedName: null,
    orderApproval: APPROVAL,
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  usePaletteAction.setState({ pending: null });
  seed();
});

describe('Approve Order fork — AC-REG-2 (desktop/tablet byte-unchanged)', () => {
  it('desktop renders the desktop tree even with an approval pending', () => {
    mockTier = 'desktop';
    requestApproval();
    const { queryByTestId, queryByText } = render(<ReorderSection />);
    expect(queryByTestId('phone-approve-order')).toBeNull();
    expect(queryByTestId('phone-ordering')).toBeNull();
    expect(queryByText('reorder.tsx')).toBeTruthy();
  });

  it('tablet also stays on the desktop tree with an approval pending', () => {
    mockTier = 'tablet';
    requestApproval();
    const { queryByTestId, queryByText } = render(<ReorderSection />);
    expect(queryByTestId('phone-approve-order')).toBeNull();
    expect(queryByText('reorder.tsx')).toBeTruthy();
  });
});

describe('Approve Order fork — AC-REG-1 (PhoneOrdering unchanged)', () => {
  it('phone with NO pending approval renders PhoneOrdering', () => {
    mockTier = 'phone';
    const { getByTestId, queryByTestId } = render(<ReorderSection />);
    expect(getByTestId('phone-ordering')).toBeTruthy();
    expect(queryByTestId('phone-approve-order')).toBeNull();
  });

  it('an unrelated palette action (no orderApproval) still renders PhoneOrdering', () => {
    mockTier = 'phone';
    usePaletteAction.getState().request({ section: 'Ordering', selectedName: null });
    const { getByTestId, queryByTestId } = render(<ReorderSection />);
    expect(getByTestId('phone-ordering')).toBeTruthy();
    expect(queryByTestId('phone-approve-order')).toBeNull();
  });
});

describe('Approve Order fork — AC-6 (deep link both directions)', () => {
  // The deep link resolves through loadOrderApproval (stubbed here — the store
  // suite covers it), so pre-seed the resolved context; without it the screen
  // correctly sits on its loading pane.
  beforeEach(() => {
    useStore.setState({
      approvalContext: {
        submissionId: 'sub-1', storeId: 'store-1', vendorId: 'v-a', businessDate: '2026-08-01',
      },
    } as any);
  });

  it('phone WITH a pending approval renders the Approve Order screen', () => {
    mockTier = 'phone';
    requestApproval();
    const { getByTestId, queryByTestId } = render(<ReorderSection />);
    expect(getByTestId('phone-approve-order')).toBeTruthy();
    expect(queryByTestId('phone-ordering')).toBeNull();
  });

  it('consuming the payload returns the phone to PhoneOrdering', () => {
    mockTier = 'phone';
    requestApproval();
    const { getByTestId, queryByTestId, rerender } = render(<ReorderSection />);
    expect(getByTestId('phone-approve-order')).toBeTruthy();
    usePaletteAction.getState().consume();
    rerender(<ReorderSection />);
    expect(getByTestId('phone-ordering')).toBeTruthy();
    expect(queryByTestId('phone-approve-order')).toBeNull();
  });
});
