// src/screens/cmd/sections/__tests__/ReorderSection.exportLanguagePrompt.spec183.test.tsx
// Spec 183 — the desktop Ordering-page export language prompt.
//
// Pins, at the three desktop export sites (Quick-order, CSV, PDF):
//   • AC-1/2/3   press opens the prompt; nothing is built / shared / recorded yet
//   • AC-4       a US Foods vendor's CSV opens NO prompt and exports at once;
//                PDF + Quick-order on that card still prompt
//   • AC-10/11/12 the picked locale reaches the builders
//   • AC-9       cancel → no record, no clear, no toast, no preview
//   • AC-14      ['record','clear'] on success only, through the prompt
//   • AC-15      snapshot + file come from the values at CONFIRM; a nulled
//                payload / switched store while the prompt is open → no-op
//   • AC-16      no second prompt / second export
//   • AC-8       setLocale never called
//
// Boundary mocks cloned from ReorderSection.recordExport.spec156 (web Platform,
// stubbed CSV builder, stubbed jspdf + jspdf-autotable, stubbed sharePo, mocked
// useStore), plus a partial mock of `utils/poQuickOrderText` to spy on
// `buildPoQuickOrderText` while keeping its real output.

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

jest.mock('../../../../utils/reorderExport', () => {
  const actual = jest.requireActual('../../../../utils/reorderExport');
  return { ...actual, buildReorderCsv: jest.fn(() => 'csv,data') };
});

// Real builder output, spied (AC-1: not called before confirm; AC-10: names).
jest.mock('../../../../utils/poQuickOrderText', () => {
  const actual = jest.requireActual('../../../../utils/poQuickOrderText');
  return { ...actual, buildPoQuickOrderText: jest.fn(actual.buildPoQuickOrderText) };
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
    recordExportedOrder: jest.fn(() => Promise.resolve('po-2')),
    setLocale: jest.fn(),
  };
  const fn: any = jest.fn((selector: (s: any) => any) => selector(state));
  fn.getState = () => state;
  fn.__state = state;
  return { useStore: fn };
});

import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react-native';
import Toast from 'react-native-toast-message';
import { toISODate } from '../../../../utils/reportDates';
import { buildReorderCsv } from '../../../../utils/reorderExport';
import { buildPoQuickOrderText } from '../../../../utils/poQuickOrderText';
import { sharePurchaseOrder } from '../../lib/sharePo';
import { ReorderItem, ReorderVendor } from '../../../../types';
import ReorderSection, { handlePdfExport, importVendorForCard } from '../ReorderSection';
import { useStore } from '../../../../store/useStore';

const mockState = (useStore as any).__state as Record<string, any>;

const settle = () => new Promise((r) => setTimeout(r, 0));
const expandAllVendorCards = () => {
  screen.getAllByTestId(/^reorder-vendor-toggle-/).forEach((t) => fireEvent.press(t));
};
const confirmExportPrompt = () => fireEvent.press(screen.getByTestId('export-lang-confirm'));
const cancelExportPrompt = () => fireEvent.press(screen.getByTestId('export-lang-cancel'));
const pickLocale = (loc: string) => fireEvent.press(screen.getByTestId(`export-lang-option-${loc}`));

