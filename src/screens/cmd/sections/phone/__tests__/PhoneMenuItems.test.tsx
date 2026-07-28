// src/screens/cmd/sections/phone/__tests__/PhoneMenuItems.test.tsx
//
// Spec 142 §6 (AC-BOM1/2) — the Menu-items (Recipes) row shape ("N INGREDIENTS
// · COST $X", price, margin pill, makeable tag) and the shared menu-item detail
// internals (MAKEABLE/PRICE/MARGIN stats, INGREDIENT AVAILABILITY rows incl. the
// PREP tag for sub-recipes, PLATE COSTING). supabase is stubbed.

import React from 'react';
import { render, fireEvent } from '@testing-library/react-native';

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

import { PhoneMenuItemsList } from '../PhoneMenuItemsList';
import { useStore } from '../../../../../store/useStore';

function mkInv(catalogId: string, name: string, stock: number): any {
  return { id: 'inv-' + catalogId, catalogId, name, unit: 'lbs', currentStock: stock, storeId: 'store-1', costPerUnit: 1, parLevel: 10, averageDailyUsage: 0, safetyStock: 0, vendorId: 'v', vendorName: '', usagePerPortion: 0, lastUpdatedBy: '', lastUpdatedAt: '', eodRemaining: 0, casePrice: 0, caseQty: 1, subUnitSize: 1, subUnitUnit: 'lb' };
}

beforeEach(() => {
  jest.clearAllMocks();
  useStore.setState({
    currentStore: { id: 'store-1', brandId: 'b', name: 'F', address: '', status: 'active' } as any,
    recipes: [
      {
        id: 'r1', menuItem: 'Wings', category: 'Main', sellPrice: 12,
        ingredients: [{ itemId: 'c1', itemName: 'Chicken', quantity: 2, unit: 'lbs' }],
        prepItems: [{ prepRecipeId: 'p1', prepRecipeName: 'House Sauce', quantity: 1, unit: 'oz' }],
        brandId: 'b', storeId: 'b',
      } as any,
    ],
    inventory: [mkInv('c1', 'Chicken', 20)],
    prepRecipes: [{ id: 'p1', name: 'House Sauce', category: 'Prep', yieldQuantity: 10, yieldUnit: 'oz', notes: '', ingredients: [], brandId: 'b', storeId: 'b', createdBy: 'u', createdAt: '', version: 1, isCurrent: true } as any],
    menuCapacity: {},
  });
});

describe('PhoneMenuItemsList — AC-BOM1 row', () => {
  it('renders the ingredient-count + cost meta and the price', () => {
    const { getByTestId, getByText } = render(<PhoneMenuItemsList />);
    expect(getByTestId('phone-menuitem-row-r1')).toBeTruthy();
    // 1 raw + 1 prep line = 2 ingredients; cost getter resolves $0.00 for
    // unpriced fixtures — the meta shape is what AC-BOM1 pins.
    expect(getByText(/2 INGREDIENTS · COST \$/)).toBeTruthy();
    expect(getByText('$12.00')).toBeTruthy();
  });
});

describe('PhoneMenuItemDetail via Menu items — AC-BOM2 internals', () => {
  it('opens the shared detail with stats, ingredient availability, PREP tag and plate costing', () => {
    const { getByTestId, getByText } = render(<PhoneMenuItemsList />);
    fireEvent.press(getByTestId('phone-menuitem-row-r1'));

    // Stats
    expect(getByTestId('phone-menu-statpanel')).toBeTruthy();
    expect(getByText('MAKEABLE')).toBeTruthy();
    expect(getByText('PRICE')).toBeTruthy();
    expect(getByText('MARGIN')).toBeTruthy();

    // Ingredient availability: raw line name + NEED/PLATE meta, prep PREP tag.
    expect(getByText('Chicken')).toBeTruthy();
    expect(getByText(/NEED 2 lbs \/ PLATE/)).toBeTruthy();
    expect(getByText('House Sauce')).toBeTruthy();
    expect(getByText('PREP')).toBeTruthy();

    // Plate costing + actions
    expect(getByText('PLATE COSTING')).toBeTruthy();
    expect(getByTestId('phone-menu-edit')).toBeTruthy();
    expect(getByTestId('phone-menu-order-shortages')).toBeTruthy();
  });
});
