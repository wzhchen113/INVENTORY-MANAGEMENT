// src/screens/cmd/sections/__tests__/ReorderSection.resetAfterExport.spec138.test.tsx
// Spec 138 (AC-7) — reset-after-export.
//
// A vendor's inline-edit buffer is closed (cleared) after a SUCCESSFUL export
// for that vendor, and ONLY on success. This pins the wiring added by the
// release-proposal fix #1:
//   • CSV export success  → clearReorderEditsForVendor(vendorId)
//   • CSV export FAILURE   → buffer preserved (no clear)
//   • PDF export success   → clearReorderEditsForVendor(vendorId)
//   • quick-order share ok → clearReorderEditsForVendor(vendorId)
//   • quick-order dismissed (shared=false) → buffer preserved (no clear)
// and that the clear is scoped to the exported vendor only (other vendors'
// edits are left intact — the store action deletes only the passed key).
//
// Boundary mocking mirrors ReorderSection.spec138 (web Platform + stubbed CSV
// builder), plus stubs for the PDF engine (jspdf / jspdf-autotable) and the
// share orchestrator (sharePo) so the export presses are assertable without the
// real DOM download / clipboard paths.

jest.mock('react-native/Libraries/Utilities/Platform', () => ({
  __esModule: true,
  default: { OS: 'web', select: (obj: any) => obj.web ?? obj.default },
  OS: 'web',
}));

jest.mock('react-native-toast-message', () => ({
  __esModule: true,
  default: { show: jest.fn(), hide: jest.fn() },
}));

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

// Minimal jsPDF + autotable so handlePdfExport reaches doc.save() and returns
// true without pulling the real (DOM-coupled) engine.
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

// The share orchestrator — controlled per test via mockResolvedValueOnce.
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
    inventory: [],
    vendors: [],
    reorderEdits: {},
    setReorderEditQty: jest.fn(),
    clearReorderEdits: jest.fn(),
    clearReorderEditsForVendor: jest.fn(),
    fillCartForVendor: jest.fn(() => Promise.resolve('po-1')),
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

/** A single-vendor payload holding an edit for that vendor. */
function seedOneVendorPayload(vendorId = 'v-1') {
  mockState.inventory = [{ id: 'i-case', subUnitSize: 4 }];
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
  (buildReorderCsv as jest.Mock).mockImplementation(() => 'csv,data');
  (sharePurchaseOrder as jest.Mock).mockResolvedValue({ shared: true, previewText: 'x' });
});

describe('AC-7 reset-after-export — CSV', () => {
  it('clears the vendor buffer after a successful CSV export', async () => {
    seedOneVendorPayload('v-1');
    render(<ReorderSection />);
    fireEvent.press(screen.getByTestId('reorder-export-csv-v-1'));
    await waitFor(() => {
      expect(mockState.clearReorderEditsForVendor).toHaveBeenCalledWith('v-1');
    });
    expect(mockState.clearReorderEditsForVendor).toHaveBeenCalledTimes(1);
  });

  it('does NOT clear the buffer when the CSV export fails (edits preserved)', async () => {
    seedOneVendorPayload('v-1');
    (buildReorderCsv as jest.Mock).mockImplementationOnce(() => {
      throw new Error('csv boom');
    });
    render(<ReorderSection />);
    fireEvent.press(screen.getByTestId('reorder-export-csv-v-1'));
    // Let the async handler settle, then assert no clear fired.
    await new Promise((r) => setTimeout(r, 0));
    expect(mockState.clearReorderEditsForVendor).not.toHaveBeenCalled();
  });

  it('scopes the reset to the exported vendor only (other vendors untouched)', async () => {
    // Two vendors, both with edits; export only v-1.
    mockState.inventory = [{ id: 'i-case', subUnitSize: 4 }];
    mockState.reorderEdits = { 'v-1': { 'i-case': 120 }, 'v-2': { 'i-case': 48 } };
    const entries = [
      { vendorId: 'v-1', vendorName: 'v-1', deliveryDay: 'Wednesday' },
      { vendorId: 'v-2', vendorName: 'v-2', deliveryDay: 'Wednesday' },
    ];
    mockState.orderSchedule = {
      Monday: entries, Tuesday: entries, Wednesday: entries, Thursday: entries,
      Friday: entries, Saturday: entries, Sunday: entries,
    };
    mockState.reorderPayload = {
      asOfDate: toISODate(new Date()),
      vendors: [
        vendor({ vendorId: 'v-1', items: [caseItem({ suggestedQty: 49, caseQty: 24, costPerUnit: 2, itemId: 'i-case' })] }),
        vendor({ vendorId: 'v-2', items: [caseItem({ suggestedQty: 24, caseQty: 24, costPerUnit: 3, itemId: 'i-case' })] }),
      ],
      kpis: { vendorCount: 2, itemCount: 2, totalEstimatedCost: 200, eodSourcedVendorCount: 2, stockFallbackVendorCount: 0 },
      warnings: [],
    };
    render(<ReorderSection />);
    fireEvent.press(screen.getByTestId('reorder-export-csv-v-1'));
    await waitFor(() => {
      expect(mockState.clearReorderEditsForVendor).toHaveBeenCalledWith('v-1');
    });
    // Only v-1 was reset — v-2 was never passed to the clear action.
    expect(mockState.clearReorderEditsForVendor).not.toHaveBeenCalledWith('v-2');
  });
});

describe('AC-7 reset-after-export — PDF', () => {
  it('clears the vendor buffer after a successful PDF export', async () => {
    seedOneVendorPayload('v-1');
    render(<ReorderSection />);
    fireEvent.press(screen.getByTestId('reorder-export-pdf-v-1'));
    await waitFor(() => {
      expect(mockState.clearReorderEditsForVendor).toHaveBeenCalledWith('v-1');
    });
  });
});

describe('AC-7 reset-after-export — quick-order text', () => {
  it('clears the vendor buffer after a successful share/copy', async () => {
    seedOneVendorPayload('v-1');
    (sharePurchaseOrder as jest.Mock).mockResolvedValueOnce({ shared: true, previewText: 'x' });
    render(<ReorderSection />);
    expandAllVendorCards();
    fireEvent.press(screen.getByTestId('reorder-quick-order-v-1'));
    await waitFor(() => {
      expect(mockState.clearReorderEditsForVendor).toHaveBeenCalledWith('v-1');
    });
  });

  it('does NOT clear the buffer when the share is dismissed (shared=false)', async () => {
    seedOneVendorPayload('v-1');
    (sharePurchaseOrder as jest.Mock).mockResolvedValueOnce({ shared: false, previewText: null });
    render(<ReorderSection />);
    expandAllVendorCards();
    fireEvent.press(screen.getByTestId('reorder-quick-order-v-1'));
    await new Promise((r) => setTimeout(r, 0));
    expect(mockState.clearReorderEditsForVendor).not.toHaveBeenCalled();
  });
});
