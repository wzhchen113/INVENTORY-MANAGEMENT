// src/screens/cmd/sections/__tests__/OrderingSection.test.tsx — Spec 137/138.
//
// Spec 138 collapses "Ordering" to the reorder list ONLY (the spec-137
// Purchase-orders tab is retired) plus a small read-only past-orders History
// panel. These tests lock:
//   1. Shell render — the reorder pane mounts, and there is NO PO tab.
//   2. History panel (AC-8) — a collapsed "History" affordance that, when
//      opened, refreshes + renders date / vendor / total from orderSubmissions,
//      filters cancelled orders, and shows an empty state; read-only.
//   3. Sidebar-override fallback (AC-4) — remapLegacySidebarOverrideIds resolves
//      the removed `Reorder` / `PurchaseOrders` ids onto `Ordering` and DROPS
//      the retired `Receiving` id, with no crash / dangling entry.
//
// ReorderSection is stubbed to a `reorder-root` node so this suite isolates the
// wrapper + History responsibilities (ReorderSection has its own suites).

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

// Stub ReorderSection — this suite covers the shell + History, not the reorder
// list (which has its own suites).
jest.mock('../ReorderSection', () => {
  const ReactMod = require('react');
  const RN = require('react-native');
  return {
    __esModule: true,
    default: () => ReactMod.createElement(RN.View, { testID: 'reorder-root' }),
  };
});

jest.mock('../../../../store/useStore', () => {
  const state: any = {
    orderSubmissions: [],
    refreshPurchaseOrders: jest.fn(),
  };
  const fn: any = jest.fn((selector: (s: any) => any) => selector(state));
  fn.getState = () => state;
  fn.__state = state;
  return { useStore: fn };
});

import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react-native';
import OrderingSection from '../OrderingSection';
import { useStore } from '../../../../store/useStore';
import {
  remapLegacySidebarOverrideIds,
  applySidebarOverride,
  type SidebarGroup,
} from '../../../../lib/sidebarLayout';

const mockState = (useStore as any).__state as Record<string, any>;

function poRow(over: Record<string, any> = {}) {
  return {
    id: over.id ?? 'po-1',
    storeId: 'store-1',
    vendorId: over.vendorId ?? 'v-a',
    vendorName: over.vendorName ?? 'Acme',
    status: over.status ?? 'draft',
    referenceDate: over.referenceDate ?? '2026-07-03',
    date: over.date ?? '2026-07-03',
    totalCost: over.totalCost ?? 42,
    submittedBy: 't',
    submittedAt: '10:00',
    day: 'Friday',
    ...over,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockState.orderSubmissions = [];
  mockState.refreshPurchaseOrders = jest.fn();
});

describe('OrderingSection — reorder-only shell (spec 138)', () => {
  it('mounts the reorder pane and has NO Purchase-orders tab', () => {
    render(<OrderingSection />);
    expect(screen.getByTestId('reorder-root')).toBeTruthy();
    // The spec-137 PO tab strip is gone.
    expect(screen.queryByTestId('ordering-tab-reorder')).toBeNull();
    expect(screen.queryByTestId('ordering-tab-pos')).toBeNull();
  });

  it('renders the History toggle, collapsed by default (panel hidden)', () => {
    render(<OrderingSection />);
    expect(screen.getByTestId('ordering-history-toggle')).toBeTruthy();
    expect(screen.queryByTestId('ordering-history-panel')).toBeNull();
  });
});

describe('OrderingSection — read-only History (AC-8)', () => {
  it('opening History refreshes and renders date / vendor / total rows (cancelled filtered)', () => {
    mockState.orderSubmissions = [
      poRow({ id: 'po-1', vendorName: 'Acme', referenceDate: '2026-07-03', totalCost: 42, status: 'sent' }),
      poRow({ id: 'po-2', vendorName: 'BJ’s', referenceDate: '2026-07-02', totalCost: 15, status: 'draft' }),
      poRow({ id: 'po-3', vendorName: 'Cancelled Co', referenceDate: '2026-07-01', totalCost: 99, status: 'cancelled' }),
    ];
    render(<OrderingSection />);

    fireEvent.press(screen.getByTestId('ordering-history-toggle'));
    // Opening refreshes the PO list.
    expect(mockState.refreshPurchaseOrders).toHaveBeenCalledTimes(1);

    expect(screen.getByTestId('ordering-history-panel')).toBeTruthy();
    // Non-cancelled rows render; the cancelled one is filtered out.
    expect(screen.getByTestId('ordering-history-row-po-1')).toBeTruthy();
    expect(screen.getByTestId('ordering-history-row-po-2')).toBeTruthy();
    expect(screen.queryByTestId('ordering-history-row-po-3')).toBeNull();

    // Date / vendor / total surfaced for a row.
    expect(screen.getByText('2026-07-03')).toBeTruthy();
    expect(screen.getByText('Acme')).toBeTruthy();
    expect(screen.getByText('$42.00')).toBeTruthy();
  });

  it('shows an empty state when there are no (non-cancelled) past orders', () => {
    mockState.orderSubmissions = [poRow({ id: 'po-x', status: 'cancelled' })];
    render(<OrderingSection />);
    fireEvent.press(screen.getByTestId('ordering-history-toggle'));
    expect(screen.getByTestId('ordering-history-empty')).toBeTruthy();
  });
});

describe('remapLegacySidebarOverrideIds — spec-008 override fallback (spec 137/138)', () => {
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

  it('drops the retired Receiving override id entirely (spec 138, AC-4)', () => {
    const input = {
      v: 1 as const,
      items: [
        { id: 'Receiving', group: 'Operations' },
        { id: 'Vendors', order: 3 },
      ],
    };
    expect(remapLegacySidebarOverrideIds(input)).toEqual({
      v: 1,
      items: [{ id: 'Vendors', order: 3 }],
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

  it('applySidebarOverride resolves a dropped Receiving id cleanly (no dangling entry)', () => {
    const defaultGroups: SidebarGroup[] = [
      { label: 'Operations', items: [{ id: 'Inventory', label: 'Inventory' }] },
      { label: 'Planning', items: [{ id: 'Ordering', label: 'Ordering' }, { id: 'Vendors', label: 'Vendors' }] },
    ];
    const remapped = remapLegacySidebarOverrideIds({ v: 1, items: [{ id: 'Receiving', group: 'Operations' }] });
    const merged = applySidebarOverride(defaultGroups, remapped);
    const allIds = merged.flatMap((g) => g.items.map((i) => i.id));
    // Receiving is gone; nothing dangling; the defaults still render.
    expect(allIds).not.toContain('Receiving');
    expect(allIds).toContain('Ordering');
    expect(allIds).toContain('Inventory');
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
