// src/components/cmd/IngredientFormDrawer.storeScope.test.tsx
//
// Ingredient Save store-scope picker (This store / All stores / Pick stores).
//
// Coverage:
//   - items.tsv EDIT defaults to "This store": updateItem only, no fan-out.
//   - catalog.tsv EDIT (`brandWide`) defaults to "All stores": fan-out with no
//     store list (spec 122 call shape preserved).
//   - Switching to "All stores" from items.tsv fans out.
//   - "Pick stores" that EXCLUDES this store strips par/cost/case_price from
//     the edited row's write and fans out to just the picked ids.
//   - "Pick stores" with nothing ticked refuses to save.
//   - NEW mode creates one row per picked store.
//   - resolveScopeStoreIds pure helper.
//
// Mock layout mirrors IngredientFormDrawer.spec122.test.tsx; the store snapshot
// carries THREE brand stores (+ one other-brand store) so the picker renders.

jest.mock('../../theme/colors', () => ({
  useCmdColors: () => ({
    bg: '#fff', panel: '#f4f4f4', panel2: '#eaeaea', border: '#ccc',
    borderStrong: '#888', fg: '#000', fg2: '#444', fg3: '#888',
    accent: '#185FA5', accentBg: '#E6F1FB', accentFg: '#fff',
    warn: '#854F0B', warnBg: '#FAEEDA', danger: '#791F1F', dangerBg: '#FCEBEB',
  }),
  CmdRadius: { xs: 3, sm: 4, md: 5, lg: 6 },
}));

jest.mock('../../hooks/useT', () => ({
  useT: () => (key: string) => key,
}));

jest.mock('../../theme/breakpoints', () => ({
  useIsCompact: () => false,
  useIsPhone: () => false,
}));

jest.mock('react-native-toast-message', () => ({
  __esModule: true,
  default: { show: jest.fn() },
}));

jest.mock('../../store/useStore', () => {
  const state: any = {
    addItem: jest.fn(),
    updateItem: jest.fn(),
    applyVendorsToAllStores: jest.fn().mockResolvedValue(null),
    applyScalarsToAllStores: jest.fn().mockResolvedValue({ updatedCount: 1, skippedCount: 0, skippedStoreIds: [] }),
    stores: [
      { id: 'store-1', brandId: 'brand-1', name: 'Towson' },
      { id: 'store-2', brandId: 'brand-1', name: 'Charles' },
      { id: 'store-3', brandId: 'brand-1', name: 'Frederick' },
      { id: 'store-9', brandId: 'brand-2', name: 'Elsewhere' },
    ],
    currentStore: { id: 'store-1', brandId: 'brand-1', name: 'Towson' },
    vendors: [],
    catalogIngredients: [{ id: 'cat-1', defaultShelfLifeDays: null, i18nNames: {} }],
    updateCatalogIngredient: jest.fn(),
    setCatalogI18nNames: jest.fn(),
  };
  const fn: any = jest.fn((selector: (s: any) => any) => selector(state));
  fn.getState = () => state;
  return { useStore: fn };
});

jest.mock('./ResponsiveSheet', () => {
  const React = require('react');
  const { View } = require('react-native');
  return {
    ResponsiveSheet: ({ visible, header, footer, children }: any) =>
      visible ? React.createElement(View, null, header, children, footer) : null,
  };
});

// NEW-mode values come from blankValues; give them a valid name/category/unit
// so handleSave reaches the create loop.
jest.mock('./IngredientForm', () => ({
  IngredientForm: () => null,
  blankValues: () => ({
    name: 'Basil', category: 'produce', unit: 'each',
    costPerUnit: '', parLevel: '', vendorName: '', vendorId: '',
    caseQty: '1', casePrice: '0', subUnitSize: '1', subUnitUnit: '',
    sku: 'auto', reorderPoint: '', max: '',
    countNightly: true, trackWaste: true, allowSubstitute: false,
    defaultShelfLifeDays: '', expiryDate: '',
    nameEs: '', nameZh: '',
    vendors: [],
  }),
  derivedUnitCost: () => '3.33',
  vendorRowsToLinkPayload: (rows: any[]) => rows ?? [],
  addVendorLink: (rows: any[]) => rows ?? [],
}));

