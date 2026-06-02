// src/screens/staff/screens/Reorder.test.tsx — Spec 089 (B)(D)(F).
//
// Renders the staff Reorder screen with the staff fetch carve-out mocked at
// its module boundary → asserts:
//   - the per-vendor cards render with the spec-088 by-the-case Suggested
//     string (formatSuggested byte-for-byte)
//   - the KPI strip reads computeReorderKpis(primary) (filtered set)
//   - the four states (loading / empty / nothing-to-order / error)
//   - the order-out partition (primary vs no-schedule collapsible)
//   - showExport gates on primary.length (export buttons appear only with a
//     non-empty filtered set)
//
// Boundary mocking mirrors EODCount.test.tsx: mock the fetch + share libs so
// the screen renders headless against an in-memory payload. The staff theme
// resolves to the light palette under jest (useColorScheme()→null→light).

// All hoisted-factory-referenced vars are `mock`-prefixed per Jest's
// out-of-scope allowlist.
const mockFetchStaffReorder = jest.fn();
const mockFetchStaffOrderSchedule = jest.fn();
jest.mock('../lib/fetchReorder', () => ({
  fetchStaffReorder: (...a: unknown[]) => mockFetchStaffReorder(...a),
  fetchStaffOrderSchedule: (...a: unknown[]) => mockFetchStaffOrderSchedule(...a),
}));

const mockShareReorderCsv = jest.fn().mockResolvedValue(undefined);
const mockShareReorderText = jest.fn().mockResolvedValue(undefined);
const mockShareReorderPdf = jest.fn().mockResolvedValue(undefined);
jest.mock('../lib/shareReorder', () => ({
  shareReorderCsv: (...a: unknown[]) => mockShareReorderCsv(...a),
  shareReorderText: (...a: unknown[]) => mockShareReorderText(...a),
  shareReorderPdf: (...a: unknown[]) => mockShareReorderPdf(...a),
}));

// Reorder.tsx imports the real supabase client for its sign-out action —
// stub the boundary so the test env doesn't need SUPABASE_URL (mirrors
// EODCount.test.tsx). The data path is mocked at fetchReorder above.
jest.mock('../../../lib/supabase', () => ({
  supabase: {
    auth: { signOut: jest.fn().mockResolvedValue({ error: null }) },
  },
}));

import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { Reorder } from './Reorder';
import { useStaffStore } from '../store/useStaffStore';
import type { OrderSchedule, ReorderItem, ReorderPayload, ReorderVendor } from '../../../types';

// ── fixtures ──
function item(over: Partial<ReorderItem> & { itemId: string; itemName: string }): ReorderItem {
  return {
    unit: 'each',
    onHand: 0,
    pendingPoQty: 0,
    parLevel: 0,
    usageForecasted: 0,
    parReplacement: 0,
    suggestedQty: 0,
    costPerUnit: 1,
    estimatedCost: 0,
    caseQty: 1,
    suggestedCases: null,
    suggestedUnits: 0,
    flags: [],
    ...over,
  };
}

function vendor(over: Partial<ReorderVendor> & { vendorId: string }): ReorderVendor {
  return {
    vendorName: over.vendorId,
    scheduleKnown: true,
    nextDeliveryDate: '2026-06-03',
    daysUntilNextDelivery: 1,
    onHandSource: 'eod',
    eodSubmittedAt: null,
    items: [],
    vendorTotalCost: 0,
    ...over,
  };
}

// A case item (49 units, case of 24 → 3 cases · 72 each, $144 at $2/unit).
const caseVendor = vendor({
  vendorId: 'v-1',
  vendorName: 'Acme',
  vendorTotalCost: 144,
  items: [
    item({
      itemId: 'i-1',
      itemName: 'Buns',
      unit: 'each',
      parLevel: 49,
      suggestedQty: 49,
      costPerUnit: 2,
      estimatedCost: 144,
      caseQty: 24,
      suggestedCases: 3,
      suggestedUnits: 72,
    }),
  ],
});

function payloadOf(vendors: ReorderVendor[], warnings: ReorderPayload['warnings'] = []): ReorderPayload {
  return {
    asOfDate: '2026-06-02',
    vendors,
    kpis: { vendorCount: vendors.length, itemCount: 0, totalEstimatedCost: 0, eodSourcedVendorCount: 0, stockFallbackVendorCount: 0 },
    warnings,
  };
}

