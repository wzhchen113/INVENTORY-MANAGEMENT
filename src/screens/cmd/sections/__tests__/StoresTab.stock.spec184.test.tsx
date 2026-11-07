// src/screens/cmd/sections/__tests__/StoresTab.stock.spec184.test.tsx
//
// Spec 184: the STOCK row action (AC-27), the result panel both surfaces report
// through (AC-33, AC-34, AC-39, AC-41, AC-42), D-15, and the stale-refresh guard
// (AC-43). The dialog and drawer are light probes here; their own files cover them.

jest.mock('../../../../theme/colors', () => ({
  useCmdColors: () => ({
    bg: '#FFFFFF', panel: '#F4F4F4', panel2: '#EAEAEA', border: '#CCCCCC',
    borderStrong: '#888888', fg: '#000000', fg2: '#444444', fg3: '#888888',
    accent: '#185FA5', accentBg: '#E6F1FB', accentFg: '#FFFFFF',
    warn: '#854F0B', warnBg: '#FAEEDA', danger: '#791F1F', dangerBg: '#FCEBEB',
    ok: '#3B6D11', okBg: '#EAF3DE', info: '#185FA5', infoBg: '#E6F1FB',
  }),
  CmdRadius: { xs: 3, sm: 4, md: 5, lg: 6 },
}));

jest.mock('../../../../hooks/useT', () => ({ useT: () => (key: string) => key }));
jest.mock('../../../../utils/confirmAction', () => ({ confirmAction: jest.fn() }));

const mockFetchStores = jest.fn();
const mockFetchInventory = jest.fn();
const mockFetchVendors = jest.fn();
jest.mock('../../../../lib/db', () => ({
  fetchStoresIncludingInactive: () => mockFetchStores(),
  fetchInventory: (...a: unknown[]) => mockFetchInventory(...a),
  fetchVendors: (...a: unknown[]) => mockFetchVendors(...a),
}));

const mockNotify = jest.fn();
jest.mock('../../../../store/useStore', () => {
  const state: any = { updateStore: jest.fn(async () => true) };
  const fn: any = jest.fn((selector: (s: any) => any) => selector(state));
  fn.getState = () => state;
  return { useStore: fn, notifyBackendError: (...a: unknown[]) => mockNotify(...a) };
});

const dialogProps: any[] = [];
jest.mock('../../../../components/cmd/StockStoreDialog', () => {
  const React = require('react');
  const { View } = require('react-native');
  return {
    StockStoreDialog: (props: any) => {
      dialogProps.push(props);
      return React.createElement(View, { testID: `dialog-${props.store.id}` });
    },
  };
});

const drawerProps: any[] = [];
jest.mock('../../../../components/cmd/StoreFormDrawer', () => ({
  StoreFormDrawer: (props: any) => {
    drawerProps.push(props);
    return null;
  },
}));

jest.mock('../../../../lib/supabase', () => ({
  supabase: { from: jest.fn(), auth: {}, rpc: jest.fn() },
}));
jest.mock('react-native-toast-message', () => ({ __esModule: true, default: { show: jest.fn() } }));

import React from 'react';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react-native';
import { StoresTab } from '../BrandsSection';

const BRAND = 'brand-1';
const row = (id: string, name: string) => ({
  id, name, brandId: BRAND, address: '1 Main', status: 'active' as const, postalCode: null,
});
const RESULT = {
  itemsCopied: 149, itemsSkipped: 0, linksAdded: 150, linksSkippedCrossBrand: 0, extrasAdded: 0,
  extrasSkipped: 0, itemsNoVendorLink: 0, targetHasOrderSchedule: true, uncarriedRemaining: 0,
};
const US_FOODS = { id: 'v-us', name: 'US Foods', importCustomerNumbers: { 'store-towson': '111' } };

// The edit instance also renders with `store: null` while closed, and has no onCreated.
const lastCreateDrawer = () => drawerProps.filter((p) => p.onCreated).slice(-1)[0];
const lastDialog = () => dialogProps[dialogProps.length - 1];

async function renderTab() {
  render(<StoresTab brandId={BRAND} brandName="2AM" />);
  await screen.findByText('Kenyon');
}

