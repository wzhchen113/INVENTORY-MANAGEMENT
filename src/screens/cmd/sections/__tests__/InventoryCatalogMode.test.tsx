// src/screens/cmd/sections/__tests__/InventoryCatalogMode.test.tsx
//
// Spec 049 — Cross-brand catalog copy negative-gate coverage (item 2 of
// the FIXES_NEEDED proposal).
//
// AC-N1 / AC-F3 require that admin / master / user roles do NOT see the
// cross-brand copy affordances on the Inventory > Ingredients section:
//   - the leftmost per-row checkbox column,
//   - the per-row "COPY" pill,
//   - the top-bar bulk "Copy N to brand…" pill.
//
// The gate at the JSX level is `useIsSuperAdmin()` ([src/hooks/useRole.ts]).
// Production behavior: each affordance is short-circuited on
// `isSuperAdmin = false`. These tests mock `useIsSuperAdmin` directly so
// we can flip the gate per test without seeding `profiles.role` through
// the entire store machinery.
//
// As a positive control we also render with `useIsSuperAdmin=true` and
// assert that the per-row checkbox appears (the bulk pill is selection-
// gated and stays hidden unless we click checkboxes — the per-row
// checkbox presence is sufficient to confirm the gate flips the affordance
// subtree on, distinguishing "gate works" from "tests pass for wrong
// reason").
//
// Boundary mocking matches RecipeCategoriesSection.test.tsx + the existing
// CopyToBrandDialog.test.tsx idiom:
//   - `react-native-toast-message` is the global stub in jest.setup.ts.
//   - `../../../theme/colors` — deterministic palette + radii tokens.
//   - `../../../hooks/useT` — key-echoing translator with {var} interp.
//   - `../../../hooks/useLocale` — pinned to 'en' for deterministic
//     localeCompare.
//   - `../../../hooks/useRole` — `useIsSuperAdmin` is per-test
//     controllable via the `setSuperAdmin` helper.
//   - `../../../store/useStore` — fixed snapshot with empty inventory /
//     vendors / categories so the list pane renders an empty-state
//     placeholder and the detail pane stays in its no-selection branch.
//   - Heavy child components (IngredientFormDrawer, ExportCsvDrawer,
//     CopyToBrandDialog, TabStrip, StatCard, etc.) are stubbed to
//     null/View so we don't drag in the full Cmd UI render tree.
//   - `../../../components/cmd/IngredientForm` exports both `SelectField`
//     and other helpers; we replace it with a minimal module.
//   - `../../../i18n/localizedName` — pass-through (returns `name` as-is)
//     so sort order is deterministic for the seeded inventory.

// ── Mocks (must precede any import of the component) ────────────────

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

// useIsSuperAdmin is the gate under test. Hook returns a jest.fn() that
// each test can override via mockReturnValue. Default = false (gated off)
// so the negative-gate assertions are the "is the affordance hidden by
// default?" baseline. Tests that want the positive-control branch call
// `mockUseIsSuperAdmin.mockReturnValue(true)` BEFORE the render.
const mockUseIsSuperAdmin = jest.fn(() => false);
jest.mock('../../../../hooks/useRole', () => ({
  useIsSuperAdmin: () => mockUseIsSuperAdmin(),
  useIsMaster: () => false,
  useRole: () => 'admin' as const,
}));

// useStore — fixed snapshot. Empty inventory so the list pane is in its
// empty-state branch (no rows render). Empty vendors / categories /
// stores. brand has a non-empty id so `sourceBrandId` is truthy for the
// positive-control branch. The component does NOT render the per-row
// checkbox column at all if there are no rows in `filtered`, so for the
// positive-control assertion we seed one inventory row.
jest.mock('../../../../store/useStore', () => {
  const state: any = {
    inventory: [],
    stores: [],
    vendors: [],
    ingredientCategories: [],
    ingredientConversions: [],
    catalogIngredients: [],
    recipeCategories: [],
    recipes: [],
    prepRecipes: [],
    auditLog: [],
    currentStore: { id: 'store-1' },
    currentUser: { id: 'user-1', role: 'admin' },
    brand: { id: 'brand-source' },
    getItemStatus: () => 'ok',
    deleteItem: jest.fn(),
    addItem: jest.fn(),
    updateItem: jest.fn(),
    addIngredientConversion: jest.fn(),
    updateIngredientConversion: jest.fn(),
    deleteIngredientConversion: jest.fn(),
    updateCatalogIngredient: jest.fn(),
    setCatalogI18nNames: jest.fn(),
    brandsList: [],
    loadBrandsList: jest.fn().mockResolvedValue(undefined),
  };
  const fn: any = jest.fn((selector: (s: any) => any) => selector(state));
  fn.getState = () => state;
  fn.__state = state;
  return { useStore: fn };
});