function caseItem(over: {
  itemId: string;
  itemName: string;
  suggestedQty: number;
  caseQty: number;
  costPerUnit?: number;
}): ReorderItem {
  const cost = over.costPerUnit ?? 1;
  const cases = Math.ceil(over.suggestedQty / over.caseQty);
  const orderedUnits = cases * over.caseQty;
  return {
    itemId: over.itemId,
    itemName: over.itemName,
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

function vendor(vendorId: string, items: ReorderItem[]): ReorderVendor {
  return {
    vendorId,
    vendorName: vendorId,
    scheduleKnown: true,
    nextDeliveryDate: '2026-06-02',
    daysUntilNextDelivery: 1,
    onHandSource: 'eod',
    eodSubmittedAt: '2026-06-02T00:00:00Z',
    items,
    vendorTotalCost: items.reduce((a, i) => a + i.estimatedCost, 0),
  };
}

function everyDaySchedule(vendorId: string) {
  const entries = [{ vendorId, vendorName: vendorId, deliveryDay: 'Wednesday' }];
  return {
    Monday: entries, Tuesday: entries, Wednesday: entries, Thursday: entries,
    Friday: entries, Saturday: entries, Sunday: entries,
  };
}

/** v-1 with one MAPPED item (order code) and one UNMAPPED item (no code) that
 *  carries a Spanish name. */
function seed(asOfDate = toISODate(new Date())) {
  mockState.inventory = [
    { id: 'i-mapped', name: 'Fries', i18nNames: { es: 'Papas fritas' }, subUnitSize: 1, vendors: [{ vendorId: 'v-1', orderCode: 'OC-1' }] },
    { id: 'i-unmapped', name: 'Onions', i18nNames: { es: 'Cebollas', 'zh-CN': '洋葱' }, subUnitSize: 1, vendors: [{ vendorId: 'v-1' }] },
  ];
  mockState.reorderEdits = {};
  mockState.orderSchedule = everyDaySchedule('v-1');
  mockState.reorderPayload = {
    asOfDate,
    vendors: [vendor('v-1', [
      caseItem({ itemId: 'i-mapped', itemName: 'Fries', suggestedQty: 24, caseQty: 12 }),
      caseItem({ itemId: 'i-unmapped', itemName: 'Onions', suggestedQty: 10, caseQty: 10 }),
    ])],
    kpis: { vendorCount: 1, itemCount: 2, totalEstimatedCost: 34, eodSourcedVendorCount: 1, stockFallbackVendorCount: 0 },
    warnings: [],
  };
}

const usFoods = [{
  id: 'v-1', name: 'US FOODS', orderImportFormat: 'us_foods',
  importCustomerNumber: '123456', importDistributorNumber: '99', importDepartment: '1',
}];

const sharedText = (call = 0) => (sharePurchaseOrder as jest.Mock).mock.calls[call][0] as string;

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
  mockState.vendors = [];
  mockState.clearReorderEditsForVendor = jest.fn();
  mockState.recordExportedOrder = jest.fn(() => Promise.resolve('po-2'));
  mockState.setLocale = jest.fn();
  (buildReorderCsv as jest.Mock).mockImplementation(() => 'csv,data');
  (sharePurchaseOrder as jest.Mock).mockResolvedValue({ shared: true, previewText: 'x' });
  seed();
});

// ── AC-1 / AC-2 / AC-3 — the press only opens the prompt ────────────────────
describe('AC-1/2/3 — pressing an export opens the prompt; nothing runs yet', () => {
  it.each([
    ['quick-order', 'reorder-quick-order-v-1'],
    ['PDF', 'reorder-export-pdf-v-1'],
    ['generic CSV', 'reorder-export-csv-v-1'],
  ])('%s', async (_label, testID) => {
    const jsPDF = require('jspdf').default;
    const save = jest.spyOn(jsPDF.prototype, 'save');
    render(<ReorderSection />);
    expandAllVendorCards();
    fireEvent.press(screen.getByTestId(testID));
    expect(screen.getByTestId('export-lang-prompt')).toBeTruthy();
    await settle();
    expect(buildPoQuickOrderText).not.toHaveBeenCalled();
    expect(sharePurchaseOrder).not.toHaveBeenCalled();
    expect(buildReorderCsv).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
    expect(mockState.recordExportedOrder).not.toHaveBeenCalled();
    expect(mockState.clearReorderEditsForVendor).not.toHaveBeenCalled();
    save.mockRestore();
  });

  it('PDF offers EN / ES only; CSV and quick-order offer 中文 too (AC-5)', () => {
    render(<ReorderSection />);
    fireEvent.press(screen.getByTestId('reorder-export-pdf-v-1'));
    expect(screen.queryByTestId('export-lang-option-zh-CN')).toBeNull();
    expect(screen.getByTestId('export-lang-option-es')).toBeTruthy();
    cancelExportPrompt();
    fireEvent.press(screen.getByTestId('reorder-export-csv-v-1'));
    expect(screen.getByTestId('export-lang-option-zh-CN')).toBeTruthy();
    cancelExportPrompt();
    fireEvent.press(screen.getByTestId('reorder-quick-order-v-1'));
    expect(screen.getByTestId('export-lang-option-zh-CN')).toBeTruthy();
  });
});

