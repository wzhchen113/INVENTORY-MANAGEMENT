// src/screens/cmd/sections/__tests__/ReorderSection.noNeed.spec172.test.tsx — Spec 172.
//
// Admin reorder display of an EOD NO NEED row (flag `no_need` from
// report_reorder_list hunk R4):
//   - AC-36 FlagChip maps `no_need` to a labeled "NO NEED" chip; other tokens
//     render as before.
//   - AC-38 / OQ-3 the breakdown's `on hand` segment shows the localized NO
//     NEED label (the stale current_stock is NOT printed) for that row only.
//
// Harness copied from ReorderSection.spec138.test.tsx (web Platform, desktop
// tier, key-echo useT, mocked store).

jest.mock('react-native/Libraries/Utilities/Platform', () => ({
  __esModule: true,
  default: { OS: 'web', select: (obj: any) => obj.web ?? obj.default },
  OS: 'web',
}));

jest.mock('react-native-toast-message', () => ({
  __esModule: true,
  default: { show: jest.fn(), hide: jest.fn() },
}));

// Spec (2026-07) — force the desktop tier so the section renders its desktop
// tree; the phone `if (isPhone) return <PhoneOrdering/>` guard is exercised by
// the phone-tier tests, not these.
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

// Keep the pure reorderExport helpers real; stub only the CSV builder so the
// export press is assertable without touching the DOM download path.
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
    // Spec 151 — the section's context-fetch effect runs above the isPhone
    // guard on every mount; this mocked store must carry the action (the
    // context itself stays null, so no context line renders here — AC-17).
    lastOrderContext: null,
    loadLastOrderContext: jest.fn(),
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
import { render, screen, fireEvent } from '@testing-library/react-native';
import { toISODate } from '../../../../utils/reportDates';
import { ReorderItem, ReorderVendor } from '../../../../types';
import ReorderSection from '../ReorderSection';
import { useStore } from '../../../../store/useStore';

const mockState = (useStore as any).__state as Record<string, any>;

const expandAllVendorCards = () => {
  screen.getAllByTestId(/^reorder-vendor-toggle-/).forEach((t) => fireEvent.press(t));
};

// A case item shaped like the mapped report payload. suggestedUnits is the
// server case-rounded base-unit total; estimatedCost is the server value.
function caseItem(over: {
  itemId?: string;
  itemName?: string;
  unit?: string;
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
    unit: over.unit ?? 'each',
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

beforeAll(() => {
  (global as any).Blob = class {};
  const w = (global as any).window ?? ((global as any).window = {});
  w.URL = { createObjectURL: () => 'blob:x', revokeObjectURL: () => {} };
});

beforeEach(() => {
  jest.clearAllMocks();
  mockState.currentStore = { id: 'store-1', name: 'Test Store' };
  mockState.orderSchedule = everyDaySchedule('v-1');
  mockState.reorderPayload = null;
  mockState.reorderLoading = false;
  mockState.reorderError = null;
  mockState.loadReorderSuggestions = jest.fn();
  mockState.inventory = [];
  mockState.vendors = [];
  mockState.reorderEdits = {};
  mockState.setReorderEditQty = jest.fn();
  mockState.clearReorderEdits = jest.fn();
});


function stockedItem(over: Partial<ReorderItem> & { itemId: string; itemName: string }): ReorderItem {
  return {
    unit: 'each',
    onHand: 37,
    pendingPoQty: 0,
    parLevel: 10,
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
  } as ReorderItem;
}

function seedPayload(items: ReorderItem[]) {
  mockState.reorderPayload = {
    asOfDate: toISODate(new Date()),
    vendors: [vendor({ vendorId: 'v-1', items })],
    kpis: { vendorCount: 1, itemCount: items.length, totalEstimatedCost: 0, eodSourcedVendorCount: 1, stockFallbackVendorCount: 0 },
    warnings: [],
  };
}

describe('ReorderSection — spec 172 NO NEED display', () => {
  it('AC-36: a no_need row renders a "NO NEED" chip; other tokens are unchanged', () => {
    seedPayload([
      stockedItem({ itemId: 'nn', itemName: 'Napkins', flags: ['no_need', 'no_usage_rate'] }),
    ]);
    render(<ReorderSection />);
    expandAllVendorCards();
    expect(screen.getByText('NO NEED')).toBeTruthy();
    expect(screen.getByText('NO USAGE')).toBeTruthy();
    // Not rendered as the raw token.
    expect(screen.queryByText('no_need')).toBeNull();
  });

  it('AC-38: the on-hand figure is replaced by the NO NEED label for the flagged row only', () => {
    seedPayload([
      stockedItem({ itemId: 'nn', itemName: 'Napkins', onHand: 37, flags: ['no_need'] }),
      stockedItem({ itemId: 'ok', itemName: 'Cups', onHand: 55 }),
    ]);
    render(<ReorderSection />);
    expandAllVendorCards();
    const nn = screen.getByTestId('reorder-vendor-item-nn');
    const ok = screen.getByTestId('reorder-vendor-item-ok');
    const textOf = (n: any): string =>
      (n.children || []).map((c: any) => (typeof c === 'string' ? c : textOf(c))).join('');
    // useT is a key-echo mock → the localized label renders as its key.
    expect(textOf(nn)).toContain('section.reorder.noNeed');
    expect(textOf(nn)).not.toContain('37 each');
    expect(textOf(ok)).toContain('55 each');
    expect(textOf(ok)).not.toContain('section.reorder.noNeed');
  });
});
