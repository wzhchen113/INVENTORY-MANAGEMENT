// src/screens/cmd/sections/phone/__tests__/PhoneStoreSwitch.test.tsx
//
// Spec 148 — the phone store & brand switch sheet (README §21). Pins the store
// rows (✓ CURRENT vs SWITCH), the pick → setCurrentStore + toast + onSwitched
// (which triggers the existing spec-111 takeover + closes the drawer), the
// current-store no-op, the access filtering, and the super-admin brand gate.

import React from 'react';
import { render, fireEvent } from '@testing-library/react-native';
import Toast from 'react-native-toast-message';

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

jest.mock('../../../../../lib/db', () =>
  new Proxy({ __esModule: true }, { get: (t: Record<string, unknown>, p: string) => (p in t ? (t as any)[p] : jest.fn(() => Promise.resolve(null))) }),
);

import { PhoneStoreSwitch } from '../PhoneStoreSwitch';
import { useStore } from '../../../../../store/useStore';

const setCurrentStore = jest.fn();
const setCurrentBrandId = jest.fn();
const loadBrandsList = jest.fn(() => Promise.resolve());

const s1 = { id: 's1', brandId: 'b1', name: 'Frederick', address: '', status: 'active' } as any;
const s2 = { id: 's2', brandId: 'b1', name: 'Towson', address: '', status: 'active' } as any;

function seed(over: Record<string, unknown> = {}) {
  useStore.setState({
    stores: [s1, s2],
    currentStore: s1,
    currentUser: { id: 'u1', name: 'Admin', email: 'a@b.c', role: 'admin', stores: [] } as any,
    currentBrandId: null,
    brandsList: [],
    setCurrentStore,
    setCurrentBrandId,
    loadBrandsList,
    darkMode: false,
    ...over,
  } as any);
}

beforeEach(() => { jest.clearAllMocks(); seed(); });

describe('PhoneStoreSwitch', () => {
  it('lists accessible stores with CURRENT / SWITCH affordances', () => {
    const { getByTestId, getByText } = render(<PhoneStoreSwitch />);
    fireEvent.press(getByTestId('phone-store-chip'));
    expect(getByTestId('phone-store-row-s1')).toBeTruthy();
    expect(getByTestId('phone-store-row-s2')).toBeTruthy();
    expect(getByText(/CURRENT/)).toBeTruthy();
  });

  it('picking a different store fires setCurrentStore + toast + onSwitched', () => {
    const onSwitched = jest.fn();
    const { getByTestId } = render(<PhoneStoreSwitch onSwitched={onSwitched} />);
    fireEvent.press(getByTestId('phone-store-chip'));
    fireEvent.press(getByTestId('phone-store-row-s2'));
    expect(setCurrentStore).toHaveBeenCalledWith(s2);
    expect(Toast.show).toHaveBeenCalledWith(
      expect.objectContaining({ text1: 'Switched to Towson' }),
    );
    expect(onSwitched).toHaveBeenCalledTimes(1);
  });

  it('tapping the current store does not re-switch but still closes the drawer', () => {
    const onSwitched = jest.fn();
    const { getByTestId } = render(<PhoneStoreSwitch onSwitched={onSwitched} />);
    fireEvent.press(getByTestId('phone-store-chip'));
    fireEvent.press(getByTestId('phone-store-row-s1'));
    expect(setCurrentStore).not.toHaveBeenCalled();
    expect(onSwitched).toHaveBeenCalledTimes(1);
  });

  it('a regular user only sees their granted stores', () => {
    seed({ currentUser: { id: 'u2', name: 'Mgr', email: 'm@b.c', role: 'user', stores: ['s2'] } as any });
    const { getByTestId, queryByTestId } = render(<PhoneStoreSwitch />);
    fireEvent.press(getByTestId('phone-store-chip'));
    expect(queryByTestId('phone-store-row-s1')).toBeNull();
    expect(getByTestId('phone-store-row-s2')).toBeTruthy();
  });

  it('hides the BRAND section for a non-super-admin', () => {
    const { getByTestId, queryByTestId } = render(<PhoneStoreSwitch />);
    fireEvent.press(getByTestId('phone-store-chip'));
    expect(queryByTestId('phone-brand-row-__all_brands__')).toBeNull();
  });

  it('shows the BRAND section (super-admin) and picking a brand fires setCurrentBrandId', () => {
    seed({
      currentUser: { id: 'u3', name: 'SA', email: 'sa@b.c', role: 'super_admin', stores: [] } as any,
      currentBrandId: 'b1',
      brandsList: [{ id: 'b1', name: '2AM PROJECT' }] as any,
    });
    const onSwitched = jest.fn();
    const { getByTestId } = render(<PhoneStoreSwitch onSwitched={onSwitched} />);
    fireEvent.press(getByTestId('phone-store-chip'));
    expect(getByTestId('phone-brand-row-__all_brands__')).toBeTruthy();
    fireEvent.press(getByTestId('phone-brand-row-__all_brands__'));
    expect(setCurrentBrandId).toHaveBeenCalledWith(null);
    expect(onSwitched).toHaveBeenCalledTimes(1);
  });
});
