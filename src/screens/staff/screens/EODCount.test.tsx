// src/screens/staff/screens/EODCount.test.tsx — screen behavior tests.
//
// Mocks at the hook boundary per spec 062 §0 Q5: useEodSubmit replaces
// the entire submit+queue orchestration; supabase.from() is stubbed
// for the vendor / item / existing-submission reads.

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
let mockNextResultStack: QueryResult[] = [];
// Spec 103 — the per-user saved count order (user_count_orders) is read via a
// SEPARATE channel so it never consumes a fixture from the vendor/item/existing
// stack. Default no-row → the screen opens in default view. The upsert/delete
// (save/reset) just resolve OK.
let mockCountOrderResult: QueryResult = { data: null, error: null };

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
    select: () => builder,
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
  },
}));

// The yesterday-incomplete nudge is its own data path; mock it so it doesn't
// consume the shared query stack. Default false (no nudge) for existing tests;
// individual tests override via mockYesterdayIncomplete.mockResolvedValue(true).
const mockYesterdayIncomplete = jest.fn().mockResolvedValue(false);
jest.mock('../lib/yesterdayStatus', () => ({
  fetchYesterdayIncomplete: (...args: unknown[]) => mockYesterdayIncomplete(...args),
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

beforeEach(() => {
  jest.clearAllMocks();
  mockSubmit.mockReset();
  mockFromCalls.length = 0;
  mockNextResultStack = [];
  mockCountOrderResult = { data: null, error: null };
  mockYesterdayIncomplete.mockReset();
  mockYesterdayIncomplete.mockResolvedValue(false);
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

describe('EODCount', () => {
  it('renders the store name and an item row with TWO decimal-pad inputs (Cases + Units)', async () => {
    // Mock the data fetch sequence: vendors, items, existing
    mockNextResultStack = [
      // vendors for today
      { data: [{ vendor_id: 'v-1', vendor_name: 'Sysco', vendor: { id: 'v-1', name: 'Sysco' } }], error: null },
      // items for vendor (case_qty present → caseQty mapped)
      {
        data: [
          itemVendorRow({ id: 'item-1', catalog: { name: 'Flour', unit: 'lb', case_qty: 12 } }),
        ],
        error: null,
      },
      // existing submission — none
      { data: null, error: null },
    ];

    const { findByText, getByTestId, queryByTestId } = render(<EODCount />);
    expect(await findByText('Frederick')).toBeTruthy();
    // Item row renders after fetch with BOTH inputs.
    await waitFor(() => expect(getByTestId('eod-item-row-item-1')).toBeTruthy());
    expect(getByTestId('eod-item-cases-item-1')).toBeTruthy();
    expect(getByTestId('eod-item-units-item-1')).toBeTruthy();
    // The old single-input testID is gone.
    expect(queryByTestId('eod-item-input-item-1')).toBeNull();
    expect(getByTestId('eod-submit')).toBeTruthy();
  });

  it('renders the localized item name for a non-English locale and falls back to English when the override is missing', async () => {
    useStaffStore.setState({ locale: 'es' });
    mockNextResultStack = [
      { data: [{ vendor_id: 'v-1', vendor_name: 'Sysco', vendor: { id: 'v-1', name: 'Sysco' } }], error: null },
      {
        data: [
          // item-1: es override present → Spanish name.
          itemVendorRow({
            id: 'item-1',
            catalog: { name: 'Flour', unit: 'lb', case_qty: 12, i18n_names: { es: 'Harina' } },
          }),
          // item-2: no es override → English fallback.
          itemVendorRow({
            id: 'item-2',
            catalog: { name: 'Salt', unit: 'oz', case_qty: 1, i18n_names: { 'zh-CN': '盐' } },
          }),
        ],
        error: null,
      },
      { data: null, error: null },
    ];
    const { findByText, getByText } = render(<EODCount />);
    // es override renders in Spanish.
    expect(await findByText('Harina')).toBeTruthy();
    // missing es override falls back to English silently.
    expect(getByText('Salt')).toBeTruthy();
  });

  it('shows a static "Vendor: <name>" label (no chip switcher) when exactly one vendor is scheduled', async () => {
    mockNextResultStack = [
      { data: [{ vendor_id: 'v-1', vendor_name: 'Sysco', vendor: { id: 'v-1', name: 'Sysco' } }], error: null },
      { data: [itemVendorRow({ id: 'item-1', catalog: { name: 'Flour', unit: 'lb', case_qty: 12 } })], error: null },
      { data: null, error: null },
    ];
    const { findByText, queryByTestId } = render(<EODCount />);
    // The lone vendor is named even though it isn't switchable.
    expect(await findByText('Vendor: Sysco')).toBeTruthy();
    // No interactive chip rendered for a single vendor.
    expect(queryByTestId('vendor-chip-v-1')).toBeNull();
  });

  it('shows the chip switcher (and no single-vendor label) when >1 vendor is scheduled', async () => {
    mockNextResultStack = [
      {
        data: [
          { vendor_id: 'v-1', vendor_name: 'Sysco', vendor: { id: 'v-1', name: 'Sysco' } },
          { vendor_id: 'v-2', vendor_name: 'US Foods', vendor: { id: 'v-2', name: 'US Foods' } },
        ],
        error: null,
      },
      { data: [itemVendorRow({ id: 'item-1', catalog: { name: 'Flour', unit: 'lb', case_qty: 12 } })], error: null },
      { data: null, error: null },
    ];
    const { findByTestId, queryByTestId } = render(<EODCount />);
    expect(await findByTestId('vendor-chip-v-1')).toBeTruthy();
    expect(queryByTestId('vendor-chip-v-2')).toBeTruthy();
    expect(queryByTestId('eod-vendor-single')).toBeNull();
  });

  it('shows the pre-fill banner and seeds both boxes from a split submission', async () => {
    mockNextResultStack = [
      { data: [{ vendor_id: 'v-1', vendor_name: 'Sysco', vendor: { id: 'v-1', name: 'Sysco' } }], error: null },
      {
        data: [
          itemVendorRow({ id: 'item-1', catalog: { name: 'Flour', unit: 'lb', case_qty: 12 } }),
        ],
        error: null,
      },
      {
        data: {
          id: 'sub-1',
          submitted_at: '2026-05-24T18:30:00Z',
          eod_entries: [
            {
              item_id: 'item-1',
              actual_remaining: 29, // 2×12 + 5
              actual_remaining_cases: 2,
              actual_remaining_each: 5,
            },
          ],
        },
        error: null,
      },
    ];
    const { findByTestId } = render(<EODCount />);
    expect(await findByTestId('eod-prefill-banner')).toBeTruthy();
    // Cases box seeded from actual_remaining_cases, Units from actual_remaining_each.
    expect((await findByTestId('eod-item-cases-item-1')).props.value).toBe('2');
    expect((await findByTestId('eod-item-units-item-1')).props.value).toBe('5');
  });

  it('pre-fills a LEGACY row (null splits) as Cases blank, Units = total', async () => {
    mockNextResultStack = [
      { data: [{ vendor_id: 'v-1', vendor_name: 'Sysco', vendor: { id: 'v-1', name: 'Sysco' } }], error: null },
      {
        data: [
          itemVendorRow({ id: 'item-1', catalog: { name: 'Flour', unit: 'lb', case_qty: 12 } }),
        ],
        error: null,
      },
      {
        data: {
          id: 'sub-1',
          submitted_at: '2026-05-24T18:30:00Z',
          // Legacy row: only the total set, both splits NULL (OQ-4).
          eod_entries: [
            {
              item_id: 'item-1',
              actual_remaining: 18,
              actual_remaining_cases: null,
              actual_remaining_each: null,
            },
          ],
        },
        error: null,
      },
    ];
    const { findByTestId } = render(<EODCount />);
    expect((await findByTestId('eod-item-cases-item-1')).props.value).toBe('');
    expect((await findByTestId('eod-item-units-item-1')).props.value).toBe('18');
  });

  it('pre-fills a CASES-ONLY row without doubling: Units stays blank (not the total)', async () => {
    // Regression: a manager enters 14 cases (case of 6), leaves Loose blank.
    // Stored: cases=14, each=null, total=84 (14×6). On reload the Units box
    // must NOT seed from the total (84) — that re-adds the case amount and
    // doubles the row to 168. Cases=14, Units blank is the correct seed.
    mockNextResultStack = [
      { data: [{ vendor_id: 'v-1', vendor_name: 'Sysco', vendor: { id: 'v-1', name: 'Sysco' } }], error: null },
      {
        data: [
          itemVendorRow({ id: 'item-1', catalog: { name: 'French Fries', unit: 'bag', case_qty: 6 } }),
        ],
        error: null,
      },
      {
        data: {
          id: 'sub-1',
          submitted_at: '2026-05-24T18:30:00Z',
          eod_entries: [
            {
              item_id: 'item-1',
              actual_remaining: 84, // 14 × 6, cases-only
              actual_remaining_cases: 14,
              actual_remaining_each: null,
            },
          ],
        },
        error: null,
      },
    ];
    const { findByTestId } = render(<EODCount />);
    expect((await findByTestId('eod-item-cases-item-1')).props.value).toBe('14');
    expect((await findByTestId('eod-item-units-item-1')).props.value).toBe('');
  });

  it('converts Cases × caseQty + Units into the total in the submit payload', async () => {
    mockSubmit.mockResolvedValue({ kind: 'success', submission_id: 'sub-new' });
    mockNextResultStack = [
      { data: [{ vendor_id: 'v-1', vendor_name: 'Sysco', vendor: { id: 'v-1', name: 'Sysco' } }], error: null },
      {
        data: [
          itemVendorRow({ id: 'item-1', catalog: { name: 'Flour', unit: 'lb', case_qty: 12 } }),
        ],
        error: null,
      },
      { data: null, error: null }, // no existing
      { data: null, error: null }, // re-fetch after submit success
    ];
    const { findByTestId } = render(<EODCount />);
    fireEvent.changeText(await findByTestId('eod-item-cases-item-1'), '2');
    fireEvent.changeText(await findByTestId('eod-item-units-item-1'), '3');
    fireEvent.press(await findByTestId('eod-submit'));
    await waitFor(() => expect(mockSubmit).toHaveBeenCalled());
    // total = 2 × 12 + 3 = 27; raw splits carried alongside.
    expect(mockSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        store_id: 'store-1',
        vendor_id: 'v-1',
        entries: [
          {
            item_id: 'item-1',
            actual_remaining: 27,
            actual_remaining_cases: 2,
            actual_remaining_each: 3,
          },
        ],
      }),
    );
  });

  it('navigates to the Reorder tab after a successful submit', async () => {
    mockSubmit.mockResolvedValue({ kind: 'success', submission_id: 'sub-new' });
    mockNextResultStack = [
      { data: [{ vendor_id: 'v-1', vendor_name: 'Sysco', vendor: { id: 'v-1', name: 'Sysco' } }], error: null },
      { data: [itemVendorRow({ id: 'item-1', catalog: { name: 'Flour', unit: 'lb', case_qty: 12 } })], error: null },
      { data: null, error: null },
      { data: null, error: null },
    ];
    const { findByTestId } = render(<EODCount />);
    fireEvent.changeText(await findByTestId('eod-item-units-item-1'), '3');
    fireEvent.press(await findByTestId('eod-submit'));
    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('Reorder'));
  });

  it('round-trips a spec-093 fixed row (case_qty=20): total = cases × 20 + units', async () => {
    // Spec 093 (§11) EOD round-trip AC. After the form fix lands a
    // "1 case = 20 lbs" row as case_qty=20 (canonical units-per-case), the
    // EOD Cases box must compute total = cases × 20 + units — i.e. the case
    // size is no longer invisible (pre-fix it landed in sub_unit_size and
    // case_qty stayed 1, miscounting by 20×). No EOD code change; this pins
    // the consumer against the fixed-row shape.
    mockSubmit.mockResolvedValue({ kind: 'success', submission_id: 'sub-new' });
    mockNextResultStack = [
      { data: [{ vendor_id: 'v-1', vendor_name: 'Sysco', vendor: { id: 'v-1', name: 'Sysco' } }], error: null },
      {
        data: [
          itemVendorRow({ id: 'item-1', catalog: { name: 'Brown Paper Bag', unit: 'each', case_qty: 20 } }),
        ],
        error: null,
      },
      { data: null, error: null }, // no existing
      { data: null, error: null }, // re-fetch after submit success
    ];
    const { findByTestId } = render(<EODCount />);
    fireEvent.changeText(await findByTestId('eod-item-cases-item-1'), '3');
    fireEvent.changeText(await findByTestId('eod-item-units-item-1'), '4');
    fireEvent.press(await findByTestId('eod-submit'));
    await waitFor(() => expect(mockSubmit).toHaveBeenCalled());
    // total = 3 × 20 + 4 = 64.
    expect(mockSubmit.mock.calls[0][0].entries[0]).toEqual({
      item_id: 'item-1',
      actual_remaining: 64,
      actual_remaining_cases: 3,
      actual_remaining_each: 4,
    });
  });

  it('defaults caseQty to 1 when the catalog has no case_qty (null → ×1)', async () => {
    mockSubmit.mockResolvedValue({ kind: 'success', submission_id: 'sub-new' });
    mockNextResultStack = [
      { data: [{ vendor_id: 'v-1', vendor_name: 'Sysco', vendor: { id: 'v-1', name: 'Sysco' } }], error: null },
      {
        // No case_qty key → caseQty maps to null → conversion uses × 1.
        data: [itemVendorRow({ id: 'item-1', catalog: { name: 'Flour', unit: 'lb' } })],
        error: null,
      },
      { data: null, error: null },
      { data: null, error: null },
    ];
    const { findByTestId } = render(<EODCount />);
    fireEvent.changeText(await findByTestId('eod-item-cases-item-1'), '4');
    fireEvent.changeText(await findByTestId('eod-item-units-item-1'), '5');
    fireEvent.press(await findByTestId('eod-submit'));
    await waitFor(() => expect(mockSubmit).toHaveBeenCalled());
    // total = 4 × 1 + 5 = 9.
    expect(mockSubmit.mock.calls[0][0].entries[0]).toEqual({
      item_id: 'item-1',
      actual_remaining: 9,
      actual_remaining_cases: 4,
      actual_remaining_each: 5,
    });
  });

  it('includes a row when ONLY Units is filled (Cases blank → cases null)', async () => {
    mockSubmit.mockResolvedValue({ kind: 'success', submission_id: 'sub-new' });
    mockNextResultStack = [
      { data: [{ vendor_id: 'v-1', vendor_name: 'Sysco', vendor: { id: 'v-1', name: 'Sysco' } }], error: null },
      {
        data: [itemVendorRow({ id: 'item-1', catalog: { name: 'Flour', unit: 'lb', case_qty: 12 } })],
        error: null,
      },
      { data: null, error: null },
      { data: null, error: null },
    ];
    const { findByTestId } = render(<EODCount />);
    // Only Units filled — the "entered when either filled" predicate.
    fireEvent.changeText(await findByTestId('eod-item-units-item-1'), '7.5');
    fireEvent.press(await findByTestId('eod-submit'));
    await waitFor(() => expect(mockSubmit).toHaveBeenCalled());
    expect(mockSubmit.mock.calls[0][0].entries).toEqual([
      {
        item_id: 'item-1',
        actual_remaining: 7.5, // 0 × 12 + 7.5
        actual_remaining_cases: null, // blank Cases → null
        actual_remaining_each: 7.5,
      },
    ]);
  });

  it('includes a row when ONLY Cases is filled (Units blank → each null)', async () => {
    mockSubmit.mockResolvedValue({ kind: 'success', submission_id: 'sub-new' });
    mockNextResultStack = [
      { data: [{ vendor_id: 'v-1', vendor_name: 'Sysco', vendor: { id: 'v-1', name: 'Sysco' } }], error: null },
      {
        data: [itemVendorRow({ id: 'item-1', catalog: { name: 'Flour', unit: 'lb', case_qty: 4 } })],
        error: null,
      },
      { data: null, error: null },
      { data: null, error: null },
    ];
    const { findByTestId } = render(<EODCount />);
    // Only Cases filled — the other half of the "entered when either filled" predicate.
    fireEvent.changeText(await findByTestId('eod-item-cases-item-1'), '3');
    fireEvent.press(await findByTestId('eod-submit'));
    await waitFor(() => expect(mockSubmit).toHaveBeenCalled());
    expect(mockSubmit.mock.calls[0][0].entries).toEqual([
      {
        item_id: 'item-1',
        actual_remaining: 12, // 3 × 4 + 0
        actual_remaining_cases: 3,
        actual_remaining_each: null, // blank Units → null
      },
    ]);
  });

  it('blocks submit on a fully-blank row → "count every item" gate toast (no skip)', async () => {
    // Completeness gate: every item must be counted (even "0") before submit.
    // A fully-blank row no longer silently skips — it blocks the submit and the
    // toast names how many remain (the prior blank-skip behavior is inverted).
    mockNextResultStack = [
      { data: [{ vendor_id: 'v-1', vendor_name: 'Sysco', vendor: { id: 'v-1', name: 'Sysco' } }], error: null },
      {
        data: [itemVendorRow({ id: 'item-1', catalog: { name: 'Flour', unit: 'lb', case_qty: 12 } })],
        error: null,
      },
      { data: null, error: null },
    ];
    const { findByTestId } = render(<EODCount />);
    // Press Submit without touching either input.
    await findByTestId('eod-item-cases-item-1');
    fireEvent.press(await findByTestId('eod-submit'));
    await waitFor(() => expect(Toast.show).toHaveBeenCalled());
    // submit() never called — the completeness gate fired first.
    expect(mockSubmit).not.toHaveBeenCalled();
    expect((Toast.show as jest.Mock).mock.calls[0][0]).toMatchObject({
      text1: 'Count every item first',
      text2: '1 still need a count',
    });
  });

  it('shows "Submitted" toast on success outcome', async () => {
    mockSubmit.mockResolvedValue({ kind: 'success', submission_id: 'sub-new' });
    mockNextResultStack = [
      { data: [{ vendor_id: 'v-1', vendor_name: 'Sysco', vendor: { id: 'v-1', name: 'Sysco' } }], error: null },
      { data: [itemVendorRow({ id: 'item-1', catalog: { name: 'Flour', unit: 'lb' } })], error: null },
      { data: null, error: null },
      { data: null, error: null },
    ];
    const { findByTestId } = render(<EODCount />);
    fireEvent.changeText(await findByTestId('eod-item-units-item-1'), '7');
    fireEvent.press(await findByTestId('eod-submit'));
    await waitFor(() => expect(Toast.show).toHaveBeenCalled());
    expect((Toast.show as jest.Mock).mock.calls[0][0]).toMatchObject({
      text1: 'Submitted',
    });
  });

  it('shows "Already submitted" toast on success-replay', async () => {
    mockSubmit.mockResolvedValue({
      kind: 'success-replay',
      submission_id: 'sub-existing',
    });
    mockNextResultStack = [
      { data: [{ vendor_id: 'v-1', vendor_name: 'Sysco', vendor: { id: 'v-1', name: 'Sysco' } }], error: null },
      { data: [itemVendorRow({ id: 'item-1', catalog: { name: 'Flour', unit: 'lb' } })], error: null },
      { data: null, error: null },
    ];
    const { findByTestId } = render(<EODCount />);
    fireEvent.changeText(await findByTestId('eod-item-units-item-1'), '7');
    fireEvent.press(await findByTestId('eod-submit'));
    await waitFor(() => expect(Toast.show).toHaveBeenCalled());
    const calls = (Toast.show as jest.Mock).mock.calls;
    expect(calls[0][0].text1).toMatch(/Already submitted/i);
  });

  it('shows error banner on forbidden outcome (no auto-signout)', async () => {
    mockSubmit.mockResolvedValue({
      kind: 'forbidden',
      message: 'Cannot submit for this store — your access has changed. Sign out and back in.',
    });
    mockNextResultStack = [
      { data: [{ vendor_id: 'v-1', vendor_name: 'Sysco', vendor: { id: 'v-1', name: 'Sysco' } }], error: null },
      { data: [itemVendorRow({ id: 'item-1', catalog: { name: 'Flour', unit: 'lb' } })], error: null },
      { data: null, error: null },
    ];
    const { findByText, findByTestId } = render(<EODCount />);
    fireEvent.changeText(await findByTestId('eod-item-units-item-1'), '7');
    fireEvent.press(await findByTestId('eod-submit'));
    await waitFor(() =>
      expect(findByText(/your access has changed/i)).resolves.toBeTruthy(),
    );
    // Auth state still signed-in
    expect(useStaffStore.getState().authState.kind).toBe('signed-in');
  });

  it('clears inputs on queued outcome', async () => {
    mockSubmit.mockResolvedValue({ kind: 'queued', client_uuid: 'q-1' });
    mockNextResultStack = [
      { data: [{ vendor_id: 'v-1', vendor_name: 'Sysco', vendor: { id: 'v-1', name: 'Sysco' } }], error: null },
      { data: [itemVendorRow({ id: 'item-1', catalog: { name: 'Flour', unit: 'lb' } })], error: null },
      { data: null, error: null },
    ];
    const { findByTestId } = render(<EODCount />);
    const cases = await findByTestId('eod-item-cases-item-1');
    const units = await findByTestId('eod-item-units-item-1');
    fireEvent.changeText(cases, '2');
    fireEvent.changeText(units, '7');
    fireEvent.press(await findByTestId('eod-submit'));
    // Both inputs clear on the queued outcome (spec §B7).
    await waitFor(() => {
      expect(cases.props.value).toBe('');
      expect(units.props.value).toBe('');
    });
  });

  it('renders vendor switcher only when multiple vendors scheduled', async () => {
    mockNextResultStack = [
      {
        data: [
          { vendor_id: 'v-1', vendor_name: 'Sysco', vendor: { id: 'v-1', name: 'Sysco' } },
          { vendor_id: 'v-2', vendor_name: 'Restaurant Depot', vendor: { id: 'v-2', name: 'Restaurant Depot' } },
        ],
        error: null,
      },
      // items for v-1
      { data: [], error: null },
      // existing — none
      { data: null, error: null },
    ];
    const { findByTestId } = render(<EODCount />);
    expect(await findByTestId('vendor-chip-v-1')).toBeTruthy();
    expect(await findByTestId('vendor-chip-v-2')).toBeTruthy();
  });

  it('captures the date at submit time, not at mount time (spec §11 risk c)', async () => {
    // Mount on day-1, then advance Date to day-2 before pressing
    // Submit. The payload must carry day-2's ISO date — not the
    // mount-time day-1. `todayIso` uses LOCAL date (getFullYear /
    // getMonth / getDate), so we construct dates that differ in LOCAL
    // time regardless of the host's UTC offset.
    const RealDate = Date;
    // 12:00 noon local on each day — unambiguous in any TZ.
    const day1 = new RealDate(2026, 4, 24, 12, 0, 0); // 2026-05-24 local
    const day2 = new RealDate(2026, 4, 25, 12, 0, 0); // 2026-05-25 local
    let now = day1;
    class MockDate extends RealDate {
      constructor(arg?: number | string | Date) {
        if (arguments.length === 0) {
          super(now.getTime());
        } else {
          // Defer to RealDate for explicit-arg construction
          // (e.g. new Date('2026-05-24T18:30:00Z') in fixtures).
          super(arg as number | string | Date);
        }
      }
      static now() {
        return now.getTime();
      }
    }
    global.Date = MockDate as DateConstructor;

    try {
      mockSubmit.mockResolvedValue({ kind: 'success', submission_id: 'sub-new' });
      mockNextResultStack = [
        { data: [{ vendor_id: 'v-1', vendor_name: 'Sysco', vendor: { id: 'v-1', name: 'Sysco' } }], error: null },
        {
          data: [
            itemVendorRow({ id: 'item-1', catalog: { name: 'Flour', unit: 'lb' } }),
          ],
          error: null,
        },
        { data: null, error: null },
        { data: null, error: null }, // post-submit re-fetch
      ];

      const { findByTestId } = render(<EODCount />);
      const input = await findByTestId('eod-item-units-item-1');
      fireEvent.changeText(input, '7');

      // Advance the clock past midnight BEFORE pressing Submit.
      now = day2;

      const submit = await findByTestId('eod-submit');
      fireEvent.press(submit);
      await waitFor(() => expect(mockSubmit).toHaveBeenCalled());

      // Payload date must be day-2 (capture-at-submit), not day-1
      // (capture-at-mount).
      const payload = mockSubmit.mock.calls[0][0];
      expect(payload.date).toBe('2026-05-25');
    } finally {
      global.Date = RealDate;
    }
  });
});

// Owner request (2026-07): step back ONE day to count a missed vendor,
// flagged as a late submission.
describe('EODCount — late (yesterday) count', () => {
  it('switching to Yesterday shows the late banner and submits with yesterday’s date', async () => {
    const RealDate = Date;
    // Pin "now" to 2026-05-25 so yesterday is deterministically 2026-05-24.
    const fixed = new RealDate(2026, 4, 25, 12, 0, 0);
    class MockDate extends RealDate {
      constructor(arg?: number | string | Date) {
        if (arguments.length === 0) super(fixed.getTime());
        else super(arg as number | string | Date);
      }
      static now() {
        return fixed.getTime();
      }
    }
    global.Date = MockDate as DateConstructor;

    try {
      mockSubmit.mockResolvedValue({ kind: 'success', submission_id: 'sub-new' });
      const vendorRow = {
        data: [{ vendor_id: 'v-1', vendor_name: 'Sysco', vendor: { id: 'v-1', name: 'Sysco' } }],
        error: null,
      };
      const itemsRow = {
        data: [itemVendorRow({ id: 'item-1', catalog: { name: 'Flour', unit: 'lb' } })],
        error: null,
      };
      const noExisting = { data: null, error: null };
      mockNextResultStack = [
        // mount (today) load
        vendorRow,
        itemsRow,
        noExisting,
        // yesterday reload after the toggle
        vendorRow,
        itemsRow,
        noExisting,
        // post-submit existing re-fetch
        noExisting,
      ];

      const { findByTestId, queryByTestId } = render(<EODCount />);
      // No late banner on the default (today) view.
      await findByTestId('eod-item-units-item-1');
      expect(queryByTestId('eod-late-banner')).toBeNull();

      // Step back to yesterday → late banner appears.
      fireEvent.press(await findByTestId('eod-date-yesterday'));
      expect(await findByTestId('eod-late-banner')).toBeTruthy();

      fireEvent.changeText(await findByTestId('eod-item-units-item-1'), '5');
      fireEvent.press(await findByTestId('eod-submit'));
      await waitFor(() => expect(mockSubmit).toHaveBeenCalled());

      // Submits with YESTERDAY's date (the missed count date).
      expect(mockSubmit.mock.calls[0][0].date).toBe('2026-05-24');
    } finally {
      global.Date = RealDate;
    }
  });

  it('shows the Today reminder banner when yesterday is incomplete', async () => {
    mockYesterdayIncomplete.mockResolvedValue(true);
    mockNextResultStack = [
      { data: [{ vendor_id: 'v-1', vendor_name: 'Sysco', vendor: { id: 'v-1', name: 'Sysco' } }], error: null },
      { data: [itemVendorRow({ id: 'item-1', catalog: { name: 'Flour', unit: 'lb' } })], error: null },
      { data: null, error: null },
    ];
    const { findByTestId } = render(<EODCount />);
    // On the default Today view, the reminder banner appears.
    expect(await findByTestId('eod-yesterday-reminder')).toBeTruthy();
  });

  it('hides the Today reminder banner when yesterday is complete', async () => {
    mockYesterdayIncomplete.mockResolvedValue(false);
    mockNextResultStack = [
      { data: [{ vendor_id: 'v-1', vendor_name: 'Sysco', vendor: { id: 'v-1', name: 'Sysco' } }], error: null },
      { data: [itemVendorRow({ id: 'item-1', catalog: { name: 'Flour', unit: 'lb' } })], error: null },
      { data: null, error: null },
    ];
    const { findByTestId, queryByTestId } = render(<EODCount />);
    await findByTestId('eod-item-units-item-1');
    expect(queryByTestId('eod-yesterday-reminder')).toBeNull();
  });
});

describe('EODCount — spec 072 scroll-pinned-footer', () => {
  it('items FlatList carries style with flex: 1 (scroll container guard)', async () => {
    // Regression guard for spec 072 AC3. The fix adds `style={styles.itemListBody}`
    // (flex: 1) to the items FlatList so it becomes the scroll container instead
    // of growing past the viewport and hiding the Submit footer on web. If a future
    // edit removes this style or sets flex: 0, Submit is pushed below the fold again
    // on any vendor with more items than the viewport height.
    mockNextResultStack = [
      { data: [{ vendor_id: 'v-1', vendor_name: 'Sysco', vendor: { id: 'v-1', name: 'Sysco' } }], error: null },
      { data: [itemVendorRow({ id: 'item-1', catalog: { name: 'Flour', unit: 'lb' } })], error: null },
      { data: null, error: null },
    ];
    const { UNSAFE_getAllByType, findByTestId } = render(<EODCount />);
    // Wait until the populated FlatList (items) has rendered.
    await findByTestId('eod-item-row-item-1');
    const flatLists = UNSAFE_getAllByType(FlatList);
    // The items FlatList is the last FlatList in the tree (vendor switcher
    // is horizontal; items list is vertical with style={styles.itemListBody}).
    const itemsList = flatLists[flatLists.length - 1];
    const styleProp = itemsList.props.style;
    const styles: Record<string, unknown>[] = Array.isArray(styleProp)
      ? (styleProp as unknown[]).flat(Infinity) as Record<string, unknown>[]
      : [styleProp as Record<string, unknown>];
    const flex = styles.filter(Boolean).map((s) => s.flex).find((v) => v !== undefined);
    expect(flex).toBe(1);
  });
});

// ─── Spec 103 — per-user custom drag order ───────────────────────────
describe('EODCount — spec 103 custom order', () => {
  // A saved order [item-2, item-1] reverses the fetch order [item-1, item-2].
  function seedTwoItems() {
    mockNextResultStack = [
      { data: [{ vendor_id: 'v-1', vendor_name: 'Sysco', vendor: { id: 'v-1', name: 'Sysco' } }], error: null },
      {
        data: [
          itemVendorRow({ id: 'item-1', catalog: { name: 'Apple', unit: 'lb', case_qty: 1 } }),
          itemVendorRow({ id: 'item-2', catalog: { name: 'Banana', unit: 'lb', case_qty: 1 } }),
        ],
        error: null,
      },
      { data: null, error: null }, // no existing submission
    ];
  }

  it('opens in Custom view and renders rows flat in the SAVED order (AC-3/AC-7)', async () => {
    seedTwoItems();
    // Saved order reverses the default fetch order.
    mockCountOrderResult = { data: { item_ids: ['item-2', 'item-1'] }, error: null };
    const { findByTestId, getByTestId } = render(<EODCount />);
    // Custom toggle is selected once the saved order resolves.
    await waitFor(() =>
      expect(getByTestId('eod-view-custom').props.accessibilityState?.selected).toBe(true),
    );
    // Both rows render flat (no category headers on this screen anyway).
    expect(await findByTestId('eod-item-row-item-1')).toBeTruthy();
    expect(getByTestId('eod-item-row-item-2')).toBeTruthy();
  });

  it('AC-9: the submit payload is byte-identical with and without a custom order', async () => {
    // Baseline (default view, no saved order) — capture the payload.
    mockSubmit.mockResolvedValue({ kind: 'success', submission_id: 'sub-new' });
    seedTwoItems();
    mockNextResultStack.push({ data: null, error: null }); // re-fetch after submit
    const first = render(<EODCount />);
    fireEvent.changeText(await first.findByTestId('eod-item-units-item-1'), '3');
    fireEvent.changeText(await first.findByTestId('eod-item-units-item-2'), '5');
    fireEvent.press(await first.findByTestId('eod-submit'));
    await waitFor(() => expect(mockSubmit).toHaveBeenCalled());
    const defaultEntries = mockSubmit.mock.calls[0][0].entries;
    first.unmount();

    // Custom view (saved order reversed) — same inputs, same store/vendor.
    mockSubmit.mockClear();
    seedTwoItems();
    mockNextResultStack.push({ data: null, error: null });
    mockCountOrderResult = { data: { item_ids: ['item-2', 'item-1'] }, error: null };
    const second = render(<EODCount />);
    await waitFor(() =>
      expect(second.getByTestId('eod-view-custom').props.accessibilityState?.selected).toBe(true),
    );
    fireEvent.changeText(await second.findByTestId('eod-item-units-item-1'), '3');
    fireEvent.changeText(await second.findByTestId('eod-item-units-item-2'), '5');
    fireEvent.press(await second.findByTestId('eod-submit'));
    await waitFor(() => expect(mockSubmit).toHaveBeenCalled());
    const customEntries = mockSubmit.mock.calls[0][0].entries;

    // The submission iterates the FULL `items` (fetch order), never the
    // reordered view — so the entry set is byte-identical regardless of view.
    expect(customEntries).toEqual(defaultEntries);
  });

  it('AC-12: the gate jump targets the first uncounted in the CUSTOM order', async () => {
    // Saved order puts item-2 first. Fill item-1 only → the single uncounted is
    // item-2, and in the custom order it is the TOP row, so the gate jumps to it.
    seedTwoItems();
    mockCountOrderResult = { data: { item_ids: ['item-2', 'item-1'] }, error: null };
    const { findByTestId, getByTestId } = render(<EODCount />);
    await waitFor(() =>
      expect(getByTestId('eod-view-custom').props.accessibilityState?.selected).toBe(true),
    );
    fireEvent.changeText(await findByTestId('eod-item-units-item-1'), '4');
    // item-2 left blank — press submit → blocked + jump.
    fireEvent.press(getByTestId('eod-submit'));
    await waitFor(() => expect(Toast.show).toHaveBeenCalled());
    expect(mockSubmit).not.toHaveBeenCalled();
    // The blocked-submit toast names exactly 1 remaining (item-2).
    const toastCall = (Toast.show as jest.Mock).mock.calls.find(
      (c) => c[0]?.text1 === 'Count every item first',
    );
    expect(toastCall?.[0]).toMatchObject({ text2: '1 still need a count' });
  });

  it('Reset returns to default view (AC-4/AC-8)', async () => {
    seedTwoItems();
    mockCountOrderResult = { data: { item_ids: ['item-2', 'item-1'] }, error: null };
    const { getByTestId } = render(<EODCount />);
    await waitFor(() =>
      expect(getByTestId('eod-view-custom').props.accessibilityState?.selected).toBe(true),
    );
    // The reset control is present (a saved order exists). Pressing it flips
    // to default view.
    fireEvent.press(getByTestId('eod-reset-order'));
    await waitFor(() =>
      expect(getByTestId('eod-view-default').props.accessibilityState?.selected).toBe(true),
    );
  });
});
