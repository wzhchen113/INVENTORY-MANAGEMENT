// src/screens/staff/screens/EODCount.borrowed.spec200.test.tsx — Spec 200.
//
// Staff EOD counts a shared item ONCE across vendors: a shared item another
// vendor already counted tonight (store, count date) is pre-filled, labelled
// "Counted under {vendor}", counts for the gate / X-of-N / advance, and is
// omitted from this vendor's payload unless the vendor is all-borrowed.
//
// Harness copied from EODCount.test.tsx (mocks at the useEodSubmit hook
// boundary; supabase.from() stubbed via a shared vendor/item/existing stack).
// The borrow-source read (`fetchBorrowSources`) is its own module mock seam.

import { fireEvent, render, waitFor } from '@testing-library/react-native';
import Toast from 'react-native-toast-message';

jest.setTimeout(15000);

const mockSubmit = jest.fn();
jest.mock('../hooks/useEodSubmit', () => ({
  useEodSubmit: () => ({
    submit: mockSubmit,
    pending: 0,
    draining: false,
  }),
}));

jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ navigate: jest.fn() }),
}));

type QueryResult = { data: unknown; error: unknown };
let mockNextResultStack: QueryResult[] = [];

function mockQueryBuilder(table: string) {
  if (table === 'user_count_orders') {
    const builder: Record<string, unknown> = {
      select: () => builder,
      eq: () => builder,
      is: () => builder,
      upsert: () => Promise.resolve({ data: null, error: null }),
      delete: () => builder,
      maybeSingle: () => Promise.resolve({ data: null, error: null }),
      then: (resolve: (v: QueryResult) => unknown) => resolve({ data: null, error: null }),
    };
    return builder;
  }
  const result = mockNextResultStack.shift() ?? { data: [], error: null };
  const builder: Record<string, unknown> = {
    select: () => builder,
    eq: () => builder,
    is: () => builder,
    order: () => builder,
    maybeSingle: () => Promise.resolve(result),
    then: (resolve: (v: QueryResult) => unknown) => resolve(result),
  };
  return builder;
}

jest.mock('../../../lib/supabase', () => ({
  supabase: {
    from: (table: string) => mockQueryBuilder(table),
    rpc: (_fn: string) => Promise.resolve({ data: [], error: null }),
  },
}));

jest.mock('../lib/yesterdayStatus', () => ({
  fetchYesterdayIncomplete: () => Promise.resolve(false),
}));

const mockSubmittedVendorIds = jest.fn().mockResolvedValue(new Set<string>());
jest.mock('../lib/submittedStatus', () => ({
  fetchSubmittedVendorIds: (...args: unknown[]) => mockSubmittedVendorIds(...args),
}));

const mockFetchBorrowSources = jest.fn();
jest.mock('../lib/borrowSources', () => ({
  fetchBorrowSources: (...args: unknown[]) => mockFetchBorrowSources(...args),
}));

// AC-20 — the pre-submit stock check is its own module mock seam. Each
// all-borrowed arm sets `mockStock` (item id → current_stock as PostgREST
// returns it); an unset id reads as missing → mismatch (fail closed).
let mockStock: Record<string, number | string | null> = {};
const mockFetchCurrentStock = jest.fn();
jest.mock('../lib/stockCheck', () => ({
  fetchCurrentStock: (...args: unknown[]) => mockFetchCurrentStock(...args),
}));

const mockNotify = jest.fn();
jest.mock('../lib/notifyBackendError', () => ({
  notifyBackendError: (...args: unknown[]) => mockNotify(...args),
}));

import { act } from '@testing-library/react-native';
import { EODCount } from './EODCount';
import { useStaffStore } from '../store/useStaffStore';
import { todayIso } from '../lib/date';
import type { EodEntry, QueuedSubmission, ServerEodSource } from '../lib/types';

const STORE = 'store-1';
const USER = 'user-1';
const A = 'v-a'; // Sysco — the other vendor that counted X first
const B = 'v-b'; // US Foods — the vendor being counted (selected by default)
const X = 'item-x'; // shared (A + B)
const X2 = 'item-x2'; // shared (A + B)
const Y = 'item-y'; // B only
const W = 'item-w'; // B only

type Api = ReturnType<typeof render>;

const TODAY = () => todayIso(new Date());

// B is first in the schedule → selected on load; A is in the chip list too
// (names a QUEUED source, R4).
const vendorsBA = {
  data: [
    { vendor_id: B, vendor_name: 'US Foods', vendor: { id: B, name: 'US Foods' } },
    { vendor_id: A, vendor_name: 'Sysco', vendor: { id: A, name: 'Sysco' } },
  ],
  error: null,
};

function itemsFixture(rows: Array<{ id: string; name: string; caseQty?: number; mode?: string }>) {
  return {
    data: rows.map((r) => ({
      vendor_id: B,
      item: {
        id: r.id,
        store_id: STORE,
        catalog: {
          name: r.name,
          unit: 'lb',
          case_qty: r.caseQty ?? 12,
          ...(r.mode ? { eod_count_mode: r.mode } : {}),
        },
      },
    })),
    error: null,
  };
}
const NONE = { data: null, error: null };

function units(itemId: string, n: number): EodEntry {
  return { item_id: itemId, actual_remaining: n, actual_remaining_cases: null, actual_remaining_each: n };
}
const noNeedEntry = (itemId: string): EodEntry => ({
  item_id: itemId,
  actual_remaining: null,
  actual_remaining_cases: null,
  actual_remaining_each: null,
  no_need: true,
});

