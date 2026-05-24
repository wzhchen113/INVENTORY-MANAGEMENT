// src/components/cmd/MenuCapacityBadge.test.tsx — Spec 060 frontend.
//
// Component-project (jsdom) tests for the inline per-recipe capacity
// pill rendered inside RecipesSection's list row. Six render paths
// per the architect's contract (spec §A "Inline badge in RecipesSection"):
//
//   1. row missing from slice            → renders nothing (no flicker)
//   2. hasRecipe=false                   → "no recipe defined" literal
//   3. makeableQty=0                     → red pill, accessibility says insufficient
//   4. makeableQty>0 && lowCount>0       → amber pill, accessibility says low
//   5. makeableQty>0 && lowCount===0     → neutral mono number, no pill
//   6. hasUnitMismatch / truncated       → "~" prefix / "?" suffix on the number
//
// Boundary mocking pattern mirrors StatusPill.test.tsx + the
// CopyToBrandDialog test (mock useCmdColors, mock useT, mock useStore).

jest.mock('../../theme/colors', () => ({
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

// useT — key-echoing with {var} interpolation. Same shape as the
// CopyToBrandDialog test.
jest.mock('../../hooks/useT', () => ({
  useT: () => (key: string, vars?: Record<string, string | number>) => {
    if (!vars) return key;
    return Object.entries(vars).reduce(
      (acc, [k, v]) => acc.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v)),
      key,
    );
  },
}));

// useStore — selector-style mock returning a configurable slice. Each
// test reseeds via `seedCapacity({...})` so the component re-renders
// with the desired row shape.
jest.mock('../../store/useStore', () => {
  const state: any = { menuCapacity: {} as Record<string, any> };
  const fn: any = jest.fn((selector: (s: any) => any) => selector(state));
  fn.getState = () => state;
  fn.__state = state;
  return { useStore: fn };
});

// ── Imports (resolve mocks above) ───────────────────────────────────
import React from 'react';
import { render, screen } from '@testing-library/react-native';
import { MenuCapacityBadge } from './MenuCapacityBadge';
import { useStore } from '../../store/useStore';

const mockState = (useStore as any).__state as { menuCapacity: Record<string, any> };

function seedCapacity(recipeId: string, row: any) {
  mockState.menuCapacity = { ...mockState.menuCapacity, [recipeId]: row };
}

function resetCapacity() {
  mockState.menuCapacity = {};
}

const baseRow = {
  recipeId:           'r1',
  storeId:            'store-1',
  hasRecipe:          true,
  makeableQty:        5,
  bindingCatalogId:   null,
  bindingCatalogName: null,
  bindingShortfall:   null,
  lowIngredientCount: 0,
  hasUnitMismatch:    false,
  truncated:          false,
};

beforeEach(() => {
  resetCapacity();
});

describe('MenuCapacityBadge', () => {
  it('renders nothing when the menuCapacity slice has no row for the recipe', () => {
    const { toJSON } = render(<MenuCapacityBadge recipeId="r1" />);
    expect(toJSON()).toBeNull();
  });

  it('renders the "no recipe defined" literal when hasRecipe is false', () => {
    seedCapacity('r1', { ...baseRow, hasRecipe: false, makeableQty: null });
    render(<MenuCapacityBadge recipeId="r1" />);
    expect(screen.getByText('component.menuCapacityBadge.noRecipe')).toBeTruthy();
    expect(
      screen.getByLabelText('component.menuCapacityBadge.noRecipeAria'),
    ).toBeTruthy();
  });

  it('renders the "unknown" sentinel when hasRecipe but makeableQty is null', () => {
    seedCapacity('r1', { ...baseRow, hasRecipe: true, makeableQty: null });
    render(<MenuCapacityBadge recipeId="r1" />);
    expect(screen.getByText('component.menuCapacityBadge.unknown')).toBeTruthy();
    expect(
      screen.getByLabelText('component.menuCapacityBadge.unknownAria'),
    ).toBeTruthy();
  });

  it('renders the makeable quantity in neutral text when capacity is healthy', () => {
    seedCapacity('r1', { ...baseRow, makeableQty: 7, lowIngredientCount: 0 });
    render(<MenuCapacityBadge recipeId="r1" />);
    expect(screen.getByText('7')).toBeTruthy();
    // Accessibility label = "can make 7" (with the {count} interpolated)
    expect(
      screen.getByLabelText('component.menuCapacityBadge.canMake'.replace('{count}', '7') + ''),
    ).toBeTruthy();
  });

  it('renders the amber low-pill state when makeableQty > 0 and a touched ingredient is low', () => {
    seedCapacity('r1', { ...baseRow, makeableQty: 3, lowIngredientCount: 2 });
    render(<MenuCapacityBadge recipeId="r1" />);
    expect(screen.getByText('3')).toBeTruthy();
    // The accessibility label appends the lowAria phrase after " — ".
    const expectedAria =
      'can make 3 — component.menuCapacityBadge.lowAria'
        .replace(/can make 3/, 'component.menuCapacityBadge.canMake');
    // Easier: use a regex match instead of exact string.
    expect(
      screen.getByLabelText(/component\.menuCapacityBadge\.lowAria/),
    ).toBeTruthy();
    void expectedAria;
  });

  it('renders the red zero-pill state when makeableQty === 0', () => {
    seedCapacity('r1', { ...baseRow, makeableQty: 0, lowIngredientCount: 0 });
    render(<MenuCapacityBadge recipeId="r1" />);
    expect(screen.getByText('0')).toBeTruthy();
    expect(
      screen.getByLabelText(/component\.menuCapacityBadge\.insufficientAria/),
    ).toBeTruthy();
  });

  it('prepends "~" when hasUnitMismatch is true', () => {
    seedCapacity('r1', { ...baseRow, makeableQty: 5, hasUnitMismatch: true });
    render(<MenuCapacityBadge recipeId="r1" />);
    expect(screen.getByText('~5')).toBeTruthy();
    expect(
      screen.getByLabelText(/component\.menuCapacityBadge\.unitMismatchAria/),
    ).toBeTruthy();
  });

  it('appends "?" when truncated is true', () => {
    seedCapacity('r1', { ...baseRow, makeableQty: 5, truncated: true });
    render(<MenuCapacityBadge recipeId="r1" />);
    expect(screen.getByText('5?')).toBeTruthy();
    expect(
      screen.getByLabelText(/component\.menuCapacityBadge\.truncatedAria/),
    ).toBeTruthy();
  });

  it('combines "~" prefix and "?" suffix when both flags fire', () => {
    seedCapacity('r1', {
      ...baseRow,
      makeableQty: 5,
      hasUnitMismatch: true,
      truncated: true,
    });
    render(<MenuCapacityBadge recipeId="r1" />);
    expect(screen.getByText('~5?')).toBeTruthy();
  });

  it('renders the floor of fractional makeableQty values', () => {
    // The RPC may emit non-integer values when capacity math divides
    // through; the badge displays whole menu items, so floor() in the
    // component.
    seedCapacity('r1', { ...baseRow, makeableQty: 3.7 });
    render(<MenuCapacityBadge recipeId="r1" />);
    expect(screen.getByText('3')).toBeTruthy();
  });
});
