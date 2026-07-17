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
// Spec 126 — <SettingsGear /> in the header also needs useNavigation.
jest.mock('@react-navigation/native', () => ({
  useFocusEffect: (cb: () => void | (() => void)) => {
    const { useEffect } = require('react');
    // eslint-disable-next-line react-hooks/rules-of-hooks
    useEffect(() => cb(), [cb]);
  },
  useNavigation: () => ({ navigate: jest.fn() }),
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
// Spec 110 — the store's shared named layouts (store_count_layouts). The
// `.select().eq().order()` chain resolves this. Default empty so existing tests
// see Default-only (no named pills). Rows are snake_case as PostgREST returns
// them (item_ids / updated_at); the carve-out camelCases inline.
let mockLayoutsResult: QueryResult = { data: [], error: null };
// Spec 106 — the per-user resumable draft (user_count_drafts). `.maybeSingle()`
// returns this; default no-row so existing tests see no draft. The upsert/delete
// (save/discard/delete-on-submit) are captured so the tests can assert them.
let mockDraftResult: QueryResult = { data: null, error: null };
// Bare jest.fn() (permissive jest.Mock<any, any> signature) so the
// `draftUpsert(...args)` spread below type-checks under tsconfig.test.json — a
// `jest.fn(() => Promise.resolve(...))` inline impl infers a ZERO-arg call
// signature that rejects the spread (TS2556). The builder returns its own
// resolved value; these spies exist only to capture the call + args.
const draftUpsert = jest.fn();
const draftDelete = jest.fn();

function mockQueryBuilder(table: string) {
  if (table === 'store_count_layouts') {
    // Spec 110 read-only carve-out: `.select().eq().order()` awaited directly.
    const builder: Record<string, unknown> = {
      select: () => builder,
      eq: () => builder,
      order: () => builder,
      then: (resolve: (v: QueryResult) => unknown) => resolve(mockLayoutsResult),
    };
    return builder;
  }
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
  if (table === 'user_count_drafts') {
    // Staff carve-out I/O shapes (src/screens/staff/lib/countDrafts.ts):
    //   save   → `.upsert(...)` awaited DIRECTLY (no abortSignal — that's the
    //            admin db.ts path).
    //   delete → `.delete().eq().eq().eq()` awaited directly.
    //   read   → `.select().eq().eq().eq().maybeSingle()`.
    // Make the builder thenable so the awaited delete-chain resolves ok.
    const builder: Record<string, unknown> = {
      select: () => builder,
      eq: () => builder,
      upsert: (...args: unknown[]) => {
        draftUpsert(...args);
        return Promise.resolve({ data: null, error: null });
      },
      delete: () => {
        draftDelete();
        return builder;
      },
      maybeSingle: () => Promise.resolve(mockDraftResult),
      // delete() is awaited after the .eq() chain — make the builder thenable.
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

// Spec 106 — a controllable online/offline signal for the Save branch + the
// sync-on-reconnect effect. `setMockOnline(false)` before render simulates an
// offline device.
let mockOnline = true;
const setMockOnline = (v: boolean) => {
  mockOnline = v;
};
jest.mock('../hooks/useConnectionStatus', () => ({
  useConnectionStatus: () => mockOnline,
}));

// Spec 106 — the Discard flow gates on the cross-platform confirm util, which
// routes to Alert.alert on native (Platform.OS is 'ios' in the jest-expo
// jsdom env). Auto-confirm it so the test exercises the post-confirm delete +
// clear behavior deterministically (the confirm-routing itself is covered by
// confirmAction's own contract, not re-tested here). `mockConfirm` lets a test
// assert the confirm was invoked with the draft-discard copy.
const mockConfirm = jest.fn(
  (_title: string, _message: string, onConfirm: () => void) => onConfirm(),
);
jest.mock('../../../utils/confirmAction', () => ({
  confirmAction: (...args: unknown[]) =>
    (mockConfirm as unknown as (...a: unknown[]) => void)(...args),
}));

jest.mock('../../../lib/supabase', () => ({
  supabase: {
    from: (table: string) => mockQueryBuilder(table),
    rpc: (_fn: string) => Promise.resolve(mockRpcResult),
  },
}));

import { WeeklyCount } from './WeeklyCount';
import { useStaffStore } from '../store/useStaffStore';
// Spec 106 — the staff device-local draft trio (AsyncStorage-backed; the global
// jest.setup in-memory AsyncStorage mock makes these real reads/writes). Used to
// seed a local draft before render and to assert the offline-save + reconnect
// sync wrote/cleared the slot.
import {
  readLocalStaffDraft,
  writeLocalStaffDraft,
  staffCountDraftKey,
  serializeWeeklyDraft,
} from '../lib/countDrafts';
import AsyncStorage from '@react-native-async-storage/async-storage';

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

beforeEach(async () => {
  jest.clearAllMocks();
  mockItemsResult = { data: [], error: null };
  mockCategoriesResult = { data: [], error: null };
  mockRpcResult = { data: null, error: null };
  mockCountOrderResult = { data: null, error: null };
  // Spec 110 — reset the shared-layouts server-mock (Default-only by default).
  mockLayoutsResult = { data: [], error: null };
  // Spec 106 — reset the draft server-mock + the online signal + the local KV.
  mockDraftResult = { data: null, error: null };
  setMockOnline(true);
  await AsyncStorage.clear();
  // Reset to English + x1 between tests — both are global store state.
  useStaffStore.setState({ locale: 'en', uiScale: 1 });
  seedSignedIn();
});

// This suite mounts the heaviest staff screen (full-store SectionList + the
// full header). The FIRST mount pays a cold-start cost — StyleSheet factories
// + the scaled-token subtree build on first render — that can exceed Jest's
// 5s default on slower CI runners (subsequent mounts are warm and fast). The
// whole file runs in ~2s locally; the headroom only covers that cold first
// render on CI.
jest.setTimeout(20000);

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

// ─── Spec 110 — PICK-ONLY shared named layouts ───────────────────────
// The staff Weekly screen is pick-only (OQ-1): it READS the store's shared
// named layouts and picks one to apply as a flat Custom view. The spec-103
// per-user drag / auto-save / reset affordances are INTENTIONALLY GONE from
// this screen (an accepted consequence of OQ-1 + OQ-2 — the staff drag-loss is
// pinned as intended, not a regression). These tests assert the pick-only row
// (no save/drag/reset), the apply path (AC-8), search composition (AC-10), the
// gate-jump-follows-order (AC-11), and the submission-scope invariant (AC-11).
describe('WeeklyCount — spec 110 pick-only layouts', () => {
  function twoItems() {
    // Default fetch order is alpha-sorted by name (Apple, Banana). A layout
    // with item_ids [item-2, item-1] reverses that in Custom view.
    mockItemsResult = {
      data: [
        { id: 'item-1', catalog: { name: 'Apple', unit: 'lb', category: 'Produce', case_qty: 1 } },
        { id: 'item-2', catalog: { name: 'Banana', unit: 'lb', category: 'Produce', case_qty: 1 } },
      ],
      error: null,
    };
  }

  // One shared layout that reverses the alpha order (walk-order [item-2, item-1]).
  function oneLayout() {
    mockLayoutsResult = {
      data: [
        {
          id: 'layout-1',
          name: 'Walk order',
          item_ids: ['item-2', 'item-1'],
          position: 1,
          updated_at: '2026-07-04T00:00:00Z',
        },
      ],
      error: null,
    };
  }

  it('renders a PICK-ONLY row: Default + named pills, and NO save/drag/reset affordances', async () => {
    twoItems();
    oneLayout();
    const { getByTestId, queryByTestId } = render(<WeeklyCount />);
    await waitFor(() => expect(getByTestId('weekly-item-row-item-1')).toBeTruthy());
    // The Default pill + the named layout pill both render.
    expect(getByTestId('weekly-layout-default')).toBeTruthy();
    expect(getByTestId('weekly-layout-pill-layout-1')).toBeTruthy();
    // Default is selected on open (no layout picked yet).
    expect(getByTestId('weekly-layout-default').props.accessibilityState?.selected).toBe(true);
    // The removed spec-103 affordances are ABSENT — no Default/Custom toggle,
    // no reset, no move-up/down drag controls, and NO layout Save button.
    expect(queryByTestId('weekly-view-default')).toBeNull();
    expect(queryByTestId('weekly-view-custom')).toBeNull();
    expect(queryByTestId('weekly-reset-order')).toBeNull();
    expect(queryByTestId('weekly-layout-save')).toBeNull();
    // The spec-106 Save-DRAFT button is UNTOUCHED (present).
    expect(getByTestId('weekly-save-draft')).toBeTruthy();
  });

  it('with NO layouts, shows Default only (no named pills) and does not crash', async () => {
    twoItems();
    mockLayoutsResult = { data: [], error: null };
    const { getByTestId, queryByTestId } = render(<WeeklyCount />);
    await waitFor(() => expect(getByTestId('weekly-item-row-item-1')).toBeTruthy());
    expect(getByTestId('weekly-layout-default')).toBeTruthy();
    // No named pills exist.
    expect(queryByTestId('weekly-layout-pill-layout-1')).toBeNull();
    // Default category headers render (category-grouped default view).
    expect(getByTestId('weekly-category-header-Produce')).toBeTruthy();
  });

  it('AC-8: picking a named layout applies its order as a flat Custom view (headers suppressed)', async () => {
    twoItems();
    oneLayout();
    const { getByTestId, queryByTestId } = render(<WeeklyCount />);
    await waitFor(() => expect(getByTestId('weekly-layout-pill-layout-1')).toBeTruthy());
    // Pick the named layout.
    fireEvent.press(getByTestId('weekly-layout-pill-layout-1'));
    await waitFor(() =>
      expect(getByTestId('weekly-layout-pill-layout-1').props.accessibilityState?.selected).toBe(true),
    );
    // Both rows still render…
    expect(getByTestId('weekly-item-row-item-1')).toBeTruthy();
    expect(getByTestId('weekly-item-row-item-2')).toBeTruthy();
    // …but the category header is suppressed in the flat Custom view.
    expect(queryByTestId('weekly-category-header-Produce')).toBeNull();
    // Picking Default returns to the category-grouped view.
    fireEvent.press(getByTestId('weekly-layout-default'));
    await waitFor(() => expect(getByTestId('weekly-category-header-Produce')).toBeTruthy());
  });

  it('AC-11: the submit payload is byte-identical with Default and with a picked layout', async () => {
    const mockSubmit = jest.fn().mockResolvedValue({ count_id: 'c-1', conflict: false, entry_ids: ['e-1', 'e-2'] });
    useStaffStore.setState({ submitWeeklyCount: mockSubmit as any });

    // Default view, no layout picked.
    twoItems();
    oneLayout();
    const first = render(<WeeklyCount />);
    await waitFor(() => expect(first.getByTestId('weekly-item-row-item-1')).toBeTruthy());
    fireEvent.changeText(first.getByTestId('weekly-item-units-item-1'), '3');
    fireEvent.changeText(first.getByTestId('weekly-item-units-item-2'), '5');
    fireEvent.press(first.getByTestId('weekly-submit'));
    await waitFor(() => expect(mockSubmit).toHaveBeenCalled());
    const defaultEntries = mockSubmit.mock.calls[0][0].entries;
    first.unmount();

    // Custom view — pick the reversed layout.
    mockSubmit.mockClear();
    twoItems();
    oneLayout();
    const second = render(<WeeklyCount />);
    await waitFor(() => expect(second.getByTestId('weekly-layout-pill-layout-1')).toBeTruthy());
    fireEvent.press(second.getByTestId('weekly-layout-pill-layout-1'));
    await waitFor(() =>
      expect(second.getByTestId('weekly-layout-pill-layout-1').props.accessibilityState?.selected).toBe(true),
    );
    fireEvent.changeText(second.getByTestId('weekly-item-units-item-1'), '3');
    fireEvent.changeText(second.getByTestId('weekly-item-units-item-2'), '5');
    fireEvent.press(second.getByTestId('weekly-submit'));
    await waitFor(() => expect(mockSubmit).toHaveBeenCalled());
    const customEntries = mockSubmit.mock.calls[0][0].entries;

    // Submission iterates the full `items` (fetch order), never the picked
    // layout order — the entry set is identical regardless of the picked pill.
    expect(customEntries).toEqual(defaultEntries);
  });

  it('AC-10: search composes with the picked layout (matching rows in layout relative order)', async () => {
    twoItems();
    oneLayout();
    const { getByTestId, queryByTestId } = render(<WeeklyCount />);
    await waitFor(() => expect(getByTestId('weekly-layout-pill-layout-1')).toBeTruthy());
    fireEvent.press(getByTestId('weekly-layout-pill-layout-1'));
    await waitFor(() =>
      expect(getByTestId('weekly-layout-pill-layout-1').props.accessibilityState?.selected).toBe(true),
    );
    // Search "Banana" → only item-2 remains; item-1 filtered out. The layout
    // order is preserved among survivors (here a single match).
    fireEvent.changeText(getByTestId('weekly-search'), 'Banana');
    await waitFor(() => expect(queryByTestId('weekly-item-row-item-1')).toBeNull());
    expect(getByTestId('weekly-item-row-item-2')).toBeTruthy();
  });

  it('AC-11: the gate jump targets the first uncounted in the PICKED layout order', async () => {
    const mockSubmit = jest.fn();
    useStaffStore.setState({ submitWeeklyCount: mockSubmit as any });
    twoItems();
    oneLayout();
    const { getByTestId } = render(<WeeklyCount />);
    await waitFor(() => expect(getByTestId('weekly-layout-pill-layout-1')).toBeTruthy());
    fireEvent.press(getByTestId('weekly-layout-pill-layout-1'));
    await waitFor(() =>
      expect(getByTestId('weekly-layout-pill-layout-1').props.accessibilityState?.selected).toBe(true),
    );
    // Fill item-1; leave item-2 blank. In the layout order [item-2, item-1]
    // item-2 is the TOP row → the gate blocks and the toast names 1 remaining.
    fireEvent.changeText(getByTestId('weekly-item-units-item-1'), '4');
    fireEvent.press(getByTestId('weekly-submit'));
    await waitFor(() => expect(Toast.show).toHaveBeenCalled());
    expect(mockSubmit).not.toHaveBeenCalled();
    const toastCall = (Toast.show as jest.Mock).mock.calls.find(
      (c) => c[0]?.text1 === 'Count every item first',
    );
    expect(toastCall?.[0]).toMatchObject({ text2: '1 still need a count' });
  });
});

// ─── Spec 106 — save-draft + resume ──────────────────────────────────
describe('WeeklyCount — spec 106 save-draft + resume', () => {
  function oneItem() {
    // A single dual-input item (case_qty > 1) so both cases + units render.
    mockItemsResult = {
      data: [{ id: 'item-1', catalog: { name: 'Flour', unit: 'lb', category: 'Dry Goods', case_qty: 12 } }],
      error: null,
    };
  }

  it('AC-5/AC-6/AC-16: restores the SERVER draft (newer saved_at) into the inputs and shows the banner', async () => {
    oneItem();
    // Server draft is newer than any local (none here). saved_at ~2 min ago.
    const serverSavedAt = new Date(Date.now() - 2 * 60_000).toISOString();
    mockDraftResult = {
      data: {
        payload: serializeWeeklyDraft({ caseCounts: { 'item-1': '2' }, unitCounts: { 'item-1': '5' } }),
        saved_at: serverSavedAt,
      },
      error: null,
    };
    const { getByTestId } = render(<WeeklyCount />);
    // The restored banner renders…
    await waitFor(() => expect(getByTestId('weekly-draft-banner')).toBeTruthy());
    // …and the typed values are restored VERBATIM into the two inputs.
    await waitFor(() => expect(getByTestId('weekly-item-cases-item-1').props.value).toBe('2'));
    expect(getByTestId('weekly-item-units-item-1').props.value).toBe('5');
    // A Discard affordance is present when a draft is restored (AC-7).
    expect(getByTestId('weekly-draft-discard')).toBeTruthy();
  });

  it('AC-15/AC-16: restores the LOCAL draft when its saved_at is NEWER than the server (and pushes it up)', async () => {
    oneItem();
    const storeId = 'store-1';
    // Local draft newer (now); server draft older (10 min ago).
    const localSavedAt = new Date().toISOString();
    const serverSavedAt = new Date(Date.now() - 10 * 60_000).toISOString();
    await writeLocalStaffDraft('user-1', 'staff-weekly', storeId, {
      payload: serializeWeeklyDraft({ caseCounts: {}, unitCounts: { 'item-1': '9' } }),
      savedAt: localSavedAt,
      unsynced: true,
    });
    mockDraftResult = {
      data: {
        payload: serializeWeeklyDraft({ caseCounts: {}, unitCounts: { 'item-1': '3' } }),
        saved_at: serverSavedAt,
      },
      error: null,
    };
    const { getByTestId } = render(<WeeklyCount />);
    // The NEWER local value wins the restore.
    await waitFor(() => expect(getByTestId('weekly-item-units-item-1').props.value).toBe('9'));
    // reconcile action was 'push' → the local draft was upserted to the server…
    await waitFor(() => expect(draftUpsert).toHaveBeenCalled());
    // …and its local unsynced flag was cleared.
    await waitFor(async () => {
      const rec = await readLocalStaffDraft('user-1', 'staff-weekly', storeId);
      expect(rec?.unsynced).toBe(false);
    });
  });

  it('AC-11: a stale item id in a restored draft is ignored (never crashes; only live ids restore)', async () => {
    oneItem(); // only item-1 is live
    mockDraftResult = {
      data: {
        payload: serializeWeeklyDraft({
          caseCounts: {},
          // item-ghost was deleted since the draft was saved → must be dropped.
          unitCounts: { 'item-1': '7', 'item-ghost': '99' },
        }),
        saved_at: new Date().toISOString(),
      },
      error: null,
    };
    const { getByTestId, queryByTestId } = render(<WeeklyCount />);
    await waitFor(() => expect(getByTestId('weekly-item-units-item-1').props.value).toBe('7'));
    // The stale id never rendered a row (it isn't a live item) and the screen
    // did not crash — the live value restored fine.
    expect(queryByTestId('weekly-item-row-item-ghost')).toBeNull();
  });

  it('AC-7: Discard deletes the server row + the local copy and clears the form', async () => {
    // confirmAction is mocked to auto-confirm (see top of file).
    oneItem();
    const storeId = 'store-1';
    // Seed a local copy too so we can prove BOTH sides are cleared.
    await writeLocalStaffDraft('user-1', 'staff-weekly', storeId, {
      payload: serializeWeeklyDraft({ caseCounts: {}, unitCounts: { 'item-1': '4' } }),
      savedAt: new Date().toISOString(),
      unsynced: false,
    });
    mockDraftResult = {
      data: {
        payload: serializeWeeklyDraft({ caseCounts: {}, unitCounts: { 'item-1': '4' } }),
        saved_at: new Date().toISOString(),
      },
      error: null,
    };
    const { getByTestId, queryByTestId } = render(<WeeklyCount />);
    await waitFor(() => expect(getByTestId('weekly-draft-banner')).toBeTruthy());
    expect(getByTestId('weekly-item-units-item-1').props.value).toBe('4');
    fireEvent.press(getByTestId('weekly-draft-discard'));
    // Server delete fired…
    await waitFor(() => expect(draftDelete).toHaveBeenCalled());
    // …the local copy is gone…
    await waitFor(async () => {
      const rec = await readLocalStaffDraft('user-1', 'staff-weekly', storeId);
      expect(rec).toBeNull();
    });
    // …the banner is dismissed and the input cleared back to fresh.
    await waitFor(() => expect(queryByTestId('weekly-draft-banner')).toBeNull());
    expect(getByTestId('weekly-item-units-item-1').props.value).toBe('');
    // The confirm was invoked before any delete side-effect.
    expect(mockConfirm).toHaveBeenCalled();
  });

  it('AC-8: a successful Submit deletes the draft (server + local) — no stale banner on reopen', async () => {
    const mockSubmit = jest.fn().mockResolvedValue({ count_id: 'c-1', conflict: false, entry_ids: ['e-1'] });
    useStaffStore.setState({ submitWeeklyCount: mockSubmit as any });
    oneItem();
    const storeId = 'store-1';
    await writeLocalStaffDraft('user-1', 'staff-weekly', storeId, {
      payload: serializeWeeklyDraft({ caseCounts: {}, unitCounts: { 'item-1': '6' } }),
      savedAt: new Date().toISOString(),
      unsynced: false,
    });
    const { getByTestId } = render(<WeeklyCount />);
    await waitFor(() => expect(getByTestId('weekly-item-row-item-1')).toBeTruthy());
    // Fill the single item so the count-everything gate lifts, then submit.
    fireEvent.changeText(getByTestId('weekly-item-units-item-1'), '6');
    fireEvent.press(getByTestId('weekly-submit'));
    await waitFor(() => expect(mockSubmit).toHaveBeenCalled());
    // The draft is deleted on submit success — server delete fired…
    await waitFor(() => expect(draftDelete).toHaveBeenCalled());
    // …and the local copy is cleared.
    await waitFor(async () => {
      const rec = await readLocalStaffDraft('user-1', 'staff-weekly', storeId);
      expect(rec).toBeNull();
    });
  });

  it('AC-14: offline Save writes an UNSYNCED local copy + the "saved on this device" toast (no server write)', async () => {
    setMockOnline(false);
    oneItem();
    const storeId = 'store-1';
    const { getByTestId } = render(<WeeklyCount />);
    await waitFor(() => expect(getByTestId('weekly-item-row-item-1')).toBeTruthy());
    fireEvent.changeText(getByTestId('weekly-item-units-item-1'), '8');
    fireEvent.press(getByTestId('weekly-save-draft'));
    // The offline toast (not the plain "Draft saved") is shown.
    await waitFor(() => {
      const call = (Toast.show as jest.Mock).mock.calls.find(
        (c) => c[0]?.text1 === 'Saved on this device — will sync when online',
      );
      expect(call).toBeTruthy();
    });
    // A device-local UNSYNCED copy was written; the server was NOT touched.
    const rec = await readLocalStaffDraft('user-1', 'staff-weekly', storeId);
    expect(rec?.unsynced).toBe(true);
    expect(rec?.payload).toMatchObject({ unitCounts: { 'item-1': '8' } });
    expect(draftUpsert).not.toHaveBeenCalled();
  });

  it('AC-9: pressing Save calls ONLY the draft helper — Submit is never invoked (no history row)', async () => {
    // AC-9: a draft is purely resumable state — Save must NOT route through
    // submitWeeklyCount (the only path that writes the weekly-count history row).
    const mockSubmit = jest.fn().mockResolvedValue({ count_id: 'c-1', conflict: false, entry_ids: ['e-1'] });
    useStaffStore.setState({ submitWeeklyCount: mockSubmit as any });
    oneItem();
    const { getByTestId } = render(<WeeklyCount />);
    await waitFor(() => expect(getByTestId('weekly-item-row-item-1')).toBeTruthy());
    // Partially fill (Save is ungated) and press Save — NOT Submit.
    fireEvent.changeText(getByTestId('weekly-item-units-item-1'), '3');
    fireEvent.press(getByTestId('weekly-save-draft'));
    // The draft upsert fired (online default)…
    await waitFor(() => expect(draftUpsert).toHaveBeenCalled());
    // …and Submit was NOT — Save and Submit are independent affordances.
    expect(mockSubmit).not.toHaveBeenCalled();
  });

  it('AC-17: a fresh mount (new device, empty local slot) restores the server draft the first device saved', async () => {
    // Cross-device visibility (AC-17): the server is the source of truth once
    // synced. This "second device" starts with an EMPTY AsyncStorage slot
    // (cleared in beforeEach) and the server fetch returns the row the first
    // device saved — the fresh mount must fetch + restore it. (The DB owner-read
    // layer that makes this the SAME user's row across sessions is covered by the
    // pgTAP owner-scoped RLS suite; here we prove the client restores a
    // server-only draft on a device with no local copy.)
    oneItem();
    const storeId = 'store-1';
    // Assert this device truly has no local draft before render.
    expect(await readLocalStaffDraft('user-1', 'staff-weekly', storeId)).toBeNull();
    const serverSavedAt = new Date(Date.now() - 60_000).toISOString();
    mockDraftResult = {
      data: {
        payload: serializeWeeklyDraft({ caseCounts: {}, unitCounts: { 'item-1': '42' } }),
        saved_at: serverSavedAt,
      },
      error: null,
    };
    const { getByTestId } = render(<WeeklyCount />);
    // The server draft restores on the fresh device…
    await waitFor(() => expect(getByTestId('weekly-item-units-item-1').props.value).toBe('42'));
    // …with the restored banner.
    expect(getByTestId('weekly-draft-banner')).toBeTruthy();
  });

  it('AC-15: on reconnect (offline→online flip), a newer unsynced local draft is pushed up to the server', async () => {
    setMockOnline(false);
    oneItem();
    const storeId = 'store-1';
    const { getByTestId, rerender } = render(<WeeklyCount />);
    await waitFor(() => expect(getByTestId('weekly-item-row-item-1')).toBeTruthy());
    // Save offline → unsynced local copy, no server write yet.
    fireEvent.changeText(getByTestId('weekly-item-units-item-1'), '5');
    fireEvent.press(getByTestId('weekly-save-draft'));
    await waitFor(async () => {
      const rec = await readLocalStaffDraft('user-1', 'staff-weekly', storeId);
      expect(rec?.unsynced).toBe(true);
    });
    expect(draftUpsert).not.toHaveBeenCalled();
    // No server draft exists → the lone unsynced local is the push winner.
    mockDraftResult = { data: null, error: null };
    // Flip online + re-render so the reconnect effect (wasOnlineRef false→true)
    // fires.
    setMockOnline(true);
    rerender(<WeeklyCount />);
    // The local draft is pushed up to the server and its flag cleared.
    await waitFor(() => expect(draftUpsert).toHaveBeenCalled());
    await waitFor(async () => {
      const rec = await readLocalStaffDraft('user-1', 'staff-weekly', storeId);
      expect(rec?.unsynced).toBe(false);
    });
  });
});
