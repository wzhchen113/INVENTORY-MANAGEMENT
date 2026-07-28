// src/screens/cmd/sections/phone/__tests__/honestToast.test.tsx
//
// Spec 142 §6.7 (AC-D5) — a desktop-only edit action (EDIT RECIPE) fires an
// honest Toast with the "Edit on desktop" copy and performs NO navigation /
// store mutation (a fake form would be the defect). Toast is the global stub
// from jest.setup.ts.

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

import { PhoneMenuItemDetail } from '../PhoneMenuItemDetail';
import { useStore } from '../../../../../store/useStore';
import { usePaletteAction } from '../../../../../lib/paletteAction';

beforeEach(() => {
  jest.clearAllMocks();
  usePaletteAction.setState({ pending: null });
  useStore.setState({
    currentStore: { id: 'store-1', brandId: 'b', name: 'F', address: '', status: 'active' } as any,
    recipes: [{ id: 'r1', menuItem: 'Wings', category: 'Main', sellPrice: 12, ingredients: [], prepItems: [], brandId: 'b', storeId: 'b' } as any],
    menuCapacity: {},
    inventory: [],
  });
});

describe('honest toast for desktop-only edit (AC-D5)', () => {
  it('EDIT RECIPE fires an honest toast and does not navigate or mutate', () => {
    const { getByTestId } = render(<PhoneMenuItemDetail recipeId="r1" />);
    fireEvent.press(getByTestId('phone-menu-edit'));

    expect(Toast.show as jest.Mock).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'info', text1: 'Edit on desktop' }),
    );
    // No cross-section navigation was requested (a fake form / real edit would).
    expect(usePaletteAction.getState().pending).toBeNull();
  });

  it('ORDER SHORTAGES navigates to Ordering (positive control)', () => {
    const { getByTestId } = render(<PhoneMenuItemDetail recipeId="r1" />);
    fireEvent.press(getByTestId('phone-menu-order-shortages'));
    expect(usePaletteAction.getState().pending).toEqual({ section: 'Ordering', selectedName: null });
  });
});
