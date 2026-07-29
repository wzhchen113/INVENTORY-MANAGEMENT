// src/screens/cmd/sections/phone/__tests__/PhoneUsers.acReg.test.tsx — Spec 146.
//
// AC-REG — the phone Users guard is the sole behavioral fork. With isPhone
// false (desktop AND tablet) UsersSection renders its desktop tree (the
// `users.tsx` TabStrip tab) and NOT the phone component; with isPhone true only
// the phone component renders and the tab strip is gone. Mirrors
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

// UsersSection fetches the user list on mount — stub the auth boundary so the
// mount is deterministic and does not hit the network.
jest.mock('../../../../../lib/auth', () => ({
  __esModule: true,
  fetchAllUsers: jest.fn(() => Promise.resolve([])),
  sendPasswordReset: jest.fn(() => Promise.resolve({ error: null })),
  inviteUser: jest.fn(() => Promise.resolve({ error: null })),
}));

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

import UsersSection from '../../UsersSection';
import { useStore } from '../../../../../store/useStore';

function seed() {
  useStore.setState({
    currentUser: { id: 'me', name: 'Admin', email: 'a@b.c', role: 'master' } as any,
    stores: [{ id: 'store-1', brandId: 'b', name: 'F' } as any],
    brand: { id: 'b', name: '2AM' } as any,
  });
}

beforeEach(() => { jest.clearAllMocks(); seed(); });

describe('Users & access — AC-REG', () => {
  it('desktop renders the desktop tree, not the phone component', () => {
    mockTier = 'desktop';
    const { queryByTestId, queryByText } = render(<UsersSection />);
    expect(queryByTestId('phone-users')).toBeNull();
    expect(queryByText('users.tsx')).toBeTruthy();
  });

  it('tablet also stays on the desktop tree', () => {
    mockTier = 'tablet';
    const { queryByTestId, queryByText } = render(<UsersSection />);
    expect(queryByTestId('phone-users')).toBeNull();
    expect(queryByText('users.tsx')).toBeTruthy();
  });

  it('phone renders the phone Users component and no desktop tab strip', () => {
    mockTier = 'phone';
    const { getByTestId, queryByText } = render(<UsersSection />);
    expect(getByTestId('phone-users')).toBeTruthy();
    expect(queryByText('users.tsx')).toBeNull();
  });
});
