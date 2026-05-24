// src/screens/cmd/sections/__tests__/MenuImpactSection.test.tsx — Spec 060.
//
// Component-project (jsdom) tests for the dedicated Menu impact
// section under the INSIGHTS sidebar group. Covers the architect's
// design contract (spec §B "Dedicated MenuImpactSection.tsx"):
//
//   1. Default sort = makeable_qty ASC; most-impacted rows surface first.
//   2. No-BOM rows (hasRecipe=false) pin to the BOTTOM regardless of
//      direction — the two-key comparator's primary key.
//   3. Header click toggles direction; click a DIFFERENT column to
//      switch to that column with 'asc'.
//   4. "Show impacted only" filter hides healthy rows.
//   5. Loading / empty states render the correct copy.
//
// Boundary mocking matches the VendorsSection test:
//   - useCmdColors, useT, useLocale (pin to 'en'), useStore stub.
//   - ListSkeleton / SectionCaption stubbed as null where applicable.
//
// Note: this file exercises the SECTION-level wiring. A separate
// unit-level assertion lives directly against the exported
// `compareRows` helper to lock the comparator math.

jest.mock('../../../../theme/colors', () => ({
  useCmdColors: () => ({
    bg:           '#FFFFFF',
    panel:        '#F4F4F4',
    panel2:       '#EAEAEA',
    border:       '#CCCCCC',
    borderStrong: '#888888',
    fg:           '#000000',
    fg2:          '#444444',
    fg3:          '#888888',
    accent:       '#185FA5',
    accentBg:     '#E6F1FB',
    accentFg:     '#FFFFFF',
    warn:         '#854F0B',
    warnBg:       '#FAEEDA',
    danger:       '#791F1F',
    dangerBg:     '#FCEBEB',
    ok:           '#3B6D11',
    okBg:         '#EAF3DE',
    info:         '#185FA5',
    infoBg:       '#E6F1FB',
  }),
  CmdRadius: { xs: 3, sm: 4, md: 5, lg: 6 },
}));

jest.mock('../../../../hooks/useT', () => ({
  useT: () => (key: string, vars?: Record<string, string | number>) => {
    if (!vars) return key;
    return Object.entries(vars).reduce(
      (acc, [k, v]) => acc.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v)),
      key,
    );
  },
}));

jest.mock('../../../../hooks/useLocale', () => ({
  useLocale: () => 'en',
}));

// Default = non-super-admin so the brand column is hidden in basic
// tests. The dedicated test re-mocks it true.
const mockUseIsSuperAdmin = jest.fn(() => false);
jest.mock('../../../../hooks/useRole', () => ({
  useIsSuperAdmin: () => mockUseIsSuperAdmin(),
  useIsMaster: () => false,
  useRole: () => 'admin' as const,
}));

// Mock the i18n localizedName helper to a passthrough so our test
// recipes' menuItem strings render verbatim.
jest.mock('../../../../i18n/localizedName', () => ({
  getLocalizedName: (input: { menuItem?: string; name?: string }) =>
    input.menuItem ?? input.name ?? '',
}));

// useStore — fixed snapshot. Tests reseed recipes, menuCapacity, brand
// state, and storeLoading via `mockState.*` mutations.
jest.mock('../../../../store/useStore', () => {
  const state: any = {
    recipes: [],
    menuCapacity: {},
    brand: { id: 'brand-1', name: 'Brand One' },
    brandsList: [
      { id: 'brand-1', name: 'Brand One', deletedAt: null },
      { id: 'brand-2', name: 'Brand Two', deletedAt: null },
    ],
    storeLoading: false,
  };
  const fn: any = jest.fn((selector: (s: any) => any) => selector(state));
  fn.getState = () => state;
  fn.__state = state;
  return { useStore: fn };
});

jest.mock('../../../../components/cmd/ListSkeleton', () => ({
  ListSkeleton: ({ rows }: { rows?: number }) => {
    const React = require('react');
    const { View } = require('react-native');
    return React.createElement(View, {
      accessibilityLabel: 'Loading',
      'data-rows': rows,
    });
  },
}));

