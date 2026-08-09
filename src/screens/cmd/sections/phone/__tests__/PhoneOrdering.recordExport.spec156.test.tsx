// src/screens/cmd/sections/phone/__tests__/PhoneOrdering.recordExport.spec156.test.tsx
// Spec 156 (AC-8 sites 4-6, AC-9, AC-10).
//
// Pins the PHONE overflow-sheet export → draft-order recording wiring:
//   • quick-order share ok / dismissed → 1 record / 0 records
//   • CSV (generic + US FOODS import branch) ok / failed → 1 record / 0 records
//   • PDF ok / failed → 1 record / 0 records
//   • AC-9 native pin: with Platform.OS = 'ios', CSV and PDF toast
//     `common.availableOnDesktop` and record ZERO times.
//   • AC-10: `record` fires before `clear`.
//
// Mirrors PhoneOrdering.test.tsx's mocking (REAL store slices via
// useStore.setState, stubbed supabase/db, forced phone breakpoint), with the
// export I/O boundary stubbed the way the desktop spec-138/156 suites do
// (web Platform, stubbed CSV builder, stubbed jspdf, stubbed sharePo) and
// `recordExportedOrder` / `clearReorderEditsForVendor` replaced by jest.fn on
// the real store so the call sites are the only thing under test.

import React from 'react';
import { render, fireEvent, waitFor } from '@testing-library/react-native';

// Web by default; the AC-9 native pin flips `mockPlatform.OS` at runtime (the
// default export IS the object `react-native`'s Platform getter hands the
// component, so mutating it is what the non-web early return sees).
jest.mock('react-native/Libraries/Utilities/Platform', () => ({
  __esModule: true,
  default: { OS: 'web', select: (obj: any) => obj.web ?? obj.default },
  OS: 'web',
}));

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, left: 0, right: 0, bottom: 0 }),
}));

jest.mock('react-native-toast-message', () => ({
  __esModule: true,
  default: { show: jest.fn(), hide: jest.fn() },
}));

jest.mock('../../../../../lib/supabase', () => ({
  __esModule: true,
  supabase: {
    auth: {
      getSession: jest.fn(() => Promise.resolve({ data: { session: null }, error: null })),
      onAuthStateChange: jest.fn(() => ({ data: { subscription: { unsubscribe: jest.fn() } } })),
    },
    from: jest.fn(() => ({ select: jest.fn().mockReturnThis(), eq: jest.fn().mockReturnThis(), order: jest.fn().mockReturnThis(), single: jest.fn(() => Promise.resolve({ data: null, error: null })), maybeSingle: jest.fn(() => Promise.resolve({ data: null, error: null })) })),
    rpc: jest.fn(() => Promise.resolve({ data: null, error: null })),
    channel: jest.fn(() => ({ on: jest.fn().mockReturnThis(), subscribe: jest.fn(() => ({ unsubscribe: jest.fn() })) })),
    removeChannel: jest.fn(),
    functions: { invoke: jest.fn() },
  },
}));

jest.mock('../../../../../lib/db', () =>
  new Proxy({ __esModule: true }, { get: (t: Record<string, unknown>, p: string) => (p in t ? (t as any)[p] : jest.fn(() => Promise.resolve(null))) }),
);

jest.mock('../../../../../theme/breakpoints', () => {
  const actual = jest.requireActual('../../../../../theme/breakpoints');
  return { ...actual, useIsPhone: () => true, useIsTablet: () => false, useIsDesktop: () => false, useIsCompact: () => true, useBreakpoint: () => 'phone' };
});

// Keep the pure reorderExport helpers real; stub the CSV builder so a CSV press
// is assertable (and can be forced to throw) without the DOM download path.
jest.mock('../../../../../utils/reorderExport', () => {
  const actual = jest.requireActual('../../../../../utils/reorderExport');
  return { ...actual, buildReorderCsv: jest.fn(() => 'csv,data') };
});

jest.mock('jspdf', () => ({
  __esModule: true,
  default: class {
    internal = { pageSize: { getHeight: () => 800 } };
    lastAutoTable = { finalY: 120 };
    setFont() { return this; }
    setFontSize() { return this; }
    setTextColor() { return this; }
    text() { return this; }
    getTextWidth() { return 10; }
    addPage() { return this; }
    save() { return this; }
  },
}));
jest.mock('jspdf-autotable', () => ({ __esModule: true, default: () => {} }));

jest.mock('../../../lib/sharePo', () => ({
  sharePurchaseOrder: jest.fn(() => Promise.resolve({ shared: true, previewText: 'x' })),
}));

import RNPlatform from 'react-native/Libraries/Utilities/Platform';
import { PhoneOrdering } from '../PhoneOrdering';
import { useStore } from '../../../../../store/useStore';
import { usePaletteAction } from '../../../../../lib/paletteAction';
import { buildReorderCsv } from '../../../../../utils/reorderExport';
import { sharePurchaseOrder } from '../../../lib/sharePo';
import Toast from 'react-native-toast-message';

