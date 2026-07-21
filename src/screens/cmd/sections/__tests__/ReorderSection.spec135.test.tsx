// src/screens/cmd/sections/__tests__/ReorderSection.spec135.test.tsx — Spec 135.
//
// Collapsible vendor cards on the Reorder page. Each expandable VendorCard
// header carries a `▾`/`▸` chevron toggle wrapping ONLY the chevron + vendor
// name. Collapsing hides the whole card body (column strip + per-item rows +
// footer actions + quick-order preview), leaving the header block (name/badges
// + next-delivery + items·qty·est-cost stats row) visible. The collapse Set is
// keyed on the group-qualified render key (`need-` / `ok-` / `nosched-`) so a
// vendor that appears in BOTH the needs and enough groups collapses each card
// independently. The violet "count not submitted" card (spec 130) has NO
// chevron and is not collapsible.
//
// Boundary mocking mirrors ReorderSection.spec130.test.tsx: mock
// useCmdColors / useT / TabStrip / StatCard / useStore, force Platform.OS =
// 'web', everyday schedule so vendors are day-active.

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
    violet: '#6D28D9', violetBg: '#F3EEFC',
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
jest.mock('../../../../components/cmd/StatCard', () => {
  const ReactMod = require('react');
  const RN = require('react-native');
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

// A COUNTED vendor (EOD submitted) with one below-par item → needs group.
const counted = vendor({
  vendorId: 'v-a',
  vendorName: 'Counted Co',
  onHandSource: 'eod',
  eodSubmittedAt: '2026-06-02T18:00:00Z',
  items: [item({ itemId: 'a1' })],
  vendorTotalCost: 10,
});
// An UN-COUNTED vendor (no EOD submitted) → count-not-submitted group.
const notSubmitted = vendor({
  vendorId: 'v-b',
  vendorName: 'Uncounted Co',
  onHandSource: 'stock',
  eodSubmittedAt: null,
  items: [item({ itemId: 'b1' })],
  vendorTotalCost: 10,
});
// A COUNTED vendor with BOTH a below-par item (needs) and an at-par item
// (enough) so splitReorderVendorsByNeed yields a card in BOTH groups.
const both = vendor({
  vendorId: 'v-c',
  vendorName: 'Both Co',
  onHandSource: 'eod',
  eodSubmittedAt: '2026-06-02T18:00:00Z',
  items: [
    item({ itemId: 'c1', needsOrder: true }),
    item({ itemId: 'c2', needsOrder: false, estimatedCost: 0, suggestedQty: 0 }),
  ],
  vendorTotalCost: 10,
});

beforeEach(() => {
  jest.clearAllMocks();
  (global as any).Blob = class {};
  const w = (global as any).window ?? ((global as any).window = {});
  w.URL = { createObjectURL: () => 'blob:x', revokeObjectURL: () => {} };
  mockState.currentStore = { id: 'store-1', name: 'Test Store' };
  mockState.orderSchedule = everyDaySchedule(['v-a', 'v-b', 'v-c']);
  mockState.reorderPayload = null;
  mockState.reorderLoading = false;
  mockState.reorderError = null;
  mockState.loadReorderSuggestions = jest.fn();
  mockState.createPoDraft = jest.fn(() => Promise.resolve('po-1'));
  mockState.vendors = [];
  mockState.inventory = [];
});

const payloadWith = (vendors: any[]) => ({
  asOfDate: toISODate(new Date()),
  vendors,
  kpis: { vendorCount: vendors.length, itemCount: 1, totalEstimatedCost: 10, eodSourcedVendorCount: 1, stockFallbackVendorCount: 0 },
  warnings: [],
});

describe('Reorder — collapsible vendor cards (spec 135)', () => {
  it('renders every card expanded by default (body + header stats visible)', () => {
    mockState.reorderPayload = payloadWith([counted]);
    render(<ReorderSection />);

    expect(screen.getByTestId('reorder-vendor-stats-need-v-a')).toBeTruthy();
    expect(screen.getByTestId('reorder-vendor-columns-need-v-a')).toBeTruthy();
    expect(screen.getByTestId('reorder-vendor-item-a1')).toBeTruthy();
    expect(screen.getByTestId('reorder-create-po-v-a')).toBeTruthy();
  });

  it('collapse hides the body (columns/items/footer) but keeps the header stats', () => {
    mockState.reorderPayload = payloadWith([counted]);
    render(<ReorderSection />);

    fireEvent.press(screen.getByTestId('reorder-vendor-toggle-need-v-a'));

    // Body gone.
    expect(screen.queryByTestId('reorder-vendor-columns-need-v-a')).toBeNull();
    expect(screen.queryByTestId('reorder-vendor-item-a1')).toBeNull();
    expect(screen.queryByTestId('reorder-create-po-v-a')).toBeNull();
    // Header stats row still present.
    expect(screen.getByTestId('reorder-vendor-stats-need-v-a')).toBeTruthy();
    // Toggle itself still there (header block stays).
    expect(screen.getByTestId('reorder-vendor-toggle-need-v-a')).toBeTruthy();
  });

  it('keys collapse per group — collapsing the needs card leaves the enough card open', () => {
    mockState.reorderPayload = payloadWith([both]);
    render(<ReorderSection />);

    // Both cards render for the same vendor.
    expect(screen.getByTestId('reorder-vendor-item-c1')).toBeTruthy(); // needs
    expect(screen.getByTestId('reorder-vendor-item-c2')).toBeTruthy(); // enough

    fireEvent.press(screen.getByTestId('reorder-vendor-toggle-need-v-c'));

    // Needs card body hidden…
    expect(screen.queryByTestId('reorder-vendor-item-c1')).toBeNull();
    // …enough card body untouched.
    expect(screen.getByTestId('reorder-vendor-item-c2')).toBeTruthy();
    expect(screen.getByTestId('reorder-create-po-v-c')).toBeTruthy();
  });

  it('the count-not-submitted card has no chevron and is not collapsible', () => {
    mockState.reorderPayload = payloadWith([notSubmitted]);
    render(<ReorderSection />);

    expect(screen.getByTestId('reorder-count-not-submitted-v-b')).toBeTruthy();
    expect(screen.queryByTestId('reorder-vendor-toggle-nosub-v-b')).toBeNull();
    expect(screen.queryByTestId('reorder-vendor-toggle-need-v-b')).toBeNull();
  });

  it('exposes accessibilityState.expanded reflecting current state', () => {
    mockState.reorderPayload = payloadWith([counted]);
    render(<ReorderSection />);

    const toggle = screen.getByTestId('reorder-vendor-toggle-need-v-a');
    expect(toggle.props.accessibilityState.expanded).toBe(true);

    fireEvent.press(toggle);
    expect(
      screen.getByTestId('reorder-vendor-toggle-need-v-a').props.accessibilityState.expanded,
    ).toBe(false);
  });
});
