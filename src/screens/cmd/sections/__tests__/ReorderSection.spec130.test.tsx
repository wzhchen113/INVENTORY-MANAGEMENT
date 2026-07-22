// src/screens/cmd/sections/__tests__/ReorderSection.spec130.test.tsx — Spec 130.
//
// A vendor whose EOD count was NOT submitted for the reorder date
// (`eodSubmittedAt == null`) must render a "Count not submitted yet" state
// block in place of its per-item order rows, with NONE of the four per-vendor
// actions (Create PO / Quick-order / CSV / PDF), and must be pulled out of the
// KPI / needs-enough split so its stale (on_hand=0 → order N) lines can't
// inflate "Items" / "Est. total". A counted vendor renders exactly as before.
//
// Boundary mocking mirrors ReorderSection.spec123.test.tsx: mock
// useCmdColors / useT / TabStrip / StatCard / useStore, force Platform.OS =
// 'web' so the per-vendor export gate is active. StatCard is mocked to expose
// its value so the KPI-exclusion assertion can read the strip.

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
jest.mock('../../../../components/cmd/StatCard', () => {
  const ReactMod = require('react');
  const RN = require('react-native');
  // Expose BOTH the value and the sub so spec-130 can assert the repurposed
  // "count not submitted" KPI sub-stat as well as the item / est-cost values.
  return {
    StatCard: ({ label, value, sub }: { label: string; value: string; sub?: string }) =>
      ReactMod.createElement(
        RN.View,
        { testID: `statcard-${label}` },
        ReactMod.createElement(RN.Text, { testID: `statcard-value-${label}` }, value),
        ReactMod.createElement(RN.Text, { testID: `statcard-sub-${label}` }, sub),
      ),
  };
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
import ReorderSection from '../ReorderSection';
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
    eodSubmittedAt: over.eodSubmittedAt ?? null,
    items: over.items ?? [item()],
    vendorTotalCost: over.vendorTotalCost ?? 10,
    hasPo: over.hasPo ?? false,
  };
}

function everyDaySchedule(vendorIds: string[]) {
  const entries = vendorIds.map((id) => ({ vendorId: id, vendorName: id, deliveryDay: 'Wednesday' }));
  return {
    Monday: entries, Tuesday: entries, Wednesday: entries, Thursday: entries,
    Friday: entries, Saturday: entries, Sunday: entries,
  };
}

// A COUNTED vendor (EOD submitted): 1 item, $10.
const counted = vendor({
  vendorId: 'v-a',
  vendorName: 'Counted Co',
  onHandSource: 'eod',
  eodSubmittedAt: '2026-06-02T18:00:00Z',
  items: [item({ itemId: 'a1' })],
  vendorTotalCost: 10,
});
// An UN-COUNTED vendor (no EOD submitted): 2 stale items, $20 — must NOT
// inflate the KPIs.
const notSubmitted = vendor({
  vendorId: 'v-b',
  vendorName: 'Uncounted Co',
  onHandSource: 'stock',
  eodSubmittedAt: null,
  items: [item({ itemId: 'b1' }), item({ itemId: 'b2' })],
  vendorTotalCost: 20,
});

beforeEach(() => {
  jest.clearAllMocks();
  (global as any).Blob = class {};
  const w = (global as any).window ?? ((global as any).window = {});
  w.URL = { createObjectURL: () => 'blob:x', revokeObjectURL: () => {} };
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

describe('Reorder — count not submitted (spec 130)', () => {
  it('renders the not-submitted state block and NONE of the four per-vendor actions', () => {
    mockState.reorderPayload = {
      asOfDate: toISODate(new Date()),
      vendors: [counted, notSubmitted],
      kpis: { vendorCount: 2, itemCount: 3, totalEstimatedCost: 30, eodSourcedVendorCount: 1, stockFallbackVendorCount: 1 },
      warnings: [],
    };
    render(<ReorderSection />);

    // Group header + the un-counted vendor's state block render.
    expect(screen.getByTestId('reorder-section-count-not-submitted')).toBeTruthy();
    expect(screen.getByTestId('reorder-count-not-submitted-v-b')).toBeTruthy();
    expect(screen.getByText('section.reorder.countNotSubmittedTitle')).toBeTruthy();

    // The four per-vendor actions are ABSENT for the un-counted vendor.
    expect(screen.queryByTestId('reorder-create-po-v-b')).toBeNull();
    expect(screen.queryByTestId('reorder-quick-order-v-b')).toBeNull();
    expect(screen.queryByTestId('reorder-export-csv-v-b')).toBeNull();
    expect(screen.queryByTestId('reorder-export-pdf-v-b')).toBeNull();
  });

  it('renders a counted vendor normally (breakdown + all actions present)', () => {
    mockState.reorderPayload = {
      asOfDate: toISODate(new Date()),
      vendors: [counted, notSubmitted],
      kpis: { vendorCount: 2, itemCount: 3, totalEstimatedCost: 30, eodSourcedVendorCount: 1, stockFallbackVendorCount: 1 },
      warnings: [],
    };
    render(<ReorderSection />);
    expandAllVendorCards();

    // The counted vendor is NOT rendered as a not-submitted card.
    expect(screen.queryByTestId('reorder-count-not-submitted-v-a')).toBeNull();
    // Its per-vendor actions all render.
    expect(screen.getByTestId('reorder-create-po-v-a')).toBeTruthy();
    expect(screen.getByTestId('reorder-quick-order-v-a')).toBeTruthy();
    expect(screen.getByTestId('reorder-export-csv-v-a')).toBeTruthy();
    expect(screen.getByTestId('reorder-export-pdf-v-a')).toBeTruthy();
  });

  it('excludes the un-counted vendor from the Items / Est. total KPIs', () => {
    mockState.reorderPayload = {
      asOfDate: toISODate(new Date()),
      vendors: [counted, notSubmitted],
      kpis: { vendorCount: 2, itemCount: 3, totalEstimatedCost: 30, eodSourcedVendorCount: 1, stockFallbackVendorCount: 1 },
      warnings: [],
    };
    render(<ReorderSection />);

    // Only the counted vendor's 1 item / $10 feed the KPIs — the un-counted
    // vendor's 2 stale items / $20 are excluded.
    expect(screen.getByTestId('statcard-value-Items').props.children).toBe('1');
    expect(screen.getByTestId('statcard-value-Est. total').props.children).toBe('$10.00');
    expect(screen.getByTestId('statcard-value-Vendors').props.children).toBe('1');
  });

  it('repurposes the on-hand-source KPI sub-stat to the not-submitted count', () => {
    mockState.reorderPayload = {
      asOfDate: toISODate(new Date()),
      vendors: [counted, notSubmitted],
      kpis: { vendorCount: 2, itemCount: 3, totalEstimatedCost: 30, eodSourcedVendorCount: 1, stockFallbackVendorCount: 1 },
      warnings: [],
    };
    render(<ReorderSection />);

    // Value keeps the EOD-sourced side; the sub now reads the count of
    // "count not submitted" vendors (1), not the vestigial stock-fallback count.
    expect(screen.getByTestId('statcard-value-On-hand source').props.children).toBe('1 EOD');
    expect(screen.getByTestId('statcard-sub-On-hand source').props.children).toBe(
      '1 section.reorder.countNotSubmittedKpiSub',
    );
  });
});