jest.mock('./VendorFormDrawer', () => ({ VendorFormDrawer: () => null }));
jest.mock('./JsonPreview', () => ({ JsonPreview: () => null }));
jest.mock('./AuditHistory', () => ({ AuditHistory: () => null }));

import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react-native';
import Toast from 'react-native-toast-message';
import { IngredientFormDrawer } from './IngredientFormDrawer';
import { resolveScopeStoreIds } from './StoreScopePicker';
import { useStore } from '../../store/useStore';
import type { InventoryItem } from '../../types';

const store = (useStore as any).getState();
const mockUpdateItem = store.updateItem as jest.Mock;
const mockAddItem = store.addItem as jest.Mock;
const mockApplyScalars = store.applyScalarsToAllStores as jest.Mock;
const mockToast = (Toast as any).show as jest.Mock;

function makeItem(overrides: Partial<InventoryItem> = {}): InventoryItem {
  return {
    id: 'inv-1', storeId: 'store-1', catalogId: 'cat-1',
    name: 'Tomato', category: 'produce', unit: 'each',
    currentStock: 42, parLevel: 10, costPerUnit: 3.33, casePrice: 40,
    caseQty: 12, subUnitSize: 1, subUnitUnit: '', vendorId: '', vendorName: '',
    ...overrides,
  } as InventoryItem;
}

async function press(label: string) {
  await act(async () => {
    fireEvent.press(screen.getByLabelText(label));
  });
}

