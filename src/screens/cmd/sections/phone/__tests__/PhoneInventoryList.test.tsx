// src/screens/cmd/sections/phone/__tests__/PhoneInventoryList.test.tsx
//
// Spec 142 §6.4 (AC-INV1/2/3) — the phone Inventory list:
//   - the segmented ALL/OUT/LOW/OK counts equal the partition of the seeded set;
//   - a two-line row renders a StatusPill in a SEMANTIC (out/low/ok) token and
//     NOT the accent (§91);
//   - nothing is selected by default (no detail overlay);
//   - at 143 seeded items the FlatList virtualizes (far fewer than 143 rows
//     render eagerly).
//
// supabase is stubbed (useStore imports it at module load); getItemStatus is the
// REAL store selector (currentStock<=0 → out, <par → low, else ok).

import React from 'react';
import { Text } from 'react-native';
import { render, fireEvent, within } from '@testing-library/react-native';

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

import { PhoneInventoryList } from '../PhoneInventoryList';
import { useStore } from '../../../../../store/useStore';
import { LightCmd } from '../../../../../theme/colors';
import en from '../../../../../i18n/en.json';

function mkItem(over: Partial<any>): any {
  return {
    id: over.id, catalogId: over.id, name: over.name ?? over.id, category: over.category ?? 'Protein',
    unit: 'lbs', costPerUnit: 2, currentStock: 50, parLevel: 40, averageDailyUsage: 5, safetyStock: 0,
    vendorId: 'v1', vendorName: 'BJ', usagePerPortion: 0, lastUpdatedBy: 'u', lastUpdatedAt: new Date().toISOString(),
    eodRemaining: 0, storeId: 'store-1', casePrice: 40, caseQty: 25, subUnitSize: 1, subUnitUnit: 'lb',
    ...over,
  };
}

function flat(style: any): any {
  return Array.isArray(style) ? Object.assign({}, ...style.flat(Infinity).filter(Boolean)) : (style || {});
}

function seed(items: any[]) {
  useStore.setState({
    currentStore: { id: 'store-1', brandId: 'brand-1', name: 'Frederick', address: '', status: 'active' } as any,
    currentUser: { id: 'user-1', name: 'Admin', email: 'a@b.c', role: 'admin' } as any,
    inventory: items,
    vendors: [{ id: 'v1', name: 'BJ' } as any],
    auditLog: [],
  });
}

beforeEach(() => jest.clearAllMocks());

