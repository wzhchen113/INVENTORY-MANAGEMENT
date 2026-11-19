// src/screens/cmd/sections/__tests__/ReorderSection.primaryWins.spec201.test.tsx
// — Spec 201 (AC-21, plus the component half of AC-25 / AC-26).
//
// On a coincident day the server keeps shared item F ONLY on its primary
// vendor A's card and names the yielding vendor(s) in `yieldedFromVendors`.
// The desktop section must:
//   - render "also from <B> — switch" on A's F row (testIDs
//     `reorder-yielded-from-${itemId}` / `reorder-switch-primary-${itemId}-${vendorId}`)
//     INSTEAD of the spec-102 "also available from … — order from one" line;
//   - keep the old line byte-for-byte on every other shared row;
//   - render no F row on B's card, and a KPI strip equal to
//     `computeReorderKpis` over the rendered cards;
//   - wire the switch through `switchItemPrimaryVendor` with a confirmAction
//     confirm (AC-25), and toast the 3c refusal (AC-26).
//
// Boundary mocking mirrors ReorderSection.spec130.test.tsx. `useT` is mocked
// to `key|var1|var2…` so interpolated values are observable.

jest.mock('react-native/Libraries/Utilities/Platform', () => ({
  __esModule: true,
  default: { OS: 'web', select: (obj: any) => obj.web ?? obj.default },
  OS: 'web',
}));

jest.mock('react-native-toast-message', () => ({
  __esModule: true,
  default: { show: jest.fn(), hide: jest.fn() },
}));

jest.mock('../../../../utils/confirmAction', () => ({
  confirmAction: jest.fn(),
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
  }),
  CmdRadius: { xs: 3, sm: 4, md: 5, lg: 6 },
}));