// A schedule that lists the vendor on EVERY weekday so the lone payload
// vendor always lands in the PRIMARY set regardless of "today".
function everyDaySchedule(vendorId: string): OrderSchedule {
  const entry = [{ vendorId, vendorName: vendorId, deliveryDay: 'Wednesday' }];
  return {
    Sunday: entry, Monday: entry, Tuesday: entry, Wednesday: entry,
    Thursday: entry, Friday: entry, Saturday: entry,
  };
}

function renderScreen() {
  return render(
    <SafeAreaProvider>
      <Reorder />
    </SafeAreaProvider>,
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  useStaffStore.setState({
    authState: {
      kind: 'signed-in',
      userId: 'user-1',
      stores: [
        { storeId: 'store-1', storeName: 'Towson' },
        { storeId: 'store-2', storeName: 'Frederick' },
      ],
    },
    activeStore: { id: 'store-1', name: 'Towson' },
    eodQueue: [],
    draining: false,
  });
});

describe('Reorder — happy path (by-the-case display + KPIs)', () => {
  it('renders the per-vendor card with the spec-088 cases·units Suggested string', async () => {
    mockFetchStaffReorder.mockResolvedValue(payloadOf([caseVendor]));
    mockFetchStaffOrderSchedule.mockResolvedValue(everyDaySchedule('v-1'));

    const { getByText, getAllByText, getByTestId } = renderScreen();
    await waitFor(() => expect(getByTestId('staff-reorder-vendor-v-1')).toBeTruthy());
    expect(getByText('Acme')).toBeTruthy();
    // The Suggested string is byte-for-byte the admin formatSuggested output.
    expect(getByText('Order: 3 cases · 72 each')).toBeTruthy();
    // Server-rounded est cost rides through (no FE cost math). $144.00 shows
    // in the per-item cost, the KPI Est. total, AND the vendor subtotal (the
    // KPI total equals the single item's cost) — so assert ≥1 occurrence.
    expect(getAllByText('$144.00').length).toBeGreaterThanOrEqual(1);
  });

  it('shows the export buttons (CSV/text/PDF) when the filtered set is non-empty', async () => {
    mockFetchStaffReorder.mockResolvedValue(payloadOf([caseVendor]));
    mockFetchStaffOrderSchedule.mockResolvedValue(everyDaySchedule('v-1'));

    const { getByTestId } = renderScreen();
    await waitFor(() => expect(getByTestId('staff-reorder-export-csv')).toBeTruthy());
    expect(getByTestId('staff-reorder-export-text')).toBeTruthy();
    expect(getByTestId('staff-reorder-export-pdf')).toBeTruthy();
  });

  it('export buttons invoke the share orchestrator with the derived payload', async () => {
    mockFetchStaffReorder.mockResolvedValue(payloadOf([caseVendor]));
    mockFetchStaffOrderSchedule.mockResolvedValue(everyDaySchedule('v-1'));

    const { getByTestId } = renderScreen();
    await waitFor(() => expect(getByTestId('staff-reorder-export-csv')).toBeTruthy());
    await act(async () => {
      fireEvent.press(getByTestId('staff-reorder-export-csv'));
    });
    expect(mockShareReorderCsv).toHaveBeenCalledTimes(1);
    // Second arg is the store name; first is the derived (filtered) payload.
    const [passedPayload, storeName] = mockShareReorderCsv.mock.calls[0];
    expect(storeName).toBe('Towson');
    expect(passedPayload.vendors).toHaveLength(1);
    // KPIs recomputed from the primary set (1 vendor, 1 item, $144).
    expect(passedPayload.kpis.itemCount).toBe(1);
    expect(passedPayload.kpis.totalEstimatedCost).toBe(144);
  });
});