// The snapshot: A's submitted submission at (store, today) holds X = 5 units.
function sourceA(entries: EodEntry[], over: Partial<ServerEodSource> = {}): ServerEodSource {
  return {
    submissionId: 'aaaaaaaa-0000-4000-8000-000000000001',
    storeId: STORE,
    date: TODAY(),
    vendorId: A,
    vendorName: 'Sysco',
    status: 'submitted',
    submittedAt: '2026-11-18T20:00:00.123456+00:00',
    entries,
    ...over,
  };
}

function ownSubmission(entries: Array<{ item_id: string; units: number }>) {
  return {
    data: {
      id: 'sub-b',
      submitted_at: '2026-11-18T21:00:00Z',
      eod_entries: entries.map((e) => ({
        item_id: e.item_id,
        actual_remaining: e.units,
        actual_remaining_cases: null,
        actual_remaining_each: e.units,
        no_need: false,
      })),
    },
    error: null,
  };
}

function pressKeys(api: Api, value: string) {
  for (const ch of value.split('')) {
    fireEvent.press(api.getByTestId(ch === '.' ? 'eod-key-dot' : ch === '⌫' ? 'eod-key-back' : `eod-key-${ch}`));
  }
}

async function enterCount(api: Api, itemId: string, field: 'cases' | 'units', value: string) {
  fireEvent.press(await api.findByTestId(`eod-well-${itemId}-${field}`));
  await api.findByTestId('eod-sheet-title');
  pressKeys(api, value);
  fireEvent.press(api.getByTestId('eod-sheet-close'));
}

function wellValue(api: Api, itemId: string, field: 'cases' | 'units'): unknown {
  return api.getByTestId(`eod-item-${field}-${itemId}`).props.children;
}

function countedLabel(api: Api): string {
  return String(api.getByTestId('eod-counted-label').props.children);
}

function borrowedLabel(api: Api, itemId: string): string | null {
  const n = api.queryByTestId(`eod-borrowed-${itemId}`);
  return n ? String(n.props.children) : null;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockSubmit.mockReset();
  mockNextResultStack = [];
  mockSubmittedVendorIds.mockReset();
  mockSubmittedVendorIds.mockResolvedValue(new Set<string>());
  mockFetchBorrowSources.mockReset();
  mockFetchBorrowSources.mockResolvedValue([]);
  mockStock = {};
  mockFetchCurrentStock.mockReset();
  mockFetchCurrentStock.mockImplementation((_store: string, ids: string[]) =>
    Promise.resolve(
      new Map(ids.filter((id) => id in mockStock).map((id) => [id, mockStock[id]] as const)),
    ),
  );
  useStaffStore.setState({ locale: 'en' });
  useStaffStore.setState({
    authState: {
      kind: 'signed-in',
      userId: USER,
      stores: [{ storeId: STORE, storeName: 'Frederick' }],
    },
    activeStore: { id: STORE, name: 'Frederick' },
    eodQueue: [],
    draining: false,
  });
});