jest.mock('../../../../hooks/useT', () => ({
  useT: () => (key: string, vars?: Record<string, string | number>) =>
    vars ? [key, ...Object.values(vars).map(String)].join('|') : key,
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
    StatCard: ({ label, value }: { label: string; value: string }) =>
      ReactMod.createElement(
        RN.View,
        { testID: `statcard-${label}` },
        ReactMod.createElement(RN.Text, { testID: `statcard-value-${label}` }, value),
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
    lastOrderContext: null,
    loadLastOrderContext: jest.fn(),
    createPoDraft: jest.fn(() => Promise.resolve('po-1')),
    vendors: [],
    inventory: [],
    reorderEdits: {},
    setReorderEditQty: jest.fn(),
    clearReorderEdits: jest.fn(),
    clearReorderEditsForVendor: jest.fn(),
    fillCartForVendor: jest.fn(() => Promise.resolve('po-1')),
    switchItemPrimaryVendor: jest.fn(),
  };
  const fn: any = jest.fn((selector: (s: any) => any) => selector(state));
  fn.getState = () => state;
  fn.__state = state;
  return { useStore: fn };
});

import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react-native';
import Toast from 'react-native-toast-message';
import { toISODate } from '../../../../utils/reportDates';
import { computeReorderKpis } from '../../../../utils/reorderDayFilter';
import { formatMoney } from '../../../../utils/reorderExport';
import { confirmAction } from '../../../../utils/confirmAction';
import ReorderSection from '../ReorderSection';
import { useStore } from '../../../../store/useStore';
import type { ReorderItem, ReorderVendor } from '../../../../types';

const mockState = (useStore as any).__state as Record<string, any>;
const confirmActionMock = confirmAction as jest.Mock;
const toastShowMock = (Toast as any).show as jest.Mock;

const expandAllVendorCards = () => {
  screen.getAllByTestId(/^reorder-vendor-toggle-/).forEach((t) => fireEvent.press(t));
};

const flush = () => act(async () => { await new Promise<void>((r) => setTimeout(r, 0)); });

function item(over: Partial<ReorderItem> & { itemId: string; itemName: string }): ReorderItem {
  return {
    unit: 'each',
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
    otherVendorCount: 0,
    alsoFromVendors: [],
    yieldedFromVendors: [],
    ...over,
  };
}

function vendor(over: Partial<ReorderVendor> & { vendorId: string; items: ReorderItem[] }): ReorderVendor {
  return {
    vendorName: over.vendorId,
    scheduleKnown: true,
    nextDeliveryDate: '2026-06-02',
    daysUntilNextDelivery: 1,
    onHandSource: 'eod',
    eodSubmittedAt: '2026-06-02T18:00:00Z',
    vendorTotalCost: over.items.reduce((acc, it) => acc + it.estimatedCost, 0),
    hasPo: false,
    ...over,
  } as ReorderVendor;
}

function everyDaySchedule(vendorIds: string[]) {
  const entries = vendorIds.map((id) => ({ vendorId: id, vendorName: id, deliveryDay: 'Wednesday' }));
  return {
    Monday: entries, Tuesday: entries, Wednesday: entries, Thursday: entries,
    Friday: entries, Saturday: entries, Sunday: entries,
  };
}

const BRAVO = { vendorId: 'vendor-b', vendorName: 'Bravo Supply' };
const CHARLIE = { vendorId: 'vendor-c', vendorName: 'Charlie Co' };

// F — shared, coincident, primary A: on A only, yielded from B.
const F = item({
  itemId: 'item-f',
  itemName: 'Fryer Oil',
  otherVendorCount: 1,
  alsoFromVendors: [BRAVO],
  yieldedFromVendors: [BRAVO],
  estimatedCost: 30,
});
// H — shared but NOT in the coincident rule (empty yielded list): keeps the
// old spec-102 line exactly.
const H = item({
  itemId: 'item-h',
  itemName: 'Hot Sauce',
  otherVendorCount: 1,
  alsoFromVendors: [CHARLIE],
  yieldedFromVendors: [],
  estimatedCost: 4,
});
// G — B's own item.
const G = item({ itemId: 'item-g', itemName: 'Gloves', estimatedCost: 5 });

const A = vendor({ vendorId: 'vendor-a', vendorName: 'Alpha Foods', items: [F, H] });
const B = vendor({ vendorId: 'vendor-b', vendorName: 'Bravo Supply', items: [G] });

function seedPayload(vendors: ReorderVendor[]) {
  mockState.reorderPayload = {
    asOfDate: toISODate(new Date()),
    vendors,
    kpis: computeReorderKpis(vendors),
    warnings: [],
  };
  mockState.orderSchedule = everyDaySchedule(vendors.map((v) => v.vendorId));
}

beforeEach(() => {
  jest.clearAllMocks();
  (global as any).Blob = class {};
  const w = (global as any).window ?? ((global as any).window = {});
  w.URL = { createObjectURL: () => 'blob:x', revokeObjectURL: () => {} };
  mockState.currentStore = { id: 'store-1', name: 'Test Store' };
  mockState.reorderLoading = false;
  mockState.reorderError = null;
  mockState.vendors = [];
  mockState.inventory = [];
  mockState.reorderEdits = {};
  mockState.switchItemPrimaryVendor = jest.fn();
  seedPayload([A, B]);
});

describe('ReorderSection — spec 201 primary wins (AC-21)', () => {
  it('renders "also from B — switch" on A\'s F row instead of the old line; no F on B; KPIs match', () => {
    render(<ReorderSection />);
    expandAllVendorCards();

    // The new line + exactly one switch control (one yielded vendor → plain "switch").
    expect(screen.getByTestId('reorder-yielded-from-item-f').props.children).toBe(
      'section.reorder.yieldedFrom|Bravo Supply',
    );
    const sw = screen.getByTestId('reorder-switch-primary-item-f-vendor-b');
    expect(screen.getAllByTestId(/^reorder-switch-primary-item-f-/)).toHaveLength(1);
    expect(screen.getByText('section.reorder.switchPrimary')).toBeTruthy();
    expect(sw.props.accessibilityLabel).toBe('section.reorder.switchPrimaryAria|Bravo Supply|Fryer Oil');

    // The old "order from one" line is NOT on the F row …
    expect(screen.queryByTestId('reorder-also-from-item-f')).toBeNull();
    // … but every other shared row keeps it byte-for-byte (English literal).
    expect(screen.getByTestId('reorder-also-from-item-h').props.children).toBe(
      'also available from Charlie Co — order from one',
    );
    expect(screen.queryByTestId('reorder-yielded-from-item-h')).toBeNull();

    // F renders ONCE (A's card) — B's card carries only G.
    expect(screen.getAllByTestId('reorder-vendor-item-item-f')).toHaveLength(1);
    expect(screen.getAllByTestId('reorder-vendor-item-item-g')).toHaveLength(1);

    // KPI strip = computeReorderKpis over the rendered cards.
    const k = computeReorderKpis([A, B]);
    expect(screen.getByTestId('statcard-value-Vendors').props.children).toBe(String(k.vendorCount));
    expect(screen.getByTestId('statcard-value-Items').props.children).toBe(String(k.itemCount));
    expect(screen.getByTestId('statcard-value-Est. total').props.children).toBe(formatMoney(k.totalEstimatedCost));
    expect(k.itemCount).toBe(3);
  });

  it('two yielded vendors (AC-7 all-three) → one named switch per target', () => {
    const F3 = item({
      itemId: 'item-f',
      itemName: 'Fryer Oil',
      otherVendorCount: 2,
      alsoFromVendors: [BRAVO, CHARLIE],
      yieldedFromVendors: [BRAVO, CHARLIE],
    });
    seedPayload([vendor({ vendorId: 'vendor-a', vendorName: 'Alpha Foods', items: [F3] })]);
    render(<ReorderSection />);
    expandAllVendorCards();

    expect(screen.getByTestId('reorder-yielded-from-item-f').props.children).toBe(
      'section.reorder.yieldedFrom|Bravo Supply, Charlie Co',
    );
    expect(screen.getByTestId('reorder-switch-primary-item-f-vendor-b')).toBeTruthy();
    expect(screen.getByTestId('reorder-switch-primary-item-f-vendor-c')).toBeTruthy();
    expect(screen.getByText('section.reorder.switchPrimaryTo|Bravo Supply')).toBeTruthy();
    expect(screen.getByText('section.reorder.switchPrimaryTo|Charlie Co')).toBeTruthy();
    expect(screen.queryByTestId('reorder-also-from-item-f')).toBeNull();
  });

  it('a row with no yielded vendors and no other vendors renders neither line', () => {
    render(<ReorderSection />);
    expandAllVendorCards();
    expect(screen.queryByTestId('reorder-yielded-from-item-g')).toBeNull();
    expect(screen.queryByTestId('reorder-also-from-item-g')).toBeNull();
  });
});

describe('ReorderSection — spec 201 switch flow (AC-25 / AC-26)', () => {
  it('switch → store action with A→B + the as-of date; confirm goes through confirmAction; success toast', async () => {
    // The store action drives the confirm the component hands it.
    mockState.switchItemPrimaryVendor = jest.fn(async (args: any) =>
      (await args.confirm()) ? 'switched' : 'cancelled',
    );
    confirmActionMock.mockImplementation((_t: string, _b: string, onConfirm: () => void) => onConfirm());

    render(<ReorderSection />);
    expandAllVendorCards();
    fireEvent.press(screen.getByTestId('reorder-switch-primary-item-f-vendor-b'));
    await flush();

    expect(mockState.switchItemPrimaryVendor).toHaveBeenCalledTimes(1);
    expect(mockState.switchItemPrimaryVendor).toHaveBeenCalledWith(
      expect.objectContaining({
        itemId: 'item-f',
        fromVendorId: 'vendor-a',
        toVendorId: 'vendor-b',
        asOfDate: toISODate(new Date()),
      }),
    );
    // The confirm names both vendors and is permanent-for-this-store copy.
    expect(confirmActionMock).toHaveBeenCalledTimes(1);
    const [title, body, , cta] = confirmActionMock.mock.calls[0];
    expect(title).toBe('section.reorder.switchConfirmTitle|Fryer Oil|Alpha Foods|Bravo Supply');
    expect(body).toBe('section.reorder.switchConfirmBody|Fryer Oil|Alpha Foods|Bravo Supply');
    expect(cta).toBe('section.reorder.switchConfirmCta');
    expect(toastShowMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'success', text1: 'section.reorder.switchedToast|Fryer Oil|Alpha Foods|Bravo Supply' }),
    );
  });

  it('cancelling the confirm resolves "cancelled" and shows no toast (AC-25.4)', async () => {
    mockState.switchItemPrimaryVendor = jest.fn(async (args: any) =>
      (await args.confirm()) ? 'switched' : 'cancelled',
    );
    confirmActionMock.mockImplementation(
      (_t: string, _b: string, _ok: () => void, _cta: string, onCancel: () => void) => onCancel(),
    );

    render(<ReorderSection />);
    expandAllVendorCards();
    fireEvent.press(screen.getByTestId('reorder-switch-primary-item-f-vendor-b'));
    await flush();

    expect(confirmActionMock).toHaveBeenCalledTimes(1);
    await expect(mockState.switchItemPrimaryVendor.mock.results[0].value).resolves.toBe('cancelled');
    expect(toastShowMock).not.toHaveBeenCalled();
  });

  it('refused (3c) → refusal toast naming the item + current vendor; no confirm (AC-26)', async () => {
    mockState.switchItemPrimaryVendor = jest.fn(async () => 'refused');

    render(<ReorderSection />);
    expandAllVendorCards();
    fireEvent.press(screen.getByTestId('reorder-switch-primary-item-f-vendor-b'));
    await flush();

    expect(confirmActionMock).not.toHaveBeenCalled();
    expect(toastShowMock).toHaveBeenCalledTimes(1);
    expect(toastShowMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'error',
        text1: 'section.reorder.switchRefusedTitle',
        text2: 'section.reorder.switchRefused|Fryer Oil|Alpha Foods|Bravo Supply',
      }),
    );
  });

  it('failed → no component toast (the store already called notifyBackendError)', async () => {
    mockState.switchItemPrimaryVendor = jest.fn(async () => 'failed');
    render(<ReorderSection />);
    expandAllVendorCards();
    fireEvent.press(screen.getByTestId('reorder-switch-primary-item-f-vendor-b'));
    await flush();
    expect(toastShowMock).not.toHaveBeenCalled();
  });

  it('a second press while the switch is in flight does not double-fire', async () => {
    let release!: (v: string) => void;
    mockState.switchItemPrimaryVendor = jest.fn(() => new Promise<string>((r) => { release = r; }));

    render(<ReorderSection />);
    expandAllVendorCards();
    fireEvent.press(screen.getByTestId('reorder-switch-primary-item-f-vendor-b'));
    fireEvent.press(screen.getByTestId('reorder-switch-primary-item-f-vendor-b'));
    expect(mockState.switchItemPrimaryVendor).toHaveBeenCalledTimes(1);
    await act(async () => { release('cancelled'); });
    await flush();
  });
});
