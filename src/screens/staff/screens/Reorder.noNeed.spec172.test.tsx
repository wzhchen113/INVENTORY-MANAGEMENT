// src/screens/staff/screens/Reorder.noNeed.spec172.test.tsx — Spec 172 (AC-38 / OQ-3).
//
// A staff reorder row flagged `no_need` (the item was marked "more than
// enough" at EOD) shows the localized NO NEED label in place of the on-hand
// figure — the stale `current_stock`, which a NO NEED mark never updates — on
// both the "on hand · par" breakdown and the "Have enough stock" In-stock line.
// An unflagged row renders exactly as before.
//
// Harness copied from Reorder.test.tsx (fetch + share libs mocked at their
// module boundary).

jest.setTimeout(20000);

// Spec 126 — the header now renders <SettingsGear />, which calls
// useNavigation. Stub it (no NavigationContainer in these unit renders).
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ navigate: jest.fn() }),
}));

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

// Stub the supabase boundary so the test env doesn't need SUPABASE_URL for any
// transitive import (mirrors EODCount.test.tsx). The data path is mocked at
// fetchReorder above; spec 126 follow-up removed the inline sign-out action.
jest.mock('../../../lib/supabase', () => ({
  supabase: {},
}));

import { render, waitFor } from '@testing-library/react-native';
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
    // Spec 130 — default to a submitted count so fixtures render the normal
    // (counted) card path; pass eodSubmittedAt:null to model an un-counted
    // vendor (the "Count not submitted yet" state).
    eodSubmittedAt: '2026-06-02T00:00:00Z',
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
    // Spec 100 — locale is global store state; reset to English between tests
    // so a localization test doesn't leak its locale into later cases.
    locale: 'en',
  });
});


describe('Reorder — spec 172 NO NEED row', () => {
  it('replaces the on-hand figure with "No need" for the flagged row only', async () => {
    const v = vendor({
      vendorId: 'v-1',
      vendorName: 'Acme',
      items: [
        item({
          itemId: 'i-nn',
          itemName: 'Napkins',
          unit: 'each',
          onHand: 37,
          caseQty: 1,
          parLevel: 10,
          needsOrder: false,
          flags: ['no_need'],
        }),
        item({
          itemId: 'i-ok',
          itemName: 'Cups',
          unit: 'each',
          onHand: 55,
          caseQty: 1,
          parLevel: 10,
          needsOrder: false,
        }),
      ],
    });
    mockFetchStaffReorder.mockResolvedValue(payloadOf([v]));
    mockFetchStaffOrderSchedule.mockResolvedValue(everyDaySchedule('v-1'));

    const { getByText, queryByText, getByTestId } = renderScreen();
    await waitFor(() => expect(getByTestId('reorder-section-enough')).toBeTruthy());
    expect(getByText('In stock: No need')).toBeTruthy();
    expect(getByText('on hand No need · par 10 each')).toBeTruthy();
    expect(queryByText(/37/)).toBeNull();
    // The unflagged row is unchanged.
    expect(getByText('In stock: 55 each')).toBeTruthy();
    expect(getByText('on hand 55 each · par 10 each')).toBeTruthy();
  });

  it('localizes the label (es)', async () => {
    useStaffStore.setState({ locale: 'es' });
    const v = vendor({
      vendorId: 'v-1',
      vendorName: 'Acme',
      items: [item({ itemId: 'i-nn', itemName: 'Napkins', onHand: 37, parLevel: 10, needsOrder: false, flags: ['no_need'] })],
    });
    mockFetchStaffReorder.mockResolvedValue(payloadOf([v]));
    mockFetchStaffOrderSchedule.mockResolvedValue(everyDaySchedule('v-1'));
    const { getByText, getByTestId } = renderScreen();
    await waitFor(() => expect(getByTestId('reorder-section-enough')).toBeTruthy());
    expect(getByText('En stock: No hace falta')).toBeTruthy();
  });
});
