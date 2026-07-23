// src/screens/cmd/sections/__tests__/ReorderSection.spec123.test.tsx — Spec 123.
//
// Two behaviours land in this file:
//   1. Per-vendor CSV + PDF export replaces the former GLOBAL top-of-screen
//      CSV/PDF buttons. Each vendor card exports ONLY that vendor via a narrowed
//      payload ({ ...payload, vendors:[v], kpis: computeReorderKpis([v]) }) fed
//      to the SAME builders. (spec 123)
//   2. Fill-cart extension gating (spec 138): the retired "+ CREATE PO" / "PO
//      CREATED" chip is gone; a "Fill cart" button renders ONLY on
//      `extension_ordering` vendors (exports-only otherwise). The describe block
//      below was rewritten from the spec-123 "PO CREATED chip" behaviour to this.
//
// Boundary mocking mirrors ReorderSection.test.tsx / ReorderSectionCases (spec
// 087/088): mock useCmdColors / useT / TabStrip / StatCard / useStore. Two
// additions for this spec:
//   - Force Platform.OS = 'web' so the web-only `showExport` gate renders the
//     per-vendor export buttons (jest-expo defaults to 'ios').
//   - Mock reorderExport's `buildReorderCsv` (keep the rest real) so the CSV
//     press can be asserted to receive the single-vendor narrowed payload
//     without touching the DOM download path.

jest.mock('react-native/Libraries/Utilities/Platform', () => ({
  __esModule: true,
  default: { OS: 'web', select: (obj: any) => obj.web ?? obj.default },
  OS: 'web',
}));

jest.mock('react-native-toast-message', () => ({
  __esModule: true,
  default: { show: jest.fn(), hide: jest.fn() },
}));

