// src/screens/staff/screens/EODCount.test.tsx — screen behavior tests.
//
// Mocks at the hook boundary per spec 062 §0 Q5: useEodSubmit replaces
// the entire submit+queue orchestration; supabase.from() is stubbed
// for the vendor / item / existing-submission reads.

import { FlatList } from 'react-native';
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import Toast from 'react-native-toast-message';

// ─── mock the hook surface ───────────────────────────────────────
const mockSubmit = jest.fn();
jest.mock('../hooks/useEodSubmit', () => ({
  useEodSubmit: () => ({
    submit: mockSubmit,
    pending: 0,
    draining: false,
  }),
}));

// ─── mock supabase.from() so vendor/item/existing reads work ─────
type QueryResult = { data: unknown; error: unknown };
const mockFromCalls: string[] = [];
let mockNextResultStack: QueryResult[] = [];

function mockQueryBuilder(table: string) {
  mockFromCalls.push(table);
  const result = mockNextResultStack.shift() ?? { data: [], error: null };
  const builder: Record<string, unknown> = {
    select: () => builder,
    eq: () => builder,
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
    auth: { signOut: jest.fn().mockResolvedValue({ error: null }) },
  },
}));

import { EODCount } from './EODCount';
import { useStaffStore } from '../store/useStaffStore';

beforeEach(() => {
  jest.clearAllMocks();
  mockSubmit.mockReset();
  mockFromCalls.length = 0;
  mockNextResultStack = [];
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
          {
            id: 'item-1',
            vendor_id: 'v-1',
            catalog: { name: 'Flour', unit: 'lb', case_qty: 12 },
          },
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
          {
            id: 'item-1',
            vendor_id: 'v-1',
            catalog: { name: 'Flour', unit: 'lb', case_qty: 12, i18n_names: { es: 'Harina' } },
          },
          // item-2: no es override → English fallback.
          {
            id: 'item-2',
            vendor_id: 'v-1',
            catalog: { name: 'Salt', unit: 'oz', case_qty: 1, i18n_names: { 'zh-CN': '盐' } },
          },
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
      { data: [{ id: 'item-1', vendor_id: 'v-1', catalog: { name: 'Flour', unit: 'lb', case_qty: 12 } }], error: null },
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
      { data: [{ id: 'item-1', vendor_id: 'v-1', catalog: { name: 'Flour', unit: 'lb', case_qty: 12 } }], error: null },
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
          { id: 'item-1', vendor_id: 'v-1', catalog: { name: 'Flour', unit: 'lb', case_qty: 12 } },
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
          { id: 'item-1', vendor_id: 'v-1', catalog: { name: 'Flour', unit: 'lb', case_qty: 12 } },
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

  it('converts Cases × caseQty + Units into the total in the submit payload', async () => {
    mockSubmit.mockResolvedValue({ kind: 'success', submission_id: 'sub-new' });
    mockNextResultStack = [
      { data: [{ vendor_id: 'v-1', vendor_name: 'Sysco', vendor: { id: 'v-1', name: 'Sysco' } }], error: null },
      {
        data: [
          { id: 'item-1', vendor_id: 'v-1', catalog: { name: 'Flour', unit: 'lb', case_qty: 12 } },
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
          { id: 'item-1', vendor_id: 'v-1', catalog: { name: 'Brown Paper Bag', unit: 'each', case_qty: 20 } },
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
        data: [{ id: 'item-1', vendor_id: 'v-1', catalog: { name: 'Flour', unit: 'lb' } }],
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
        data: [{ id: 'item-1', vendor_id: 'v-1', catalog: { name: 'Flour', unit: 'lb', case_qty: 12 } }],
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
        data: [{ id: 'item-1', vendor_id: 'v-1', catalog: { name: 'Flour', unit: 'lb', case_qty: 4 } }],
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

  it('skips a fully-blank row (no Cases, no Units) → noCountsEntered toast', async () => {
    mockNextResultStack = [
      { data: [{ vendor_id: 'v-1', vendor_name: 'Sysco', vendor: { id: 'v-1', name: 'Sysco' } }], error: null },
      {
        data: [{ id: 'item-1', vendor_id: 'v-1', catalog: { name: 'Flour', unit: 'lb', case_qty: 12 } }],
        error: null,
      },
      { data: null, error: null },
    ];
    const { findByTestId } = render(<EODCount />);
    // Press Submit without touching either input.
    await findByTestId('eod-item-cases-item-1');
    fireEvent.press(await findByTestId('eod-submit'));
    await waitFor(() => expect(Toast.show).toHaveBeenCalled());
    // submit() never called — the empty-payload guard fired first.
    expect(mockSubmit).not.toHaveBeenCalled();
    expect((Toast.show as jest.Mock).mock.calls[0][0]).toMatchObject({
      text1: 'Submission failed — try again',
      text2: 'No counts entered',
    });
  });

  it('shows "Submitted" toast on success outcome', async () => {
    mockSubmit.mockResolvedValue({ kind: 'success', submission_id: 'sub-new' });
    mockNextResultStack = [
      { data: [{ vendor_id: 'v-1', vendor_name: 'Sysco', vendor: { id: 'v-1', name: 'Sysco' } }], error: null },
      { data: [{ id: 'item-1', vendor_id: 'v-1', catalog: { name: 'Flour', unit: 'lb' } }], error: null },
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
      { data: [{ id: 'item-1', vendor_id: 'v-1', catalog: { name: 'Flour', unit: 'lb' } }], error: null },
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
      { data: [{ id: 'item-1', vendor_id: 'v-1', catalog: { name: 'Flour', unit: 'lb' } }], error: null },
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
      { data: [{ id: 'item-1', vendor_id: 'v-1', catalog: { name: 'Flour', unit: 'lb' } }], error: null },
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
            { id: 'item-1', vendor_id: 'v-1', catalog: { name: 'Flour', unit: 'lb' } },
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

describe('EODCount — spec 072 scroll-pinned-footer', () => {
  it('items FlatList carries style with flex: 1 (scroll container guard)', async () => {
    // Regression guard for spec 072 AC3. The fix adds `style={styles.itemListBody}`
    // (flex: 1) to the items FlatList so it becomes the scroll container instead
    // of growing past the viewport and hiding the Submit footer on web. If a future
    // edit removes this style or sets flex: 0, Submit is pushed below the fold again
    // on any vendor with more items than the viewport height.
    mockNextResultStack = [
      { data: [{ vendor_id: 'v-1', vendor_name: 'Sysco', vendor: { id: 'v-1', name: 'Sysco' } }], error: null },
      { data: [{ id: 'item-1', vendor_id: 'v-1', catalog: { name: 'Flour', unit: 'lb' } }], error: null },
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