// ── AC-4 — import-file skip ─────────────────────────────────────────────────
describe('AC-4 — a US Foods / SYSCO CSV skips the prompt', () => {
  it('CSV: no prompt, the import file goes out at once and records once', async () => {
    mockState.vendors = usFoods;
    render(<ReorderSection />);
    fireEvent.press(screen.getByTestId('reorder-export-csv-v-1'));
    expect(screen.queryByTestId('export-lang-prompt')).toBeNull();
    await waitFor(() => expect(mockState.recordExportedOrder).toHaveBeenCalledTimes(1));
    expect(buildReorderCsv).not.toHaveBeenCalled();
  });

  it('PDF and quick-order on the same card still prompt', () => {
    mockState.vendors = usFoods;
    render(<ReorderSection />);
    fireEvent.press(screen.getByTestId('reorder-export-pdf-v-1'));
    expect(screen.getByTestId('export-lang-prompt')).toBeTruthy();
    cancelExportPrompt();
    fireEvent.press(screen.getByTestId('reorder-quick-order-v-1'));
    expect(screen.getByTestId('export-lang-prompt')).toBeTruthy();
  });

  it('importVendorForCard — the shared press/run check: US Foods + SYSCO hit, a plain vendor misses', () => {
    const card = mockState.reorderPayload.vendors[0];
    expect(importVendorForCard(mockState.reorderPayload, card, usFoods as any)?.id).toBe('v-1');
    const sysco = [{ ...usFoods[0], orderImportFormat: 'sysco' }];
    expect(importVendorForCard(mockState.reorderPayload, card, sysco as any)?.id).toBe('v-1');
    expect(importVendorForCard(mockState.reorderPayload, card, [{ id: 'v-1', name: 'BJS' }] as any)).toBeUndefined();
  });
});

// ── AC-10 — quick-order names follow the picked locale ──────────────────────
describe('AC-10 — quick-order text uses the picked language', () => {
  it('ES: the unmapped line carries the Spanish name; mapped line identical to EN', async () => {
    render(<ReorderSection />);
    fireEvent.press(screen.getByTestId('reorder-quick-order-v-1'));
    confirmExportPrompt(); // default (UI locale undefined in this mock → en)
    await waitFor(() => expect(sharePurchaseOrder).toHaveBeenCalledTimes(1));
    const en = sharedText(0);

    fireEvent.press(screen.getByTestId('reorder-quick-order-v-1'));
    pickLocale('es');
    confirmExportPrompt();
    await waitFor(() => expect(sharePurchaseOrder).toHaveBeenCalledTimes(2));
    const es = sharedText(1);

    expect(en).toContain('??? Onions');
    expect(es).toContain('??? Cebollas');
    expect(es).not.toContain('Onions');
    const mappedEn = en.split('\n').find((l) => l.startsWith('OC-1'));
    const mappedEs = es.split('\n').find((l) => l.startsWith('OC-1'));
    expect(mappedEn).toBe('OC-1\t2');
    expect(mappedEs).toBe(mappedEn);
  });

  it('中文 is offered and applied for quick-order', async () => {
    render(<ReorderSection />);
    fireEvent.press(screen.getByTestId('reorder-quick-order-v-1'));
    pickLocale('zh-CN');
    confirmExportPrompt();
    await waitFor(() => expect(sharePurchaseOrder).toHaveBeenCalledTimes(1));
    expect(sharedText()).toContain('??? 洋葱');
  });
});