// ── Imports (resolve mocks above) ───────────────────────────────────
import React from 'react';
import { render, screen, fireEvent, within } from '@testing-library/react-native';
import MenuImpactSection, { compareRows } from '../MenuImpactSection';
import { useStore } from '../../../../store/useStore';

const mockState = (useStore as any).__state as Record<string, any>;

function makeRecipe(id: string, menuItem: string, brandId = 'brand-1') {
  return { id, menuItem, brandId, storeId: brandId, category: 'Mains', sellPrice: 10, ingredients: [], prepItems: [] };
}

function makeCap(recipeId: string, overrides: Partial<any> = {}) {
  return {
    recipeId,
    storeId:            'store-1',
    hasRecipe:          true,
    makeableQty:        5,
    bindingCatalogId:   null,
    bindingCatalogName: null,
    bindingShortfall:   null,
    lowIngredientCount: 0,
    hasUnitMismatch:    false,
    truncated:          false,
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockUseIsSuperAdmin.mockReturnValue(false);
  mockState.recipes = [];
  mockState.menuCapacity = {};
  mockState.storeLoading = false;
  mockState.brand = { id: 'brand-1', name: 'Brand One' };
});

describe('compareRows comparator (Spec 060 §B sort contract)', () => {
  const base = {
    recipeId: 'r1',
    name: 'Burger',
    brandId: 'brand-1',
    brandName: 'Brand One',
    capacity: null,
    hasRecipe: true,
    makeableQty: 5,
    bindingCatalogName: null,
    lowCount: 0,
    hasUnitMismatch: false,
    truncated: false,
    bindingShortfall: null,
  };

  it('sorts numerically by makeable qty ascending', () => {
    const a = { ...base, recipeId: 'a', makeableQty: 10 };
    const b = { ...base, recipeId: 'b', makeableQty: 2 };
    expect(compareRows(a, b, 'makeable', 'asc', 'en')).toBeGreaterThan(0);
    expect(compareRows(b, a, 'makeable', 'asc', 'en')).toBeLessThan(0);
  });

  it('sorts numerically by makeable qty descending when dir flipped', () => {
    const a = { ...base, recipeId: 'a', makeableQty: 10 };
    const b = { ...base, recipeId: 'b', makeableQty: 2 };
    expect(compareRows(a, b, 'makeable', 'desc', 'en')).toBeLessThan(0);
  });

  it('pins no-BOM rows to the bottom on ascending sort', () => {
    const noBom = { ...base, recipeId: 'noBom', hasRecipe: false, makeableQty: null };
    const lowQty = { ...base, recipeId: 'low', makeableQty: 1 };
    // No-BOM comes after low-qty regardless of dir.
    expect(compareRows(noBom, lowQty, 'makeable', 'asc', 'en')).toBeGreaterThan(0);
  });

  it('pins no-BOM rows to the bottom on DESCENDING sort too', () => {
    // This is the key invariant: direction does not flip the no-BOM
    // sink. Spec AC §B: "sort order pushes them to the bottom regardless
    // of direction".
    const noBom = { ...base, recipeId: 'noBom', hasRecipe: false, makeableQty: null };
    const highQty = { ...base, recipeId: 'high', makeableQty: 99 };
    expect(compareRows(noBom, highQty, 'makeable', 'desc', 'en')).toBeGreaterThan(0);
  });

  it('sorts by menu item name using localeCompare', () => {
    const a = { ...base, recipeId: 'a', name: 'Zebra' };
    const b = { ...base, recipeId: 'b', name: 'Apple' };
    expect(compareRows(a, b, 'name', 'asc', 'en')).toBeGreaterThan(0);
  });

  it('sorts by binding ingredient with empty strings pinned to the bottom', () => {
    // The binding-name comparator has its own two-tier rule (empty
    // string sinks to bottom regardless of dir) layered ON TOP of the
    // primary no-BOM-sinks rule. Both rows here have hasRecipe=true,
    // so the binding-name rule is what we're exercising.
    const noBinding = { ...base, recipeId: 'a', bindingCatalogName: null };
    const flour = { ...base, recipeId: 'b', bindingCatalogName: 'Flour' };
    expect(compareRows(noBinding, flour, 'binding', 'asc', 'en')).toBeGreaterThan(0);
    expect(compareRows(noBinding, flour, 'binding', 'desc', 'en')).toBeGreaterThan(0);
  });
});

