// src/screens/cmd/sections/phone/__tests__/PhoneInventory.acReg.test.tsx
//
// Spec 142 §6.3 (AC-REG1) — the phone Inventory surfaces are pure additive
// guards. With isPhone false (desktop AND tablet), the existing desktop tree
// renders and the phone component is absent; with isPhone true, only the phone
// component renders and the desktop chrome (items.tsv / ingredient.tsx tab
// strips) is gone. Pins that the guard is the sole behavioral fork for both
// InventoryDesktopLayout (per-store) and InventoryCatalogMode.

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

jest.mock('../../../../../lib/db', () =>
  new Proxy({ __esModule: true }, { get: (t: Record<string, unknown>, p: string) => (p in t ? (t as any)[p] : jest.fn(() => Promise.resolve(null))) }),
);

let mockTier: 'phone' | 'tablet' | 'desktop' = 'desktop';
jest.mock('../../../../../theme/breakpoints', () => {
  const actual = jest.requireActual('../../../../../theme/breakpoints');
  return {
    ...actual,
    useIsPhone: () => mockTier === 'phone',
    useIsTablet: () => mockTier === 'tablet',
    useIsDesktop: () => mockTier === 'desktop',
    useIsCompact: () => mockTier !== 'desktop',
    useBreakpoint: () => mockTier,
  };
});

import InventoryDesktopLayout from '../../../InventoryDesktopLayout';
import InventoryCatalogMode from '../../InventoryCatalogMode';
import { useStore } from '../../../../../store/useStore';
import { setLastInventoryViewMode } from '../../../lib/inventoryViewMode';

function mkItem(over: Partial<any>): any {
  return {
    id: over.id, catalogId: over.id, name: over.name ?? 'Olive Oil', category: over.category ?? 'Pantry',
    unit: 'lbs', costPerUnit: 2, currentStock: 50, parLevel: 40, averageDailyUsage: 5, safetyStock: 0,
    vendorId: 'v1', vendorName: 'BJ', usagePerPortion: 0, lastUpdatedBy: 'u', lastUpdatedAt: new Date().toISOString(),
    eodRemaining: 0, storeId: 'store-1', casePrice: 40, caseQty: 25, subUnitSize: 1, subUnitUnit: 'lb',
    ...over,
  };
}

function seed() {
  useStore.setState({
    currentStore: { id: 'store-1', brandId: 'brand-1', name: 'Frederick', address: '', status: 'active' } as any,
    currentUser: { id: 'user-1', name: 'Admin', email: 'a@b.c', role: 'admin' } as any,
    inventory: [mkItem({ id: 'a', name: 'Olive Oil' }), mkItem({ id: 'b', name: 'Chicken', category: 'Protein' })],
    vendors: [{ id: 'v1', name: 'BJ' } as any],
    stores: [{ id: 'store-1', name: 'Frederick' } as any],
    ingredientCategories: [],
    auditLog: [],
    storeLoading: false,
    brand: { id: 'brand-1', name: 'B' } as any,
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  // Reset the module-level Inventory viewMode memory so the persistence used by
  // the remount test below doesn't leak into the other cases.
  setLastInventoryViewMode('per-store');
  seed();
});

describe('InventoryDesktopLayout Inventory — AC-REG', () => {
  it('desktop: renders the items.tsv tab strip, not the phone list', () => {
    mockTier = 'desktop';
    const { getByText, queryByTestId } = render(<InventoryDesktopLayout section="Inventory" setSection={() => {}} onPaletteOpen={() => {}} />);
    expect(getByText('items.tsv')).toBeTruthy();
    expect(queryByTestId('phone-inventory')).toBeNull();
  });

  it('tablet: still renders the items.tsv tab strip, not the phone list', () => {
    mockTier = 'tablet';
    const { getByText, queryByTestId } = render(<InventoryDesktopLayout section="Inventory" setSection={() => {}} onPaletteOpen={() => {}} />);
    expect(getByText('items.tsv')).toBeTruthy();
    expect(queryByTestId('phone-inventory')).toBeNull();
  });

  it('phone: renders the phone list and drops the desktop tab strip', () => {
    mockTier = 'phone';
    const { getByTestId, queryByText } = render(<InventoryDesktopLayout section="Inventory" setSection={() => {}} onPaletteOpen={() => {}} />);
    expect(getByTestId('phone-inventory')).toBeTruthy();
    expect(queryByText('items.tsv')).toBeNull();
  });

  // Spec 142 — the reachability seam the code-reviewer Critical lived in: on
  // phone, viewMode==='catalog' must route through InventoryDesktopLayout's
  // dispatch to InventoryCatalogMode → PhoneCatalogList (AC-INV5). This models
  // the REAL resize path: ResponsiveCmdShell mounts this host at a different
  // tree position per tier, so a tier change UNMOUNTS + REMOUNTS it (local
  // useState would reset). We unmount the desktop instance and mount a FRESH
  // phone instance — this fails without the module-level viewMode memory
  // (fresh useState → 'per-store' → PhoneInventoryList) and passes with it.
  it('phone catalog survives the tier-change remount (AC-INV5)', () => {
    const props = { section: 'Inventory' as const, setSection: () => {}, onPaletteOpen: () => {} };

    mockTier = 'desktop';
    const desktop = render(<InventoryDesktopLayout {...props} />);
    fireEvent.press(desktop.getByText('catalog.tsv')); // sets viewMode → 'catalog'
    desktop.unmount(); // the tier-change remount

    mockTier = 'phone';
    const phone = render(<InventoryDesktopLayout {...props} />); // fresh instance
    expect(phone.getByTestId('phone-catalog')).toBeTruthy();
    expect(phone.queryByTestId('phone-inventory')).toBeNull();
  });
});

describe('InventoryCatalogMode — AC-REG', () => {
  it('desktop: renders the ingredient.tsx tab strip, not the phone catalog', () => {
    mockTier = 'desktop';
    const { getByText, queryByTestId } = render(
      <InventoryCatalogMode selectedName="olive oil" onSelectName={() => {}} />,
    );
    expect(getByText('ingredient.tsx')).toBeTruthy();
    expect(queryByTestId('phone-catalog')).toBeNull();
  });

  it('phone: renders the phone catalog and drops the desktop tab strip', () => {
    mockTier = 'phone';
    const { getByTestId, queryByText } = render(
      <InventoryCatalogMode selectedName="olive oil" onSelectName={() => {}} />,
    );
    expect(getByTestId('phone-catalog')).toBeTruthy();
    expect(queryByText('ingredient.tsx')).toBeNull();
  });
});
