// src/screens/cmd/sections/phone/__tests__/PhoneWeeklyCount.acReg.test.tsx — Spec 144.
//
// AC-REG — the phone weekly-count guard is the sole behavioral fork. With
// isPhone false (desktop AND tablet) InventoryCountSection renders its desktop
// tree (the count/history/weekly TabStrip) and NOT the phone component; with
// isPhone true only the phone component renders (no desktop tab strip). Mirrors
// PhoneOrdering.acReg.test.tsx.

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

import InventoryCountSection from '../../InventoryCountSection';
import { useStore } from '../../../../../store/useStore';

function seed() {
  useStore.setState({
    currentStore: { id: 'store-1', brandId: 'b', name: 'F', address: '', status: 'active' } as any,
    currentUser: { id: 'user-1', name: 'Admin', email: 'a@b.c', role: 'admin' } as any,
    stores: [{ id: 'store-1', name: 'F' } as any],
    inventory: [],
    weeklyCountStatus: null,
    weeklyCountStatusLoading: false,
    loadWeeklyCountStatus: (async () => {}) as any,
    fetchStoreCountLayouts: (async () => []) as any,
  });
}

beforeEach(() => { jest.clearAllMocks(); seed(); });

describe('Inventory count / weekly — AC-REG', () => {
  it('desktop renders the desktop tree, not the phone component', () => {
    mockTier = 'desktop';
    const { queryByTestId, queryByText } = render(<InventoryCountSection />);
    expect(queryByTestId('phone-weekly-count')).toBeNull();
    expect(queryByText('count.tsx')).toBeTruthy();
  });

  it('tablet also stays on the desktop tree', () => {
    mockTier = 'tablet';
    const { queryByTestId, queryByText } = render(<InventoryCountSection />);
    expect(queryByTestId('phone-weekly-count')).toBeNull();
    expect(queryByText('count.tsx')).toBeTruthy();
  });

  it('phone renders the phone weekly-count component and no desktop tab strip', () => {
    mockTier = 'phone';
    const { getByTestId, queryByText } = render(<InventoryCountSection />);
    expect(getByTestId('phone-weekly-count')).toBeTruthy();
    expect(queryByText('count.tsx')).toBeNull();
  });
});
