// src/screens/cmd/sections/eod/__tests__/PhoneEodCount.test.tsx — Spec 140 §6.
//
// Component coverage for the phone-tier EOD worksheet + keypad sheet. Renders
// `PhoneEodCount` with a synthetic, stateful `model` (mirroring what the parent
// lifts) so digit write-through, advance-with-wrap, the submit-bar wiring, and
// the pendingFocusItem→open-sheet bridge are exercised at the phone tier.
//
// Boundary mock: importing PhoneEodCount transitively reaches EODCountSection →
// ../../../lib/db → ../../../lib/supabase, which crashes at module load when
// EXPO_PUBLIC_SUPABASE_* is unset (same shape as the sibling section tests).

import React from 'react';
import { fireEvent, render } from '@testing-library/react-native';
import Toast from 'react-native-toast-message';

jest.mock('../../../../../lib/supabase', () => ({
  __esModule: true,
  supabase: {
    auth: {
      getSession: jest.fn(() => Promise.resolve({ data: { session: null }, error: null })),
      onAuthStateChange: jest.fn(() => ({ data: { subscription: { unsubscribe: jest.fn() } } })),
    },
    from: jest.fn(() => ({
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      single: jest.fn(() => Promise.resolve({ data: null, error: null })),
    })),
    rpc: jest.fn(() => Promise.resolve({ data: null, error: null })),
    channel: jest.fn(() => ({ on: jest.fn().mockReturnThis(), subscribe: jest.fn(() => ({ unsubscribe: jest.fn() })) })),
    removeChannel: jest.fn(),
    functions: { invoke: jest.fn() },
  },
}));

import PhoneEodCount, { type PhoneEodModel, type PhoneDayCell } from '../PhoneEodCount';
import type { InventoryItem, Vendor } from '../../../../../types';

function makeItem(over: Partial<InventoryItem> & { id: string; name: string }): InventoryItem {
  return {
    category: 'General',
    unit: 'ea',
    caseQty: 1,
    parLevel: 0,
    currentStock: 0,
    vendorId: 'v1',
    vendorIds: ['v1'],
    ...over,
  } as unknown as InventoryItem;
}

const WEEK: PhoneDayCell[] = [
  { day: 'Wednesday', date: 'Jul 1', iso: '2026-07-01', status: 'today', counted: 0, total: 0 },
];

const VENDOR_TABS = [
  { id: 'v1', name: 'BJ', count: 3 } as unknown as Vendor & { count: number },
];

// Stateful harness: holds the count maps in React state so write-through digit
// entry re-renders the worksheet + sheet exactly like the parent does.
function Harness(props: {
  items: InventoryItem[];
  onSubmit?: () => void;
  pendingFocusItem?: string | null;
  extraCounted?: string[];
  initialUnit?: Record<string, string>;
  isVendorLocked?: boolean;
  isRestDay?: boolean;
}) {
  const [caseCounts, setCaseCountsState] = React.useState<Record<string, string>>({});
  const [unitCounts, setUnitCountsState] = React.useState<Record<string, string>>(props.initialUnit ?? {});
  const [notes, setNotesState] = React.useState<Record<string, string>>({});

  const localHasEntry = (id: string) =>
    (caseCounts[id] ?? '').trim() !== '' || (unitCounts[id] ?? '').trim() !== '';
  const countedItemIds = new Set<string>([
    ...props.items.filter((i) => localHasEntry(i.id)).map((i) => i.id),
    ...(props.extraCounted ?? []),
  ]);
  const hasEntry = (id: string) => localHasEntry(id) || countedItemIds.has(id);
  const itemTotal = (i: InventoryItem) => {
    const c = parseFloat(caseCounts[i.id] || '');
    const u = parseFloat(unitCounts[i.id] || '');
    return (isNaN(c) ? 0 : c) * (i.caseQty || 1) + (isNaN(u) ? 0 : u);
  };
  const countedNum = props.items.filter((i) => hasEntry(i.id)).length;

  const model: PhoneEodModel = {
    week: WEEK,
    selectedIso: '2026-07-01',
    setSelectedIso: () => {},
    wkNum: 27,
    vendorTabs: VENDOR_TABS,
    selectedVendorId: 'v1',
    setSelectedVendorId: () => {},
    setSelectedCategory: () => {},
    submittedVendorIds: new Set(),
    countedItemIds,
    storeInventory: props.items,
    filteredItems: props.items,
    caseCounts,
    unitCounts,
    notes,
    setCaseCounts: (u) => setCaseCountsState((p) => u(p)),
    setUnitCounts: (u) => setUnitCountsState((p) => u(p)),
    setNotes: (u) => setNotesState((p) => u(p)),
    hasEntry,
    localHasEntry,
    itemTotal,
    countedNum,
    total: props.items.length,
    isRestDay: props.isRestDay ?? false,
    isVendorLocked: props.isVendorLocked ?? false,
    isCurrentVendorEditing: false,
    currentVendorSubmission: null,
    submitting: false,
    onSubmit: props.onSubmit ?? (() => {}),
    onEditCurrentVendor: () => {},
    pendingFocusItem: props.pendingFocusItem ?? null,
    tabId: 'count.tsx',
    setTabId: () => {},
  };

  return <PhoneEodCount model={model} />;
}

beforeEach(() => jest.clearAllMocks());

