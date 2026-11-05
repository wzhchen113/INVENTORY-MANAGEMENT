// src/screens/cmd/sections/phone/__tests__/PhoneOrdering.exportLanguagePrompt.spec183.test.tsx
// Spec 183 — the phone Ordering overflow sheet's export language prompt.
//
// Pins:
//   • AC-17/AC-19 web: Quick-order / CSV / PDF → the ··· sheet is gone, the
//     prompt is up (hosted by the PhoneOrdering root, so it outlives the sheet),
//     nothing ran before confirm, confirm runs with the picked locale.
//   • native: Quick-order prompts only after PHONE_SHEET_HANDOFF_MS, then
//     confirm → share. CSV / PDF → `availableOnDesktop` toast, no prompt ever
//     (AC-18), even after the timers run.
//   • AC-4 a US Foods vendor's CSV opens no prompt.
//   • a store switch while the prompt is open closes it; nothing recorded.
//   • cancel is a no-op (AC-9).
//   • zh-CN UI + PDF → EN selected, no 中文 segment (AC-5/AC-6).
//   • the hook-order rule: the new hooks sit above the no-store early return.
//
// Mocking cloned from PhoneOrdering.recordExport.spec156 (REAL store slices via
// useStore.setState, stubbed supabase/db, forced phone breakpoint, stubbed
// export I/O boundary).

import React from 'react';
import { render, fireEvent, waitFor, act } from '@testing-library/react-native';

jest.mock('react-native/Libraries/Utilities/Platform', () => ({
  __esModule: true,
  default: { OS: 'web', select: (obj: any) => obj.web ?? obj.default },
  OS: 'web',
}));

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, left: 0, right: 0, bottom: 0 }),
}));

jest.mock('react-native-toast-message', () => ({
  __esModule: true,
  default: { show: jest.fn(), hide: jest.fn() },
}));

jest.mock('../../../../../lib/supabase', () => ({
  __esModule: true,
  supabase: {
    auth: {
      getSession: jest.fn(() => Promise.resolve({ data: { session: null }, error: null })),
      onAuthStateChange: jest.fn(() => ({ data: { subscription: { unsubscribe: jest.fn() } } })),
    },
    from: jest.fn(() => ({ select: jest.fn().mockReturnThis(), eq: jest.fn().mockReturnThis(), order: jest.fn().mockReturnThis(), single: jest.fn(() => Promise.resolve({ data: null, error: null })), maybeSingle: jest.fn(() => Promise.resolve({ data: null, error: null })) })),
    rpc: jest.fn(() => Promise.resolve({ data: null, error: null })),
    channel: jest.fn(() => ({ on: jest.fn().mockReturnThis(), subscribe: jest.fn(() => ({ unsubscribe: jest.fn() })) })),
    removeChannel: jest.fn(),
    functions: { invoke: jest.fn() },
  },
}));

jest.mock('../../../../../lib/db', () =>
  new Proxy({ __esModule: true }, { get: (t: Record<string, unknown>, p: string) => (p in t ? (t as any)[p] : jest.fn(() => Promise.resolve(null))) }),
);

jest.mock('../../../../../theme/breakpoints', () => {
  const actual = jest.requireActual('../../../../../theme/breakpoints');
  return { ...actual, useIsPhone: () => true, useIsTablet: () => false, useIsDesktop: () => false, useIsCompact: () => true, useBreakpoint: () => 'phone' };
});