describe('EODCount — spec 200 shared item counted once', () => {
  it('AC-2: X is pre-filled with A\'s 5 units + "Counted under Sysco"; Y blank; "1 of 2 counted"', async () => {
    mockFetchBorrowSources.mockResolvedValue([sourceA([units(X, 5)])]);
    mockNextResultStack = [vendorsBA, itemsFixture([{ id: X, name: 'Flour' }, { id: Y, name: 'Sugar' }]), NONE];
    const api = render(<EODCount />);
    // First test in the file: it pays the cold module/render cost, which can
    // exceed waitFor's default 1 s on a slow CI runner (failed run 44502645676).
    await waitFor(() => expect(borrowedLabel(api, X)).toBe('Counted under Sysco'), { timeout: 5000 });
    expect(mockFetchBorrowSources).toHaveBeenCalledWith(STORE, TODAY());
    expect(wellValue(api, X, 'units')).toBe('5');
    expect(wellValue(api, X, 'cases')).toBe('—');
    expect(api.getByTestId(`eod-counted-${X}`)).toBeTruthy();
    expect(api.queryByTestId(`eod-counted-${Y}`)).toBeNull();
    expect(wellValue(api, Y, 'units')).toBe('—');
    expect(borrowedLabel(api, Y)).toBeNull();
    expect(countedLabel(api)).toBe('1 of 2 counted');
  });

  it('AC-3 + AC-8: with Y counted and X untouched the gate passes; entries hold Y and NOT X', async () => {
    mockSubmit.mockResolvedValue({ kind: 'success', submission_id: 'sub-b' });
    mockFetchBorrowSources.mockResolvedValue([sourceA([units(X, 5)])]);
    mockNextResultStack = [vendorsBA, itemsFixture([{ id: X, name: 'Flour' }, { id: Y, name: 'Sugar' }]), NONE, NONE];
    const api = render(<EODCount />);
    await waitFor(() => expect(borrowedLabel(api, X)).not.toBeNull());
    await enterCount(api, Y, 'units', '4');
    fireEvent.press(api.getByTestId('eod-submit'));
    await waitFor(() => expect(mockSubmit).toHaveBeenCalledTimes(1));
    expect(mockSubmit.mock.calls[0][0].entries).toEqual([units(Y, 4)]);
  });

  it('AC-3: with Y blank the gate blocks, reports 1 remaining, and opens the sheet on Y (not X)', async () => {
    mockFetchBorrowSources.mockResolvedValue([sourceA([units(X, 5)])]);
    mockNextResultStack = [vendorsBA, itemsFixture([{ id: X, name: 'Flour' }, { id: Y, name: 'Sugar' }]), NONE];
    const api = render(<EODCount />);
    await waitFor(() => expect(borrowedLabel(api, X)).not.toBeNull());
    fireEvent.press(api.getByTestId('eod-submit'));
    await waitFor(() => expect(Toast.show).toHaveBeenCalled());
    expect(mockSubmit).not.toHaveBeenCalled();
    expect((Toast.show as jest.Mock).mock.calls[0][0]).toMatchObject({
      text1: 'Count every item first',
      text2: '1 still need a count',
    });
    expect((await api.findByTestId('eod-sheet-title')).props.children).toBe('Sugar');
  });

  it('AC-4: NEXT from the row before X skips X; DONE shows once Y is counted', async () => {
    mockFetchBorrowSources.mockResolvedValue([sourceA([units(X, 5)])]);
    mockNextResultStack = [
      vendorsBA,
      itemsFixture([{ id: W, name: 'Salt' }, { id: X, name: 'Flour' }, { id: Y, name: 'Sugar' }]),
      NONE,
    ];
    const api = render(<EODCount />);
    await waitFor(() => expect(borrowedLabel(api, X)).not.toBeNull());
    fireEvent.press(api.getByTestId(`eod-well-${W}-units`));
    await api.findByTestId('eod-sheet-title');
    pressKeys(api, '1');
    fireEvent.press(api.getByTestId('eod-sheet-next'));
    expect(api.getByTestId('eod-sheet-title').props.children).toBe('Sugar');
    expect(api.getByTestId('eod-sheet-next').props.accessibilityLabel).toBe('Next item →');
    pressKeys(api, '2');
    expect(api.getByTestId('eod-sheet-next').props.accessibilityLabel).toBe('Done ✓');
  });

  it('AC-5: no borrow when the only sources are another date, another store, a draft, or lack X', async () => {
    mockFetchBorrowSources.mockResolvedValue([
      sourceA([units(X, 5)], { submissionId: 's1', date: '1999-01-01' }),
      sourceA([units(X, 5)], { submissionId: 's2', storeId: 'store-other' }),
      sourceA([units(X, 5)], { submissionId: 's3', status: 'draft' }),
      sourceA([units(Y, 1)], { submissionId: 's4', vendorId: 'v-c', vendorName: 'BJs' }),
    ]);
    mockNextResultStack = [vendorsBA, itemsFixture([{ id: X, name: 'Flour' }, { id: W, name: 'Salt' }]), NONE];
    const api = render(<EODCount />);
    await api.findByTestId(`eod-well-${X}-units`);
    await waitFor(() => expect(mockFetchBorrowSources).toHaveBeenCalled());
    expect(borrowedLabel(api, X)).toBeNull();
    expect(wellValue(api, X, 'units')).toBe('—');
    expect(api.queryByTestId(`eod-counted-${X}`)).toBeNull();
    expect(countedLabel(api)).toBe('0 of 2 counted');
  });

  it('AC-5: toggling the count date to yesterday drops today\'s source (re-read for yesterday)', async () => {
    const today = TODAY();
    mockFetchBorrowSources.mockImplementation((_s: string, iso: string) =>
      Promise.resolve(iso === today ? [sourceA([units(X, 5)])] : []),
    );
    mockNextResultStack = [
      vendorsBA,
      itemsFixture([{ id: X, name: 'Flour' }]),
      NONE,
      vendorsBA, // yesterday's schedule
      itemsFixture([{ id: X, name: 'Flour' }]),
      NONE,
    ];
    const api = render(<EODCount />);
    await waitFor(() => expect(borrowedLabel(api, X)).not.toBeNull());
    fireEvent.press(api.getByTestId('eod-date-yesterday'));
    await waitFor(() => expect(borrowedLabel(api, X)).toBeNull());
    const y = new Date();
    y.setDate(y.getDate() - 1);
    expect(mockFetchBorrowSources).toHaveBeenCalledWith(STORE, todayIso(y));
    expect(wellValue(api, X, 'units')).toBe('—');
  });

  it('AC-6 + AC-7: open/close keeps it borrowed; typing 7 makes it own (payload 7); clearing falls back to A\'s 5', async () => {
    mockSubmit.mockResolvedValue({ kind: 'success', submission_id: 'sub-b' });
    mockFetchBorrowSources.mockResolvedValue([sourceA([units(X, 5)])]);
    mockNextResultStack = [vendorsBA, itemsFixture([{ id: X, name: 'Flour' }, { id: Y, name: 'Sugar' }]), NONE, NONE];
    const api = render(<EODCount />);
    await waitFor(() => expect(borrowedLabel(api, X)).not.toBeNull());

    // Open + close with no key: still borrowed. The sheet shows the borrowed 5.
    fireEvent.press(api.getByTestId(`eod-well-${X}-units`));
    await api.findByTestId('eod-sheet-title');
    expect(String(api.getByTestId('eod-sheet-total').props.children)).toContain('5');
    fireEvent.press(api.getByTestId('eod-sheet-close'));
    expect(borrowedLabel(api, X)).toBe('Counted under Sysco');

    // First key replaces the seated field: 7 on a borrowed 5 → own 7.
    await enterCount(api, X, 'units', '7');
    expect(borrowedLabel(api, X)).toBeNull();
    expect(wellValue(api, X, 'units')).toBe('7');
    expect(api.getByTestId(`eod-counted-${X}`)).toBeTruthy();

    // AC-7: clear back to blank → A's 5 + the label again, still counted.
    await enterCount(api, X, 'units', '⌫');
    expect(borrowedLabel(api, X)).toBe('Counted under Sysco');
    expect(wellValue(api, X, 'units')).toBe('5');
    expect(api.getByTestId(`eod-counted-${X}`)).toBeTruthy();

    // Re-edit to 7 and submit: X ships as own, built by eodRowEntryValues.
    await enterCount(api, X, 'units', '7');
    await enterCount(api, Y, 'units', '4');
    fireEvent.press(api.getByTestId('eod-submit'));
    await waitFor(() => expect(mockSubmit).toHaveBeenCalledTimes(1));
    expect(mockSubmit.mock.calls[0][0].entries).toEqual([units(X, 7), units(Y, 4)]);
  });

  it('AC-9: an all-borrowed vendor submits verbatim copies, turns green and locks', async () => {
    // AC-20 — stock unchanged since A's count ("5.000" = 5: formatting tolerated).
    mockStock = { [X]: '5.000', [X2]: 26 };
    mockSubmit.mockResolvedValue({ kind: 'success', submission_id: 'sub-b' });
    const x2: EodEntry = { item_id: X2, actual_remaining: 26, actual_remaining_cases: 2, actual_remaining_each: 2 };
    mockFetchBorrowSources.mockResolvedValue([sourceA([units(X, 5), x2])]);
    mockNextResultStack = [vendorsBA, itemsFixture([{ id: X, name: 'Flour' }, { id: X2, name: 'Rice' }]), NONE, NONE];
    const api = render(<EODCount />);
    await waitFor(() => expect(borrowedLabel(api, X2)).not.toBeNull());
    expect(countedLabel(api)).toBe('2 of 2 counted');
    fireEvent.press(api.getByTestId('eod-submit'));
    await waitFor(() => expect(mockSubmit).toHaveBeenCalledTimes(1));
    const entries = mockSubmit.mock.calls[0][0].entries as EodEntry[];
    expect(entries).toEqual([units(X, 5), x2]);
    expect(entries.every((e) => !('no_need' in e))).toBe(true);
    // No "no counts entered" error; chip green; SUBMITTED_LOCKED ("Edit").
    expect((Toast.show as jest.Mock).mock.calls.map((c) => c[0].text2)).not.toContain('No counts entered');
    expect(await api.findByText('Edit')).toBeTruthy();
    expect(api.getByTestId(`eod-vendor-status-${B}`).props.accessibilityLabel).toBe('Submitted');
    // The copies are now B's OWN entries: locked view shows them, no label.
    await waitFor(() => expect(borrowedLabel(api, X)).toBeNull());
    expect(borrowedLabel(api, X2)).toBeNull();
    expect(wellValue(api, X, 'units')).toBe('5');
    expect(wellValue(api, X2, 'cases')).toBe('2');
    expect(countedLabel(api)).toBe('2 of 2 counted');
  });

  it('AC-9 mixed: once X2 is edited, the payload is only X2 (X omitted)', async () => {
    mockSubmit.mockResolvedValue({ kind: 'success', submission_id: 'sub-b' });
    mockFetchBorrowSources.mockResolvedValue([sourceA([units(X, 5), units(X2, 6)])]);
    mockNextResultStack = [vendorsBA, itemsFixture([{ id: X, name: 'Flour' }, { id: X2, name: 'Rice' }]), NONE, NONE];
    const api = render(<EODCount />);
    await waitFor(() => expect(borrowedLabel(api, X2)).not.toBeNull());
    await enterCount(api, X2, 'units', '9');
    fireEvent.press(api.getByTestId('eod-submit'));
    await waitFor(() => expect(mockSubmit).toHaveBeenCalledTimes(1));
    expect(mockSubmit.mock.calls[0][0].entries).toEqual([units(X2, 9)]);
  });

  it('AC-10: a borrowed NO NEED shows as NO NEED + label, counts; omitted when mixed', async () => {
    mockSubmit.mockResolvedValue({ kind: 'success', submission_id: 'sub-b' });
    mockFetchBorrowSources.mockResolvedValue([sourceA([noNeedEntry(X)])]);
    mockNextResultStack = [vendorsBA, itemsFixture([{ id: X, name: 'Flour' }, { id: Y, name: 'Sugar' }]), NONE, NONE];
    const api = render(<EODCount />);
    await waitFor(() => expect(borrowedLabel(api, X)).toBe('Counted under Sysco'));
    expect(api.getByTestId(`eod-noneed-${X}`).props.accessibilityState).toEqual(
      expect.objectContaining({ selected: true }),
    );
    expect(wellValue(api, X, 'units')).toBe('—');
    expect(api.getByTestId(`eod-counted-${X}`)).toBeTruthy();
    await enterCount(api, Y, 'units', '1');
    fireEvent.press(api.getByTestId('eod-submit'));
    await waitFor(() => expect(mockSubmit).toHaveBeenCalledTimes(1));
    expect(mockSubmit.mock.calls[0][0].entries).toEqual([units(Y, 1)]);
  });

  it('AC-10: all-borrowed NO NEED ships no_need: true with null quantities', async () => {
    mockSubmit.mockResolvedValue({ kind: 'success', submission_id: 'sub-b' });
    mockFetchBorrowSources.mockResolvedValue([sourceA([noNeedEntry(X)])]);
    mockNextResultStack = [vendorsBA, itemsFixture([{ id: X, name: 'Flour' }]), NONE, NONE];
    const api = render(<EODCount />);
    await waitFor(() => expect(borrowedLabel(api, X)).not.toBeNull());
    fireEvent.press(api.getByTestId('eod-submit'));
    await waitFor(() => expect(mockSubmit).toHaveBeenCalledTimes(1));
    expect(mockSubmit.mock.calls[0][0].entries).toEqual([noNeedEntry(X)]);
    // AC-20 — NO NEED copies never write on-hand, so they are not stock-checked.
    expect(mockFetchCurrentStock).not.toHaveBeenCalled();
  });

  it('AC-11: live units_only, A recorded cases only → counts, shows the recorded cases, copied verbatim', async () => {
    mockStock = { [X]: 24 };
    mockSubmit.mockResolvedValue({ kind: 'success', submission_id: 'sub-b' });
    const casesOnly: EodEntry = { item_id: X, actual_remaining: 24, actual_remaining_cases: 2, actual_remaining_each: null };
    mockFetchBorrowSources.mockResolvedValue([sourceA([casesOnly])]);
    mockNextResultStack = [vendorsBA, itemsFixture([{ id: X, name: 'Flour', mode: 'units_only' }]), NONE, NONE];
    const api = render(<EODCount />);
    await waitFor(() => expect(borrowedLabel(api, X)).not.toBeNull());
    // Legacy layout (locked-row model): the CS well shows the recorded 2.
    expect(wellValue(api, X, 'cases')).toBe('2');
    expect(wellValue(api, X, 'units')).toBe('—');
    expect(api.getByTestId(`eod-counted-${X}`)).toBeTruthy();
    fireEvent.press(api.getByTestId('eod-submit'));
    await waitFor(() => expect(mockSubmit).toHaveBeenCalledTimes(1));
    // Not nulled by the live-mode builder.
    expect(mockSubmit.mock.calls[0][0].entries).toEqual([casesOnly]);
  });

  it('AC-12: own wins — B\'s own X = 3 shows with no label in SUBMITTED_LOCKED and EDITING', async () => {
    mockFetchBorrowSources.mockResolvedValue([sourceA([units(X, 5)])]);
    mockNextResultStack = [vendorsBA, itemsFixture([{ id: X, name: 'Flour' }]), ownSubmission([{ item_id: X, units: 3 }])];
    const api = render(<EODCount />);
    await waitFor(() => expect(wellValue(api, X, 'units')).toBe('3'));
    await waitFor(() => expect(mockFetchBorrowSources).toHaveBeenCalled());
    expect(borrowedLabel(api, X)).toBeNull();
    fireEvent.press(api.getByTestId('eod-submit')); // Edit
    await waitFor(() => expect(api.getByTestId('eod-cancel-edit')).toBeTruthy());
    expect(wellValue(api, X, 'units')).toBe('3');
    expect(borrowedLabel(api, X)).toBeNull();
  });

  it('AC-13: after a mixed submit the locked view shows X borrowed + counted; EDIT→Cancel brings it back', async () => {
    mockSubmit.mockResolvedValue({ kind: 'success', submission_id: 'sub-b' });
    mockFetchBorrowSources.mockResolvedValue([sourceA([units(X, 5)])]);
    mockNextResultStack = [
      vendorsBA,
      itemsFixture([{ id: X, name: 'Flour' }, { id: Y, name: 'Sugar' }]),
      NONE,
      ownSubmission([{ item_id: Y, units: 4 }]), // post-submit refetch
    ];
    const api = render(<EODCount />);
    await waitFor(() => expect(borrowedLabel(api, X)).not.toBeNull());
    await enterCount(api, Y, 'units', '4');
    fireEvent.press(api.getByTestId('eod-submit'));
    expect(await api.findByText('Edit')).toBeTruthy();
    // AC-15 — the server-source read ran again after the confirmed write.
    await waitFor(() => expect(mockFetchBorrowSources).toHaveBeenCalledTimes(2));
    expect(borrowedLabel(api, X)).toBe('Counted under Sysco');
    expect(wellValue(api, X, 'units')).toBe('5');
    expect(api.getByTestId(`eod-well-${X}-units`).props.accessibilityState?.disabled).toBe(true);
    expect(countedLabel(api)).toBe('2 of 2 counted');
    fireEvent.press(api.getByTestId('eod-submit')); // Edit
    await waitFor(() => expect(api.getByTestId('eod-cancel-edit')).toBeTruthy());
    fireEvent.press(api.getByTestId('eod-cancel-edit'));
    await waitFor(() => expect(api.queryByTestId('eod-cancel-edit')).toBeNull());
    expect(borrowedLabel(api, X)).toBe('Counted under Sysco');
    expect(wellValue(api, Y, 'units')).toBe('4');
    expect(countedLabel(api)).toBe('2 of 2 counted');
  });

  it('AC-13: the same holds after a queued (offline) submit under B', async () => {
    mockSubmit.mockResolvedValue({ kind: 'queued', client_uuid: 'q-1' });
    mockFetchBorrowSources.mockResolvedValue([sourceA([units(X, 5)])]);
    mockNextResultStack = [vendorsBA, itemsFixture([{ id: X, name: 'Flour' }, { id: Y, name: 'Sugar' }]), NONE];
    const api = render(<EODCount />);
    await waitFor(() => expect(borrowedLabel(api, X)).not.toBeNull());
    await enterCount(api, Y, 'units', '4');
    fireEvent.press(api.getByTestId('eod-submit'));
    expect(await api.findByText('Edit')).toBeTruthy();
    expect(mockSubmit.mock.calls[0][0].entries).toEqual([units(Y, 4)]);
    expect(borrowedLabel(api, X)).toBe('Counted under Sysco');
    expect(countedLabel(api)).toBe('2 of 2 counted');
  });

  it('AC-14: a queued A submission by this user borrows (named from the chip list); another user\'s does not', async () => {
    const q = (over: Partial<QueuedSubmission>): QueuedSubmission => ({
      client_uuid: 'qqqqqqqq-0000-4000-8000-000000000001',
      store_id: STORE,
      date: TODAY(),
      vendor_id: A,
      status: 'submitted',
      entries: [units(X, 5)],
      queued_at: new Date().toISOString(),
      intent_user_id: USER,
      attempts: 0,
      ...over,
    });
    useStaffStore.setState({
      eodQueue: [q({}), q({ client_uuid: 'qqqqqqqq-0000-4000-8000-000000000002', intent_user_id: 'user-other', entries: [units(Y, 2)] })],
    });
    mockNextResultStack = [vendorsBA, itemsFixture([{ id: X, name: 'Flour' }, { id: Y, name: 'Sugar' }]), NONE];
    const api = render(<EODCount />);
    await waitFor(() => expect(borrowedLabel(api, X)).toBe('Counted under Sysco'));
    expect(wellValue(api, X, 'units')).toBe('5');
    expect(borrowedLabel(api, Y)).toBeNull();
    expect(countedLabel(api)).toBe('1 of 2 counted');
  });

  it('R9 drain gap: when the queued source leaves the queue, the server sources are re-read', async () => {
    useStaffStore.setState({
      eodQueue: [
        {
          client_uuid: 'qqqqqqqq-0000-4000-8000-000000000001',
          store_id: STORE,
          date: TODAY(),
          vendor_id: A,
          status: 'submitted',
          entries: [units(X, 5)],
          queued_at: new Date().toISOString(),
          intent_user_id: USER,
          attempts: 0,
        },
      ],
    });
    mockNextResultStack = [vendorsBA, itemsFixture([{ id: X, name: 'Flour' }]), NONE];
    const api = render(<EODCount />);
    await waitFor(() => expect(borrowedLabel(api, X)).not.toBeNull());
    expect(mockFetchBorrowSources).toHaveBeenCalledTimes(1);
    // Drained: the server now holds A's row.
    mockFetchBorrowSources.mockResolvedValue([sourceA([units(X, 5)])]);
    act(() => {
      useStaffStore.setState({ eodQueue: [] });
    });
    await waitFor(() => expect(mockFetchBorrowSources).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(borrowedLabel(api, X)).toBe('Counted under Sysco'));
  });

  it('AC-15: a rejected server-source read → no server borrows, notifyBackendError, list + queued sources still work', async () => {
    mockFetchBorrowSources.mockRejectedValue(new Error('boom'));
    useStaffStore.setState({
      eodQueue: [
        {
          client_uuid: 'qqqqqqqq-0000-4000-8000-000000000001',
          store_id: STORE,
          date: TODAY(),
          vendor_id: 'v-gone', // not in the chip list → generic label
          status: 'submitted',
          entries: [units(Y, 2)],
          queued_at: new Date().toISOString(),
          intent_user_id: USER,
          attempts: 0,
        },
      ],
    });
    mockNextResultStack = [vendorsBA, itemsFixture([{ id: X, name: 'Flour' }, { id: Y, name: 'Sugar' }]), NONE];
    const api = render(<EODCount />);
    await api.findByTestId(`eod-well-${X}-units`);
    await waitFor(() => expect(mockNotify).toHaveBeenCalledWith('fetchBorrowSources', expect.any(Error)));
    expect(borrowedLabel(api, X)).toBeNull();
    expect(borrowedLabel(api, Y)).toBe('Counted under another vendor');
    expect(countedLabel(api)).toBe('1 of 2 counted');
  });
});

