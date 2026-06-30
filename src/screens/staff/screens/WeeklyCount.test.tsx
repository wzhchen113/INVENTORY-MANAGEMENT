// src/screens/staff/screens/WeeklyCount.test.tsx — weekly full-store
// count screen behavior tests (spec 098 §10).
//
// Asserts: renders ALL items for the store (not vendor-scoped); items
// grouped under per-category section headers (catalog_ingredients.category,
// null/empty → "Uncategorized"); dual case/each inputs ONLY where
// case_qty > 1 (single input otherwise); submit gated on ≥1 non-blank
// entry ACROSS ALL categories; the WeeklyDueBanner shows for open/overdue
// and hides for completed/not_scheduled.
//
// Mocks at the boundary like EODCount.test.tsx: supabase.from() for the
// item read, supabase.rpc() for the status fetch, and the staff store's
// submitWeeklyCount action. useFocusEffect is shimmed to a plain effect.

import { fireEvent, render, waitFor } from '@testing-library/react-native';
import Toast from 'react-native-toast-message';

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
// Spec: WeeklyCount now reads ingredient_categories for localized headers.
// Keyed by table so the item read and the category read return distinct
// data (default empty for categories so existing tests are unaffected).
let mockCategoriesResult: QueryResult = { data: [], error: null };
let mockRpcResult: QueryResult = { data: null, error: null };
// Spec 103 — the per-user saved count order (user_count_orders). `.maybeSingle()`
// returns this; default no-row so existing tests open in default view. The
// upsert/delete (save/reset) just resolve OK.
let mockCountOrderResult: QueryResult = { data: null, error: null };

function mockQueryBuilder(table: string) {
  if (table === 'user_count_orders') {
    const builder: Record<string, unknown> = {
      select: () => builder,
      eq: () => builder,
      is: () => builder,
      upsert: () => Promise.resolve({ data: null, error: null }),
      delete: () => builder,
      maybeSingle: () => Promise.resolve(mockCountOrderResult),
      // delete() is awaited directly — make the builder thenable too.
      then: (resolve: (v: QueryResult) => unknown) => resolve({ data: null, error: null }),
    };
    return builder;
  }
  const result =
    table === 'ingredient_categories' ? mockCategoriesResult : mockItemsResult;
  const builder: Record<string, unknown> = {
    select: () => builder,
    eq: () => builder,
    is: () => builder,
    order: () => builder,
    then: (resolve: (v: QueryResult) => unknown) => resolve(result),
  };
  return builder;
}

