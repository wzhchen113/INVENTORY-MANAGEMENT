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
// Spec 150 — the REAL shared predicate (deliberately not mocked): the sheet's
// rows are asserted against this function's output.
import { visibleStoresFor } from '../../../../../lib/storeVisibility';

const setCurrentStore = jest.fn();
// Spec 150 — the real action REPORTS the brand actually in effect (it returns
// null when a store-less brand was diverted to "All brands"). The default stub
// echoes the request back = "applied as asked"; the diverted-toast case
// overrides it to return null, exercising the component's honest read of the
// outcome rather than a re-derivation of the store's guard.
const setCurrentBrandId = jest.fn((brandId: string | null) => brandId);
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

  // Spec 150 — a super-admin / master with NO explicit user_stores rows sees
  // every store by role. This was the reported-but-wrong theory for the
  // "phone shows no stores" bug; pinned here so a future access-filter edit
  // can't quietly re-introduce the narrowing the sheet never had.
  it.each(['super_admin', 'master'] as const)(
    'a %s with no user_stores rows still sees every store',
    (role) => {
      seed({ currentUser: { id: 'u9', name: 'Owner', email: 'o@b.c', role, stores: [] } as any });
      const { getByTestId } = render(<PhoneStoreSwitch />);
      fireEvent.press(getByTestId('phone-store-chip'));
      expect(getByTestId('phone-store-row-s1')).toBeTruthy();
      expect(getByTestId('phone-store-row-s2')).toBeTruthy();
    },
  );

  // Spec 150 (C) — the residual empty state names the brand it is scoped to
  // instead of the bare "No stores available", which read as "no access".
  // The store-side fix (spec 150 D) keeps this state from persisting; this
  // copy covers the pre-fetchStores window where the brand can't be validated.
  it('names the active brand when the brand narrowing hid every store', () => {
    seed({
      currentUser: { id: 'u3', name: 'SA', email: 'sa@b.c', role: 'super_admin', stores: [] } as any,
      currentBrandId: 'b-empty',
      brandsList: [{ id: 'b1', name: '2AM PROJECT' }, { id: 'b-empty', name: 'BALTIMORE SEAFOOD' }] as any,
    });
    const { getByTestId, queryByTestId } = render(<PhoneStoreSwitch />);
    fireEvent.press(getByTestId('phone-store-chip'));
    expect(queryByTestId('phone-store-row-s1')).toBeNull();
    expect(getByTestId('phone-store-empty').props.children).toBe(
      'No stores in BALTIMORE SEAFOOD — pick another brand below',
    );
    // The escape hatch the copy points at is still rendered.
    expect(getByTestId('phone-brand-row-__all_brands__')).toBeTruthy();
  });

  it('falls back to the generic empty copy with no brand context', () => {
    seed({ stores: [], currentStore: null });
    const { getByTestId } = render(<PhoneStoreSwitch />);
    fireEvent.press(getByTestId('phone-store-chip'));
    expect(getByTestId('phone-store-empty').props.children).toBe('No stores available');
  });

  // Spec 150 — the phone half of the shared-predicate pin. The desktop half
  // lives in src/components/cmd/TitleBar.test.tsx against the SAME fixture, so
  // a divergence between the two store switchers fails one of the two suites.
  describe('renders exactly the shared predicate output', () => {
    const FIXTURE_STORES = [
      { id: 's1', brandId: 'b1', name: 'Frederick', address: '', status: 'active' as const },
      { id: 's2', brandId: 'b1', name: 'Towson', address: '', status: 'active' as const },
      { id: 's3', brandId: 'b2', name: 'Harbor', address: '', status: 'active' as const },
    ];

    it.each([
      ['admin sees every store under "All brands"', 'admin', [] as string[], null],
      ['admin narrowed to a brand', 'admin', [] as string[], 'b1'],
      ['super-admin with no grants sees every store', 'super_admin', [] as string[], null],
      ['non-privileged user sees only grants', 'user', ['s2'], null],
      ['non-privileged user, brand with no granted store', 'user', ['s3'], 'b1'],
    ] as const)('%s', (_label, role, grants, brandId) => {
      const currentUser = { id: 'u1', name: 'U', email: 'u@x.c', role, stores: grants as string[] };
      seed({
        stores: FIXTURE_STORES,
        currentUser: currentUser as any,
        currentBrandId: brandId,
        currentStore: FIXTURE_STORES[0],
        brandsList: [{ id: 'b1', name: '2AM PROJECT' }, { id: 'b2', name: 'BALTIMORE SEAFOOD' }] as any,
      });
      const expected = visibleStoresFor(FIXTURE_STORES, currentUser as any, brandId);

      const { getByTestId, queryByTestId } = render(<PhoneStoreSwitch />);
      fireEvent.press(getByTestId('phone-store-chip'));

      for (const s of FIXTURE_STORES) {
        const shown = expected.some((e) => e.id === s.id);
        expect(Boolean(queryByTestId(`phone-store-row-${s.id}`))).toBe(shown);
      }
    });
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
    expect(Toast.show).toHaveBeenCalledWith(
      expect.objectContaining({ text1: 'Switched brand' }),
    );
    expect(onSwitched).toHaveBeenCalledTimes(1);
  });

  // Spec 150 follow-up — an honest toast. When the store DIVERTS the pick (the
  // brand has no store this role can open), the sheet must not claim a switch
  // that didn't happen. The outcome is READ from the setter's return value, so
  // the guard's condition is not duplicated in the component.
  it('reports the diversion when a store-less brand is picked', () => {
    setCurrentBrandId.mockImplementation((brandId: string | null) =>
      brandId === 'b-empty' ? null : brandId,
    );
    seed({
      currentUser: { id: 'u3', name: 'SA', email: 'sa@b.c', role: 'super_admin', stores: [] } as any,
      currentBrandId: null,
      brandsList: [{ id: 'b1', name: '2AM PROJECT' }, { id: 'b-empty', name: 'BALTIMORE SEAFOOD' }] as any,
    });
    const { getByTestId } = render(<PhoneStoreSwitch />);
    fireEvent.press(getByTestId('phone-store-chip'));
    fireEvent.press(getByTestId('phone-brand-row-b-empty'));

    expect(setCurrentBrandId).toHaveBeenCalledWith('b-empty');
    expect(Toast.show).toHaveBeenCalledWith(
      expect.objectContaining({
        text1: 'BALTIMORE SEAFOOD has no stores',
        text2: 'Showing all brands',
      }),
    );
    expect(Toast.show).not.toHaveBeenCalledWith(
      expect.objectContaining({ text1: 'Switched brand' }),
    );
  });

  it('keeps the plain switched-brand toast when the pick is applied as asked', () => {
    seed({
      currentUser: { id: 'u3', name: 'SA', email: 'sa@b.c', role: 'super_admin', stores: [] } as any,
      currentBrandId: null,
      brandsList: [{ id: 'b1', name: '2AM PROJECT' }] as any,
    });
    const { getByTestId } = render(<PhoneStoreSwitch />);
    fireEvent.press(getByTestId('phone-store-chip'));
    fireEvent.press(getByTestId('phone-brand-row-b1'));

    expect(Toast.show).toHaveBeenCalledWith(
      expect.objectContaining({ text1: 'Switched brand' }),
    );
  });
});