// Spec 138 — Fill cart is confirm-gated; auto-confirm so the press reaches the
// store action synchronously (mirrors OrderingSection.test).
const mockConfirmAction = jest.fn(
  (_t: string, _m: string, onConfirm: () => void) => { onConfirm(); },
);
jest.mock('../../../../utils/confirmAction', () => ({
  confirmAction: (...args: any[]) => (mockConfirmAction as any)(...args),
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
  CmdRadius: { xs: 3, sm: 4, md: 5, lg: 6 },
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
jest.mock('../../../../components/cmd/StatCard', () => ({
  StatCard: () => null,
}));

// Keep every pure reorderExport helper real (the section renders with them);
// only stub the CSV builder so the per-vendor CSV press is assertable without
// the DOM Blob/download path.
jest.mock('../../../../utils/reorderExport', () => {
  const actual = jest.requireActual('../../../../utils/reorderExport');
  return { ...actual, buildReorderCsv: jest.fn(() => 'csv,data') };
});

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
    createPoDraft: jest.fn(() => Promise.resolve('po-1')),
    vendors: [],
    inventory: [],
    // Spec 138 — inline-edit buffer + Fill-cart slice the section now reads.
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
import { render, screen, fireEvent } from '@testing-library/react-native';
import { toISODate } from '../../../../utils/reportDates';
import { computeReorderKpis } from '../../../../utils/reorderDayFilter';
import { buildReorderCsv } from '../../../../utils/reorderExport';
import ReorderSection, { narrowReorderToVendor } from '../ReorderSection';
import { useStore } from '../../../../store/useStore';

const mockState = (useStore as any).__state as Record<string, any>;

// Spec 135 owner follow-up (2026-07-21): vendor cards start COLLAPSED, so
// body assertions (item rows / exports / footer actions) must expand first.
const expandAllVendorCards = () => {
  screen.getAllByTestId(/^reorder-vendor-toggle-/).forEach((t) => fireEvent.press(t));
};


function item(over: Record<string, any> = {}) {
  return {
    itemId: over.itemId ?? 'i-1',
    itemName: over.itemName ?? 'Item',
    unit: over.unit ?? 'each',
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
    ...over,
  };
}

function vendor(over: Record<string, any> & { vendorId: string }) {
  return {
    vendorId: over.vendorId,
    vendorName: over.vendorName ?? over.vendorId,
    scheduleKnown: over.scheduleKnown ?? true,
    nextDeliveryDate: '2026-06-02',
    daysUntilNextDelivery: 1,
    onHandSource: over.onHandSource ?? 'eod',
    // Spec 130 — default to a submitted count so these fixtures render the
    // normal (counted) card path.
    eodSubmittedAt: over.eodSubmittedAt ?? '2026-06-02T00:00:00Z',
    items: over.items ?? [item()],
    vendorTotalCost: over.vendorTotalCost ?? 10,
    hasPo: over.hasPo ?? false,
  };
}

// Schedule the given vendors on EVERY weekday so they always land in the
// PRIMARY (day-filtered) set regardless of the machine's "today".
function everyDaySchedule(vendorIds: string[]) {
  const entries = vendorIds.map((id) => ({ vendorId: id, vendorName: id, deliveryDay: 'Wednesday' }));
  return {
    Monday: entries, Tuesday: entries, Wednesday: entries, Thursday: entries,
    Friday: entries, Saturday: entries, Sunday: entries,
  };
}

// The CSV press reaches the (web-only) DOM download path after the assertable
// `buildReorderCsv` call. jest-expo has no Blob / URL.createObjectURL, so stub
// them so the download orchestrator completes quietly rather than throwing into
// the caught-and-warned branch.
beforeAll(() => {
  (global as any).Blob = class {};
  const w = (global as any).window ?? ((global as any).window = {});
  w.URL = { createObjectURL: () => 'blob:x', revokeObjectURL: () => {} };
});

beforeEach(() => {
  jest.clearAllMocks();
  mockState.currentStore = { id: 'store-1', name: 'Test Store' };
  mockState.orderSchedule = everyDaySchedule(['v-a', 'v-b']);
  mockState.reorderPayload = null;
  mockState.reorderLoading = false;
  mockState.reorderError = null;
  mockState.loadReorderSuggestions = jest.fn();
  mockState.createPoDraft = jest.fn(() => Promise.resolve('po-1'));
  mockState.vendors = [];
  mockState.inventory = [];
  mockState.reorderEdits = {};
  mockState.setReorderEditQty = jest.fn();
  mockState.clearReorderEdits = jest.fn();
  mockState.clearReorderEditsForVendor = jest.fn();
  mockState.fillCartForVendor = jest.fn(() => Promise.resolve('po-1'));
  mockConfirmAction.mockImplementation((_t: string, _m: string, onConfirm: () => void) => { onConfirm(); });
});

describe('narrowReorderToVendor (payload narrowing helper)', () => {
  it('narrows a multi-vendor payload to a single vendor with recomputed KPIs', () => {
    const vA = vendor({ vendorId: 'v-a', items: [item({ itemId: 'a1' })] });
    const vB = vendor({ vendorId: 'v-b', onHandSource: 'stock', items: [item({ itemId: 'b1' }), item({ itemId: 'b2' })] });
    const payload = {
      asOfDate: '2026-06-02',
      vendors: [vA, vB],
      kpis: computeReorderKpis([vA, vB]),
      warnings: [{ code: 'x', message: 'keep me' }],
    };

    const narrowed = narrowReorderToVendor(payload as any, vB as any);

    // Only the one vendor rides in the narrowed payload.
    expect(narrowed.vendors).toHaveLength(1);
    expect(narrowed.vendors[0].vendorId).toBe('v-b');
    // KPIs are recomputed from JUST that vendor (not the 2-vendor total).
    expect(narrowed.kpis).toEqual(computeReorderKpis([vB as any]));
    expect(narrowed.kpis.vendorCount).toBe(1);
    expect(narrowed.kpis.itemCount).toBe(2);
    // Other envelope fields (asOfDate, warnings) are preserved.
    expect(narrowed.asOfDate).toBe('2026-06-02');
    expect(narrowed.warnings).toEqual([{ code: 'x', message: 'keep me' }]);
  });
});

describe('per-vendor CSV/PDF export', () => {
  it('renders a CSV and PDF button per vendor card, and NO global export buttons', () => {
    mockState.reorderPayload = {
      asOfDate: toISODate(new Date()),
      vendors: [vendor({ vendorId: 'v-a' }), vendor({ vendorId: 'v-b' })],
      kpis: { vendorCount: 2, itemCount: 2, totalEstimatedCost: 20, eodSourcedVendorCount: 2, stockFallbackVendorCount: 0 },
      warnings: [],
    };
    render(<ReorderSection />);
    expandAllVendorCards();

    // Per-vendor export buttons exist for both cards.
    expect(screen.getByTestId('reorder-export-csv-v-a')).toBeTruthy();
    expect(screen.getByTestId('reorder-export-pdf-v-a')).toBeTruthy();
    expect(screen.getByTestId('reorder-export-csv-v-b')).toBeTruthy();
    expect(screen.getByTestId('reorder-export-pdf-v-b')).toBeTruthy();

    // The former GLOBAL export buttons are gone; REFRESH stays.
    expect(screen.queryByTestId('reorder-export-csv')).toBeNull();
    expect(screen.queryByTestId('reorder-export-pdf')).toBeNull();
    expect(screen.getByTestId('reorder-refresh')).toBeTruthy();
  });

  it('CSV button exports ONLY that vendor via a single-vendor narrowed payload', () => {
    const vA = vendor({ vendorId: 'v-a', items: [item({ itemId: 'a1' })] });
    const vB = vendor({ vendorId: 'v-b', items: [item({ itemId: 'b1' })] });
    mockState.reorderPayload = {
      asOfDate: toISODate(new Date()),
      vendors: [vA, vB],
      kpis: { vendorCount: 2, itemCount: 2, totalEstimatedCost: 20, eodSourcedVendorCount: 2, stockFallbackVendorCount: 0 },
      warnings: [],
    };
    render(<ReorderSection />);
    expandAllVendorCards();

    fireEvent.press(screen.getByTestId('reorder-export-csv-v-b'));

    // The shared CSV builder is invoked with a payload narrowed to vendor B.
    expect(buildReorderCsv).toHaveBeenCalledTimes(1);
    const passedPayload = (buildReorderCsv as jest.Mock).mock.calls[0][0];
    expect(passedPayload.vendors).toHaveLength(1);
    expect(passedPayload.vendors[0].vendorId).toBe('v-b');
    expect(passedPayload.kpis.vendorCount).toBe(1);
  });
});

// Spec 138 (AC-9/AC-11/AC-12) — the retired "+ CREATE PO" / "PO CREATED" is
// replaced by a per-vendor "Fill cart" button that renders ONLY on
// extension_ordering vendors.
describe('Fill cart button (extension-ordering gating, spec 138)', () => {
  const payloadFor = (vendorId: string) => ({
    asOfDate: toISODate(new Date()),
    vendors: [vendor({ vendorId })],
    kpis: { vendorCount: 1, itemCount: 1, totalEstimatedCost: 10, eodSourcedVendorCount: 1, stockFallbackVendorCount: 0 },
    warnings: [],
  });

  it('renders a Fill cart button on an extension_ordering vendor, and NO + CREATE PO / PO CREATED', () => {
    mockState.vendors = [{ id: 'v-a', extensionOrdering: true }];
    mockState.reorderPayload = payloadFor('v-a');
    render(<ReorderSection />);
    expandAllVendorCards();

    expect(screen.getByTestId('reorder-fill-cart-v-a')).toBeTruthy();
    // AC-12 — the retired PO affordances are gone.
    expect(screen.queryByTestId('reorder-create-po-v-a')).toBeNull();
    expect(screen.queryByText('section.reorder.createPoLabel')).toBeNull();
    expect(screen.queryByText('section.reorder.poCreatedLabel')).toBeNull();
  });

  it('renders NO Fill cart button on a non-extension vendor (exports only, AC-11)', () => {
    mockState.vendors = [{ id: 'v-a', extensionOrdering: false }];
    mockState.reorderPayload = payloadFor('v-a');
    render(<ReorderSection />);
    expandAllVendorCards();

    expect(screen.queryByTestId('reorder-fill-cart-v-a')).toBeNull();
    // The CSV/PDF/quick-order exports remain available.
    expect(screen.getByTestId('reorder-export-csv-v-a')).toBeTruthy();
    expect(screen.getByTestId('reorder-quick-order-v-a')).toBeTruthy();
  });

  it('renders NO Fill cart button when the vendor is not in the vendors slice', () => {
    mockState.vendors = [];
    mockState.reorderPayload = payloadFor('v-a');
    render(<ReorderSection />);
    expandAllVendorCards();
    expect(screen.queryByTestId('reorder-fill-cart-v-a')).toBeNull();
  });

  it('pressing Fill cart calls fillCartForVendor for that vendor (confirm-gated)', () => {
    mockState.vendors = [{ id: 'v-a', extensionOrdering: true }];
    mockState.reorderPayload = payloadFor('v-a');
    render(<ReorderSection />);
    expandAllVendorCards();

    fireEvent.press(screen.getByTestId('reorder-fill-cart-v-a'));
    expect(mockConfirmAction).toHaveBeenCalledTimes(1);
    expect(mockState.fillCartForVendor).toHaveBeenCalledTimes(1);
    expect(mockState.fillCartForVendor.mock.calls[0][0].vendorId).toBe('v-a');
  });
});
