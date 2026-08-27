// src/components/cmd/StoreGatePicker.test.tsx — Spec 161.
//
// The sign-in store gate's two panes. Pins the brand grouping (derived from
// the VISIBLE stores, never from `brandsList`), the auto-selected brand, both
// filters, the pick → setCurrentStore hand-off, and the sign-out escape hatch
// (without which a wrong-account sign-in is a dead end — the gate replaces the
// entire shell, sidebar included).
//
// Mocking mirrors PhoneStoreSwitch.test.tsx. `visibleStoresFor` is deliberately
// NOT mocked: the rows are asserted against the real shared predicate.

import React from 'react';
import { render, fireEvent, screen } from '@testing-library/react-native';

jest.mock('../../lib/supabase', () => ({
  __esModule: true,
  supabase: {
    auth: {
      getSession: jest.fn(() => Promise.resolve({ data: { session: null }, error: null })),
      onAuthStateChange: jest.fn(() => ({ data: { subscription: { unsubscribe: jest.fn() } } })),
    },
    from: jest.fn(),
    rpc: jest.fn(() => Promise.resolve({ data: null, error: null })),
    channel: jest.fn(),
    removeChannel: jest.fn(),
    functions: { invoke: jest.fn() },
  },
}));

jest.mock('../../lib/db', () =>
  new Proxy({ __esModule: true }, { get: (t: Record<string, unknown>, p: string) => (p in t ? (t as any)[p] : jest.fn(() => Promise.resolve(null))) }),
);

import { StoreGatePicker } from './StoreGatePicker';
import { useStore } from '../../store/useStore';

const setCurrentStore = jest.fn();
const logout = jest.fn();
const loadBrandsList = jest.fn(() => Promise.resolve());

const towson = { id: 's1', brandId: 'b1', name: 'Towson', address: '', status: 'active' } as any;
const charles = { id: 's2', brandId: 'b1', name: 'Charles', address: '', status: 'active' } as any;
const harbor = { id: 's3', brandId: 'b2', name: 'Harbor', address: '', status: 'active' } as any;

const PLACEHOLDER = { id: '', brandId: '', name: '', address: '', status: 'active' } as any;

function seed(over: Record<string, unknown> = {}) {
  useStore.setState({
    stores: [towson, charles, harbor],
    // The gate always renders against the placeholder — that is the state
    // AdminStack holds the shell back on.
    currentStore: PLACEHOLDER,
    currentUser: { id: 'u1', name: 'Owner', email: 'o@b.c', role: 'super_admin', stores: [] } as any,
    currentBrandId: null,
    brand: null,
    brandsList: [
      { id: 'b1', name: '2AM Project', deletedAt: null, createdAt: null },
      { id: 'b2', name: 'Harborside', deletedAt: null, createdAt: null },
    ],
    storeGate: 'choosing',
    setCurrentStore,
    logout,
    loadBrandsList,
    ...over,
  } as any);
}

beforeEach(() => {
  jest.clearAllMocks();
  seed();
});

describe('StoreGatePicker', () => {
  it('lists one row per brand that owns a visible store', () => {
    render(<StoreGatePicker />);

    expect(screen.getByTestId('store-gate-brand-b1')).toBeTruthy();
    expect(screen.getByTestId('store-gate-brand-b2')).toBeTruthy();
  });

  it('auto-selects a brand so the store pane is never empty on open', () => {
    render(<StoreGatePicker />);

    // b1 sorts first by name ("2AM Project" < "Harborside") and is picked
    // without any interaction.
    expect(screen.getByTestId('store-gate-store-s1')).toBeTruthy();
    expect(screen.getByTestId('store-gate-store-s2')).toBeTruthy();
    expect(screen.queryByTestId('store-gate-store-s3')).toBeNull();
  });

  it('swaps the store pane when another brand is picked', () => {
    render(<StoreGatePicker />);

    fireEvent.press(screen.getByTestId('store-gate-brand-b2'));

    expect(screen.getByTestId('store-gate-store-s3')).toBeTruthy();
    expect(screen.queryByTestId('store-gate-store-s1')).toBeNull();
  });

  it('filters the store pane by name', () => {
    render(<StoreGatePicker />);

    fireEvent.changeText(screen.getByTestId('store-gate-store-filter'), 'char');

    expect(screen.getByTestId('store-gate-store-s2')).toBeTruthy();
    expect(screen.queryByTestId('store-gate-store-s1')).toBeNull();
  });

  it('filters the brand pane by name', () => {
    render(<StoreGatePicker />);

    fireEvent.changeText(screen.getByTestId('store-gate-brand-filter'), 'harbors');

    expect(screen.getByTestId('store-gate-brand-b2')).toBeTruthy();
    expect(screen.queryByTestId('store-gate-brand-b1')).toBeNull();
  });

  it('picking a store hands off to setCurrentStore', () => {
    render(<StoreGatePicker />);

    fireEvent.press(screen.getByTestId('store-gate-store-s2'));

    expect(setCurrentStore).toHaveBeenCalledTimes(1);
    expect(setCurrentStore).toHaveBeenCalledWith(charles);
  });

  it('offers sign-out so a wrong-account session is not trapped', () => {
    render(<StoreGatePicker />);

    fireEvent.press(screen.getByTestId('store-gate-signout'));

    expect(logout).toHaveBeenCalledTimes(1);
  });

  it('shows only granted stores for a non-privileged user', () => {
    // The real `visibleStoresFor` narrows to `user_stores` for non-privileged
    // roles; the gate must never offer a store the DB would refuse.
    seed({ currentUser: { id: 'u2', name: 'Mgr', email: 'm@b.c', role: 'user', stores: ['s2'] } as any });
    render(<StoreGatePicker />);

    expect(screen.getByTestId('store-gate-store-s2')).toBeTruthy();
    expect(screen.queryByTestId('store-gate-store-s1')).toBeNull();
    expect(screen.queryByTestId('store-gate-brand-b2')).toBeNull();
  });

  it('still lets the user pick when brand names have not loaded', () => {
    // A regular admin reaches the gate before `brandsList` resolves; the group
    // falls back to a generic label rather than blocking the pick.
    seed({ brandsList: [], brand: null });
    render(<StoreGatePicker />);

    fireEvent.press(screen.getByTestId('store-gate-store-s1'));

    expect(setCurrentStore).toHaveBeenCalledWith(towson);
  });

  it('shows a bare spinner while the store set is still resolving', () => {
    // Rendering the panes on this tick would flash a picker at single-store
    // users who are about to be auto-landed.
    seed({ storeGate: 'resolving' });
    render(<StoreGatePicker />);

    expect(screen.getByTestId('store-gate-resolving')).toBeTruthy();
    expect(screen.queryByTestId('store-gate-brand-b1')).toBeNull();
    expect(screen.queryByTestId('store-gate-store-s1')).toBeNull();
  });

  it('fetches the brand list when it is empty', () => {
    seed({ brandsList: [] });
    render(<StoreGatePicker />);

    expect(loadBrandsList).toHaveBeenCalled();
  });
});
