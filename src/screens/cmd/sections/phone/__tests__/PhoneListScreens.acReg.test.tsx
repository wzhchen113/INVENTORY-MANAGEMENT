// src/screens/cmd/sections/phone/__tests__/PhoneListScreens.acReg.test.tsx
//
// Spec 147 AC-REG — the four shared-list-shell sections (Reconciliation / POS
// imports / Audit log / Reports) are pure additive guards. With isPhone false
// (desktop AND tablet) each host renders its desktop TabStrip tree and NOT the
// phone component; with isPhone true only the phone component renders and the
// tab strip is gone. Mirrors PhoneSections.acReg / PhoneDashboard.acReg.

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

import ReconciliationSection from '../../ReconciliationSection';
import POSImportsSection from '../../POSImportsSection';
import AuditLogSection from '../../AuditLogSection';
import ReportsSection from '../../ReportsSection';
import { useStore } from '../../../../../store/useStore';

function seed() {
  useStore.setState({
    currentStore: { id: 'store-1', brandId: 'b', name: 'F', address: '', status: 'active' } as any,
    currentUser: { id: 'user-1', name: 'Admin', email: 'a@b.c', role: 'admin' } as any,
    stores: [{ id: 'store-1', name: 'F' } as any],
    brand: { id: 'b', name: 'B' } as any,
    inventory: [],
    vendors: [],
    recipes: [],
    eodSubmissions: [],
    posImports: [],
    auditLog: [],
    savedReports: [],
    reportRuns: {},
    posRecipeAliases: [],
    storeLoading: false,
  } as any);
}

beforeEach(() => { jest.clearAllMocks(); seed(); });

type Case = { name: string; el: React.ReactElement; phoneTestId: string; desktopMarker: string };
const cases: Case[] = [
  { name: 'Reconciliation', el: <ReconciliationSection />, phoneTestId: 'phone-reconciliation', desktopMarker: 'variance.tsx' },
  { name: 'POSImports', el: <POSImportsSection />, phoneTestId: 'phone-posimports', desktopMarker: 'imports.tsx' },
  { name: 'AuditLog', el: <AuditLogSection />, phoneTestId: 'phone-auditlog', desktopMarker: 'feed.tsx' },
  { name: 'Reports', el: <ReportsSection />, phoneTestId: 'phone-reports', desktopMarker: 'library.tsx' },
];

describe('phone list-shell sections — AC-REG', () => {
  for (const c of cases) {
    it(`${c.name}: desktop renders the desktop tree, not the phone component`, () => {
      mockTier = 'desktop';
      const { queryByTestId, queryByText } = render(c.el);
      expect(queryByTestId(c.phoneTestId)).toBeNull();
      expect(queryByText(c.desktopMarker)).toBeTruthy();
    });

    it(`${c.name}: tablet also stays on the desktop tree`, () => {
      mockTier = 'tablet';
      const { queryByTestId, queryByText } = render(c.el);
      expect(queryByTestId(c.phoneTestId)).toBeNull();
      expect(queryByText(c.desktopMarker)).toBeTruthy();
    });

    it(`${c.name}: phone renders the phone component and no desktop tab strip`, () => {
      mockTier = 'phone';
      const { getByTestId, queryByText } = render(c.el);
      expect(getByTestId(c.phoneTestId)).toBeTruthy();
      expect(queryByText(c.desktopMarker)).toBeNull();
    });
  }
});