describe('PhoneEodCount — indicator square (AC-5 / spec 102)', () => {
  it('shows ✓ for a counted row and none for an uncounted row', () => {
    const items = [
      makeItem({ id: 'a', name: 'Apple' }),
      makeItem({ id: 'b', name: 'Bread' }),
    ];
    const { queryByTestId } = render(<Harness items={items} initialUnit={{ a: '5' }} />);
    expect(queryByTestId('eod-counted-a')).toBeTruthy();
    expect(queryByTestId('eod-counted-b')).toBeNull();
  });

  it('counted-once-globally: an item counted under ANOTHER vendor reads counted here', () => {
    const items = [makeItem({ id: 'shared', name: 'Shared' })];
    const { queryByTestId } = render(<Harness items={items} extraCounted={['shared']} />);
    expect(queryByTestId('eod-counted-shared')).toBeTruthy();
  });
});

describe('PhoneEodCount — keypad sheet (AC-7 / AC-8 / AC-9)', () => {
  it('tapping a well opens the keypad sheet seated on that item', () => {
    const items = [makeItem({ id: 'a', name: 'Apple', unit: 'lb' })];
    const { getByTestId, queryByTestId } = render(<Harness items={items} />);
    expect(queryByTestId('eod-key-1')).toBeNull();
    fireEvent.press(getByTestId('eod-well-a-units'));
    expect(getByTestId('eod-key-1')).toBeTruthy();
    expect(getByTestId('eod-sheet-title').props.children).toBe('Apple');
  });

  it('digit entry writes through to the well + running total (0 is valid)', () => {
    const items = [makeItem({ id: 'a', name: 'Apple', unit: 'lb' })];
    const { getByTestId, getByText } = render(<Harness items={items} />);
    fireEvent.press(getByTestId('eod-well-a-units'));
    fireEvent.press(getByTestId('eod-key-1'));
    fireEvent.press(getByTestId('eod-key-2'));
    // Running total reads from the same maps: cases×caseQty + units = 12.
    expect(getByText('= 12 lb total')).toBeTruthy();
    // The row now reads as counted.
    expect(getByTestId('eod-counted-a')).toBeTruthy();
  });

  it('NEXT ITEM advances to the next uncounted item; relabels DONE ✓ when none remain', () => {
    const items = [
      makeItem({ id: 'a', name: 'Apple', unit: 'lb' }),
      makeItem({ id: 'b', name: 'Bread', unit: 'ea' }),
    ];
    // a counted initially; open on b (uncounted).
    const { getByTestId, getByText, queryByTestId } = render(<Harness items={items} initialUnit={{ a: '5' }} />);
    fireEvent.press(getByTestId('eod-well-b-units'));
    expect(getByTestId('eod-sheet-title').props.children).toBe('Bread');
    // Count b → all counted → NEXT relabels to DONE ✓.
    fireEvent.press(getByTestId('eod-key-3'));
    expect(getByText('DONE ✓')).toBeTruthy();
    // Tapping DONE closes the sheet + fires the all-counted toast.
    fireEvent.press(getByTestId('eod-sheet-next'));
    expect(queryByTestId('eod-key-1')).toBeNull();
    expect(Toast.show).toHaveBeenCalledWith(
      expect.objectContaining({ text1: 'All items counted ✓' }),
    );
  });

  it('NEXT ITEM wraps around to the top', () => {
    const items = [
      makeItem({ id: 'a', name: 'Apple' }),
      makeItem({ id: 'b', name: 'Bread' }),
      makeItem({ id: 'c', name: 'Cream' }),
    ];
    // b + c counted; a uncounted. Open on c (last), NEXT wraps to a.
    const { getByTestId } = render(<Harness items={items} initialUnit={{ b: '1', c: '1' }} />);
    fireEvent.press(getByTestId('eod-well-c-units'));
    fireEvent.press(getByTestId('eod-sheet-next'));
    expect(getByTestId('eod-sheet-title').props.children).toBe('Apple');
  });

  it('SKIP advances without recording the current item', () => {
    const items = [
      makeItem({ id: 'a', name: 'Apple' }),
      makeItem({ id: 'b', name: 'Bread' }),
    ];
    const { getByTestId, queryByTestId } = render(<Harness items={items} />);
    fireEvent.press(getByTestId('eod-well-a-units'));
    fireEvent.press(getByTestId('eod-sheet-skip'));
    // Advanced to b, and a was NOT recorded.
    expect(getByTestId('eod-sheet-title').props.children).toBe('Bread');
    expect(queryByTestId('eod-counted-a')).toBeNull();
  });

  it('switching the active field lets the pad write the CS well when caseQty > 1', () => {
    const items = [makeItem({ id: 'a', name: 'Apple', unit: 'lb', caseQty: 25 })];
    const { getByTestId, getByText } = render(<Harness items={items} />);
    // Open on the CS well — active field is cases (caseQty > 1).
    fireEvent.press(getByTestId('eod-well-a-cases'));
    fireEvent.press(getByTestId('eod-key-2'));
    // 2 cases × 25 = 50 lb total.
    expect(getByText('= 50 lb total')).toBeTruthy();
  });
});

describe('PhoneEodCount — submit bar + gate bridge (AC-10 / AC-11)', () => {
  it('the submit button calls the reused onSubmit', () => {
    const onSubmit = jest.fn();
    const items = [makeItem({ id: 'a', name: 'Apple' })];
    const { getByTestId } = render(<Harness items={items} onSubmit={onSubmit} initialUnit={{ a: '1' }} />);
    fireEvent.press(getByTestId('eod-submit'));
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it('a non-null pendingFocusItem opens the keypad sheet on that item (gate jump)', () => {
    const items = [
      makeItem({ id: 'a', name: 'Apple' }),
      makeItem({ id: 'b', name: 'Bread' }),
    ];
    const { getByTestId } = render(<Harness items={items} pendingFocusItem="b" />);
    expect(getByTestId('eod-key-1')).toBeTruthy();
    expect(getByTestId('eod-sheet-title').props.children).toBe('Bread');
  });
});