describe('EODCount — spec 200 AC-20 stock check before all-borrowed copies', () => {
  function seedAllBorrowed() {
    mockFetchBorrowSources.mockResolvedValue([sourceA([units(X, 5), units(X2, 6)])]);
    mockNextResultStack = [vendorsBA, itemsFixture([{ id: X, name: 'Flour' }, { id: X2, name: 'Rice' }]), NONE, NONE];
  }

  it('match → the copies are sent; the read is store-scoped to the copied numeric items', async () => {
    mockSubmit.mockResolvedValue({ kind: 'success', submission_id: 'sub-b' });
    mockStock = { [X]: 5, [X2]: '6.000' };
    seedAllBorrowed();
    const api = render(<EODCount />);
    await waitFor(() => expect(borrowedLabel(api, X2)).not.toBeNull());
    fireEvent.press(api.getByTestId('eod-submit'));
    await waitFor(() => expect(mockSubmit).toHaveBeenCalledTimes(1));
    expect(mockFetchCurrentStock).toHaveBeenCalledWith(STORE, [X, X2]);
    expect(mockSubmit.mock.calls[0][0].entries).toEqual([units(X, 5), units(X2, 6)]);
  });

  it('mismatch → no copies; the changed item needs a real count (toast + sheet on it); then only it is sent', async () => {
    mockSubmit.mockResolvedValue({ kind: 'success', submission_id: 'sub-b' });
    // A delivery landed after A counted X: current_stock 17 ≠ 5. X2 unchanged.
    mockStock = { [X]: 17, [X2]: 6 };
    seedAllBorrowed();
    const api = render(<EODCount />);
    await waitFor(() => expect(borrowedLabel(api, X)).not.toBeNull());
    fireEvent.press(api.getByTestId('eod-submit'));
    await waitFor(() =>
      expect((Toast.show as jest.Mock).mock.calls.map((c) => c[0])).toContainEqual(
        expect.objectContaining({
          text1: 'Stock changed since this was counted',
          text2: 'Please count it again (1)',
        }),
      ),
    );
    expect(mockSubmit).not.toHaveBeenCalled();
    // X is no longer borrowed: blank, uncounted, the sheet opened on it.
    expect((await api.findByTestId('eod-sheet-title')).props.children).toBe('Flour');
    expect(borrowedLabel(api, X)).toBeNull();
    expect(api.queryByTestId(`eod-counted-${X}`)).toBeNull();
    expect(borrowedLabel(api, X2)).toBe('Counted under Sysco');
    expect(countedLabel(api)).toBe('1 of 2 counted');
    // The row says why it needs a count (the toast can sit under the sheet).
    expect(String(api.getByTestId(`eod-recount-${X}`).props.children)).toBe(
      'Stock changed since this count — count it again',
    );
    expect(api.queryByTestId(`eod-recount-${X2}`)).toBeNull();
    fireEvent.press(api.getByTestId('eod-sheet-close'));
    // Count X for real → mixed list → X2 (borrowed, untouched) is omitted.
    await enterCount(api, X, 'units', '17');
    expect(api.queryByTestId(`eod-recount-${X}`)).toBeNull();
    fireEvent.press(api.getByTestId('eod-submit'));
    await waitFor(() => expect(mockSubmit).toHaveBeenCalledTimes(1));
    expect(mockSubmit.mock.calls[0][0].entries).toEqual([units(X, 17)]);
    expect(mockFetchCurrentStock).toHaveBeenCalledTimes(1);
  });

  it('a queued source not yet on the server mismatches the same way (conservative)', async () => {
    useStaffStore.setState({
      eodQueue: [
        {
          client_uuid: 'qqqqqqqq-0000-4000-8000-000000000001',
          store_id: STORE,
          date: TODAY(),
          vendor_id: A,
          status: 'submitted',
          entries: [units(X, 8)],
          queued_at: new Date().toISOString(),
          intent_user_id: USER,
          attempts: 0,
        },
      ],
    });
    mockStock = { [X]: 5 }; // the queued 8 hasn't been written yet
    mockNextResultStack = [vendorsBA, itemsFixture([{ id: X, name: 'Flour' }]), NONE];
    const api = render(<EODCount />);
    await waitFor(() => expect(borrowedLabel(api, X)).not.toBeNull());
    fireEvent.press(api.getByTestId('eod-submit'));
    expect((await api.findByTestId('eod-sheet-title')).props.children).toBe('Flour');
    expect(mockSubmit).not.toHaveBeenCalled();
    expect(api.queryByTestId(`eod-counted-${X}`)).toBeNull();
  });

  it('read failure → fail closed: no copies, every numeric copy needs a count, error surfaced', async () => {
    mockFetchCurrentStock.mockRejectedValue(new Error('network down'));
    seedAllBorrowed();
    const api = render(<EODCount />);
    await waitFor(() => expect(borrowedLabel(api, X2)).not.toBeNull());
    fireEvent.press(api.getByTestId('eod-submit'));
    await waitFor(() => expect(mockNotify).toHaveBeenCalledWith('fetchCurrentStock', expect.any(Error)));
    expect(mockSubmit).not.toHaveBeenCalled();
    expect((await api.findByTestId('eod-sheet-title')).props.children).toBe('Flour');
    expect(countedLabel(api)).toBe('0 of 2 counted');
    // Round 2 — the check couldn't run, so the wording says so (not "stock changed").
    expect((Toast.show as jest.Mock).mock.calls.map((c) => c[0])).toContainEqual(
      expect.objectContaining({ text1: "Couldn't check stock", text2: 'Please count these items (2)' }),
    );
    expect(String(api.getByTestId(`eod-recount-${X}`).props.children)).toBe(
      "Couldn't check stock — please count it",
    );
    expect(String(api.getByTestId(`eod-recount-${X2}`).props.children)).toBe(
      "Couldn't check stock — please count it",
    );
  });

  it('NO NEED copies are excluded from the check (mixed NO NEED + numeric: only the numeric id is read)', async () => {
    mockSubmit.mockResolvedValue({ kind: 'success', submission_id: 'sub-b' });
    mockStock = { [X2]: 6 };
    mockFetchBorrowSources.mockResolvedValue([sourceA([noNeedEntry(X), units(X2, 6)])]);
    mockNextResultStack = [vendorsBA, itemsFixture([{ id: X, name: 'Flour' }, { id: X2, name: 'Rice' }]), NONE, NONE];
    const api = render(<EODCount />);
    await waitFor(() => expect(borrowedLabel(api, X2)).not.toBeNull());
    fireEvent.press(api.getByTestId('eod-submit'));
    await waitFor(() => expect(mockSubmit).toHaveBeenCalledTimes(1));
    expect(mockFetchCurrentStock).toHaveBeenCalledWith(STORE, [X2]);
    expect(mockSubmit.mock.calls[0][0].entries).toEqual([noNeedEntry(X), units(X2, 6)]);
  });

  it('a vendor switch clears the recount flags', async () => {
    mockStock = { [X]: 17 };
    mockFetchBorrowSources.mockResolvedValue([sourceA([units(X, 5)])]);
    mockNextResultStack = [
      vendorsBA,
      itemsFixture([{ id: X, name: 'Flour' }]),
      NONE,
      itemsFixture([{ id: X, name: 'Flour' }]), // A's list
      NONE,
      itemsFixture([{ id: X, name: 'Flour' }]), // back to B
      NONE,
    ];
    const api = render(<EODCount />);
    await waitFor(() => expect(borrowedLabel(api, X)).not.toBeNull());
    fireEvent.press(api.getByTestId('eod-submit'));
    await api.findByTestId('eod-sheet-title');
    fireEvent.press(api.getByTestId('eod-sheet-close'));
    expect(borrowedLabel(api, X)).toBeNull();
    fireEvent.press(api.getByTestId(`vendor-chip-${A}`));
    await waitFor(() => expect(api.getByTestId(`vendor-chip-${A}`).props.accessibilityState?.selected).toBe(true));
    fireEvent.press(api.getByTestId(`vendor-chip-${B}`));
    await waitFor(() => expect(borrowedLabel(api, X)).toBe('Counted under Sysco'));
  });
});

