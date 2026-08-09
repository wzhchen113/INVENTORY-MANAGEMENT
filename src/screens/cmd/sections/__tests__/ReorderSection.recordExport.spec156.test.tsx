// src/screens/cmd/sections/__tests__/ReorderSection.recordExport.spec156.test.tsx
// Spec 156 (AC-8 sites 1-3, AC-9, AC-10, AC-11, AC-6 at the seam).
//
// Pins the DESKTOP export → draft-order recording wiring:
//   • quick-order share ok / dismissed  → 1 record / 0 records
//   • CSV (generic branch) ok / failed   → 1 record / 0 records
//   • CSV (US FOODS import branch)       → 1 record  ← the owner's motivating case
//   • CSV (SYSCO import branch)          → 1 record
//   • PDF ok / failed                    → 1 record / 0 records
//   • ORDER: `record` fires BEFORE `clear` (AC-10)
//   • the vendor handed to the recorder carries the EDITED base qty, and the
//     same edited base reached the export builder (AC-11)
//   • a rejecting recorder does not break the export or the clear (AC-6)
//
// Boundary mocking is cloned from ReorderSection.resetAfterExport.spec138
// (web Platform, stubbed CSV builder, stubbed jspdf + jspdf-autotable, stubbed
// sharePo, mocked useStore) plus a `recordExportedOrder` jest.fn on the mocked
// state object. The spec-138 suite itself stays UNEDITED (AC-REG-1).

jest.mock('react-native/Libraries/Utilities/Platform', () => ({
  __esModule: true,
  default: { OS: 'web', select: (obj: any) => obj.web ?? obj.default },
  OS: 'web',
}));

jest.mock('react-native-toast-message', () => ({
  __esModule: true,
  default: { show: jest.fn(), hide: jest.fn() },
}));

jest.mock('../../../../theme/breakpoints', () => {
  const actual = jest.requireActual('../../../../theme/breakpoints');
  return { ...actual, useIsPhone: () => false, useIsTablet: () => false, useIsDesktop: () => true, useIsCompact: () => false, useBreakpoint: () => 'desktop' };
});

jest.mock('../../../../theme/colors', () => ({
  useCmdColors: () => ({
    bg: '#FFFFFF', panel: '#F4F4F4', panel2: '#EAEAEA',
    border: '#CCCCCC', borderStrong: '#888888',
    fg: '#000000', fg2: '#444444', fg3: '#888888',
    accent: '#3F7C20', accentBg: '#E0EFC9', accentFg: '#FFFFFF',
    warn: '#854F0B', warnBg: '#FAEEDA',
    danger: '#791F1F', dangerBg: '#FCEBEB',
    ok: '#3B6D11', okBg: '#EAF3DE',
    info: '#185FA5', infoBg: '#E6F1FB',
    violet: '#5B3FA0', violetBg: '#EFE9FA',
  }),
  CmdRadius: { xs: 3, sm: 4, md: 5, lg: 6, pill: 999 },
}));

jest.mock('../../../../hooks/useT', () => ({
  useT: () => (key: string, vars?: Record<string, string | number>) => {
    if (!vars) return key;
    return Object.entries(vars).reduce(
      (acc, [k, v]) => acc.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v)),
      key,
    );
  },
}));

jest.mock('../../../../components/cmd/TabStrip', () => {
  const ReactMod = require('react');
  const RN = require('react-native');
  return {
    TabStrip: ({ rightSlot }: { rightSlot?: React.ReactNode }) =>
      ReactMod.createElement(RN.View, { testID: 'tabstrip' }, rightSlot),
  };
});
jest.mock('../../../../components/cmd/StatCard', () => ({ StatCard: () => null }));