async function pressText(text: string) {
  await act(async () => {
    fireEvent.press(screen.getByText(text));
    await Promise.resolve();
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockApplyScalars.mockResolvedValue({ updatedCount: 1, skippedCount: 0, skippedStoreIds: [] });
});

describe('IngredientFormDrawer — store scope picker', () => {
  it('items.tsv EDIT defaults to "This store": writes this row, no fan-out', async () => {
    render(<IngredientFormDrawer visible mode="edit" item={makeItem()} onClose={() => {}} />);
    expect(screen.getByLabelText('section.inventory.storeScopeThisNamed').props.accessibilityState).toEqual({ selected: true });

    await pressText('SAVE  ⌘S');

    expect(mockUpdateItem).toHaveBeenCalledTimes(1);
    expect(mockUpdateItem.mock.calls[0][1]).toMatchObject({ parLevel: 10, casePrice: 40 });
    expect(mockApplyScalars).not.toHaveBeenCalled();
  });

  it('catalog.tsv EDIT defaults to "All stores": fan-out with no store list', async () => {
    render(<IngredientFormDrawer visible mode="edit" item={makeItem()} brandWide onClose={() => {}} />);
    await pressText('SAVE  ⌘S');

    expect(mockUpdateItem).toHaveBeenCalledTimes(1);
    expect(mockApplyScalars).toHaveBeenCalledTimes(1);
    expect(mockApplyScalars.mock.calls[0]).toHaveLength(2);
    expect(mockApplyScalars).toHaveBeenCalledWith('cat-1', { parLevel: 10, costPerUnit: 3.33, casePrice: 40 });
  });

  it('switching items.tsv EDIT to "All stores" fans out', async () => {
    render(<IngredientFormDrawer visible mode="edit" item={makeItem()} onClose={() => {}} />);
    await press('section.inventory.storeScopeAll');
    await pressText('SAVE  ⌘S');

    expect(mockApplyScalars).toHaveBeenCalledTimes(1);
    expect(mockApplyScalars.mock.calls[0]).toHaveLength(2);
  });

  it('"Pick stores" excluding this store strips par/cost/case from this row and fans out to the picked ids', async () => {
    render(<IngredientFormDrawer visible mode="edit" item={makeItem()} onClose={() => {}} />);
    await press('section.inventory.storeScopePick');
    // Towson (this store) starts ticked — untick it, tick Charles + Frederick.
    await press('Towson');
    await press('Charles');
    await press('Frederick');
    // Other-brand stores are never offered.
    expect(screen.queryByLabelText('Elsewhere')).toBeNull();

    await pressText('SAVE  ⌘S');

    expect(mockUpdateItem).toHaveBeenCalledTimes(1);
    const updates = mockUpdateItem.mock.calls[0][1];
    expect(updates).not.toHaveProperty('parLevel');
    expect(updates).not.toHaveProperty('costPerUnit');
    expect(updates).not.toHaveProperty('casePrice');
    expect(updates).toMatchObject({ name: 'Tomato' });

    expect(mockApplyScalars).toHaveBeenCalledWith(
      'cat-1',
      { parLevel: 10, costPerUnit: 3.33, casePrice: 40 },
      ['store-2', 'store-3'],
    );
  });

  it('"Pick stores" with only this store ticked behaves like "This store"', async () => {
    render(<IngredientFormDrawer visible mode="edit" item={makeItem()} onClose={() => {}} />);
    await press('section.inventory.storeScopePick');
    await pressText('SAVE  ⌘S');

    expect(mockUpdateItem.mock.calls[0][1]).toMatchObject({ parLevel: 10 });
    expect(mockApplyScalars).not.toHaveBeenCalled();
  });

  it('"Pick stores" with nothing ticked refuses to save', async () => {
    const onClose = jest.fn();
    render(<IngredientFormDrawer visible mode="edit" item={makeItem()} onClose={onClose} />);
    await press('section.inventory.storeScopePick');
    await press('Towson');
    await pressText('SAVE  ⌘S');

    expect(mockUpdateItem).not.toHaveBeenCalled();
    expect(mockApplyScalars).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(mockToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error', text1: 'section.inventory.storeScopeEmptyError' }));
  });

  it('NEW mode creates one row per picked store', async () => {
    render(<IngredientFormDrawer visible mode="new" onClose={() => {}} />);
    await press('section.inventory.storeScopePick');
    await press('Frederick');
    await pressText('CREATE  ⌘⏎');

    expect(mockAddItem).toHaveBeenCalledTimes(2);
    expect(mockAddItem.mock.calls.map((c) => c[0].storeId)).toEqual(['store-1', 'store-3']);
  });

  it('NEW mode "All stores" creates at every store of the brand only', async () => {
    render(<IngredientFormDrawer visible mode="new" onClose={() => {}} />);
    await press('section.inventory.storeScopeAll');
    await pressText('CREATE  ⌘⏎');

    expect(mockAddItem.mock.calls.map((c) => c[0].storeId)).toEqual(['store-1', 'store-2', 'store-3']);
  });
});

describe('resolveScopeStoreIds', () => {
  const brand = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  it('this → just the self store', () => {
    expect(resolveScopeStoreIds({ mode: 'this', storeIds: ['b'] }, brand, 'a')).toEqual(['a']);
  });
  it('all → every brand store, keeping self even if missing from the list', () => {
    expect(resolveScopeStoreIds({ mode: 'all', storeIds: [] }, brand, 'a')).toEqual(['a', 'b', 'c']);
    expect(resolveScopeStoreIds({ mode: 'all', storeIds: [] }, brand, 'z')).toEqual(['z', 'a', 'b', 'c']);
  });
  it('pick → ticked ids in brand order, dropping ids that are not brand stores', () => {
    expect(resolveScopeStoreIds({ mode: 'pick', storeIds: ['c', 'x', 'a'] }, brand, 'a')).toEqual(['a', 'c']);
  });
});
