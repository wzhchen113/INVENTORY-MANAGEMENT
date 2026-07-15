// src/screens/cmd/sections/__tests__/ReorderSection.spec123.test.tsx — Spec 123.
//
// Two behaviours land in this spec:
//   1. Per-vendor CSV + PDF export replaces the former GLOBAL top-of-screen
//      CSV/PDF buttons. Each vendor card exports ONLY that vendor via a narrowed
//      payload ({ ...payload, vendors:[v], kpis: computeReorderKpis([v]) }) fed
//      to the SAME builders.
//   2. "+ CREATE PO" becomes a disabled, muted "PO CREATED" chip when the
//      vendor already has a (date-keyed) PO (`hasPo` from the RPC), preventing a
//      duplicate draft.
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
    eodSubmittedAt: null,
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

    fireEvent.press(screen.getByTestId('reorder-export-csv-v-b'));

    // The shared CSV builder is invoked with a payload narrowed to vendor B.
    expect(buildReorderCsv).toHaveBeenCalledTimes(1);
    const passedPayload = (buildReorderCsv as jest.Mock).mock.calls[0][0];
    expect(passedPayload.vendors).toHaveLength(1);
    expect(passedPayload.vendors[0].vendorId).toBe('v-b');
    expect(passedPayload.kpis.vendorCount).toBe(1);
  });
});

describe('"PO CREATED" persistent disabled state', () => {
  it('renders a disabled "PO CREATED" chip (no createPoDraft) when the vendor hasPo', () => {
    mockState.reorderPayload = {
      asOfDate: toISODate(new Date()),
      vendors: [vendor({ vendorId: 'v-a', hasPo: true })],
      kpis: { vendorCount: 1, itemCount: 1, totalEstimatedCost: 10, eodSourcedVendorCount: 1, stockFallbackVendorCount: 0 },
      warnings: [],
    };
    render(<ReorderSection />);

    expect(screen.getByText('section.reorder.poCreatedLabel')).toBeTruthy();
    expect(screen.queryByText('section.reorder.createPoLabel')).toBeNull();

    const chip = screen.getByTestId('reorder-create-po-v-a');
    expect(chip.props.accessibilityState?.disabled).toBe(true);

    // Pressing the disabled chip must never create a draft.
    fireEvent.press(chip);
    expect(mockState.createPoDraft).not.toHaveBeenCalled();
  });

  it('renders a pressable "+ CREATE PO" button when the vendor has no PO', () => {
    mockState.reorderPayload = {
      asOfDate: toISODate(new Date()),
      vendors: [vendor({ vendorId: 'v-a', hasPo: false })],
      kpis: { vendorCount: 1, itemCount: 1, totalEstimatedCost: 10, eodSourcedVendorCount: 1, stockFallbackVendorCount: 0 },
      warnings: [],
    };
    render(<ReorderSection />);

    expect(screen.getByText('section.reorder.createPoLabel')).toBeTruthy();
    expect(screen.queryByText('section.reorder.poCreatedLabel')).toBeNull();

    // The button is enabled (not the disabled PO-CREATED chip).
    const btn = screen.getByTestId('reorder-create-po-v-a');
    expect(btn.props.accessibilityState?.disabled).not.toBe(true);
  });

  it('two vendors on the same date are independent (A created, B not)', () => {
    mockState.reorderPayload = {
      asOfDate: toISODate(new Date()),
      vendors: [vendor({ vendorId: 'v-a', hasPo: true }), vendor({ vendorId: 'v-b', hasPo: false })],
      kpis: { vendorCount: 2, itemCount: 2, totalEstimatedCost: 20, eodSourcedVendorCount: 2, stockFallbackVendorCount: 0 },
      warnings: [],
    };
    render(<ReorderSection />);

    // A shows PO CREATED (disabled), B shows + CREATE PO (enabled).
    expect(screen.getByTestId('reorder-create-po-v-a').props.accessibilityState?.disabled).toBe(true);
    expect(screen.getByTestId('reorder-create-po-v-b').props.accessibilityState?.disabled).not.toBe(true);
  });
});