async function runStock(result: Record<string, unknown> = RESULT, target = 'kenyon', name = 'Kenyon') {
  fireEvent.press(screen.getByTestId(`store-stock-${target}`));
  await act(async () => {
    lastDialog().onStocked({ targetStoreId: target, targetName: name, sourceName: 'Towson', result });
    lastDialog().onClose();
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  dialogProps.length = 0;
  drawerProps.length = 0;
  mockFetchStores.mockResolvedValue([row('kenyon', 'Kenyon'), row('hstreet', 'H Street')]);
  mockFetchInventory.mockResolvedValue([]);
  mockFetchVendors.mockResolvedValue([]);
});

describe('the STOCK action (AC-27)', () => {
  it('every row has one, labeled, with a 44x44 effective target like EDIT', async () => {
    await renderTab();
    for (const [id, name] of [['kenyon', 'Kenyon'], ['hstreet', 'H Street']]) {
      const button = screen.getByTestId(`store-stock-${id}`);
      expect(button.props.accessibilityLabel).toBe(`Stock store ${name}`);
      const edit = screen.getByTestId(`store-edit-${id}`);
      expect(button.props.hitSlop).toEqual({ top: 11, bottom: 11, left: 8, right: 8 });
      expect(button.props.hitSlop).toEqual(edit.props.hitSlop);
      expect(button.props.accessibilityRole).toBe(edit.props.accessibilityRole);
    }
  });

  it('opens the dialog on that row, and it unmounts on close', async () => {
    await renderTab();
    expect(screen.queryByTestId('dialog-hstreet')).toBeNull();
    fireEvent.press(screen.getByTestId('store-stock-hstreet'));
    expect(screen.getByTestId('dialog-hstreet')).toBeTruthy();
    expect(lastDialog().brandId).toBe(BRAND);

    await act(async () => { lastDialog().onClose(); });
    expect(screen.queryByTestId('dialog-hstreet')).toBeNull();
  });
});

describe('the result panel (AC-33, AC-34)', () => {
  it('shows the run, and is dismissible', async () => {
    await renderTab();
    expect(screen.queryByTestId('store-stock-result')).toBeNull();
    await runStock();
    expect(screen.getByTestId('store-stock-result-copied').props.children).toBe(
      'Copied 149 items and 150 vendor links from Towson to Kenyon. Stock starts at 0.',
    );
    fireEvent.press(screen.getByTestId('store-stock-result-dismiss'));
    expect(screen.queryByTestId('store-stock-result')).toBeNull();
  });

  it('warns about a missing order schedule (H Street), not when one exists (Kenyon)', async () => {
    await renderTab();
    await runStock();
    expect(screen.queryByTestId('store-stock-result-no-schedule')).toBeNull();
    await runStock({ ...RESULT, targetHasOrderSchedule: false }, 'hstreet', 'H Street');
    expect(screen.getByTestId('store-stock-result-no-schedule')).toBeTruthy();
  });

  it('create-and-stock reports through the same panel (AC-42)', async () => {
    await renderTab();
    await act(async () => {
      lastCreateDrawer().onCreated({
        storeId: 'new', storeName: 'Canton', sourceName: 'Towson',
        result: { ...RESULT, targetHasOrderSchedule: false },
        stockFailed: false, canStockLater: true, uncarriedCount: 2,
      });
    });
    expect(screen.getByTestId('store-stock-result-copied')).toBeTruthy();
    expect(screen.getByTestId('store-stock-result-no-schedule')).toBeTruthy();
    expect(screen.getByTestId('store-stock-result-uncarried')).toBeTruthy();
  });

  it('AC-41: created but not stocked says so, and runs no customer-number check', async () => {
    await renderTab();
    await act(async () => {
      lastCreateDrawer().onCreated({
        storeId: 'new', storeName: 'Canton', sourceName: 'Towson', result: null,
        stockFailed: true, canStockLater: true, uncarriedCount: 0,
      });
    });
    expect(screen.getByTestId('store-stock-result-not-stocked')).toBeTruthy();
    expect(mockFetchInventory).not.toHaveBeenCalled();
  });

  it('a brand with nothing to add to the toast shows no panel', async () => {
    await renderTab();
    await act(async () => {
      lastCreateDrawer().onCreated({
        storeId: 'new', storeName: 'Canton', sourceName: null, result: null,
        stockFailed: false, canStockLater: false, uncarriedCount: 0,
      });
    });
    expect(screen.queryByTestId('store-stock-result')).toBeNull();
  });

  it('clears when the brand changes', async () => {
    const { rerender } = render(<StoresTab brandId={BRAND} brandName="2AM" />);
    await screen.findByText('Kenyon');
    await runStock();
    expect(screen.getByTestId('store-stock-result')).toBeTruthy();
    await act(async () => { rerender(<StoresTab brandId="brand-2" brandName="Other" />); });
    expect(screen.queryByTestId('store-stock-result')).toBeNull();
  });

  it("a run that resolves after a brand switch doesn't put its panel on the new brand", async () => {
    const { rerender } = render(<StoresTab brandId={BRAND} brandName="2AM" />);
    await screen.findByText('Kenyon');
    fireEvent.press(screen.getByTestId('store-stock-kenyon'));
    // The dialog holds the callbacks from brand-1's render while its run is in flight.
    const staleDialog = lastDialog();
    const staleDrawer = lastCreateDrawer();
    await act(async () => { rerender(<StoresTab brandId="brand-2" brandName="Other" />); });
    await act(async () => {
      staleDialog.onStocked({ targetStoreId: 'kenyon', targetName: 'Kenyon', sourceName: 'Towson', result: RESULT });
      staleDrawer.onCreated({
        storeId: 'new', storeName: 'Canton', sourceName: 'Towson', result: RESULT,
        stockFailed: false, canStockLater: true, uncarriedCount: 0,
      });
    });
    expect(screen.queryByTestId('store-stock-result')).toBeNull();
    expect(mockFetchInventory).not.toHaveBeenCalled();
  });
});

describe('the customer-number line (D-15)', () => {
  const item = (vendorIds: string[]) => ({ storeId: 'kenyon', vendorId: vendorIds[0], vendorIds });

  it('reads the TARGET rows and THIS brand, not the slices, and names the vendor', async () => {
    mockFetchInventory.mockResolvedValue([item(['v-us'])]);
    mockFetchVendors.mockResolvedValue([US_FOODS]);
    await renderTab();
    await runStock();

    expect(mockFetchInventory).toHaveBeenCalledWith('kenyon');
    expect(mockFetchVendors).toHaveBeenCalledWith(BRAND);
    expect(screen.getByTestId('store-stock-result-customer-number').props.children).toContain(
      'US Foods has no customer number for Kenyon',
    );
  });

  it('create-and-stock checks too, against the new store', async () => {
    mockFetchInventory.mockResolvedValue([{ ...item(['v-us']), storeId: 'new' }]);
    mockFetchVendors.mockResolvedValue([US_FOODS]);
    await renderTab();
    await act(async () => {
      lastCreateDrawer().onCreated({
        storeId: 'new', storeName: 'Canton', sourceName: 'Towson', result: RESULT,
        stockFailed: false, canStockLater: true, uncarriedCount: 0,
      });
    });
    expect(mockFetchInventory).toHaveBeenCalledWith('new');
    expect(screen.getByTestId('store-stock-result-customer-number').props.children).toContain(
      'US Foods has no customer number for Canton',
    );
  });

  it('no line when the entry exists', async () => {
    mockFetchInventory.mockResolvedValue([item(['v-us'])]);
    mockFetchVendors.mockResolvedValue([
      { ...US_FOODS, importCustomerNumbers: { kenyon: '222' } },
    ]);
    await renderTab();
    await runStock();
    expect(screen.queryByTestId('store-stock-result-customer-number')).toBeNull();
  });

  it('no line on an empty map', async () => {
    mockFetchInventory.mockResolvedValue([item(['v-us'])]);
    mockFetchVendors.mockResolvedValue([{ ...US_FOODS, importCustomerNumbers: {} }]);
    await renderTab();
    await runStock();
    expect(screen.queryByTestId('store-stock-result-customer-number')).toBeNull();
  });

  it('a failed check notifies and says it could not check', async () => {
    mockFetchVendors.mockRejectedValue(new Error('boom'));
    await renderTab();
    await runStock();
    expect(mockNotify).toHaveBeenCalledWith('Check vendor customer numbers', expect.any(Error));
    expect(screen.getByTestId('store-stock-result-customer-number').props.children).toContain(
      'Could not check vendor customer numbers for Kenyon',
    );
  });

  it('the panel does not wait for the check, and a late answer stays out after a dismiss', async () => {
    let resolve: (v: unknown) => void = () => {};
    mockFetchInventory.mockReturnValue(new Promise((r) => { resolve = r; }));
    mockFetchVendors.mockResolvedValue([US_FOODS]);
    await renderTab();
    await runStock();
    expect(screen.getByTestId('store-stock-result-copied')).toBeTruthy();

    fireEvent.press(screen.getByTestId('store-stock-result-dismiss'));
    await act(async () => { resolve([item(['v-us'])]); });
    expect(screen.queryByTestId('store-stock-result')).toBeNull();
  });
});

describe('the stale-refresh guard (AC-43)', () => {
  it('an older response cannot drop a new store that a newer one returned', async () => {
    let resolveOld: (v: unknown) => void = () => {};
    mockFetchStores.mockReset();
    mockFetchStores.mockResolvedValueOnce([row('kenyon', 'Kenyon')]);
    render(<StoresTab brandId={BRAND} brandName="2AM" />);
    await screen.findByText('Kenyon');

    // Opening the drawer starts a refresh that hangs from before the insert…
    mockFetchStores.mockReturnValueOnce(new Promise((r) => { resolveOld = r; }));
    fireEvent.press(screen.getByText('+ NEW STORE'));
    await waitFor(() => expect(mockFetchStores).toHaveBeenCalledTimes(2));

    // …and closing it after the insert starts a newer one that sees the new store.
    mockFetchStores.mockResolvedValueOnce([row('kenyon', 'Kenyon'), row('canton', 'Canton')]);
    await act(async () => { lastCreateDrawer().onClose(); });
    await screen.findByText('Canton');

    await act(async () => { resolveOld([row('kenyon', 'Kenyon')]); });
    expect(screen.getByText('Canton')).toBeTruthy();
  });
});
