// src/screens/cmd/sections/__tests__/ReorderSection.spec138.test.tsx — Spec 138.
//
// Inline case-quantity editing + the buffer overlay:
//   1. `applyReorderEdits` (pure) — the buffer base replaces the suggestion and
//      recomputes est-$ via the LOAD-BEARING per-EACH → per-COUNTED-unit bridge
//      (`base × costPerUnit × subUnitSize`) on a `subUnitSize > 1` case row.
//   2. Inline edit → `poResolveEdit` (cases) → `setReorderEditQty` writes the
//      BASE-unit qty (cases × caseQty).
//   3. The edited qty flows into the card breakdown, est-$ / KPI, AND the CSV
//      export (the builder receives the buffer-overridden vendor).
//
// Boundary mocking mirrors ReorderSection.spec123 (web Platform + stubbed CSV
// builder so the export press is assertable without the DOM download path).

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
import { buildReorderCsv } from '../../../../utils/reorderExport';
import { ReorderItem, ReorderVendor } from '../../../../types';
import ReorderSection, { applyReorderEdits } from '../ReorderSection';
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

describe('applyReorderEdits (pure buffer overlay + est-$ bridge)', () => {
  const subUnit4 = () => 4;

  it('recomputes est-$ = base × costPerUnit × subUnitSize on a subUnitSize>1 case row', () => {
    const item = caseItem({ suggestedQty: 49, caseQty: 24, costPerUnit: 2, itemId: 'i-case' });
    const v = vendor({ vendorId: 'v-1', items: [item] });
    // Edit to 5 cases → base 120.
    const out = applyReorderEdits(v, { 'i-case': 120 }, subUnit4);
    const edited = out.items[0];
    expect(edited.suggestedUnits).toBe(120);
    expect(edited.suggestedQty).toBe(120);
    expect(edited.suggestedCases).toBe(120 / 24); // 5
    // ★ the load-bearing per-each → per-counted-unit bridge.
    expect(edited.estimatedCost).toBe(120 * 2 * 4);
    expect(out.vendorTotalCost).toBe(120 * 2 * 4);
  });

  it('returns the vendor UNCHANGED when there is no edit for it (server est-$ preserved)', () => {
    const item = caseItem({ suggestedQty: 49, caseQty: 24, costPerUnit: 2 });
    const v = vendor({ vendorId: 'v-1', items: [item] });
    expect(applyReorderEdits(v, undefined, subUnit4)).toBe(v);
    expect(applyReorderEdits(v, {}, subUnit4)).toBe(v);
    // An untouched item inside an edited vendor keeps its server est-$.
    const two = vendor({ vendorId: 'v-1', items: [item, caseItem({ itemId: 'other', suggestedQty: 24, caseQty: 24, costPerUnit: 3 })] });
    const out = applyReorderEdits(two, { other: 48 }, subUnit4);
    expect(out.items[0].estimatedCost).toBe(item.estimatedCost); // untouched, verbatim
    expect(out.items[1].estimatedCost).toBe(48 * 3 * 4); // edited, bridged
  });
});

describe('Inline edit → poResolveEdit → setReorderEditQty (cases)', () => {
  it('typing a new case count writes base = cases × caseQty to the buffer', () => {
    mockState.inventory = [{ id: 'i-case', subUnitSize: 1 }];
    mockState.reorderPayload = {
      asOfDate: toISODate(new Date()),
      vendors: [vendor({ vendorId: 'v-1', items: [caseItem({ suggestedQty: 72, caseQty: 24, itemId: 'i-case' })] })],
      kpis: { vendorCount: 1, itemCount: 1, totalEstimatedCost: 72, eodSourcedVendorCount: 1, stockFallbackVendorCount: 0 },
      warnings: [],
    };
    render(<ReorderSection />);
    expandAllVendorCards();

    const input = screen.getByTestId('reorder-ordered-i-case');
    // Seed is 3 cases (72/24). Type 5 → base 5 × 24 = 120.
    fireEvent(input, 'endEditing', { nativeEvent: { text: '5' } });
    expect(mockState.setReorderEditQty).toHaveBeenCalledWith('v-1', 'i-case', 120);
  });

  it('re-typing the seed value is a no-op (no buffer write)', () => {
    mockState.inventory = [{ id: 'i-case', subUnitSize: 1 }];
    mockState.reorderPayload = {
      asOfDate: toISODate(new Date()),
      vendors: [vendor({ vendorId: 'v-1', items: [caseItem({ suggestedQty: 72, caseQty: 24, itemId: 'i-case' })] })],
      kpis: { vendorCount: 1, itemCount: 1, totalEstimatedCost: 72, eodSourcedVendorCount: 1, stockFallbackVendorCount: 0 },
      warnings: [],
    };
    render(<ReorderSection />);
    expandAllVendorCards();
    const input = screen.getByTestId('reorder-ordered-i-case');
    fireEvent(input, 'endEditing', { nativeEvent: { text: '3' } }); // == seed
    expect(mockState.setReorderEditQty).not.toHaveBeenCalled();
  });
});

describe('Edited qty flows to display + CSV export', () => {
  it('renders the edited cases·units in the breakdown and feeds CSV the overridden vendor', () => {
    // Buffer already holds an edit: 5 cases → base 120. subUnitSize 4, cost $2.
    mockState.inventory = [{ id: 'i-case', subUnitSize: 4 }];
    mockState.reorderEdits = { 'v-1': { 'i-case': 120 } };
    mockState.reorderPayload = {
      asOfDate: toISODate(new Date()),
      vendors: [vendor({ vendorId: 'v-1', items: [caseItem({ suggestedQty: 49, caseQty: 24, costPerUnit: 2, itemId: 'i-case', itemName: 'Buns' })] })],
      kpis: { vendorCount: 1, itemCount: 1, totalEstimatedCost: 144, eodSourcedVendorCount: 1, stockFallbackVendorCount: 0 },
      warnings: [],
    };
    render(<ReorderSection />);
    expandAllVendorCards();

    // Breakdown reflects the edited 5 cases · 120 each (not the server 3 · 72).
    expect(screen.getAllByText(/5 cases · 120 each/).length).toBeGreaterThanOrEqual(1);

    // CSV export receives the buffer-overridden vendor.
    fireEvent.press(screen.getByTestId('reorder-export-csv-v-1'));
    expect(buildReorderCsv).toHaveBeenCalledTimes(1);
    const passed = (buildReorderCsv as jest.Mock).mock.calls[0][0];
    expect(passed.vendors[0].items[0].suggestedUnits).toBe(120);
    expect(passed.vendors[0].items[0].estimatedCost).toBe(120 * 2 * 4);
  });
});
