// src/screens/staff/screens/EODCount.noNeed.spec172.test.tsx — Spec 172.
//
// Staff EOD "NO NEED" ("more than enough; not counted numerically") through the
// REAL screen: the row toggle (AC-31 / OQ-1), the keypad-sheet button with
// mark-and-advance (AC-29 semantics / OQ-5), the counted predicates + gate
// (AC-32), the entry builder's NO NEED shape (AC-32 / AC-3), the
// existing-submission read + seed / locked view / EDIT→Cancel (AC-33), the
// queued synthesized lock (AC-33), and the spec 171 count modes (AC-35).
//
// Harness copied verbatim from EODCount.test.tsx (mocks at the useEodSubmit
// hook boundary + a supabase.from() fixture stack) so that suite stays
// unmodified (AC-40).

import { FlatList } from 'react-native';
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import Toast from 'react-native-toast-message';

// CI hardening: this full-render suite is timing-marginal on the 2-core CI
// runner under full parallel load — the first render + waitFor occasionally
// blew jest's default 5000ms budget and reddened `main` (a flake, ~149ms
// locally). Raise the per-suite budget so contention can't fail it; does not
// slow the pass locally (tests still resolve in ~150ms each).
jest.setTimeout(15000);

// ─── mock the hook surface ───────────────────────────────────────
const mockSubmit = jest.fn();
jest.mock('../hooks/useEodSubmit', () => ({
  useEodSubmit: () => ({
    submit: mockSubmit,
    pending: 0,
    draining: false,
  }),
}));

// EODCount navigates to the Reorder tab on a successful submit — mock the
// navigation object (no NavigationContainer in these unit renders).
const mockNavigate = jest.fn();
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ navigate: mockNavigate }),
}));

// ─── mock supabase.from() so vendor/item/existing reads work ─────
type QueryResult = { data: unknown; error: unknown };
const mockFromCalls: string[] = [];
const mockSelectCalls: Array<{ table: string; cols?: string }> = [];
let mockNextResultStack: QueryResult[] = [];
// Spec 103 — the per-user saved count order (user_count_orders) is read via a
// SEPARATE channel so it never consumes a fixture from the vendor/item/existing
// stack. Default no-row → the screen opens in default view. The upsert/delete
// (save/reset) just resolve OK.
let mockCountOrderResult: QueryResult = { data: null, error: null };
// Spec 128 — the staff_items_updated RPC (drives the "Updated" badge). Its own
// channel so it never consumes a fixture from the vendor/item/existing stack.
// Default empty → no badges for existing tests.
let mockUpdatedResult: QueryResult = { data: [], error: null };

function mockQueryBuilder(table: string) {
  mockFromCalls.push(table);
  if (table === 'user_count_orders') {
    const builder: Record<string, unknown> = {
      select: () => builder,
      eq: () => builder,
      is: () => builder,
      upsert: () => Promise.resolve({ data: null, error: null }),
      delete: () => builder,
      maybeSingle: () => Promise.resolve(mockCountOrderResult),
      then: (resolve: (v: QueryResult) => unknown) => resolve({ data: null, error: null }),
    };
    return builder;
  }
  const result = mockNextResultStack.shift() ?? { data: [], error: null };
  const builder: Record<string, unknown> = {
    select: (cols?: string) => {
      // Spec 171 — record the projection so the AC-15 arm can pin the embed.
      mockSelectCalls.push({ table, cols });
      return builder;
    },
    eq: () => builder,
    is: () => builder,
    order: () => builder,
    maybeSingle: () => Promise.resolve(result),
    // Direct-await behavior (for non-maybeSingle queries) — supabase-js
    // builders are thenable.
    then: (resolve: (v: QueryResult) => unknown) => resolve(result),
  };
  return builder;
}

jest.mock('../../../lib/supabase', () => ({
  supabase: {
    from: (table: string) => mockQueryBuilder(table),
    rpc: (_fn: string) => Promise.resolve(mockUpdatedResult),
  },
}));

// The yesterday-incomplete nudge is its own data path; mock it so it doesn't
// consume the shared query stack. Default false (no nudge) for existing tests;
// individual tests override via mockYesterdayIncomplete.mockResolvedValue(true).
const mockYesterdayIncomplete = jest.fn().mockResolvedValue(false);
jest.mock('../lib/yesterdayStatus', () => ({
  fetchYesterdayIncomplete: (...args: unknown[]) => mockYesterdayIncomplete(...args),
}));

