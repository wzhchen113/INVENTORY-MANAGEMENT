// src/screens/cmd/sections/eod/__tests__/EODCountSection.acReg.test.tsx
//
// Spec 140 AC-REG — the phone tier is a pure ADDITIVE early-return. With
// `useIsPhone()` false (tablet + desktop), EODCountSection renders its existing
// desktop tree and NONE of the phone-only surface; with it true, the phone
// worksheet (and only that) renders. This pins that the `if (isPhone) return
// <PhoneEodCount/>` gate is the sole behavioral fork and the desktop path is
// untouched.
//
// db.ts is mocked with an inert Proxy (any accessed export → a promise-returning
// jest.fn) so the section renders without a live backend; supabase is stubbed
// because useStore imports it at module load.

import React from 'react';
import { render } from '@testing-library/react-native';

jest.mock('../../../../../lib/supabase', () => ({
  __esModule: true,
  supabase: {
    auth: {
      getSession: jest.fn(() => Promise.resolve({ data: { session: null }, error: null })),
      onAuthStateChange: jest.fn(() => ({ data: { subscription: { unsubscribe: jest.fn() } } })),
    },
    from: jest.fn(() => ({
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      order: jest.fn().mockReturnThis(),
      single: jest.fn(() => Promise.resolve({ data: null, error: null })),
      maybeSingle: jest.fn(() => Promise.resolve({ data: null, error: null })),
    })),
    rpc: jest.fn(() => Promise.resolve({ data: null, error: null })),
    channel: jest.fn(() => ({ on: jest.fn().mockReturnThis(), subscribe: jest.fn(() => ({ unsubscribe: jest.fn() })) })),
    removeChannel: jest.fn(),
    functions: { invoke: jest.fn() },
  },
}));

// Inert db.ts — any accessed export resolves null (the section handles a null
// saved order; nothing else is exercised at render for an empty store).
jest.mock('../../../../../lib/db', () =>
  new Proxy(
    { __esModule: true },
    {
      get: (target: Record<string, unknown>, prop: string) => {
        if (prop in target) return (target as any)[prop];
        return jest.fn(() => Promise.resolve(null));
      },
    },
  ),
);

// Controllable tier — flipped per test before render.
let mockIsPhone = false;
jest.mock('../../../../../theme/breakpoints', () => {
  const actual = jest.requireActual('../../../../../theme/breakpoints');
  return {
    ...actual,
    useIsPhone: () => mockIsPhone,
    useBreakpoint: () => (mockIsPhone ? 'phone' : 'desktop'),
  };
});

import EODCountSection from '../../EODCountSection';
import { useStore } from '../../../../../store/useStore';

function seedStore() {
  useStore.setState({
    currentStore: { id: 'store-1', brandId: 'brand-1', name: 'Frederick', address: '', status: 'active' } as any,
    currentUser: { id: 'user-1', name: 'Admin', email: 'a@b.c', role: 'admin' } as any,
    inventory: [],
    vendors: [],
    eodSubmissions: [],
    orderSchedule: {},
    storeLoading: false,
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  seedStore();
});

describe('EODCountSection — spec 140 AC-REG (phone early-return gate)', () => {
  it('desktop: renders the existing desktop tree and NO phone-only surface', () => {
    mockIsPhone = false;
    const { queryByText, queryByTestId } = render(<EODCountSection />);
    // Desktop-only week sidebar marker is present…
    expect(queryByText('This week')).toBeTruthy();
    // …and the phone submit bar / worksheet is absent.
    expect(queryByTestId('eod-submit')).toBeNull();
  });

  it('phone: renders the phone worksheet and NOT the desktop week sidebar', () => {
    mockIsPhone = true;
    const { queryByText, queryByTestId } = render(<EODCountSection />);
    // Phone submit bar is present…
    expect(queryByTestId('eod-submit')).toBeTruthy();
    // …and the desktop-only "This week" sidebar header is gone.
    expect(queryByText('This week')).toBeNull();
  });
});
