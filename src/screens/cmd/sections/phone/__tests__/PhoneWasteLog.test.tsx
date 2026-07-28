// src/screens/cmd/sections/phone/__tests__/PhoneWasteLog.test.tsx
//
// Spec 142 §6.6 (AC-WASTE2) — the two-step log sheet advances picker → stepper;
// SAVE calls the seeded `logWaste` spy with the chosen item/qty/reason; the feed
// renders the wasteLog slice.
//
// supabase is stubbed; safe-area is zeroed (ResponsiveSheet reads insets).

import React from 'react';
import { render, fireEvent } from '@testing-library/react-native';

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, left: 0, right: 0, bottom: 0 }),
}));

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

import { PhoneWasteLog } from '../PhoneWasteLog';
import { useStore } from '../../../../../store/useStore';

function mkItem(id: string, name: string): any {
  return { id, catalogId: id, name, unit: 'lbs', costPerUnit: 3, currentStock: 20, parLevel: 10, averageDailyUsage: 0, safetyStock: 0, vendorId: 'v', vendorName: '', usagePerPortion: 0, lastUpdatedBy: '', lastUpdatedAt: '', eodRemaining: 0, storeId: 'store-1', casePrice: 0, caseQty: 1, subUnitSize: 1, subUnitUnit: 'lb' };
}

const logWaste = jest.fn();

function seed(wasteLog: any[] = []) {
  useStore.setState({
    currentStore: { id: 'store-1', brandId: 'b', name: 'F', address: '', status: 'active' } as any,
    currentUser: { id: 'user-1', name: 'Admin', email: 'a@b.c', role: 'admin' } as any,
    inventory: [mkItem('i1', 'Chicken'), mkItem('i2', 'Flour')],
    wasteLog,
    logWaste,
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  seed();
});

describe('PhoneWasteLog — spec 142 chunk c', () => {
  it('advances picker → stepper and SAVE calls logWaste with the chosen item/qty/reason', () => {
    const { getByTestId, getByLabelText } = render(<PhoneWasteLog />);
    fireEvent.press(getByTestId('phone-waste-open-sheet'));
    // Step 1 — item picker.
    fireEvent.press(getByTestId('phone-waste-pick-i1'));
    // Step 2 — bump qty 1 → 2, choose a reason, save.
    fireEvent.press(getByLabelText('Increase quantity'));
    fireEvent.press(getByTestId('phone-waste-reason-Dropped/spilled'));
    fireEvent.press(getByTestId('phone-waste-save'));

    expect(logWaste).toHaveBeenCalledTimes(1);
    expect(logWaste).toHaveBeenCalledWith(
      expect.objectContaining({ itemId: 'i1', itemName: 'Chicken', quantity: 2, reason: 'Dropped/spilled', storeId: 'store-1' }),
    );
  });

  it('renders the feed from the wasteLog slice', () => {
    seed([
      { id: 'w1', itemId: 'i1', itemName: 'Chicken', quantity: 3, unit: 'lbs', costPerUnit: 3, reason: 'Expired', loggedBy: 'A', loggedByUserId: 'u', timestamp: new Date().toISOString(), notes: '', storeId: 'store-1' },
    ]);
    const { getByTestId } = render(<PhoneWasteLog />);
    expect(getByTestId('phone-waste-row-w1')).toBeTruthy();
  });

  it('reason chip row filters the feed (AC-WASTE1)', () => {
    const now = new Date().toISOString();
    seed([
      { id: 'wE', itemId: 'i1', itemName: 'Chicken', quantity: 3, unit: 'lbs', costPerUnit: 3, reason: 'Expired', loggedBy: 'A', loggedByUserId: 'u', timestamp: now, notes: '', storeId: 'store-1' },
      { id: 'wT', itemId: 'i2', itemName: 'Flour', quantity: 1, unit: 'lbs', costPerUnit: 2, reason: 'Theft', loggedBy: 'B', loggedByUserId: 'u', timestamp: now, notes: '', storeId: 'store-1' },
    ]);
    const { getByTestId, queryByTestId } = render(<PhoneWasteLog />);
    // The chip row + both feed rows exist under 'all'.
    expect(getByTestId('phone-waste-chips')).toBeTruthy();
    expect(getByTestId('phone-waste-row-wE')).toBeTruthy();
    expect(getByTestId('phone-waste-row-wT')).toBeTruthy();
    // Tapping the Theft chip filters the feed to Theft only.
    fireEvent.press(getByTestId('chip-Theft'));
    expect(getByTestId('phone-waste-row-wT')).toBeTruthy();
    expect(queryByTestId('phone-waste-row-wE')).toBeNull();
  });
});
