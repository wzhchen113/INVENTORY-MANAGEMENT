// src/screens/cmd/sections/phone/__tests__/PhoneOrdering.acReg.test.tsx
//
// Spec (2026-07) AC-REG — the phone Ordering guard is the sole behavioral fork.
// With isPhone false (desktop AND tablet) ReorderSection renders its desktop
// tree (the `reorder.tsx` TabStrip tab) and NOT the phone component; with
// isPhone true only the phone component renders. Mirrors
// PhoneSections.acReg.test.tsx.

import React from 'react';
import { render } from '@testing-library/react-native';

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
});
