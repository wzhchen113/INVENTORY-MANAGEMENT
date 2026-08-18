// src/screens/cmd/sections/__tests__/RecipesSection.countedFilter.spec160.test.tsx
//
// Spec 160 §9.1 — blast-radius pin for the shared filter DSL.
//
// `filterParser` is shared with Recipes. Adding `counted` to KEY_ALIASES changes
// parsing here: `counted:never` used to fall into `parsed.text` and substring-
// match `menuItem` (→ 0 results); it is now a recognized key that RecipesSection
// deliberately ignores (→ the full list). That is the SAME documented posture
// `status:` and `vendor:` already have here — "accepted but no-op, so users can
// paste a query copied from the inventory filter without errors" — so this test
// pins the accepted behavior rather than treating it as a regression.

jest.mock('../../../../theme/breakpoints', () => {
  const actual = jest.requireActual('../../../../theme/breakpoints');
  return { ...actual, useIsPhone: () => false };
});

jest.mock('../../../../theme/colors', () => ({
  useCmdColors: () => ({
    bg: '#FFFFFF', panel: '#F4F4F4', panel2: '#EAEAEA',
    border: '#CCCCCC', borderStrong: '#888888',
    fg: '#000000', fg2: '#444444', fg3: '#888888',
    accent: '#185FA5', accentBg: '#E6F1FB', accentFg: '#FFFFFF',
    warn: '#854F0B', warnBg: '#FAEEDA',
    danger: '#791F1F', dangerBg: '#FCEBEB',
    ok: '#3B6D11', okBg: '#EAF3DE',
    info: '#185FA5', infoBg: '#E6F1FB',
  }),
  CmdRadius: { xs: 3, sm: 4, md: 5, lg: 6 },
}));

jest.mock('../../../../hooks/useT', () => ({
  useT: () => (key: string) => key,
}));
jest.mock('../../../../hooks/useLocale', () => ({ useLocale: () => 'en' }));
jest.mock('../../../../hooks/useRole', () => ({
  useRole: () => 'admin' as const,
  useIsSuperAdmin: () => false,
  useIsMaster: () => false,
}));
jest.mock('../../../../i18n/localizedName', () => ({
  getLocalizedName: (input: { menuItem?: string; name?: string }) =>
    input.menuItem ?? input.name ?? '',
}));

// FilterInput → a bare controlled TextInput so the test can type into it.
jest.mock('../../../../components/cmd/FilterInput', () => {
  const React = require('react');
  const { TextInput } = require('react-native');
  return {
    FilterInput: ({ value, onChangeText }: any) => (
      <TextInput testID="recipes-filter" value={value} onChangeText={onChangeText} />
    ),
  };
});

jest.mock('../../../../components/cmd/RecipeFormDrawer', () => ({ RecipeFormDrawer: () => null }));
jest.mock('../../../../components/cmd/MenuCapacityBadge', () => ({ MenuCapacityBadge: () => null }));
jest.mock('../../../../components/cmd/ListSkeleton', () => ({ ListSkeleton: () => null }));
jest.mock('../../../../components/cmd/StockHistoryChart', () => ({ StockHistoryChart: () => null }));
jest.mock('../RecipeCategoriesSection', () => ({ __esModule: true, default: () => null }));
jest.mock('./../phone/PhoneMenuItemsList', () => ({ PhoneMenuItemsList: () => null }));

jest.mock('../../../../store/useStore', () => {
  const state: any = {
    recipes: [
      { id: 'r1', menuItem: 'Wings', category: 'Mains', sellPrice: 10, ingredients: [], prepItems: [], i18nNames: {} },
      { id: 'r2', menuItem: 'Fries', category: 'Sides', sellPrice: 5, ingredients: [], prepItems: [], i18nNames: {} },
    ],
    recipeCategories: [],
    inventory: [],
    prepRecipes: [],
    currentStore: { id: 'store-1', name: 'Store One' },
    getRecipeCost: () => 3,
    getRecipeFoodCostPct: () => 30,
    getIngredientLineCost: () => 0,
    getPrepRecipe: () => undefined,
    getPrepRecipeCostPerUnit: () => 0,
    deleteRecipe: jest.fn(),
    storeLoading: false,
    posImports: [],
  };
  const fn: any = jest.fn((selector: (s: any) => any) => selector(state));
  fn.getState = () => state;
  fn.__state = state;
  return { useStore: fn };
});

import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react-native';
import RecipesSection from '../RecipesSection';

describe('RecipesSection — `counted:` is accepted-but-no-op (spec 160 §9.1)', () => {
  it('leaves the full recipe list visible for counted:never', () => {
    render(<RecipesSection />);
    expect(screen.getAllByText('Wings').length).toBeGreaterThanOrEqual(1);

    fireEvent.changeText(screen.getByTestId('recipes-filter'), 'counted:never');

    // Parsed as a filter key and ignored → both recipes still listed. Before
    // the alias existed this token was a NAME search and matched nothing.
    expect(screen.getAllByText('Wings').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('Fries').length).toBeGreaterThanOrEqual(1);
  });

  it('still applies cat: alongside an ignored counted: token', () => {
    render(<RecipesSection />);
    fireEvent.changeText(screen.getByTestId('recipes-filter'), 'counted:never cat:sides');
    expect(screen.getAllByText('Fries').length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByText('Wings')).toBeNull();
  });

  it('a bare unknown token still narrows by name (the DSL is otherwise intact)', () => {
    render(<RecipesSection />);
    fireEvent.changeText(screen.getByTestId('recipes-filter'), 'fri');
    expect(screen.getAllByText('Fries').length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByText('Wings')).toBeNull();
  });
});