describe('EODCount — spec 200 AC-21 all-borrowed copies never fall back to the offline queue', () => {
  it('all-borrowed: submit is called with allowQueue: false; a network failure shows the error, stays unlocked, and a retry re-reads stock', async () => {
    mockStock = { [X]: 5, [X2]: 6 };
    mockFetchBorrowSources.mockResolvedValue([sourceA([units(X, 5), units(X2, 6)])]);
    mockNextResultStack = [vendorsBA, itemsFixture([{ id: X, name: 'Flour' }, { id: X2, name: 'Rice' }]), NONE, NONE];
    const notSent = "No connection — not sent. Try again.";
    // The hook maps offline / network error to `failed` for allowQueue: false.
    mockSubmit.mockResolvedValueOnce({ kind: 'failed', message: notSent });
    mockSubmit.mockResolvedValueOnce({ kind: 'success', submission_id: 'sub-b' });
    const api = render(<EODCount />);
    await waitFor(() => expect(borrowedLabel(api, X2)).not.toBeNull());

    fireEvent.press(api.getByTestId('eod-submit'));
    await waitFor(() => expect(mockSubmit).toHaveBeenCalledTimes(1));
    expect(mockSubmit.mock.calls[0][1]).toEqual({ allowQueue: false });
    await waitFor(() =>
      expect((Toast.show as jest.Mock).mock.calls.map((c) => c[0].text1)).toContain(notSent),
    );
    // Retryable: still UNSUBMITTED (Submit, not Edit), rows still borrowed, chip still red.
    expect(api.getByText('Submit')).toBeTruthy();
    expect(api.queryByText('Edit')).toBeNull();
    expect(borrowedLabel(api, X)).toBe('Counted under Sysco');
    expect(api.getByTestId(`eod-vendor-status-${B}`).props.accessibilityLabel).toBe('Not submitted');
    expect(useStaffStore.getState().eodQueue).toHaveLength(0);

    // Retry → the stock check runs again before the second submit.
    fireEvent.press(api.getByTestId('eod-submit'));
    await waitFor(() => expect(mockSubmit).toHaveBeenCalledTimes(2));
    expect(mockFetchCurrentStock).toHaveBeenCalledTimes(2);
    expect(mockSubmit.mock.calls[1][1]).toEqual({ allowQueue: false });
    expect(await api.findByText('Edit')).toBeTruthy();
  });

  it('mixed / own-count submits call submit without options (queue-on-network-failure unchanged)', async () => {
    mockSubmit.mockResolvedValue({ kind: 'queued', client_uuid: 'q-1' });
    mockFetchBorrowSources.mockResolvedValue([sourceA([units(X, 5)])]);
    mockNextResultStack = [vendorsBA, itemsFixture([{ id: X, name: 'Flour' }, { id: Y, name: 'Sugar' }]), NONE];
    const api = render(<EODCount />);
    await waitFor(() => expect(borrowedLabel(api, X)).not.toBeNull());
    await enterCount(api, Y, 'units', '4');
    fireEvent.press(api.getByTestId('eod-submit'));
    await waitFor(() => expect(mockSubmit).toHaveBeenCalledTimes(1));
    expect(mockSubmit.mock.calls[0]).toHaveLength(1);
    expect(mockFetchCurrentStock).not.toHaveBeenCalled();
    expect(await api.findByText('Edit')).toBeTruthy();
  });
});

