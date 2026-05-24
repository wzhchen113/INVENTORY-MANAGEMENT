// src/screens/staff/screens/EODCount.test.tsx — screen behavior tests.
//
// Mocks at the hook boundary per spec 062 §0 Q5: useEodSubmit replaces
// the entire submit+queue orchestration; supabase.from() is stubbed
// for the vendor / item / existing-submission reads.

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
  it('renders the store name and an item row with a decimal-pad input', async () => {
    // Mock the data fetch sequence: vendors, items, existing
    mockNextResultStack = [
      // vendors for today
      { data: [{ vendor_id: 'v-1', vendor_name: 'Sysco', vendor: { id: 'v-1', name: 'Sysco' } }], error: null },
      // items for vendor
      {
        data: [
          {
            id: 'item-1',
            vendor_id: 'v-1',
            catalog: { name: 'Flour', unit: 'lb' },
          },
        ],
        error: null,
      },
      // existing submission — none
      { data: null, error: null },
    ];

    const { findByText, getByTestId } = render(<EODCount />);
    expect(await findByText('Frederick')).toBeTruthy();
    // Item row renders after fetch
    await waitFor(() => expect(getByTestId('eod-item-row-item-1')).toBeTruthy());
    expect(getByTestId('eod-item-input-item-1')).toBeTruthy();
    expect(getByTestId('eod-submit')).toBeTruthy();
  });

  it('shows the pre-fill banner when an existing submission is returned', async () => {
    mockNextResultStack = [
      { data: [{ vendor_id: 'v-1', vendor_name: 'Sysco', vendor: { id: 'v-1', name: 'Sysco' } }], error: null },
      {
        data: [
          { id: 'item-1', vendor_id: 'v-1', catalog: { name: 'Flour', unit: 'lb' } },
        ],
        error: null,
      },
      {
        data: {
          id: 'sub-1',
          submitted_at: '2026-05-24T18:30:00Z',
          eod_entries: [{ item_id: 'item-1', actual_remaining: 12 }],
        },
        error: null,
      },
    ];
    const { findByTestId } = render(<EODCount />);
    expect(await findByTestId('eod-prefill-banner')).toBeTruthy();
  });

  it('calls submit with mapped payload when Submit is pressed', async () => {
    mockSubmit.mockResolvedValue({ kind: 'success', submission_id: 'sub-new' });
    mockNextResultStack = [
      { data: [{ vendor_id: 'v-1', vendor_name: 'Sysco', vendor: { id: 'v-1', name: 'Sysco' } }], error: null },
      {
        data: [
          { id: 'item-1', vendor_id: 'v-1', catalog: { name: 'Flour', unit: 'lb' } },
        ],
        error: null,
      },
      { data: null, error: null }, // no existing
      { data: null, error: null }, // re-fetch after submit success
    ];
    const { findByTestId } = render(<EODCount />);
    const input = await findByTestId('eod-item-input-item-1');
    fireEvent.changeText(input, '7.5');
    const submit = await findByTestId('eod-submit');
    fireEvent.press(submit);
    await waitFor(() => expect(mockSubmit).toHaveBeenCalled());
    expect(mockSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        store_id: 'store-1',
        vendor_id: 'v-1',
        entries: [{ item_id: 'item-1', count: 7.5 }],
      }),
    );
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
    fireEvent.changeText(await findByTestId('eod-item-input-item-1'), '7');
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
    fireEvent.changeText(await findByTestId('eod-item-input-item-1'), '7');
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
    fireEvent.changeText(await findByTestId('eod-item-input-item-1'), '7');
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
    const input = await findByTestId('eod-item-input-item-1');
    fireEvent.changeText(input, '7');
    fireEvent.press(await findByTestId('eod-submit'));
    await waitFor(() => {
      expect(input.props.value).toBe('');
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
      const input = await findByTestId('eod-item-input-item-1');
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