// ── AC-11 — CSV gets the picked locale ──────────────────────────────────────
describe('AC-11 — handleCsvExport receives the picked locale', () => {
  it("default confirm → 'en'", () => {
    render(<ReorderSection />);
    fireEvent.press(screen.getByTestId('reorder-export-csv-v-1'));
    confirmExportPrompt();
    expect(buildReorderCsv).toHaveBeenCalledTimes(1);
    expect((buildReorderCsv as jest.Mock).mock.calls[0][1]).toBe('en');
  });

  it("ES pick → 'es'", () => {
    render(<ReorderSection />);
    fireEvent.press(screen.getByTestId('reorder-export-csv-v-1'));
    pickLocale('es');
    confirmExportPrompt();
    expect((buildReorderCsv as jest.Mock).mock.calls[0][1]).toBe('es');
  });
});

// ── AC-12 — PDF gets the picked locale ──────────────────────────────────────
describe('AC-12 — handlePdfExport receives the picked locale', () => {
  it('ES pick → the Spanish PDF title is drawn', async () => {
    const jsPDF = require('jspdf').default;
    const text = jest.spyOn(jsPDF.prototype, 'text');
    render(<ReorderSection />);
    fireEvent.press(screen.getByTestId('reorder-export-pdf-v-1'));
    pickLocale('es');
    confirmExportPrompt();
    await waitFor(() => expect(mockState.recordExportedOrder).toHaveBeenCalledTimes(1));
    const drawn = text.mock.calls.map((c) => c[0]);
    expect(drawn).toContain('Sugerencias de pedido por proveedor');
    expect(drawn).not.toContain('Per-Vendor Reorder Suggestions');
    text.mockRestore();
  });

  it('defense in depth: handlePdfExport still coerces zh-CN → en', async () => {
    const jsPDF = require('jspdf').default;
    const text = jest.spyOn(jsPDF.prototype, 'text');
    const ok = await handlePdfExport(mockState.reorderPayload, mockState.currentStore, 'zh-CN');
    expect(ok).toBe(true);
    expect(text.mock.calls.map((c) => c[0])).toContain('Per-Vendor Reorder Suggestions');
    text.mockRestore();
  });
});

// ── AC-9 — cancel is a no-op at every site ──────────────────────────────────
describe('AC-9 — cancel has no side effects', () => {
  it.each([
    ['quick-order', 'reorder-quick-order-v-1'],
    ['PDF', 'reorder-export-pdf-v-1'],
    ['generic CSV', 'reorder-export-csv-v-1'],
  ])('%s', async (_label, testID) => {
    render(<ReorderSection />);
    expandAllVendorCards();
    fireEvent.press(screen.getByTestId(testID));
    cancelExportPrompt();
    await settle();
    expect(screen.queryByTestId('export-lang-prompt')).toBeNull();
    expect(sharePurchaseOrder).not.toHaveBeenCalled();
    expect(buildReorderCsv).not.toHaveBeenCalled();
    expect(mockState.recordExportedOrder).not.toHaveBeenCalled();
    expect(mockState.clearReorderEditsForVendor).not.toHaveBeenCalled();
    expect(Toast.show).not.toHaveBeenCalled();
    expect(screen.queryByTestId('reorder-quick-order-preview-v-1')).toBeNull();
  });
});

