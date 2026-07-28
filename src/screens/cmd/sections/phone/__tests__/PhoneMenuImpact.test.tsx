// src/screens/cmd/sections/phone/__tests__/PhoneMenuImpact.test.tsx
//
// Spec 142 §6.5 (AC-MI1/2):
//   - clientMenuCapacity: makeable = min floor(onHand/needPerPlate), limitedBy
//     = argmin — matches a hand-computed fixture;
//   - recipeCapacity prefers the server menuCapacity value when present;
//   - PhoneMenuImpactList sorts rows by capacity ascending (most-impacted first).
//
// supabase is stubbed (useStore imports it at module load).

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

import { clientMenuCapacity, recipeCapacity } from '../menuCapacityFallback';
import { PhoneMenuImpactList } from '../PhoneMenuImpactList';
import { useStore } from '../../../../../store/useStore';

describe('clientMenuCapacity (spec 142 AC-MI2)', () => {
  it('returns min floor(onHand/needPerPlate) and the argmin ingredient', () => {
    const res = clientMenuCapacity([
      { onHand: 30, needPerPlate: 2, name: 'Flour' },   // 15
      { onHand: 9, needPerPlate: 1.5, name: 'Chicken' }, // 6  ← argmin
      { onHand: 100, needPerPlate: 1, name: 'Salt' },    // 100
    ]);
    expect(res).toEqual({ makeable: 6, limitedBy: 'Chicken' });
  });

  it('ignores zero-need lines and returns null when no line is tracked', () => {
    expect(clientMenuCapacity([{ onHand: 5, needPerPlate: 0, name: 'x' }])).toEqual({ makeable: null, limitedBy: null });
    expect(clientMenuCapacity([])).toEqual({ makeable: null, limitedBy: null });
  });
});

describe('recipeCapacity (server vs client)', () => {
  const recipe: any = { id: 'r1', menuItem: 'X', category: 'Main', sellPrice: 10, ingredients: [{ itemId: 'c1', itemName: 'Chicken', quantity: 1, unit: 'lbs' }], prepItems: [], brandId: 'b', storeId: 'b' };
  const inv: any = [{ id: 'i1', catalogId: 'c1', name: 'Chicken', unit: 'lbs', currentStock: 4, storeId: 'store-1', costPerUnit: 1, parLevel: 10, averageDailyUsage: 0, safetyStock: 0, vendorId: 'v', vendorName: '', usagePerPortion: 0, lastUpdatedBy: '', lastUpdatedAt: '', eodRemaining: 0, casePrice: 0, caseQty: 1, subUnitSize: 1, subUnitUnit: 'lb' }];

  it('uses the server makeableQty when the capacity row is present', () => {
    const cap: any = { recipeId: 'r1', storeId: 'store-1', hasRecipe: true, makeableQty: 99, bindingCatalogId: null, bindingCatalogName: 'ServerBind', bindingShortfall: null, lowIngredientCount: 0, hasUnitMismatch: false, truncated: false };
    expect(recipeCapacity(recipe, inv, 'store-1', cap)).toEqual({ makeable: 99, limitedBy: 'ServerBind' });
  });

  it('falls back to the client formula when no capacity row exists', () => {
    // onHand 4 / need 1 = 4
    expect(recipeCapacity(recipe, inv, 'store-1', null)).toEqual({ makeable: 4, limitedBy: 'Chicken' });
  });
});

function mkRecipe(id: string, name: string, itemId: string): any {
  return { id, menuItem: name, category: 'Main', sellPrice: 12, ingredients: [{ itemId, itemName: name + '-ing', quantity: 1, unit: 'lbs' }], prepItems: [], brandId: 'b', storeId: 'b' };
}
function mkInv(catalogId: string, stock: number): any {
  return { id: 'inv-' + catalogId, catalogId, name: catalogId, unit: 'lbs', currentStock: stock, storeId: 'store-1', costPerUnit: 1, parLevel: 10, averageDailyUsage: 0, safetyStock: 0, vendorId: 'v', vendorName: '', usagePerPortion: 0, lastUpdatedBy: '', lastUpdatedAt: '', eodRemaining: 0, casePrice: 0, caseQty: 1, subUnitSize: 1, subUnitUnit: 'lb' };
}

describe('PhoneMenuImpactList sort (AC-MI1)', () => {
  it('orders rows by capacity ascending (most-impacted first)', () => {
    useStore.setState({
      currentStore: { id: 'store-1', brandId: 'b', name: 'F', address: '', status: 'active' } as any,
      recipes: [mkRecipe('rC', 'Cee', 'cC'), mkRecipe('rA', 'Aaa', 'cA'), mkRecipe('rB', 'Bee', 'cB')],
      inventory: [mkInv('cA', 0), mkInv('cB', 5), mkInv('cC', 30)],
      menuCapacity: {},
    });
    const { root } = render(<PhoneMenuImpactList />);
    const seen = root
      .findAll((n: any) => typeof n.props?.testID === 'string' && n.props.testID.startsWith('phone-menuimpact-row-'))
      .map((n: any) => n.props.testID);
    const order = [...new Set(seen)]; // testID appears on the Pressable + its host View
    expect(order).toEqual(['phone-menuimpact-row-rA', 'phone-menuimpact-row-rB', 'phone-menuimpact-row-rC']);
  });
});

describe('PhoneMenuImpactList chips + KPI (AC-MI1)', () => {
  beforeEach(() => {
    useStore.setState({
      currentStore: { id: 'store-1', brandId: 'b', name: 'F', address: '', status: 'active' } as any,
      recipes: [mkRecipe('rA', 'Aaa', 'cA'), mkRecipe('rB', 'Bee', 'cB'), mkRecipe('rC', 'Cee', 'cC')],
      inventory: [mkInv('cA', 0), mkInv('cB', 5), mkInv('cC', 30)], // makeable 0 / 5 / 30
      menuCapacity: {},
    });
  });

  it('renders the KPI caption and the ALL / IMPACTED ONLY chips', () => {
    const { getByText, getByTestId } = render(<PhoneMenuImpactList />);
    // 1 blocked (makeable 0), 1 limited (makeable 5 < 15).
    expect(getByText('1 BLOCKED · 1 LIMITED · MOST-IMPACTED FIRST')).toBeTruthy();
    expect(getByTestId('chip-all')).toBeTruthy();
    expect(getByTestId('chip-impacted')).toBeTruthy();
  });

  it('IMPACTED ONLY chip filters out the healthy row', () => {
    const { getByTestId, queryByTestId } = render(<PhoneMenuImpactList />);
    fireEvent.press(getByTestId('chip-impacted'));
    expect(getByTestId('phone-menuimpact-row-rA')).toBeTruthy(); // blocked
    expect(getByTestId('phone-menuimpact-row-rB')).toBeTruthy(); // limited
    expect(queryByTestId('phone-menuimpact-row-rC')).toBeNull(); // makeable 30 → not impacted
  });
});
