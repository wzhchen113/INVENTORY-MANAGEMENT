// src/screens/staff/screens/WeeklyCount.test.tsx — weekly full-store
// count screen behavior tests (spec 098 §10).
//
// Asserts: renders ALL items for the store (not vendor-scoped); dual
// case/each inputs ONLY where case_qty > 1 (single input otherwise);
// submit gated on ≥1 non-blank entry; the WeeklyDueBanner shows for
// open/overdue and hides for completed/not_scheduled.
//
// Mocks at the boundary like EODCount.test.tsx: supabase.from() for the
// item read, supabase.rpc() for the status fetch, and the staff store's
// submitWeeklyCount action. useFocusEffect is shimmed to a plain effect.

import { fireEvent, render, waitFor } from '@testing-library/react-native';

// useFocusEffect → run the callback once on mount (no navigator in tests).
jest.mock('@react-navigation/native', () => ({
  useFocusEffect: (cb: () => void | (() => void)) => {
    const { useEffect } = require('react');
    // eslint-disable-next-line react-hooks/rules-of-hooks
    useEffect(() => cb(), [cb]);
  },
}));

// ─── mock supabase.from() (item read) + supabase.rpc() (status) ──────
type QueryResult = { data: unknown; error: unknown };
let mockItemsResult: QueryResult = { data: [], error: null };
let mockRpcResult: QueryResult = { data: null, error: null };

function mockQueryBuilder() {
  const builder: Record<string, unknown> = {
    select: () => builder,
    eq: () => builder,
    order: () => builder,
    then: (resolve: (v: QueryResult) => unknown) => resolve(mockItemsResult),
  };
  return builder;
}

jest.mock('../../../lib/supabase', () => ({
  supabase: {
    from: () => mockQueryBuilder(),
    rpc: (_fn: string) => Promise.resolve(mockRpcResult),
    auth: { signOut: jest.fn().mockResolvedValue({ error: null }) },
  },
}));

import { WeeklyCount } from './WeeklyCount';
import { useStaffStore } from '../store/useStaffStore';

