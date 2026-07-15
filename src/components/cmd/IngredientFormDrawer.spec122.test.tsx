// src/components/cmd/IngredientFormDrawer.spec122.test.tsx
//
// Spec 122 — catalog.tsv Save fans par/cost/case_price out to all brand
// stores; items.tsv Save stays single-store.
//
// Coverage:
//   - EDIT + `brandWide` Save calls BOTH `updateItem` (current store) AND
//     `applyScalarsToAllStores` with the parsed par/cost/case_price (AC-3/AC-7).
//   - The fan-out payload NEVER carries `current_stock` (AC-5/AC-6) —
//     structurally it can only ever be the three CONFIG scalars.
//   - EDIT WITHOUT `brandWide` (items.tsv) calls `updateItem` only — NO
//     fan-out (AC-13 regression guard).
//   - A blank par field maps to `null` (NULL-means-skip), not `0`, so a
//     cleared value never zeros every store.
//
// Boundary mocking: the store is a fixed snapshot; `ResponsiveSheet` is
// flattened so the footer SAVE button is reachable; `IngredientForm` and the
// side panes render null (their render tree is out of scope here — we only
// drive `handleSave`). `IngredientForm`'s pure helpers that the drawer imports
// at module scope (`blankValues` / `derivedUnitCost` / `vendorRowsToLinkPayload`
// / `addVendorLink`) are provided deterministically so `fromItem(item)` yields
// a known `values` snapshot.

// ── Mocks (must precede any import of the component) ────────────────

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
  useT: () => (key: string, vars?: Record<string, string | number>) => {
    if (!vars) return key;
    return Object.entries(vars).reduce(
      (acc, [k, v]) => acc.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v)),
      key,
    );
  },
}));

jest.mock('../../theme/breakpoints', () => ({
  useIsCompact: () => false,
  useIsPhone: () => false,
}));

// Store snapshot — the drawer reads these selectors. Fns are created INSIDE
// the factory (jest.mock is hoisted; external refs would hit the TDZ) and
// reached in tests via `useStore.getState()`. `applyScalarsToAllStores`
// resolves a summary so the success-toast branch is exercised.
jest.mock('../../store/useStore', () => {
  const state: any = {
    addItem: jest.fn(),
    updateItem: jest.fn(),
    applyVendorsToAllStores: jest.fn().mockResolvedValue(null),
    applyScalarsToAllStores: jest.fn().mockResolvedValue({
      updatedCount: 4,
      skippedCount: 1,
      skippedStoreIds: ['store-x'],
    }),
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

// Flatten ResponsiveSheet so header/children/footer render inline and the
// footer SAVE button is pressable.
jest.mock('./ResponsiveSheet', () => {
  const React = require('react');
  const { View } = require('react-native');
  return {
    ResponsiveSheet: ({ visible, header, footer, children }: any) =>
      visible ? React.createElement(View, null, header, children, footer) : null,
  };
});

// Deterministic IngredientForm module surface. `derivedUnitCost` returns a
// fixed string so `values.costPerUnit` is a known number in the fan-out.
jest.mock('./IngredientForm', () => ({
  IngredientForm: () => null,
  blankValues: () => ({
    name: '', category: '', unit: 'each',
    costPerUnit: '', parLevel: '', vendorName: '', vendorId: '',
    caseQty: '1', casePrice: '0', subUnitSize: '1', subUnitUnit: '',
    sku: 'auto', reorderPoint: '', max: '',
    countNightly: true, trackWaste: true, allowSubstitute: false,
    createAtAllStores: false,
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

// ── Imports (resolve mocks above) ───────────────────────────────────
import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react-native';
import { IngredientFormDrawer } from './IngredientFormDrawer';
import { useStore } from '../../store/useStore';
import type { InventoryItem } from '../../types';

const store = (useStore as any).getState();
const mockUpdateItem = store.updateItem as jest.Mock;
const mockApplyScalars = store.applyScalarsToAllStores as jest.Mock;

function makeItem(overrides: Partial<InventoryItem> = {}): InventoryItem {
  return {
    id: 'inv-1',
    storeId: 'store-1',
    catalogId: 'cat-1',
    name: 'Tomato',
    category: 'produce',
    unit: 'each',
    currentStock: 42,
    parLevel: 10,
    costPerUnit: 3.33,
    casePrice: 40,
    caseQty: 12,
    subUnitSize: 1,
    subUnitUnit: '',
    vendorId: '',
    vendorName: '',
    ...overrides,
  } as InventoryItem;
}

async function pressSave() {
  await act(async () => {
    fireEvent.press(screen.getByText('SAVE  ⌘S'));
    // let the fire-and-forget fan-out promise settle
    await Promise.resolve();
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  // clearAllMocks wipes the default resolved value — restore it.
  mockApplyScalars.mockResolvedValue({
    updatedCount: 4,
    skippedCount: 1,
    skippedStoreIds: ['store-x'],
  });
});

describe('IngredientFormDrawer — Spec 122 brand-wide Save fan-out', () => {
  it('brandWide EDIT Save calls updateItem AND applyScalarsToAllStores with par/cost/case_price', async () => {
    render(
      <IngredientFormDrawer visible mode="edit" item={makeItem()} brandWide onClose={() => {}} />,
    );
    await pressSave();

    // Current-store write still happens.
    expect(mockUpdateItem).toHaveBeenCalledTimes(1);
    expect(mockUpdateItem).toHaveBeenCalledWith('inv-1', expect.any(Object));

    // Fan-out fires with the three CONFIG scalars.
    expect(mockApplyScalars).toHaveBeenCalledTimes(1);
    expect(mockApplyScalars).toHaveBeenCalledWith('cat-1', {
      parLevel: 10,
      costPerUnit: 3.33,
      casePrice: 40,
    });
  });

  it('fan-out payload never carries current_stock or count-like fields', async () => {
    render(
      <IngredientFormDrawer visible mode="edit" item={makeItem()} brandWide onClose={() => {}} />,
    );
    await pressSave();

    const payload = mockApplyScalars.mock.calls[0][1];
    expect(Object.keys(payload).sort()).toEqual(['casePrice', 'costPerUnit', 'parLevel']);
    expect(payload).not.toHaveProperty('currentStock');
    expect(payload).not.toHaveProperty('expiryDate');
    expect(payload).not.toHaveProperty('usagePerPortion');
  });

  it('items.tsv EDIT Save (no brandWide) calls updateItem only — NO fan-out', async () => {
    render(
      <IngredientFormDrawer visible mode="edit" item={makeItem()} onClose={() => {}} />,
    );
    await pressSave();

    expect(mockUpdateItem).toHaveBeenCalledTimes(1);
    expect(mockApplyScalars).not.toHaveBeenCalled();
  });

  it('blank par field maps to null (NULL-means-skip), not 0', async () => {
    render(
      <IngredientFormDrawer
        visible
        mode="edit"
        // parLevel null → fromItem yields '' → scalarOrNull('') === null
        item={makeItem({ parLevel: null as unknown as number })}
        brandWide
        onClose={() => {}}
      />,
    );
    await pressSave();

    expect(mockApplyScalars).toHaveBeenCalledTimes(1);
    const payload = mockApplyScalars.mock.calls[0][1];
    expect(payload.parLevel).toBeNull();
    // cost/case_price still fan out (derived / seeded).
    expect(payload.costPerUnit).toBe(3.33);
    expect(payload.casePrice).toBe(40);
  });
});