jest.mock('../../../../../utils/reorderExport', () => {
  const actual = jest.requireActual('../../../../../utils/reorderExport');
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

jest.mock('../../../lib/sharePo', () => ({
  sharePurchaseOrder: jest.fn(() => Promise.resolve({ shared: true, previewText: 'x' })),
}));

import RNPlatform from 'react-native/Libraries/Utilities/Platform';
import { PhoneOrdering, PHONE_SHEET_HANDOFF_MS } from '../PhoneOrdering';
import { useStore } from '../../../../../store/useStore';
import { usePaletteAction } from '../../../../../lib/paletteAction';
import { buildReorderCsv } from '../../../../../utils/reorderExport';
import { sharePurchaseOrder } from '../../../lib/sharePo';
import Toast from 'react-native-toast-message';

const mockPlatform = RNPlatform as unknown as { OS: string };

function todayIso(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function item(over: Record<string, any>): any {
  return {
    itemId: over.itemId, itemName: over.itemName ?? over.itemId, unit: over.unit ?? 'lbs',
    onHand: 0, pendingPoQty: 0, parLevel: 100, usageForecasted: 0, parReplacement: 0,
    suggestedQty: over.suggestedUnits ?? 20, costPerUnit: over.costPerUnit ?? 3,
    estimatedCost: over.estimatedCost ?? 60, caseQty: over.caseQty ?? 5,
    suggestedCases: over.suggestedCases ?? 4, suggestedUnits: over.suggestedUnits ?? 20,
    flags: [], ...over,
  };
}

function vendor(over: Record<string, any>): any {
  return {
    vendorId: over.vendorId, vendorName: over.vendorName, scheduleKnown: true,
    nextDeliveryDate: todayIso(), daysUntilNextDelivery: 1,
    onHandSource: over.onHandSource ?? 'eod', eodSubmittedAt: over.eodSubmittedAt ?? null,
    items: over.items ?? [], vendorTotalCost: over.vendorTotalCost ?? 0,
  };
}

function everyDay(vendorIds: string[]) {
  const entries = vendorIds.map((id) => ({ vendorId: id, vendorName: id, deliveryDay: 'Monday' }));
  return { Monday: entries, Tuesday: entries, Wednesday: entries, Thursday: entries, Friday: entries, Saturday: entries, Sunday: entries };
}

const counted = vendor({
  vendorId: 'v-a', vendorName: 'Counted Co', onHandSource: 'eod', eodSubmittedAt: `${todayIso()}T18:00:00Z`,
  items: [item({ itemId: 'a1', itemName: 'French Fries', caseQty: 5, suggestedUnits: 20, estimatedCost: 60, costPerUnit: 3 })],
  vendorTotalCost: 60,
});

const calls: string[] = [];
let recordMock: jest.Mock;
let clearMock: jest.Mock;
let setLocaleMock: jest.Mock;

function seed(vendorsSlice?: any[]) {
  recordMock = jest.fn(() => {
    calls.push('record');
    return Promise.resolve('po-2');
  });
  clearMock = jest.fn(() => {
    calls.push('clear');
  });
  setLocaleMock = jest.fn();
  useStore.setState({
    currentStore: { id: 'store-1', brandId: 'b', name: 'F', address: '', status: 'active' } as any,
    orderSchedule: everyDay(['v-a']) as any,
    reorderPayload: {
      asOfDate: todayIso(),
      vendors: [counted],
      kpis: { vendorCount: 1, itemCount: 1, totalEstimatedCost: 60, eodSourcedVendorCount: 1, stockFallbackVendorCount: 0 },
      warnings: [],
    } as any,
    reorderLoading: false,
    reorderError: null,
    reorderEdits: {},
    locale: 'en',
    setLocale: setLocaleMock as any,
    vendors: (vendorsSlice ?? [{ id: 'v-a', extensionOrdering: true, orderUnit: 'case' }]) as any,
    // Unmapped (no order code) so the quick-order text carries the item NAME.
    inventory: [{ id: 'a1', name: 'French Fries', i18nNames: { es: 'Papas fritas' }, subUnitSize: 1, vendors: [{ vendorId: 'v-a' }] } as any],
    recordExportedOrder: recordMock as any,
    clearReorderEditsForVendor: clearMock as any,
  });
}

beforeAll(() => {
  (global as any).Blob = class {};
  const w = (global as any).window ?? ((global as any).window = {});
  w.URL = { createObjectURL: () => 'blob:x', revokeObjectURL: () => {} };
});

beforeEach(() => {
  jest.clearAllMocks();
  calls.length = 0;
  mockPlatform.OS = 'web';
  usePaletteAction.getState().consume();
  (buildReorderCsv as jest.Mock).mockImplementation(() => 'csv,data');
  (sharePurchaseOrder as jest.Mock).mockResolvedValue({ shared: true, previewText: 'x' });
  seed();
});

const settle = () => new Promise((r) => setTimeout(r, 0));

/** Open the ··· sheet for v-a and press one of its actions (no confirm). */
function openAndPress(testID: string) {
  const view = render(<PhoneOrdering />);
  fireEvent.press(view.getByTestId('phone-order-more-v-a'));
  fireEvent.press(view.getByTestId(testID));
  return view;
}

// ── Web: all three prompt, after the sheet closes (AC-17 / AC-19) ───────────
describe('web — the prompt outlives the ··· sheet and gates every export', () => {
  it.each([
    ['quick-order', 'phone-order-sheet-quick'],
    ['CSV', 'phone-order-sheet-csv'],
    ['PDF', 'phone-order-sheet-pdf'],
  ])('%s: sheet gone, prompt up, nothing ran yet', async (_label, testID) => {
    const view = openAndPress(testID);
    expect(view.queryByTestId('phone-order-sheet-quick')).toBeNull();
    expect(view.getByTestId('export-lang-prompt')).toBeTruthy();
    await settle();
    expect(sharePurchaseOrder).not.toHaveBeenCalled();
    expect(buildReorderCsv).not.toHaveBeenCalled();
    expect(recordMock).not.toHaveBeenCalled();
    expect(clearMock).not.toHaveBeenCalled();
  });

  it('quick-order: confirm with ES → the shared text carries the Spanish name; record → clear', async () => {
    const view = openAndPress('phone-order-sheet-quick');
    fireEvent.press(view.getByTestId('export-lang-option-es'));
    fireEvent.press(view.getByTestId('export-lang-confirm'));
    await waitFor(() => expect(recordMock).toHaveBeenCalledTimes(1));
    expect((sharePurchaseOrder as jest.Mock).mock.calls[0][0]).toContain('Papas fritas');
    expect(calls).toEqual(['record', 'clear']);
    expect(view.queryByTestId('export-lang-prompt')).toBeNull();
  });

  it("CSV: confirm with ES → buildReorderCsv gets 'es'; snapshot is store-1 + as-of", async () => {
    const view = openAndPress('phone-order-sheet-csv');
    fireEvent.press(view.getByTestId('export-lang-option-es'));
    fireEvent.press(view.getByTestId('export-lang-confirm'));
    expect((buildReorderCsv as jest.Mock).mock.calls[0][1]).toBe('es');
    await waitFor(() => expect(recordMock).toHaveBeenCalledTimes(1));
    expect(recordMock.mock.calls[0][1]).toEqual({ storeId: 'store-1', referenceDate: todayIso() });
    expect(calls).toEqual(['record', 'clear']);
  });

  it('PDF: confirm → records once, record before clear', async () => {
    const view = openAndPress('phone-order-sheet-pdf');
    fireEvent.press(view.getByTestId('export-lang-confirm'));
    await waitFor(() => expect(recordMock).toHaveBeenCalledTimes(1));
    expect(calls).toEqual(['record', 'clear']);
  });

  it('setLocale is never called (AC-8)', async () => {
    const view = openAndPress('phone-order-sheet-csv');
    fireEvent.press(view.getByTestId('export-lang-option-zh-CN'));
    fireEvent.press(view.getByTestId('export-lang-confirm'));
    await settle();
    expect(setLocaleMock).not.toHaveBeenCalled();
    expect(useStore.getState().locale).toBe('en');
  });
});

// ── Native ──────────────────────────────────────────────────────────────────
describe('native — modal handoff + desktop-only CSV / PDF', () => {
  beforeEach(() => {
    mockPlatform.OS = 'ios';
    jest.useFakeTimers();
  });
  // Inner afterEach runs BEFORE RNTL's top-level auto-cleanup, which would
  // otherwise hang on fake timers.
  afterEach(() => {
    jest.useRealTimers();
  });

  it('quick-order: no prompt until PHONE_SHEET_HANDOFF_MS, then confirm → share', async () => {
    const view = openAndPress('phone-order-sheet-quick');
    expect(view.queryByTestId('export-lang-prompt')).toBeNull();
    act(() => {
      jest.advanceTimersByTime(PHONE_SHEET_HANDOFF_MS - 1);
    });
    expect(view.queryByTestId('export-lang-prompt')).toBeNull();
    act(() => {
      jest.advanceTimersByTime(1);
    });
    expect(view.getByTestId('export-lang-prompt')).toBeTruthy();
    expect(sharePurchaseOrder).not.toHaveBeenCalled();
    fireEvent.press(view.getByTestId('export-lang-confirm'));
    expect(sharePurchaseOrder).toHaveBeenCalledTimes(1);
    jest.useRealTimers();
    await waitFor(() => expect(recordMock).toHaveBeenCalledTimes(1));
    expect(calls).toEqual(['record', 'clear']);
  });

  it.each([
    ['CSV', 'phone-order-sheet-csv'],
    ['PDF', 'phone-order-sheet-pdf'],
  ])('%s: availableOnDesktop toast, never a prompt (AC-18)', (_label, testID) => {
    const view = openAndPress(testID);
    expect(Toast.show).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'info', text1: 'Available on desktop' }),
    );
    act(() => {
      jest.advanceTimersByTime(PHONE_SHEET_HANDOFF_MS * 3);
    });
    expect(view.queryByTestId('export-lang-prompt')).toBeNull();
    expect(recordMock).not.toHaveBeenCalled();
    expect(clearMock).not.toHaveBeenCalled();
  });
});

