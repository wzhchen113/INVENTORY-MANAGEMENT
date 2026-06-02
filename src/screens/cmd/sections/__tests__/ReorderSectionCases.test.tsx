// src/screens/cmd/sections/__tests__/ReorderSectionCases.test.tsx — Spec 088.
//
// Case-based "Suggested" display: items WITH a case size (`caseQty > 1`,
// server sets `suggestedCases` non-null) render `N cases · M unit`; items
// without a case size render the unchanged `{suggestedQty} {unit}`. The cost
// is rounded SERVER-side (Decision B) and rides on `estimatedCost` /
// `vendorTotalCost` — the FE does NO cost math, so these tests assert the FE
// reads the server-authoritative values verbatim and that the "EST. TOTAL ==
// sum of visible per-row Est $" invariant holds through `computeReorderKpis`.
//
// Three layers covered:
//   1. Pure helpers (`formatSuggested`, `formatSuggestedPdf`, `buildReorderCsv`)
//      — ceil display incl. exact-multiple + just-over, singular/plural,
//      no-case-size unchanged, CSV columns.
//   2. Section render — the SUGGESTED column + the `order:` breakdown sub-line
//      agree (never disagree, per the AC).
//   3. KPI invariant — `computeReorderKpis(primary).totalEstimatedCost` equals
//      the sum of visible per-row `estimatedCost`, including after a spec-087
//      day filter.
//
// Boundary mocking mirrors ReorderSection.test.tsx (spec 087): mock
// useCmdColors / useT / useStore / TabStrip / StatCard so the section renders
// headless.

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
  };
  const fn: any = jest.fn((selector: (s: any) => any) => selector(state));
  fn.getState = () => state;
  fn.__state = state;
  return { useStore: fn };
});

import React from 'react';
import { render, screen } from '@testing-library/react-native';
import { toISODate } from '../../../../utils/reportDates';
import { computeReorderKpis } from '../../../../utils/reorderDayFilter';
import { ReorderItem, ReorderVendor } from '../../../../types';
import ReorderSection, {
  formatSuggested,
  formatSuggestedPdf,
  buildReorderCsv,
} from '../ReorderSection';
import { useStore } from '../../../../store/useStore';

const mockState = (useStore as any).__state as Record<string, any>;

// Build a per-item fixture shaped like the report payload AFTER mapping. The
// server is the source of truth for `suggestedCases` / `suggestedUnits` /
// `estimatedCost`; the FE only formats. For a case item we pass the values
// the server WOULD produce (ceil(suggested/case)·case·cost) so the tests pin
// the FE's display + read-through behavior, not a re-derivation.
function caseItem(over: {
  itemId?: string;
  itemName?: string;
  unit?: string;
  suggestedQty: number;
  caseQty: number;
  costPerUnit?: number;
}): ReorderItem {
  const cost = over.costPerUnit ?? 1;
  const cases = Math.ceil(over.suggestedQty / over.caseQty); // server's ceil
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
    estimatedCost: orderedUnits * cost, // server case-rounded
    caseQty: over.caseQty,
    suggestedCases: cases,
    suggestedUnits: orderedUnits,
    flags: [],
  };
}

// A non-case item: server returns suggestedCases=null, suggestedUnits falls
// back to suggestedQty, estimatedCost = suggestedQty × costPerUnit.
function plainItem(over: {
  itemId?: string;
  itemName?: string;
  unit?: string;
  suggestedQty: number;
  caseQty?: number; // null/0/1 → no case size
  costPerUnit?: number;
}): ReorderItem {
  const cost = over.costPerUnit ?? 1;
  return {
    itemId: over.itemId ?? 'i-plain',
    itemName: over.itemName ?? 'Plain Item',
    unit: over.unit ?? 'gal',
    onHand: 0,
    pendingPoQty: 0,
    parLevel: over.suggestedQty,
    usageForecasted: 0,
    parReplacement: over.suggestedQty,
    suggestedQty: over.suggestedQty,
    costPerUnit: cost,
    estimatedCost: over.suggestedQty * cost,
    caseQty: over.caseQty ?? 1,
    suggestedCases: null,
    suggestedUnits: over.suggestedQty,
    flags: [],
  };
}

function vendor(over: { vendorId: string; items: ReorderItem[]; onHandSource?: 'eod' | 'stock' }): ReorderVendor {
  return {
    vendorId: over.vendorId,
    vendorName: over.vendorId,
    scheduleKnown: true,
    nextDeliveryDate: '2026-06-02',
    daysUntilNextDelivery: 1,
    onHandSource: over.onHandSource ?? 'eod',
    eodSubmittedAt: null,
    items: over.items,
    // Server rolls case-rounded per-item cost into vendor_total_cost — mirror
    // that here (the carrier the KPI invariant rests on).
    vendorTotalCost: over.items.reduce((acc, i) => acc + i.estimatedCost, 0),
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockState.currentStore = { id: 'store-1', name: 'Test Store' };
  // Schedule a vendor on EVERY weekday so the lone payload vendor always lands
  // in the PRIMARY set regardless of "today" — the case display is a pure
  // transform over the shown rows.
  const everyDay = [{ vendorId: 'v-1', vendorName: 'v-1', deliveryDay: 'Wednesday' }];
  mockState.orderSchedule = {
    Monday: everyDay, Tuesday: everyDay, Wednesday: everyDay, Thursday: everyDay,
    Friday: everyDay, Saturday: everyDay, Sunday: everyDay,
  };
  mockState.reorderPayload = null;
  mockState.reorderLoading = false;
  mockState.reorderError = null;
  mockState.loadReorderSuggestions = jest.fn();
});