function seedSignedIn() {
  useStaffStore.setState({
    authState: {
      kind: 'signed-in',
      userId: 'user-1',
      stores: [{ storeId: 'store-1', storeName: 'Frederick' }],
    },
    activeStore: { id: 'store-1', name: 'Frederick' },
    weeklyStatus: null,
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockItemsResult = { data: [], error: null };
  mockRpcResult = { data: null, error: null };
  seedSignedIn();
});

describe('WeeklyCount', () => {
  it('renders EVERY item for the store (not vendor-scoped)', async () => {
    mockItemsResult = {
      data: [
        { id: 'item-1', catalog: { name: 'Flour', unit: 'lb', case_qty: 12 } },
        { id: 'item-2', catalog: { name: 'Salt', unit: 'oz', case_qty: 1 } },
      ],
      error: null,
    };
    const { getByTestId } = render(<WeeklyCount />);
    await waitFor(() => expect(getByTestId('weekly-item-row-item-1')).toBeTruthy());
    expect(getByTestId('weekly-item-row-item-2')).toBeTruthy();
  });

  it('shows dual case/each inputs ONLY where case_qty > 1; single input otherwise', async () => {
    mockItemsResult = {
      data: [
        { id: 'item-1', catalog: { name: 'Flour', unit: 'lb', case_qty: 12 } }, // dual
        { id: 'item-2', catalog: { name: 'Salt', unit: 'oz', case_qty: 1 } }, // single
      ],
      error: null,
    };
    const { getByTestId, queryByTestId } = render(<WeeklyCount />);
    await waitFor(() => expect(getByTestId('weekly-item-row-item-1')).toBeTruthy());
    // Dual: both inputs present.
    expect(getByTestId('weekly-item-cases-item-1')).toBeTruthy();
    expect(getByTestId('weekly-item-units-item-1')).toBeTruthy();
    // Single (case_qty=1): only the units input, no cases input.
    expect(queryByTestId('weekly-item-cases-item-2')).toBeNull();
    expect(getByTestId('weekly-item-units-item-2')).toBeTruthy();
  });

  it('gates submit on ≥1 non-blank entry — disabled while empty, enabled once filled, never calls RPC empty', async () => {
    const mockSubmit = jest.fn().mockResolvedValue({
      count_id: 'c-1',
      conflict: false,
      entry_ids: ['e-1'],
    });
    useStaffStore.setState({ submitWeeklyCount: mockSubmit as any });
    mockItemsResult = {
      data: [{ id: 'item-1', catalog: { name: 'Flour', unit: 'lb', case_qty: 12 } }],
      error: null,
    };
    const { getByTestId } = render(<WeeklyCount />);
    await waitFor(() => expect(getByTestId('weekly-item-row-item-1')).toBeTruthy());
    // With no entries the Submit button is disabled — pressing it is a
    // no-op (the disabled Pressable swallows onPress) so the RPC is never
    // called on an empty form.
    const submit = getByTestId('weekly-submit');
    expect(submit.props.accessibilityState?.disabled).toBe(true);
    fireEvent.press(submit);
    expect(mockSubmit).not.toHaveBeenCalled();
    // Once a box is non-blank the gate lifts and submit goes through.
    fireEvent.changeText(getByTestId('weekly-item-units-item-1'), '4');
    await waitFor(() =>
      expect(getByTestId('weekly-submit').props.accessibilityState?.disabled).toBe(false),
    );
    fireEvent.press(getByTestId('weekly-submit'));
    await waitFor(() => expect(mockSubmit).toHaveBeenCalled());
  });

  it('submits the converted total once ≥1 box is non-blank', async () => {
    const mockSubmit = jest.fn().mockResolvedValue({
      count_id: 'c-1',
      conflict: false,
      entry_ids: ['e-1'],
    });
    useStaffStore.setState({ submitWeeklyCount: mockSubmit as any });
    mockItemsResult = {
      data: [{ id: 'item-1', catalog: { name: 'Flour', unit: 'lb', case_qty: 12 } }],
      error: null,
    };
    const { getByTestId } = render(<WeeklyCount />);
    await waitFor(() => expect(getByTestId('weekly-item-row-item-1')).toBeTruthy());
    fireEvent.changeText(getByTestId('weekly-item-cases-item-1'), '2');
    fireEvent.changeText(getByTestId('weekly-item-units-item-1'), '3');
    fireEvent.press(getByTestId('weekly-submit'));
    await waitFor(() => expect(mockSubmit).toHaveBeenCalled());
    // total = 2 × 12 + 3 = 27; raw splits carried.
    expect(mockSubmit.mock.calls[0][0]).toMatchObject({
      storeId: 'store-1',
      entries: [
        {
          item_id: 'item-1',
          actual_remaining: 27,
          actual_remaining_cases: 2,
          actual_remaining_each: 3,
          unit: 'lb',
        },
      ],
    });
  });

  it('shows the due/overdue banner for open + overdue status', async () => {
    mockItemsResult = {
      data: [{ id: 'item-1', catalog: { name: 'Flour', unit: 'lb', case_qty: 1 } }],
      error: null,
    };
    useStaffStore.setState({
      weeklyStatus: {
        storeId: 'store-1',
        dueDow: 3,
        windowStart: '2026-06-15',
        windowEnd: '2026-06-21',
        status: 'overdue',
        lastCountId: null,
        lastCountedAt: null,
      },
    });
    const { getByTestId } = render(<WeeklyCount />);
    await waitFor(() => expect(getByTestId('weekly-due-banner')).toBeTruthy());
  });

  it('hides the banner for completed + not_scheduled status', async () => {
    mockItemsResult = {
      data: [{ id: 'item-1', catalog: { name: 'Flour', unit: 'lb', case_qty: 1 } }],
      error: null,
    };
    useStaffStore.setState({
      weeklyStatus: {
        storeId: 'store-1',
        dueDow: 3,
        windowStart: '2026-06-15',
        windowEnd: '2026-06-21',
        status: 'completed',
        lastCountId: 'c-1',
        lastCountedAt: '2026-06-18T12:00:00Z',
      },
    });
    const { queryByTestId, getByTestId } = render(<WeeklyCount />);
    await waitFor(() => expect(getByTestId('weekly-item-row-item-1')).toBeTruthy());
    expect(queryByTestId('weekly-due-banner')).toBeNull();

    // not_scheduled also hides.
    useStaffStore.setState({
      weeklyStatus: {
        storeId: 'store-1',
        dueDow: null,
        windowStart: null,
        windowEnd: null,
        status: 'not_scheduled',
        lastCountId: null,
        lastCountedAt: null,
      },
    });
    expect(queryByTestId('weekly-due-banner')).toBeNull();
  });
});