// Keep the pure reorderExport helpers real; stub the CSV builder so a CSV press
// is assertable (and can be forced to throw) without the DOM download path.
jest.mock('../../../../utils/reorderExport', () => {
  const actual = jest.requireActual('../../../../utils/reorderExport');
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

jest.mock('../../lib/sharePo', () => ({
  sharePurchaseOrder: jest.fn(() => Promise.resolve({ shared: true, previewText: 'x' })),
}));

jest.mock('../../../../store/useStore', () => {
  const state: any = {
    currentStore: { id: 'store-1', name: 'Test Store' },
    orderSchedule: {
      Monday: [], Tuesday: [], Wednesday: [], Thursday: [], Friday: [], Saturday: [], Sunday: [],
    },
    reorderPayload: null,
    reorderLoading: false,
    reorderError: null,
    loadReorderSuggestions: jest.fn(),
    lastOrderContext: null,
    loadLastOrderContext: jest.fn(),
    inventory: [],
    vendors: [],
    reorderEdits: {},
    setReorderEditQty: jest.fn(),
    clearReorderEdits: jest.fn(),
    clearReorderEditsForVendor: jest.fn(),
    fillCartForVendor: jest.fn(() => Promise.resolve('po-1')),
    // Spec 156 — the assertion surface at the six call sites.
    recordExportedOrder: jest.fn(() => Promise.resolve('po-2')),
  };
  const fn: any = jest.fn((selector: (s: any) => any) => selector(state));
  fn.getState = () => state;
  fn.__state = state;
  return { useStore: fn };
});

import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react-native';
import { toISODate } from '../../../../utils/reportDates';
import { buildReorderCsv } from '../../../../utils/reorderExport';
import { sharePurchaseOrder } from '../../lib/sharePo';
import { ReorderItem, ReorderVendor } from '../../../../types';
import ReorderSection from '../ReorderSection';
import { useStore } from '../../../../store/useStore';

const mockState = (useStore as any).__state as Record<string, any>;

const expandAllVendorCards = () => {
  screen.getAllByTestId(/^reorder-vendor-toggle-/).forEach((t) => fireEvent.press(t));
};

const settle = () => new Promise((r) => setTimeout(r, 0));

function caseItem(over: {
  itemId?: string;
  itemName?: string;
  suggestedQty: number;
  caseQty: number;
  costPerUnit?: number;
}): ReorderItem {
  const cost = over.costPerUnit ?? 1;
  const cases = Math.ceil(over.suggestedQty / over.caseQty);
  const orderedUnits = cases * over.caseQty;
  return {
    itemId: over.itemId ?? 'i-case',
    itemName: over.itemName ?? 'Case Item',
    unit: 'each',
    onHand: 0,
    pendingPoQty: 0,
    parLevel: over.suggestedQty,
    usageForecasted: 0,
    parReplacement: over.suggestedQty,
    suggestedQty: over.suggestedQty,
    costPerUnit: cost,
    estimatedCost: orderedUnits * cost,
    caseQty: over.caseQty,
    suggestedCases: cases,
    suggestedUnits: orderedUnits,
    flags: [],
  };
}

function vendor(over: { vendorId: string; items: ReorderItem[] }): ReorderVendor {
  return {
    vendorId: over.vendorId,
    vendorName: over.vendorId,
    scheduleKnown: true,
    nextDeliveryDate: '2026-06-02',
    daysUntilNextDelivery: 1,
    onHandSource: 'eod',
    eodSubmittedAt: '2026-06-02T00:00:00Z',
    items: over.items,
    vendorTotalCost: over.items.reduce((a, i) => a + i.estimatedCost, 0),
  };
}

function everyDaySchedule(vendorId: string) {
  const entries = [{ vendorId, vendorName: vendorId, deliveryDay: 'Wednesday' }];
  return {
    Monday: entries, Tuesday: entries, Wednesday: entries, Thursday: entries,
    Friday: entries, Saturday: entries, Sunday: entries,
  };
}

/** A single-vendor payload holding an inline edit (base 120) for that vendor. */
function seedOneVendorPayload(vendorId = 'v-1') {
  mockState.inventory = [{ id: 'i-case', subUnitSize: 4, vendors: [{ vendorId, orderCode: 'OC-1' }] }];
  mockState.reorderEdits = { [vendorId]: { 'i-case': 120 } };
  mockState.orderSchedule = everyDaySchedule(vendorId);
  mockState.reorderPayload = {
    asOfDate: toISODate(new Date()),
    vendors: [vendor({ vendorId, items: [caseItem({ suggestedQty: 49, caseQty: 24, costPerUnit: 2, itemId: 'i-case' })] })],
    kpis: { vendorCount: 1, itemCount: 1, totalEstimatedCost: 144, eodSourcedVendorCount: 1, stockFallbackVendorCount: 0 },
    warnings: [],
  };
}

beforeAll(() => {
  (global as any).Blob = class {};
  const w = (global as any).window ?? ((global as any).window = {});
  w.URL = { createObjectURL: () => 'blob:x', revokeObjectURL: () => {} };
});

beforeEach(() => {
  jest.clearAllMocks();
  mockState.currentStore = { id: 'store-1', name: 'Test Store' };
  mockState.reorderLoading = false;
  mockState.reorderError = null;
  mockState.loadReorderSuggestions = jest.fn();
  mockState.vendors = [];
  mockState.setReorderEditQty = jest.fn();
  mockState.clearReorderEdits = jest.fn();
  mockState.clearReorderEditsForVendor = jest.fn();
  mockState.recordExportedOrder = jest.fn(() => Promise.resolve('po-2'));
  (buildReorderCsv as jest.Mock).mockImplementation(() => 'csv,data');
  (sharePurchaseOrder as jest.Mock).mockResolvedValue({ shared: true, previewText: 'x' });
});

// ── AC-8 site 1 / AC-9: quick-order share ───────────────────────────────────
describe('quick-order share (site 1)', () => {
  it('records ONCE for the shared vendor when shared === true', async () => {
    seedOneVendorPayload('v-1');
    render(<ReorderSection />);
    expandAllVendorCards();
    fireEvent.press(screen.getByTestId('reorder-quick-order-v-1'));
    await waitFor(() => expect(mockState.recordExportedOrder).toHaveBeenCalledTimes(1));
    expect(mockState.recordExportedOrder.mock.calls[0][0].vendorId).toBe('v-1');
  });

  it('records NOTHING when the share is dismissed (shared === false)', async () => {
    seedOneVendorPayload('v-1');
    (sharePurchaseOrder as jest.Mock).mockResolvedValueOnce({ shared: false, previewText: null });
    render(<ReorderSection />);
    expandAllVendorCards();
    fireEvent.press(screen.getByTestId('reorder-quick-order-v-1'));
    await settle();
    expect(mockState.recordExportedOrder).not.toHaveBeenCalled();
    expect(mockState.clearReorderEditsForVendor).not.toHaveBeenCalled();
  });
});

// ── AC-8 site 2 / AC-9: CSV, BOTH branches ──────────────────────────────────
describe('CSV export (site 2 — generic + import branches)', () => {
  it('generic branch: records ONCE on ok === true', async () => {
    seedOneVendorPayload('v-1');
    render(<ReorderSection />);
    fireEvent.press(screen.getByTestId('reorder-export-csv-v-1'));
    await waitFor(() => expect(mockState.recordExportedOrder).toHaveBeenCalledTimes(1));
    expect(buildReorderCsv).toHaveBeenCalledTimes(1); // the GENERIC builder ran
  });

  it('US FOODS import branch: records ONCE (the owner’s motivating case)', async () => {
    seedOneVendorPayload('v-1');
    mockState.vendors = [{
      id: 'v-1', name: 'US FOODS', orderImportFormat: 'us_foods',
      importCustomerNumber: '123456', importDistributorNumber: '99', importDepartment: '1',
    }];
    render(<ReorderSection />);
    fireEvent.press(screen.getByTestId('reorder-export-csv-v-1'));
    await waitFor(() => expect(mockState.recordExportedOrder).toHaveBeenCalledTimes(1));
    // The IMPORT file went out, not the generic reorder CSV.
    expect(buildReorderCsv).not.toHaveBeenCalled();
    expect(mockState.recordExportedOrder.mock.calls[0][0].vendorId).toBe('v-1');
  });

  it('SYSCO import branch: records ONCE', async () => {
    seedOneVendorPayload('v-1');
    mockState.vendors = [{
      id: 'v-1', name: 'SYSCO', orderImportFormat: 'sysco', importCustomerNumber: '123456',
    }];
    render(<ReorderSection />);
    fireEvent.press(screen.getByTestId('reorder-export-csv-v-1'));
    await waitFor(() => expect(mockState.recordExportedOrder).toHaveBeenCalledTimes(1));
    expect(buildReorderCsv).not.toHaveBeenCalled();
  });

  it('a FAILED CSV export records nothing and preserves the edit buffer', async () => {
    seedOneVendorPayload('v-1');
    (buildReorderCsv as jest.Mock).mockImplementationOnce(() => {
      throw new Error('csv boom');
    });
    render(<ReorderSection />);
    fireEvent.press(screen.getByTestId('reorder-export-csv-v-1'));
    await settle();
    expect(mockState.recordExportedOrder).not.toHaveBeenCalled();
    // Co-located sanity check — the canonical pin lives in the spec-138 suite.
    expect(mockState.clearReorderEditsForVendor).not.toHaveBeenCalled();
  });
});

// ── AC-8 site 3 / AC-9: PDF ─────────────────────────────────────────────────
describe('PDF export (site 3)', () => {
  it('records ONCE on ok === true', async () => {
    seedOneVendorPayload('v-1');
    render(<ReorderSection />);
    fireEvent.press(screen.getByTestId('reorder-export-pdf-v-1'));
    await waitFor(() => expect(mockState.recordExportedOrder).toHaveBeenCalledTimes(1));
  });

  it('records nothing when the PDF build fails', async () => {
    seedOneVendorPayload('v-1');
    const jsPDF = require('jspdf').default;
    const spy = jest.spyOn(jsPDF.prototype, 'save').mockImplementationOnce(() => {
      throw new Error('pdf boom');
    });
    render(<ReorderSection />);
    fireEvent.press(screen.getByTestId('reorder-export-pdf-v-1'));
    await settle();
    expect(mockState.recordExportedOrder).not.toHaveBeenCalled();
    expect(mockState.clearReorderEditsForVendor).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

// ── AC-10: ordering — record BEFORE clear ───────────────────────────────────
describe('AC-10 — the recording precedes the edit-buffer clear', () => {
  const orderedCalls = () => {
    const calls: string[] = [];
    mockState.recordExportedOrder = jest.fn(() => {
      calls.push('record');
      return Promise.resolve('po-2');
    });
    mockState.clearReorderEditsForVendor = jest.fn(() => {
      calls.push('clear');
    });
    return calls;
  };

  it('CSV: ["record", "clear"]', async () => {
    seedOneVendorPayload('v-1');
    const calls = orderedCalls();
    render(<ReorderSection />);
    fireEvent.press(screen.getByTestId('reorder-export-csv-v-1'));
    await waitFor(() => expect(calls).toEqual(['record', 'clear']));
  });

  it('PDF: ["record", "clear"]', async () => {
    seedOneVendorPayload('v-1');
    const calls = orderedCalls();
    render(<ReorderSection />);
    fireEvent.press(screen.getByTestId('reorder-export-pdf-v-1'));
    await waitFor(() => expect(calls).toEqual(['record', 'clear']));
  });

  it('quick-order: ["record", "clear"]', async () => {
    seedOneVendorPayload('v-1');
    const calls = orderedCalls();
    render(<ReorderSection />);
    expandAllVendorCards();
    fireEvent.press(screen.getByTestId('reorder-quick-order-v-1'));
    await waitFor(() => expect(calls).toEqual(['record', 'clear']));
  });
});

// ── AC-11: the recorded vendor IS the exported vendor ───────────────────────
describe('AC-11 — the edited quantity reaches BOTH the export and the record', () => {
  it('the recorder gets the buffer-overlaid vendor the CSV builder consumed', async () => {
    seedOneVendorPayload('v-1'); // edit: i-case → 120 base (server suggestion is 72)
    render(<ReorderSection />);
    fireEvent.press(screen.getByTestId('reorder-export-csv-v-1'));
    await waitFor(() => expect(mockState.recordExportedOrder).toHaveBeenCalledTimes(1));

    const recordedVendor = mockState.recordExportedOrder.mock.calls[0][0];
    expect(recordedVendor.items[0].suggestedUnits).toBe(120);
    expect(recordedVendor.items[0].suggestedQty).toBe(120);

    // The SAME edited base reached the export builder.
    const exportedPayload = (buildReorderCsv as jest.Mock).mock.calls[0][0];
    expect(exportedPayload.vendors[0].items[0].suggestedUnits).toBe(120);
  });
});

// ── Security review (2026-08-08) Mediums 1+2 — the export-start snapshot ────
//
// The call site must hand `recordExportedOrder` the `(store, reorder date)` that
// was true when the export STARTED, not whatever the globals say when it
// finishes. Pinned here at the seam, because the store-side guard can only
// refuse what the call site tells it.
describe('the (store, reorder date) snapshot is taken at EXPORT START', () => {
  it('passes the active store + as-of date alongside the vendor', async () => {
    seedOneVendorPayload('v-1');
    const asOf = mockState.reorderPayload.asOfDate;
    render(<ReorderSection />);
    fireEvent.press(screen.getByTestId('reorder-export-csv-v-1'));
    await waitFor(() => expect(mockState.recordExportedOrder).toHaveBeenCalledTimes(1));
    expect(mockState.recordExportedOrder.mock.calls[0][1]).toEqual({
      storeId: 'store-1',
      referenceDate: asOf,
    });
  });

  it('a store switch DURING the export does not move the snapshot (Medium 1)', async () => {
    seedOneVendorPayload('v-1');
    const asOf = mockState.reorderPayload.asOfDate;
    // Hold the share sheet open — the window in which the TitleBar switcher is
    // live and the operator can change stores.
    let release: (v: any) => void = () => {};
    (sharePurchaseOrder as jest.Mock).mockImplementationOnce(
      () => new Promise((r) => { release = r; }),
    );

    render(<ReorderSection />);
    expandAllVendorCards();
    fireEvent.press(screen.getByTestId('reorder-quick-order-v-1'));

    // …the operator switches to another store while the sheet is open…
    mockState.currentStore = { id: 'store-2', name: 'Other Store' };
    release({ shared: true, previewText: 'x' });

    await waitFor(() => expect(mockState.recordExportedOrder).toHaveBeenCalledTimes(1));
    // …and the recorder is still told the export belonged to store-1. The store
    // action then refuses (live store is store-2), so nothing lands under the
    // wrong tenant — pinned store-side in useStore.recordExportedOrder.spec156.
    expect(mockState.recordExportedOrder.mock.calls[0][1]).toEqual({
      storeId: 'store-1',
      referenceDate: asOf,
    });
  });

  it('a realtime reload nulling reorderPayload mid-export does not move the date (Medium 2)', async () => {
    seedOneVendorPayload('v-1');
    const asOf = mockState.reorderPayload.asOfDate;
    let release: (v: any) => void = () => {};
    (sharePurchaseOrder as jest.Mock).mockImplementationOnce(
      () => new Promise((r) => { release = r; }),
    );

    render(<ReorderSection />);
    expandAllVendorCards();
    fireEvent.press(screen.getByTestId('reorder-quick-order-v-1'));

    // The self-echo of an earlier export lands: loadFromSupabase nulls the payload.
    mockState.reorderPayload = null;
    release({ shared: true, previewText: 'x' });

    await waitFor(() => expect(mockState.recordExportedOrder).toHaveBeenCalledTimes(1));
    // The dated key survives — no `reference_date IS NULL` second draft header.
    expect(mockState.recordExportedOrder.mock.calls[0][1].referenceDate).toBe(asOf);
  });
});

// ── AC-6 at the seam ────────────────────────────────────────────────────────
describe('AC-6 — a failing recorder never breaks the export', () => {
  it('a rejected record still clears the buffer and does not throw', async () => {
    seedOneVendorPayload('v-1');
    mockState.recordExportedOrder = jest.fn(() => Promise.reject(new Error('rls denied')));
    render(<ReorderSection />);
    fireEvent.press(screen.getByTestId('reorder-export-csv-v-1'));
    await waitFor(() => expect(mockState.clearReorderEditsForVendor).toHaveBeenCalledWith('v-1'));
    await settle();
  });
});
