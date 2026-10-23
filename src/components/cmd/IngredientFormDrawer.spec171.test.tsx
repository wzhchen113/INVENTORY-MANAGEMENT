// src/components/cmd/IngredientFormDrawer.spec171.test.tsx — Spec 171 (AC-18).
//
// The drawer threads the brand-level EOD count mode through BOTH write paths:
//   - EDIT → `updateItem(id, toUpdates(values))` carries `eodCountMode`, which
//     db.updateInventoryItem maps to `catalogUpdates.eod_count_mode`
//     (db.eodCountMode.test.ts pins that hop);
//   - NEW → `addItem({...})` carries `eodCountMode`, which db.createInventoryItem
//     sends as `p_eod_count_mode` on create_inventory_item_with_catalog.
// `fromItem` hydrates the stored mode so an untouched EDIT round-trips it, and
// the stored mode is sent as-is (never normalized against the case size, N2).
//
// Boundary mocking mirrors IngredientFormDrawer.spec122.test.tsx, except the
// IngredientForm mock CAPTURES its props so the test can drive `onChange` the
// way the real form's "EOD count" SelectField does.

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

jest.mock('../../store/useStore', () => {
  const state: any = {
    addItem: jest.fn(),
    updateItem: jest.fn(),
    applyVendorsToAllStores: jest.fn().mockResolvedValue(null),
    applyScalarsToAllStores: jest.fn().mockResolvedValue(null),
    stores: [{ id: 'store-1', brandId: 'brand-1' }],
    currentStore: { id: 'store-1', brandId: 'brand-1' },
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

// Capture the latest props the drawer hands the form so a test can drive
// `onChange` exactly like the real control does. `blankValues` is the REAL one
// (it carries the spec-171 default) via requireActual.
const mockFormProps: { current: any } = { current: null };
jest.mock('./IngredientForm', () => {
  const actual = jest.requireActual('./IngredientForm');
  return {
    ...actual,
    IngredientForm: (props: any) => {
      mockFormProps.current = props;
      return null;
    },
  };
});

jest.mock('./VendorFormDrawer', () => ({ VendorFormDrawer: () => null }));
jest.mock('./JsonPreview', () => ({ JsonPreview: () => null }));
jest.mock('./AuditHistory', () => ({ AuditHistory: () => null }));
jest.mock('../../lib/supabase', () => ({ __esModule: true, supabase: {} }));
jest.mock('../../lib/translate', () => ({
  translateOnSave: jest.fn(() => Promise.resolve({ data: null, error: null })),
}));

import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react-native';
import { IngredientFormDrawer } from './IngredientFormDrawer';
import { useStore } from '../../store/useStore';
import type { InventoryItem } from '../../types';

const store = (useStore as any).getState();
const mockUpdateItem = store.updateItem as jest.Mock;
const mockAddItem = store.addItem as jest.Mock;

function makeItem(overrides: Partial<InventoryItem> = {}): InventoryItem {
  return {
    id: 'inv-1',
    storeId: 'store-1',
    catalogId: 'cat-1',
    name: 'Lettuce Iceberg',
    category: 'produce',
    unit: 'each',
    currentStock: 0,
    parLevel: 2,
    costPerUnit: 1,
    casePrice: 24,
    caseQty: 24,
    subUnitSize: 1,
    subUnitUnit: '',
    vendorId: '',
    vendorName: '',
    ...overrides,
  } as InventoryItem;
}

function changeForm(patch: Record<string, unknown>) {
  act(() => {
    const p = mockFormProps.current;
    p.onChange({ ...p.values, ...patch });
  });
}

async function press(label: string) {
  await act(async () => {
    fireEvent.press(screen.getByText(label));
    await Promise.resolve();
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockFormProps.current = null;
});

describe('IngredientFormDrawer — spec 171 EOD count mode (AC-18)', () => {
  it('EDIT hydrates the stored mode into the form and round-trips it unchanged', async () => {
    render(<IngredientFormDrawer visible mode="edit" item={makeItem({ eodCountMode: 'units_only' })} onClose={() => {}} />);
    expect(mockFormProps.current.values.eodCountMode).toBe('units_only');
    await press('SAVE  ⌘S');
    expect(mockUpdateItem).toHaveBeenCalledWith('inv-1', expect.objectContaining({ eodCountMode: 'units_only' }));
  });

  it('EDIT with a changed mode sends the new mode through updateItem', async () => {
    render(<IngredientFormDrawer visible mode="edit" item={makeItem()} onClose={() => {}} />);
    // An item with no hydrated mode reads as the default.
    expect(mockFormProps.current.values.eodCountMode).toBe('cases_and_units');
    changeForm({ eodCountMode: 'cases_only' });
    await press('SAVE  ⌘S');
    expect(mockUpdateItem).toHaveBeenCalledWith('inv-1', expect.objectContaining({ eodCountMode: 'cases_only' }));
  });

  it('EDIT does not normalize the stored mode against a case size <= 1 (N2)', async () => {
    render(
      <IngredientFormDrawer visible mode="edit" item={makeItem({ caseQty: 1, eodCountMode: 'cases_only' })} onClose={() => {}} />,
    );
    await press('SAVE  ⌘S');
    expect(mockUpdateItem).toHaveBeenCalledWith(
      'inv-1',
      expect.objectContaining({ caseQty: 1, eodCountMode: 'cases_only' }),
    );
  });

  it('NEW with a non-default mode passes it to addItem (→ p_eod_count_mode)', async () => {
    render(<IngredientFormDrawer visible mode="new" onClose={() => {}} />);
    changeForm({ name: 'Lettuce Iceberg', category: 'produce', unit: 'each', caseQty: '24', eodCountMode: 'cases_only' });
    await press('CREATE  ⌘⏎');
    expect(mockAddItem).toHaveBeenCalledTimes(1);
    expect(mockAddItem).toHaveBeenCalledWith(expect.objectContaining({ eodCountMode: 'cases_only', caseQty: 24 }));
  });

  it('NEW left at the default sends cases_and_units', async () => {
    render(<IngredientFormDrawer visible mode="new" onClose={() => {}} />);
    changeForm({ name: 'Salt', category: 'dry', unit: 'each' });
    await press('CREATE  ⌘⏎');
    expect(mockAddItem).toHaveBeenCalledWith(expect.objectContaining({ eodCountMode: 'cases_and_units' }));
  });
});
