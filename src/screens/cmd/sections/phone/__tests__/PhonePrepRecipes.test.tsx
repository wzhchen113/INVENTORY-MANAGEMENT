// src/screens/cmd/sections/phone/__tests__/PhonePrepRecipes.test.tsx
//
// Spec 142 §6 (AC-PREP1/2) — the Prep-recipes row (name / YIELD·BATCH meta /
// $per-unit + "IN N MENU ITEMS") and the detail (YIELD/BATCH COST/COST-PER-UNIT
// stats, INGREDIENTS + USED IN sections, EDIT RECIPE + LOG A BATCH honest
// toasts). supabase is stubbed; Toast is the global jest.setup stub.

import React from 'react';
import { render, fireEvent } from '@testing-library/react-native';
import Toast from 'react-native-toast-message';

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

import { PhonePrepRecipesList } from '../PhonePrepRecipesList';
import { useStore } from '../../../../../store/useStore';

beforeEach(() => {
  jest.clearAllMocks();
  useStore.setState({
    currentStore: { id: 'store-1', brandId: 'b', name: 'F', address: '', status: 'active' } as any,
    prepRecipes: [
      {
        id: 'p1', name: 'House Sauce', category: 'Prep', yieldQuantity: 10, yieldUnit: 'lbs', notes: '',
        ingredients: [{ itemId: 'c1', itemName: 'Tomato', quantity: 5, unit: 'lbs', baseQuantity: 5, baseUnit: 'g', type: 'raw' }],
        brandId: 'b', storeId: 'b', createdBy: 'u', createdAt: new Date().toISOString(), version: 1, isCurrent: true,
      } as any,
    ],
    recipes: [
      { id: 'r1', menuItem: 'Wings', category: 'Main', sellPrice: 12, ingredients: [], prepItems: [{ prepRecipeId: 'p1', prepRecipeName: 'House Sauce', quantity: 1, unit: 'oz' }], brandId: 'b', storeId: 'b' } as any,
    ],
    inventory: [],
    menuCapacity: {},
  });
});

describe('PhonePrepRecipesList — AC-PREP1 row', () => {
  it('renders the yield/batch meta and the "IN N MENU ITEMS" count', () => {
    const { getByTestId, getByText } = render(<PhonePrepRecipesList />);
    expect(getByTestId('phone-prep-row-p1')).toBeTruthy();
    expect(getByText(/YIELD 10 lbs · \$.*\/BATCH/)).toBeTruthy();
    expect(getByText('IN 1 MENU ITEMS')).toBeTruthy();
  });
});

describe('PhonePrepRecipesList detail — AC-PREP2', () => {
  it('opens stats + INGREDIENTS + USED IN and fires honest toasts', () => {
    const { getByTestId, getByText } = render(<PhonePrepRecipesList />);
    fireEvent.press(getByTestId('phone-prep-row-p1'));

    expect(getByTestId('phone-prep-statpanel')).toBeTruthy();
    expect(getByText('YIELD')).toBeTruthy();
    expect(getByText('BATCH COST')).toBeTruthy();
    expect(getByText('INGREDIENTS')).toBeTruthy();
    expect(getByText('Tomato')).toBeTruthy();
    expect(getByText('USED IN 1 MENU ITEMS')).toBeTruthy();
    expect(getByText('Wings')).toBeTruthy();

    fireEvent.press(getByTestId('phone-prep-edit'));
    expect(Toast.show as jest.Mock).toHaveBeenCalledWith(expect.objectContaining({ type: 'info', text1: 'Edit on desktop' }));

    (Toast.show as jest.Mock).mockClear();
    fireEvent.press(getByTestId('phone-prep-log-batch'));
    expect(Toast.show as jest.Mock).toHaveBeenCalledWith(expect.objectContaining({ type: 'info', text1: 'Available on desktop' }));
  });
});