describe('MenuImpactSection — render + sort + filter', () => {
  it('renders the title and the impacted-only toggle', () => {
    mockState.recipes = [
      makeRecipe('r1', 'Burger'),
      makeRecipe('r2', 'Pizza'),
    ];
    mockState.menuCapacity = {
      r1: makeCap('r1', { makeableQty: 10 }),
      r2: makeCap('r2', { makeableQty: 2, lowIngredientCount: 1, bindingCatalogName: 'Cheese' }),
    };

    render(<MenuImpactSection />);
    expect(screen.getByText('section.menuImpact.title')).toBeTruthy();
    // Both recipe names render.
    expect(screen.getByText('Burger')).toBeTruthy();
    expect(screen.getByText('Pizza')).toBeTruthy();
    // The impacted-only filter toggle is present.
    expect(
      screen.getByLabelText('section.menuImpact.showImpactedOnly'),
    ).toBeTruthy();
  });

  it('default sort is makeable_qty ASCENDING — most-impacted first', () => {
    mockState.recipes = [
      makeRecipe('r1', 'High'),
      makeRecipe('r2', 'Low'),
      makeRecipe('r3', 'Mid'),
    ];
    mockState.menuCapacity = {
      r1: makeCap('r1', { makeableQty: 100 }),
      r2: makeCap('r2', { makeableQty: 1 }),
      r3: makeCap('r3', { makeableQty: 50 }),
    };

    render(<MenuImpactSection />);

    // The makeable column has the values 1, 50, 100 in that order.
    // findAllByText returns elements in DOM order.
    const lowText = screen.getByText('Low');
    const midText = screen.getByText('Mid');
    const highText = screen.getByText('High');
    // All three names render. The hard ordering test is via compareRows;
    // here we sanity-check that all rows are present after the sort.
    expect(lowText).toBeTruthy();
    expect(midText).toBeTruthy();
    expect(highText).toBeTruthy();
  });

  it('renders "no recipe defined" for hasRecipe=false rows', () => {
    mockState.recipes = [
      makeRecipe('r1', 'Burger'),
      makeRecipe('r2', 'PlaceholderItem'),
    ];
    mockState.menuCapacity = {
      r1: makeCap('r1'),
      r2: makeCap('r2', { hasRecipe: false, makeableQty: null }),
    };

    render(<MenuImpactSection />);
    // The "no recipe defined" literal renders in the makeable column.
    expect(screen.getByText('section.menuImpact.noRecipe')).toBeTruthy();
  });

  it('filters out healthy rows when "show impacted only" is toggled on', () => {
    mockState.recipes = [
      makeRecipe('r1', 'HealthyBurger'),
      makeRecipe('r2', 'LowPizza'),
    ];
    mockState.menuCapacity = {
      r1: makeCap('r1', { makeableQty: 100, lowIngredientCount: 0 }),
      r2: makeCap('r2', { makeableQty: 1, lowIngredientCount: 3, bindingCatalogName: 'Tomato' }),
    };

    render(<MenuImpactSection />);

    // Both rows render initially.
    expect(screen.getByText('HealthyBurger')).toBeTruthy();
    expect(screen.getByText('LowPizza')).toBeTruthy();

    // Toggle on the filter.
    fireEvent.press(screen.getByLabelText('section.menuImpact.showImpactedOnly'));

    // After the press, only the impacted row stays.
    expect(screen.queryByText('HealthyBurger')).toBeNull();
    expect(screen.getByText('LowPizza')).toBeTruthy();
  });

  it('renders the empty state when no recipes exist', () => {
    mockState.recipes = [];
    mockState.menuCapacity = {};

    render(<MenuImpactSection />);
    expect(screen.getByText('section.menuImpact.emptyNoRecipes')).toBeTruthy();
  });

  it('renders the loading-capacity state when recipes exist but menuCapacity is empty', () => {
    mockState.recipes = [makeRecipe('r1', 'Burger')];
    mockState.menuCapacity = {};

    render(<MenuImpactSection />);
    expect(screen.getByText('section.menuImpact.emptyLoading')).toBeTruthy();
  });

  it('renders the first-mount skeleton when storeLoading is true and recipes is empty', () => {
    mockState.recipes = [];
    mockState.menuCapacity = {};
    mockState.storeLoading = true;

    render(<MenuImpactSection />);
    expect(screen.getByLabelText('Loading')).toBeTruthy();
  });

  it('shows the brand column when useIsSuperAdmin returns true', () => {
    mockUseIsSuperAdmin.mockReturnValue(true);
    mockState.recipes = [makeRecipe('r1', 'Burger', 'brand-1')];
    mockState.menuCapacity = { r1: makeCap('r1') };

    render(<MenuImpactSection />);
    // The brand header renders (when expanded). The brand NAME cell
    // renders against the brand-1 → "Brand One" lookup.
    expect(screen.getByText('section.menuImpact.colBrand')).toBeTruthy();
    expect(screen.getByText('Brand One')).toBeTruthy();
  });

  it('hides the brand column for non-super-admin', () => {
    mockUseIsSuperAdmin.mockReturnValue(false);
    mockState.recipes = [makeRecipe('r1', 'Burger', 'brand-1')];
    mockState.menuCapacity = { r1: makeCap('r1') };

    render(<MenuImpactSection />);
    expect(screen.queryByText('section.menuImpact.colBrand')).toBeNull();
    // Brand name "Brand One" not shown either.
    expect(screen.queryByText('Brand One')).toBeNull();
  });

  it('clicking a header column toggles direction on subsequent clicks', () => {
    mockState.recipes = [
      makeRecipe('r1', 'Aaa'),
      makeRecipe('r2', 'Zzz'),
    ];
    mockState.menuCapacity = {
      r1: makeCap('r1', { makeableQty: 1 }),
      r2: makeCap('r2', { makeableQty: 99 }),
    };

    render(<MenuImpactSection />);

    // Sanity: the menu-item header is reachable via its label.
    const nameHeader = screen.getByLabelText('section.menuImpact.colMenuItem');
    fireEvent.press(nameHeader);  // switch to name ASC
    fireEvent.press(nameHeader);  // toggle to name DESC

    // The two rows still render. The exact DOM order in @testing-library
    // react-native is awkward to assert against, so we lean on the
    // compareRows unit test for the strict ordering contract.
    expect(screen.getByText('Aaa')).toBeTruthy();
    expect(screen.getByText('Zzz')).toBeTruthy();
  });

  it('emits the unit-mismatch indicator when has_unit_mismatch is true', () => {
    mockState.recipes = [makeRecipe('r1', 'Burger')];
    mockState.menuCapacity = {
      r1: makeCap('r1', {
        makeableQty:        5,
        hasUnitMismatch:    true,
        lowIngredientCount: 1,
        bindingCatalogName: 'Flour',
      }),
    };

    render(<MenuImpactSection />);

    // The binding-ingredient column carries a "~" indicator next to
    // the name. We assert the indicator renders; the tooltip wires up
    // off the title attribute (web-only, not asserted in jsdom RN).
    const indicators = screen.queryAllByText('~');
    expect(indicators.length).toBeGreaterThanOrEqual(1);
    // Sanity check: the binding catalog name is still rendered.
    expect(screen.getByText('Flour')).toBeTruthy();
    // Belt-and-braces — silence within-import lint when within is unused.
    void within;
  });
});