// ── AC-14 — record → clear on success only, through the prompt ──────────────
describe('AC-14 — record then clear on success only', () => {
  const ordered = () => {
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

  it.each([
    ['quick-order', 'reorder-quick-order-v-1'],
    ['PDF', 'reorder-export-pdf-v-1'],
    ['generic CSV', 'reorder-export-csv-v-1'],
  ])('%s success → ["record","clear"]', async (_label, testID) => {
    const calls = ordered();
    render(<ReorderSection />);
    fireEvent.press(screen.getByTestId(testID));
    confirmExportPrompt();
    await waitFor(() => expect(calls).toEqual(['record', 'clear']));
  });

  it('quick-order dismissed share → nothing', async () => {
    const calls = ordered();
    (sharePurchaseOrder as jest.Mock).mockResolvedValueOnce({ shared: false, previewText: null });
    render(<ReorderSection />);
    fireEvent.press(screen.getByTestId('reorder-quick-order-v-1'));
    confirmExportPrompt();
    await settle();
    expect(calls).toEqual([]);
  });

  it('CSV failure → nothing', async () => {
    const calls = ordered();
    (buildReorderCsv as jest.Mock).mockImplementationOnce(() => {
      throw new Error('csv boom');
    });
    render(<ReorderSection />);
    fireEvent.press(screen.getByTestId('reorder-export-csv-v-1'));
    confirmExportPrompt();
    await settle();
    expect(calls).toEqual([]);
  });

  it('PDF failure → nothing', async () => {
    const calls = ordered();
    const jsPDF = require('jspdf').default;
    const spy = jest.spyOn(jsPDF.prototype, 'save').mockImplementationOnce(() => {
      throw new Error('pdf boom');
    });
    render(<ReorderSection />);
    fireEvent.press(screen.getByTestId('reorder-export-pdf-v-1'));
    confirmExportPrompt();
    await settle();
    expect(calls).toEqual([]);
    spy.mockRestore();
  });
});

// ── AC-15 — the snapshot is taken at CONFIRM, from the file's own values ────
describe('AC-15 — snapshot-before-await, at confirm', () => {
  it('(a) a payload replaced while the prompt is open: record + file both use the NEW payload', async () => {
    render(<ReorderSection />);
    fireEvent.press(screen.getByTestId('reorder-export-csv-v-1'));
    const newDate = '2026-01-07';
    seed(newDate);
    screen.rerender(<ReorderSection />);
    confirmExportPrompt();
    await waitFor(() => expect(mockState.recordExportedOrder).toHaveBeenCalledTimes(1));
    expect(mockState.recordExportedOrder.mock.calls[0][1]).toEqual({ storeId: 'store-1', referenceDate: newDate });
    expect((buildReorderCsv as jest.Mock).mock.calls[0][0].asOfDate).toBe(newDate);
  });

  it('(b) payload nulled while the prompt is open → prompt gone, nothing runs', async () => {
    render(<ReorderSection />);
    fireEvent.press(screen.getByTestId('reorder-quick-order-v-1'));
    expect(screen.getByTestId('export-lang-prompt')).toBeTruthy();
    mockState.reorderPayload = null;
    screen.rerender(<ReorderSection />);
    expect(screen.queryByTestId('export-lang-prompt')).toBeNull();
    await settle();
    expect(sharePurchaseOrder).not.toHaveBeenCalled();
    expect(mockState.recordExportedOrder).not.toHaveBeenCalled();
    expect(mockState.clearReorderEditsForVendor).not.toHaveBeenCalled();
  });

  it('(c) store switched while the prompt is open → prompt auto-dismisses, nothing runs', async () => {
    render(<ReorderSection />);
    fireEvent.press(screen.getByTestId('reorder-export-pdf-v-1'));
    expect(screen.getByTestId('export-lang-prompt')).toBeTruthy();
    mockState.currentStore = { id: 'store-2', name: 'Other Store' };
    screen.rerender(<ReorderSection />);
    expect(screen.queryByTestId('export-lang-prompt')).toBeNull();
    await settle();
    expect(mockState.recordExportedOrder).not.toHaveBeenCalled();
    expect(mockState.clearReorderEditsForVendor).not.toHaveBeenCalled();
  });
});

// ── AC-16 — no double-fire ──────────────────────────────────────────────────
describe('AC-16 — no second prompt / second export', () => {
  it('a second quick-order press while the prompt is open → still one prompt', () => {
    render(<ReorderSection />);
    fireEvent.press(screen.getByTestId('reorder-quick-order-v-1'));
    fireEvent.press(screen.getByTestId('reorder-quick-order-v-1'));
    expect(screen.getAllByTestId('export-lang-prompt')).toHaveLength(1);
  });

  it('a held share + another quick-order press → no new prompt, no second share', async () => {
    let release: (v: any) => void = () => {};
    (sharePurchaseOrder as jest.Mock).mockImplementationOnce(
      () => new Promise((r) => { release = r; }),
    );
    render(<ReorderSection />);
    fireEvent.press(screen.getByTestId('reorder-quick-order-v-1'));
    confirmExportPrompt();
    await waitFor(() => expect(sharePurchaseOrder).toHaveBeenCalledTimes(1));
    fireEvent.press(screen.getByTestId('reorder-quick-order-v-1'));
    expect(screen.queryByTestId('export-lang-prompt')).toBeNull();
    release({ shared: true, previewText: 'x' });
    await waitFor(() => expect(mockState.recordExportedOrder).toHaveBeenCalledTimes(1));
    expect(sharePurchaseOrder).toHaveBeenCalledTimes(1);
  });
});

// ── AC-8 — export-scoped ────────────────────────────────────────────────────
describe('AC-8 — the app locale is never changed', () => {
  it('pick + confirm at all three sites never calls setLocale', async () => {
    render(<ReorderSection />);
    for (const id of ['reorder-quick-order-v-1', 'reorder-export-csv-v-1', 'reorder-export-pdf-v-1']) {
      fireEvent.press(screen.getByTestId(id));
      pickLocale('es');
      confirmExportPrompt();
      await settle();
    }
    expect(mockState.setLocale).not.toHaveBeenCalled();
  });
});

// ── AC-13 — chrome around the file stays in the UI language ─────────────────
// Added by test-engineer (spec 183 review). The `useT` mock above is
// language-agnostic (returns the key), so picking ES must leave every chrome
// string equal to the same key a default-en confirm produces; a regression that
// routed chrome through a picked-locale translator would surface Spanish text
// (or a different value) here.
describe('AC-13 — dialog title, preview note, warning toasts and filename stay in the UI language', () => {
  it('quick-order: ES pick leaves the share dialog title, unitNote and warning toasts on the UI-language keys', async () => {
    render(<ReorderSection />);
    fireEvent.press(screen.getByTestId('reorder-quick-order-v-1'));
    pickLocale('es');
    confirmExportPrompt();
    await waitFor(() => expect(sharePurchaseOrder).toHaveBeenCalledTimes(1));
    const opts = (sharePurchaseOrder as jest.Mock).mock.calls[0][1];
    expect(opts.dialogTitle).toBe('section.purchaseOrders.quickOrderDialogTitle');
    await waitFor(() => expect(screen.getByTestId('reorder-quick-order-preview-v-1')).toBeTruthy());
    expect(screen.getByText('section.purchaseOrders.quickOrderCountingInCases')).toBeTruthy();
    // The unmapped Onions line fires the unmapped warning in the UI language.
    expect(Toast.show).toHaveBeenCalledWith(
      expect.objectContaining({ text1: 'section.purchaseOrders.quickOrderUnmappedWarning' }),
    );
  });

  it('CSV: the filename + success toast are identical for an ES pick and a default confirm', async () => {
    render(<ReorderSection />);
    fireEvent.press(screen.getByTestId('reorder-export-csv-v-1'));
    confirmExportPrompt();
    await settle();
    const first = (Toast.show as jest.Mock).mock.calls.map((c) => c[0]);

    (Toast.show as jest.Mock).mockClear();
    fireEvent.press(screen.getByTestId('reorder-export-csv-v-1'));
    pickLocale('es');
    confirmExportPrompt();
    await settle();
    const second = (Toast.show as jest.Mock).mock.calls.map((c) => c[0]);

    expect(first.length).toBeGreaterThan(0);
    expect(second).toEqual(first);
    expect(second[0].text2).toMatch(/^IMR_Reorder_.*\.csv$/);
  });
});
