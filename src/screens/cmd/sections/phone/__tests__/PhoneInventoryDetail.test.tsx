// src/screens/cmd/sections/phone/__tests__/PhoneInventoryDetail.test.tsx
//
// Spec 142 §6 (AC-INV4) — the full-screen item detail content: pill + caption +
// name, the stat panel, the COUNT NOW (EOD deep-link) + VIEW IN ORDERING
// actions, the PROPERTIES card, and the RECENT COUNTS history. supabase is
// stubbed (useStore imports it at module load); getItemStatus is the real
// selector.

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

import { PhoneInventoryDetail } from '../PhoneInventoryDetail';
import { useStore } from '../../../../../store/useStore';
import { usePaletteAction } from '../../../../../lib/paletteAction';

function mkItem(over: Partial<any> = {}): any {
  return {
    id: 'i1', catalogId: 'i1', name: 'Chicken Wings', category: 'Protein', unit: 'lbs',
    costPerUnit: 2.5, currentStock: 12, parLevel: 40, averageDailyUsage: 4, safetyStock: 0,
    vendorId: 'v1', vendorName: 'BJ', usagePerPortion: 0, lastUpdatedBy: 'u', lastUpdatedAt: new Date().toISOString(),
    eodRemaining: 0, storeId: 'store-1', casePrice: 40, caseQty: 25, subUnitSize: 1, subUnitUnit: 'lb', ...over,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  usePaletteAction.setState({ pending: null });
  useStore.setState({
    currentStore: { id: 'store-1', brandId: 'b', name: 'F', address: '', status: 'active' } as any,
    vendors: [{ id: 'v1', name: 'BJ Wholesale' } as any],
    auditLog: [],
  });
});

describe('PhoneInventoryDetail — AC-INV4', () => {
  it('renders name, stat panel, and PROPERTIES card', () => {
    const { getByText, getByTestId } = render(<PhoneInventoryDetail item={mkItem()} />);
    expect(getByText('Chicken Wings')).toBeTruthy();
    expect(getByTestId('phone-inv-statpanel')).toBeTruthy();
    // On-hand hero shows the current stock.
    expect(getByText('12')).toBeTruthy();
    // PROPERTIES card renders the label/value rows.
    expect(getByTestId('phone-inv-properties')).toBeTruthy();
    expect(getByText('CATEGORY')).toBeTruthy();
    expect(getByText('DAYS OF STOCK')).toBeTruthy();
  });

  it('COUNT NOW deep-links into the EOD keypad for this item', () => {
    const { getByTestId } = render(<PhoneInventoryDetail item={mkItem()} />);
    fireEvent.press(getByTestId('phone-inv-count-now'));
    expect(usePaletteAction.getState().pending).toEqual({ section: 'EODCount', selectedName: null, eodFocusItemId: 'i1' });
  });

  it('VIEW IN ORDERING jumps to the Ordering section', () => {
    const { getByTestId } = render(<PhoneInventoryDetail item={mkItem()} />);
    fireEvent.press(getByTestId('phone-inv-view-ordering'));
    expect(usePaletteAction.getState().pending).toEqual({ section: 'Ordering', selectedName: null });
  });

  it('RECENT COUNTS renders the item audit history', () => {
    useStore.setState({
      auditLog: [{ id: 'a1', itemRef: 'chicken wings', userName: 'Maria', value: '12 lbs', timestamp: new Date().toISOString(), action: 'EOD entry' } as any],
    });
    const { getByText } = render(<PhoneInventoryDetail item={mkItem()} />);
    expect(getByText('RECENT COUNTS')).toBeTruthy();
    expect(getByText(/Maria/)).toBeTruthy();
  });

  it('RECENT COUNTS shows an empty state when there is no history', () => {
    const { getByText } = render(<PhoneInventoryDetail item={mkItem()} />);
    expect(getByText('no activity recorded')).toBeTruthy();
  });
});

// ── Spec 160 — the LAST COUNTED row reads count history, not last-edited ──
describe('PhoneInventoryDetail — LAST COUNTED (spec 160 AC-1 / AC-9 / AC-12)', () => {
  const DAY = 86_400_000;
  const realAgo = (ms: number) => new Date(Date.now() - ms).toISOString();

  it('AC-9 — shows the loading phrase, never "never counted", while unloaded', () => {
    useStore.setState({ lastCountedByItem: {}, lastCountedLoaded: false, lastCountedStoreId: null });
    const { getByText, queryByText } = render(<PhoneInventoryDetail item={mkItem()} />);
    expect(getByText('LAST COUNTED')).toBeTruthy();
    expect(getByText('loading')).toBeTruthy();
    expect(queryByText('never counted')).toBeNull();
  });

  it('AC-12 — shows the absolute date AND the relative age once loaded', () => {
    useStore.setState({
      lastCountedByItem: { i1: realAgo(3 * DAY) },
      lastCountedLoaded: true,
      lastCountedStoreId: 'store-1',
    });
    const { getByText } = render(<PhoneInventoryDetail item={mkItem()} />);
    expect(getByText(/^[A-Za-z]+ \d{1,2}, \d{4} · 3d$/)).toBeTruthy();
  });

  it('AC-5 — a null value renders "never counted"', () => {
    useStore.setState({
      lastCountedByItem: { i1: null },
      lastCountedLoaded: true,
      lastCountedStoreId: 'store-1',
    });
    const { getByText } = render(<PhoneInventoryDetail item={mkItem()} />);
    expect(getByText('never counted')).toBeTruthy();
  });

  it('AC-1 — a fresh lastUpdatedAt (plain EDIT) does not make the row look counted', () => {
    useStore.setState({
      lastCountedByItem: { i1: realAgo(40 * DAY) },
      lastCountedLoaded: true,
      lastCountedStoreId: 'store-1',
    });
    const { getByText } = render(
      <PhoneInventoryDetail item={mkItem({ lastUpdatedAt: new Date().toISOString() })} />,
    );
    expect(getByText(/· 1mo$/)).toBeTruthy();
  });

  it('guards a cross-store map — another store\'s map falls back to loading', () => {
    useStore.setState({
      lastCountedByItem: { i1: realAgo(3 * DAY) },
      lastCountedLoaded: true,
      lastCountedStoreId: 'store-2',
    });
    const { getByText } = render(<PhoneInventoryDetail item={mkItem()} />);
    expect(getByText('loading')).toBeTruthy();
  });
});
