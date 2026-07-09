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

// CI render-timing headroom. These are full-screen integration renders
// (renderScreen() + waitFor) that pass locally but sit close to jest's
// default 5s on slower CI runners — the first happy-path render flaked the
// suite once on a slow runner. Bump the per-test timeout file-wide so timing
// variance can't red a logically-green suite. (Not a perf regression: spec
// 102's per-card "also from N" hint renders null for these single-vendor
// fixtures, so it adds no work here.)
jest.setTimeout(20000);

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
import { ReorderDatePicker } from '../components/ReorderDatePicker';
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
    // Spec 100 — locale is global store state; reset to English between tests
    // so a localization test doesn't leak its locale into later cases.
    locale: 'en',
  });
});

describe('Reorder — happy path (by-the-case display + KPIs)', () => {
  it('renders the per-vendor card with the spec-088 cases·units Suggested string', async () => {
    mockFetchStaffReorder.mockResolvedValue(payloadOf([caseVendor]));
    mockFetchStaffOrderSchedule.mockResolvedValue(everyDaySchedule('v-1'));

    const { getByText, queryAllByText, getByTestId } = renderScreen();
    await waitFor(() => expect(getByTestId('staff-reorder-vendor-v-1')).toBeTruthy());
    expect(getByText('Acme')).toBeTruthy();
    // Composed from the screen-local suggestedMainLabel + suggestedSubLabel
    // helpers (spec 100); in EN the output matches the admin formatSuggested
    // string byte-for-byte.
    expect(getByText('Order: 3 cases · 72 each')).toBeTruthy();
    // Owner decision (2026-07): staff see order quantities ONLY — no cost. The
    // server-rounded est cost ($144.00) that previously showed in the per-item
    // cost / KPI Est. total / vendor subtotal must not render anywhere.
    expect(queryAllByText('$144.00')).toHaveLength(0);
    expect(queryAllByText(/\$/)).toHaveLength(0);
  });

  it('splits items into "Needs to Order" and "Have enough stock" sections', async () => {
    const mixed = vendor({
      vendorId: 'v-1',
      vendorName: 'Acme',
      items: [
        item({
          itemId: 'i-need',
          itemName: 'Buns',
          parLevel: 49,
          suggestedQty: 49,
          caseQty: 24,
          suggestedCases: 3,
          suggestedUnits: 72,
          needsOrder: true,
        }),
        item({
          itemId: 'i-ok',
          itemName: 'Napkins',
          unit: 'each',
          onHand: 20,
          caseQty: 4,
          parLevel: 10,
          suggestedQty: 0,
          suggestedUnits: 0,
          needsOrder: false,
        }),
      ],
    });
    mockFetchStaffReorder.mockResolvedValue(payloadOf([mixed]));
    mockFetchStaffOrderSchedule.mockResolvedValue(everyDaySchedule('v-1'));

    const { getByText, getByTestId } = renderScreen();
    await waitFor(() => expect(getByTestId('reorder-section-needs')).toBeTruthy());
    // Both sections render; needs-order item shows its order line, enough-stock
    // item shows the "Enough stock" label instead.
    expect(getByTestId('reorder-section-enough')).toBeTruthy();
    expect(getByText('Order: 3 cases · 72 each')).toBeTruthy();
    // Enough-stock item shows the case-aware on-hand: 20 each / case of 4 = 5.
    expect(getByText('In stock: 5 cases')).toBeTruthy();
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

// Spec 100 — the staff reorder screen's localization completion: item names
// via getLocalizedName (adapter shaping itemName→name), the case noun via the
// new `reorder.unit.case`/`.cases` keys, display-only unit casing
// normalization, and the EOD badge via `reorder.source.eod`. The shared
// reorderExport.ts util stays English + untouched (verified separately in
// reorderExport.test.ts).
describe('Reorder — localization (spec 100)', () => {
  // A case item whose unit is UPPERCASE ("CASE") so the casing-normalization
  // (CASE→case) is observable, with es + zh-CN name overrides for item-name
  // localization. 2 cases (plural branch) of 24 → 48 each.
  const localizedVendor = vendor({
    vendorId: 'v-1',
    vendorName: 'Tai Trading',
    vendorTotalCost: 96,
    items: [
      item({
        itemId: 'i-1',
        itemName: 'Shrimp - Head Off',
        unit: 'CASE',
        parLevel: 48,
        suggestedQty: 48,
        costPerUnit: 2,
        estimatedCost: 96,
        caseQty: 24,
        suggestedCases: 2,
        suggestedUnits: 48,
        i18nNames: { es: 'Camarón sin cabeza', 'zh-CN': '虾仁去头' },
      }),
    ],
  });

  it('renders the item name in zh-CN when an override is present', async () => {
    useStaffStore.setState({ locale: 'zh-CN' });
    mockFetchStaffReorder.mockResolvedValue(payloadOf([localizedVendor]));
    mockFetchStaffOrderSchedule.mockResolvedValue(everyDaySchedule('v-1'));

    const { getByText, queryByText, getByTestId } = renderScreen();
    await waitFor(() => expect(getByTestId('staff-reorder-vendor-v-1')).toBeTruthy());
    expect(getByText('虾仁去头')).toBeTruthy();
    // The English canonical is NOT rendered when the override resolves.
    expect(queryByText('Shrimp - Head Off')).toBeNull();
  });

  it('falls back to English silently when the override is missing for the locale', async () => {
    useStaffStore.setState({ locale: 'es' });
    const noEs = vendor({
      vendorId: 'v-1',
      vendorName: 'Tai Trading',
      vendorTotalCost: 96,
      items: [
        item({
          itemId: 'i-1',
          itemName: '4LB Brown Paper Bag',
          unit: 'CASE',
          suggestedQty: 1,
          suggestedUnits: 1,
          estimatedCost: 1,
          i18nNames: { 'zh-CN': '只此一项' }, // no `es` override
        }),
      ],
    });
    mockFetchStaffReorder.mockResolvedValue(payloadOf([noEs]));
    mockFetchStaffOrderSchedule.mockResolvedValue(everyDaySchedule('v-1'));

    const { getByText, getByTestId } = renderScreen();
    await waitFor(() => expect(getByTestId('staff-reorder-vendor-v-1')).toBeTruthy());
    expect(getByText('4LB Brown Paper Bag')).toBeTruthy();
  });

  it('localizes the plural case noun in es and normalizes the unit casing', async () => {
    useStaffStore.setState({ locale: 'es' });
    mockFetchStaffReorder.mockResolvedValue(payloadOf([localizedVendor]));
    mockFetchStaffOrderSchedule.mockResolvedValue(everyDaySchedule('v-1'));

    const { getByText, getByTestId } = renderScreen();
    await waitFor(() => expect(getByTestId('staff-reorder-vendor-v-1')).toBeTruthy());
    // Spanish plural case noun ("2 cajas") + the sub-unit total with the raw
    // "CASE" token display-normalized to lowercase "case".
    expect(getByText('Pedir: 2 cajas · 48 case')).toBeTruthy();
  });

  it('uses the singular case key when exactly one case is suggested', async () => {
    useStaffStore.setState({ locale: 'es' });
    const oneCase = vendor({
      vendorId: 'v-1',
      vendorName: 'Tai Trading',
      items: [
        item({
          itemId: 'i-1',
          itemName: 'Buns',
          unit: 'CASE',
          suggestedQty: 24,
          suggestedUnits: 24,
          estimatedCost: 10,
          caseQty: 24,
          suggestedCases: 1,
        }),
      ],
    });
    mockFetchStaffReorder.mockResolvedValue(payloadOf([oneCase]));
    mockFetchStaffOrderSchedule.mockResolvedValue(everyDaySchedule('v-1'));

    const { getByText, getByTestId } = renderScreen();
    await waitFor(() => expect(getByTestId('staff-reorder-vendor-v-1')).toBeTruthy());
    // Singular "1 caja" (not "1 cajas") + normalized sub-unit.
    expect(getByText('Pedir: 1 caja · 24 case')).toBeTruthy();
  });

  it('normalizes the raw unit token on the on-hand/par breakdown line', async () => {
    const lbVendor = vendor({
      vendorId: 'v-1',
      vendorName: 'Tai Trading',
      items: [
        item({
          itemId: 'i-1',
          itemName: 'Flour',
          unit: 'LB', // raw uppercase, non-case → casing-normalized on render
          onHand: 0.5,
          parLevel: 12,
          suggestedQty: 11.5,
          suggestedUnits: 11.5,
          estimatedCost: 10,
        }),
      ],
    });
    mockFetchStaffReorder.mockResolvedValue(payloadOf([lbVendor]));
    mockFetchStaffOrderSchedule.mockResolvedValue(everyDaySchedule('v-1'));

    const { getByText, getByTestId } = renderScreen();
    await waitFor(() => expect(getByTestId('staff-reorder-vendor-v-1')).toBeTruthy());
    // "LB" → "lb" on both the breakdown and the non-case order line.
    expect(getByText('on hand 0.5 lb · par 12 lb')).toBeTruthy();
    expect(getByText('Order: 11.5 lb')).toBeTruthy();
  });

  it('routes the EOD badge through the catalog (reorder.source.eod)', async () => {
    // The badge value is the literal "EOD" in every locale, but it must now
    // come from the catalog key (not the old hardcoded string). Asserting it
    // renders under zh-CN confirms the keyed path resolves.
    useStaffStore.setState({ locale: 'zh-CN' });
    mockFetchStaffReorder.mockResolvedValue(payloadOf([localizedVendor]));
    mockFetchStaffOrderSchedule.mockResolvedValue(everyDaySchedule('v-1'));

    const { getByText, getByTestId } = renderScreen();
    await waitFor(() => expect(getByTestId('staff-reorder-vendor-v-1')).toBeTruthy());
    expect(getByText('EOD')).toBeTruthy();
  });

  it('shows STOCK FALLBACK (localized) when the source is stock, not EOD', async () => {
    useStaffStore.setState({ locale: 'zh-CN' });
    const stockVendor = vendor({
      vendorId: 'v-1',
      vendorName: 'Amazon',
      onHandSource: 'stock',
      items: [item({ itemId: 'i-1', itemName: 'Salt', suggestedQty: 1, suggestedUnits: 1, estimatedCost: 1 })],
    });
    mockFetchStaffReorder.mockResolvedValue(payloadOf([stockVendor]));
    mockFetchStaffOrderSchedule.mockResolvedValue(everyDaySchedule('v-1'));

    const { getByText, queryByText, getByTestId } = renderScreen();
    await waitFor(() => expect(getByTestId('staff-reorder-vendor-v-1')).toBeTruthy());
    expect(getByText('库存回退')).toBeTruthy();
    expect(queryByText('EOD')).toBeNull();
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

    const { getByTestId, queryByTestId } = renderScreen();
    await waitFor(() => expect(getByTestId('staff-reorder-no-schedule-toggle')).toBeTruthy());
    // Collapsed by default — the unscheduled vendor CARD is not shown yet.
    // (Its name does appear as a filter chip, so assert on the card testID,
    // not the text.)
    expect(queryByTestId('staff-reorder-vendor-v-2')).toBeNull();
    // Expand it.
    await act(async () => {
      fireEvent.press(getByTestId('staff-reorder-no-schedule-toggle'));
    });
    expect(getByTestId('staff-reorder-vendor-v-2')).toBeTruthy();
  });

  it('renders schedule_unknown warnings localized from code + vendor', async () => {
    // fetchReorder parses the vendor name out of the server message; the
    // screen rebuilds the warning from the stable `code` + `vendor` so it's
    // localized (here: the English catalog under jest's light/en default).
    mockFetchStaffReorder.mockResolvedValue(
      payloadOf(
        [caseVendor],
        [
          {
            code: 'schedule_unknown',
            message: 'Vendor "Beta" has no order schedule — using 7-day buffer.',
            vendor: 'Beta',
          },
        ],
      ),
    );
    mockFetchStaffOrderSchedule.mockResolvedValue(everyDaySchedule('v-1'));

    const { getByTestId, getByText } = renderScreen();
    await waitFor(() => expect(getByTestId('staff-reorder-warnings')).toBeTruthy());
    expect(
      getByText('Vendor "Beta" has no order schedule — using 7-day buffer.'),
    ).toBeTruthy();
  });

  it('falls back to the raw message for non-schedule_unknown warnings', async () => {
    mockFetchStaffReorder.mockResolvedValue(
      payloadOf([caseVendor], [{ code: 'some_other', message: 'A different warning' }]),
    );
    mockFetchStaffOrderSchedule.mockResolvedValue(everyDaySchedule('v-1'));

    const { getByTestId, getByText } = renderScreen();
    await waitFor(() => expect(getByTestId('staff-reorder-warnings')).toBeTruthy());
    expect(getByText('A different warning')).toBeTruthy();
  });
});

describe('Reorder — vendor filter chips', () => {
  // Two order-today vendors so the chip row renders (gated on >1 vendor).
  const acme = caseVendor; // v-1, Acme, 1 item, $144
  const beta = vendor({
    vendorId: 'v-2',
    vendorName: 'Beta',
    vendorTotalCost: 5,
    items: [item({ itemId: 'i-2', itemName: 'Salt', suggestedQty: 5, suggestedUnits: 5, estimatedCost: 5 })],
  });

  function bothSchedule(): OrderSchedule {
    const entry = [
      { vendorId: 'v-1', vendorName: 'Acme', deliveryDay: 'Wednesday' },
      { vendorId: 'v-2', vendorName: 'Beta', deliveryDay: 'Wednesday' },
    ];
    return {
      Sunday: entry, Monday: entry, Tuesday: entry, Wednesday: entry,
      Thursday: entry, Friday: entry, Saturday: entry,
    };
  }

  it('renders an All chip + one chip per vendor when >1 vendor', async () => {
    mockFetchStaffReorder.mockResolvedValue(payloadOf([acme, beta]));
    mockFetchStaffOrderSchedule.mockResolvedValue(bothSchedule());

    const { getByTestId } = renderScreen();
    await waitFor(() => expect(getByTestId('staff-reorder-vendor-filter')).toBeTruthy());
    expect(getByTestId('staff-reorder-vendor-chip-all')).toBeTruthy();
    expect(getByTestId('staff-reorder-vendor-chip-v-1')).toBeTruthy();
    expect(getByTestId('staff-reorder-vendor-chip-v-2')).toBeTruthy();
    // Both vendor cards visible under the default "All".
    expect(getByTestId('staff-reorder-vendor-v-1')).toBeTruthy();
    expect(getByTestId('staff-reorder-vendor-v-2')).toBeTruthy();
  });

  it('selecting a vendor chip narrows the visible cards to that vendor', async () => {
    mockFetchStaffReorder.mockResolvedValue(payloadOf([acme, beta]));
    mockFetchStaffOrderSchedule.mockResolvedValue(bothSchedule());

    const { getByTestId, queryByTestId } = renderScreen();
    await waitFor(() => expect(getByTestId('staff-reorder-vendor-chip-v-2')).toBeTruthy());
    await act(async () => {
      fireEvent.press(getByTestId('staff-reorder-vendor-chip-v-2'));
    });
    expect(getByTestId('staff-reorder-vendor-v-2')).toBeTruthy();
    expect(queryByTestId('staff-reorder-vendor-v-1')).toBeNull();
  });

  it('export payload narrows to the selected vendor (filter everything)', async () => {
    mockFetchStaffReorder.mockResolvedValue(payloadOf([acme, beta]));
    mockFetchStaffOrderSchedule.mockResolvedValue(bothSchedule());

    const { getByTestId } = renderScreen();
    await waitFor(() => expect(getByTestId('staff-reorder-vendor-chip-v-2')).toBeTruthy());
    await act(async () => {
      fireEvent.press(getByTestId('staff-reorder-vendor-chip-v-2'));
    });
    await act(async () => {
      fireEvent.press(getByTestId('staff-reorder-export-csv'));
    });
    const [passedPayload] = mockShareReorderCsv.mock.calls[0];
    expect(passedPayload.vendors).toHaveLength(1);
    expect(passedPayload.vendors[0].vendorId).toBe('v-2');
    // KPIs recomputed for the single selected vendor (Beta: 1 item, $5).
    expect(passedPayload.kpis.itemCount).toBe(1);
    expect(passedPayload.kpis.totalEstimatedCost).toBe(5);
  });

  it('no chip row when there is only a single vendor', async () => {
    mockFetchStaffReorder.mockResolvedValue(payloadOf([acme]));
    mockFetchStaffOrderSchedule.mockResolvedValue(everyDaySchedule('v-1'));

    const { getByTestId, queryByTestId } = renderScreen();
    await waitFor(() => expect(getByTestId('staff-reorder-vendor-v-1')).toBeTruthy());
    expect(queryByTestId('staff-reorder-vendor-filter')).toBeNull();
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

// Spec 091 B3 — the activeStore===null gate. The tab bar only mounts with an
// active store, so this is defense-in-depth: with no active store the screen
// must render the centered ActivityIndicator and fire NO fetch.
describe('Reorder — no active store (spec 091 B3)', () => {
  it('renders the select-store defensive state and does NOT fetch when activeStore is null', () => {
    useStaffStore.setState({
      authState: {
        kind: 'signed-in',
        userId: 'user-1',
        stores: [{ storeId: 'store-1', storeName: 'Towson' }],
      },
      activeStore: null,
      eodQueue: [],
      draining: false,
    });

    const { UNSAFE_getByType, queryByTestId } = renderScreen();
    // The defensive branch renders an ActivityIndicator (no header, no list).
    const { ActivityIndicator } = require('react-native');
    expect(UNSAFE_getByType(ActivityIndicator)).toBeTruthy();
    // The store-scoped header / list never mount.
    expect(queryByTestId('staff-reorder-root')).toBeNull();
    expect(queryByTestId('staff-reorder-store-name')).toBeNull();
    // The fetch effect early-returns on a null store.
    expect(mockFetchStaffReorder).not.toHaveBeenCalled();
    expect(mockFetchStaffOrderSchedule).not.toHaveBeenCalled();
  });
});

// Spec 091 B4 — the screen-layer re-fetch when the date picker changes
// `selectedDate`. The fetch-layer `as_of_date` plumbing is pinned in
// fetchReorder.test.ts; this complements it by exercising the
// useEffect([activeStore?.id, selectedDate, load]) path at the screen.
describe('Reorder — date-change re-fetch (spec 091 B4)', () => {
  it('re-fetches with the new as_of_date when the date picker selects a past day', async () => {
    mockFetchStaffReorder.mockResolvedValue(payloadOf([caseVendor]));
    mockFetchStaffOrderSchedule.mockResolvedValue(everyDaySchedule('v-1'));

    const { getByTestId } = renderScreen();
    // Initial mount fetches as-of today.
    await waitFor(() => expect(mockFetchStaffReorder).toHaveBeenCalledTimes(1));
    const [firstStoreId, firstAsOf] = mockFetchStaffReorder.mock.calls[0];
    expect(firstStoreId).toBe('store-1');

    // Open the picker, page back one month, and pick day 1 (a guaranteed past
    // date < today). Day-1-of-the-previous-month is always strictly before
    // today, so its cell is never `> maxDate` → never future-disabled → always
    // pressable, which is why it's a safe fixture for "a past date".
    // selectDay → onChange(dateStr) → setSelectedDate → the effect re-fires the
    // fetch with the new date.
    await act(async () => {
      fireEvent.press(getByTestId('staff-reorder-datepicker-trigger'));
    });
    await act(async () => {
      fireEvent.press(getByTestId('staff-reorder-datepicker-prev-month'));
    });
    await act(async () => {
      fireEvent.press(getByTestId('staff-reorder-datepicker-day-1'));
    });

    await waitFor(() => expect(mockFetchStaffReorder).toHaveBeenCalledTimes(2));
    const [secondStoreId, secondAsOf] = mockFetchStaffReorder.mock.calls[1];
    expect(secondStoreId).toBe('store-1');
    // The new as-of is a valid YYYY-MM-DD, distinct from today, and earlier
    // (we paged to the previous month, day 1).
    expect(secondAsOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(secondAsOf).not.toBe(firstAsOf);
    expect(secondAsOf < firstAsOf).toBe(true);
  });
});

// Spec 091 B5 — the initial-load testID. With the fetch held pending,
// `loading && !payload` is true and the centered loading view renders.
describe('Reorder — loading state testID (spec 091 B5)', () => {
  it('shows staff-reorder-loading while the initial fetch is pending', () => {
    // Never-resolving fetch → Promise.all stays pending → loading stays true
    // with payload null → the initial-load branch renders.
    mockFetchStaffReorder.mockReturnValue(new Promise<never>(() => {}));
    mockFetchStaffOrderSchedule.mockReturnValue(new Promise<never>(() => {}));

    const { getByTestId } = renderScreen();
    expect(getByTestId('staff-reorder-loading')).toBeTruthy();
  });
});

// Spec 091 A2 — `maxDate` is computed PER RENDER (not a mount-only useMemo), so
// the date picker's upper bound follows the wall clock past midnight instead of
// freezing at the mount day. The old `useMemo(() => todayIso(), [])` would fail
// the post-rerender assertion (it'd stay frozen at the mount day).
describe('Reorder — maxDate recomputes per render (spec 091 A2)', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it("the date picker's maxDate follows the current day across a re-render", async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-06-02T12:00:00Z')); // midday UTC → local day = Jun 2
    mockFetchStaffReorder.mockResolvedValue(payloadOf([caseVendor]));
    mockFetchStaffOrderSchedule.mockResolvedValue(everyDaySchedule('v-1'));

    const screen = render(
      <SafeAreaProvider>
        <Reorder />
      </SafeAreaProvider>,
    );
    await act(async () => {}); // flush the mount fetch microtasks
    expect(screen.UNSAFE_getByType(ReorderDatePicker).props.maxDate).toBe('2026-06-02');

    // Advance past midnight + re-render: a per-render maxDate updates to Jun 3;
    // a mount-memoized one would stay Jun 2 (the regression this pins).
    jest.setSystemTime(new Date('2026-06-03T12:00:00Z'));
    screen.rerender(
      <SafeAreaProvider>
        <Reorder />
      </SafeAreaProvider>,
    );
    await act(async () => {});
    expect(screen.UNSAFE_getByType(ReorderDatePicker).props.maxDate).toBe('2026-06-03');
  });
});