// i18n helpers — return inputs unchanged so we can match by raw text.
jest.mock('../../../../i18n/localizedName', () => ({
  getLocalizedName: (row: { name: string }) => row.name,
}));
jest.mock('../../../../i18n/matchesQuery', () => ({
  matchesQuery: () => true,
}));

// Stub heavy child components so we don't drag in their store reads /
// modal portals / etc. Each returns null when not visible (which is the
// default state for all of them in this test).
jest.mock('../../../../components/cmd/IngredientFormDrawer', () => ({
  IngredientFormDrawer: () => null,
}));
jest.mock('../../../../components/cmd/ExportCsvDrawer', () => ({
  ExportCsvDrawer: () => null,
}));
jest.mock('../../../../components/cmd/CopyToBrandDialog', () => ({
  CopyToBrandDialog: () => null,
}));
// IngredientForm exports SelectField (used in the detail pane only). The
// detail pane never mounts in this test because no row is selected, but
// the module is statically imported at the top of InventoryCatalogMode,
// so we stub the module to avoid pulling its useStore reads.
jest.mock('../../../../components/cmd/IngredientForm', () => ({
  SelectField: () => null,
  IngredientForm: () => null,
  blankValues: () => ({}),
  NEW_VENDOR_SENTINEL: '__new_vendor__',
  CUSTOM_UNIT_SENTINEL: '__custom__',
  CUSTOM_UNIT_MAX_LEN: 30,
  validateCustomUnit: () => ({ kind: 'ok' as const, label: '' }),
}));

// TabStrip / StatCard / PropertiesJson / ComingSoonPanel are only used
// inside the detail pane which doesn't mount in this test, but they're
// statically imported — stub to avoid theme / store coupling.
jest.mock('../../../../components/cmd/TabStrip', () => ({
  TabStrip: () => null,
}));
jest.mock('../../../../components/cmd/StatCard', () => ({
  StatCard: () => null,
}));
jest.mock('../../../../components/cmd/PropertiesJson', () => ({
  PropertiesJson: () => null,
}));
jest.mock('../../../../components/cmd/ComingSoonPanel', () => ({
  ComingSoonPanel: () => null,
}));

// ── Imports (resolve mocks above) ───────────────────────────────────
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react-native';
import InventoryCatalogMode from '../InventoryCatalogMode';
import { useStore } from '../../../../store/useStore';

const mockState = (useStore as any).__state as Record<string, any>;

function seedInventory(rows: Array<Partial<any>> = []) {
  // Provide minimal fields the component reads in the list-pane render
  // path. The component computes status/cost in the detail pane so the
  // shape we need here is bounded.
  mockState.inventory = rows.map((r, i) => ({
    id:            r.id            ?? `inv-${i}`,
    storeId:       r.storeId       ?? 'store-1',
    name:          r.name          ?? `Item ${i}`,
    category:      r.category      ?? 'produce',
    unit:          r.unit          ?? 'each',
    currentStock:  r.currentStock  ?? 0,
    parLevel:      r.parLevel      ?? 0,
    costPerUnit:   r.costPerUnit   ?? 0,
    catalogId:     r.catalogId     ?? `cat-${i}`,
    i18nNames:     r.i18nNames     ?? {},
    vendorId:      r.vendorId      ?? '',
    vendorName:    r.vendorName    ?? '',
    lastUpdatedAt: r.lastUpdatedAt ?? null,
    ...r,
  }));
}

beforeEach(() => {
  jest.clearAllMocks();
  mockUseIsSuperAdmin.mockReturnValue(false);
  seedInventory([]);
});

// ── Tests ───────────────────────────────────────────────────────────