describe('formatSuggested (cases·units display)', () => {
  it('renders cases · ordered units for a case item', () => {
    const item = caseItem({ suggestedQty: 72, caseQty: 24, unit: 'each' });
    expect(formatSuggested(item)).toBe('3 cases · 72 each');
  });

  it('ceil — just-over a multiple rounds up (49/24 → 3 cases · 72)', () => {
    const item = caseItem({ suggestedQty: 49, caseQty: 24, unit: 'each' });
    expect(item.suggestedCases).toBe(3);
    expect(formatSuggested(item)).toBe('3 cases · 72 each');
  });

  it('ceil — exact multiple does NOT add a spurious case (48/24 → 2 cases · 48)', () => {
    const item = caseItem({ suggestedQty: 48, caseQty: 24, unit: 'each' });
    expect(item.suggestedCases).toBe(2);
    expect(formatSuggested(item)).toBe('2 cases · 48 each');
  });

  it('singular copy at exactly one case (24/24 → 1 case · 24), never "1 cases"', () => {
    const item = caseItem({ suggestedQty: 24, caseQty: 24, unit: 'each' });
    expect(formatSuggested(item)).toBe('1 case · 24 each');
    expect(formatSuggested(item)).not.toMatch(/1 cases/);
  });

  it('no-case-size item renders {suggestedQty} {unit} unchanged (caseQty=1)', () => {
    const item = plainItem({ suggestedQty: 8, caseQty: 1, unit: 'gal' });
    expect(formatSuggested(item)).toBe('8 gal');
    expect(formatSuggested(item)).not.toMatch(/case/);
  });

  it('no-case-size item renders unchanged for caseQty null/0 (server suggestedCases=null)', () => {
    const nullCase = plainItem({ suggestedQty: 5, unit: 'lbs' });
    expect(formatSuggested(nullCase)).toBe('5 lbs');
    const zeroCase = plainItem({ suggestedQty: 5, caseQty: 0, unit: 'lbs' });
    expect(formatSuggested(zeroCase)).toBe('5 lbs');
  });

  it('drops trailing-zero decimals in the unit count via formatQty', () => {
    // suggestedUnits is whole here; assert a fractional base-unit non-case
    // qty still formats like today.
    const item = plainItem({ suggestedQty: 2.5, unit: 'gal' });
    expect(formatSuggested(item)).toBe('2.5 gal');
  });
});

describe('formatSuggestedPdf (compact print variant)', () => {
  it('uses the "cs" abbreviation for case items', () => {
    const item = caseItem({ suggestedQty: 49, caseQty: 24, unit: 'each' });
    expect(formatSuggestedPdf(item)).toBe('3 cs · 72 each');
  });
  it('renders plain for non-case items', () => {
    const item = plainItem({ suggestedQty: 8, unit: 'gal' });
    expect(formatSuggestedPdf(item)).toBe('8 gal');
  });
});

describe('Est $ is server-rounded (FE does no cost math)', () => {
  it('per-row estimatedCost equals ceil_cases × caseQty × costPerUnit', () => {
    // 49 units, case of 24, $2/unit → 3 cases → 72 units → $144.
    const item = caseItem({ suggestedQty: 49, caseQty: 24, costPerUnit: 2 });
    expect(item.estimatedCost).toBe(72 * 2);
    // The FE reads it verbatim — there is no FE recompute to assert beyond
    // the read-through, which the section + KPI tests below exercise.
  });
});