describe('PhoneInventoryList — spec 142 chunk b', () => {
  it('segments partition the set into ALL/OUT/LOW/OK counts', () => {
    seed([
      mkItem({ id: 'a', currentStock: 0, parLevel: 40 }),   // out
      mkItem({ id: 'b', currentStock: 10, parLevel: 40 }),  // low
      mkItem({ id: 'c', currentStock: 60, parLevel: 40 }),  // ok
      mkItem({ id: 'd', currentStock: 70, parLevel: 40 }),  // ok
    ]);
    const { getByTestId } = render(<PhoneInventoryList />);
    expect(within(getByTestId('phone-inv-segment-all')).getByText('4')).toBeTruthy();
    expect(within(getByTestId('phone-inv-segment-out')).getByText('1')).toBeTruthy();
    expect(within(getByTestId('phone-inv-segment-low')).getByText('1')).toBeTruthy();
    expect(within(getByTestId('phone-inv-segment-ok')).getByText('2')).toBeTruthy();
  });

  it('filters the list to a status when its segment is tapped', () => {
    seed([
      mkItem({ id: 'a', currentStock: 0, parLevel: 40 }),
      mkItem({ id: 'b', currentStock: 10, parLevel: 40 }),
      mkItem({ id: 'c', currentStock: 60, parLevel: 40 }),
    ]);
    const { getByTestId, queryByTestId } = render(<PhoneInventoryList />);
    fireEvent.press(getByTestId('phone-inv-segment-out'));
    expect(getByTestId('phone-inv-row-a')).toBeTruthy();
    expect(queryByTestId('phone-inv-row-b')).toBeNull();
    expect(queryByTestId('phone-inv-row-c')).toBeNull();
  });

  it('renders the OUT status pill in a semantic token, never the accent', () => {
    seed([mkItem({ id: 'a', currentStock: 0, parLevel: 40 })]);
    const { getByTestId } = render(<PhoneInventoryList />);
    const row = getByTestId('phone-inv-row-a');
    const colors = row.findAllByType(Text).map((t: any) => flat(t.props.style).color);
    expect(colors).toContain(LightCmd.danger);
    expect(colors).not.toContain(LightCmd.accent);
  });

  it('selects nothing by default (no detail overlay)', () => {
    seed([mkItem({ id: 'a' }), mkItem({ id: 'b' })]);
    const { queryByTestId } = render(<PhoneInventoryList />);
    expect(queryByTestId('phone-drill-detail')).toBeNull();
  });

  // Spec 160 §9.4 — the phone list shares the desktop filter DSL, so the
  // `counted:` token advertised in its search placeholder has to RESOLVE here.
  // No column is added; this is filter wiring only.
  describe('counted: filter (spec 160 §9.4)', () => {
    const DAY = 86_400_000;
    const realAgo = (ms: number) => new Date(Date.now() - ms).toISOString();

    it('counted:never keeps only the never-counted rows', () => {
      seed([mkItem({ id: 'a' }), mkItem({ id: 'b' })]);
      useStore.setState({
        lastCountedByItem: { a: realAgo(2 * DAY), b: null },
        lastCountedLoaded: true,
        lastCountedStoreId: 'store-1',
      });
      const { getByTestId, queryByTestId } = render(<PhoneInventoryList />);
      fireEvent.changeText(getByTestId('phone-inv-search'), 'counted:never');
      expect(queryByTestId('phone-inv-row-a')).toBeNull();
      expect(getByTestId('phone-inv-row-b')).toBeTruthy();
    });

    it('counted:stale keeps stale, cold AND never — but not fresh', () => {
      seed([mkItem({ id: 'a' }), mkItem({ id: 'b' }), mkItem({ id: 'c' })]);
      useStore.setState({
        lastCountedByItem: { a: realAgo(2 * DAY), b: realAgo(10 * DAY), c: null },
        lastCountedLoaded: true,
        lastCountedStoreId: 'store-1',
      });
      const { getByTestId, queryByTestId } = render(<PhoneInventoryList />);
      fireEvent.changeText(getByTestId('phone-inv-search'), 'counted:stale');
      expect(queryByTestId('phone-inv-row-a')).toBeNull();
      expect(getByTestId('phone-inv-row-b')).toBeTruthy();
      expect(getByTestId('phone-inv-row-c')).toBeTruthy();
    });

    it('matches ZERO rows while the aggregate is unloaded (never every row)', () => {
      seed([mkItem({ id: 'a' }), mkItem({ id: 'b' })]);
      useStore.setState({
        lastCountedByItem: {},
        lastCountedLoaded: false,
        lastCountedStoreId: null,
      });
      const { getByTestId, queryByTestId } = render(<PhoneInventoryList />);
      fireEvent.changeText(getByTestId('phone-inv-search'), 'counted:never');
      expect(queryByTestId('phone-inv-row-a')).toBeNull();
      expect(queryByTestId('phone-inv-row-b')).toBeNull();
    });
  });

  // AC-19 wiring half — content parity is i18n.test.ts's job; this pins that
  // the `filterPlaceholderItems` string actually reaches the search
  // TextInput's `placeholder` prop (not the untouched `filterPlaceholder`
  // key), so a future dropped/reverted prop would fail this suite.
  it('AC-19 — the search placeholder is filterPlaceholderItems, not the untouched filterPlaceholder key', () => {
    seed([mkItem({ id: 'a' })]);
    const { getByTestId } = render(<PhoneInventoryList />);
    const search = getByTestId('phone-inv-search');
    expect(search.props.placeholder).toBe(en.section.inventory.filterPlaceholderItems);
    expect(search.props.placeholder).not.toBe(en.section.inventory.filterPlaceholder);
  });

  it('virtualizes 143 items — far fewer than 143 rows render eagerly', () => {
    const items = Array.from({ length: 143 }, (_, i) =>
      mkItem({ id: `i${i}`, name: `Item ${String(i).padStart(3, '0')}`, category: 'Protein', currentStock: 50, parLevel: 40 }),
    );
    seed(items);
    const { root, getByTestId } = render(<PhoneInventoryList />);
    expect(getByTestId('phone-inv-flatlist')).toBeTruthy();
    const rendered = root.findAll(
      (n: any) => typeof n.props?.testID === 'string' && n.props.testID.startsWith('phone-inv-row-'),
    );
    expect(rendered.length).toBeGreaterThan(0);
    expect(rendered.length).toBeLessThan(143);
  });
});
