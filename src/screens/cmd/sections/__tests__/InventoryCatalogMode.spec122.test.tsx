// src/screens/cmd/sections/__tests__/InventoryCatalogMode.spec122.test.tsx
//
// Spec 122 (AC-1) — the catalog.tsv edit drawer seeds from the CURRENT store's
// inventory_items row, not the arbitrary `primary` (first-iterated) row, and
// falls back to `primary` when the current store has no row. It also passes
// `brandWide` so Save fans par/cost/case_price out to every brand store.
//
// The edit `IngredientFormDrawer` instance is mounted unconditionally (only
// its `visible` prop toggles), so we capture the `item` / `brandWide` props it
// receives on render — no need to drive the EDIT click through the TabStrip.
//
// Mock idiom mirrors InventoryCatalogMode.test.tsx (Spec 049): deterministic
// theme / translator / locale, a fixed store snapshot, and heavy children
// stubbed. `currentStore` is per-test controllable via the store snapshot.

// ── Mocks (must precede any import of the component) ────────────────

jest.mock('../../../../theme/colors', () => ({
  useCmdColors: () => ({
    bg: '#fff', panel: '#f4f4f4', panel2: '#eaeaea', border: '#ccc',
    borderStrong: '#888', fg: '#000', fg2: '#444', fg3: '#888',
    accent: '#185FA5', accentBg: '#E6F1FB', accentFg: '#fff',
    warn: '#854F0B', warnBg: '#FAEEDA', danger: '#791F1F', dangerBg: '#FCEBEB',
    ok: '#3B6D11', okBg: '#EAF3DE', info: '#185FA5', infoBg: '#E6F1FB',
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

jest.mock('../../../../hooks/useLocale', () => ({ useLocale: () => 'en' }));

jest.mock('../../../../hooks/useRole', () => ({
  useIsSuperAdmin: () => false,
  useIsMaster: () => false,
  useRole: () => 'admin' as const,
}));

jest.mock('../../../../store/useStore', () => {
  const state: any = {
    inventory: [],
    stores: [
      { id: 'store-1', name: 'Frederick', brandId: 'brand-1' },
      { id: 'store-2', name: 'Charles', brandId: 'brand-1' },
    ],
    vendors: [],
    ingredientCategories: [],
    ingredientConversions: [],
    catalogIngredients: [],
    recipeCategories: [],
    recipes: [],
    prepRecipes: [],
    auditLog: [],
    currentStore: { id: 'store-2', name: 'Charles', brandId: 'brand-1' },
    currentUser: { id: 'user-1', role: 'admin' },
    brand: { id: 'brand-1' },
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

jest.mock('../../../../i18n/localizedName', () => ({
  getLocalizedName: (row: { name: string }) => row.name,
}));
jest.mock('../../../../i18n/matchesQuery', () => ({ matchesQuery: () => true }));

// Capture the props passed to the edit IngredientFormDrawer instance.
const drawerCalls: Array<{ mode: string; item: any; brandWide: any; visible: boolean }> = [];
jest.mock('../../../../components/cmd/IngredientFormDrawer', () => ({
  IngredientFormDrawer: (props: any) => {
    drawerCalls.push({
      mode: props.mode,
      item: props.item,
      brandWide: props.brandWide,
      visible: props.visible,
    });
    return null;
  },
}));

jest.mock('../../../../components/cmd/ExportCsvDrawer', () => ({ ExportCsvDrawer: () => null }));
jest.mock('../../../../components/cmd/CopyToBrandDialog', () => ({ CopyToBrandDialog: () => null }));
jest.mock('../../../../components/cmd/IngredientForm', () => ({
  SelectField: () => null,
  IngredientForm: () => null,
  blankValues: () => ({}),
}));
jest.mock('../../../../components/cmd/TabStrip', () => ({ TabStrip: () => null }));
jest.mock('../../../../components/cmd/StatCard', () => ({ StatCard: () => null }));
jest.mock('../../../../components/cmd/StatusPill', () => ({ StatusPill: () => null }));
jest.mock('../../../../components/cmd/StatusDot', () => ({ StatusDot: () => null }));
jest.mock('../../../../components/cmd/PropertiesJson', () => ({ PropertiesJson: () => null }));
jest.mock('../../../../components/cmd/SectionCaption', () => ({ SectionCaption: () => null }));
jest.mock('../../../../components/cmd/ComingSoonPanel', () => ({ ComingSoonPanel: () => null }));

// ── Imports (resolve mocks above) ───────────────────────────────────
import React from 'react';
import { render } from '@testing-library/react-native';
import InventoryCatalogMode from '../InventoryCatalogMode';
import { useStore } from '../../../../store/useStore';

const mockState = (useStore as any).__state as Record<string, any>;

function seedTwoStores() {
  // Same lowercase name → one catalog group; two per-store rows. `primary`
  // is the FIRST iterated (Frederick / store-1), which is NOT the current
  // store (Charles / store-2) — the exact wrong-store repro shape.
  mockState.inventory = [
    { id: 'inv-1', storeId: 'store-1', catalogId: 'cat-1', name: 'Corn On Cob', category: 'produce', unit: 'each', currentStock: 5, parLevel: 480, costPerUnit: 1, casePrice: 40, caseQty: 12, subUnitSize: 1, i18nNames: {}, vendorId: '', vendorName: '', lastUpdatedAt: null },
    { id: 'inv-2', storeId: 'store-2', catalogId: 'cat-1', name: 'Corn On Cob', category: 'produce', unit: 'each', currentStock: 3, parLevel: 4, costPerUnit: 1, casePrice: 40, caseQty: 12, subUnitSize: 1, i18nNames: {}, vendorId: '', vendorName: '', lastUpdatedAt: null },
  ];
}

function editDrawerProps() {
  return drawerCalls.filter((c) => c.mode === 'edit').slice(-1)[0];
}

beforeEach(() => {
  jest.clearAllMocks();
  drawerCalls.length = 0;
  seedTwoStores();
});

describe('InventoryCatalogMode — Spec 122 current-store binding (AC-1)', () => {
  it('seeds the edit drawer from the CURRENT store row, not primary', () => {
    mockState.currentStore = { id: 'store-2', name: 'Charles', brandId: 'brand-1' };
    render(<InventoryCatalogMode selectedName="corn on cob" onSelectName={() => {}} />);

    const edit = editDrawerProps();
    expect(edit).toBeTruthy();
    // Current store = Charles/store-2 → binds inv-2 (par 4), NOT primary inv-1.
    expect(edit.item.id).toBe('inv-2');
    expect(edit.item.storeId).toBe('store-2');
    // Save from catalog.tsv is brand-wide.
    expect(edit.brandWide).toBe(true);
  });

  it('falls back to primary when the current store has no row for the ingredient', () => {
    mockState.currentStore = { id: 'store-3', name: 'Elsewhere', brandId: 'brand-1' };
    render(<InventoryCatalogMode selectedName="corn on cob" onSelectName={() => {}} />);

    const edit = editDrawerProps();
    expect(edit).toBeTruthy();
    // No store-3 row → deterministic fallback to primary (inv-1).
    expect(edit.item.id).toBe('inv-1');
  });
});