// The mocked Platform default export, typed as the mutable object it is here.
const mockPlatform = RNPlatform as unknown as { OS: string };

function todayIso(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function item(over: Record<string, any>): any {
  return {
    itemId: over.itemId, itemName: over.itemName ?? over.itemId, unit: over.unit ?? 'lbs',
    onHand: 0, pendingPoQty: 0, parLevel: 100, usageForecasted: 0, parReplacement: 0,
    suggestedQty: over.suggestedUnits ?? 20, costPerUnit: over.costPerUnit ?? 3,
    estimatedCost: over.estimatedCost ?? 60, caseQty: over.caseQty ?? 5,
    suggestedCases: over.suggestedCases ?? 4, suggestedUnits: over.suggestedUnits ?? 20,
    flags: [], ...over,
  };
}

function vendor(over: Record<string, any>): any {
  return {
    vendorId: over.vendorId, vendorName: over.vendorName, scheduleKnown: true,
    nextDeliveryDate: todayIso(), daysUntilNextDelivery: 1,
    onHandSource: over.onHandSource ?? 'eod', eodSubmittedAt: over.eodSubmittedAt ?? null,
    items: over.items ?? [], vendorTotalCost: over.vendorTotalCost ?? 0,
  };
}

function everyDay(vendorIds: string[]) {
  const entries = vendorIds.map((id) => ({ vendorId: id, vendorName: id, deliveryDay: 'Monday' }));
  return { Monday: entries, Tuesday: entries, Wednesday: entries, Thursday: entries, Friday: entries, Saturday: entries, Sunday: entries };
}

const counted = vendor({
  vendorId: 'v-a', vendorName: 'Counted Co', onHandSource: 'eod', eodSubmittedAt: `${todayIso()}T18:00:00Z`,
  items: [item({ itemId: 'a1', itemName: 'French Fries', caseQty: 5, suggestedUnits: 20, estimatedCost: 60, costPerUnit: 3 })],
  vendorTotalCost: 60,
});

const calls: string[] = [];
let recordMock: jest.Mock;
let clearMock: jest.Mock;

function seed(vendorsSlice?: any[]) {
  recordMock = jest.fn(() => {
    calls.push('record');
    return Promise.resolve('po-2');
  });
  clearMock = jest.fn(() => {
    calls.push('clear');
  });
  useStore.setState({
    currentStore: { id: 'store-1', brandId: 'b', name: 'F', address: '', status: 'active' } as any,
    orderSchedule: everyDay(['v-a']) as any,
    reorderPayload: {
      asOfDate: todayIso(),
      vendors: [counted],
      kpis: { vendorCount: 1, itemCount: 1, totalEstimatedCost: 60, eodSourcedVendorCount: 1, stockFallbackVendorCount: 0 },
      warnings: [],
    } as any,
    reorderLoading: false,
    reorderError: null,
    reorderEdits: { 'v-a': { a1: 25 } },
    vendors: (vendorsSlice ?? [{ id: 'v-a', extensionOrdering: true, orderUnit: 'case' }]) as any,
    inventory: [{ id: 'a1', subUnitSize: 1, vendors: [{ vendorId: 'v-a', orderCode: 'OC-1' }] } as any],
    // Spec 156 — the assertion surface at the three phone call sites.
    recordExportedOrder: recordMock as any,
    clearReorderEditsForVendor: clearMock as any,
  });
}

beforeAll(() => {
  (global as any).Blob = class {};
  const w = (global as any).window ?? ((global as any).window = {});
  w.URL = { createObjectURL: () => 'blob:x', revokeObjectURL: () => {} };
});

beforeEach(() => {
  jest.clearAllMocks();
  calls.length = 0;
  mockPlatform.OS = 'web';
  usePaletteAction.getState().consume();
  (buildReorderCsv as jest.Mock).mockImplementation(() => 'csv,data');
  (sharePurchaseOrder as jest.Mock).mockResolvedValue({ shared: true, previewText: 'x' });
  seed();
});

const settle = () => new Promise((r) => setTimeout(r, 0));

/** Open the ··· sheet for v-a and press one of its actions. */
function pressSheetAction(testID: string) {
  const view = render(<PhoneOrdering />);
  fireEvent.press(view.getByTestId('phone-order-more-v-a'));
  fireEvent.press(view.getByTestId(testID));
  return view;
}

// ── AC-8 site 4: quick-order share ──────────────────────────────────────────
describe('OverflowSheet.runQuickOrder (site 4)', () => {
  it('records ONCE for the vendor when shared === true, BEFORE the clear (AC-10)', async () => {
    pressSheetAction('phone-order-sheet-quick');
    await waitFor(() => expect(recordMock).toHaveBeenCalledTimes(1));
    expect(recordMock.mock.calls[0][0].vendorId).toBe('v-a');
    expect(calls).toEqual(['record', 'clear']);
  });

  it('records NOTHING when the share is dismissed (shared === false)', async () => {
    (sharePurchaseOrder as jest.Mock).mockResolvedValueOnce({ shared: false, previewText: null });
    pressSheetAction('phone-order-sheet-quick');
    await settle();
    expect(recordMock).not.toHaveBeenCalled();
    expect(clearMock).not.toHaveBeenCalled();
  });
});

// ── AC-8 site 5: CSV (both branches) ────────────────────────────────────────
describe('OverflowSheet.runCsv (site 5)', () => {
  it('generic branch: records ONCE on ok === true, before the clear', async () => {
    pressSheetAction('phone-order-sheet-csv');
    await waitFor(() => expect(recordMock).toHaveBeenCalledTimes(1));
    expect(buildReorderCsv).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(['record', 'clear']);
  });

  it('US FOODS import branch: records ONCE', async () => {
    seed([{
      id: 'v-a', name: 'US FOODS', extensionOrdering: false, orderUnit: 'case',
      orderImportFormat: 'us_foods', importCustomerNumber: '123456',
      importDistributorNumber: '99', importDepartment: '1',
    }]);
    pressSheetAction('phone-order-sheet-csv');
    await waitFor(() => expect(recordMock).toHaveBeenCalledTimes(1));
    expect(buildReorderCsv).not.toHaveBeenCalled();
  });

  it('records nothing when the CSV export fails', async () => {
    (buildReorderCsv as jest.Mock).mockImplementationOnce(() => {
      throw new Error('csv boom');
    });
    pressSheetAction('phone-order-sheet-csv');
    await settle();
    expect(recordMock).not.toHaveBeenCalled();
    expect(clearMock).not.toHaveBeenCalled();
  });
});

// ── AC-8 site 6: PDF ────────────────────────────────────────────────────────
describe('OverflowSheet.runPdf (site 6)', () => {
  it('records ONCE on ok === true, before the clear', async () => {
    pressSheetAction('phone-order-sheet-pdf');
    await waitFor(() => expect(recordMock).toHaveBeenCalledTimes(1));
    expect(calls).toEqual(['record', 'clear']);
  });

  it('records nothing when the PDF build fails', async () => {
    const jsPDF = require('jspdf').default;
    const spy = jest.spyOn(jsPDF.prototype, 'save').mockImplementationOnce(() => {
      throw new Error('pdf boom');
    });
    pressSheetAction('phone-order-sheet-pdf');
    await settle();
    expect(recordMock).not.toHaveBeenCalled();
    expect(clearMock).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

// ── Security review (2026-08-08) Mediums 1+2 — the export-start snapshot ────
describe('the (store, reorder date) snapshot is taken at EXPORT START', () => {
  it('passes the active store + as-of date alongside the vendor', async () => {
    pressSheetAction('phone-order-sheet-csv');
    await waitFor(() => expect(recordMock).toHaveBeenCalledTimes(1));
    expect(recordMock.mock.calls[0][1]).toEqual({
      storeId: 'store-1',
      referenceDate: todayIso(),
    });
  });

  it('a store switch DURING the share does not move the snapshot (Medium 1)', async () => {
    let release: (v: any) => void = () => {};
    (sharePurchaseOrder as jest.Mock).mockImplementationOnce(
      () => new Promise((r) => { release = r; }),
    );
    pressSheetAction('phone-order-sheet-quick');

    // The operator switches stores while the share sheet is open.
    useStore.setState({ currentStore: { id: 'store-2', name: 'Other' } as any });
    release({ shared: true, previewText: 'x' });

    await waitFor(() => expect(recordMock).toHaveBeenCalledTimes(1));
    expect(recordMock.mock.calls[0][1].storeId).toBe('store-1');
  });

  it('a realtime reload nulling reorderPayload mid-share does not move the date (Medium 2)', async () => {
    let release: (v: any) => void = () => {};
    (sharePurchaseOrder as jest.Mock).mockImplementationOnce(
      () => new Promise((r) => { release = r; }),
    );
    pressSheetAction('phone-order-sheet-quick');

    useStore.setState({ reorderPayload: null as any });
    release({ shared: true, previewText: 'x' });

    await waitFor(() => expect(recordMock).toHaveBeenCalledTimes(1));
    expect(recordMock.mock.calls[0][1].referenceDate).toBe(todayIso());
  });
});

// ── AC-9: the native early return records NOTHING ───────────────────────────
describe('AC-9 — native (Platform.OS !== "web") records zero times', () => {
  beforeEach(() => {
    mockPlatform.OS = 'ios';
  });

  it('CSV on native toasts availableOnDesktop and records nothing', async () => {
    pressSheetAction('phone-order-sheet-csv');
    await settle();
    expect(recordMock).not.toHaveBeenCalled();
    expect(clearMock).not.toHaveBeenCalled();
    expect(Toast.show).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'info', text1: 'Available on desktop' }),
    );
  });

  it('PDF on native toasts availableOnDesktop and records nothing', async () => {
    pressSheetAction('phone-order-sheet-pdf');
    await settle();
    expect(recordMock).not.toHaveBeenCalled();
    expect(clearMock).not.toHaveBeenCalled();
    expect(Toast.show).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'info', text1: 'Available on desktop' }),
    );
  });
});