// ── AC-4 — import-file skip ─────────────────────────────────────────────────
describe('AC-4 — a US Foods CSV opens no prompt', () => {
  it('exports at once and records once', async () => {
    seed([{
      id: 'v-a', name: 'US FOODS', extensionOrdering: false, orderUnit: 'case',
      orderImportFormat: 'us_foods', importCustomerNumber: '123456',
      importDistributorNumber: '99', importDepartment: '1',
    }]);
    const view = openAndPress('phone-order-sheet-csv');
    expect(view.queryByTestId('export-lang-prompt')).toBeNull();
    await waitFor(() => expect(recordMock).toHaveBeenCalledTimes(1));
    expect(buildReorderCsv).not.toHaveBeenCalled();
  });
});

// ── Store switch / cancel / zh-CN PDF ───────────────────────────────────────
describe('prompt dismissal', () => {
  it('a store switch while the prompt is open closes it; nothing recorded or cleared', async () => {
    const view = openAndPress('phone-order-sheet-quick');
    expect(view.getByTestId('export-lang-prompt')).toBeTruthy();
    act(() => {
      useStore.setState({ currentStore: { id: 'store-2', brandId: 'b', name: 'G', address: '', status: 'active' } as any });
    });
    expect(view.queryByTestId('export-lang-prompt')).toBeNull();
    // Switching back does not resurrect the stale prompt.
    act(() => {
      useStore.setState({ currentStore: { id: 'store-1', brandId: 'b', name: 'F', address: '', status: 'active' } as any });
    });
    expect(view.queryByTestId('export-lang-prompt')).toBeNull();
    await settle();
    expect(sharePurchaseOrder).not.toHaveBeenCalled();
    expect(recordMock).not.toHaveBeenCalled();
    expect(clearMock).not.toHaveBeenCalled();
  });

  it.each([
    ['quick-order', 'phone-order-sheet-quick'],
    ['CSV', 'phone-order-sheet-csv'],
    ['PDF', 'phone-order-sheet-pdf'],
  ])('%s: cancel is a no-op (AC-9)', async (_label, testID) => {
    const view = openAndPress(testID);
    fireEvent.press(view.getByTestId('export-lang-cancel'));
    await settle();
    expect(view.queryByTestId('export-lang-prompt')).toBeNull();
    expect(sharePurchaseOrder).not.toHaveBeenCalled();
    expect(buildReorderCsv).not.toHaveBeenCalled();
    expect(recordMock).not.toHaveBeenCalled();
    expect(clearMock).not.toHaveBeenCalled();
    expect(Toast.show).not.toHaveBeenCalled();
  });

  it('zh-CN UI + PDF → EN selected and no 中文 segment', () => {
    useStore.setState({ locale: 'zh-CN' as any });
    const view = openAndPress('phone-order-sheet-pdf');
    expect(view.queryByTestId('export-lang-option-zh-CN')).toBeNull();
    expect(view.getByTestId('export-lang-option-en').props.accessibilityState.selected).toBe(true);
    expect(view.getByTestId('export-lang-option-es').props.accessibilityState.selected).toBe(false);
  });
});

// ── Guard-after-hooks (specs 140-148) ───────────────────────────────────────
describe('hook order', () => {
  it('no-store → store mounts the list without a hook-order error', () => {
    useStore.setState({ currentStore: null as any });
    const view = render(<PhoneOrdering />);
    expect(view.getByTestId('phone-order-no-store')).toBeTruthy();
    act(() => {
      useStore.setState({ currentStore: { id: 'store-1', brandId: 'b', name: 'F', address: '', status: 'active' } as any });
    });
    expect(view.getByTestId('phone-order-more-v-a')).toBeTruthy();
  });
});