describe('buildReorderCsv (Cases / Units Per Case columns)', () => {
  function payloadWith(items: ReorderItem[]) {
    return {
      asOfDate: '2026-06-02',
      vendors: [vendor({ vendorId: 'v-1', items })],
      kpis: { vendorCount: 1, itemCount: items.length, totalEstimatedCost: 0, eodSourcedVendorCount: 1, stockFallbackVendorCount: 0 },
      warnings: [],
    };
  }

  it('emits Cases + Units Per Case columns in the header', () => {
    const csv = buildReorderCsv(payloadWith([caseItem({ suggestedQty: 49, caseQty: 24 })]));
    const header = csv.split('\n')[0];
    expect(header).toContain('Cases');
    expect(header).toContain('Units Per Case');
    // Ordering: Cases/Units Per Case immediately after Suggested Qty.
    expect(header).toMatch(/Suggested Qty,Cases,Units Per Case,Unit/);
  });

  it('case row: Suggested Qty = ordered units (M), Cases populated, Est. Cost case-rounded', () => {
    const csv = buildReorderCsv(payloadWith([caseItem({ suggestedQty: 49, caseQty: 24, costPerUnit: 1, itemName: 'Buns' })]));
    const line = csv.split('\n').find((l) => l.includes('Buns'))!;
    const cells = line.split(',');
    // columns: Vendor,Item Name,On Hand,Pending PO,Par Level,Suggested Qty,Cases,Units Per Case,Unit,Est. Cost,...
    expect(cells[5]).toBe('72'); // Suggested Qty = ordered units M
    expect(cells[6]).toBe('3');  // Cases
    expect(cells[7]).toBe('24'); // Units Per Case
    expect(cells[9]).toBe('72.00'); // Est. Cost = 72 × $1, server-rounded
  });

  it('non-case row is byte-for-byte unchanged: Suggested Qty = raw, Cases/Units Per Case empty', () => {
    const csv = buildReorderCsv(payloadWith([plainItem({ suggestedQty: 8, caseQty: 1, unit: 'gal', itemName: 'Oil' })]));
    const line = csv.split('\n').find((l) => l.includes('Oil'))!;
    const cells = line.split(',');
    expect(cells[5]).toBe('8'); // Suggested Qty = raw suggestedQty
    expect(cells[6]).toBe('');  // Cases empty
    expect(cells[7]).toBe('');  // Units Per Case empty
    expect(cells[8]).toBe('gal');
  });
});

describe('Section render — SUGGESTED column and order: sub-line agree', () => {
  it('shows the cases·units string in BOTH the suggested column and the breakdown order: line', () => {
    mockState.reorderPayload = {
      asOfDate: toISODate(new Date()),
      vendors: [vendor({ vendorId: 'v-1', items: [caseItem({ suggestedQty: 49, caseQty: 24, unit: 'each', itemName: 'Buns' })] })],
      kpis: { vendorCount: 1, itemCount: 1, totalEstimatedCost: 144, eodSourcedVendorCount: 1, stockFallbackVendorCount: 0 },
      warnings: [],
    };
    render(<ReorderSection />);
    // The SUGGESTED column renders the bare string; the order: line renders
    // it prefixed with `order: `. Both must contain `3 cases · 72 each`.
    const matches = screen.getAllByText(/3 cases · 72 each/);
    // One in the column cell, one inside the `order: …` breakdown line.
    expect(matches.length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText(/order: /)).toBeTruthy();
  });

  it('non-case item renders {qty} {unit} with no case wording', () => {
    mockState.reorderPayload = {
      asOfDate: toISODate(new Date()),
      vendors: [vendor({ vendorId: 'v-1', items: [plainItem({ suggestedQty: 8, caseQty: 1, unit: 'gal', itemName: 'Oil' })] })],
      kpis: { vendorCount: 1, itemCount: 1, totalEstimatedCost: 8, eodSourcedVendorCount: 1, stockFallbackVendorCount: 0 },
      warnings: [],
    };
    render(<ReorderSection />);
    expect(screen.getAllByText(/8 gal/).length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByText(/case/)).toBeNull();
  });
});

describe('EST. TOTAL invariant — KPI == sum of visible per-row Est $', () => {
  it('computeReorderKpis sums the case-rounded per-row estimatedCost (mixed case + non-case)', () => {
    const caseI = caseItem({ suggestedQty: 49, caseQty: 24, costPerUnit: 2 }); // 72 × 2 = 144
    const plainI = plainItem({ suggestedQty: 8, costPerUnit: 1.5 }); // 8 × 1.5 = 12
    const v1 = vendor({ vendorId: 'v-1', items: [caseI] });
    const v2 = vendor({ vendorId: 'v-2', items: [plainI], onHandSource: 'stock' });
    const primary = [v1, v2];

    const kpis = computeReorderKpis(primary);

    // The invariant: the KPI total equals the sum of every visible per-row
    // Est $ across the shown vendors.
    const sumOfRows = primary.reduce(
      (acc, v) => acc + v.items.reduce((a, i) => a + i.estimatedCost, 0),
      0,
    );
    expect(kpis.totalEstimatedCost).toBe(sumOfRows);
    expect(kpis.totalEstimatedCost).toBe(144 + 12);
  });

  it('holds after a spec-087 day filter drops a vendor (subset still balances)', () => {
    const caseI = caseItem({ suggestedQty: 24, caseQty: 24, costPerUnit: 3 }); // 1 case → 24 × 3 = 72
    const plainI = plainItem({ suggestedQty: 10, costPerUnit: 1 }); // 10
    const all = [
      vendor({ vendorId: 'v-keep', items: [caseI] }),
      vendor({ vendorId: 'v-drop', items: [plainI] }),
    ];
    // Simulate the day filter selecting only the first vendor.
    const filtered = all.filter((v) => v.vendorId === 'v-keep');

    const kpis = computeReorderKpis(filtered);
    const sumOfVisibleRows = filtered.reduce(
      (acc, v) => acc + v.items.reduce((a, i) => a + i.estimatedCost, 0),
      0,
    );
    expect(kpis.totalEstimatedCost).toBe(sumOfVisibleRows);
    expect(kpis.totalEstimatedCost).toBe(72); // only the kept vendor's case-rounded cost
  });
});