describe('InventoryCatalogMode — cross-brand copy affordances gate (Spec 049)', () => {
  describe('when useIsSuperAdmin() returns false (admin / master / user)', () => {
    it('does NOT render the per-row checkbox or per-row COPY pill', () => {
      // Seed one inventory row so the list pane has a row that, in the
      // super-admin branch, would render the checkbox + COPY pill.
      seedInventory([{ id: 'inv-1', name: 'Tomato', catalogId: 'cat-1' }]);

      render(
        <InventoryCatalogMode
          selectedName={null}
          onSelectName={() => {}}
        />
      );

      // The row renders (the localized name is visible).
      expect(screen.getByText('Tomato')).toBeTruthy();
      // The checkbox accessibility label is keyed off
      // `dialog.copyToBrand.selectRowAria` — when the gate is off, the
      // entire checkbox subtree is null, so the label is absent.
      expect(screen.queryByLabelText('dialog.copyToBrand.selectRowAria')).toBeNull();
      // The per-row "COPY" pill literal text is absent.
      expect(screen.queryByText('COPY')).toBeNull();
      // The per-row "Copy to brand…" accessibility label (rowActionLabel)
      // is absent.
      expect(screen.queryByLabelText('dialog.copyToBrand.rowActionLabel')).toBeNull();
    });

    it('does NOT render the top-bar bulk pill (even when a selection set would otherwise be non-empty)', () => {
      // Without a row check available (the checkbox is gated off), there
      // is no way for the user to populate `selectedKeys` in the first
      // place. We assert the pill is absent on a no-selection mount —
      // which is the production state for any non-super-admin caller.
      seedInventory([{ id: 'inv-1', name: 'Tomato', catalogId: 'cat-1' }]);

      render(
        <InventoryCatalogMode
          selectedName={null}
          onSelectName={() => {}}
        />
      );

      // The bulk pill's accessibility label echoes the key `bulkPillIngredients`
      // with the count substituted in. We probe the key path itself —
      // present iff the pill rendered.
      expect(screen.queryByText(/dialog\.copyToBrand\.bulkPillIngredients/)).toBeNull();
    });
  });

  describe('when useIsSuperAdmin() returns true (positive control)', () => {
    it('DOES render the per-row checkbox and per-row COPY pill', () => {
      mockUseIsSuperAdmin.mockReturnValue(true);
      seedInventory([{ id: 'inv-1', name: 'Tomato', catalogId: 'cat-1' }]);

      render(
        <InventoryCatalogMode
          selectedName={null}
          onSelectName={() => {}}
        />
      );

      // Sanity-check: the row itself is in the tree.
      expect(screen.getByText('Tomato')).toBeTruthy();
      // The leftmost checkbox renders for the row (accessibilityLabel
      // resolves to the key path under the mocked useT).
      expect(screen.getByLabelText('dialog.copyToBrand.selectRowAria')).toBeTruthy();
      // The per-row COPY pill renders (literal text in the row).
      expect(screen.getByText('COPY')).toBeTruthy();
      // The accessibilityLabel for the per-row affordance also resolves.
      expect(screen.getByLabelText('dialog.copyToBrand.rowActionLabel')).toBeTruthy();
    });

    it('DOES render the top-bar bulk pill once the user picks a row', () => {
      mockUseIsSuperAdmin.mockReturnValue(true);
      seedInventory([{ id: 'inv-1', name: 'Tomato', catalogId: 'cat-1' }]);

      render(
        <InventoryCatalogMode
          selectedName={null}
          onSelectName={() => {}}
        />
      );

      // Initially no selection → no bulk pill.
      expect(
        screen.queryByText(/dialog\.copyToBrand\.bulkPillIngredients/),
      ).toBeNull();

      // Click the row checkbox to populate `selectedKeys`. We target it
      // by accessibility label since there's only one row's checkbox in
      // the tree. Pass a fake event object — the row handler calls
      // `e.stopPropagation?.()` so we need a non-undefined arg.
      fireEvent.press(
        screen.getByLabelText('dialog.copyToBrand.selectRowAria'),
        { stopPropagation: () => {} },
      );

      // Pill text appears (the {count}=1 is substituted in by the mock
      // useT, leaving the rest of the key path).
      expect(
        screen.getByText(/dialog\.copyToBrand\.bulkPillIngredients/),
      ).toBeTruthy();
    });
  });
});