// Spec 129 — the per-vendor "submitted today" status is its own mock seam
// (like yesterdayStatus) so it never consumes a fixture from the shared
// vendor/item/existing query stack. Default empty set → every chip renders red.
const mockSubmittedVendorIds = jest.fn().mockResolvedValue(new Set<string>());
jest.mock('../lib/submittedStatus', () => ({
  fetchSubmittedVendorIds: (...args: unknown[]) => mockSubmittedVendorIds(...args),
}));

import { EODCount } from './EODCount';
import { useStaffStore } from '../store/useStaffStore';

// Spec 102 (§6d) — fetchItemsForVendor now queries `item_vendors` and
// embeds the inventory item under `item:` (a shared item links to N
// vendors via the junction). This helper builds the new row shape from the
// fields a test cares about so the fixtures stay terse; it mirrors the
// PostgREST embed `item_vendors → item:inventory_items!inner(... catalog)`.
function itemVendorRow(args: {
  id: string;
  vendorId?: string;
  storeId?: string;
  catalog: Record<string, unknown>;
}) {
  return {
    vendor_id: args.vendorId ?? 'v-1',
    item: {
      id: args.id,
      store_id: args.storeId ?? 'store-1',
      catalog: args.catalog,
    },
  };
}

// ─── Spec 141 keypad helpers ─────────────────────────────────────────
// Render-result shape we lean on for the keypad flow.
type Api = ReturnType<typeof render>;

function pressKeys(api: Api, value: string) {
  for (const ch of value.split('')) {
    fireEvent.press(api.getByTestId(ch === '.' ? 'eod-key-dot' : `eod-key-${ch}`));
  }
}

// Open a row's field well, type a value on the in-app digit pad, then close the
// sheet (the value persists in the count map — SKIP/close need no commit step).
async function enterCount(
  api: Api,
  itemId: string,
  field: 'cases' | 'units',
  value: string,
) {
  fireEvent.press(await api.findByTestId(`eod-well-${itemId}-${field}`));
  await api.findByTestId('eod-sheet-title');
  pressKeys(api, value);
  fireEvent.press(api.getByTestId('eod-sheet-close'));
}

// Read a well's displayed value (the old `eod-item-<field>-<id>` testID is kept
// on the value text). Empty wells render the '—' placeholder.
function wellValue(api: Api, itemId: string, field: 'cases' | 'units'): unknown {
  return api.getByTestId(`eod-item-${field}-${itemId}`).props.children;
}

function wellDisabled(api: Api, itemId: string, field: 'cases' | 'units'): unknown {
  return api.getByTestId(`eod-well-${itemId}-${field}`).props.accessibilityState?.disabled;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockSubmit.mockReset();
  mockFromCalls.length = 0;
  mockSelectCalls.length = 0;
  mockNextResultStack = [];
  mockCountOrderResult = { data: null, error: null };
  mockUpdatedResult = { data: [], error: null };
  mockYesterdayIncomplete.mockReset();
  mockYesterdayIncomplete.mockResolvedValue(false);
  mockSubmittedVendorIds.mockReset();
  mockSubmittedVendorIds.mockResolvedValue(new Set<string>());
  mockNavigate.mockReset();
  // Reset to English between tests — locale is global store state.
  useStaffStore.setState({ locale: 'en' });
  useStaffStore.setState({
    authState: {
      kind: 'signed-in',
      userId: 'user-1',
      stores: [{ storeId: 'store-1', storeName: 'Frederick' }],
    },
    activeStore: { id: 'store-1', name: 'Frederick' },
    eodQueue: [],
    draining: false,
  });
});


const vendorRow = {
  data: [{ vendor_id: 'v-1', vendor_name: 'Sysco', vendor: { id: 'v-1', name: 'Sysco' } }],
  error: null,
};
function itemsFixture(rows: Array<{ id: string; name: string; caseQty?: number; mode?: string }>) {
  return {
    data: rows.map((r) =>
      itemVendorRow({
        id: r.id,
        catalog: {
          name: r.name,
          unit: 'lb',
          case_qty: r.caseQty ?? 12,
          ...(r.mode ? { eod_count_mode: r.mode } : {}),
        },
      }),
    ),
    error: null,
  };
}
const NONE = { data: null, error: null };

