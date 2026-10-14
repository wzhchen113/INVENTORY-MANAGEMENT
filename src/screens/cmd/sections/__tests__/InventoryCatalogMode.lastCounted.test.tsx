// src/screens/cmd/sections/__tests__/InventoryCatalogMode.lastCounted.test.tsx
//
// catalog.tsv → ingredient.tsx: per-store LAST COUNTED column in the
// stores.tsv table + the "last counted at {store}" fragment on the hero meta
// line. Data comes from one `items_last_counted` RPC per store the selected
// ingredient lives in (db.fetchItemsLastCounted), cached per inventory
// snapshot.
//
// Mock shape mirrors InventoryCatalogMode.spec122.test.tsx. useT renders
// `key[var=value,…]` so assertions can see which store / value was passed.

jest.mock('../../../../theme/breakpoints', () => {
  const actual = jest.requireActual('../../../../theme/breakpoints');
  return { ...actual, useIsPhone: () => false };
});

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
  useT: () => (key: string, vars?: Record<string, string | number>) =>
    vars ? `${key}[${Object.entries(vars).map(([k, v]) => `${k}=${v}`).join(',')}]` : key,
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
    timezone: 'America/New_York',
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
  return { useStore: fn, notifyBackendError: jest.fn() };
});

jest.mock('../../../../lib/db', () => ({
  fetchItemsLastCounted: jest.fn(),
}));

jest.mock('../../../../i18n/localizedName', () => ({
  getLocalizedName: (row: { name: string }) => row.name,
}));
jest.mock('../../../../i18n/matchesQuery', () => ({ matchesQuery: () => true }));

jest.mock('../../../../components/cmd/IngredientFormDrawer', () => ({ IngredientFormDrawer: () => null }));
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
import { render, screen, waitFor } from '@testing-library/react-native';
import InventoryCatalogMode from '../InventoryCatalogMode';
import { useStore, notifyBackendError } from '../../../../store/useStore';
import * as db from '../../../../lib/db';

const mockState = (useStore as any).__state as Record<string, any>;
const fetchMock = db.fetchItemsLastCounted as jest.Mock;
const DAY_MS = 86_400_000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY_MS).toISOString();

beforeEach(() => {
  jest.clearAllMocks();
  mockState.inventory = [
    { id: 'inv-1', storeId: 'store-1', catalogId: 'cat-1', name: 'Macaroni Pasta', category: 'Condiments', unit: 'box', currentStock: 6, parLevel: 2, costPerUnit: 1.5, casePrice: 9, caseQty: 6, subUnitSize: 1, i18nNames: {}, vendorId: '', vendorName: '', lastUpdatedAt: null },
    { id: 'inv-2', storeId: 'store-2', catalogId: 'cat-1', name: 'Macaroni Pasta', category: 'Condiments', unit: 'box', currentStock: 6, parLevel: 2, costPerUnit: 1.5, casePrice: 9, caseQty: 6, subUnitSize: 1, i18nNames: {}, vendorId: '', vendorName: '', lastUpdatedAt: null },
  ];
});

const renderSelected = () =>
  render(<InventoryCatalogMode selectedName="macaroni pasta" onSelectName={() => {}} />);

describe('InventoryCatalogMode — per-store last counted', () => {
  it('fetches once per store and renders each store row with its own count age', async () => {
    fetchMock.mockImplementation(async (sid: string) =>
      sid === 'store-1'
        ? [{ itemId: 'inv-1', lastCountedAt: daysAgo(2) }]
        : [{ itemId: 'inv-2', lastCountedAt: null }],
    );
    renderSelected();

    expect(await screen.findByText(/· 2d$/)).toBeTruthy();
    expect(screen.getAllByText('section.inventory.neverCounted').length).toBeGreaterThan(0);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.map((c) => c[0]).sort()).toEqual(['store-1', 'store-2']);
  });

  it('names the most recently counted store on the hero meta line', async () => {
    fetchMock.mockImplementation(async (sid: string) =>
      sid === 'store-1'
        ? [{ itemId: 'inv-1', lastCountedAt: daysAgo(9) }]
        : [{ itemId: 'inv-2', lastCountedAt: daysAgo(1) }],
    );
    renderSelected();

    expect(await screen.findByText(/section\.inventory\.lastCountedAtStore\[store=Charles,value=.*· 1d\]/)).toBeTruthy();
  });

  it('tones a 7d+ count as stale (warn) and a never-counted row as danger', async () => {
    fetchMock.mockImplementation(async (sid: string) =>
      sid === 'store-1'
        ? [{ itemId: 'inv-1', lastCountedAt: daysAgo(10) }]
        : [{ itemId: 'inv-2', lastCountedAt: null }],
    );
    renderSelected();

    const stale = await screen.findByText(/· 10d$/);
    expect(stale.props.style).toEqual(expect.objectContaining({ color: '#854F0B' }));
    const never = screen.getAllByText('section.inventory.neverCounted').find((n) => n.props.style?.width === 110);
    expect(never?.props.style).toEqual(expect.objectContaining({ color: '#791F1F' }));
  });

  it('shows the — placeholder and no meta fragment while loading', () => {
    fetchMock.mockImplementation(() => new Promise(() => {}));
    renderSelected();

    expect(screen.getAllByLabelText('section.inventory.lastCountedLoading')).toHaveLength(2);
    expect(screen.queryByText(/lastCountedAtStore/)).toBeNull();
    expect(screen.queryByText('section.inventory.neverCounted')).toBeNull();
  });

  it('toasts once per failed store and does not retry on re-render', async () => {
    fetchMock.mockImplementation(async (sid: string) => {
      if (sid === 'store-1') throw new Error('permission denied');
      return [{ itemId: 'inv-2', lastCountedAt: daysAgo(3) }];
    });
    renderSelected();

    await waitFor(() => expect(notifyBackendError).toHaveBeenCalledTimes(1));
    expect(notifyBackendError).toHaveBeenCalledWith('Load last counted', expect.any(Error));
    expect(await screen.findByText(/· 3d$/)).toBeTruthy();
    // Failed store keeps the placeholder; the meta line stays hidden because
    // a store is unknown, not "never counted".
    expect(screen.getAllByLabelText('section.inventory.lastCountedLoading')).toHaveLength(1);
    expect(screen.queryByText(/lastCountedAtStore/)).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
