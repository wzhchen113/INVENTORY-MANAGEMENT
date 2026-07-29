// src/screens/cmd/sections/phone/__tests__/PhoneDashboard.test.tsx — Spec 145.
//
// Behavioral coverage for the phone Dashboard:
//   - KPI card values + the danger/warn semantic value coloring;
//   - TODAY'S EOD COUNT progress rows (submitted ✓ vs N/M) + the EOD-tab
//     deep-link payload (usePaletteAction bridge);
//   - NEEDS ATTENTION rows == the OUT items, and tapping opens the item detail;
//   - RECENT ACTIVITY rows from the audit feed.
//
// PhoneDashboard is presentational (every datum arrives in `model`), so these
// render it directly with a controlled model — mirrors the PhoneWeeklyCount
// test style.

import React from 'react';
import { StyleSheet } from 'react-native';
import { render, fireEvent } from '@testing-library/react-native';

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, left: 0, right: 0, bottom: 0 }),
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

import { PhoneDashboard, type PhoneDashboardModel } from '../PhoneDashboard';
import { usePaletteAction } from '../../../../../lib/paletteAction';
import { useStore } from '../../../../../store/useStore';
import { LightCmd } from '../../../../../theme/colors';
import type { AuditEvent, InventoryItem } from '../../../../../types';

function mkItem(id: string, name: string, over: Partial<InventoryItem> = {}): InventoryItem {
  return {
    id, catalogId: id, name, category: 'Proteins', unit: 'lbs', costPerUnit: 3, currentStock: 0,
    parLevel: 40, averageDailyUsage: 0, safetyStock: 0, vendorId: 'v1', vendorName: 'Sysco',
    usagePerPortion: 0, lastUpdatedBy: '', lastUpdatedAt: '', eodRemaining: 0, storeId: 'store-1',
    casePrice: 0, caseQty: 1, subUnitSize: 1, subUnitUnit: 'lb', ...over,
  } as InventoryItem;
}

function mkAudit(id: string, over: Partial<AuditEvent> = {}): AuditEvent {
  return {
    id, timestamp: new Date().toISOString(), userId: 'u1', userName: 'Maria Garcia',
    userRole: 'admin', storeId: 'store-1', storeName: 'Towson', action: 'EOD entry',
    detail: '', itemRef: '', value: '', ...over,
  } as AuditEvent;
}

function makeModel(over: Partial<PhoneDashboardModel> = {}): PhoneDashboardModel {
  return {
    storeName: 'Towson',
    totalInvValue: 48231.5,
    itemCount: 143,
    outCount: 3,
    lowCount: 5,
    wasteWeek: 46.9,
    wasteEventCount: 4,
    outItems: [],
    eodRows: [],
    activity: [],
    ...over,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  useStore.setState({ darkMode: false } as any);
  usePaletteAction.setState({ pending: null });
});

describe('PhoneDashboard — KPI cards', () => {
  it('renders the four KPI values from the model', () => {
    const { getByText } = render(<PhoneDashboard model={makeModel()} />);
    expect(getByText('$48,231.50')).toBeTruthy(); // inventory value
    expect(getByText('3')).toBeTruthy(); // out
    expect(getByText('5')).toBeTruthy(); // low
    expect(getByText('$46.90')).toBeTruthy(); // waste 7d
    // sub-labels carry the counts.
    expect(getByText('AT COST · 143 ITEMS')).toBeTruthy();
    expect(getByText('4 EVENTS LOGGED')).toBeTruthy();
  });

  it('colors the OUT value danger and the LOW value warn (semantic tokens)', () => {
    const { getByTestId } = render(<PhoneDashboard model={makeModel()} />);
    const out = StyleSheet.flatten(getByTestId('phone-dash-kpi-out-value').props.style);
    const low = StyleSheet.flatten(getByTestId('phone-dash-kpi-low-value').props.style);
    const inv = StyleSheet.flatten(getByTestId('phone-dash-kpi-invValue-value').props.style);
    expect(out.color).toBe(LightCmd.danger);
    expect(low.color).toBe(LightCmd.warn);
    // Inventory value is the neutral fg — never a status color / the accent.
    expect(inv.color).toBe(LightCmd.fg);
    expect(inv.color).not.toBe(LightCmd.accent);
  });
});