jest.mock('../../../lib/supabase', () => ({
  supabase: {
    from: (table: string) => mockQueryBuilder(table),
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
  mockCategoriesResult = { data: [], error: null };
  mockRpcResult = { data: null, error: null };
  mockCountOrderResult = { data: null, error: null };
  // Reset to English between tests — locale is global store state.
  useStaffStore.setState({ locale: 'en' });
  seedSignedIn();
});

describe('WeeklyCount', () => {
  it('renders EVERY item for the store (not vendor-scoped)', async () => {
    mockItemsResult = {
      data: [
        { id: 'item-1', catalog: { name: 'Flour', unit: 'lb', category: 'Dry Goods', case_qty: 12 } },
        { id: 'item-2', catalog: { name: 'Salt', unit: 'oz', category: 'Dry Goods', case_qty: 1 } },
      ],
      error: null,
    };
    const { getByTestId } = render(<WeeklyCount />);
    await waitFor(() => expect(getByTestId('weekly-item-row-item-1')).toBeTruthy());
    expect(getByTestId('weekly-item-row-item-2')).toBeTruthy();
  });

  it('groups items under per-category section headers; null/empty category falls under "Uncategorized"', async () => {
    mockItemsResult = {
      data: [
        // Two distinct categories + one with a null category (→ Uncategorized).
        { id: 'item-1', catalog: { name: 'Tomato', unit: 'ea', category: 'Produce', case_qty: 1 } },
        { id: 'item-2', catalog: { name: 'Flour', unit: 'lb', category: 'Dry Goods', case_qty: 12 } },
        { id: 'item-3', catalog: { name: 'Mystery', unit: 'ea', category: null, case_qty: 1 } },
      ],
      error: null,
    };
    const { getByTestId, getByText } = render(<WeeklyCount />);
    await waitFor(() => expect(getByTestId('weekly-item-row-item-1')).toBeTruthy());
    // One header per category, plus the Uncategorized bucket for the null row.
    expect(getByTestId('weekly-category-header-Dry Goods')).toBeTruthy();
    expect(getByTestId('weekly-category-header-Produce')).toBeTruthy();
    expect(getByTestId('weekly-category-header-uncategorized')).toBeTruthy();
    // The Uncategorized header renders its localized title.
    expect(getByText('Uncategorized')).toBeTruthy();
    // All items still render (grouping is display-only).
    expect(getByTestId('weekly-item-row-item-2')).toBeTruthy();
    expect(getByTestId('weekly-item-row-item-3')).toBeTruthy();
  });

  it('submits non-blank entries from MULTIPLE categories (grouping never drops hidden entries)', async () => {
    const mockSubmit = jest.fn().mockResolvedValue({
      count_id: 'c-1',
      conflict: false,
      entry_ids: ['e-1', 'e-2'],
    });
    useStaffStore.setState({ submitWeeklyCount: mockSubmit as any });
    mockItemsResult = {
      data: [
        { id: 'item-1', catalog: { name: 'Tomato', unit: 'ea', category: 'Produce', case_qty: 1 } },
        { id: 'item-2', catalog: { name: 'Flour', unit: 'lb', category: 'Dry Goods', case_qty: 1 } },
      ],
      error: null,
    };
    const { getByTestId } = render(<WeeklyCount />);
    await waitFor(() => expect(getByTestId('weekly-item-row-item-1')).toBeTruthy());
    // Fill one box in each category.
    fireEvent.changeText(getByTestId('weekly-item-units-item-1'), '5');
    fireEvent.changeText(getByTestId('weekly-item-units-item-2'), '7');
    fireEvent.press(getByTestId('weekly-submit'));
    await waitFor(() => expect(mockSubmit).toHaveBeenCalled());
    // Both categories' entries are submitted — grouping is view-only.
    const payload = mockSubmit.mock.calls[0][0];
    expect(payload.entries).toHaveLength(2);
    const ids = payload.entries.map((e: { item_id: string }) => e.item_id).sort();
    expect(ids).toEqual(['item-1', 'item-2']);
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

  it('gates submit on EVERY item counted — an incomplete submit is blocked (no RPC); submits once all filled', async () => {
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
    // The button is enabled (press-to-discover). Pressing it with the row
    // blank fires the completeness gate, which blocks and never calls the RPC
    // on an incomplete form — a blocked submit only toasts + jumps to the gap.
    const submit = getByTestId('weekly-submit');
    expect(submit.props.accessibilityState?.disabled).toBe(false);
    fireEvent.press(submit);
    expect(mockSubmit).not.toHaveBeenCalled();
    // Once EVERY item has a value the gate lifts and submit goes through.
    fireEvent.changeText(getByTestId('weekly-item-units-item-1'), '4');
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

  it('renders localized item names + category headers for a non-English locale; falls back to English when an override is missing', async () => {
    useStaffStore.setState({ locale: 'es' });
    mockItemsResult = {
      data: [
        // item-1 has an es override → shows the Spanish name.
        {
          id: 'item-1',
          catalog: {
            name: 'Flour',
            unit: 'lb',
            category: 'Dry Goods',
            case_qty: 1,
            i18n_names: { es: 'Harina', 'zh-CN': '面粉' },
          },
        },
        // item-2 has NO es override → falls back to the English name.
        {
          id: 'item-2',
          catalog: {
            name: 'Salt',
            unit: 'oz',
            category: 'Dry Goods',
            case_qty: 1,
            i18n_names: { 'zh-CN': '盐' },
          },
        },
      ],
      error: null,
    };
    // Category 'Dry Goods' has an es override → the header localizes.
    mockCategoriesResult = {
      data: [{ name: 'Dry Goods', i18n_names: { es: 'Secos' } }],
      error: null,
    };
    const { getByText } = render(<WeeklyCount />);
    // Item with an es override renders in Spanish.
    await waitFor(() => expect(getByText('Harina')).toBeTruthy());
    // Item without an es override falls back to English silently.
    expect(getByText('Salt')).toBeTruthy();
    // Category header localizes to the es override.
    expect(getByText('Secos')).toBeTruthy();
  });

  it('falls back to the raw English category text when the category has no override (and re-renders on a locale switch)', async () => {
    mockItemsResult = {
      data: [
        {
          id: 'item-1',
          catalog: {
            name: 'Flour',
            unit: 'lb',
            category: 'Dry Goods',
            case_qty: 1,
            i18n_names: { es: 'Harina' },
          },
        },
      ],
      error: null,
    };
    // No row for 'Dry Goods' → header keeps the raw English category text.
    mockCategoriesResult = { data: [], error: null };
    const { getByText } = render(<WeeklyCount />);
    // English first: canonical name + raw category header.
    await waitFor(() => expect(getByText('Flour')).toBeTruthy());
    expect(getByText('Dry Goods')).toBeTruthy();
    // Switch to Spanish: the item name re-renders (override present) WITHOUT
    // a remount; the category header stays English (no override).
    useStaffStore.setState({ locale: 'es' });
    await waitFor(() => expect(getByText('Harina')).toBeTruthy());
    expect(getByText('Dry Goods')).toBeTruthy();
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

// ─── Spec 103 — per-user custom drag order ───────────────────────────
describe('WeeklyCount — spec 103 custom order', () => {
  function twoItems() {
    // Default fetch order is alpha-sorted by name (Apple, Banana). A saved
    // order [item-2, item-1] reverses that in Custom view.
    mockItemsResult = {
      data: [
        { id: 'item-1', catalog: { name: 'Apple', unit: 'lb', category: 'Produce', case_qty: 1 } },
        { id: 'item-2', catalog: { name: 'Banana', unit: 'lb', category: 'Produce', case_qty: 1 } },
      ],
      error: null,
    };
  }

  it('opens in Custom view (category headers suppressed) when a saved order exists (AC-7/AC-13)', async () => {
    twoItems();
    mockCountOrderResult = { data: { item_ids: ['item-2', 'item-1'] }, error: null };
    const { getByTestId, queryByTestId } = render(<WeeklyCount />);
    await waitFor(() =>
      expect(getByTestId('weekly-view-custom').props.accessibilityState?.selected).toBe(true),
    );
    // Both rows render…
    expect(getByTestId('weekly-item-row-item-1')).toBeTruthy();
    expect(getByTestId('weekly-item-row-item-2')).toBeTruthy();
    // …but the category header is suppressed in Custom view (flat list).
    expect(queryByTestId('weekly-category-header-Produce')).toBeNull();
  });

  it('AC-9: the submit payload is byte-identical with and without a custom order', async () => {
    const mockSubmit = jest.fn().mockResolvedValue({ count_id: 'c-1', conflict: false, entry_ids: ['e-1', 'e-2'] });
    useStaffStore.setState({ submitWeeklyCount: mockSubmit as any });

    // Default view, no saved order.
    twoItems();
    const first = render(<WeeklyCount />);
    await waitFor(() => expect(first.getByTestId('weekly-item-row-item-1')).toBeTruthy());
    fireEvent.changeText(first.getByTestId('weekly-item-units-item-1'), '3');
    fireEvent.changeText(first.getByTestId('weekly-item-units-item-2'), '5');
    fireEvent.press(first.getByTestId('weekly-submit'));
    await waitFor(() => expect(mockSubmit).toHaveBeenCalled());
    const defaultEntries = mockSubmit.mock.calls[0][0].entries;
    first.unmount();

    // Custom view, reversed saved order.
    mockSubmit.mockClear();
    twoItems();
    mockCountOrderResult = { data: { item_ids: ['item-2', 'item-1'] }, error: null };
    const second = render(<WeeklyCount />);
    await waitFor(() =>
      expect(second.getByTestId('weekly-view-custom').props.accessibilityState?.selected).toBe(true),
    );
    fireEvent.changeText(second.getByTestId('weekly-item-units-item-1'), '3');
    fireEvent.changeText(second.getByTestId('weekly-item-units-item-2'), '5');
    fireEvent.press(second.getByTestId('weekly-submit'));
    await waitFor(() => expect(mockSubmit).toHaveBeenCalled());
    const customEntries = mockSubmit.mock.calls[0][0].entries;

    // Submission iterates the full `items` (fetch order), never the reordered
    // view — the entry set is identical regardless of view.
    expect(customEntries).toEqual(defaultEntries);
  });

  it('AC-10: search composes with the custom order (matching rows in custom relative order)', async () => {
    twoItems();
    mockCountOrderResult = { data: { item_ids: ['item-2', 'item-1'] }, error: null };
    const { getByTestId, queryByTestId } = render(<WeeklyCount />);
    await waitFor(() =>
      expect(getByTestId('weekly-view-custom').props.accessibilityState?.selected).toBe(true),
    );
    // Search "Banana" → only item-2 remains; item-1 filtered out. The custom
    // order is preserved among survivors (here a single match).
    fireEvent.changeText(getByTestId('weekly-search'), 'Banana');
    await waitFor(() => expect(queryByTestId('weekly-item-row-item-1')).toBeNull());
    expect(getByTestId('weekly-item-row-item-2')).toBeTruthy();
  });

  it('AC-12: the gate jump targets the first uncounted in the CUSTOM order', async () => {
    const mockSubmit = jest.fn();
    useStaffStore.setState({ submitWeeklyCount: mockSubmit as any });
    twoItems();
    mockCountOrderResult = { data: { item_ids: ['item-2', 'item-1'] }, error: null };
    const { getByTestId } = render(<WeeklyCount />);
    await waitFor(() =>
      expect(getByTestId('weekly-view-custom').props.accessibilityState?.selected).toBe(true),
    );
    // Fill item-1; leave item-2 blank. In the custom order item-2 is the TOP
    // row → the gate blocks and the toast names exactly 1 remaining.
    fireEvent.changeText(getByTestId('weekly-item-units-item-1'), '4');
    fireEvent.press(getByTestId('weekly-submit'));
    await waitFor(() => expect(Toast.show).toHaveBeenCalled());
    expect(mockSubmit).not.toHaveBeenCalled();
    const toastCall = (Toast.show as jest.Mock).mock.calls.find(
      (c) => c[0]?.text1 === 'Count every item first',
    );
    expect(toastCall?.[0]).toMatchObject({ text2: '1 still need a count' });
  });

  it('Reset returns to the default category-grouped view (AC-4/AC-8)', async () => {
    twoItems();
    mockCountOrderResult = { data: { item_ids: ['item-2', 'item-1'] }, error: null };
    const { getByTestId } = render(<WeeklyCount />);
    await waitFor(() =>
      expect(getByTestId('weekly-view-custom').props.accessibilityState?.selected).toBe(true),
    );
    fireEvent.press(getByTestId('weekly-reset-order'));
    await waitFor(() =>
      expect(getByTestId('weekly-view-default').props.accessibilityState?.selected).toBe(true),
    );
    // Category header returns in default view.
    expect(getByTestId('weekly-category-header-Produce')).toBeTruthy();
  });
});
