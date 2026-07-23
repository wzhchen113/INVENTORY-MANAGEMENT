// src/screens/cmd/sections/__tests__/OrderingSection.test.tsx — Spec 137.
//
// The unified "Ordering" destination is a thin tab shell that hosts the two
// EXISTING sections (ReorderSection, POsSection) as tabs. These tests lock the
// three seams that make it work:
//   1. Shell render + landing tab — both tabs present, Reorder mounted on open.
//   2. Deep-link — "+ CREATE PO" success flips to the Purchase-orders tab AND
//      preselects the returned poId (via the orderingHandoff signal).
//   3. Sidebar-override fallback — remapLegacySidebarOverrideIds resolves the
//      removed `Reorder` / `PurchaseOrders` override ids onto `Ordering`.
//
// Boundary mocking mirrors ReorderSection.spec123 / POsSection.test: mock
// useCmdColors / useT (key-echoing) / confirmAction (auto-confirm) / toast /
// useStore (combined snapshot both sections read). TabStrip is stubbed to render
// its tabs (as pressable, testID'd nodes) AND its rightSlot so the shell tabs
// and the sections' action buttons are all reachable.

jest.mock('react-native/Libraries/Utilities/Platform', () => ({
  __esModule: true,
  default: { OS: 'web', select: (obj: any) => obj.web ?? obj.default },
  OS: 'web',
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

jest.mock('../../../../hooks/useLocale', () => ({ useLocale: () => 'en' }));
jest.mock('../../../../i18n/localizedName', () => ({
  getLocalizedName: (row: { name?: string }) => row?.name ?? '',
}));

const mockConfirmAction = jest.fn(
  (_t: string, _m: string, onConfirm: () => void) => { onConfirm(); },
);
jest.mock('../../../../utils/confirmAction', () => ({
  confirmAction: (...args: any[]) => (mockConfirmAction as any)(...args),
}));

jest.mock('react-native-toast-message', () => ({
  __esModule: true,
  default: { show: jest.fn(), hide: jest.fn() },
}));

// TabStrip — render each tab as a pressable, testID'd node AND the rightSlot,
// so the shell's tabs and both sections' header actions are all reachable.
jest.mock('../../../../components/cmd/TabStrip', () => {
  const ReactMod = require('react');
  const RN = require('react-native');
  return {
    TabStrip: ({ tabs, onChange, rightSlot }: any) =>
      ReactMod.createElement(
        RN.View,
        { testID: 'tabstrip' },
        (tabs || []).map((t: any) =>
          ReactMod.createElement(
            RN.TouchableOpacity,
            { key: t.id, testID: t.testID, onPress: () => onChange(t.id) },
            ReactMod.createElement(RN.Text, null, t.label),
          ),
        ),
        ReactMod.createElement(RN.View, { key: '__rs' }, rightSlot),
      ),
  };
});
jest.mock('../../../../components/cmd/StatCard', () => ({ StatCard: () => null }));
jest.mock('../../../../components/cmd/StatusPill', () => {
  const ReactMod = require('react');
  const RN = require('react-native');
  return { StatusPill: ({ label }: { label?: string }) => ReactMod.createElement(RN.Text, null, label) };
});
jest.mock('../../../../components/cmd/SectionCaption', () => {
  const ReactMod = require('react');
  const RN = require('react-native');
  return { SectionCaption: ({ children }: any) => ReactMod.createElement(RN.Text, null, children) };
});

// Keep the pure reorderExport helpers real; stub only the CSV builder so the
// DOM download path never runs (unused here, but ReorderSection imports it).
jest.mock('../../../../utils/reorderExport', () => {
  const actual = jest.requireActual('../../../../utils/reorderExport');
  return { ...actual, buildReorderCsv: jest.fn(() => 'csv,data') };
});

// Combined store snapshot — the union of the slices ReorderSection and
// POsSection read. Configurable per test via `mockState`.
jest.mock('../../../../store/useStore', () => {
  const state: any = {
    // ReorderSection slices
    currentStore: { id: 'store-1', name: 'Test Store' },
    orderSchedule: { Monday: [], Tuesday: [], Wednesday: [], Thursday: [], Friday: [], Saturday: [], Sunday: [] },
    reorderPayload: null,
    reorderLoading: false,
    reorderError: null,
    loadReorderSuggestions: jest.fn(),
    createPoDraft: jest.fn(async () => 'po-123'),
    vendors: [],
    inventory: [],
    // POsSection slices
    orderSubmissions: [],
    poLinesById: {},
    loadPurchaseOrderLines: jest.fn(async () => []),
    updatePoLineQty: jest.fn(),
    removePoLine: jest.fn(),
    sendPurchaseOrderEmail: jest.fn(async () => true),
    markPurchaseOrderSentManually: jest.fn(async () => true),
    cancelPurchaseOrder: jest.fn(async () => 'cancelled'),
    closeShortPurchaseOrder: jest.fn(async () => 'received'),
  };
  const fn: any = jest.fn((selector: (s: any) => any) => selector(state));
  fn.getState = () => state;
  fn.__state = state;
  return { useStore: fn };
});

import React from 'react';
import { StyleSheet } from 'react-native';
import { render, screen, fireEvent, waitFor } from '@testing-library/react-native';
import { toISODate } from '../../../../utils/reportDates';
import OrderingSection from '../OrderingSection';
import { useStore } from '../../../../store/useStore';
import { useOrderingHandoff } from '../../../../lib/orderingHandoff';
import {
  remapLegacySidebarOverrideIds,
  applySidebarOverride,
  type SidebarGroup,
} from '../../../../lib/sidebarLayout';

const mockState = (useStore as any).__state as Record<string, any>;

function reorderItem(over: Record<string, any> = {}) {
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

function reorderVendor(over: Record<string, any> & { vendorId: string }) {
  return {
    vendorId: over.vendorId,
    vendorName: over.vendorName ?? over.vendorId,
    scheduleKnown: over.scheduleKnown ?? true,
    nextDeliveryDate: '2026-06-02',
    daysUntilNextDelivery: 1,
    onHandSource: over.onHandSource ?? 'eod',
    eodSubmittedAt: over.eodSubmittedAt ?? '2026-06-02T00:00:00Z',
    items: over.items ?? [reorderItem()],
    vendorTotalCost: over.vendorTotalCost ?? 10,
    hasPo: over.hasPo ?? false,
  };
}

// Schedule the vendor on EVERY weekday so it lands in the PRIMARY (day-filtered)
// set regardless of the machine's "today".
function everyDaySchedule(vendorIds: string[]) {
  const entries = vendorIds.map((id) => ({ vendorId: id, vendorName: id, deliveryDay: 'Wednesday' }));
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
  useOrderingHandoff.setState({ pendingPoId: null });
  mockState.currentStore = { id: 'store-1', name: 'Test Store' };
  mockState.orderSchedule = everyDaySchedule(['v-a']);
  mockState.reorderPayload = null;
  mockState.reorderLoading = false;
  mockState.reorderError = null;
  mockState.loadReorderSuggestions = jest.fn();
  mockState.createPoDraft = jest.fn(async () => 'po-123');
  mockState.vendors = [];
  mockState.inventory = [];
  mockState.orderSubmissions = [];
  mockState.poLinesById = {};
  mockConfirmAction.mockImplementation((_t: string, _m: string, onConfirm: () => void) => { onConfirm(); });
});

describe('OrderingSection — shell render + landing tab', () => {
  it('renders both tabs and mounts the Reorder tab (ReorderSection) on open', () => {
    render(<OrderingSection />);
    // Both shell tabs exist.
    expect(screen.getByTestId('ordering-tab-reorder')).toBeTruthy();
    expect(screen.getByTestId('ordering-tab-pos')).toBeTruthy();
    // Reorder is the landing tab → ReorderSection is mounted (its root testID).
    expect(screen.getByTestId('reorder-root')).toBeTruthy();
    // POsSection is NOT mounted (conditional render — only the active tab mounts).
    expect(screen.queryByTestId('po-filter-all')).toBeNull();
  });

  it('switches to the Purchase-orders tab on manual tab press (ReorderSection unmounts)', () => {
    render(<OrderingSection />);
    fireEvent.press(screen.getByTestId('ordering-tab-pos'));
    expect(screen.queryByTestId('reorder-root')).toBeNull();
    // POsSection mounted (its status-filter chip row is POsSection-only).
    expect(screen.getByTestId('po-filter-all')).toBeTruthy();
  });
});

describe('OrderingSection — deep-link create → switch → preselect', () => {
  it('“+ CREATE PO” success flips to the PO tab and preselects the new draft', async () => {
    mockState.reorderPayload = {
      asOfDate: toISODate(new Date()),
      vendors: [reorderVendor({ vendorId: 'v-a' })],
      kpis: { vendorCount: 1, itemCount: 1, totalEstimatedCost: 10, eodSourcedVendorCount: 1, stockFallbackVendorCount: 0 },
      warnings: [],
    };
    // createPoDraft resolves the new poId AND lands the draft in orderSubmissions
    // (mirrors the real action, which awaits refreshPurchaseOrders before
    // resolving — so the draft is present when POsSection mounts on the PO tab).
    mockState.createPoDraft = jest.fn(async () => {
      mockState.orderSubmissions = [
        {
          id: 'po-123', storeId: 'store-1', vendorId: 'v-a', vendorName: 'v-a',
          status: 'draft', day: 'Monday', date: '2026-07-03',
          timestamp: '2026-07-03T10:00:00Z', submittedBy: 't', submittedAt: '10:00', totalCost: 10,
        },
      ];
      return 'po-123';
    });

    render(<OrderingSection />);
    // Reorder tab is active on open.
    expect(screen.getByTestId('reorder-root')).toBeTruthy();

    fireEvent.press(screen.getByTestId('reorder-create-po-v-a'));

    // After the create resolves, the shell flips to the PO tab (ReorderSection
    // unmounts) and POsSection selects po-123.
    await waitFor(() => expect(screen.queryByTestId('reorder-root')).toBeNull());
    const row = await screen.findByTestId('po-list-po-123');
    expect(StyleSheet.flatten(row.props.style).borderLeftWidth).toBe(2); // isSel → 2px accent border
  });

  it('manual path still works — no signal fires when just switching tabs', () => {
    mockState.orderSubmissions = [
      {
        id: 'po-9', storeId: 'store-1', vendorId: 'v-a', vendorName: 'Acme',
        status: 'sent', day: 'Monday', date: '2026-07-03',
        timestamp: '2026-07-03T10:00:00Z', submittedBy: 't', submittedAt: '10:00', totalCost: 10,
      },
    ];
    render(<OrderingSection />);
    fireEvent.press(screen.getByTestId('ordering-tab-pos'));
    // The auto-select effect (no signal) selects the newest PO.
    expect(StyleSheet.flatten(screen.getByTestId('po-list-po-9').props.style).borderLeftWidth).toBe(2);
    // Signal was never armed.
    expect(useOrderingHandoff.getState().pendingPoId).toBeNull();
  });
});

describe('remapLegacySidebarOverrideIds — spec-008 override fallback', () => {
  it('remaps a legacy Reorder override id onto Ordering', () => {
    const input = { v: 1 as const, items: [{ id: 'Reorder', group: 'Operations' }] };
    expect(remapLegacySidebarOverrideIds(input)).toEqual({
      v: 1,
      items: [{ id: 'Ordering', group: 'Operations' }],
    });
  });

  it('remaps PurchaseOrders onto Ordering', () => {
    const input = { v: 1 as const, items: [{ id: 'PurchaseOrders', hidden: true }] };
    expect(remapLegacySidebarOverrideIds(input)).toEqual({
      v: 1,
      items: [{ id: 'Ordering', hidden: true }],
    });
  });

  it('dedupes both legacy ids to a single Ordering (first occurrence wins)', () => {
    const input = {
      v: 1 as const,
      items: [
        { id: 'Reorder', group: 'Operations' },
        { id: 'PurchaseOrders', group: 'Insights' },
      ],
    };
    const out = remapLegacySidebarOverrideIds(input);
    expect(out?.items).toEqual([{ id: 'Ordering', group: 'Operations' }]);
  });

  it('passes non-legacy ids through untouched', () => {
    const input = { v: 1 as const, items: [{ id: 'Vendors', order: 5 }] };
    expect(remapLegacySidebarOverrideIds(input)).toEqual(input);
  });

  it('returns null/empty inputs unchanged', () => {
    expect(remapLegacySidebarOverrideIds(null)).toBeNull();
    expect(remapLegacySidebarOverrideIds(undefined)).toBeUndefined();
    const empty = { v: 1 as const, items: [] };
    expect(remapLegacySidebarOverrideIds(empty)).toBe(empty);
  });

  it('applySidebarOverride places the remapped Ordering per the override', () => {
    const defaultGroups: SidebarGroup[] = [
      { label: 'Operations', items: [{ id: 'Inventory', label: 'Inventory' }] },
      { label: 'Planning', items: [{ id: 'Ordering', label: 'Ordering' }, { id: 'Vendors', label: 'Vendors' }] },
    ];
    const remapped = remapLegacySidebarOverrideIds({ v: 1, items: [{ id: 'Reorder', group: 'Operations' }] });
    const merged = applySidebarOverride(defaultGroups, remapped);
    const ops = merged.find((g) => g.label === 'Operations')!;
    const planning = merged.find((g) => g.label === 'Planning')!;
    expect(ops.items.map((i) => i.id)).toContain('Ordering');
    expect(planning.items.map((i) => i.id)).not.toContain('Ordering');
  });
});