describe('Reorder — states', () => {
  it('empty state when the payload has no vendors at all', async () => {
    mockFetchStaffReorder.mockResolvedValue(payloadOf([]));
    mockFetchStaffOrderSchedule.mockResolvedValue({});

    const { getByTestId, queryByTestId } = renderScreen();
    await waitFor(() => expect(getByTestId('staff-reorder-empty')).toBeTruthy());
    // No export buttons on an empty payload.
    expect(queryByTestId('staff-reorder-export-csv')).toBeNull();
  });

  it('nothing-to-order state when vendors exist but none order out today', async () => {
    mockFetchStaffReorder.mockResolvedValue(payloadOf([caseVendor]));
    // Empty schedule → the vendor (scheduleKnown=true) is hidden for every
    // day → primary is empty → distinct "nothing to order" state.
    mockFetchStaffOrderSchedule.mockResolvedValue({});

    const { getByTestId, queryByTestId } = renderScreen();
    await waitFor(() => expect(getByTestId('staff-reorder-nothing-today')).toBeTruthy());
    expect(queryByTestId('staff-reorder-export-csv')).toBeNull();
  });

  it('error pane (retry-able) when the fetch rejects', async () => {
    mockFetchStaffReorder.mockRejectedValue(new Error('permission denied for function'));
    mockFetchStaffOrderSchedule.mockResolvedValue({});

    const { getByTestId, getByText } = renderScreen();
    await waitFor(() => expect(getByTestId('staff-reorder-error')).toBeTruthy());
    expect(getByText('permission denied for function')).toBeTruthy();
    expect(getByTestId('staff-reorder-retry')).toBeTruthy();

    // Retry re-invokes the fetch.
    mockFetchStaffReorder.mockResolvedValue(payloadOf([caseVendor]));
    mockFetchStaffOrderSchedule.mockResolvedValue(everyDaySchedule('v-1'));
    await act(async () => {
      fireEvent.press(getByTestId('staff-reorder-retry'));
    });
    await waitFor(() => expect(getByTestId('staff-reorder-vendor-v-1')).toBeTruthy());
  });
});

describe('Reorder — no-schedule group + warnings', () => {
  it('surfaces scheduleKnown=false vendors in the collapsible no-schedule group', async () => {
    const unscheduled = vendor({
      vendorId: 'v-2',
      vendorName: 'Beta',
      scheduleKnown: false,
      items: [item({ itemId: 'i-2', itemName: 'Salt', suggestedQty: 5, suggestedUnits: 5, estimatedCost: 5 })],
      vendorTotalCost: 5,
    });
    mockFetchStaffReorder.mockResolvedValue(payloadOf([caseVendor, unscheduled]));
    mockFetchStaffOrderSchedule.mockResolvedValue(everyDaySchedule('v-1'));

    const { getByTestId, queryByText } = renderScreen();
    await waitFor(() => expect(getByTestId('staff-reorder-no-schedule-toggle')).toBeTruthy());
    // Collapsed by default — the unscheduled vendor card is not shown yet.
    expect(queryByText('Beta')).toBeNull();
    // Expand it.
    await act(async () => {
      fireEvent.press(getByTestId('staff-reorder-no-schedule-toggle'));
    });
    expect(getByTestId('staff-reorder-vendor-v-2')).toBeTruthy();
  });

  it('renders the warnings banner when the payload carries warnings', async () => {
    mockFetchStaffReorder.mockResolvedValue(
      payloadOf([caseVendor], [{ code: 'schedule_unknown', message: 'Beta has no schedule' }]),
    );
    mockFetchStaffOrderSchedule.mockResolvedValue(everyDaySchedule('v-1'));

    const { getByTestId, getByText } = renderScreen();
    await waitFor(() => expect(getByTestId('staff-reorder-warnings')).toBeTruthy());
    expect(getByText('Beta has no schedule')).toBeTruthy();
  });
});

describe('Reorder — root structure', () => {
  it('root is a SafeAreaView with edges top+bottom (staff convention)', async () => {
    mockFetchStaffReorder.mockResolvedValue(payloadOf([caseVendor]));
    mockFetchStaffOrderSchedule.mockResolvedValue(everyDaySchedule('v-1'));
    const { getByTestId } = renderScreen();
    await waitFor(() => expect(getByTestId('staff-reorder-vendor-v-1')).toBeTruthy());
    const root = getByTestId('staff-reorder-root');
    expect(root.type).toBe('SafeAreaView');
    expect(root.props.edges).toEqual(['top', 'bottom']);
  });
});