describe('EODCount — spec 172 NO NEED', () => {
  it('§3.5: the existing-submission embed selects no_need', async () => {
    mockNextResultStack = [vendorRow, itemsFixture([{ id: 'item-1', name: 'Flour' }]), NONE];
    const api = render(<EODCount />);
    await api.findByTestId('eod-noneed-item-1');
    const subSelect = mockSelectCalls.find((c) => c.table === 'eod_submissions');
    expect(subSelect?.cols).toContain('no_need');
  });

  it('AC-31/32: tapping NO NEED counts the row (wells blank) and submits the NO NEED shape', async () => {
    mockSubmit.mockResolvedValue({ kind: 'success', submission_id: 'sub-new' });
    mockNextResultStack = [
      vendorRow,
      itemsFixture([{ id: 'item-1', name: 'Flour' }, { id: 'item-2', name: 'Sugar' }]),
      NONE,
      NONE, // post-submit refetch
    ];
    const api = render(<EODCount />);
    fireEvent.press(await api.findByTestId('eod-noneed-item-1'));
    expect(api.getByTestId('eod-counted-item-1')).toBeTruthy();
    expect(wellValue(api, 'item-1', 'cases')).toBe('—');
    expect(wellValue(api, 'item-1', 'units')).toBe('—');
    expect(api.queryByTestId('eod-item-total-item-1')).toBeNull();
    expect(api.getByTestId('eod-noneed-item-1').props.accessibilityState).toEqual(
      expect.objectContaining({ selected: true }),
    );
    await enterCount(api, 'item-2', 'units', '4');
    fireEvent.press(api.getByTestId('eod-submit'));
    await waitFor(() => expect(mockSubmit).toHaveBeenCalled());
    expect(mockSubmit.mock.calls[0][0].entries).toEqual([
      {
        item_id: 'item-1',
        actual_remaining: null,
        actual_remaining_cases: null,
        actual_remaining_each: null,
        no_need: true,
      },
      // A numeric entry is byte-identical to today (no `no_need` key).
      { item_id: 'item-2', actual_remaining: 4, actual_remaining_cases: null, actual_remaining_each: 4 },
    ]);
  });

  it('AC-32: a worksheet of ONLY NO NEED marks passes the gate + the "no counts" guard', async () => {
    mockSubmit.mockResolvedValue({ kind: 'success', submission_id: 'sub-new' });
    mockNextResultStack = [vendorRow, itemsFixture([{ id: 'item-1', name: 'Flour' }]), NONE, NONE];
    const api = render(<EODCount />);
    fireEvent.press(await api.findByTestId('eod-noneed-item-1'));
    fireEvent.press(api.getByTestId('eod-submit'));
    await waitFor(() => expect(mockSubmit).toHaveBeenCalledTimes(1));
    expect(mockSubmit.mock.calls[0][0].entries).toHaveLength(1);
    expect(mockSubmit.mock.calls[0][0].entries[0]).toMatchObject({ item_id: 'item-1', no_need: true });
  });

  it('OQ-1: NO NEED on a row with a number clears it; a re-tap returns the row to uncounted + blank', async () => {
    mockNextResultStack = [vendorRow, itemsFixture([{ id: 'item-1', name: 'Flour' }]), NONE];
    const api = render(<EODCount />);
    await enterCount(api, 'item-1', 'cases', '2');
    await enterCount(api, 'item-1', 'units', '3');
    expect(wellValue(api, 'item-1', 'units')).toBe('3');
    fireEvent.press(api.getByTestId('eod-noneed-item-1'));
    expect(wellValue(api, 'item-1', 'cases')).toBe('—');
    expect(wellValue(api, 'item-1', 'units')).toBe('—');
    expect(api.getByTestId('eod-counted-item-1')).toBeTruthy();
    fireEvent.press(api.getByTestId('eod-noneed-item-1'));
    expect(api.queryByTestId('eod-counted-item-1')).toBeNull();
    expect(wellValue(api, 'item-1', 'units')).toBe('—');
  });

  it('AC-16/29: a keypad digit on a NO NEED item clears NO NEED and writes the digit', async () => {
    mockNextResultStack = [vendorRow, itemsFixture([{ id: 'item-1', name: 'Flour' }]), NONE];
    const api = render(<EODCount />);
    fireEvent.press(await api.findByTestId('eod-noneed-item-1'));
    fireEvent.press(api.getByTestId('eod-well-item-1-units'));
    await api.findByTestId('eod-sheet-title');
    // Sheet total reads the label while marked.
    expect(String(api.getByTestId('eod-sheet-total').props.children)).toBe('No need');
    pressKeys(api, '5');
    expect(String(api.getByTestId('eod-sheet-total').props.children)).toContain('5');
    fireEvent.press(api.getByTestId('eod-sheet-close'));
    expect(wellValue(api, 'item-1', 'units')).toBe('5');
    expect(api.getByTestId('eod-noneed-item-1').props.accessibilityState).toEqual(
      expect.objectContaining({ selected: false }),
    );
  });

  it('OQ-5: the sheet NO NEED marks the seated item and advances; on the last uncounted item it closes', async () => {
    mockNextResultStack = [
      vendorRow,
      itemsFixture([{ id: 'item-1', name: 'Flour' }, { id: 'item-2', name: 'Sugar' }]),
      NONE,
    ];
    const api = render(<EODCount />);
    fireEvent.press(await api.findByTestId('eod-well-item-1-units'));
    expect((await api.findByTestId('eod-sheet-title')).props.children).toBe('Flour');
    fireEvent.press(api.getByTestId('eod-sheet-noneed'));
    // Advanced to the next uncounted item (NOT re-seated on Flour).
    expect(api.getByTestId('eod-sheet-title').props.children).toBe('Sugar');
    expect(api.getByTestId('eod-counted-item-1')).toBeTruthy();
    fireEvent.press(api.getByTestId('eod-sheet-noneed'));
    // Nothing uncounted remains → the sheet closes.
    await waitFor(() => expect(api.queryByTestId('eod-sheet-title')).toBeNull());
    expect(api.getByTestId('eod-counted-item-2')).toBeTruthy();
  });

  it('AC-33: an existing NO NEED entry renders locked as NO NEED (never "0"); EDIT→Cancel keeps it', async () => {
    mockNextResultStack = [
      vendorRow,
      itemsFixture([{ id: 'item-1', name: 'Flour' }]),
      {
        data: {
          id: 'sub-1',
          submitted_at: '2026-10-23T18:30:00Z',
          eod_entries: [
            {
              item_id: 'item-1',
              actual_remaining: null,
              actual_remaining_cases: null,
              actual_remaining_each: null,
              no_need: true,
            },
          ],
        },
        error: null,
      },
    ];
    const api = render(<EODCount />);
    await api.findByText('Edit');
    const btn = api.getByTestId('eod-noneed-item-1');
    expect(btn.props.accessibilityState).toEqual(expect.objectContaining({ selected: true, disabled: true }));
    expect(wellValue(api, 'item-1', 'units')).toBe('—');
    expect(wellValue(api, 'item-1', 'cases')).toBe('—');
    expect(api.getByTestId('eod-counted-item-1')).toBeTruthy();

    fireEvent.press(api.getByTestId('eod-submit')); // Edit
    await waitFor(() =>
      expect(api.getByTestId('eod-noneed-item-1').props.accessibilityState).toEqual(
        expect.objectContaining({ selected: true, disabled: false }),
      ),
    );
    // Toggle it off while editing, then Cancel → reverts to the submitted NO NEED.
    fireEvent.press(api.getByTestId('eod-noneed-item-1'));
    expect(api.queryByTestId('eod-counted-item-1')).toBeNull();
    fireEvent.press(api.getByTestId('eod-cancel-edit'));
    await waitFor(() =>
      expect(api.getByTestId('eod-noneed-item-1').props.accessibilityState).toEqual(
        expect.objectContaining({ selected: true, disabled: true }),
      ),
    );
    expect(wellValue(api, 'item-1', 'units')).toBe('—');
  });

  it('AC-33: a queued NO NEED submit locks and still shows NO NEED', async () => {
    mockSubmit.mockResolvedValue({ kind: 'queued', client_uuid: 'q-1' });
    mockNextResultStack = [vendorRow, itemsFixture([{ id: 'item-1', name: 'Flour' }]), NONE];
    const api = render(<EODCount />);
    fireEvent.press(await api.findByTestId('eod-noneed-item-1'));
    fireEvent.press(api.getByTestId('eod-submit'));
    await waitFor(() => expect(mockSubmit).toHaveBeenCalled());
    await waitFor(() => expect(wellDisabled(api, 'item-1', 'units')).toBe(true));
    expect(api.getByTestId('eod-noneed-item-1').props.accessibilityState).toEqual(
      expect.objectContaining({ selected: true, disabled: true }),
    );
    expect(wellValue(api, 'item-1', 'units')).toBe('—');
  });

  it.each(['cases_only', 'units_only', 'cases_and_units'])(
    'AC-35 (%s): NO NEED is available, counts, and submits the NO NEED shape',
    async (mode) => {
      mockSubmit.mockResolvedValue({ kind: 'success', submission_id: 'sub-new' });
      mockNextResultStack = [vendorRow, itemsFixture([{ id: 'item-1', name: 'Flour', mode }]), NONE, NONE];
      const api = render(<EODCount />);
      fireEvent.press(await api.findByTestId('eod-noneed-item-1'));
      expect(api.getByTestId('eod-counted-item-1')).toBeTruthy();
      fireEvent.press(api.getByTestId('eod-submit'));
      await waitFor(() => expect(mockSubmit).toHaveBeenCalled());
      expect(mockSubmit.mock.calls[0][0].entries).toEqual([
        {
          item_id: 'item-1',
          actual_remaining: null,
          actual_remaining_cases: null,
          actual_remaining_each: null,
          no_need: true,
        },
      ]);
    },
  );
});