describe('PhoneDashboard — TODAY\'S EOD COUNT', () => {
  const eodRows = [
    { vendorId: 'v1', vendorName: 'Sysco', counted: 1, total: 3, submitted: false, focusItemId: 'i-sysco' },
    { vendorId: 'v2', vendorName: 'US Foods', counted: 4, total: 4, submitted: true, focusItemId: 'i-usf' },
  ];

  it('renders per-vendor progress (N/M open · ✓ submitted)', () => {
    const { getByText } = render(<PhoneDashboard model={makeModel({ eodRows })} />);
    expect(getByText('Sysco')).toBeTruthy();
    expect(getByText('US Foods')).toBeTruthy();
    expect(getByText('1/3')).toBeTruthy();
    expect(getByText('1 OF 3 COUNTED')).toBeTruthy();
    expect(getByText('SUBMITTED · SYNCED')).toBeTruthy();
  });

  it('deep-links to that vendor\'s EOD tab with the focus item id', () => {
    const { getByTestId } = render(<PhoneDashboard model={makeModel({ eodRows })} />);
    fireEvent.press(getByTestId('phone-dash-eod-row-v1'));
    expect(usePaletteAction.getState().pending).toEqual({
      section: 'EODCount',
      selectedName: null,
      eodFocusItemId: 'i-sysco',
    });
  });

  it('shows the empty state when no vendors are scheduled', () => {
    const { getByText } = render(<PhoneDashboard model={makeModel({ eodRows: [] })} />);
    expect(getByText('No vendors scheduled today')).toBeTruthy();
  });
});

describe('PhoneDashboard — NEEDS ATTENTION', () => {
  it('renders one row per OUT item and drills into the item detail on tap', () => {
    const outItems = [mkItem('i1', 'Chicken Wings'), mkItem('i2', 'Salmon Fillet')];
    const { getByText, getByTestId, queryByTestId } = render(
      <PhoneDashboard model={makeModel({ outItems })} />,
    );
    expect(getByText('Chicken Wings')).toBeTruthy();
    expect(getByText('Salmon Fillet')).toBeTruthy();
    // No detail overlay until a row is tapped (Hard Rule 7 — nothing selected).
    expect(queryByTestId('phone-drill-detail')).toBeNull();
    fireEvent.press(getByTestId('phone-dash-attention-row-i1'));
    expect(getByTestId('phone-drill-detail')).toBeTruthy();
  });

  it('shows the all-clear empty state with no OUT items', () => {
    const { getByText } = render(<PhoneDashboard model={makeModel({ outItems: [] })} />);
    expect(getByText('Nothing out of stock')).toBeTruthy();
  });
});

describe('PhoneDashboard — RECENT ACTIVITY', () => {
  it('renders audit rows with the localized action title', () => {
    const activity = [
      mkAudit('a1', { action: 'EOD entry', userName: 'Maria Garcia' }),
      mkAudit('a2', { action: 'Item edit', userName: 'Kevin Park' }),
    ];
    const { getByText, getByTestId } = render(<PhoneDashboard model={makeModel({ activity })} />);
    expect(getByTestId('phone-dash-activity-row-a1')).toBeTruthy();
    expect(getByTestId('phone-dash-activity-row-a2')).toBeTruthy();
    // formatAuditAction maps 'EOD entry' → enum.auditAction.eodEntry.
    expect(getByText('submitted EOD count')).toBeTruthy();
    expect(getByText('Maria Garcia')).toBeTruthy();
  });

  it('shows the empty state with no activity', () => {
    const { getByText } = render(<PhoneDashboard model={makeModel({ activity: [] })} />);
    expect(getByText('No recent activity')).toBeTruthy();
  });
});
