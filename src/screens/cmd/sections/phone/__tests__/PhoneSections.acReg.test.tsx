// src/screens/cmd/sections/phone/__tests__/PhoneSections.acReg.test.tsx
//
// Spec 142 §6.3 (AC-REG1) — the five chunk-c sections are pure additive guards.
// With isPhone false (desktop AND tablet) the existing desktop tree renders and
// the phone component is absent; with isPhone true only the phone component
// renders. Pins that the `if (isPhone) return <PhoneXxx/>` guard is the sole
// behavioral fork for MenuImpact / Recipes / Prep / Vendors / Waste.

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

import MenuImpactSection from '../../MenuImpactSection';
import RecipesSection from '../../RecipesSection';
import PrepRecipesSection from '../../PrepRecipesSection';
import VendorsSection from '../../VendorsSection';
import WasteLogSection from '../../WasteLogSection';
import { useStore } from '../../../../../store/useStore';

function seed() {
  useStore.setState({
    currentStore: { id: 'store-1', brandId: 'b', name: 'F', address: '', status: 'active' } as any,
    currentUser: { id: 'user-1', name: 'Admin', email: 'a@b.c', role: 'admin' } as any,
    stores: [{ id: 'store-1', name: 'F' } as any],
    brand: { id: 'b', name: 'B' } as any,
    recipes: [{ id: 'r1', menuItem: 'Wings', category: 'Main', sellPrice: 12, ingredients: [], prepItems: [], brandId: 'b', storeId: 'b' } as any],
    prepRecipes: [{ id: 'p1', name: 'Sauce', category: 'Prep', yieldQuantity: 10, yieldUnit: 'lbs', notes: '', ingredients: [], brandId: 'b', storeId: 'b', createdBy: 'u', createdAt: new Date().toISOString(), version: 1, isCurrent: true } as any],
    vendors: [{ id: 'v1', brandId: 'b', name: 'BJ', contactName: '', phone: '', email: '', accountNumber: '', leadTimeDays: 2, deliveryDays: [], categories: [], orderUnit: 'case', extensionOrdering: false, orderPageUrl: null } as any],
    inventory: [],
    wasteLog: [],
    menuCapacity: {},
    recipeCategories: [],
    ingredientCategories: [],
    posImports: [],
    auditLog: [],
    storeLoading: false,
  });
}

beforeEach(() => { jest.clearAllMocks(); seed(); });

type Case = { name: string; el: React.ReactElement; phoneTestId: string; desktopMarker?: string };
const cases: Case[] = [
  { name: 'MenuImpact', el: <MenuImpactSection />, phoneTestId: 'phone-menuimpact' },
  { name: 'Recipes', el: <RecipesSection />, phoneTestId: 'phone-menuitems', desktopMarker: 'recipe.tsx' },
  { name: 'Prep', el: <PrepRecipesSection />, phoneTestId: 'phone-prep', desktopMarker: 'prep.tsx' },
  { name: 'Vendors', el: <VendorsSection />, phoneTestId: 'phone-vendors', desktopMarker: 'profile.tsx' },
  { name: 'Waste', el: <WasteLogSection />, phoneTestId: 'phone-waste-flatlist', desktopMarker: 'log.tsx' },
];

describe('chunk-c sections — AC-REG', () => {
  for (const c of cases) {
    it(`${c.name}: desktop renders the desktop tree, not the phone component`, () => {
      mockTier = 'desktop';
      const { queryByTestId, queryByText } = render(c.el);
      expect(queryByTestId(c.phoneTestId)).toBeNull();
      if (c.desktopMarker) expect(queryByText(c.desktopMarker)).toBeTruthy();
    });

    it(`${c.name}: tablet also stays on the desktop tree`, () => {
      mockTier = 'tablet';
      const { queryByTestId } = render(c.el);
      expect(queryByTestId(c.phoneTestId)).toBeNull();
    });

    it(`${c.name}: phone renders the phone component`, () => {
      mockTier = 'phone';
      const { getByTestId, queryByText } = render(c.el);
      expect(getByTestId(c.phoneTestId)).toBeTruthy();
      if (c.desktopMarker) expect(queryByText(c.desktopMarker)).toBeNull();
    });
  }
});
