// src/screens/staff/screens/Reorder.primaryWins.spec201.test.tsx — Spec 201 (AC-23).
//
// On a coincident day the server keeps a shared item ONLY on its primary
// vendor's card and names the yielding vendors in `yieldedFromVendors`. The
// staff Reorder screen renders that as ONE text line —
// `t('reorder.item.yieldedFrom', { vendors })`, testID
// `reorder-yielded-from-${itemId}` — INSTEAD of the spec-102 "also available
// from … — order from one" line, and offers NO switch control (OQ-3b: admin
// only). Every other shared row keeps the old line exactly.
//
// Boundary mocking mirrors Reorder.test.tsx (fetch + share libs mocked).

jest.setTimeout(20000);

jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ navigate: jest.fn() }),
}));

const mockFetchStaffReorder = jest.fn();
const mockFetchStaffOrderSchedule = jest.fn();
jest.mock('../lib/fetchReorder', () => ({
  fetchStaffReorder: (...a: unknown[]) => mockFetchStaffReorder(...a),
  fetchStaffOrderSchedule: (...a: unknown[]) => mockFetchStaffOrderSchedule(...a),
}));

jest.mock('../lib/shareReorder', () => ({
  shareReorderCsv: jest.fn().mockResolvedValue(undefined),
  shareReorderText: jest.fn().mockResolvedValue(undefined),
  shareReorderPdf: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../../lib/supabase', () => ({
  supabase: {},
}));

import { render, waitFor } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { Reorder } from './Reorder';
import { useStaffStore } from '../store/useStaffStore';
import en from '../i18n/en.json';
import es from '../i18n/es.json';
import zhCN from '../i18n/zh-CN.json';
import type { OrderSchedule, ReorderItem, ReorderPayload, ReorderVendor } from '../../../types';

function item(over: Partial<ReorderItem> & { itemId: string; itemName: string }): ReorderItem {
  return {
    unit: 'each',
    onHand: 0,
    pendingPoQty: 0,
    parLevel: 10,
    usageForecasted: 0,
    parReplacement: 10,
    suggestedQty: 10,
    costPerUnit: 1,
    estimatedCost: 10,
    caseQty: 1,
    suggestedCases: null,
    suggestedUnits: 10,
    flags: [],
    needsOrder: true,
    ...over,
  };
}

const BRAVO = { vendorId: 'v-b', vendorName: 'Bravo Supply' };
const CHARLIE = { vendorId: 'v-c', vendorName: 'Charlie Co' };

const alpha: ReorderVendor = {
  vendorId: 'v-a',
  vendorName: 'Alpha Foods',
  scheduleKnown: true,
  nextDeliveryDate: '2026-06-03',
  daysUntilNextDelivery: 1,
  onHandSource: 'eod',
  eodSubmittedAt: '2026-06-02T00:00:00Z',
  vendorTotalCost: 20,
  items: [
    // F — coincident, primary A, yielded from B.
    item({
      itemId: 'i-f',
      itemName: 'Fryer Oil',
      otherVendorCount: 1,
      alsoFromVendors: [BRAVO],
      yieldedFromVendors: [BRAVO],
    }),
    // H — shared, not in the rule: keeps the old line.
    item({
      itemId: 'i-h',
      itemName: 'Hot Sauce',
      otherVendorCount: 1,
      alsoFromVendors: [CHARLIE],
      yieldedFromVendors: [],
    }),
  ],
};

function payloadOf(vendors: ReorderVendor[]): ReorderPayload {
  return {
    asOfDate: '2026-06-02',
    vendors,
    kpis: { vendorCount: vendors.length, itemCount: 2, totalEstimatedCost: 20, eodSourcedVendorCount: 1, stockFallbackVendorCount: 0 },
    warnings: [],
  };
}

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

function setLocale(locale: 'en' | 'es' | 'zh-CN') {
  useStaffStore.setState({
    authState: {
      kind: 'signed-in',
      userId: 'user-1',
      stores: [{ storeId: 'store-1', storeName: 'Towson' }],
    },
    activeStore: { id: 'store-1', name: 'Towson' },
    eodQueue: [],
    draining: false,
    locale,
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  setLocale('en');
  mockFetchStaffReorder.mockResolvedValue(payloadOf([alpha]));
  mockFetchStaffOrderSchedule.mockResolvedValue(everyDaySchedule('v-a'));
});

describe('staff Reorder — spec 201 primary wins (AC-23)', () => {
  it('renders the "also from" line on the primary row, with NO switch, instead of the old line', async () => {
    const { getByTestId, queryByTestId, queryAllByTestId } = renderScreen();
    await waitFor(() => expect(getByTestId('reorder-yielded-from-i-f')).toBeTruthy());

    expect(getByTestId('reorder-yielded-from-i-f')).toHaveTextContent(
      'also from Bravo Supply — order it here',
    );
    expect(queryByTestId('reorder-also-from-i-f')).toBeNull();
    // No switch control anywhere on the staff screen (OQ-3b).
    expect(queryAllByTestId(/^reorder-switch-primary-/)).toHaveLength(0);

    // A shared row outside the rule keeps the old line exactly.
    expect(getByTestId('reorder-also-from-i-h')).toHaveTextContent(
      'also available from Charlie Co — order from one',
    );
    expect(queryByTestId('reorder-yielded-from-i-h')).toBeNull();
  });

  it.each([
    ['es', 'también de Bravo Supply — pídalo aquí'],
    ['zh-CN', '也可从 Bravo Supply 订购 — 请在此订购'],
  ] as const)('localizes the line (%s)', async (locale, expected) => {
    setLocale(locale);
    const { getByTestId } = renderScreen();
    await waitFor(() => expect(getByTestId('reorder-yielded-from-i-f')).toBeTruthy());
    expect(getByTestId('reorder-yielded-from-i-f')).toHaveTextContent(expected);
  });

  it('the new key exists in en / es / zh-CN with identical {tokens}', () => {
    const tokens = (s: string) => (s.match(/\{[a-zA-Z]+\}/g) || []).sort();
    const values = [en, es, zhCN].map((cat) => cat.reorder.item.yieldedFrom);
    values.forEach((v) => expect(typeof v).toBe('string'));
    expect(tokens(values[0])).toEqual(['{vendors}']);
    expect(tokens(values[1])).toEqual(tokens(values[0]));
    expect(tokens(values[2])).toEqual(tokens(values[0]));
  });
});
