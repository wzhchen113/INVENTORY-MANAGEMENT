// src/screens/cmd/sections/phone/__tests__/PhoneVendors.test.tsx
//
// Spec 142 §6 (AC-VEN1/2) — the Vendors row (delivery-days pill, name,
// contact·phone, LEAD/CUTOFF/ITEMS) and the detail (LEAD/CUTOFF/ITEMS stats,
// CONTACT/ORDER CODES/SCHEDULE, CALL VENDOR tel: sanitize + short-circuit, VIEW
// IN ORDERING). supabase is stubbed; Linking.openURL is spied.

import React from 'react';
import { render, fireEvent } from '@testing-library/react-native';
import { Linking } from 'react-native';
import Toast from 'react-native-toast-message';

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

import { PhoneVendorsList } from '../PhoneVendorsList';
import { useStore } from '../../../../../store/useStore';
import { usePaletteAction } from '../../../../../lib/paletteAction';

function mkVendor(over: Partial<any> = {}): any {
  return { id: 'v1', brandId: 'b', name: 'BJ Wholesale', contactName: 'Sam', phone: '(301) 555-1234', email: 's@bj.com', accountNumber: 'AC-1', leadTimeDays: 2, deliveryDays: ['Mon', 'Wed'], categories: ['Protein'], orderCutoffTime: '15:00', orderUnit: 'case', extensionOrdering: false, orderPageUrl: null, ...over };
}

let openURLSpy: jest.SpyInstance;

beforeEach(() => {
  jest.clearAllMocks();
  usePaletteAction.setState({ pending: null });
  openURLSpy = jest.spyOn(Linking, 'openURL').mockResolvedValue(true as any);
  useStore.setState({
    currentStore: { id: 'store-1', brandId: 'b', name: 'F', address: '', status: 'active' } as any,
    vendors: [mkVendor()],
    inventory: [
      { id: 'i1', catalogId: 'i1', name: 'Chicken', category: 'Protein', unit: 'lbs', costPerUnit: 2, currentStock: 10, parLevel: 20, averageDailyUsage: 0, safetyStock: 0, vendorId: 'v1', vendorName: 'BJ Wholesale', usagePerPortion: 0, lastUpdatedBy: '', lastUpdatedAt: '', eodRemaining: 0, storeId: 'store-1', casePrice: 40, caseQty: 25, subUnitSize: 1, subUnitUnit: 'lb', vendors: [{ vendorId: 'v1', vendorName: 'BJ Wholesale', costPerUnit: 2, casePrice: 40, isPrimary: true, orderCode: 'SKU-9', productPageUrl: '' }] } as any,
    ],
  });
});

describe('PhoneVendorsList — AC-VEN1 row', () => {
  it('renders the vendor row with contact/phone and lead/cutoff/items meta', () => {
    const { getByTestId, getByText } = render(<PhoneVendorsList />);
    expect(getByTestId('phone-vendor-row-v1')).toBeTruthy();
    expect(getByText(/Sam · \(301\) 555-1234/)).toBeTruthy();
    expect(getByText(/LEAD 2d · CUTOFF 15:00 · 1 ITEMS/)).toBeTruthy();
  });
});

describe('PhoneVendorsList detail — AC-VEN2', () => {
  it('opens stats + CONTACT/ORDER CODES/SCHEDULE and CALL sanitizes the tel: URL', () => {
    const { getByTestId, getByText } = render(<PhoneVendorsList />);
    fireEvent.press(getByTestId('phone-vendor-row-v1'));

    expect(getByTestId('phone-vendor-statpanel')).toBeTruthy();
    expect(getByText('Sam')).toBeTruthy();          // CONTACT card value
    expect(getByText('ORDER CODES')).toBeTruthy();
    expect(getByText('SCHEDULE')).toBeTruthy();
    expect(getByText('SKU-9')).toBeTruthy();         // ORDER CODES row

    fireEvent.press(getByTestId('phone-vendor-call'));
    expect(openURLSpy).toHaveBeenCalledWith('tel:3015551234');

    fireEvent.press(getByTestId('phone-vendor-view-ordering'));
    expect(usePaletteAction.getState().pending).toEqual({ section: 'Ordering', selectedName: null });
  });

  it('CALL VENDOR short-circuits (no tel:) when the vendor has no phone', () => {
    useStore.setState({ vendors: [mkVendor({ phone: '' })] });
    const { getByTestId } = render(<PhoneVendorsList />);
    fireEvent.press(getByTestId('phone-vendor-row-v1'));
    fireEvent.press(getByTestId('phone-vendor-call'));
    expect(openURLSpy).not.toHaveBeenCalled();
    expect(Toast.show as jest.Mock).toHaveBeenCalled();
  });
});
